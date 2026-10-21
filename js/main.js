import { HostSession, ClientSession } from './host.js';
import { joinRoom } from './net.js';
import { SUIT_SYMBOL, RANK_LABEL, cardLabel, isRed, wildTest } from './cards.js';
import { buildSet, buildRun, addCards, wildSlotFor, couldBeSet, couldBeRun, arrangeRun } from './melds.js';
import { ROUNDS, contractText, DEFAULT_OPTIONS, MAX_PLAYERS, SET_MIN, RUN_MIN, MIN_DECKS, MAX_DECKS, decksFor } from './rules.js';

const $app = document.getElementById('app');
const $toasts = document.getElementById('toasts');

// ---------- local storage helpers ----------
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('shanghai.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('shanghai.' + k, JSON.stringify(v));
    } catch {}
  },
};
let clientId = store.get('clientId');
if (!clientId) store.set('clientId', (clientId = Math.random().toString(36).slice(2) + Date.now().toString(36)));

const ui = {
  session: null,
  snap: null,
  name: store.get('name', ''),
  joinCode: (new URLSearchParams(location.search).get('join') || '').toUpperCase(),
  selected: new Set(),
  order: [],
  fresh: new Set(),
  staged: [],
  armed: false,
  modal: null,
  wildPrompt: null,
  handRound: null,
  lastSeq: null,
  lastTurnKey: null,
  lastErrSeq: null,
  homeError: null,
  sound: store.get('sound', true),
  cardBack: store.get('cardBack', 'purple'),
  sortDesc: store.get('sortDesc', false),
  drag: null,
  pendingRender: false,
  swallowClick: false, // set when a drag ends, so the click the browser sends after it isn't taken as a tap
  drawTo: null, // where in the hand a card being drawn by dragging should go
  afterDraw: null, // a discard dragged onto a group or pile, to play once it's in your hand
};

// card back colors you can pick in Settings (the CSS for each lives in style.css)
const CARD_BACKS = [
  ['purple', 'Purple'],
  ['red', 'Red'],
  ['blue', 'Blue'],
  ['green', 'Green'],
  ['yellow', 'Yellow'],
  ['black', 'Black'],
];
function applyCardBack() {
  document.documentElement.dataset.back = ui.cardBack;
}
applyCardBack();

// ---------- add to home screen ----------
// Opened from a home screen icon, the game gets its own storage that phones don't clear after a week away.
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(navigator.userAgent);
let installPrompt = null; // Chrome on Android hands us its own install prompt
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  render();
});
const canAddToHome = () => !isStandalone() && (isIOS || isAndroid || !!installPrompt);

async function addToHome() {
  if (!installPrompt) {
    ui.modal = 'install';
    return render();
  }
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  render();
}

function installModal() {
  const steps = isIOS
    ? `<ol><li>Tap the <b>Share</b> button (the square with an arrow). In Safari it's at the bottom of the screen.</li>
        <li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>.</li></ol>`
    : `<ol><li>Tap the browser menu (<b>⋮</b> at the top right in Chrome).</li>
        <li>Tap <b>Add to Home screen</b> or <b>Install app</b>.</li><li>Tap <b>Add</b> or <b>Install</b>.</li></ol>`;
  return wrapModal(
    'Add to your home screen',
    `<div class="rules"><p>Then Shanghai opens like an app, full screen, and your phone keeps your settings and your saved game.</p>${steps}
    <p class="muted">From then on, open the game from the new icon.${isIOS ? " The first time, you'll type your name again." : ''}</p></div>`
  );
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- sound ----------
let audio;
function beep(freqs, dur = 0.12) {
  if (!ui.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    let t = audio.currentTime;
    for (const f of freqs) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      o.type = 'triangle';
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + dur);
      t += dur * 0.8;
    }
  } catch {}
}

