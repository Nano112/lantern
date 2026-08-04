// lantern farm worker: hosts the WASI farm (fs + stdio + net bridge) and the
// proxy WebSocket OFF the main thread, so page rendering and background-tab
// throttling never stall server I/O. The page talks to us via postMessage.
import { Directory, Fd, File, Inode, PreopenDirectory, wasi } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";

const post = (msg) => self.postMessage(msg);
const writeText = (text) => post({ type: "term", text });

class TerminalOut extends Fd {
  fd_write(data) {
    writeText(new TextDecoder().decode(data));
    return { ret: 0, nwritten: data.byteLength };
  }
}

// Polled mailbox stdin: empty reads mean "no input yet" (the wasm side sleeps
// and retries instead of treating 0 bytes as EOF).
class QueueStdin extends Fd {
  buf = new Uint8Array(0);
  push(text) {
    const bytes = new TextEncoder().encode(text);
    const merged = new Uint8Array(this.buf.length + bytes.length);
    merged.set(this.buf);
    merged.set(bytes, this.buf.length);
    this.buf = merged;
  }
  fd_read(len) {
    const n = Math.min(len, this.buf.length);
    const data = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return { ret: 0, data };
  }
}

// Net bridge fd: mirrors the proxy WebSocket into the wasm server.
// Frames use Aero's WS protocol ([1B type][4B sid BE][payload]); across the fd
// they get a u32 BE length prefix since fds are byte streams.
class NetBridgeFd extends Fd {
  rx = new Uint8Array(0);      // frames (length-prefixed) waiting for wasm
  txbuf = new Uint8Array(0);   // byte stream from wasm, parsed into ws sends
  ws = null;

  fd_fdstat_get() {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_READ) | BigInt(wasi.RIGHTS_FD_WRITE);
    return { ret: 0, fdstat };
  }

  fd_filestat_get() {
    return { ret: 0, filestat: new wasi.Filestat(0n, wasi.FILETYPE_CHARACTER_DEVICE, 0n) };
  }

  fd_read(len) {
    const n = Math.min(len, this.rx.length);
    const data = this.rx.slice(0, n);
    this.rx = this.rx.slice(n);
    return { ret: 0, data };
  }

  fd_write(data) {
    const merged = new Uint8Array(this.txbuf.length + data.length);
    merged.set(this.txbuf);
    merged.set(data, this.txbuf.length);
    this.txbuf = merged;
    while (this.txbuf.length >= 4) {
      const flen = new DataView(this.txbuf.buffer, this.txbuf.byteOffset).getUint32(0);
      if (this.txbuf.length < 4 + flen) break;
      const frame = this.txbuf.slice(4, 4 + flen);
      this.txbuf = this.txbuf.slice(4 + flen);
      this.bytesOut += frame.length;
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
    }
    return { ret: 0, nwritten: data.byteLength };
  }

  bytesIn = 0;
  bytesOut = 0;

  pushFrame(frameBytes) {
    this.bytesIn += frameBytes.length;
    const prefixed = new Uint8Array(4 + frameBytes.length);
    new DataView(prefixed.buffer).setUint32(0, frameBytes.length);
    prefixed.set(frameBytes, 4);
    const merged = new Uint8Array(this.rx.length + prefixed.length);
    merged.set(this.rx);
    merged.set(prefixed, this.rx.length);
    this.rx = merged;
  }
}

function wsFrame(type, sid, payloadBytes) {
  const f = new Uint8Array(5 + payloadBytes.length);
  f[0] = type;
  new DataView(f.buffer).setUint32(1, sid);
  f.set(payloadBytes, 5);
  return f;
}

const netFd = new NetBridgeFd();

// Mounted at ./net.sock — a preopen must be a directory (wasi-libc aborts with
// EX_OSERR otherwise), so the bridge lives inside the cwd as an openable inode.
class NetSockInode extends Inode {
  constructor(fdObj) {
    super();
    this.fdObj = fdObj;
  }
  stat() {
    return new wasi.Filestat(this.ino, wasi.FILETYPE_CHARACTER_DEVICE, 0n);
  }
  path_open() {
    return { ret: 0, fd_obj: this.fdObj };
  }
}

// HTTP bridge: the wasm side writes "[u32 len][u32 req_id][METHOD url]" frames;
// we fetch via the lantern proxy's CORS'd Mojang endpoints and answer with
// "[u32 len][u32 req_id][u16 status][body]".
const HTTP_HOST_MAP = {
  "sessionserver.mojang.com": "/api/mojang",
  "api.minecraftservices.com": "/api/mojang-services",
  "api.mojang.com": "/api/mojang-api",
};

