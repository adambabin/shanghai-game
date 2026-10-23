// Runs in the host's browser: owns the lobby and the game, drives the bots, and sends each
// player their own view of the game.

import { createGame, applyAction, viewFor, nextRound, endRoundNoWinner, endIfPastLastRound, buyTimeout, beginPlay, sittingOut } from './engine.js';
import { chooseDraw, choosePlay, wantsToBuy, seesShanghai, shanghaiReaction } from './bot.js';
import { DEFAULT_OPTIONS, MAX_PLAYERS } from './rules.js';
import { openRoom, randomCode } from './net.js';
import { cleanChat, ChatLimit, CHAT_KEEP } from './chat.js';

const BOT_NAMES = ['Lucky Lou', 'Card Shark', 'Rummy Rita', 'Jolly Joker', 'Shuffles', 'Ace', 'Sir Deals-a-Lot', 'Queenie'];
// each game you host (or play against the computer) is saved under its own key so several can be resumed
const SAVE_PREFIX = 'shanghai.hostGame.';
const OLD_SAVE_KEY = 'shanghai.hostGame'; // the single save slot older versions used
const newGameId = () => Math.random().toString(36).slice(2, 10);

export class HostSession {
  // solo: no network room, just you against bots
  constructor({ name, clientId, solo = false, restore = null }) {
    this.listeners = new Set();
    this.conns = new Map(); // connId -> seat (or null while in lobby without a seat yet)
    this.timers = new Set();
    this.reacted = new Set();
    this.chatListeners = new Set();
    this.chatLimit = new ChatLimit();
    this.chat = Array.isArray(restore && restore.chat) ? restore.chat : [];
    this.chatSeq = this.chat.reduce((n, m) => Math.max(n, m.id + 1), 0);
    this.solo = solo;
    this.clientId = clientId;
    this.status = solo ? 'connected' : 'starting';

    if (restore) {
      this.gameId = restore.id || newGameId();
      this.lobby = restore.lobby;
      this.lobby.options = { ...DEFAULT_OPTIONS, ...this.lobby.options };
      this.game = restore.game;
      // games saved by an older version are missing newer fields
      Object.assign(this.game, { mustPlay: [], buyOffered: false, ...this.game, buyWindow: null, earlyBuy: null });
      // saved between rounds when there were 11: past round 7 it goes straight to the final scores
      endIfPastLastRound(this.game);
      this.lobby.seats.forEach((s) => {
        if (!s.bot && !s.isHost) s.connected = false;
      });
    } else {
      this.gameId = newGameId();
      this.lobby = {
        code: solo ? null : randomCode(),
        started: false,
        options: { ...DEFAULT_OPTIONS },
        seats: [{ name, clientId, isHost: true, connected: true }],
      };
      this.game = null;
      if (solo) {
        this.addBot();
        this.addBot();
      }
    }

    if (!solo) {
      this.room = openRoom(this.lobby.code, {
        onReady: () => {
          this.status = 'connected';
          this.emit();
        },
        onMessage: (connId, msg) => this.onMessage(connId, msg),
        onClose: (connId) => this.onClose(connId),
        onError: (msg) => {
          this.status = 'error';
          this.error = msg;
          this.emit();
        },
      });
    }
    this.changed();
  }

