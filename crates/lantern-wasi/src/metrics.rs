//! lantern: 1 Hz server metrics as newline-delimited JSON over metrics.sock.
//! One-way (wasm → page); the page's right-hand panel renders it.

use std::sync::Arc;
use std::time::{Duration, Instant};

use pumpkin::server::Server;

static ACTIVITY: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// What the server is busy with right now — shown live on the dashboard.
pub fn set_activity(text: &str) {
    *ACTIVITY.lock().unwrap() = text.to_string();
}

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
            let all_players = server.get_all_players();
    		let players = all_players.len();
            let player_list: Vec<serde_json::Value> = all_players
                .iter()
                .map(|p| {
                    serde_json::json!({
                        "name": p.gameprofile.name,
                        "gamemode": format!("{:?}", p.gamemode.load()),
                    })
                })
                .collect();
            let player_list = serde_json::to_string(&player_list).unwrap_or_else(|_| "[]".into());
            let activity =
                serde_json::to_string(&*ACTIVITY.lock().unwrap()).unwrap_or_else(|_| "\"\"".into());
            let mut chunks = 0usize;
            for world in server.worlds.load().iter() {
                chunks += world.level.loaded_chunk_count();
            }
            let mem_mb = (core::arch::wasm32::memory_size::<0>() * 64) as f64 / 1024.0;

            let rt = tokio::runtime::Handle::current().metrics();
            let tasks = rt.num_alive_tasks();
            // blocking-pool introspection needs tokio_unstable; workers is the
            // stable proxy (1 on current_thread; blocking threads show in tasks)
            let blocking = rt.num_workers();
            let idle_blocking = 0usize;
            let net_streams = crate::net_bridge::OPEN_STREAMS.load(std::sync::atomic::Ordering::Relaxed);
            let net_outq = crate::net_bridge::OUT_QUEUE.load(std::sync::atomic::Ordering::Relaxed);

            let line = format!(
                "{{\"mspt\":{mspt:.2},\"players\":{players},\"chunks\":{chunks},\"mem_mb\":{mem_mb:.1},\"uptime_s\":{},\"tasks\":{tasks},\"blocking\":{blocking},\"idle_blocking\":{idle_blocking},\"net_streams\":{net_streams},\"net_outq\":{net_outq},\"player_list\":{player_list},\"activity\":{activity}}}\n",
                start.elapsed().as_secs()
            );
            crate::net_bridge::fd_write_all(fd, line.as_bytes());
        }
    });
}
