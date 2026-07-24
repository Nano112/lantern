//! lantern × Nucleation: load a schematic as the world.
//!
//! The page mounts schematic bytes at `./import.schem` (fetched from
//! schemat.io or any URL). Nucleation parses it in-wasm; blocks are pasted
//! into the overworld above the floor, chunk by chunk, through the normal
//! level API so lighting/saving/persistence all apply.

use std::sync::Arc;

use pumpkin::server::Server;
use pumpkin_util::math::position::BlockPos;
use pumpkin_util::math::vector2::Vector2;
use pumpkin_util::math::vector3::Vector3;
use pumpkin_world::generation::structure::template::{BlockStateResolver, PaletteEntry};

const IMPORT_PATH: &str = "import.schem";

/// Paste height. Void floor sits at -64, so -63 is "on the floor"; on noise
/// worlds something higher keeps the build visible. Page overrides via
/// LANTERN_SCHEM_Y.
fn base_y() -> i32 {
    std::env::var("LANTERN_SCHEM_Y")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(100)
}

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
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        tracing::info!("schematic: parsing {} KiB import…", bytes.len() / 1024);
        let schem = match nucleation::UniversalSchematic::from_schematic(&bytes) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("schematic: parse failed: {e}");
                return;
            }
        };

        let base_y = base_y();
        let world = server.worlds.load()[0].clone();
        let level = world.level.clone();

        // Group blocks by chunk so each chunk is fetched (and its ticket held)
        // exactly once while we write into it.
        let mut by_chunk: std::collections::HashMap<(i32, i32), Vec<(i32, i32, i32, u16)>> =
            std::collections::HashMap::new();
        let mut unknown = 0usize;
        let mut total = 0usize;

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
            let (x, y, z) = (pos.x, pos.y + base_y, pos.z);
            by_chunk
                .entry((x >> 4, z >> 4))
                .or_default()
                .push((x, y, z, state.id.as_u16()));
            total += 1;
        }

        let chunk_count = by_chunk.len();
        tracing::info!(
            "schematic: pasting {total} blocks into {chunk_count} chunks ({unknown} unknown skipped)…"
        );
        let start = std::time::Instant::now();

        for ((cx, cz), blocks) in by_chunk {
            // Materialize the chunk (void gen is cheap) and keep it while writing.
            level
                .get_or_fetch_chunk(Vector2::new(cx, cz), |_| ())
                .await;
            for (x, y, z, state_id) in blocks {
                level.set_block_state(
                    &BlockPos(Vector3::new(x, y, z)),
                    pumpkin_data::BlockStateId::new_or_air(state_id),
                );
            }
        }

        tracing::info!(
            "schematic: done — {total} blocks in {:.1}s. Fly to 0 {base_y} 0.",
            start.elapsed().as_secs_f64(),
        );
    });
}
