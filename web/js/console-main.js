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
const savedMotd = localStorage.getItem("lantern-motd") || "";
if (savedMotd) env.push(`LANTERN_MOTD=${savedMotd}`);
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
        : (!location.port || location.port === "443")
          ? `https://${location.hostname}`
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
  if (params.has("schemstage")) {
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle("import-schem.bin");
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      await root.removeEntry("import-schem.bin").catch(() => {});
      writeText(`[schem] loading staged schematic (${(bytes.length / 1024).toFixed(1)} KiB)\n`);
      return bytes;
    } catch {
      writeText("[schem] no staged schematic found\n");
      return null;
    }
  }
  const raw = params.get("schem");
  if (!raw) return null;
  return fetchSchematicBytes(raw);
}

fetchSchematic()
  .catch((e) => { writeText(`[schem] ${e}\n`); return null; })
  .then((schem) => {
    farmWorker.postMessage(
      { type: "init", env, fresh: params.has("fresh"), schem, world: params.has("world") },
      schem ? [schem.buffer] : [],
    );
    // fresh/world are one-shot: once consumed, the imported world lives in
    // state.bin — a manual reload must not wipe it or re-import.
    if (params.has("fresh") || params.has("world") || params.has("schemstage")) {
      const clean = new URLSearchParams(location.search);
      clean.delete("fresh");
      clean.delete("world");
      clean.delete("schemstage");
      const qs = clean.toString();
      history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
    }
  });
let serverRunning = false;
farmWorker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "term") writeText(m.text);
  else if (m.type === "status") {
    statusEl.textContent = m.status;
    if (/server running/.test(m.status)) serverRunning = true;
    if (/exited|crashed/.test(m.status)) serverRunning = false;
  }
  else if (m.type === "room") {
    const h = location.hostname;
    const sidecar = h !== "localhost" && (!location.port || location.port === "443");
    // The sidecar TCP-forwards the default Minecraft port; direct access uses
    // :25570. The bare address routes to room "default" — which this page
    // owns after boot (newest-wins takeover); suffixed rooms only work where
    // wildcard DNS resolves (not on *.ts.net), so flag them.
    const bare = sidecar ? h : `${h === "localhost" ? "localhost" : h}:25570`;
    const addrEl = document.getElementById("mc-addr");
    const roomEl = document.getElementById("mc-room");
    addrEl.value = bare;
    const infoRoom = document.getElementById("info-room");
    if (infoRoom) infoRoom.textContent = m.room;
    roomEl.textContent = m.room === "default"
      ? ""
      : `⚠ room "${m.room}" — another server owns this address`;
    roomEl.style.color = m.room === "default" ? "#9a8f7a" : "#e0a458";
  } else if (m.type === "metrics") {
    onMetrics(m.data);
    if (m.data && Array.isArray(m.data.player_list)) renderPlayers(m.data.player_list);
    if (m.data && Array.isArray(m.data.earth_needed) && earth.origin) {
      for (const [rx, rz] of m.data.earth_needed) earthFetchRegion(rx, rz);
    }
    const act = document.getElementById("activity");
    if (act) {
      const text = (m.data && m.data.activity) || "";
      act.textContent = text ? `⚙ ${text}` : "";
      act.style.display = text ? "block" : "none";
    }
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

// --- mc-tick simulation toggle ---
const simOn = document.getElementById("sim-on");
const simOff = document.getElementById("sim-off");
simOn?.addEventListener("click", () => {
  farmWorker.postMessage({ type: "sim", cmd: "on" });
  writeText("[sim] mc-tick engine requested ON\n");
});
simOff?.addEventListener("click", () => {
  farmWorker.postMessage({ type: "sim", cmd: "off" });
  writeText("[sim] mc-tick engine requested OFF\n");
});
// Debug/scripting hook: lanternSim("use 0 -62 0")
window.lanternSim = (cmd) => farmWorker.postMessage({ type: "sim", cmd: String(cmd) });

// --- drag & drop: schematics hot-swap the running server; world zips are
// staged in OPFS and the page reboots with the world mounted ---
const dropOverlay = document.createElement("div");
dropOverlay.textContent = "drop to load — .schem / .litematic / .schematic hot-swaps, world .zip reboots into that world";
dropOverlay.style.cssText = "position:fixed; inset:0; z-index:99; display:none; align-items:center; justify-content:center; text-align:center; padding:40px; background:rgba(22,19,15,.88); border:3px dashed #f0a030; color:#f0a030; font-size:16px; pointer-events:none;";
document.body.appendChild(dropOverlay);

let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (++dragDepth === 1) dropOverlay.style.display = "flex";
});
document.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.style.display = "none"; }
});
document.addEventListener("dragover", (e) => e.preventDefault());

async function importWorldZip(file) {
  writeText(`[world] staging ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MiB) — the server will reboot into it\n`);
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle("import-world.zip", { create: true });
  const w = await handle.createWritable();
  await w.write(await file.arrayBuffer());
  await w.close();
  const next = new URLSearchParams();
  if (params.has("offline")) next.set("offline", params.get("offline") || "1");
  if (params.has("gen")) next.set("gen", params.get("gen"));
  next.set("fresh", "1");
  next.set("world", "1");
  location.href = `${location.pathname}?${next}`;
}

document.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.style.display = "none";
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    if (/\.zip$/i.test(file.name)) {
      if (serverRunning) {
        // Live swap: no reboot, no kick — chunks reload in place.
        const bytes = await file.arrayBuffer();
        writeText(`[world] dropped ${file.name} (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB) — swapping live\n`);
        farmWorker.postMessage({ type: "worldswap", bytes }, [bytes]);
      } else {
        await importWorldZip(file);
      }
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer());
      showDropModal(file.name, bytes);
    }
  } catch (err) {
    writeText(`[drop] ${err.message ?? err}\n`);
  }
});