// ---------- toasts ----------
// During a game, messages show briefly in the activity box under the deck; elsewhere they float.
function toast(text, bad = false, ms = 3000) {
  if (ui.snap && ui.snap.view) {
    ui.flash = { text, bad, until: Date.now() + ms };
    clearTimeout(ui.flashTimer);
    ui.flashTimer = setTimeout(render, ms + 30);
    render();
    return;
  }
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = text;
  $toasts.appendChild(el);
  while ($toasts.children.length > 2) $toasts.firstChild.remove();
  setTimeout(() => el.remove(), ms);
}
function shout(text) {
  const el = document.createElement('div');
  el.className = 'shout';
  el.innerHTML = `<span>${esc(text)}</span>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1700);
}

// ---------- cards ----------
function cardHTML(c, { sm = false, cls = '', attrs = '', isWild } = {}) {
  const size = sm ? ' sm' : '';
  if (c.r === 0)
    return `<div class="card joker${size} ${cls}" ${attrs}><span class="tl">★</span><span class="mid">JOKER</span></div>`;
  const wild = isWild && isWild(c) ? '<span class="wildmark">WILD</span>' : '';
  return `<div class="card${isRed(c) ? ' red' : ''}${size} ${cls}" ${attrs}><span class="tl">${RANK_LABEL[c.r]}<small>${SUIT_SYMBOL[c.s]}</small></span><span class="mid">${SUIT_SYMBOL[c.s]}</span>${wild}</div>`;
}

// ---------- session ----------
function startSession(session) {
  if (ui.session) ui.session.close();
  ui.allGames = false;
  ui.session = session;
  ui.snap = null;
  ui.lastSeq = null;
  ui.handRound = null;
  ui.modal = null;
  ui.flash = null;
  session.subscribe(onSnapshot);
}

// Games other people host that you've joined, so the home screen can take you back in. The host's browser has the
// real game; this only remembers the room code and who was playing, as of the last time you were in it.
function joinedGames() {
  const list = store.get('joinedGames', []);
  return Array.isArray(list) ? list : [];
}

function forgetJoined(code) {
  store.set('joinedGames', joinedGames().filter((g) => g.code !== code));
}

function rememberJoined(snap) {
  const code = snap.lobby && snap.lobby.code;
  if (!code) return;
  if (snap.view && snap.view.phase === 'gameOver') return forgetJoined(code);
  const seats = snap.lobby.seats;
  const host = seats.find((s) => s.isHost);
  const entry = {
    code,
    host: host ? host.name : '',
    others: seats.filter((s, i) => !s.isHost && i !== snap.seat).map((s) => s.name),
    round: snap.view ? snap.view.round : null,
    seenAt: Date.now(),
  };
  store.set('joinedGames', [entry, ...joinedGames().filter((g) => g.code !== code)]);
}

function onSnapshot(snap) {
  const prev = ui.snap;
  ui.snap = snap;
  if (ui.session instanceof ClientSession) {
    if (snap.status === 'connected') rememberJoined(snap);
    else if (snap.status === 'kicked') forgetJoined(ui.session.code);
  }
  if (snap.toastError && snap.errSeq !== ui.lastErrSeq) {
    ui.lastErrSeq = snap.errSeq;
    toast(snap.toastError, true);
  }
  const v = snap.view;
  if (v) {
    syncHand(v);
    // a discard dragged onto a group or pile: play it as soon as it's in your hand
    const take = ui.afterDraw;
    if (take && v.hand.some((c) => c.id === take.id)) {
      ui.afterDraw = null;
      setTimeout(() => finishTake(take));
    }
    processLog(v);
    trackMeldChanges(v);
    ui.windowDeadline = v.buyWindow ? Date.now() + v.buyWindow.msLeft : null;
    const turnKey = `${v.round}:${v.turn}:${v.phase}`;
    if (turnKey !== ui.lastTurnKey) {
      if (v.turn !== (prev && prev.view && prev.view.turn)) ui.armed = false;
      // pick your cards back up when it's your turn or a new round is dealt
      if ((v.turn === v.you && v.phase === 'draw') || v.phase === 'ready') ui.dockCollapsed = false;
      if (v.turn === v.you && v.phase === 'draw' && ui.lastTurnKey) beep([660, 880]);
      ui.lastTurnKey = turnKey;
      ui.revealTurn = true;
    }
  }
  render();
}

// Piles that just changed (laid down, added to, joker swapped) get a short highlight.
const JUST_PLAYED_MS = 2500;
function trackMeldChanges(v) {
  const sig = new Map(v.melds.map((m) => [m.id, m.cards.map((c) => c.id).join()]));
  const prev = ui.meldSig;
  ui.meldSig = sig;
  if (!prev || prev.round !== v.round) {
    sig.round = v.round;
    return;
  }
  sig.round = v.round;
  const changed = v.melds.filter((m) => prev.get(m.id) !== sig.get(m.id)).map((m) => m.id);
  if (!changed.length) return;
  ui.justPlayed = { ids: new Set(changed), until: Date.now() + JUST_PLAYED_MS };
  setTimeout(render, JUST_PLAYED_MS + 50);
}

function processLog(v) {
  if (ui.lastSeq == null || ui.lastSeq > v.seq) {
    ui.lastSeq = v.seq;
    return;
  }
  for (const e of v.log) {
    if (e.seq <= ui.lastSeq) continue;
    // someone else's discard flies from their tile to the pile (yours you just put there yourself)
    if (DISCARD_KINDS.includes(e.kind) && e.seat !== v.you) ui.flyFrom = e.seat;
    if (e.kind === 'shanghai') {
      shout('SHANGHAI!');
      toast(e.text, true, 5000);
      beep([880, 660, 440], 0.16);
    } else if (e.kind === 'falsecall') {
      toast(e.text, true, 5000);
      beep([220, 180], 0.2);
    } else if (e.kind === 'win') {
      beep([523, 659, 784]);
    } else if (e.kind === 'notshanghai') {
      if (e.seat === v.you) toast(e.note, false, 5000);
    } else if (['buy', 'buyreq', 'laydown', 'dead', 'swap', 'buywindow'].includes(e.kind)) {
      // you already know what you just did
      if (e.seat === v.you) continue;
      toast(e.text, false);
    }
  }
  ui.lastSeq = v.seq;
}

function syncHand(v) {
  const ids = v.hand.map((c) => c.id);
  const idSet = new Set(ids);
  if (ui.handRound !== v.round) {
    ui.handRound = v.round;
    ui.sortMode = ui.sortMode || 'rank';
    ui.order = sortIds(v.hand, ui.sortMode === 'manual' ? 'rank' : ui.sortMode);
    ui.staged = [];
    ui.selected.clear();
    ui.fresh.clear();
    return;
  }
  const known = new Set(ui.order);
  const added = ids.filter((id) => !known.has(id));
  ui.order = ui.order.filter((id) => idSet.has(id)).concat(added);
  // a card dragged in from the deck or discard pile goes where it was dropped
  if (added.length === 1 && ui.drawTo && Date.now() < ui.drawTo.until) {
    const stagedIds = new Set(ui.staged.flatMap((g) => g.ids));
    const order = ui.order.filter((id) => id !== added[0]);
    const before = order.filter((id) => !stagedIds.has(id))[ui.drawTo.index];
    order.splice(before == null ? order.length : order.indexOf(before), 0, added[0]);
    ui.order = order;
  }
  if (added.length) ui.drawTo = null;
  // keep the hand in the chosen order as cards come and go (unless you've arranged it by hand)
  if (ui.sortMode !== 'manual') ui.order = sortIds(v.hand, ui.sortMode);
  if (added.length) {
    ui.fresh = new Set(added);
  }
  for (const id of [...ui.selected]) if (!idSet.has(id)) ui.selected.delete(id);
  ui.staged = ui.staged.map((g) => ({ ...g, ids: g.ids.filter((id) => idSet.has(id)) })).filter((g) => g.ids.length);
  if (v.you != null && v.players[v.you].laid) ui.staged = [];
}

function sortIds(hand, how) {
  const suitOrder = { S: 0, H: 1, C: 2, D: 3, J: 4 };
  // jokers stay at the right end either way
  const dir = ui.sortDesc ? -1 : 1;
  const byRank = (a, b) => (a.r === 0) - (b.r === 0) || dir * ((a.r === 1 ? 14 : a.r) - (b.r === 1 ? 14 : b.r));
  const cards = [...hand];
  if (how === 'rank') cards.sort((a, b) => byRank(a, b) || suitOrder[a.s] - suitOrder[b.s]);
  else cards.sort((a, b) => suitOrder[a.s] - suitOrder[b.s] || byRank(a, b));
  return cards.map((c) => c.id);
}

function send(action) {
  const res = ui.session.send(action);
  if (res && !res.ok && !res.pending) toast(res.error, true);
  return res;
}

// ---------- rendering ----------
function render() {
  if (ui.drag) {
    ui.pendingRender = true;
    return;
  }
  // re-rendering replaces the table and pop-ups, so carry their scroll positions over
  const oldPlayers = $app.querySelector('.players');
  const playersLeft = oldPlayers ? oldPlayers.scrollLeft : null;
  const oldStaged = $app.querySelector('.staged-row');
  const stagedLeft = oldStaged ? oldStaged.scrollLeft : null;
  const oldTable = $app.querySelector('.table');
  const tableTop = oldTable ? oldTable.scrollTop : null;
  const oldModalBody = $app.querySelector('.modal-body');
  const modalTop = oldModalBody && ui.renderedModal === ui.modal ? oldModalBody.scrollTop : null;
  ui.renderedModal = ui.modal;
  const snap = ui.snap;
  if (!ui.session || !snap) $app.innerHTML = ui.allGames ? allGamesHTML() : homeHTML();
  else if (snap.status === 'kicked') $app.innerHTML = messageHTML('The host removed you from the game.');
  else if (!snap.lobby) $app.innerHTML = connectingHTML(snap);
  else if (!snap.lobby.started || !snap.view) $app.innerHTML = lobbyHTML(snap);
  else $app.innerHTML = gameHTML(snap);
  layoutHand();
  placeTapSpots();
  markTableOverflow();
  fitHomeGames();
  flyDiscard();
  const players = $app.querySelector('.players');
  if (players) {
    if (playersLeft != null) players.scrollLeft = playersLeft;
    if (ui.revealTurn) revealTurn(players, playersLeft != null);
    ui.revealTurn = false;
    markEdgeFade(players);
  }
  const staged = $app.querySelector('.staged-row');
  if (staged) {
    if (stagedLeft != null) staged.scrollLeft = stagedLeft;
    // a group you just made goes on the end; bring it into view
    if (ui.revealStaged) staged.scrollLeft = staged.scrollWidth;
    markEdgeFade(staged);
  }
  ui.revealStaged = false;
  const modalBody = $app.querySelector('.modal-body');
  if (modalBody && modalTop != null) modalBody.scrollTop = modalTop;
  const table = $app.querySelector('.table');
  if (!table) return;
  if (tableTop != null) table.scrollTop = tableTop;
}

// The row of player tiles scrolls sideways when it doesn't fit; bring whoever's turn it is into view.
function revealTurn(players, smooth) {
  const chip = players.querySelector('.chip.turn');
  if (!chip) return;
  const pad = 32; // clear of the edge fade
  const left = chip.offsetLeft - pad;
  const right = chip.offsetLeft + chip.offsetWidth + pad - players.clientWidth;
  const to = left < players.scrollLeft ? left : right > players.scrollLeft ? right : null;
  if (to != null) players.scrollTo({ left: Math.max(0, to), behavior: smooth ? 'smooth' : 'auto' });
}

// sideways-scrolling rows (player tiles, staged groups) fade whichever edge has more past it
function markEdgeFade(row) {
  const max = row.scrollWidth - row.clientWidth;
  row.classList.toggle('more-left', row.scrollLeft > 1);
  row.classList.toggle('more-right', row.scrollLeft < max - 1);
}

// when the piles on the table don't all fit, shade the top edge of the deck row so it's clear there's more above it
function markTableOverflow() {
  const table = $app.querySelector('.table');
  const bottom = $app.querySelector('.bottom');
  if (table && bottom) bottom.classList.toggle('raised', table.scrollHeight > table.clientHeight + 1);
}

function namesText(names) {
  return names.length ? 'with ' + names.map(esc).join(', ') : 'no one else yet';
}

function roundText(round) {
  return round == null ? 'Not started yet' : `Round ${round + 1} of ${ROUNDS.length}`;
}

// every game you can go back to: the ones saved on this device (yours) and the ones you joined, newest first
function yourGameRows() {
  const hosted = HostSession.savedGames().map((s) => ({
    at: s.savedAt || 0,
    html: `<button class="ghost game-pick" data-act="resume" data-id="${esc(s.id)}">
      <b>${s.solo ? 'Against the computer' : `Room ${esc(s.lobby.code)} · you're hosting`}</b>
      <span>${roundText(s.game.round)} · ${namesText(s.lobby.seats.slice(1).map((p) => p.name))}</span></button>
      <button class="ghost small game-forget" data-act="forgetGame" data-id="${esc(s.id)}" aria-label="Remove">✕</button>`,
  }));
  const joined = joinedGames().map((g) => ({
    at: g.seenAt || 0,
    html: `<button class="ghost game-pick" data-act="rejoin" data-code="${esc(g.code)}">
      <b>Room ${esc(g.code)} · ${esc(g.host)}'s game</b>
      <span>${roundText(g.round)} · ${namesText(g.others)}</span></button>
      <button class="ghost small game-forget" data-act="forgetJoined" data-code="${esc(g.code)}" aria-label="Remove">✕</button>`,
  }));
  return [...hosted, ...joined].sort((a, b) => b.at - a.at).map((g) => `<div class="game-row">${g.html}</div>`);
}

// On the home screen the list may be cut short (see fitHomeGames) so joining by code stays on screen
function yourGamesHTML() {
  const rows = yourGameRows();
  if (!rows.length) return '';
  return `<div class="divider">— your games —</div><div class="your-games">${rows.join('')}</div>
    <button class="ghost small view-all" data-act="viewAllGames" hidden>View all your games (${rows.length})</button>`;
}

function allGamesHTML() {
  const rows = yourGameRows();
  // removed the last one: nothing left to list
  if (!rows.length) {
    ui.allGames = false;
    return homeHTML();
  }
  return `<div class="center-screen"><div class="panel">
    <div class="panel-head"><button class="ghost small" data-act="homeBack">‹ Back</button><b>Your games</b></div>
    <div class="your-games">${rows.join('')}</div>
  </div></div>`;
}

// Hide games from the end of the home list until the room code, How to play and Settings fit on screen.
// Your latest game always stays.
function fitHomeGames() {
  const list = $app.querySelector('.your-games');
  const viewAll = $app.querySelector('.view-all');
  const links = $app.querySelector('.home-links');
  if (!list || !viewAll || !links) return;
  const rows = [...list.children];
  rows.forEach((r) => (r.hidden = false));
  viewAll.hidden = true;
  const fits = () => links.getBoundingClientRect().bottom <= document.documentElement.clientHeight - 16;
  if (fits()) return;
  viewAll.hidden = false;
  for (let n = rows.length - 1; n >= 1 && !fits(); n--) rows[n].hidden = true;
  if (rows.every((r) => !r.hidden)) viewAll.hidden = true;
}

function homeHTML() {
  return `<div class="center-screen"><div class="panel">
    <div class="title">Shanghai</div>
    <div class="title-suits">♠<span class="r">♥</span>♣<span class="r">♦</span></div>
    <div class="subtitle">Family rummy, house rules</div>
    <label class="field">Your name<input data-field="name" maxlength="20" placeholder="e.g. Grandma" value="${esc(ui.name)}" autocomplete="nickname"></label>
    ${ui.homeError ? `<div class="err">${esc(ui.homeError)}</div>` : ''}
    <button class="primary" data-act="host">Host a game for friends &amp; family</button>
    <button class="ghost" data-act="solo">Play against the computer</button>
    ${yourGamesHTML()}
    <div class="divider">— or join someone else's game —</div>
    <div class="row"><input data-field="joinCode" placeholder="ROOM CODE" maxlength="5" style="text-transform:uppercase;letter-spacing:3px" value="${esc(ui.joinCode)}"><button data-act="join" style="flex:none">Join</button></div>
    <div class="row home-links"><button class="ghost small" data-act="rules">How to play</button><button class="ghost small" data-act="modal" data-m="settings">Settings</button></div>
    ${canAddToHome() ? '<button class="ghost small" data-act="addToHome">Add Shanghai to your home screen</button>' : ''}
  </div></div>${ui.modal === 'rules' ? rulesModal(DEFAULT_OPTIONS) : ui.modal === 'settings' ? settingsModal() : ui.modal === 'install' ? installModal() : ''}`;
}

function messageHTML(text) {
  return `<div class="center-screen"><div class="panel"><p>${esc(text)}</p><button data-act="leave">Back to start</button></div></div>`;
}

function connectingHTML(snap) {
  const msg =
    snap.status === 'no-host'
      ? `Can't find game ${esc(snap.code || ui.joinCode)} yet. Check the code; the host has to keep their page open. Still trying…`
      : snap.status === 'error'
        ? `Connection problem: ${esc(snap.error || '')}. Retrying…`
        : snap.status === 'slow'
          ? `Can't reach the host yet. If you're on mobile data, try Wi-Fi, or ask the host to check their connection. Still trying…`
          : 'Connecting to the game…';
  const code = snap.code || ui.joinCode;
  const stuck = snap.status === 'no-host' || snap.status === 'slow';
  const remove =
    stuck && joinedGames().some((g) => g.code === code)
      ? `<button class="ghost" data-act="forgetJoined" data-code="${esc(code)}">Remove from your games</button>`
      : '';
  return `<div class="center-screen"><div class="panel"><div class="title" style="font-size:30px">Joining…</div><p class="muted">${msg}</p>${remove}<button class="ghost" data-act="leave">Cancel</button></div></div>`;
}

function optionRow(label, key, choices, opts, isHost) {
  const val = opts[key];
  if (!isHost) {
    const ch = choices.find((c) => c[0] === val);
    return `<span>${label}</span><b>${esc(ch ? ch[1] : val)}</b>`;
  }
  return `<span>${label}</span><select data-opt="${key}">${choices
    .map(([v, t]) => `<option value='${JSON.stringify(v)}' ${v === val ? 'selected' : ''}>${esc(t)}</option>`)
    .join('')}</select>`;
}

function lobbyHTML(snap) {
  const { lobby, isHost, seat, solo } = snap;
  const o = lobby.options;
  const seats = lobby.seats
    .map(
      (s, i) => `<div class="seat"><span class="name">${esc(s.name)}</span>
      ${s.isHost ? '<span class="tag gold">host</span>' : ''}${s.bot ? '<span class="tag">computer</span>' : ''}${i === seat ? '<span class="tag">you</span>' : ''}
      ${!s.connected ? '<span class="tag red">offline</span>' : ''}
      ${isHost && i !== 0 ? `<button class="ghost small" data-act="removeSeat" data-seat="${i}">✕</button>` : ''}</div>`
    )
    .join('');
  const invite = lobby.code ? inviteLink(lobby.code) : '';
  return `<div class="center-screen"><div class="panel">
    <h2>${solo ? 'Game vs computer' : 'Game lobby'}</h2>
    ${
      lobby.code
        ? `<div class="muted" style="text-align:center">Room code</div><div class="room-code">${lobby.code}</div>
      ${isHost ? `<button class="ghost" data-act="share">Share invite link</button><div class="muted" style="text-align:center;word-break:break-all">${esc(invite)}</div>` : ''}`
        : ''
    }
    ${snap.status === 'starting' ? '<div class="muted">Opening the room…</div>' : ''}
    ${snap.status === 'error' ? `<div class="err">${esc(snap.error)}</div>` : ''}
    <div class="seat-list">${seats}</div>
    ${isHost ? `<button class="ghost" data-act="addBot" ${lobby.seats.length >= MAX_PLAYERS ? 'disabled' : ''}>+ Add a computer player</button>` : ''}
    <h3 style="margin-top:6px">House rules</h3>
    <div class="options">
      ${optionRow('Decks', 'decks', Array.from({ length: MAX_DECKS - MIN_DECKS + 1 }, (_, i) => [MIN_DECKS + i, `${MIN_DECKS + i} (${(MIN_DECKS + i) * 2} jokers)`]), o, isHost)}
      ${optionRow('Buys per round', 'buyLimit', [[0, 'None'], [1, '1'], [2, '2'], [3, '3'], [4, '4']], o, isHost)}
      ${optionRow('Extra cards per buy', 'buyPenalty', [[0, 'None'], [1, '1'], [2, '2'], [3, '3']], o, isHost)}
      ${optionRow('2♣ wild', 'twoClubsWild', [[false, 'No (jokers only)'], [true, 'Yes']], o, isHost)}
      ${optionRow('Shanghai penalty', 'shanghaiPenalty', [[2, '2 cards'], [3, '3 cards'], [4, '4 cards']], o, isHost)}
      ${optionRow('Wrong Shanghai call', 'falseCallPenalty', [[0, 'No penalty'], [1, '1 card'], [2, '2 cards'], [3, '3 cards']], o, isHost)}
      ${optionRow('Computer speed', 'botSpeed', [[0.5, 'Fast'], [1, 'Normal'], [2, 'Slow']], o, isHost)}
    </div>
    ${
      isHost
        ? `<button class="primary" data-act="start" ${lobby.seats.length < 2 ? 'disabled' : ''}>Start game</button>`
        : `<div class="muted" style="text-align:center">Waiting for ${esc(lobby.seats[0]?.name || 'the host')} to start…</div>`
    }
    <button class="ghost small" data-act="rules">How to play</button>
    <button class="ghost small" data-act="leave">Leave</button>
  </div></div>${ui.modal === 'rules' ? rulesModal(o) : ''}`;
}

