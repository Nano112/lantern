// lantern runner worker: compiles lantern.wasm and starts it on a dedicated
// thread (via the shim's thread spawner), so blocking is legal everywhere.
import { WASIFarmAnimal } from "@oligami/browser_wasi_shim-threads";

self.onmessage = async (e) => {
  const { wasi_ref } = e.data;
  try {
    postMessage({ status: "fetching lantern.wasm…" });
    const wasm = await WebAssembly.compileStreaming(fetch("/lantern.wasm"));

    postMessage({ status: "preparing WASI (threads)…" });
    const animal = new WASIFarmAnimal(
      wasi_ref,
      ["lantern"], // argv
      ["RUST_MIN_STACK=16777216"],
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
