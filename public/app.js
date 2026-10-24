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
  let reactionList = [];
  let trayLoaded = false;
  let myStreak = 0;
  let giftBusy = false;
  let reactCool = false;

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
    syncDock();
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
        ? "Start when everyone has joined. You start each question and show the results."
        : "Waiting for the host to start the game…";
    $("backHome").textContent = role === "host" ? "← Close room" : "← Leave room";
    // Only the host sees the room code and the QR. Players already joined, they don't need them.
    $("qrPanel").classList.toggle("hidden", role !== "host");
    $("codeCard").classList.toggle("hidden", role !== "host");
    $("lobbyIntro").textContent =
      role === "host" ? "Share the code or the QR so everyone can join." : "You're in! Waiting for the host to start the game.";
    syncDock();
  }

  /* ---------------------------------------------------------------- */
  /* Streak, emoji and gift helpers                                   */
  /* ---------------------------------------------------------------- */
  function updateStreak(players) {
    if (role !== "player") return;
    const me = (players || []).find((p) => p.name === myName);
    if (!me) return;
    const v = me.streak || 0;
    myStreak = v;
    $("streakNum").textContent = v;
    const bar = $("streakBar");
    bar.classList.toggle("on", v >= 1);
    bar.classList.toggle("hot", v >= 2);
    $("streakNext").textContent = v >= 1 ? `next right answer: +${Math.min(500, v * 100)} bonus` : "get one right to start a streak";
  }

  function renderDock() {
    trayLoaded = false;
    $("reactTray").innerHTML = reactionList
      .map((r) => {
        const face = r.gif ? `<img data-src="${esc(r.gif)}" alt="" width="44" height="44">` : "";
        return `<button type="button" data-react="${esc(r.id)}" title="${esc(r.label)}"><span class="rt-fallback">${esc(r.fallback)}</span>${face}</button>`;
      })
      .join("");
  }

  // Thumbnails are only downloaded the first time the tray is opened, so players' phones stay light.
  function loadTray() {
    if (trayLoaded) return;
    trayLoaded = true;
    $("reactTray").querySelectorAll("img[data-src]").forEach((img) => {
      img.onload = () => img.parentElement.classList.add("has-gif");
      img.onerror = () => img.remove();
      img.src = img.dataset.src;
    });
  }

  function syncDock() {
    const home = $("home") && $("home").classList.contains("active");
    const show = role === "player" && !!roomCode && !home && reactionList.length > 0;
    $("reactDock").classList.toggle("hidden", !show);
    if (!show) $("reactTray").classList.add("hidden");
  }

  function spawnReaction(name, id) {
    if (role !== "host") return; // reactions only show on the host's screen
    const r = reactionList.find((x) => x.id === id);
    if (!r) return;
    const layer = $("reactLayer");
    if (layer.childElementCount >= 8) return; // too many on screen: drop extras to avoid lag
    const el = document.createElement("div");
    el.className = "react-bubble";
    el.style.left = `${8 + Math.random() * 78}%`;
    el.style.setProperty("--dx", `${Math.round(Math.random() * 80 - 40)}px`);
    const showFallback = () => {
      const f = document.createElement("span");
      f.className = "rb-emoji";
      f.textContent = r.fallback;
      el.prepend(f);
    };
    if (r.gif) {
      const img = new Image();
      img.className = "rb-gif";
      img.alt = r.label;
      img.onerror = () => {
        img.remove();
        showFallback();
      };
      img.src = r.gif;
      el.append(img);
    } else {
      showFallback();
    }
    const n = document.createElement("span");
    n.className = "rb-name";
    n.textContent = name;
    el.append(n);
    layer.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
    if (reduceMotion) setTimeout(() => el.remove(), 1800);
  }

  function addFeed(entry) {
    const list = $("giftFeedList");
    const li = document.createElement("li");
    const b = document.createElement("b");
    b.textContent = entry.name;
    li.append(b, document.createTextNode(` ${entry.text}`));
    list.prepend(li);
    while (list.children.length > 8) list.lastChild.remove();
    $("giftFeed").classList.remove("hidden");
  }

  function showGiftResult(g, instant) {
    $("giftBtn").classList.add("hidden");
    const el = $("giftResult");
    el.className = `gift-result ${g.kind}`;
    const icon = g.kind === "steal" ? "🕵️" : g.kind === "mult" ? "💎" : "🎁";
    const victims = (g.victims || []).length
      ? `<ul class="gr-victims">${g.victims.map((v) => `<li><span>${esc(v.name)}</span><em>${MINUS}${fmt(v.amount)}</em></li>`).join("")}</ul>`
      : "";
    el.innerHTML = `<div class="gr-ico">${icon}</div><div><small>YOU GOT</small><b>${esc(g.title)}</b><p>${esc(
      g.detail
    )}</p><strong class="gr-delta">+${fmt(g.delta)}</strong>${victims}</div>`;
    if (!instant) {
      sfx("reveal");
      if (!reduceMotion) fx.confettiBurst(g.kind === "bonus" ? 45 : 120);
    }
  }

  function setupGift(me, giftStats) {
    const box = $("giftBox");
    giftBusy = false;
    $("giftFeedList").innerHTML = "";
    $("giftFeed").classList.add("hidden");
    $("giftResult").classList.add("hidden");
    $("giftBtn").classList.remove("hidden", "opening");
    if (role === "player" && me && me.gift) {
      box.classList.remove("hidden");
      if (me.gift.claimed && me.gift.result) showGiftResult(me.gift.result, true);
    } else {
      box.classList.add("hidden");
    }
    const prog = $("giftProgress");
    prog.classList.toggle("hidden", role !== "host" || !giftStats);
    if (role === "host" && giftStats) prog.textContent = `🎁 ${giftStats.claimed} / ${giftStats.total} gifts opened`;
  }

  async function openGift() {
    if (giftBusy) return;
    giftBusy = true;
    $("giftBtn").classList.add("opening");
    const res = await emitAck("claimGift", {});
    if (!res || !res.ok) {
      giftBusy = false;
      $("giftBtn").classList.remove("opening");
      toast((res && res.error) || "Could not open the gift.");
      return;
    }
    setTimeout(() => {
      showGiftResult(res.gift, false);
      $("myStanding").textContent = `Rank #${res.rank} · ${fmt(res.score)} pts total`;
    }, reduceMotion ? 0 : 650);
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
            p.streak > 0 ? `<em class="streak-tag" title="${p.streak} in a row">🔥${p.streak}</em>` : ""
          }${
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
      x1: "safe",
      x2: `${MINUS}${bets.x2.penalty} if wrong`,
      x3: `${MINUS}${bets.x3.penalty} if wrong`,
      allin: `×${bets.allin.mult} or lose all`,
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
    $("streakBar").classList.toggle("hidden", !isPlayer);
    updateStreak(q.players || []);
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
    selectedChoice = choice;
    applyLockedUi(choice, `Locked in at ${(((timerDuration - rem) / 1000)).toFixed(1)}s. Hold tight, results are coming.`);

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
  /* Encouragement: every answer gets a different line (shuffled deck, no repeats until it runs out) */
  const CHEERS = {
    correct: [
      "Nice! You really know this poster.",
      "Boom, that's a point machine.",
      "Easy for you, huh? Keep it up.",
      "Right again. The others better watch out.",
      "That was quick thinking.",
      "Nailed it. Don't slow down now.",
      "Yes! Mars is lucky to have you.",
      "Smart move. You're climbing the board.",
      "Spot on. Keep that streak going.",
      "Great answer. You were paying attention.",
      "Perfect. Do it one more time.",
      "Look at you go. Keep it rolling.",
    ],
    wrong: [
      "Close one. The next question is yours.",
      "It's okay, everybody misses some.",
      "Shake it off and go again.",
      "You can still catch up, there's time.",
      "One miss won't ruin your game.",
      "Now you know it for next time.",
      "Breathe. Read the next one slowly.",
      "You're still in this. Keep pushing!",
      "Mistakes happen. Come back stronger.",
      "Head up, the points are still out there.",
    ],
    none: [
      "Too slow this time. Try to answer a bit faster.",
      "Time ran out. Don't overthink the next one.",
      "No answer, no points. You've got the next one.",
      "Next round, tap an answer even if you're unsure.",
      "The clock won this time. Beat it next round.",
    ],
  };
  const CHEER_LABEL = { correct: "NICE ONE", wrong: "KEEP PUSHING", none: "STAY SHARP" };
  const cheerDeck = { correct: [], wrong: [], none: [] };
  const cheerLast = { correct: "", wrong: "", none: "" };
  let wrongInRow = 0;

  function nextCheer(kind) {
    if (kind === "wrong") wrongInRow++;
    else if (kind === "correct") wrongInRow = 0;
    if (!cheerDeck[kind].length) {
      const d = CHEERS[kind].slice();
      for (let i = d.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [d[i], d[j]] = [d[j], d[i]];
      }
      if (d.length > 1 && d[d.length - 1] === cheerLast[kind]) d.unshift(d.pop());
      cheerDeck[kind] = d;
    }
    cheerLast[kind] = cheerDeck[kind].pop();
    return cheerLast[kind];
  }

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
      $("myDetail").textContent = "Time ran out before you picked an answer.";
    } else if (last.status === "correct") {
      el.classList.add("correct");
      $("myHead").textContent = "CORRECT";
      $("myDelta").textContent = `+${fmt(last.gained)}`;
      $("myDetail").textContent = `Answered in ${(last.answerTimeMs / 1000).toFixed(1)}s · ${fmt(last.speedPoints)} speed pts ${betLabel(
        last.bet
      )}${last.streakBonus ? ` · +${fmt(last.streakBonus)} streak bonus (${last.streak} in a row)` : last.streak > 1 ? ` · ${last.streak} in a row` : ""}`;
    } else {
      el.classList.add("wrong");
      $("myHead").textContent = "WRONG";
      $("myDelta").textContent = last.gained === 0 ? "+0" : `${MINUS}${fmt(-last.gained)}`;
      $("myDetail").textContent =
        last.bet === "allin"
          ? "All-in missed. Your score went back to zero."
          : last.gained === 0
          ? "No penalty on a ×1 buff."
          : `${betLabel(last.bet)} buff penalty.`;
    }
    $("myStanding").textContent = standing;
    const kind = last.status === "correct" ? "correct" : last.status === "wrong" ? "wrong" : "none";
    let cheer = nextCheer(kind);
    if (kind === "wrong" && wrongInRow >= 2) cheer += " Tip: a ×1 keeps you safe for a round.";
    $("myCheerLabel").textContent = CHEER_LABEL[kind];
    $("myCheerText").textContent = cheer;
    const box = $("myCheer");
    box.classList.remove("pop");
    void box.offsetWidth;
    box.classList.add("pop");
  }

  function showResults(result, me, giftStats) {
    stopTimer();
    lastResult = result;
    const isLast = result.index + 1 >= result.total;
    const mineChoice = me && me.last && me.last.status !== "none" ? me.last.choice : null;

    $("resultTitle").innerHTML = `QUESTION <span>${String(result.index + 1).padStart(2, "0")} DONE</span>`;
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
    $("answerCounts").textContent = `${result.correctCount} right · ${Math.max(0, result.totalPlayers - answered)} did not answer`;

    renderMyResult(me);
    renderLeaderboard(result.leaderboard || [], "resultsLeaderboard");
    updateStreak(result.leaderboard || []);
    setupGift(me, giftStats);
    const staticTip = document.querySelector("#results .score-tip");
    if (staticTip) staticTip.classList.toggle("hidden", role === "player");

    $("hostNextControls").classList.toggle("hidden", role !== "host");
    $("nextQuestion").textContent = isLast ? "SHOW FINAL RESULTS →" : "NEXT QUESTION →";
    $("playerWait").classList.toggle("hidden", role === "host");
    $("playerWait").textContent = isLast
      ? "That was the last question. Waiting for the host to show the final results…"
      : "Waiting for the host to start the next question…";

    showScreen("results");

    if (role === "player" && me && me.last) {
      if (me.last.status === "correct") sfx("correct");
      else if (me.last.status === "wrong") sfx("wrong");
    }
  }

  /* ---------------------------------------------------------------- */
  /* Fireworks + confetti (canvas)                                    */
  /* ---------------------------------------------------------------- */
  const fx = (() => {
    const cv = $("fxCanvas");
    const ctx = cv.getContext("2d");
    const HUES = [45, 190, 340, 130, 270, 20];
    let W = 0, H = 0, raf = 0, last = 0, running = false, auto = null, stopTimer_ = null;
    let rockets = [], sparks = [], bits = [], lastPop = 0;

    function size() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = window.innerWidth;
      H = window.innerHeight;
      cv.width = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function rocket() {
      rockets.push({
        x: W * (0.12 + Math.random() * 0.76),
        y: H + 10,
        vx: Math.random() * 2 - 1,
        vy: -(H / 52 + Math.random() * 3),
        ty: H * (0.12 + Math.random() * 0.33),
      });
    }

    function burst(x, y) {
      const hue = HUES[(Math.random() * HUES.length) | 0];
      const n = 70 + ((Math.random() * 40) | 0);
      const ring = Math.random() < 0.35;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.1;
        const sp = ring ? 4.4 : 1.5 + Math.random() * 5;
        sparks.push({ x, y, px: x, py: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 55 + Math.random() * 35, hue: hue + (Math.random() * 30 - 15) });
      }
      const t = performance.now();
      if (t - lastPop > 170) { lastPop = t; sfx("pop"); }
    }

    function confetti(n) {
      for (let i = 0; i < n; i++) {
        bits.push({ x: Math.random() * W, y: -20 - Math.random() * H * 0.5, vx: Math.random() * 2 - 1, vy: 2 + Math.random() * 3, rot: Math.random() * 6, vr: Math.random() * 0.3 - 0.15, w: 6 + Math.random() * 6, h: 4 + Math.random() * 5, hue: Math.random() * 360, sway: Math.random() * 6 });
      }
    }

    function frame(t) {
      const k = Math.min(3, (t - last) / 16.67 || 1);
      last = t;
      ctx.clearRect(0, 0, W, H);

      rockets = rockets.filter((r) => {
        r.x += r.vx * k;
        r.y += r.vy * k;
        r.vy *= 0.985;
        ctx.fillStyle = "#ffe9b0";
        ctx.fillRect(r.x - 1.5, r.y, 3, 10);
        if (r.y <= r.ty || r.vy > -2) { burst(r.x, r.y); return false; }
        return true;
      });

      ctx.globalCompositeOperation = "lighter";
      sparks = sparks.filter((p) => {
        p.px = p.x; p.py = p.y;
        p.x += p.vx * k;
        p.y += p.vy * k;
        p.vx *= 0.985;
        p.vy = p.vy * 0.985 + 0.045 * k;
        p.life += k;
        const f = 1 - p.life / p.max;
        if (f <= 0) return false;
        ctx.strokeStyle = `hsla(${p.hue},100%,${55 + 20 * f}%,${f})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.px, p.py);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        return true;
      });
      ctx.globalCompositeOperation = "source-over";

      bits = bits.filter((c) => {
        c.sway += 0.05 * k;
        c.x += (c.vx + Math.sin(c.sway) * 0.9) * k;
        c.y += c.vy * k;
        c.rot += c.vr * k;
        if (c.y > H + 30) return false;
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.rotate(c.rot);
        ctx.fillStyle = `hsl(${c.hue},90%,60%)`;
        ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
        ctx.restore();
        return true;
      });

      if (running || rockets.length || sparks.length || bits.length) {
        raf = requestAnimationFrame(frame);
      } else {
        raf = 0;
        cv.style.display = "none";
      }
    }

    function start(ms) {
      stop();
      size();
      cv.style.display = "block";
      running = true;
      last = performance.now();
      for (let i = 0; i < 5; i++) setTimeout(rocket, i * 260);
      confetti(150);
      setTimeout(() => confetti(100), 2200);
      auto = setInterval(rocket, 420);
      stopTimer_ = setTimeout(() => { running = false; clearInterval(auto); }, Math.max(1500, ms));
      raf = requestAnimationFrame(frame);
    }

    function confettiBurst(n) {
      size();
      cv.style.display = "block";
      confetti(n);
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    }

    function stop() {
      running = false;
      clearInterval(auto);
      clearTimeout(stopTimer_);
      cancelAnimationFrame(raf);
      raf = 0;
      rockets = []; sparks = []; bits = [];
      cv.style.display = "none";
    }

    window.addEventListener("resize", () => { if (raf) size(); });
    return { start, stop, confettiBurst };
  })();

  /* ---------------------------------------------------------------- */
  /* Finale: the spotlight visits 3rd, then 2nd, then 1st place       */
  /* ---------------------------------------------------------------- */
  // All times in ms. Make the numbers bigger to give each spotlight more time.
  const FINAL_TIMING = {
    search: 1800,       // light moves to the spot and "looks" for 2nd / 3rd place
    hold: 4200,         // how long a 2nd / 3rd place winner stays in the light
    winnerSearch: 3400, // drumroll before the winner
    winnerHold: 8000,   // fireworks time for the winner
  };
  const COL_OF = { 1: 1, 2: 0, 3: 2 };      // podium column of each place (2nd | 1st | 3rd)
  const SPOT_X = [19.33, 50, 80.67];        // spotlight position (% of stage width) per column
  let finalTimers = [];
  let finalPlayers = [];

  function later(ms, fn) {
    finalTimers.push(setTimeout(fn, ms));
  }

  function clearFinal() {
    finalTimers.forEach(clearTimeout);
    finalTimers = [];
    fx.stop();
  }

  function say(text) {
    const el = $("finalCaption");
    el.classList.remove("swap");
    void el.offsetWidth;
    el.textContent = text;
    el.classList.add("swap");
  }

  function countUp(el, to, ms) {
    const t0 = performance.now();
    (function step(now) {
      const f = Math.min(1, (now - t0) / ms);
      el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - f, 3))));
      if (f < 1) requestAnimationFrame(step);
    })(t0);
  }

  function revealPod(place, instant) {
    const pod = $("podium").querySelector(`.place-${place}`);
    if (!pod) return;
    pod.classList.remove("past");
    pod.classList.add("lit");
    const sc = pod.querySelector(".pod-score");
    const to = Number(sc.dataset.score) || 0;
    if (instant) sc.textContent = fmt(to);
    else countUp(sc, to, 1400);
  }

  function drumroll(ms) {
    let t = 0;
    let gap = 260;
    while (t < ms - 150) {
      later(t, () => sfx("tick"));
      t += gap;
      gap = Math.max(55, gap * 0.9);
    }
  }

  function finishFinal() {
    $("stage").classList.add("lights-on");
    $("spot").classList.remove("searching");
    $("restWrap").classList.remove("hidden");
    $("finalActions").classList.remove("hidden");
    $("skipFinal").parentElement.classList.add("hidden");
    const you = $("finalYou");
    if (role === "player") {
      const mine = ranked(finalPlayers).find((p) => p.name === myName);
      if (mine) {
        you.textContent = `You finished #${mine.rank} with ${fmt(mine.score)} points.`;
        you.classList.remove("hidden");
      }
    }
  }

  function showFinal(players) {
    stopTimer();
    clearFinal();
    finalPlayers = players || [];
    const rows = ranked(finalPlayers);
    const top = rows.slice(0, 3);
    const stage = $("stage");
    renderLeaderboard(finalPlayers, "finalLeaderboard");

    $("podium").innerHTML = [2, 1, 3]
      .map((place) => {
        const p = top[place - 1];
        if (!p) return '<div class="pod pod-empty"></div>';
        return `<div class="pod place-${place}"><div class="pod-info">${
          place === 1 ? '<div class="pod-crown">👑</div>' : ""
        }<div class="pod-avatar">${esc((p.name || "?").slice(0, 1).toUpperCase())}</div><b class="pod-name">${esc(
          p.name
        )}</b><span class="pod-score" data-score="${p.score}">0</span></div><div class="pod-step"><strong>${place}</strong></div></div>`;
      })
      .join("");

    stage.className = "stage";
    $("spot").classList.remove("searching");
    stage.style.setProperty("--spot-x", "50%");
    $("restWrap").classList.add("hidden");
    $("finalActions").classList.add("hidden");
    $("finalYou").classList.add("hidden");
    $("skipFinal").parentElement.classList.remove("hidden");
    showScreen("final");

    const order = [3, 2, 1].filter((pl) => top[pl - 1]);
    if (!order.length) {
      say("Nobody played this game.");
      finishFinal();
      return;
    }
    if (reduceMotion) {
      order.forEach((pl) => revealPod(pl, true));
      say(`Congratulations, ${top[0].name}!`);
      finishFinal();
      return;
    }

    stage.classList.add("dark");
    say("Get ready…");
    const T = FINAL_TIMING;
    let t = 1000;
    order.forEach((place) => {
      const win = place === 1;
      const p = top[place - 1];
      const search = win ? T.winnerSearch : T.search;
      const hold = win ? T.winnerHold : T.hold;
      later(t, () => {
        say(win ? "And the winner is…" : place === 3 ? "In third place…" : "In second place…");
        $("podium").querySelectorAll(".pod.lit").forEach((el) => el.classList.add("past"));
        stage.style.setProperty("--spot-x", `${SPOT_X[COL_OF[place]]}%`);
        $("spot").classList.add("searching");
        sfx("sweep");
        if (win) drumroll(search);
      });
      later(t + search, () => {
        $("spot").classList.remove("searching");
        revealPod(place, false);
        if (win) {
          say(`Congratulations, ${p.name}!`);
          sfx("fanfare");
          fx.start(hold - 500);
        } else {
          say(`${place === 3 ? "3rd" : "2nd"} place: ${p.name}`);
          sfx("reveal");
        }
      });
      t += search + hold;
    });
    later(t, finishFinal);
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

  function tone(freq, start, dur, gain, type) {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    const t = audioCtx.currentTime + start;
    o.type = type || "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain || 0.05, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur);
  }

  let noiseBuf = null;
  function noisePop() {
    if (!audioCtx) return;
    if (!noiseBuf) {
      noiseBuf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * 0.3), audioCtx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = audioCtx.currentTime;
    const src = audioCtx.createBufferSource();
    const f = audioCtx.createBiquadFilter();
    const g = audioCtx.createGain();
    src.buffer = noiseBuf;
    f.type = "lowpass";
    f.frequency.value = 900;
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    src.connect(f);
    f.connect(g);
    g.connect(audioCtx.destination);
    src.start(t);
    src.stop(t + 0.3);
  }

  function sfx(kind) {
    try {
      if (kind === "correct") { tone(660, 0, 0.12); tone(880, 0.12, 0.2); }
      if (kind === "wrong") { tone(247, 0, 0.18); tone(196, 0.16, 0.28); }
      if (kind === "tick") tone(1500, 0, 0.04, 0.025, "square");
      if (kind === "reveal") { tone(523, 0, 0.4, 0.05, "triangle"); tone(659, 0.08, 0.4, 0.05, "triangle"); tone(784, 0.16, 0.7, 0.05, "triangle"); }
      if (kind === "fanfare") [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.14, i === 3 ? 1.1 : 0.3, 0.06, "sawtooth"));
      if (kind === "pop") noisePop();
      if (kind === "sweep" && audioCtx) {
        const t = audioCtx.currentTime;
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = "sine";
        o.frequency.setValueAtTime(220, t);
        o.frequency.exponentialRampToValueAtTime(880, t + 0.9);
        g.gain.setValueAtTime(0.001, t);
        g.gain.linearRampToValueAtTime(0.04, t + 0.2);
        g.gain.exponentialRampToValueAtTime(0.001, t + 1);
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start(t);
        o.stop(t + 1.05);
      }
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
    reactionList = s.reactions || reactionList;
    renderDock();
    if (s.role === "host") reactionList.forEach((r) => { if (r.gif) new Image().src = r.gif; }); // preload for smooth playback

    if (s.state === "question" && s.question) showQuestion(s.question, s.me);
    else if (s.state === "results" && s.result) {
      showResults(s.result, s.me, s.giftStats);
      (s.giftLog || []).slice().reverse().forEach(addFeed);
    }
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
    correctStreak = 0; wrongStreak = 0; wrongInRow = 0;
    clearFinal();
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
    $("connText").textContent = online ? "ONLINE" : "RECONNECTING…";
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
    toast(`You're in, ${res.snapshot.myName}!`);
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
  $("giftBtn").onclick = openGift;
  $("reactToggle").onclick = () => {
    $("reactTray").classList.toggle("hidden");
    loadTray();
  };
  $("reactTray").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-react]");
    if (!b || reactCool) return;
    reactCool = true;
    $("reactTray").classList.add("cool");
    const release = () => {
      reactCool = false;
      $("reactTray").classList.remove("cool");
    };
    const timer = setTimeout(release, 3000);
    emitAck("react", { id: b.dataset.react }).then((r) => {
      if (r && r.ok) {
        toast("Sent to the host!");
      } else {
        clearTimeout(timer);
        toast((r && r.error) || "Could not send it.");
        setTimeout(release, 1200);
      }
    });
  });
  $("skipFinal").onclick = () => {
    clearFinal();
    $("stage").classList.add("dark");
    [1, 2, 3].forEach((pl) => revealPod(pl, true));
    const first = ranked(finalPlayers)[0];
    say(first ? `Congratulations, ${first.name}!` : "Final results");
    finishFinal();
  };
  $("replayFinal").onclick = () => showFinal(finalPlayers);

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
    updateStreak(players);
    if ($("results").classList.contains("active")) renderLeaderboard(players, "resultsLeaderboard");
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

  socket.on("results", ({ result, me, giftStats }) => {
    if (roomCode) showResults(result, me, giftStats);
  });

  socket.on("giftNews", (entry) => {
    if (roomCode && $("results").classList.contains("active")) addFeed(entry);
  });

  socket.on("giftProgress", (st) => {
    if (role === "host" && st) {
      $("giftProgress").classList.remove("hidden");
      $("giftProgress").textContent = `🎁 ${st.claimed} / ${st.total} gifts opened`;
    }
  });

  socket.on("stolen", ({ by, amount }) => {
    if (!roomCode) return;
    toast(`${by} stole ${fmt(amount)} points from you!`);
    sfx("wrong");
  });

  socket.on("reaction", ({ name, id }) => {
    if (roomCode) spawnReaction(name, id);
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