function inviteLink(code) {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('join', code);
  const ps = new URLSearchParams(location.search).get('peerserver');
  if (ps) u.searchParams.set('peerserver', ps);
  return u.toString();
}

function playerChips(v) {
  return v.players
    .map((p, i) => {
      const tags = [];
      if (v.phase === 'ready' && p.ready) tags.push('<span class="tag gold">ready</span>');
      const seat = ui.snap.lobby.seats[i];
      if (seat && !seat.connected) tags.push('<span class="tag red">offline</span>');
      // one $ per buy left; none once they've laid down, since they can't buy then
      const left = p.laid ? 0 : Math.max(0, v.options.buyLimit - p.buysUsed);
      const buys = left ? `<span class="buys-left" title="${left} buy${left === 1 ? '' : 's'} left">${'$'.repeat(left)}</span>` : '';
      const dealer = i === v.dealer;
      // names longer than 15 characters are cut short; the full name shows on hover
      const short = p.name.length > 15 ? p.name.slice(0, 14).trimEnd() + '…' : p.name;
      return `<div class="chip ${i === v.turn ? 'turn' : ''} ${i === v.you ? 'me' : ''} ${dealer ? 'dealer' : ''}">
        ${dealer ? '<span class="dealer-badge" title="Dealer">D</span>' : ''}<span class="pname" title="${esc(p.name)}">${esc(short)}</span>
        <span class="pstats"><span>${p.cards} card${p.cards === 1 ? '' : 's'}</span>${buys}</span>
        <span class="ptags">${tags.join('')}</span></div>`;
    })
    .join('');
}

function selectedCards(v) {
  return [...ui.selected].map((id) => v.hand.find((c) => c.id === id)).filter(Boolean);
}

function canPlayOn(v) {
  const me = v.you;
  return me != null && v.turn === me && v.phase === 'play' && v.players[me].laid && ui.selected.size > 0;
}

function tableHTML(v, isWild) {
  if (!v.melds.length)
    return `<div class="table-empty"><span class="table-round">Round ${v.round + 1} of ${ROUNDS.length}</span><b class="table-contract">${contractText(v.round)}</b></div>`;
  const playable = canPlayOn(v);
  // piles take dragged cards whenever you could play on them, selected or not
  const laid = v.you != null && v.players[v.you].laid;
  const droppable = laid && v.turn === v.you && v.phase === 'play';
  const rows = [];
  v.players.forEach((p, i) => {
    // sets before runs, so everyone's piles line up the same way
    const melds = v.melds.filter((m) => m.owner === i).sort((a, b) => (a.type === b.type ? a.id - b.id : a.type === 'set' ? -1 : 1));
    if (!melds.length) return;
    const html = melds
      .map((m) => {
        // every pile lights up: picking the right one is part of the game
        const ok = playable;
        const fresh = ui.justPlayed && Date.now() < ui.justPlayed.until && ui.justPlayed.ids.has(m.id);
        return `<div class="meld ${ok ? 'target' : ''} ${fresh ? 'just-played' : ''}" ${ok ? 'data-act="playOn"' : ''} ${
          droppable ? 'data-drop="meld"' : ''
        } ${laid ? `data-meld="${m.id}"` : ''} title="${m.type}">
          ${m.cards.map((c) => cardHTML(c, { sm: true, isWild })).join('')}</div>`;
      })
      .join('');
    rows.push(`<div class="owner-row"><span class="who">${esc(p.name)}${i === v.you ? ' (you)' : ''}</span><div class="melds">${html}</div></div>`);
  });
  return rows.join('');
}

// Log entries that say what someone did on their turn, and the ones that end it with a discard
const TURN_KINDS = ['draw', 'buy', 'laydown', 'play', 'swap', 'undo'];
const DISCARD_KINDS = ['discard', 'dead', 'notshanghai'];

// the latest entry this round that matches (each round's log starts with a 'round' line)
function lastLog(v, test) {
  for (let i = v.log.length - 1; i >= 0; i--) {
    const e = v.log[i];
    if (e.kind === 'round') return null;
    if (test(e)) return e;
  }
  return null;
}

// a log line for the activity box: the player's name in bold, cards drawn as little cards, no full stop
function logHTML(e, v) {
  const name = e.seat != null ? v.players[e.seat].name : '';
  let html = esc(e.text.replace(/\.$/, ''));
  if (name && e.text.startsWith(name)) html = `<b>${e.seat === v.you ? 'You' : esc(name)}</b>` + html.slice(esc(name).length);
  // "discarded the A♥" reads fine as "discarded A♥" and keeps the line short
  return html.replace(/\bthe (?=(10|[2-9AJQK])[♠♥♦♣]|Joker)/g, '').replace(/(10|[2-9AJQK])([♠♥♦♣])|Joker/g, (m, rank, suit) => `<span class="mini-card ${suit === '♥' || suit === '♦' ? 'red' : ''}">${m}</span>`);
}

function statusText(v) {
  const me = v.you;
  const turnName = esc(v.players[v.turn].name);
  if (me == null) return `You're watching. It's <b>${turnName}</b>'s turn.`;
  const myTurn = v.turn === me;
  if (v.phase === 'ready') return `Sort and plan your hand. <b>${turnName}</b> goes first once everyone is ready.`;
  if (!myTurn) {
    if (v.phase === 'draw') {
      const d = lastLog(v, (e) => DISCARD_KINDS.includes(e.kind));
      return d ? `${logHTML(d, v)} · <b>${turnName}</b> to draw` : `Waiting for <b>${turnName}</b> to draw…`;
    }
    // what they've done so far this turn (drew, took the discard, laid down, played on a pile…)
    const did = lastLog(v, (e) => e.seat === v.turn && TURN_KINDS.includes(e.kind));
    return did ? logHTML(did, v) : `<b>${turnName}</b> is playing…`;
  }
  if (v.phase === 'draw') {
    if (v.buyWindow) return 'Waiting while others decide whether to buy…';
    return '<b>Your turn</b>';
  }
  if (v.mustPlay.some((id) => v.hand.some((c) => c.id === id)))
    return '<span class="warn">Play the wild card you swapped out before you discard.</span>';
  if (v.hand.length === 1) return `<span class="warn">You can't discard your last card. Play it on a pile, or Undo.</span>`;
  return '<b>Your turn</b>';
}

function centerHTML(v, isWild) {
  const me = v.you;
  const myTurn = me != null && v.turn === me;
  const p = me != null ? v.players[me] : null;
  const canDraw = myTurn && v.phase === 'draw' && !v.buyWindow;
  const top = v.discardTop;
  const discardClickable = canDraw && top && !v.topDead;
  const deckClickable = canDraw && !v.mustDecide;
  // anything you can tap to draw, you can also drag down into your hand
  const deck = `<div class="pile ${deckClickable ? 'clickable' : ''}"><div class="stack" ${deckClickable ? 'data-act="drawDeck" data-drag="deck"' : ''}>${
    v.deckCount ? '<div class="card-back"></div>' : '<div class="empty-pile"></div>'
  }</div><span>Deck</span></div>`;
  // with one card selected on your turn, the discard pile is where you tap to discard it
  const canDiscard = myTurn && v.phase === 'play' && ui.selected.size === 1;
  const pileAct = discardClickable ? 'drawDiscard' : canDiscard ? 'discard' : null;
  // kept to one short line so the discard card doesn't shift; the red glow shows a declared-dead discard
  const pileLabel = canDiscard ? 'Tap to discard' : v.topDead ? 'Dead card' : 'Discard';
  const landing = ui.flyUntil > Date.now() ? 'landing' : '';
  const discard = `<div class="pile discard-pile ${landing} ${pileAct ? 'clickable' : ''} ${canDiscard ? 'discard-target' : ''} ${canDiscard && ui.armed ? 'armed' : ''}"><div class="stack" ${
    pileAct ? `data-act="${pileAct}"` : ''
  } ${discardClickable ? 'data-drag="discard"' : ''} ${myTurn && v.phase === 'play' ? 'data-drop="discard"' : ''}>${top ? cardHTML(top, { isWild }) : '<div class="empty-pile"></div>'}${
    v.topDead ? '<div class="dead-stamp"><span>DEAD</span></div>' : ''
  }</div><span>${pileLabel}</span></div>`;

  const actions = [];
  if (p) {
    if (myTurn && v.phase === 'play')
      actions.push(
        `<button class="shanghai-btn ${ui.armed ? 'armed' : ''}" data-act="arm">${ui.armed ? 'SHANGHAI! ✓' : 'SHANGHAI!'}</button>`
      );
    else actions.push('<button class="shanghai-btn" data-act="callShanghai">SHANGHAI!</button>');
  }
  // the activity box sits above the deck row: when a prompt makes it taller it grows upward over the table,
  // so the piles and your hand stay put
  return `${activityHTML(v)}<div class="center">${deck}${discard}<div class="center-actions">${actions.join('')}</div></div>`;
}

// One place for everything going on: what you need to do (a prompt), else your turn, else something that just
// happened (shown for a few seconds), else whose turn it is.
function activityHTML(v) {
  const me = v.you;
  const mine = me != null && v.turn === me && (v.phase === 'draw' || v.phase === 'play');
  const f = ui.flash && ui.flash.until > Date.now() ? ui.flash : null;
  // your own turn beats other people's news (it stays on the line below), but not your own mistakes
  const showFlash = f && (!mine || f.bad);
  // prompts keep their own buttons; any other message opens the game log when tapped
  let main = buyBarHTML(v);
  const log = 'data-act="modal" data-m="log" title="Tap for the game log"';
  if (!main && showFlash) main = `<div class="buy-bar flash tappable ${f.bad ? 'bad' : ''}" ${log}><span>${esc(f.text)}</span></div>`;
  if (!main) {
    const warn = mine && v.phase === 'play' && (v.hand.length === 1 || v.mustPlay.some((id) => v.hand.some((c) => c.id === id)));
    main = `<div class="buy-bar tappable ${mine ? 'ask' : ''} ${warn ? 'warn' : ''}" ${log}><span>${statusText(v)}</span></div>`;
  }
  return `<div class="activity">${main}</div>`;
}

function secondsLeft() {
  return ui.windowDeadline ? Math.max(0, Math.ceil((ui.windowDeadline - Date.now()) / 1000)) : 0;
}

