import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSet, buildRun, addCards, fitsAnyMeld, runHi, placements } from '../js/melds.js';
import { wildTest } from '../js/cards.js';
import { createGame, applyAction, viewFor, totals, nextRound, resolveBuyWindow } from '../js/engine.js';

const isWild = wildTest({ twoClubsWild: false });
let nid = 1000;
const c = (r, s) => ({ id: nid++, r, s });
const J = () => c(0, 'J');

test('sets need 3 cards with at least 2 naturals of one rank', () => {
  assert.ok(buildSet([c(7, 'S'), c(7, 'H'), c(7, 'D')], isWild));
  assert.ok(buildSet([c(7, 'S'), c(7, 'H'), J()], isWild));
  assert.equal(buildSet([c(7, 'S'), J(), J()], isWild), null);
  assert.equal(buildSet([c(7, 'S'), c(8, 'H'), c(7, 'D')], isWild), null);
  assert.equal(buildSet([c(7, 'S'), c(7, 'H')], isWild), null);
});

test('2 of clubs is not wild by default', () => {
  assert.equal(buildSet([c(7, 'S'), c(7, 'H'), c(2, 'C')], isWild), null);
  const wild2 = wildTest({ twoClubsWild: true });
  assert.ok(buildSet([c(7, 'S'), c(7, 'H'), c(2, 'C')], wild2));
});

test('runs: 4+ same suit, wilds fill gaps, aces only high', () => {
  const r = buildRun([c(5, 'H'), c(6, 'H'), c(8, 'H'), J()], isWild);
  assert.equal(r.lo, 5);
  assert.equal(runHi(r), 8);
  assert.equal(r.cards[3].r, 8);
  assert.equal(buildRun([c(1, 'S'), c(2, 'S'), c(3, 'S'), c(4, 'S')], isWild), null, 'ace is not low');
  const high = buildRun([c(11, 'S'), c(12, 'S'), c(13, 'S'), c(1, 'S')], isWild);
  assert.equal(runHi(high), 14);
  assert.equal(buildRun([c(12, 'S'), c(13, 'S'), c(1, 'S'), c(2, 'S')], isWild), null);
  assert.equal(buildRun([c(5, 'H'), c(6, 'D'), c(7, 'H'), c(8, 'H')], isWild), null);
  assert.equal(buildRun([c(5, 'H'), J(), J(), c(9, 'H')], isWild), null);
  assert.equal(buildRun([c(5, 'H'), c(6, 'H'), c(7, 'H')], isWild), null);
  // a spare wild can't sit below the 2
  const low = buildRun([c(2, 'C'), c(3, 'C'), c(4, 'C'), J()], isWild, 'low');
  assert.equal(low.lo, 2);
  assert.equal(runHi(low), 5);
  assert.deepEqual(placements(low, c(1, 'C'), isWild), []);
  assert.deepEqual(placements(low, J(), isWild), ['high']);
});

test('spare wilds in a run go to the chosen end', () => {
  const hi = buildRun([c(5, 'H'), c(6, 'H'), c(7, 'H'), J()], isWild, 'high');
  assert.equal(hi.lo, 5);
  const lo = buildRun([c(5, 'H'), c(6, 'H'), c(7, 'H'), J()], isWild, 'low');
  assert.equal(lo.lo, 4);
});

test('adding cards to melds', () => {
  const run = { ...buildRun([c(5, 'H'), c(6, 'H'), c(7, 'H'), c(8, 'H')], isWild), id: 1, owner: 0 };
  const more = addCards(run, [c(10, 'H'), J()], isWild);
  assert.equal(runHi(more), 10);
  assert.equal(addCards(run, [c(10, 'H')], isWild), null);
  assert.equal(addCards(run, [c(9, 'S')], isWild), null);
  const set = { ...buildSet([c(7, 'S'), c(7, 'H'), c(7, 'D')], isWild), id: 2, owner: 0 };
  assert.ok(addCards(set, [c(7, 'C')], isWild));
  assert.ok(fitsAnyMeld(c(4, 'H'), [run, set], isWild));
  assert.ok(fitsAnyMeld(c(7, 'C'), [run, set], isWild));
  assert.ok(!fitsAnyMeld(c(2, 'C'), [run, set], isWild));
});

