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

/// True while swap() is rebuilding player view areas — the streamed-gen
/// counter stays quiet then so the two progress messages don't fight.
static RESENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

async fn swap(server: &Arc<Server>, clear_cache: bool) {
    let world = server.worlds.load()[0].clone();
    let level = world.level.clone();

    // Only file-based swaps (world zip / convert) clear the cache: the next
    // fetch must re-read from disk. Generator resets already wiped + replayed
    // through the scheduler — clearing here would orphan the freshly
    // regenerated chunks (Full holders, empty public map, no transition left
    // to fire) and hang every resend fetch.
    if clear_cache {
        let purged = level.loaded_chunks.len();
        level.loaded_chunks.clear();
        tracing::info!("worldswap: dropped {purged} cached chunks");
    }

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
    RESENDING.store(true, std::sync::atomic::Ordering::Relaxed);
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
    RESENDING.store(false, std::sync::atomic::Ordering::Relaxed);
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
    swap(server, false).await;
}

/// Nucleation ChunkSource streaming worlds. Payload JSON:
///   {"kind":"sdf","program":{...},"block":"minecraft:stone","minY":-64,"maxY":320}
///   {"kind":"cellular","program":{...},"block":...,"minY":..,"maxY":..,
///    "cell":48,"seed":1,"presence":[2,3]}
///   {"kind":"osm","footprints":[...geojson-ish...],"base":"minecraft:grass_block"}
/// Chunks are produced on demand by nucleation and written into the world by
/// the fork's chunk_fill generator — infinite, streamed as explored.
async fn reset_chunk_source(server: &Arc<Server>, payload: &[u8]) {
    use nucleation::building::{BrushEnum, SolidBrush};
    use nucleation::world_generation::{
        CellularSdfChunkSource, CellularSdfConfig, ChunkRequest, ChunkSource,
        ProjectedFootprintChunkSource, SdfChunkSource, SourceProvenance,
    };

    let world = server.worlds.load()[0].clone();
    let level = world.level.clone();
    let v: serde_json::Value = match serde_json::from_slice(payload) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("worldswap: chunksrc payload is not JSON: {e}");
            return;
        }
    };
    let kind = v["kind"].as_str().unwrap_or("sdf").to_string();
    let provenance = match SourceProvenance::new("lantern", "1") {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("worldswap: provenance: {e:?}");
            return;
        }
    };
    let brush = |name: &str| {
        BrushEnum::Solid(SolidBrush::new(nucleation::BlockState::new(
            name.to_string(),
        )))
    };
    let min_y = v["minY"].as_i64().unwrap_or(-64) as i32;
    let max_y = v["maxY"].as_i64().unwrap_or(120) as i32;
    let block = v["block"].as_str().unwrap_or("minecraft:stone").to_string();

    let source: std::sync::Arc<dyn ChunkSource> = match kind.as_str() {
        // Full layered composite (e.g. the infinite riverfall manifest):
        // layers of sdf/cellular sources with solid or field3 brushes.
        "composite" => {
            use nucleation::building::{BlockPalette, FieldBrush, GradientStop};
            use nucleation::world_generation::{ChunkOverlayMode, CompositeChunkSource};
            let build_brush = |b: &serde_json::Value| -> Option<BrushEnum> {
                match b["kind"].as_str()? {
                    "solid" => Some(BrushEnum::Solid(SolidBrush::new(
                        nucleation::BlockState::new(b["block"].as_str()?.to_string()),
                    ))),
                    "field3" => {
                        let field: nucleation::field::Field3 =
                            serde_json::from_value(b["field"].clone()).ok()?;
                        let stops: Vec<f32> = b["stops"]
                            .as_array()?
                            .iter()
                            .filter_map(|x| x.as_f64().map(|f| f as f32))
                            .collect();
                        let colors: Vec<u8> = b["colors"]
                            .as_array()?
                            .iter()
                            .filter_map(|x| x.as_u64().map(|c| c as u8))
                            .collect();
                        let gstops: Vec<GradientStop> = stops
                            .iter()
                            .zip(colors.chunks_exact(3))
                            .map(|(pos, c)| GradientStop {
                                position: f64::from(*pos),
                                color: nucleation::blockpedia::ExtendedColorData::from_rgb(
                                    c[0], c[1], c[2],
                                ),
                            })
                            .collect();
                        let space = match b["space"].as_str().unwrap_or("Oklab") {
                            "Rgb" => nucleation::building::InterpolationSpace::Rgb,
                            _ => nucleation::building::InterpolationSpace::Oklab,
                        };
                        let mut brush = FieldBrush::from_field3(
                            field,
                            gstops,
                            b["lo"].as_f64().unwrap_or(-1.0),
                            b["hi"].as_f64().unwrap_or(1.0),
                        )
                        .ok()?
                        .with_space(space);
                        if let Some(ids) = b["palette"].as_array() {
                            let ids: Vec<String> = ids
                                .iter()
                                .filter_map(|x| x.as_str().map(str::to_string))
                                .collect();
                            brush.set_palette(std::sync::Arc::new(
                                BlockPalette::from_block_ids(ids.iter().map(String::as_str)),
                            ));
                        }
                        Some(BrushEnum::Field(brush))
                    }
                    _ => None,
                }
            };
            let world_seed = v["seed"].as_u64().unwrap_or(0);
            let mut composite = CompositeChunkSource::new(provenance);
            let mut added = 0usize;
            for layer in v["layers"].as_array().cloned().unwrap_or_default() {
                let Some(brush) = build_brush(&layer["brush"]) else {
                    tracing::warn!("worldswap: composite layer {:?} brush rejected", layer["name"]);
                    continue;
                };
                let volume =
                    match nucleation::sdf::SdfNode::from_json(&layer["volume"].to_string()) {
                        Ok(n) => n,
                        Err(e) => {
                            tracing::warn!("worldswap: composite layer sdf rejected: {e}");
                            continue;
                        }
                    };
                let (lmin, lmax) = (
                    layer["minY"].as_i64().unwrap_or(-32) as i32,
                    layer["maxY"].as_i64().unwrap_or(120) as i32,
                );
                let Ok(prov) = SourceProvenance::new("lantern-layer", "1") else {
                    continue;
                };
                let src: std::sync::Arc<dyn ChunkSource> = if layer["type"] == "cellular" {
                    let c = &layer["config"];
                    let cfg = CellularSdfConfig {
                        cell_size_x: c["cellX"].as_i64().unwrap_or(192) as i32,
                        cell_size_z: c["cellZ"].as_i64().unwrap_or(160) as i32,
                        // XOR with the world seed: same authored scene,
                        // different placements/rotations/scales per world.
                        seed: c["seed"].as_u64().unwrap_or(1) ^ world_seed,
                        max_jitter_x: c["jitterX"].as_f64().unwrap_or(0.0) as f32,
                        max_jitter_z: c["jitterZ"].as_f64().unwrap_or(0.0) as f32,
                        max_yaw_degrees: c["yaw"].as_f64().unwrap_or(0.0) as f32,
                        min_scale: c["minScale"].as_f64().unwrap_or(1.0) as f32,
                        max_scale: c["maxScale"].as_f64().unwrap_or(1.0) as f32,
                        min_y_offset: c["minYOff"].as_i64().unwrap_or(0) as i32,
                        max_y_offset: c["maxYOff"].as_i64().unwrap_or(0) as i32,
                        presence_numerator: c["presenceN"].as_u64().unwrap_or(1) as u32,
                        presence_denominator: c["presenceD"].as_u64().unwrap_or(1) as u32,
                        feature_salt: c["salt"].as_u64().unwrap_or(0),
                        ..Default::default()
                    };
                    match CellularSdfChunkSource::new(volume, brush, lmin, lmax, cfg, prov) {
                        Ok(s) => std::sync::Arc::new(s),
                        Err(e) => {
                            tracing::warn!("worldswap: cellular layer rejected: {e:?}");
                            continue;
                        }
                    }
                } else {
                    match SdfChunkSource::new(volume, brush, lmin, lmax, prov) {
                        Ok(s) => std::sync::Arc::new(s),
                        Err(e) => {
                            tracing::warn!("worldswap: sdf layer rejected: {e:?}");
                            continue;
                        }
                    }
                };
                if composite.add_layer(src, ChunkOverlayMode::Replace).is_err() {
                    tracing::warn!("worldswap: composite layer cap reached");
                    break;
                }
                added += 1;
            }
            tracing::info!("worldswap: composite source with {added} layers");
            std::sync::Arc::new(composite)
        }
        "cellular" => {
            let node = match nucleation::sdf::SdfNode::from_json(&v["program"].to_string()) {
                Ok(n) => n,
                Err(e) => {
                    tracing::warn!("worldswap: chunksrc sdf rejected: {e}");
                    return;
                }
            };
            let mut cfg = CellularSdfConfig::default();
            if let Some(c) = v["cell"].as_i64() {
                cfg.cell_size_x = c as i32;
                cfg.cell_size_z = c as i32;
            }
            if let Some(seed) = v["seed"].as_u64() {
                cfg.seed = seed;
            }
            if let (Some(n), Some(d)) = (v["presence"][0].as_u64(), v["presence"][1].as_u64()) {
                cfg.presence_numerator = n as u32;
                cfg.presence_denominator = d as u32;
            }
            match CellularSdfChunkSource::new(node, brush(&block), min_y, max_y, cfg, provenance) {
                Ok(s) => std::sync::Arc::new(s),
                Err(e) => {
                    tracing::warn!("worldswap: cellular source rejected: {e:?}");
                    return;
                }
            }
        }
        "osm" => {
            let footprints =
                match nucleation::geo::parse_footprints_json(&v["footprints"].to_string()) {
                    Ok(f) => f,
                    Err(e) => {
                        tracing::warn!("worldswap: footprints rejected: {e}");
                        return;
                    }
                };
            let base = v["base"].as_str().map(str::to_string);
            let count = footprints.len();
            match ProjectedFootprintChunkSource::new(footprints, base, provenance) {
                Ok(s) => {
                    tracing::info!("worldswap: OSM source ready ({count} footprints)");
                    std::sync::Arc::new(s)
                }
                Err(e) => {
                    tracing::warn!("worldswap: osm source rejected: {e:?}");
                    return;
                }
            }
        }
        _ => {
            let node = match nucleation::sdf::SdfNode::from_json(&v["program"].to_string()) {
                Ok(n) => n,
                Err(e) => {
                    tracing::warn!("worldswap: chunksrc sdf rejected: {e}");
                    return;
                }
            };
            match SdfChunkSource::new(node, brush(&block), min_y, max_y, provenance) {
                Ok(s) => std::sync::Arc::new(s),
                Err(e) => {
                    tracing::warn!("worldswap: sdf source rejected: {e:?}");
                    return;
                }
            }
        }
    };

    // Optional terrain grid (OSM worlds): flat i32 heights row-major,
    // sampled every `step` blocks, origin at world (originX, originZ).
    struct Terrain {
        heights: Vec<i32>,
        width: i32,
        depth: i32,
        origin_x: i32,
        origin_z: i32,
        step: i32,
        surface: u16,
        dirt: u16,
        sub: u16,
    }
    let terrain: Option<Terrain> = v["terrain"].as_object().and_then(|t| {
        let heights: Vec<i32> = t
            .get("heights")?
            .as_array()?
            .iter()
            .filter_map(|x| x.as_i64().map(|n| n as i32))
            .collect();
        let width = t.get("width")?.as_i64()? as i32;
        if width <= 0 || heights.len() < width as usize {
            return None;
        }
        let resolve = |name: &str, def: &str| {
            use pumpkin_world::generation::structure::template::{
                BlockStateResolver, PaletteEntry,
            };
            let e = PaletteEntry::with_properties(name.to_string(), Vec::new());
            BlockStateResolver::resolve_simple(&e).map_or_else(
                || {
                    let e = PaletteEntry::with_properties(def.to_string(), Vec::new());
                    BlockStateResolver::resolve_simple(&e).map_or(0, |s| s.id.as_u16())
                },
                |s| s.id.as_u16(),
            )
        };
        Some(Terrain {
            depth: heights.len() as i32 / width,
            heights,
            width,
            origin_x: t.get("originX").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
            origin_z: t.get("originZ").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
            step: t.get("step").and_then(|x| x.as_i64()).unwrap_or(2).max(1) as i32,
            surface: resolve(
                t.get("surface").and_then(|x| x.as_str()).unwrap_or("minecraft:grass_block"),
                "minecraft:grass_block",
            ),
            dirt: resolve("minecraft:dirt", "minecraft:dirt"),
            sub: resolve(
                t.get("sub").and_then(|x| x.as_str()).unwrap_or("minecraft:stone"),
                "minecraft:stone",
            ),
        })
    });
    if terrain.is_some() {
        tracing::info!("worldswap: terrain heightmap attached");
    }

    // nucleation blocks -> pumpkin state ids, memoized per descriptor.
    let fill = std::sync::Arc::new(move |cx: i32, cz: i32| {
        use pumpkin_world::generation::structure::template::{BlockStateResolver, PaletteEntry};
        use std::cell::RefCell;
        thread_local! {
            static CACHE: RefCell<std::collections::HashMap<String, u16>> =
                RefCell::new(std::collections::HashMap::new());
        }
        static GENERATED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = GENERATED.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        if n % 4 == 0 && !RESENDING.load(std::sync::atomic::Ordering::Relaxed) {
            crate::metrics::set_activity(&format!("streaming world — {n} chunks generated"));
        }
        let result = match source.generate(ChunkRequest::new(cx, cz)) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("chunksrc: generate ({cx},{cz}): {e:?}");
                return Vec::new();
            }
        };
        let mut out = Vec::new();
        if let Some(t) = &terrain {
            // Bilinear-free nearest sample: terrain grid step is small enough
            // that per-column nearest lookup reads fine in-game.
            for bx in 0..16 {
                for bz in 0..16 {
                    let wx = cx * 16 + bx;
                    let wz = cz * 16 + bz;
                    let gx = ((wx - t.origin_x) / t.step).clamp(0, t.width - 1);
                    let gz = ((wz - t.origin_z) / t.step).clamp(0, t.depth - 1);
                    let h = t.heights[(gz * t.width + gx) as usize].max(1);
                    for y in 1..=h {
                        let id = if y == h {
                            t.surface
                        } else if y >= h - 3 {
                            t.dirt
                        } else {
                            t.sub
                        };
                        out.push((wx, y, wz, id));
                    }
                }
            }
        }
        for (x, y, z, state) in result.chunk().blocks() {
            let key = format!("{state:?}");
            let id = CACHE.with(|c| {
                if let Some(id) = c.borrow().get(&key) {
                    return *id;
                }
                let entry = PaletteEntry::with_properties(
                    state.name.to_string(),
                    state
                        .properties
                        .iter()
                        .map(|(k, val)| (k.to_string(), val.to_string()))
                        .collect(),
                );
                let id = BlockStateResolver::resolve_simple(&entry)
                    .map_or(0, |s| s.id.as_u16());
                c.borrow_mut().insert(key.clone(), id);
                id
            });
            if id != 0 {
                out.push((x, y, z, id));
            }
        }
        out
    });

    level.lantern_swap_generator_chunks(
        pumpkin_util::world_seed::Seed(0),
        fill,
        "minecraft:plains".to_string(),
    );
    let _ = std::fs::remove_dir_all("world");
    let _ = std::fs::remove_file("schem_prev.bin");
    for _ in 0..2 {
        level
            .lantern_drop_all_chunks
            .store(true, std::sync::atomic::Ordering::Relaxed);
        level.chunk_loading.lock().unwrap().send_change();
        tokio::time::sleep(Duration::from_millis(125)).await;
    }
    tracing::info!("worldswap: chunk-source world active (kind {kind}) — streaming as explored");
    crate::metrics::set_activity("generating streamed world…");
    swap(server, false).await;
}