// --- copy-paste MC address ---
const mcAddrEl = document.getElementById("mc-addr");
const mcCopyBtn = document.getElementById("mc-copy");
async function copyMcAddr() {
  const v = mcAddrEl.value;
  if (!v || v === "…") return;
  try {
    await navigator.clipboard.writeText(v);
  } catch {
    mcAddrEl.select();
    document.execCommand("copy");
  }
  mcCopyBtn.textContent = "copied!";
  setTimeout(() => { mcCopyBtn.textContent = "copy"; }, 1200);
}
mcCopyBtn?.addEventListener("click", copyMcAddr);
mcAddrEl?.addEventListener("click", () => { mcAddrEl.select(); copyMcAddr(); });

// --- schematic drop modal: paste at coords, or reboot into a fresh void world ---
let pendingDrop = null;
const dropModal = document.getElementById("drop-modal");
function showDropModal(name, bytes) {
  pendingDrop = { name, bytes };
  document.getElementById("drop-modal-name").textContent = name;
  dropModal.style.display = "flex";
}
document.getElementById("drop-cancel")?.addEventListener("click", () => {
  pendingDrop = null;
  dropModal.style.display = "none";
});
document.getElementById("drop-paste")?.addEventListener("click", () => {
  if (!pendingDrop) return;
  const at = {
    x: parseInt(document.getElementById("drop-x").value, 10) || 0,
    y: parseInt(document.getElementById("drop-y").value, 10) || 0,
    z: parseInt(document.getElementById("drop-z").value, 10) || 0,
  };
  writeText(`[schem] pasting ${pendingDrop.name} at ${at.x} ${at.y} ${at.z}\n`);
  farmWorker.postMessage({ type: "schem", bytes: pendingDrop.bytes.buffer, at }, [pendingDrop.bytes.buffer]);
  pendingDrop = null;
  dropModal.style.display = "none";
});
document.getElementById("drop-world")?.addEventListener("click", async () => {
  if (!pendingDrop) return;
  const { name, bytes } = pendingDrop;
  pendingDrop = null;
  dropModal.style.display = "none";
  writeText(`[schem] staging ${name} — rebooting into a fresh void world around it\n`);
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle("import-schem.bin", { create: true });
  const w = await handle.createWritable();
  await w.write(bytes);
  await w.close();
  const next = new URLSearchParams();
  if (params.has("offline")) next.set("offline", params.get("offline") || "1");
  next.set("fresh", "1");
  next.set("gen", "void");
  next.set("schemstage", "1");
  location.href = `${location.pathname}?${next}`;
}); 

// --- server settings card ---
const motdInput = document.getElementById("cfg-motd");
if (motdInput) {
  motdInput.value = localStorage.getItem("lantern-motd") || "";
  motdInput.addEventListener("change", () => {
    localStorage.setItem("lantern-motd", motdInput.value);
    writeText(`[cfg] MOTD saved — applies on the next world reboot\n`);
  });
}
const genSelect = null; // world type lives solely in the new-world modal
if (genSelect) genSelect.value = (gen || "normal");
const infoGen = document.getElementById("info-gen");
if (infoGen) infoGen.textContent = gen || "normal";
genSelect?.addEventListener("change", () => { if (infoGen) infoGen.textContent = genSelect.value; });
const nwModal = document.getElementById("nw-modal");
const nwStatus = document.getElementById("nw-status");
function nwStep(text, done) {
  if (!nwStatus) return;
  nwStatus.style.display = "flex";
  if (text === null) { nwStatus.style.display = "none"; nwStatus.innerHTML = ""; return; }
  const el = document.createElement("div");
  el.textContent = `${done ? "✓" : "…"} ${text}`;
  if (done && nwStatus.lastChild) nwStatus.lastChild.remove();
  nwStatus.appendChild(el);
}
document.getElementById("cfg-newworld")?.addEventListener("click", () => {
  // Restore the user's last choice and SYNC the sdf panel visibility —
  // silently resetting to "normal" while the SDF panel stayed visible sent
  // normal-world resets for configured OSM/streamed worlds.
  const last = localStorage.getItem("lantern-worldtype");
  if (last) document.getElementById("nw-gen").value = last;
  document.getElementById("nw-gen").dispatchEvent(new Event("change"));
  nwModal.style.display = "flex";
});
document.getElementById("nw-gen")?.addEventListener("change", () => {
  localStorage.setItem("lantern-worldtype", document.getElementById("nw-gen").value);
});
document.getElementById("nw-cancel")?.addEventListener("click", () => nwModal.style.display = "none");
async function wipeOpfsSave() {
  const root = await navigator.storage.getDirectory();
  for (const f of ["lantern-world.bin", "import-world.zip", "import-schem.bin"]) {
    await root.removeEntry(f).catch(() => {});
  }
}
const SDF_PRESETS = {
  planet: { y: -20, program: { type: "sphere", radius: 80 } },
  moons: { y: 20, program: { type: "union",
    a: { type: "sphere", radius: 24 },
    b: { type: "union",
      a: { type: "translate", offset: [60, 10, 0], child: { type: "sphere", radius: 16 } },
      b: { type: "translate", offset: [-40, -5, 50], child: { type: "sphere", radius: 20 } } } } },
  slab: { y: -30, program: { type: "elongate", halfLengths: [120, 0, 120], child: { type: "sphere", radius: 8 } } },
};
const nwGenSel = document.getElementById("nw-gen");
const nwSdfBox = document.getElementById("nw-sdf");
const nwSdfPreset = document.getElementById("nw-sdf-preset");
const nwSdfJson = document.getElementById("nw-sdf-json");
nwGenSel?.addEventListener("change", () => {
  nwSdfBox.style.display = nwGenSel.value === "sdf" ? "flex" : "none";
});
nwSdfPreset?.addEventListener("change", () => {
  nwSdfJson.style.display = nwSdfPreset.value === "custom" ? "block" : "none";
  const geo = nwSdfPreset.value === "osm" || nwSdfPreset.value === "earth";
  document.getElementById("nw-osm-row").style.display = geo ? "flex" : "none";
});

