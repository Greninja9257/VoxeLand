// Overworld terrain: climate noises -> biome + height, 3D density for overhangs, cheese/spaghetti caves,
// surface rules, ores, bedrock and features (trees/plants) with cross-chunk clipping.
import type { BlockRegistry } from '../../blocks/registry';
import { Random } from '../../math';
import { Chunk, MIN_Y, MAX_Y, SEA_LEVEL, WORLD_HEIGHT } from '../chunk';
import { BIOMES, selectOverworldBiome, biomeId, type BiomeDef } from './biomes';
import { FBM, Perlin, spline, hashSeed } from './noise';
import { FeatureStates, TreeGen, placeOreBlob, type BlockSink } from './features';
import { StructureManager, VILLAGE, type StructureGenContext } from './structures';
import { STRONGHOLD } from './stronghold';
import type { StructureBundle } from './jigsaw';

export interface Climate { T: number; H: number; C: number; E: number; W: number; PV: number }

export interface Generator {
  generate(cx: number, cz: number): Chunk;
  spawnHeight(x: number, z: number): number;
  /** nearest structure start of a type (block coords) for /locate */
  locate?(type: string, x: number, z: number): [number, number] | null;
}

const LAVA_LEVEL = -54;

export class OverworldGen implements Generator {
  private tempN: FBM; private humN: FBM; private contN: FBM; private erosN: FBM; private weirdN: FBM;
  private detailN: FBM; private terrain3: FBM; private cheese: FBM; private spag1: Perlin; private spag2: Perlin; private surfN: Perlin; private ravineN: Perlin; private caveBiomeN: Perlin;
  private st: FeatureStates;
  private trees: TreeGen;
  structures: StructureManager;
  private gridCache = new Map<number, Float32Array>();
  private columnCache = new Map<number, { blocks: Uint16Array; biome: number; h: number }>();
  private climateCache = new Map<number, { c: Climate; h: number; biome: number }>();
  private badlandsBands: number[] = [];
  // states
  private S: Record<string, number> = {};

