# 📱 Phone Pong

**Classic Pong, rebuilt for 2026: your phone is the paddle.**

Built for the **Retro Remix** track at **KCL FirstYearHack 2026**.

🎬 **Demo video:** _[link coming soon]_

![Game screen](docs/screenshot-game.png)
_Screenshot placeholder: game screen_

![Phone controller](docs/screenshot-phone.png)
_Screenshot placeholder: phone controller_

## Why we built it

Pong was one of the first video games, played by twisting a knob on an arcade
cabinet. We wanted to keep the simple game everyone already knows and swap the
knob for the controller everyone already carries. No app to install, no
gamepads: one screen, a QR code, and up to four phones in the room.

## How to play

1. **Open the game** on a big screen (laptop, monitor or projector) and press START.
2. **Scan the QR code** with your phone (or type in the 4-letter room code link).
3. **Tap ENABLE MOTION** on your phone and allow motion access.
4. **Tilt your phone** up and down to move your paddle. First team to 7 wins.

## Game modes

| Mode | Players |
|---|---|
| **1V1** | P1 (RED) vs P2 (BLUE) |
| **2V2** | P1 + P3 (RED) vs P2 + P4 (BLUE); P3 and P4 play the front bats near the net |
| **CO-OP VS BOTS** | P1 + P3 (RED) vs two BLUE bots, on **EASY** or **HARD** |

P1's phone is the "captain": it can pick the mode and difficulty and start the
match. The host screen can do the same.

## Controls

| Action | Phone | Keyboard (host) |
|---|---|---|
| Move paddle | Tilt up / down (or drag up / down in the box) | P1: **W / S** · P2: **↑ / ↓** (P3 in co-op) |
| Spin | Twist the phone left / right (or drag sideways) | n/a |
| Smash | Shake the phone just before the ball arrives | n/a |
| Pause | **PAUSE** button | **P** or **Esc** (or the on-screen PAUSE button) |
| Recentre tilt | **RECENTRE** button | n/a |

No phones? Press **SPACE** in the lobby to play with the keyboard.

## Special shots

- **Spin:** a fast-moving bat or a twist of the phone puts spin on the ball,
  which curves it through the air. Bots don't predict the curve, so spin is
  your best weapon against them. Hits with spin show **SPIN!**
- **Smash:** shake your phone, then hit the ball within about half a second.
  The return flies 1.8× faster, with screen shake, a flash, a fiery trail and a
  big **SMASH!** Your phone buzzes and flashes when it lands.

## How it works

- A Flask server hosts the game screen (`/`) and the phone controller (`/play?room=CODE`).
- The host creates a room; phones join it with the code from the QR link.
- Phones stream their tilt (about 30 times a second) over Socket.IO; the server relays it to the host.
- The host runs all the game physics on an HTML5 canvas and sends scores, hits and pauses back to the phones.

## Tech stack

- **Backend:** Python, Flask, Flask-SocketIO (threading mode, simple-websocket)
- **Frontend:** Plain HTML, CSS and JavaScript, with an HTML5 `<canvas>` for the game
- **Controls:** Browser `DeviceOrientation` (tilt and twist) and `DeviceMotion` (shake) APIs
- **Real-time:** Socket.IO (WebSockets, with polling as a fallback)

## Running it

Requires Python 3.9+.

```bash
# 1. Create and activate a virtual environment
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Start the server
python app.py
```

Then open <http://localhost:8000> on the big screen.

> Port 8000 is the default because macOS AirPlay Receiver occupies port 5000.
> Use a different port with `PORT=8080 python app.py`.

### Playing from phones (ngrok and iPhone HTTPS)

Phones can't open `localhost`: that would point at the phone itself. And
iPhones (and some Android browsers) only allow motion sensors over **HTTPS**.
The easiest fix is an HTTPS tunnel with [ngrok](https://ngrok.com/):

```bash
ngrok http 8000
```

Open the `https://….ngrok-free.app` link on the big screen and the QR code will
point phones at the same link. On iPhone, tap **ENABLE MOTION** and allow access
when asked.

On the same Wi-Fi you can also use your computer's local IP
(`ipconfig getifaddr en0` on macOS, then `http://<your-ip>:8000`), but without
HTTPS iPhones fall back to drag controls.

## How we built it

- We worked in **IntelliJ IDEA** with **JetBrains Air**, using **Claude Code**
  as our coding agent.
- We **split the work by file**: one of us owned the host game screen
  (`templates/index.html`), the other the phone controller (`templates/play.html`,
  `static/controller.js`), with the server (`app.py`) in between.
- Before splitting up we **agreed a Socket.IO event contract** (written at the
  top of `app.py` and `controller.js`), so our halves connected first time.
- We let **other teams playtest** it and tuned the tilt range (now ±37.5°) and
  the tilt smoothing from their feedback.

## What we learned

- **Real-time networking:** WebSockets (through Socket.IO) keep a connection
  open so devices can talk instantly instead of asking the server again and
  again. When the WebSocket connection fails, Socket.IO quietly falls back to
  slow HTTP polling. Everything still "works", but that is what made our
  paddles lag.
- **Phone sensors on the web:** we read tilt with the `DeviceOrientation` API.
  iPhones only allow it over HTTPS, and only after the user taps a button to
  give permission.
- **HTTPS and tunnelling:** a phone can't reach `localhost`, because on the
  phone that means the phone itself. ngrok gives a laptop a public HTTPS link,
  which solves both problems at once.
- **Scoping under time pressure:** we got the core game working first (one
  ball, two paddles, tilt), then added features (modes, bots, spin, smash,
  pause), and froze features before the deadline to leave time for testing
  and polish.

## Limitations

- Runs on Flask's development server with rooms kept in memory, so a server
  restart ends every game.
- Tilt needs HTTPS on iPhone; without it, players use the drag controls.
- Everyone has to be in the same room as the screen; there is no online play.
- Phones that reconnect while the game is paused don't see the pause menu until
  the next pause or resume.
- The font, QR code and Socket.IO client load from CDNs, so the game needs
  internet access.

## Future plans

- Deploy it with a production server and a permanent HTTPS link.
- Online play, so phones and screens don't need to be in the same room.
- More modes and power-ups, plus a tournament / leaderboard mode.
- Settings for tilt sensitivity, sound and match length.

## Project structure

```
phone-pong/
├── app.py                # Flask + Socket.IO server: rooms, players, event relay
├── requirements.txt      # Python dependencies
├── static/
│   └── controller.js     # Phone controller: tilt, spin, smash, pause, lobby
└── templates/
    ├── index.html        # Host screen: lobby, QR code, game, pause and win screens
    └── play.html         # Phone controller page
```

## Credits

- [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) font by CodeMan38 (Google Fonts)
- [QRCode.js](https://github.com/davidshimjs/qrcodejs) for the QR code
- [Socket.IO](https://socket.io/) and [Flask-SocketIO](https://flask-socketio.readthedocs.io/) for real-time messaging

## License

MIT License.

## Team

- Yash
- Oscar