function apiBase() {
  // Mirror connectProxy: localhost dev → direct proxy port; sidecar pages
  // (default https port) → same-origin /api/ (tailscale serve maps it);
  // legacy <host>:<port> pages → the host tailscale's :9443.
  const h = self.location.hostname;
  const port = self.location.port;
  if (h === "localhost") return "http://localhost:9091";
  return (!port || port === "443") ? `https://${h}` : `https://${h}:9443`;
}


// Transient-failure tolerant fetch for the HTTP bridge: a proxy/sidecar
// restart or upstream flake must not fail a Mojang auth call outright.
async function fetchWithRetry(url, opts) {
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await fetch(url, opts);
      if ((resp.status === 502 || resp.status === 503 || resp.status === 504) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      return resp;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

class HttpBridgeFd extends Fd {
  rx = new Uint8Array(0);
  txbuf = new Uint8Array(0);

  fd_fdstat_get() {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_READ) | BigInt(wasi.RIGHTS_FD_WRITE);
    return { ret: 0, fdstat };
  }

  fd_filestat_get() {
    return { ret: 0, filestat: new wasi.Filestat(0n, wasi.FILETYPE_CHARACTER_DEVICE, 0n) };
  }

  fd_read(len) {
    const n = Math.min(len, this.rx.length);
    const data = this.rx.slice(0, n);
    this.rx = this.rx.slice(n);
    return { ret: 0, data };
  }

  fd_write(data) {
    const merged = new Uint8Array(this.txbuf.length + data.length);
    merged.set(this.txbuf);
    merged.set(data, this.txbuf.length);
    this.txbuf = merged;
    while (this.txbuf.length >= 4) {
      const flen = new DataView(this.txbuf.buffer, this.txbuf.byteOffset).getUint32(0);
      if (this.txbuf.length < 4 + flen) break;
      const frame = this.txbuf.slice(4, 4 + flen);
      this.txbuf = this.txbuf.slice(4 + flen);
      this.handleRequest(frame);
    }
    return { ret: 0, nwritten: data.byteLength };
  }

  async handleRequest(frame) {
    const reqId = new DataView(frame.buffer, frame.byteOffset).getUint32(0);
    let status = 502;
    let body = new Uint8Array(0);
    try {
      const [method, url] = new TextDecoder().decode(frame.slice(4)).split(" ", 2);
      const u = new URL(url);
      const prefix = HTTP_HOST_MAP[u.hostname];
      if (prefix) {
        const path = u.pathname.replace(/\/{2,}/g, "/");
        const target = `${apiBase()}${prefix}${path}${u.search}`;
        const resp = await fetchWithRetry(target, { method });
        status = resp.status;
        body = new Uint8Array(await resp.arrayBuffer());
      } else {
        console.warn("http bridge: host not allowlisted:", u.hostname);
      }
    } catch (e) {
      console.warn("http bridge: request failed:", e);
    }
    const out = new Uint8Array(4 + 4 + 2 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 6 + body.length);
    dv.setUint32(4, reqId);
    dv.setUint16(8, status);
    out.set(body, 10);
    const merged = new Uint8Array(this.rx.length + out.length);
    merged.set(this.rx);
    merged.set(out, this.rx.length);
    this.rx = merged;
  }
}

const httpFd = new HttpBridgeFd();

// One-way telemetry from the server: newline-delimited JSON.
class MetricsFd extends Fd {
  linebuf = "";

  fd_fdstat_get() {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_READ) | BigInt(wasi.RIGHTS_FD_WRITE);
    return { ret: 0, fdstat };
  }

  fd_filestat_get() {
    return { ret: 0, filestat: new wasi.Filestat(0n, wasi.FILETYPE_CHARACTER_DEVICE, 0n) };
  }

  fd_read(_len) {
    return { ret: 0, data: new Uint8Array(0) };
  }

  fd_write(data) {
    this.linebuf += new TextDecoder().decode(data);
    const lines = this.linebuf.split("\n");
    this.linebuf = lines.pop();
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        m.net_in = netFd.bytesIn;
        m.net_out = netFd.bytesOut;
        m.now = Date.now();
        post({ type: "metrics", data: m });
      } catch { /* partial or malformed line */ }
    }
    return { ret: 0, nwritten: data.byteLength };
  }
}

