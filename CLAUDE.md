# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser Shanghai rummy game with one family's house rules. It's a static site with no build step and no backend: plain ES modules plus a vendored PeerJS (`vendor/peerjs.min.js`). Deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`. That workflow runs `npm test` first, then publishes `index.html`, `manifest.webmanifest`, `icons/`, `css/`, `js/` and `vendor/`. New top-level files must be added to its copy step.

## Commands

- `npm test` runs all tests (`node --test tests/*.test.js`). No dependencies to install.
- Run a single test: `node --test --test-name-pattern="buying" tests/engine.test.js`
- Serve locally: `npm start` (or `python3 -m http.server 8080`) and open http://localhost:8080.
- `?debug` on the URL exposes the UI state as `window.__shanghai`. `window.__shanghai.session.game` is the host's live engine state. Browser tests rig scenarios by mutating it and calling `session.changed()`.
- `?peerserver=host:port` uses a self-hosted PeerJS server instead of the public one. Invite links carry it along. This is how multiplayer is tested locally: run a `peer` server and open several browser contexts.

There is no linter or formatter configured. Match the existing style: 2-space indent, single quotes, semicolons, ~140-char lines.

## Architecture

**Host-authoritative peer-to-peer.** The host's browser runs the whole game; other players are thin clients.

- `js/engine.js` holds the game: pure state plus `applyAction(state, seat, action)`, which returns `{ ok }` or `{ ok: false, error }`. Players are referenced by **seat index**.
  - `viewFor(state, seat)` builds the only thing a player ever sees. It redacts other hands and the deck, and adds derived flags the UI relies on (`mustDecide`, `buyEligible`, `buyWindow`, `canUndo`, `mustPlay`).
  - Any new state the UI needs must be exposed through `viewFor`.
- `js/host.js`
  - `HostSession` owns the lobby (seats, options), the engine state, bot timers and the buy-window timeouts.
  - It persists each game to `localStorage` under its own key (`shanghai.hostGame.<gameId>`), so several games (vs the computer or hosted) can be resumed from "Your games" on the home screen. Only one runs at a time: leaving a hosted game pauses it for everyone until the host resumes it, and the room code stays the same. `savedGames()` moves the single save older versions used into the list. When restoring, it fills defaults for fields older saves lack, so add new state fields there too.
  - It broadcasts a per-seat `snapshot()` to every connection after each change.
  - `ClientSession` has the same `subscribe`/`send` interface but forwards actions to the host. Host-only actions (`start`, `nextRound`, `endRound`, `startNow`, `toggleBot`, …) are handled in `HostSession.act`, not the engine.
