// lantern console — main thread: terminal UI only. The WASI farm, WebSocket,
// and all fd servicing live in farm-worker.js so DOM work and background-tab
// throttling never block server I/O.
const logEl = document.getElementById("log");
const inputEl = document.getElementById("input");
const statusEl = document.getElementById("status");
const connectEl = document.getElementById("connect");

// Batch DOM appends: pushing a div + forced scroll per log line stalls the
// page during chunk-send bursts.
let pendingLine = "";
let queued = [];
let flushScheduled = false;
function flush() {
  flushScheduled = false;
  if (!queued.length) return;
  const frag = document.createDocumentFragment();
  for (const line of queued) {
    const div = document.createElement("div");
    div.textContent = line === "" ? " " : line;
    frag.appendChild(div);
  }
  queued = [];
  logEl.appendChild(frag);
  while (logEl.childNodes.length > 2000) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}
function writeText(text) {
  pendingLine += text;
  const lines = pendingLine.split("\n");
  pendingLine = lines.pop();
  queued.push(...lines);
  if (!flushScheduled && queued.length) {
    flushScheduled = true;
    setTimeout(flush, 40);
  }
}

const farmWorker = new Worker("./dist/farm-worker.js", { type: "module" });
const offline = new URLSearchParams(location.search).has("offline");
farmWorker.postMessage({ type: "init", env: [`LANTERN_ONLINE=${offline ? "0" : "1"}`] });
farmWorker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "term") writeText(m.text);
  else if (m.type === "status") statusEl.textContent = m.status;
  else if (m.type === "room") {
    const mcHost = location.hostname === "localhost" ? "localhost" : location.hostname;
    connectEl.textContent = `Minecraft Java 26.2 → ${mcHost}:25570 (room "${m.room}")`;
  } else if (m.type === "error") {
    statusEl.textContent = "crashed — see console";
    writeText(`\n[lantern] ${m.error}\n`);
  }
};

inputEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const line = inputEl.value;
  inputEl.value = "";
  writeText(`> ${line}\n`);
  farmWorker.postMessage({ type: "stdin", line: `${line}\n` });
});
