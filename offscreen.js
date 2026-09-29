// Runs in the offscreen document: captures tab audio and either
//   - saves it to a .webm file (mode "file"), or
//   - live-streams the chunks to a server over WebSocket (mode "stream")
//     with automatic reconnection if the server drops.

let mediaRecorder = null;
let chunks = [];
let stream = null;
let audioCtx = null;
let mode = "file";
let tabTitle = "tab";

// streaming state
let ws = null;
let serverBase = null;       // e.g. ws://192.168.1.5:8080
let streamMime = "audio/webm";
let stopping = false;        // true only when the user pressed Stop
let reconnectAttempts = 0;
let reconnectTimer = null;
let openTimer = null;

const MAX_RECONNECTS = 20;   // then give up
const CONNECT_TIMEOUT_MS = 6000;

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60).trim() || "tab";
}

function pickMime() {
  return MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
}

async function start(opts) {
  mode = opts.mode || "file";
  tabTitle = sanitize(opts.tabTitle || "tab");
  chunks = [];
  stopping = false;
  reconnectAttempts = 0;

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: opts.streamId }
    },
    video: false
  });

  // Capturing a tab silences it for the user, so route it back to the speakers.
  audioCtx = new AudioContext();
  audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);

  streamMime = pickMime();

  if (mode === "stream") {
    serverBase = opts.serverUrl.replace(/\/+$/, "");
    connectAndStream();
  } else {
    startFileRecorder();
  }
}

/* ----------------------------- file mode ------------------------------- */
function startFileRecorder() {
  mediaRecorder = new MediaRecorder(stream, { mimeType: streamMime });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.onstop = onStopFile;
  mediaRecorder.start(1000);
}

async function onStopFile() {
  const blob = new Blob(chunks, { type: "audio/webm" });
  const reader = new FileReader();
  reader.onloadend = async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await chrome.runtime.sendMessage({
      target: "background", type: "save",
      url: reader.result, filename: `${tabTitle}-${stamp}.webm`
    });
    cleanup();
  };
  reader.readAsDataURL(blob);
}

/* ---------------------------- stream mode ------------------------------ */
function connectAndStream() {
  if (stopping) return;
  clearTimeout(openTimer);

  try {
    ws = new WebSocket(serverBase + "/producer");
  } catch (e) {
    return scheduleReconnect("Bad server address");
  }
  ws.binaryType = "arraybuffer";

  // If it doesn't open promptly, treat it as a failed attempt.
  openTimer = setTimeout(() => {
    if (ws && ws.readyState !== WebSocket.OPEN) {
      try { ws.close(); } catch (e) {}
    }
  }, CONNECT_TIMEOUT_MS);

  ws.onopen = () => {
    clearTimeout(openTimer);
    reconnectAttempts = 0;
    notify("streaming", "Connected — streaming live");
    startStreamRecorder(); // fresh recorder => fresh WebM header for this session
  };

  ws.onerror = () => { /* onclose will follow and drive reconnect */ };

  ws.onclose = () => {
    stopStreamRecorder();
    if (stopping) return;
    scheduleReconnect();
  };
}

function startStreamRecorder() {
  stopStreamRecorder();
  mediaRecorder = new MediaRecorder(stream, { mimeType: streamMime });
  mediaRecorder.ondataavailable = async (e) => {
    if (e.data && e.data.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(await e.data.arrayBuffer()); } catch (err) { /* dropping */ }
    }
  };
  mediaRecorder.start(250); // low-latency live chunks
}

function stopStreamRecorder() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch (e) {}
  }
  mediaRecorder = null;
}

function scheduleReconnect(reasonMsg) {
  clearTimeout(reconnectTimer);
  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECTS) {
    notify("stopped", "Server unreachable — gave up after " + MAX_RECONNECTS + " tries");
    cleanup();
    return;
  }
  const delay = Math.min(15000, 1000 * Math.pow(2, Math.min(reconnectAttempts, 4)));
  const secs = Math.round(delay / 1000);
  notify("reconnecting",
    (reasonMsg ? reasonMsg + " — " : "Connection lost — ") +
    `reconnecting in ${secs}s (try ${reconnectAttempts}/${MAX_RECONNECTS})`);
  reconnectTimer = setTimeout(connectAndStream, delay);
}

/* ------------------------------ shared --------------------------------- */
function stop() {
  stopping = true;
  clearTimeout(reconnectTimer);
  clearTimeout(openTimer);
  if (mode === "stream") {
    stopStreamRecorder();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try { ws.close(); } catch (e) {}
    }
    cleanup();
  } else if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop(); // file finalizes in onStopFile -> cleanup
  }
}

function cleanup() {
  clearTimeout(reconnectTimer);
  clearTimeout(openTimer);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioCtx && audioCtx.state !== "closed") audioCtx.close();
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    try { ws.close(); } catch (e) {}
  }
  stream = null; audioCtx = null; mediaRecorder = null; ws = null; chunks = [];
}

function notify(state, text) {
  chrome.runtime.sendMessage({ target: "background", type: "status", state, text });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "start") {
    start(msg).catch((e) => { notify("error", e.message); cleanup(); });
  } else if (msg.type === "stop") {
    stop();
  }
});