// The buying conversation: the current player decides whether to let others buy, then it goes around the table one at a time.
function readyBarHTML(v, isHost) {
  const me = v.you;
  const waiting = v.players.filter((p) => !p.ready).map((p) => esc(p.name));
  const startNow = isHost ? '<button class="ghost" data-act="startNow">Start now</button>' : '';
  if (me != null && !v.players[me].ready)
    return `<div class="buy-bar ask"><span>Look over your cards. Round ${v.round + 1}: <b>${contractText(v.round)}</b></span>
      <span class="buy-actions"><button class="primary" data-act="ready">I'm ready</button>${startNow}</span></div>`;
  return `<div class="buy-bar"><span>Waiting for ${waiting.join(', ')} to be ready…</span>${startNow ? `<span class="buy-actions">${startNow}</span>` : ''}</div>`;
}

function buyBarHTML(v) {
  const me = v.you;
  if (v.phase === 'ready') return readyBarHTML(v, ui.snap.isHost);
  if (me == null || v.phase !== 'draw') return '';
  const top = v.discardTop;
  const w = v.buyWindow;
  const timer = `<span class="countdown" data-countdown>${secondsLeft()}</span>`;
  if (w) {
    // one player at a time, in turn order: only the person being asked gets the buttons
    if (w.asking !== me) {
      const ahead = w.order.indexOf(me) - w.order.indexOf(w.asking);
      const next = ahead === 1 ? " You're next." : ahead > 1 ? ` You're up after ${esc(v.players[w.order[ahead - 1 + w.order.indexOf(w.asking)]].name)}.` : '';
      return `<div class="buy-bar"><span><b>${esc(v.players[w.asking].name)}</b> is deciding whether to buy the ${esc(cardLabel(top))}…${next}</span> ${timer}</div>`;
    }
    const left = v.options.buyLimit - v.players[me].buysUsed;
    return `<div class="buy-bar ask"><span>Buy the <b>${esc(cardLabel(top))}</b>? +${v.options.buyPenalty} from the deck. ${left} buy${left === 1 ? '' : 's'} left.</span>
      <span class="buy-actions"><button class="primary" data-act="buyAnswer" data-buy="1">Buy</button><button class="ghost" data-act="buyAnswer" data-buy="0">No</button></span> ${timer}</div>`;
  }
  if (v.turn === me && v.mustDecide) {
    return `<div class="buy-bar ask"><span>Take the <b>${esc(cardLabel(top))}</b> or let others buy it?</span>
      <span class="buy-actions"><button class="primary" data-act="allowBuy">Allow buy</button><button class="ghost" data-act="drawDiscard">Take it</button></span></div>`;
  }
  return '';
}

function stagingHTML(v, isWild) {
  const me = v.you;
  if (me == null || v.players[me].laid) return '';
  const cfg = ROUNDS[v.round];
  const sets = ui.staged.filter((g) => g.type === 'set').length;
  const runs = ui.staged.filter((g) => g.type === 'run').length;
  if (!ui.staged.length) return '';
  let allComplete = true;
  // with cards selected, every staged group lights up: tap one to add them (it says so if they don't fit)
  const adding = ui.selected.size > 0;
  const groups = ui.staged
    .map((g, i) => {
      const cards = g.ids.map((id) => v.hand.find((c) => c.id === id)).filter(Boolean);
      const built = g.type === 'set' ? buildSet(cards, isWild) : buildRun(cards, isWild);
      if (!built) allComplete = false;
      const min = g.type === 'set' ? SET_MIN : RUN_MIN;
      // complete, still short of cards, or enough cards that don't work yet (e.g. too many jokers)
      const status = built ? '✓' : cards.length < min ? `${cards.length}/${min}` : '!';
      const shown = built ? built.cards : cards;
      return `<div class="staged ${built ? 'done' : ''} ${adding ? 'target' : ''}" data-act="addToStaged" data-drop="staged" data-i="${i}" title="Select cards and tap to add them">
        <div class="staged-head"><span class="kind">${g.type.toUpperCase()} ${status}</span>
        <button class="unstage" data-act="unstage" data-i="${i}" title="Put these cards back">✕</button></div>
        <div class="staged-cards">${shown.map((c) => cardHTML(c, { sm: true, isWild })).join('')}</div></div>`;
    })
    .join('');
  const ready = sets === cfg.sets && runs === cfg.runs && allComplete;
  const canLay = ready && v.turn === me && v.phase === 'play';
  // only count what this round actually asks for
  const need = [cfg.sets && `${sets}/${cfg.sets} set${cfg.sets > 1 ? 's' : ''}`, cfg.runs && `${runs}/${cfg.runs} run${cfg.runs > 1 ? 's' : ''}`].filter(Boolean);
  // the button sits on the count line and the groups scroll sideways in one row, so however much you've staged,
  // the button and your hand below stay on screen
  // with cards selected the hint takes the place of "Your lay down:", so the line still fits in later rounds
  return `<div class="staging"><div class="staging-head"><span class="label">${adding ? '' : 'Your lay down: '}${need.join(' · ')}${
    adding ? ' · <b>Tap or Drag to a Group</b>' : ''
  }</span>
    <button class="primary small" data-act="layDown" ${canLay ? '' : 'disabled'}>${ready ? 'Lay down!' : 'Lay down'}</button></div>
    <div class="staged-row hscroll">${groups}</div></div>`;
}

// "New set" / "New run" spots for the groups the round still needs. They only show while cards are lifted out
// of the hand, so tapping and the Make set / Make run buttons look the same as ever. placeSpots() floats them
// next to your staged groups (or just above the hand), so showing them never moves anything mid-drag.
function newGroupSpotsHTML(v) {
  const me = v.you;
  if (me == null || v.players[me].laid || v.phase === 'roundOver' || v.phase === 'gameOver') return '';
  const cfg = ROUNDS[v.round];
  const count = (type) => ui.staged.filter((g) => g.type === type).length;
  // with 2 or more cards selected, the spots the selection could start also show without dragging, to tap
  // (taking the place of the old Make set / Make run buttons); one selected card shows nothing
  const isWild = wildTest(v.options);
  const sel = selectedCards(v);
  const fits = (type) => sel.length >= 2 && !ui.dockCollapsed && (type === 'set' ? couldBeSet(sel, isWild) : couldBeRun(sel, isWild));
  const spot = (type) =>
    `<div class="new-group ${fits(type) ? 'fits' : ''}" data-drop="newGroup" data-type="${type}" ${fits(type) ? `data-act="stage"` : ''}><span class="plus">+</span>New ${type}</div>`;
  const types = ['set', 'run'].filter((type) => count(type) < cfg[`${type}s`]);
  if (!types.length) return '';
  return `<div class="spots-float ${types.some(fits) ? 'tap' : ''}">${types.map(spot).join('')}</div>`;
}

function handHTML(v, isWild) {
  const stagedIds = new Set(ui.staged.flatMap((g) => g.ids));
  const cards = ui.order.filter((id) => !stagedIds.has(id)).map((id) => v.hand.find((c) => c.id === id)).filter(Boolean);
  const n = ui.selected.size;
  const btns = [];
  if (v.canUndo) btns.push('<button class="ghost" data-act="undo">Undo</button>');
  if (n) btns.push('<button class="ghost" data-act="clearSel">Clear</button>');
  btns.push(`<button class="ghost" data-act="sort" data-how="${ui.sortMode === 'rank' ? 'suit' : 'rank'}">${ui.sortMode === 'rank' ? 'Sort by suit' : 'Sort by rank'}</button>`);
  return `<div class="hand-area"><div class="hand" id="hand">${cards
    .map((c) =>
      cardHTML(c, {
        isWild,
        cls: `${ui.selected.has(c.id) ? 'sel' : ''} ${ui.fresh.has(c.id) ? 'fresh' : ''}`,
        attrs: `data-card="${c.id}"`,
      })
    )
    .join('')}</div><div class="hand-buttons">${btns.join('')}</div></div>`;
}

// The bottom area (status, staged groups, hand) can be tucked away to see more of the table, like putting
// your cards face down. It opens again on your turn.
function dockHTML(v, isWild) {
  const me = v.you;
  if (me == null) return '';
  const body = stagingHTML(v, isWild) + handHTML(v, isWild);
  if (ui.dockCollapsed)
    return `<div class="dock collapsed"><button class="dock-toggle" data-act="toggleDock">Show my cards (${v.hand.length}) ▴</button></div>`;
  return `<div class="dock"><button class="dock-toggle icon" data-act="toggleDock" title="Hide my cards" aria-label="Hide my cards"><svg viewBox="0 0 24 14" aria-hidden="true"><path d="M3 3l9 8 9-8"/></svg></button><div class="dock-body">${body}</div></div>`;
}

function gameHTML(snap) {
  const v = snap.view;
  const isWild = wildTest(v.options);
  const banner =
    !snap.isHost && snap.status !== 'connected'
      ? `<div class="conn-banner">${snap.status === 'slow' ? "Still can't reach the host. If you're on mobile data, try Wi-Fi." : 'Lost connection to the host. Reconnecting…'}</div>`
      : snap.status === 'error'
        ? `<div class="conn-banner">${esc(snap.error)}</div>`
        : '';
  const me = v.you;
  return `<div class="game">
    ${banner}
    <div class="topbar">
      <span class="round">Round ${v.round + 1}/${ROUNDS.length}</span>
      <span class="contract">${contractText(v.round)}</span>
      <span class="spacer"></span>
      ${snap.lobby.code ? `<span class="muted" style="font-size:12px">${snap.lobby.code}</span>` : ''}
      <button class="icon-btn" data-act="modal" data-m="scores">Scores</button>
      <button class="icon-btn" data-act="modal" data-m="menu">☰</button>
    </div>
    <div class="players hscroll">${playerChips(v)}</div>
    <div class="table">${tableHTML(v, isWild)}</div>
    <div class="bottom">${newGroupSpotsHTML(v)}${centerHTML(v, isWild)}${dockHTML(v, isWild)}</div>
    ${modalHTML(snap)}
  </div>`;
}

// ---------- modals ----------
function modalHTML(snap) {
  const v = snap.view;
  if (v.phase === 'roundOver' || v.phase === 'gameOver') {
    if (!['scores', 'menu', 'rules', 'log', 'settings', 'install'].includes(ui.modal)) return resultModal(snap);
  }
  switch (ui.modal) {
    case 'scores':
      return wrapModal('Scores', scoresTable(v));
    case 'rules':
      return rulesModal(v.options);
    case 'log':
      return wrapModal(
        'Game log',
        `<div class="log">${[...v.log]
          .reverse()
          .map((e) => `<div class="${e.kind}">${esc(e.text)}</div>`)
          .join('')}</div>`
      );
    case 'menu':
      return menuModal(snap);
    case 'settings':
      return settingsModal();
    case 'install':
      return installModal();
    case 'swap':
      return wrapModal(
        'Swap or add?',
        '<p>Swap your card in for the wild card (you then have to play the wild), or add your card to the end of the run?</p>',
        `<button class="primary" data-act="swapOrAdd" data-choice="swap">Swap for the wild</button><button data-act="swapOrAdd" data-choice="add">Add to the end</button>`
      );
    case 'wild':
      return wrapModal(
        'Which end?',
        '<p>Put the wild card on the low end or the high end of the run?</p>',
        `<button data-act="wildEnd" data-end="low">Low end</button><button data-act="wildEnd" data-end="high">High end</button>`
      );
    default:
      return '';
  }
}

// the title and the Close button stay put; only the middle scrolls
function wrapModal(title, body, actions = '') {
  return `<div class="overlay" data-act="closeModal"><div class="modal framed" data-stop>
    <h2>${title}</h2><div class="modal-body">${body}</div>
    <div class="actions">${actions}<button class="ghost" data-act="closeModal">Close</button></div></div></div>`;
}

function totalsOf(v) {
  return v.scores.map((s) => s.reduce((a, b) => a + b, 0));
}

