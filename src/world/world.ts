// World: chunk container + block access + scheduled ticks. Pure (usable in workers).
import type { BlockRegistry } from '../blocks/registry';
import { Chunk, chunkKey, MIN_Y, MAX_Y, DEFAULT_LIGHT, type BlockEntity, CHUNK_W } from './chunk';
import { LightEngine } from './lighting';

export type Dimension = 'overworld' | 'the_nether' | 'the_end';

export interface ScheduledTick { x: number; y: number; z: number; state: number; time: number; priority: number; seq: number }

export interface WorldListener {
  onSectionDirty?(cx: number, sy: number, cz: number): void;
  onBlockChanged?(x: number, y: number, z: number, oldState: number, newState: number, flags: number): void;
  onNeighborChanged?(x: number, y: number, z: number, fromX: number, fromY: number, fromZ: number): void;
}

export const SET_UPDATE_NEIGHBORS = 1;
export const SET_NO_LIGHT = 2;
export const SET_NO_RERENDER = 4;
export const SET_SILENT = 8; // from generation: no listeners

export class World {
  chunks = new Map<number, Chunk>();
  light: LightEngine;
  listeners: WorldListener[] = [];
  /** game time in ticks (total) and day time (0..24000) */
  time = 0;
  dayTime = 1000;
  seed = 0;
  dimension: Dimension = 'overworld';
  private ticks: ScheduledTick[] = [];
  private tickSeq = 0;
  hasSkyLight = true;
  /** Used by isolated lighting (worker): missing chunks are walls. */
  isolated = false;

  constructor(public registry: BlockRegistry, dimension: Dimension = 'overworld') {
    this.light = new LightEngine(this, registry);
    this.setDimension(dimension);
  }

  setDimension(d: Dimension): void {
    this.dimension = d;
    this.hasSkyLight = d === 'overworld';
    this.light.hasSky = this.hasSkyLight;
  }

  getChunk(cx: number, cz: number): Chunk | undefined { return this.chunks.get(chunkKey(cx, cz)); }
  hasChunk(cx: number, cz: number): boolean { return this.chunks.has(chunkKey(cx, cz)); }
  addChunk(c: Chunk): void { this.chunks.set(chunkKey(c.cx, c.cz), c); }
  removeChunk(cx: number, cz: number): Chunk | undefined { const k = chunkKey(cx, cz); const c = this.chunks.get(k); this.chunks.delete(k); return c; }
  chunkAt(x: number, z: number): Chunk | undefined { return this.chunks.get(chunkKey(x >> 4, z >> 4)); }

  getBlock(x: number, y: number, z: number): number {
    if (y < MIN_Y || y >= MAX_Y) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return 0;
    const s = c.sections[(y - MIN_Y) >> 4];
    if (!s) return 0;
    return s[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
  }

  /** Returns -1 for unloaded chunk (as opposed to air). */
  getBlockOrUnloaded(x: number, y: number, z: number): number {
    if (y < MIN_Y || y >= MAX_Y) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return -1;
    return c.getBlock(x & 15, y, z & 15);
  }

  isLoaded(x: number, z: number): boolean { return this.chunks.has(chunkKey(x >> 4, z >> 4)); }

  getLight(x: number, y: number, z: number): number {
    if (y >= MAX_Y) return this.hasSkyLight ? DEFAULT_LIGHT : 0;
    if (y < MIN_Y) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return this.hasSkyLight ? DEFAULT_LIGHT : 0;
    return c.getLight(x & 15, y, z & 15);
  }
  getSky(x: number, y: number, z: number): number { return this.getLight(x, y, z) >> 4; }
  getBlockLight(x: number, y: number, z: number): number { return this.getLight(x, y, z) & 15; }
  /** Combined light level 0-15 as vanilla "light level" for spawning etc. */
  getLightLevel(x: number, y: number, z: number, skyDarken = 0): number {
    const l = this.getLight(x, y, z);
    return Math.max((l >> 4) - skyDarken, l & 15);
  }

  getHeight(x: number, z: number): number {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    return c ? c.getHeight(x & 15, z & 15) : MIN_Y;
  }

  getBiome(x: number, z: number): number {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    return c ? c.biomes[((z & 15) << 4) | (x & 15)] : 0;
  }

  getBlockEntity(x: number, y: number, z: number): BlockEntity | undefined {
    return this.chunks.get(chunkKey(x >> 4, z >> 4))?.getBlockEntity(x & 15, y, z & 15);
  }
  setBlockEntity(x: number, y: number, z: number, be: BlockEntity | null): void {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (c) { c.setBlockEntity(x & 15, y, z & 15, be); c.modified = true; }
  }

  /**
   * Set a block. Updates heightmap, lighting, dirty flags and notifies listeners.
   * Returns false if unchanged / chunk not loaded.
   */
  setBlock(x: number, y: number, z: number, state: number, flags = SET_UPDATE_NEIGHBORS): boolean {
    if (y < MIN_Y || y >= MAX_Y) return false;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return false;
    const lx = x & 15, lz = z & 15;
    const old = c.getBlock(lx, y, lz);
    if (old === state) return false;
    c.setBlock(lx, y, lz, state);
    c.modified = true;
    if (this.registry.block(old) !== this.registry.block(state)) c.setBlockEntity(lx, y, lz, null);
    // heightmap
    const hi = (lz << 4) | lx;
    const reg = this.registry;
    if (state !== 0 && !reg.isAir(state)) {
      if (y + 1 > c.heightmap[hi]) c.heightmap[hi] = y + 1;
    } else if (y + 1 === c.heightmap[hi]) {
      let yy = y - 1;
      while (yy >= MIN_Y && reg.isAir(c.getBlock(lx, yy, lz))) yy--;
      c.heightmap[hi] = yy + 1;
    }
    if (!(flags & SET_NO_LIGHT)) this.light.onBlockChanged(x, y, z, old, state);
    if (!(flags & SET_NO_RERENDER)) this.markDirtyAround(x, y, z);
    if (!(flags & SET_SILENT)) {
      for (const l of this.listeners) l.onBlockChanged?.(x, y, z, old, state, flags);
      if (flags & SET_UPDATE_NEIGHBORS) this.updateNeighbors(x, y, z);
    }
    return true;
  }

  updateNeighbors(x: number, y: number, z: number): void {
    const n = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [dx, dy, dz] of n) for (const l of this.listeners) l.onNeighborChanged?.(x + dx, y + dy, z + dz, x, y, z);
  }

