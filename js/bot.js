// Computer player. Decisions are made from the same filtered view a human gets.

import { wildTest, cardPoints } from './cards.js';
import { addCards, fitsAnyMeld, placements, buildSet, buildRun, runValue, wildSlotFor } from './melds.js';
import { roundCfg, SET_MIN, RUN_MIN, botLevelFor } from './rules.js';

// How each computer skill plays.
// declare: chance it says Shanghai itself when its discard could go on a pile (otherwise anyone can catch it).
// playChance: chance it plays another card onto a pile rather than stopping there (going out is always taken).
// buyMistake: chance it gets a buy answer backwards. smartBuys: weighs the extra cards, buys left and hand size.
// call, callDelay: how often and how fast (ms, base + random) it calls Shanghai on someone else.
// stump: chance, once a round, that it holds a ready lay down to catch others out ("stumping"), for at most stumpTurns
// turns. It lays down once it would be left with STUMP_LEFT cards or fewer, once someone else lays down, or when the
// cards it would lay down are worth STUMP_POINTS or more.
const LEVELS = {
  easy: { declare: 0.35, playChance: 0.7, buyMistake: 0.25, smartBuys: false, call: 0.5, callDelay: [3000, 3000], stump: 0 },
  normal: { declare: 0.6, playChance: 1, buyMistake: 0, smartBuys: false, call: 0.75, callDelay: [1200, 2500], stump: 0.25, stumpTurns: 1 },
  hard: { declare: 1, playChance: 1, buyMistake: 0, smartBuys: true, call: 0.95, callDelay: [900, 1800], stump: 0.5, stumpTurns: Infinity },
};
const STUMP_LEFT = 2;
const STUMP_POINTS = 100;

export function botLevel(options) {
  return LEVELS[botLevelFor(options)];
}

// ---------- Finding a lay down ----------

function setCandidates(cards, isWild) {
  const wilds = cards.filter(isWild);
  const byRank = new Map();
  for (const c of cards) {
    if (isWild(c)) continue;
    if (!byRank.has(c.r)) byRank.set(c.r, []);
    byRank.get(c.r).push(c);
  }
  const out = [];
  for (const [rank, nat] of byRank) {
    if (nat.length >= SET_MIN) out.push({ key: rank, cards: nat.slice(0, SET_MIN), wilds: 0 });
    else if (nat.length > SET_MIN - nat.length && wilds.length >= SET_MIN - nat.length)
      out.push({ key: rank, cards: [...nat, ...wilds.slice(0, SET_MIN - nat.length)], wilds: SET_MIN - nat.length });
  }
  return out.sort((a, b) => a.wilds - b.wilds);
}

function runCandidates(cards, isWild) {
  const wilds = cards.filter(isWild);
  const out = [];
  for (const suit of ['S', 'H', 'D', 'C']) {
    const byVal = new Map();
    for (const c of cards) {
      if (isWild(c) || c.s !== suit) continue;
      if (!byVal.has(runValue(c))) byVal.set(runValue(c), c);
    }
    for (let start = 2; start + RUN_MIN - 1 <= 14; start++) {
      const picked = [];
      let missing = 0;
      for (let v = start; v < start + RUN_MIN; v++) {
        const c = byVal.get(v);
        if (c && !picked.includes(c)) picked.push(c);
        else missing++;
      }
      // more real cards than wilds, and with a 4-card window that also means no two wilds together
      if (picked.length <= missing || missing > wilds.length) continue;
      out.push({ key: suit.charCodeAt(0) * 20 + start, cards: [...picked, ...wilds.slice(0, missing)], wilds: missing });
    }
  }
  return out.sort((a, b) => a.wilds - b.wilds);
}

export function findContract(hand, round, isWild) {
  const cfg = roundCfg(round);
  const needed = [...Array(cfg.runs).fill('run'), ...Array(cfg.sets).fill('set')];
  const search = (idx, avail, lastKey) => {
    if (idx === needed.length) return [];
    const type = needed[idx];
    const cands = type === 'set' ? setCandidates(avail, isWild) : runCandidates(avail, isWild);
    const sameAsPrev = idx > 0 && needed[idx - 1] === type;
    for (const cand of cands) {
      if (sameAsPrev && cand.key < lastKey) continue;
      const ids = new Set(cand.cards.map((c) => c.id));
      const rest = search(idx + 1, avail.filter((c) => !ids.has(c.id)), cand.key);
      if (rest) return [{ type, ids: cand.cards.map((c) => c.id) }, ...rest];
    }
    return null;
  };
  return search(0, hand, -Infinity);
}