// Overpass → nucleation footprints: query buildings around lat/lon, project
// to blocks (1m ≈ 1 block, equirectangular at that latitude), height from
// tags (height in meters, else building:levels × 3m, else 8).
// AWS terrarium elevation tiles -> heightmap grid centered at lat/lon.
// h_meters = R*256 + G + B/256 - 32768; 1 block = 1 m, min height -> y 2.
async function fetchTerrainGrid(lat, lon, radius, base) {
  const Z = 14;
  const n = 2 ** Z;
  const latRad = lat * Math.PI / 180;
  const tx = (lon + 180) / 360 * n;
  const ty = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  const mPerPx = 156543.03 * Math.cos(latRad) / (2 ** Z) / 256 * 256 / 256; // per pixel at z
  const metersPerTile = 40075016.7 * Math.cos(latRad) / n;
  const tileSpan = Math.ceil(radius / metersPerTile) ;
  const tiles = new Map();
  const loads = [];
  for (let dx = -tileSpan; dx <= tileSpan; dx++) {
    for (let dy = -tileSpan; dy <= tileSpan; dy++) {
      const X = Math.floor(tx) + dx, Y = Math.floor(ty) + dy;
      loads.push((async () => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        const done = new Promise((res, rej) => {
          img.onload = res;
          img.onerror = () => rej(new Error("tile"));
          setTimeout(() => rej(new Error("tile timeout")), 20000);
        });
        img.src = `${base}/api/terrain/elevation-tiles-prod/terrarium/${Z}/${X}/${Y}.png`;
        await done;
        const c = document.createElement("canvas");
        c.width = c.height = 256;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        tiles.set(`${X},${Y}`, g.getImageData(0, 0, 256, 256).data);
      })().catch(() => {}));
    }
  }
  await Promise.all(loads);
  const elevAt = (la, lo) => {
    const fx = (lo + 180) / 360 * n;
    const laR = la * Math.PI / 180;
    const fy = (1 - Math.log(Math.tan(laR) + 1 / Math.cos(laR)) / Math.PI) / 2 * n;
    const X = Math.floor(fx), Y = Math.floor(fy);
    const d = tiles.get(`${X},${Y}`);
    if (!d) return null;
    const px = Math.min(255, Math.floor((fx - X) * 256));
    const py = Math.min(255, Math.floor((fy - Y) * 256));
    const i = (py * 256 + px) * 4;
    return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
  };
  const mLat = 111320, mLon = 111320 * Math.cos(latRad);
  const step = Math.max(2, Math.round(radius / 250));
  const half = Math.ceil(radius / step);
  const width = half * 2 + 1;
  const heights = new Array(width * width).fill(0);
  let min = Infinity, max = -Infinity;
  for (let gz = 0; gz < width; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const wx = (gx - half) * step, wz = (gz - half) * step;
      const e = elevAt(lat - wz / mLat, lon + wx / mLon);
      heights[gz * width + gx] = e === null ? 0 : e;
      if (e !== null) { min = Math.min(min, e); max = Math.max(max, e); }
    }
  }
  if (!isFinite(min)) return null;
  for (let i = 0; i < heights.length; i++) {
    heights[i] = Math.max(1, Math.round(heights[i] - min) + 2);
  }
  writeText(`[osm] terrain: ${width}x${width} grid, relief ${(max - min).toFixed(0)}m (step ${step})\n`);
  return { heights, width, originX: -half * step, originZ: -half * step, step,
           surface: "minecraft:grass_block", sub: "minecraft:stone",
           sample: (wx, wz) => heights[
             Math.min(width - 1, Math.max(0, Math.round((wz + half * step) / step))) * width +
             Math.min(width - 1, Math.max(0, Math.round((wx + half * step) / step)))] };
}

const ROAD_STYLE = {
  motorway: [12, "minecraft:gray_concrete"], trunk: [11, "minecraft:gray_concrete"],
  primary: [9, "minecraft:gray_concrete"], secondary: [8, "minecraft:gray_concrete"],
  tertiary: [7, "minecraft:gray_concrete"], residential: [6, "minecraft:gray_concrete"],
  service: [4, "minecraft:light_gray_concrete"], footway: [2, "minecraft:dirt_path"],
  path: [2, "minecraft:dirt_path"], cycleway: [3, "minecraft:stone_bricks"],
  pedestrian: [5, "minecraft:stone_bricks"], unclassified: [5, "minecraft:gray_concrete"],
};

// A road polyline becomes one thin quad footprint per segment, each seated on
// the terrain at its midpoint — roads climb hills in steps.
function roadFootprints(el, lon, lat, mLon, mLat, terrain) {
  const style = ROAD_STYLE[(el.tags || {}).highway];
  if (!style) return [];
  const [w, block] = style;
  const pts = el.geometry.map((pt) => [(pt.lon - lon) * mLon, -((pt.lat - lat) * mLat)]);
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[i + 1];
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) continue;
    const nx = (-dz / len) * (w / 2), nz = (dx / len) * (w / 2);
    const y = terrain ? terrain.sample((x1 + x2) / 2, (z1 + z2) / 2) : 1;
    out.push({
      polygon: [[x1 + nx, z1 + nz], [x2 + nx, z2 + nz], [x2 - nx, z2 - nz], [x1 - nx, z1 - nz]],
      height: y, min_y: y, block,
    });
  }
  return out;
}

