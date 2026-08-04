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

    let purged = level.loaded_chunks.len();
    level.loaded_chunks.clear();
    tracing::info!("worldswap: dropped {purged} cached chunks");

    let players = world.players.load();
    if players.is_empty() {
        crate::metrics::set_activity("");
        return;
    }

    // Only the chunks each player can actually see get regenerated eagerly —
    // everything else regenerates lazily on demand. Nearest chunks first, in
    // small batches, with progress on the dashboard: a full old-cache resend
    // once took 25s+ of silent grinding and timed the player out.
    const RADIUS: i32 = 6; // matches view_distance
    for player in players.iter() {
        if let ClientPlatform::Java(java_client) = player.client.as_ref() {
            let bp = player.living_entity.entity.block_pos.load();
            let (pcx, pcz) = (bp.0.x >> 4, bp.0.z >> 4);
            let mut positions: Vec<Vector2<i32>> = (-RADIUS..=RADIUS)
                .flat_map(|dx| (-RADIUS..=RADIUS).map(move |dz| Vector2::new(pcx + dx, pcz + dz)))
                .collect();
            positions.sort_by_key(|p| {
                let (dx, dz) = (p.x - pcx, p.y - pcz);
                dx * dx + dz * dz
            });
            let total = positions.len();
            let name = &player.gameprofile.name;
            tracing::info!("worldswap: rebuilding {total} chunks around {name}…");
            for (done, batch) in positions.chunks(16).enumerate() {
                // Fetch the whole batch concurrently — regeneration order is
                // the scheduler's business, and awaiting ring-order serializes
                // behind whichever chunk happens to be slowest.
                let fetched = futures::future::join_all(batch.iter().map(|pos| {
                    let level = level.clone();
                    let pos = *pos;
                    async move { level.get_or_fetch_chunk(pos, std::clone::Clone::clone).await }
                }))
                .await;
                java_client.send_packet_now(&CChunkBatchStart).await;
                for chunk in &fetched {
                    java_client.send_packet_now(&CChunkData(chunk)).await;
                }
                java_client
                    .send_packet_now(&CChunkBatchEnd::new(batch.len() as u16))
                    .await;
                let sent = (done * 16 + batch.len()).min(total);
                crate::metrics::set_activity(&format!(
                    "regenerating world — {sent}/{total} chunks around {name}"
                ));
                if sent % 48 == 0 || sent == total {
                    tracing::info!("worldswap: {sent}/{total} chunks around {name}");
                }
            }
        }
    }
    crate::metrics::set_activity("");
    tracing::info!(
        "worldswap: world live for {} player(s) — chunks beyond view distance regenerate as explored",
        players.len()
    );
}

/// Brand-new world without restarting the server: swap the generator (fresh
/// seed), wipe stored chunks, purge the cache and re-send around players.
/// The status seed / level_info keep boot-time values until the next reload —
/// terrain is what actually swaps.
async fn reset(server: &Arc<Server>, mode: &str, seed_override: Option<u64>) {
    use pumpkin_world::generation::generator::FlatLayer;
    let world = server.worlds.load()[0].clone();
    let level = world.level.clone();

    let seed = seed_override.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64 ^ (d.as_secs() << 20))
            .unwrap_or(42)
    });
    let (is_flat, layers) = match mode {
        "void" => (
            true,
            vec![FlatLayer {
                block: "minecraft:bedrock".to_string(),
                height: 1,
            }],
        ),
        "flat" => (
            true,
            vec![
                FlatLayer {
                    block: "minecraft:bedrock".to_string(),
                    height: 1,
                },
                FlatLayer {
                    block: "minecraft:dirt".to_string(),
                    height: 2,
                },
                FlatLayer {
                    block: "minecraft:grass_block".to_string(),
                    height: 1,
                },
            ],
        ),
        _ => (false, Vec::new()),
    };
    level.lantern_swap_generator(
        pumpkin_util::world_seed::Seed(seed),
        is_flat,
        layers,
        "minecraft:plains".to_string(),
    );

    // Forget everything the old world left behind: stored region files, the
    // schematic paste ledger, and — crucially — the scheduler's completed-
    // chunk state (without this, re-requested chunks are considered already
    // done and their listeners hang forever).
    let _ = std::fs::remove_dir_all("world");
    let _ = std::fs::remove_file("schem_prev.bin");
    level
        .lantern_drop_all_chunks
        .store(true, std::sync::atomic::Ordering::Relaxed);
    {
        let mut loading = level.chunk_loading.lock().unwrap();
        loading.send_change(); // wake the scheduler so it processes the drop
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
    // Second tap: anything mid-pipeline during the first wipe (commonly the
    // chunk under a player) has landed by now — wipe it too so nothing keeps
    // serving old terrain.
    level
        .lantern_drop_all_chunks
        .store(true, std::sync::atomic::Ordering::Relaxed);
    {
        let mut loading = level.chunk_loading.lock().unwrap();
        loading.send_change();
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    tracing::info!("worldswap: generator reset to \"{mode}\" (seed {seed}) — regenerating…");
    crate::metrics::set_activity(&format!("generating a fresh \"{mode}\" world…"));
    swap(server).await;
}

/// Old-version world zip: run it through nucleation's DataConverter
/// (PaperMC port — block states, block entities, items, entities), re-emit
/// current-version world files into ./world, then hot-swap. Bounded to a
/// sane volume: the conversion holds every block in memory.
async fn convert_and_swap(server: &Arc<Server>, zip: &[u8]) {
    tracing::info!(
        "worldswap: converting {} KiB old-version world with nucleation's DataConverter…",
        zip.len() / 1024
    );
    crate::metrics::set_activity("upgrading old world with the DataConverter…");
    const R: i32 = 512; // ±32 chunks around origin — memory-bounded
    let mut schem =
        match nucleation::formats::world::from_world_zip_bounded(zip, -R, -64, -R, R, 320, R) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("worldswap: convert failed reading old world: {e}");
                return;
            }
        };
    let from = schem.metadata.source_data_version.unwrap_or(0);
    schem.convert_to_canonical();
    tracing::info!(
        "worldswap: DataVersion {from} → {} — writing world files…",
        nucleation::dataconverter::CANONICAL_DATA_VERSION
    );
    let files = match nucleation::formats::world::to_world(&schem, None) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("worldswap: convert failed writing world: {e}");
            return;
        }
    };
    let _ = std::fs::remove_dir_all("world");
    for (path, data) in &files {
        let full = format!("world/{path}");
        if let Some(parent) = std::path::Path::new(&full).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::write(&full, data) {
            tracing::warn!("worldswap: write {full}: {e}");
        }
    }
    tracing::info!("worldswap: wrote {} converted files", files.len());
    swap(server).await;
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
                if frame.starts_with(b"convert:") {
                    convert_and_swap(&server, &frame["convert:".len()..]).await;
                } else {
                    let cmd = String::from_utf8_lossy(&frame).trim().to_string();
                    if cmd == "swap" {
                        swap(&server).await;
                    } else if let Some(rest) = cmd.strip_prefix("reset ") {
                        let mut it = rest.trim().split_whitespace();
                        let mode = it.next().unwrap_or("normal").to_string();
                        let seed = it.next().and_then(|s| s.parse::<u64>().ok());
                        reset(&server, &mode, seed).await;
                    } else {
                        tracing::warn!("worldswap: unknown command {cmd:?}");
                    }
                }
            }
        }
    });
}
