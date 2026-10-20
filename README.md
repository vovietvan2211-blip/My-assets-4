# Nova City Quiz — Multiplayer Web App (v2)

A 20-question real-time quiz based on the **Nova City poster** (Mars mega-city, zones, city systems, travel, housing and AI). Built with Node.js, Express, Socket.IO, HTML, CSS and browser JavaScript.

## How the game works
- The host creates a room and shares the 5-character code. Players join from their own phones or computers.
- The host launches each question. The round ends when the timer runs out **or as soon as every connected player has answered**.
- After each question everyone sees the correct answer, an explanation and the A/B/C/D distribution. Each player also gets a personal card: right or wrong, points gained or lost, and current rank.
- After question 20 the host reveals the final standings, and **every player's screen** switches to the podium.

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
The 20 questions are in `questions.json`, written from the poster text. Put the correct answer **first** in each `options` list (`"correct": 0`); the server shuffles the answer order every time a question is asked, so the correct answer lands on A/B/C/D at random. Add or edit questions freely, but every question needs exactly 4 options.

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
\n\n## Version 2.2 polish\n- Rebalanced answer choices and shuffled correct-answer positions to reduce guessing by pattern.\n- Hid the live “points if you answer now” preview; the timer and speed-based scoring remain unchanged.\n- Made multiplier/buff choices more visually prominent.\n- Added rotating encouragement messages, a consecutive-correct streak bonus (+100 per extra correct answer, capped at +500), and an animated top-three podium with fireworks at the end.\n