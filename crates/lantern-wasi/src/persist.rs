//! lantern: world persistence over the page's OPFS.
//!
//! Everything the server writes lives in two places: the in-wasm memfs
//! (chunk/region data via `pumpkin_util::compat::fs`) and the WASI cwd
//! (configs, level.dat, player data via `std::fs`). Both are archived into a
//! single `state.bin`, which the page mounts as a special inode: reads come
//! from the OPFS copy loaded at boot, writes are streamed back to OPFS.
//!
//! Record format: magic `LNTN1`, then per file:
//! `[u8 kind: 0=memfs 1=wasi][u32 BE path_len][path][u32 BE data_len][data]`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use pumpkin::server::Server;

const STATE_PATH: &str = "state.bin";
const MAGIC: &[u8; 5] = b"LNTN1";
const MAGIC_V2: &[u8; 5] = b"LNTN2"; // deflate-compressed archive
const SNAPSHOT_INTERVAL: Duration = Duration::from_secs(60);

/// Files that must never be captured: bridge sockets, the archive itself,
/// transient inputs (a stale import.schem restored over a fresh one shadows
/// the user's download), and logs.
/// Streamed worlds (SDF / composite / OSM / earth) regenerate from their
/// sources — snapshotting their chunk files ballooned the archive past 250MB
/// and OOM'd the autosave. Set by worldswap on generator swaps.
pub static SKIP_WORLD_DIR: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn skip(path: &Path) -> bool {
    if SKIP_WORLD_DIR.load(std::sync::atomic::Ordering::Relaxed) {
        let p = path.to_string_lossy();
        if p.trim_start_matches("./").starts_with("world") {
            return true;
        }
    }
    let p = path.to_string_lossy();
    let p = p.trim_start_matches("./");
    // Any .sock is a virtual fd bridge — reading one during a snapshot walk
    // would steal queued frames (e.g. a pending world swap command).
    matches!(p, "state.bin" | "import.schem")
        || p.ends_with(".sock")
        || p.starts_with("logs")
}

pub fn restore() -> std::io::Result<(usize, usize)> {
    // Chunked read: the WASI farm's shared-buffer allocator can't transfer
    // arbitrarily large single reads/writes.
    let mut file = std::fs::File::open(STATE_PATH)?;
    let mut bytes: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        use std::io::Read;
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..n]);
    }
    if bytes.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "state.bin empty",
        ));
    }
    if bytes.len() >= MAGIC_V2.len() && &bytes[..MAGIC_V2.len()] == MAGIC_V2 {
        use std::io::Read;
        let mut inflated = Vec::new();
        flate2::read::DeflateDecoder::new(&bytes[MAGIC_V2.len()..])
            .read_to_end(&mut inflated)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let mut with_magic = MAGIC.to_vec();
        with_magic.extend_from_slice(&inflated);
        bytes = with_magic;
    }
    if bytes.len() < MAGIC.len() || &bytes[..MAGIC.len()] != MAGIC {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "state.bin: bad magic",
        ));
    }
    let mut memfs_entries = Vec::new();
    let mut wasi_count = 0usize;
    let mut off = MAGIC.len();
    while off + 9 <= bytes.len() {
        let kind = bytes[off];
        let plen =
            u32::from_be_bytes([bytes[off + 1], bytes[off + 2], bytes[off + 3], bytes[off + 4]])
                as usize;
        off += 5;
        if off + plen + 4 > bytes.len() {
            break;
        }
        let path = String::from_utf8_lossy(&bytes[off..off + plen]).into_owned();
        off += plen;
        let dlen =
            u32::from_be_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
                as usize;
        off += 4;
        if off + dlen > bytes.len() {
            break;
        }
        let data = bytes[off..off + dlen].to_vec();
        off += dlen;

        if kind == 0 {
            memfs_entries.push((PathBuf::from(path), data));
        } else {
            if let Some(parent) = Path::new(&path).parent()
                && !parent.as_os_str().is_empty()
            {
                let _ = std::fs::create_dir_all(parent);
            }
            if std::fs::write(&path, &data).is_ok() {
                wasi_count += 1;
            }
        }
    }
    let mem_count = memfs_entries.len();
    pumpkin_util::compat::fs::restore_entries(memfs_entries);
    Ok((mem_count, wasi_count))
}

fn walk_wasi(dir: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if skip(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk_wasi(&path, out);
        } else if let Ok(data) = std::fs::read(&path) {
            out.push((path, data));
        }
    }
}

fn write_record(
    enc: &mut impl std::io::Write,
    kind: u8,
    path: &Path,
    data: &[u8],
) -> std::io::Result<()> {
    let p = path.to_string_lossy();
    let p = p.trim_start_matches("./").as_bytes();
    enc.write_all(&[kind])?;
    enc.write_all(&(p.len() as u32).to_be_bytes())?;
    enc.write_all(p)?;
    enc.write_all(&(data.len() as u32).to_be_bytes())?;
    enc.write_all(data)
}

pub fn save_now(reason: &str) {
    // Records stream straight into the deflate encoder: building the raw
    // archive first peaked at a single >250MB Vec on chunk-heavy worlds and
    // OOM'd the autosave.
    let mut bytes = MAGIC_V2.to_vec();
    {
        use std::io::Write;
        let mut enc =
            flate2::write::DeflateEncoder::new(&mut bytes, flate2::Compression::fast());
        for (path, data) in pumpkin_util::compat::fs::snapshot_entries() {
            if !skip(&path) {
                let _ = write_record(&mut enc, 0, &path, &data);
            }
        }
        let mut wasi_files = Vec::new();
        walk_wasi(Path::new("."), &mut wasi_files);
        for (path, data) in wasi_files {
            let _ = write_record(&mut enc, 1, &path, &data);
        }
        let _ = enc.finish();
    }
    let kb = bytes.len() / 1024;
    let result = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(STATE_PATH)?;
        // Chunked: single jumbo writes overflow the farm's transfer buffer.
        for chunk in bytes.chunks(1 << 20) {
            f.write_all(chunk)?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => tracing::info!("persist: snapshot saved ({kb} KiB, {reason})"),
        Err(e) => tracing::warn!("persist: snapshot failed: {e}"),
    }
}

pub fn spawn_autosave(_server: Arc<Server>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SNAPSHOT_INTERVAL);
        ticker.tick().await; // skip the immediate first tick
        loop {
            ticker.tick().await;
            save_now("autosave");
        }
    });
}
