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
    /// World-paste offset: schematic coords + this = world coords.
    off: (i32, i32, i32),
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

    Ok(RunningSim { sim, min, off })
}

async fn apply_changes(server: &Arc<Server>, running: &mut RunningSim) -> usize {
    let changes: Vec<(mc_tick::Pos, mc_tick::StateId)> = running
        .sim
        .recorded()
        .iter()
        .map(|c| (c.pos, c.to))
        .collect();
    running.sim.record(); // reset the log for the next step
    if changes.is_empty() {
        return 0;
    }

    let world = server.worlds.load()[0].clone();
    let level = world.level.clone();
    let mut updates: Vec<(BlockPos, u16)> = Vec::new();

    for (pos, state) in changes {
        let Some(descriptor) = running.sim.registry().descriptor(state) else {
            continue;
        };
        let entry = parse_descriptor(descriptor);
        let Some(resolved) = BlockStateResolver::resolve_simple(&entry) else {
            continue;
        };
        let wx = pos.x + running.min.0 + running.off.0;
        let wy = pos.y + running.min.1 + running.off.1;
        let wz = pos.z + running.min.2 + running.off.2;
        level.get_or_fetch_chunk(Vector2::new(wx >> 4, wz >> 4), |_| ()).await;
        let block_pos = BlockPos(Vector3::new(wx, wy, wz));
        level.set_block_state(&block_pos, resolved.id);
        updates.push((block_pos, resolved.id.as_u16()));
    }

    let players = world.players.load();
    for player in players.iter() {
        if let ClientPlatform::Java(java_client) = player.client.as_ref() {
            for (location, state_id) in &updates {
                java_client
                    .send_packet_now(&CBlockUpdate {
                        location: *location,
                        state_id: VarInt(i32::from(*state_id)),
                    })
                    .await;
            }
        }
    }
    updates.len()
}

pub fn spawn_control(server: Arc<Server>) {
    let Ok(fd) = crate::net_bridge::open_socket(SIM_SOCK) else {
        return;
    };
    tokio::spawn(async move {
        let mut running: Option<RunningSim> = None;
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
                                            "sim: mc-tick engine ON ({} ticks/s, vanilla phase order)",
                                            20
                                        );
                                        running = Some(r);
                                    }
                                    Err(e) => tracing::warn!("sim: refused to start: {e}"),
                                },
                            }
                        }
                        "off" => {
                            if running.take().is_some() {
                                tracing::info!("sim: mc-tick engine OFF (Pumpkin logic only)");
                            }
                        }
                        other => {
                            if let Some(rest) = other.strip_prefix("use ") {
                                let p: Vec<i32> =
                                    rest.split_whitespace().filter_map(|t| t.parse().ok()).collect();
                                if let (Some(r), [x, y, z]) = (running.as_mut(), p.as_slice()) {
                                    // World coords → engine coords.
                                    let pos = mc_tick::Pos::new(
                                        x - r.min.0 - r.off.0,
                                        y - r.min.1 - r.off.1,
                                        z - r.min.2 - r.off.2,
                                    );
                                    r.sim.use_block(pos);
                                    tracing::info!("sim: use_block at {x} {y} {z}");
                                }
                            } else {
                                tracing::warn!("sim: unknown command {other:?}");
                            }
                        }
                    }
                }
            }

            // One engine tick per 50ms while enabled.
            if let Some(r) = running.as_mut() {
                r.sim.step();
                let applied = apply_changes(&server, r).await;
                if applied > 0 {
                    tracing::info!("sim: tick {} applied {applied} changes", r.sim.tick_count());
                }
            }
        }
    });
}
