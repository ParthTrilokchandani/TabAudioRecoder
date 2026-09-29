// Service worker: orchestrates capture. It cannot record audio itself
// (no DOM/MediaRecorder/WebSocket-to-MediaStream in a worker), so it delegates
// to an offscreen document. Two modes: save to file, or live-stream to a server.

let recording = false;
let lastStatus = { state: "idle", text: "" };

async function hasOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    return await chrome.offscreen.hasDocument();
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capturing tab audio to save or stream."
  });
}

async function teardownOffscreen() {
  if (await hasOffscreen()) {
    try {
      await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" });
    } catch (e) { /* offscreen may not be listening */ }
    await chrome.offscreen.closeDocument();
  }
}

function normalizeServer(input) {
  let s = (input || "").trim();
  if (!s) throw new Error("Enter a server address, e.g. 192.168.1.5:8080");
  if (!/^wss?:\/\//i.test(s)) s = "ws://" + s; // default to ws://
  return s.replace(/\/+$/, "");
}

async function startRecording(mode, serverInput) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");

  // A stale offscreen doc can still hold the tab's audio stream, causing
  // "Cannot capture a tab with an active stream." Always tear it down first.
  await teardownOffscreen();

  let serverUrl = null;
  if (mode === "stream") serverUrl = normalizeServer(serverInput);

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id
  });

  await ensureOffscreen();

  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "start",
    mode,
    serverUrl,
    streamId,
    tabTitle: tab.title || "tab"
  });

  recording = true;
  lastStatus = {
    state: mode === "stream" ? "streaming" : "recording",
    text: mode === "stream" ? "Streaming live…" : "Recording to file…"
  };
  await chrome.storage.local.set({ recording: true, mode });
  chrome.action.setBadgeText({ text: mode === "stream" ? "LIVE" : "REC" });
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
}

async function stopRecording() {
  await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" });
  recording = false;
  lastStatus = { state: "idle", text: "" };
  await chrome.storage.local.set({ recording: false });
  chrome.action.setBadgeText({ text: "" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.target === "background") {
        if (msg.type === "get-state") {
          sendResponse({ recording, status: lastStatus });
        } else if (msg.type === "start") {
          await startRecording(msg.mode || "file", msg.serverUrl);
          sendResponse({ ok: true });
        } else if (msg.type === "stop") {
          await stopRecording();
          sendResponse({ ok: true });
        } else if (msg.type === "status") {
          lastStatus = { state: msg.state, text: msg.text };
          if (msg.state === "error" || msg.state === "stopped") {
            recording = false;
            chrome.action.setBadgeText({ text: "" });
            await chrome.storage.local.set({ recording: false });
          } else if (msg.state === "reconnecting") {
            chrome.action.setBadgeText({ text: "…" });
            chrome.action.setBadgeBackgroundColor({ color: "#f9ab00" });
          } else if (msg.state === "streaming") {
            chrome.action.setBadgeText({ text: "LIVE" });
            chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
          }
        } else if (msg.type === "save") {
          const filename = `tab-audio/${msg.filename}`;
          await chrome.downloads.download({ url: msg.url, filename, saveAs: false });
          await teardownOffscreen();
          sendResponse({ ok: true });
        }
      }
    } catch (err) {
      console.error(err);
      lastStatus = { state: "error", text: String(err && err.message || err) };
      recording = false;
      chrome.action.setBadgeText({ text: "" });
      sendResponse({ ok: false, error: lastStatus.text });
    }
  })();
  return true; // async response
});
