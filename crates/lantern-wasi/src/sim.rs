//! lantern × mc-tick: Nucleation's vanilla-accurate tick engine as an
//! alternative logic driver for the pasted schematic region.
//!
//! When enabled ("sim on" over sim.sock), the last pasted schematic is loaded
//! into an `mc_tick::Simulation`; a 20 Hz loop steps it, drains the engine's
//! recorded block changes, writes them into the Pumpkin world, and broadcasts
//! `CBlockUpdate`s to connected Java clients — redstone, pistons and entity
//! machinery run on Nucleation's engine while Pumpkin keeps serving the world.
//!
//! The simulation wiring below is vendored from nucleation's bridge
//! (`src/bridge/mc_tick.rs::wire_simulation`, settle mode InWorld) — worth
//! upstreaming into nucleation as a public embed API so this can't drift.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use pumpkin::net::ClientPlatform;
use pumpkin::server::Server;
use pumpkin_protocol::codec::var_int::VarInt;
use pumpkin_protocol::java::client::play::CBlockUpdate;
use pumpkin_util::math::position::BlockPos;
use pumpkin_util::math::vector2::Vector2;
use pumpkin_util::math::vector3::Vector3;
use pumpkin_world::generation::structure::template::{BlockStateResolver, PaletteEntry};

const SIM_SOCK: &str = "sim.sock";

/// The last pasted schematic (raw bytes + world-paste offset), set by schematic.rs.
static SIM_SOURCE: Mutex<Option<(Vec<u8>, (i32, i32, i32))>> = Mutex::new(None);

pub fn set_source(bytes: Vec<u8>, off: (i32, i32, i32)) {
    *SIM_SOURCE.lock().unwrap() = Some((bytes, off));
}

struct RunningSim {
    sim: mc_tick::Simulation,
    /// Schematic bounding-box minimum: engine coords + this = schematic coords.
    min: (i32, i32, i32),
    /// Schematic bounding-box maximum (inclusive).
    max: (i32, i32, i32),
    /// World-paste offset: schematic coords + this = world coords.
    off: (i32, i32, i32),
}

/// The running engine, shared with the fork's player-interaction hook.
static SIM: Mutex<Option<RunningSim>> = Mutex::new(None);
/// Player clicks captured by the hook, drained each engine tick.
static PENDING_USE: Mutex<Vec<(i32, i32, i32)>> = Mutex::new(Vec::new());

fn world_in_region(r: &RunningSim, x: i32, y: i32, z: i32) -> bool {
    let (lo, hi) = (
        (r.min.0 + r.off.0, r.min.1 + r.off.1, r.min.2 + r.off.2),
        (r.max.0 + r.off.0, r.max.1 + r.off.1, r.max.2 + r.off.2),
    );
    x >= lo.0 && x <= hi.0 && y >= lo.1 && y <= hi.1 && z >= lo.2 && z <= hi.2
}

fn parse_descriptor(descriptor: &str) -> PaletteEntry {
    match descriptor.split_once('[') {
        None => PaletteEntry::with_properties(descriptor.to_string(), Vec::new()),
        Some((name, props)) => {
            let props = props
                .trim_end_matches(']')
                .split(',')
                .filter_map(|kv| {
                    kv.split_once('=')
                        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
                })
                .collect();
            PaletteEntry::with_properties(name.to_string(), props)
        }
    }
}

