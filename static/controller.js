// Phone Pong controller: joins a room and streams paddle position (y: 0 top .. 1 bottom).
//
// Socket.IO contract (phone side):
//   emit  join   {room, id, player} -> receive "joined" {player: 1|2} or "room_full"
//         (id + last player number let a rejoining phone reclaim its old slot)
//   emit  paddle {room, y, spin}   (spin -1..1 from twisting the phone, or dragging sideways)
//   emit  smash  {room}          (phone was shaken; 1 s cooldown)
//   emit  rematch {room}         (REMATCH tapped on the game-over screen)
//   emit  latency_ping {room} (acked by the server) then latency {room, ms}, every 2 s
//   on    score  {p1, p2}
//   on    smash_landed           (our smash hit the ball: flash the screen)
//   on    hit    {type}          ("hit": our bat struck the ball, "concede": we lost a point)
//   on    game_over {winner} / match_start   (show / hide the REMATCH button)

(() => {
  const SEND_INTERVAL_MS = 33; // ~30 updates per second
  const TILT_RANGE = 37.5;     // tilt clamped to ±37.5° around the calibrated centre
                               // (halfway between the old ±30° and the too-sluggish ±45°)
  const DEAD_ZONE = 2;         // degrees around the centre that count as "centre"
  const TILT_SMOOTHING = 0.2;  // low-pass filter weight for each new reading (0..1)
  const ROOM_FULL_RETRY_MS = 3000;
  const SMASH_THRESHOLD = 18;  // m/s² of movement (gravity removed) that counts as a shake
  const SMASH_COOLDOWN_MS = 1000;
  const LATENCY_INTERVAL_MS = 2000;
  const TWIST_RANGE = 30;      // sideways roll (gamma) for full spin, degrees from the centre
  const TWIST_DEAD_ZONE = 4;   // small wobbles in the roll don't add spin
  const DRAG_SPIN_WIDTH = 0.35; // dragging sideways this fraction of the pad = full spin

  const statusEl = document.getElementById("status");
  const roomEl = document.getElementById("room-code");
  const scoreEl = document.getElementById("score");
  const p1El = document.getElementById("score-p1");
  const p2El = document.getElementById("score-p2");
  const motionBtn = document.getElementById("motion-btn");
  const recentreBtn = document.getElementById("recentre-btn");
  const smashHintEl = document.getElementById("smash-hint");
  const flashEl = document.getElementById("flash");
  const rematchBtn = document.getElementById("rematch-btn");
  const hintEl = document.getElementById("hint");
  const pad = document.getElementById("pad");
  const paddleEl = document.getElementById("paddle");
  const spinFillEl = document.getElementById("spin-fill");

  const room = (new URLSearchParams(location.search).get("room") || "").trim();

  let player = null;     // 1 or 2 once joined
  let y = 0.5;           // current paddle position
  let dragging = false;  // finger on the pad overrides tilt
  let twistSpin = 0;     // -1..1 from rolling the phone left/right
  let dragSpin = 0;      // -1..1 from dragging sideways
  let dragStartX = 0;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function setStatus(text, blink = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle("blink", blink);
  }

  // Full-screen colour flash (restarting the CSS animation each time).
  function flash(colour) {
    flashEl.style.background = colour;
    flashEl.classList.remove("on");
    void flashEl.offsetWidth; // force reflow so the animation replays
    flashEl.classList.add("on");
  }

  // Spin sent to the game: the finger wins while dragging, otherwise the twist.
  const currentSpin = () => (dragging ? dragSpin : twistSpin);

  // Spin meter: a bar that fills left (negative) or right (positive) from the middle.
  function showSpin(s) {
    const pct = Math.abs(s) * 50;
    spinFillEl.style.left = `${s < 0 ? 50 - pct : 50}%`;
    spinFillEl.style.width = `${pct}%`;
  }

  function setY(value) {
    y = clamp(value, 0, 1);
    // Paddle is 25% of the pad's height, so it travels over the remaining 75%.
    paddleEl.style.top = `${y * 75}%`;
  }

  if (!room) {
    setStatus("NO ROOM CODE");
    hintEl.textContent = "OPEN /play?room=CODE";
    motionBtn.disabled = true;
    return;
  }
  roomEl.textContent = room;

  // ---- Identity (survives reconnects and page reloads in this tab) ----
  const store = {
    get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* private mode */ } },
  };
  const PLAYER_KEY = `phone-pong-player-${room.toUpperCase()}`;
  let clientId = store.get("phone-pong-id");
  if (!clientId) {
    // Not crypto.randomUUID: that needs HTTPS, and phones often connect over plain http.
    clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    store.set("phone-pong-id", clientId);
  }
  let lastPlayer = Number(store.get(PLAYER_KEY)) || null;

  // ---- Socket.IO ----
  const socket = io();
  let retryTimer = null;

  function join() {
    clearTimeout(retryTimer);
    socket.emit("join", { room, id: clientId, player: lastPlayer });
  }

  // Fires on first connect and again after any reconnect, so we rejoin automatically.
  socket.on("connect", () => {
    player = null;
    setStatus("JOINING...", true);
    join();
  });

  socket.on("disconnect", () => {
    player = null;
    clearTimeout(retryTimer);
    setStatus("RECONNECTING...", true);
  });

  socket.on("joined", (data) => {
    clearTimeout(retryTimer);
    player = data && data.player;
    lastPlayer = player;
    store.set(PLAYER_KEY, String(player));
    setStatus(`YOU ARE PLAYER ${player}`);
    p1El.classList.toggle("mine", player === 1);
    p2El.classList.toggle("mine", player === 2);
  });

  // Keep retrying: a slot frees up when a player leaves or a stale connection times out.
  socket.on("room_full", () => {
    player = null;
    setStatus("ROOM FULL - RETRYING", true);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (socket.connected) join(); }, ROOM_FULL_RETRY_MS);
  });

  socket.on("score", (data) => {
    if (!data) return;
    p1El.textContent = data.p1 ?? 0;
    p2El.textContent = data.p2 ?? 0;
    scoreEl.classList.remove("hidden");
  });

  const PLAYER_COLOURS = { 1: "#e04848", 2: "#3f6fe6" };

  // ---- Match flow ----
  socket.on("game_over", (data) => {
    const winner = data && data.winner;
    setStatus(winner === player ? "YOU WIN!" : `PLAYER ${winner} WINS`, true);
    rematchBtn.classList.remove("hidden");
  });

  socket.on("match_start", () => {
    if (player) setStatus(`YOU ARE PLAYER ${player}`);
    rematchBtn.classList.add("hidden");
  });

  rematchBtn.addEventListener("click", () => {
    if (socket.connected) socket.emit("rematch", { room });
  });

  // navigator.vibrate is missing on iPhones (and some browsers), hence the screen flash too.
  function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  socket.on("smash_landed", () => {
    vibrate([40, 30, 80]);
    flash("#ff8a3a");
  });

  socket.on("hit", (data) => {
    const colour = PLAYER_COLOURS[player] || "#fff";
    if (data && data.type === "concede") {
      vibrate(200);
      flash(colour);
    } else {
      vibrate(30);
      flash(colour);
    }
  });

  // Stream the paddle position while we hold a player slot.
  setInterval(() => {
    if (player && socket.connected) {
      socket.emit("paddle", { room, y, spin: Math.round(currentSpin() * 100) / 100 });
    }
    showSpin(currentSpin());
  }, SEND_INTERVAL_MS);

  // Measure the round trip to the server and report it, so the host can display it.
  setInterval(() => {
    if (!player || !socket.connected) return;
    const sent = performance.now();
    socket.emit("latency_ping", { room }, () => {
      socket.emit("latency", { room, ms: Math.round(performance.now() - sent) });
    });
  }, LATENCY_INTERVAL_MS);

  // ---- Tilt controls ----
  let motionSeen = false;
  let centreBeta = null; // phone angle when ENABLE MOTION was tapped = paddle centre
  let smoothTilt = 0;    // low-pass filtered tilt, in degrees from the centre
  let centreGamma = 0;   // sideways roll at calibration = no spin
  let smoothTwist = 0;   // low-pass filtered roll, degrees from centreGamma

  function onOrientation(e) {
    if (e.beta == null) return;
    // Calibrate on the first reading after the tap, so however the player is
    // holding the phone right now becomes the middle of the screen.
    if (centreBeta === null) {
      centreBeta = e.beta;
      centreGamma = e.gamma || 0;
      smoothTilt = 0;
      smoothTwist = 0;
    }
    motionSeen = true;
    // Wrap the difference into [-180, 180) in case it crosses the ±180 seam.
    const tilt = ((e.beta - centreBeta + 540) % 360) - 180;
    // Low-pass filter to smooth out sensor jitter (keeps running while dragging,
    // so letting go doesn't jump to a stale value).
    smoothTilt += (tilt - smoothTilt) * TILT_SMOOTHING;

    // TWIST TO SPIN: sideways roll (gamma) from the calibrated centre, with a dead zone.
    if (e.gamma != null) {
      smoothTwist += (e.gamma - centreGamma - smoothTwist) * TILT_SMOOTHING;
      const twist = Math.max(0, Math.abs(smoothTwist) - TWIST_DEAD_ZONE);
      twistSpin = clamp(Math.sign(smoothTwist) * twist / (TWIST_RANGE - TWIST_DEAD_ZONE), -1, 1);
    }

    if (dragging) return;
    // Dead zone: small wobbles near the centre are ignored. Subtracting it
    // keeps the response continuous at its edge.
    const magnitude = Math.max(0, Math.abs(smoothTilt) - DEAD_ZONE);
    const range = TILT_RANGE - DEAD_ZONE;
    const beta = clamp(Math.sign(smoothTilt) * magnitude, -range, range);
    setY((beta + range) / (2 * range)); // -range -> 0 (top), +range -> 1 (bottom)
  }

  // ---- Shake to smash ----
  let lastSmash = 0;

  function onMotion(e) {
    let magnitude;
    const a = e.acceleration; // gravity already removed, when the phone supports it
    if (a && a.x != null) {
      magnitude = Math.hypot(a.x, a.y, a.z);
    } else {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null) return;
      magnitude = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81); // subtract gravity
    }
    if (magnitude < SMASH_THRESHOLD) return;
    const now = Date.now();
    if (now - lastSmash < SMASH_COOLDOWN_MS) return; // no spamming
    lastSmash = now;
    if (player && socket.connected) socket.emit("smash", { room });
    // Quick local cue that the shake registered.
    pad.classList.add("smash");
    setTimeout(() => pad.classList.remove("smash"), 300);
  }

  function startMotion() {
    centreBeta = null;
    window.addEventListener("deviceorientation", onOrientation);
    window.addEventListener("devicemotion", onMotion);
    motionBtn.textContent = "MOTION ON";
    motionBtn.disabled = true;
    hintEl.textContent = "TILT TO MOVE, TWIST TO SPIN";
    recentreBtn.classList.remove("hidden");
    smashHintEl.classList.remove("hidden");
    // Desktop browsers / insecure (http) pages often never fire the event.
    setTimeout(() => {
      if (!motionSeen) {
        motionBtn.textContent = "NO MOTION";
        hintEl.innerHTML = "NO TILT SENSOR FOUND<br>DRAG IN THE BOX";
      }
    }, 1500);
  }

  motionBtn.addEventListener("click", async () => {
    if (typeof DeviceOrientationEvent === "undefined") {
      motionBtn.textContent = "NO MOTION";
      motionBtn.disabled = true;
      hintEl.innerHTML = "NOT SUPPORTED<br>DRAG IN THE BOX";
      return;
    }
    // iOS 13+ needs an explicit permission prompt triggered by a user tap.
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      try {
        const result = await DeviceOrientationEvent.requestPermission();
        if (result !== "granted") {
          motionBtn.textContent = "MOTION DENIED";
          hintEl.innerHTML = "PERMISSION DENIED<br>DRAG IN THE BOX";
          return;
        }
      } catch (err) {
        motionBtn.textContent = "MOTION BLOCKED";
        hintEl.innerHTML = "NEEDS HTTPS ON IOS<br>DRAG IN THE BOX";
        return;
      }
    }
    // Shake detection needs its own permission on iOS; tilt still works without it.
    if (typeof DeviceMotionEvent !== "undefined" &&
        typeof DeviceMotionEvent.requestPermission === "function") {
      try { await DeviceMotionEvent.requestPermission(); } catch { /* no smash, tilt still fine */ }
    }
    startMotion();
  });

  // RECENTRE: forget the centre so the next orientation reading becomes the new one
  // (same calibration as when ENABLE MOTION was tapped).
  recentreBtn.addEventListener("click", () => {
    centreBeta = null;
  });

  // ---- Touch / drag fallback (pointer events also cover mouse for desktop testing) ----
  function yFromPointer(e) {
    const rect = pad.getBoundingClientRect();
    return (e.clientY - rect.top) / rect.height;
  }

  // Sideways finger movement since touching down = spin (drag diagonally to spin).
  function spinFromPointer(e) {
    const width = pad.getBoundingClientRect().width * DRAG_SPIN_WIDTH;
    return clamp((e.clientX - dragStartX) / width, -1, 1);
  }

  pad.addEventListener("pointerdown", (e) => {
    dragging = true;
    dragStartX = e.clientX;
    dragSpin = 0;
    pad.setPointerCapture(e.pointerId);
    setY(yFromPointer(e));
    e.preventDefault();
  });

  pad.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    setY(yFromPointer(e));
    dragSpin = spinFromPointer(e);
    e.preventDefault();
  });

  const endDrag = () => { dragging = false; dragSpin = 0; };
  pad.addEventListener("pointerup", endDrag);
  pad.addEventListener("pointercancel", endDrag);

  setY(0.5);
})();
