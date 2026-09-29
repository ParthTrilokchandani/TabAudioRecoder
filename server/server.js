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
const wss = new WebSocketServer({ server });
const listeners = new Set();
let headerChunk = null; // first chunk of the current producer session

wss.on("connection", (ws, req) => {
  const url = req.url || "";

  if (url.startsWith("/producer")) {
    console.log("Producer connected (extension is streaming).");
    headerChunk = null; // new session

    // Also save this live session to a file while broadcasting it.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(REC_DIR, `stream-${stamp}.webm`);
    const fileStream = fs.createWriteStream(filePath);
    console.log("Saving stream to", filePath);

    ws.on("message", (data) => {
      if (headerChunk === null) headerChunk = data; // cache init segment
      fileStream.write(data);                       // save to disk
      for (const l of listeners) {
        if (l.readyState === l.OPEN) l.send(data);  // fan out to GUIs
      }
    });
    ws.on("close", () => {
      console.log("Producer disconnected. Saved:", filePath);
      fileStream.end();
      headerChunk = null;
    });

  } else {
    // listener (browser GUI)
    console.log("Listener connected. Total listeners:", listeners.size + 1);
    listeners.add(ws);
    if (headerChunk) ws.send(headerChunk); // catch it up with the header
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
