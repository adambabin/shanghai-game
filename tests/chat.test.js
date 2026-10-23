// Table chat: cleaning up what's typed, the flood limit, and the host keeping messages apart from the game.
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

const { cleanChat, isEmojiOnly, ChatLimit, CHAT_MAX, CHAT_KEEP } = await import('../js/chat.js');
const { HostSession } = await import('../js/host.js');

const cp = (...codes) => String.fromCodePoint(...codes);

test('messages are squeezed to one short line of visible text', () => {
  assert.equal(cleanChat('  hi\n\nthere\t you  '), 'hi there you');
  assert.equal(cleanChat('a'.repeat(500)).length, CHAT_MAX);
  // invisible and text-reversing characters go
  assert.equal(cleanChat(`ok${cp(0x202e)}evil${cp(0x200b)}!`), 'ok evil !');
  assert.equal(cleanChat(`${cp(0x200b)} \n `), '');
  assert.equal(cleanChat(42), '');
  assert.equal(cleanChat({ text: 'hi' }), '');
  // emoji built with the joiner stay whole, and the cut never splits an emoji in half
  const family = `👨${cp(0x200d)}👩${cp(0x200d)}👧`;
  assert.equal(cleanChat(family), family);
  assert.equal(Array.from(cleanChat('😂'.repeat(200))).length, CHAT_MAX);
});

test('just emoji are shown big', () => {
  for (const t of ['😂', '😂😂', '👍🏽', '❤️', `👨${cp(0x200d)}👩${cp(0x200d)}👧`]) assert.ok(isEmojiOnly(t), t);
  for (const t of ['hi 😂', 'Nice one!', '😂😂😂😂', '1', '#', '']) assert.ok(!isEmojiOnly(t), t);
});

test('nobody can flood the table', () => {
  const limit = new ChatLimit();
  assert.ok(limit.allow(1, 0));
  assert.ok(!limit.allow(1, 500), 'a second message within a second');
  assert.ok(limit.allow(2, 500), 'others are not held up');
  for (const t of [1500, 3000, 4500, 6000]) assert.ok(limit.allow(1, t));
  assert.ok(!limit.allow(1, 7500), 'a sixth within ten seconds');
  assert.ok(limit.allow(1, 10600));
});

function soloGame() {
  const h = new HostSession({ name: 'Ann', clientId: 'me', solo: true });
  h.chatLimit.allow = () => true;
  return h;
}

test('chat starts with the game and never touches it', () => {
  data.clear();
  const h = soloGame();
  assert.equal(h.sendChat('hello').ok, false, 'not before the game starts');
  h.act(0, { type: 'start' });
  const before = JSON.stringify(h.game);
  const heard = [];
  h.subscribeChat((m) => heard.push(m));
  assert.ok(h.sendChat('  hello\nall ').ok);
  assert.equal(JSON.stringify(h.game), before);
  assert.deepEqual(heard.map((m) => [m.seat, m.name, m.text]), [[0, 'Ann', 'hello all']]);
  assert.equal(h.sendChat(' \n ').ok, false);
  // computers don't chat, and seats that aren't there can't either
  assert.equal(h.say(1, 'beep').ok, false);
  assert.equal(h.say(9, 'hi').ok, false);
  assert.equal(h.say(null, 'hi').ok, false);
  h.close();
});

test("a joined player's message carries their own seat and name, whatever it claims", () => {
  data.clear();
  const h = new HostSession({ name: 'Ann', clientId: 'me', solo: true });
  h.chatLimit.allow = () => true;
  const sent = [];
  h.room = { send: (connId, msg) => sent.push([connId, msg]), close() {} };
  h.lobby.seats.push({ name: 'Bob', clientId: 'bob', connected: true });
  h.conns.set('c1', 3);
  h.act(0, { type: 'start' });
  h.onMessage('c1', { t: 'chat', text: 'I am Ann', seat: 0, name: 'Ann' });
  const m = h.chat[h.chat.length - 1];
  assert.equal(m.seat, 3);
  assert.equal(m.name, 'Bob');
  assert.ok(sent.some(([c, msg]) => c === 'c1' && msg.t === 'chat' && msg.m === m), 'each message goes out on its own');
  // nothing from a connection without a seat, and chat can't sneak in a move
  h.onMessage('stranger', { t: 'chat', text: 'hi' });
  assert.equal(h.chat.length, 1);
  const before = JSON.stringify(h.game);
  h.onMessage('c1', { t: 'chat', text: { type: 'discard', id: 1 } });
  assert.equal(JSON.stringify(h.game), before);
  assert.equal(h.chat.length, 1);
  h.close();
});

test('the chat is kept with the game, the latest messages only', () => {
  data.clear();
  const h = soloGame();
  h.act(0, { type: 'start' });
  for (let i = 0; i < CHAT_KEEP + 5; i++) h.sendChat(`message ${i}`);
  h.close();
  assert.equal(h.chat.length, CHAT_KEEP);
  const saved = HostSession.saved(h.gameId);
  assert.equal(saved.chat.length, CHAT_KEEP);
  assert.equal(saved.chat[0].text, 'message 5');
  const r = new HostSession({ name: 'Ann', clientId: 'me', solo: true, restore: saved });
  r.chatLimit.allow = () => true;
  r.sendChat('back again');
  assert.equal(r.chat[r.chat.length - 1].id, CHAT_KEEP + 5, 'numbering carries on');
  r.close();
});

test('the game snapshots sent after every move leave the chat out', () => {
  data.clear();
  const h = soloGame();
  h.act(0, { type: 'start' });
  h.sendChat('secret plans');
  assert.ok(!JSON.stringify(h.snapshot(0)).includes('secret plans'));
  h.close();
});