/// SDF world: payload is JSON {"block":"minecraft:stone","scale":1.0,
/// "y":0,"program":{...sdf node json...}} — nucleation validates the program
/// (sandboxed, provably terminating), and blocks exist wherever the field is
/// <= 0. Rides the same live-swap flow as every other reset.
async fn reset_sdf(server: &Arc<Server>, payload: &[u8]) {
    let world = server.worlds.load()[0].clone();
    let level = world.level.clone();

    let wrapper: serde_json::Value = match serde_json::from_slice(payload) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("worldswap: sdf payload is not JSON: {e}");
            return;
        }
    };
    let program_json = wrapper["program"].to_string();
    let program = match nucleation::sdf::SdfNode::from_json(&program_json) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("worldswap: sdf program rejected: {e}");
            return;
        }
    };
    let block_name = wrapper["block"].as_str().unwrap_or("minecraft:stone");
    let scale = wrapper["scale"].as_f64().unwrap_or(1.0) as f32;
    let y_off = wrapper["y"].as_i64().unwrap_or(0) as f32;
    let state = pumpkin_data::Block::from_name(
        block_name.strip_prefix("minecraft:").unwrap_or(block_name),
    )
    .map_or(pumpkin_data::Block::STONE.default_state, |b| b.default_state);

    let density = std::sync::Arc::new(move |x: i32, y: i32, z: i32| {
        let d = program.eval(x as f32 * scale, (y as f32 - y_off) * scale, z as f32 * scale);
        (d <= 0.0).then_some(state)
    });
    level.lantern_swap_generator_density(
        pumpkin_util::world_seed::Seed(0),
        density,
        "minecraft:plains".to_string(),
    );
    let _ = std::fs::remove_dir_all("world");
    let _ = std::fs::remove_file("schem_prev.bin");
    level
        .lantern_drop_all_chunks
        .store(true, std::sync::atomic::Ordering::Relaxed);
    level.chunk_loading.lock().unwrap().send_change();
    tokio::time::sleep(Duration::from_millis(150)).await;
    level
        .lantern_drop_all_chunks
        .store(true, std::sync::atomic::Ordering::Relaxed);
    level.chunk_loading.lock().unwrap().send_change();
    tokio::time::sleep(Duration::from_millis(100)).await;
    tracing::info!("worldswap: SDF world active ({block_name}, scale {scale}) — regenerating…");
    crate::metrics::set_activity("generating SDF world…");
    swap(server, false).await;
}

