// Generated structures: placement (vanilla structure sets: random-spread regions and the stronghold rings),
// lazily built structure starts (a block map bucketed per chunk + block entities + entities to spawn), and the
// per-chunk application with a simplified "beard" that raises the terrain under rigid pieces.
import type { BlockRegistry } from '../../blocks/registry';
import { Random } from '../../math';
import { Chunk, MIN_Y, MAX_Y, chunkKey, type BlockEntity } from '../chunk';
import type { Dimension } from '../world';
import type { BiomeDef } from './biomes';
import { hashSeed } from './noise';
import { FeatureStates, TreeGen, type BlockSink } from './features';
import { updateConnections } from '../../blocks/placement';
import { assembleJigsaw, processBlock, parseBlockString, rotPos, rotVec, boxIntersects, type Box, type StructureBundle, type JigsawPiece } from './jigsaw';

export type { Box };
export interface SpawnEntry { type: string; x: number; y: number; z: number; extra?: Record<string, any> }
export interface StructureRef { type: string; box: Box; /** piece bounds touching the chunk (fortress spawn overrides) */ pieces?: Box[] }
interface StructureFeature { kind: string; x: number; y: number; z: number }
interface ChunkPart { blocks: Map<number, number>; blockEntities: BlockEntity[]; spawns: SpawnEntry[] }

export interface StructureGenContext {
  seed: number;
  reg: BlockRegistry;
  st: FeatureStates;
  trees: TreeGen;
  dimension: Dimension;
  bundle: StructureBundle | null;
  /** pristine terrain block (no features/structures); 0 outside the world */
  probe(x: number, y: number, z: number): number;
  /** y of the first air block above the terrain (water counts as terrain) */
  surfaceY(x: number, z: number): number;
  biomeAt(x: number, z: number): BiomeDef;
}

export class StructureStart {
  box: Box = [0, 0, 0, 0, 0, 0];
  chunks = new Map<number, ChunkPart>();
  features: StructureFeature[] = [];
  /** rigid piece footprints that get terrain filled underneath */
  beards: Box[] = [];
  pieceBoxes: Box[] = [];
  constructor(public type: string, public cx: number, public cz: number) {}
  part(cx: number, cz: number): ChunkPart {
    const k = chunkKey(cx, cz);
    let p = this.chunks.get(k);
    if (!p) { p = { blocks: new Map(), blockEntities: [], spawns: [] }; this.chunks.set(k, p); }
    return p;
  }
  blockAt(x: number, y: number, z: number): number {
    if (y < MIN_Y || y >= MAX_Y) return -1;
    const p = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!p) return -1;
    const v = p.blocks.get(((y - MIN_Y) << 8) | ((z & 15) << 4) | (x & 15));
    return v === undefined ? -1 : v;
  }
}