// Builds a game, then overwrites hands and piles so a scenario is predictable.
function rigged(hands, { discard = [c(13, 'C')], deck } = {}) {
  const g = createGame(hands.map((_, i) => ({ name: 'P' + i })), {}, () => 0.5);
  g.hands = hands;
  g.discard = discard;
  g.deck = deck || Array.from({ length: 40 }, (_, i) => c((i % 13) + 1, 'S'));
  g.turn = 0;
  g.phase = 'draw';
  return g;
}

test('round 1 lay down, play on piles, and Shanghai call penalties', () => {
  const p0 = [c(4, 'S'), c(4, 'H'), c(4, 'D'), c(9, 'S'), c(9, 'H'), c(9, 'C'), c(4, 'C'), c(12, 'D'), c(3, 'H'), c(5, 'D'), c(6, 'D')];
  const p1 = Array.from({ length: 11 }, (_, i) => c((i % 6) + 2, 'H'));
  const p2 = Array.from({ length: 11 }, (_, i) => c((i % 6) + 2, 'D'));
  const g = rigged([p0, p1, p2]);
  assert.ok(applyAction(g, 0, { type: 'drawDeck' }).ok);
  const lay = applyAction(g, 0, {
    type: 'layDown',
    groups: [
      { type: 'set', ids: [p0[0].id, p0[1].id, p0[2].id] },
      { type: 'set', ids: [p0[3].id, p0[4].id, p0[5].id] },
    ],
  });
  assert.ok(lay.ok, lay.error);
  // discard the 4C, which would fit on the set of 4s: no declaration, so it's a Shanghai
  assert.ok(applyAction(g, 0, { type: 'discard', id: p0[6].id }).ok);
  const before = g.hands[0].length;
  // p0 themselves calling doesn't count
  assert.equal(applyAction(g, 0, { type: 'shanghai' }).result, 'miss');
  assert.equal(g.hands[0].length, before + 2);
  assert.ok(g.blocked[0]);
  assert.ok(!applyAction(g, 0, { type: 'shanghai' }).ok, 'blocked caller cannot call again');
  assert.equal(applyAction(g, 2, { type: 'shanghai' }).result, 'hit');
  assert.equal(g.hands[0].length, before + 2 + 3);
  assert.ok(g.topDead);
  assert.ok(!applyAction(g, 1, { type: 'drawDiscard' }).ok, 'dead card cannot be picked up');
  assert.ok(!applyAction(g, 2, { type: 'buy' }).ok, 'dead card cannot be bought');
  // a second call on the same card is a false call
  assert.equal(applyAction(g, 1, { type: 'shanghai' }).result, 'miss');
});

test('declared Shanghai discard is dead, no penalty, live again once covered and uncovered', () => {
  const p0 = [c(4, 'S'), c(4, 'H'), c(4, 'D'), c(9, 'S'), c(9, 'H'), c(9, 'C'), c(4, 'C'), c(12, 'D'), c(3, 'H')];
  const p1 = [c(2, 'H'), c(3, 'D'), c(6, 'C'), c(7, 'C'), c(8, 'S')];
  const g = rigged([p0, p1]);
  applyAction(g, 0, { type: 'drawDeck' });
  applyAction(g, 0, { type: 'layDown', groups: [{ type: 'set', ids: [p0[0].id, p0[1].id, p0[2].id] }, { type: 'set', ids: [p0[3].id, p0[4].id, p0[5].id] }] });
  assert.ok(applyAction(g, 0, { type: 'discard', id: p0[6].id, declare: true }).ok);
  assert.ok(g.topDead);
  assert.equal(applyAction(g, 1, { type: 'shanghai' }).result, 'miss');
  assert.ok(!applyAction(g, 1, { type: 'drawDiscard' }).ok);
  applyAction(g, 1, { type: 'drawDeck' });
  applyAction(g, 1, { type: 'discard', id: p1[0].id });
  assert.ok(!g.topDead);
  // p0 takes the covering card; the formerly dead 4C is now on top and live
  assert.ok(applyAction(g, 0, { type: 'drawDiscard' }).ok);
  assert.ok(!g.topDead);
  assert.equal(g.discard[g.discard.length - 1].id, p0[6].id);
});