// ---------- Hand evaluation ----------

// Picks the most promising partial sets and runs for this round's contract, then values each card by
// whether it belongs to one of them. Cards outside those groups are discard fodder.
function planHand(hand, round, isWild) {
  const cfg = roundCfg(round);
  const value = new Map();
  const naturals = hand.filter((c) => !isWild(c));

  if (cfg.sets) {
    const byRank = new Map();
    for (const c of naturals) byRank.set(c.r, [...(byRank.get(c.r) || []), c]);
    const groups = [...byRank.values()].sort((a, b) => b.length - a.length);
    groups.slice(0, cfg.sets + 1).forEach((g, gi) => {
      const spare = gi >= cfg.sets; // one backup group in case another stalls
      g.forEach((c, i) => {
        let v = i < SET_MIN ? [3, 8, 12][Math.min(g.length, SET_MIN) - 1] : 5;
        if (spare) v *= 0.6;
        value.set(c.id, Math.max(value.get(c.id) || 0, v));
      });
    });
  }

  if (cfg.runs) {
    const windows = [];
    for (const suit of ['S', 'H', 'D', 'C']) {
      const byVal = new Map();
      for (const c of naturals) {
        if (c.s !== suit) continue;
        if (!byVal.has(runValue(c))) byVal.set(runValue(c), c);
      }
      for (let start = 2; start + RUN_MIN - 1 <= 14; start++) {
        const cards = [];
        for (let v = start; v < start + RUN_MIN; v++) if (byVal.has(v) && !cards.includes(byVal.get(v))) cards.push(byVal.get(v));
        if (cards.length >= 2) windows.push({ suit, start, cards });
      }
    }
    windows.sort((a, b) => b.cards.length - a.cards.length);
    const chosen = [];
    for (const w of windows) {
      if (chosen.length >= cfg.runs + 1) break;
      if (chosen.some((o) => o.cards.some((c) => w.cards.includes(c)))) continue;
      chosen.push(w);
    }
    chosen.forEach((w, wi) => {
      let v = [0, 2, 6, 9, 12][w.cards.length];
      if (wi >= cfg.runs) v *= 0.6;
      for (const c of w.cards) value.set(c.id, Math.max(value.get(c.id) || 0, v));
    });
  }
  return value;
}

function usefulness(card, hand, round, isWild) {
  if (isWild(card)) return 100;
  return planHand(hand, round, isWild).get(card.id) || 0;
}

function worstCard(hand, view, isWild) {
  const laid = view.players[view.you].laid;
  let best = null;
  for (const c of hand) {
    const fits = fitsAnyMeld(c, view.melds, isWild);
    // after laying down only table plays matter: dump high cards that don't fit anywhere
    const keep = laid ? (fits ? 1000 : 0) : usefulness(c, hand, view.round, isWild);
    const score = keep - cardPoints(c, isWild) / 25;
    if (!best || score < best.score) best = { c, score, fits };
  }
  return best;
}

// ---------- Decisions ----------

function wantsDiscard(view, isWild, memo) {
  const top = view.discardTop;
  const me = view.players[view.you];
  const hand = view.hand;
  if (me.laid) return fitsAnyMeld(top, view.melds, isWild);
  if (isWild(top)) return true;
  // waiting to stump: anything that would go on a pile once we lay down gets us closer
  if (memo.stump && memo.held) {
    const groups = findContract(hand, view.round, isWild);
    if (groups && leftAfterLayDown([...hand, top], view, groups, isWild) < leftAfterLayDown(hand, view, groups, isWild)) return true;
  }
  if (!findContract(hand, view.round, isWild) && findContract([...hand, top], view.round, isWild)) return true;
  const u = usefulness(top, [...hand, top], view.round, isWild);
  const worst = worstCard(hand, view, isWild);
  return u >= 7 && u > worst.score + 2;
}

// Draw-phase decision on the bot's own turn. Returns null while others are deciding whether to buy.
// memo is this computer's own notes for the round (see choosePlay).
export function chooseDraw(view, memo = {}) {
  const isWild = wildTest(view.options);
  if (view.buyWindow) return null;
  const top = view.discardTop;
  if (!top || view.topDead) return { type: 'drawDeck' };
  if (wantsDiscard(view, isWild, memo)) return { type: 'drawDiscard' };
  // not interested: give everyone else a chance to buy it first
  if (!view.buyOffered && view.buyEligible.length) return { type: 'allowBuy' };
  return { type: 'drawDeck' };
}

