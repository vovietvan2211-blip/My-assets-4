(() => {
  "use strict";

  const socket = io();
  const $ = (id) => document.getElementById(id);
  const SCREENS = ["home", "lobby", "game", "results", "final"];
  const LETTERS = ["A", "B", "C", "D"];
  const MINUS = "\u2212";

  /* ---------------------------------------------------------------- */
  /* Persistent identity (lets a player come back after a dropped     */
  /* connection or a page refresh)                                    */
  /* ---------------------------------------------------------------- */
  const store = {
    get(k) {
      try { return localStorage.getItem(k); } catch (e) { return null; }
    },
    set(k, v) {
      try { localStorage.setItem(k, v); } catch (e) { /* ignore */ }
    },
    del(k) {
      try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
    },
  };

  function makeId() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  const clientId = (() => {
    let id = store.get("nova.clientId");
    if (!id || !/^[a-f0-9]{16,64}$/i.test(id)) {
      id = makeId();
      store.set("nova.clientId", id);
    }
    return id;
  })();

  function saveSession() {
    store.set("nova.session", JSON.stringify({ code: roomCode }));
  }
  function loadSession() {
    try { return JSON.parse(store.get("nova.session") || "null"); } catch (e) { return null; }
  }
  function clearSession() {
    store.del("nova.session");
  }

  /* ---------------------------------------------------------------- */
  /* State                                                            */
  /* ---------------------------------------------------------------- */
  let role = null;
  let roomCode = null;
  let myName = "";
  let scoring = null;
  let question = null;
  let selectedChoice = null;
  let selectedBet = "x1";
  let lastResult = null;
  let timerHandle = null;
  let timerEnd = 0;
  let timerDuration = 1;
  let toastTimer = null;
  let audioCtx = null;
  let correctStreak = 0;
  let wrongStreak = 0;

  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------------------------------------------------------- */
  /* Small helpers                                                    */
  /* ---------------------------------------------------------------- */
  const fmt = (n) => Number(n || 0).toLocaleString("en-US");
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function showScreen(name) {
    SCREENS.forEach((s) => $(s).classList.toggle("active", s === name));
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
  }

  function setError(id, message) {
    $(id).textContent = message || "";
  }

  function emitAck(event, payload) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(event, payload || {}, (err, res) => {
        resolve(err ? { ok: false, error: "No response from the server. Check your connection." } : res);
      });
    });
  }

  function speedPoints(remainingMs, durationMs) {
    const f = Math.min(1, Math.max(0, remainingMs / durationMs));
    const raw = scoring.minPoints + (scoring.maxPoints - scoring.minPoints) * f;
    return Math.round(raw / 10) * 10;
  }

  function betLabel(key) {
    return scoring && scoring.bets[key] ? scoring.bets[key].label : key;
  }

  function setRole(next) {
    role = next;
    $("startGame").classList.toggle("hidden", role !== "host");
    $("lobbyHint").textContent =
      role === "host"
        ? "Start when everyone has joined. You launch each question and reveal the results."
        : "Waiting for the host to start the mission…";
    $("backHome").textContent = role === "host" ? "← Close room" : "← Leave room";
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                        */
  /* ---------------------------------------------------------------- */
  function renderPlayers(players) {
    $("lobbyPlayers").innerHTML = players
      .map(
        (p) =>
          `<div class="player-chip${p.connected === false ? " offline" : ""}"><span class="avatar">${esc(
            (p.name || "?").slice(0, 1).toUpperCase()
          )}</span><span title="${esc(p.name)}">${esc(p.name)}</span></div>`
      )
      .join("");
    $("emptyPlayers").classList.toggle("hidden", players.length > 0);
    $("playerCount").textContent = `${players.length} PLAYER${players.length === 1 ? "" : "S"}`;
  }

  function ranked(players) {
    return players.map((p) => ({ ...p, rank: 1 + players.filter((o) => o.score > p.score).length }));
  }

  function renderLeaderboard(players, target) {
    const rows = ranked(players);
    const showTick = target === "gameLeaderboard"; // "answered" ticks only matter while a question is live
    $(target).innerHTML =
      rows
        .map((p) => {
          const medal = p.score > 0 ? (p.rank === 1 ? "gold" : p.rank === 2 ? "silver" : p.rank === 3 ? "bronze" : "") : "";
          const mine = role === "player" && p.name === myName;
          return `<div class="leader-row${mine ? " me" : ""}${p.connected === false ? " offline" : ""}">
            <span class="rank ${medal}">${String(p.rank).padStart(2, "0")}</span>
            <span class="leader-name" title="${esc(p.name)}">${esc(p.name)}${mine ? '<em class="you-tag">YOU</em>' : ""}${
            showTick && p.answered === true ? " · ✓" : ""
          }${p.connected === false ? ' <em class="off-tag">OFFLINE</em>' : ""}</span>
            <span class="leader-score">${fmt(p.score)}<small>PTS</small></span>
          </div>`;
        })
        .join("") || '<div class="empty-state">No players yet.</div>';
  }

  function renderBets() {
    const bets = scoring.bets;
    const hints = {
      x1: "SAFE",
      x2: `${MINUS}${bets.x2.penalty} IF WRONG`,
      x3: `${MINUS}${bets.x3.penalty} IF WRONG`,
      allin: `×${bets.allin.mult} · ZERO IF WRONG`,
    };
    $("betOptions").innerHTML = Object.keys(bets)
      .map(
        (k) =>
          `<button type="button" data-bet="${k}" class="bet-option${k === "allin" ? " allin" : ""}${
            k === selectedBet ? " selected" : ""
          }"><b>${esc(bets[k].label)}</b><span>${esc(hints[k] || "")}</span></button>`
      )
      .join("");
  }

  /* ---------------------------------------------------------------- */
  /* Timer + live points                                              */
  /* ---------------------------------------------------------------- */
  function stopTimer() {
    clearInterval(timerHandle);
    timerHandle = null;
  }

  function remainingNow() {
    return Math.max(0, timerEnd - performance.now());
  }

  function startTimer(remainingMs, durationMs) {
    stopTimer();
    timerDuration = durationMs;
    timerEnd = performance.now() + remainingMs;
    tick();
    timerHandle = setInterval(tick, 100);
  }

  function tick() {
    const rem = remainingNow();
    $("timerNum").textContent = Math.ceil(rem / 1000);
    $("timerArc").style.strokeDashoffset = String(276.46 * (1 - rem / timerDuration));
    $("timerRing").classList.toggle("urgent", rem <= 5000 && rem > 0);
    if (role === "player" && selectedChoice === null) updateLive(rem);
    if (rem <= 0) {
      stopTimer();
      onTimeUp();
    }
  }

  function updateLive(rem) {
    if (role !== "player" || !scoring) return;
    const pts = speedPoints(rem, timerDuration);
    const rule = scoring.bets[selectedBet];
    $("livePts").textContent = fmt(pts);
    $("liveMult").textContent = `× ${rule.mult}`;
    $("liveTotal").textContent = `= ${fmt(pts * rule.mult)}`;
    $("liveBar").style.width = `${Math.min(100, (rem / timerDuration) * 100)}%`;
  }

  function onTimeUp() {
    if (role === "player" && selectedChoice === null) {
      $("answers").querySelectorAll("button").forEach((b) => (b.disabled = true));
      $("answers").classList.add("timeup");
      $("betBox").classList.add("hidden");
      $("liveValue").classList.add("hidden");
      toast("Time's up!");
    }
  }

  /* ---------------------------------------------------------------- */
  /* Question screen                                                  */
  /* ---------------------------------------------------------------- */
  function showQuestion(q, me) {
    question = q;
    scoring = q.scoring || scoring;
    selectedChoice = null;
    selectedBet = "x1";
    const isPlayer = role === "player";

    $("questionPill").textContent = `QUESTION ${String(q.index + 1).padStart(2, "0")} / ${q.total}`;
    $("category").textContent = q.category;
    $("questionText").textContent = q.q;
    $("progressFill").style.width = `${(100 * (q.index + 1)) / q.total}%`;
    $("answers").innerHTML = q.options
      .map(
        (a, i) =>
          `<button type="button" class="answer-option" data-choice="${i}" style="--i:${i}"><span class="option-key">${LETTERS[i]}</span><span>${esc(
            a
          )}</span></button>`
      )
      .join("");
    $("answers").querySelectorAll("button").forEach((b) => (b.disabled = !isPlayer));
    $("answers").classList.remove("locked", "timeup", "shake");

    renderBets();
    $("betBox").classList.toggle("hidden", !isPlayer);
    $("liveValue").classList.toggle("hidden", !isPlayer);
    $("answerLocked").classList.add("hidden");
    $("hostControls").classList.toggle("hidden", role !== "host");
    $("hostProgress").textContent = "Waiting for answers…";
    $("endQuestion").disabled = false;
    $("liveCrew").textContent = `${(q.players || []).length} CREW`;
    renderLeaderboard(q.players || [], "gameLeaderboard");
    $("timerRing").classList.remove("urgent");

    // Rejoined after answering: restore the locked state.
    if (isPlayer && me && me.answered) {
      selectedChoice = me.choice;
      selectedBet = me.bet || "x1";
      applyLockedUi(me.choice, "Your answer is in. Hold tight, the results are incoming.");
    }

    showScreen("game");
    startTimer(q.remainingMs, q.duration * 1000);
  }

  function applyLockedUi(choice, info) {
    $("answers").classList.add("locked");
    $("answers").querySelectorAll(".answer-option").forEach((b) => {
      b.disabled = true;
      b.classList.toggle("selected", Number(b.dataset.choice) === choice);
    });
    $("betBox").classList.add("hidden");
    $("liveValue").classList.add("hidden");
    $("answerLocked").classList.remove("hidden");
    $("lockedInfo").textContent = info;
  }

  function rippleAt(btn, x, y) {
    if (reduceMotion || !btn) return;
    const r = btn.getBoundingClientRect();
    const dot = document.createElement("span");
    dot.className = "ans-ripple";
    dot.style.left = `${x == null ? r.width / 2 : x - r.left}px`;
    dot.style.top = `${y == null ? r.height / 2 : y - r.top}px`;
    btn.appendChild(dot);
    setTimeout(() => dot.remove(), 650);
  }

  function shakeAnswers() {
    const g = $("answers");
    g.classList.remove("shake");
    void g.offsetWidth; // restart the animation
    g.classList.add("shake");
  }

  async function chooseAnswer(choice) {
    if (role !== "player" || selectedChoice !== null || !question || !scoring) return;
    const rem = remainingNow();
    if (rem <= 0) return;
    const pts = speedPoints(rem, timerDuration);
    const rule = scoring.bets[selectedBet];
    selectedChoice = choice;
    applyLockedUi(choice, `Locked in at ${(((timerDuration - rem) / 1000)).toFixed(1)}s · about ${fmt(pts)} speed pts × ${rule.mult} if correct.`);

    const res = await emitAck("submitAnswer", { choice, bet: selectedBet });
    if (!res || !res.ok) {
      // Roll back so the player can try again (unless time ran out).
      selectedChoice = null;
      $("answerLocked").classList.add("hidden");
      $("answers").classList.remove("locked");
      shakeAnswers();
      if (remainingNow() > 0) {
        $("answers").querySelectorAll(".answer-option").forEach((b) => {
          b.disabled = false;
          b.classList.remove("selected");
        });
        $("betBox").classList.remove("hidden");
        $("liveValue").classList.remove("hidden");
      }
      toast((res && res.error) || "Could not submit your answer.");
    }
  }

  /* ---------------------------------------------------------------- */
  /* Results screen                                                   */
  /* ---------------------------------------------------------------- */
  function renderMyResult(me) {
    const el = $("myResult");
    // No record at all = the player joined after this question ended, so there is nothing to show.
    if (role !== "player" || !me || !me.last) {
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden", "correct", "wrong", "none");
    const last = me.last;
    const standing = `Rank #${me.rank} · ${fmt(me.score)} pts total`;
    if (!last || last.status === "none") {
      el.classList.add("none");
      $("myHead").textContent = "NO ANSWER";
      $("myDelta").textContent = "+0";
      $("myDetail").textContent = "You ran out of time. Lock in faster next round!";
    } else if (last.status === "correct") {
      el.classList.add("correct");
      $("myHead").textContent = "CORRECT";
      $("myDelta").textContent = `+${fmt(last.gained)}`;
      $("myDetail").textContent = `Answered in ${(last.answerTimeMs / 1000).toFixed(1)}s · ${fmt(last.speedPoints)} speed pts × ${betLabel(
        last.bet
      )}${last.streakBonus ? ` · +${fmt(last.streakBonus)} streak bonus (${last.streak} in a row!)` : last.streak > 1 ? ` · ${last.streak} in a row!` : ""}`;
    } else {
      el.classList.add("wrong");
      $("myHead").textContent = "INCORRECT";
      $("myDelta").textContent = last.gained === 0 ? "+0" : `${MINUS}${fmt(-last.gained)}`;
      $("myDetail").textContent =
        last.bet === "allin"
          ? "All-in missed. Your score was reset to zero."
          : last.gained === 0
          ? "No penalty on the safe ×1 bet."
          : `Penalty for the ${betLabel(last.bet)} bet.`;
    }
    $("myStanding").textContent = standing;
  }

  function showResults(result, me) {
    stopTimer();
    lastResult = result;
    const isLast = result.index + 1 >= result.total;
    const mineChoice = me && me.last && me.last.status !== "none" ? me.last.choice : null;

    $("resultTitle").innerHTML = `QUESTION <span>${String(result.index + 1).padStart(2, "0")} COMPLETE</span>`;
    $("resultQuestion").textContent = result.question || "";
    $("correctAnswer").textContent = result.correctText || LETTERS[result.correct];
    $("explanation").textContent = result.explain || "";

    const answered = result.counts.reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...result.counts);
    $("responseTotal").textContent = `${answered} RESPONSE${answered === 1 ? "" : "S"}`;
    $("distribution").innerHTML = result.counts
      .map(
        (count, i) => `<div class="dist-row${i === result.correct ? " correct-dist" : ""}${i === mineChoice ? " mine" : ""}">
          <span class="dist-key">${LETTERS[i]}</span>
          <div class="dist-main"><span class="dist-label">${esc(result.options[i])}</span><div class="dist-bar"><div class="dist-fill" style="width:${(count / max) * 100}%"></div></div></div>
          <span class="dist-count">${count}</span>
        </div>`
      )
      .join("");
    $("answerCounts").textContent = `${result.correctCount} correct · ${Math.max(0, result.totalPlayers - answered)} did not answer`;

    renderMyResult(me);
    renderLeaderboard(result.leaderboard || [], "resultsLeaderboard");
    if (role === "player" && me && me.last) {
      const good = [
        "Clean answer! Keep that momentum going.",
        "Nice one — you clearly know your stuff.",
        "That's the kind of answer that moves you up.",
        "Great read! Stay sharp for the next question.",
        "Brilliant — you're building a strong run."
      ];
      const tryAgain = [
        "No stress. One question doesn't decide the whole game.",
        "Shake it off — the next question is a fresh start.",
        "Not this time, but you're still in the race.",
        "Take a breath, read carefully, and go again.",
        "Every miss teaches you something. Keep going."
      ];
      if (me.last.status === "correct") { correctStreak++; wrongStreak = 0; }
      else if (me.last.status === "wrong" || me.last.status === "none") { wrongStreak++; correctStreak = 0; }
      const tips = document.querySelector("#results .score-tip");
      if (tips) {
        const msg = me.last.status === "correct" ? good[(result.index + correctStreak - 1) % good.length] : tryAgain[(result.index + wrongStreak - 1) % tryAgain.length];
        tips.innerHTML = `<span>✦</span><p><b>${me.last.status === "correct" ? "Nice work!" : "You’ve got this"}</b>${esc(msg)}${wrongStreak >= 2 ? " Comeback time: try the ×2 buff next round if you're confident." : ""}</p>`;
      }
    }

    $("hostNextControls").classList.toggle("hidden", role !== "host");
    $("nextQuestion").textContent = isLast ? "VIEW FINAL STANDINGS →" : "NEXT QUESTION →";
    $("playerWait").classList.toggle("hidden", role === "host");
    $("playerWait").textContent = isLast
      ? "That was the last question. Waiting for the host to reveal the final standings…"
      : "Waiting for the host to launch the next question…";

    showScreen("results");

    if (role === "player" && me && me.last) {
      if (me.last.status === "correct") sfx("correct");
      else if (me.last.status === "wrong") sfx("wrong");
    }
  }

  function showFinal(players) {
    stopTimer();
    renderLeaderboard(players, "finalLeaderboard");
    const podium = $("podium");
    const top = ranked(players).slice(0, 3);
    const places = [2, 1, 3];
    podium.innerHTML = top.length ? places.map((rank) => {
      const p = top.find((x) => x.rank === rank);
      if (!p) return `<div class="podium-place empty"></div>`;
      return `<div class="podium-place place-${rank}"><div class="podium-crown">${rank === 1 ? "👑" : rank === 2 ? "🥈" : "🥉"}</div><b class="podium-name">${esc(p.name)}</b><span class="podium-score">${fmt(p.score)} pts</span><div class="podium-step"><strong>${rank}</strong></div></div>`;
    }).join("") : "";
    const you = $("finalYou");
    if (role === "player") {
      const mine = ranked(players).find((p) => p.name === myName);
      if (mine) {
        you.textContent = `You finished #${mine.rank} with ${fmt(mine.score)} points.`;
        you.classList.remove("hidden");
      }
    } else {
      you.classList.add("hidden");
    }
    showScreen("final");
  }

  /* ---------------------------------------------------------------- */
  /* Sound (tiny synth, created on first tap so mobile browsers allow */
  /* it)                                                              */
  /* ---------------------------------------------------------------- */
  function unlockAudio() {
    try {
      if (!audioCtx) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (C) audioCtx = new C();
      }
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) { /* ignore */ }
  }
  document.addEventListener("pointerdown", unlockAudio, { once: false });

  function tone(freq, start, dur, gain) {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    const t = audioCtx.currentTime + start;
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain || 0.05, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur);
  }

  function sfx(kind) {
    try {
      if (kind === "correct") { tone(660, 0, 0.12); tone(880, 0.12, 0.2); }
      if (kind === "wrong") { tone(247, 0, 0.18); tone(196, 0.16, 0.28); }
    } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- */
  /* QR code to join the room                                         */
  /* ---------------------------------------------------------------- */
  let baseUrl = location.origin;
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  // Playing on localhost? Phones can't open that, so use the computer's Wi-Fi address instead.
  if (isLocalHost) {
    fetch("/api/lan", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.urls && d.urls.length) {
          baseUrl = d.urls[0];
          if (roomCode) renderQr();
        }
      })
      .catch(() => {});
  }

  function joinUrl() {
    return `${baseUrl}/?room=${encodeURIComponent(roomCode)}`;
  }

  function renderQr() {
    const box = $("qrBox");
    if (!box || !roomCode || !window.NovaQR) return;
    const url = joinUrl();
    try {
      box.innerHTML = NovaQR.toSvg(url, { dark: "#071116", light: "#ffffff", margin: 2 });
    } catch (e) {
      box.textContent = "";
    }
    const link = $("qrLink");
    link.textContent = url.replace(/^https?:\/\//, "");
    link.href = url;
    $("qrHint").textContent =
      isLocalHost && baseUrl === location.origin
        ? "Phones can't open localhost. Open this page via your computer's Wi-Fi IP address."
        : "Point a phone camera at the code. Same Wi-Fi needed when playing locally.";
  }

  // Opened from a QR code (?room=ABCDE): jump straight to the join form.
  (function openFromLink() {
    const code = new URLSearchParams(location.search).get("room");
    if (!code) return;
    const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
    if (!clean) return;
    $("roomCode").value = clean;
    $("joinPanel").classList.remove("hidden");
    $("createPanel").classList.add("hidden");
    $("playerName").focus();
    try { history.replaceState(null, "", location.pathname); } catch (e) { /* ignore */ }
  })();

  /* ---------------------------------------------------------------- */
  /* Applying server state (join, create, reconnect)                  */
  /* ---------------------------------------------------------------- */
  function applySnapshot(s) {
    roomCode = s.code;
    myName = s.myName;
    scoring = s.scoring || scoring;
    setRole(s.role);
    saveSession();
    $("lobbyCode").textContent = s.code;
    renderQr();
    renderPlayers(s.players || []);

    if (s.state === "question" && s.question) showQuestion(s.question, s.me);
    else if (s.state === "results" && s.result) showResults(s.result, s.me);
    else if (s.state === "final") showFinal(s.final || []);
    else showScreen("lobby");

    if (s.role === "player" && s.hostConnected === false) toast("The host is reconnecting…");
  }

  function resetToHome() {
    stopTimer();
    roomCode = null;
    role = null;
    myName = "";
    question = null;
    lastResult = null;
    correctStreak = 0; wrongStreak = 0;
    showScreen("home");
  }

  async function leaveRoom() {
    if (role === "host" && !window.confirm("Close the room? Everyone will be disconnected.")) return;
    await emitAck("leaveRoom", {});
    clearSession();
    location.reload();
  }

  function setConn(online) {
    $("connStatus").classList.toggle("offline", !online);
    $("connText").textContent = online ? "MARS NETWORK ONLINE" : "RECONNECTING…";
  }

  /* ---------------------------------------------------------------- */
  /* UI events                                                        */
  /* ---------------------------------------------------------------- */
  $("showCreate").onclick = () => {
    $("createPanel").classList.remove("hidden");
    $("joinPanel").classList.add("hidden");
    $("hostName").focus();
  };
  $("showJoin").onclick = () => {
    $("joinPanel").classList.remove("hidden");
    $("createPanel").classList.add("hidden");
    $("roomCode").focus();
  };
  $("roomCode").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  });

  $("createBtn").onclick = async () => {
    setError("createError", "");
    const btn = $("createBtn");
    btn.disabled = true;
    const res = await emitAck("createRoom", {
      name: $("hostName").value.trim() || "Host",
      duration: Number($("duration").value),
      clientId,
    });
    btn.disabled = false;
    if (!res || !res.ok) return setError("createError", (res && res.error) || "Unable to create room.");
    applySnapshot(res.snapshot);
    toast("Room created. Share the code with your players.");
  };

  async function join() {
    setError("joinError", "");
    const btn = $("joinBtn");
    btn.disabled = true;
    const res = await emitAck("joinRoom", {
      code: $("roomCode").value.trim(),
      name: $("playerName").value.trim(),
      clientId,
    });
    btn.disabled = false;
    if (!res || !res.ok) return setError("joinError", (res && res.error) || "Unable to join.");
    applySnapshot(res.snapshot);
    toast(`Welcome to Nova City, ${res.snapshot.myName}!`);
  }
  $("joinBtn").onclick = join;
  $("playerName").addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
  $("roomCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("playerName").focus(); });

  $("copyCode").onclick = async () => {
    try {
      await navigator.clipboard.writeText(roomCode);
      toast("Room code copied!");
    } catch (e) {
      toast(`Room code: ${roomCode}`);
    }
  };

  $("startGame").onclick = async () => {
    if (role !== "host") return;
    const res = await emitAck("startQuestion", {});
    if (!res || !res.ok) toast((res && res.error) || "Could not start the game.");
  };

  $("endQuestion").onclick = async () => {
    const res = await emitAck("endQuestion", {});
    if (!res || !res.ok) toast((res && res.error) || "Could not end the question.");
  };

  $("nextQuestion").onclick = async () => {
    const btn = $("nextQuestion");
    btn.disabled = true;
    const res = await emitAck("startQuestion", {});
    btn.disabled = false;
    if (!res || !res.ok) toast((res && res.error) || "Could not continue.");
  };

  $("backHome").onclick = leaveRoom;
  $("newGame").onclick = async () => {
    await emitAck("leaveRoom", {});
    clearSession();
    location.reload();
  };

  // Answer + bet buttons (event delegation)
  $("answers").addEventListener("click", (e) => {
    const b = e.target.closest(".answer-option");
    if (b && !b.disabled) {
      rippleAt(b, e.clientX, e.clientY);
      chooseAnswer(Number(b.dataset.choice));
    }
  });
  $("betOptions").addEventListener("click", (e) => {
    const b = e.target.closest(".bet-option");
    if (!b || selectedChoice !== null) return;
    selectedBet = b.dataset.bet;
    $("betOptions").querySelectorAll(".bet-option").forEach((x) => x.classList.toggle("selected", x === b));
    updateLive(remainingNow());
  });

  // Keyboard: A-D or 1-4 to answer
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    if (!$("game").classList.contains("active") || role !== "player") return;
    const k = e.key.toLowerCase();
    let idx = "abcd".indexOf(k);
    if (idx < 0) idx = "1234".indexOf(k);
    if (idx >= 0) {
      const b = $("answers").querySelectorAll(".answer-option")[idx];
      if (b && !b.disabled) rippleAt(b);
      chooseAnswer(idx);
    }
  });

  /* ---------------------------------------------------------------- */
  /* Socket events                                                    */
  /* ---------------------------------------------------------------- */
  socket.on("lobby", (data) => {
    if (data.code !== roomCode) return;
    const players = data.players || [];
    renderPlayers(players);
    if ($("game").classList.contains("active")) {
      renderLeaderboard(players, "gameLeaderboard");
      $("liveCrew").textContent = `${players.length} CREW`;
      if (role === "host") {
        const online = players.filter((p) => p.connected);
        $("hostProgress").textContent = `${online.filter((p) => p.answered).length} / ${online.length} answers locked`;
      }
    }
  });

  socket.on("question", (q) => {
    if (roomCode) showQuestion(q, null);
  });

  socket.on("answerProgress", (d) => {
    if (role === "host") $("hostProgress").textContent = `${d.answered} / ${d.total} answers locked`;
  });

  socket.on("results", ({ result, me }) => {
    if (roomCode) showResults(result, me);
  });

  socket.on("gameOver", ({ leaderboard }) => {
    if (roomCode) showFinal(leaderboard || []);
  });

  socket.on("hostStatus", ({ connected }) => {
    if (role === "player") toast(connected ? "The host is back!" : "The host lost connection. Waiting for them to return…");
  });

  socket.on("roomClosed", (message) => {
    clearSession();
    toast(message || "This room has closed.");
    setTimeout(() => location.reload(), 1800);
  });

  socket.on("disconnect", () => setConn(false));

  socket.on("connect", () => {
    setConn(true);
    const session = loadSession();
    if (!session || !session.code) return;
    emitAck("rejoin", { code: session.code, clientId }).then((res) => {
      if (res && res.ok) {
        applySnapshot(res.snapshot);
      } else {
        clearSession();
        resetToHome();
        if (res && res.error) toast(res.error);
      }
    });
  });
})();
