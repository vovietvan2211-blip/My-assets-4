# Nova City Quiz — Multiplayer Web App (v6)

A 15-question real-time quiz based on the **Nova City poster** (Mars mega-city, zones, city systems, travel, housing and AI). Built with Node.js, Express, Socket.IO, HTML, CSS and browser JavaScript.

## How the game works
- The host creates a room and shares the 5-character code. Players join from their own phones or computers.
- The host launches each question. The round ends when the timer runs out **or as soon as every connected player has answered**.
- After each question everyone sees the correct answer, an explanation and the A/B/C/D distribution. Each player also gets a personal card: right or wrong, points gained or lost, and current rank.
- After the last question the host shows the final results, and **every player's screen** switches to the spotlight finale.

## Scoring (speed-based)
- A correct answer earns **1,000 points if answered instantly**, falling linearly to **100 points at the buzzer**. Faster means more points.
- Optional risk multipliers (shown to the player, applied to the speed points):

| Bet | If correct | If wrong |
|---|---|---|
| ×1 (default) | speed pts × 1 | nothing lost |
| ×2 | speed pts × 2 | −250 (never below 0) |
| ×3 | speed pts × 3 | −500 (never below 0) |
| ALL-IN | speed pts × 5 | score reset to 0 |

- No answer = 0 points, no penalty.
- All numbers live in the `SCORING` object at the top of `server.js`. If you change them, also update the text in the lobby briefing in `public/index.html`.

## Questions
The 15 questions are in `questions.json`, written from the poster text. Put the correct answer **first** in each `options` list (`"correct": 0`); the server shuffles the answer order every time a question is asked, so the correct answer lands on A/B/C/D at random. Add or edit questions freely, but every question needs exactly 4 options.

## Run locally
1. Install Node.js 18 or newer: https://nodejs.org/
2. Open a terminal in this folder and run:
   ```bash
   npm install
   npm start
   ```
3. Open `http://localhost:3000` on the host computer.

For other devices on the **same Wi-Fi**, use the host computer's local IP, e.g. `http://192.168.1.25:3000` (allow Node.js through the firewall if asked).

## Deploy online
Use any Node host that supports WebSockets (Render, Railway, a VPS…). Build: `npm install`. Start: `npm start`. The app listens on `process.env.PORT`. Everyone should use the same HTTPS URL.

## Reliability notes
- Players and the host get a private ID stored in the browser. If the connection drops or the page is refreshed, they **rejoin automatically** with their score intact. In the lobby a dropped player keeps their seat for 60 s; a dropped host has 2 minutes to return before the room closes.
- Rooms live in server memory: restarting the server clears active games, and this version supports a single server instance. Idle rooms are cleaned up after 3 hours.
- Light rate limits protect room creation and joining.

## QR code to join
The lobby shows a QR code for `/?room=CODE`. Scanning it opens the join form with the code already filled in. If you host on `localhost`, the server's `/api/lan` endpoint supplies your Wi-Fi address so the QR still works on phones. The generator is `public/qr.js` (no dependencies, works offline).

## Controls
Players can tap an answer or press **A–D** (or **1–4**) on a keyboard.

## Project structure
- `server.js` — room state, scoring, timers, reconnection.
- `questions.json` — question bank.
- `public/index.html`, `public/style.css`, `public/app.js` — interface and Socket.IO client.

## Version 4 changes
- **15 core questions**, rewritten in plain wording. In every question the four answers have the same number of words and almost the same length, so nobody can guess by length.
- **Spotlight finale**: the light moves to 3rd place, then 2nd, then 1st. The winner gets a drumroll, fireworks and confetti. After that the lights come on and the full standings appear. A "Skip" link and a "Replay" button are on the screen.
  - To give each spotlight more (or less) time, change `FINAL_TIMING` in `public/app.js` (values in milliseconds).
- **Praise and encouragement**: every answer shows a different line (12 for right, 10 for wrong, 5 for no answer). Lines come from a shuffled deck, so nothing repeats until the deck is used up. Edit them in the `CHEERS` object in `public/app.js`.
- Buffs (×1, ×2, ×3, ALL-IN) are bigger and colour-coded; the chosen one glows.
- The "points if you answer now" preview stays hidden. Scoring (faster = more points) is unchanged.
- Home page shows the poster instead of the Mars drawing (`public/poster.jpg`). The floating star on the last screen is gone.
- Menus and labels use plain wording instead of sci-fi phrases.

## Version 5 changes
- **15 questions** (5 new: Technology Zone, Entertainment Zone, Green Zone, dome air, food). All answers in a question have the same word count and almost the same length.
- **Gift box**: after every question each player gets one mystery box and taps it to open. Possible gifts: **+300 / +600 points**, **×2 or ×3 of your current score** (at least +300), or **steal 30% from up to 5 random players**. Victims get a notice, the host sees how many boxes were opened, and a gift log shows what everyone got. An unopened box expires when the next question starts. Odds and amounts are in the `GIFT` object at the top of `server.js`.
- **Streak counter**: players see their current streak (and the next bonus) above the buffs, and a 🔥 number sits next to every name on the leaderboards.
- **Cat reactions** (replaced the emoji, see Version 6).
- **Room code and QR are host-only.** Players never see them.
- The "HOW IT WORKS" panel in the lobby is bigger and highlighted, and now explains streaks, gifts and emojis.

## Version 6 changes
- **Cat GIF reactions replace the emoji.** Players tap the 🐱 button and pick a cat. It floats up **only on the host's screen** with the sender's name. Other players never see it, they only get a small "Sent to the host!" message.
- **Limits so the host screen never lags:** one reaction per player every 3 seconds, at most 12 per room every 3 seconds, and at most 8 on the host screen at the same time (extra ones are dropped). Players' phones only download the GIF thumbnails the first time they open the tray.
- **Your own GIFs:** the list is in `reactions.json` (max 12). Put the GIF files in `public/gifs/` using the same names (`popcat.gif`, `nyan.gif`, ...). A reaction without a file shows its fallback emoji, so nothing breaks. Keep each GIF small (under ~500 KB). Direct https links also work in the `gif` field, but links on other websites can break, so local files are safer.
