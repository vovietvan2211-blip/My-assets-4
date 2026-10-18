"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const QUESTIONS = require("./questions.json");

/* ------------------------------------------------------------------ */
/* Config - tweak the game here                                        */
/* ------------------------------------------------------------------ */
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 100;
const MAX_ROOMS = 200;
const DURATIONS = [10, 15, 20, 30];
const PLAYER_GRACE_MS = 60_000; // lobby: how long a dropped player keeps their seat
const HOST_GRACE_MS = 120_000; // how long a dropped host can come back
const ROOM_TTL_MS = 3 * 60 * 60 * 1000; // idle rooms are cleaned up
const ANSWER_GRACE_MS = 300; // network slack after the timer hits zero
const EARLY_FINISH_DELAY_MS = 900; // pause after the last answer before revealing

// Speed scoring: answering instantly = maxPoints, at the buzzer = minPoints.
// The result is then multiplied by the chosen bet.
//   mult    : multiplier applied to speed points when correct
//   penalty : points lost when wrong (never goes below 0)
//   wipe    : wrong answer resets the whole score to 0
const SCORING = {
  maxPoints: 1000,
  minPoints: 100,
  bets: {
    x1: { label: "×1", mult: 1, penalty: 0 },
    x2: { label: "×2", mult: 2, penalty: 250 },
    x3: { label: "×3", mult: 3, penalty: 500 },
    allin: { label: "ALL-IN", mult: 5, wipe: true },
  },
};

QUESTIONS.forEach((q, i) => {
  const ok =
    q.q &&
    Array.isArray(q.options) &&
    q.options.length === 4 &&
    Number.isInteger(q.correct) &&
    q.correct >= 0 &&
    q.correct <= 3;
  if (!ok) throw new Error(`questions.json: question #${i + 1} is invalid`);
});

/* ------------------------------------------------------------------ */
/* App setup                                                           */
/* ------------------------------------------------------------------ */
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.send("ok"));

const rooms = new Map();
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const now = () => Date.now();

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanName(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

function cleanId(value) {
  const s = String(value || "");
  return /^[a-f0-9]{16,64}$/i.test(s) ? s : null;
}

function cleanCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);
}

function limited(socket, key, max, windowMs) {
  const bucket = socket.data.rl || (socket.data.rl = {});
  const t = now();
  const e = bucket[key];
  if (!e || t - e.start > windowMs) {
    bucket[key] = { start: t, n: 1 };
    return false;
  }
  e.n++;
  return e.n > max;
}

function speedPoints(remainingMs, durationMs) {
  const f = Math.min(1, Math.max(0, remainingMs / durationMs));
  const raw = SCORING.minPoints + (SCORING.maxPoints - SCORING.minPoints) * f;
  return Math.round(raw / 10) * 10;
}

function on(socket, event, handler) {
  socket.on(event, (payload, cb) => {
    const reply = typeof cb === "function" ? cb : () => {};
    try {
      handler(payload && typeof payload === "object" ? payload : {}, reply);
    } catch (err) {
      console.error(`[${event}]`, err);
      reply({ ok: false, error: "Server error. Please try again." });
    }
  });
}

