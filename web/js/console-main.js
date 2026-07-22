// lantern console — main thread: owns the WASI farm (fs + stdio), the terminal
// UI, and hands a farm ref to the runner worker that executes lantern.wasm.
import { Fd, PreopenDirectory } from "@bjorn3/browser_wasi_shim";
import { WASIFarm } from "@oligami/browser_wasi_shim-threads";

const logEl = document.getElementById("log");
const inputEl = document.getElementById("input");
const statusEl = document.getElementById("status");

let pendingLine = "";
function writeText(text) {
  pendingLine += text;
  const lines = pendingLine.split("\n");
  pendingLine = lines.pop();
  for (const line of lines) {
    const div = document.createElement("div");
    div.textContent = line === "" ? " " : line;
    logEl.appendChild(div);
  }
  // Trim history so the DOM doesn't grow unboundedly.
  while (logEl.childNodes.length > 2000) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

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

const stdin = new QueueStdin();
const cwd = new PreopenDirectory(".", new Map());

const farm = new WASIFarm(stdin, new TerminalOut(), new TerminalOut(), [cwd]);

const runner = new Worker("./dist/runner.js", { type: "module" });
runner.postMessage({ wasi_ref: farm.get_ref() });
runner.onmessage = (e) => {
  if (e.data.status) statusEl.textContent = e.data.status;
  if (e.data.error) {
    statusEl.textContent = "crashed — see console";
    writeText(`\n[lantern] ${e.data.error}\n`);
  }
};

inputEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const line = inputEl.value;
  inputEl.value = "";
  writeText(`> ${line}\n`);
  stdin.push(`${line}\n`);
});
