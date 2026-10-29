// Runs in the host's browser: owns the lobby and the game, drives the bots, and sends each
// player their own view of the game.

import {
  createGame,
  applyAction,
  viewFor,
  nextRound,
  endRoundNoWinner,
  endIfPastLastRound,
  buyTimeout,
  beginPlay,
  sittingOut,
  startRound,
  newStats,
} from './engine.js';
import { chooseDraw, choosePlay, wantsToBuy, seesShanghai, shanghaiReaction } from './bot.js';
import { DEFAULT_OPTIONS, MAX_PLAYERS, isLastRound } from './rules.js';
import { openRoom, randomCode } from './net.js';
import { cleanChat, ChatLimit, CHAT_KEEP, CHAT_MAX } from './chat.js';
import {
  MAX_TOUR_PLAYERS,
  MIN_TABLE,
  MAX_TABLE,
  tableRange,
  suggestTables,
  dealTables,
  rankTable,
  nextTables,
  tableStats,
  moveCount,
  moveLine,
  tieAtLine,
  drawCard,
  settleDraw,
} from './tournament.js';

const BOT_NAMES = ['Lucky Lou', 'Card Shark', 'Rummy Rita', 'Jolly Joker', 'Shuffles', 'Ace', 'Sir Deals-a-Lot', 'Queenie'];
// each game you host (or play against the computer) is saved under its own key so several can be resumed
const SAVE_PREFIX = 'shanghai.hostGame.';
const OLD_SAVE_KEY = 'shanghai.hostGame'; // the single save slot older versions used
const newGameId = () => Math.random().toString(36).slice(2, 10);
export const TIE_DRAW_MS = 10000; // Tables (BETA): how long the people in a tie have to draw before a card is drawn for them

// fields a game saved by an older version may lack (stats: null, so a game saved before they were counted shows no
// "How everyone played" rather than wrong numbers), and what never carries over a reload
function restoreGame(g) {
  return Object.assign(g, { mustPlay: [], buyOffered: false, stats: null, ...g, buyWindow: null, earlyBuy: null });
}

export class HostSession {
  // solo: no network room, just you against bots
  constructor({ name, clientId, solo = false, restore = null }) {
    this.listeners = new Set();
    this.conns = new Map(); // connId -> seat (or null while in lobby without a seat yet)
    this.timers = new Set();
    this.drivers = new WeakMap(); // game -> the computers' timers and notes for it
    this.touched = new Set(); // games changed since the computers were last scheduled (none: all of them)
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
      this.lobby.mode = this.lobby.mode || 'one';
      this.game = restore.game ? restoreGame(restore.game) : null;
      this.tour = restore.tour || null;
      if (this.tour) {
        this.tour.games.forEach(restoreGame);
        // a draw for a tie that was under way starts its 10 seconds again
        for (const g of this.tour.games) if (g.tie && !g.tie.done) g.tie.deadline = Date.now() + TIE_DRAW_MS;
        if (this.tour.tbGame) restoreGame(this.tour.tbGame);
        this.tour.watching = {};
      }
      // saved between rounds when there were 11: past round 7 it goes straight to the final scores
      if (this.game) endIfPastLastRound(this.game);
      this.lobby.seats.forEach((s) => {
        if (!s.bot && !s.isHost) s.connected = false;
      });
    } else {
      this.gameId = newGameId();
      this.lobby = {
        code: solo ? null : randomCode(),
        started: false,
        options: { ...DEFAULT_OPTIONS },
        mode: 'one', // or 'tables': Tables (BETA), see tournament.js
        tableCount: null,
        seats: [{ name, clientId, isHost: true, connected: true }],
      };
      this.game = null;
      this.tour = null;
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
    const tour = this.tour ? this.tourSnapshot(seat) : null;
    return {
      status: this.status,
      error: this.error,
      isHost: seat === 0,
      solo: this.solo,
      lobby: {
        code: this.lobby.code,
        started: this.lobby.started,
        options: this.lobby.options,
        mode: this.lobby.mode,
        tableCount: this.lobby.mode === 'tables' ? this.lobbyTableCount() : null,
        seats: this.lobby.seats.map((s) => ({
          name: s.name,
          bot: !!s.bot,
          standIn: !!s.botStandIn,
          isHost: !!s.isHost,
          connected: !!s.connected || !!s.bot,
          table: this.lobby.mode === 'tables' ? (s.table ?? 0) : null,
        })),
      },
      seat,
      view: tour ? tour.view : this.game ? viewFor(this.game, seat) : null,
      tour: tour ? tour.info : null,
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
    if (!this.lobby.started) this.fitLobbyTables();
    this.save();
    this.emit();
    this.scheduleBots();
  }

  save() {
    if (!this.game && !this.tour) return;
    try {
      const data = { id: this.gameId, lobby: this.lobby, game: this.game, tour: this.tour, chat: this.chat, solo: this.solo, savedAt: Date.now() };
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
          const going = s && ((s.tour && s.tour.phase !== 'gameOver') || (!s.tour && s.game && s.game.phase !== 'gameOver'));
          if (going) games.push({ ...s, id: key.slice(SAVE_PREFIX.length) });
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
      const res = this.say(this.conns.get(connId), msg.text, msg.to);
      // marked as chat, with what they typed, so it shows in their chat and the text goes back in the box
      if (!res.ok) this.room.send(connId, { t: 'err', msg: res.error, chat: true, text: String(msg.text || '').slice(0, CHAT_MAX) });
    }
  }

  maxSeats() {
    return this.lobby.mode === 'tables' ? MAX_TOUR_PLAYERS : MAX_PLAYERS;
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
      } else if (seats.length >= this.maxSeats()) {
        this.room.send(connId, { t: 'err', msg: 'The table is full.' });
        return;
      } else {
        seats.push({ name: this.uniqueName(name), clientId, connected: true });
        seat = seats.length - 1;
        this.seatAtTable(seat);
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
        this.setBot(seat, false);
      }
    }
    this.conns.set(connId, seat);
    this.changed();
    // the whole chat so far, so someone coming back sees what they missed
    this.sendChatAll(connId, seat);
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
  // joined, the connection it arrived on), and the text is cleaned up and kept short. In a Tables game it goes to
  // everyone, or (to: 'table') just the table they're at or watching this round.
  say(seat, text, to = 'all') {
    const s = seat != null && this.lobby.seats[seat];
    if (!s || s.bot || !this.lobby.started) return { ok: false, error: 'You can chat once the game starts.' };
    text = cleanChat(text);
    if (!text) return { ok: false, error: 'Type a message first.' };
    if (!this.chatLimit.allow(seat)) return { ok: false, error: 'Hold on a second, then send it again.' };
    const m = { id: this.chatSeq++, seat, name: s.name, text, at: Date.now() };
    const table = to === 'table' ? this.chatTable(seat) : null;
    if (table != null) Object.assign(m, { table, round: this.tour.round, watching: this.tour.watching[seat] != null });
    this.chat.push(m);
    if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
    this.save();
    // each message goes out once, on its own: it never rides along with the game updates sent after every move
    if (this.room) for (const [connId, seat] of this.conns) if (this.canSeeChat(m, seat)) this.room.send(connId, { t: 'chat', m });
    if (this.canSeeChat(m, this.mySeat)) this.chatListeners.forEach((fn) => fn(m));
    return { ok: true };
  }