/** Writes a structure into its start's per-chunk block maps. */
export class StructureWriter {
  private minX = 1e9; private minY = 1e9; private minZ = 1e9; private maxX = -1e9; private maxY = -1e9; private maxZ = -1e9;
  private connect: [number, number, number][] = [];
  constructor(public ctx: StructureGenContext, public start: StructureStart) {}
  get reg(): BlockRegistry { return this.ctx.reg; }
  set(x: number, y: number, z: number, state: number): void {
    if (y < MIN_Y || y >= MAX_Y) return;
    this.start.part(x >> 4, z >> 4).blocks.set(((y - MIN_Y) << 8) | ((z & 15) << 4) | (x & 15), state);
    if (x < this.minX) this.minX = x; if (x > this.maxX) this.maxX = x; if (y < this.minY) this.minY = y; if (y > this.maxY) this.maxY = y; if (z < this.minZ) this.minZ = z; if (z > this.maxZ) this.maxZ = z;
  }
  /** structure block if written, else pristine terrain */
  get(x: number, y: number, z: number): number { const s = this.start.blockAt(x, y, z); return s >= 0 ? s : this.ctx.probe(x, y, z); }
  has(x: number, y: number, z: number): boolean { return this.start.blockAt(x, y, z) >= 0; }
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, state: number | (() => number)): void {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, z, typeof state === 'function' ? state() : state);
  }
  /** mark a block whose connection props (fences, walls, panes, stairs) are computed once everything is written */
  connectLater(x: number, y: number, z: number): void { this.connect.push([x, y, z]); }
  blockEntity(x: number, y: number, z: number, be: Record<string, any>): void { this.start.part(x >> 4, z >> 4).blockEntities.push({ ...be, x, y, z } as BlockEntity); }
  chest(x: number, y: number, z: number, state: number, lootTable: string): void { this.set(x, y, z, state); this.blockEntity(x, y, z, { type: 'chest', lootTable, invSize: 27 }); }
  spawner(x: number, y: number, z: number, mob: string): void { this.set(x, y, z, this.ctx.st.id('spawner')); this.blockEntity(x, y, z, { type: 'spawner', mob, invSize: 0 }); }
  spawn(type: string, x: number, y: number, z: number, extra?: Record<string, any>): void { this.start.part(Math.floor(x) >> 4, Math.floor(z) >> 4).spawns.push({ type, x, y, z, extra }); }
  feature(kind: string, x: number, y: number, z: number): void { this.start.features.push({ kind, x, y, z }); }
  finish(): void {
    const reg = this.reg;
    const world = { getBlock: (x: number, y: number, z: number) => { const s = this.get(x, y, z); return s < 0 ? 0 : s; } } as any;
    for (const [x, y, z] of this.connect) { const s = this.start.blockAt(x, y, z); if (s > 0) this.set(x, y, z, updateConnections(reg, world, x, y, z, s)); }
    this.start.box = this.minX > this.maxX ? [0, 0, 0, 0, 0, 0] : [this.minX, this.minY, this.minZ, this.maxX, this.maxY, this.maxZ];
    for (const b of this.start.pieceBoxes) { this.start.box[0] = Math.min(this.start.box[0], b[0]); this.start.box[1] = Math.min(this.start.box[1], b[1]); this.start.box[2] = Math.min(this.start.box[2], b[2]); this.start.box[3] = Math.max(this.start.box[3], b[3]); this.start.box[4] = Math.max(this.start.box[4], b[4]); this.start.box[5] = Math.max(this.start.box[5], b[5]); }
  }
}

export interface StructureType {
  name: string;
  dimension: Dimension;
  /** max distance (chunks) from a start's chunk that its blocks can reach */
  reach: number;
  /** candidate start chunks that could affect chunk (cx, cz) */
  candidates(ctx: StructureGenContext, cx: number, cz: number): [number, number][];
  /** validate the start at its chunk and build it; null when it doesn't generate there */
  build(ctx: StructureGenContext, cx: number, cz: number, w: StructureWriter): boolean;
  /** cheap validity test (biome) used by /locate; defaults to "candidate exists" */
  valid?(ctx: StructureGenContext, cx: number, cz: number): boolean;
}

// ---------- placement ----------
/** vanilla RandomSpreadStructurePlacement (linear spread): one candidate chunk per spacing×spacing region */
export function randomSpreadCandidates(seed: number, spacing: number, separation: number, salt: number, reach: number, cx: number, cz: number): [number, number][] {
  const out: [number, number][] = [];
  const r0x = Math.floor((cx - reach) / spacing), r1x = Math.floor((cx + reach) / spacing), r0z = Math.floor((cz - reach) / spacing), r1z = Math.floor((cz + reach) / spacing);
  for (let rz = r0z; rz <= r1z; rz++) for (let rx = r0x; rx <= r1x; rx++) {
    const rnd = new Random(hashSeed(seed, rx, rz, salt));
    const sx = rx * spacing + rnd.nextInt(spacing - separation), sz = rz * spacing + rnd.nextInt(spacing - separation);
    if (Math.abs(sx - cx) <= reach && Math.abs(sz - cz) <= reach) out.push([sx, sz]);
  }
  return out;
}

