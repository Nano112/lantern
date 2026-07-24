// lantern farm worker: hosts the WASI farm (fs + stdio + net bridge) and the
// proxy WebSocket OFF the main thread, so page rendering and background-tab
// throttling never stall server I/O. The page talks to us via postMessage.
import { Fd, File, Inode, PreopenDirectory, wasi } from "@bjorn3/browser_wasi_shim";
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
  return self.location.hostname === "localhost"
    ? "http://localhost:9091"
    : `https://${self.location.hostname}:9443`;
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
        const resp = await fetch(target, { method });
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

function connectProxy() {
  const url = self.location.hostname === "localhost"
    ? "ws://localhost:9091/ws"
    : `wss://${self.location.hostname}:9443/ws`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  netFd.ws = ws;
  ws.onopen = () => {
    const reg = new TextEncoder().encode(JSON.stringify({ room: "default", motd: "lantern — Pumpkin in your browser" }));
    ws.send(wsFrame(0, 0, reg)); // registration on control stream 0
    post({ type: "status", status: "server running — proxy connected" });
  };
  ws.onmessage = (ev) => {
    const f = new Uint8Array(ev.data);
    const sid = new DataView(f.buffer, f.byteOffset).getUint32(1);
    if (sid === 0) {
      try {
        const resp = JSON.parse(new TextDecoder().decode(f.slice(5)));
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

let runner = null;
let started = false;
const pendingStdin = [];

self.onmessage = (e) => {
  if (e.data.type === "stdin") {
    if (runner) stdin.push(e.data.line);
    else pendingStdin.push(e.data.line);
  } else if (e.data.type === "init" && !started) {
    started = true;
    boot(e.data).catch((err) => post({ type: "error", error: String(err) }));
  }
};

async function boot({ env, fresh, schem }) {
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
  const cwd = new PreopenDirectory(".", cwdEntries);
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
      if (/exited/.test(ev.data.status)) netFd.ws?.close();
    }
    if (ev.data.error) {
      post({ type: "error", error: ev.data.error });
      netFd.ws?.close();
    }
  };
}
