# Shanghai

A browser version of Shanghai rummy with our family's house rules. Play against the computer, or host a game and have friends and family join from their own phones or computers with a room code.

No accounts, no server to run. The host's browser runs the game and everyone else connects to it directly over WebRTC (through [PeerJS](https://peerjs.com)).

## Playing

1. Open the site and enter your name.
2. **Play against the computer** starts a solo game with two computer players (add or remove more in the lobby).
3. **Host a game** gives you a 5-letter room code and a **Share invite link** button. Send the link to everyone. When they open it and type their name, they're in your lobby.
4. In the lobby the host can add computer players to fill seats, adjust the house rules, and start the game (2–8 players).

The host has to keep their page open for the whole game. If the host refreshes or their browser restarts, **Resume your last game** on the start page reopens the same room, and everyone reconnects automatically. If a player drops off, they can reopen the invite link (even on another device, using the same name) to get their seat back. Meanwhile the host can open the ☰ menu and let the computer play for them.

## House rules

- 11 rounds, lowest total score wins. The contracts are listed under **How to play** in the game and live in [`js/rules.js`](js/rules.js).
- 3 decks with 6 jokers; when the deck runs out the discard pile is reshuffled.
- Sets are 3+ of a rank, runs are 4+ in a row of one suit (aces are high only: J-Q-K-A, never A-2-3-4). Every set or run needs more real cards than jokers, and a run can't have two jokers side by side. Jokers in a run go where you put them (select joker, 8, 9, 10 to put the joker below the 8).
- **Only jokers are wild.** The 2♣ is a normal card (the host can turn 2♣-wild on in the lobby).
- **Buying:** at the start of your turn you pick **No, take card** (you take the discard) or **Allow buy** (you can only draw from the deck after allowing a buy). If you allow it, everyone who can buy gets 10 seconds to answer Buy or No thanks; the one next in turn order wins and takes the card plus 2 from the deck. Then you draw from the deck (or take the discard if nobody bought it). 2 buys per round, and not once you've laid down.
- **Shanghai!** If anyone discards a card that could have been played on any pile, anyone can hit the SHANGHAI! button before the next player draws. The discarder picks up 3 cards and the card is dead.
  - The button is always live. Calling Shanghai when there isn't one costs you 2 cards. A card counts as playable if it fits on the end of a pile or could swap out a joker in a run.
  - To get rid of a playable card on purpose, tap SHANGHAI! on your own turn before discarding. Your discard is declared dead: no penalty, but nobody can pick it up or buy it until another card covers it. If the card couldn't actually go anywhere, you get a heads-up and it stays live.
- **Swapping wilds:** once you've laid down, you can swap the real card for a joker in any run and take the joker. You must play that joker before you can discard. Runs only.
- **Going out:** you can't go out on a discard. Your last cards (at least 2 on the final turn) must be played onto piles. **Undo** takes back plays you made this turn, until you discard.
- Scoring: 2–9 face value, 10/J/Q/K 10, ace 20, joker 50.

The host can change buy limits, penalty sizes, 2♣ wild and computer speed in the lobby.

## Hosting the site

It's a static site with no build step. Any static host works.

**GitHub Pages:** the workflow in `.github/workflows/pages.yml` runs the tests and publishes the site on every push to `main`. Turn it on once under the repo's **Settings → Pages → Build and deployment → Source: GitHub Actions**. The site then appears at `https://<your-username>.github.io/shanghai-game/`. (GitHub Pages on a private repo needs a paid GitHub plan; otherwise make the repo public.)

**Locally:** `npm start` (or `python3 -m http.server 8080`) and open http://localhost:8080.

Connections use the free public PeerJS server to introduce players to each other, and PeerJS's relay servers when two networks can't connect directly. To use your own [PeerJS server](https://github.com/peers/peerjs-server) instead, add `?peerserver=yourhost:9000` to the URL. Invite links carry it along.

## Code

| File | What it does |
| --- | --- |
| `js/rules.js` | Round contracts, deal sizes, default house-rule options |
| `js/cards.js` | Deck, wilds, card points |
| `js/melds.js` | Set and run validation, adding cards to piles |
| `js/engine.js` | The game itself: turns, buying, Shanghai calls, dead cards, going out, scoring |
| `js/bot.js` | Computer players |
| `js/host.js` | Host session (lobby, seats, bots, saving) and the client session |
| `js/net.js` | PeerJS connections, heartbeats and reconnects |
| `js/main.js` | The interface |

`npm test` runs the rules tests plus simulated all-computer games.
