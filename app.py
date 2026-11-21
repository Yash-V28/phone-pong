"""Phone Pong - classic Pong controlled by tilting your phone.

Built at KCL FirstYearHack 2026 (Retro Remix).

Socket.IO contract:
  phone -> server: join {room, id, player} -> "joined" {player: 1|2} or "room_full"
                  (id + last player number let a rejoining phone reclaim its slot)
  phone -> server: paddle {room, y}       (y: 0 top .. 1 bottom)
  host  -> server: create_room {room}
  host  -> server: score {room, p1, p2}
  server -> host:  player_joined {player}, player_left {player}, paddle {player, y}
  server -> phones: score {p1, p2}
"""
import os
import threading

from flask import Flask, render_template, request
from flask_socketio import SocketIO, join_room
from werkzeug.serving import WSGIRequestHandler

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-me")

# threading mode works on any Python version without extra async libraries.
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*")

MAX_PLAYERS = 2

# room code -> {"host": sid | None, "players": {1: sid, 2: sid}, "ids": {1: client_id, ...}}
rooms = {}
rooms_lock = threading.Lock()


def normalise_code(data):
    """Pull a room code out of an event payload, upper-cased, or None if missing."""
    if not isinstance(data, dict):
        return None
    code = str(data.get("room") or "").strip().upper()
    return code[:16] or None


def new_room():
    return {"host": None, "players": {}, "ids": {}}


def phones_channel(code):
    """Socket.IO room the phones of a game sit in, so scores reach only them."""
    return f"phones:{code}"


def player_for(room, sid):
    for number, player_sid in room["players"].items():
        if player_sid == sid:
            return number
    return None


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/play")
def play():
    """Phone controller. The room code is read client-side from ?room=CODE."""
    return render_template("play.html")


@socketio.on("create_room")
def handle_create_room(data):
    code = normalise_code(data)
    if not code:
        return
    with rooms_lock:
        room = rooms.setdefault(code, new_room())
        room["host"] = request.sid
        already_joined = sorted(room["players"])
    # Phones that arrived before the host (e.g. after a host refresh) still count.
    for number in already_joined:
        socketio.emit("player_joined", {"player": number}, to=request.sid)


@socketio.on("join")
def handle_join(data):
    code = normalise_code(data)
    if not code:
        return
    sid = request.sid
    client_id = str(data.get("id") or "")[:64] or None
    preferred = data.get("player") if data.get("player") in range(1, MAX_PLAYERS + 1) else None
    with rooms_lock:
        room = rooms.setdefault(code, new_room())
        number = player_for(room, sid)
        is_new = number is None
        if is_new and client_id:
            # Same phone on a new connection (its old one may not have timed out
            # yet): take the slot back instead of being told the room is full.
            number = next((n for n, i in room["ids"].items() if i == client_id), None)
        if number is None:
            free = [n for n in range(1, MAX_PLAYERS + 1) if n not in room["players"]]
            # Prefer the slot this phone had before (e.g. after a server restart).
            number = preferred if preferred in free else (free[0] if free else None)
        if number is not None:
            room["players"][number] = sid
            room["ids"][number] = client_id
        host = room["host"]

    if number is None:
        socketio.emit("room_full", to=sid)
        return
    join_room(phones_channel(code))
    socketio.emit("joined", {"player": number}, to=sid)
    if is_new and host:
        socketio.emit("player_joined", {"player": number}, to=host)


@socketio.on("paddle")
def handle_paddle(data):
    code = normalise_code(data)
    if not code:
        return
    try:
        y = min(1.0, max(0.0, float(data.get("y"))))
    except (TypeError, ValueError):
        return
    with rooms_lock:
        room = rooms.get(code)
        if not room or not room["host"]:
            return
        number = player_for(room, request.sid)
        host = room["host"]
    if number is not None:
        socketio.emit("paddle", {"player": number, "y": y}, to=host)


@socketio.on("score")
def handle_score(data):
    code = normalise_code(data)
    if not code:
        return
    with rooms_lock:
        room = rooms.get(code)
        if not room or room["host"] != request.sid:
            return  # only the host may announce scores
    try:
        payload = {"p1": int(data.get("p1", 0)), "p2": int(data.get("p2", 0))}
    except (TypeError, ValueError):
        return
    socketio.emit("score", payload, to=phones_channel(code))


@socketio.on("disconnect")
def handle_disconnect(*_args):
    sid = request.sid
    notify = []  # (host_sid, player_number)
    with rooms_lock:
        for code in list(rooms):
            room = rooms[code]
            if room["host"] == sid:
                room["host"] = None
            number = player_for(room, sid)
            if number is not None:
                del room["players"][number]
                room["ids"].pop(number, None)
                if room["host"]:
                    notify.append((room["host"], number))
            if not room["host"] and not room["players"]:
                del rooms[code]
    for host, number in notify:
        socketio.emit("player_left", {"player": number}, to=host)


class UnbufferedRequestHandler(WSGIRequestHandler):
    # Werkzeug reads requests through a buffered stream. Behind a proxy such as
    # ngrok the client's first WebSocket frame can arrive in the same packet as
    # the upgrade request; the buffer swallows it, simple-websocket (which reads
    # the raw socket) never sees the probe, and the upgrade fails. Reading
    # unbuffered leaves those bytes on the socket.
    rbufsize = 0


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    # host 0.0.0.0 so phones on the same Wi-Fi can reach the server.
    socketio.run(app, host="0.0.0.0", port=port, debug=True, allow_unsafe_werkzeug=True,
                 request_handler=UnbufferedRequestHandler)