  markDirtyAround(x: number, y: number, z: number): void {
    const cx = x >> 4, cz = z >> 4, lx = x & 15, lz = z & 15, ly = (y - MIN_Y) & 15;
    this.markSectionDirty(cx, (y - MIN_Y) >> 4, cz);
    if (lx === 0) this.markSectionDirty(cx - 1, (y - MIN_Y) >> 4, cz);
    if (lx === 15) this.markSectionDirty(cx + 1, (y - MIN_Y) >> 4, cz);
    if (lz === 0) this.markSectionDirty(cx, (y - MIN_Y) >> 4, cz - 1);
    if (lz === 15) this.markSectionDirty(cx, (y - MIN_Y) >> 4, cz + 1);
    if (ly === 0) this.markSectionDirty(cx, ((y - MIN_Y) >> 4) - 1, cz);
    if (ly === 15) this.markSectionDirty(cx, ((y - MIN_Y) >> 4) + 1, cz);
    // diagonals matter for AO at corners
    if (lx === 0 && lz === 0) this.markSectionDirty(cx - 1, (y - MIN_Y) >> 4, cz - 1);
    if (lx === 15 && lz === 0) this.markSectionDirty(cx + 1, (y - MIN_Y) >> 4, cz - 1);
    if (lx === 0 && lz === 15) this.markSectionDirty(cx - 1, (y - MIN_Y) >> 4, cz + 1);
    if (lx === 15 && lz === 15) this.markSectionDirty(cx + 1, (y - MIN_Y) >> 4, cz + 1);
  }

  markSectionDirty(cx: number, sy: number, cz: number): void {
    if (sy < 0 || sy >= 24) return;
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return;
    c.dirtySections |= 1 << sy;
    for (const l of this.listeners) l.onSectionDirty?.(cx, sy, cz);
  }

  // ---------- scheduled ticks ----------
  scheduleTick(x: number, y: number, z: number, delay: number, priority = 0): void {
    const state = this.getBlock(x, y, z);
    // avoid duplicates for same pos+state
    for (const t of this.ticks) if (t.x === x && t.y === y && t.z === z && t.state === state) return;
    this.ticks.push({ x, y, z, state, time: this.time + delay, priority, seq: this.tickSeq++ });
  }

  /** Pops all ticks due now, ordered by time/priority. */
  popDueTicks(): ScheduledTick[] {
    const due: ScheduledTick[] = [];
    const rest: ScheduledTick[] = [];
    for (const t of this.ticks) (t.time <= this.time ? due : rest).push(t);
    this.ticks = rest;
    due.sort((a, b) => a.time - b.time || a.priority - b.priority || a.seq - b.seq);
    return due;
  }

  get pendingTickCount(): number { return this.ticks.length; }

  // ---------- helpers ----------
  /** Iterate collision boxes of blocks overlapping an AABB (world coords). */
  forEachCollisionBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, cb: (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, state: number, bx: number, by: number, bz: number) => void): void {
    const reg = this.registry;
    const x0 = Math.floor(minX), x1 = Math.floor(maxX), y0 = Math.max(MIN_Y, Math.floor(minY)), y1 = Math.min(MAX_Y - 1, Math.floor(maxY)), z0 = Math.floor(minZ), z1 = Math.floor(maxZ);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
      if (!c) { // unloaded chunks are solid so the player doesn't fall out of the world
        cb(x, y0, z, x + 1, y1 + 1, z + 1, 0, x, y0, z); continue;
      }
      for (let y = y0; y <= y1; y++) {
        const s = c.getBlock(x & 15, y, z & 15);
        if (s === 0) continue;
        const si = reg.shapeIndex[s];
        if (si < 0) continue;
        const boxes = reg.shapes[si];
        for (let i = 0; i < boxes.length; i++) {
          const b = boxes[i];
          cb(x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5], s, x, y, z);
        }
      }
    }
  }

  isChunkColumnLoaded(cx: number, cz: number, radius: number): boolean {
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) if (!this.chunks.has(chunkKey(cx + dx, cz + dz))) return false;
    return true;
  }
}

export { CHUNK_W };
