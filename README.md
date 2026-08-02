# 🎃 lantern

**A real Minecraft Java server, running in a browser tab.**

lantern compiles [Pumpkin](https://pumpkinmc.org) — a Minecraft 26.2 server
written in Rust — to `wasm32-wasip1-threads` and runs it in the browser on web
workers with shared memory. Real Minecraft clients join through a TCP↔WebSocket
proxy. Worlds persist in the browser's own storage. Schematics from
[schemat.io](https://schemat.io) load as instant worlds via
[Nucleation](https://github.com/Schem-at/Nucleation).

```
Minecraft Java 26.2 client
  │ TCP :25570
  ▼
Go proxy (vendored from Schem-at/Aero) ── also reverse-proxies Mojang auth + schemat.io
  │ WebSocket (multiplexed streams)
  ▼
Browser page ── farm worker (WASI host: fs, stdio, sockets-over-fd, OPFS persistence)
  │ SharedArrayBuffer + web workers (one per server thread)
  ▼
Pumpkin server (wasm32-wasip1-threads) ── tick loop, worldgen, mobs, redstone…
  └─ Nucleation (schematic parsing, later: SDF/OSM/simulation)
```

## What works

- **Authenticated online-mode joins** — encryption, Mojang `hasJoined`:
  HTTP calls tunnel from wasm through the page to the proxy's CORS'd
  Mojang passthrough.
- **The gameplay stack Pumpkin implements** — worldgen (bit-exact vanilla
  seeds), chunk streaming, commands, chat. The server console is bridged to an
  on-page terminal, next to a live metrics panel (TPS/MSPT, tasks, queues,
  net rates, sparklines).
- **Persistent worlds** — the in-wasm filesystem is snapshotted (deflate) to
  OPFS every 60 s and on shutdown; reloading the tab restores the same world,
  same seed. `?fresh=1` wipes.
- **Schematics as worlds** — `?schem=<schemat.io url>&gen=void` boots a void
  world and pastes the build (measured: ~98 k blocks in 0.5 s, zero unknown
  block states — Nucleation's blockpedia and Pumpkin both target MC 26.2).
- **~11–13 chunks/s** vanilla worldgen in wasm (2 gen threads; measured, see
  perf notes below).

## Repository layout

| Path | What |
|---|---|
| `pumpkin/` | submodule → [Nano112/Pumpkin](https://github.com/Nano112/Pumpkin) branch `lantern` — the fork. Every patch is `cfg`-gated or per-target; native builds are unaffected and stay green. |
| `crates/lantern-wasi` | the wasm entry binary: boots Pumpkin, virtual networking (`net.sock`), HTTP bridge (`http.sock`), metrics (`metrics.sock`), OPFS persistence (`state.bin`), schematic import, worldgen bench |
| `crates/lantern-web` | milestone-1 demo: worldgen rendered to a canvas via wasm-bindgen |
| `web/` | console page + farm worker (WASI shim host) + esbuild bundles |
| `proxy/` | Go TCP↔WebSocket proxy, vendored from [Schem-at/Aero](https://github.com/Schem-at/Aero), extended with CORS'd reverse proxies for Mojang APIs and schemat.io |
| `vendor/parking_lot_core` | patched: wasm needs a working thread parker on stable Rust (upstream gates it behind nightly; the panicking fallback aborts on first contended lock) |

## Running it

Prereqs: Rust ≥ 1.95 with `wasm32-wasip1-threads`, Go, Node, Chrome
(SharedArrayBuffer requires cross-origin isolation **and** a secure context —
`localhost` or HTTPS, e.g. `tailscale serve`).

```sh
git clone --recurse-submodules <this repo>   # pumpkin has a NESTED submodule (pumpkin-plugin-wit)
cargo build --target wasm32-wasip1-threads -p lantern-wasi --release
cp target/wasm32-wasip1-threads/release/lantern.wasm web/

cd web && npm install
# re-apply the shim patch (see Gotchas) after any npm install
npx esbuild js/console-main.js --bundle --format=esm --outfile=dist/console-main.js
npx esbuild js/farm-worker.js  --bundle --format=esm --outfile=dist/farm-worker.js
npx esbuild js/runner.js       --bundle --format=esm --outfile=dist/runner.js
npx esbuild js/thread_spawn.js --bundle --format=esm --outfile=dist/thread_spawn.js
python3 serve.py 8932          # COOP/COEP headers + ETag revalidation

cd ../proxy && go build ./cmd/proxy
./proxy -port 25570 -api-port 9091 -domain <host> -web-port 0
```

Open `http://localhost:8932/console.html`, then point a Minecraft Java 26.2
client at the address shown in the console's copy bar (`<host>:25570`
direct, bare hostname via the tailscale sidecar).

Rooms are newest-wins: the bare address always routes to room `"default"`,
and a freshly loaded page evicts whoever held it (stale tabs demote
themselves to suffixed rooms and stop competing). Suffixed rooms are
reachable as `<room>.<domain>` wherever such names resolve — pass the parent
domain via the proxy's `-domain` flag. (`*.ts.net` names can't have
subdomains, so on the tailnet only the newest server is reachable.)

URL params: `?offline=1` (cracked/bot access), `?fresh=1` (wipe saved world),
`?schem=<url>` (+ `&gen=void&y=-63`), `?bench=N` (worldgen benchmark),
`?gen=void|flat`.

> `crates/lantern-wasi` currently depends on Nucleation by local path — point
> it at your checkout of [Schem-at/Nucleation](https://github.com/Schem-at/Nucleation)
> (which also provides the `mc-tick` engine crate at `crates/mc-tick`).

## mc-tick: swappable logic engine

The pasted schematic can be simulated by Nucleation's **mc-tick** engine — a
vanilla-accurate headless tick engine (redstone, pistons, entities,
deterministic RNG) — as an alternative to Pumpkin's own logic. Toggle it from
the console page ("logic engine: mc-tick / pumpkin"): when on, a 20 Hz loop
steps the simulation, drains its recorded block changes, writes them into the
Pumpkin world and broadcasts `CBlockUpdate`s to connected clients.

- Engine commands travel over `sim.sock` (same virtual-fd pattern as the other
  bridges): `on`, `off`, and `use X Y Z` (world coords) to interact — e.g.
  flip a lever. From the page console: `lanternSim("use 0 -62 0")`.
- The engine refuses schematics containing blocks it has no behaviour for
  (correctness over coverage) — you'll see `sim: refused to start: …`.
- `crates/schem-gen` writes `web/clock.schem`, a test scene: an observer pair
  plus a lever→wire→lamp run. Verified end-to-end: flipping the lever applies
  the wire/lamp changes into the world, including vanilla's delayed lamp-off.
- Wiring is vendored from Nucleation's bridge in
  `crates/lantern-wasi/src/sim.rs` (settle mode "in world"); worth upstreaming
  as a public embed API.

## Drag & drop

Drop files anywhere on the console page:

- **`.schem` / `.litematic` / legacy `.schematic`** — hot-swaps the running
  server's pasted build (format detected by content, via nucleation).
- **world `.zip`** (a Java world save containing `level.dat`) — inflated in
  the farm worker (browser-native `DecompressionStream`, no zip library) and
  mounted at `./world`, so Pumpkin reads `level.dat` and loads chunks lazily
  from the region files. Ungenerated areas fall to the active generator.
  `DIM1`/`DIM-1`, `session.lock` and macOS zip litter are skipped; the world
  is captured by the normal OPFS persistence on the next autosave.
  - **Live swap:** dropped while the server is running, the world is replaced
    in place — the page swaps the files under `./world`, signals `world.sock`,
    and the server purges its chunk cache and re-sends the loaded chunks to
    connected players. Nobody gets kicked. (level_info/seed keep their
    boot-time values until the next reload.)
  - **Version guard:** the page reads `DataVersion` from `level.dat` before
    doing anything; Pumpkin supports 4435–4903 (MC 1.21.9 – 26.2, no
    DataFixerUpper). Older worlds get a clear refusal — open them once in a
    current Minecraft to upgrade, then re-zip.

> Gotcha: don't parse schematics through nucleation's `FormatManager`
> (`get_manager()`) in the wasm binary — that build wedged at startup on
> wasm32-wasip1-threads (silent, no output). Direct calls into
> `nucleation::formats::{litematic, classic_schematic, world}` link and run
> fine (the DataConverter world-upgrade path uses `formats::world` in-browser),
> so the problem is specific to the manager's registry, not the format code.
> `schematic.rs::parse_any` sniffs formats by content instead.

### Old worlds: automatic DataConverter upgrade

Dropped world zips older than Pumpkin's supported range are upgraded
in-browser by nucleation's DataConverter (a Rust port of PaperMC's
DataConverter): the zip goes over `world.sock` as a `convert:` command, is
read bounded to ±512 blocks around origin, forward-converted to the canonical
DataVersion, re-emitted as current world files and hot-swapped. Verified
round-trip: a DV-4082 (1.21.4) export upgrades to 4790 and loads.

### Schematic drop modal

Dropping a schematic opens a modal: **paste into world** at chosen X/Y/Z
(placement travels as an `LSH1` JSON header on the `schem.sock` frame), or
**fresh void world** (bytes staged in OPFS, page reboots, one-shot
`?schemstage=1`).

## Performance notes (all measured, wasm, M-series)

- ~11–13 chunks/s through the real pipeline. **2 gen threads is the optimum;
  4 halves throughput** (pipeline contention).
- Biggest win so far: `set_structure_references` eagerly rebuilt two
  noise-router component stacks per call — made lazy: 15.2 → 4.9 ms/run,
  **+46 % total throughput** (applies to native Pumpkin too).
- Remaining noise cost is **DAG interpretation volume** (~17 M node-fill
  invocations per 121 chunks, one per node per column/cell pass; leaf math is
  nearly free). Conditional fills are already hybrid batch/lazy
  (bit-exact, pooled scratch buffers); the next levers are plane-sized passes
  and DAG fusion. `simd128` is enabled but neutral until then.
- Per-stage profiler built in: `?bench=N` prints the table (probes are no-ops
  outside bench mode). Native comparison: `cargo test --release -p
  pumpkin-world --test stage_timing -- --nocapture --ignored`.

## Bugs found on the way (fixed in the fork, upstream-relevant)

- **Flat-world scheduler livelock**: Flat-generator arms for
  `StructureStart`/`StructureReferences` never advanced the chunk stage
  marker → the scheduler re-queued the same dependency pyramid forever.
- **`MOJANG_SERVICES_URL` double-slash** breaking key fetches behind proxies.
- **parking_lot on wasm** silently selects a parker that aborts on first
  contended lock when built on stable (see `vendor/`).
- wasm needs `--max-memory` raised (default 1 GiB max; template-heavy
  structure gen OOMs into `memory access out of bounds`).

Known wart: chunk tickets filed in the scheduler's first ~2 s can be missed
(init race, worked around with a settle delay; not yet root-caused).

## Gotchas

- Clone with `--recurse-submodules`: Pumpkin itself has a nested
  `pumpkin-plugin-wit` submodule; without it the main crate fails with 35
  `cannot find pumpkin in v0_1` errors.
- `@oligami/browser_wasi_shim-threads` 0.4.x has a `poll_oneoff` bug against
  `@bjorn3/browser_wasi_shim` 0.4.2 (`s.precision` undefined → BigInt
  TypeError in every `thread::sleep`). Patch `node_modules` before bundling:
  treat missing `precision` as `0n`.
- The page must be cross-origin isolated **and** on a secure context, or
  SharedArrayBuffer doesn't exist. `serve.py` sends the headers; use
  `localhost` or HTTPS.
- Chrome only for now (needs `Atomics.waitAsync`).

## Credits

- [Pumpkin](https://github.com/Pumpkin-MC/Pumpkin) — the server. lantern's
  whole bet is riding their gameplay work; fork patches are kept
  upstream-mergeable.
- [Schem-at/Aero](https://github.com/Schem-at/Aero) — the proxy and prior art
  for browser-hosted Minecraft.
- [Nucleation](https://github.com/Schem-at/Nucleation) — schematic engine.
- [browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) +
  `@oligami/browser_wasi_shim-threads` — the WASI host.
