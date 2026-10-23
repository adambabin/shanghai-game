// Table chat: short messages between the people at the table. Chat never touches the game: the host takes each
// message on its own (never through applyAction), stamps it with the sender's seat and name from the connection it
// came in on, and the UI only ever shows it as plain text.

export const CHAT_MAX = 120; // characters per message
export const CHAT_KEEP = 100; // messages kept with the game
// quick reactions in the chat, above the text box
export const CHAT_EMOJI = ['😂', '🥴', '🤪', '😱', '👏', '😭'];
export const CHAT_SAYINGS = ['Nice one!', 'Nooo!', 'Hurry up 😴', 'So close!', 'Oops!', 'Good game!'];

// line breaks, control characters and the invisible ones that can hide or reorder text (the joiner that builds
// emoji like 👨‍👩‍👧 stays), squeezed to single spaces and cut to CHAT_MAX characters; '' when nothing is left
const cp = (n) => '\\u{' + n.toString(16) + '}';
const HIDDEN_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0xad], [0x61c], [0x180e], [0x200b, 0x200c], [0x200e, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x2069], [0xfeff], [0xfff9, 0xfffb]];
const HIDDEN = new RegExp(`[${HIDDEN_RANGES.map(([a, b]) => cp(a) + (b ? '-' + cp(b) : '')).join('')}]`, 'gu');
export function cleanChat(text) {
  if (typeof text !== 'string') return '';
  const clean = text.replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, CHAT_MAX).join('').trim();
}

// just emoji (up to 3, with skin tones and joined ones like 👨‍👩‍👧), shown big instead of in a bubble
const EMOJI_ONLY = new RegExp(
  String.raw`^(?:\p{Extended_Pictographic}(?:${cp(0xfe0f)}|${cp(0x200d)}\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s?){1,3}$`,
  'u'
);
export function isEmojiOnly(text) {
  return EMOJI_ONLY.test(text);
}

// At most one message a second each, and 5 in any 10 seconds, so nobody can flood the table.
export class ChatLimit {
  constructor() {
    this.sent = new Map(); // seat -> recent send times
  }

  allow(seat, now = Date.now()) {
    const recent = (this.sent.get(seat) || []).filter((t) => now - t < 10000);
    if ((recent.length && now - recent[recent.length - 1] < 1000) || recent.length >= 5) return false;
    recent.push(now);
    this.sent.set(seat, recent);
    return true;
  }
}
