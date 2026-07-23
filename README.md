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
- ✅ Milestone 2: the full server runs in the browser. Target is
  `wasm32-wasip1-threads` (real threads via web workers + SharedArrayBuffer,
  real clocks — Pumpkin's thread-based chunk pipeline runs unmodified).
  `crates/lantern-wasi` boots the server with networking disabled; the page
  (`web/console.html`) hosts a WASI farm (`@oligami/browser_wasi_shim-threads`)
  and bridges stdin/stdout to an on-screen server console. Tick loop runs at
  20 TPS; `seed`, `time query`, `difficulty`, … all work.
  Build: `cargo build --target wasm32-wasip1-threads -p lantern-wasi --release`,
  copy `lantern.wasm` into `web/`, bundle `web/js/*` with esbuild into
  `web/dist/`, serve `web/` with `serve.py` (COOP/COEP headers required).
- ✅ Milestone 3 (networking): real Minecraft clients reach the browser server.
  Chain: MC client → `proxy/` (vendored Aero Go proxy, TCP :25570) → WebSocket
  (`:9091/ws`, wss via tailscale serve :9443) → page `NetBridgeFd` (mounted at
  `./net.sock` in the WASI cwd) → `lantern-wasi::net_bridge` (Aero's mux
  framing + u32 length prefix over the fd) → `tokio::io::duplex` →
  `JavaClient::new_virtual` → `pumpkin::run_java_client`.
  Verified end-to-end: server-list status ping returns full JSON; offline-mode
  login reaches Login Success + configuration state. Browser config forces
  offline mode (no Mojang HTTP on wasm), encryption+compression off for now.
- ⬜ Full join (play state, chunk streaming to a real client) — untested; then
  re-enable compression (+ maybe encryption), OPFS persistence, plugins.
- ⬜ Persistence: swap the in-memory `compat::fs` store for OPFS.
- ⬜ Threads: chunk pipeline (`rayon`/`crossfire`) currently must stay off-wasm;
  either single-threaded scheduling or SharedArrayBuffer + wasm threads later.

## Worldgen performance (wasm, measured)

Bench harness: `?bench=N` on the console URL (radius-N square through the real
pipeline; per-stage table printed at the end — probes are no-ops unless bench
mode enables them). Protocol: discard the first run after deploying a new
binary (V8 tiering), read run 2+.

State as of 2026-07-24: **~11-13 chunks/s** with 2 gen threads/dim (4 threads
halves it — pipeline contention). Fixed so far: structure_refs eager sampler
builds (15.2→4.9ms/run, +46%), Add-fill heap churn, CacheOnce size-flip
reallocs, 1GiB→2GiB max memory (jigsaw template OOB crash). Neutral: simd128,
codegen-units=1.

Where the remaining noise time goes: NOT leaf math (independent leaf fills are
~20ms/bench) — it's DAG interpretation volume: **17M+ node-fill invocations
per 121 chunks**, dominated by Mul/Min/Max lazy per-element fallbacks that
recurse the subtree per sample. wasm pays 2-4x native per call. The structural
fix is a batch-evaluation pass (each node consumes/produces whole arrays with
reused scratch, no per-element re-dispatch) — upstream-grade refactor, golden
tests (`cargo test -p pumpkin-world`, 90 tests) are the bit-exactness referee.

## Gotchas

- The shipped `@oligami/browser_wasi_shim-threads` 0.4.1 has a `poll_oneoff`
  bug against `@bjorn3/browser_wasi_shim` 0.4.2 (`s.precision` is undefined →
  BigInt TypeError in every `thread::sleep`). We patch `node_modules` before
  bundling — see README-web notes / re-apply after `npm install`.
- Console input: browser stdin is a polled mailbox; the fork treats empty
  stdin reads as "no input yet" on wasm (never EOF).

- Clone with `git submodule update --init --recursive` — Pumpkin itself has a
  nested submodule (`pumpkin-plugin-wit`, the WIT plugin interfaces); without it
  the main `pumpkin` crate fails with 35 `cannot find pumpkin in v0_1` errors.
- Native server: `cargo build --release -p pumpkin` inside `pumpkin/`, run the
  binary from `run/` (config + world land in cwd). Targets MC Java 26.2,
  accepts clients ≥ 1.20.5.

- Pumpkin requires a recent stable Rust (`rust-version = 1.95`+).
- `Chunk` returns either `Proto` or `Level`; lantern-web handles both.
- Time on wasm is a stub (`compat::time::timeout` never elapses) — fine while
  single-threaded and in-memory; needs a JS-timer driver for the real tick loop.