  get mySeat() {
    return 0;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.snapshot(this.mySeat));
    return () => this.listeners.delete(fn);
  }

  snapshot(seat) {
    return {
      status: this.status,
      error: this.error,
      isHost: seat === 0,
      solo: this.solo,
      lobby: {
        code: this.lobby.code,
        started: this.lobby.started,
        options: this.lobby.options,
        seats: this.lobby.seats.map((s) => ({
          name: s.name,
          bot: !!s.bot,
          standIn: !!s.botStandIn,
          isHost: !!s.isHost,
          connected: !!s.connected || !!s.bot,
        })),
      },
      seat,
      view: this.game ? viewFor(this.game, seat) : null,
    };
  }

  emit() {
    const snap = this.snapshot(this.mySeat);
    this.listeners.forEach((fn) => fn(snap));
    if (this.room) {
      for (const [connId, seat] of this.conns) this.room.send(connId, { t: 'state', s: this.snapshot(seat) });
    }
  }

  changed() {
    this.save();
    this.emit();
    this.scheduleBots();
  }

  save() {
    if (!this.game) return;
    try {
      const data = { id: this.gameId, lobby: this.lobby, game: this.game, chat: this.chat, solo: this.solo, savedAt: Date.now() };
      localStorage.setItem(SAVE_PREFIX + this.gameId, JSON.stringify(data));
    } catch {}
  }

  // every unfinished saved game, most recently played first
  static savedGames() {
    const games = [];
    try {
      const old = localStorage.getItem(OLD_SAVE_KEY);
      if (old) {
        const s = JSON.parse(old);
        if (s && s.game) {
          s.id = newGameId();
          localStorage.setItem(SAVE_PREFIX + s.id, JSON.stringify(s));
        }
        localStorage.removeItem(OLD_SAVE_KEY);
      }
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key.startsWith(SAVE_PREFIX)) continue;
        try {
          const s = JSON.parse(localStorage.getItem(key));
          if (s && s.game && s.game.phase !== 'gameOver') games.push({ ...s, id: key.slice(SAVE_PREFIX.length) });
        } catch {}
      }
    } catch {}
    return games.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }

  static saved(id) {
    return HostSession.savedGames().find((s) => s.id === id) || null;
  }

  static clearSaved(id) {
    try {
      localStorage.removeItem(SAVE_PREFIX + id);
    } catch {}
  }

  // ---------- network ----------

  onMessage(connId, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') return this.onHello(connId, msg);
    if (msg.t === 'act') {
      if (!this.conns.has(connId)) return;
      const seat = this.conns.get(connId);
      const res = this.act(seat, msg.a);
      if (res && !res.ok) this.room.send(connId, { t: 'err', msg: res.error });
    }
    if (msg.t === 'chat') {
      if (!this.conns.has(connId)) return;
      const res = this.say(this.conns.get(connId), msg.text);
      if (!res.ok) this.room.send(connId, { t: 'err', msg: res.error });
    }
  }

  onHello(connId, { clientId, name }) {
    name = String(name || 'Player').slice(0, 20).trim() || 'Player';
    const seats = this.lobby.seats;
    const human = (s) => !s.isHost && (!s.bot || s.botStandIn);
    let seat = seats.findIndex((s) => human(s) && s.clientId === clientId);
    if (seat < 0) {
      // same name on a new device: take back a seat that dropped off
      seat = seats.findIndex((s) => human(s) && !s.connected && s.name.toLowerCase() === name.toLowerCase());
    }
    if (seat < 0) {
      if (this.lobby.started) {
        this.room.send(connId, { t: 'err', msg: 'That game has already started. You can watch, or ask the host to let you take a seat.' });
        seat = null;
      } else if (seats.length >= MAX_PLAYERS) {
        this.room.send(connId, { t: 'err', msg: 'The table is full.' });
        return;
      } else {
        seats.push({ name: this.uniqueName(name), clientId, connected: true });
        seat = seats.length - 1;
      }
    }
    if (seat != null) {
      for (const [cid, s] of this.conns) if (s === seat && cid !== connId) this.conns.delete(cid);
      const s = seats[seat];
      s.connected = true;
      s.clientId = clientId;
      if (s.botStandIn) {
        // they're back: hand the seat over from the computer
        s.bot = false;
        s.botStandIn = false;
        if (this.game) this.game.players[seat].bot = false;
      }
    }
    this.conns.set(connId, seat);
    this.changed();
    // the whole chat so far, so someone coming back sees what they missed
    this.room.send(connId, { t: 'chatAll', list: this.chat });
  }

  onClose(connId) {
    const seat = this.conns.get(connId);
    this.conns.delete(connId);
    if (seat != null && ![...this.conns.values()].includes(seat)) {
      const s = this.lobby.seats[seat];
      if (s) {
        if (!this.lobby.started) this.lobby.seats.splice(seat, 1), this.reindexAfterRemoval(seat);
        else s.connected = false;
      }
    }
    this.changed();
  }

  reindexAfterRemoval(removed) {
    for (const [cid, s] of this.conns) if (s != null && s > removed) this.conns.set(cid, s - 1);
  }

  uniqueName(name) {
    const taken = new Set(this.lobby.seats.map((s) => s.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
  }

  // ---------- chat ----------

  // A message from a seat. It never goes near the game: the sender and their name come from the seat (for players who
  // joined, the connection it arrived on), and the text is cleaned up and kept short.
  say(seat, text) {
    const s = seat != null && this.lobby.seats[seat];
    if (!s || s.bot || !this.lobby.started) return { ok: false, error: 'You can chat once the game starts.' };
    text = cleanChat(text);
    if (!text) return { ok: false, error: 'Type a message first.' };
    if (!this.chatLimit.allow(seat)) return { ok: false, error: 'Hold on a second before sending another message.' };
    const m = { id: this.chatSeq++, seat, name: s.name, text, at: Date.now() };
    this.chat.push(m);
    if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
    this.save();
    // each message goes out once, on its own: it never rides along with the game updates sent after every move
    if (this.room) for (const connId of this.conns.keys()) this.room.send(connId, { t: 'chat', m });
    this.chatListeners.forEach((fn) => fn(m));
    return { ok: true };
  }

  sendChat(text) {
    const res = this.say(this.mySeat, text);
    return res.ok ? { ...res, sent: true } : res;
  }

  // fn(message) for each new message
  subscribeChat(fn) {
    this.chatListeners.add(fn);
    return () => this.chatListeners.delete(fn);
  }

  // ---------- actions ----------

  send(action) {
    return this.act(this.mySeat, action);
  }

  act(seat, a) {
    if (!a || typeof a !== 'object') return { ok: false, error: 'Bad request.' };
    const hostOnly = ['addBot', 'removeSeat', 'setOption', 'start', 'nextRound', 'endRound', 'playAgain', 'toggleBot', 'startNow'];
    if (hostOnly.includes(a.type) && seat !== 0) return { ok: false, error: 'Only the host can do that.' };
    let res;
    switch (a.type) {
      case 'addBot':
        res = this.addBot();
        break;
      case 'removeSeat':
        if (this.lobby.started || a.seat === 0 || !this.lobby.seats[a.seat]) return { ok: false, error: "Can't remove that player." };
        for (const [cid, s] of this.conns) if (s === a.seat) {
          this.room.send(cid, { t: 'kicked' });
          this.conns.delete(cid);
        }
        this.lobby.seats.splice(a.seat, 1);
        this.reindexAfterRemoval(a.seat);
        res = { ok: true };
        break;
      case 'setOption':
        if (this.lobby.started || !(a.key in DEFAULT_OPTIONS)) return { ok: false, error: "Can't change that now." };
        this.lobby.options[a.key] = a.value;
        res = { ok: true };
        break;
      case 'start':
        if (this.lobby.started) return { ok: false, error: 'Already started.' };
        if (this.lobby.seats.length < 2) return { ok: false, error: 'You need at least 2 players. Add a computer player!' };
        this.lobby.started = true;
        this.game = createGame(this.lobby.seats.map((s) => ({ name: s.name, bot: !!s.bot })), this.lobby.options);
        res = { ok: true };
        break;
      case 'nextRound':
        res = nextRound(this.game);
        break;
      case 'endRound':
        res = endRoundNoWinner(this.game);
        break;
      case 'startNow':
        res = beginPlay(this.game);
        break;
      case 'toggleBot': {
        // let the computer play for someone who dropped off (or hand the seat back)
        const s = this.lobby.seats[a.seat];
        if (!s || s.isHost) return { ok: false, error: "Can't do that." };
        s.bot = !s.bot;
        s.botStandIn = s.bot && !!s.clientId;
        if (this.game) {
          this.game.players[a.seat].bot = s.bot;
          if (s.bot && this.game.phase === 'ready') applyAction(this.game, a.seat, { type: 'ready' });
        }
        res = { ok: true };
        break;
      }
      case 'playAgain':
        this.game = null;
        this.lobby.started = false;
        this.lobby.seats = this.lobby.seats.filter((s) => s.isHost || s.bot || s.connected);
        this.lobby.seats.forEach((s) => s.botStandIn && ((s.bot = false), (s.botStandIn = false)));
        HostSession.clearSaved(this.gameId);
        res = { ok: true };
        break;
      default:
        if (!this.game || seat == null) return { ok: false, error: 'The game has not started.' };
        try {
          res = applyAction(this.game, seat, a);
        } catch (e) {
          console.error(e);
          res = { ok: false, error: 'Something went wrong with that move.' };
        }
    }
    if (res.ok) this.changed();
    return res;
  }

  addBot() {
    if (this.lobby.started) return { ok: false, error: 'The game has already started.' };
    if (this.lobby.seats.length >= MAX_PLAYERS) return { ok: false, error: 'The table is full.' };
    const used = new Set(this.lobby.seats.map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || this.uniqueName('Computer');
    this.lobby.seats.push({ name, bot: true });
    return { ok: true };
  }

  // ---------- bots ----------

  later(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms * (this.lobby.options.botSpeed || 1));
    this.timers.add(t);
    return t;
  }

  clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }

  // With one person playing against the computer, opening a pop-up (the menu, Settings, Scores…) pauses the game:
  // the computers wait and the buy countdown stops, then picks up where it was
  canPause() {
    return this.lobby.seats.filter((s) => !s.bot).length === 1;
  }

  setPaused(on) {
    on = on && this.canPause();
    if (on === !!this.pausedAt) return;
    if (on) {
      this.pausedAt = Date.now();
      this.clearTimers();
      clearTimeout(this.turnTimer);
      return;
    }
    const g = this.game;
    if (g && g.buyWindow) g.buyWindow.deadline += Date.now() - this.pausedAt;
    this.pausedAt = null;
    // the cleared timers are set up again: buy answers, and the computers' Shanghai calls on this discard
    this.askArmed = null;
    this.askFast = null;
    this.reacted.clear();
    this.changed();
  }

  stillAsking(seat) {
    const w = this.game && this.game.buyWindow;
    return !!w && w.order.includes(seat) && w.answers[seat] === undefined;
  }

  // every person in the buy window has answered (the computers still to go don't count)
  peopleAnswered(w) {
    return w.order.every((seat) => this.game.players[seat].bot || w.answers[seat] !== undefined);
  }

  botBuyAnswer(seat, ms) {
    const g = this.game;
    const w = g.buyWindow;
    this.later(ms, () => this.game === g && g.buyWindow === w && this.stillAsking(seat) && this.act(seat, { type: 'buyAnswer', buy: wantsToBuy(viewFor(g, seat)) }));
  }

  scheduleBots() {
    const g = this.game;
    if (this.pausedAt) return;
    // reaction timers re-check themselves when they fire; only the turn timer is reset on every change
    clearTimeout(this.turnTimer);
    this.timers.delete(this.turnTimer);
    if (!g || (g.phase !== 'draw' && g.phase !== 'play')) return;
    const bots = g.players.map((p, i) => (p.bot ? i : -1)).filter((i) => i >= 0);

    // everyone eligible is asked at once: computers answer, players who dropped off pass,
    // and anyone who hasn't answered when the 10 seconds run out passes
    const w = g.buyWindow;
    const askKey = w && `${w.cardId}:${w.deadline}`;
    if (w && this.askArmed !== askKey) {
      this.askArmed = askKey;
      const peopleDone = this.peopleAnswered(w);
      for (const seat of w.order) {
        const s = this.lobby.seats[seat];
        if (g.players[seat].bot) {
          if (!peopleDone) this.botBuyAnswer(seat, 900 + Math.random() * 1200);
        } else if (s && !s.isHost && !s.connected) this.later(300, () => this.stillAsking(seat) && this.act(seat, { type: 'buyAnswer', buy: false }));
      }
      const t = setTimeout(() => {
        this.timers.delete(t);
        if (this.game === g && g.buyWindow === w && w.deadline <= Date.now() + 50) {
          buyTimeout(g);
          this.changed();
        }
      }, Math.max(0, w.deadline - Date.now()) + 250);
      this.timers.add(t);
    }
    // once every person being asked has answered, the computers answer quickly: nobody is left needing time to think
    if (w && this.askFast !== askKey && this.peopleAnswered(w)) {
      this.askFast = askKey;
      for (const seat of w.order) if (g.players[seat].bot) this.botBuyAnswer(seat, 400 + Math.random() * 500);
    }

    // Shanghai calls on the latest discard, decided once per discard per bot
    if (g.phase === 'draw') {
      const key = `${g.round}:${g.discard.length}:${g.discard[g.discard.length - 1]?.id}`;
      for (const seat of bots) {
        if (seat === g.turn || sittingOut(g, seat) || this.reacted.has(key + ':' + seat)) continue;
        const v = viewFor(g, seat);
        if (!seesShanghai(v)) continue;
        this.reacted.add(key + ':' + seat);
        const { calls, delay } = shanghaiReaction(g.options);
        if (calls)
          this.later(delay, () => this.game === g && seesShanghai(viewFor(g, seat)) && this.act(seat, { type: 'shanghai' }));
      }
      if (this.reacted.size > 500) this.reacted.clear();
    }

    if (!g.players[g.turn].bot) return;
    const seat = g.turn;
    if (g.phase === 'draw') {
      if (g.buyWindow) return; // wait for buyers; resolving the window reschedules us
      // give people time to spot and call Shanghai before the bot draws (the window closes on the draw); with no piles on
      // the table nothing can be a Shanghai, so there's nothing to wait for. Once nobody bought it, draw a little sooner
      // (after a buy, the usual pause lets the bought card fly to the buyer first)
      const callable = g.lastDiscard && g.lastDiscard.open && !g.buyOffered && g.melds.length > 0;
      const wait = callable ? 6000 : g.buyOffered ? 800 : 1500;
      this.turnTimer = this.later(wait, () => {
        const a = chooseDraw(viewFor(g, seat));
        if (a) this.act(seat, a);
      });
    } else {
      this.turnTimer = this.later(900, () => {
        const res = this.act(seat, choosePlay(viewFor(g, seat)));
        // never let a confused bot freeze the table
        if (!res.ok) {
          const hand = g.hands[seat];
          if (g.phase === 'play' && g.turn === seat && hand.length > 1) this.act(seat, { type: 'discard', id: hand[0].id });
        }
      });
    }
  }

  close() {
    this.clearTimers();
    // tell everyone the host left on purpose, so they don't just see a dropped connection
    this.room && this.room.close({ t: 'bye' });
  }
}