function scoresTable(v) {
  const totals = totalsOf(v);
  const head = v.players.map((p) => `<th>${esc(p.name)}</th>`).join('');
  const rows = ROUNDS.map((_, r) => {
    const cells = v.players.map((_, i) => {
      const s = v.scores[i][r];
      return s == null ? '<td></td>' : `<td class="${s === 0 ? 'zero' : ''}">${s}</td>`;
    });
    return `<tr><td>${r + 1}. ${contractText(r)}</td>${cells.join('')}</tr>`;
  }).join('');
  return `<div style="overflow-x:auto"><table class="scores"><tr><th>Round</th>${head}</tr>${rows}<tr class="total"><td>Total</td>${totals
    .map((t) => `<td>${t}</td>`)
    .join('')}</tr></table></div><p class="muted">Lowest total after ${ROUNDS.length} rounds wins.</p>`;
}

function resultModal(snap) {
  const v = snap.view;
  const rr = v.roundResult;
  const isWild = wildTest(v.options);
  const totals = totalsOf(v);
  const over = v.phase === 'gameOver';
  const order = v.players.map((_, i) => i).sort((a, b) => (over ? totals[a] - totals[b] : rr.points[a] - rr.points[b]));
  const rows = order
    .map((i, rank) => {
      const hand = rr.hands ? rr.hands[i] : [];
      return `<div class="result-row"><div class="top"><span>${over && rank === 0 ? '🏆 ' : ''}${esc(v.players[i].name)}${
        rr.winner === i ? ' went out!' : ''
      }</span><span>+${rr.points[i]} · total ${totals[i]}</span></div>
      ${hand.length ? `<div class="mini-hand">${hand.map((c) => cardHTML(c, { sm: true, isWild })).join('')}</div>` : ''}</div>`;
    })
    .join('');
  const title = over ? `Game over! ${esc(v.players[order[0]].name)} wins` : `Round ${v.round + 1} done`;
  let actions = '';
  if (snap.isHost) actions = over ? '<button class="primary" data-act="playAgain">Play again</button>' : `<button class="primary" data-act="nextRound">Deal round ${v.round + 2}: ${contractText(v.round + 1)}</button>`;
  else actions = `<span class="muted">Waiting for the host to ${over ? 'start a new game' : 'deal'}…</span>`;
  return `<div class="overlay"><div class="modal">
    <h2>${title}</h2>
    ${rr.winner == null ? '<p class="muted">Nobody went out this round.</p>' : ''}
    ${rows}
    <div class="actions"><button class="ghost" data-act="modal" data-m="scores">Score sheet</button>${over ? '<button class="ghost" data-act="leave">Home</button>' : ''}${actions}</div>
  </div></div>`;
}

function menuModal(snap) {
  const v = snap.view;
  const items = [
    '<button class="ghost" data-act="modal" data-m="scores">Score sheet</button>',
    '<button class="ghost" data-act="modal" data-m="log">Game log</button>',
    '<button class="ghost" data-act="modal" data-m="rules">Rules</button>',
    '<button class="ghost" data-act="modal" data-m="settings">Settings</button>',
  ];
  if (snap.isHost) {
    if (snap.lobby.code) items.push(`<button class="ghost" data-act="share">Share invite link (${snap.lobby.code})</button>`);
    snap.lobby.seats.forEach((s, i) => {
      if (s.isHost) return;
      if (!s.connected && !s.bot) items.push(`<button class="ghost" data-act="toggleBot" data-seat="${i}">Let the computer play for ${esc(s.name)}</button>`);
      else if (s.standIn)
        items.push(`<button class="ghost" data-act="toggleBot" data-seat="${i}">Give ${esc(s.name)}'s seat back to them</button>`);
    });
    if (v.phase === 'draw' || v.phase === 'play') items.push('<button class="danger" data-act="endRound">End this round (nobody can go out)</button>');
  }
  items.push(`<button class="danger" data-act="leave">${snap.isHost && !snap.solo ? 'Leave (game pauses for everyone)' : 'Leave game'}</button>`);
  return wrapModal('Menu', `<div class="menu-list">${items.join('')}</div>`);
}

// Your own preferences. They're saved in this browser, so they come back next time on this device.
function settingsModal() {
  const choice = (act, val, on, label) => `<button class="${on ? 'primary' : 'ghost'}" data-act="${act}" data-val="${val}">${label}</button>`;
  const backs = CARD_BACKS.map(
    ([key, label]) =>
      `<button class="back-swatch ${ui.cardBack === key ? 'on' : ''}" data-act="setCardBack" data-val="${key}" title="${label}"><span class="card-back" data-back="${key}"></span>${label}</button>`
  ).join('');
  return wrapModal(
    'Settings',
    `<div class="settings">
      <h3>Card color</h3><div class="swatches">${backs}</div>
      <h3>Sort cards</h3><div class="seg">${choice('setSortDesc', 0, !ui.sortDesc, 'Low to high')}${choice('setSortDesc', 1, ui.sortDesc, 'High to low')}</div>
      <h3>Sound</h3><div class="seg">${choice('setSound', 1, ui.sound, 'On')}${choice('setSound', 0, !ui.sound, 'Off')}</div>
      <p class="muted">Saved on this device.${canAddToHome() ? ' Phones can clear them if you don\'t play for a while, unless you add the game to your home screen.' : ''}</p>
      ${canAddToHome() ? '<button class="ghost small" data-act="addToHome">Add to your home screen</button>' : ''}
    </div>`
  );
}

function rulesModal(o) {
  const rounds = ROUNDS.map((r, i) => `<li>Round ${i + 1}: ${contractText(i)} (${r.deal} cards)</li>`).join('');
  return wrapModal(
    'How to play',
    `<div class="rules">
    <p>Lowest score after ${ROUNDS.length} rounds wins. Each round has a contract you must lay down before you can play on any piles.</p>
    <ul>${rounds}</ul>
    <h3>Sets &amp; runs</h3>
    <ul><li>Set: 3 or more of the same rank.</li><li>Run: 4 or more in a row, same suit. Aces are high only (J-Q-K-A, never A-2-3-4).</li>
    <li>Jokers are wild${o.twoClubsWild ? ', and so is the 2♣' : '. The 2♣ is NOT wild'}. Every set or run needs more real cards than wild cards (a 4-card run needs 3 real cards), and a run can't have two wild cards next to each other.</li>
    <li>When you make a run with a joker, the joker goes where you put it: select the cards in order (e.g. joker, 8, 9, 10).</li>
    <li>${decksFor(o)} decks with ${decksFor(o) * 2} jokers. When the deck runs out, the discard pile is shuffled into a new deck.</li></ul>
    <h3>Your turn</h3>
    <ul><li>Draw from the deck or take the top discard.</li><li>Lay down your contract (exactly the sets and runs listed). Once you're down you can add cards to anyone's piles, on this turn or later.</li>
    <li>End your turn by discarding one card.</li></ul>
    <h3>Buying</h3>
    <ul><li>At the start of your turn you choose: <b>Take it</b> (you take the discard) or <b>Allow buy</b>. You can only draw from the deck after allowing others to buy.</li>
    <li>If you allow it, the offer goes around the table in order, starting with the player after you. Each player gets 10 seconds to say Buy or No; the first to buy gets the card plus ${o.buyPenalty} from the deck.</li>
    <li>When a card is bought, the card underneath is live again (even if it had been Shanghai'd), and you choose again: take it, or allow buying.</li>
    <li>If nobody buys it, you can still take it, or draw from the deck.</li>
    <li>${o.buyLimit} buys per round. Once you've laid down you can't buy.</li>
    <li>The <b class="buys-left">$</b> signs by each name are the buys that player has left.</li></ul>
    <h3>Shanghai!</h3>
    <ul><li>If anyone discards a card that could have gone on a pile, anyone else can hit <b>SHANGHAI!</b> before the next player draws. The discarder picks up ${o.shanghaiPenalty} cards and that card is dead.</li>
    <li>A card counts as playable if it fits on the end of a pile or could swap out a joker in a run (e.g. a 9 when there's 7, 8, joker, 10).</li>
    <li>Calling Shanghai when there isn't one ${o.falseCallPenalty ? `costs you ${o.falseCallPenalty} card${o.falseCallPenalty === 1 ? '' : 's'}` : 'costs nothing'}.</li>
    <li>Want to get rid of a playable card on purpose? Before discarding, tap SHANGHAI! yourself. Your discard is declared dead: no penalty, but nobody can pick it up or buy it until another card covers it. (If the card couldn't actually go anywhere, it isn't a Shanghai: you'll get a heads-up and the card stays live.)</li></ul>
    <h3>Swapping wild cards</h3>
    <ul><li>Once you've laid down, if a run on the table has a joker standing in for a card you hold, select that card and tap the run to swap it in. You take the joker.</li>
    <li>You have to play the joker you took before you can discard. Only runs, never sets.</li></ul>
    <h3>Going out</h3>
    <ul><li>You can't go out on a discard. Your last cards (at least 2 on that final turn) have to be played onto piles.</li>
    <li>Made a mistake? Undo takes back plays you made this turn, until you discard. It can even put back a discard you picked up, so you can choose again.</li></ul>
    <h3>Scoring</h3>
    <ul><li>2–9: face value · 10, J, Q, K: 10 · Ace: 20 · Joker${o.twoClubsWild ? ' / 2♣' : ''}: 50</li></ul>
    </div>`
  );
}

// ---------- hand layout & dragging ----------
// Lays the hand out as overlapping fans. When there are too many cards for one row to keep each card's
// corner readable, it wraps into more rows (each tucked half under the one above) and, for really big
// hands, shrinks the cards a little.
function layoutHand() {
  const hand = document.getElementById('hand');
  if (!hand) return;
  const cards = [...hand.querySelectorAll('.card')];
  const root = getComputedStyle(document.documentElement);
  const baseW = parseFloat(root.getPropertyValue('--cw')) || 62;
  const baseH = parseFloat(root.getPropertyValue('--ch')) || 88;
  // the width the hand actually has (the whole page in portrait, less in a landscape layout)
  const area = hand.closest('.dock') || document.documentElement;
  const avail = Math.min(area.clientWidth - 20, 1200);
  const n = cards.length;
  const fit = (scale) => {
    const cw = baseW * scale;
    const minStep = Math.max(22, cw * 0.36); // enough to read the rank and suit in the corner
    const perRowMax = Math.max(1, Math.floor((avail - cw) / minStep) + 1);
    const rows = Math.max(1, Math.ceil(n / perRowMax));
    return { scale, cw, ch: baseH * scale, rows, perRow: Math.ceil(n / rows) };
  };
  // shrink only when even two rows aren't enough
  let L = fit(1);
  if (L.rows > 2) L = fit(0.85);
  if (L.rows > 2) L = fit(0.75);
  const step = L.perRow > 1 ? Math.min(L.cw * 0.7, (avail - L.cw) / (L.perRow - 1)) : 0;
  const rowGap = L.ch * 0.5;
  hand.style.setProperty('--cw', `${L.cw}px`);
  hand.style.setProperty('--ch', `${L.ch}px`);
  hand.style.width = `${L.cw + step * Math.max(0, L.perRow - 1)}px`;
  hand.style.height = `${L.ch + 22 + rowGap * (L.rows - 1)}px`;
  const slots = handSlots(n, { step, perRow: L.perRow, rowGap, cw: L.cw });
  cards.forEach((el, i) => placeInSlot(el, slots[i], i));
  Object.assign(hand.dataset, { step, perRow: L.perRow, rowGap, rows: L.rows, cw: L.cw });
}

