// Phone Pong controller: joins a room and streams paddle position (y: 0 top .. 1 bottom).
//
// Socket.IO contract (phone side):
//   emit  join   {room}       -> receive "joined" {player: 1|2} or "room_full"
//   emit  paddle {room, y}
//   on    score  {p1, p2}

(() => {
  const SEND_INTERVAL_MS = 33; // ~30 updates per second
  const TILT_RANGE = 30;       // beta clamped to [-30, 30] degrees

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

  // ---- Socket.IO ----
  const socket = io();

  // Fires on first connect and again after any reconnect, so we rejoin automatically.
  socket.on("connect", () => {
    player = null;
    setStatus("JOINING...", true);
    socket.emit("join", { room });
  });

  socket.on("disconnect", () => {
    player = null;
    setStatus("RECONNECTING...", true);
  });

  socket.on("joined", (data) => {
    player = data && data.player;
    setStatus(`YOU ARE PLAYER ${player}`);
    p1El.classList.toggle("mine", player === 1);
    p2El.classList.toggle("mine", player === 2);
  });

  socket.on("room_full", () => {
    player = null;
    setStatus("ROOM FULL");
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

  function onOrientation(e) {
    if (dragging || e.beta == null) return;
    const beta = clamp(e.beta, -TILT_RANGE, TILT_RANGE);
    setY((beta + TILT_RANGE) / (2 * TILT_RANGE)); // -30 -> 0 (top), +30 -> 1 (bottom)
    motionSeen = true;
  }

  function startMotion() {
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
