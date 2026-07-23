// lantern runner worker: compiles lantern.wasm and starts it on a dedicated
// thread (via the shim's thread spawner), so blocking is legal everywhere.
import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";

self.onmessage = async (e) => {
  const { wasi_ref, env } = e.data;
  try {
    postMessage({ status: "downloading lantern.wasm…" });
    const resp = await fetch("/lantern.wasm");
    if (!resp.ok) throw new Error(`lantern.wasm: HTTP ${resp.status}`);
    const total = Number(resp.headers.get("Content-Length")) || 0;
    const reader = resp.body.getReader();
    const chunks = [];
    let got = 0;
    let lastPost = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (Date.now() - lastPost > 200) {
        lastPost = Date.now();
        const mb = (got / 1048576).toFixed(1);
        const totalMb = total ? (total / 1048576).toFixed(1) : "?";
        postMessage({ status: `downloading lantern.wasm ${mb}/${totalMb} MB` });
      }
    }
    const buf = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.length;
    }
    postMessage({ status: "compiling wasm…" });
    const wasm = await WebAssembly.compile(buf);

    postMessage({ status: "preparing WASI (threads)…" });
    const animal = new WASIFarmAnimal(
      wasi_ref,
      ["lantern"], // argv
      ["RUST_MIN_STACK=16777216", ...(env ?? [])],
      {
        can_thread_spawn: true,
        thread_spawn_worker_url: new URL("./thread_spawn.js", self.location.href).href,
        thread_spawn_wasm: wasm,
      },
    );
    await animal.wait_worker_background_worker();

    postMessage({ status: "server running" });
    const code = await animal.async_start_on_thread();
    postMessage({ status: `server exited (code ${code})` });
  } catch (err) {
    console.error(err);
    postMessage({ error: String(err?.stack ?? err) });
  }
};
