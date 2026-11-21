# 📱 Phone Pong

**Classic Pong, remixed: tilt your phone to move your paddle.**

Built for the *Retro Remix* theme at **KCL FirstYearHack 2026**.

## What is it?

Phone Pong takes the 1970s arcade classic and swaps the knobs for the phone in
your pocket. The game runs in a browser on a big screen (laptop, monitor,
projector). Each player opens the site on their phone and tilts it up or down
to move their paddle, using the phone's motion sensors. Real-time updates go
between phones and the game screen over WebSockets (Flask-SocketIO).

## Tech stack

- **Backend:** Python, Flask, Flask-SocketIO
- **Frontend:** Plain HTML, CSS and JavaScript, with an HTML5 `<canvas>` for the game
- **Controls:** Browser `DeviceOrientation` API (phone tilt)

## Running locally

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

Then open <http://localhost:8000> in your browser.

> Port 8000 is the default because macOS AirPlay Receiver occupies port 5000.
> Use a different port with `PORT=8080 python app.py`.

### Playing from a phone

The server listens on all network interfaces, so phones on the **same Wi-Fi**
can connect using your computer's local IP address:

```bash
# macOS: find your local IP
ipconfig getifaddr en0
```

Then visit `http://<your-ip>:8000` on the phone.

> **Note:** iOS Safari (and some Android browsers) only allow motion-sensor
> access over **HTTPS**. For tilt controls on a phone you may need an HTTPS
> tunnel such as [ngrok](https://ngrok.com/) (`ngrok http 8000`).

## Project structure

```
phone-pong/
├── app.py              # Flask + Socket.IO server
├── requirements.txt    # Python dependencies
└── templates/
    └── index.html      # Retro home screen + game canvas
```

## Roadmap

- [x] Retro home screen
- [ ] Game loop: ball physics, paddles, scoring
- [ ] Phone controller page that sends tilt data over Socket.IO
- [ ] Room codes so two players can pair their phones with a game screen
- [ ] Sound effects and a winner screen
