// Runs in the host's browser: owns the lobby and the game, drives the bots, and sends each
// player their own view of the game.

import { createGame, applyAction, viewFor, nextRound, endRoundNoWinner } from './engine.js';
import { chooseDraw, choosePlay, wantsToBuy, seesShanghai } from './bot.js';
import { DEFAULT_OPTIONS, MAX_PLAYERS } from './rules.js';
import { openRoom, randomCode } from './net.js';

const BOT_NAMES = ['Lucky Lou', 'Card Shark', 'Rummy Rita', 'Jolly Joker', 'Shuffles', 'Ace', 'Sir Deals-a-Lot', 'Queenie'];
const SAVE_KEY = 'shanghai.hostGame';

export class HostSession {
  // solo: no network room, just you against bots
  constructor({ name, clientId, solo = false, restore = null }) {
    this.listeners = new Set();
    this.conns = new Map(); // connId -> seat (or null while in lobby without a seat yet)
    this.timers = new Set();
    this.reacted = new Set();
    this.solo = solo;
    this.clientId = clientId;
    this.status = solo ? 'connected' : 'starting';

    if (restore) {
      this.lobby = restore.lobby;
      this.game = restore.game;
      this.lobby.seats.forEach((s) => {
        if (!s.bot && !s.isHost) s.connected = false;
      });
    } else {
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
      localStorage.setItem(SAVE_KEY, JSON.stringify({ lobby: this.lobby, game: this.game, solo: this.solo, savedAt: Date.now() }));
    } catch {}
  }

  static saved() {
    try {
      const s = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (s && s.game && s.game.phase !== 'gameOver') return s;
    } catch {}
    return null;
  }

  static clearSaved() {
    try {
      localStorage.removeItem(SAVE_KEY);
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

  // ---------- actions ----------

  send(action) {
    return this.act(this.mySeat, action);
  }

  act(seat, a) {
    if (!a || typeof a !== 'object') return { ok: false, error: 'Bad request.' };
    const hostOnly = ['addBot', 'removeSeat', 'setOption', 'start', 'nextRound', 'endRound', 'playAgain', 'toggleBot'];
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
      case 'toggleBot': {
        // let the computer play for someone who dropped off (or hand the seat back)
        const s = this.lobby.seats[a.seat];
        if (!s || s.isHost) return { ok: false, error: "Can't do that." };
        s.bot = !s.bot;
        s.botStandIn = s.bot && !!s.clientId;
        if (this.game) this.game.players[a.seat].bot = s.bot;
        res = { ok: true };
        break;
      }
      case 'playAgain':
        this.game = null;
        this.lobby.started = false;
        this.lobby.seats = this.lobby.seats.filter((s) => s.isHost || s.bot || s.connected);
        this.lobby.seats.forEach((s) => s.botStandIn && ((s.bot = false), (s.botStandIn = false)));
        HostSession.clearSaved();
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

  scheduleBots() {
    const g = this.game;
    // reaction timers re-check themselves when they fire; only the turn timer is reset on every change
    clearTimeout(this.turnTimer);
    this.timers.delete(this.turnTimer);
    if (!g || (g.phase !== 'draw' && g.phase !== 'play')) return;
    const bots = g.players.map((p, i) => (p.bot ? i : -1)).filter((i) => i >= 0);
    if (!bots.length) return;

    // reactions to the latest discard: Shanghai calls and buys, decided once per discard per bot
    if (g.phase === 'draw') {
      const key = `${g.round}:${g.discard.length}:${g.discard[g.discard.length - 1]?.id}`;
      for (const seat of bots) {
        if (seat === g.turn || this.reacted.has(key + ':' + seat)) continue;
        const v = viewFor(g, seat);
        const call = seesShanghai(v) && Math.random() < 0.75;
        const buy = wantsToBuy(v);
        if (!call && !buy) continue;
        this.reacted.add(key + ':' + seat);
        if (call) this.later(1200 + Math.random() * 2500, () => this.game === g && seesShanghai(viewFor(g, seat)) && this.act(seat, { type: 'shanghai' }));
        if (buy) this.later(500 + Math.random() * 1200, () => this.game === g && g.phase === 'draw' && wantsToBuy(viewFor(g, seat)) && this.act(seat, { type: 'buy' }));
      }
      if (this.reacted.size > 500) this.reacted.clear();
    }

    if (!g.players[g.turn].bot) return;
    const seat = g.turn;
    if (g.phase === 'draw') {
      // give people a moment to buy or call Shanghai before the bot draws
      const wait = g.lastDiscard && g.lastDiscard.open ? 3200 : 1600;
      this.turnTimer = this.later(wait, () => this.act(seat, chooseDraw(viewFor(g, seat))));
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
    this.room && this.room.close();
  }
}

// What a non-host player uses: same interface as HostSession.
export class ClientSession {
  constructor({ code, name, clientId, join }) {
    this.listeners = new Set();
    this.snap = { status: 'connecting', lobby: null, view: null, seat: null, isHost: false, code };
    this.code = code;
    this.link = join(code, {
      onOpen: () => this.link.send({ t: 'hello', clientId, name }),
      onMessage: (msg) => {
        if (msg.t === 'state') this.update({ ...msg.s, status: 'connected', isHost: false });
        else if (msg.t === 'err') this.listeners.forEach((fn) => fn({ ...this.snap, toastError: msg.msg, errSeq: Math.random() }));
        else if (msg.t === 'kicked') this.update({ ...this.snap, status: 'kicked' });
      },
      onStatus: (status, detail) => {
        if (this.snap.status === 'kicked') return;
        this.update({ ...this.snap, status, error: detail });
      },
    });
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
