// How everyone played: who gets each award, ties, and the three numbers on each player's card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gameAwards, playerFacts } from '../js/awards.js';

const blank = () => ({ caught: 0, caughtBy: 0, shanghaiCards: 0, ownShanghais: 0, falseCalls: 0, buys: 0, buyExtra: 0, jokerSwaps: 0, wentOut: 0 });
const stats = (...changes) => changes.map((c) => ({ ...blank(), ...c }));

test('each award goes to whoever has the most, and only if it happened', () => {
  const s = stats({ caught: 5, wentOut: 2 }, { buys: 9, caughtBy: 1 }, { caughtBy: 4, jokerSwaps: 1 });
  const awards = gameAwards(s, [[10, 0], [145, 30], [0, 60]]);
  const who = Object.fromEntries(awards.map((a) => [a.key, a.seats]));
  assert.deepEqual(who, { sheriff: [0], wanted: [2], spender: [1], thief: [2], ouch: [1] });
  assert.equal(awards.find((a) => a.key === 'ouch').n, 145);
});

test('a tie gives the award to everyone tied', () => {
  const awards = gameAwards(stats({ buys: 3 }, { buys: 3 }, { buys: 1 }), [[], [], []]);
  assert.deepEqual(awards.find((a) => a.key === 'spender').seats, [0, 1]);
});

test('games without the counts have no awards', () => {
  assert.deepEqual(gameAwards(null, [[1], [2]]), []);
});

test("a player's card shows their award numbers first, then what else happened, then zeros", () => {
  const s = stats({ caught: 5, wentOut: 2, falseCalls: 1 }, { buys: 1 });
  const scores = [[10], [40]];
  assert.deepEqual(
    playerFacts(s, scores, 0).map((f) => `${f.n} ${f.label}`),
    ['5 Shanghais caught', '1 missed call', '2 rounds won'] // the one missed call wins False Alarm too
  );
  assert.deepEqual(
    playerFacts(s, scores, 1).map((f) => `${f.n} ${f.label}`),
    ['1 buy', '40 worst round', '0 rounds won']
  );
});