// Where each of the hand's n slots sits. While dragging, slots gapAt..gapAt+gapLen-1 are the empty space
// the dragged cards will drop into. The space is at least 60% of a card wide so it shows up even in a
// crowded hand, and it comes out of the other cards' overlap in that row, so the hand never gets wider.
function handSlots(n, g, gapAt = -1, gapLen = 0) {
  const isGap = (i) => i >= gapAt && i < gapAt + gapLen;
  const gapStep = gapLen ? Math.max(g.step, (g.cw * 0.6 + (gapLen - 1) * g.step) / gapLen) : g.step;
  const room = g.step * (g.perRow - 1);
  const slots = [];
  for (let start = 0; start < n; start += g.perRow) {
    const end = Math.min(n, start + g.perRow);
    // the distance from each slot to the next one in the row
    const steps = [];
    for (let i = start; i < end - 1; i++) steps.push(isGap(i) ? gapStep : g.step);
    const total = steps.reduce((a, b) => a + b, 0);
    if (total > room) {
      const gapTotal = steps.reduce((a, s, k) => a + (isGap(start + k) ? s : 0), 0);
      const plain = steps.filter((s, k) => !isGap(start + k)).length;
      const squeezed = plain ? (room - gapTotal) / plain : 0;
      for (let k = 0; k < steps.length; k++) {
        if (plain && squeezed >= 8) steps[k] = isGap(start + k) ? steps[k] : squeezed;
        else steps[k] *= room / total;
      }
    }
    let left = 0;
    for (let i = start; i < end; i++) {
      slots.push({ left, top: 18 + (start / g.perRow) * g.rowGap });
      left += steps[i - start] || 0;
    }
  }
  return slots;
}

// Cards higher in the hand order sit on top. Odd z-indexes are left free for the drop outlines.
function placeInSlot(el, slot, i) {
  el.style.left = `${slot.left}px`;
  el.style.top = `${slot.top}px`;
  el.style.zIndex = i * 2 + 2;
}

// Dragging works alongside tapping: a press that moves less than 8px is still a tap. Cards dragged within your
// hand rearrange it. Lifted up out of the hand they float with your finger and can be dropped on the discard
// pile, a staged group or a pile on the table. The deck and the discard can be dragged down into your hand to
// draw. Drop targets reach DROP_BUFFER past their edges so a drop doesn't have to be exact.
const DROP_BUFFER = 24;

function handGeo(hand) {
  return {
    step: parseFloat(hand.dataset.step) || 1,
    perRow: Number(hand.dataset.perRow) || 1,
    rowGap: parseFloat(hand.dataset.rowGap) || 1,
    rows: Number(hand.dataset.rows) || 1,
    cw: parseFloat(hand.dataset.cw) || 62,
  };
}

function onPointerDown(e) {
  ui.swallowClick = false;
  // one drag at a time, and not while the last drop is still sliding into place
  if (ui.drag || $app.querySelector('.hand .settling')) return;
  const pile = e.target.closest('[data-drag]');
  if (pile) return startPileDrag(e, pile);
  const el = e.target.closest('.hand .card');
  if (!el) return;
  const hand = el.parentElement;
  const cardEls = [...hand.querySelectorAll('.card')];
  const id = Number(el.dataset.card);
  // dragging a selected card brings the other selected cards along
  const group = ui.selected.has(id) ? cardEls.filter((c) => ui.selected.has(Number(c.dataset.card))) : [el];
  const r = el.getBoundingClientRect();
  ui.drag = {
    kind: 'hand',
    el,
    id,
    hand,
    cardEls,
    group,
    held: group.indexOf(el),
    rest: cardEls.filter((c) => !group.includes(c)),
    start: group.map((c) => ({ left: parseFloat(c.style.left), top: parseFloat(c.style.top) })),
    x0: e.clientX,
    y0: e.clientY,
    grabX: e.clientX - r.left,
    grabY: e.clientY - r.top,
    ...handGeo(hand),
    ch: parseFloat(hand.style.getPropertyValue('--ch')) || 88,
    lift: (parseFloat(hand.style.getPropertyValue('--ch')) || 88) * 0.4,
    to: -1,
    outlines: [],
    out: false,
    moved: false,
    pointerId: e.pointerId,
  };
  el.setPointerCapture(e.pointerId);
}

function startPileDrag(e, pile) {
  const card = pile.firstElementChild;
  const r = card.getBoundingClientRect();
  ui.drag = {
    kind: 'pile',
    from: pile.dataset.drag,
    el: pile,
    card,
    x0: e.clientX,
    y0: e.clientY,
    grabX: e.clientX - r.left,
    grabY: e.clientY - r.top,
    lift: r.height * 0.4,
    to: -1,
    outlines: [],
    moved: false,
    pointerId: e.pointerId,
  };
  pile.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  const d = ui.drag;
  if (!d || e.pointerId !== d.pointerId) return;
  if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 8) return;
  d.moved = true;
  d.px = e.clientX;
  d.py = e.clientY;
  if (d.kind === 'pile') return movePileDrag(d);
  // lifted clear of the hand, the cards come out of it and float with your finger. It goes by where the held
  // card is (it floats above the finger), and coming back in takes a little more than going out, so it doesn't
  // flicker at the edge.
  const cardsTop = d.hand.getBoundingClientRect().top + 18;
  const heldMiddle = d.py - d.grabY - d.lift + d.ch / 2;
  const out = heldMiddle < cardsTop - (d.out ? 0 : 40);
  if (out !== d.out) (out ? liftOutOfHand : putBackInHand)(d);
  if (out) return moveGhost(d);
  moveInHand(d);
}

function moveInHand(d) {
  const dx = d.px - d.x0;
  // with one row the cards only lift; with several they can move between rows
  const dy = d.rows > 1 ? d.py - d.y0 : Math.min(0, d.py - d.y0);
  if (!d.outlines.length) {
    d.hand.classList.add('drag-on');
    // let the lifted cards float above the dock, unless it's scrolling and has to clip
    const dock = d.hand.closest('.dock-body');
    if (dock && dock.scrollHeight <= dock.clientHeight) dock.classList.add('lifting');
    d.outlines = d.group.map(() => d.hand.appendChild(Object.assign(document.createElement('div'), { className: 'drop-slot' })));
  }
  // the held card follows the finger, floating a little higher so the space under it shows, and the rest of
  // the group fans out from it
  const fan = Math.min(d.step, d.cw * 0.3);
  const held = d.start[d.held];
  d.group.forEach((el, j) => {
    el.classList.add('dragging');
    el.style.zIndex = 200 + j;
    const x = held.left + dx + (j - d.held) * fan - d.start[j].left;
    const y = held.top + dy - d.lift - d.start[j].top;
    el.style.transform = `translate(${x}px, ${y}px)`;
  });
  showGap(d, slotAt(d, held.left + dx - d.held * fan, held.top + dy, d.rest.length));
}

// The slot (counting only the cards staying in the hand) that a card at left/top within the hand would drop into
function slotAt(g, left, top, max) {
  const col = Math.max(0, Math.min(g.perRow - 1, Math.round(left / g.step)));
  const row = Math.max(0, Math.min(g.rows - 1, Math.round((top - 18) / g.rowGap)));
  return Math.min(max, row * g.perRow + col);
}

// Slides the cards staying in the hand aside to open a space at slot `to`, outlined where the cards will land
function showGap(d, to) {
  if (to === d.to) return;
  d.to = to;
  const k = d.outlines.length;
  const slots = handSlots(d.rest.length + k, d, to, k);
  d.rest.forEach((el, i) => placeInSlot(el, slots[i < to ? i : i + k], i < to ? i : i + k));
  d.outlines.forEach((el, j) => {
    el.style.display = '';
    el.style.left = `${slots[to + j].left}px`;
    el.style.top = `${slots[to + j].top}px`;
    el.style.zIndex = (to + j) * 2 + 1;
  });
}

// Closes the space again, with every card back in its place
function closeGap(d, cards) {
  if (d.to === -1) return;
  d.to = -1;
  const slots = handSlots(cards.length, d);
  cards.forEach((el, i) => placeInSlot(el, slots[i], i));
  d.outlines.forEach((el) => (el.style.display = 'none'));
}

function liftOutOfHand(d) {
  d.out = true;
  document.body.classList.add('cards-lifted');
  placeSpots(d.hand);
  // the dragged cards leave holes where they were, so it's clear where they'd go back to
  d.group.forEach((el) => (el.style.visibility = 'hidden'));
  closeGap(d, d.cardEls);
  const fan = Math.min(d.step, d.cw * 0.3);
  d.ghost = makeGhost(
    d.group.map((el) => el.cloneNode(true)),
    fan,
    d.hand.style.getPropertyValue('--cw'),
    d.hand.style.getPropertyValue('--ch')
  );
  d.ghostX = d.grabX + d.held * fan;
  autoScroll(d);
}

// The New set / New run spots go where a new group will show, on top of the page so nothing moves:
// - nothing staged yet: a bar in the space between the deck row and your hand
// - groups staged with room after them: tiles at the end of the row, beside the groups
// - the row is full: a bar over the "Your lay down" line above it, so they never cover a group
function placeSpots(hand) {
  const spots = $app.querySelector('.spots-float');
  const dock = hand && hand.closest('.dock');
  if (!spots || !dock) return;
  const n = [...spots.children].filter((el) => getComputedStyle(el).display !== 'none').length;
  if (!n) return;
  const box = dock.getBoundingClientRect();
  const place = (left, width, top, height, gap = 8) =>
    Object.assign(spots.style, { left: `${left}px`, width: `${width}px`, top: `${top}px`, height: `${height}px`, columnGap: `${gap}px` });
  const row = $app.querySelector('.staged-row');
  spots.classList.remove('tiles', 'slim');
  if (!row) {
    // a slim pill in the gap between the Deck / Discard labels and the tops of the hand's cards (selected ones
    // sit higher), so it covers neither; it leaves the hide-cards arrow in the middle uncovered too, with one
    // spot to its left or one either side of it
    spots.classList.add('slim');
    const left = box.left + 12;
    const labels = [...$app.querySelectorAll('.center .pile > span')].map((el) => el.getBoundingClientRect().bottom);
    // (cards being dragged don't count: they've already been lifted out)
    const cards = [...hand.querySelectorAll('.card:not(.dragging)')].map((el) => el.getBoundingClientRect().top);
    const bottom = (cards.length ? Math.min(...cards) : hand.getBoundingClientRect().top + 18) - 4;
    const height = Math.max(28, Math.min(44, bottom - (labels.length ? Math.max(...labels) + 3 : bottom - 44)));
    const arrow = $app.querySelector('.dock-toggle');
    const a = arrow ? arrow.getBoundingClientRect() : { left: box.left + box.width / 2, width: 0 };
    if (n === 1) return place(left, a.left - 8 - left, bottom - height, height);
    return place(left, box.width - 24, bottom - height, height, a.width + 16);
  }
  const r = row.getBoundingClientRect();
  const groups = [...row.querySelectorAll('.staged')];
  const last = groups[groups.length - 1].getBoundingClientRect();
  const need = n * 92 + (n - 1) * 8;
  if (r.right - (last.right + 8) >= need) {
    spots.classList.add('tiles');
    return place(last.right + 8, need, last.top, last.height);
  }
  // the row is full: over the "Your lay down" line, short of the Lay down button
  const lay = $app.querySelector('.staging-head button');
  const end = lay ? lay.getBoundingClientRect().left - 8 : box.right - 12;
  place(box.left + 12, end - box.left - 12, r.top + 2 - 40, 40);
}

// Spots shown for tapping (cards selected, no drag) are placed after each render
function placeTapSpots() {
  if ($app.querySelector('.spots-float.tap')) placeSpots(document.getElementById('hand'));
}

function putBackInHand(d) {
  d.out = false;
  document.body.classList.remove('cards-lifted');
  placeTapSpots();
  d.group.forEach((el) => (el.style.visibility = ''));
  d.ghost.remove();
  d.ghost = null;
  setHover(d, null);
}

// The floating copy of the dragged cards, kept outside the page so nothing clips it
function makeGhost(cards, fan, cw, ch) {
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  if (cw) ghost.style.setProperty('--cw', cw);
  if (ch) ghost.style.setProperty('--ch', ch);
  cards.forEach((c, j) => {
    c.removeAttribute('style');
    c.classList.remove('dragging', 'sel', 'fresh');
    c.style.left = `${j * fan}px`;
    ghost.appendChild(c);
  });
  document.body.appendChild(ghost);
  return ghost;
}

