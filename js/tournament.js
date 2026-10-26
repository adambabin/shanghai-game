// Tables (BETA): a big group plays at several tables at once, all through the same 7 rounds. After each round the best
// at each table move up a table, except at the winners' table (table 1), where they stay. The rest stay put, except the
// worst at the winners' table, who drop all the way to the losers' table. Lowest total over the 7 rounds wins.
// Tables are numbered from 0 here (0 is the winners' table); seats are the lobby's seat numbers.

import { shuffle, SUITS } from './cards.js';

export const MIN_TABLE = 3;
export const MAX_TABLE = 8;
export const MAX_TABLES = 8;
export const MAX_TOUR_PLAYERS = 32;

// How many tables n players can make: at least 2, each with 3 to 8. null when they can't (fewer than 6).
export function tableRange(n) {
  const min = Math.max(2, Math.ceil(n / MAX_TABLE));
  const max = Math.min(MAX_TABLES, Math.floor(n / MIN_TABLE));
  return min <= max ? { min, max } : null;
}

// Tables of about 4, within what n players can make
export function suggestTables(n) {
  const r = tableRange(n);
  return r ? Math.min(r.max, Math.max(r.min, Math.round(n / 4))) : 2;
}

// n players split as evenly as they go: 14 at 3 tables is 5, 5 and 4
export function tableSizes(n, k) {
  const base = Math.floor(n / k);
  return Array.from({ length: k }, (_, i) => base + (i < n % k ? 1 : 0));
}

// The seats dealt out at random into k tables
export function dealTables(seats, k, rng = Math.random) {
  const order = shuffle([...seats], rng);
  return tableSizes(order.length, k).map((size) => order.splice(0, size));
}

// 2 move each way, or 1 when any table has only 3 (2 out of 3 would leave one person behind)
export function moveCount(tables) {
  return tables.some((t) => t.length < 4) ? 1 : 2;
}

// A table's seats from best to worst this round: lowest points, then lowest total, then whoever went out, then chance
// (a tie that decides who moves is drawn for instead: tieAtLine)
export function rankTable(seats, { points, totals, wentOut = null }, rng = Math.random) {
  const luck = new Map(seats.map((s) => [s, rng()]));
  return [...seats].sort(
    (a, b) => points[a] - points[b] || totals[a] - totals[b] || (b === wentOut) - (a === wentOut) || luck.get(a) - luck.get(b)
  );
}

// How many at a table end up on the better side of the line between moving and staying: at the winners' table
// everyone but the worst m stays, at any other table the best m move up
export function moveLine(k, size, m) {
  return k === 0 ? size - m : m;
}

// A tie across that line: the people level on both this round's points and their total, with some of them on each
// side. They draw cards for it. need: how many of them get the better side. null when there's no such tie.
export function tieAtLine(ranked, line, { points, totals }) {
  if (line <= 0 || line >= ranked.length) return null;
  const level = (a, b) => points[a] === points[b] && totals[a] === totals[b];
  const at = ranked[line - 1];
  if (!level(at, ranked[line])) return null;
  const seats = ranked.filter((s) => level(s, at));
  return { seats, need: line - ranked.indexOf(seats[0]) };
}

// A card drawn for a tie, from one deck without jokers; aces are high
export const drawValue = (c) => (c.r === 1 ? 14 : c.r);

// A card for a tie's draw from one deck without jokers, not one already drawn (taken)
export function drawCard(taken, rng = Math.random) {
  const left = [];
  for (const s of SUITS) for (let r = 1; r <= 13; r++) if (!taken.some((c) => c.r === r && c.s === s)) left.push({ id: -1 - left.length, r, s });
  return left[Math.floor(rng() * left.length)];
}

// After everyone tied has drawn: high card loses, so the lowest cards take the better side. Those level on the card
// right at the line draw again (again, for need more places); everyone else is settled, best first.
export function settleDraw(seats, cards, need) {
  const v = (s) => drawValue(cards[s]);
  const sorted = [...seats].sort((a, b) => v(a) - v(b));
  const cut = v(sorted[need - 1]);
  if (cut !== v(sorted[need])) return { good: sorted.slice(0, need), bad: sorted.slice(need), again: [], need: 0 };
  const good = sorted.filter((s) => v(s) < cut);
  return { good, bad: sorted.filter((s) => v(s) > cut), again: sorted.filter((s) => v(s) === cut), need: need - good.length };
}

// Next round's tables from this round's, each already ranked best first (rankTable). Everyone who stays keeps their
// place at the front, and the people arriving go after them. moves: seat -> { from, to } for everyone who moves.
export function nextTables(ranked) {
  const m = moveCount(ranked);
  const k = ranked.length;
  const next = ranked.map((t, i) => (i === 0 ? t.slice(0, t.length - m) : t.slice(m)));
  const moves = {};
  const move = (seats, from, to) => {
    next[to].push(...seats);
    for (const s of seats) moves[s] = { from, to };
  };
  for (let i = 1; i < k; i++) move(ranked[i].slice(0, m), i, i - 1);
  move(ranked[0].slice(ranked[0].length - m), 0, k - 1);
  return { tables: next, moves };
}

// Where each seat at one table goes next, from that table's ranking alone (the same as nextTables): seat -> table
export function movesFrom(ranked, k, tableCount, m) {
  const to = {};
  ranked.forEach((s, i) => {
    if (k === 0) to[s] = i >= ranked.length - m ? tableCount - 1 : 0;
    else to[s] = i < m ? k - 1 : k;
  });
  return to;
}

// Which table each seat sits at in a round: seat -> table
export function tableOf(tables) {
  const at = {};
  tables.forEach((t, i) => t.forEach((s) => (at[s] = i)));
  return at;
}

// Rounds at the winners' table, and the longest stay at one table (a run of rounds in a row; counted only from 2, since
// one round anywhere isn't a stay), from the table each seat sat at in each round so far
export function tableStats(history, seat) {
  const at = history.map((round) => round[seat]).filter((t) => t != null);
  let longest = 0;
  let run = 0;
  let table = null;
  at.forEach((t, i) => {
    run = i > 0 && at[i - 1] === t ? run + 1 : 1;
    if (run > longest) [longest, table] = [run, t];
  });
  return { topRounds: at.filter((t) => t === 0).length, longestStay: longest >= 2 ? longest : 0, stayTable: longest >= 2 ? table : null };
}