/** vanilla ConcentricRingsStructurePlacement for strongholds: distance 32, spread 3, count 128 (chunk coords). */
const ringCache = new Map<number, [number, number][]>();
export function strongholdPositions(seed: number): [number, number][] {
  let list = ringCache.get(seed);
  if (list) return list;
  list = [];
  const rnd = new Random(hashSeed(seed, 0x57, 0x0d, 0x9)); const distance = 32, count = 128;
  let spread = 3, angle = rnd.next() * Math.PI * 2, ring = 0, inRing = 0;
  for (let i = 0; i < count; i++) {
    const d = 4 * distance + distance * ring * 6 + (rnd.next() - 0.5) * distance * 2.5;
    list.push([Math.round(Math.cos(angle) * d), Math.round(Math.sin(angle) * d)]);
    angle += Math.PI * 2 / spread;
    if (++inRing === spread) { ring++; inRing = 0; spread += Math.floor(2 * spread / (ring + 1)); spread = Math.min(spread, count - i); angle += rnd.next() * Math.PI * 2; }
  }
  ringCache.set(seed, list);
  return list;
}
/** Nearest stronghold start (block coords of the portal-room search origin) — the Eye of Ender's target. */
export function nearestStronghold(seed: number, x: number, z: number): [number, number] {
  let best: [number, number] = [0, 0], bd = Infinity;
  for (const [cx, cz] of strongholdPositions(seed)) { const bx = cx * 16 + 8, bz = cz * 16 + 8; const d = (bx - x) ** 2 + (bz - z) ** 2; if (d < bd) { bd = d; best = [bx, bz]; } }
  return best;
}

// ---------- manager ----------
export class StructureManager {
  private cache = new Map<string, StructureStart | null>();
  constructor(public ctx: StructureGenContext, public types: StructureType[]) {}

  startAt(type: StructureType, cx: number, cz: number): StructureStart | null {
    const k = `${type.name}:${cx}:${cz}`;
    let s = this.cache.get(k);
    if (s !== undefined) return s;
    this.cache.set(k, null); // guards re-entrancy while building
    const start = new StructureStart(type.name, cx, cz);
    const w = new StructureWriter(this.ctx, start);
    let ok = false;
    try { ok = type.build(this.ctx, cx, cz, w); } catch (e) { console.warn('structure build failed', type.name, cx, cz, e); }
    if (ok) w.finish();
    s = ok ? start : null;
    if (this.cache.size > 64) { const first = this.cache.keys().next().value; if (first !== undefined) this.cache.delete(first); }
    this.cache.set(k, s);
    return s;
  }

  /** every start whose box touches chunk (cx, cz) */
  startsFor(cx: number, cz: number): StructureStart[] {
    const out: StructureStart[] = [];
    const chunkBox: Box = [cx * 16, MIN_Y, cz * 16, cx * 16 + 15, MAX_Y, cz * 16 + 15];
    for (const t of this.types) for (const [sx, sz] of t.candidates(this.ctx, cx, cz)) {
      const s = this.startAt(t, sx, sz);
      if (s && boxIntersects(s.box, chunkBox)) out.push(s);
    }
    return out;
  }

