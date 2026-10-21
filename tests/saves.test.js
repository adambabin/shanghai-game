// Several games can be saved at once and resumed separately.
import test from 'node:test';
import assert from 'node:assert/strict';

// a minimal in-memory localStorage
const data = new Map();
globalThis.localStorage = {
  get length() {
    return data.size;
  },
  key: (i) => [...data.keys()][i] ?? null,
  getItem: (k) => (data.has(k) ? data.get(k) : null),
  setItem: (k, v) => data.set(k, String(v)),
  removeItem: (k) => data.delete(k),
};

const { HostSession } = await import('../js/host.js');

function soloGame(name) {
  const h = new HostSession({ name, clientId: 'me', solo: true });
  h.act(0, { type: 'start' });
  h.close();
  return h;
}

test('each solo game gets its own save', () => {
  data.clear();
  const a = soloGame('Ann');
  const b = soloGame('Ann');
  const games = HostSession.savedGames();
  assert.equal(games.length, 2);
  assert.deepEqual(games.map((g) => g.id).sort(), [a.gameId, b.gameId].sort());
  assert.ok(HostSession.saved(a.gameId).solo);
});

test('a resumed game keeps saving to the same slot', () => {
  data.clear();
  const a = soloGame('Ann');
  const r = new HostSession({ name: 'Ann', clientId: 'me', solo: true, restore: HostSession.saved(a.gameId) });
  r.changed();
  r.close();
  assert.equal(r.gameId, a.gameId);
  assert.equal(HostSession.savedGames().length, 1);
});

test('clearing one game leaves the others', () => {
  data.clear();
  const a = soloGame('Ann');
  const b = soloGame('Ann');
  HostSession.clearSaved(a.gameId);
  assert.deepEqual(HostSession.savedGames().map((g) => g.id), [b.gameId]);
});

test('finished games are not listed', () => {
  data.clear();
  const a = soloGame('Ann');
  const s = HostSession.saved(a.gameId);
  s.game.phase = 'gameOver';
  data.set('shanghai.hostGame.' + a.gameId, JSON.stringify(s));
  assert.equal(HostSession.savedGames().length, 0);
});

test('the single save from older versions moves into the list', () => {
  data.clear();
  const a = soloGame('Ann');
  const s = HostSession.saved(a.gameId);
  data.clear();
  delete s.id;
  data.set('shanghai.hostGame', JSON.stringify(s));
  const games = HostSession.savedGames();
  assert.equal(games.length, 1);
  assert.ok(games[0].id);
  assert.equal(data.has('shanghai.hostGame'), false);
  assert.deepEqual(HostSession.saved(games[0].id).game, s.game);
});