/* ------------------------------------------------------------------ */
/* Room state helpers                                                  */
/* ------------------------------------------------------------------ */
function publicPlayers(room) {
  return [...room.players.values()]
    .map((p) => ({ name: p.name, score: p.score, connected: p.connected, answered: !!p.answer }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function rankOf(room, player) {
  let higher = 0;
  for (const p of room.players.values()) if (p.score > player.score) higher++;
  return higher + 1;
}

function connectedPlayers(room) {
  return [...room.players.values()].filter((p) => p.connected);
}

function clearTimers(room) {
  if (room.timer) clearTimeout(room.timer);
  if (room.earlyTimer) clearTimeout(room.earlyTimer);
  room.timer = null;
  room.earlyTimer = null;
}

function questionPayload(room) {
  const q = QUESTIONS[room.questionIndex];
  return {
    index: room.questionIndex,
    total: QUESTIONS.length,
    category: q.category,
    q: q.q,
    options: room.current.options,
    duration: room.duration,
    remainingMs: Math.max(0, room.deadline - now()),
    scoring: SCORING,
    players: publicPlayers(room),
  };
}

function snapshot(room, role, clientId) {
  const p = role === "player" ? room.players.get(clientId) : null;
  return {
    code: room.code,
    role,
    myName: role === "host" ? room.hostName : p.name,
    hostName: room.hostName,
    hostConnected: room.hostConnected,
    state: room.state,
    duration: room.duration,
    total: QUESTIONS.length,
    questionIndex: room.questionIndex,
    scoring: SCORING,
    players: publicPlayers(room),
    question: room.state === "question" ? questionPayload(room) : null,
    result: room.state === "results" ? room.result : null,
    final: room.state === "final" ? publicPlayers(room) : null,
    me: p
      ? {
          answered: !!p.answer,
          choice: p.answer ? p.answer.choice : null,
          bet: p.answer ? p.answer.bet : null,
          last: p.last,
          rank: rankOf(room, p),
          score: p.score,
        }
      : null,
  };
}

function sendLobby(room) {
  io.to(room.code).emit("lobby", {
    code: room.code,
    players: publicPlayers(room),
    state: room.state,
    questionIndex: room.questionIndex,
  });
}

function attach(socket, room, role, clientId) {
  socket.join(room.code);
  socket.data.code = room.code;
  socket.data.role = role;
  socket.data.clientId = clientId;
}

function closeRoom(code, message) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimers(room);
  if (room.hostTimer) clearTimeout(room.hostTimer);
  for (const p of room.players.values()) if (p.removeTimer) clearTimeout(p.removeTimer);
  if (message) io.to(code).emit("roomClosed", message);
  io.in(code).socketsLeave(code);
  rooms.delete(code);
}

function ctxOf(socket, need) {
  const room = rooms.get(socket.data.code);
  if (!room) return { ok: false, error: "Room not found." };
  room.lastActivity = now();
  if (need === "host") {
    const isHost =
      socket.data.role === "host" && room.hostId === socket.data.clientId && room.hostSocketId === socket.id;
    if (!isHost) return { ok: false, error: "Host only." };
    return { ok: true, room };
  }
  if (need === "player") {
    const player = room.players.get(socket.data.clientId);
    if (!player || socket.data.role !== "player" || player.socketId !== socket.id) {
      return { ok: false, error: "You are not in this room." };
    }
    return { ok: true, room, player };
  }
  return { ok: true, room };
}

/* ------------------------------------------------------------------ */
/* Game flow                                                           */
/* ------------------------------------------------------------------ */
function maybeFinishEarly(room) {
  if (room.state !== "question" || room.earlyTimer) return;
  const active = connectedPlayers(room);
  if (active.length && active.every((p) => p.answer)) {
    room.earlyTimer = setTimeout(() => finishQuestion(room.code), EARLY_FINISH_DELAY_MS);
  }
}

function finishQuestion(code) {
  const room = rooms.get(code);
  if (!room || room.state !== "question") return;
  clearTimers(room);

  const q = QUESTIONS[room.questionIndex];
  const cur = room.current;
  const counts = [0, 0, 0, 0];
  let correctCount = 0;
  let answeredCount = 0;

  for (const p of room.players.values()) {
    const a = p.answer;
    if (!a) {
      p.last = { status: "none", gained: 0 };
      continue;
    }
    answeredCount++;
    counts[a.choice]++;
    const rule = SCORING.bets[a.bet];
    const isCorrect = a.choice === cur.correct;
    let gained = 0;
    if (isCorrect) {
      correctCount++;
      gained = a.speedPoints * rule.mult;
      p.score += gained;
    } else if (rule.wipe) {
      gained = p.score > 0 ? -p.score : 0;
      p.score = 0;
    } else {
      const loss = Math.min(rule.penalty || 0, p.score);
      gained = -loss;
      p.score -= loss;
    }
    p.last = {
      status: isCorrect ? "correct" : "wrong",
      choice: a.choice,
      bet: a.bet,
      gained,
      speedPoints: a.speedPoints,
      answerTimeMs: a.answerTimeMs,
    };
  }

  room.state = "results";
  room.deadline = 0;
  room.result = {
    index: room.questionIndex,
    total: QUESTIONS.length,
    question: q.q,
    options: cur.options,
    correct: cur.correct,
    correctText: cur.options[cur.correct],
    counts,
    correctCount,
    answeredCount,
    totalPlayers: room.players.size,
    explain: q.explain,
    leaderboard: publicPlayers(room),
  };

  io.to(room.hostSocketId).emit("results", { result: room.result, me: null });
  for (const p of room.players.values()) {
    if (!p.connected) continue;
    io.to(p.socketId).emit("results", {
      result: room.result,
      me: { last: p.last, rank: rankOf(room, p), score: p.score },
    });
  }
  sendLobby(room);
}

function startNext(room) {
  // After the last question the host's "next" button ends the game.
  if (room.questionIndex + 1 >= QUESTIONS.length) {
    room.state = "final";
    room.deadline = 0;
    io.to(room.code).emit("gameOver", { leaderboard: publicPlayers(room), total: QUESTIONS.length });
    sendLobby(room);
    return { ok: true, final: true };
  }

  const idx = ++room.questionIndex;
  const q = QUESTIONS[idx];
  const order = shuffle([0, 1, 2, 3]);
  room.current = {
    options: order.map((i) => q.options[i]),
    correct: order.indexOf(q.correct),
  };
  room.state = "question";
  room.result = null;
  room.startedAt = now();
  room.deadline = room.startedAt + room.duration * 1000;
  for (const p of room.players.values()) {
    p.answer = null;
    p.last = null;
  }
  clearTimers(room);
  room.timer = setTimeout(() => finishQuestion(room.code), room.duration * 1000 + ANSWER_GRACE_MS);
  io.to(room.code).emit("question", questionPayload(room));
  sendLobby(room);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Sockets                                                             */
/* ------------------------------------------------------------------ */
io.on("connection", (socket) => {
  on(socket, "createRoom", (p, reply) => {
    if (limited(socket, "create", 5, 60_000)) {
      return reply({ ok: false, error: "Too many attempts. Please wait a moment." });
    }
    if (socket.data.code) return reply({ ok: false, error: "You are already in a room." });
    const clientId = cleanId(p.clientId);
    if (!clientId) return reply({ ok: false, error: "Invalid session. Refresh the page." });
    if (rooms.size >= MAX_ROOMS) return reply({ ok: false, error: "Server is busy. Try again later." });

    const room = {
      code: makeCode(),
      hostId: clientId,
      hostSocketId: socket.id,
      hostName: cleanName(p.name) || "Host",
      hostConnected: true,
      hostTimer: null,
      players: new Map(),
      state: "lobby",
      questionIndex: -1,
      duration: DURATIONS.includes(Number(p.duration)) ? Number(p.duration) : 15,
      startedAt: 0,
      deadline: 0,
      current: null,
      result: null,
      timer: null,
      earlyTimer: null,
      lastActivity: now(),
    };
    rooms.set(room.code, room);
    attach(socket, room, "host", clientId);
    reply({ ok: true, snapshot: snapshot(room, "host", clientId) });
    sendLobby(room);
  });

  on(socket, "joinRoom", (p, reply) => {
    if (limited(socket, "join", 12, 30_000)) {
      return reply({ ok: false, error: "Too many attempts. Please wait a moment." });
    }
    if (socket.data.code) return reply({ ok: false, error: "You are already in a room." });
    const clientId = cleanId(p.clientId);
    if (!clientId) return reply({ ok: false, error: "Invalid session. Refresh the page." });

    const room = rooms.get(cleanCode(p.code));
    if (!room) return reply({ ok: false, error: "Room not found. Check the code and try again." });
    if (room.hostId === clientId) return reply({ ok: false, error: "You are the host of this room." });
    room.lastActivity = now();

    // Same browser joining again = treat as a reconnect.
    const existing = room.players.get(clientId);
    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;
      if (existing.removeTimer) clearTimeout(existing.removeTimer);
      attach(socket, room, "player", clientId);
      reply({ ok: true, snapshot: snapshot(room, "player", clientId) });
      return sendLobby(room);
    }

    if (room.state === "question") {
      return reply({ ok: false, error: "A question is running right now. Try again in a few seconds." });
    }
    if (room.state === "final") return reply({ ok: false, error: "This game has already finished." });
    if (room.players.size >= MAX_PLAYERS) return reply({ ok: false, error: "This room is full." });

    const name = cleanName(p.name);
    if (!name) return reply({ ok: false, error: "Enter a nickname first." });
    const taken = [...room.players.values()].some((x) => x.name.toLowerCase() === name.toLowerCase());
    if (taken) return reply({ ok: false, error: "That nickname is already taken in this room." });

    room.players.set(clientId, {
      id: clientId,
      socketId: socket.id,
      name,
      score: 0,
      connected: true,
      answer: null,
      last: null,
      removeTimer: null,
    });
    attach(socket, room, "player", clientId);
    reply({ ok: true, snapshot: snapshot(room, "player", clientId) });
    sendLobby(room);
  });

  on(socket, "rejoin", (p, reply) => {
    const clientId = cleanId(p.clientId);
    const room = rooms.get(cleanCode(p.code));
    if (!clientId || !room) return reply({ ok: false, error: "That game is no longer available." });
    room.lastActivity = now();

    if (room.hostId === clientId) {
      if (room.hostTimer) clearTimeout(room.hostTimer);
      room.hostTimer = null;
      room.hostSocketId = socket.id;
      room.hostConnected = true;
      attach(socket, room, "host", clientId);
      io.to(room.code).emit("hostStatus", { connected: true });
      return reply({ ok: true, snapshot: snapshot(room, "host", clientId) });
    }

    const player = room.players.get(clientId);
    if (!player) return reply({ ok: false, error: "Your seat in that game has expired." });
    if (player.removeTimer) clearTimeout(player.removeTimer);
    player.removeTimer = null;
    player.socketId = socket.id;
    player.connected = true;
    attach(socket, room, "player", clientId);
    reply({ ok: true, snapshot: snapshot(room, "player", clientId) });
    sendLobby(room);
  });

  on(socket, "startQuestion", (_p, reply) => {
    const ctx = ctxOf(socket, "host");
    if (!ctx.ok) return reply(ctx);
    const room = ctx.room;
    if (room.state === "question") return reply({ ok: false, error: "A question is already running." });
    if (room.state === "final") return reply({ ok: false, error: "Game is over." });
    if (room.state === "lobby" && connectedPlayers(room).length === 0) {
      return reply({ ok: false, error: "Wait for at least one player to join." });
    }
    reply(startNext(room));
  });

  on(socket, "submitAnswer", (p, reply) => {
    const ctx = ctxOf(socket, "player");
    if (!ctx.ok) return reply(ctx);
    const { room, player } = ctx;
    if (room.state !== "question") return reply({ ok: false, error: "No question is accepting answers." });
    const remainingMs = room.deadline - now();
    if (remainingMs < -ANSWER_GRACE_MS) return reply({ ok: false, error: "Time is up." });
    if (player.answer) return reply({ ok: false, error: "Your answer is already locked." });

    const choice = Number(p.choice);
    if (![0, 1, 2, 3].includes(choice)) return reply({ ok: false, error: "Invalid answer." });
    const bet = Object.prototype.hasOwnProperty.call(SCORING.bets, p.bet) ? p.bet : "x1";

    const durationMs = room.duration * 1000;
    const remaining = Math.max(0, remainingMs);
    player.answer = {
      choice,
      bet,
      speedPoints: speedPoints(remaining, durationMs),
      answerTimeMs: durationMs - remaining,
    };
    reply({ ok: true });

    const active = connectedPlayers(room);
    io.to(room.hostSocketId).emit("answerProgress", {
      answered: active.filter((x) => x.answer).length,
      total: active.length,
    });
    sendLobby(room);
    maybeFinishEarly(room);
  });

  on(socket, "endQuestion", (_p, reply) => {
    const ctx = ctxOf(socket, "host");
    if (!ctx.ok) return reply(ctx);
    if (ctx.room.state !== "question") return reply({ ok: false, error: "No active question." });
    finishQuestion(ctx.room.code);
    reply({ ok: true });
  });

  on(socket, "leaveRoom", (_p, reply) => {
    const room = rooms.get(socket.data.code);
    if (!room) return reply({ ok: true });
    if (socket.data.role === "host" && room.hostId === socket.data.clientId) {
      closeRoom(room.code, "The host closed the room.");
    } else {
      const p = room.players.get(socket.data.clientId);
      if (p) {
        if (p.removeTimer) clearTimeout(p.removeTimer);
        room.players.delete(socket.data.clientId);
        socket.leave(room.code);
        sendLobby(room);
        maybeFinishEarly(room);
      }
    }
    socket.data.code = null;
    reply({ ok: true });
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;

    if (socket.data.role === "host" && room.hostId === socket.data.clientId) {
      if (room.hostSocketId !== socket.id) return; // host already reconnected elsewhere
      room.hostConnected = false;
      io.to(room.code).emit("hostStatus", { connected: false });
      if (room.hostTimer) clearTimeout(room.hostTimer);
      room.hostTimer = setTimeout(() => closeRoom(room.code, "The host did not return."), HOST_GRACE_MS);
      return;
    }

    const p = room.players.get(socket.data.clientId);
    if (!p || p.socketId !== socket.id) return; // player already reconnected on a new socket
    p.connected = false;
    if (room.state === "lobby") {
      p.removeTimer = setTimeout(() => {
        if (!p.connected && room.players.get(p.id) === p) {
          room.players.delete(p.id);
          sendLobby(room);
        }
      }, PLAYER_GRACE_MS);
    }
    sendLobby(room);
    maybeFinishEarly(room);
  });
});

// Clean up abandoned rooms.
setInterval(() => {
  const t = now();
  for (const room of [...rooms.values()]) {
    if (t - room.lastActivity > ROOM_TTL_MS) closeRoom(room.code, "This room expired.");
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Nova City Quiz running on port ${PORT}`));
