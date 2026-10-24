// Tables (BETA): splitting a big group into tables, ranking a table's round, and who moves where after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tableRange, suggestTables, tableSizes, dealTables, moveCount, rankTable, nextTables, tableOf, tableStats } from '../js/tournament.js';
import { gameAwards, playerFacts } from '../js/awards.js';

function seeded(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}
const range = (n, from = 0) => Array.from({ length: n }, (_, i) => from + i);

test('how many tables a group can make: 2 or more, each with 3 to 8', () => {
  assert.equal(tableRange(5), null);
  assert.deepEqual(tableRange(6), { min: 2, max: 2 });
  assert.deepEqual(tableRange(16), { min: 2, max: 5 });
  assert.deepEqual(tableRange(17), { min: 3, max: 5 });
  assert.deepEqual(tableRange(32), { min: 4, max: 8 });
  assert.equal(suggestTables(16), 4);
  assert.equal(suggestTables(7), 2);
  assert.equal(suggestTables(30), 8);
});

test('players are split as evenly as they go, bigger tables first', () => {
  assert.deepEqual(tableSizes(14, 3), [5, 5, 4]);
  assert.deepEqual(tableSizes(16, 4), [4, 4, 4, 4]);
  const tables = dealTables(range(14), 3, seeded(3));
  assert.deepEqual(tables.map((t) => t.length), [5, 5, 4]);
  assert.deepEqual(tables.flat().sort((a, b) => a - b), range(14), 'everyone sits at exactly one table');
});

test('2 move each way, or 1 when a table has only 3', () => {
  assert.equal(moveCount([range(4), range(4, 4)]), 2);
  assert.equal(moveCount([range(4), range(3, 4)]), 1);
});

test("a table's round is ranked by points, then total so far, then who went out, then chance", () => {
  const points = { 1: 25, 2: 0, 3: 25, 4: 40 };
  assert.deepEqual(rankTable([1, 2, 3, 4], { points, totals: { 1: 50, 2: 90, 3: 30, 4: 0 } }), [2, 3, 1, 4]);
  // same points and totals: going out wins it
  const even = { 1: 0, 2: 0 };
  assert.deepEqual(rankTable([1, 2], { points: even, totals: even, wentOut: 2 }), [2, 1]);
  // and otherwise it's chance, but always the same for the same luck
  const a = rankTable([1, 2, 3], { points: { 1: 5, 2: 5, 3: 5 }, totals: { 1: 5, 2: 5, 3: 5 } }, seeded(1));
  const b = rankTable([1, 2, 3], { points: { 1: 5, 2: 5, 3: 5 }, totals: { 1: 5, 2: 5, 3: 5 } }, seeded(1));
  assert.deepEqual(a, b);
});

test("the best 2 move up a table; the winners' table keeps its best and drops its worst 2 to the losers' table", () => {
  // each table already ranked best first
  const ranked = [
    ['Rita', 'Rebecca', 'Grandma', 'Theo'],
    ['Lou', 'Ben', 'Shark', 'Mia'],
    ['Sam', 'Adam', 'Ava', 'Nana'],
    ['Max', 'Jo', 'Ellie', 'Kit'],
  ];
  const { tables, moves } = nextTables(ranked);
  assert.deepEqual(tables, [
    ['Rita', 'Rebecca', 'Lou', 'Ben'],
    ['Shark', 'Mia', 'Sam', 'Adam'],
    ['Ava', 'Nana', 'Max', 'Jo'],
    ['Ellie', 'Kit', 'Grandma', 'Theo'],
  ]);
  assert.deepEqual(moves.Adam, { from: 2, to: 1 });
  assert.deepEqual(moves.Grandma, { from: 0, to: 3 }, 'all the way down');
  assert.equal(moves.Rita, undefined, 'the winners at the winners table stay');
  assert.equal(moves.Kit, undefined, 'the losers everywhere else stay');
});

test('at bigger tables the middle stays, and every table keeps its size', () => {
  const ranked = [range(6), range(6, 6), range(5, 12)];
  const { tables } = nextTables(ranked);
  assert.deepEqual(tables.map((t) => t.length), [6, 6, 5]);
  assert.deepEqual(tables[0], [0, 1, 2, 3, 6, 7]);
  assert.deepEqual(tables[2], [14, 15, 16, 4, 5], "table 3's best 2 went up; the winners' table's worst 2 came down");
});

test('with a table of 3, just 1 moves each way', () => {
  const { tables, moves } = nextTables([[0, 1, 2], [3, 4, 5], [6, 7, 8]]);
  assert.deepEqual(tables, [[0, 1, 3], [4, 5, 6], [7, 8, 2]]);
  assert.equal(Object.keys(moves).length, 3);
});

test('with 2 tables the winners and losers just trade', () => {
  const { tables } = nextTables([[0, 1, 2, 3], [4, 5, 6, 7]]);
  assert.deepEqual(tables, [[0, 1, 4, 5], [6, 7, 2, 3]]);
});

test('over many rounds nobody is lost or seated twice', () => {
  const rng = seeded(9);
  let tables = dealTables(range(23), 5, rng);
  for (let r = 0; r < 7; r++) {
    const points = Object.fromEntries(range(23).map((s) => [s, Math.floor(rng() * 100)]));
    const ranked = tables.map((t) => rankTable(t, { points, totals: points }, rng));
    tables = nextTables(ranked).tables;
    assert.deepEqual(tables.flat().sort((a, b) => a - b), range(23));
    assert.deepEqual(tables.map((t) => t.length), [5, 5, 5, 4, 4]);
  }
  assert.deepEqual(tableOf([[3, 1], [2]]), { 3: 0, 1: 0, 2: 1 });
});

test('rounds at the winners table and the longest stay at one table', () => {
  // the table each of 3 seats sat at, round by round
  const history = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 2, 0],
    [0, 2, 0],
  ];
  assert.deepEqual(tableStats(history, 0), { topRounds: 3, longestStay: 2, stayTable: 0 });
  assert.deepEqual(tableStats(history, 1), { topRounds: 0, longestStay: 3, stayTable: 2 });
  assert.deepEqual(tableStats(history, 2), { topRounds: 2, longestStay: 2, stayTable: 0 });
  // never two rounds in a row at the same table: no stay counted
  assert.deepEqual(tableStats([[1], [0], [1]], 0), { topRounds: 1, longestStay: 0, stayTable: null });
});

test('Penthouse and Regular go to the most rounds at the winners table and the longest stay', () => {
  const blank = { caught: 0, caughtBy: 0, shanghaiCards: 0, ownShanghais: 0, falseCalls: 0, buys: 0, buyExtra: 0, jokerSwaps: 0, wentOut: 0 };
  const stats = [
    { ...blank, topRounds: 5, longestStay: 3 },
    { ...blank, topRounds: 1, longestStay: 6 },
    { ...blank, topRounds: 0, longestStay: 0 },
  ];
  const who = Object.fromEntries(gameAwards(stats, [[], [], []]).map((a) => [a.key, a.seats]));
  assert.deepEqual(who.penthouse, [0]);
  assert.deepEqual(who.regular, [1]);
  assert.deepEqual(playerFacts(stats, [[], [], []], 1).map((f) => f.label)[0], 'rounds in a row at one table');
  // a one-table game keeps no table counts, so they never show up there
  const plain = [{ ...blank }, { ...blank, buys: 1 }];
  assert.ok(!gameAwards(plain, [[], []]).some((a) => a.key === 'penthouse' || a.key === 'regular'));
  assert.ok(!playerFacts(plain, [[], []], 0).some((f) => f.key === 'topRounds' || f.key === 'longestStay'));
});