  sendChat(text, to) {
    const res = this.say(this.mySeat, text, to);
    return res.ok ? { ...res, sent: true } : res;
  }

  // the table whose chat a seat is in: the one they're watching, else their own (none outside a Tables round)
  chatTable(seat) {
    const t = this.tour;
    if (!t || (t.phase !== 'playing' && t.phase !== 'between')) return null;
    const at = t.watching[seat] ?? this.tableAt(seat);
    return at >= 0 ? at : null;
  }

  canSeeChat(m, seat) {
    if (m.table == null) return true;
    const t = this.tour;
    return !!t && seat != null && m.round === t.round && (this.tableAt(seat) === m.table || t.watching[seat] === m.table);
  }

  sendChatAll(connId, seat) {
    this.room.send(connId, { t: 'chatAll', list: this.chat.filter((m) => this.canSeeChat(m, seat)) });
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
    const hostOnly = ['addBot', 'removeSeat', 'setOption', 'start', 'nextRound', 'endRound', 'playAgain', 'toggleBot', 'startNow', 'setMode', 'setTables', 'shuffleTables', 'moveSeat'];
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
      case 'setMode':
      case 'setTables':
      case 'shuffleTables':
      case 'moveSeat':
        res = this.lobbyTables(a);
        break;
      case 'start':
        if (this.lobby.started) return { ok: false, error: 'Already started.' };
        if (this.lobby.mode === 'tables') {
          res = this.startTour();
          break;
        }
        if (this.lobby.seats.length < 2) return { ok: false, error: 'You need at least 2 players. Add a computer player!' };
        if (this.lobby.seats.length > MAX_PLAYERS) return { ok: false, error: `One table seats up to ${MAX_PLAYERS}. Try Tables, or remove some players.` };
        this.lobby.started = true;
        this.game = createGame(this.lobby.seats.map((s) => ({ name: s.name, bot: !!s.bot })), this.lobby.options);
        res = { ok: true };
        break;
      case 'nextRound':
        res = this.tour ? this.nextTourRound() : nextRound(this.game);
        break;
      case 'endRound':
      case 'startNow': {
        const g = this.tour ? this.hostTableGame() : this.game;
        if (!g) return { ok: false, error: 'No round in progress.' };
        this.touch(g);
        res = a.type === 'endRound' ? endRoundNoWinner(g) : beginPlay(g);
        break;
      }
      case 'toggleBot': {
        // let the computer play for someone who dropped off (or hand the seat back)
        const s = this.lobby.seats[a.seat];
        if (!s || s.isHost) return { ok: false, error: "Can't do that." };
        s.bot = !s.bot;
        s.botStandIn = s.bot && !!s.clientId;
        this.setBot(a.seat, s.bot);
        res = { ok: true };
        break;
      }
      case 'playAgain':
        this.game = null;
        this.tour = null;
        this.lobby.started = false;
        this.lobby.seats = this.lobby.seats.filter((s) => s.isHost || s.bot || s.connected);
        this.lobby.seats.forEach((s) => s.botStandIn && ((s.bot = false), (s.botStandIn = false)));
        this.fitLobbyTables();
        HostSession.clearSaved(this.gameId);
        res = { ok: true };
        break;
      case 'watch':
        res = this.watch(seat, a.table);
        break;
      case 'tieDraw':
        res = this.tieDraw(seat);
        break;
      default: {
        if (this.tour && a.type === 'tieVote' && this.tour.phase === 'tieVote') {
          res = this.tourTieVote(seat, a.choice);
          break;
        }
        const at = this.tour ? this.gameFor(seat) : this.game && seat != null ? { g: this.game, local: seat } : null;
        if (!at) return { ok: false, error: this.tour ? "You're not at a table right now." : 'The game has not started.' };
        this.touch(at.g);
        try {
          res = applyAction(at.g, at.local, a);
        } catch (e) {
          console.error(e);
          res = { ok: false, error: 'Something went wrong with that move.' };
        }
      }
    }
    if (res.ok) {
      if (this.tour) this.checkTour();
      this.changed();
    }
    return res;
  }

  addBot() {
    if (this.lobby.started) return { ok: false, error: 'The game has already started.' };
    if (this.lobby.seats.length >= this.maxSeats()) return { ok: false, error: 'The table is full.' };
    const used = new Set(this.lobby.seats.map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || this.uniqueName('Computer');
    this.lobby.seats.push({ name, bot: true });
    this.seatAtTable(this.lobby.seats.length - 1);
    return { ok: true };
  }

  // a seat's computer switched on or off, in whichever game they're playing
  setBot(seat, bot) {
    const at = this.tour ? this.gameFor(seat) : this.game ? { g: this.game, local: seat } : null;
    if (!at) return;
    at.g.players[at.local].bot = bot;
    this.touch(at.g);
    if (bot && at.g.phase === 'ready') applyAction(at.g, at.local, { type: 'ready' });
  }

  // ---------- Tables (BETA): the lobby ----------

  // How many tables the lobby is set for: the host's pick, kept within what the players can make
  lobbyTableCount() {
    const n = this.lobby.seats.length;
    const r = tableRange(n);
    const want = this.lobby.tableCount ?? suggestTables(n);
    return r ? Math.min(r.max, Math.max(r.min, want)) : Math.max(2, Math.min(want, 2));
  }

  // Every seat at one of the tables: anyone without one (or at a table that's gone) goes to the smallest
  fitLobbyTables() {
    if (this.lobby.mode !== 'tables') return;
    const k = this.lobbyTableCount();
    this.lobby.seats.forEach((s, i) => {
      if (!(s.table >= 0 && s.table < k)) {
        delete s.table;
        this.seatAtTable(i);
      }
    });
  }

  seatAtTable(seat) {
    if (this.lobby.mode !== 'tables') return;
    const k = this.lobbyTableCount();
    // until the host arranges the tables themselves, they're dealt again whenever there are enough people for one more
    if (this.lobby.tableCount == null && k !== this.lobby.autoTables) return this.shuffleLobbyTables();
    const sizes = Array.from({ length: k }, (_, t) => this.lobby.seats.filter((s, i) => i !== seat && s.table === t).length);
    this.lobby.seats[seat].table = sizes.indexOf(Math.min(...sizes));
  }

  shuffleLobbyTables() {
    const seats = this.lobby.seats;
    this.lobby.autoTables = this.lobbyTableCount();
    dealTables(seats.map((_, i) => i), this.lobby.autoTables).forEach((t, k) => t.forEach((i) => (seats[i].table = k)));
  }

  lobbyTables(a) {
    if (this.lobby.started) return { ok: false, error: 'The game has already started.' };
    const seats = this.lobby.seats;
    if (a.type === 'setMode') {
      if (a.mode !== 'one' && a.mode !== 'tables') return { ok: false, error: 'Unknown choice.' };
      this.lobby.mode = a.mode;
      if (a.mode === 'tables') this.shuffleLobbyTables();
      return { ok: true };
    }
    if (this.lobby.mode !== 'tables') return { ok: false, error: 'Pick Tables first.' };
    if (a.type === 'setTables') {
      const r = tableRange(seats.length);
      if (!r || !(a.count >= r.min && a.count <= r.max)) return { ok: false, error: r ? `${seats.length} players can make ${r.min} to ${r.max} tables.` : 'Tables needs at least 6 players.' };
      this.lobby.tableCount = a.count;
      this.shuffleLobbyTables();
      return { ok: true };
    }
    // once the host shuffles or moves anyone, the number of tables stays as it is while people join
    this.lobby.tableCount = this.lobbyTableCount();
    if (a.type === 'shuffleTables') {
      this.shuffleLobbyTables();
      return { ok: true };
    }
    // moveSeat: to another table, or swap places with someone (with: their seat)
    const s = seats[a.seat];
    if (!s) return { ok: false, error: "Can't move that player." };
    if (a.with != null) {
      const o = seats[a.with];
      if (!o) return { ok: false, error: "Can't move that player." };
      [s.table, o.table] = [o.table, s.table];
      return { ok: true };
    }
    if (!(a.table >= 0 && a.table < this.lobbyTableCount())) return { ok: false, error: 'There is no table like that.' };
    if (seats.filter((x) => x.table === a.table).length >= MAX_TABLE) return { ok: false, error: `A table seats up to ${MAX_TABLE}.` };
    s.table = a.table;
    return { ok: true };
  }

  // ---------- Tables (BETA): the game ----------
  // this.tour: { round, tables (seats at each table this round, winners' table first), games (each table's game of
  // this one round, its players in the table's order), history (round -> seat -> table), scores (seat -> points per
  // round), stats (seat -> counts, for How everyone played), phase ('playing' | 'between' | 'tieVote' | 'tiebreak' |
  // 'gameOver'), next and moves (next round's tables, once every table is done), watching (seat -> table), tiebreak,
  // tbGame (a tiebreaker's game, just the tied players), winners }

  startTour() {
    const seats = this.lobby.seats;
    const r = tableRange(seats.length);
    if (!r) return { ok: false, error: 'Tables needs at least 6 players. Add computer players, or pick One table.' };
    this.fitLobbyTables();
    const k = this.lobbyTableCount();
    const tables = Array.from({ length: k }, (_, t) => seats.map((_, i) => i).filter((i) => seats[i].table === t));
    const small = tables.findIndex((t) => t.length < MIN_TABLE);
    if (small >= 0) return { ok: false, error: `Table ${small + 1} needs at least ${MIN_TABLE} players.` };
    const big = tables.findIndex((t) => t.length > MAX_TABLE);
    if (big >= 0) return { ok: false, error: `Table ${big + 1} has more than ${MAX_TABLE} players.` };
    this.lobby.started = true;
    this.tour = {
      round: 0,
      tables,
      games: [],
      history: [],
      scores: seats.map(() => []),
      stats: seats.map(() => ({ ...newStats(), topRounds: 0, longestStay: 0 })),
      phase: 'playing',
      next: null,
      moves: null,
      watching: {},
      tiebreak: null,
      tbGame: null,
      winners: null,
    };
    this.dealTour();
    return { ok: true };
  }

  // each table's game of this round, and who sat where
  dealTour() {
    const t = this.tour;
    const seats = this.lobby.seats;
    t.games = t.tables.map((at) => createGame(at.map((i) => ({ name: seats[i].name, bot: !!seats[i].bot })), this.lobby.options, Math.random, { round: t.round, oneRound: true }));
    const where = seats.map(() => null);
    t.tables.forEach((at, k) => at.forEach((i) => (where[i] = k)));
    t.history[t.round] = where;
    t.watching = {};
    t.phase = 'playing';
    // a table of computers has nobody to look over their cards: it starts at once
    for (const g of t.games) if (g.ready.every(Boolean)) beginPlay(g);
  }

  tableAt(seat) {
    return this.tour ? this.tour.tables.findIndex((at) => at.includes(seat)) : -1;
  }

  // the game a seat plays in right now, and their seat in it
  gameFor(seat) {
    const t = this.tour;
    if (!t || seat == null) return null;
    if (t.phase === 'tiebreak') {
      const local = t.tiebreak.seats.indexOf(seat);
      return local >= 0 ? { g: t.tbGame, local } : null;
    }
    if (t.phase !== 'playing' && t.phase !== 'between') return null;
    const k = this.tableAt(seat);
    return k >= 0 ? { g: t.games[k], local: t.tables[k].indexOf(seat) } : null;
  }

  // the host's Start now and End round work on the table they're watching, else their own
  hostTableGame() {
    const t = this.tour;
    if (t.phase === 'tiebreak') return t.tbGame;
    if (t.phase !== 'playing') return null;
    return t.games[t.watching[0] ?? this.tableAt(0)] || null;
  }

  watch(seat, table) {
    const t = this.tour;
    if (!t || t.phase !== 'playing' || seat == null) return { ok: false, error: 'There is nothing to watch right now.' };
    if (table == null) delete t.watching[seat];
    else {
      const own = this.tableAt(seat);
      if (!t.games[table] || table === own) return { ok: false, error: 'There is no table like that.' };
      if (own >= 0 && !t.games[own].counted) return { ok: false, error: 'Finish your own round first.' };
      t.watching[seat] = table;
    }
    // their chat changes with it: the table's messages this round
    if (this.room) for (const [connId, s] of this.conns) if (s === seat) this.sendChatAll(connId, seat);
    return { ok: true };
  }

  // After every change: take each finished table's points, and once every table is done, work out next round's tables
  checkTour() {
    const t = this.tour;
    if (t.phase === 'playing') {
      t.games.forEach((g, k) => g.phase === 'roundOver' && !g.counted && this.countTable(k));
      if (t.games.every((g) => g.counted && !(g.tie && !g.tie.done))) this.endTourRound();
    } else if (t.phase === 'tiebreak' && t.tbGame.phase === 'gameOver') {
      const g = t.tbGame;
      const seats = t.tiebreak.seats;
      this.addStats(g, seats);
      t.tiebreak.points = this.lobby.seats.map((_, i) => (seats.includes(i) ? g.tiebreak.points[seats.indexOf(i)] : null));
      t.tiebreak.playing = false;
      t.winners = g.winners.map((l) => seats[l]);
      t.phase = 'gameOver';
    }
  }

  addStats(g, seats) {
    if (!g.stats) return;
    g.stats.forEach((st, l) => {
      const into = this.tour.stats[seats[l]];
      for (const key of Object.keys(st)) into[key] = (into[key] || 0) + st[key];
    });
  }

  countTable(k) {
    const t = this.tour;
    const g = t.games[k];
    g.counted = true;
    g.roundResult.points.forEach((p, l) => (t.scores[t.tables[k][l]][t.round] = p));
    this.addStats(g, t.tables[k]);
    // best to worst this round, so everyone at the table can see at once where they're going next
    const totals = this.tourTotals();
    const w = g.roundResult.winner;
    const points = t.scores.map((s) => s[t.round] || 0);
    g.ranked = rankTable(t.tables[k], { points, totals, wentOut: w == null ? null : t.tables[k][w] });
    // people level on points and total across the line between moving and staying draw cards for it (nobody moves
    // after the last round)
    if (isLastRound(t.round)) return;
    const tie = tieAtLine(g.ranked, moveLine(k, g.ranked.length, moveCount(t.tables)), { points, totals });
    if (tie) g.tie = { ...tie, places: tie.need, all: tie.seats, tries: [{}], good: [], bad: [], deadline: Date.now() + TIE_DRAW_MS, done: false };
  }

  // Someone in a tie at their table draws a card (high card loses). Once they all have, the ones level on the card
  // right at the line draw again; when it's settled, the table's ranking takes their order.
  tieDraw(seat) {
    const t = this.tour;
    const g = t && t.phase === 'playing' ? t.games[this.tableAt(seat)] : null;
    const tie = g && g.tie;
    if (!tie || tie.done || !tie.seats.includes(seat)) return { ok: false, error: 'There is no card to draw.' };
    const cards = tie.tries[tie.tries.length - 1];
    if (cards[seat]) return { ok: false, error: 'You already drew a card.' };
    cards[seat] = drawCard(Object.values(cards));
    if (tie.seats.every((s) => cards[s])) {
      const r = settleDraw(tie.seats, cards, tie.need);
      tie.good.push(...r.good);
      tie.bad.unshift(...r.bad);
      if (r.again.length) {
        Object.assign(tie, { seats: r.again, need: r.need, deadline: Date.now() + TIE_DRAW_MS });
        tie.tries.push({});
      } else {
        tie.done = true;
        g.ranked.splice(Math.min(...tie.all.map((s) => g.ranked.indexOf(s))), tie.all.length, ...tie.good, ...tie.bad);
      }
    }
    this.touch(g);
    return { ok: true };
  }

  tourTotals() {
    return this.tour.scores.map((s) => s.reduce((a, b) => a + (b || 0), 0));
  }

  endTourRound() {
    const t = this.tour;
    const totals = this.tourTotals();
    if (isLastRound(t.round)) return this.settleTour(totals);
    // this round's tables stay as they are until the host deals the next one
    const { tables, moves } = nextTables(t.games.map((g) => g.ranked));
    Object.assign(t, { next: tables, moves, phase: 'between' });
  }

  nextTourRound() {
    const t = this.tour;
    if (t.phase !== 'between') return { ok: false, error: 'The round is not over.' };
    t.tables = t.next;
    t.next = null;
    t.moves = null;
    t.round++;
    this.dealTour();
    return { ok: true };
  }

  // After the last round: lowest total wins. A tie for it goes to a vote among the tied people, as in a one-table game.
  settleTour(totals) {
    const t = this.tour;
    t.stats.forEach((st, i) => Object.assign(st, tableStats(t.history, i)));
    const best = Math.min(...totals);
    const tied = totals.map((_, i) => i).filter((i) => totals[i] === best);
    if (tied.length > 1 && tied.some((i) => !this.lobby.seats[i].bot)) {
      t.tiebreak = { seats: tied, votes: {}, playing: false, points: null };
      t.phase = 'tieVote';
      return;
    }
    t.winners = tied;
    t.phase = 'gameOver';
  }

  tourTieVote(seat, choice) {
    const t = this.tour;
    const tb = t.tiebreak;
    if (!tb.seats.includes(seat) || this.lobby.seats[seat].bot) return { ok: false, error: 'Only the tied players choose.' };
    if (choice !== 'share' && choice !== 'tiebreak') return { ok: false, error: 'Unknown choice.' };
    tb.votes[seat] = choice;
    if (choice === 'share') {
      t.winners = tb.seats;
      t.phase = 'gameOver';
      return { ok: true };
    }
    if (tb.seats.every((i) => this.lobby.seats[i].bot || tb.votes[i] === 'tiebreak')) {
      // the last round's contract again, just the tied players at one table
      const seats = this.lobby.seats;
      const g = createGame(tb.seats.map((i) => ({ name: seats[i].name, bot: !!seats[i].bot })), this.lobby.options, Math.random, { round: t.round });
      g.tiebreak = { seats: tb.seats.map((_, l) => l), votes: {}, playing: true, points: null };
      g.stats = g.players.map(() => newStats());
      startRound(g, { tiebreaker: true });
      t.tbGame = g;
      tb.playing = true;
      t.phase = 'tiebreak';
    }
    return { ok: true };
  }

  // What a seat sees of a Tables game: their table's game (or the one they're watching, with every hand hidden), or at
  // the end the whole group as one game, so the end screens and score sheet work as they do for one table
  tourSnapshot(seat) {
    const t = this.tour;
    const own = this.tableAt(seat);
    let view;
    let viewSeats;
    if (t.phase === 'playing' || t.phase === 'between') {
      const w = t.phase === 'playing' ? t.watching[seat] : undefined;
      const k = w ?? own;
      if (k >= 0) {
        viewSeats = t.tables[k];
        view = viewFor(t.games[k], w == null ? t.tables[k].indexOf(seat) : null);
      }
    } else if (t.phase === 'tiebreak') {
      viewSeats = t.tiebreak.seats;
      const local = viewSeats.indexOf(seat);
      view = viewFor(t.tbGame, local >= 0 ? local : null);
    }
    if (!view) {
      viewSeats = this.lobby.seats.map((_, i) => i);
      view = this.summaryView(seat);
    }
    const info = {
      round: t.round,
      phase: t.phase,
      table: own,
      watching: t.phase === 'playing' ? (t.watching[seat] ?? null) : null,
      viewSeats,
      tables: t.tables.map((at, k) => {
        const g = t.games[k];
        const rr = g.roundResult;
        return {
          seats: at,
          done: !!g.counted,
          phase: g.phase,
          turn: at[g.turn],
          laid: g.laid.filter(Boolean).length,
          wentOut: rr && rr.winner != null ? at[rr.winner] : null,
          ranked: g.ranked || null,
          tie: g.tie ? { ...g.tie, msLeft: Math.max(0, g.tie.deadline - Date.now()) } : null,
        };
      }),
      points: t.scores.map((s) => s[t.round] ?? null),
      totals: this.tourTotals(),
      next: t.next,
      moves: t.moves,
      history: t.history,
    };
    return { view, info };
  }

  summaryView(seat) {
    const t = this.tour;
    const n = this.lobby.seats.length;
    const over = t.phase === 'gameOver';
    return {
      you: seat,
      options: this.lobby.options,
      players: this.lobby.seats.map((s) => ({ name: s.name, bot: !!s.bot, out: false, cards: 0, laid: false, buysUsed: 0, blocked: false, ready: true })),
      scores: t.scores.map((s) => Array.from({ length: t.round + 1 }, (_, r) => s[r] ?? 0)),
      round: t.round,
      dealer: -1,
      turn: -1,
      phase: over ? 'gameOver' : 'tieVote',
      deckCount: 0,
      discardTop: null,
      discardBelow: null,
      discardCount: 0,
      topDead: false,
      lastDiscard: null,
      melds: [],
      hand: [],
      turnPlays: 0,
      canUndo: false,
      mustPlay: [],
      buyOffered: false,
      buyEligible: [],
      mustDecide: false,
      earlyBuy: null,
      buyWindow: null,
      roundResult: { winner: null, points: Array.from({ length: n }, (_, i) => t.scores[i][t.round] ?? 0), hands: null },
      log: [],
      seq: 0,
      tiebreak: t.tiebreak,
      winners: t.winners,
      stats: over ? t.stats : null,
    };
  }

  // ---------- bots ----------

  // g: the game the timer belongs to, so pausing one table clears only its timers
  later(ms, fn, g) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (g) this.driver(g).timers.delete(t);
      fn();
    }, ms * (this.lobby.options.botSpeed || 1));
    this.timers.add(t);
    if (g) this.driver(g).timers.add(t);
    return t;
  }

  clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }

  // a game changed: its computers get a fresh look at it next time they're scheduled
  touch(g) {
    if (g) this.touched.add(g);
  }

  // With one person playing against the computer, opening a pop-up (the menu, Settings, Scores…) pauses the game:
  // the computers wait and the buy countdown stops, then picks up where it was. In Tables (BETA) only their own table
  // waits: the tables of only computers play on
  canPause() {
    return this.lobby.seats.filter((s) => !s.bot).length === 1;
  }

  // the game a pause holds: the one the person (the host, seat 0) is playing in, while it's mid-turn
  pauseTarget() {
    const g = this.tour ? this.gameFor(0)?.g : this.game;
    return g && (g.phase === 'draw' || g.phase === 'play') ? g : null;
  }

  setPaused(on) {
    on = on && this.canPause();
    if (on === !!this.pausedAt) return;
    if (on) {
      const g = this.pauseTarget();
      if (!g) return;
      this.pausedAt = Date.now();
      this.pausedGame = g;
      const d = this.driver(g);
      clearTimeout(d.turnTimer);
      d.timers.forEach((t) => {
        clearTimeout(t);
        this.timers.delete(t);
      });
      d.timers.clear();
      return;
    }
    const g = this.pausedGame;
    if (g.buyWindow) g.buyWindow.deadline += Date.now() - this.pausedAt;
    this.pausedAt = null;
    this.pausedGame = null;
    // the cleared timers are set up again: buy answers, and the computers' Shanghai calls on this discard
    this.drivers.delete(g);
    this.touch(g);
    this.changed();
  }

  // the games computers might be playing in right now, each with its seats in the lobby (null: the same numbers)
  botGames() {
    const t = this.tour;
    if (!t) return this.game ? [{ g: this.game, seats: null }] : [];
    if (t.phase === 'playing') return t.games.map((g, k) => ({ g, seats: t.tables[k] }));
    if (t.phase === 'tiebreak') return [{ g: t.tbGame, seats: t.tiebreak.seats }];
    return [];
  }

  driver(g) {
    if (!this.drivers.has(g)) this.drivers.set(g, { reacted: new Set(), memos: new Map(), memoKey: null, timers: new Set() });
    return this.drivers.get(g);
  }

  stillAsking(g, seat) {
    const w = g.buyWindow;
    return !!w && w.order.includes(seat) && w.answers[seat] === undefined;
  }

  // every person in the buy window has answered (the computers still to go don't count)
  peopleAnswered(g, w) {
    return w.order.every((seat) => g.players[seat].bot || w.answers[seat] !== undefined);
  }

  scheduleBots() {
    // only the games that changed: the others' timers carry on (a busy table doesn't hold the others up)
    const only = this.touched.size ? this.touched : null;
    this.touched = new Set();
    for (const { g, seats } of this.botGames()) if ((!only || only.has(g)) && g !== this.pausedGame) this.scheduleGame(g, seats);
  }

  // seats: the lobby seat of each of the game's players (null when they're the same numbers)
  scheduleGame(g, seats) {
    const d = this.driver(g);
    const lobbySeat = (local) => (seats ? seats[local] : local);
    const act = (local, a) => this.act(lobbySeat(local), a);
    // reaction timers re-check themselves when they fire; only the turn timer is reset on every change
    clearTimeout(d.turnTimer);
    this.timers.delete(d.turnTimer);
    if (g.tie && !g.tie.done) return this.scheduleTie(g, d);
    if (g.phase !== 'draw' && g.phase !== 'play') return;
    const bots = g.players.map((p, i) => (p.bot ? i : -1)).filter((i) => i >= 0);
    const botBuyAnswer = (seat, ms, w) =>
      this.later(ms, () => g.buyWindow === w && this.stillAsking(g, seat) && act(seat, { type: 'buyAnswer', buy: wantsToBuy(viewFor(g, seat)) }), g);

    // everyone eligible is asked at once: computers answer, players who dropped off pass,
    // and anyone who hasn't answered when the 10 seconds run out passes
    const w = g.buyWindow;
    const askKey = w && `${w.cardId}:${w.deadline}`;
    if (w && d.askArmed !== askKey) {
      d.askArmed = askKey;
      const peopleDone = this.peopleAnswered(g, w);
      for (const seat of w.order) {
        const s = this.lobby.seats[lobbySeat(seat)];
        if (g.players[seat].bot) {
          if (!peopleDone) botBuyAnswer(seat, 900 + Math.random() * 1200, w);
        } else if (s && !s.isHost && !s.connected) this.later(300, () => this.stillAsking(g, seat) && act(seat, { type: 'buyAnswer', buy: false }), g);
      }
      const t = setTimeout(() => {
        this.timers.delete(t);
        d.timers.delete(t);
        if (g.buyWindow === w && w.deadline <= Date.now() + 50 && this.botGames().some((b) => b.g === g)) {
          buyTimeout(g);
          this.touch(g);
          if (this.tour) this.checkTour();
          this.changed();
        }
      }, Math.max(0, w.deadline - Date.now()) + 250);
      this.timers.add(t);
      d.timers.add(t);
    }
    // once every person being asked has answered, the computers answer quickly: nobody is left needing time to think
    if (w && d.askFast !== askKey && this.peopleAnswered(g, w)) {
      d.askFast = askKey;
      for (const seat of w.order) if (g.players[seat].bot) botBuyAnswer(seat, 400 + Math.random() * 500, w);
    }

    // Shanghai calls on the latest discard, decided once per discard per bot, the one about to draw too (it won't take
    // a Shanghai it didn't call, see chooseDraw)
    if (g.phase === 'draw') {
      const key = `${g.round}:${g.discard.length}:${g.discard[g.discard.length - 1]?.id}`;
      for (const seat of bots) {
        if (sittingOut(g, seat) || d.reacted.has(key + ':' + seat)) continue;
        const v = viewFor(g, seat);
        if (!seesShanghai(v)) continue;
        d.reacted.add(key + ':' + seat);
        const { calls, delay } = shanghaiReaction(g.options);
        if (calls) this.later(delay, () => this.botGames().some((b) => b.g === g) && seesShanghai(viewFor(g, seat)) && act(seat, { type: 'shanghai' }), g);
      }
      if (d.reacted.size > 500) d.reacted.clear();
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
      d.turnTimer = this.later(wait, () => {
        const a = chooseDraw(viewFor(g, seat), this.botMemo(g, seat));
        if (a) act(seat, a);
      }, g);
    } else {
      d.turnTimer = this.later(900, () => {
        const res = act(seat, choosePlay(viewFor(g, seat), Math.random, this.botMemo(g, seat)));
        // never let a confused bot freeze the table
        if (!res.ok) {
          const hand = g.hands[seat];
          if (g.phase === 'play' && g.turn === seat && hand.length > 1) act(seat, { type: 'discard', id: hand[0].id });
        }
      }, g);
    }
  }

  // A draw for a tie at a finished table: computers draw after a moment, and so does anyone who dropped off; whoever
  // hasn't drawn when the 10 seconds are up gets a card drawn for them
  scheduleTie(g, d) {
    const tie = g.tie;
    const key = `${this.tour.round}:${tie.tries.length}`;
    if (d.tieArmed === key) return;
    d.tieArmed = key;
    const cards = tie.tries[tie.tries.length - 1];
    const still = (s) => g.tie === tie && !tie.done && tie.tries[tie.tries.length - 1] === cards && !cards[s];
    const draw = (s) => still(s) && this.act(s, { type: 'tieDraw' });
    for (const s of tie.seats) {
      const p = this.lobby.seats[s];
      if (p.bot) this.later(800 + Math.random() * 1000, () => draw(s), g);
      else if (!p.isHost && !p.connected) this.later(300, () => draw(s), g);
    }
    const t = setTimeout(() => {
      this.timers.delete(t);
      d.timers.delete(t);
      tie.seats.forEach(draw);
    }, Math.max(0, tie.deadline - Date.now()) + 250);
    this.timers.add(t);
    d.timers.add(t);
  }

  // a computer's notes for this round (whether it's holding its lay down to stump people); not saved with the game
  botMemo(g, seat) {
    const d = this.driver(g);
    const key = `${g.round}:${g.tiebreak ? 't' : ''}`;
    if (d.memoKey !== key) Object.assign(d, { memoKey: key, memos: new Map() });
    if (!d.memos.has(seat)) d.memos.set(seat, {});
    return d.memos.get(seat);
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
        else if (msg.t === 'err' && msg.chat) this.chatListeners.forEach((fn) => fn(null, { error: String(msg.msg), text: String(msg.text || '') }));
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

  sendChat(text, to) {
    text = cleanChat(text);
    if (!text) return { ok: false, error: 'Type a message first.' };
    // messages go through the host's phone: with them away it would just be lost
    if (this.snap.status !== 'connected' || this.snap.hostLeft) return { ok: false, error: 'Chat is paused until the host is back.' };
    this.link.send({ t: 'chat', text, to });
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