const metricsFd = new MetricsFd();

// Live schematic push: page → wasm, framed [u32 len][bytes].
class SchemFd extends Fd {
  rx = new Uint8Array(0);

  fd_fdstat_get() {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_READ) | BigInt(wasi.RIGHTS_FD_WRITE);
    return { ret: 0, fdstat };
  }

  fd_filestat_get() {
    return { ret: 0, filestat: new wasi.Filestat(0n, wasi.FILETYPE_CHARACTER_DEVICE, 0n) };
  }

  fd_read(len) {
    const n = Math.min(len, this.rx.length);
    const data = this.rx.slice(0, n);
    this.rx = this.rx.slice(n);
    return { ret: 0, data };
  }

  fd_write(data) {
    return { ret: 0, nwritten: data.byteLength };
  }

  push(bytes) {
    const framed = new Uint8Array(4 + bytes.length);
    new DataView(framed.buffer).setUint32(0, bytes.length);
    framed.set(bytes, 4);
    const merged = new Uint8Array(this.rx.length + framed.length);
    merged.set(this.rx);
    merged.set(framed, this.rx.length);
    this.rx = merged;
  }
}

const schemFd = new SchemFd();
const simFd = new SchemFd();

// state.bin: reads serve the OPFS snapshot loaded at boot; writes buffer the
// new snapshot and flush it to OPFS on close.
class PersistFd extends Fd {
  constructor(initial, onSave) {
    super();
    this.data = initial; // Uint8Array
    this.pos = 0;
    this.writeBuf = null;
    this.onSave = onSave;
  }

  fd_fdstat_get() {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_REGULAR_FILE, 0);
    fdstat.fs_rights_base =
      BigInt(wasi.RIGHTS_FD_READ) | BigInt(wasi.RIGHTS_FD_WRITE) | BigInt(wasi.RIGHTS_FD_SEEK);
    return { ret: 0, fdstat };
  }

  fd_filestat_get() {
    return {
      ret: 0,
      filestat: new wasi.Filestat(0n, wasi.FILETYPE_REGULAR_FILE, BigInt(this.data.length)),
    };
  }

  fd_read(len) {
    const n = Math.min(len, this.data.length - this.pos);
    if (n <= 0) return { ret: 0, data: new Uint8Array(0) };
    const out = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return { ret: 0, data: out };
  }

  fd_write(chunk) {
    if (!this.writeBuf) this.writeBuf = [];
    this.writeBuf.push(chunk.slice());
    return { ret: 0, nwritten: chunk.byteLength };
  }

  fd_seek(offset, whence) {
    const size = BigInt(this.data.length);
    let target = whence === wasi.WHENCE_SET ? offset
      : whence === wasi.WHENCE_CUR ? BigInt(this.pos) + offset
      : size + offset;
    if (target < 0n) return { ret: wasi.ERRNO_INVAL, offset: 0n };
    this.pos = Number(target);
    return { ret: 0, offset: target };
  }

  fd_close() {
    if (this.writeBuf) {
      let total = 0;
      for (const c of this.writeBuf) total += c.length;
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of this.writeBuf) { merged.set(c, off); off += c.length; }
      this.writeBuf = null;
      this.data = merged; // subsequent reads see the newest snapshot
      this.onSave(merged);
    }
    this.pos = 0;
    return 0;
  }
}

class PersistInode extends Inode {
  constructor(fdObj) {
    super();
    this.fdObj = fdObj;
  }
  stat() {
    return new wasi.Filestat(this.ino, wasi.FILETYPE_REGULAR_FILE, BigInt(this.fdObj.data.length));
  }
  path_open(oflags) {
    if ((oflags & wasi.OFLAGS_TRUNC) === wasi.OFLAGS_TRUNC) this.fdObj.writeBuf = [];
    this.fdObj.pos = 0;
    return { ret: 0, fd_obj: this.fdObj };
  }
}

let claimedDefaultOnce = false;
// A crashed/exited server must not keep (re)claiming a room: a dead session
// squatting "default" is exactly the stale-tab problem takeover exists for.
let serverDead = false;

