//! lantern × Nucleation: schematics as worlds, hot-swappable.
//!
//! Boot: the page mounts schematic bytes at `./import.schem`; they're pasted
//! once the scheduler is up. Live: the page pushes replacement schematics as
//! `[u32 BE len][bytes]` frames over `schem.sock` — the previous build's
//! exact block positions (persisted in `schem_prev.bin`, so it survives
//! reloads) are cleared, the new one is pasted, and every affected chunk is
//! re-sent to connected Java clients so the swap is visible immediately.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use pumpkin::net::ClientPlatform;
use pumpkin::server::Server;
use pumpkin_data::Block;
use pumpkin_protocol::java::client::play::{CChunkBatchEnd, CChunkBatchStart, CChunkData};
use pumpkin_util::math::position::BlockPos;
use pumpkin_util::math::vector2::Vector2;
use pumpkin_util::math::vector3::Vector3;
use pumpkin_world::generation::structure::template::{BlockStateResolver, PaletteEntry};

const IMPORT_PATH: &str = "import.schem";
const PREV_POSITIONS_PATH: &str = "schem_prev.bin";
const LIVE_SOCK: &str = "schem.sock";

/// Paste height: default sits one above the void-world bedrock floor; the
/// page overrides via LANTERN_SCHEM_Y for other generators.
fn base_y() -> i32 {
    std::env::var("LANTERN_SCHEM_Y")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(-63)
}

fn load_prev_positions() -> Vec<(i32, i32, i32)> {
    let Ok(bytes) = std::fs::read(PREV_POSITIONS_PATH) else {
        return Vec::new();
    };
    bytes
        .chunks_exact(12)
        .map(|c| {
            (
                i32::from_be_bytes([c[0], c[1], c[2], c[3]]),
                i32::from_be_bytes([c[4], c[5], c[6], c[7]]),
                i32::from_be_bytes([c[8], c[9], c[10], c[11]]),
            )
        })
        .collect()
}

fn save_prev_positions(positions: &[(i32, i32, i32)]) {
    let mut out = Vec::with_capacity(positions.len() * 12);
    for (x, y, z) in positions {
        out.extend_from_slice(&x.to_be_bytes());
        out.extend_from_slice(&y.to_be_bytes());
        out.extend_from_slice(&z.to_be_bytes());
    }
    if let Err(e) = std::fs::write(PREV_POSITIONS_PATH, &out) {
        tracing::warn!("schematic: failed to persist paste positions: {e}");
    }
}

/// Parse the schematic formats we accept: sponge .schem, .litematic, and
/// legacy MCEdit .schematic. Detection by content, not filename.
/// (Deliberately NOT nucleation's FormatManager: registering every importer
/// links in the world/zip readers, and that binary hangs at startup on the
/// wasm target — see README gotchas.)
pub(crate) fn parse_any(bytes: &[u8]) -> Result<nucleation::UniversalSchematic, String> {
    use nucleation::formats::{classic_schematic, litematic};
    if litematic::is_litematic(bytes) {
        tracing::info!("schematic: detected format \"litematic\"");
        return litematic::from_litematic(bytes).map_err(|e| format!("{e}"));
    }
    if classic_schematic::is_classic_schematic(bytes) {
        tracing::info!("schematic: detected format \"classic schematic\"");
        return classic_schematic::from_classic_schematic(bytes).map_err(|e| format!("{e}"));
    }
    nucleation::UniversalSchematic::from_schematic(bytes).map_err(|e| format!("{e}"))
}

