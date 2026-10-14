// Tab Audio Server
// - Serves the listener GUI at            http://<host>:<port>/
// - Accepts the extension's live stream at ws://<host>:<port>/producer
// - Fans the audio out to browser GUIs at  ws://<host>:<port>/listener
//
// The audio is a continuous WebM/Opus stream from the extension's MediaRecorder.
// The very first chunk contains the WebM header (initialization segment), so we
// cache it and send it to any listener that joins mid-stream, otherwise their
// MediaSource cannot decode the following chunks.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const REC_DIR = path.join(__dirname, "recordings");
if (!fs.existsSync(REC_DIR)) fs.mkdirSync(REC_DIR, { recursive: true });

// --- static file server for the GUI ---------------------------------------
const server = http.createServer((req, res) => {
  let file = req.url === "/" ? "/index.html" : req.url;
  file = file.split("?")[0];
  const full = path.join(__dirname, "public", path.normalize(file));
  if (!full.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(full);
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
});

// --- websocket fan-out -----------------------------------------------------
// WebM/MSE requirement: a player must receive the *initialization segment*
// (EBML header … Tracks) first, and then media data starting at a *cluster*
// boundary. A listener that joins mid-stream and gets bytes from the middle of
// a cluster receives data (KB go up) but cannot decode it (no audio). So the
// server parses the WebM byte stream: it caches the init segment (everything
// before the first Cluster) and only starts a new listener at the next cluster
// boundary, sending it the cached header first.
const wss = new WebSocketServer({ server });
const listeners = new Map(); // ws -> { synced: boolean }

// EBML element id for a Cluster: 0x1F43B675
const CLUSTER_ID = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

let session = null; // current producer session

class ProducerSession {
  constructor(fileStream) {
    this.fileStream = fileStream;
    this.headerParts = [];
    this.header = null;      // Buffer once complete
    this.headerDone = false;
    this.carry = Buffer.alloc(0); // last few bytes, to catch an id split across chunks
  }

  onData(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.fileStream.write(chunk); // saved file gets the full continuous stream

    // Find the first cluster boundary that begins within THIS chunk.
    const combined = Buffer.concat([this.carry, chunk]);
    let firstBoundary = -1;
    let idx = combined.indexOf(CLUSTER_ID, 0);
    while (idx !== -1) {
      const offsetInChunk = idx - this.carry.length;
      if (offsetInChunk >= 0) { firstBoundary = offsetInChunk; break; }
      idx = combined.indexOf(CLUSTER_ID, idx + 1);
    }
    this.carry = combined.subarray(Math.max(0, combined.length - 3));

    // Accumulate the init segment until the first cluster appears.
    if (!this.headerDone) {
      if (firstBoundary === -1) {
        this.headerParts.push(chunk);
        return; // nothing decodable to send yet
      }
      this.headerParts.push(chunk.subarray(0, firstBoundary));
      this.header = Buffer.concat(this.headerParts);
      this.headerDone = true;
    }

    // Fan out.
    for (const [ws, st] of listeners) {
      if (ws.readyState !== ws.OPEN) continue;
      if (st.synced) {
        ws.send(chunk); // continuous stream for already-synced players
      } else if (firstBoundary !== -1) {
        ws.send(this.header);                 // init segment first
        ws.send(chunk.subarray(firstBoundary)); // then from a clean cluster
        st.synced = true;
      }
      // else: not synced yet and no boundary in this chunk -> wait for one
    }
  }
}

wss.on("connection", (ws, req) => {
  const url = req.url || "";

  if (url.startsWith("/producer")) {
    console.log("Producer connected (streaming).");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(REC_DIR, `stream-${stamp}.webm`);
    const fileStream = fs.createWriteStream(filePath);
    console.log("Saving stream to", filePath);

    session = new ProducerSession(fileStream);
    // New session => existing listeners must re-sync to the new header.
    for (const st of listeners.values()) st.synced = false;

    ws.on("message", (data) => { if (session) session.onData(data); });
    ws.on("close", () => {
      console.log("Producer disconnected. Saved:", filePath);
      fileStream.end();
      session = null;
    });

  } else {
    // listener (browser GUI)
    listeners.set(ws, { synced: false });
    console.log("Listener connected. Total listeners:", listeners.size);
    // It will be synced by the producer at the next cluster boundary.
    ws.on("close", () => {
      listeners.delete(ws);
      console.log("Listener left. Total listeners:", listeners.size);
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\nTab Audio Server running.`);
  console.log(`  GUI:      http://<this-machine-ip>:${PORT}/`);
  console.log(`  Extension server address to enter:  <this-machine-ip>:${PORT}\n`);
});
