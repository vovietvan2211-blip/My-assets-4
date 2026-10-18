# Nova City Quiz — Multiplayer Web App

A 20-question real-time quiz based on the uploaded **POSTER.docx**. Built with Node.js, Express, Socket.IO, HTML, CSS and browser JavaScript.

## Features
- Host creates a room and shares a 5-character code.
- Players join from their own phones or computers.
- Host starts each question; answers lock after submission or the timer expires.
- After each question, everyone sees the answer distribution (A/B/C/D), explanation, and updated leaderboard.
- Point choices: ×1 (default), ×2, ×3, or All-in. Correct answers award 1,000 base points times the multiplier; a wrong All-in answer resets the player's score to zero. A wrong ×2/×3 answer earns no points for that question but does not subtract existing points.
- 10/15/20/30-second timer choices.
- Responsive sci-fi interface, timer animations, result transitions, and simple audio feedback.
- Up to 100 players per room in this in-memory prototype.

## Run locally
1. Install Node.js 18 or newer: https://nodejs.org/
2. Extract the ZIP.
3. Open a terminal in the project folder.
4. Run:
   ```bash
   npm install
   npm start
   ```
5. Open `http://localhost:3000` on the host computer.

For other devices on the **same Wi-Fi**, use the host computer's local IP address, for example `http://192.168.1.25:3000`. Allow Node.js through the computer's firewall if prompted. This local-network approach is not the same as public internet hosting.

## Deploy online
For players to join from different networks, deploy this project to a Node.js host that supports WebSockets (for example, Render, Railway, or a VPS).

General deployment steps:
1. Create a new web service from this project or its Git repository.
2. Build/install command: `npm install`
3. Start command: `npm start`
4. The app listens on `process.env.PORT`, as required by most hosts.
5. Open the HTTPS URL provided by the host. The host and players should use that same URL.

**Important prototype limits:** rooms and scores are stored in server memory. Restarting/redeploying the service clears active rooms. This version is designed for one server instance; do not scale it to multiple instances without adding a shared Socket.IO adapter and shared persistent room state. A host leaving closes that room. For a classroom activity, keep the host browser open for the whole game.

## Project structure
- `server.js` — question bank, room state, answer validation, timer and scoring.
- `public/index.html` — screens and markup.
- `public/style.css` — responsive visual design and animations.
- `public/app.js` — browser interaction and Socket.IO client.
- `package.json` — Node dependencies and start script.

## Question source
Questions are based on the poster's descriptions of Mars location, glass domes, five zones, city systems, population, skyscrapers, transport, housing, AI, safety, healthcare and challenges. They are paraphrased into multiple-choice questions for quiz use.
