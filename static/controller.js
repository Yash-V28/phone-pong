// Phone Pong controller: joins a room and streams paddle position (y: 0 top .. 1 bottom).
//
// Socket.IO contract (phone side):
//   emit  join   {room, id, player} -> receive "joined" {player: 1|2} or "room_full"
//         (id + last player number let a rejoining phone reclaim its old slot)
//   emit  paddle {room, y}
//   on    score  {p1, p2}

(() => {
  const SEND_INTERVAL_MS = 33; // ~30 updates per second
  const TILT_RANGE = 45;       // tilt clamped to ±45° around the calibrated centre
  const DEAD_ZONE = 2;         // degrees around the centre that count as "centre"
  const TILT_SMOOTHING = 0.2;  // low-pass filter weight for each new reading (0..1)
  const ROOM_FULL_RETRY_MS = 3000;

  const statusEl = document.getElementById("status");
  const roomEl = document.getElementById("room-code");
  const scoreEl = document.getElementById("score");
  const p1El = document.getElementById("score-p1");
  const p2El = document.getElementById("score-p2");
  const motionBtn = document.getElementById("motion-btn");
  const hintEl = document.getElementById("hint");
  const pad = document.getElementById("pad");
  const paddleEl = document.getElementById("paddle");

  const room = (new URLSearchParams(location.search).get("room") || "").trim();

  let player = null;     // 1 or 2 once joined
  let y = 0.5;           // current paddle position
  let dragging = false;  // finger on the pad overrides tilt

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function setStatus(text, blink = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle("blink", blink);
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

  // Stream the paddle position while we hold a player slot.
  setInterval(() => {
    if (player && socket.connected) {
      socket.emit("paddle", { room, y });
    }
  }, SEND_INTERVAL_MS);

  // ---- Tilt controls ----
  let motionSeen = false;
  let centreBeta = null; // phone angle when ENABLE MOTION was tapped = paddle centre
  let smoothTilt = 0;    // low-pass filtered tilt, in degrees from the centre

  function onOrientation(e) {
    if (e.beta == null) return;
    // Calibrate on the first reading after the tap, so however the player is
    // holding the phone right now becomes the middle of the screen.
    if (centreBeta === null) {
      centreBeta = e.beta;
      smoothTilt = 0;
    }
    motionSeen = true;
    // Wrap the difference into [-180, 180) in case it crosses the ±180 seam.
    const tilt = ((e.beta - centreBeta + 540) % 360) - 180;
    // Low-pass filter to smooth out sensor jitter (keeps running while dragging,
    // so letting go doesn't jump to a stale value).
    smoothTilt += (tilt - smoothTilt) * TILT_SMOOTHING;
    if (dragging) return;
    // Dead zone: small wobbles near the centre are ignored. Subtracting it
    // keeps the response continuous at its edge.
    const magnitude = Math.max(0, Math.abs(smoothTilt) - DEAD_ZONE);
    const range = TILT_RANGE - DEAD_ZONE;
    const beta = clamp(Math.sign(smoothTilt) * magnitude, -range, range);
    setY((beta + range) / (2 * range)); // -45° -> 0 (top), +45° -> 1 (bottom)
  }

  function startMotion() {
    centreBeta = null;
    window.addEventListener("deviceorientation", onOrientation);
    motionBtn.textContent = "MOTION ON";
    motionBtn.disabled = true;
    hintEl.textContent = "TILT TO MOVE";
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
    startMotion();
  });

  // ---- Touch / drag fallback (pointer events also cover mouse for desktop testing) ----
  function yFromPointer(e) {
    const rect = pad.getBoundingClientRect();
    return (e.clientY - rect.top) / rect.height;
  }

  pad.addEventListener("pointerdown", (e) => {
    dragging = true;
    pad.setPointerCapture(e.pointerId);
    setY(yFromPointer(e));
    e.preventDefault();
  });

  pad.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    setY(yFromPointer(e));
    e.preventDefault();
  });

  const endDrag = () => { dragging = false; };
  pad.addEventListener("pointerup", endDrag);
  pad.addEventListener("pointercancel", endDrag);

  setY(0.5);
})();
