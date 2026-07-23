//! lantern: 1 Hz server metrics as newline-delimited JSON over metrics.sock.
//! One-way (wasm → page); the page's right-hand panel renders it.

use std::sync::Arc;
use std::time::{Duration, Instant};

use pumpkin::server::Server;

pub fn spawn(server: Arc<Server>) {
    let Ok(fd) = crate::net_bridge::open_socket("metrics.sock") else {
        tracing::info!("metrics: no metrics.sock mounted, telemetry disabled");
        return;
    };
    let start = Instant::now();

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;

            let mspt = server.get_mspt();
            let players = server.get_all_players().len();
            let mut chunks = 0usize;
            for world in server.worlds.load().iter() {
                chunks += world.level.loaded_chunk_count();
            }
            let mem_mb = (core::arch::wasm32::memory_size::<0>() * 64) as f64 / 1024.0;

            let line = format!(
                "{{\"mspt\":{mspt:.2},\"players\":{players},\"chunks\":{chunks},\"mem_mb\":{mem_mb:.1},\"uptime_s\":{}}}\n",
                start.elapsed().as_secs()
            );
            crate::net_bridge::fd_write_all(fd, line.as_bytes());
        }
    });
}