async function fetchOsmFootprints(lat, lon, radius) {
  const base = location.hostname === "localhost"
    ? "http://localhost:9091"
    : (!location.port || location.port === "443") ? "" : `https://${location.hostname}:9443`;
  const q = `[out:json][timeout:25];(way["building"](around:${radius},${lat},${lon});way["highway"](around:${radius},${lat},${lon}););out geom;`;
  writeText(`[osm] querying Overpass for buildings within ${radius}m of ${lat}, ${lon}…\n`);
  // Public Overpass instances slot-limit per IP — rotate mirrors and retry.
  let data = null, lastErr = null;
  for (const route of ["/api/overpass", "/api/overpass-alt", "/api/overpass"]) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 45000);
      const resp = await fetch(`${base}${route}/api/interpreter?data=${encodeURIComponent(q)}`,
        { signal: ctl.signal });
      clearTimeout(timer);
      if (!resp.ok) { lastErr = new Error(`Overpass HTTP ${resp.status}`); continue; }
      data = await resp.json();
      break;
    } catch (e) {
      lastErr = e;
      writeText(`[osm] mirror ${route} failed (${e.name === "AbortError" ? "timeout" : e.message}) — trying next…\n`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!data) throw lastErr || new Error("all Overpass mirrors failed");
  const mLat = 111320;
  const mLon = 111320 * Math.cos(lat * Math.PI / 180);
  const BLOCKS = { church: "minecraft:stone_bricks", cathedral: "minecraft:stone_bricks",
    industrial: "minecraft:gray_concrete", retail: "minecraft:white_concrete",
    apartments: "minecraft:bricks", house: "minecraft:oak_planks" };
  const base2 = location.hostname === "localhost"
    ? "http://localhost:9091"
    : (!location.port || location.port === "443") ? "" : `https://${location.hostname}:9443`;
  let terrain = null;
  try { terrain = await fetchTerrainGrid(lat, lon, radius, base2); }
  catch (e) { writeText(`[osm] terrain unavailable (${e.message}) — flat base\n`); }

  const footprints = [];
  let roads = 0;
  for (const el of data.elements || []) {
    if (el.type !== "way" || !el.geometry) continue;
    const tags = el.tags || {};
    if (tags.building && el.geometry.length >= 4) {
      const polygon = el.geometry.map((pt) => [
        (pt.lon - lon) * mLon,
        -((pt.lat - lat) * mLat),
      ]);
      let h = parseFloat(tags.height) || (parseInt(tags["building:levels"], 10) || 0) * 3 || 8;
      h = Math.min(Math.round(h), 250);
      // Seat on terrain at the footprint centroid.
      let cx = 0, cz = 0;
      for (const [px, pz] of polygon) { cx += px; cz += pz; }
      cx /= polygon.length; cz /= polygon.length;
      const ground = terrain ? terrain.sample(cx, cz) : 1;
      footprints.push({
        polygon,
        height: ground + h,
        min_y: ground,
        block: BLOCKS[tags.building] || "minecraft:bricks",
      });
    } else if (tags.highway && el.geometry.length >= 2) {
      const segs = roadFootprints(el, lon, lat, mLon, mLat, terrain);
      roads += segs.length ? 1 : 0;
      footprints.push(...segs);
    }
  }
  writeText(`[osm] ${footprints.filter(f => f.height > f.min_y).length} buildings + ${roads} roads converted\n`);
  return { footprints, terrain };
}

document.getElementById("nw-create")?.addEventListener("click", async () => {
  const g = document.getElementById("nw-gen").value;
  const seed = document.getElementById("nw-seed").value.trim();
  const wipe = document.getElementById("nw-wipeopfs").checked;
  nwStep(null);
  if (wipe) { await wipeOpfsSave(); writeText("[world] OPFS save deleted\n"); }
  if (g !== "sdf") nwModal.style.display = "none";
  if (g === "sdf") {
    const preset = nwSdfPreset.value;
    const block = document.getElementById("nw-sdf-block").value || "minecraft:stone";
    const parseJson = (label) => {
      try { return JSON.parse(nwSdfJson.value); }
      catch (e) { writeText(`[world] bad ${label} JSON: ${e.message}\n`); return null; }
    };
    // Streamed kinds go through nucleation's ChunkSource (infinite worlds).
    if (preset === "earth") {
      const lat = parseFloat(document.getElementById("nw-osm-lat").value);
      const lon = parseFloat(document.getElementById("nw-osm-lon").value);
      if (!isFinite(lat) || !isFinite(lon)) { writeText("[earth] bad lat/lon\n"); return; }
      await startEarthWorld(lat, lon);
      setTimeout(() => { nwModal.style.display = "none"; nwStep(null); }, 2000);
      return;
    }
    if (preset === "planet" || preset === "cellular" || preset === "custom" || preset === "osm" || preset === "riverfall" || preset === "alps") {
      let payload;
      if (preset === "riverfall" || preset === "alps") {
        const file = preset === "alps" ? "lantern-alps.json" : "riverfall-world.json";
        nwStep(`loading ${preset} manifest`);
        try {
          const resp = await fetch(file);
          payload = await resp.json();
          nwStep(`${preset} manifest loaded (${payload.layers.length} layers)`, true);
          payload.seed = /^\d+$/.test(seed) ? parseInt(seed, 10) : Math.floor(Math.random() * 2 ** 48);
        } catch (e) { writeText(`[world] riverfall manifest failed: ${e.message}\n`); return; }
      } else if (preset === "osm") {
        if (window.__osmBusy) { writeText("[osm] a fetch is already running — wait for it\n"); return; }
        window.__osmBusy = true;
        setTimeout(() => { window.__osmBusy = false; }, 120000);
        const lat = parseFloat(document.getElementById("nw-osm-lat").value);
        const lon = parseFloat(document.getElementById("nw-osm-lon").value);
        const radius = Math.min(parseInt(document.getElementById("nw-osm-radius").value, 10) || 250, 1500);
        if (!isFinite(lat) || !isFinite(lon)) { writeText("[osm] bad lat/lon\n"); return; }
        nwStep(`querying OpenStreetMap around ${lat.toFixed(3)}, ${lon.toFixed(3)}`);
        let res;
        try { res = await fetchOsmFootprints(lat, lon, radius); }
        catch (e) {
          nwStep(`OSM failed: ${e.message} — wait a minute and retry`, true);
          writeText(`[osm] ${e.message}\n`); window.__osmBusy = false; return;
        }
        window.__osmBusy = false;
        nwStep(`${res.footprints.length} features converted${res.terrain ? " + terrain" : ""}`, true);
        if (!res.footprints.length) { writeText("[osm] nothing found there\n"); return; }
        payload = { kind: "osm", footprints: res.footprints, base: null };
        if (res.terrain) {
          const { sample, ...t } = res.terrain;
          payload.terrain = t;
        }
      } else if (preset === "cellular") {
        payload = { kind: "cellular", block, minY: -60, maxY: 200,
          program: { type: "sphere", radius: 12 }, cell: 48, seed: Date.now() % 100000, presence: [2, 3] };
      } else {
        const program = preset === "custom" ? parseJson("SDF") : { type: "sphere", radius: 80 };
        if (!program) return;
        payload = { kind: "sdf", block, minY: -100, maxY: 200, program };
      }
      writeText(`[world] streaming ${preset} world from nucleation — no restart\n`);
      nwStep("world command sent — watch the ⚙ badge for chunk progress", true);
      farmWorker.postMessage({ type: "worldchunksrc", payload: JSON.stringify(payload) });
      setTimeout(() => { nwModal.style.display = "none"; nwStep(null); }, 2500);
      return;
    }
    const entry = SDF_PRESETS[preset];
    const payload = {
      block,
      scale: parseFloat(document.getElementById("nw-sdf-scale").value) || 1.0,
      y: entry.y,
      program: entry.program,
    };
    writeText(`[world] generating SDF world (${preset}) — no restart\n`);
    farmWorker.postMessage({ type: "worldsdf", payload: JSON.stringify(payload) });
    nwModal.style.display = "none";
    return;
  }
  if (serverRunning) {
    writeText(`[world] resetting to a fresh "${g}" world${seed ? ` (seed ${seed})` : ""} — no restart\n`);
    farmWorker.postMessage({ type: "worldreset", gen: g, seed });
  } else {
    const next = new URLSearchParams();
    if (params.has("offline")) next.set("offline", params.get("offline") || "1");
    if (g !== "normal") next.set("gen", g);
    next.set("fresh", "1");
    location.href = `${location.pathname}?${next}`;
  }
});
document.getElementById("cfg-wipesave")?.addEventListener("click", async () => {
  if (!confirm("Delete the saved world from this browser (OPFS) and reboot fresh?")) return;
  await wipeOpfsSave();
  const next = new URLSearchParams();
  if (params.has("offline")) next.set("offline", params.get("offline") || "1");
  if (params.has("gen")) next.set("gen", params.get("gen"));
  next.set("fresh", "1");
  location.href = `${location.pathname}?${next}`;
});

