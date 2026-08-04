# Earth streamer — dynamic real-world fetching

World kind `earth`: pick lat/lon; Minecraft (0,0) = that point; terrain and
buildings stream in as regions are explored. 1 block = 1 m (equirectangular
at origin latitude), y = elevation − origin elevation + 40.

## Data flow
1. `earth:` command over world.sock: `{lat, lon, originElev}` → generator swap
   (chunk_fill closure) + standard reset dance.
2. chunk_fill(cx,cz) looks up its 512-block region `(floor(cx·16/512), …)`:
   - present → terrain columns from the region heightmap (step 2 m, nearest)
     + building/road blocks from a per-region nucleation footprint source.
   - missing → records the region as *needed*, emits empty (placeholder void).
3. Needed regions surface through the metrics JSON (`earth_needed`), which the
   page already polls at 1 Hz.
4. The page fetches (terrarium elevation tiles + Overpass buildings/highways
   for the region bbox — one Overpass fetch at a time, mirror rotation),
   converts with the existing OSM pipeline against the ORIGIN datum (no
   per-region normalization → regions seam), and pushes
   `region:{rx,rz,heights,width,step,footprints}` over world.sock.
5. Rust stores the region, fires the scheduler wipe-replay (chunks that were
   generated as void placeholders regenerate with real data), and the
   view-distance resend delivers them to players.

## Rate-limit reality
Overpass tolerates ~1 concurrent query with gaps; the page queues needed
regions nearest-player-first, dedupes in-flight, and skips a region (retry
with backoff) when mirrors are exhausted. Elevation tiles are effectively
unmetered through /api/terrain.
