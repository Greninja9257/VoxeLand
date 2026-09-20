// Streams chunks around the player: generation/loading in workers, border light propagation,
// meshing dispatch (padded 18^3 arrays) and GPU upload through the renderer.
import type { Assets } from '../assets';
import { Chunk, ChunkStage, MIN_Y, SECTION_COUNT, chunkKey, type ChunkData } from './chunk';
import { World } from './world';
import { WorkerPool } from '../workers/pool';
import { storage } from '../save/storage';
import type { MeshOutput, Mesher } from '../render/mesher';
import { BIOMES } from './gen/biomes';

export interface SectionMeshTarget {
  setSectionMesh(cx: number, sy: number, cz: number, out: MeshOutput): void;
  removeChunkMeshes(cx: number, cz: number): void;
}

const NULL_TARGET: SectionMeshTarget = { setSectionMesh() {}, removeChunkMeshes() {} };

export class ChunkManager {
  genPool: WorkerPool;
  meshPool: WorkerPool;
  viewDistance = 8;
  simulationDistance = 8;
  private pendingGen = new Set<number>();
  private pendingMesh = new Set<number>();
  private meshQueue: { cx: number; sy: number; cz: number; d: number }[] = [];
  private lastCenter = { cx: 1e9, cz: 1e9 };
  private saveTimer = 0;
  private unloadTimer = 0;
  stats = { genTime: 0, genCount: 0, meshTime: 0, meshCount: 0, loaded: 0 };
  private unloading = false;
  onChunkLoaded?: (c: Chunk) => void;
  onChunkUnloaded?: (c: Chunk) => void;
  /** called before the periodic save so runtime block entities are written back into their chunks */
  onBeforeSave?: () => void;

