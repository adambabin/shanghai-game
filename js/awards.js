// "How everyone played", shown from the game-over pop-up: awards and each player's numbers, worked out from the counts
// the engine keeps all game (state.stats, only in the view once the game is over) and the score sheet.

// in the order they're listed; each goes to whoever has the most (all of them on a tie), and only if it happened
export const AWARDS = [
  { key: 'sheriff', emoji: '🚨', title: 'Shanghai Sheriff', stat: 'caught' },
  { key: 'wanted', emoji: '🎯', title: 'Most Wanted', stat: 'caughtBy' },
  { key: 'spender', emoji: '💸', title: 'Big Spender', stat: 'buys' },
  { key: 'honest', emoji: '🙊', title: 'Honest Abe', stat: 'ownShanghais' },
  { key: 'falseAlarm', emoji: '📣', title: 'False Alarm', stat: 'falseCalls' },
  { key: 'thief', emoji: '🃏', title: 'Joker Thief', stat: 'jokerSwaps' },
  { key: 'ouch', emoji: '😬', title: 'Ouch', stat: 'worst' },
];

// what each number is called on a player's card, for 1 and for more
const LABELS = {
  wentOut: ['round won', 'rounds won'],
  caught: ['Shanghai caught', 'Shanghais caught'],
  caughtBy: ['time Shanghai’d', 'times Shanghai’d'],
  buys: ['buy', 'buys'],
  ownShanghais: ['own Shanghai', 'own Shanghais'],
  falseCalls: ['missed call', 'missed calls'],
  jokerSwaps: ['joker swapped', 'jokers swapped'],
  worst: ['worst round', 'worst round'],
};
// after a player's award numbers, the rest in this order (any that happened first, then ones that didn't)
const FACT_ORDER = ['wentOut', 'caught', 'buys', 'caughtBy', 'jokerSwaps', 'ownShanghais', 'falseCalls', 'worst'];

// each player's counts plus their worst round from the score sheet (rounds only, not a tiebreaker)
function countsOf(stats, scores) {
  return stats.map((s, i) => {
    const rounds = (scores[i] || []).map((p) => (typeof p === 'number' ? p : 0));
    return { ...s, worst: rounds.length ? Math.max(...rounds) : 0 };
  });
}

// [{ key, emoji, title, stat, seats, n }] for the awards someone earned
export function gameAwards(stats, scores) {
  if (!stats) return [];
  const counts = countsOf(stats, scores);
  return AWARDS.map((a) => {
    const n = Math.max(...counts.map((c) => c[a.stat] || 0));
    return { ...a, n, seats: n > 0 ? counts.map((c, i) => (c[a.stat] === n ? i : -1)).filter((i) => i >= 0) : [] };
  }).filter((a) => a.seats.length);
}

// three numbers for a player's card: their award numbers first, then whatever else happened, then zeros
export function playerFacts(stats, scores, seat, awards = gameAwards(stats, scores)) {
  const c = countsOf(stats, scores)[seat];
  const keys = [...awards.filter((a) => a.seats.includes(seat)).map((a) => a.stat)];
  for (const k of FACT_ORDER) if (c[k] > 0 && !keys.includes(k)) keys.push(k);
  for (const k of FACT_ORDER) if (!keys.includes(k)) keys.push(k);
  return keys.slice(0, 3).map((k) => ({ key: k, n: c[k] || 0, label: LABELS[k][c[k] === 1 ? 0 : 1] }));
}
