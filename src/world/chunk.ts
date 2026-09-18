// Chunk storage: 16x384x16 columns split into 24 sections of 16^3 Uint16 block states.
export const CHUNK_W = 16;
export const MIN_Y = -64;
export const MAX_Y = 320;          // exclusive
export const WORLD_HEIGHT = MAX_Y - MIN_Y; // 384
export const SECTION_COUNT = WORLD_HEIGHT / 16; // 24
export const SEA_LEVEL = 63;

export const enum ChunkStage { EMPTY = 0, GENERATED = 1, LIT = 2, READY = 3 }

export const DEFAULT_LIGHT = 0xf0; // sky 15, block 0

export function sectionIndex(x: number, y: number, z: number): number { return (y << 8) | (z << 4) | x; }
export function chunkKey(cx: number, cz: number): number { return ((cx + 0x8000) << 16) | ((cz + 0x8000) & 0xffff); }
export function sectionKey(cx: number, sy: number, cz: number): number { return ((cx + 0x8000) * 0x10000 + ((cz + 0x8000) & 0xffff)) * 32 + (sy + 4); }

export interface BlockEntity { type: string; x: number; y: number; z: number; [k: string]: any }

export class Chunk {
  sections: (Uint16Array | null)[] = new Array(SECTION_COUNT).fill(null);
  light: (Uint8Array | null)[] = new Array(SECTION_COUNT).fill(null);
  /** Motion-blocking heightmap (highest non-air y + 1), world y coords. */
  heightmap = new Int16Array(CHUNK_W * CHUNK_W).fill(MIN_Y);
  /** Highest block that blocks sky light (for light fill); world y coords */
  skyHeight = new Int16Array(CHUNK_W * CHUNK_W).fill(MIN_Y);
  biomes = new Uint8Array(CHUNK_W * CHUNK_W); // 2D biome per column (biome id index)
  blockEntities = new Map<number, BlockEntity>();
  stage: ChunkStage = ChunkStage.EMPTY;
  dirtySections = 0; // bitmask (24 bits)
  modified = false;
  /** neighbor-lit flag: border light propagation done */
  borderLit = false;
  lastAccess = 0;
  /** Set once all 8 neighbors were generated and this chunk was decorated with cross-chunk features. */
  decorated = false;
  inhabitedTime = 0;
  /** entities the generator asks to be spawned when the chunk is first loaded (village villagers, animals…) */
  spawns: { type: string; x: number; y: number; z: number; extra?: Record<string, any> }[] = [];
  /** generated structures whose bounds touch this chunk (fortress mob spawns, /locate) */
  structures: { type: string; box: [number, number, number, number, number, number]; pieces?: [number, number, number, number, number, number][] }[] = [];

  constructor(public cx: number, public cz: number) {}

  static localBEKey(x: number, y: number, z: number): number { return ((y - MIN_Y) << 8) | (z << 4) | x; }

  getBlock(x: number, y: number, z: number): number {
    if (y < MIN_Y || y >= MAX_Y) return 0;
    const s = this.sections[(y - MIN_Y) >> 4];
    if (!s) return 0;
    return s[((y & 15) << 8) | (z << 4) | x];
  }

  setBlock(x: number, y: number, z: number, state: number): boolean {
    if (y < MIN_Y || y >= MAX_Y) return false;
    const si = (y - MIN_Y) >> 4;
    let s = this.sections[si];
    if (!s) {
      if (state === 0) return false;
      s = this.sections[si] = new Uint16Array(4096);
    }
    const i = ((y & 15) << 8) | (z << 4) | x;
    if (s[i] === state) return false;
    s[i] = state;
    return true;
  }

  getLight(x: number, y: number, z: number): number {
    if (y >= MAX_Y) return DEFAULT_LIGHT;
    if (y < MIN_Y) return 0;
    const l = this.light[(y - MIN_Y) >> 4];
    if (!l) return DEFAULT_LIGHT;
    return l[((y & 15) << 8) | (z << 4) | x];
  }
  getSky(x: number, y: number, z: number): number { return this.getLight(x, y, z) >> 4; }
  getBlockLight(x: number, y: number, z: number): number { return this.getLight(x, y, z) & 15; }