  /** Main-thread mesher for the blocking chunk-builder modes (vanilla prioritizeChunkUpdates). */
  syncMesher: Mesher | null = null;
  chunkBuilder: 'threaded' | 'semi' | 'full' = 'threaded';
  /** per-section build counter: an async result older than the newest build of that section is discarded */
  private meshVersion = new Map<number, number>();
  /** Multiplayer guest: chunks come from the host instead of the generator. */
  remote: { requestChunk(cx: number, cz: number): void; forgetChunk(cx: number, cz: number): void } | null;
  /** Additional positions (other players) whose surroundings stay loaded (host). */
  extraCenters: { x: number; z: number }[] = [];
  /** A dimension the host simulates for guests but does not look at: chunks stream and tick, nothing is meshed. */
  headless: boolean;
  private renderTarget: SectionMeshTarget;
  private meshOptions: { smoothLighting: boolean; fancy: boolean } | null = null;
  constructor(public world: World, public assets: Assets, target: SectionMeshTarget, public worldId: string, public biomeColors: Uint8Array, remote: { requestChunk(cx: number, cz: number): void; forgetChunk(cx: number, cz: number): void } | null = null, private sessionChunks: Map<string, ChunkData> | null = null, headless = false) {
    this.remote = remote;
    this.renderTarget = target; this.headless = headless;
    this.target = headless ? NULL_TARGET : target;
    const hw = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4)));
    const genCount = Math.max(1, Math.floor(hw / 2));
    this.genPool = this.remote ? new WorkerPool(() => new Worker(new URL('../workers/gen.worker.ts', import.meta.url), { type: 'module' }), 0, null) : new WorkerPool(() => new Worker(new URL('../workers/gen.worker.ts', import.meta.url), { type: 'module' }), genCount, { type: 'init', mcdata: assets.mcdata, structures: assets.structures, seed: world.seed, dimension: world.dimension });
    this.meshPool = this.makeMeshPool(headless ? 0 : Math.max(1, hw - genCount - 1));
  }
  public target: SectionMeshTarget;
  private makeMeshPool(count: number): WorkerPool {
    return new WorkerPool(() => new Worker(new URL('../workers/mesh.worker.ts', import.meta.url), { type: 'module' }), count, { type: 'init', mcdata: this.assets.mcdata, models: this.assets.models, atlas: this.assets.atlas, redstoneTint: this.assets.mcdata.tints.redstone.data });
  }
  /** Switch between being looked at (meshed into the renderer) and simulated in the background. */
  setHeadless(headless: boolean): void {
    if (headless === this.headless) return;
    this.headless = headless;
    for (const c of this.world.chunks.values()) this.target.removeChunkMeshes(c.cx, c.cz);
    this.meshPool.terminate(); this.pendingMesh.clear();
    const hw = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4)));
    this.meshPool = this.makeMeshPool(headless ? 0 : Math.max(1, hw - Math.max(1, Math.floor(hw / 2)) - 1));
    this.target = headless ? NULL_TARGET : this.renderTarget;
    if (!headless) { if (this.meshOptions) this.meshPool.broadcast({ type: 'options', options: this.meshOptions }); for (const c of this.world.chunks.values()) { c.dirtySections = (1 << SECTION_COUNT) - 1; (c as any).tintsDirty = true; } }
  }

  /** Push mesh-affecting video options to the workers and rebuild every loaded section. */
  setMeshOptions(o: { smoothLighting: boolean; fancy: boolean; biomeBlend: number }): void {
    this.meshOptions = { smoothLighting: o.smoothLighting, fancy: o.fancy };
    this.meshPool.broadcast({ type: 'options', options: this.meshOptions });
    if (this.syncMesher) this.syncMesher.options = { ...this.syncMesher.options, ...this.meshOptions };
    this.biomeBlend = o.biomeBlend;
    for (const c of this.world.chunks.values()) { c.dirtySections = (1 << SECTION_COUNT) - 1; (c as any).tintsDirty = true; }
  }
  biomeBlend = 2;

  ready(): Promise<void> { return Promise.all([this.genPool.ready(), this.meshPool.ready()]).then(() => {}); }
  /** /locate structure: asks a generator worker for the nearest start (null on guests, who have no generator) */
  async locate(structure: string, x: number, z: number): Promise<[number, number] | null> { if (this.remote || !this.genPool.size) return null; const r = await this.genPool.request({ type: 'locate', structure, x, z }); return r.pos ?? null; }

  disposed = false;
  dispose(): void { this.disposed = true; this.genPool.terminate(); this.meshPool.terminate(); }

  async findSpawn(): Promise<[number, number, number]> {
    const r = await this.genPool.request({ type: 'spawn' });
    return r.pos;
  }

  /** Called every frame with the player position. */
  update(px: number, pz: number, dt: number): void {
    if (this.disposed) return;
    const ccx = Math.floor(px) >> 4, ccz = Math.floor(pz) >> 4;
    const vd = this.viewDistance;
    const world = this.world;
    const centers = [{ cx: ccx, cz: ccz }, ...this.extraCenters.map((c) => ({ cx: Math.floor(c.x) >> 4, cz: Math.floor(c.z) >> 4 }))];
    const nearAny = (cx: number, cz: number, r: number) => { for (const c of centers) { const dx = cx - c.cx, dz = cz - c.cz; if (dx * dx + dz * dz <= r * r) return true; } return false; };
    if (ccx !== this.lastCenter.cx || ccz !== this.lastCenter.cz || this.extraCenters.length || this.unloadTimer++ > 40) {
      this.lastCenter = { cx: ccx, cz: ccz }; this.unloadTimer = 0;
      // unload far chunks
      const toRemove: Chunk[] = [];
      for (const c of world.chunks.values()) if (!nearAny(c.cx, c.cz, vd + 2)) toRemove.push(c);
      if (toRemove.length) {
        const save: ChunkData[] = [];
        for (const c of toRemove) {
          world.removeChunk(c.cx, c.cz);
          this.target.removeChunkMeshes(c.cx, c.cz);
          this.onChunkUnloaded?.(c);
          this.remote?.forgetChunk(c.cx, c.cz);
          if (c.modified && !this.remote) save.push(c.serialize());
        }
        if (save.length) this.storeChunks(save);
      }
    }
    // request generation for missing chunks, nearest first
    const maxInFlight = this.remote ? 64 : this.genPool.size * 3;
    if (this.genPool.inFlight < maxInFlight) {
      const wanted: [number, number, number][] = [];
      const seen = new Set<number>();
      for (const c of centers) {
        const r = c === centers[0] ? vd : Math.min(vd, 8); // guests get up to 8 chunks around them
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          const d = dx * dx + dz * dz;
          if (d > r * r) continue;
          const cx = c.cx + dx, cz = c.cz + dz;
          const key = chunkKey(cx, cz);
          if (seen.has(key) || world.chunks.has(key) || this.pendingGen.has(key)) continue;
          seen.add(key);
          wanted.push([d + (c === centers[0] ? 0 : 1000), cx, cz]);
        }
      }
      wanted.sort((a, b) => a[0] - b[0]);
      if (this.remote) { for (let i = 0; i < wanted.length && i < 32; i++) this.remote.requestChunk(wanted[i][1], wanted[i][2]); }
      else for (let i = 0; i < wanted.length && this.genPool.inFlight + i < maxInFlight; i++) this.requestChunk(wanted[i][1], wanted[i][2]);
    }
    // meshing
    this.dispatchMeshes(ccx, ccz);
    // periodic save
    this.saveTimer += dt;
    if (this.saveTimer > 30 && !this.remote) { this.saveTimer = 0; this.onBeforeSave?.(); this.saveAll(); }
    this.stats.loaded = world.chunks.size;
  }

  private async requestChunk(cx: number, cz: number): Promise<void> {
    const key = chunkKey(cx, cz);
    this.pendingGen.add(key);
    try {
      let chunk: Chunk | null = null;
      const saved = this.sessionChunks
        ? this.sessionChunks.get(`${this.world.dimension}:${cx},${cz}`)
        : await storage.loadChunk(this.worldId, this.world.dimension, cx, cz).catch(() => undefined);
      if (saved) chunk = Chunk.deserialize(saved);
      else {
        const r = await this.genPool.request({ type: 'gen', cx, cz });
        chunk = Chunk.deserialize(r.data);
        chunk.modified = true; // freshly generated: persist
        (chunk as any).fresh = true;
        this.stats.genTime += r.time; this.stats.genCount++;
      }
      if (!this.pendingGen.has(key)) return; // disposed
      this.addChunk(chunk);
    } finally { this.pendingGen.delete(key); }
  }

  /** A chunk received from the host (guest). */
  addRemoteChunk(chunk: Chunk): void {
    const old = this.world.chunks.get(chunkKey(chunk.cx, chunk.cz));
    if (old) { this.world.removeChunk(old.cx, old.cz); this.target.removeChunkMeshes(old.cx, old.cz); }
    this.addChunk(chunk);
  }

  /** Remove a chunk explicitly unloaded by a remote authoritative server. */
  removeRemoteChunk(cx: number, cz: number): void {
    const chunk = this.world.removeChunk(cx, cz);
    if (!chunk) return;
    this.target.removeChunkMeshes(cx, cz);
    this.onChunkUnloaded?.(chunk);
  }

  private addChunk(chunk: Chunk): void {
    const world = this.world;
    world.addChunk(chunk);
    chunk.stage = ChunkStage.GENERATED;
    chunk.markAllDirty();
    // border light exchange with loaded neighbours
    world.light.propagateBorders(chunk);
    chunk.borderLit = true;
    // neighbours need remeshing at the shared border (their padded data changed)
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const n = world.getChunk(chunk.cx + dx, chunk.cz + dz);
      if (n) { n.markAllDirty(); (n as any).tints = undefined; }
    }
    this.onChunkLoaded?.(chunk);
  }

  private neighborsLoaded(cx: number, cz: number): boolean {
    const w = this.world;
    return w.hasChunk(cx - 1, cz) && w.hasChunk(cx + 1, cz) && w.hasChunk(cx, cz - 1) && w.hasChunk(cx, cz + 1) && w.hasChunk(cx - 1, cz - 1) && w.hasChunk(cx + 1, cz - 1) && w.hasChunk(cx - 1, cz + 1) && w.hasChunk(cx + 1, cz + 1);
  }

  /** Compile every dirty section of the chunk column at (x, z) right now (Semi/Fully Blocking modes). */
  rebuildNow(x: number, z: number, y?: number): void {
    if (this.headless || !this.syncMesher || this.chunkBuilder === 'threaded') return;
    const cx = x >> 4, cz = z >> 4;
    // a block change also dirties the neighbouring columns' border sections
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const c = this.world.getChunk(cx + dx, cz + dz);
      if (!c || !c.dirtySections || !this.neighborsLoaded(c.cx, c.cz)) continue;
      for (let sy = 0; sy < SECTION_COUNT; sy++) {
        if (!(c.dirtySections & (1 << sy))) continue;
        if (y !== undefined && Math.abs(((y - MIN_Y) >> 4) - sy) > 1) continue;
        this.buildSection(c, sy, true);
      }
    }
  }
  private buildSection(c: Chunk, sy: number, sync: boolean): void {
    c.dirtySections &= ~(1 << sy);
    if (!c.sections[sy]) { this.target.setSectionMesh(c.cx, sy, c.cz, { cx: c.cx, sy, cz: c.cz, layers: [null, null, null], time: 0 }); return; }
    this.meshSection(c, sy, sync);
  }

  private dispatchMeshes(ccx: number, ccz: number): void {
    if (this.headless) return;
    // Fully Blocking: everything dirty around the player is compiled before this frame draws
    if (this.chunkBuilder === 'full' && this.syncMesher) {
      let built = 0;
      for (let dx = -1; dx <= 1 && built < 24; dx++) for (let dz = -1; dz <= 1 && built < 24; dz++) {
        const c = this.world.getChunk(ccx + dx, ccz + dz);
        if (!c || !c.dirtySections || !this.neighborsLoaded(c.cx, c.cz)) continue;
        for (let sy = 0; sy < SECTION_COUNT && built < 24; sy++) if (c.dirtySections & (1 << sy)) { this.buildSection(c, sy, true); built++; }
      }
    }
    const maxInFlight = this.meshPool.size * 4;
    if (this.meshPool.inFlight >= maxInFlight) return;
    const world = this.world;
    // gather dirty sections
    const list = this.meshQueue;
    list.length = 0;
    for (const c of world.chunks.values()) {
      if (!c.dirtySections) continue;
      if (!this.neighborsLoaded(c.cx, c.cz)) continue;
      const d = (c.cx - ccx) ** 2 + (c.cz - ccz) ** 2;
      for (let sy = 0; sy < SECTION_COUNT; sy++) {
        if (!(c.dirtySections & (1 << sy))) continue;
        const key = sectionKey(c.cx, sy, c.cz);
        if (this.pendingMesh.has(key)) continue;
        list.push({ cx: c.cx, sy, cz: c.cz, d });
      }
    }
    if (!list.length) return;
    list.sort((a, b) => a.d - b.d);
    for (let i = 0; i < list.length && this.meshPool.inFlight < maxInFlight; i++) {
      const { cx, sy, cz } = list[i];
      const c = world.getChunk(cx, cz)!;
      this.buildSection(c, sy, false);
    }
  }

  private meshSection(c: Chunk, sy: number, sync = false): void {
    const key = sectionKey(c.cx, sy, c.cz);
    const version = (this.meshVersion.get(key) ?? 0) + 1;
    this.meshVersion.set(key, version);
    const blocks = new Uint16Array(18 * 18 * 18);
    const light = new Uint8Array(18 * 18 * 18);
    const world = this.world;
    const y0 = sy * 16 + MIN_Y;
    const wx0 = c.cx * 16, wz0 = c.cz * 16;
    for (let z = -1; z <= 16; z++) {
      for (let x = -1; x <= 16; x++) {
        const wx = wx0 + x, wz = wz0 + z;
        const ch = (x >= 0 && x < 16 && z >= 0 && z < 16) ? c : world.getChunk(wx >> 4, wz >> 4);
        const lx = wx & 15, lz = wz & 15;
        let idx = (z + 1) * 18 + (x + 1);
        if (!ch) continue;
        for (let y = -1; y <= 16; y++) {
          const wy = y0 + y;
          const i = idx + (y + 1) * 324;
          blocks[i] = ch.getBlock(lx, wy, lz);
          light[i] = ch.getLight(lx, wy, lz);
        }
      }
    }
    const tints = this.chunkTints(c);
    const input = { cx: c.cx, sy, cz: c.cz, blocks, light, tints };
    if (sync && this.syncMesher) {
      const out = this.syncMesher.mesh(input);
      this.stats.meshTime += out.time; this.stats.meshCount++;
      if (world.getChunk(c.cx, c.cz) === c) this.target.setSectionMesh(c.cx, sy, c.cz, out);
      return;
    }
    this.pendingMesh.add(key);
    this.meshPool.request({ type: 'mesh', input }, [blocks.buffer, light.buffer]).then((r) => {
      this.pendingMesh.delete(key);
      if (this.meshVersion.get(key) !== version) return; // a newer (synchronous) build already replaced it
      const out = r.out as MeshOutput;
      this.stats.meshTime += out.time; this.stats.meshCount++;
      if (world.getChunk(c.cx, c.cz) === c) this.target.setSectionMesh(c.cx, sy, c.cz, out);
    });
  }

  /** Blended biome tint colours for each column of a chunk ((2R+1)² smoothing, R = biome blend option). */
  chunkTints(c: Chunk): Uint8Array {
    const cached = (c as any).tints as Uint8Array | undefined;
    if (cached && !(c as any).tintsDirty) return cached;
    (c as any).tintsDirty = false;
    const R = this.biomeBlend;
    const out = new Uint8Array(16 * 16 * 12);
    const world = this.world;
    const bc = this.biomeColors;
    const acc = new Float32Array(12);
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
      acc.fill(0);
      let n = 0;
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const wx = c.cx * 16 + lx + dx, wz = c.cz * 16 + lz + dz;
        const ch = world.getChunk(wx >> 4, wz >> 4) ?? c;
        const b = ch.biomes[((wz & 15) << 4) | (wx & 15)];
        const o = b * 12;
        for (let k = 0; k < 12; k++) acc[k] += bc[o + k];
        n++;
      }
      const o = ((lz << 4) | lx) * 12;
      for (let k = 0; k < 12; k++) out[o + k] = acc[k] / n;
    }
    (c as any).tints = out;
    return out;
  }

  saveAll(): Promise<void> {
    if (this.remote) return Promise.resolve();
    const save: ChunkData[] = [];
    for (const c of this.world.chunks.values()) if (c.modified) { save.push(c.serialize()); c.modified = false; }
    return this.storeChunks(save);
  }

  /** Session worlds (the backend-owned public world) retain chunks only in memory. */
  private storeChunks(chunks: ChunkData[]): Promise<void> {
    if (this.sessionChunks) {
      for (const c of chunks) this.sessionChunks.set(`${this.world.dimension}:${c.cx},${c.cz}`, c);
      return Promise.resolve();
    }
    return storage.saveChunks(this.worldId, this.world.dimension, chunks).catch(console.error) as Promise<void>;
  }

  /** Remove everything (dimension change / quit). */
  clear(): void {
    for (const c of [...this.world.chunks.values()]) { this.world.removeChunk(c.cx, c.cz); this.target.removeChunkMeshes(c.cx, c.cz); }
    this.pendingGen.clear(); this.pendingMesh.clear();
    this.lastCenter = { cx: 1e9, cz: 1e9 };
  }

  get pendingGenCount(): number { return this.pendingGen.size; }
  get pendingMeshCount(): number { return this.pendingMesh.size; }
}

