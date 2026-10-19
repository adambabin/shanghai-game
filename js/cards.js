// Cards are plain objects: { id, r, s }.
// r: 1 = Ace ... 11 = J, 12 = Q, 13 = K, 0 = Joker. s: 'S' | 'H' | 'D' | 'C' | 'J' (joker).

export const SUITS = ['S', 'H', 'D', 'C'];
export const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣', J: '★' };
export const RANK_LABEL = ['JK', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export function makeDecks(count) {
  const cards = [];
  let id = 0;
  for (let d = 0; d < count; d++) {
    for (const s of SUITS) {
      for (let r = 1; r <= 13; r++) cards.push({ id: id++, r, s });
    }
    cards.push({ id: id++, r: 0, s: 'J' });
    cards.push({ id: id++, r: 0, s: 'J' });
  }
  return cards;
}

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function wildTest(options) {
  return (c) => c.r === 0 || (options.twoClubsWild && c.r === 2 && c.s === 'C');
}

export function cardPoints(c, isWild) {
  if (isWild(c)) return 50;
  if (c.r === 1) return 20;
  if (c.r >= 10) return 10;
  return c.r;
}

export function cardLabel(c) {
  if (c.r === 0) return 'Joker';
  return RANK_LABEL[c.r] + SUIT_SYMBOL[c.s];
}

export function isRed(c) {
  return c.s === 'H' || c.s === 'D';
}
