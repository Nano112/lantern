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
}
