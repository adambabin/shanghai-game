import { HostSession, ClientSession } from './host.js';
import { joinRoom } from './net.js';
import { SUIT_SYMBOL, RANK_LABEL, cardLabel, isRed, wildTest } from './cards.js';
import { buildSet, buildRun, addCards, wildSlotFor, couldBeSet, couldBeRun, arrangeRun } from './melds.js';
import { ROUNDS, contractText, DEFAULT_OPTIONS, MAX_PLAYERS, SET_MIN, RUN_MIN } from './rules.js';

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
  drag: null,
  pendingRender: false,
};

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
function toast(text, bad = false, ms = 3000) {
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
  ui.session = session;
  ui.snap = null;
  ui.lastSeq = null;
  ui.handRound = null;
  ui.modal = null;
  session.subscribe(onSnapshot);
}

function onSnapshot(snap) {
  const prev = ui.snap;
  ui.snap = snap;
  if (snap.toastError && snap.errSeq !== ui.lastErrSeq) {
    ui.lastErrSeq = snap.errSeq;
    toast(snap.toastError, true);
  }
  const v = snap.view;
  if (v) {
    syncHand(v);
    processLog(v);
    ui.windowDeadline = v.buyWindow ? Date.now() + v.buyWindow.msLeft : null;
    const turnKey = `${v.round}:${v.turn}:${v.phase}`;
    if (turnKey !== ui.lastTurnKey) {
      if (v.turn !== (prev && prev.view && prev.view.turn)) ui.armed = false;
      // pick your cards back up when it's your turn or a new round is dealt
      if ((v.turn === v.you && v.phase === 'draw') || v.phase === 'ready') ui.dockCollapsed = false;
      if (v.turn === v.you && v.phase === 'draw' && ui.lastTurnKey) beep([660, 880]);
      ui.lastTurnKey = turnKey;
    }
  }
  render();
}