// What a non-host player uses: same interface as HostSession.
export class ClientSession {
  constructor({ code, name, clientId, join }) {
    this.listeners = new Set();
    this.snap = { status: 'connecting', lobby: null, view: null, seat: null, isHost: false, code };
    this.code = code;
    this.chatListeners = new Set();
    // this phone's own copy of the chat, so it's there straight away after a quick reconnect
    this.chat = loadJoinedChat(code);
    this.link = join(code, {
      onOpen: () => this.link.send({ t: 'hello', clientId, name }),
      onMessage: (msg) => {
        if (msg.t === 'state') this.update({ ...msg.s, status: 'connected', isHost: false });
        else if (msg.t === 'err') this.listeners.forEach((fn) => fn({ ...this.snap, toastError: msg.msg, errSeq: Math.random() }));
        else if (msg.t === 'kicked') this.update({ ...this.snap, status: 'kicked' });
        else if (msg.t === 'bye') this.update({ ...this.snap, hostLeft: true });
        else if (msg.t === 'chat') this.gotChat([msg.m], true);
        else if (msg.t === 'chatAll') this.gotChat(msg.list, false, true);
      },
      onStatus: (status, detail) => {
        if (this.snap.status === 'kicked') return;
        this.update({ ...this.snap, status, error: detail });
      },
    });
  }

