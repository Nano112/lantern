//! lantern: Pumpkin compiled for `wasm32-wasip1-threads`, running in a browser
//! WASI shim. Networking is disabled — clients will arrive over virtual duplex
//! streams injected by the host page (milestone 3). The server console speaks
//! plain stdin/stdout, which the page bridges to an on-screen terminal.

mod net_bridge;

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
    // Mojang auth needs blocking HTTP (absent on wasm) — offline mode only.
    config.advanced.networking.java.online_mode = false;
    config.advanced.networking.java.encryption = false;
    // Keep the byte stream inspectable while the bridge is young.
    config.advanced.networking.java.compression.enabled = false;
    // Plain text into a DIY terminal; no ANSI escapes, no thread-id noise.
    config.advanced.logging.color = false;
    config.advanced.logging.threads = false;

    let vanilla_data = VanillaData::load();
    pumpkin::init_logger(&config.advanced);

    tracing::info!("lantern: booting Pumpkin inside WebAssembly");

    let server = PumpkinServer::new(config.basic, config.advanced, vanilla_data).await;
    server.init_plugins().await;

    // Virtual networking: streams arrive from the page over a WASI fd.
    net_bridge::spawn(server.server.clone());

    tracing::info!("lantern: server up — type commands below (try: help, seed, time query daytime)");

    server.start().await;
}