test('cannot discard your last card; undo takes plays back; going out on two piles ends the round', () => {
  const p0 = [c(4, 'S'), c(4, 'H'), c(4, 'D'), c(9, 'S'), c(9, 'H'), c(9, 'C'), c(4, 'C')];
  const p1 = [c(1, 'H'), c(13, 'D'), c(5, 'C'), c(0, 'J')];
  const g = rigged([p0, p1], { deck: [c(9, 'D')] });
  applyAction(g, 0, { type: 'drawDeck' });
  assert.ok(applyAction(g, 0, { type: 'layDown', groups: [{ type: 'set', ids: [p0[0].id, p0[1].id, p0[2].id] }, { type: 'set', ids: [p0[3].id, p0[4].id, p0[5].id] }] }).ok);
  assert.equal(g.hands[0].length, 2);
  const four = g.hands[0].find((x) => x.r === 4);
  const nine = g.hands[0].find((x) => x.r === 9);
  assert.ok(applyAction(g, 0, { type: 'addToMeld', meldId: g.melds[0].id, ids: [four.id] }).ok);
  const d = applyAction(g, 0, { type: 'discard', id: nine.id });
  assert.ok(!d.ok);
  assert.match(d.error, /go out on a discard/);
  // undo puts the 4 back
  assert.ok(applyAction(g, 0, { type: 'undo' }).ok);
  assert.equal(g.hands[0].length, 2);
  assert.equal(g.melds[0].cards.length, 3);
  assert.ok(applyAction(g, 0, { type: 'undo' }).ok);
  assert.equal(g.melds.length, 0);
  assert.ok(!g.laid[0]);
  assert.equal(g.hands[0].length, 8);
  // redo it properly and go out across both piles
  applyAction(g, 0, { type: 'layDown', groups: [{ type: 'set', ids: [p0[0].id, p0[1].id, p0[2].id] }, { type: 'set', ids: [p0[3].id, p0[4].id, p0[5].id] }] });
  applyAction(g, 0, { type: 'addToMeld', meldId: g.melds[0].id, ids: [four.id] });
  assert.ok(applyAction(g, 0, { type: 'addToMeld', meldId: g.melds[1].id, ids: [nine.id] }).ok);
  assert.equal(g.phase, 'roundOver');
  assert.deepEqual(g.scores[1], [20 + 10 + 5 + 50]);
  assert.equal(g.scores[0][0], 0);
  assert.ok(nextRound(g).ok);
  assert.equal(g.round, 1);
  assert.deepEqual(totals(g), [0, 85]);
});

test('buying: only after the current player allows it; closest buyer wins; card + 2 extra; limit of 2', () => {
  const hands = [0, 1, 2, 3].map(() => Array.from({ length: 11 }, (_, i) => c((i % 13) + 1, 'D')));
  const g = rigged(hands, { discard: [c(7, 'S')] });
  g.turn = 1;
  assert.ok(!applyAction(g, 3, { type: 'buyAnswer', buy: true }).ok, 'no buying until allowed');
  assert.ok(applyAction(g, 1, { type: 'allowBuy' }).ok);
  assert.deepEqual(g.buyWindow.eligible, [0, 2, 3]);
  assert.ok(!applyAction(g, 1, { type: 'drawDeck' }).ok, 'current player waits for buyers');
  applyAction(g, 3, { type: 'buyAnswer', buy: true });
  assert.ok(g.buyWindow, 'still waiting on seat 2, who is ahead of seat 3');
  applyAction(g, 2, { type: 'buyAnswer', buy: true });
  assert.equal(g.buyWindow, null, 'seat 2 is closest, so it resolves at once');
  assert.equal(g.hands[2].length, 14);
  assert.equal(g.hands[3].length, 11);
  assert.equal(g.buysUsed[2], 1);
  assert.ok(!applyAction(g, 1, { type: 'drawDiscard' }).ok, 'after a buy the current player draws from the deck');
  assert.ok(applyAction(g, 1, { type: 'drawDeck' }).ok);

  // nobody buys before the timeout: current player can still take the discard
  applyAction(g, 1, { type: 'discard', id: g.hands[1][0].id });
  g.buysUsed[3] = 2;
  applyAction(g, 2, { type: 'allowBuy' });
  assert.deepEqual(g.buyWindow.eligible, [0], 'seat 3 is out of buys and seat 1 discarded it');
  resolveBuyWindow(g, true);
  assert.equal(g.buyWindow, null);
  assert.ok(applyAction(g, 2, { type: 'drawDiscard' }).ok);
});

