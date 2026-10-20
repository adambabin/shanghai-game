import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, viewFor, nextRound, totals, endRoundNoWinner, buyAsking, beginPlay } from '../js/engine.js';
import { chooseDraw, choosePlay, wantsToBuy, seesShanghai } from '../js/bot.js';

function seeded(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

function playGame(players, seed) {
  const rng = seeded(seed);
  const g = createGame(Array.from({ length: players }, (_, i) => ({ name: 'Bot' + i, bot: true })), {}, rng);
  const stats = { stalled: 0, buys: 0, shanghais: 0, rounds: 0, steps: 0 };
  while (g.phase !== 'gameOver') {
    let steps = 0;
    if (g.phase === 'ready') beginPlay(g);
    while (g.phase === 'draw' || g.phase === 'play') {
      // a round can genuinely deadlock when nobody can go out without discarding; the host can end it
      if (++steps >= 3000) {
        endRoundNoWinner(g);
        stats.stalled++;
        break;
      }
      stats.steps++;
      if (g.phase === 'draw') {
        for (let s = 0; s < players; s++) {
          const v = viewFor(g, s);
          if (seesShanghai(v) && rng() < 0.7) {
            const r = applyAction(g, s, { type: 'shanghai' });
            assert.equal(r.result, 'hit');
            stats.shanghais++;
          }
        }
        if (g.buyWindow) {
          const s = buyAsking(g);
          assert.ok(applyAction(g, s, { type: 'buyAnswer', buy: wantsToBuy(viewFor(g, s)) }).ok);
          continue;
        }
        const before = g.buysUsed.reduce((a, b) => a + b, 0);
        const a = chooseDraw(viewFor(g, g.turn));
        const r = applyAction(g, g.turn, a);
        assert.ok(r.ok, `${a.type}: ${r.error}`);
        stats.buys += g.buysUsed.reduce((a, b) => a + b, 0) - before;
      } else {
        const seat = g.turn;
        const a = choosePlay(viewFor(g, seat));
        const r = applyAction(g, seat, a);
        assert.ok(r.ok, `${a.type}: ${r.error}`);
      }
    }
    stats.rounds++;
    for (const h of g.hands) assert.ok(h.every((c) => c && typeof c.id === 'number'));
    if (g.phase === 'roundOver') nextRound(g);
  }
  return { g, stats };
}

test('bot-only games run to completion without stalls', () => {
  let wentOut = 0;
  let rounds = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const { g, stats } = playGame(3 + (seed % 6), seed);
    assert.equal(stats.rounds, 11);
    assert.equal(g.scores[0].length, 11);
    rounds += 11 - stats.stalled;
    wentOut += g.scores[0].map((_, r) => g.scores.some((s) => s[r] === 0)).filter(Boolean).length;
    assert.ok(totals(g).every((t) => t >= 0));
  }
  // most rounds should end with someone going out
  rounds = 12 * 11;
  assert.ok(wentOut / rounds > 0.85, `only ${wentOut}/${rounds} rounds had a winner`);
});
