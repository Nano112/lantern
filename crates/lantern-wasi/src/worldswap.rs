//! Live world swap: the page replaces the files under ./world in the WASI fs
//! (new region files + level.dat from a dropped zip), then sends "swap" over
//! world.sock. We drop every cached chunk and re-send the previously loaded
//! positions to connected players — no restart, nobody gets kicked.
//! Terrain swaps live; level_info (seed/spawn) keeps the boot-time values
//! until the next reload.

use std::sync::Arc;
use std::time::Duration;

use pumpkin::net::ClientPlatform;
use pumpkin::server::Server;
use pumpkin_protocol::java::client::play::{CChunkBatchEnd, CChunkBatchStart, CChunkData};
use pumpkin_util::math::vector2::Vector2;

const SWAP_SOCK: &str = "world.sock";

async fn swap(server: &Arc<Server>) {
    let world = server.worlds.load()[0].clone();
    let level = world.level.clone();

    // Remember what was in memory, then drop it all — the next fetch reads
    // the replaced region files.
    let positions: Vec<Vector2<i32>> = level.loaded_chunks.iter().map(|e| *e.key()).collect();
    level.loaded_chunks.clear();
    tracing::info!(
        "worldswap: purged {} cached chunks — reloading from the new world files",
        positions.len()
    );

    let players = world.players.load();
    if players.is_empty() {
        return;
    }
    for player in players.iter() {
        if let ClientPlatform::Java(java_client) = player.client.as_ref() {
            java_client.send_packet_now(&CChunkBatchStart).await;
            let mut sent = 0u16;
            for pos in &positions {
                let chunk = level
                    .get_or_fetch_chunk(*pos, std::clone::Clone::clone)
                    .await;
                java_client.send_packet_now(&CChunkData(&chunk)).await;
                sent += 1;
            }
            java_client.send_packet_now(&CChunkBatchEnd::new(sent)).await;
        }
    }
    tracing::info!(
        "worldswap: re-sent {} chunks to {} player(s) — world swapped live",
        positions.len(),
        players.len()
    );
}

pub fn spawn_control(server: Arc<Server>) {
    let Ok(fd) = crate::net_bridge::open_socket(SWAP_SOCK) else {
        return;
    };
    tokio::spawn(async move {
        let mut acc: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 4096];
        loop {
            let n = crate::net_bridge::fd_read_now(fd, &mut buf);
            if n == 0 {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
            acc.extend_from_slice(&buf[..n]);
            while acc.len() >= 4 {
                let flen = u32::from_be_bytes([acc[0], acc[1], acc[2], acc[3]]) as usize;
                if acc.len() < 4 + flen {
                    break;
                }
                let frame: Vec<u8> = acc.drain(..4 + flen).skip(4).collect();
                let cmd = String::from_utf8_lossy(&frame).trim().to_string();
                if cmd == "swap" {
                    swap(&server).await;
                } else {
                    tracing::warn!("worldswap: unknown command {cmd:?}");
                }
            }
        }
    });
}
