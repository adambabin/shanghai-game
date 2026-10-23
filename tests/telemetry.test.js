import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTracker, plainError } from '../js/telemetry.js';

function tracker(opts = {}) {
  const sent = [];
  const t = makeTracker({
    site: 'site-id',
    id: 'anon',
    version: 'abc123',
    page: () => ({ hostname: 'example.github.io', url: '/shanghai-game/' }),
    post: (url, body, closing) => sent.push({ url, body: JSON.parse(body), closing }),
    ...opts,
  });
  return { t, sent };
}

test('events go to Umami in its format, with the version', () => {
  const { t, sent } = tracker();
  t.track('round_end', { round: 3 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://cloud.umami.is/api/send');
  assert.deepEqual(sent[0].body, {
    type: 'event',
    payload: {
      website: 'site-id',
      hostname: 'example.github.io',
      url: '/shanghai-game/',
      id: 'anon',
      name: 'round_end',
      data: { version: 'abc123', round: 3 },
    },
  });
});

test('a page view has no name or data', () => {
  const { t, sent } = tracker();
  t.pageView();
  assert.equal(sent[0].body.payload.name, undefined);
  assert.equal(sent[0].body.payload.data, undefined);
});

test('nothing is sent without a site id or when turned off', () => {
  for (const opts of [{ site: '' }, { enabled: false }]) {
    const { t, sent } = tracker(opts);
    assert.equal(t.track('open'), false);
    t.pageView();
    assert.equal(sent.length, 0);
  }
});

test('sending waits for the page to be idle, except when it is closing', () => {
  const later = [];
  const { t, sent } = tracker({ defer: (fn) => later.push(fn) });
  t.track('open');
  t.trackNow('game_left');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].closing, true);
  later.forEach((fn) => fn());
  assert.equal(sent.length, 2);
});

test('a failing network never throws', async () => {
  const { t } = tracker({ post: () => Promise.reject(new Error('offline')) });
  assert.equal(t.track('open'), true);
  const { t: t2 } = tracker({
    post: () => {
      throw new Error('no fetch');
    },
  });
  assert.doesNotThrow(() => t2.track('open'));
});

test('a page load sends at most 300 events', () => {
  const { t, sent } = tracker();
  for (let i = 0; i < 400; i++) t.track('refused');
  assert.equal(sent.length, 300);
});

test('error messages lose their card names', () => {
  assert.equal(plainError("That isn't a valid run: 5♥ 7♥ Joker"), "That isn't a valid run: #");
  assert.equal(plainError("10♣ can't go on that set."), "# can't go on that set.");
  assert.equal(plainError('Draw first.'), 'Draw first.');
});