/// Vendored from nucleation's bridge: build a fully-wired Simulation from a
/// schematic, settle mode "in world" (blocks stand as found, nothing re-runs
/// onPlace).
fn build_simulation(bytes: &[u8], off: (i32, i32, i32)) -> Result<RunningSim, String> {
    let schematic = crate::schematic::parse_any(bytes).map_err(|e| format!("parse: {e}"))?;
    let bb = schematic.get_bounding_box();
    let min = (bb.min.0, bb.min.1, bb.min.2);
    let max = (bb.max.0, bb.max.1, bb.max.2);

    let volume = i64::from(bb.max.0 - bb.min.0 + 1)
        * i64::from(bb.max.1 - bb.min.1 + 1)
        * i64::from(bb.max.2 - bb.min.2 + 1);
    if volume > 8_000_000 {
        return Err(format!("{volume} cells is over the 8M-cell engine limit"));
    }

    let snbt = nucleation::formats::gametest::to_gametest_snbt(&schematic);
    let structure = mc_tick::Structure::parse(&snbt).map_err(|e| format!("load: {e:?}"))?;

    use mc_tick::{Pos, Simulation};
    const MARGIN: i32 = 4;
    let mut sim = Simulation::new(structure.bounds(MARGIN));
    {
        let (registry, world) = sim.registry_and_world_mut();
        structure.place(world, registry, Pos::new(0, 0, 0));
    }
    if let Some(version) = schematic.metadata.source_data_version {
        sim.set_motion_semantics(mc_tick::MotionSemantics::for_data_version(version));
    }
    let mut wanted: Vec<String> = vec!["minecraft:redstone_block".to_string()];
    for (_, stacks) in &structure.inventories {
        for stack in stacks {
            wanted.extend(mc_tick::vanilla::dispensable_states(&stack.id));
        }
    }
    for descriptor in &wanted {
        sim.registry_mut()
            .intern(descriptor)
            .map_err(|e| format!("interning {descriptor}: {e:?}"))?;
    }
    for pos in &structure.block_entities {
        sim.mark_block_entity(*pos);
    }
    for (pos, strength) in &structure.comparator_outputs {
        sim.set_comparator_output(*pos, *strength);
    }
    for (pos, stacks) in &structure.inventories {
        let entry = structure
            .blocks
            .iter()
            .find(|(p, _)| p == pos)
            .map(|(_, e)| *e)
            .ok_or_else(|| format!("inventory at {pos:?} with no block"))?;
        let name = structure.palette[entry]
            .split('[')
            .next()
            .unwrap_or_default()
            .to_string();
        let slots = mc_tick::vanilla::container_slots(&name)
            .ok_or_else(|| format!("{name} has an inventory but no slot count"))?;
        sim.set_inventory(
            *pos,
            mc_tick::Inventory {
                slots,
                stacks: stacks.clone(),
            },
        );
    }
    mc_tick::intern_companions(sim.registry_mut());
    {
        let mut table = std::mem::take(sim.behaviours_mut());
        mc_tick::register_all_at(sim.registry_mut(), &mut table, Pos::new(0, 0, 0));
        *sim.behaviours_mut() = table;
    }
    if let Some(report) = sim.unknown_report() {
        return Err(format!("blocks without behaviour: {report}"));
    }
    {
        let (solidity, frictions, heights, webs) =
            mc_tick::vanilla::physics_tables(sim.registry());
        sim.set_physics_tables(solidity, frictions, heights, webs);
        let (water_kinds, bubble_kinds) = mc_tick::vanilla::fluid_tables(sim.registry());
        sim.set_fluid_tables(water_kinds, bubble_kinds);
        let (rails, conductors) = mc_tick::vanilla::rail_tables(sim.registry());
        sim.set_rail_tables(rails, conductors);
    }
    let mut refused: Vec<String> = Vec::new();
    for spawned in &structure.entities {
        match spawned {
            mc_tick::structure::SpawnedEntity::Item(item) => {
                sim.spawn_item(item.item.clone(), item.pos, item.motion, item.pickup_delay);
            }
            mc_tick::structure::SpawnedEntity::Minecart(cart) => {
                let vehicle = sim.spawn_authored_minecart(cart, None);
                for rider in &cart.passengers {
                    if let Err(why) = sim.spawn_authored_rider(vehicle, rider) {
                        refused.push(why);
                    }
                }
            }
            mc_tick::structure::SpawnedEntity::FurnaceMinecart(cart) => {
                if let Err(why) = sim.spawn_authored_furnace_minecart(cart, None) {
                    refused.push(why);
                }
            }
            mc_tick::structure::SpawnedEntity::Body(body) => {
                if let Err(why) = sim.spawn_authored_body(body) {
                    refused.push(why);
                }
            }
        }
    }
    if !refused.is_empty() {
        return Err(format!(
            "{} entities need unimplemented behaviour: {}",
            refused.len(),
            refused.join("; ")
        ));
    }
    for (pos, entry) in &structure.blocks {
        let state = sim.registry().get(&structure.palette[*entry]);
        let is_ticker = state
            .and_then(|s| sim.behaviours().get(s))
            .is_some_and(|b| b.ticks_as_block_entity());
        if is_ticker {
            sim.add_block_entity_ticker(*pos);
        }
    }
    // Settle mode InWorld: no place_on_place, no settle_with_order.
    sim.record();

    Ok(RunningSim { sim, min, max, off })
}

async fn apply_updates(server: &Arc<Server>, updates: &[(i32, i32, i32, u16)]) {
    let world = server.worlds.load()[0].clone();
    let level = world.level.clone();
    let mut sent: Vec<(BlockPos, u16)> = Vec::new();
    for (x, y, z, state_id) in updates {
        level
            .get_or_fetch_chunk(Vector2::new(x >> 4, z >> 4), |_| ())
            .await;
        let block_pos = BlockPos(Vector3::new(*x, *y, *z));
        level.set_block_state(&block_pos, pumpkin_data::BlockStateId::new_or_air(*state_id));
        sent.push((block_pos, *state_id));
    }
    let players = world.players.load();
    for player in players.iter() {
        if let ClientPlatform::Java(java_client) = player.client.as_ref() {
            for (location, state_id) in &sent {
                java_client
                    .send_packet_now(&CBlockUpdate {
                        location: *location,
                        state_id: VarInt(i32::from(*state_id)),
                    })
                    .await;
            }
        }
    }
}

