// lantern farm worker: hosts the WASI farm (fs + stdio + net bridge) and the
// proxy WebSocket OFF the main thread, so page rendering and background-tab
// throttling never stall server I/O. The page talks to us via postMessage.
import { Fd, Inode, PreopenDirectory, wasi } from "@bjorn3/browser_wasi_shim";
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
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
    }
    return { ret: 0, nwritten: data.byteLength };
  }

  pushFrame(frameBytes) {
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
const cwd = new PreopenDirectory(".", new Map([
  ["net.sock", new NetSockInode(netFd)],
  ["http.sock", new NetSockInode(httpFd)],
]));
const farm = new WASIFarm(stdin, new TerminalOut(), new TerminalOut(), [cwd]);

let runner = null;
self.onmessage = (e) => {
  if (e.data.type === "stdin") stdin.push(e.data.line);
  else if (e.data.type === "init" && !runner) {
    runner = new Worker(new URL("./runner.js", self.location.href), { type: "module" });
    runner.postMessage({ wasi_ref: farm.get_ref(), env: e.data.env });
    runner.onmessage = (ev) => {
      if (ev.data.status) post({ type: "status", status: ev.data.status });
      if (ev.data.error) post({ type: "error", error: ev.data.error });
    };
  }
};