// --- player list + right-click actions ---
const plMenu = document.getElementById("pl-menu");
function sendCmd(line) {
  writeText(`> ${line}\n`);
  farmWorker.postMessage({ type: "stdin", line: `${line}\n` });
}
function menuItem(label, fn) {
  const el = document.createElement("div");
  el.textContent = label;
  el.style.cssText = "padding:5px 10px; border-radius:4px; cursor:pointer; color:#e8dcc8;";
  el.addEventListener("mouseenter", () => el.style.background = "#33291d");
  el.addEventListener("mouseleave", () => el.style.background = "none");
  el.addEventListener("click", () => { fn(); hideMenu(); });
  return el;
}
function hideMenu() { plMenu.style.display = "none"; }
document.addEventListener("click", hideMenu);
function showPlayerMenu(ev, name) {
  ev.preventDefault();
  plMenu.innerHTML = "";
  plMenu.append(
    menuItem(`⭐ op ${name}`, () => sendCmd(`op ${name}`)),
    menuItem(`✖ deop ${name}`, () => sendCmd(`deop ${name}`)),
  );
  const gmLabel = document.createElement("div");
  gmLabel.textContent = "gamemode ▸";
  gmLabel.style.cssText = "padding:5px 10px; color:#9a8f7a; font-size:11px; text-transform:uppercase; letter-spacing:.06em;";
  plMenu.append(gmLabel);
  for (const gm of ["creative", "survival", "spectator", "adventure"]) {
    plMenu.append(menuItem(`  ${gm}`, () => sendCmd(`gamemode ${gm} ${name}`)));
  }
  plMenu.append(
    menuItem(`⌂ tp to spawn`, () => sendCmd(`tp ${name} 0 -60 0`)),
    menuItem(`🚪 kick ${name}`, () => sendCmd(`kick ${name}`)),
  );
  plMenu.style.left = `${Math.min(ev.clientX, innerWidth - 180)}px`;
  plMenu.style.top = `${Math.min(ev.clientY, innerHeight - 260)}px`;
  plMenu.style.display = "block";
}
function renderPlayers(list) {
  const box = document.getElementById("player-list");
  const count = document.getElementById("pl-count");
  if (!box) return;
  count.textContent = list.length ? `(${list.length})` : "";
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = '<span class="hint">nobody online — click a player for actions</span>';
    return;
  }
  for (const p of list) {
    const row = document.createElement("div");
    row.className = "player-row";
    row.innerHTML = `<span style="color:#7fb069;">●</span><span>${p.name}</span><span style="color:#9a8f7a; font-size:11px; margin-left:auto;">${(p.gamemode || "").toLowerCase()}</span>`;
    row.addEventListener("contextmenu", (ev) => showPlayerMenu(ev, p.name));
    row.addEventListener("click", (ev) => showPlayerMenu(ev, p.name));
    box.append(row);
  }
}

// --- slippy-map location picker (hand-rolled: CDN map libs are blocked by
// cross-origin isolation; tiles come through the proxy) ---
const mapModal = document.getElementById("map-modal");
const mapCv = document.getElementById("map-canvas");
const mapCtx = mapCv?.getContext("2d");
const tileCache = new Map();
const mapState = { lat: 48.8584, lon: 2.2945, zoom: 13, pick: null };
const apiBase2 = () => location.hostname === "localhost"
  ? "http://localhost:9091"
  : (!location.port || location.port === "443") ? "" : `https://${location.hostname}:9443`;

function lonToX(lon, z) { return (lon + 180) / 360 * 2 ** z; }
function latToY(lat, z) {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
}
function xToLon(x, z) { return x / 2 ** z * 360 - 180; }
function yToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function tileImg(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = drawMap;
  img.onerror = () => {
    tileCache.delete(key);
    setTimeout(drawMap, 1200);
  };
  img.src = `${apiBase2()}/api/osmtile/${z}/${x}/${y}.png`;
  tileCache.set(key, img);
  if (tileCache.size > 300) tileCache.delete(tileCache.keys().next().value);
  return img;
}

