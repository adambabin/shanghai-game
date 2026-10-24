// Tables (BETA): a big group plays at several tables at once, all through the same 7 rounds. After each round the best
// at each table move up a table, except at the winners' table (table 1), where they stay. The rest stay put, except the
// worst at the winners' table, who drop all the way to the losers' table. Lowest total over the 7 rounds wins.
// Tables are numbered from 0 here (0 is the winners' table); seats are the lobby's seat numbers.

import { shuffle } from './cards.js';

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
export function rankTable(seats, { points, totals, wentOut = null }, rng = Math.random) {
  const luck = new Map(seats.map((s) => [s, rng()]));
  return [...seats].sort(
    (a, b) => points[a] - points[b] || totals[a] - totals[b] || (b === wentOut) - (a === wentOut) || luck.get(a) - luck.get(b)
  );
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
