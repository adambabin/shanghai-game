// House rules and round setup. Edit this file to change how the game plays.

// One entry per round. `deal` is how many cards each player gets.
export const ROUNDS = [
  { sets: 2, runs: 0, deal: 11 },
  { sets: 1, runs: 1, deal: 11 },
  { sets: 0, runs: 2, deal: 11 },
  { sets: 3, runs: 0, deal: 11 },
  { sets: 2, runs: 1, deal: 11 },
  { sets: 1, runs: 2, deal: 11 },
  { sets: 0, runs: 3, deal: 11 },
  { sets: 3, runs: 1, deal: 11 },
  { sets: 1, runs: 3, deal: 11 },
  { sets: 4, runs: 0, deal: 13 },
  { sets: 0, runs: 4, deal: 13 },
];

export const SET_MIN = 3; // cards of the same rank
export const RUN_MIN = 4; // cards in a row, same suit
// Every set and run needs more real cards than wild cards (see melds.js).

export const MAX_PLAYERS = 8;

// Defaults for the options the host can change in the lobby.
export const DEFAULT_OPTIONS = {
  buyLimit: 2, // buys per player per round
  buyPenalty: 2, // extra cards from the deck on top of the card you buy
  twoClubsWild: false, // jokers are always wild; optionally the 2 of clubs too
  shanghaiPenalty: 2, // cards the discarder picks up when Shanghai is called on them
  falseCallPenalty: 2, // cards picked up for calling Shanghai when there isn't one
  botSpeed: 1, // 0.5 = fast, 1 = normal, 2 = slow
  decks: 3, // standard decks shuffled together, each with its 2 jokers; 3 to 6
};

export const MIN_DECKS = 3;
export const MAX_DECKS = 6;

// How many decks a game uses (3 by default, 162 cards). Older saved games have no setting and get the default.
export function decksFor(options = {}) {
  const n = Number(options.decks) || DEFAULT_OPTIONS.decks;
  return Math.min(MAX_DECKS, Math.max(MIN_DECKS, n));
}

export function contractText(round) {
  const r = ROUNDS[round];
  const parts = [];
  if (r.sets) parts.push(`${r.sets} Set${r.sets > 1 ? 's' : ''}`);
  if (r.runs) parts.push(`${r.runs} Run${r.runs > 1 ? 's' : ''}`);
  return parts.join(' + ');
}