function connectProxy() {
  // localhost dev → direct port; lantern sidecar (default https port) →
  // same-origin /ws; legacy mac-mini:<port> pages → ts.net :9443.
  const h = self.location.hostname;
  const port = self.location.port;
  const url = h === "localhost"
    ? "ws://localhost:9091/ws"
    : (!port || port === "443")
      ? `wss://${h}/ws`
      : `wss://${h}:9443/ws`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  netFd.ws = ws;
  ws.onopen = () => {
    // Newest-wins: the first registration of a page load evicts whoever holds
    // "default" (stale tabs). Reconnects/retries never steal it back.
    const reg = new TextEncoder().encode(JSON.stringify({
      room: "default",
      motd: "lantern — Pumpkin in your browser",
      takeover: !claimedDefaultOnce,
    }));
    ws.send(wsFrame(0, 0, reg)); // registration on control stream 0
    post({ type: "status", status: "server running — proxy connected" });
  };
  ws.onmessage = (ev) => {
    const f = new Uint8Array(ev.data);
    const sid = new DataView(f.buffer, f.byteOffset).getUint32(1);
    if (sid === 0) {
      try {
        const resp = JSON.parse(new TextDecoder().decode(f.slice(5)));
        if (resp.room) claimedDefaultOnce = true;
        if (resp.room) post({ type: "room", room: resp.room });
        writeText(`[proxy] room "${resp.room ?? "?"}" registered\n`);
        // Suffixed room = someone (likely a stale session) holds "default",
        // which is the only room reachable over plain DNS. Keep retrying —
        // the proxy's keepalive frees dead sessions within a minute.
        if (resp.room && resp.room !== "default") {
          writeText(`[proxy] "default" is taken (stale session?) — retrying in 15s\n`);
          setTimeout(() => ws.close(), 15000);
        }
      } catch { /* non-JSON control noise */ }
      return;
    }
    netFd.pushFrame(f);
  };
  ws.onclose = () => {
    if (serverDead) {
      post({ type: "status", status: "server down — not re-registering the room" });
      return;
    }
    post({ type: "status", status: "proxy disconnected (retrying in 5s)" });
    setTimeout(connectProxy, 5000);
  };
  ws.onerror = () => ws.close();
}
connectProxy();

const stdin = new QueueStdin();

const WORLD_FILE = "lantern-world.bin";
let opfsWriteChain = Promise.resolve();
function saveToOpfs(bytes) {
  opfsWriteChain = opfsWriteChain.then(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(WORLD_FILE, { create: true });
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
    post({ type: "term", text: `[persist] world saved to OPFS (${(bytes.length / 1024).toFixed(0)} KiB)\n` });
  }).catch((e) => post({ type: "term", text: `[persist] OPFS save failed: ${e}\n` }));
}

async function loadFromOpfs(fresh) {
  try {
    const root = await navigator.storage.getDirectory();
    if (fresh) {
      await root.removeEntry(WORLD_FILE).catch(() => {});
      return new Uint8Array(0);
    }
    const handle = await root.getFileHandle(WORLD_FILE);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return new Uint8Array(0);
  }
}

// ── World-zip import ────────────────────────────────────────────────────────
// A dropped world zip is stashed in OPFS by the page, which reloads with
// ?world=1; we read it here at boot, inflate it (browser-native
// DecompressionStream, no zip library), and mount the world directory into
// the WASI fs so Pumpkin's anvil reader loads its chunks lazily.

const WORLD_ZIP_FILE = "import-world.zip";
const worldSwapFd = new SchemFd();

// Pumpkin's supported world DataVersion window (pumpkin-world/src/world_info):
// 4435 (MC 1.21.9) … 4903 (MC 26.2). Anything older needs a pass through a
// current Minecraft to upgrade — refuse it with a message, don't panic wasm.
const MIN_WORLD_DATA_VERSION = 4435;
const MAX_WORLD_DATA_VERSION = 4903;

async function levelDatDataVersion(bytes) {
  // level.dat is gzipped NBT; scan the inflated bytes for the TAG_Int
  // "DataVersion" (0x03, u16 name length 11, name, i32 BE value).
  const raw = new Uint8Array(await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).arrayBuffer());
  const name = new TextEncoder().encode("DataVersion");
  outer: for (let i = 0; i + 18 <= raw.length; i++) {
    if (raw[i] !== 0x03 || raw[i + 1] !== 0 || raw[i + 2] !== 11) continue;
    for (let j = 0; j < 11; j++) if (raw[i + 3 + j] !== name[j]) continue outer;
    return new DataView(raw.buffer, raw.byteOffset + i + 14).getInt32(0);
  }
  return null;
}

