"""Phone Pong - classic Pong controlled by tilting your phone.

Built at KCL FirstYearHack 2026 (Retro Remix).

Modes: "1v1" (P1 vs P2), "2v2" (P1+P3 RED vs P2+P4 BLUE), "coop" (P1+P3 vs two bots).
Team RED = P1, P3 (left). Team BLUE = P2, P4 (right). P1's phone is the "captain".

Socket.IO contract:
  phone -> server: join {room, id, player} -> "joined" {player: 1-4} or "room_full"
                  (id + last player number let a rejoining phone reclaim its slot)
  phone/host -> server: set_mode {room, mode, difficulty}  (captain P1 or host, lobby only)
  phone -> server: start_game {room}      (captain tapped START; host decides)
  host  -> server: lobby_open {room}      (host is back in the lobby: modes can change)
  phone -> server: paddle {room, y, spin} (y: 0 top .. 1 bottom, spin: -1..1 twist)
  phone -> server: smash {room}           (player shook the phone)
  phone -> server: rematch {room}         (REMATCH tapped after a match)
  phone -> server: latency_ping {room}    (acked straight back, so the phone can time it)
  phone -> server: latency {room, ms}     (the round trip it measured)
  host  -> server: create_room {room}
  host  -> server: score {room, p1, p2}
  host  -> server: smash_landed {room, player}
  host  -> server: hit {room, player, type: "hit"|"concede"}
  host  -> server: game_over {room, winner: "red"|"blue", label}, match_start {room}
  server -> host + phones: room_state {players: [1, 3], mode, difficulty, state: "lobby"|"game"}
                   (sent on every join / leave / mode change; replaces player_joined/left)
  server -> host:  paddle {player, y, spin}, smash {player}, rematch {player},
                   latency {player, ms}, start_game {player}
  server -> phones: score {p1, p2} (p1 = RED team, p2 = BLUE team), game_over {winner, label},
                   match_start {}
  server -> one phone: smash_landed {}, hit {type}
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

# Which player slots each mode uses (co-op: both humans on RED, BLUE is bots).
MODES = {"1v1": [1, 2], "2v2": [1, 2, 3, 4], "coop": [1, 3]}
DIFFICULTIES = ("easy", "hard")

# room code -> {"host": sid | None, "players": {1: sid, ...}, "ids": {1: client_id, ...},
#               "mode": "1v1", "difficulty": "easy", "state": "lobby" | "game"}
rooms = {}
rooms_lock = threading.Lock()


def normalise_code(data):
    """Pull a room code out of an event payload, upper-cased, or None if missing."""
    if not isinstance(data, dict):
        return None
    code = str(data.get("room") or "").strip().upper()
    return code[:16] or None


def new_room():
    return {"host": None, "players": {}, "ids": {}, "mode": "1v1", "difficulty": "easy",
            "state": "lobby"}


def room_snapshot(room):
    return {"players": sorted(room["players"]), "mode": room["mode"],
            "difficulty": room["difficulty"], "state": room["state"]}


def broadcast_room(code):
    """Send the room's current players/mode/state to its host and all its phones."""
    with rooms_lock:
        room = rooms.get(code)
        if not room:
            return
        snapshot = room_snapshot(room)
        host = room["host"]
    if host:
        socketio.emit("room_state", snapshot, to=host)
    socketio.emit("room_state", snapshot, to=phones_channel(code))


def repack_players(room, mode):
    """Fit the current phones into the new mode's slots (call with rooms_lock held).

    Phones already in a valid slot keep it (so P1 stays captain); the rest move to
    free slots in order, or are benched if there is no room. Returns [(sid, new
    number or None)] for every phone whose slot changed.
    """
    allowed = MODES[mode]
    old_players, old_ids = room["players"], room["ids"]
    room["players"], room["ids"] = {}, {}
    for number in sorted(old_players):
        if number in allowed:
            room["players"][number] = old_players[number]
            room["ids"][number] = old_ids.get(number)
    changed = []
    for number in sorted(old_players):
        if number in allowed:
            continue
        free = [n for n in allowed if n not in room["players"]]
        new_number = free[0] if free else None
        if new_number is not None:
            room["players"][new_number] = old_players[number]
            room["ids"][new_number] = old_ids.get(number)
        changed.append((old_players[number], new_number))
    room["mode"] = mode
    return changed


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
    # Phones that arrived before the host (e.g. after a host refresh) still count.
    broadcast_room(code)


@socketio.on("join")
def handle_join(data):
    code = normalise_code(data)
    if not code:
        return
    sid = request.sid
    client_id = str(data.get("id") or "")[:64] or None
    preferred = data.get("player")
    with rooms_lock:
        room = rooms.setdefault(code, new_room())
        allowed = MODES[room["mode"]]  # e.g. co-op only uses slots 1 and 3
        number = player_for(room, sid)
        if number is None and client_id:
            # Same phone on a new connection (its old one may not have timed out
            # yet): take the slot back instead of being told the room is full.
            number = next((n for n, i in room["ids"].items() if i == client_id), None)
        if number is None:
            free = [n for n in allowed if n not in room["players"]]
            # Prefer the slot this phone had before (e.g. after a server restart).
            number = preferred if preferred in free else (free[0] if free else None)
        if number is not None:
            room["players"][number] = sid
            room["ids"][number] = client_id
        mode = room["mode"]

    # Every phone listens to the room (even a benched one, so it hears mode changes).
    join_room(phones_channel(code))
    if number is None:
        socketio.emit("room_full", {"mode": mode}, to=sid)
        return
    socketio.emit("joined", {"player": number}, to=sid)
    broadcast_room(code)