function sectionKey(cx: number, sy: number, cz: number): number { return ((cx + 0x8000) * 0x10000 + ((cz + 0x8000) & 0xffff)) * 32 + sy; }

/** Compute per-biome tint colours (grass, foliage, water, dry foliage) from colormaps + tints.json overrides. */
export function computeBiomeColors(assets: Assets, colormaps: { grass: ImageData; foliage: ImageData; dry: ImageData | null }): Uint8Array {
  const out = new Uint8Array(BIOMES.length * 12);
  const sample = (img: ImageData, temp: number, downfall: number): [number, number, number] => {
    const t = Math.max(0, Math.min(1, temp)), h = Math.max(0, Math.min(1, downfall)) * t;
    const x = Math.round((1 - t) * 255), y = Math.round((1 - h) * 255);
    const i = (y * 256 + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const tints = assets.mcdata.tints;
  const override = (table: { keys: string[]; color: number }[], name: string): number | null => {
    for (const e of table) if (e.keys.includes(name) && (e.color & 0xffffff) !== 0) return e.color & 0xffffff;
    return null;
  };
  for (let i = 0; i < BIOMES.length; i++) {
    const b = BIOMES[i];
    const o = i * 12;
    let g = sample(colormaps.grass, b.temperature, b.downfall);
    let f = sample(colormaps.foliage, b.temperature, b.downfall);
    let d = colormaps.dry ? sample(colormaps.dry, b.temperature, b.downfall) : [g[0] * 0.8, g[1] * 0.6, g[2] * 0.4] as [number, number, number];
    // minecraft-data stores dark_forest's *additive* offset, not a colour — handled by the formula below
    const go = b.grassColor ?? (b.name === 'dark_forest' ? null : override(tints.grass.data, b.name));
    const fo = b.foliageColor ?? (b.name === 'dark_forest' ? null : override(tints.foliage.data, b.name));
    const wo = b.waterColor ?? override(tints.water.data, b.name) ?? 0x3f76e4;
    if (go !== null) g = [(go >> 16) & 255, (go >> 8) & 255, go & 255];
    if (fo !== null) f = [(fo >> 16) & 255, (fo >> 8) & 255, fo & 255];
    if (b.name === 'swamp') { g = [0x6a, 0x70, 0x39]; f = [0x6a, 0x70, 0x39]; }
    if (b.name === 'dark_forest') { g = [(g[0] + 0x28) >> 1, (g[1] + 0x34) >> 1, (g[2] + 0x0a) >> 1]; }
    out.set([g[0], g[1], g[2], f[0], f[1], f[2], (wo >> 16) & 255, (wo >> 8) & 255, wo & 255, d[0], d[1], d[2]], o);
  }
  return out;
}
