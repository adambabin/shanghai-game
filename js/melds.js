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

// ---------- Staging a lay down: groups that are still being built ----------

// Could these cards grow into a set? (all real cards one rank; at least one real card)
export function couldBeSet(cards, isWild) {
  const naturals = cards.filter((c) => !isWild(c));
  return cards.length >= 2 && naturals.length > 0 && naturals.every((c) => c.r === naturals[0].r);
}

// Could these cards grow into a run? (real cards one suit, no repeats, close enough to fit in 2..A)
export function couldBeRun(cards, isWild) {
  const naturals = cards.filter((c) => !isWild(c));
  if (cards.length < 2 || !naturals.length || naturals.some((c) => c.s !== naturals[0].s)) return false;
  const vals = naturals.map(runValue);
  if (new Set(vals).size !== vals.length) return false;
  return Math.max(...vals) - Math.min(...vals) + 1 <= HIGH - LOW + 1;
}

// Orders a partly built run low to high. Wild cards keep the spot they were given; new ones go on the end.
export function arrangeRun(existing, added, isWild) {
  const value = new Map();
  const asc = existing.findIndex((c) => !isWild(c));
  let pos = null;
  if (asc >= 0) {
    for (const dir of [1, -1]) {
      const lo = runValue(existing[asc]) - dir * asc;
      if (existing.every((c, i) => isWild(c) || runValue(c) === lo + dir * i)) {
        pos = (i) => lo + dir * i;
        break;
      }
    }
  }
  let last = -Infinity;
  existing.forEach((c, i) => {
    const v = isWild(c) ? (pos ? pos(i) : last + 0.5) : runValue(c);
    value.set(c, v);
    last = v;
  });
  let tail = 100;
  for (const c of added) value.set(c, isWild(c) ? tail++ : runValue(c));
  return [...existing, ...added].sort((a, b) => value.get(a) - value.get(b));
}

export function meldLabel(meld) {
  return meld.type === 'set' ? 'Set' : 'Run';
}

// ---------- Staged runs: where the wild cards sit ----------

// The number each card stands for in a run laid out low to high (gaps allowed): a real card its own, a wild card
// counted on from the nearest real card before it (or back from the one after it).
export function runPlaces(cards, isWild) {
  const at = cards.map((c) => (isWild(c) ? null : runValue(c)));
  return at.map((v, i) => {
    if (v != null) return v;
    for (let j = i - 1; j >= 0; j--) if (at[j] != null) return at[j] + (i - j);
    for (let j = i + 1; j < at.length; j++) if (at[j] != null) return at[j] - (j - i);
    return null;
  });
}

// A staged run laid out as well as it can be, low to high: as it would be laid down if it's already a run,
// otherwise the real cards in order with wild cards filling the gaps from the bottom, then going on the high end
// (the low end once it reaches the ace).
export function layoutRun(cards, isWild) {
  const naturals = cards.filter((c) => !isWild(c)).sort((a, b) => runValue(a) - runValue(b));
  const wilds = cards.filter(isWild);
  if (!naturals.length) return cards;
  const built = buildRun([...naturals, ...wilds], isWild);
  if (built) return built.cards;
  const out = [];
  naturals.forEach((c, i) => {
    if (i) for (let v = runValue(naturals[i - 1]) + 1; v < runValue(c) && wilds.length; v++) out.push(wilds.shift());
    out.push(c);
  });
  let hi = runPlaces(out, isWild).at(-1);
  while (wilds.length) {
    if (hi < HIGH) {
      out.push(wilds.shift());
      hi++;
    } else out.unshift(wilds.shift());
  }
  return out;
}

// Do these cards, in exactly this order, make a run so far (however short)?
function inOrderSoFar(cards, isWild) {
  return enoughNaturals(cards, isWild) && noAdjacentWilds(cards, isWild) && !!runInOrder(cards, isWild);
}

// Where the wild card at index i of a staged run (cards low to high, places from runPlaces) could move to:
// a gap between the other cards or either end. If the run can work, only the spots where it still does.
export function wildSpots(cards, places, i, isWild) {
  const others = places.filter((p, j) => j !== i);
  const lo = Math.max(LOW, Math.min(...others) - 1);
  const hi = Math.min(HIGH, Math.max(...others) + 1);
  const spots = [];
  for (let v = lo; v <= hi; v++) if (!others.includes(v)) spots.push(v);
  const order = (v) => {
    const at = places.map((p, j) => (j === i ? v : p));
    return cards.map((c, j) => [c, at[j]]).sort((a, b) => a[1] - b[1]).map(([c]) => c);
  };
  const working = spots.filter((v) => inOrderSoFar(order(v), isWild));
  return working.length ? working : spots;
}
