// Tables (BETA) on the host: the lobby's tables, several tables playing at once, moving people between rounds, and the
// end of the whole game.
import test from 'node:test';
import assert from 'node:assert/strict';

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
const { endRoundNoWinner } = await import('../js/engine.js');

// a host with n seats in all (the host plus computers), set to Tables
function tablesLobby(n) {
  const h = new HostSession({ name: 'Ann', clientId: 'me', solo: true });
  assert.ok(h.act(0, { type: 'setMode', mode: 'tables' }).ok);
  while (h.lobby.seats.length < n) assert.ok(h.act(0, { type: 'addBot' }).ok);
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the lobby deals everyone into tables, and the host can move people', () => {
  data.clear();
  const h = tablesLobby(14);
  const snap = h.snapshot(0);
  assert.equal(snap.lobby.mode, 'tables');
  assert.equal(snap.lobby.tableCount, 4, 'about 4 a table');
  const sizes = (x) => [0, 1, 2, 3].map((t) => x.lobby.seats.filter((s) => s.table === t).length);
  assert.deepEqual(sizes(snap).sort(), [3, 3, 4, 4]);
  assert.ok(h.act(0, { type: 'setTables', count: 3 }).ok);
  assert.deepEqual(sizes(h.snapshot(0)).slice(0, 3).sort(), [4, 5, 5]);
  assert.ok(!h.act(0, { type: 'setTables', count: 5 }).ok, '14 players can make at most 4 tables');
  const s1 = h.lobby.seats[1];
  const other = (s1.table + 1) % 3;
  assert.ok(h.act(0, { type: 'moveSeat', seat: 1, table: other }).ok);
  assert.equal(h.lobby.seats[1].table, other);
  const before = [h.lobby.seats[2].table, h.lobby.seats[3].table];
  assert.ok(h.act(0, { type: 'moveSeat', seat: 2, with: 3 }).ok);
  assert.deepEqual([h.lobby.seats[3].table, h.lobby.seats[2].table], before, 'swapped places');
  assert.ok(!h.act(1, { type: 'shuffleTables' }).ok, 'only the host arranges tables');
  h.close();
});

test('a table needs at least 3, and one table seats at most 8', () => {
  data.clear();
  const h = tablesLobby(10);
  h.act(0, { type: 'setTables', count: 2 });
  // move everyone but two to the first table
  h.lobby.seats.forEach((s, i) => i > 1 && (s.table = 0));
  h.lobby.seats[0].table = 1;
  h.lobby.seats[1].table = 1;
  const res = h.act(0, { type: 'start' });
  assert.ok(!res.ok);
  assert.match(res.error, /Table 2 needs at least 3/);
  assert.ok(h.act(0, { type: 'setMode', mode: 'one' }).ok);
  assert.match(h.act(0, { type: 'start' }).error, /One table seats up to 8/);
  h.close();
});

test('16 players play all 7 rounds at 4 tables, moving between rounds, and someone wins', { timeout: 120000 }, async () => {
  data.clear();
  const h = tablesLobby(16);
  h.lobby.options.botSpeed = 0.002;
  assert.ok(h.act(0, { type: 'start' }).ok);
  // let the computer play for the host too
  h.lobby.seats[0].bot = true;
  h.setBot(0, true);
  h.changed();
  const t = h.tour;
  assert.equal(t.games.length, 4);
  assert.deepEqual(t.games.map((g) => g.players.length), [4, 4, 4, 4]);
  assert.ok(t.games.every((g) => g.round === 0 && g.phase === 'draw'), 'tables of computers start at once');

  const seen = [];
  let lastChange = Date.now();
  let sig = '';
  while (t.phase !== 'gameOver' && t.phase !== 'tieVote') {
    await sleep(20);
    const now = JSON.stringify([t.phase, t.round, t.games.map((g) => [g.phase, g.turn, g.seq])]);
    if (now !== sig) [sig, lastChange] = [now, Date.now()];
    if (t.phase === 'between') {
      seen.push({ round: t.round, tables: t.tables.map((x) => [...x]), next: t.next.map((x) => [...x]), points: t.scores.map((s) => s[t.round]) });
      assert.ok(h.act(0, { type: 'nextRound' }).ok);
      assert.equal(h.tour.round, seen.length);
    } else if (Date.now() - lastChange > 1500) {
      // a round nobody can finish: the host ends it
      for (const g of t.games) if (!g.counted && (g.phase === 'draw' || g.phase === 'play')) endRoundNoWinner(g);
      h.checkTour();
      h.changed();
    }
  }
  h.close();
  assert.equal(seen.length, 6, 'six times between rounds');
  // after each round: the winners' table keeps its best 2 and drops its worst 2 to the losers' table
  for (const r of seen) {
    const best = (at) => [...at].sort((a, b) => r.points[a] - r.points[b]);
    const top = best(r.tables[0]);
    for (const s of top.slice(-2)) assert.ok(r.next[3].includes(s) || r.points[s] === r.points[top[1]], 'the worst at the top go to the bottom');
    assert.deepEqual(r.next.map((x) => x.length), [4, 4, 4, 4]);
    assert.deepEqual(r.next.flat().sort((a, b) => a - b), [...Array(16).keys()]);
  }
  assert.ok(t.scores.every((s) => s.length === 7 && s.every((p) => typeof p === 'number')), 'everyone scored every round');
  if (t.phase === 'gameOver') assert.ok(t.winners.length >= 1);
  // the whole group's end screen works like one table's
  const snap = h.snapshot(5);
  assert.equal(snap.view.players.length, 16);
  assert.equal(snap.view.you, 5);
  assert.deepEqual(snap.tour.viewSeats, [...Array(16).keys()]);
  if (t.phase === 'gameOver') {
    assert.equal(snap.view.phase, 'gameOver');
    assert.ok(snap.view.stats.every((s) => s.topRounds >= 0 && s.longestStay >= 0));
    assert.equal(snap.view.stats.reduce((n, s) => n + s.topRounds, 0), 28, '4 at the winners table each of the 7 rounds');
  }
});