  /** /locate: nearest start of a type to (x, z), searching outwards up to `radius` chunks; block coords or null */
  locate(type: string, x: number, z: number, radius = 100 * 34): [number, number] | null {
    const t = this.types.find((tt) => tt.name === type);
    if (!t) return null;
    const cx = Math.floor(x) >> 4, cz = Math.floor(z) >> 4;
    let best: [number, number] | null = null, bd = Infinity;
    const seen = new Set<string>();
    for (let r = 0; r <= radius; r += 8) {
      // scan the ring of chunks at distance r (candidates are cheap: one hash per region)
      const ring: [number, number][] = [];
      if (r === 0) ring.push([cx, cz]); else for (let i = -r; i <= r; i += 8) { ring.push([cx + i, cz - r], [cx + i, cz + r], [cx - r, cz + i], [cx + r, cz + i]); }
      for (const [rx, rz] of ring) for (const [sx, sz] of t.candidates(this.ctx, rx, rz)) {
        const k = sx + ':' + sz; if (seen.has(k)) continue; seen.add(k);
        if (t.valid ? !t.valid(this.ctx, sx, sz) : false) continue;
        const d = (sx * 16 + 8 - x) ** 2 + (sz * 16 + 8 - z) ** 2;
        if (d < bd) { bd = d; best = [sx * 16 + 8, sz * 16 + 8]; }
      }
      if (best && Math.sqrt(bd) < (r + 8) * 16) break;
    }
    return best;
  }

  /** structure block at a world position, -1 when none (tree placement checks look through this) */
  private current: StructureStart[] = [];
  blockAt(x: number, y: number, z: number): number {
    for (const s of this.current) { const v = s.blockAt(x, y, z); if (v >= 0) return v; }
    return -1;
  }

  /** Write the structures touching this chunk. Call after the terrain columns are filled and before features. */
  apply(chunk: Chunk, sink: BlockSink): StructureRef[] {
    const starts = this.startsFor(chunk.cx, chunk.cz);
    this.current = starts;
    const refs: StructureRef[] = [];
    const x0 = chunk.cx * 16, z0 = chunk.cz * 16;
    const chunkBox: Box = [x0, MIN_Y, z0, x0 + 15, MAX_Y, z0 + 15];
    for (const s of starts) {
      refs.push({ type: s.type, box: s.box, pieces: s.type === 'fortress' ? s.pieceBoxes.filter((b) => boxIntersects(b, chunkBox)) : undefined });
      if (s.beards.length) this.beard(chunk, s);
      const part = s.chunks.get(chunkKey(chunk.cx, chunk.cz));
      if (part) {
        for (const [idx, state] of part.blocks) chunk.setBlock(idx & 15, (idx >> 8) + MIN_Y, (idx >> 4) & 15, state);
        for (const be of part.blockEntities) chunk.setBlockEntity(be.x & 15, be.y, be.z & 15, { ...be });
        chunk.spawns.push(...part.spawns.map((e) => ({ ...e, extra: e.extra ? { ...e.extra } : undefined })));
      }
      for (const f of s.features) {
        if (f.x < x0 - 8 || f.x >= x0 + 24 || f.z < z0 - 8 || f.z >= z0 + 24) continue;
        this.placeFeature(f, sink);
      }
    }
    return refs;
  }

