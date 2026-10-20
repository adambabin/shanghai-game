import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSet, buildRun, addCards, fitsAnyMeld, runHi, placements, couldBeSet, couldBeRun, arrangeRun } from '../js/melds.js';
import { wildTest } from '../js/cards.js';
import { createGame, applyAction, viewFor, totals, nextRound, buyTimeout, buyAsking, mustDecideOnDiscard } from '../js/engine.js';

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
  assert.deepEqual(placements(low, J(), isWild), [], 'no joker next to a joker');
});

test('jokers stay where you put them; more real cards than jokers; no jokers side by side', () => {
  const front = buildRun([J(), c(8, 'H'), c(9, 'H'), c(10, 'H')], isWild);
  assert.equal(front.lo, 7, 'joker first means the joker is the 7');
  const back = buildRun([c(8, 'H'), c(9, 'H'), c(10, 'H'), J()], isWild);
  assert.equal(back.lo, 8);
  const desc = buildRun([c(10, 'H'), c(9, 'H'), c(8, 'H'), J()], isWild);
  assert.equal(desc.lo, 7, 'high-to-low order works too');
  assert.equal(buildRun([c(5, 'H'), c(6, 'H'), J(), J()], isWild), null, 'needs 3 real cards');
  const spread = buildRun([c(5, 'H'), c(6, 'H'), c(7, 'H'), J(), J()], isWild);
  assert.deepEqual(spread.cards.map((x) => x.r), [0, 5, 6, 7, 0], 'two jokers together are split onto both ends');
  assert.ok(buildRun([J(), c(5, 'H'), c(6, 'H'), c(7, 'H'), J()], isWild), 'jokers apart is fine');
  assert.equal(buildSet([c(7, 'S'), c(7, 'H'), J(), J()], isWild), null, 'set needs more real cards too');
  const set = buildSet([c(7, 'S'), c(7, 'H'), J()], isWild);
  assert.deepEqual(placements(set, J(), isWild), [], "can't add a joker that ties the count");
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

// Draws from the deck, first letting others buy the discard (nobody does) as the rules require.
function deckDraw(g, seat) {
  if (mustDecideOnDiscard(g)) applyAction(g, seat, { type: 'allowBuy' });
  while (g.buyWindow) buyTimeout(g);
  return applyAction(g, seat, { type: 'drawDeck' });
}

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
  assert.ok(deckDraw(g, 0).ok);
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
  assert.ok(!g.blocked[0], 'no more blocking after a wrong call');
  assert.equal(applyAction(g, 2, { type: 'shanghai' }).result, 'hit');
  assert.equal(g.hands[0].length, before + 2 + 2);
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
  deckDraw(g, 0);
  applyAction(g, 0, { type: 'layDown', groups: [{ type: 'set', ids: [p0[0].id, p0[1].id, p0[2].id] }, { type: 'set', ids: [p0[3].id, p0[4].id, p0[5].id] }] });
  assert.ok(applyAction(g, 0, { type: 'discard', id: p0[6].id, declare: true }).ok);
  assert.ok(g.topDead);
  assert.equal(applyAction(g, 1, { type: 'shanghai' }).result, 'miss');
  assert.ok(!applyAction(g, 1, { type: 'drawDiscard' }).ok);
  deckDraw(g, 1);
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
  deckDraw(g, 0);
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

test('buying goes around in turn order, one player at a time; card + 2 extra; exposed card is offered again', () => {
  const hands = [0, 1, 2, 3].map(() => Array.from({ length: 11 }, (_, i) => c((i % 13) + 1, 'D')));
  const under = c(4, 'C');
  const g = rigged(hands, { discard: [under, c(7, 'S')] });
  g.turn = 1;
  assert.ok(!applyAction(g, 3, { type: 'buyAnswer', buy: true }).ok, 'no buying until allowed');
  assert.ok(applyAction(g, 1, { type: 'allowBuy' }).ok);
  assert.deepEqual(g.buyWindow.order, [2, 3, 0], 'clockwise from the player after the current one');
  assert.ok(!applyAction(g, 1, { type: 'drawDeck' }).ok, 'current player waits for buyers');
  assert.ok(!applyAction(g, 3, { type: 'buyAnswer', buy: true }).ok, "seat 3 can't jump ahead of seat 2");
  assert.ok(applyAction(g, 2, { type: 'buyAnswer', buy: false }).ok);
  assert.equal(buyAsking(g), 3);
  buyTimeout(g); // seat 3 doesn't answer
  assert.equal(buyAsking(g), 0);
  assert.ok(applyAction(g, 0, { type: 'buyAnswer', buy: true }).ok);
  assert.equal(g.buyWindow, null);
  assert.equal(g.hands[0].length, 14, 'card + 2 extra');
  assert.equal(g.buysUsed[0], 1);
  // the 4C underneath is exposed and offered again: take it, or allow buying again
  assert.equal(g.discard[g.discard.length - 1].id, under.id);
  assert.ok(mustDecideOnDiscard(g));
  assert.ok(!applyAction(g, 1, { type: 'drawDeck' }).ok);
  assert.ok(applyAction(g, 1, { type: 'drawDiscard' }).ok, 'current player can take the exposed card');

  // nobody buys: current player can still take the discard
  applyAction(g, 1, { type: 'discard', id: g.hands[1][0].id });
  g.buysUsed[3] = 2;
  applyAction(g, 2, { type: 'allowBuy' });
  assert.deepEqual(g.buyWindow.order, [0], 'seat 3 is out of buys and seat 1 discarded it');
  applyAction(g, 0, { type: 'buyAnswer', buy: false });
  assert.equal(g.buyWindow, null);
  assert.ok(applyAction(g, 2, { type: 'drawDiscard' }).ok);
});

test('a bought-out dead card underneath comes back to life', () => {
  const hands = [0, 1, 2].map(() => Array.from({ length: 5 }, (_, i) => c(i + 2, 'H')));
  const g = rigged(hands, { discard: [c(9, 'C'), c(10, 'C')] });
  g.turn = 1;
  g.topDead = false;
  applyAction(g, 1, { type: 'allowBuy' });
  applyAction(g, 2, { type: 'buyAnswer', buy: true });
  assert.ok(!g.topDead);
  assert.ok(applyAction(g, 1, { type: 'drawDiscard' }).ok);
});

test('rounds start with everyone looking at their cards until all are ready', () => {
  const g = createGame([{ name: 'a' }, { name: 'b' }, { name: 'bot', bot: true }]);
  assert.equal(g.phase, 'ready');
  assert.ok(!applyAction(g, g.turn, { type: 'drawDeck' }).ok);
  applyAction(g, 0, { type: 'ready' });
  assert.equal(g.phase, 'ready');
  applyAction(g, 1, { type: 'ready' });
  assert.equal(g.phase, 'draw', 'computers are always ready');
});

test('Shanghai counts on anyone, laid down or not; a self-Shanghai that is not one stays live', () => {
  const p0 = [c(4, 'S'), c(4, 'H'), c(4, 'D'), c(9, 'S'), c(9, 'H'), c(9, 'C'), c(8, 'S'), c(12, 'D')];
  const p1 = [c(4, 'C'), c(3, 'D'), c(6, 'C'), c(7, 'C'), c(13, 'S')];
  const p2 = [c(2, 'H'), c(3, 'H'), c(6, 'S'), c(7, 'S'), c(10, 'S')];
  const g = rigged([p0, p1, p2]);
  deckDraw(g, 0);
  applyAction(g, 0, { type: 'layDown', groups: [{ type: 'set', ids: [p0[0].id, p0[1].id, p0[2].id] }, { type: 'set', ids: [p0[3].id, p0[4].id, p0[5].id] }] });
  applyAction(g, 0, { type: 'discard', id: p0[6].id });
  // p1 (not laid down) discards the 4C, which fits on p0's 4s
  deckDraw(g, 1);
  applyAction(g, 1, { type: 'discard', id: p1[0].id });
  assert.equal(applyAction(g, 2, { type: 'shanghai' }).result, 'hit');
  assert.equal(g.hands[1].length, 5 + 2);
  // p2 says Shanghai on the 2H, which fits nowhere: no penalty, card stays live
  deckDraw(g, 2);
  applyAction(g, 2, { type: 'discard', id: p2[0].id, declare: true });
  assert.ok(!g.topDead);
  assert.equal(g.log[g.log.length - 1].kind, 'notshanghai');
  assert.ok(applyAction(g, 0, { type: 'drawDiscard' }).ok);
});

test('a discard that could swap out a joker is a Shanghai', () => {
  const run = { id: 1, owner: 0, type: 'run', suit: 'S', lo: 7, cards: [c(7, 'S'), c(8, 'S'), J(), c(10, 'S')] };
  assert.ok(fitsAnyMeld(c(9, 'S'), [run], isWild));
  assert.ok(!fitsAnyMeld(c(9, 'H'), [run], isWild));
});

test('swapping a natural card for a wild in a run, which then must be played', () => {
  const p0 = [c(5, 'H'), c(6, 'H'), c(0, 'J'), c(8, 'H'), c(9, 'S'), c(9, 'H'), c(9, 'C'), c(7, 'H'), c(3, 'D'), c(12, 'S')];
  const p1 = [c(2, 'H'), c(3, 'C'), c(6, 'C'), c(7, 'C')];
  const g = rigged([p0, p1]);
  g.round = 1; // 1 set + 1 run
  deckDraw(g, 0);
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

test('staging partial groups', () => {
  assert.ok(couldBeSet([c(7, 'S'), c(7, 'H')], isWild));
  assert.ok(!couldBeSet([c(7, 'S'), c(8, 'S')], isWild));
  assert.ok(couldBeRun([c(7, 'S'), c(9, 'S')], isWild));
  assert.ok(!couldBeRun([c(7, 'S'), c(9, 'H')], isWild));
  assert.ok(!couldBeRun([c(7, 'S'), c(7, 'S')], isWild));
  assert.ok(couldBeSet([c(7, 'S'), J()], isWild) && couldBeRun([c(7, 'S'), J()], isWild), 'a joker and one card could be either');
  // J in front of 8, 9; then add a 10: joker stays in front
  const joker = J();
  const order = arrangeRun([joker, c(8, 'H'), c(9, 'H')], [c(10, 'H')], isWild);
  assert.deepEqual(order.map((x) => x.r), [0, 8, 9, 10]);
  assert.equal(buildRun(order, isWild).lo, 7);
  // adding a lower card slots it in before
  assert.deepEqual(arrangeRun([c(8, 'H'), c(9, 'H')], [c(6, 'H'), J()], isWild).map((x) => x.r), [6, 8, 9, 0]);
});

test('view hides other hands', () => {
  const g = createGame([{ name: 'a' }, { name: 'b' }]);
  const v = viewFor(g, 0);
  assert.equal(v.hand.length, 11);
  assert.equal(v.players[1].cards, 11);
  assert.ok(!JSON.stringify(v).includes('"deck"'));
});

test('undo puts a picked-up discard back so you can choose again', () => {
  const p0 = [c(4, 'S'), c(5, 'H'), c(9, 'D')];
  const p1 = [c(1, 'H'), c(13, 'D'), c(5, 'C')];
  const g = rigged([p0, p1], { deck: [c(9, 'C'), c(10, 'C')] });
  const top = g.discard[g.discard.length - 1];
  assert.ok(viewFor(g, 0).mustDecide);
  assert.ok(applyAction(g, 0, { type: 'drawDiscard' }).ok);
  assert.ok(viewFor(g, 0).canUndo);
  assert.ok(applyAction(g, 0, { type: 'undo' }).ok);
  assert.equal(g.phase, 'draw');
  assert.equal(g.hands[0].length, 3);
  assert.equal(g.discard[g.discard.length - 1].id, top.id);
  // back to the choice: no deck draw until others get the chance to buy
  assert.ok(viewFor(g, 0).mustDecide);
  assert.ok(!applyAction(g, 0, { type: 'drawDeck' }).ok);
  deckDraw(g, 0);
  assert.equal(g.phase, 'play');
  assert.equal(g.hands[0].length, 4);
});

test('the host can pick how many decks: 3 by default, 3 to 6, two jokers each', () => {
  const total = (g) => g.deck.length + g.discard.length + g.hands.reduce((n, h) => n + h.length, 0);
  const jokers = (g) => [...g.deck, ...g.discard, ...g.hands.flat()].filter((c) => c.r === 0).length;
  const players = [{ name: 'A' }, { name: 'B' }];
  const g3 = createGame(players, {}, () => 0.5);
  assert.equal(total(g3), 3 * 54);
  assert.equal(jokers(g3), 6);
  const g5 = createGame(players, { decks: 5 }, () => 0.5);
  assert.equal(total(g5), 5 * 54);
  assert.equal(jokers(g5), 10);
  // out-of-range values are clamped, and every card id is unique
  assert.equal(total(createGame(players, { decks: 1 }, () => 0.5)), 3 * 54);
  const g9 = createGame(players, { decks: 9 }, () => 0.5);
  assert.equal(total(g9), 6 * 54);
  const ids = [...g9.deck, ...g9.discard, ...g9.hands.flat()].map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});