def is_captain_or_host(room, sid):
    return sid == room["host"] or room["players"].get(1) == sid


@socketio.on("set_mode")
def handle_set_mode(data):
    """Captain (P1) or host picks the mode/difficulty in the lobby."""
    code = normalise_code(data)
    if not code:
        return
    mode = data.get("mode")
    difficulty = data.get("difficulty")
    with rooms_lock:
        room = rooms.get(code)
        if not room or not is_captain_or_host(room, request.sid) or room["state"] != "lobby":
            return
        if difficulty in DIFFICULTIES:
            room["difficulty"] = difficulty
        changed = repack_players(room, mode) if mode in MODES and mode != room["mode"] else []
        mode = room["mode"]
    # Phones that moved slot (e.g. P2 -> P3 for co-op) or lost theirs hear about it.
    for sid, number in changed:
        if number is None:
            socketio.emit("room_full", {"mode": mode}, to=sid)
        else:
            socketio.emit("joined", {"player": number}, to=sid)
    broadcast_room(code)


@socketio.on("start_game")
def handle_start_game(data):
    phone_to_host(data, "start_game")  # host checks it's P1 and everyone needed is in


@socketio.on("lobby_open")
def handle_lobby_open(data):
    """Host went back to the lobby: modes may change again."""
    code = normalise_code(data)
    if not code:
        return
    with rooms_lock:
        room = rooms.get(code)
        if not room or room["host"] != request.sid:
            return
        room["state"] = "lobby"
    broadcast_room(code)


@socketio.on("paddle")
def handle_paddle(data):
    code = normalise_code(data)
    if not code:
        return
    try:
        y = min(1.0, max(0.0, float(data.get("y"))))
        # Twist spin from the phone, -1..1 (older controllers don't send it: 0).
        spin = min(1.0, max(-1.0, float(data.get("spin") or 0)))
    except (TypeError, ValueError):
        return
    with rooms_lock:
        room = rooms.get(code)
        if not room or not room["host"]:
            return
        number = player_for(room, request.sid)
        host = room["host"]
    if number is not None:
        socketio.emit("paddle", {"player": number, "y": y, "spin": spin}, to=host)


def phone_to_host(data, event, extra=None):
    """Forward a phone's event to its room's host as {player, **extra}."""
    code = normalise_code(data)
    if not code:
        return
    with rooms_lock:
        room = rooms.get(code)
        if not room or not room["host"]:
            return
        number = player_for(room, request.sid)
        host = room["host"]
    if number is not None:
        socketio.emit(event, {"player": number, **(extra or {})}, to=host)


def host_to_phone(data, event, payload=None):
    """Forward a host event to one player's phone (data["player"] picks which)."""
    code = normalise_code(data)
    if not code:
        return
    with rooms_lock:
        room = rooms.get(code)
        if not room or room["host"] != request.sid:
            return  # only the host may send these
        phone = room["players"].get(data.get("player"))
    if phone:
        socketio.emit(event, payload or {}, to=phone)


@socketio.on("smash")
def handle_smash(data):
    phone_to_host(data, "smash")


@socketio.on("smash_landed")
def handle_smash_landed(data):
    host_to_phone(data, "smash_landed")


@socketio.on("hit")
def handle_hit(data):
    # "hit": this player's bat struck the ball. "concede": they just lost a point.
    kind = data.get("type") if isinstance(data, dict) else None
    if kind in ("hit", "concede"):
        host_to_phone(data, "hit", {"type": kind})


@socketio.on("latency_ping")
def handle_latency_ping(data):
    # Returning a value sends it as the Socket.IO acknowledgement: an immediate echo.
    return True


@socketio.on("latency")
def handle_latency(data):
    try:
        ms = max(0, min(9999, int(data.get("ms"))))
    except (AttributeError, TypeError, ValueError):
        return
    phone_to_host(data, "latency", {"ms": ms})


@socketio.on("rematch")
def handle_rematch(data):
    phone_to_host(data, "rematch")


def host_to_phones(data, event, payload=None):
    """Forward a host event to every phone in its room."""
    code = normalise_code(data)
    if not code:
        return
    with rooms_lock:
        room = rooms.get(code)
        if not room or room["host"] != request.sid:
            return  # only the host may send these
    socketio.emit(event, payload or {}, to=phones_channel(code))


@socketio.on("game_over")
def handle_game_over(data):
    winner = data.get("winner") if isinstance(data, dict) else None
    if winner in ("red", "blue"):
        label = str(data.get("label") or "")[:32]
        host_to_phones(data, "game_over", {"winner": winner, "label": label})


@socketio.on("match_start")
def handle_match_start(data):
    code = normalise_code(data)
    with rooms_lock:
        room = rooms.get(code)
        if room and room["host"] == request.sid:
            room["state"] = "game"  # no mode changes mid-match
    host_to_phones(data, "match_start")
    broadcast_room(code)


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
    changed = []  # rooms whose player list changed
    with rooms_lock:
        for code in list(rooms):
            room = rooms[code]
            if room["host"] == sid:
                room["host"] = None
            number = player_for(room, sid)
            if number is not None:
                del room["players"][number]
                room["ids"].pop(number, None)
                changed.append(code)
            if not room["host"] and not room["players"]:
                del rooms[code]
    for code in changed:
        broadcast_room(code)


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