async function checkWorldVersion(entries) {
  const ld = entries.filter((e) => e.name === "level.dat" || e.name.endsWith("/level.dat"))
    .reduce((a, b) => (!a || b.name.length < a.name.length ? b : a), null);
  if (!ld) throw new Error("no level.dat in the zip — is this a world save?");
  const dv = await levelDatDataVersion(ld.data);
  if (dv !== null && (dv < MIN_WORLD_DATA_VERSION || dv > MAX_WORLD_DATA_VERSION)) {
    throw new Error(
      `world is DataVersion ${dv} — Pumpkin supports ${MIN_WORLD_DATA_VERSION}–${MAX_WORLD_DATA_VERSION} `
      + `(MC 1.21.9 – 26.2). Open it once in a current Minecraft to upgrade it, then re-zip.`,
    );
  }
  return dv;
}

async function takeWorldZipFromOpfs() {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(WORLD_ZIP_FILE);
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    await root.removeEntry(WORLD_ZIP_FILE).catch(() => {});
    return bytes;
  } catch {
    return null;
  }
}

async function unzipAll(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || off === 0xffffffff) throw new Error("zip64 archives not supported");
  const td = new TextDecoder();
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = td.decode(u8.subarray(off + 46, off + 46 + nameLen));
    if (csize === 0xffffffff || lho === 0xffffffff) throw new Error("zip64 archives not supported");
    if (!name.endsWith("/")) {
      const lnl = dv.getUint16(lho + 26, true), lel = dv.getUint16(lho + 28, true);
      const dataStart = lho + 30 + lnl + lel;
      entries.push({ name, method, data: u8.subarray(dataStart, dataStart + csize) });
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  for (const e of entries) {
    if (e.method === 8) {
      e.data = new Uint8Array(await new Response(
        new Blob([e.data]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
      ).arrayBuffer());
    } else if (e.method !== 0) {
      throw new Error(`unsupported zip compression method ${e.method} in ${e.name}`);
    }
  }
  return entries;
}

// Everything the server won't use and would only bloat memory/state.bin.
const WORLD_SKIP = /(^|\/)(__MACOSX\/|\.DS_Store$|session\.lock$|DIM1\/|DIM-1\/)/;

function buildWorldDir(entries) {
  const cands = entries.filter((e) => e.name === "level.dat" || e.name.endsWith("/level.dat"));
  if (!cands.length) throw new Error("no level.dat in the zip — is this a world save?");
  const prefix = cands.reduce((a, b) => (a.name.length <= b.name.length ? a : b))
    .name.slice(0, -"level.dat".length);
  const root = new Directory(new Map());
  let files = 0, bytes = 0;
  for (const e of entries) {
    if (!e.name.startsWith(prefix)) continue;
    const rel = e.name.slice(prefix.length);
    if (!rel || WORLD_SKIP.test(rel)) continue;
    const parts = rel.split("/").filter(Boolean);
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let child = dir.contents.get(part);
      if (!(child instanceof Directory)) {
        child = new Directory(new Map());
        child.parent = dir;
        dir.contents.set(part, child);
      }
      dir = child;
    }
    dir.contents.set(parts.at(-1), new File(e.data));
    files += 1; bytes += e.data.length;
  }
  return { root, files, bytes };
}

let runner = null;
let started = false;
let cwdRootDir = null;
const pendingStdin = [];

// Live world swap: replace ./world's contents in place, then tell the server
// to purge its chunk cache and re-send chunks — no reboot, no kick.
async function liveWorldSwap(zipBytes) {
  const u8 = new Uint8Array(zipBytes);
  const entries = await unzipAll(u8);
  let dv = null;
  try {
    dv = await checkWorldVersion(entries);
  } catch (e) {
    if (!/DataVersion/.test(String(e))) throw e;
    // Old world: nucleation's DataConverter (in the server binary) upgrades
    // it — send the raw zip over world.sock as a convert command.
    post({ type: "term", text: `[world] old-version world — upgrading with nucleation's DataConverter…\n` });
    const cmd = new TextEncoder().encode("convert:");
    const framed = new Uint8Array(cmd.length + u8.length);
    framed.set(cmd); framed.set(u8, cmd.length);
    worldSwapFd.push(framed);
    return;
  }
  const { root, files, bytes } = buildWorldDir(entries);
  let dir = cwdRootDir.contents.get("world");
  if (dir instanceof Directory) {
    dir.contents.clear();
    for (const [k, v] of root.contents) {
      if (v instanceof Directory) v.parent = dir;
      dir.contents.set(k, v);
    }
  } else {
    root.parent = cwdRootDir;
    cwdRootDir.contents.set("world", root);
  }
  post({ type: "term", text: `[world] swapped in ${files} files (${(bytes / 1024 / 1024).toFixed(1)} MiB) — reloading chunks live\n` });
  worldSwapFd.push(new TextEncoder().encode("swap"));
}