pub fn spawn_control(server: Arc<Server>) {
    let Ok(fd) = crate::net_bridge::open_socket(SIM_SOCK) else {
        return;
    };
    // In-game clicks inside the sim region belong to mc-tick: swallow them
    // from Pumpkin and queue for the next engine tick.
    let _ = pumpkin::LANTERN_USE_BLOCK_HOOK.set(Box::new(|pos| {
        let guard = SIM.lock().unwrap();
        if let Some(r) = guard.as_ref()
            && world_in_region(r, pos.0.x, pos.0.y, pos.0.z)
        {
            PENDING_USE.lock().unwrap().push((pos.0.x, pos.0.y, pos.0.z));
            return true;
        }
        false
    }));
    tokio::spawn(async move {
        let mut acc: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 16 * 1024];
        let mut ticker = tokio::time::interval(Duration::from_millis(50));

        loop {
            ticker.tick().await;

            // Commands from the page.
            let n = crate::net_bridge::fd_read_now(fd, &mut buf);
            if n > 0 {
                acc.extend_from_slice(&buf[..n]);
                while acc.len() >= 4 {
                    let flen = u32::from_be_bytes([acc[0], acc[1], acc[2], acc[3]]) as usize;
                    if acc.len() < 4 + flen {
                        break;
                    }
                    let frame: Vec<u8> = acc.drain(..4 + flen).skip(4).collect();
                    let cmd = String::from_utf8_lossy(&frame).trim().to_string();
                    match cmd.as_str() {
                        "on" => {
                            let source = SIM_SOURCE.lock().unwrap().clone();
                            match source {
                                None => tracing::warn!("sim: no schematic loaded to simulate"),
                                Some((bytes, off)) => match build_simulation(&bytes, off) {
                                    Ok(r) => {
                                        tracing::info!(
                                            "sim: mc-tick engine ON — clicks inside the region are now vanilla-accurate (mc-tick), 20 ticks/s"
                                        );
                                        *SIM.lock().unwrap() = Some(r);
                                    }
                                    Err(e) => tracing::warn!("sim: refused to start: {e}"),
                                },
                            }
                        }
                        "off" => {
                            if SIM.lock().unwrap().take().is_some() {
                                tracing::info!("sim: mc-tick engine OFF (Pumpkin logic only)");
                            }
                        }
                        other => {
                            if let Some(rest) = other.strip_prefix("use ") {
                                let p: Vec<i32> =
                                    rest.split_whitespace().filter_map(|t| t.parse().ok()).collect();
                                if let [x, y, z] = p.as_slice() {
                                    PENDING_USE.lock().unwrap().push((*x, *y, *z));
                                    tracing::info!("sim: use_block queued at {x} {y} {z}");
                                }
                            } else {
                                tracing::warn!("sim: unknown command {other:?}");
                            }
                        }
                    }
                }
            }

            // One engine tick per 50ms while enabled. Resolve block states
            // inside the lock; apply/broadcast (await) outside it.
            let updates: Vec<(i32, i32, i32, u16)> = {
                let mut guard = SIM.lock().unwrap();
                if let Some(r) = guard.as_mut() {
                    for (x, y, z) in PENDING_USE.lock().unwrap().drain(..) {
                        let pos = mc_tick::Pos::new(
                            x - r.min.0 - r.off.0,
                            y - r.min.1 - r.off.1,
                            z - r.min.2 - r.off.2,
                        );
                        r.sim.use_block(pos);
                    }
                    r.sim.step();
                    let changes: Vec<(mc_tick::Pos, mc_tick::StateId)> =
                        r.sim.recorded().iter().map(|c| (c.pos, c.to)).collect();
                    r.sim.record();
                    let mut out = Vec::with_capacity(changes.len());
                    for (pos, state) in changes {
                        let Some(descriptor) = r.sim.registry().descriptor(state) else {
                            continue;
                        };
                        let entry = parse_descriptor(descriptor);
                        let Some(resolved) = BlockStateResolver::resolve_simple(&entry) else {
                            continue;
                        };
                        out.push((
                            pos.x + r.min.0 + r.off.0,
                            pos.y + r.min.1 + r.off.1,
                            pos.z + r.min.2 + r.off.2,
                            resolved.id.as_u16(),
                        ));
                    }
                    out
                } else {
                    Vec::new()
                }
            };
            if !updates.is_empty() {
                apply_updates(&server, &updates).await;
                tracing::info!("sim: applied {} block changes", updates.len());
            }
        }
    });
}