  /** Simplified beardifier (terrain_adaptation beard_thin): fill the ground under rigid pieces, with a 3-block slope around them. */
  private beard(chunk: Chunk, s: StructureStart): void {
    const ctx = this.ctx, x0 = chunk.cx * 16, z0 = chunk.cz * 16;
    const want = new Int16Array(22 * 22).fill(-1000); // chunk + 3 margin
    const idx = (x: number, z: number) => (z - z0 + 3) * 22 + (x - x0 + 3);
    let any = false;
    for (const b of s.beards) {
      if (b[3] < x0 - 3 || b[0] > x0 + 18 || b[5] < z0 - 3 || b[2] > z0 + 18) continue;
      for (let z = Math.max(b[2], z0 - 3); z <= Math.min(b[5], z0 + 18); z++) for (let x = Math.max(b[0], x0 - 3); x <= Math.min(b[3], x0 + 18); x++) {
        const st = s.blockAt(x, b[1], z);
        if (st <= 0 || ctx.reg.collisionBoxes(st).length === 0) continue;
        want[idx(x, z)] = Math.max(want[idx(x, z)], b[1] - 1); any = true;
      }
    }
    if (!any) return;
    const slope = new Int16Array(want);
    for (let it = 0; it < 3; it++) for (let z = z0 - 3; z <= z0 + 18; z++) for (let x = x0 - 3; x <= x0 + 18; x++) {
      const i = idx(x, z); let m = want[i];
      if (x > x0 - 3) m = Math.max(m, want[i - 1] - 1); if (x < x0 + 18) m = Math.max(m, want[i + 1] - 1); if (z > z0 - 3) m = Math.max(m, want[i - 22] - 1); if (z < z0 + 18) m = Math.max(m, want[i + 22] - 1);
      slope[i] = m;
    }
    for (let i = 0; i < want.length; i++) want[i] = slope[i];
    const reg = ctx.reg;
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
      const x = x0 + lx, z = z0 + lz, target = want[idx(x, z)];
      if (target < -500) continue;
      // terrain top: highest block that is neither air, water nor a plant
      let top = ctx.surfaceY(x, z) - 1;
      while (top > MIN_Y) { const st = chunk.getBlock(lx, top, lz); if (st !== 0 && !reg.isAir(st) && !reg.isWater(st) && reg.collisionBoxes(st).length) break; top--; }
      if (top >= target) continue;
      const biome = ctx.biomeAt(x, z);
      const filler = ctx.st.id(biome.filler === 'stone' ? 'stone' : biome.filler), topBlock = ctx.st.id(biome.top);
      const covered = s.blockAt(x, target + 1, z) > 0;
      for (let y = top + 1; y <= target; y++) chunk.setBlock(lx, y, lz, y === target && !covered ? topBlock : filler);
      for (let y = target + 1; y <= target + 2; y++) { const st = chunk.getBlock(lx, y, lz); if (st !== 0 && reg.isWater(st)) chunk.setBlock(lx, y, lz, 0); }
    }
  }

  private placeFeature(f: StructureFeature, sink: BlockSink): void {
    const ctx = this.ctx, st = ctx.st, reg = ctx.reg;
    const rnd = new Random(hashSeed(ctx.seed, f.x, f.z, f.y));
    const kind = f.kind.replace(/^minecraft:/, '');
    const ground = (x: number, z: number) => { let y = f.y + 2; while (y > MIN_Y && (sink.get(x, y - 1, z) === 0 || reg.isAir(sink.get(x, y - 1, z)))) y--; return y; };
    const put = (x: number, y: number, z: number, s: number) => { const g = sink.get(x, y, z); if (g === 0 || (g > 0 && reg.isAir(g))) sink.set(x, y, z, s); };
    switch (kind) {
      case 'oak': case 'spruce': case 'pine': case 'acacia': { const y = ground(f.x, f.z); ctx.trees.place(kind === 'pine' ? 'spruce' : kind, sink, rnd, f.x, y, f.z); break; }
      case 'flower_plain': { const flowers = ['dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip']; for (let i = 0; i < 24; i++) { const x = f.x + rnd.nextInt(7) - 3, z = f.z + rnd.nextInt(7) - 3; const y = ground(x, z); if (reg.nameOf(sink.get(x, y - 1, z) || 0) === 'grass_block') put(x, y, z, st.id(flowers[rnd.nextInt(flowers.length)])); } break; }
      case 'patch_taiga_grass': { for (let i = 0; i < 24; i++) { const x = f.x + rnd.nextInt(7) - 3, z = f.z + rnd.nextInt(7) - 3; const y = ground(x, z); if (reg.nameOf(sink.get(x, y - 1, z) || 0) === 'grass_block') put(x, y, z, st.id(rnd.next() < 0.3 ? 'fern' : 'short_grass')); } break; }
      case 'patch_berry_bush': { for (let i = 0; i < 12; i++) { const x = f.x + rnd.nextInt(5) - 2, z = f.z + rnd.nextInt(5) - 2; const y = ground(x, z); if (reg.nameOf(sink.get(x, y - 1, z) || 0) === 'grass_block') put(x, y, z, st.withProps('sweet_berry_bush', { age: '3' })); } break; }
      case 'patch_cactus': { for (let i = 0; i < 6; i++) { const x = f.x + rnd.nextInt(5) - 2, z = f.z + rnd.nextInt(5) - 2; const y = ground(x, z); if (reg.nameOf(sink.get(x, y - 1, z) || 0) === 'sand') { const h = 1 + rnd.nextInt(3); for (let j = 0; j < h; j++) put(x, y + j, z, st.id('cactus')); } } break; }
      case 'pile_hay': case 'pile_melon': case 'pile_pumpkin': case 'pile_snow': case 'pile_ice': {
        const block = () => kind === 'pile_hay' ? st.withProps('hay_block', { axis: ['x', 'y', 'z'][rnd.nextInt(3)] }) : st.id(kind === 'pile_melon' ? 'melon' : kind === 'pile_pumpkin' ? 'pumpkin' : kind === 'pile_snow' ? 'snow_block' : 'ice');
        // vanilla BlockPileFeature: a random blob within ±(2..3) blocks, two layers high, on sturdy ground
        const y = ground(f.x, f.z);
        const ri = 2 + rnd.nextInt(2), rj = 2 + rnd.nextInt(2);
        for (let x = f.x - ri; x <= f.x + ri; x++) for (let py = y; py <= y + 1; py++) for (let z = f.z - rj; z <= f.z + rj; z++) {
          const k = f.x - x, l = f.z - z;
          if (!(k * k + l * l <= rnd.next() * 10 - rnd.next() * 6) && !(rnd.next() < 0.031)) continue;
          const below = sink.get(x, py - 1, z);
          if (below > 0 && reg.fullCube[below] === 1) put(x, py, z, block());
        }
        break;
      }
    }
  }
}

