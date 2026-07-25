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
const params = new URLSearchParams(location.search);
const env = [`LANTERN_ONLINE=${params.has("offline") ? "0" : "1"}`];
if (params.has("bench")) env.push(`LANTERN_BENCH=${params.get("bench")}`);

// Schematic-as-world: ?schem=<url> fetches the file (schemat.io URLs are
// routed through the proxy to dodge CORS) and boots a void world around it.
// ?gen=void|flat forces the generator without a schematic too.
// Schematics default to a void world (bedrock floor at -64, paste at -63) —
// the flat-generator scheduler livelock is fixed in the fork.
const gen = params.get("gen") ?? (params.has("schem") ? "void" : null);
if (gen && gen !== "normal") env.push(`LANTERN_WORLDGEN=${gen}`);
const schemY = params.get("y") ?? (gen === "normal" ? "100" : "-63");
env.push(`LANTERN_SCHEM_Y=${schemY}`);

function translateSchemUrl(raw) {
  let url = raw;
  try {
    const u = new URL(raw, location.href);
    if (u.hostname.endsWith("schemat.io")) {
      // A schematic PAGE link (schemat.io/schematics/{id}) isn't the file —
      // translate it to the API download endpoint.
      const page = u.pathname.match(/^\/schematics\/([A-Za-z0-9_-]+)\/?$/);
      const path = page ? `/api/v1/schematics/${page[1]}/download` : u.pathname;
      const base = location.hostname === "localhost"
        ? "http://localhost:9091"
        : `https://${location.hostname}:9443`;
      url = `${base}/api/schematio${path}${page ? "" : u.search}`;
    }
  } catch { /* relative path — leave as-is */ }
  return url;
}

async function fetchSchematicBytes(raw) {
  const url = translateSchemUrl(raw);
  writeText(`[schem] fetching ${raw}…\n`);
  const resp = await fetch(url);
  if (!resp.ok) {
    writeText(`[schem] fetch failed: HTTP ${resp.status}\n`);
    return null;
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  // Sniff: gzip (1f 8b) or bare NBT compound (0x0a) is a schematic; '<' or '{'
  // means we fetched a web page or an API error instead.
  if (buf[0] === 0x3c || buf[0] === 0x7b) {
    writeText(`[schem] that URL returned ${buf[0] === 0x3c ? "HTML" : "JSON"}, not a schematic file — check the link\n`);
    return null;
  }
  writeText(`[schem] ${(buf.length / 1024).toFixed(1)} KiB downloaded\n`);
  return buf;
}

async function fetchSchematic() {
  const raw = params.get("schem");
  if (!raw) return null;
  return fetchSchematicBytes(raw);
}

fetchSchematic()
  .catch((e) => { writeText(`[schem] ${e}\n`); return null; })
  .then((schem) => {
    farmWorker.postMessage(
      { type: "init", env, fresh: params.has("fresh"), schem },
      schem ? [schem.buffer] : [],
    );
  });
farmWorker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "term") writeText(m.text);
  else if (m.type === "status") statusEl.textContent = m.status;
  else if (m.type === "room") {
    const mcHost = location.hostname === "localhost" ? "localhost" : location.hostname;
    connectEl.textContent = `Minecraft Java 26.2 → ${mcHost}:25570 (room "${m.room}")`;
  } else if (m.type === "metrics") {
    onMetrics(m.data);
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

// --- metrics panel ---
const HISTORY = 120; // 2 minutes at 1 Hz
const msptHist = [];
const netInHist = [];
const netOutHist = [];
let prevNet = null;

const $ = (id) => document.getElementById(id);

function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`;
}

function onMetrics(d) {
  const tps = d.mspt > 50 ? 1000 / d.mspt : 20;
  const tpsOk = tps >= 19.5 ? "" : tps >= 15 ? " ⚠" : " ✖";
  $("m-tps").textContent = tps.toFixed(1) + tpsOk;
  $("m-mspt").innerHTML = `${d.mspt.toFixed(1)}<span class="unit"> ms</span>`;
  $("m-players").textContent = d.players;
  $("m-chunks").textContent = d.chunks;
  $("m-mem").innerHTML = `${d.mem_mb.toFixed(0)}<span class="unit"> MB</span>`;
  $("m-uptime").textContent = fmtUptime(d.uptime_s);
  $("m-tasks").textContent = d.tasks ?? "–";
  $("m-streams").textContent = d.net_streams ?? 0;
  $("m-outq").textContent = d.net_outq ?? 0;
  if (prevNet && d.now > prevNet.now) {
    const rate = (d.chunks - prevNet.chunks) / ((d.now - prevNet.now) / 1000);
    $("m-genrate").textContent = rate > 0 ? rate.toFixed(1) : "0";
  }

  msptHist.push(d.mspt);
  if (msptHist.length > HISTORY) msptHist.shift();

  if (prevNet) {
    const dt = Math.max(0.25, (d.now - prevNet.now) / 1000);
    netInHist.push((d.net_in - prevNet.net_in) / 1024 / dt);
    netOutHist.push((d.net_out - prevNet.net_out) / 1024 / dt);
    if (netInHist.length > HISTORY) { netInHist.shift(); netOutHist.shift(); }
  }
  prevNet = d;

  $("mspt-readout").textContent = `${d.mspt.toFixed(1)} ms`;
  const li = netInHist.at(-1) ?? 0, lo = netOutHist.at(-1) ?? 0;
  $("net-readout").textContent = `↓${li.toFixed(1)} ↑${lo.toFixed(1)}`;

  drawSpark($("mspt-chart"), [{ data: msptHist, color: "#c9812a" }], 50);
  drawSpark($("net-chart"), [
    { data: netInHist, color: "#c9812a" },
    { data: netOutHist, color: "#4f9bcb" },
  ]);
}

function drawSpark(canvas, series, refLine) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const all = series.flatMap((s) => s.data);
  if (!all.length) return;
  const max = Math.max(...all, refLine ?? 0, 1e-6) * 1.1;

  // baseline + optional reference line (e.g. 50ms budget), recessive
  ctx.strokeStyle = "#2c2620";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, H - 0.5);
  ctx.lineTo(W, H - 0.5);
  ctx.stroke();
  if (refLine && refLine < max) {
    const y = H - (refLine / max) * (H - 4);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const s of series) {
    if (s.data.length < 2) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    s.data.forEach((v, i) => {
      const x = (i / (HISTORY - 1)) * W;
      const y = H - (v / max) * (H - 4);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

// --- live schematic swap ---
const schemInput = document.getElementById("schem-url");
const schemBtn = document.getElementById("schem-load");
if (schemBtn) {
  schemBtn.addEventListener("click", async () => {
    const raw = schemInput.value.trim();
    if (!raw) return;
    schemBtn.disabled = true;
    try {
      const bytes = await fetchSchematicBytes(raw);
      if (bytes) farmWorker.postMessage({ type: "schem", bytes: bytes.buffer }, [bytes.buffer]);
    } catch (e) {
      writeText(`[schem] ${e}\n`);
    } finally {
      schemBtn.disabled = false;
    }
  });
  schemInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") schemBtn.click();
  });
}