test("each player sees their own table, watchers see no one's cards, and chat can stay at the table", () => {
  data.clear();
  const h = tablesLobby(8);
  h.act(0, { type: 'start' });
  const t = h.tour;
  const mine = t.tables[h.tableAt(0)];
  const snap = h.snapshot(0);
  assert.equal(snap.view.players.length, 4);
  assert.deepEqual(snap.tour.viewSeats, mine);
  assert.equal(snap.view.you, mine.indexOf(0));
  assert.equal(snap.view.hand.length, 11);
  // watching needs your own round done first
  const other = 1 - h.tableAt(0);
  assert.ok(!h.act(0, { type: 'watch', table: other }).ok);
  endRoundNoWinner(t.games[h.tableAt(0)]);
  h.checkTour();
  assert.ok(h.act(0, { type: 'watch', table: other }).ok);
  const w = h.snapshot(0);
  assert.equal(w.tour.watching, other);
  assert.equal(w.view.you, null);
  assert.deepEqual(w.view.hand, []);
  assert.ok(!('hands' in w.view) || w.view.hands == null);
  // chat: the table, or everyone
  h.chatLimit.allow = () => true;
  const got = [];
  h.subscribeChat((m) => got.push(m));
  assert.ok(h.sendChat('hello table', 'table').ok);
  assert.ok(h.sendChat('hello all', 'all').ok);
  const [toTable, toAll] = h.chat.slice(-2);
  assert.equal(toTable.table, other, "while watching, Table is the watched table's chat");
  assert.ok(toTable.watching);
  assert.equal(toAll.table, undefined);
  const atOther = t.tables[other][0];
  const atMine = mine.find((s) => s !== 0);
  assert.ok(h.canSeeChat(toTable, atOther));
  assert.ok(!h.canSeeChat(toTable, atMine), "the host's own table doesn't see the other table's chat");
  assert.ok(h.canSeeChat(toAll, atMine));
  h.close();
});

test('a Tables game is saved and picks up where it was', () => {
  data.clear();
  const h = tablesLobby(12);
  h.act(0, { type: 'start' });
  h.close();
  const saved = HostSession.saved(h.gameId);
  assert.ok(saved.tour);
  const r = new HostSession({ name: 'Ann', clientId: 'me', solo: true, restore: saved });
  assert.equal(r.tour.games.length, 3);
  assert.deepEqual(r.snapshot(0).tour.viewSeats, h.tour.tables[h.tableAt(0)]);
  r.close();
});

test('a tie for the win goes to the vote, then a tiebreaker table of just the tied players', () => {
  data.clear();
  const h = tablesLobby(8);
  h.act(0, { type: 'start' });
  const t = h.tour;
  t.round = 6;
  for (let r = 0; r < 7; r++) t.history[r] = t.history[0];
  // the host and seat 1 tie for the lowest total
  h.settleTour([50, 50, 90, 90, 90, 90, 90, 90]);
  assert.equal(t.phase, 'tieVote');
  assert.equal(h.snapshot(0).view.phase, 'tieVote');
  assert.ok(!h.act(2, { type: 'tieVote', choice: 'share' }).ok, 'only the tied players choose');
  assert.ok(h.act(0, { type: 'tieVote', choice: 'tiebreak' }).ok);
  if (!h.lobby.seats[1].bot) assert.ok(h.act(1, { type: 'tieVote', choice: 'tiebreak' }).ok);
  assert.equal(t.phase, 'tiebreak');
  const mine = h.snapshot(0);
  assert.equal(mine.view.players.length, 2);
  assert.ok(mine.view.tiebreak.playing);
  assert.equal(mine.view.hand.length, 11);
  assert.equal(h.snapshot(2).view.you, null, 'everyone else watches the tiebreaker');
  endRoundNoWinner(t.tbGame);
  h.checkTour();
  assert.equal(t.phase, 'gameOver');
  assert.ok(t.winners.length >= 1 && t.winners.every((s) => s === 0 || s === 1));
  assert.equal(t.tiebreak.points.filter((p) => p != null).length, 2);
  const end = h.snapshot(4).view;
  assert.equal(end.phase, 'gameOver');
  assert.deepEqual(end.winners, t.winners);
  h.close();
});
