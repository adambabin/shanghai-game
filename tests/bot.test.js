import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choosePlay, wantsToBuy, shanghaiReaction } from '../js/bot.js';
import { buildSet, buildRun } from '../js/melds.js';
import { wildTest } from '../js/cards.js';
import { DEFAULT_OPTIONS, botLevelFor } from '../js/rules.js';

let nextId = 1000;
const card = (r, s) => ({ id: nextId++, r, s });
const always = () => 0; // every chance comes true
const never = () => 0.99; // no chance comes true

// A play-phase or buy view for seat 0, built by hand the way viewFor shapes it.
function view(level, { hand, melds = [], laid = false, round = 0, top = null, options = {} }) {
  return {
    you: 0,
    options: { ...DEFAULT_OPTIONS, botLevel: level, ...options },
    players: [
      { name: 'Bot', bot: true, laid, buysUsed: 0, blocked: false },
      { name: 'Lou', bot: false, laid: true, buysUsed: 0, blocked: false },
    ],
    round,
    phase: top ? 'draw' : 'play',
    hand,
    melds: melds.map((m, i) => ({ ...m, id: i + 1 })),
    mustPlay: [],
    discardTop: top,
    topDead: false,
    buyEligible: top ? [0] : [],
    buyOffered: false,
    buyWindow: null,
  };
}

const isWild = wildTest(DEFAULT_OPTIONS);
const kings = () => buildSet([card(13, 'S'), card(13, 'H'), card(13, 'D')], isWild);

test('older games without a skill setting play on normal', () => {
  assert.equal(botLevelFor({}), 'normal');
  assert.equal(botLevelFor({ botLevel: 'bogus' }), 'normal');
  assert.equal(botLevelFor({ botLevel: 'easy' }), 'easy');
});

test('hard computers always say Shanghai on their own playable discard, easy ones often forget', () => {
  // not down yet: the king is the card to throw, and it fits the kings on the table
  const hand = () => [card(3, 'H'), card(5, 'D'), card(8, 'S'), card(13, 'C')];
  const throwKing = (level, rng) => {
    const h = hand();
    const a = choosePlay(view(level, { hand: h, melds: [kings()] }), rng);
    assert.equal(a.type, 'discard');
    assert.equal(a.id, h[3].id);
    return a.declare;
  };
  assert.equal(throwKing('hard', never), true);
  assert.equal(throwKing('normal', never), false);
  assert.equal(throwKing('normal', always), true);
  assert.equal(throwKing('easy', never), false);
});

test('easy computers sometimes hold on to a card they could play', () => {
  const run = buildRun([card(5, 'H'), card(6, 'H'), card(7, 'H'), card(8, 'H')], isWild);
  const hand = () => [card(9, 'H'), card(3, 'S'), card(4, 'D'), card(10, 'C')];
  assert.equal(choosePlay(view('normal', { hand: hand(), melds: [run], laid: true }), never).type, 'addToMeld');
  assert.equal(choosePlay(view('easy', { hand: hand(), melds: [run], laid: true }), never).type, 'discard');
  assert.equal(choosePlay(view('easy', { hand: hand(), melds: [run], laid: true }), always).type, 'addToMeld');
});

test('easy computers still go out when they can', () => {
  const set = kings();
  const hand = [card(13, 'C'), card(13, 'S')];
  const a = choosePlay(view('easy', { hand, melds: [set], laid: true }), never);
  assert.equal(a.type, 'addToMeld');
});

test('hard computers pass on a buy that only adds to a big hand', () => {
  // a third 7 is worth buying for a normal computer, but hard weighs 3 extra cards on top of 15 already held
  const hand = [card(7, 'S'), card(7, 'H'), card(9, 'D')];
  for (const r of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13]) hand.push(card(r, 'C'));
  const top = card(7, 'D');
  const opts = { hand, top, options: { buyPenalty: 3 } };
  assert.equal(wantsToBuy(view('normal', opts), never), true);
  assert.equal(wantsToBuy(view('hard', opts), never), false);
  // a small hand with the usual 2 extra cards: hard buys it too
  const small = { hand: [card(7, 'S'), card(7, 'H'), card(2, 'C'), card(4, 'D')], top: card(7, 'C') };
  assert.equal(wantsToBuy(view('hard', small), never), true);
});

test('easy computers sometimes get a buy answer backwards', () => {
  const opts = { hand: [card(7, 'S'), card(7, 'H'), card(2, 'C'), card(4, 'D')], top: card(7, 'C') };
  assert.equal(wantsToBuy(view('easy', opts), never), true);
  assert.equal(wantsToBuy(view('easy', opts), always), false);
});

test('easy computers call Shanghai on you less often and later', () => {
  const easy = shanghaiReaction({ botLevel: 'easy' }, () => 0.6);
  const hard = shanghaiReaction({ botLevel: 'hard' }, () => 0.6);
  assert.equal(easy.calls, false);
  assert.equal(hard.calls, true);
  assert.ok(easy.delay > hard.delay);
});

test('with 2 cards left, a computer only plays one if the last card can go out after it (not just swap for a wild)', () => {
  // the 6♠ fits the end of 7-J♠, and the 5♦ could only take the joker's place in 3♦ 4♦ ★ 6♦: playing the 6♠ would
  // leave a card that can't go out, so the computer used to play it, take it back, play it again, forever
  const spades = buildRun([7, 8, 9, 10, 11].map((r) => card(r, 'S')), isWild);
  const diamonds = buildRun([card(3, 'D'), card(4, 'D'), card(0, 'J'), card(6, 'D')], isWild);
  const six = card(6, 'S');
  const five = card(5, 'D');
  for (const level of ['easy', 'normal', 'hard']) {
    const a = choosePlay(view(level, { hand: [six, five], melds: [spades, diamonds], laid: true }), always);
    assert.equal(a.type, 'discard', level);
  }
  // but when the last card does fit an end, it plays and goes out
  const queen = card(12, 'S');
  const a = choosePlay(view('normal', { hand: [six, queen], melds: [spades, diamonds], laid: true }), always);
  assert.equal(a.type, 'addToMeld');
});
