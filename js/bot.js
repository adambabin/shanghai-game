// Computer player. Decisions are made from the same filtered view a human gets.

import { wildTest, cardPoints } from './cards.js';
import { addCards, fitsAnyMeld, placements, buildSet, buildRun } from './melds.js';
import { ROUNDS, SET_MIN, RUN_MIN, MIN_NATURALS } from './rules.js';

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
    else if (nat.length >= MIN_NATURALS && wilds.length >= SET_MIN - nat.length)
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
      const vals = c.r === 1 ? [1, 14] : [c.r];
      for (const v of vals) if (!byVal.has(v)) byVal.set(v, c);
    }
    for (let start = 1; start + RUN_MIN - 1 <= 14; start++) {
      const picked = [];
      let missing = 0;
      for (let v = start; v < start + RUN_MIN; v++) {
        const c = byVal.get(v);
        if (c && !picked.includes(c)) picked.push(c);
        else missing++;
      }
      if (picked.length < MIN_NATURALS || missing > wilds.length) continue;
      out.push({ key: suit.charCodeAt(0) * 20 + start, cards: [...picked, ...wilds.slice(0, missing)], wilds: missing });
    }
  }
  return out.sort((a, b) => a.wilds - b.wilds);
}

export function findContract(hand, round, isWild) {
  const cfg = ROUNDS[round];
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
  const cfg = ROUNDS[round];
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
        for (const v of c.r === 1 ? [1, 14] : [c.r]) if (!byVal.has(v)) byVal.set(v, c);
      }
      for (let start = 1; start + RUN_MIN - 1 <= 14; start++) {
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
    const fits = laid && fitsAnyMeld(c, view.melds, isWild);
    // after laying down only table plays matter: dump high cards that don't fit anywhere
    const keep = laid ? (fits ? 1000 : 0) : usefulness(c, hand, view.round, isWild);
    const score = keep - cardPoints(c, isWild) / 25;
    if (!best || score < best.score) best = { c, score, fits };
  }
  return best;
}

// ---------- Decisions ----------

export function chooseDraw(view) {
  const isWild = wildTest(view.options);
  const top = view.discardTop;
  if (!top || view.topDead) return { type: 'drawDeck' };
  const me = view.players[view.you];
  const hand = view.hand;
  if (me.laid) return fitsAnyMeld(top, view.melds, isWild) ? { type: 'drawDiscard' } : { type: 'drawDeck' };
  if (isWild(top)) return { type: 'drawDiscard' };
  if (!findContract(hand, view.round, isWild) && findContract([...hand, top], view.round, isWild)) return { type: 'drawDiscard' };
  const u = usefulness(top, [...hand, top], view.round, isWild);
  const worst = worstCard(hand, view, isWild);
  return u >= 7 && u > worst.score + 2 ? { type: 'drawDiscard' } : { type: 'drawDeck' };
}

export function wantsToBuy(view) {
  const isWild = wildTest(view.options);
  const me = view.players[view.you];
  const top = view.discardTop;
  if (!top || view.topDead || me.laid || me.buying) return false;
  if (me.buysUsed >= view.options.buyLimit) return false;
  if (view.lastDiscard && view.lastDiscard.by === view.you && view.lastDiscard.cardId === top.id) return false;
  if (view.turn === view.you) return false;
  if (isWild(top)) return true;
  const hand = view.hand;
  if (!findContract(hand, view.round, isWild) && findContract([...hand, top], view.round, isWild)) return true;
  const u = usefulness(top, [...hand, top], view.round, isWild);
  // later rounds need more cards than you're dealt, so be keener
  const cfg = ROUNDS[view.round];
  const need = cfg.sets * SET_MIN + cfg.runs * RUN_MIN;
  const short = need >= cfg.deal;
  return u >= (short ? 7 : 12);
}

// Would the top discard be a Shanghai? Bots only call when they're sure.
export function seesShanghai(view) {
  const ld = view.lastDiscard;
  const top = view.discardTop;
  if (!ld || !top || ld.declared || ld.called || ld.by === view.you || ld.cardId !== top.id) return false;
  if (view.phase !== 'draw' || view.players[view.you].blocked) return false;
  if (!view.players[ld.by].laid) return false;
  // only while the window is still open: the next player hasn't drawn yet
  return fitsAnyMeld(top, view.melds, wildTest(view.options));
}

// One action for the play phase (call repeatedly until it discards).
export function choosePlay(view) {
  const isWild = wildTest(view.options);
  const me = view.players[view.you];
  const hand = view.hand;

  if (!me.laid) {
    const groups = findContract(hand, view.round, isWild);
    if (groups) {
      const used = new Set(groups.flatMap((g) => g.ids));
      // laying down everything but one card would leave us stuck; extensions are tried right after
      if (hand.length - used.size !== 1 || canFinishAfter(hand.filter((c) => !used.has(c.id)), view, groups, isWild))
        return { type: 'layDown', groups };
    }
  } else {
    const plays = [];
    for (const c of hand) {
      for (const m of view.melds) if (placements(m, c, isWild).length) { plays.push({ c, m }); break; }
    }
    // wilds last, so naturals extend first
    plays.sort((a, b) => Number(isWild(a.c)) - Number(isWild(b.c)));
    if (plays.length) {
      if (hand.length === 1 || hand.length > 2) return { type: 'addToMeld', meldId: plays[0].m.id, ids: [plays[0].c.id] };
      // with 2 cards left, only play if both can go and we go out
      for (const p of plays) {
        const after = addCards(p.m, [p.c], isWild);
        const rest = hand.find((c) => c.id !== p.c.id);
        const melds = view.melds.map((m) => (m.id === p.m.id ? after : m));
        if (fitsAnyMeld(rest, melds, isWild)) return { type: 'addToMeld', meldId: p.m.id, ids: [p.c.id] };
      }
    }
  }

  // stuck holding one card we can't play: take back the last play
  if (hand.length === 1) return { type: 'undo' };
  const worst = worstCard(hand, view, isWild);
  return { type: 'discard', id: worst.c.id, declare: !!(me.laid && worst.fits) };
}

function canFinishAfter(leftover, view, groups, isWild) {
  // leftover is a single card: can it go on one of the new melds or anything already on the table?
  const built = groups.map((g) => {
    const cards = g.ids.map((id) => view.hand.find((c) => c.id === id));
    return g.type === 'set' ? buildSet(cards, isWild) : buildRun(cards, isWild);
  });
  return fitsAnyMeld(leftover[0], [...built, ...view.melds], isWild);
}