self.onmessage = (e) => {
  if (e.data.type === "worldreset") {
    worldSwapFd.push(new TextEncoder().encode(`reset ${e.data.gen || "normal"}`));
  } else if (e.data.type === "worldswap") {
    liveWorldSwap(e.data.bytes).catch((err) =>
      post({ type: "term", text: `[world] swap failed: ${err.message ?? err}\n` }));
  } else if (e.data.type === "sim") {
    simFd.push(new TextEncoder().encode(e.data.cmd));
  } else if (e.data.type === "schem") {
    let payload = new Uint8Array(e.data.bytes);
    if (e.data.at) {
      const hdr = new TextEncoder().encode(JSON.stringify(e.data.at));
      const framed = new Uint8Array(6 + hdr.length + payload.length);
      framed.set([0x4c, 0x53, 0x48, 0x31, hdr.length >> 8, hdr.length & 0xff]); // "LSH1" + u16 len
      framed.set(hdr, 6);
      framed.set(payload, 6 + hdr.length);
      payload = framed;
    }
    schemFd.push(payload);
    post({ type: "term", text: `[schem] pushed ${(e.data.bytes.byteLength / 1024).toFixed(1)} KiB to the running server\n` });
  } else if (e.data.type === "stdin") {
    if (runner) stdin.push(e.data.line);
    else pendingStdin.push(e.data.line);
  } else if (e.data.type === "init" && !started) {
    started = true;
    boot(e.data).catch((err) => post({ type: "error", error: String(err) }));
  }
};

async function boot({ env, fresh, schem, world }) {
  const snapshot = await loadFromOpfs(fresh);
  if (snapshot.length) {
    post({ type: "term", text: `[persist] loaded ${(snapshot.length / 1024).toFixed(0)} KiB world from OPFS\n` });
  }
  const persistFd = new PersistFd(snapshot, saveToOpfs);

  const cwdEntries = new Map([
    ["net.sock", new NetSockInode(netFd)],
    ["http.sock", new NetSockInode(httpFd)],
    ["metrics.sock", new NetSockInode(metricsFd)],
    ["state.bin", new PersistInode(persistFd)],
  ]);
  if (schem?.length) cwdEntries.set("import.schem", new File(schem));
  if (world) {
    try {
      const zip = await takeWorldZipFromOpfs();
      if (!zip) throw new Error("no staged world zip found in OPFS");
      post({ type: "term", text: `[world] inflating ${(zip.length / 1024 / 1024).toFixed(1)} MiB zip…\n` });
      const entries = await unzipAll(zip);
      await checkWorldVersion(entries);
      const { root, files, bytes } = buildWorldDir(entries);
      cwdEntries.set("world", root);
      post({ type: "term", text: `[world] mounted ${files} files (${(bytes / 1024 / 1024).toFixed(1)} MiB) at ./world — Pumpkin will load its chunks\n` });
    } catch (e) {
      post({ type: "term", text: `[world] import failed: ${e.message ?? e}\n` });
    }
  }
  cwdEntries.set("schem.sock", new NetSockInode(schemFd));
  cwdEntries.set("sim.sock", new NetSockInode(simFd));
  cwdEntries.set("world.sock", new NetSockInode(worldSwapFd));
  const cwd = new PreopenDirectory(".", cwdEntries);
  cwdRootDir = cwd.dir;
  const farm = new WASIFarm(stdin, new TerminalOut(), new TerminalOut(), [cwd], {
    allocator_size: 64 * 1024 * 1024, // world snapshots move through here
  });

  runner = new Worker(new URL("./runner.js", self.location.href), { type: "module" });
  for (const line of pendingStdin.splice(0)) stdin.push(line);
  runner.postMessage({ wasi_ref: farm.get_ref(), env });
  runner.onmessage = (ev) => {
    if (ev.data.status) {
      post({ type: "status", status: ev.data.status });
      // A finished server must not squat on the room.
      if (/exited/.test(ev.data.status)) {
        serverDead = true;
        netFd.ws?.close();
      }
    }
    if (ev.data.error) {
      post({ type: "error", error: ev.data.error });
      serverDead = true;
      netFd.ws?.close();
    }
  };
}
