# Tab Audio Recorder + Live Streamer — Chrome Extension

A Manifest V3 Chrome extension that captures **audio from the current browser
tab** (YouTube, Google Meet, Teams web, Zoom web) and can either:

1. **Record to a `.webm` file** (saved to `Downloads/tab-audio/`), or
2. **Live-stream** the audio to a server over WebSocket, played in a browser GUI
   in real time (no file).

## Repository layout

```
plug/
├── manifest.json        extension manifest (MV3)
├── background.js        service worker: mints stream, manages state
├── offscreen.html/js    hidden page: MediaRecorder + WebSocket streaming
├── popup.html/js        toolbar UI (server address + Stream / Record / Stop)
├── icons/               action icons
└── server/              standalone Node.js GUI server (point 2)
    ├── package.json
    ├── server.js        HTTP + WebSocket fan-out
    └── public/index.html  live listener GUI (MediaSource playback)
```

## About the "VPN" requirement

The extension does **not** need to speak VPN itself. A VPN's only role is to put
both machines on one reachable network. Once connected, the server machine has
an IP address (its VPN-assigned IP); you type that IP into the extension and it
connects. The exact same setup works on a plain LAN or on one machine
(`localhost`). So the design is: **extension asks for server IP:port → opens a
WebSocket → streams live.**

---

## Part 1 — Load the extension

1. `chrome://extensions` → enable **Developer mode** (top-right).
2. **Load unpacked** → select this `plug` folder.
3. Pin the extension.

## Part 2 — Run the streaming server

Requires Node.js (check with `node --version`).

```bash
cd server
npm install        # installs the 'ws' dependency
npm start          # starts on port 8080 (set PORT to change)
```

The console prints the address. Find the server machine's IP:
- Windows: `ipconfig` → IPv4 Address (LAN), or your VPN adapter's IP.

## Part 3 — Stream live

1. On the **listener device**, open `http://<server-ip>:8080/` and click
   **Start listening** (the click is required so the browser allows audio).
2. In Chrome (the **source device**), open a tab playing audio.
3. Click the extension → type `<server-ip>:8080` in the server field →
   **Stream live to server**.
4. Audio plays live in the listener GUI, with a **waveform + level meter**.
   Click **Stop** in the popup to end.

Every live session is **also saved on the server** to
`server/recordings/stream-<timestamp>.webm` while it streams — so you get live
playback and an archived copy at once.

> Same machine test: run the server, open `http://localhost:8080/`, and enter
> `localhost:8080` in the extension.

## How live streaming works

- The offscreen page records tab audio with `MediaRecorder` in **250 ms** WebM/Opus
  chunks and sends each chunk over a WebSocket to `ws://<ip>:<port>/producer`.
- `server.js` caches the **first** chunk (the WebM header / init segment) and
  broadcasts every chunk to all listeners at `/listener`. New listeners get the
  cached header first so their decoder can start mid-stream.
- The GUI feeds chunks into a **MediaSource** `SourceBuffer` and plays them,
  trimming old buffer to stay near real time.

## Stability / reconnection

The live stream is resilient to the server going away:

- **Extension side:** if the WebSocket drops (server crash, network blip, VPN
  reconnect), the popup shows an amber **"Reconnecting…"** state and the badge
  turns to `…`. It retries with exponential backoff (up to 20 attempts, capped at
  15 s apart). On reconnect it restarts the recorder so a fresh WebM header is
  sent to the new server session (each reconnect writes a new file on the
  server). If the server never comes back it reports **"Server unreachable — gave
  up"** and stops cleanly. A connect timeout (6 s) means an unreachable address
  fails fast instead of hanging on a false "streaming".
- **Listener GUI:** if the server restarts, the page shows
  **"Server disconnected — reconnecting…"** and automatically rebuilds its player
  and resumes when the stream returns — no manual refresh needed.

## Limitations & notes

- Captures **tab** audio, not OS-wide system audio (covers in-browser YouTube/
  Meet/Teams/Zoom; not native desktop apps).
- Uses `ws://` (unencrypted) — fine for LAN/VPN/coursework. For the internet use
  `wss://` behind a TLS reverse proxy.
- **Legal/ethics:** recording or transmitting conversations is regulated by
  consent/wiretapping law (some places need *all* parties to consent). Only
  capture meetings you're entitled to, and inform participants. The popup and GUI
  both show a live indicator for transparency.
