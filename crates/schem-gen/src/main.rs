//! Generates a small test schematic (native helper for lantern testing).
fn main() {
    let mut schem = nucleation::UniversalSchematic::new("lantern-test".to_string());
    // 9x9 stone platform with a gold plus and a beacon-ish pillar
    for x in 0..9 {
        for z in 0..9 {
            schem.set_block_str(x, 0, z, "minecraft:stone");
        }
    }
    for i in 0..9 {
        schem.set_block_str(i, 1, 4, "minecraft:gold_block");
        schem.set_block_str(4, 1, i, "minecraft:gold_block");
    }
    for y in 1..6 {
        schem.set_block_str(4, y, 4, "minecraft:diamond_block");
    }
    schem.set_block_str(4, 6, 4, "minecraft:glowstone");
    let bytes = schem.to_schematic().expect("serialize");
    std::fs::write("web/test.schem", &bytes).expect("write");
    println!("wrote web/test.schem ({} bytes)", bytes.len());

    // A self-running contraption for the mc-tick engine test: two observers
    // staring at each other form a clock; dust alongside shows the pulses.
    let mut clock = nucleation::UniversalSchematic::new("lantern-clock".to_string());
    for x in 0..4 {
        for z in 0..3 {
            clock.set_block_str(x, 0, z, "minecraft:smooth_stone");
        }
    }
    clock.set_block_from_string(1, 1, 1, "minecraft:observer[facing=east]").unwrap();
    clock.set_block_from_string(2, 1, 1, "minecraft:observer[facing=west]").unwrap();
    clock.set_block_str(0, 1, 1, "minecraft:redstone_wire");
    clock.set_block_str(3, 1, 1, "minecraft:redstone_wire");
    // Interactive branch: lever → wire → lamp, driven by "use" over sim.sock.
    clock.set_block_from_string(0, 1, 0, "minecraft:lever[face=floor,facing=east,powered=false]").unwrap();
    clock.set_block_str(1, 1, 0, "minecraft:redstone_wire");
    clock.set_block_str(2, 1, 0, "minecraft:redstone_wire");
    clock.set_block_from_string(3, 1, 0, "minecraft:redstone_lamp[lit=false]").unwrap();
    let bytes = clock.to_schematic().expect("serialize clock");
    std::fs::write("web/clock.schem", &bytes).expect("write clock");
    println!("wrote web/clock.schem ({} bytes)", bytes.len());

    // Same scene as a litematic and as a vanilla world zip — drag-and-drop
    // test fixtures for the two other import paths.
    let lit = nucleation::formats::litematic::to_litematic(&clock).expect("litematic");
    std::fs::write("web/clock.litematic", &lit).expect("write litematic");
    println!("wrote web/clock.litematic ({} bytes)", lit.len());
    let zip = nucleation::formats::world::to_world_zip(&clock, None).expect("world zip");
    std::fs::write("web/clock-world.zip", &zip).expect("write world zip");
    println!("wrote web/clock-world.zip ({} bytes)", zip.len());
}
