// Game engine. Runs only on the host; everyone else gets a filtered view of the state.
// Players are referred to by seat number (0..n-1).

import { makeDecks, shuffle, wildTest, cardPoints, cardLabel } from './cards.js';
import { buildSet, buildRun, addCards, fitsAnyMeld, wildSlotFor } from './melds.js';
import { ROUNDS, roundCfg, isLastRound, DEFAULT_OPTIONS, decksFor, contractText } from './rules.js';

// How long players get to decide whether to buy once the current player allows it.
export const BUY_WINDOW_MS = 10000; // one countdown shared by everyone being asked

export function createGame(players, options = {}, rng = Math.random) {
  const state = {
    options: { ...DEFAULT_OPTIONS, ...options },
    players: players.map((p) => ({ name: p.name, bot: !!p.bot })),
    scores: players.map(() => []),
    stats: players.map(() => newStats()),
    round: -1,
    dealer: Math.floor(rng() * players.length),
    phase: 'draw',
    log: [],
    seq: 0,
    nextMeldId: 1,
  };
  Object.defineProperty(state, 'rng', { value: rng, enumerable: false, writable: true });
  startRound(state);
  return state;
}

// Counted all game for "How everyone played" at the end (only shown then). Games saved before these were kept have
// none, and show nothing.
function newStats() {
  return { caught: 0, caughtBy: 0, shanghaiCards: 0, ownShanghais: 0, falseCalls: 0, buys: 0, buyExtra: 0, jokerSwaps: 0, wentOut: 0 };
}
function bump(state, seat, key, n = 1) {
  if (state.stats && state.stats[seat]) state.stats[seat][key] += n;
}

function log(state, text, kind = 'info', extra = {}) {
  state.seq++;
  state.log.push({ seq: state.seq, text, kind, ...extra });
  if (state.log.length > 80) state.log.shift();
}

export function isWildFn(state) {
  return wildTest(state.options);
}

function rngOf(state) {
  return state.rng || Math.random;
}

// Is this seat out of the current deal? Only during a tiebreaker, for everyone who isn't tied.
export function sittingOut(state, seat) {
  return !!(state.tiebreak && state.tiebreak.playing && !state.tiebreak.seats.includes(seat));
}

// The next seat round the table that's playing this deal
function nextSeat(state, seat) {
  const n = state.players.length;
  for (let i = 1; i <= n; i++) {
    const s = (seat + i) % n;
    if (!sittingOut(state, s)) return s;
  }
  return seat;
}

// A tiebreaker deals the last round's contract again (state.round stays put) to the tied players only
export function startRound(state, { tiebreaker = false } = {}) {
  if (!tiebreaker) state.round++;
  if (state.round > 0 || tiebreaker) state.dealer = nextSeat(state, state.dealer);
  const cfg = roundCfg(state.round);
  state.deck = shuffle(makeDecks(decksFor(state.options)), rngOf(state));
  state.hands = state.players.map((_, i) => (sittingOut(state, i) ? [] : state.deck.splice(0, cfg.deal)));
  state.discard = [state.deck.pop()];
  state.topDead = false;
  state.melds = [];
  state.laid = state.players.map(() => false);
  state.buysUsed = state.players.map(() => 0);
  state.blocked = state.players.map(() => false);
  state.lastDiscard = null;
  state.turn = nextSeat(state, state.dealer);
  resetDraw(state);
  state.turnPlays = 0;
  state.history = [];
  state.mustPlay = [];
  // everyone gets to look over their cards first; computers are always ready
  state.phase = 'ready';
  state.ready = state.players.map((p, i) => p.bot || sittingOut(state, i));
  state.roundResult = null;
  if (tiebreaker)
    log(state, `Tiebreaker: ${contractText(state.round)}, just ${listNames(state, state.tiebreak.seats)}. ${state.players[state.dealer].name} deals.`, 'round');
  else log(state, `Round ${state.round + 1}: ${contractText(state.round)}. ${state.players[state.dealer].name} deals.`, 'round');
}