function processLog(v) {
  if (ui.lastSeq == null || ui.lastSeq > v.seq) {
    ui.lastSeq = v.seq;
    return;
  }
  for (const e of v.log) {
    if (e.seq <= ui.lastSeq) continue;
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
  const rankKey = (c) => (c.r === 0 ? 99 : c.r === 1 ? 14 : c.r);
  const cards = [...hand];
  if (how === 'rank') cards.sort((a, b) => rankKey(a) - rankKey(b) || suitOrder[a.s] - suitOrder[b.s]);
  else cards.sort((a, b) => suitOrder[a.s] - suitOrder[b.s] || rankKey(a) - rankKey(b));
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
  const snap = ui.snap;
  if (!ui.session || !snap) $app.innerHTML = homeHTML();
  else if (snap.status === 'kicked') $app.innerHTML = messageHTML('The host removed you from the game.');
  else if (!snap.lobby) $app.innerHTML = connectingHTML(snap);
  else if (!snap.lobby.started || !snap.view) $app.innerHTML = lobbyHTML(snap);
  else $app.innerHTML = gameHTML(snap);
  layoutHand();
}

function homeHTML() {
  const saved = HostSession.saved();
  return `<div class="center-screen"><div class="panel">
    <div class="title">Shanghai</div>
    <div class="title-suits">♠<span class="r">♥</span>♣<span class="r">♦</span></div>
    <div class="subtitle">Family rummy, house rules</div>
    <label class="field">Your name<input data-field="name" maxlength="20" placeholder="e.g. Grandma" value="${esc(ui.name)}" autocomplete="nickname"></label>
    ${ui.homeError ? `<div class="err">${esc(ui.homeError)}</div>` : ''}
    <button class="primary" data-act="host">Host a game for friends &amp; family</button>
    <button class="ghost" data-act="solo">Play against the computer</button>
    ${saved ? `<button class="ghost" data-act="resume">Resume your last game (round ${saved.game.round + 1} of ${ROUNDS.length})</button>` : ''}
    <div class="divider">— or join someone else's game —</div>
    <div class="row"><input data-field="joinCode" placeholder="ROOM CODE" maxlength="5" style="text-transform:uppercase;letter-spacing:3px" value="${esc(ui.joinCode)}"><button data-act="join" style="flex:none">Join</button></div>
    <button class="ghost small" data-act="rules">How to play</button>
  </div></div>${ui.modal === 'rules' ? rulesModal(DEFAULT_OPTIONS) : ''}`;
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
        : 'Connecting to the game…';
  return `<div class="center-screen"><div class="panel"><div class="title" style="font-size:30px">Joining…</div><p class="muted">${msg}</p><button class="ghost" data-act="leave">Cancel</button></div></div>`;
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
      ${optionRow('Buys per round', 'buyLimit', [[0, 'None'], [1, '1'], [2, '2'], [3, '3'], [4, '4']], o, isHost)}
      ${optionRow('Extra cards per buy', 'buyPenalty', [[0, 'None'], [1, '1'], [2, '2'], [3, '3']], o, isHost)}
      ${optionRow('2♣ wild', 'twoClubsWild', [[false, 'No (jokers only)'], [true, 'Yes']], o, isHost)}
      ${optionRow('Shanghai penalty', 'shanghaiPenalty', [[2, '2 cards'], [3, '3 cards'], [4, '4 cards']], o, isHost)}
      ${optionRow('Wrong Shanghai call', 'falseCallPenalty', [[1, '1 card'], [2, '2 cards'], [3, '3 cards']], o, isHost)}
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
      if (i === v.dealer) tags.push('<span class="tag">dealer</span>');
      if (v.phase === 'ready') tags.push(p.ready ? '<span class="tag gold">ready</span>' : '<span class="tag">looking…</span>');
      if (p.buying) tags.push('<span class="tag gold">buying</span>');
      const seat = ui.snap.lobby.seats[i];
      if (seat && !seat.connected) tags.push('<span class="tag red">offline</span>');
      const left = v.options.buyLimit - p.buysUsed;
      return `<div class="chip ${i === v.turn ? 'turn' : ''} ${i === v.you ? 'me' : ''}">
        <span class="pname">${esc(p.name)}</span>
        <span class="pstats"><span>${p.cards} card${p.cards === 1 ? '' : 's'}</span><span>${left} buy${left === 1 ? '' : 's'}</span></span>
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
  if (!v.melds.length) return `<div class="table-empty">No one has laid down yet.<br>This round: <b>${contractText(v.round)}</b></div>`;
  const sel = selectedCards(v);
  const playable = canPlayOn(v);
  const rows = [];
  v.players.forEach((p, i) => {
    const melds = v.melds.filter((m) => m.owner === i);
    if (!melds.length) return;
    const html = melds
      .map((m) => {
        // every pile lights up: picking the right one is part of the game
        const ok = playable;
        return `<div class="meld ${ok ? 'target' : ''}" ${ok ? `data-act="playOn" data-meld="${m.id}"` : ''} title="${m.type}">
          ${m.cards.map((c) => cardHTML(c, { sm: true, isWild })).join('')}</div>`;
      })
      .join('');
    rows.push(`<div class="owner-row"><span class="who">${esc(p.name)}${i === v.you ? ' (you)' : ''}</span><div class="melds">${html}</div></div>`);
  });
  return rows.join('');
}

function statusText(v) {
  const me = v.you;
  const turnName = esc(v.players[v.turn].name);
  if (me == null) return `You're watching. It's <b>${turnName}</b>'s turn.`;
  const myTurn = v.turn === me;
  const p = v.players[me];
  if (v.phase === 'ready') return `Sort and plan your hand. <b>${turnName}</b> goes first once everyone is ready.`;
  if (!myTurn) {
    return v.phase === 'draw' ? `Waiting for <b>${turnName}</b> to draw…` : `<b>${turnName}</b> is playing…`;
  }
  if (v.phase === 'draw') {
    if (v.buyWindow) return 'Waiting while others decide whether to buy…';
    if (v.topDead) return '<b>Your turn!</b> Draw from the deck (the discard is dead).';
    if (v.mustDecide) return '<b>Your turn!</b> Take the discard, or allow buying and then draw.';
    return '<b>Your turn!</b> Tap the deck or the discard pile to draw.';
  }
  if (v.mustPlay.some((id) => v.hand.some((c) => c.id === id)))
    return '<span class="warn">Play the wild card you swapped out before you discard.</span>';
  if (v.hand.length === 1) return `<span class="warn">You can't discard your last card. Play it on a pile, or Undo.</span>`;
  if (!p.laid) return `Lay down <b>${contractText(v.round)}</b>, or select a card and tap the discard pile.`;
  if (ui.selected.size) return 'Tap a pile to play the selected cards (or swap out a joker), or tap the discard pile.';
  return 'Select cards to play on any pile, then select a card and tap the discard pile.';
}

function centerHTML(v, isWild) {
  const me = v.you;
  const myTurn = me != null && v.turn === me;
  const p = me != null ? v.players[me] : null;
  const canDraw = myTurn && v.phase === 'draw' && !v.buyWindow;
  const top = v.discardTop;
  const discardClickable = canDraw && top && !v.topDead;
  const deckClickable = canDraw && !v.mustDecide;
  const deck = `<div class="pile ${deckClickable ? 'clickable' : ''}"><div class="stack" ${deckClickable ? 'data-act="drawDeck"' : ''}>${
    v.deckCount ? '<div class="card-back"></div>' : '<div class="empty-pile"></div>'
  }</div><span>Deck</span></div>`;
  // with one card selected on your turn, the discard pile is where you tap to discard it
  const canDiscard = myTurn && v.phase === 'play' && ui.selected.size === 1;
  const pileAct = discardClickable ? 'drawDiscard' : canDiscard ? 'discard' : null;
  const pileLabel = canDiscard ? (ui.armed ? 'Tap to discard (dead)' : 'Tap to discard') : v.topDead ? 'Dead card' : 'Discard';
  const discard = `<div class="pile ${pileAct ? 'clickable' : ''} ${canDiscard ? 'discard-target' : ''} ${canDiscard && ui.armed ? 'armed' : ''}"><div class="stack" ${
    pileAct ? `data-act="${pileAct}"` : ''
  }>${top ? cardHTML(top, { isWild }) : '<div class="empty-pile"></div>'}${
    v.topDead ? '<div class="dead-stamp"><span>DEAD</span></div>' : ''
  }</div><span>${pileLabel}</span></div>`;

  const actions = [];
  if (p) {
    if (myTurn && v.phase === 'play')
      actions.push(
        `<button class="shanghai-btn ${ui.armed ? 'armed' : ''}" data-act="arm">${ui.armed ? 'Shanghai said: next discard is dead' : 'SHANGHAI!'}</button>`
      );
    else actions.push('<button class="shanghai-btn" data-act="callShanghai">SHANGHAI!</button>');
  }
  return `<div class="center">${deck}${discard}<div class="center-actions">${actions.join('')}</div></div>${buyBarHTML(v)}`;
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
    return `<div class="buy-bar ask"><span>Buy the <b>${esc(cardLabel(top))}</b>? You also take ${v.options.buyPenalty} from the deck. (${left} buy${left === 1 ? '' : 's'} left)</span> ${timer}
      <span class="buy-actions"><button class="primary" data-act="buyAnswer" data-buy="1">Buy</button><button class="ghost" data-act="buyAnswer" data-buy="0">No thanks</button></span></div>`;
  }
  if (v.turn === me && v.mustDecide) {
    return `<div class="buy-bar ask"><span>Take the <b>${esc(cardLabel(top))}</b>, or let others buy it?</span>
      <span class="buy-actions"><button class="primary" data-act="allowBuy">Allow buy</button><button class="ghost" data-act="drawDiscard">No, take card</button></span></div>`;
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
  const groups = ui.staged
    .map((g, i) => {
      const cards = g.ids.map((id) => v.hand.find((c) => c.id === id)).filter(Boolean);
      const built = g.type === 'set' ? buildSet(cards, isWild) : buildRun(cards, isWild);
      if (!built) allComplete = false;
      const min = g.type === 'set' ? SET_MIN : RUN_MIN;
      // complete, still short of cards, or enough cards that don't work yet (e.g. too many jokers)
      const status = built ? '✓' : cards.length < min ? `${cards.length}/${min}` : '!';
      const shown = built ? built.cards : cards;
      return `<div class="staged ${built ? 'done' : ''}" data-act="addToStaged" data-i="${i}" title="Select cards and tap to add them">
        <div class="staged-head"><span class="kind">${g.type.toUpperCase()} ${status}</span>
        <button class="unstage" data-act="unstage" data-i="${i}" title="Put these cards back">✕</button></div>
        <div class="staged-cards">${shown.map((c) => cardHTML(c, { sm: true, isWild })).join('')}</div></div>`;
    })
    .join('');
  const ready = sets === cfg.sets && runs === cfg.runs && allComplete;
  const canLay = ready && v.turn === me && v.phase === 'play';
  return `<div class="staging"><span class="label">Your lay down: ${sets}/${cfg.sets} sets · ${runs}/${cfg.runs} runs</span>${groups}
    <button class="primary small" data-act="layDown" ${canLay ? '' : 'disabled'}>${ready ? 'Lay down!' : 'Lay down'}</button></div>`;
}

function handHTML(v, isWild) {
  const stagedIds = new Set(ui.staged.flatMap((g) => g.ids));
  const cards = ui.order.filter((id) => !stagedIds.has(id)).map((id) => v.hand.find((c) => c.id === id)).filter(Boolean);
  const me = v.you;
  const p = v.players[me];
  const n = ui.selected.size;
  const btns = [];
  if (!p.laid && v.phase !== 'roundOver' && n >= 2) {
    // offer whichever group the selected cards could grow into (a joker plus one card could be either)
    const sel = selectedCards(v);
    if (couldBeSet(sel, isWild)) btns.push('<button class="primary" data-act="stage" data-type="set">Make set</button>');
    if (couldBeRun(sel, isWild)) btns.push('<button class="primary" data-act="stage" data-type="run">Make run</button>');
  }
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
function dockHTML(v, isWild, warn) {
  const me = v.you;
  const body = `<div class="status ${warn ? 'warn' : ''}">${statusText(v)}</div>${me != null ? stagingHTML(v, isWild) + handHTML(v, isWild) : ''}`;
  if (me == null) return body;
  if (ui.dockCollapsed)
    return `<div class="dock collapsed"><button class="dock-toggle" data-act="toggleDock">Show my cards (${v.hand.length}) ▴</button></div>`;
  return `<div class="dock"><button class="dock-toggle icon" data-act="toggleDock" title="Hide my cards" aria-label="Hide my cards">▾</button><div class="dock-body">${body}</div></div>`;
}

function gameHTML(snap) {
  const v = snap.view;
  const isWild = wildTest(v.options);
  const banner =
    !snap.isHost && snap.status !== 'connected'
      ? `<div class="conn-banner">Lost connection to the host. Reconnecting…</div>`
      : snap.status === 'error'
        ? `<div class="conn-banner">${esc(snap.error)}</div>`
        : '';
  const me = v.you;
  const warn = me != null && v.turn === me && v.phase === 'play' && v.hand.length === 1;
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
    <div class="players">${playerChips(v)}</div>
    <div class="table">${tableHTML(v, isWild)}</div>
    ${centerHTML(v, isWild)}
    ${dockHTML(v, isWild, warn)}
    ${modalHTML(snap)}
  </div>`;
}

// ---------- modals ----------
function modalHTML(snap) {
  const v = snap.view;
  if (v.phase === 'roundOver' || v.phase === 'gameOver') {
    if (ui.modal !== 'scores' && ui.modal !== 'menu' && ui.modal !== 'rules' && ui.modal !== 'log') return resultModal(snap);
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

function wrapModal(title, body, actions = '') {
  return `<div class="overlay" data-act="closeModal"><div class="modal" data-stop>
    <h2>${title}</h2>${body}
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
    `<button class="ghost" data-act="toggleSound">Sound: ${ui.sound ? 'on' : 'off'}</button>`,
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
  items.push(`<button class="danger" data-act="leave">${snap.isHost && !snap.solo ? 'End game for everyone' : 'Leave game'}</button>`);
  return wrapModal('Menu', `<div class="menu-list">${items.join('')}</div>`);
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
    <li>3 decks with 6 jokers. When the deck runs out, the discard pile is shuffled into a new deck.</li></ul>
    <h3>Your turn</h3>
    <ul><li>Draw from the deck or take the top discard.</li><li>Lay down your contract (exactly the sets and runs listed). Once you're down you can add cards to anyone's piles, on this turn or later.</li>
    <li>End your turn by discarding one card.</li></ul>
    <h3>Buying</h3>
    <ul><li>At the start of your turn you choose: <b>No, take card</b> (you take the discard) or <b>Allow buy</b>. You can only draw from the deck after allowing others to buy.</li>
    <li>If you allow it, the offer goes around the table in order, starting with the player after you. Each player gets 10 seconds to say Buy or No thanks; the first to buy gets the card plus ${o.buyPenalty} from the deck.</li>
    <li>When a card is bought, the card underneath is live again (even if it had been Shanghai'd), and you choose again: take it, or allow buying.</li>
    <li>If nobody buys it, you can still take it, or draw from the deck.</li>
    <li>${o.buyLimit} buys per round. Once you've laid down you can't buy.</li></ul>
    <h3>Shanghai!</h3>
    <ul><li>If anyone discards a card that could have gone on a pile, anyone else can hit <b>SHANGHAI!</b> before the next player draws. The discarder picks up ${o.shanghaiPenalty} cards and that card is dead.</li>
    <li>A card counts as playable if it fits on the end of a pile or could swap out a joker in a run (e.g. a 9 when there's 7, 8, joker, 10).</li>
    <li>Calling Shanghai when there isn't one costs you ${o.falseCallPenalty} cards.</li>
    <li>Want to get rid of a playable card on purpose? Before discarding, tap SHANGHAI! yourself. Your discard is declared dead: no penalty, but nobody can pick it up or buy it until another card covers it. (If the card couldn't actually go anywhere, it isn't a Shanghai: you'll get a heads-up and the card stays live.)</li></ul>
    <h3>Swapping wild cards</h3>
    <ul><li>Once you've laid down, if a run on the table has a joker standing in for a card you hold, select that card and tap the run to swap it in. You take the joker.</li>
    <li>You have to play the joker you took before you can discard. Only runs, never sets.</li></ul>
    <h3>Going out</h3>
    <ul><li>You can't go out on a discard. Your last cards (at least 2 on that final turn) have to be played onto piles.</li>
    <li>Made a mistake? Undo takes back plays you made this turn, until you discard.</li></ul>
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
  const avail = Math.min(window.innerWidth - 20, 1200);
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
  cards.forEach((el, i) => {
    const row = Math.floor(i / L.perRow);
    el.style.left = `${(i % L.perRow) * step}px`;
    el.style.top = `${18 + row * rowGap}px`;
    el.style.zIndex = i + 1;
  });
  Object.assign(hand.dataset, { step, perRow: L.perRow, rowGap, rows: L.rows });
}

function onPointerDown(e) {
  const el = e.target.closest('.hand .card');
  if (!el) return;
  const hand = el.parentElement;
  ui.drag = {
    el,
    id: Number(el.dataset.card),
    x0: e.clientX,
    y0: e.clientY,
    left0: parseFloat(el.style.left),
    top0: parseFloat(el.style.top),
    step: parseFloat(hand.dataset.step) || 1,
    perRow: Number(hand.dataset.perRow) || 1,
    rowGap: parseFloat(hand.dataset.rowGap) || 1,
    rows: Number(hand.dataset.rows) || 1,
    moved: false,
    pointerId: e.pointerId,
  };
  el.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  const d = ui.drag;
  if (!d || e.pointerId !== d.pointerId) return;
  const dx = e.clientX - d.x0;
  const dy = e.clientY - d.y0;
  if (!d.moved && Math.hypot(dx, dy) < 8) return;
  d.moved = true;
  d.el.classList.add('dragging');
  // with one row the card only lifts; with several it can move between rows
  d.el.style.transform = `translate(${dx}px, ${d.rows > 1 ? dy : Math.min(0, dy)}px)`;
}

function onPointerUp(e) {
  const d = ui.drag;
  if (!d || e.pointerId !== d.pointerId) return;
  ui.drag = null;
  if (d.moved) {
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    const col = Math.max(0, Math.min(d.perRow - 1, Math.round((d.left0 + dx) / d.step)));
    const row = Math.max(0, Math.min(d.rows - 1, Math.round((d.top0 - 18 + dy) / d.rowGap)));
    const stagedIds = new Set(ui.staged.flatMap((g) => g.ids));
    const visible = ui.order.filter((id) => !stagedIds.has(id));
    const from = visible.indexOf(d.id);
    const to = Math.max(0, Math.min(visible.length - 1, row * d.perRow + col));
    visible.splice(from, 1);
    visible.splice(to, 0, d.id);
    ui.order = [...visible, ...ui.order.filter((id) => stagedIds.has(id))];
    ui.sortMode = 'manual';
  } else {
    if (ui.selected.has(d.id)) ui.selected.delete(d.id);
    else ui.selected.add(d.id);
    ui.fresh.clear();
  }
  render();
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
    if (!confirm('Leaving ends the game for everyone. Leave anyway?')) return;
  }
  if (ui.session) ui.session.close();
  if (snap && snap.isHost && snap.view && snap.view.phase === 'gameOver') HostSession.clearSaved();
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
      const saved = HostSession.saved();
      if (!saved) return render();
      startSession(new HostSession({ name: ui.name, clientId, solo: saved.solo, restore: saved }));
      return;
    }
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
    case 'toggleSound':
      ui.sound = !ui.sound;
      store.set('sound', ui.sound);
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
    case 'stage': {
      const cards = selectedCards(v);
      const type = t.dataset.type;
      const ok = type === 'set' ? couldBeSet(cards, isWild) : couldBeRun(cards, isWild);
      if (!ok) return toast(type === 'set' ? "Those cards can't make a set." : "Those cards can't make a run.", true);
      ui.staged.push({ type, ids: cards.map((c) => c.id) });
      ui.selected.clear();
      return render();
    }
    case 'addToStaged': {
      const g = ui.staged[Number(t.dataset.i)];
      const added = selectedCards(v);
      if (!g) return;
      if (!added.length) return toast('Select cards to add to this group, or tap ✕ to put it back.');
      const existing = g.ids.map((id) => v.hand.find((c) => c.id === id)).filter(Boolean);
      const all = g.type === 'set' ? [...existing, ...added] : arrangeRun(existing, added, isWild);
      if (!(g.type === 'set' ? couldBeSet(all, isWild) : couldBeRun(all, isWild)))
        return toast(`${added.map(cardLabel).join(' ')} can't go in that ${g.type}.`, true);
      g.ids = all.map((c) => c.id);
      ui.selected.clear();
      return render();
    }
    case 'unstage':
      ui.staged.splice(Number(t.dataset.i), 1);
      return render();
    case 'layDown':
      send({ type: 'layDown', groups: ui.staged.map((g) => ({ type: g.type, ids: g.ids })) });
      return render();
    case 'discard': {
      const [id] = [...ui.selected];
      const res = send({ type: 'discard', id, declare: ui.armed });
      if (res.ok) {
        ui.selected.clear();
        ui.armed = false;
      }
      return render();
    }
    case 'clearSel':
      ui.selected.clear();
      return render();
    case 'sort': {
      const stagedIds = new Set(ui.staged.flatMap((g) => g.ids));
      ui.sortMode = t.dataset.how;
      ui.order = sortIds(v.hand, t.dataset.how).sort((a, b) => Number(stagedIds.has(a)) - Number(stagedIds.has(b)));
      return render();
    }
    case 'playOn': {
      const meld = v.melds.find((m) => m.id === Number(t.dataset.meld));
      const cards = selectedCards(v);
      const canSwap = cards.length === 1 && wildSlotFor(meld, cards[0], isWild) >= 0;
      if (!canSwap && !addCards(meld, cards, isWild)) {
        toast(`${cards.map(cardLabel).join(' ')} can't go on that ${meld.type}.`, true);
        return;
      }
      if (canSwap) {
        if (addCards(meld, cards, isWild)) {
          ui.wildPrompt = { meldId: meld.id, ids: [cards[0].id] };
          ui.modal = 'swap';
          return render();
        }
        const res = send({ type: 'swapWild', meldId: meld.id, id: cards[0].id });
        if (res.ok) ui.selected.clear();
        return render();
      }
      const wild = cards.some(isWild);
      if (wild && meld.type === 'run') {
        const lowOk = addCards(meld, cards, isWild, 'low');
        const highOk = addCards(meld, cards, isWild, 'high');
        const differ = lowOk && highOk && lowOk.lo !== highOk.lo;
        if (differ) {
          ui.wildPrompt = { meldId: meld.id, ids: cards.map((c) => c.id) };
          ui.modal = 'wild';
          return render();
        }
      }
      const res = send({ type: 'addToMeld', meldId: meld.id, ids: cards.map((c) => c.id) });
      if (res.ok) ui.selected.clear();
      return render();
    }
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

$app.addEventListener('click', onClick);
$app.addEventListener('input', onInput);
$app.addEventListener('change', onChange);
$app.addEventListener('keydown', onKey);
$app.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', (e) => {
  if (ui.drag && e.pointerId === ui.drag.pointerId) {
    ui.drag = null;
    render();
  }
});
window.addEventListener('resize', layoutHand);
setInterval(() => {
  if (!ui.windowDeadline) return;
  document.querySelectorAll('[data-countdown]').forEach((el) => (el.textContent = secondsLeft()));
}, 250);

// Test hook: ?debug exposes UI state to automated browser tests
if (new URLSearchParams(location.search).has('debug')) window.__shanghai = ui;

// Opening an invite link with a saved name joins straight away
if (ui.joinCode && ui.name) startJoin();
else render();
