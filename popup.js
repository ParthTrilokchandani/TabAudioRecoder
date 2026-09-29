const controls = document.getElementById("controls");
const serverInput = document.getElementById("server");
const streamBtn = document.getElementById("stream");
const recordBtn = document.getElementById("record");
const stopBtn = document.getElementById("stop");
const status = document.getElementById("status");

function setStatus(text, isErr) {
  status.textContent = text || "";
  status.className = isErr ? "err" : "";
}

function render(state) {
  const active = state && state.recording;
  controls.classList.toggle("hidden", active);
  stopBtn.classList.toggle("hidden", !active);
  const st = state && state.status;
  if (st && st.text) {
    if (active) {
      const dotCls = st.state === "reconnecting" ? "dot warn" : "dot";
      status.className = st.state === "reconnecting" ? "warn" : "";
      status.innerHTML = '<span class="' + dotCls + '"></span>' + st.text;
    } else {
      // finished/failed: show plain text, red if it was an error/gave up
      setStatus(st.text, st.state === "error" || st.state === "stopped");
    }
  } else {
    setStatus("");
  }
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ target: "background", type: "get-state" });
  render(res);
}

// Keep the popup live while it's open (reconnect status, drops, etc.).
setInterval(refresh, 1000);

// Restore last-used server address.
chrome.storage.local.get("server").then((r) => {
  if (r.server) serverInput.value = r.server;
});

streamBtn.addEventListener("click", async () => {
  const server = serverInput.value.trim();
  if (!server) { setStatus("Enter the server address first.", true); return; }
  await chrome.storage.local.set({ server });
  streamBtn.disabled = true;
  const res = await chrome.runtime.sendMessage({
    target: "background", type: "start", mode: "stream", serverUrl: server
  });
  streamBtn.disabled = false;
  if (!res || res.ok === false) setStatus("Error: " + (res && res.error || "unknown"), true);
  else refresh();
});

recordBtn.addEventListener("click", async () => {
  recordBtn.disabled = true;
  const res = await chrome.runtime.sendMessage({
    target: "background", type: "start", mode: "file"
  });
  recordBtn.disabled = false;
  if (!res || res.ok === false) setStatus("Error: " + (res && res.error || "unknown"), true);
  else refresh();
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  await chrome.runtime.sendMessage({ target: "background", type: "stop" });
  stopBtn.disabled = false;
  refresh();
});

refresh();