  constructor(public seed: number, public reg: BlockRegistry, bundle: StructureBundle | null = null) {
    this.tempN = new FBM(seed + 11, 3, 2, 0.5);
    this.humN = new FBM(seed + 22, 3, 2, 0.5);
    this.contN = new FBM(seed + 33, 6, 2, 0.55);
    this.erosN = new FBM(seed + 44, 4, 2, 0.5);
    this.weirdN = new FBM(seed + 55, 4, 2, 0.5);
    this.detailN = new FBM(seed + 66, 3, 2, 0.5);
    this.terrain3 = new FBM(seed + 77, 3, 2, 0.5);
    this.cheese = new FBM(seed + 88, 2, 2, 0.5);
    this.spag1 = new Perlin(seed + 99);
    this.spag2 = new Perlin(seed + 111);
    this.surfN = new Perlin(seed + 122);
    this.ravineN = new Perlin(seed + 133);
    this.caveBiomeN = new Perlin(seed + 144);
    this.st = new FeatureStates(reg);
    this.trees = new TreeGen(reg, this.st);
    const sctx: StructureGenContext = { seed, reg, st: this.st, trees: this.trees, dimension: 'overworld', bundle, probe: (x, y, z) => this.probeBlock(x, y, z), surfaceY: (x, z) => this.surfaceY(x, z), biomeAt: (x, z) => BIOMES[this.columnInfo(x, z).biome] };
    this.structures = new StructureManager(sctx, bundle ? [VILLAGE, STRONGHOLD] : [STRONGHOLD]);
    const names = ['stone', 'deepslate', 'dirt', 'grass_block', 'water', 'lava', 'bedrock', 'sand', 'sandstone', 'red_sand', 'red_sandstone', 'gravel', 'snow_block', 'ice', 'packed_ice', 'podzol', 'mycelium', 'coarse_dirt', 'terracotta', 'mud', 'clay', 'calcite', 'tuff', 'granite', 'diorite', 'andesite', 'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore', 'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore', 'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'short_grass', 'fern', 'dead_bush', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'brown_mushroom', 'red_mushroom', 'lily_pad', 'seagrass', 'kelp', 'kelp_plant', 'pumpkin', 'melon', 'cactus', 'sugar_cane', 'bamboo', 'sweet_berry_bush', 'moss_block', 'moss_carpet', 'glow_lichen', 'dripstone_block', 'pointed_dripstone', 'spore_blossom', 'sculk', 'pink_petals', 'wildflowers', 'bush', 'leaf_litter', 'firefly_bush', 'cave_air', 'pale_moss_block', 'pale_moss_carpet', 'stone_button', 'mossy_cobblestone', 'cobblestone'];
    for (const n of names) this.S[n] = reg.defaultState(n);
    const brnd = new Random(seed ^ 0x5bd1e995);
    const colors = ['terracotta', 'orange_terracotta', 'yellow_terracotta', 'white_terracotta', 'red_terracotta', 'brown_terracotta', 'light_gray_terracotta'];
    for (let y = 0; y < 64; y++) this.badlandsBands.push(reg.defaultState('terracotta'));
    for (let i = 0; i < 14; i++) { const y = brnd.nextInt(60); const c = colors[brnd.nextInt(colors.length)]; const len = 1 + brnd.nextInt(3); for (let j = 0; j < len; j++) this.badlandsBands[Math.min(63, y + j)] = reg.defaultState(c); }
  }

  private s(name: string): number { return this.S[name] ?? (this.S[name] = this.reg.defaultState(name)); }

  // ---------- climate & height ----------
  climate(x: number, z: number): Climate {
    const T = this.tempN.noise2(x, z, 1 / 1200) * 1.2;
    const H = this.humN.noise2(x + 5000, z - 3000, 1 / 900) * 1.2;
    const C = this.contN.noise2(x - 9000, z + 7000, 1 / 1800) * 1.4 + 0.1;
    const E = this.erosN.noise2(x + 2000, z + 2000, 1 / 1400) * 1.3;
    const W = this.weirdN.noise2(x - 4000, z - 8000, 1 / 700) * 1.3;
    const PV = 1 - Math.abs(3 * Math.abs(W) - 2);
    return { T: clamp1(T), H: clamp1(H), C: clamp1(C), E: clamp1(E), W: clamp1(W), PV: clamp1(PV) };
  }

  /** Terrain target height for a column (before 3D noise). */
  heightFromClimate(c: Climate, x: number, z: number): number {
    const base = spline([[-1, 18], [-0.6, 32], [-0.45, 44], [-0.2, 56], [-0.11, 62], [-0.05, 65], [0.05, 68], [0.3, 76], [0.6, 88], [1, 100]], c.C);
    const amp = spline([[-1, 110], [-0.6, 70], [-0.3, 40], [0, 22], [0.4, 10], [1, 3]], c.E);
    const landFactor = spline([[-0.3, 0.15], [-0.11, 0.5], [0, 1]], c.C);
    let h = base + (c.PV * 0.5 + 0.5) * amp * landFactor - amp * landFactor * 0.25;
    // extra jaggedness for real peaks
    if (c.PV > 0.5 && c.E < -0.3) h += (c.PV - 0.5) * 2 * 40 * (-c.E);
    h += this.detailN.noise2(x, z, 1 / 60) * 4;
    // rivers along weirdness ~ 0 on land
    const river = clamp01(1 - Math.abs(c.W) / 0.07);
    if (c.C > -0.15 && river > 0) {
      const riverDepth = SEA_LEVEL - 3 + this.detailN.noise2(x + 100, z, 1 / 30) * 1.5;
      const t = river * river * (3 - 2 * river);
      h = h * (1 - t) + Math.min(h, riverDepth) * t;
    }
    return h;
  }

  columnInfo(x: number, z: number): { c: Climate; h: number; biome: number } {
    const key = ((x + 0x800000) * 0x1000000) + (z + 0x800000);
    let v = this.climateCache.get(key);
    if (v) return v;
    const c = this.climate(x, z);
    const h = this.heightFromClimate(c, x, z);
    const biome = selectOverworldBiome(c.T, c.H, c.C, c.E, c.PV, c.W, h, SEA_LEVEL);
    v = { c, h, biome };
    if (this.climateCache.size > 20000) this.climateCache.clear();
    this.climateCache.set(key, v);
    return v;
  }

  // ---------- 3D noise grid (4x4x4 cells, cached per grid column; 4 channels: terrain, cheese, spaghetti1, spaghetti2) ----------
  private gridColumn(gx: number, gz: number): Float32Array {
    const key = (gx + 0x80000) * 0x100000 + (gz + 0x80000);
    let col = this.gridCache.get(key);
    if (col) return col;
    const n = WORLD_HEIGHT / 4 + 1;
    col = new Float32Array(n * 4);
    const x = gx * 4, z = gz * 4;
    for (let i = 0; i < n; i++) {
      const y = MIN_Y + i * 4;
      col[i * 4] = this.terrain3.noise3(x / 48, y / 32, z / 48, 1);
      col[i * 4 + 1] = this.cheese.noise3(x / 70, y / 45, z / 70, 1);
      col[i * 4 + 2] = this.spag1.noise3(x / 38, y / 26, z / 38);
      col[i * 4 + 3] = this.spag2.noise3(x / 38 + 100, y / 26, z / 38 + 100);
    }
    if (this.gridCache.size > 6000) this.gridCache.clear();
    this.gridCache.set(key, col);
    return col;
  }

  // ---------- column generation (terrain + caves + surface), deterministic per column ----------
  private column(x: number, z: number): { blocks: Uint16Array; biome: number; h: number } {
    const key = ((x + 0x800000) * 0x1000000) + (z + 0x800000);
    let col = this.columnCache.get(key);
    if (col) return col;
    const info = this.columnInfo(x, z);
    const blocks = new Uint16Array(WORLD_HEIGHT);
    this.fillColumn(x, z, info, blocks);
    col = { blocks, biome: info.biome, h: info.h };
    if (this.columnCache.size > 4096) this.columnCache.clear();
    this.columnCache.set(key, col);
    return col;
  }

  private fillColumn(x: number, z: number, info: { c: Climate; h: number; biome: number }, blocks: Uint16Array): void {
    const { c, h } = info;
    const biome = BIOMES[info.biome];
    const S = this.S;
    const stone = S.stone, deepslate = S.deepslate, water = S.water, lava = S.lava, air = 0;
    const amp = 10 + Math.max(0, c.PV) * 14 * Math.max(0, -c.E);
    const jag = 1 + Math.max(0, c.PV - 0.4) * 2;
    const hInt = Math.floor(h);
    const bandLo = hInt - 18, bandHi = hInt + Math.ceil(amp * 1.2 * jag) + 2;
    const rnd = hashSeed(this.seed, x, z);
    const deepslateBlend = (rnd & 7);
    // grid columns for trilinear interpolation
    const gx = Math.floor(x / 4), gz = Math.floor(z / 4);
    const fx = (x - gx * 4) / 4, fz = (z - gz * 4) / 4;
    const c00 = this.gridColumn(gx, gz), c10 = this.gridColumn(gx + 1, gz), c01 = this.gridColumn(gx, gz + 1), c11 = this.gridColumn(gx + 1, gz + 1);
    const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
    const sample = (ch: number, y: number): number => {
      const gy = (y - MIN_Y) >> 2, fy = ((y - MIN_Y) & 3) / 4;
      const i0 = gy * 4 + ch, i1 = i0 + 4;
      const lo = c00[i0] * w00 + c10[i0] * w10 + c01[i0] * w01 + c11[i0] * w11;
      const hi = c00[i1] * w00 + c10[i1] * w10 + c01[i1] * w01 + c11[i1] * w11;
      return lo + (hi - lo) * fy;
    };
    // solid / air / water
    for (let y = MIN_Y; y < MAX_Y; y++) {
      let solid: boolean;
      if (y < bandLo) solid = true;
      else if (y > bandHi) solid = false;
      else solid = (h - y) / amp + sample(0, y) * 0.85 * jag > 0;
      const i = y - MIN_Y;
      if (solid) blocks[i] = y < deepslateBlend ? deepslate : stone;
      else blocks[i] = y < SEA_LEVEL ? water : air;
    }
    // find top solid
    let top = MAX_Y - 1;
    while (top > MIN_Y && (blocks[top - MIN_Y] === air || blocks[top - MIN_Y] === water)) top--;
    const underwater = top < SEA_LEVEL - 1;
    // caves (not too close to ocean floors)
    const caveTop = underwater ? top - 8 : top - 1;
    const caveBiome = this.caveBiomeN.noise3(x / 160, 0, z / 160);
    const rv = this.ravineN.noise2(x / 90, z / 90);
    const ravine = Math.abs(rv) < 0.018 && this.ravineN.noise2(x / 30 + 50, z / 30) > -0.2;
    for (let y = -60; y <= caveTop && y < MAX_Y - 1; y++) {
      const i = y - MIN_Y;
      const b = blocks[i];
      if (b !== stone && b !== deepslate) continue;
      const depthT = (top - y) > 60 ? 1 : (top - y) / 60;
      let carve = sample(1, y) > 0.62 - depthT * 0.22 - (y < 0 ? 0.05 : 0);
      if (!carve) {
        const thick = 0.045 + depthT * 0.03;
        const s1 = sample(2, y);
        if (s1 < thick && s1 > -thick) { const s2 = sample(3, y); carve = s2 < thick && s2 > -thick; }
        if (!carve && ravine && y > top - 70 && y < top - 4) carve = true;
      }
      if (carve) blocks[i] = y <= LAVA_LEVEL ? lava : (S.cave_air || 0);
    }
    // re-find top
    top = MAX_Y - 1;
    while (top > MIN_Y && (blocks[top - MIN_Y] === air || blocks[top - MIN_Y] === water || blocks[top - MIN_Y] === S.cave_air)) top--;
    // surface
    this.applySurface(x, z, info, biome, blocks, top, underwater, caveBiome);
    // bedrock
    blocks[0] = S.bedrock;
    for (let y = 1; y < 5; y++) if ((hashSeed(this.seed, x, z, y) % 5) >= y) blocks[y] = S.bedrock;
    // lush/dripstone cave decoration hint stored via biome only
  }

  private applySurface(x: number, z: number, info: { c: Climate; h: number; biome: number }, biome: BiomeDef, blocks: Uint16Array, top: number, underwater: boolean, caveBiome: number): void {
    const S = this.S;
    const depthNoise = this.surfN.noise2(x / 12, z / 12);
    const depth = 3 + Math.floor((depthNoise + 1) * 1.5);
    const topState = this.s(biome.top), filler = this.s(biome.filler), uw = this.s(biome.underwater);
    const topI = top - MIN_Y;
    const isStone = (s: number) => s === S.stone || s === S.deepslate;
    const stoneySurface = biome.top === 'stone';
    if (topI < 0 || topI >= blocks.length) return;
    if (!isStone(blocks[topI])) return;
    const mountainStone = info.c.PV > 0.55 && top > 120 && (biome.name === 'snowy_slopes' || biome.name === 'grove' || biome.name === 'windswept_hills' || biome.name === 'windswept_forest' || biome.name === 'meadow');
    if (underwater) {
      for (let i = 0; i < depth; i++) { const y = top - i; if (y < MIN_Y) break; if (isStone(blocks[y - MIN_Y])) blocks[y - MIN_Y] = i < depth ? uw : uw; }
      if (biome.name.includes('ocean') && depthNoise > 0.5) for (let i = 0; i < depth; i++) { const y = top - i; if (isStone(blocks[y - MIN_Y]) || blocks[y - MIN_Y] === uw) blocks[y - MIN_Y] = depthNoise > 0.75 ? S.clay : S.sand; }
      return;
    }
    if (biome.name === 'badlands' || biome.name === 'eroded_badlands' || biome.name === 'wooded_badlands') {
      for (let y = top; y > top - 20 && y >= MIN_Y; y--) {
        const i = y - MIN_Y;
        if (!isStone(blocks[i])) continue;
        if (y === top && biome.name !== 'wooded_badlands') blocks[i] = y > 75 ? this.badlandsBands[(y + 3) & 63] : S.red_sand;
        else if (y === top) blocks[i] = S.coarse_dirt;
        else if (top - y < 4 && top <= 75) blocks[i] = S.red_sandstone;
        else blocks[i] = this.badlandsBands[(y + 3) & 63];
      }
      return;
    }
    if (mountainStone || stoneySurface) {
      if (biome.name === 'stony_peaks' && depthNoise > 0.3) for (let i = 0; i < depth; i++) blocks[top - i - MIN_Y] = S.calcite;
      if (biome.name === 'jagged_peaks' || biome.name === 'frozen_peaks') { blocks[topI] = depthNoise > -0.2 ? S.snow_block : (biome.name === 'frozen_peaks' ? S.packed_ice : S.stone); }
      if (biome.name === 'windswept_gravelly_hills') for (let i = 0; i < depth; i++) blocks[top - i - MIN_Y] = S.gravel;
      return;
    }
    const beachSand = biome.beach || (top <= SEA_LEVEL + 1 && info.c.C < -0.05 && !biome.river);
    for (let i = 0; i < depth; i++) {
      const y = top - i; if (y < MIN_Y) break;
      const bi = y - MIN_Y;
      if (!isStone(blocks[bi])) continue;
      if (beachSand && biome.top !== 'gravel' && biome.top !== 'stone') { blocks[bi] = i < depth - 1 ? S.sand : S.sandstone; continue; }
      blocks[bi] = i === 0 ? topState : filler;
      if (biome.top === 'sand' && i >= 3) blocks[bi] = S.sandstone;
      if (biome.top === 'red_sand' && i >= 3) blocks[bi] = S.red_sandstone;
    }
    if (biome.top === 'sand' && depth < 4) for (let i = depth; i < 5; i++) { const y = top - i; if (y >= MIN_Y && isStone(blocks[y - MIN_Y])) blocks[y - MIN_Y] = S.sandstone; }
    // snow layers & ice
    if (biome.precipitation === 'snow' || (biome.mountain && top > 150 && info.c.T < 0.4) || (top > 190 && info.c.T < 0.75)) {
      if (top + 1 < MAX_Y && blocks[topI + 1] === 0) blocks[topI + 1] = this.s('snow');
      if (blocks[topI] === S.grass_block && (biome.name === 'snowy_plains' || biome.name === 'snowy_taiga' || biome.name === 'grove' || biome.name === 'snowy_slopes' || biome.name === 'ice_spikes' || biome.name === 'snowy_beach' || biome.name === 'frozen_river')) {
        blocks[topI] = this.st.withProps('grass_block', { snowy: 'true' });
      }
      if (blocks[topI] === S.water) blocks[topI] = S.ice;
    }
    if ((biome.name === 'frozen_ocean' || biome.name === 'frozen_river' || biome.name === 'snowy_beach') && blocks[SEA_LEVEL - 1 - MIN_Y] === S.water) blocks[SEA_LEVEL - 1 - MIN_Y] = S.ice;
    // deep dark / lush / dripstone caves: modify cave floors
    if (caveBiome > 0.55) {
      for (let y = -40; y < Math.min(top - 10, 60); y++) {
        const i = y - MIN_Y;
        if (blocks[i] === S.stone && (blocks[i + 1] === S.cave_air || blocks[i + 1] === 0) && (hashSeed(this.seed, x, y, z) % 3) === 0) blocks[i] = caveBiome > 0.7 ? S.moss_block : S.dripstone_block;
      }
    }
  }

  // ---------- chunk generation ----------
  generate(cx: number, cz: number): Chunk {
    const chunk = new Chunk(cx, cz);
    const x0 = cx * 16, z0 = cz * 16;
    const columns: { blocks: Uint16Array; biome: number; h: number }[] = new Array(256);
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
      const col = this.column(x0 + lx, z0 + lz);
      columns[(lz << 4) | lx] = col;
      chunk.biomes[(lz << 4) | lx] = col.biome;
      const blocks = col.blocks;
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        const st = blocks[y];
        if (st === 0) continue;
        const si = y >> 4;
        let sec = chunk.sections[si];
        if (!sec) sec = chunk.sections[si] = new Uint16Array(4096);
        sec[((y & 15) << 8) | (lz << 4) | lx] = st;
      }
    }
    const sink = new ChunkSink(this, chunk);
    // structures go in before features so trees avoid them (vanilla: structure starts precede features)
    chunk.structures = this.structures.apply(chunk, sink);
    // tree placement checks always read the pristine terrain (+ structures) so both sides of a chunk border agree
    this.trees.checkSink = { get: (x, y, z) => { const st = this.structures.blockAt(x, y, z); return st >= 0 ? st : this.probeBlock(x, y, z); }, set: () => {} };
    // ores + features from this chunk and its neighbours (clipped)
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      this.placeOres(sink, cx + dx, cz + dz);
      this.placeTrees(sink, cx + dx, cz + dz, dx === 0 && dz === 0);
    }
    this.trees.checkSink = null;
    this.placeDungeons(sink, chunk);
    this.placePlants(sink, cx, cz);
    this.computeHeightmap(chunk);
    chunk.decorated = true;
    return chunk;
  }

  locate(type: string, x: number, z: number): [number, number] | null { return this.structures.locate(type, x, z); }

  computeHeightmap(chunk: Chunk): void {
    const reg = this.reg;
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
      let y = MAX_Y - 1;
      while (y >= MIN_Y) {
        const s = chunk.getBlock(lx, y, lz);
        if (s !== 0 && !reg.isAir(s)) break;
        y--;
      }
      chunk.heightmap[(lz << 4) | lx] = y + 1;
    }
  }

  spawnHeight(x: number, z: number): number {
    const col = this.column(x, z);
    let y = MAX_Y - 1;
    while (y > MIN_Y && (col.blocks[y - MIN_Y] === 0 || col.blocks[y - MIN_Y] === this.S.cave_air)) y--;
    return y + 1;
  }

  /** Surface y (top non-air block + 1) for a column outside the chunk (probe). */
  surfaceY(x: number, z: number): number {
    const col = this.column(x, z);
    let y = MAX_Y - 1;
    while (y > MIN_Y && (col.blocks[y - MIN_Y] === 0 || col.blocks[y - MIN_Y] === this.S.cave_air)) y--;
    return y + 1;
  }

  probeBlock(x: number, y: number, z: number): number {
    if (y < MIN_Y || y >= MAX_Y) return 0;
    return this.column(x, z).blocks[y - MIN_Y];
  }

  // ---------- ores ----------
  private placeOres(sink: BlockSink, cx: number, cz: number): void {
    const rnd = new Random(hashSeed(this.seed, cx, cz, 0x0e5));
    const S = this.S;
    const stoneTargets = (s: number): 0 | 1 | 2 => (s === S.stone || s === S.granite || s === S.diorite || s === S.andesite || s === S.tuff ? 1 : s === S.deepslate ? 2 : 0);
    const x0 = cx * 16, z0 = cz * 16;
    const uniform = (min: number, max: number) => min + rnd.nextInt(max - min + 1);
    const triangle = (min: number, max: number) => { const a = uniform(min, max), b = uniform(min, max); return Math.floor((a + b) / 2); };
    const tcx = (sink as ChunkSink).chunk.cx, tcz = (sink as ChunkSink).chunk.cz;
    const blob = (count: number, size: number, ore: string, deep: string, yfn: () => number, chance = 1) => {
      for (let i = 0; i < count; i++) {
        if (chance < 1 && rnd.next() > chance) continue;
        const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16), y = yfn();
        const reach = size / 8 + size / 16 + 2;
        if (x < tcx * 16 - reach || x >= tcx * 16 + 16 + reach || z < tcz * 16 - reach || z >= tcz * 16 + 16 + reach) continue;
        placeOreBlob(noProbe, new Random(hashSeed(this.seed, x, y, z)), x, y, z, size, this.s(ore), this.s(deep), stoneTargets);
      }
    };
    const noProbe = (sink as ChunkSink).noProbe();
    // vanilla-ish 1.18+ distributions
    blob(10, 33, 'dirt', 'dirt', () => uniform(0, 160));
    blob(8, 33, 'gravel', 'gravel', () => uniform(-64, 320));
    blob(6, 64, 'granite', 'granite', () => uniform(0, 60), 0.5); blob(6, 64, 'diorite', 'diorite', () => uniform(0, 60), 0.5); blob(6, 64, 'andesite', 'andesite', () => uniform(0, 60), 0.5);
    blob(2, 64, 'granite', 'granite', () => uniform(64, 128), 0.3); blob(2, 64, 'diorite', 'diorite', () => uniform(64, 128), 0.3); blob(2, 64, 'andesite', 'andesite', () => uniform(64, 128), 0.3);
    blob(2, 64, 'tuff', 'tuff', () => uniform(-64, 0));
    blob(20, 17, 'coal_ore', 'deepslate_coal_ore', () => triangle(0, 192));
    blob(30, 17, 'coal_ore', 'deepslate_coal_ore', () => uniform(136, 320), 0.5);
    blob(10, 9, 'iron_ore', 'deepslate_iron_ore', () => triangle(-24, 56));
    blob(10, 9, 'iron_ore', 'deepslate_iron_ore', () => triangle(80, 384), 0.6);
    blob(10, 4, 'iron_ore', 'deepslate_iron_ore', () => uniform(-64, 72));
    blob(16, 10, 'copper_ore', 'deepslate_copper_ore', () => triangle(-16, 112));
    blob(4, 9, 'gold_ore', 'deepslate_gold_ore', () => triangle(-64, 32));
    blob(1, 9, 'gold_ore', 'deepslate_gold_ore', () => uniform(-64, -48), 0.5);
    blob(4, 8, 'redstone_ore', 'deepslate_redstone_ore', () => uniform(-64, 15));
    blob(8, 8, 'redstone_ore', 'deepslate_redstone_ore', () => triangle(-96, -32));
    blob(2, 7, 'lapis_ore', 'deepslate_lapis_ore', () => triangle(-32, 32));
    blob(4, 7, 'lapis_ore', 'deepslate_lapis_ore', () => uniform(-64, 64), 0.5);
    blob(7, 4, 'diamond_ore', 'deepslate_diamond_ore', () => triangle(-144, 16), 0.85);
    blob(4, 8, 'diamond_ore', 'deepslate_diamond_ore', () => triangle(-144, 16), 0.25);
    blob(1, 12, 'diamond_ore', 'deepslate_diamond_ore', () => triangle(-144, 16), 0.11);
    const biome = BIOMES[this.columnInfo(x0 + 8, z0 + 8).biome];
    if (biome.extra?.includes('emerald')) blob(50, 3, 'emerald_ore', 'deepslate_emerald_ore', () => triangle(-16, 480), 0.6);
    if (biome.extra?.includes('gold')) blob(50, 9, 'gold_ore', 'deepslate_gold_ore', () => uniform(32, 256), 0.3);
    // clay / sand in rivers & lakes handled by surface
  }

  // ---------- trees ----------
  private placeTrees(sink: ProbeSinkLike, cx: number, cz: number, self: boolean): void {
    const rnd = new Random(hashSeed(this.seed, cx, cz, 0x7ee));
    const x0 = cx * 16, z0 = cz * 16;
    const biome = BIOMES[this.columnInfo(x0 + 8, z0 + 8).biome];
    const tcx = sink.chunk.cx, tcz = sink.chunk.cz;
    for (const [type, count] of biome.trees) {
      const n = Math.floor(count) + (rnd.next() < count - Math.floor(count) ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16);
        const treeRnd = new Random(hashSeed(this.seed, x, z, 0x77));
        // skip trees that can't reach the target chunk
        if (!self) {
          const reach = 8;
          if (x < tcx * 16 - reach || x >= tcx * 16 + 16 + reach || z < tcz * 16 - reach || z >= tcz * 16 + 16 + reach) continue;
        }
        const colBiome = BIOMES[this.columnInfo(x, z).biome];
        if (colBiome !== biome && !colBiome.trees.some((t) => t[0] === type)) continue;
        const y = this.surfaceYVia(sink, x, z);
        if (y <= SEA_LEVEL - 2 && type !== 'mangrove') continue;
        if (y >= MAX_Y - 30) continue;
        this.trees.place(type, sink, treeRnd, x, y, z);
      }
    }
  }

  private surfaceYVia(_sink: ProbeSinkLike, x: number, z: number): number {
    return this.surfaceY(x, z);
  }

  // ---------- dungeons (vanilla MonsterRoomFeature: monster_room ×10 at y 0..top, monster_room_deep ×4 at y -58..10) ----------
  private placeDungeons(sink: BlockSink, chunk: Chunk): void {
    const rnd = new Random(hashSeed(this.seed, chunk.cx, chunk.cz, 0xd0e));
    const reg = this.reg, S = this.S;
    const x0 = chunk.cx * 16, z0 = chunk.cz * 16;
    const solid = (x: number, y: number, z: number) => { const st = sink.get(x, y, z); return st > 0 && !reg.isFluid(st) && reg.fullCube[st] === 1; };
    const empty = (x: number, y: number, z: number) => { const st = sink.get(x, y, z); return st === 0 || reg.isAir(st); };
    // twice the vanilla attempt counts: our caves are sparser and rooms can't straddle the chunk border here
    for (let attempt = 0; attempt < 28; attempt++) {
      const deep = attempt >= 20;
      const ox = x0 + 4 + rnd.nextInt(8), oz = z0 + 4 + rnd.nextInt(8);
      const oy = deep ? -58 + rnd.nextInt(69) : rnd.nextInt(256);
      if (oy < MIN_Y + 6) continue;
      const rx = rnd.nextInt(2) + 2, rz = rnd.nextInt(2) + 2;
      let openings = 0, ok = true;
      for (let x = ox - rx - 1; x <= ox + rx + 1 && ok; x++) for (let y = oy - 1; y <= oy + 4 && ok; y++) for (let z = oz - rz - 1; z <= oz + rz + 1; z++) {
        const isSolid = solid(x, y, z);
        if ((y === oy - 1 || y === oy + 4) && !isSolid) { ok = false; break; }
        if ((x === ox - rx - 1 || x === ox + rx + 1 || z === oz - rz - 1 || z === oz + rz + 1) && y === oy && empty(x, y, z) && empty(x, y + 1, z)) openings++;
      }
      if (!ok || openings < 1 || openings > 5) continue;
      for (let x = ox - rx - 1; x <= ox + rx + 1; x++) for (let y = oy + 3; y >= oy - 1; y--) for (let z = oz - rz - 1; z <= oz + rz + 1; z++) {
        const wall = x === ox - rx - 1 || x === ox + rx + 1 || y === oy - 1 || y === oy + 4 || z === oz - rz - 1 || z === oz + rz + 1;
        if (!wall) { sink.set(x, y, z, 0); continue; }
        if (y >= oy && !solid(x, y - 1, z)) sink.set(x, y, z, 0);
        else if (solid(x, y, z)) sink.set(x, y, z, y === oy - 1 && rnd.nextInt(4) !== 0 ? S.mossy_cobblestone : S.cobblestone);
      }
      // up to two chests against a single wall (vanilla: 3 tries each)
      for (let k = 0; k < 2; k++) for (let t = 0; t < 3; t++) {
        const x = ox + rnd.nextInt(rx * 2 + 1) - rx, z = oz + rnd.nextInt(rz * 2 + 1) - rz;
        if (!empty(x, oy, z)) continue;
        let walls = 0; if (solid(x - 1, oy, z)) walls++; if (solid(x + 1, oy, z)) walls++; if (solid(x, oy, z - 1)) walls++; if (solid(x, oy, z + 1)) walls++;
        if (walls !== 1) continue;
        sink.set(x, oy, z, this.st.withProps('chest', { facing: ['north', 'south', 'west', 'east'][rnd.nextInt(4)] }));
        chunk.setBlockEntity(x & 15, oy, z & 15, { type: 'chest', x, y: oy, z, lootTable: 'chests/simple_dungeon', invSize: 27 } as any);
        break;
      }
      sink.set(ox, oy, oz, this.st.id('spawner'));
      chunk.setBlockEntity(ox & 15, oy, oz & 15, { type: 'spawner', x: ox, y: oy, z: oz, mob: ['skeleton', 'zombie', 'zombie', 'spider'][rnd.nextInt(4)], invSize: 0 } as any);
    }
  }

  // ---------- plants & small features (within chunk) ----------
  private placePlants(sink: BlockSink, cx: number, cz: number): void {
    const rnd = new Random(hashSeed(this.seed, cx, cz, 0x91a));
    const x0 = cx * 16, z0 = cz * 16;
    const reg = this.reg, S = this.S;
    const topOf = (x: number, z: number): number => {
      let y = MAX_Y - 1;
      while (y > MIN_Y) { const s = sink.get(x, y, z); if (s !== 0 && s !== S.cave_air) break; y--; }
      return y;
    };
    const isGrass = (s: number) => s === S.grass_block || reg.nameOf(s) === 'grass_block';
    const placeDouble = (x: number, y: number, z: number, name: string) => {
      if (sink.get(x, y, z) !== 0 || sink.get(x, y + 1, z) !== 0) return;
      sink.set(x, y, z, this.st.withProps(name, { half: 'lower' })); sink.set(x, y + 1, z, this.st.withProps(name, { half: 'upper' }));
    };
    const centerBiome = BIOMES[this.columnInfo(x0 + 8, z0 + 8).biome];
    const extra = new Set(centerBiome.extra ?? []);
    // grass patches
    const patch = (attempts: number, fn: (x: number, y: number, z: number, b: BiomeDef) => void) => {
      for (let i = 0; i < attempts; i++) {
        const px = x0 + rnd.nextInt(16), pz = z0 + rnd.nextInt(16);
        const b = BIOMES[this.columnInfo(px, pz).biome];
        const y = topOf(px, pz);
        fn(px, y, pz, b);
      }
    };
    const grassAttempts = centerBiome.grass * 8;
    patch(grassAttempts, (x, y, z, b) => {
      const g = sink.get(x, y, z);
      if (!isGrass(g) || sink.get(x, y + 1, z) !== 0) return;
      const r = rnd.next();
      const taiga = b.name.includes('taiga') || b.name === 'grove';
      if (r < 0.1 && b.grass > 3) placeDouble(x, y + 1, z, taiga ? 'large_fern' : 'tall_grass');
      else sink.set(x, y + 1, z, taiga && r < 0.6 ? S.fern : S.short_grass);
    });
    // flowers
    const flowerSet = centerBiome.name === 'flower_forest' ? ['dandelion', 'poppy', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley']
      : centerBiome.name === 'meadow' ? ['dandelion', 'poppy', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower'] : centerBiome.name === 'swamp' ? ['blue_orchid'] : centerBiome.name === 'plains' || centerBiome.name === 'sunflower_plains' ? ['dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip'] : ['dandelion', 'poppy'];
    patch(centerBiome.flowers * 3, (x, y, z) => {
      const g = sink.get(x, y, z);
      if (!isGrass(g) || sink.get(x, y + 1, z) !== 0) return;
      sink.set(x, y + 1, z, this.s(flowerSet[rnd.nextInt(flowerSet.length)]));
    });
    if (extra.has('tall_flowers') || centerBiome.name === 'flower_forest') patch(6, (x, y, z) => { if (isGrass(sink.get(x, y, z))) placeDouble(x, y + 1, z, ['lilac', 'rose_bush', 'peony'][rnd.nextInt(3)]); });
    if (extra.has('sunflower')) patch(10, (x, y, z) => { if (isGrass(sink.get(x, y, z))) placeDouble(x, y + 1, z, 'sunflower'); });
    if (extra.has('pink_petals')) patch(24, (x, y, z) => { if (isGrass(sink.get(x, y, z)) && sink.get(x, y + 1, z) === 0) sink.set(x, y + 1, z, this.st.withProps('pink_petals', { flower_amount: String(1 + rnd.nextInt(4)), facing: ['north', 'south', 'west', 'east'][rnd.nextInt(4)] })); });
    if (centerBiome.name === 'plains' || centerBiome.name === 'sunflower_plains' || centerBiome.name === 'forest' || centerBiome.name === 'birch_forest' || centerBiome.name === 'meadow') {
      patch(3, (x, y, z) => { if (isGrass(sink.get(x, y, z)) && sink.get(x, y + 1, z) === 0 && S.bush) sink.set(x, y + 1, z, S.bush); });
      patch(4, (x, y, z) => { if (isGrass(sink.get(x, y, z)) && sink.get(x, y + 1, z) === 0 && S.wildflowers && centerBiome.name !== 'forest') sink.set(x, y + 1, z, this.st.withProps('wildflowers', { flower_amount: String(1 + rnd.nextInt(4)) })); });
      patch(6, (x, y, z) => { if (isGrass(sink.get(x, y, z)) && sink.get(x, y + 1, z) === 0 && S.leaf_litter && centerBiome.name === 'forest') sink.set(x, y + 1, z, this.st.withProps('leaf_litter', { segment_amount: String(1 + rnd.nextInt(4)) })); });
    }
    if (extra.has('mushroom')) patch(4, (x, y, z) => { const g = sink.get(x, y, z); if ((isGrass(g) || g === S.podzol || g === S.mycelium || g === S.dirt) && sink.get(x, y + 1, z) === 0 && rnd.next() < 0.3) sink.set(x, y + 1, z, rnd.next() < 0.5 ? S.brown_mushroom : S.red_mushroom); });
    if (extra.has('dead_bush')) patch(6, (x, y, z) => { const g = sink.get(x, y, z); if ((g === S.sand || g === S.red_sand || g === S.terracotta || g === S.coarse_dirt) && sink.get(x, y + 1, z) === 0) sink.set(x, y + 1, z, S.dead_bush); });
    if (extra.has('cactus')) patch(6, (x, y, z) => {
      if (sink.get(x, y, z) !== S.sand || sink.get(x, y + 1, z) !== 0) return;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (sink.get(x + dx, y + 1, z + dz) !== 0) return;
      const h = 1 + rnd.nextInt(3);
      for (let i = 0; i < h; i++) sink.set(x, y + 1 + i, z, this.s('cactus'));
    });
    if (extra.has('sugar_cane')) patch(8, (x, y, z) => {
      const g = sink.get(x, y, z);
      if (!(g === S.sand || isGrass(g) || g === S.dirt) || sink.get(x, y + 1, z) !== 0) return;
      let nearWater = false;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (sink.get(x + dx, y, z + dz) === S.water) nearWater = true;
      if (!nearWater) return;
      const h = 2 + rnd.nextInt(3);
      for (let i = 0; i < h; i++) sink.set(x, y + 1 + i, z, this.s('sugar_cane'));
    });
    if (extra.has('pumpkin')) patch(1, (x, y, z) => { if (isGrass(sink.get(x, y, z)) && sink.get(x, y + 1, z) === 0 && rnd.next() < 0.15) { for (let i = 0; i < 4; i++) { const px = x + rnd.nextInt(5) - 2, pz = z + rnd.nextInt(5) - 2; const py = topOf(px, pz); if (isGrass(sink.get(px, py, pz)) && sink.get(px, py + 1, pz) === 0) sink.set(px, py + 1, pz, this.st.withProps('pumpkin', {})); } } });
    if (extra.has('melon')) patch(2, (x, y, z) => { if (isGrass(sink.get(x, y, z)) && sink.get(x, y + 1, z) === 0 && rnd.next() < 0.3) sink.set(x, y + 1, z, S.melon); });
    if (extra.has('sweet_berries')) patch(3, (x, y, z) => { if (isGrass(sink.get(x, y, z)) && sink.get(x, y + 1, z) === 0 && rnd.next() < 0.4) sink.set(x, y + 1, z, this.st.withProps('sweet_berry_bush', { age: String(1 + rnd.nextInt(3)) })); });
    if (extra.has('bamboo') || extra.has('bamboo_sparse')) patch(extra.has('bamboo') ? 60 : 4, (x, y, z) => {
      const g = sink.get(x, y, z);
      if (!(isGrass(g) || g === S.podzol || g === S.dirt) || sink.get(x, y + 1, z) !== 0) return;
      const h = 4 + rnd.nextInt(10);
      for (let i = 0; i < h; i++) { if (sink.get(x, y + 1 + i, z) !== 0) break; sink.set(x, y + 1 + i, z, this.st.withProps('bamboo', { age: '1', leaves: i >= h - 2 ? 'large' : i >= h - 4 ? 'small' : 'none', stage: '0' })); }
    });
    if (extra.has('lily_pad')) patch(8, (x, y, z) => { if (sink.get(x, y, z) === S.water && sink.get(x, y + 1, z) === 0 && y === SEA_LEVEL - 1) sink.set(x, y + 1, z, S.lily_pad); });
    if (extra.has('kelp') || extra.has('seagrass')) patch(20, (x, y, z) => {
      const floor = (() => { let yy = SEA_LEVEL - 1; while (yy > MIN_Y && sink.get(x, yy, z) === S.water) yy--; return yy; })();
      const g = sink.get(x, floor, z);
      if (g === 0 || g === S.water || floor >= SEA_LEVEL - 2) return;
      if (extra.has('kelp') && rnd.next() < 0.35) {
        const h = 3 + rnd.nextInt(Math.max(1, Math.min(14, SEA_LEVEL - 3 - floor)));
        for (let i = 0; i < h; i++) { if (sink.get(x, floor + 1 + i, z) !== S.water) break; sink.set(x, floor + 1 + i, z, i === h - 1 ? this.st.withProps('kelp', { age: String(rnd.nextInt(20)) }) : S.kelp_plant); }
      } else if (rnd.next() < 0.7) {
        if (rnd.next() < 0.3 && sink.get(x, floor + 2, z) === S.water) { sink.set(x, floor + 1, z, this.st.withProps('tall_seagrass', { half: 'lower' })); sink.set(x, floor + 2, z, this.st.withProps('tall_seagrass', { half: 'upper' })); }
        else sink.set(x, floor + 1, z, S.seagrass);
      }
    });
    if (extra.has('sea_pickle')) patch(6, (x, y, z) => { let yy = SEA_LEVEL - 1; while (yy > MIN_Y && sink.get(x, yy, z) === S.water) yy--; if (sink.get(x, yy, z) === S.sand && sink.get(x, yy + 1, z) === S.water) sink.set(x, yy + 1, z, this.st.withProps('sea_pickle', { pickles: String(1 + rnd.nextInt(4)), waterlogged: 'true' })); });
    if (extra.has('coral')) patch(3, (x, y, z) => {
      let yy = SEA_LEVEL - 1; while (yy > MIN_Y && sink.get(x, yy, z) === S.water) yy--;
      if (sink.get(x, yy, z) !== S.sand) return;
      const kinds = ['tube', 'brain', 'bubble', 'fire', 'horn'];
      const k = kinds[rnd.nextInt(5)];
      for (let i = 0; i < 12; i++) { const px = x + rnd.nextInt(5) - 2, py = yy + rnd.nextInt(3), pz = z + rnd.nextInt(5) - 2; if (sink.get(px, py, pz) === S.water && sink.get(px, py - 1, pz) !== S.water && rnd.next() < 0.7) sink.set(px, py, pz, rnd.next() < 0.6 ? this.s(k + '_coral_block') : this.st.withProps(k + (rnd.next() < 0.5 ? '_coral' : '_coral_fan'), { waterlogged: 'true' })); }
    });
    if (extra.has('ice_spikes')) patch(3, (x, y, z) => {
      if (sink.get(x, y, z) !== S.snow_block && !isGrass(sink.get(x, y, z))) return;
      const h = 6 + rnd.nextInt(10), r = 1 + rnd.nextInt(2);
      for (let dy = 0; dy < h; dy++) { const rr = dy > h - 4 ? 0 : r; for (let dx = -rr; dx <= rr; dx++) for (let dz = -rr; dz <= rr; dz++) if (dx * dx + dz * dz <= rr * rr + 1) sink.set(x + dx, y + 1 + dy, z + dz, S.packed_ice); }
    });
    if (extra.has('desert_well') && rnd.next() < 0.002) this.desertWell(sink, rnd, x0 + 4 + rnd.nextInt(8), z0 + 4 + rnd.nextInt(8), topOf(x0 + 8, z0 + 8));
    // vines on jungle trees are handled by the tree; glow lichen & dripstone in caves
    if (centerBiome.name === 'jungle' || centerBiome.name === 'bamboo_jungle' || centerBiome.name === 'sparse_jungle' || centerBiome.name === 'swamp') {
      for (let i = 0; i < 40; i++) {
        const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16), y = SEA_LEVEL + rnd.nextInt(40);
        if (sink.get(x, y, z) !== 0) continue;
        for (const [dx, dz, face] of [[1, 0, 'east'], [-1, 0, 'west'], [0, 1, 'south'], [0, -1, 'north']] as [number, number, string][]) {
          const n = sink.get(x + dx, y, z + dz);
          if (n > 0 && (reg.nameOf(n).endsWith('_log') || reg.nameOf(n).endsWith('_leaves'))) { sink.set(x, y, z, this.st.withProps('vine', { [face]: 'true' })); break; }
        }
      }
    }
    // cave decoration: glow lichen, dripstone, moss & sculk hints; lava/water pockets skipped
    for (let i = 0; i < 24; i++) {
      const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16), y = -50 + rnd.nextInt(100);
      const s = sink.get(x, y, z);
      if (s !== S.cave_air && s !== 0) continue;
      const below = sink.get(x, y - 1, z), above = sink.get(x, y + 1, z);
      if (below === S.dripstone_block && rnd.next() < 0.6) sink.set(x, y, z, this.st.withProps('pointed_dripstone', { thickness: 'tip', vertical_direction: 'up' }));
      else if (above === S.dripstone_block && rnd.next() < 0.6) sink.set(x, y, z, this.st.withProps('pointed_dripstone', { thickness: 'tip', vertical_direction: 'down' }));
      else if (below === S.moss_block) { if (rnd.next() < 0.5) sink.set(x, y, z, rnd.next() < 0.5 ? S.moss_carpet : S.short_grass); }
      else if (above === S.moss_block && rnd.next() < 0.3) { sink.set(x, y, z, this.st.withProps('cave_vines', { berries: rnd.next() < 0.3 ? 'true' : 'false', age: '0' })); }
      else if (below === S.stone && y < 0 && rnd.next() < 0.1 && (this.caveBiomeN.noise3(x / 160, 0, z / 160) < -0.6)) sink.set(x, y - 1, z, S.sculk);
      else if ((below === S.stone || below === S.deepslate) && rnd.next() < 0.15) {
        for (const [dx, dy, dz, face] of [[1, 0, 0, 'east'], [-1, 0, 0, 'west'], [0, 1, 0, 'up'], [0, -1, 0, 'down'], [0, 0, 1, 'south'], [0, 0, -1, 'north']] as [number, number, number, string][]) {
          const n = sink.get(x + dx, y + dy, z + dz);
          if (n === S.stone || n === S.deepslate) { sink.set(x, y, z, this.st.withProps('glow_lichen', { [face]: 'true' })); break; }
        }
      }
    }
    // snow layers on newly placed plants are not needed; ensure snow on top of trees in cold biomes
    if (centerBiome.precipitation === 'snow') {
      for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        const x = x0 + lx, z = z0 + lz; const y = topOf(x, z);
        const s = sink.get(x, y, z);
        if (s > 0 && (reg.nameOf(s).endsWith('_leaves') || s === S.grass_block || s === S.dirt || s === S.stone) && sink.get(x, y + 1, z) === 0 && this.reg.fullCube[s]) sink.set(x, y + 1, z, this.s('snow'));
      }
    }
  }

  private desertWell(sink: BlockSink, rnd: Random, x: number, z: number, y: number): void {
    const ss = this.s('sandstone'), slab = this.st.withProps('sandstone_slab', { type: 'bottom' }), water = this.S.water;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) { sink.set(x + dx, y, z + dz, ss); sink.set(x + dx, y - 1, z + dz, ss); }
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) sink.set(x + dx, y + 1, z + dz, dx === 0 && dz === 0 ? water : ss);
    for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) { sink.set(x + dx, y + 1, z + dz, ss); sink.set(x + dx, y + 2, z + dz, ss); sink.set(x + dx, y + 3, z + dz, ss); }
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) sink.set(x + dx, y + 4, z + dz, Math.abs(dx) === 2 && Math.abs(dz) === 2 ? ss : slab);
    sink.set(x, y + 4, z, ss);
  }
}

