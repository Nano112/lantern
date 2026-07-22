# 🎃 lantern

**Pumpkin, but in your browser.** [Pumpkin](https://pumpkinmc.org) is a Minecraft
server written in Rust — which, unlike the JVM servers, has a first-class path to
WebAssembly. lantern is a thin harness around a lightly-patched Pumpkin fork that
compiles it for the web: Pumpkin's team maintains the gameplay (worldgen, mob AI,
physics, protocol); lantern maintains only the platform layer (network transport,
storage, timers).

Prior art: [Schem-at/Aero](https://github.com/Schem-at/Aero) proved the
browser-server concept but meant maintaining an entire server implementation.
lantern's bet is that piggybacking Pumpkin keeps the maintained surface tiny.

## Layout

- `pumpkin/` — git submodule → [Nano112/Pumpkin](https://github.com/Nano112/Pumpkin),
  branch `lantern` (fork of Pumpkin-MC/Pumpkin). Carries the wasm patches; kept
  minimal and upstream-mergeable (everything is `#[cfg(target_family = "wasm")]`-gated
  or per-target Cargo deps, native builds are unaffected).
- `crates/lantern-web` — wasm-bindgen entry point. Milestone 1 exposes Pumpkin's
  vanilla world generation to JS (`LanternWorld::chunk_surface`).
- `web/` — demo page. `wasm-pack build crates/lantern-web --target web --out-dir ../../web/pkg --release`,
  then serve `web/` and watch vanilla overworld terrain generate on a canvas.
- `proxy/` — (planned) Aero-style bridge so real Java Edition clients can reach a
  browser-hosted server: browser ⇄ WebSocket/WebRTC ⇄ proxy ⇄ TCP :25565.

## Fork patches so far (branch `lantern`)

| Where | What | Why |
| --- | --- | --- |
| workspace `Cargo.toml` | `uuid` + `js` feature | wasm randomness (no-op on native) |
| `pumpkin-util` | `compat::{fs, time}` module | re-exports tokio on native; in-memory async FS + pass-through timeout on wasm |
| `pumpkin-util` | `ureq` + `fetch_oidc_jwks` gated to native | native TLS/socket HTTP; online-mode auth is meaningless in-browser |
| `pumpkin-world` | tokio features split per-target; `tokio::fs`/`tokio::time` call sites → `compat::` | wasm tokio has no fs/time/threads |
| `pumpkin-protocol` | tokio `net` + Bedrock `UdpSocket` path gated to native | mio doesn't exist on wasm |

`.cargo/config.toml` at the repo root sets `--cfg getrandom_backend="wasm_js"` for
wasm builds (applies into the submodule too).

## Status

- ✅ `pumpkin-world`, `pumpkin-protocol`, `pumpkin-util`, `pumpkin-data`,
  `pumpkin-nbt`, `pumpkin-config` compile for `wasm32-unknown-unknown`;
  native builds still green.
- ✅ Milestone 1: vanilla overworld chunk generation runs in the browser
  (single-threaded `generate_single_chunk` path — no tokio runtime needed).
- ⬜ Milestone 2: the `pumpkin` main crate on wasm. Known surgery, all confined:
  - plugin system (`wasmtime` host + `libloading`) → feature-gate off for web
    (long-term: load WIT plugins with the browser's own wasm engine instead);
  - `rustyline` console, `sysinfo` crash reporter, `notify` watchers, `signal`
    handling → gate to native;
  - TCP accept loop → a `VirtualTransport` (bytes in/out over a JS bridge), the
    same seam the proxy uses.
- ⬜ Milestone 3: tick loop + a client connected end-to-end through the virtual
  transport (in-page viewer first, then real clients via `proxy/`).
- ⬜ Persistence: swap the in-memory `compat::fs` store for OPFS.
- ⬜ Threads: chunk pipeline (`rayon`/`crossfire`) currently must stay off-wasm;
  either single-threaded scheduling or SharedArrayBuffer + wasm threads later.

## Gotchas

- Pumpkin requires a recent stable Rust (`rust-version = 1.95`+).
- `Chunk` returns either `Proto` or `Level`; lantern-web handles both.
- Time on wasm is a stub (`compat::time::timeout` never elapses) — fine while
  single-threaded and in-memory; needs a JS-timer driver for the real tick loop.