// ── Earth streamer: dynamic real-world regions ────────────────────────────
// docs/earth-streamer.md. Regions are 512-block squares; the page fetches
// them on demand (surfaced via metrics "earth_needed") and pushes them back
// as "region:" frames.

pub const EARTH_REGION: i32 = 512;

struct EarthRegion {
    heights: Vec<i32>,
    width: i32,
    depth: i32,
    step: i32,
    surface: u16,
    dirt: u16,
    sub: u16,
    water: u16,
    water_y: i32,
    source: Option<nucleation::world_generation::ProjectedFootprintChunkSource>,
}

#[derive(Default)]
struct EarthState {
    regions: std::collections::HashMap<(i32, i32), EarthRegion>,
    needed: std::collections::BTreeSet<(i32, i32)>,
}

static EARTH: std::sync::Mutex<Option<EarthState>> = std::sync::Mutex::new(None);

/// Regions the generator wants but doesn't have — polled into metrics.
pub fn earth_needed() -> Vec<(i32, i32)> {
    EARTH
        .lock()
        .unwrap()
        .as_ref()
        .map(|e| e.needed.iter().copied().take(6).collect())
        .unwrap_or_default()
}

fn resolve_block(name: &str) -> u16 {
    use pumpkin_world::generation::structure::template::{BlockStateResolver, PaletteEntry};
    let e = PaletteEntry::with_properties(name.to_string(), Vec::new());
    BlockStateResolver::resolve_simple(&e).map_or(0, |s| s.id.as_u16())
}