  // live: just sent, so it can pop up; whole: the host's full list (on joining), which replaces ours
  gotChat(list, live, whole = false) {
    if (!Array.isArray(list)) return;
    const ok = list.filter((m) => m && Number.isInteger(m.id) && typeof m.text === 'string' && typeof m.name === 'string');
    if (whole) this.chat = ok.slice(-CHAT_KEEP);
    else {
      const have = new Set(this.chat.map((m) => m.id));
      ok.forEach((m) => !have.has(m.id) && this.chat.push(m));
      this.chat = this.chat.slice(-CHAT_KEEP);
    }
    saveJoinedChat(this.code, this.chat);
    this.chatListeners.forEach((fn) => fn(live ? ok[ok.length - 1] : null));
  }

  sendChat(text) {
    text = cleanChat(text);
    if (!text) return { ok: false, error: 'Type a message first.' };
    this.link.send({ t: 'chat', text });
    return { ok: true, pending: true, sent: true };
  }

  subscribeChat(fn) {
    this.chatListeners.add(fn);
    return () => this.chatListeners.delete(fn);
  }

  update(snap) {
    this.snap = snap;
    this.listeners.forEach((fn) => fn(snap));
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  send(action) {
    this.link.send({ t: 'act', a: action });
    return { ok: true, pending: true };
  }

  close() {
    this.link.close();
  }
}

// The chat of games other people host, kept on this phone (the 5 most recent games)
const JOINED_CHAT_KEY = 'shanghai.joinedChat';
const JOINED_CHAT_GAMES = 5;
function loadJoinedChat(code) {
  try {
    const all = JSON.parse(localStorage.getItem(JOINED_CHAT_KEY)) || {};
    return Array.isArray(all[code] && all[code].list) ? all[code].list : [];
  } catch {
    return [];
  }
}
function saveJoinedChat(code, list) {
  try {
    const all = JSON.parse(localStorage.getItem(JOINED_CHAT_KEY)) || {};
    all[code] = { at: Date.now(), list };
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, JOINED_CHAT_GAMES);
    localStorage.setItem(JOINED_CHAT_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {}
}