function drawMap() {
  if (!mapCtx || mapModal.style.display === "none") return;
  const { lat, lon, zoom } = mapState;
  const W = mapCv.width, H = mapCv.height;
  const cx = lonToX(lon, zoom) * 256, cy = latToY(lat, zoom) * 256;
  mapCtx.fillStyle = "#241f18";
  mapCtx.fillRect(0, 0, W, H);
  const x0 = Math.floor((cx - W / 2) / 256), x1 = Math.floor((cx + W / 2) / 256);
  const y0 = Math.floor((cy - H / 2) / 256), y1 = Math.floor((cy + H / 2) / 256);
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= 2 ** zoom) continue;
      const img = tileImg(zoom, ((tx % 2 ** zoom) + 2 ** zoom) % 2 ** zoom, ty);
      if (img.complete && img.naturalWidth) {
        mapCtx.drawImage(img, Math.round(tx * 256 - cx + W / 2), Math.round(ty * 256 - cy + H / 2));
      }
    }
  }
  if (mapState.pick) {
    const px = lonToX(mapState.pick.lon, zoom) * 256 - cx + W / 2;
    const py = latToY(mapState.pick.lat, zoom) * 256 - cy + H / 2;
    const radius = parseInt(document.getElementById("nw-osm-radius").value, 10) || 250;
    const mPerPx = 156543.03 * Math.cos(mapState.pick.lat * Math.PI / 180) / 2 ** zoom;
    mapCtx.strokeStyle = "#f0a030"; mapCtx.fillStyle = "rgba(240,160,48,.15)";
    mapCtx.lineWidth = 2;
    mapCtx.beginPath();
    mapCtx.arc(px, py, radius / mPerPx, 0, Math.PI * 2);
    mapCtx.fill(); mapCtx.stroke();
    mapCtx.beginPath();
    mapCtx.arc(px, py, 4, 0, Math.PI * 2);
    mapCtx.fillStyle = "#f0a030"; mapCtx.fill();
  }
}

function mapPos(e) {
  const r = mapCv.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (mapCv.width / r.width),
    y: (e.clientY - r.top) * (mapCv.height / r.height),
  };
}
let dragging = null;
mapCv?.addEventListener("pointerdown", (e) => {
  mapCv.setPointerCapture(e.pointerId);
  const p = mapPos(e);
  dragging = { x: p.x, y: p.y, moved: 0 };
});
mapCv?.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const p = mapPos(e);
  const dx = p.x - dragging.x, dy = p.y - dragging.y;
  dragging.moved += Math.abs(dx) + Math.abs(dy);
  mapState.lon = xToLon(lonToX(mapState.lon, mapState.zoom) - dx / 256, mapState.zoom);
  mapState.lat = yToLat(latToY(mapState.lat, mapState.zoom) - dy / 256, mapState.zoom);
  dragging.x = p.x; dragging.y = p.y;
  drawMap();
});
mapCv?.addEventListener("pointerup", (e) => {
  if (dragging && dragging.moved <= 4) {
    const p = mapPos(e);
    const W = mapCv.width, H = mapCv.height, z = mapState.zoom;
    const cx = lonToX(mapState.lon, z) * 256, cy = latToY(mapState.lat, z) * 256;
    const lon = xToLon((cx - W / 2 + p.x) / 256, z);
    const lat = yToLat((cy - H / 2 + p.y) / 256, z);
    mapState.pick = { lat, lon };
    document.getElementById("map-readout").textContent =
      `${lat.toFixed(5)}, ${lon.toFixed(5)} — preview terrain or use location`;
    drawMap();
  }
  dragging = null;
});
mapCv?.addEventListener("pointercancel", () => { dragging = null; });
function mapZoomAt(px, py, dir) {
  const z0 = mapState.zoom;
  const z1 = Math.max(3, Math.min(17, z0 + dir));
  if (z0 === z1) return;
  // Anchor the zoom on the cursor: keep the world point under (px,py) fixed.
  const W = mapCv.width, H = mapCv.height;
  const wx = (lonToX(mapState.lon, z0) * 256 - W / 2 + px) / 256;
  const wy = (latToY(mapState.lat, z0) * 256 - H / 2 + py) / 256;
  const scale = 2 ** (z1 - z0);
  mapState.zoom = z1;
  mapState.lon = xToLon(wx * scale - (px - W / 2) / 256, z1);
  mapState.lat = yToLat(wy * scale - (py - H / 2) / 256, z1);
  drawMap();
}
mapCv?.addEventListener("wheel", (e) => {
  e.preventDefault();
  const p = mapPos(e);
  mapZoomAt(p.x, p.y, e.deltaY < 0 ? 1 : -1);
}, { passive: false });
document.getElementById("map-zin")?.addEventListener("click", () => mapZoomAt(mapCv.width / 2, mapCv.height / 2, 1));
document.getElementById("map-zout")?.addEventListener("click", () => mapZoomAt(mapCv.width / 2, mapCv.height / 2, -1));
document.getElementById("nw-osm-map")?.addEventListener("click", () => {
  mapState.lat = parseFloat(document.getElementById("nw-osm-lat").value) || 48.8584;
  mapState.lon = parseFloat(document.getElementById("nw-osm-lon").value) || 2.2945;
  mapState.pick = { lat: mapState.lat, lon: mapState.lon };
  mapModal.style.display = "flex";
  // Retina-crisp: match the backing store to the CSS size once visible.
  requestAnimationFrame(() => {
    const r = mapCv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (r.width && Math.abs(mapCv.width - r.width * dpr) > 2) {
      mapCv.width = Math.round(r.width * dpr);
      mapCv.height = Math.round(r.height * dpr);
    }
    document.getElementById("map-readout").textContent =
      `${mapState.lat.toFixed(5)}, ${mapState.lon.toFixed(5)} — click to move the marker`;
    drawMap();
  });
});
document.getElementById("map-cancel")?.addEventListener("click", () => mapModal.style.display = "none");
document.getElementById("map-use")?.addEventListener("click", () => {
  if (mapState.pick) {
    document.getElementById("nw-osm-lat").value = mapState.pick.lat.toFixed(5);
    document.getElementById("nw-osm-lon").value = mapState.pick.lon.toFixed(5);
  }
  mapModal.style.display = "none";
});
document.getElementById("map-preview")?.addEventListener("click", async () => {
  if (!mapState.pick) { document.getElementById("map-readout").textContent = "click the map first"; return; }
  const radius = Math.min(parseInt(document.getElementById("nw-osm-radius").value, 10) || 250, 1500);
  const relief = document.getElementById("map-relief");
  const g = relief.getContext("2d");
  relief.style.display = "block";
  g.fillStyle = "#241f18"; g.fillRect(0, 0, relief.width, relief.height);
  g.fillStyle = "#9a8f7a"; g.fillText("fetching elevation…", 10, 20);
  try {
    const t = await fetchTerrainGrid(mapState.pick.lat, mapState.pick.lon, radius, apiBase2());
    if (!t) throw new Error("no elevation data");
    const { heights, width } = t;
    const depth = heights.length / width;
    let lo = Infinity, hi = -Infinity;
    for (const h of heights) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
    const span = Math.max(1, hi - lo);
    const img = g.createImageData(width, depth);
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        const h = heights[z * width + x];
        const hr = heights[z * width + Math.min(width - 1, x + 1)];
        const shade = Math.max(-24, Math.min(24, (h - hr) * 4));
        const v = (h - lo) / span;
        const i = (z * width + x) * 4;
        img.data[i] = 60 + v * 150 + shade;
        img.data[i + 1] = 90 + v * 120 + shade;
        img.data[i + 2] = 55 + v * 90 + shade;
        img.data[i + 3] = 255;
      }
    }
    const off = new OffscreenCanvas(width, depth);
    off.getContext("2d").putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.fillStyle = "#241f18"; g.fillRect(0, 0, relief.width, relief.height);
    const s = Math.min(relief.width / width, relief.height / depth);
    g.drawImage(off, (relief.width - width * s) / 2, 0, width * s, depth * s);
    g.fillStyle = "#e8dcc8";
    g.fillText(`relief ${(hi - lo)}m over ${radius * 2}m — this becomes your terrain (1 block = 1 m)`, 10, relief.height - 8);
  } catch (e) {
    g.fillStyle = "#e0a458"; g.fillText(`terrain preview failed: ${e.message}`, 10, 40);
  }
});