async fn paste(server: &Arc<Server>, bytes: &[u8], off: (i32, i32, i32)) {
    tracing::info!("schematic: parsing {} KiB…", bytes.len() / 1024);
    let schem = match parse_any(bytes) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("schematic: parse failed: {e}");
            return;
        }
    };

    crate::sim::set_source(bytes.to_vec(), off);
    if let Ok(s) = parse_any(bytes) {
        let bb = s.get_bounding_box();
        crate::sim::set_region(
            (bb.min.0 + off.0, bb.min.1 + off.1, bb.min.2 + off.2),
            (bb.max.0 + off.0, bb.max.1 + off.1, bb.max.2 + off.2),
        );
    }
    let world = server.worlds.load()[0].clone();
    let level = world.level.clone();
    let air = Block::AIR.default_state.id;
    let mut touched_chunks: HashSet<(i32, i32)> = HashSet::new();

    // 1. Clear the previous build (exact positions, so player edits and the
    //    floor survive).
    let prev = load_prev_positions();
    if !prev.is_empty() {
        tracing::info!("schematic: clearing previous build ({} blocks)…", prev.len());
        let mut by_chunk: HashMap<(i32, i32), Vec<(i32, i32, i32)>> = HashMap::new();
        for pos in prev {
            by_chunk.entry((pos.0 >> 4, pos.2 >> 4)).or_default().push(pos);
        }
        for ((cx, cz), blocks) in by_chunk {
            level.get_or_fetch_chunk(Vector2::new(cx, cz), |_| ()).await;
            for (x, y, z) in blocks {
                level.set_block_state(&BlockPos(Vector3::new(x, y, z)), air);
            }
            touched_chunks.insert((cx, cz));
        }
    }

    // 2. Paste the new one.
    let mut by_chunk: HashMap<(i32, i32), Vec<(i32, i32, i32, u16)>> = HashMap::new();
    let mut positions = Vec::new();
    let mut unknown = 0usize;
    for (pos, block) in schem.iter_blocks() {
        if block.name.as_str() == "minecraft:air" || block.name.as_str() == "air" {
            continue;
        }
        let entry = PaletteEntry::with_properties(
            block.name.to_string(),
            block
                .properties
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        );
        let Some(state) = BlockStateResolver::resolve_simple(&entry) else {
            unknown += 1;
            continue;
        };
        let (x, y, z) = (pos.x + off.0, pos.y + off.1, pos.z + off.2);
        by_chunk
            .entry((x >> 4, z >> 4))
            .or_default()
            .push((x, y, z, state.id.as_u16()));
        positions.push((x, y, z));
    }

    let total = positions.len();
    tracing::info!(
        "schematic: pasting {total} blocks into {} chunks ({unknown} unknown skipped)…",
        by_chunk.len()
    );
    let start = std::time::Instant::now();
    for ((cx, cz), blocks) in by_chunk {
        level.get_or_fetch_chunk(Vector2::new(cx, cz), |_| ()).await;
        for (x, y, z, state_id) in blocks {
            level.set_block_state(
                &BlockPos(Vector3::new(x, y, z)),
                pumpkin_data::BlockStateId::new_or_air(state_id),
            );
        }
        touched_chunks.insert((cx, cz));
    }
    save_prev_positions(&positions);

    // 3. Re-send every touched chunk so online players see the swap.
    let players = world.players.load();
    if !players.is_empty() {
        for player in players.iter() {
            if let ClientPlatform::Java(java_client) = player.client.as_ref() {
                java_client.send_packet_now(&CChunkBatchStart).await;
                let mut sent = 0u16;
                for (cx, cz) in &touched_chunks {
                    let chunk = level
                        .get_or_fetch_chunk(Vector2::new(*cx, *cz), std::clone::Clone::clone)
                        .await;
                    java_client.send_packet_now(&CChunkData(&chunk)).await;
                    sent += 1;
                }
                java_client.send_packet_now(&CChunkBatchEnd::new(sent)).await;
            }
        }
        tracing::info!(
            "schematic: refreshed {} chunks for {} player(s)",
            touched_chunks.len(),
            players.len()
        );
    }

    tracing::info!(
        "schematic: done — {total} blocks in {:.1}s. Fly to {} {} {}.",
        start.elapsed().as_secs_f64(),
        off.0, off.1, off.2,
    );
}

/// Boot-time import from ./import.schem (mounted by the page pre-boot).
pub fn spawn_import(server: Arc<Server>) {
    let Ok(bytes) = std::fs::read(IMPORT_PATH) else {
        return;
    };
    if bytes.is_empty() {
        return;
    }
    tokio::spawn(async move {
        // Same settle delay the bench uses: a ticket filed in the first
        // instants of the scheduler's life can be missed (init race).
        tokio::time::sleep(Duration::from_secs(2)).await;
        paste(&server, &bytes, (0, base_y(), 0)).await;
    });
}

/// Split an optional LSH1 placement header off a live frame.
fn parse_frame_header(frame: &[u8]) -> ((i32, i32, i32), &[u8]) {
    let default = (0, base_y(), 0);
    if frame.len() < 6 || &frame[..4] != b"LSH1" {
        return (default, frame);
    }
    let hlen = u16::from_be_bytes([frame[4], frame[5]]) as usize;
    if frame.len() < 6 + hlen {
        return (default, frame);
    }
    let hdr = &frame[6..6 + hlen];
    let body = &frame[6 + hlen..];
    let mut xyz = default;
    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(hdr) {
        xyz = (
            v["x"].as_i64().unwrap_or(0) as i32,
            v["y"].as_i64().unwrap_or(i64::from(base_y())) as i32,
            v["z"].as_i64().unwrap_or(0) as i32,
        );
    }
    (xyz, body)
}

/// Live reload: framed schematics pushed by the page over schem.sock.
pub fn spawn_live_reload(server: Arc<Server>) {
    let Ok(fd) = crate::net_bridge::open_socket(LIVE_SOCK) else {
        return;
    };
    tokio::spawn(async move {
        let mut acc: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
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
                // Optional placement header: "LSH1" + u16 BE len + JSON
                // {"x":..,"y":..,"z":..}, then the schematic bytes.
                let (off, body) = parse_frame_header(&frame);
                tracing::info!(
                    "schematic: live reload requested ({} KiB at {} {} {})",
                    body.len() / 1024, off.0, off.1, off.2,
                );
                paste(&server, body, off).await;
            }
        }
    });
}