async fn earth_start(server: &Arc<Server>, payload: &[u8]) {
    let world = server.worlds.load()[0].clone();
    let level = world.level.clone();
    let v: serde_json::Value = match serde_json::from_slice(payload) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("earth: bad payload: {e}");
            return;
        }
    };
    *EARTH.lock().unwrap() = Some(EarthState::default());
    tracing::info!(
        "earth: world anchored at {} {} — regions stream as explored",
        v["lat"], v["lon"]
    );

    let fill = std::sync::Arc::new(move |cx: i32, cz: i32| {
        let rx = (cx * 16).div_euclid(EARTH_REGION);
        let rz = (cz * 16).div_euclid(EARTH_REGION);
        let mut guard = EARTH.lock().unwrap();
        let Some(state) = guard.as_mut() else { return Vec::new() };
        let Some(region) = state.regions.get(&(rx, rz)) else {
            state.needed.insert((rx, rz));
            return Vec::new();
        };
        let mut out = Vec::new();
        let (ox, oz) = (rx * EARTH_REGION, rz * EARTH_REGION);
        for bx in 0..16 {
            for bz in 0..16 {
                let wx = cx * 16 + bx;
                let wz = cz * 16 + bz;
                let gx = ((wx - ox) / region.step).clamp(0, region.width - 1);
                let gz = ((wz - oz) / region.step).clamp(0, region.depth - 1);
                let h = region.heights[(gz * region.width + gx) as usize].max(1);
                for y in 1..=h.max(region.water_y) {
                    let id = if y > h {
                        region.water
                    } else if y == h {
                        if h <= region.water_y { region.sub } else { region.surface }
                    } else if y >= h - 3 {
                        region.dirt
                    } else {
                        region.sub
                    };
                    if id != 0 {
                        out.push((wx, y, wz, id));
                    }
                }
            }
        }
        if let Some(src) = &region.source {
            use nucleation::world_generation::{ChunkRequest, ChunkSource};
            if let Ok(res) = src.generate(ChunkRequest::new(cx, cz)) {
                for (x, y, z, st) in res.chunk().blocks() {
                    let id = resolve_block(&format!(
                        "{}{}",
                        st.name,
                        "" // properties ignored for footprint blocks (plain blocks)
                    ));
                    if id != 0 {
                        out.push((x, y, z, id));
                    }
                }
            }
        }
        out
    });
    level.lantern_swap_generator_chunks(
        pumpkin_util::world_seed::Seed(0),
        fill,
        "minecraft:plains".to_string(),
    );
    let _ = std::fs::remove_dir_all("world");
    let _ = std::fs::remove_file("schem_prev.bin");
    for _ in 0..2 {
        level
            .lantern_drop_all_chunks
            .store(true, std::sync::atomic::Ordering::Relaxed);
        level.chunk_loading.lock().unwrap().send_change();
        tokio::time::sleep(Duration::from_millis(125)).await;
    }
    crate::metrics::set_activity("earth world — waiting for first regions…");
    swap(server, false).await;
}