// Moves the floating cards to the finger and lights up the drop target under them
function moveGhost(d) {
  const x = d.px - (d.ghostX ?? d.grabX);
  const y = d.py - d.grabY - d.lift;
  d.ghost.style.transform = `translate(${x}px, ${y}px)`;
  // aim with the middle of the held card (what you see), not the finger under it
  const card = d.ghost.children[d.held || 0].getBoundingClientRect();
  d.aimX = card.left + card.width / 2;
  d.aimY = card.top + card.height / 2;
  setHover(d, dropTarget(d));
}

function movePileDrag(d) {
  if (!d.ghost) {
    const r = d.card.getBoundingClientRect();
    d.ghost = makeGhost([d.card.cloneNode(true)], 0, `${r.width}px`, `${r.height}px`);
    d.el.classList.add('lifted');
    // the discard can go straight onto a staged group or a New set / New run spot, so show the spots
    if (d.from === 'discard') {
      document.body.classList.add('cards-lifted');
      placeSpots(document.getElementById('hand'));
    }
  }
  moveGhost(d);
  // over your hand, it opens a space where the card will go
  const hand = document.getElementById('hand');
  if (!hand) return;
  if (d.hover !== hand) {
    if (d.to !== -1) {
      d.to = -1;
      layoutHand();
      d.outlines.forEach((el) => (el.style.display = 'none'));
    }
    return;
  }
  if (!d.cardEls) {
    d.cardEls = [...hand.querySelectorAll('.card')];
    d.rest = d.cardEls;
    Object.assign(d, handGeo(hand));
    // one more card has to fit in the same width
    const n = d.cardEls.length + 1;
    const room = Math.max(d.step * (d.perRow - 1), d.cw * 0.7);
    d.perRow = Math.ceil(n / d.rows);
    d.step = d.perRow > 1 ? room / (d.perRow - 1) : 1;
    hand.classList.add('drag-on');
    d.outlines = [hand.appendChild(Object.assign(document.createElement('div'), { className: 'drop-slot' }))];
  }
  const h = hand.getBoundingClientRect();
  const g = d.ghost.firstElementChild.getBoundingClientRect();
  showGap(d, slotAt(d, g.left - h.left, g.top + d.lift - h.top, d.rest.length));
}

// What the dragged cards would drop onto: the target nearest the aim point, within DROP_BUFFER of its edges.
// Piles on the table and staged groups only count where they're scrolled into view.
function dropTarget(d) {
  const els =
    d.kind === 'hand'
      ? [...$app.querySelectorAll('[data-drop]')]
      : [
          document.getElementById('hand') || $app.querySelector('.dock'),
          ...(d.from === 'discard' ? $app.querySelectorAll('[data-drop="staged"], [data-drop="newGroup"], .meld[data-meld]') : []),
        ].filter(Boolean);
  let best = null;
  let bestDist = Infinity;
  for (const el of els) {
    let r = el.getBoundingClientRect();
    if (!r.width) continue; // not showing
    const box = el.closest('.table, .staged-row');
    if (box) {
      const b = box.getBoundingClientRect();
      r = { left: Math.max(r.left, b.left), right: Math.min(r.right, b.right), top: Math.max(r.top, b.top), bottom: Math.min(r.bottom, b.bottom) };
      if (r.left >= r.right || r.top >= r.bottom) continue;
    }
    const dx = Math.max(0, r.left - d.aimX, d.aimX - r.right);
    const dy = Math.max(0, r.top - d.aimY, d.aimY - r.bottom);
    if (dx > DROP_BUFFER || dy > DROP_BUFFER) continue;
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) [best, bestDist] = [el, dist];
  }
  return best;
}

function setHover(d, el) {
  if (d.hover === el) return;
  if (d.hover) d.hover.classList.remove('drop-hover');
  d.hover = el;
  // your own hand doesn't need a glow: the space opening in it shows where the card goes
  if (el && el.id !== 'hand') el.classList.add('drop-hover');
}