// ---------- villages (jigsaw over the vanilla templates) ----------
const VILLAGE_BIOMES: Record<string, string[]> = { village_plains: ['plains', 'meadow'], village_desert: ['desert'], village_savanna: ['savanna'], village_snowy: ['snowy_plains'], village_taiga: ['taiga'] };

export const VILLAGE: StructureType = {
  name: 'village', dimension: 'overworld', reach: 7,
  valid(ctx, cx, cz) { const biome = ctx.biomeAt(cx * 16, cz * 16).name; return Object.values(VILLAGE_BIOMES).some((b) => b.includes(biome)); },
  candidates(ctx, cx, cz) {
    if (!ctx.bundle) return [];
    const set = ctx.bundle.structureSets.villages?.placement ?? { spacing: 34, separation: 8, salt: 10387312 };
    return randomSpreadCandidates(ctx.seed, set.spacing, set.separation, set.salt, this.reach, cx, cz);
  },
  build(ctx, cx, cz, w) {
    const bundle = ctx.bundle!;
    const x = cx * 16, z = cz * 16;
    const biome = ctx.biomeAt(x, z).name;
    const kind = Object.keys(VILLAGE_BIOMES).find((k) => VILLAGE_BIOMES[k].includes(biome));
    if (!kind) return false;
    const def = bundle.structures[kind];
    if (!def) return false;
    const rnd = new Random(hashSeed(ctx.seed, cx, cz, 0x7111a6e));
    const jctx = { bundle, reg: ctx.reg, surfaceY: (px: number, pz: number) => ctx.surfaceY(px, pz) };
    const pieces = assembleJigsaw(jctx, { startPool: def.start_pool, maxDepth: def.size ?? 6, useExpansionHack: !!def.use_expansion_hack, maxDistanceFromCenter: def.max_distance_from_center ?? 80, projectStartToHeightmap: !!def.project_start_to_heightmap, startY: def.start_height?.absolute ?? 0 }, x, z, rnd);
    if (!pieces.length) return false;
    for (const p of pieces) placeJigsawPiece(ctx, w, jctx, p);
    return true;
  },
};