export function wantsToBuy(view, rng = Math.random) {
  const me = view.players[view.you];
  const top = view.discardTop;
  if (!top || view.topDead || me.laid) return false;
  if (!view.buyEligible.includes(view.you)) return false;
  const lvl = botLevel(view.options);
  const want = buyIsWorthIt(view, lvl);
  return lvl.buyMistake && rng() < lvl.buyMistake ? !want : want;
}

function buyIsWorthIt(view, lvl) {
  const isWild = wildTest(view.options);
  const top = view.discardTop;
  if (isWild(top)) return true;
  const hand = view.hand;
  if (!findContract(hand, view.round, isWild) && findContract([...hand, top], view.round, isWild)) return true;
  const u = usefulness(top, [...hand, top], view.round, isWild);
  // later rounds need more cards than you're dealt, so be keener
  const cfg = roundCfg(view.round);
  const need = cfg.sets * SET_MIN + cfg.runs * RUN_MIN;
  const short = need >= cfg.deal;
  let bar = short ? 7 : 12;
  if (lvl.smartBuys) {
    const o = view.options;
    bar += (o.buyPenalty - 2) * 1.5; // more extra cards, pickier
    if (hand.length >= cfg.deal + 4) bar += 3; // already holding plenty
    if (!short && o.buyLimit - view.players[view.you].buysUsed === 1) bar += 2; // save the last buy for something better
    // one card from laying down after this one: worth paying for
    if (findContract([...hand, top, { id: -1, r: 0, s: 'J' }], view.round, isWild)) bar -= 3;
  }
  return u >= bar;
}

// How often and how soon this computer calls Shanghai on someone else's discard.
export function shanghaiReaction(options, rng = Math.random) {
  const { call, callDelay } = botLevel(options);
  return { calls: rng() < call, delay: callDelay[0] + rng() * callDelay[1] };
}

// Would the top discard be a Shanghai? Bots only call when they're sure.
export function seesShanghai(view) {
  const ld = view.lastDiscard;
  const top = view.discardTop;
  if (!ld || !top || ld.declared || ld.called || ld.by === view.you || ld.cardId !== top.id) return false;
  if (view.phase !== 'draw' || view.players[view.you].blocked) return false;
  // only while the window is still open: the next player hasn't drawn yet
  return fitsAnyMeld(top, view.melds, wildTest(view.options));
}

// One action for the play phase (call repeatedly until it discards). memo is an object kept for this computer for the
// round (a fresh one each round): whether it's stumping and how many turns it has held.
export function choosePlay(view, rng = Math.random, memo = {}) {
  const isWild = wildTest(view.options);
  const lvl = botLevel(view.options);
  const me = view.players[view.you];
  const hand = view.hand;

  // a wild we swapped out has to be played before we can discard
  const owed = hand.find((c) => view.mustPlay.includes(c.id));
  if (owed) {
    const m = view.melds.find((m) => placements(m, owed, isWild).length);
    if (m) return { type: 'addToMeld', meldId: m.id, ids: [owed.id] };
    return { type: 'undo' };
  }

  if (!me.laid) {
    const groups = findContract(hand, view.round, isWild);
    if (groups) {
      const used = new Set(groups.flatMap((g) => g.ids));
      // laying down everything but one card would leave us stuck; extensions are tried right after
      const ok = hand.length - used.size !== 1 || canFinishAfter(hand.filter((c) => !used.has(c.id)), view, groups, isWild);
      if (ok && !holdsToStump(view, groups, lvl, rng, memo, isWild)) return { type: 'layDown', groups };
      if (ok) {
        // keep what will go on the piles once we lay down; let go of the rest
        memo.held = (memo.held || 0) + 1;
        // (a card that fits a pile already would be a Shanghai, so that's kept too)
        const melds = [...builtGroups(groups, hand, isWild), ...view.melds];
        const keep = (c) => used.has(c.id) || isWild(c) || canPlayLast(c, melds, isWild) || fitsAnyMeld(c, view.melds, isWild);
        const spare = hand.filter((c) => !keep(c));
        if (spare.length) {
          const c = spare.reduce((a, b) => (cardPoints(b, isWild) > cardPoints(a, isWild) ? b : a));
          return { type: 'discard', id: c.id, declare: false };
        }
      }
    }
  } else {
    // swap a natural card for a wild in a run (only with cards to spare, so the wild can be played and we can still discard)
    if (hand.length >= 3 && rng() < lvl.playChance) {
      for (const c of hand) {
        const m = view.melds.find((m) => wildSlotFor(m, c, isWild) >= 0);
        if (!m) continue;
        const wild = m.cards[wildSlotFor(m, c, isWild)];
        if (view.melds.some((o) => placements(o, wild, isWild).length)) return { type: 'swapWild', meldId: m.id, id: c.id };
      }
    }
    const plays = [];
    for (const c of hand) {
      for (const m of view.melds) if (placements(m, c, isWild).length) { plays.push({ c, m }); break; }
    }
    // wilds last, so naturals extend first
    plays.sort((a, b) => Number(isWild(a.c)) - Number(isWild(b.c)));
    if (plays.length) {
      // easier computers don't always play everything they could; that leaves cards to Shanghai later
      if (hand.length > 2 && rng() >= lvl.playChance) plays.length = 0;
      else if (hand.length === 1 || hand.length > 2) return { type: 'addToMeld', meldId: plays[0].m.id, ids: [plays[0].c.id] };
      // with 2 cards left, only play if both can go and we go out
      for (const p of plays) {
        const after = addCards(p.m, [p.c], isWild);
        const rest = hand.find((c) => c.id !== p.c.id);
        const melds = view.melds.map((m) => (m.id === p.m.id ? after : m));
        if (canPlayLast(rest, melds, isWild)) return { type: 'addToMeld', meldId: p.m.id, ids: [p.c.id] };
      }
    }
  }

  // stuck holding one card we can't play: take back the last play
  if (hand.length === 1) return { type: 'undo' };
  const worst = worstCard(hand, view, isWild);
  // discarding a card that could go on a pile: say Shanghai first so nobody can catch it
  // (easier computers forget sometimes, so you can catch them)
  return { type: 'discard', id: worst.c.id, declare: !!worst.fits && rng() < lvl.declare };
}