interface ProbeSinkLike extends BlockSink { chunk: Chunk }

/** Writes clipped to one chunk; reads outside come from the deterministic column generator. */
class ChunkSink implements ProbeSinkLike {
  private x0: number; private z0: number;
  constructor(private gen: OverworldGen, public chunk: Chunk) { this.x0 = chunk.cx * 16; this.z0 = chunk.cz * 16; }
  get(x: number, y: number, z: number): number {
    if (y < MIN_Y || y >= MAX_Y) return 0;
    const lx = x - this.x0, lz = z - this.z0;
    if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16) return this.chunk.getBlock(lx, y, lz);
    return this.gen.probeBlock(x, y, z);
  }
  set(x: number, y: number, z: number, state: number): void {
    const lx = x - this.x0, lz = z - this.z0;
    if (lx < 0 || lx >= 16 || lz < 0 || lz >= 16 || y < MIN_Y || y >= MAX_Y) return;
    this.chunk.setBlock(lx, y, lz, state);
  }
  /** A view that never probes outside the chunk (returns -1). */
  noProbe(): BlockSink {
    const c = this.chunk, x0 = this.x0, z0 = this.z0;
    return {
      get: (x, y, z) => { const lx = x - x0, lz = z - z0; if (lx < 0 || lx >= 16 || lz < 0 || lz >= 16 || y < MIN_Y || y >= MAX_Y) return -1; return c.getBlock(lx, y, lz); },
      set: (x, y, z, st) => this.set(x, y, z, st),
    };
  }
}

function clamp1(v: number): number { return v < -1 ? -1 : v > 1 ? 1 : v; }
function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

export { biomeId };