// Holding cards near the top or bottom edge of the table scrolls it, to reach piles that are out of view
function autoScroll(d) {
  const tick = () => {
    if (ui.drag !== d || !d.out) return;
    const table = $app.querySelector('.table');
    if (table && d.aimY != null) {
      const r = table.getBoundingClientRect();
      const inside = d.aimX >= r.left && d.aimX <= r.right;
      const by = d.aimY < r.top + 40 && d.aimY > r.top - 40 ? -8 : d.aimY > r.bottom - 40 && d.aimY < r.bottom ? 8 : 0;
      if (inside && by) {
        const before = table.scrollTop;
        table.scrollTop += by;
        if (table.scrollTop !== before) setHover(d, dropTarget(d));
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function endDrag(d) {
  ui.drag = null;
  document.body.classList.remove('cards-lifted');
  if (d.ghost) d.ghost.remove();
  ui.swallowClick = d.moved;
}

function onPointerUp(e) {
  const d = ui.drag;
  if (!d || e.pointerId !== d.pointerId) return;
  endDrag(d);
  const v = ui.snap && ui.snap.view;
  // a pile that was only tapped is handled by the click that follows
  if (d.kind === 'pile') {
    if (!d.moved) return; // redrawing now would remove the pile before its click arrives
    if (v && d.hover && (d.hover.id === 'hand' || d.hover.classList.contains('dock'))) drawTo(d.from, d.to);
    else if (v && d.hover) takeDiscardTo(v, d.hover, d.aimX);
    return render();
  }
  if (!d.moved) {
    if (ui.selected.has(d.id)) ui.selected.delete(d.id);
    else ui.selected.add(d.id);
    ui.fresh.clear();
    return render();
  }
  const groupIds = d.group.map((el) => Number(el.dataset.card));
  if (d.out) {
    if (v && d.hover) dropOn(v, d.hover, groupIds, d.aimX);
    return render();
  }
  const stagedIds = new Set(ui.staged.flatMap((g) => g.ids));
  const visible = ui.order.filter((id) => !stagedIds.has(id) && !groupIds.includes(id));
  visible.splice(d.to, 0, ...groupIds);
  ui.order = [...visible, ...ui.order.filter((id) => stagedIds.has(id))];
  ui.sortMode = 'manual';
  // slide the dragged cards into the space before redrawing
  const slots = handSlots(d.cardEls.length, d);
  d.outlines.forEach((el) => el.remove());
  d.group.forEach((el, j) => {
    el.classList.remove('dragging');
    el.classList.add('settling');
    el.style.left = `${slots[d.to + j].left}px`;
    el.style.top = `${slots[d.to + j].top}px`;
    el.style.transform = '';
  });
  setTimeout(render, 130);
}

// Draws from the deck or discard pile; the new card goes where it was dropped in your hand (index `at`)
function drawTo(from, at) {
  ui.drawTo = at >= 0 ? { index: at, until: Date.now() + 5000 } : null;
  if (at >= 0) ui.sortMode = 'manual';
  const res = send({ type: from === 'deck' ? 'drawDeck' : 'drawDiscard' });
  if (!res.ok) ui.drawTo = null;
}

function dropOn(v, target, ids, x) {
  const isWild = wildTest(v.options);
  const cards = ids.map((id) => v.hand.find((c) => c.id === id)).filter(Boolean);
  const kind = target.dataset.drop;
  if (kind === 'discard') {
    if (cards.length > 1) return toast('Discard one card at a time.', true);
    return discard(cards[0].id);
  }
  if (kind === 'staged') return addToStaged(v, Number(target.dataset.i), cards, isWild);
  if (kind === 'newGroup') return stageGroup(target.dataset.type, cards, isWild);
  const meld = v.melds.find((m) => m.id === Number(target.dataset.meld));
  if (meld) playOn(v, meld, cards, isWild, dropSpot(target, meld, x, isWild));
}

// Where on a pile something was dropped: on a joker, or which half of it
function dropSpot(target, meld, x, isWild) {
  const r = target.getBoundingClientRect();
  const shown = [...target.querySelectorAll('.card')];
  const over = shown.filter((c) => c.getBoundingClientRect().left <= x).length - 1;
  const onWild = over >= 0 && x <= shown[over].getBoundingClientRect().right && isWild(meld.cards[over]);
  return { onWild, side: x < r.left + r.width / 2 ? 'low' : 'high' };
}

// Takes the discard straight onto a staged group, a New set / New run spot or a pile on the table. The card is
// checked first, with the usual message if it can't go there, so it stays on the discard pile rather than being
// taken for nothing. Once it's in your hand (right away for the host, after the host replies for everyone
// else), finishTake() plays it.
function takeDiscardTo(v, target, x) {
  const isWild = wildTest(v.options);
  const card = v.discardTop;
  if (!card) return;
  const kind = target.dataset.drop || 'meld';
  const take = { id: card.id, kind, until: Date.now() + 5000 };
  if (kind === 'staged') {
    take.i = Number(target.dataset.i);
    const g = ui.staged[take.i];
    if (!g || !stagedWith(v, g, [card], isWild)) return toast(`${cardLabel(card)} can't go in that ${g ? g.type : 'group'}.`, true);
  } else if (kind === 'newGroup') {
    take.type = target.dataset.type;
  } else {
    const meld = v.melds.find((m) => m.id === Number(target.dataset.meld));
    if (!meld) return;
    if (!(wildSlotFor(meld, card, isWild) >= 0 || addCards(meld, [card], isWild)))
      return toast(`${cardLabel(card)} can't go on that ${meld.type}.`, true);
    take.meldId = meld.id;
    take.spot = dropSpot(target, meld, x, isWild);
  }
  ui.afterDraw = take;
  if (!send({ type: 'drawDiscard' }).ok) ui.afterDraw = null;
}

function finishTake(take) {
  const v = ui.snap && ui.snap.view;
  const card = v && v.hand.find((c) => c.id === take.id);
  if (!card || Date.now() > take.until) return;
  const isWild = wildTest(v.options);
  if (take.kind === 'staged') addToStaged(v, take.i, [card], isWild);
  else if (take.kind === 'newGroup') stageGroup(take.type, [card], isWild);
  else playOn(v, v.melds.find((m) => m.id === take.meldId), [card], isWild, take.spot);
  render();
}

// ---------- playing cards (shared by taps and drags) ----------
function discard(id) {
  const res = send({ type: 'discard', id, declare: ui.armed });
  if (res.ok) {
    ui.selected.clear();
    ui.armed = false;
  }
}

// Starts a staged group. One card is enough to start one when it's dragged onto a "New set" or "New run" spot.
function stageGroup(type, cards, isWild) {
  const ok = cards.length === 1 || (type === 'set' ? couldBeSet(cards, isWild) : couldBeRun(cards, isWild));
  if (!ok) return toast(type === 'set' ? "Those cards can't make a set." : "Those cards can't make a run.", true);
  ui.staged.push({ type, ids: cards.map((c) => c.id) });
  for (const c of cards) ui.selected.delete(c.id);
  ui.revealStaged = true;
}

// A staged group with cards added, in order, or null if they don't fit
function stagedWith(v, g, added, isWild) {
  const existing = g.ids.map((id) => v.hand.find((c) => c.id === id)).filter(Boolean);
  const all = g.type === 'set' ? [...existing, ...added] : arrangeRun(existing, added, isWild);
  return (g.type === 'set' ? couldBeSet(all, isWild) : couldBeRun(all, isWild)) ? all : null;
}

function addToStaged(v, i, added, isWild) {
  const g = ui.staged[i];
  if (!g) return;
  const all = stagedWith(v, g, added, isWild);
  if (!all) return toast(`${added.map(cardLabel).join(' ')} can't go in that ${g.type}.`, true);
  g.ids = all.map((c) => c.id);
  for (const c of added) ui.selected.delete(c.id);
  if (ui.flash && ui.flash.bad) ui.flash = null; // an earlier "can't go there" no longer applies
}

// Plays cards on a pile on the table. A tap asks when it's unclear what you meant (swap the joker or add to the
// run, which end a joker goes on); a drag answers from where you dropped: on a joker swaps it, and the left or
// right half of a run is its low or high end.
function playOn(v, meld, cards, isWild, drop = null) {
  if (!meld || !cards.length) return;
  const ids = cards.map((c) => c.id);
  const done = (res) => {
    if (res.ok) for (const id of ids) ui.selected.delete(id);
  };
  const canSwap = cards.length === 1 && wildSlotFor(meld, cards[0], isWild) >= 0;
  const canAdd = !!addCards(meld, cards, isWild);
  if (!canSwap && !canAdd) return toast(`${cards.map(cardLabel).join(' ')} can't go on that ${meld.type}.`, true);
  if (canSwap && (!canAdd || (drop && drop.onWild))) return done(send({ type: 'swapWild', meldId: meld.id, id: ids[0] }));
  if (canSwap && !drop) {
    ui.wildPrompt = { meldId: meld.id, ids };
    ui.modal = 'swap';
    return;
  }
  if (cards.some(isWild) && meld.type === 'run') {
    const lowOk = addCards(meld, cards, isWild, 'low');
    const highOk = addCards(meld, cards, isWild, 'high');
    if (lowOk && highOk && lowOk.lo !== highOk.lo) {
      if (drop) return done(send({ type: 'addToMeld', meldId: meld.id, ids, wildEnd: drop.side }));
      ui.wildPrompt = { meldId: meld.id, ids };
      ui.modal = 'wild';
      return;
    }
  }
  done(send({ type: 'addToMeld', meldId: meld.id, ids }));
}

// Slide the new discard from the tile of the player who threw it down onto the discard pile. The real card on the
// pile stays hidden (.landing) until it lands; re-renders in the meantime keep it hidden by checking ui.flyUntil.
const FLY_MS = 550;
function flyDiscard() {
  const seat = ui.flyFrom;
  ui.flyFrom = null;
  if (seat == null || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const row = $app.querySelector('.players');
  const chip = row && row.children[seat];
  const card = $app.querySelector('.discard-pile .stack > .card');
  if (!chip || !card) return;
  const from = chip.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  const to = card.getBoundingClientRect();
  // a tile scrolled out of sight sends its card from the edge of the row
  const fx = Math.min(Math.max(from.left + from.width / 2, box.left + 20), box.right - 20);
  const fy = from.top + from.height / 2;
  const ghost = card.cloneNode(true);
  ghost.classList.add('flying-card');
  Object.assign(ghost.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
  document.body.appendChild(ghost);
  ui.flyUntil = Date.now() + FLY_MS;
  card.closest('.discard-pile').classList.add('landing');
  const dx = fx - (to.left + to.width / 2);
  const dy = fy - (to.top + to.height / 2);
  ghost.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0.4 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: FLY_MS, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' }
  ).onfinish = () => {
    ghost.remove();
    ui.flyUntil = 0;
    const pile = $app.querySelector('.discard-pile.landing');
    if (pile) pile.classList.remove('landing');
  };
}

// ---------- events ----------
function startHost(solo) {
  ui.name = ui.name.trim();
  if (!ui.name) {
    ui.homeError = 'Enter your name first.';
    return render();
  }
  store.set('name', ui.name);
  ui.homeError = null;
  try {
    startSession(new HostSession({ name: ui.name, clientId, solo }));
  } catch (err) {
    ui.homeError = 'Could not start: ' + err.message;
    render();
  }
}

function startJoin() {
  ui.name = ui.name.trim();
  const code = ui.joinCode.trim().toUpperCase();
  if (!ui.name) {
    ui.homeError = 'Enter your name first.';
    return render();
  }
  if (code.length < 4) {
    ui.homeError = 'Enter the room code from the host.';
    return render();
  }
  store.set('name', ui.name);
  ui.homeError = null;
  const u = new URL(location.href);
  u.searchParams.set('join', code);
  history.replaceState(null, '', u);
  startSession(new ClientSession({ code, name: ui.name, clientId, join: joinRoom }));
}

function leave() {
  const snap = ui.snap;
  if (snap && snap.isHost && snap.view && snap.view.phase !== 'gameOver' && !snap.solo) {
    if (!confirm("Everyone's game will pause until you come back to it from Your games. Leave anyway?")) return;
  }
  if (ui.session) ui.session.close();
  if (snap && snap.isHost && snap.view && snap.view.phase === 'gameOver') HostSession.clearSaved(ui.session.gameId);
  ui.session = null;
  ui.snap = null;
  ui.modal = null;
  ui.joinCode = '';
  const u = new URL(location.href);
  u.searchParams.delete('join');
  history.replaceState(null, '', u);
  render();
}

async function share() {
  const code = ui.snap.lobby.code;
  const link = inviteLink(code);
  const text = `Come play Shanghai with me! Room code ${code}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Shanghai', text, url: link });
      return;
    }
  } catch {
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied!');
  } catch {
    prompt('Copy this link:', link);
  }
}

function onClick(e) {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  if (ui.swallowClick) {
    ui.swallowClick = false;
    return;
  }
  // clicks inside a modal shouldn't hit the backdrop's close handler
  if (t.dataset.act === 'closeModal' && t.classList.contains('overlay') && e.target.closest('[data-stop]')) return;
  const act = t.dataset.act;
  const v = ui.snap && ui.snap.view;
  const isWild = v ? wildTest(v.options) : null;

  switch (act) {
    case 'host':
      return startHost(false);
    case 'solo':
      return startHost(true);
    case 'resume': {
      const saved = HostSession.saved(t.dataset.id);
      if (!saved) return render();
      startSession(new HostSession({ name: ui.name, clientId, solo: saved.solo, restore: saved }));
      return;
    }
    case 'viewAllGames':
      ui.allGames = true;
      window.scrollTo(0, 0);
      return render();
    case 'homeBack':
      ui.allGames = false;
      return render();
    case 'rejoin':
      ui.joinCode = t.dataset.code;
      return startJoin();
    case 'forgetGame': {
      const saved = HostSession.saved(t.dataset.id);
      const what = saved && !saved.solo ? `the game in room ${saved.lobby.code}` : 'this game against the computer';
      if (saved && !confirm(`Delete ${what}? You won't be able to finish it.`)) return;
      HostSession.clearSaved(t.dataset.id);
      return render();
    }
    case 'forgetJoined':
      forgetJoined(t.dataset.code);
      if (ui.session) return leave();
      return render();
    case 'join':
      return startJoin();
    case 'leave':
      return leave();
    case 'share':
      return share();
    case 'rules':
      ui.modal = 'rules';
      return render();
    case 'modal':
      ui.modal = t.dataset.m;
      return render();
    case 'closeModal':
      ui.modal = null;
      ui.wildPrompt = null;
      return render();
    case 'toggleDock':
      ui.dockCollapsed = !ui.dockCollapsed;
      return render();
    case 'addToHome':
      return addToHome();
    case 'setSound':
      ui.sound = t.dataset.val === '1';
      store.set('sound', ui.sound);
      return render();
    case 'setCardBack':
      ui.cardBack = t.dataset.val;
      store.set('cardBack', ui.cardBack);
      applyCardBack();
      return render();
    case 'setSortDesc':
      ui.sortDesc = t.dataset.val === '1';
      store.set('sortDesc', ui.sortDesc);
      if (v && ui.sortMode && ui.sortMode !== 'manual') {
        const stagedIds = new Set(ui.staged.flatMap((g) => g.ids));
        ui.order = sortIds(v.hand, ui.sortMode).sort((a, b) => Number(stagedIds.has(a)) - Number(stagedIds.has(b)));
      }
      return render();
    case 'addBot':
    case 'start':
    case 'nextRound':
    case 'playAgain':
    case 'drawDeck':
    case 'drawDiscard':
    case 'allowBuy':
    case 'ready':
    case 'startNow':
    case 'undo':
      ui.modal = null;
      send({ type: act });
      return render();
    case 'endRound':
      if (confirm('End this round now? Nobody wins it and everyone scores the cards in their hand.')) {
        ui.modal = null;
        send({ type: 'endRound' });
      }
      return render();
    case 'removeSeat':
    case 'toggleBot':
      ui.modal = null;
      send({ type: act, seat: Number(t.dataset.seat) });
      return render();
    case 'buyAnswer':
      send({ type: 'buyAnswer', buy: t.dataset.buy === '1' });
      return render();
    case 'swapOrAdd': {
      const wp = ui.wildPrompt;
      ui.modal = null;
      ui.wildPrompt = null;
      if (wp) {
        const res =
          t.dataset.choice === 'swap'
            ? send({ type: 'swapWild', meldId: wp.meldId, id: wp.ids[0] })
            : send({ type: 'addToMeld', meldId: wp.meldId, ids: wp.ids });
        if (res.ok) ui.selected.clear();
      }
      return render();
    }
    case 'callShanghai':
      send({ type: 'shanghai' });
      return;
    case 'arm':
      ui.armed = !ui.armed;
      if (ui.armed) toast('Your next discard is declared dead: no penalty, but nobody can pick it up.');
      return render();
    case 'stage':
      stageGroup(t.dataset.type, selectedCards(v), isWild);
      return render();
    case 'addToStaged': {
      const added = selectedCards(v);
      if (!added.length) return toast('Select cards to add to this group, or tap ✕ to put it back.');
      addToStaged(v, Number(t.dataset.i), added, isWild);
      return render();
    }
    case 'unstage':
      ui.staged.splice(Number(t.dataset.i), 1);
      return render();
    case 'layDown':
      send({ type: 'layDown', groups: ui.staged.map((g) => ({ type: g.type, ids: g.ids })) });
      return render();
    case 'discard':
      discard([...ui.selected][0]);
      return render();
    case 'clearSel':
      ui.selected.clear();
      return render();
    case 'sort': {
      const stagedIds = new Set(ui.staged.flatMap((g) => g.ids));
      ui.sortMode = t.dataset.how;
      ui.order = sortIds(v.hand, t.dataset.how).sort((a, b) => Number(stagedIds.has(a)) - Number(stagedIds.has(b)));
      return render();
    }
    case 'playOn':
      playOn(v, v.melds.find((m) => m.id === Number(t.dataset.meld)), selectedCards(v), isWild);
      return render();
    case 'wildEnd': {
      const wp = ui.wildPrompt;
      ui.modal = null;
      ui.wildPrompt = null;
      if (wp) {
        const res = send({ type: 'addToMeld', meldId: wp.meldId, ids: wp.ids, wildEnd: t.dataset.end });
        if (res.ok) ui.selected.clear();
      }
      return render();
    }
  }
}

function onInput(e) {
  const f = e.target.dataset.field;
  if (f === 'name') ui.name = e.target.value;
  if (f === 'joinCode') ui.joinCode = e.target.value.toUpperCase();
}

function onChange(e) {
  const key = e.target.dataset.opt;
  if (key) send({ type: 'setOption', key, value: JSON.parse(e.target.value) });
}

function onKey(e) {
  if (e.key === 'Enter' && e.target.dataset.field === 'joinCode') startJoin();
  if (e.key === 'Escape' && ui.modal) {
    ui.modal = null;
    render();
  }
}

// scroll events don't bubble, so listen while they pass down to the sideways rows
$app.addEventListener('scroll', (e) => {
  if (e.target.classList && e.target.classList.contains('hscroll')) markEdgeFade(e.target);
}, true);
$app.addEventListener('click', onClick);
$app.addEventListener('input', onInput);
$app.addEventListener('change', onChange);
$app.addEventListener('keydown', onKey);
$app.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', (e) => {
  if (ui.drag && e.pointerId === ui.drag.pointerId) {
    endDrag(ui.drag);
    render();
  }
});
window.addEventListener('resize', () => {
  layoutHand();
  markTableOverflow();
  fitHomeGames();
  placeTapSpots();
});
// Keep the page at 100%: Safari ignores user-scalable=no, so block pinch gestures directly
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });
setInterval(() => {
  if (!ui.windowDeadline) return;
  document.querySelectorAll('[data-countdown]').forEach((el) => (el.textContent = secondsLeft()));
}, 250);

// Test hook: ?debug exposes UI state to automated browser tests
if (new URLSearchParams(location.search).has('debug')) window.__shanghai = ui;

// Opening an invite link with a saved name joins straight away
if (ui.joinCode && ui.name) startJoin();
else render();