function builtGroups(groups, hand, isWild) {
  return groups.map((g) => {
    const cards = g.ids.map((id) => hand.find((c) => c.id === id));
    return g.type === 'set' ? buildSet(cards, isWild) : buildRun(cards, isWild);
  });
}

function canFinishAfter(leftover, view, groups, isWild) {
  // leftover is a single card: can it go on one of the new melds or anything already on the table?
  return canPlayLast(leftover[0], [...builtGroups(groups, view.hand, isWild), ...view.melds], isWild);
}

// How many cards would still be in hand after laying down these groups and playing everything we can onto piles.
function leftAfterLayDown(hand, view, groups, isWild) {
  const used = new Set(groups.flatMap((g) => g.ids));
  const melds = [...builtGroups(groups, hand, isWild), ...view.melds];
  // naturals first, so wilds only fill what they need to
  let rest = hand.filter((c) => !used.has(c.id)).sort((a, b) => Number(isWild(a)) - Number(isWild(b)));
  for (let played = true; played && rest.length; ) {
    played = false;
    for (const c of rest) {
      const i = melds.findIndex((m) => placements(m, c, isWild).length);
      if (i < 0) continue;
      melds[i] = addCards(melds[i], [c], isWild);
      rest = rest.filter((o) => o !== c);
      played = true;
      break;
    }
  }
  return rest.length;
}

// Points we'd be stuck with by holding these groups back instead of laying them down, if someone goes out first.
function atStake(hand, groups, isWild) {
  const used = new Set(groups.flatMap((g) => g.ids));
  return hand.reduce((t, c) => t + (used.has(c.id) ? cardPoints(c, isWild) : 0), 0);
}

// Stumping: with the contract in hand, keep it hidden until laying down would leave us nearly out, so anyone not down
// yet gets caught with a full hand. Decided once a round; given up when someone else lays down (they're racing to go
// out now), when the cards we're holding back would cost a lot if we got caught, or after the level's turn limit.
function holdsToStump(view, groups, lvl, rng, memo, isWild) {
  if (!lvl.stump) return false;
  if (memo.stump === undefined) memo.stump = rng() < lvl.stump;
  if (!memo.stump) return false;
  const hand = view.hand;
  const giveUp = (memo.held || 0) >= lvl.stumpTurns
    || view.players.some((p, i) => i !== view.you && p.laid)
    || atStake(hand, groups, isWild) >= STUMP_POINTS
    || leftAfterLayDown(hand, view, groups, isWild) <= STUMP_LEFT;
  if (giveUp) memo.stump = false;
  return !giveUp;
}

// Can our last card go out on a pile? Only onto an end or a set: swapping it for a wild would leave the wild in our
// hand, and going out on that turns into play, undo, play, undo (fitsAnyMeld counts swaps, which is right for Shanghai)
function canPlayLast(card, melds, isWild) {
  return melds.some((m) => placements(m, card, isWild).length > 0);
}