document.getElementById("schem-riverfall")?.addEventListener("click", async () => {
  writeText("[schem] loading the riverfall cabin scene (468k blocks)…\n");
  const bytes = await fetchSchematicBytes("riverfall-cabin.litematic");
  if (bytes) farmWorker.postMessage({ type: "schem", bytes: bytes.buffer }, [bytes.buffer]);
});

// --- live view distance ---
const vdSlider = document.getElementById("cfg-viewdist");
const vdLabel = document.getElementById("cfg-viewdist-label");
if (vdSlider) {
  const saved = localStorage.getItem("lantern-viewdist");
  if (saved) { vdSlider.value = saved; vdLabel.textContent = saved; }
  vdSlider.addEventListener("input", () => { vdLabel.textContent = vdSlider.value; });
  vdSlider.addEventListener("change", () => {
    localStorage.setItem("lantern-viewdist", vdSlider.value);
    farmWorker.postMessage({ type: "viewdist", n: parseInt(vdSlider.value, 10) });
    writeText(`[cfg] view distance → ${vdSlider.value} (move a chunk to stream more; client setting must allow it)\n`);
  });
}

// --- earth streamer: page-side region fetcher (docs/earth-streamer.md) ---
const earth = { origin: null, originElev: 0, inflight: new Set(), lastOverpass: 0 };

async function earthElevAt(lat, lon) {
  const t = await fetchTerrainGrid(lat, lon, 40, apiBase2());
  if (!t) return 0;
  // fetchTerrainGrid normalizes; grab raw center by re-deriving: use midpoint height + its own baseline
  return t.baseline ?? 0;
}

async function startEarthWorld(lat, lon) {
  nwStep("anchoring earth world");
  earth.origin = { lat, lon };
  earth.inflight.clear();
  // Raw elevation at origin becomes the global y-datum (origin ground ≈ y 40).
  const probe = await fetchTerrainGridRaw(lat, lon, 60, apiBase2());
  earth.originElev = probe ? probe.center : 0;
  nwStep(`origin elevation ${earth.originElev.toFixed(0)}m — anchored`, true);
  farmWorker.postMessage({ type: "worldearth", payload: JSON.stringify({ lat, lon }) });
}

