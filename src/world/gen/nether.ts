// Nether generator: 3D noise caverns between bedrock floor (y=0) and ceiling (y=127), lava sea at y<=31.
import type { BlockRegistry } from '../../blocks/registry';
import { Random } from '../../math';
import { Chunk, MIN_Y } from '../chunk';
import { biomeId } from './biomes';
import { FBM, Perlin, hashSeed } from './noise';
import { FeatureStates, TreeGen, placeOreBlob, type BlockSink } from './features';
import type { Generator } from './overworld';
import { StructureManager, type StructureGenContext } from './structures';
import { FORTRESS } from './fortress';
import type { StructureBundle } from './jigsaw';
import { BIOMES } from './biomes';

const NETHER_TOP = 128;
const LAVA_SEA = 31;

export class NetherGen implements Generator {
  private density: FBM; private biomeA: Perlin; private biomeB: Perlin; private detail: Perlin;
  private st: FeatureStates; private trees: TreeGen;
  private S: Record<string, number> = {};
  structures: StructureManager;
  private probeCache = new Map<number, Uint8Array>();
  constructor(public seed: number, public reg: BlockRegistry, bundle: StructureBundle | null = null) {
    this.density = new FBM(seed + 501, 3, 2, 0.5);
    this.biomeA = new Perlin(seed + 502); this.biomeB = new Perlin(seed + 503); this.detail = new Perlin(seed + 504);
    this.st = new FeatureStates(reg); this.trees = new TreeGen(reg, this.st);
    const sctx: StructureGenContext = { seed, reg, st: this.st, trees: this.trees, dimension: 'the_nether', bundle, probe: (x, y, z) => this.probeBlock(x, y, z), surfaceY: (x, z) => { let y = NETHER_TOP - 1; while (y > 0 && this.probeBlock(x, y - 1, z) === 0) y--; return y; }, biomeAt: (x, z) => BIOMES[this.biomeAt(x, z)] };
    this.structures = new StructureManager(sctx, [FORTRESS]);
    for (const n of ['netherrack', 'lava', 'bedrock', 'soul_sand', 'soul_soil', 'crimson_nylium', 'warped_nylium', 'basalt', 'blackstone', 'glowstone', 'nether_quartz_ore', 'nether_gold_ore', 'ancient_debris', 'magma_block', 'gravel', 'crimson_roots', 'warped_roots', 'nether_sprouts', 'crimson_fungus', 'warped_fungus', 'nether_wart', 'fire', 'soul_fire', 'bone_block', 'shroomlight', 'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant', 'brown_mushroom', 'red_mushroom']) this.S[n] = reg.defaultState(n);
  }

  /** density-only terrain column (netherrack / air / lava) for structure supports and /locate */
  probeBlock(x: number, y: number, z: number): number {
    if (y < 0 || y >= NETHER_TOP) return 0;
    const key = ((x + 0x800000) * 0x1000000) + (z + 0x800000);
    let col = this.probeCache.get(key);
    if (!col) {
      col = new Uint8Array(NETHER_TOP);
      for (let yy = 0; yy < NETHER_TOP; yy++) {
        const n = this.density.noise3(x / 60, yy / 40, z / 60, 1) + this.detail.noise3(x / 14, yy / 14, z / 14) * 0.25;
        const edge = yy < 20 ? (20 - yy) / 20 : yy > 108 ? (yy - 108) / 20 : 0;
        col[yy] = n + edge * 0.8 > 0.05 || yy <= 4 || yy >= NETHER_TOP - 5 ? 1 : yy <= LAVA_SEA ? 2 : 0;
      }
      if (this.probeCache.size > 4096) this.probeCache.clear();
      this.probeCache.set(key, col);
    }
    const v = col[y];
    return v === 1 ? this.S.netherrack : v === 2 ? this.S.lava : 0;
  }
  locate(type: string, x: number, z: number): [number, number] | null { return this.structures.locate(type, x, z); }

  private biomeAt(x: number, z: number): number {
    const a = this.biomeA.noise2(x / 220, z / 220), b = this.biomeB.noise2(x / 220 + 77, z / 220 - 33);
    if (a > 0.35) return biomeId(b > 0 ? 'crimson_forest' : 'warped_forest');
    if (a < -0.4) return biomeId(b > 0.1 ? 'basalt_deltas' : 'soul_sand_valley');
    return biomeId('nether_wastes');
  }