test('Shanghai counts on anyone, laid down or not; a self-Shanghai that is not one stays live', () => {
  const p0 = [c(4, 'S'), c(4, 'H'), c(4, 'D'), c(9, 'S'), c(9, 'H'), c(9, 'C'), c(8, 'S'), c(12, 'D')];
  const p1 = [c(4, 'C'), c(3, 'D'), c(6, 'C'), c(7, 'C'), c(13, 'S')];
  const p2 = [c(2, 'H'), c(3, 'H'), c(6, 'S'), c(7, 'S'), c(10, 'S')];
  const g = rigged([p0, p1, p2]);
  applyAction(g, 0, { type: 'drawDeck' });
  applyAction(g, 0, { type: 'layDown', groups: [{ type: 'set', ids: [p0[0].id, p0[1].id, p0[2].id] }, { type: 'set', ids: [p0[3].id, p0[4].id, p0[5].id] }] });
  applyAction(g, 0, { type: 'discard', id: p0[6].id });
  // p1 (not laid down) discards the 4C, which fits on p0's 4s
  applyAction(g, 1, { type: 'drawDeck' });
  applyAction(g, 1, { type: 'discard', id: p1[0].id });
  assert.equal(applyAction(g, 2, { type: 'shanghai' }).result, 'hit');
  assert.equal(g.hands[1].length, 5 + 3);
  // p2 says Shanghai on the 2H, which fits nowhere: no penalty, card stays live
  applyAction(g, 2, { type: 'drawDeck' });
  applyAction(g, 2, { type: 'discard', id: p2[0].id, declare: true });
  assert.ok(!g.topDead);
  assert.equal(g.log[g.log.length - 1].kind, 'notshanghai');
  assert.ok(applyAction(g, 0, { type: 'drawDiscard' }).ok);
});

test('swapping a natural card for a wild in a run, which then must be played', () => {
  const p0 = [c(5, 'H'), c(6, 'H'), c(0, 'J'), c(8, 'H'), c(9, 'S'), c(9, 'H'), c(9, 'C'), c(7, 'H'), c(3, 'D'), c(12, 'S')];
  const p1 = [c(2, 'H'), c(3, 'C'), c(6, 'C'), c(7, 'C')];
  const g = rigged([p0, p1]);
  g.round = 1; // 1 set + 1 run
  applyAction(g, 0, { type: 'drawDeck' });
  assert.ok(!applyAction(g, 0, { type: 'swapWild', meldId: 1, id: p0[7].id }).ok);
  assert.ok(applyAction(g, 0, { type: 'layDown', groups: [{ type: 'run', ids: [p0[0].id, p0[1].id, p0[2].id, p0[3].id] }, { type: 'set', ids: [p0[4].id, p0[5].id, p0[6].id] }] }).ok);
  const run = g.melds.find((m) => m.type === 'run');
  assert.ok(!applyAction(g, 0, { type: 'swapWild', meldId: run.id, id: p0[8].id }).ok, '3D does not replace the joker');
  assert.ok(applyAction(g, 0, { type: 'swapWild', meldId: run.id, id: p0[7].id }).ok);
  assert.deepEqual(run.cards.map((x) => x.r), [5, 6, 7, 8]);
  assert.ok(g.hands[0].some((x) => x.r === 0));
  const d = applyAction(g, 0, { type: 'discard', id: p0[9].id });
  assert.ok(!d.ok);
  assert.match(d.error, /wild card you swapped/);
  // undo puts it back
  assert.ok(applyAction(g, 0, { type: 'undo' }).ok);
  assert.equal(run.cards[2].r, 0);
  assert.ok(applyAction(g, 0, { type: 'swapWild', meldId: run.id, id: p0[7].id }).ok);
  const joker = g.hands[0].find((x) => x.r === 0);
  assert.ok(applyAction(g, 0, { type: 'addToMeld', meldId: run.id, ids: [joker.id] }).ok);
  assert.ok(applyAction(g, 0, { type: 'discard', id: p0[9].id }).ok);
});

test('view hides other hands', () => {
  const g = createGame([{ name: 'a' }, { name: 'b' }]);
  const v = viewFor(g, 0);
  assert.equal(v.hand.length, 11);
  assert.equal(v.players[1].cards, 11);
  assert.ok(!JSON.stringify(v).includes('"deck"'));
});
