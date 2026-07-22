//! lantern-web: browser entry point for Pumpkin.
//!
//! Milestone 1: run Pumpkin's vanilla world generation inside the browser and
//! expose chunk surfaces to JS for rendering. Later milestones wire the full
//! server loop to a virtual network transport.

use wasm_bindgen::prelude::*;

use pumpkin_data::dimension::Dimension;
use pumpkin_data::{Block, BlockStateId};
use pumpkin_util::world_seed::Seed;
use pumpkin_world::ProtoChunk;
use pumpkin_world::chunk_system::{Chunk, StagedChunkEnum, generate_single_chunk};
use pumpkin_world::generation::generator::WorldGenerator;
use pumpkin_world::generation::get_world_gen;
use pumpkin_world::world::WorldPortalExt;

/// Minimal block-registry stand-in, mirroring what pumpkin-world's own
/// benchmarks use to drive generation without a full server.
struct BlockRegistry;

impl WorldPortalExt for BlockRegistry {
    fn can_place_at(
        &self,
        _block: &pumpkin_data::Block,
        _state: &pumpkin_data::BlockState,
        _block_accessor: &dyn pumpkin_world::world::BlockAccessor,
        _block_pos: &pumpkin_util::math::position::BlockPos,
    ) -> bool {
        true
    }

    fn mirror(
        &self,
        block: &pumpkin_data::Block,
        state_id: BlockStateId,
        mirror: pumpkin_data::Mirror,
    ) -> &'static pumpkin_data::BlockState {
        block.mirror(state_id, mirror)
    }

    fn rotate(
        &self,
        block: &pumpkin_data::Block,
        state_id: BlockStateId,
        rotation: pumpkin_data::Rotation,
    ) -> &'static pumpkin_data::BlockState {
        block.rotate(state_id, rotation)
    }

    fn spawn_mobs_for_chunk_generation(
        &self,
        _cache: &mut dyn pumpkin_world::generation::proto_chunk::GenerationCache,
        _biome: &'static pumpkin_data::chunk::Biome,
        _chunk_x: i32,
        _chunk_z: i32,
    ) {
    }
}

#[wasm_bindgen]
pub struct LanternWorld {
    generator: Box<WorldGenerator>,
    registry: BlockRegistry,
    dimension: Dimension,
}

#[wasm_bindgen]
impl LanternWorld {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32) -> Self {
        console_error_panic_hook::set_once();
        Self {
            generator: get_world_gen(
                Seed(u64::from(seed)),
                Dimension::OVERWORLD,
                false,
                Vec::new(),
                String::new(),
            ),
            registry: BlockRegistry,
            dimension: Dimension::OVERWORLD,
        }
    }

    /// Generates a chunk and returns its surface as 16*16*2 i32s in x-major
    /// order: [top_y, block_state_id] per column.
    #[wasm_bindgen]
    pub fn chunk_surface(&self, chunk_x: i32, chunk_z: i32) -> Vec<i32> {
        let chunk = generate_single_chunk(
            &self.dimension,
            0,
            &self.generator,
            &self.registry,
            chunk_x,
            chunk_z,
            StagedChunkEnum::Full,
        );

        let min_y = self.dimension.min_y;
        let height = self.dimension.height;
        let mut out = Vec::with_capacity(16 * 16 * 2);

        for x in 0..16 {
            for z in 0..16 {
                let (top_y, state_id) = match &chunk {
                    Chunk::Proto(proto) => top_block_proto(proto, x, z, height),
                    Chunk::Level(data) => top_block_level(data, x, z, height),
                };
                out.push(top_y + min_y);
                out.push(i32::from(state_id.as_u16()));
            }
        }
        out
    }
}

fn top_block_proto(proto: &ProtoChunk, x: i32, z: i32, height: i32) -> (i32, BlockStateId) {
    for local_y in (0..height).rev() {
        let state_id = proto.get_block_state_raw(x, local_y, z);
        if !pumpkin_data::block_state::BlockState::from_id(state_id).is_air() {
            return (local_y, state_id);
        }
    }
    (0, Block::AIR.default_state.id)
}

fn top_block_level(
    data: &pumpkin_world::chunk::ChunkData,
    x: i32,
    z: i32,
    height: i32,
) -> (i32, BlockStateId) {
    for local_y in (0..height).rev() {
        if let Some(state_id) = data.get_relative_block(x as usize, local_y as usize, z as usize)
            && !pumpkin_data::block_state::BlockState::from_id(state_id).is_air()
        {
            return (local_y, state_id);
        }
    }
    (0, Block::AIR.default_state.id)
}

/// Resolves a block state id to its block name (e.g. "grass_block"), so JS
/// can pick map colors without shipping a registry of its own.
#[wasm_bindgen]
pub fn block_name(state_id: u16) -> String {
    BlockStateId::new_or_air(state_id).to_block().name.to_string()
}

#[wasm_bindgen]
pub fn pumpkin_version() -> String {
    // Keep in sync with the submodule; purely informational for the demo page.
    "pumpkin 0.1.0-dev+26.2 (lantern fork)".to_string()
}