  generate(cx: number, cz: number): Chunk {
    const chunk = new Chunk(cx, cz);
    const S = this.S;
    const x0 = cx * 16, z0 = cz * 16;
    const rnd = new Random(hashSeed(this.seed, cx, cz, 0x4e7));
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
      const x = x0 + lx, z = z0 + lz;
      const biome = this.biomeAt(x, z);
      chunk.biomes[(lz << 4) | lx] = biome;
      const bname = ['nether_wastes', 'soul_sand_valley', 'crimson_forest', 'warped_forest', 'basalt_deltas'].find((n) => biomeId(n) === biome) ?? 'nether_wastes';
      const top = bname === 'soul_sand_valley' ? S.soul_sand : bname === 'crimson_forest' ? S.crimson_nylium : bname === 'warped_forest' ? S.warped_nylium : bname === 'basalt_deltas' ? S.basalt : S.netherrack;
      const filler = bname === 'soul_sand_valley' ? S.soul_soil : bname === 'basalt_deltas' ? S.blackstone : S.netherrack;
      let prevSolid = false;
      for (let y = NETHER_TOP - 1; y >= 0; y--) {
        let st: number;
        if (y <= 4 && (y === 0 || rnd.nextInt(5) >= y)) st = S.bedrock;
        else if (y >= NETHER_TOP - 5 && (y === NETHER_TOP - 1 || rnd.nextInt(5) >= NETHER_TOP - 1 - y)) st = S.bedrock;
        else {
          const n = this.density.noise3(x / 60, y / 40, z / 60, 1) + this.detail.noise3(x / 14, y / 14, z / 14) * 0.25;
          const edge = y < 20 ? (20 - y) / 20 : y > 108 ? (y - 108) / 20 : 0;
          const solid = n + edge * 0.8 + (bname === 'basalt_deltas' ? 0.15 : 0) > 0.05;
          if (solid) st = filler; else st = y <= LAVA_SEA ? S.lava : 0;
        }
        chunk.setBlock(lx, y, lz, st);
        // surface: exposed top gets the biome top block
        if (st === filler && !prevSolid && y < NETHER_TOP - 6) {
          chunk.setBlock(lx, y, lz, top);
          if (bname === 'soul_sand_valley' && y > LAVA_SEA && rnd.next() < 0.5) chunk.setBlock(lx, y, lz, S.soul_soil);
        }
        prevSolid = st !== 0 && st !== S.lava;
      }
    }
    const sink = new NetherSink(chunk);
    chunk.structures = this.structures.apply(chunk, sink);
    // ores
    const target = (s: number): 0 | 1 | 2 => (s === S.netherrack ? 1 : 0);
    for (let i = 0; i < 16; i++) placeOreBlob(sink, rnd, x0 + rnd.nextInt(16), 10 + rnd.nextInt(108), z0 + rnd.nextInt(16), 14, S.nether_quartz_ore, S.nether_quartz_ore, target);
    for (let i = 0; i < 10; i++) placeOreBlob(sink, rnd, x0 + rnd.nextInt(16), 10 + rnd.nextInt(108), z0 + rnd.nextInt(16), 10, S.nether_gold_ore, S.nether_gold_ore, target);
    for (let i = 0; i < 2; i++) placeOreBlob(sink, rnd, x0 + rnd.nextInt(16), 8 + rnd.nextInt(112), z0 + rnd.nextInt(16), 5, S.gravel, S.gravel, target);
    if (rnd.next() < 0.6) placeOreBlob(sink, rnd, x0 + rnd.nextInt(16), 8 + rnd.nextInt(16), z0 + rnd.nextInt(16), 3, S.ancient_debris, S.ancient_debris, target);
    for (let i = 0; i < 4; i++) placeOreBlob(sink, rnd, x0 + rnd.nextInt(16), 27 + rnd.nextInt(10), z0 + rnd.nextInt(16), 33, S.magma_block, S.magma_block, target);
    // features
    const topOf = (x: number, z: number): number => { let y = NETHER_TOP - 8; while (y > 0 && chunk.getBlock(x & 15, y, z & 15) === 0) y--; return y; };
    for (let i = 0; i < 10; i++) { // glowstone clusters hanging from ceilings
      const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16), y = 40 + rnd.nextInt(80);
      if (chunk.getBlock(x & 15, y, z & 15) !== 0 || chunk.getBlock(x & 15, y + 1, z & 15) !== S.netherrack) continue;
      for (let j = 0; j < 12; j++) { const px = x + rnd.nextInt(5) - 2, py = y - rnd.nextInt(4), pz = z + rnd.nextInt(5) - 2; if (sink.get(px, py, pz) === 0 && (sink.get(px, py + 1, pz) === S.glowstone || sink.get(px, py + 1, pz) === S.netherrack)) sink.set(px, py, pz, S.glowstone); }
    }
    const cb = this.biomeAt(x0 + 8, z0 + 8);
    const name = ['nether_wastes', 'soul_sand_valley', 'crimson_forest', 'warped_forest', 'basalt_deltas'].find((n) => biomeId(n) === cb) ?? 'nether_wastes';
    if (name === 'crimson_forest' || name === 'warped_forest') {
      const kind = name === 'crimson_forest' ? 'crimson' : 'warped';
      for (let i = 0; i < 6; i++) { const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16); const y = topOf(x, z) + 1; if (y > LAVA_SEA + 1) this.trees.place(kind + '_fungus', sink, new Random(hashSeed(this.seed, x, z, 5)), x, y, z); }
      for (let i = 0; i < 40; i++) {
        const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16); const y = topOf(x, z);
        const g = sink.get(x, y, z);
        if (g !== (kind === 'crimson' ? S.crimson_nylium : S.warped_nylium) || sink.get(x, y + 1, z) !== 0) continue;
        const r = rnd.next();
        sink.set(x, y + 1, z, r < 0.6 ? (kind === 'crimson' ? S.crimson_roots : S.warped_roots) : r < 0.75 ? (kind === 'crimson' ? S.crimson_fungus : S.warped_fungus) : r < 0.9 ? (kind === 'crimson' ? S.warped_fungus : S.crimson_fungus) : kind === 'warped' ? S.nether_sprouts : S.crimson_roots);
      }
      // vines
      for (let i = 0; i < 20; i++) {
        const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16), y = 30 + rnd.nextInt(80);
        if (kind === 'crimson' && sink.get(x, y, z) === 0 && sink.get(x, y + 1, z) === S.netherrack) { const len = 2 + rnd.nextInt(6); for (let j = 0; j < len; j++) { if (sink.get(x, y - j, z) !== 0) break; sink.set(x, y - j, z, j === len - 1 ? S.weeping_vines : S.weeping_vines_plant); } }
        if (kind === 'warped' && sink.get(x, y, z) === 0 && sink.get(x, y - 1, z) === S.warped_nylium) { const len = 2 + rnd.nextInt(6); for (let j = 0; j < len; j++) { if (sink.get(x, y + j, z) !== 0) break; sink.set(x, y + j, z, j === len - 1 ? S.twisting_vines : S.twisting_vines_plant); } }
      }
    }
    if (name === 'soul_sand_valley') {
      for (let i = 0; i < 3; i++) { const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16); const y = topOf(x, z); if (sink.get(x, y, z) === S.soul_sand || sink.get(x, y, z) === S.soul_soil) { const h = 2 + rnd.nextInt(5); for (let j = 1; j <= h; j++) sink.set(x, y + j, z, S.bone_block); } }
      for (let i = 0; i < 8; i++) { const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16); const y = topOf(x, z); if (sink.get(x, y, z) === S.soul_soil && sink.get(x, y + 1, z) === 0) sink.set(x, y + 1, z, S.soul_fire); }
    }
    if (name === 'basalt_deltas') {
      for (let i = 0; i < 12; i++) { const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16); const y = topOf(x, z); if (sink.get(x, y, z) === S.basalt || sink.get(x, y, z) === S.blackstone) { const h = 1 + rnd.nextInt(6); for (let j = 1; j <= h; j++) if (sink.get(x, y + j, z) === 0) sink.set(x, y + j, z, S.basalt); } }
      for (let i = 0; i < 6; i++) { const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16); const y = topOf(x, z); if (sink.get(x, y, z) === S.basalt && y > LAVA_SEA) sink.set(x, y, z, S.lava); }
    }
    if (name === 'nether_wastes') {
      for (let i = 0; i < 6; i++) { const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16); const y = topOf(x, z); if (sink.get(x, y, z) === S.netherrack && sink.get(x, y + 1, z) === 0 && rnd.next() < 0.4) sink.set(x, y + 1, z, S.fire); }
      for (let i = 0; i < 2; i++) { const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16); const y = topOf(x, z); if (sink.get(x, y, z) === S.netherrack && sink.get(x, y + 1, z) === 0) sink.set(x, y + 1, z, rnd.next() < 0.5 ? S.brown_mushroom : S.red_mushroom); }
      for (let i = 0; i < 1; i++) { const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16); const y = topOf(x, z); if (sink.get(x, y, z) === S.soul_sand || rnd.next() < 0.2) { for (let j = 0; j < 8; j++) { const px = x + rnd.nextInt(5) - 2, pz = z + rnd.nextInt(5) - 2; const py = topOf(px, pz); if (sink.get(px, py, pz) === S.netherrack) { sink.set(px, py, pz, S.soul_sand); if (sink.get(px, py + 1, pz) === 0) sink.set(px, py + 1, pz, this.st.withProps('nether_wart', { age: String(rnd.nextInt(4)) })); } } } }
    }
    // heightmap
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) { let y = NETHER_TOP - 1; while (y > 0 && chunk.getBlock(lx, y, lz) === 0) y--; chunk.heightmap[(lz << 4) | lx] = y + 1; }
    chunk.decorated = true;
    return chunk;
  }

  spawnHeight(x: number, z: number): number {
    return 70;
  }
}

class NetherSink implements BlockSink {
  private x0: number; private z0: number;
  constructor(public chunk: Chunk) { this.x0 = chunk.cx * 16; this.z0 = chunk.cz * 16; }
  get(x: number, y: number, z: number): number {
    const lx = x - this.x0, lz = z - this.z0;
    if (lx < 0 || lx >= 16 || lz < 0 || lz >= 16 || y < MIN_Y || y >= NETHER_TOP) return -1;
    return this.chunk.getBlock(lx, y, lz);
  }
  set(x: number, y: number, z: number, state: number): void {
    const lx = x - this.x0, lz = z - this.z0;
    if (lx < 0 || lx >= 16 || lz < 0 || lz >= 16 || y < 0 || y >= NETHER_TOP) return;
    this.chunk.setBlock(lx, y, lz, state);
  }
}