function listNames(state, seats) {
  const names = seats.map((i) => state.players[i].name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
}

function reshuffle(state) {
  if (state.discard.length <= 1) return false;
  const top = state.discard.pop();
  state.deck = shuffle(state.discard, rngOf(state));
  state.discard = [top];
  log(state, 'The deck ran out, so the discard pile was shuffled into a new deck.');
  return true;
}

function drawCards(state, seat, count) {
  const got = [];
  for (let i = 0; i < count; i++) {
    if (!state.deck.length && !reshuffle(state)) break;
    got.push(state.deck.pop());
  }
  state.hands[seat].push(...got);
  return got;
}

function err(error) {
  return { ok: false, error };
}

function takeFromHand(state, seat, ids) {
  const hand = state.hands[seat];
  if (new Set(ids).size !== ids.length) return null;
  const cards = ids.map((id) => hand.find((c) => c.id === id));
  if (cards.some((c) => !c)) return null;
  return cards;
}

function removeFromHand(state, seat, ids) {
  state.hands[seat] = state.hands[seat].filter((c) => !ids.includes(c.id));
}

function closeShanghaiWindow(state) {
  if (state.lastDiscard) state.lastDiscard.open = false;
}

function resetDraw(state) {
  state.buyWindow = null;
  state.earlyBuy = null;
  state.buyOffered = false; // the current player already let others buy this turn
}

function topCard(state) {
  return state.discard[state.discard.length - 1] || null;
}

// The current player has to either take the live discard or let others buy it before drawing from the deck.
export function mustDecideOnDiscard(state) {
  return state.phase === 'draw' && !state.buyOffered && !state.buyWindow && buyEligible(state).length > 0;
}

// Who could buy the top discard right now.
export function buyEligible(state) {
  const top = topCard(state);
  if (state.phase !== 'draw' || !top || state.topDead) return [];
  const ld = state.lastDiscard;
  return state.players
    .map((_, i) => i)
    .filter(
      (i) =>
        i !== state.turn &&
        !sittingOut(state, i) &&
        !state.laid[i] &&
        state.buysUsed[i] < state.options.buyLimit &&
        !(ld && ld.by === i && ld.card.id === top.id)
    );
}

function turnOrder(state, seat) {
  const n = state.players.length;
  return (seat - state.turn + n) % n;
}

// While the current player is still deciding, the others can already say Buy or No: kept for that card only, and
// counted the moment the current player allows buying (thrown away if they take it).
function earlyAnswers(state) {
  const e = state.earlyBuy;
  const top = topCard(state);
  return e && top && e.cardId === top.id ? e.answers : {};
}

// Everyone who can buy is asked at once and shares one countdown of BUY_WINDOW_MS. The card goes to whoever said Buy
// and sits earliest in turn order (starting after the current player), as soon as everyone ahead of them has said No:
// so it's settled the moment the first in line says Buy, or when the countdown ends (no answer counts as No).
export function buyAsking(state) {
  // the first in line who hasn't answered yet (the one the outcome is waiting on)
  const w = state.buyWindow;
  return w ? (w.order.find((s) => w.answers[s] === undefined) ?? null) : null;
}

function settleBuy(state, final) {
  const w = state.buyWindow;
  for (const s of w.order) {
    if (w.answers[s] === true) return completeBuy(state, s);
    if (w.answers[s] === undefined && !final) return; // still waiting on someone ahead
  }
  // everyone said No (or didn't answer): nothing to log, the current player just carries on
  state.buyWindow = null;
}

// The countdown ran out: anyone who hasn't answered counts as No.
export function buyTimeout(state) {
  if (!state.buyWindow) return err('Nobody is buying right now.');
  settleBuy(state, true);
  return { ok: true };
}

function completeBuy(state, buyer) {
  state.buyWindow = null;
  const card = state.discard.pop();
  state.hands[buyer].push(card);
  state.buysUsed[buyer]++;
  const extra = drawCards(state, buyer, state.options.buyPenalty);
  // the card underneath is live again (even if it had been Shanghai'd), and the current player decides afresh
  state.topDead = false;
  state.buyOffered = false;
  closeShanghaiWindow(state);
  bump(state, buyer, 'buys');
  bump(state, buyer, 'buyExtra', extra.length);
  log(state, `${state.players[buyer].name} bought the ${cardLabel(card)} (+${extra.length} from the deck).`, 'buy', {
    seat: buyer,
    card, // the card everyone saw on the pile, so other players can watch it go to the buyer
    extra: extra.length,
  });
}

function finishRound(state, winner) {
  const isWild = isWildFn(state);
  const points = state.hands.map((h) => h.reduce((sum, c) => sum + cardPoints(c, isWild), 0));
  // a tiebreaker's points go in its own row (state.tiebreak.points), not the rounds' totals
  if (!(state.tiebreak && state.tiebreak.playing)) points.forEach((p, i) => state.scores[i].push(p));
  state.roundResult = { winner, points };
  state.buyWindow = null;
  closeShanghaiWindow(state);
  const what = state.tiebreak && state.tiebreak.playing ? 'the tiebreaker' : `round ${state.round + 1}`;
  if (winner != null) bump(state, winner, 'wentOut');
  if (winner != null) log(state, `${state.players[winner].name} went out and won ${what}!`, 'win', { seat: winner });
  else log(state, `${what[0].toUpperCase() + what.slice(1)} ended with nobody going out.`, 'win');
  if (!isLastRound(state.round)) {
    state.phase = 'roundOver';
    return;
  }
  // the tiebreaker: lowest score in it wins; tied again is a shared win
  if (state.tiebreak && state.tiebreak.playing) {
    const tb = state.tiebreak;
    tb.points = state.players.map((_, i) => (tb.seats.includes(i) ? points[i] : null));
    tb.playing = false;
    const best = Math.min(...tb.seats.map((i) => points[i]));
    return endGame(state, tb.seats.filter((i) => points[i] === best));
  }
  settleGame(state);
}

// After the last round: lowest total wins; a tie for it goes to a vote among the tied people (all computers: shared)
function settleGame(state) {
  const t = totals(state);
  const best = Math.min(...t);
  const tied = t.map((_, i) => i).filter((i) => t[i] === best);
  if (tied.length > 1 && tied.some((i) => !state.players[i].bot)) {
    state.tiebreak = { seats: tied, votes: {}, playing: false, points: null };
    state.phase = 'tieVote';
    log(state, `It's a tie! ${listNames(state, tied)} both have ${best}. Share the win, or play a tiebreaker?`, 'tie');
    return;
  }
  endGame(state, tied);
}

function endGame(state, winners) {
  state.winners = winners;
  state.phase = 'gameOver';
  log(state, winners.length > 1 ? `${listNames(state, winners)} share the win!` : `${state.players[winners[0]].name} wins the game!`, 'gameover');
}

// After a tie for the win, each tied person votes: everyone picking the tiebreaker plays the last round again (just them);
// anyone picking "share" makes it a shared win. Computers don't vote.
function tieVote(state, seat, choice) {
  const tb = state.tiebreak;
  if (state.phase !== 'tieVote' || !tb) return err('There is no tie to settle.');
  if (!tb.seats.includes(seat) || state.players[seat].bot) return err('Only the tied players choose.');
  if (choice !== 'share' && choice !== 'tiebreak') return err('Unknown choice.');
  tb.votes[seat] = choice;
  const name = state.players[seat].name;
  if (choice === 'share') {
    log(state, `${name} chose to share the win.`, 'tievote', { seat });
    endGame(state, tb.seats);
    return { ok: true };
  }
  log(state, `${name} wants a tiebreaker.`, 'tievote', { seat });
  const voters = tb.seats.filter((i) => !state.players[i].bot);
  if (voters.every((i) => tb.votes[i] === 'tiebreak')) {
    tb.playing = true;
    startRound(state, { tiebreaker: true });
  }
  return { ok: true };
}

export function totals(state) {
  return state.scores.map((s) => s.reduce((a, b) => a + b, 0));
}

function afterPlay(state, seat) {
  if (state.hands[seat].length === 0) finishRound(state, seat);
}

// Why a Shanghai call missed, in words for the person who called it
function notShanghaiReason(state, seat) {
  const ld = state.lastDiscard;
  const top = state.discard[state.discard.length - 1];
  if (!top) return 'There is no card on the discard pile.';
  if (!ld || ld.card.id !== top.id) return `The ${cardLabel(top)} was uncovered by a buy, not just discarded.`;
  const by = state.players[ld.by].name;
  if (ld.by === seat) return "You can't call Shanghai on your own discard.";
  if (ld.declared) return `${by} already declared the ${cardLabel(top)} dead.`;
  if (ld.called) return 'Someone already called it.';
  if (!ld.open) return `Too late: the ${cardLabel(top)} has been picked up or the next player has drawn.`;
  return `The ${cardLabel(top)} doesn't fit on any pile.`;
}

function topIsShanghai(state) {
  const ld = state.lastDiscard;
  return !!(ld && ld.open && ld.eligible && !ld.called && state.discard.length && state.discard[state.discard.length - 1].id === ld.card.id);
}

// Applies an action from a seat. Returns { ok: true } or { ok: false, error }.
export function applyAction(state, seat, action) {
  const n = state.players.length;
  if (seat == null || seat < 0 || seat >= n) return err('Unknown player.');
  const isWild = isWildFn(state);
  const name = state.players[seat].name;
  const myTurn = state.turn === seat;
  const inRound = state.phase === 'draw' || state.phase === 'play';
  if (action.type === 'tieVote') return tieVote(state, seat, action.choice);
  if (sittingOut(state, seat)) return err("You're sitting out the tiebreaker.");

  switch (action.type) {
    case 'drawDeck': {
      if (!myTurn || state.phase !== 'draw') return err("It's not your turn to draw.");
      if (state.buyWindow) return err('Hang on, other players are deciding whether to buy.');
      if (mustDecideOnDiscard(state)) return err('Take the discard, or allow others to buy it before you draw from the deck.');
      closeShanghaiWindow(state);
      const got = drawCards(state, seat, 1);
      if (!got.length) {
        finishRound(state, null);
        return { ok: true };
      }
      state.phase = 'play';
      state.history = [];
      state.mustPlay = [];
      resetDraw(state);
      log(state, `${name} drew from the deck.`, 'draw', { seat });
      return { ok: true };
    }

    case 'drawDiscard': {
      if (!myTurn || state.phase !== 'draw') return err("It's not your turn to draw.");
      if (!state.discard.length) return err('The discard pile is empty.');
      if (state.topDead) return err("That card is dead (Shanghai'd). It can't be picked up until another card covers it.");
      if (state.buyWindow) return err('Hang on, other players are deciding whether to buy.');
      closeShanghaiWindow(state);
      const card = state.discard.pop();
      state.hands[seat].push(card);
      state.phase = 'play';
      // undoing everything back past this puts the card back so they can choose again
      state.history = [{ kind: 'take', card, buyOffered: state.buyOffered }];
      state.mustPlay = [];
      resetDraw(state);
      log(state, `${name} picked up the ${cardLabel(card)}.`, 'draw', { seat });
      return { ok: true };
    }

    case 'allowBuy': {
      if (!myTurn || state.phase !== 'draw') return err("It's not your turn.");
      if (state.buyOffered || state.buyWindow) return { ok: true };
      const top = topCard(state);
      if (!top || state.topDead) return err('There is nothing to buy.');
      state.buyOffered = true;
      const eligible = buyEligible(state);
      if (!eligible.length) {
        log(state, `Nobody can buy the ${cardLabel(top)}.`, 'nobuy');
        return { ok: true };
      }
      const order = eligible.sort((a, b) => turnOrder(state, a) - turnOrder(state, b));
      const early = earlyAnswers(state);
      const answers = Object.fromEntries(order.filter((s) => early[s] !== undefined).map((s) => [s, early[s]]));
      state.earlyBuy = null;
      state.buyWindow = { cardId: top.id, order, answers, deadline: Date.now() + BUY_WINDOW_MS };
      log(state, `${name} is letting others buy the ${cardLabel(top)}.`, 'buywindow', { seat });
      settleBuy(state, false); // settled at once if the early answers already decide it
      return { ok: true };
    }

    case 'buyAnswer': {
      const w = state.buyWindow;
      if (!w && mustDecideOnDiscard(state) && buyEligible(state).includes(seat)) {
        // answering early, before the current player has chosen; null takes the answer back
        const top = topCard(state);
        if (!state.earlyBuy || state.earlyBuy.cardId !== top.id) state.earlyBuy = { cardId: top.id, answers: {} };
        if (action.buy == null) delete state.earlyBuy.answers[seat];
        else state.earlyBuy.answers[seat] = !!action.buy;
        return { ok: true };
      }
      if (!w || !w.order.includes(seat)) return err("You can't buy this card.");
      if (w.answers[seat] !== undefined) return err('You already answered.');
      w.answers[seat] = !!action.buy;
      settleBuy(state, false);
      return { ok: true };
    }

    case 'layDown': {
      if (!myTurn || !inRound) return err("You can only lay down on your turn.");
      if (state.phase === 'draw') return err('Draw a card first, then lay down.');
      if (state.laid[seat]) return err("You've already laid down this round.");
      const cfg = roundCfg(state.round);
      const groups = action.groups || [];
      const sets = groups.filter((g) => g.type === 'set').length;
      const runs = groups.filter((g) => g.type === 'run').length;
      if (sets !== cfg.sets || runs !== cfg.runs || groups.length !== cfg.sets + cfg.runs)
        return err(`This round you need exactly ${contractText(state.round)}.`);
      const allIds = groups.flatMap((g) => g.ids);
      const cards = takeFromHand(state, seat, allIds);
      if (!cards) return err("Those cards aren't all in your hand.");
      const built = [];
      for (const g of groups) {
        const gc = g.ids.map((id) => cards.find((c) => c.id === id));
        const m = g.type === 'set' ? buildSet(gc, isWild) : buildRun(gc, isWild, g.wildEnd);
        if (!m) return err(`That isn't a valid ${g.type}: ${gc.map(cardLabel).join(' ')}`);
        built.push(m);
      }
      removeFromHand(state, seat, allIds);
      const ids = [];
      for (const m of built) {
        const id = state.nextMeldId++;
        ids.push(id);
        state.melds.push({ ...m, id, owner: seat });
      }
      state.laid[seat] = true;
      state.history.push({ kind: 'layDown', meldIds: ids, cards });
      state.turnPlays += allIds.length;
      log(state, `${name} laid down ${contractText(state.round)}!`, 'laydown', { seat });
      afterPlay(state, seat);
      return { ok: true };
    }

    case 'addToMeld': {
      if (!myTurn || state.phase !== 'play') return err('You can only play cards on your turn, after drawing.');
      if (!state.laid[seat]) return err('You have to lay down your own contract before playing on piles.');
      const meld = state.melds.find((m) => m.id === action.meldId);
      if (!meld) return err('That pile is gone.');
      const cards = takeFromHand(state, seat, action.ids || []);
      if (!cards || !cards.length) return err("Those cards aren't in your hand.");
      const next = addCards(meld, cards, isWild, action.wildEnd);
      if (!next) return err(`${cards.map(cardLabel).join(' ')} can't go on that ${meld.type}.`);
      removeFromHand(state, seat, action.ids);
      state.history.push({ kind: 'add', meld: { ...meld }, cards });
      Object.assign(meld, next);
      state.turnPlays += cards.length;
      log(state, `${name} played ${cards.map(cardLabel).join(' ')} on ${state.players[meld.owner].name}'s ${meld.type}.`, 'play', { seat });
      afterPlay(state, seat);
      return { ok: true };
    }

    case 'ready': {
      if (state.phase !== 'ready') return { ok: true };
      state.ready[seat] = true;
      if (state.ready.every(Boolean)) beginPlay(state);
      return { ok: true };
    }

    case 'swapWild': {
      if (!myTurn || state.phase !== 'play') return err('You can only swap on your turn, after drawing.');
      if (!state.laid[seat]) return err('You have to lay down before you can swap out a wild card.');
      const meld = state.melds.find((m) => m.id === action.meldId);
      if (!meld || meld.type !== 'run') return err('You can only swap wild cards out of runs.');
      const [card] = takeFromHand(state, seat, [action.id]) || [];
      if (!card) return err("That card isn't in your hand.");
      const idx = wildSlotFor(meld, card, isWild);
      if (idx < 0) return err(`The ${cardLabel(card)} doesn't replace a wild card in that run.`);
      const wild = meld.cards[idx];
      state.history.push({ kind: 'swap', meld: { ...meld }, cards: [card], wild });
      meld.cards = meld.cards.map((c, i) => (i === idx ? card : c));
      removeFromHand(state, seat, [card.id]);
      state.hands[seat].push(wild);
      state.mustPlay.push(wild.id);
      bump(state, seat, 'jokerSwaps');
      log(state, `${name} swapped the ${cardLabel(card)} into ${state.players[meld.owner].name}'s run and took the ${cardLabel(wild)}.`, 'swap', { seat });
      return { ok: true };
    }

    case 'discard': {
      if (!myTurn || state.phase !== 'play') return err("You can't discard right now.");
      const [card] = takeFromHand(state, seat, [action.id]) || [];
      if (!card) return err("That card isn't in your hand.");
      if (state.mustPlay.some((id) => state.hands[seat].some((c) => c.id === id)))
        return err('Play the wild card you swapped out before you discard.');
      if (state.hands[seat].length <= 1)
        return err("You can't go out on a discard. Play your last card onto a pile, or Undo your plays this turn.");
      removeFromHand(state, seat, [card.id]);
      state.discard.push(card);
      const playable = fitsAnyMeld(card, state.melds, isWild);
      // declaring only kills the card if it really was a Shanghai
      const declared = !!action.declare && playable;
      state.topDead = declared;
      state.lastDiscard = { by: seat, card, declared, eligible: !declared && playable, open: !declared, called: false };
      if (declared) bump(state, seat, 'ownShanghais');
      if (declared) log(state, `${name} said "Shanghai!" and discarded the ${cardLabel(card)}. It's dead until covered.`, 'dead', { seat });
      else if (action.declare)
        log(state, `${name} discarded the ${cardLabel(card)}.`, 'notshanghai', {
          seat,
          note: `That wasn't a Shanghai: the ${cardLabel(card)} doesn't fit on any pile, so it stays live.`,
        });
      else log(state, `${name} discarded the ${cardLabel(card)}.`, 'discard', { seat });
      state.turn = nextSeat(state, state.turn);
      state.turnPlays = 0;
      state.blocked[state.turn] = false;
      resetDraw(state);
      state.phase = 'draw';
      return { ok: true };
    }

    case 'undo': {
      if (!myTurn || state.phase !== 'play') return err('Nothing to undo.');
      const h = state.history.pop();
      if (!h) return err('Nothing to undo this turn.');
      if (h.kind === 'take') {
        removeFromHand(state, seat, [h.card.id]);
        state.discard.push(h.card);
        state.phase = 'draw';
        state.buyOffered = h.buyOffered;
        log(state, `${name} put the ${cardLabel(h.card)} back.`, 'undo', { seat });
        return { ok: true };
      }
      if (h.kind === 'layDown') {
        state.melds = state.melds.filter((m) => !h.meldIds.includes(m.id));
        state.laid[seat] = false;
      } else if (h.kind === 'swap') {
        Object.assign(state.melds.find((m) => m.id === h.meld.id), h.meld);
        removeFromHand(state, seat, [h.wild.id]);
        state.mustPlay = state.mustPlay.filter((id) => id !== h.wild.id);
        state.hands[seat].push(...h.cards);
        bump(state, seat, 'jokerSwaps', -1);
        log(state, `${name} took back their swap.`, 'undo', { seat });
        return { ok: true };
      } else {
        const meld = state.melds.find((m) => m.id === h.meld.id);
        Object.assign(meld, h.meld);
      }
      state.hands[seat].push(...h.cards);
      state.turnPlays -= h.cards.length;
      log(state, `${name} took back their last play.`, 'undo', { seat });
      return { ok: true };
    }

    case 'shanghai': {
      if (!inRound) return err('There is no round in progress.');
      if (topIsShanghai(state) && state.lastDiscard.by !== seat) {
        const ld = state.lastDiscard;
        ld.called = true;
        ld.open = false;
        state.topDead = true;
        state.buyWindow = null;
        state.buyOffered = true;
        const got = drawCards(state, ld.by, state.options.shanghaiPenalty);
        bump(state, seat, 'caught');
        bump(state, ld.by, 'caughtBy');
        bump(state, ld.by, 'shanghaiCards', got.length);
        log(
          state,
          `SHANGHAI! ${name} caught ${state.players[ld.by].name}'s ${cardLabel(ld.card)}. ${state.players[ld.by].name} picks up ${got.length} cards.`,
          'shanghai',
          { seat, target: ld.by }
        );
        return { ok: true, result: 'hit' };
      }
      const got = drawCards(state, seat, state.options.falseCallPenalty);
      const cost = got.length ? ` ${name} picks up ${got.length} card${got.length === 1 ? '' : 's'}.` : '';
      const why = notShanghaiReason(state, seat);
      bump(state, seat, 'falseCalls');
      log(state, `${name} called Shanghai, but there wasn't one.${cost}`, 'falsecall', { seat, why });
      return { ok: true, result: 'miss', why };
    }

    default:
      return err('Unknown action.');
  }
}

// Ends the look-at-your-cards pause and starts the first turn (the host can force this).
export function beginPlay(state) {
  if (state.phase !== 'ready') return err('The round has already started.');
  state.phase = 'draw';
  log(state, `Everyone's ready. ${state.players[state.turn].name} goes first.`, 'round');
  return { ok: true };
}

// Host escape hatch for a round nobody can finish: everyone scores what they hold.
export function endRoundNoWinner(state) {
  if (!['ready', 'draw', 'play'].includes(state.phase)) return err('No round in progress.');
  log(state, 'The host ended the round.', 'info');
  finishRound(state, null);
  return { ok: true };
}

export function nextRound(state) {
  if (state.phase !== 'roundOver') return err('The round is not over.');
  if (endIfPastLastRound(state)) return { ok: true };
  startRound(state);
  return { ok: true };
}

// A game saved between rounds when the game had 11 rounds can be past the last one now: it ends with the scores so far
export function endIfPastLastRound(state) {
  if (!state || state.phase !== 'roundOver' || !isLastRound(state.round)) return false;
  log(state, `The game is ${ROUNDS.length} rounds now, so that was the last one.`, 'info');
  settleGame(state);
  return true;
}

// What one seat is allowed to see. seat = null for a spectator.
export function viewFor(state, seat) {
  const ld = state.lastDiscard;
  return {
    you: seat,
    options: state.options,
    players: state.players.map((p, i) => ({
      ...p,
      out: sittingOut(state, i),
      cards: state.hands[i].length,
      laid: state.laid[i],
      buysUsed: state.buysUsed[i],
      blocked: state.blocked[i],
      ready: state.phase === 'ready' ? state.ready[i] : true,
    })),
    scores: state.scores,
    round: state.round,
    dealer: state.dealer,
    turn: state.turn,
    phase: state.phase,
    deckCount: state.deck.length,
    discardTop: state.discard[state.discard.length - 1] || null,
    discardBelow: state.discard[state.discard.length - 2] || null,
    discardCount: state.discard.length,
    topDead: state.topDead,
    lastDiscard: ld ? { by: ld.by, cardId: ld.card.id, declared: ld.declared, called: ld.called } : null,
    melds: state.melds,
    hand: seat != null ? state.hands[seat] : [],
    turnPlays: state.turnPlays,
    canUndo: seat === state.turn && state.phase === 'play' && state.history.length > 0,
    mustPlay: seat === state.turn ? state.mustPlay : [],
    buyOffered: state.buyOffered,
    buyEligible: buyEligible(state),
    mustDecide: mustDecideOnDiscard(state),
    // who's being asked and how long is left; you see only your own answer (true, false, or undefined while deciding)
    // your early answer while the current player decides (true, false, or undefined)
    earlyBuy: seat != null && seat !== state.turn && mustDecideOnDiscard(state) && buyEligible(state).includes(seat)
      ? { mine: earlyAnswers(state)[seat] }
      : null,
    buyWindow: state.buyWindow
      ? {
          order: state.buyWindow.order,
          mine: seat != null ? state.buyWindow.answers[seat] : undefined,
          msLeft: Math.max(0, state.buyWindow.deadline - Date.now()),
        }
      : null,
    roundResult: state.roundResult
      ? { ...state.roundResult, hands: ['roundOver', 'gameOver', 'tieVote'].includes(state.phase) ? state.hands : null }
      : null,
    log: state.log.slice(-40),
    seq: state.seq,
    // a tie for the win: who's tied, how they've voted, and the tiebreaker's scores once it's played
    tiebreak: state.tiebreak || null,
    winners: state.winners || null,
    stats: state.phase === 'gameOver' && state.stats ? state.stats : null, // only once the game is over
  };
}