  setLight(x: number, y: number, z: number, v: number): void {
    if (y < MIN_Y || y >= MAX_Y) return;
    const si = (y - MIN_Y) >> 4;
    let l = this.light[si];
    if (!l) {
      if (v === DEFAULT_LIGHT) return;
      l = this.light[si] = new Uint8Array(4096).fill(DEFAULT_LIGHT);
    }
    l[((y & 15) << 8) | (z << 4) | x] = v;
  }
  setSky(x: number, y: number, z: number, v: number): void { this.setLight(x, y, z, (v << 4) | (this.getLight(x, y, z) & 15)); }
  setBlockLight(x: number, y: number, z: number, v: number): void { this.setLight(x, y, z, (this.getLight(x, y, z) & 0xf0) | v); }

  getHeight(x: number, z: number): number { return this.heightmap[(z << 4) | x]; }

  markDirty(y: number): void {
    const si = (y - MIN_Y) >> 4;
    if (si >= 0 && si < SECTION_COUNT) this.dirtySections |= 1 << si;
  }
  markAllDirty(): void { this.dirtySections = (1 << SECTION_COUNT) - 1; }

  getBlockEntity(x: number, y: number, z: number): BlockEntity | undefined { return this.blockEntities.get(Chunk.localBEKey(x, y, z)); }
  setBlockEntity(x: number, y: number, z: number, be: BlockEntity | null): void {
    const k = Chunk.localBEKey(x, y, z);
    if (be) this.blockEntities.set(k, be); else this.blockEntities.delete(k);
  }

  /** Serialize to compact transferable form. */
  serialize(): ChunkData {
    const sec: (Uint16Array | null)[] = this.sections.map((s) => (s && s.some((v) => v !== 0) ? s : null));
    return { cx: this.cx, cz: this.cz, sections: sec, light: this.light, heightmap: this.heightmap, skyHeight: this.skyHeight, biomes: this.biomes, blockEntities: [...this.blockEntities.values()], decorated: this.decorated, inhabitedTime: this.inhabitedTime, spawns: this.spawns.length ? this.spawns : undefined, structures: this.structures.length ? this.structures : undefined };
  }

  static deserialize(d: ChunkData): Chunk {
    const c = new Chunk(d.cx, d.cz);
    c.sections = d.sections.map((s) => (s ? new Uint16Array(s) : null));
    c.light = d.light ? d.light.map((l) => (l ? new Uint8Array(l) : null)) : new Array(SECTION_COUNT).fill(null);
    c.heightmap = new Int16Array(d.heightmap);
    c.skyHeight = new Int16Array(d.skyHeight ?? d.heightmap);
    c.biomes = new Uint8Array(d.biomes);
    for (const be of d.blockEntities ?? []) c.blockEntities.set(Chunk.localBEKey(be.x & 15, be.y, be.z & 15), be);
    c.decorated = d.decorated ?? true;
    c.inhabitedTime = d.inhabitedTime ?? 0;
    c.spawns = d.spawns ?? [];
    c.structures = d.structures ?? [];
    c.stage = ChunkStage.GENERATED;
    return c;
  }
}

export interface ChunkData {
  cx: number; cz: number;
  sections: (Uint16Array | null)[];
  light: (Uint8Array | null)[] | null;
  heightmap: Int16Array;
  skyHeight?: Int16Array;
  biomes: Uint8Array;
  blockEntities?: BlockEntity[];
  decorated?: boolean;
  inhabitedTime?: number;
  spawns?: { type: string; x: number; y: number; z: number; extra?: Record<string, any> }[];
  structures?: { type: string; box: [number, number, number, number, number, number]; pieces?: [number, number, number, number, number, number][] }[];
}
