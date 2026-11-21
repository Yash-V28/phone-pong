"""Phone Pong - classic Pong controlled by tilting your phone.

Built at KCL FirstYearHack 2026 (Retro Remix).
"""
import os

from flask import Flask, render_template
from flask_socketio import SocketIO

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-me")

# threading mode works on any Python version without extra async libraries.
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*")


@app.route("/")
def index():
    return render_template("index.html")


@socketio.on("connect")
def handle_connect():
    print("Client connected")


@socketio.on("disconnect")
def handle_disconnect():
    print("Client disconnected")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    # host 0.0.0.0 so phones on the same Wi-Fi can reach the server.
    socketio.run(app, host="0.0.0.0", port=port, debug=True, allow_unsafe_werkzeug=True)
