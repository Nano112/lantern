//! lantern: Pumpkin compiled for `wasm32-wasip1-threads`, running in a browser
//! WASI shim. Networking is disabled — clients will arrive over virtual duplex
//! streams injected by the host page (milestone 3). The server console speaks
//! plain stdin/stdout, which the page bridges to an on-screen terminal.

mod metrics;
mod net_bridge;
mod persist;
mod schematic;
mod sim;

use pumpkin::PumpkinServer;
use pumpkin::data::VanillaData;
use pumpkin_config::{LoadConfiguration, PumpkinConfig};

fn main() {
    std::panic::set_hook(Box::new(|info| {
        eprintln!("server panicked: {info}");
    }));

    // Threads exist on wasip1-threads, but tokio only supports the
    // current-thread runtime on wasm targets.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        // Blocking threads are Web Workers here — spawning one means
        // instantiating the whole module. Keep them alive and few.
        .max_blocking_threads(4)
        .thread_keep_alive(std::time::Duration::from_secs(24 * 3600))
        .build()
        .expect("failed to build tokio runtime");

    runtime.block_on(run());
}

async fn run() {
    // Restore a previous session's world before anything reads config or disk.
    // (Logger isn't up yet — stash the outcome and report it after init.)
    let restore_result = persist::restore();

    let exec_dir = std::env::current_dir().expect("no cwd (is a preopened dir mounted?)");
    let mut config = PumpkinConfig::load(&exec_dir);

    // Browser build: no OS sockets, no TTY. Console I/O runs over WASI
    // stdin/stdout regardless of what the config file says.
    config.advanced.networking.java.enabled = false;
    config.advanced.networking.bedrock.enabled = false;
    config.advanced.networking.rcon.enabled = false;
    config.advanced.networking.query.enabled = false;
    config.advanced.networking.lan_broadcast.enabled = false;
    config.advanced.commands.use_console = true;
    config.advanced.commands.use_tty = false;
    // One dimension = one chunk pipeline; nether/end cost workers we can't spare.
    config.basic.allow_nether = false;
    config.basic.allow_end = false;
    // Online mode works via the host page's http.sock bridge (Mojang calls are
    // reverse-proxied with CORS by the lantern proxy). ?offline=1 in the page
    // URL turns it off for cracked/bot testing.
    let online = std::env::var("LANTERN_ONLINE").map(|v| v != "0").unwrap_or(true);
    config.advanced.networking.java.online_mode = online;
    config.advanced.networking.java.encryption = online;
    // Compression pays for itself many times over: uncompressed chunk packets
    // are ~200KB each across the WS bridge. Level 1 = cheapest CPU.
    config.advanced.networking.java.compression.enabled = true;
    config.advanced.networking.java.compression.info.level = 1;
    // A browser server can't generate a 33x33 chunk square in reasonable time;
    // keep the streamed world small so gameplay packets aren't queued for
    // minutes behind chunk data.
    config.advanced.networking.java.view_distance = std::num::NonZeroU8::new(6).unwrap();
    config.advanced.networking.java.simulation_distance = std::num::NonZeroU8::new(6).unwrap();
    // Plain text into a DIY terminal; no ANSI escapes, no thread-id noise.
    config.advanced.logging.color = false;
    config.advanced.logging.threads = false;

    let vanilla_data = VanillaData::load();
    pumpkin::init_logger(&config.advanced);

    tracing::info!("lantern: booting Pumpkin inside WebAssembly");
    match restore_result {
        Ok((mem, wasi)) => {
            tracing::info!("persist: restored {mem} world files + {wasi} data files from OPFS");
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::info!("persist: no previous state — fresh world");
        }
        Err(e) => tracing::warn!("persist: restore failed: {e}"),
    }

    let server = PumpkinServer::new(config.basic, config.advanced, vanilla_data).await;
    server.init_plugins().await;

    // Virtual networking: streams arrive from the page over a WASI fd.
    net_bridge::spawn(server.server.clone());
    metrics::spawn(server.server.clone());
    persist::spawn_autosave(server.server.clone());
    schematic::spawn_import(server.server.clone());
    schematic::spawn_live_reload(server.server.clone());
    sim::spawn_control(server.server.clone());

    // Boot self-test: prove the http.sock bridge reaches Mojang via the proxy.
    if online {
        let auth_config = server.server.advanced_config.networking.java.authentication.clone();
        tokio::spawn(async move {
            match pumpkin::net::authentication::fetch_mojang_public_keys(&auth_config) {
                Ok(keys) => {
                    tracing::info!("lantern: Mojang reachable via http bridge ({} public keys)", keys.len());
                }
                Err(e) => tracing::warn!("lantern: Mojang http bridge self-test failed: {e}"),
            }
        });
    }

    tracing::info!("lantern: server up — type commands below (try: help, seed, time query daytime)");

    // Worldgen benchmark: LANTERN_BENCH=<radius> generates a (2r+1)^2 chunk
    // square through the real ticketed pipeline and reports throughput.
    if let Ok(r) = std::env::var("LANTERN_BENCH") {
        pumpkin_world::chunk_system::gen_timing::set_enabled(true);
        let radius: i32 = r.parse().unwrap_or(3);
        let bench_server = server.server.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let world = bench_server.worlds.load()[0].clone();
            let level = world.level.clone();
            let total = (2 * radius + 1) * (2 * radius + 1);
            tracing::info!("bench: requesting {total} chunks (radius {radius})…");
            let start = std::time::Instant::now();
            let mut tasks = Vec::new();
            for x in -radius..=radius {
                for z in -radius..=radius {
                    let level = level.clone();
                    tasks.push(tokio::spawn(async move {
                        level
                            .get_or_fetch_chunk(
                                pumpkin_util::math::vector2::Vector2::new(x, z),
                                |_| (),
                            )
                            .await;
                    }));
                }
            }
            let mut done = 0;
            for t in tasks {
                let _ = t.await;
                done += 1;
                if done % 25 == 0 {
                    let secs = start.elapsed().as_secs_f64();
                    tracing::info!("bench: {done}/{total} chunks ({:.2}/s)", f64::from(done) / secs);
                }
            }
            let secs = start.elapsed().as_secs_f64();
            tracing::info!(
                "bench: DONE {total} chunks in {secs:.1}s = {:.2} chunks/s",
                f64::from(total) / secs
            );
            let mut stages = pumpkin_world::chunk_system::gen_timing::snapshot();
            stages.sort_by(|a, b| b.2.total_cmp(&a.2));
            let total_ms: f64 = stages.iter().map(|s| s.2).sum();
            for (name, count, ms) in stages {
                tracing::info!(
                    "bench:   {name:<16} {ms:>9.1}ms total  {:>7.2}ms/run  x{count}  ({:.0}%)",
                    ms / count as f64,
                    ms / total_ms * 100.0
                );
            }
        });
    }

    server.start().await;
    persist::save_now("shutdown");
}