async fn earth_region(server: &Arc<Server>, payload: &[u8]) {
    let v: serde_json::Value = match serde_json::from_slice(payload) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("earth: bad region payload: {e}");
            return;
        }
    };
    let (rx, rz) = (
        v["rx"].as_i64().unwrap_or(0) as i32,
        v["rz"].as_i64().unwrap_or(0) as i32,
    );
    let heights: Vec<i32> = v["heights"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_i64().map(|n| n as i32)).collect())
        .unwrap_or_default();
    let width = v["width"].as_i64().unwrap_or(0) as i32;
    if width <= 0 || heights.is_empty() {
        tracing::warn!("earth: region {rx},{rz} has no terrain");
        return;
    }
    let source = v["footprints"].as_array().and_then(|f| {
        if f.is_empty() {
            return None;
        }
        let fps = nucleation::geo::parse_footprints_json(&v["footprints"].to_string()).ok()?;
        let prov = nucleation::world_generation::SourceProvenance::new("earth", "1").ok()?;
        nucleation::world_generation::ProjectedFootprintChunkSource::new(fps, None, prov).ok()
    });
    let region = EarthRegion {
        depth: heights.len() as i32 / width,
        heights,
        width,
        step: v["step"].as_i64().unwrap_or(2) as i32,
        surface: resolve_block(v["surface"].as_str().unwrap_or("minecraft:grass_block")),
        dirt: resolve_block("minecraft:dirt"),
        sub: resolve_block("minecraft:stone"),
        water: resolve_block("minecraft:water"),
        water_y: v["waterY"].as_i64().unwrap_or(0) as i32,
        source,
    };
    let buildings = v["footprints"].as_array().map_or(0, Vec::len);
    {
        let mut guard = EARTH.lock().unwrap();
        if let Some(state) = guard.as_mut() {
            state.regions.insert((rx, rz), region);
            state.needed.remove(&(rx, rz));
            tracing::info!(
                "earth: region {rx},{rz} loaded ({buildings} features, {} cached)",
                state.regions.len()
            );
        } else {
            return;
        }
    }
    // Re-generate the placeholder chunks now that real data exists.
    let world = server.worlds.load()[0].clone();
    let level = world.level.clone();
    level
        .lantern_drop_all_chunks
        .store(true, std::sync::atomic::Ordering::Relaxed);
    level.chunk_loading.lock().unwrap().send_change();
    tokio::time::sleep(Duration::from_millis(150)).await;
    swap(server, false).await;
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
    swap(server, true).await;
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
                if frame.starts_with(b"earth:") {
                    earth_start(&server, &frame["earth:".len()..]).await;
                } else if frame.starts_with(b"region:") {
                    earth_region(&server, &frame["region:".len()..]).await;
                } else if frame.starts_with(b"chunksrc:") {
                    reset_chunk_source(&server, &frame["chunksrc:".len()..]).await;
                } else if frame.starts_with(b"sdf:") {
                    reset_sdf(&server, &frame["sdf:".len()..]).await;
                } else if frame.starts_with(b"convert:") {
                    convert_and_swap(&server, &frame["convert:".len()..]).await;
                } else {
                    let cmd = String::from_utf8_lossy(&frame).trim().to_string();
                    if cmd == "swap" {
                        swap(&server, true).await;
                    } else if let Some(n) = cmd.strip_prefix("viewdist ") {
                        if let Ok(n) = n.trim().parse::<u8>() {
                            let n = n.clamp(2, 16);
                            pumpkin::world::chunker::LANTERN_VIEW_DISTANCE
                                .store(n, std::sync::atomic::Ordering::Relaxed);
                            tracing::info!(
                                "worldswap: view distance set to {n} (players may need to move a chunk to trigger streaming)"
                            );
                        }
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