/** Write one assembled piece: template blocks (rotated, processed), jigsaw final states, loot chests, entities, features. */
function placeJigsawPiece(ctx: StructureGenContext, w: StructureWriter, jctx: { bundle: StructureBundle; reg: BlockRegistry; surfaceY(x: number, z: number): number }, p: JigsawPiece): void {
  w.start.pieceBoxes.push(p.box);
  if (!p.template) {
    if (p.element.element_type === 'minecraft:feature_pool_element' && p.element.feature) w.feature(p.element.feature, p.x, p.y, p.z);
    return;
  }
  const t = p.template;
  const worldAt = (x: number, y: number, z: number) => w.get(x, y, z);
  const jigsawByIndex = new Map<number, any>();
  for (const [i, nbt] of Object.entries(t.nbts)) jigsawByIndex.set(+i, nbt);
  for (let i = 0, n = t.blocks.length / 4; i < n; i++) {
    const pal = t.palette[t.blocks[i * 4]];
    const lx = t.blocks[i * 4 + 1], ly = t.blocks[i * 4 + 2], lz = t.blocks[i * 4 + 3];
    const [rx, rz] = rotPos(lx, lz, p.rot);
    const x = p.x + rx, y = p.y + ly, z = p.z + rz;
    let name = pal.name, props = pal.props;
    const nbt = jigsawByIndex.get(i);
    if (name === 'jigsaw') { const fs = parseBlockString(nbt?.final_state ?? 'minecraft:air'); name = fs.name; props = fs.props; if (name === 'structure_void') continue; if (name === 'air' && p.legacy) continue; }
    const state = processBlock(jctx, p, name, props, x, y, z, worldAt, ctx.seed);
    if (state === null) continue;
    w.set(x, y, z, state);
    if (nbt && nbt.id !== 'minecraft:jigsaw') {
      const id = String(nbt.id).replace(/^minecraft:/, '');
      if ((id === 'chest' || id === 'barrel' || id === 'trapped_chest') && nbt.LootTable) w.blockEntity(x, y, z, { type: id === 'barrel' ? 'barrel' : 'chest', lootTable: String(nbt.LootTable).replace(/^minecraft:/, ''), invSize: 27 });
    }
  }
  // entities: villagers, animals, golems, cats… (positions rotate like vanilla StructureTemplate.placeEntities)
  for (const e of t.entities) {
    const [ex, ez] = rotVec(e.pos[0], e.pos[2], p.rot);
    const id = String(e.nbt?.id ?? '').replace(/^minecraft:/, '');
    if (!id || id === 'armor_stand' || id === 'item_frame' || id === 'painting') continue;
    const extra: Record<string, any> = {};
    const vd = e.nbt.VillagerData;
    if (vd) { extra.profession = String(vd.profession ?? 'minecraft:none').replace(/^minecraft:/, ''); extra.villagerType = String(vd.type ?? 'minecraft:plains').replace(/^minecraft:/, ''); extra.level = vd.level ?? 1; }
    if (e.nbt.Color !== undefined) extra.color = e.nbt.Color;
    if (e.nbt.variant !== undefined) extra.variant = String(e.nbt.variant).replace(/^minecraft:/, '');
    if (e.nbt.Age !== undefined && e.nbt.Age < 0) extra.baby = true;
    if (e.nbt.PersistenceRequired) extra.persistent = true;
    w.spawn(id, p.x + ex, p.y + e.pos[1], p.z + ez, extra);
  }
  // rigid template pieces get terrain filled underneath (vanilla beard_thin); entity/decor markers don't
  if (p.rigid && p.element.element_type !== 'minecraft:feature_pool_element' && (t.size[0] > 1 || t.size[2] > 1)) {
    const b = p.box; w.start.beards.push([b[0], p.y, b[2], b[3], p.y, b[5]]);
  }
}