// Region worker: metrics tells us which 512-block regions the server wants.
async function earthFetchRegion(rx, rz) {
  const key = `${rx},${rz}`;
  if (earth.inflight.has(key) || !earth.origin) return;
  earth.inflight.add(key);
  const { lat, lon } = earth.origin;
  const mLat = 111320, mLon = 111320 * Math.cos(lat * Math.PI / 180);
  const cxm = rx * 512 + 256, czm = rz * 512 + 256; // region center in blocks(≈m)
  const cLat = lat - czm / mLat, cLon = lon + cxm / mLon;
  try {
    writeText(`[earth] fetching region ${key} (${cLat.toFixed(4)}, ${cLon.toFixed(4)})…\n`);
    const t = await fetchTerrainGridRaw(cLat, cLon, 384, apiBase2());
    if (!t) throw new Error("no elevation");
    const heights = t.heights.map((e) => Math.max(1, Math.round(e - earth.originElev) + 40));
    // Overpass: gentle — one at a time, 8s spacing.
    const wait = Math.max(0, earth.lastOverpass + 8000 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    earth.lastOverpass = Date.now();
    let feats = [];
    try {
      const res = await fetchOsmFootprintsAt(cLat, cLon, 384, { ox: rx * 512 + 256, oz: rz * 512 + 256, ground: (x, z) => {
        const gx = Math.min(t.width - 1, Math.max(0, Math.round((x - rx * 512) / t.step)));
        const gz = Math.min(t.width - 1, Math.max(0, Math.round((z - rz * 512) / t.step)));
        return Math.max(1, Math.round(t.heights[gz * t.width + gx] - earth.originElev) + 40);
      }});
      feats = res;
    } catch (e) { writeText(`[earth] region ${key}: no OSM this pass (${e.message})\n`); }
    farmWorker.postMessage({ type: "worldregion", payload: JSON.stringify({
      rx, rz, heights, width: t.width, step: t.step, waterY: 38, footprints: feats,
    })});
    writeText(`[earth] region ${key} delivered (${feats.length} features)\n`);
  } catch (e) {
    writeText(`[earth] region ${key} failed: ${e.message} — will retry\n`);
    setTimeout(() => earth.inflight.delete(key), 20000);
    return;
  }
  earth.inflight.delete(key);
}

// Raw (meters, un-normalized) terrain grid — shared by earth regions so all
// regions use one global datum and seam together.
async function fetchTerrainGridRaw(lat, lon, radius, base) {
  const t = await fetchTerrainGridMeters(lat, lon, radius, base);
  return t;
}
async function fetchTerrainGridMeters(lat, lon, radius, base) {
  const Z = 14, n = 2 ** Z;
  const latRad = lat * Math.PI / 180;
  const tx = (lon + 180) / 360 * n;
  const ty = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  const metersPerTile = 40075016.7 * Math.cos(latRad) / n;
  const span = Math.ceil(radius / metersPerTile);
  const tiles = new Map();
  const loads = [];
  for (let dx = -span; dx <= span; dx++) for (let dy = -span; dy <= span; dy++) {
    const X = Math.floor(tx) + dx, Y = Math.floor(ty) + dy;
    loads.push((async () => {
      const img = new Image(); img.crossOrigin = "anonymous";
      const done = new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error("tile"));
        setTimeout(() => rej(new Error("tile timeout")), 20000);
      });
      img.src = `${base}/api/terrain/elevation-tiles-prod/terrarium/${Z}/${X}/${Y}.png`;
      await done;
      const c = document.createElement("canvas"); c.width = c.height = 256;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      tiles.set(`${X},${Y}`, g.getImageData(0, 0, 256, 256).data);
    })().catch(() => {}));
  }
  await Promise.all(loads);
  const elevAt = (la, lo) => {
    const fx = (lo + 180) / 360 * n;
    const laR = la * Math.PI / 180;
    const fy = (1 - Math.log(Math.tan(laR) + 1 / Math.cos(laR)) / Math.PI) / 2 * n;
    const X = Math.floor(fx), Y = Math.floor(fy);
    const d = tiles.get(`${X},${Y}`);
    if (!d) return null;
    const px = Math.min(255, Math.floor((fx - X) * 256));
    const py = Math.min(255, Math.floor((fy - Y) * 256));
    const i = (py * 256 + px) * 4;
    return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
  };
  const mLat = 111320, mLon = 111320 * Math.cos(latRad);
  const step = 2, half = Math.ceil(radius / step), width = half * 2 + 1;
  const heights = new Array(width * width).fill(0);
  for (let gz = 0; gz < width; gz++) for (let gx = 0; gx < width; gx++) {
    const e = elevAt(lat - (gz - half) * step / mLat, lon + (gx - half) * step / mLon);
    heights[gz * width + gx] = e === null ? 0 : e;
  }
  return { heights, width, step, center: elevAt(lat, lon) ?? 0 };
}

// OSM features for an earth region: polygons in WORLD blocks (origin datum),
// buildings seated via the caller's ground(x,z).
async function fetchOsmFootprintsAt(cLat, cLon, radius, opts) {
  const base = apiBase2();
  const o = earth.origin;
  const mLat = 111320, mLon = 111320 * Math.cos(o.lat * Math.PI / 180);
  const q = `[out:json][timeout:25];(way["building"](around:${radius},${cLat},${cLon});way["highway"](around:${radius},${cLat},${cLon}););out geom;`;
  let data = null, lastErr = null;
  for (const route of ["/api/overpass", "/api/overpass-alt"]) {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 40000);
      const r = await fetch(`${base}${route}/api/interpreter?data=${encodeURIComponent(q)}`, { signal: ctl.signal });
      clearTimeout(tm);
      if (!r.ok) { lastErr = new Error(`HTTP ${r.status}`); continue; }
      data = await r.json(); break;
    } catch (e) { lastErr = e; }
  }
  if (!data) throw lastErr || new Error("overpass failed");
  const B = { church: "minecraft:stone_bricks", industrial: "minecraft:gray_concrete",
    retail: "minecraft:white_concrete", apartments: "minecraft:bricks", house: "minecraft:oak_planks" };
  const proj = (pt) => [(pt.lon - o.lon) * mLon, -((pt.lat - o.lat) * mLat)];
  const out = [];
  for (const el of data.elements || []) {
    if (el.type !== "way" || !el.geometry) continue;
    const tags = el.tags || {};
    if (tags.building && el.geometry.length >= 4) {
      const polygon = el.geometry.map(proj);
      let cx = 0, cz = 0;
      for (const [px, pz] of polygon) { cx += px; cz += pz; }
      cx /= polygon.length; cz /= polygon.length;
      const ground = opts.ground(cx, cz);
      let h = parseFloat(tags.height) || (parseInt(tags["building:levels"], 10) || 0) * 3 || 8;
      out.push({ polygon, height: ground + Math.min(Math.round(h), 250), min_y: ground,
                 block: B[tags.building] || "minecraft:bricks" });
    } else if (tags.highway && el.geometry.length >= 2) {
      const style = ROAD_STYLE[tags.highway];
      if (!style) continue;
      const [w, block] = style;
      const pts = el.geometry.map(proj);
      for (let i = 0; i + 1 < pts.length; i++) {
        const [x1, z1] = pts[i], [x2, z2] = pts[i + 1];
        const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz);
        if (len < 0.5) continue;
        const nx = (-dz / len) * (w / 2), nz = (dx / len) * (w / 2);
        const y = opts.ground((x1 + x2) / 2, (z1 + z2) / 2);
        out.push({ polygon: [[x1 + nx, z1 + nz], [x2 + nx, z2 + nz], [x2 - nx, z2 - nz], [x1 - nx, z1 - nz]],
                   height: y, min_y: y, block });
      }
    }
  }
  return out;
}
