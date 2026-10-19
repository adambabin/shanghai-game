// Game engine. Runs only on the host; everyone else gets a filtered view of the state.
// Players are referred to by seat number (0..n-1).

import { makeDecks, shuffle, wildTest, cardPoints, cardLabel } from './cards.js';
import { buildSet, buildRun, addCards, fitsAnyMeld } from './melds.js';
import { ROUNDS, DEFAULT_OPTIONS, decksFor, contractText } from './rules.js';

export function createGame(players, options = {}, rng = Math.random) {
  const state = {
    options: { ...DEFAULT_OPTIONS, ...options },
    players: players.map((p) => ({ name: p.name, bot: !!p.bot })),
    scores: players.map(() => []),
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

export function startRound(state) {
  state.round++;
  const n = state.players.length;
  if (state.round > 0) state.dealer = (state.dealer + 1) % n;
  const cfg = ROUNDS[state.round];
  state.deck = shuffle(makeDecks(decksFor(n)), rngOf(state));
  state.hands = state.players.map(() => state.deck.splice(0, cfg.deal));
  state.discard = [state.deck.pop()];
  state.topDead = false;
  state.melds = [];
  state.laid = state.players.map(() => false);
  state.buysUsed = state.players.map(() => 0);
  state.blocked = state.players.map(() => false);
  state.buyRequests = [];
  state.lastDiscard = null;
  state.turn = (state.dealer + 1) % n;
  state.turnPlays = 0;
  state.history = [];
  state.phase = 'draw';
  state.roundResult = null;
  log(state, `Round ${state.round + 1}: ${contractText(state.round)}. ${state.players[state.dealer].name} deals.`, 'round');
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

function resolveBuys(state) {
  const reqs = state.buyRequests;
  state.buyRequests = [];
  if (!reqs.length || !state.discard.length || state.topDead) return;
  const n = state.players.length;
  // closest player after the one whose turn it is wins the buy
  const order = (s) => (s - state.turn + n) % n;
  const buyer = [...reqs].sort((a, b) => order(a) - order(b))[0];
  const card = state.discard.pop();
  state.hands[buyer].push(card);
  state.buysUsed[buyer]++;
  const extra = drawCards(state, buyer, 1);
  state.topDead = false;
  log(state, `${state.players[buyer].name} bought the ${cardLabel(card)}${extra.length ? ' (+1 card from the deck)' : ''}.`, 'buy', { seat: buyer });
}

function finishRound(state, winner) {
  const isWild = isWildFn(state);
  const points = state.hands.map((h) => h.reduce((sum, c) => sum + cardPoints(c, isWild), 0));
  points.forEach((p, i) => state.scores[i].push(p));
  state.roundResult = { winner, points };
  state.buyRequests = [];
  closeShanghaiWindow(state);
  if (winner != null) log(state, `${state.players[winner].name} went out and won round ${state.round + 1}!`, 'win', { seat: winner });
  else log(state, `Round ${state.round + 1} ended with nobody going out.`, 'win');
  state.phase = state.round >= ROUNDS.length - 1 ? 'gameOver' : 'roundOver';
}

export function totals(state) {
  return state.scores.map((s) => s.reduce((a, b) => a + b, 0));
}

function afterPlay(state, seat) {
  if (state.hands[seat].length === 0) finishRound(state, seat);
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

  switch (action.type) {
    case 'drawDeck': {
      if (!myTurn || state.phase !== 'draw') return err("It's not your turn to draw.");
      closeShanghaiWindow(state);
      resolveBuys(state);
      const got = drawCards(state, seat, 1);
      if (!got.length) {
        finishRound(state, null);
        return { ok: true };
      }
      state.phase = 'play';
      state.history = [];
      log(state, `${name} drew from the deck.`, 'draw', { seat });
      return { ok: true };
    }

    case 'drawDiscard': {
      if (!myTurn || state.phase !== 'draw') return err("It's not your turn to draw.");
      if (!state.discard.length) return err('The discard pile is empty.');
      if (state.topDead) return err("That card is dead (Shanghai'd). It can't be picked up until another card covers it.");
      closeShanghaiWindow(state);
      state.buyRequests = [];
      const card = state.discard.pop();
      state.hands[seat].push(card);
      state.phase = 'play';
      state.history = [];
      log(state, `${name} picked up the ${cardLabel(card)}.`, 'draw', { seat });
      return { ok: true };
    }

    case 'buy': {
      if (state.phase !== 'draw') return err('You can only buy before the current player draws.');
      if (myTurn) return err("It's your turn, so just pick up the discard.");
      if (!state.discard.length) return err('There is nothing to buy.');
      if (state.topDead) return err("That card is dead (Shanghai'd) and can't be bought.");
      if (state.laid[seat]) return err("You've already laid down, so you can't buy.");
      if (state.lastDiscard && state.lastDiscard.by === seat && state.lastDiscard.card.id === state.discard[state.discard.length - 1].id)
        return err("You can't buy back your own discard.");
      if (state.buysUsed[seat] >= state.options.buyLimit) return err(`You've used all ${state.options.buyLimit} buys this round.`);
      if (state.buyRequests.includes(seat)) return { ok: true };
      state.buyRequests.push(seat);
      log(state, `${name} wants to buy the ${cardLabel(state.discard[state.discard.length - 1])}.`, 'buyreq', { seat });
      return { ok: true };
    }

    case 'cancelBuy': {
      state.buyRequests = state.buyRequests.filter((s) => s !== seat);
      return { ok: true };
    }

    case 'layDown': {
      if (!myTurn || state.phase !== 'play') return err('You can only lay down on your turn, after drawing.');
      if (state.laid[seat]) return err("You've already laid down this round.");
      const cfg = ROUNDS[state.round];
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

    case 'discard': {
      if (!myTurn || state.phase !== 'play') return err("You can't discard right now.");
      const [card] = takeFromHand(state, seat, [action.id]) || [];
      if (!card) return err("That card isn't in your hand.");
      if (state.hands[seat].length <= 1)
        return err("You can't go out on a discard. Play your last card onto a pile, or Undo your plays this turn.");
      removeFromHand(state, seat, [card.id]);
      state.discard.push(card);
      const declared = !!action.declare;
      state.topDead = declared;
      state.lastDiscard = {
        by: seat,
        card,
        declared,
        eligible: !declared && state.laid[seat] && fitsAnyMeld(card, state.melds, isWild),
        open: !declared,
        called: false,
      };
      if (declared) log(state, `${name} said "Shanghai!" and discarded the ${cardLabel(card)}. It's dead until covered.`, 'dead', { seat });
      else log(state, `${name} discarded the ${cardLabel(card)}.`, 'discard', { seat });
      state.turn = (state.turn + 1) % n;
      state.turnPlays = 0;
      state.blocked[state.turn] = false;
      state.buyRequests = [];
      state.phase = 'draw';
      return { ok: true };
    }

    case 'undo': {
      if (!myTurn || state.phase !== 'play') return err('Nothing to undo.');
      const h = state.history.pop();
      if (!h) return err('Nothing to undo this turn.');
      if (h.kind === 'layDown') {
        state.melds = state.melds.filter((m) => !h.meldIds.includes(m.id));
        state.laid[seat] = false;
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
      if (state.blocked[seat]) return err("You're blocked from calling Shanghai until your next turn.");
      if (topIsShanghai(state) && state.lastDiscard.by !== seat) {
        const ld = state.lastDiscard;
        ld.called = true;
        ld.open = false;
        state.topDead = true;
        state.buyRequests = [];
        const got = drawCards(state, ld.by, state.options.shanghaiPenalty);
        log(
          state,
          `SHANGHAI! ${name} caught ${state.players[ld.by].name}'s ${cardLabel(ld.card)}. ${state.players[ld.by].name} picks up ${got.length} cards.`,
          'shanghai',
          { seat, target: ld.by }
        );
        return { ok: true, result: 'hit' };
      }
      const got = drawCards(state, seat, state.options.falseCallPenalty);
      state.blocked[seat] = true;
      log(state, `${name} called Shanghai, but there wasn't one. ${name} picks up ${got.length} cards and can't call again until their next turn.`, 'falsecall', { seat });
      return { ok: true, result: 'miss' };
    }

    default:
      return err('Unknown action.');
  }
}

// Host escape hatch for a round nobody can finish: everyone scores what they hold.
export function endRoundNoWinner(state) {
  if (state.phase !== 'draw' && state.phase !== 'play') return err('No round in progress.');
  log(state, 'The host ended the round.', 'info');
  finishRound(state, null);
  return { ok: true };
}

export function nextRound(state) {
  if (state.phase !== 'roundOver') return err('The round is not over.');
  startRound(state);
  return { ok: true };
}

// What one seat is allowed to see. seat = null for a spectator.
export function viewFor(state, seat) {
  const ld = state.lastDiscard;
  return {
    you: seat,
    options: state.options,
    players: state.players.map((p, i) => ({
      ...p,
      cards: state.hands[i].length,
      laid: state.laid[i],
      buysUsed: state.buysUsed[i],
      blocked: state.blocked[i],
      buying: state.buyRequests.includes(i),
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
    roundResult: state.roundResult
      ? { ...state.roundResult, hands: state.phase === 'roundOver' || state.phase === 'gameOver' ? state.hands : null }
      : null,
    log: state.log.slice(-40),
    seq: state.seq,
  };
}