- `js/net.js` wraps PeerJS. The room code maps to a fixed peer id prefix. `ICE_SERVERS` lists the relays (a Metered free-plan account first, PeerJS's free relay as fallback); phones on mobile data need one to reach the host. A joining player who can't get through within 15 seconds sees a "Can't reach the host" message (status `slow`) while it keeps retrying. Both sides ping (3s) and drop stale links (10s), and clients auto-reconnect. Rejoining with the same `clientId`, or the same name on a disconnected seat, reclaims that seat.
- `js/bot.js` contains the computer players. They decide from the same `viewFor` view a human gets. `HostSession.scheduleBots` drives them with timers:
  - The turn timer resets on every change.
  - Reaction timers (Shanghai calls, buy answers) re-check validity when they fire.
- `js/main.js` is the whole UI. It re-renders by setting `innerHTML` on every snapshot and uses one delegated click handler keyed on `data-act`.
  - Purely local UI state lives in the `ui` object and never reaches the engine: hand order and sort mode, selection, staged lay-down groups, the armed Shanghai declaration, dock collapse.
  - Games other people host that you've joined are remembered in `store` (`joinedGames`: room code, host, other names, round as last seen) and listed in "Your games" too. One drops off when you see it finish, are removed from it, or tap ✕.
  - `fitHomeGames()` (after every render and on resize) hides games from the end of the home list until the room code, How to play and Settings (`.home-links`) fit on screen, keeping at least your latest game, and then shows "View all your games". That opens the full list (`ui.allGames`, `allGamesHTML()`) with a Back button.
  - Per-player settings (card back color, low-to-high or high-to-low sorting, sound) live in `ui` too and are saved to `localStorage` via `store` (keys prefixed `shanghai.`). No accounts: they stay on that browser/device. Card back colors are `[data-back=…]` CSS blocks in `style.css`.
  - The home screen and Settings offer "Add to your home screen" on phones (hidden once opened from the icon). It matters on iPhone: Safari clears a site's storage after about a week unused, but a home screen app keeps its own (separate) storage. On Android it uses Chrome's install prompt when available.
  - All in-game messaging goes through the activity box above the deck row (`activityHTML`; it grows upward over the table, so the piles and hand never move). It shows, in priority order: a prompt you must answer, then your-turn status, then a brief `toast()` flash, then the turn status. Tapping the box (when it isn't a prompt) opens the game log. `toast()` only floats a pop-up outside a game.
  - `layoutHand()` positions cards absolutely after render, wrapping into rows and shrinking for big hands. It fits the hand to the `.dock`'s width, not the page's.
  - **Phones held sideways** (`@media (orientation: landscape) and (max-height: 520px)` at the end of `style.css`): `.game` becomes a two-column grid. The top bar, players and table fill the left half at full height; `.bottom` (activity box, deck row, hand) is the right half, with smaller `--cw`/`--ch` cards. Tablets and portrait keep the one-column layout.
  - The deck row, activity box and hand sit in `.bottom`. `markTableOverflow()` gives it an upward shadow (`.raised`) when the piles on the table don't all fit above it.
  - Pop-ups built with `wrapModal()` keep the title and the Close button fixed; only `.modal-body` scrolls.
  - Staged lay-down groups sit in one sideways-scrolling row (`.staged-row`) under a line holding the count and the Lay down button, so a big lay-down can't push the button or the hand off screen. If the cards area is still too tall for the screen, `.dock-body` scrolls vertically.
  - Player tiles (`.players`) are one sideways-scrolling row (`.hscroll`, shared with the staged groups): each tile is at least 88px (about 7 letters plus "…") and grows to fit the name, which is cut at 15 characters. `revealTurn()` scrolls the current player's tile into view when the turn changes, and `markEdgeFade()` fades whichever edge of an `.hscroll` row has more past it.
  - `render()` replaces everything, so it carries the scroll position of `.players`, `.staged-row`, `.table` and `.modal-body` over. `trackMeldChanges()` marks piles that changed since the last snapshot (`.just-played` for a few seconds). The table never scrolls by itself.
  - Drag and tap both work everywhere: a press that moves under 8px is a tap. A drag that ends swallows the click after it (`ui.swallowClick`).
    - Within the hand, a drag reorders `ui.order` only. Dragging a selected card brings all the selected cards along. `handSlots()` opens a space (a dashed `.drop-slot` outline) where they'll land, taken from the other cards' overlap so the hand never gets wider.
    - Lifted out of the hand, the cards float in a `.drag-ghost` on `body` and drop onto `[data-drop]` targets (discard pile, staged groups, table piles), each reaching `DROP_BUFFER` past its edges. Drops call the same functions as taps (`discard`, `addToStaged`, `playOn`). On a run, dropping on a joker swaps it and the left/right half picks the low/high end, instead of the tap's pop-ups. Holding near the table's top or bottom edge scrolls it.
    - Before you lay down, lifting cards also shows "New set" / "New run" spots (`newGroupSpotsHTML`, only the group types the round still needs, side by side). `placeSpots()` floats them where the new group will go: in the gap between the deck row and the hand when nothing is staged, as tiles at the end of the staged row when there's room, else as a bar over the "Your lay down" line. They cover no drop target and nothing moves mid-drag. They're always rendered but hidden by CSS until `body.cards-lifted`, because `render()` waits while a drag is on. One card can start a group (`stageGroup`). Tapping and the Make set / Make run buttons are unchanged.
    - `[data-drag]` piles (deck, discard) drag into the hand to draw. `ui.drawTo` makes `syncHand()` put the new card where it was dropped.
- `js/melds.js` validates sets and runs. A run is stored as `{ suit, lo, cards }`, where `cards[i]` sits at value `lo + i`. Wild cards occupy real slots, which is what makes joker swaps and order-preserving runs possible.
- `js/rules.js` holds the round contracts and deal sizes (`ROUNDS`), plus the lobby-adjustable `DEFAULT_OPTIONS`. The host picks 3 to 6 decks (`decks`, default 3), each adding 2 jokers; `decksFor()` clamps it and fills the default for older saves.

### Turn flow (engine phases)

`ready` → `draw` → `play` → (discard) → next player's `draw` … → `roundOver` / `gameOver`.

- **`ready`:** each round opens here until every human sends `ready`. Bots are pre-ready, and the host can force `startNow`.
- **`draw` with a live discard:** if anyone could buy it, the current player must choose `drawDiscard` ("Take it") or `allowBuy`. `drawDeck` is refused until they choose (`mustDecideOnDiscard`).
  - `allowBuy` opens `buyWindow`, which asks eligible players one at a time in turn order, each with `BUY_WINDOW_MS`.
  - A buy gives the card plus `buyPenalty` extra cards. The exposed card underneath is offered again: `buyOffered` resets.
- **`play`:** lay down the contract, `addToMeld`, `swapWild` (runs only, after laying down; the taken wild goes into `mustPlay` and must be played before discarding), `undo` (reverses this turn's plays via `history`; undoing past everything puts a picked-up discard back and returns to `draw`), then `discard`.

### House rules that differ from standard Shanghai (all enforced in engine/melds; keep them)

- **Shanghai calls:** a discard is a "Shanghai" if it fits any pile, either on an end or by replacing a joker in a run, regardless of whether the discarder has laid down.
  - Anyone else may call it until the next player draws. The discarder picks up `shanghaiPenalty` cards and the card goes dead.
  - A wrong call costs `falseCallPenalty` cards (0 by default; the host can set 1 to 3). There is no blocking.
- **Self-declared Shanghai:** declaring your own discard kills it only if it really was playable. Otherwise it stays live and only the discarder gets a note (log kind `notshanghai`).
- **Dead cards:** a dead card becomes live again once covered, and stays live if later exposed.
- **Going out:** you can't go out on a discard. The last cards must be played onto piles.
- **Wild cards:** only jokers are wild; the 2♣ is optional. Every set and run needs more real cards than wilds, and a run can't have two wilds side by side. These are checked on lay down and on every add.
- **Aces:** high only (no A-2-3-4).
- **Rounds 8, 9 and 11** can be nearly impossible under these rules. The sim test tolerates stalls via the host's `endRound`.

## Testing notes

- `tests/engine.test.js` builds `rigged()` games with hand-crafted hands. Its `deckDraw()` helper allows a buy and times out the window before drawing, because a plain `drawDeck` is refused while a live discard is undecided.
- `tests/saves.test.js` checks the per-game save slots with an in-memory `localStorage`.
- `tests/sim.test.js` plays many full bot-only games and asserts most rounds end with someone going out. Bot or rule changes that cause stalls show up here.
- UI changes have been checked with ad-hoc Playwright scripts (Chromium is preinstalled; use the `?debug` hook), not with committed tests.

## UI gotchas

- **Mobile first.** The viewport is locked at scale 1, and pinch and double-tap zoom are blocked. Inputs and selects must stay at ≥16px or iPhones auto-zoom.
- **Gradients need a solid fallback.** Firefox on iOS can skip CSS gradients, so give any gradient a `background-color` underneath it.
- Every visible string is user-facing copy for a family audience: plain, short, no jargon.
