// Set and run validation. Melds on the table look like:
//   { id, owner, type: 'set', rank, cards }
//   { id, owner, type: 'run', suit, lo, cards }  // cards[i] sits at rank value lo + i (2..14; aces are high only)
//
// Every set and run must have more real cards than wild cards, and a run can't have two wild cards side by side.

import { SET_MIN, RUN_MIN } from './rules.js';

const LOW = 2; // aces only count high, so a run can't go below 2
const HIGH = 14;

export function runValue(card) {
  return card.r === 1 ? HIGH : card.r;
}

export function runHi(meld) {
  return meld.lo + meld.cards.length - 1;
}

function enoughNaturals(cards, isWild) {
  const wilds = cards.filter(isWild).length;
  return cards.length - wilds > wilds;
}

function noAdjacentWilds(cards, isWild) {
  return cards.every((c, i) => i === 0 || !(isWild(c) && isWild(cards[i - 1])));
}

export function buildSet(cards, isWild) {
  if (cards.length < SET_MIN || !enoughNaturals(cards, isWild)) return null;
  const naturals = cards.filter((c) => !isWild(c));
  const rank = naturals[0].r;
  if (naturals.some((c) => c.r !== rank)) return null;
  return { type: 'set', rank, cards: [...naturals, ...cards.filter(isWild)] };
}

// Cards laid out exactly in the given order, lowest first. Returns the run or null.
function runInOrder(cards, isWild) {
  const first = cards.findIndex((c) => !isWild(c));
  const lo = runValue(cards[first]) - first;
  if (lo < LOW || lo + cards.length - 1 > HIGH) return null;
  if (cards.some((c, i) => !isWild(c) && runValue(c) !== lo + i)) return null;
  return { lo, cards };
}

// Naturals sorted, wilds filling the gaps, and any spare wilds on the ends (wildEnd says which end first).
function runAuto(naturals, wilds, isWild, wildEnd) {
  const placed = [...naturals].sort((a, b) => runValue(a) - runValue(b));
  if (placed.some((c, i) => i > 0 && runValue(c) === runValue(placed[i - 1]))) return null;
  const min = runValue(placed[0]);
  const max = runValue(placed[placed.length - 1]);
  const gaps = max - min + 1 - placed.length;
  if (gaps > wilds.length) return null;
  const extra = wilds.length - gaps;
  const splits = [];
  for (let low = 0; low <= extra; low++) splits.push(low);
  if (wildEnd !== 'low') splits.reverse(); // prefer putting them high
  for (const loExtra of splits) {
    const hiExtra = extra - loExtra;
    const lo = min - loExtra;
    if (lo < LOW || max + hiExtra > HIGH) continue;
    const slots = [];
    const wq = [...wilds];
    let pi = 0;
    for (let v = lo; v <= max + hiExtra; v++) {
      if (pi < placed.length && runValue(placed[pi]) === v) slots.push(placed[pi++]);
      else slots.push(wq.shift());
    }
    if (noAdjacentWilds(slots, isWild)) return { lo, cards: slots };
  }
  return null;
}

// Wild cards stay where the player put them: the cards are tried in the order given (low to high, or high to low)
// before falling back to sorting them. wildEnd decides which end spare wilds go on in that fallback.
export function buildRun(cards, isWild, wildEnd = 'high') {
  if (cards.length < RUN_MIN || !enoughNaturals(cards, isWild)) return null;
  const naturals = cards.filter((c) => !isWild(c));
  const wilds = cards.filter(isWild);
  const suit = naturals[0].s;
  if (naturals.some((c) => c.s !== suit)) return null;
  let run = null;
  if (wilds.length) run = runInOrder(cards, isWild) || runInOrder([...cards].reverse(), isWild);
  if (run && !noAdjacentWilds(run.cards, isWild)) run = null;
  run = run || runAuto(naturals, wilds, isWild, wildEnd);
  return run ? { type: 'run', suit, lo: run.lo, cards: run.cards } : null;
}

// Where a single card could go on a meld: [] if nowhere, else a list of 'low' / 'high' / 'set'.
export function placements(meld, card, isWild) {
  const wild = isWild(card);
  if (wild && !enoughNaturals([...meld.cards, card], isWild)) return [];
  if (meld.type === 'set') return wild || card.r === meld.rank ? ['set'] : [];
  const hi = runHi(meld);
  const out = [];
  if (wild) {
    if (hi < HIGH && !isWild(meld.cards[meld.cards.length - 1])) out.push('high');
    if (meld.lo > LOW && !isWild(meld.cards[0])) out.push('low');
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

// Could this card be played on any pile, either on the end of it or by swapping out a wild card in a run?
// This is what makes a discard a Shanghai.
export function fitsAnyMeld(card, melds, isWild) {
  return melds.some((m) => placements(m, card, isWild).length > 0 || wildSlotFor(m, card, isWild) >= 0);
}

export function meldLabel(meld) {
  return meld.type === 'set' ? 'Set' : 'Run';
}
