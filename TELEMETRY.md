# Usage stats

The game sends anonymous counts to [Umami Cloud](https://cloud.umami.is) so the owner can see how many people play, how far
they get and where they seem to get stuck. The code is `js/telemetry.js` (sending) and the "usage stats" section of
`js/main.js` (what gets counted).

- **Nothing personal:** no names, room codes, cards, hands, chat or feedback text, and no cookies. The address is sent without
  its query (which can hold a room code). Each device has a random id (`shanghai.statsId`) so returning players can be
  told apart from new ones.
- **No slowdown:** each event is one small POST, sent when the browser is idle, never awaited. Failures are ignored.
  At most 300 per page load.
- **Off** when `UMAMI_SITE` is empty, on a local copy (localhost, 127.0.0.1, file:), with `?debug`, and on any device
  that has opened the game once with `?notrack` (`?track` turns it back on). Use `?notrack` on your own phones so your
  testing doesn't count.

## Setup

1. Sign up at https://cloud.umami.is (the free Hobby plan is enough).
2. **Settings → Websites → Add website.** Name: Shanghai. Domain: the GitHub Pages domain, e.g. `adambabin.github.io`.
3. Open the website's **Edit** page and copy its **Website ID** (a UUID) into `UMAMI_SITE` at the top of
   `js/telemetry.js`. It's public by nature, like the relay credentials in `net.js`.
4. Push to `main`. Events show up in the dashboard within a minute of someone opening the game.

## Events

Every event carries `version` (the stamped release, or `local`). Most in-game events also carry `role` (`vs computer`,
`host` or `joined`), `round` (1–11), `phase`, `minutes` (since this device opened the game), `people` and `computers`.
Every device in a game sends its own, so count games with `role` ≠ `joined`.

| Event | When | Extra data |
| --- | --- | --- |
| (page view) | the game opens | |
| `open` | the game opens | `app` (browser / home screen), `device`, `returning`, `invite`, `savedGames` |
| `game_start` | round 1 is dealt | `skill` (with computers), `decks` |
| `game_resumed` | an unfinished game is opened again | `skill`, `decks` |
| `round_end` | a round ends while you watch | `outcome` (you / person / computer / nobody went out), `roundMinutes`, `tiebreaker` |
| `game_end` | the game is over | `result` (won / shared the win / lost), `tiebreaker` |
| `game_left` | leaving an unfinished game | `how`: went home, closed (page closed; phones don't always say), removed |
| `idle_turn` | 90 seconds on your turn with no touches and no pop-up open | `laidDown` |
| `refused` | the game turns a move down (once per message per round) | `error`, with card names replaced by `#` |
| `connect_trouble` | joining is slow or fails | `status` (slow / no-host / error) |
| `tour` | the first-game tour is finished or skipped | `finished`, `step` |
| `tip` / `tips_off` | a one-time tip shows / tips are turned off | `tip` |
| `feedback` | feedback is sent | `photos` |
| `chat_sent` | you send a chat message (never what it says) | `kind` (emoji / saying / typed) |
| `js_error` | a code error (5 per page load at most) | `message`, `where` |

## Useful views in the dashboard

- **Events** tab: counts of each event; click one to break it down by its data (e.g. `game_left` by `round`).
- **Funnels** (Reports): `open` → `game_start` → `round_end` → `game_end`, to see where people drop off.
- **Retention** (Reports): how many come back.
