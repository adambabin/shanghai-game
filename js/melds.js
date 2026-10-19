// Set and run validation. Melds on the table look like:
//   { id, owner, type: 'set', rank, cards }
//   { id, owner, type: 'run', suit, lo, cards }  // cards[i] sits at rank value lo + i (2..14; aces are high only)

import { SET_MIN, RUN_MIN, MIN_NATURALS } from './rules.js';

const LOW = 2; // aces only count high, so a run can't go below 2
const HIGH = 14;

export function runValue(card) {
  return card.r === 1 ? HIGH : card.r;
}

export function runHi(meld) {
  return meld.lo + meld.cards.length - 1;
}

export function buildSet(cards, isWild) {
  if (cards.length < SET_MIN) return null;
  const naturals = cards.filter((c) => !isWild(c));
  if (naturals.length < MIN_NATURALS) return null;
  const rank = naturals[0].r;
  if (naturals.some((c) => c.r !== rank)) return null;
  return { type: 'set', rank, cards: [...naturals, ...cards.filter(isWild)] };
}

// wildEnd decides which end spare wilds go on when they aren't needed to fill gaps.
export function buildRun(cards, isWild, wildEnd = 'high') {
  if (cards.length < RUN_MIN) return null;
  const naturals = cards.filter((c) => !isWild(c));
  const wilds = cards.filter(isWild);
  if (naturals.length < MIN_NATURALS) return null;
  const suit = naturals[0].s;
  if (naturals.some((c) => c.s !== suit)) return null;

  const placed = naturals.map((c) => ({ c, v: runValue(c) })).sort((a, b) => a.v - b.v);
  if (placed.some((p, i) => i > 0 && p.v === placed[i - 1].v)) return null;
  const min = placed[0].v;
  const max = placed[placed.length - 1].v;
  const gaps = max - min + 1 - placed.length;
  if (gaps > wilds.length) return null;
  const extra = wilds.length - gaps;
  let loExtra, hiExtra;
  if (wildEnd === 'low') {
    loExtra = Math.min(extra, min - LOW);
    hiExtra = extra - loExtra;
  } else {
    hiExtra = Math.min(extra, HIGH - max);
    loExtra = extra - hiExtra;
  }
  if (min - loExtra < LOW || max + hiExtra > HIGH) return null;
  const lo = min - loExtra;
  const slots = [];
  const wq = [...wilds];
  let pi = 0;
  for (let v = lo; v <= max + hiExtra; v++) {
    if (pi < placed.length && placed[pi].v === v) slots.push(placed[pi++].c);
    else slots.push(wq.shift());
  }
  return { type: 'run', suit, lo, cards: slots };
}

// Where a single card could go on a meld: [] if nowhere, else a list of 'low' / 'high' / 'set'.
export function placements(meld, card, isWild) {
  if (meld.type === 'set') return isWild(card) || card.r === meld.rank ? ['set'] : [];
  const hi = runHi(meld);
  const out = [];
  if (isWild(card)) {
    if (hi < HIGH) out.push('high');
    if (meld.lo > LOW) out.push('low');
    return out;
  }
  if (card.s !== meld.suit) return out;
  if (runValue(card) === hi + 1) out.push('high');
  if (runValue(card) === meld.lo - 1) out.push('low');
  return out;
}

// Index of the wild card in a run that this natural card would replace, or -1.
export function wildSlotFor(meld, card, isWild) {
  if (meld.type !== 'run' || isWild(card) || card.s !== meld.suit) return -1;
  const idx = runValue(card) - meld.lo;
  return idx >= 0 && idx < meld.cards.length && isWild(meld.cards[idx]) ? idx : -1;
}

function addOne(meld, card, isWild, wildEnd) {
  const where = placements(meld, card, isWild);
  if (!where.length) return null;
  if (meld.type === 'set') return { ...meld, cards: [...meld.cards, card] };
  const end = where.includes(wildEnd) ? wildEnd : where[0];
  if (end === 'high') return { ...meld, cards: [...meld.cards, card] };
  return { ...meld, lo: meld.lo - 1, cards: [card, ...meld.cards] };
}

// Adds several cards to a meld in whatever order works. Returns the new meld, or null if they don't all fit.
export function addCards(meld, cards, isWild, wildEnd = 'high') {
  for (const end of wildEnd === 'low' ? ['low', 'high'] : ['high', 'low']) {
    let m = meld;
    // naturals first so wilds only fill what they need to
    let pending = [...cards].sort((a, b) => Number(isWild(a)) - Number(isWild(b)));
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      for (let i = 0; i < pending.length; i++) {
        const next = addOne(m, pending[i], isWild, end);
        if (next) {
          m = next;
          pending.splice(i, 1);
          progress = true;
          break;
        }
      }
    }
    if (!pending.length) return m;
  }
  return null;
}

export function fitsAnyMeld(card, melds, isWild) {
  return melds.some((m) => placements(m, card, isWild).length > 0);
}

export function meldLabel(meld) {
  return meld.type === 'set' ? 'Set' : 'Run';
}
