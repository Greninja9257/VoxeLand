// Block registry built from minecraft-data: vanilla numeric block state IDs are used directly as
// the world's storage format (Uint16). Pure (no DOM) so it can be instantiated in workers.
import type { McData, McDataBlock } from '../assets';

export interface BlockProp { name: string; values: string[] }

export interface Block {
  id: number;
  name: string;
  displayName: string;
  hardness: number;      // -1 = unbreakable
  resistance: number;
  stackSize: number;
  diggable: boolean;
  material: string;
  transparent: boolean;
  emitLight: number;
  filterLight: number;
  defaultState: number;
  minStateId: number;
  maxStateId: number;
  props: BlockProp[];
  strides: number[];     // multiplier for each prop in state id computation
  harvestTools: Set<number> | null; // item ids that can harvest (null = any)
  drops: number[];
  boundingBox: 'block' | 'empty';
  soundType: string;
}

const NO_PROPS: Readonly<Record<string, string>> = Object.freeze({});

export class BlockRegistry {
  blocks: Block[] = [];
  byName = new Map<string, Block>();
  stateCount = 0;
  stateBlock!: Uint16Array;         // stateId -> block id
  filterLight!: Uint8Array;         // per state
  emitLight!: Uint8Array;           // per state
  shapeIndex!: Int32Array;          // per state -> index into shapes (or -1 = empty)
  shapes: number[][][] = [];        // shape index -> list of boxes [x0,y0,z0,x1,y1,z1]
  fullCube!: Uint8Array;            // per state: collision is exactly a full cube
  private propCache: (Record<string, string> | undefined)[] = [];
  private nameToStateCache = new Map<string, number>();

  // frequently used ids
  AIR = 0; CAVE_AIR = 0; VOID_AIR = 0; WATER = 0; LAVA = 0; STONE = 0; GRASS_BLOCK = 0; DIRT = 0; BEDROCK = 0;

  constructor(public mc: McData) {
    const raw = mc.blocks;
    let maxState = 0;
    for (const b of raw) maxState = Math.max(maxState, b.maxStateId);
    this.stateCount = maxState + 1;
    this.stateBlock = new Uint16Array(this.stateCount);
    this.filterLight = new Uint8Array(this.stateCount);
    this.emitLight = new Uint8Array(this.stateCount);
    this.shapeIndex = new Int32Array(this.stateCount).fill(-1);
    this.fullCube = new Uint8Array(this.stateCount);
    this.propCache = new Array(this.stateCount);

    // collision shapes
    const cs = mc.blockCollisionShapes;
    const shapeIds = Object.keys(cs.shapes).map(Number);
    const maxShape = Math.max(...shapeIds);
    this.shapes = new Array(maxShape + 1).fill(null).map(() => []);
    for (const k of shapeIds) this.shapes[k] = cs.shapes[String(k)];

    this.implicitWater = new Uint8Array(raw.length + 1);
    for (const rb of raw) this.addBlock(rb, cs.blocks[rb.name]);
    for (const n of ['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']) { const b = this.byName.get(n); if (b) this.implicitWater[b.id] = 1; }

    const need = (n: string) => this.byName.get(n)?.defaultState ?? 0;
    this.AIR = need('air'); this.CAVE_AIR = need('cave_air'); this.VOID_AIR = need('void_air');
    this.WATER = need('water'); this.LAVA = need('lava'); this.STONE = need('stone');
    this.GRASS_BLOCK = need('grass_block'); this.DIRT = need('dirt'); this.BEDROCK = need('bedrock');
  }

  private addBlock(rb: McDataBlock, shapeInfo: number | number[] | undefined): void {
    const props: BlockProp[] = rb.states.map((s) => ({
      name: s.name,
      values: s.type === 'bool' ? ['true', 'false'] : s.type === 'int' ? (s.values ?? Array.from({ length: s.num_values }, (_, i) => String(i))) : (s.values ?? []),
    }));
    // vanilla ordering: first property is most significant, last varies fastest
    const strides: number[] = new Array(props.length);
    let stride = 1;
    for (let i = props.length - 1; i >= 0; i--) { strides[i] = stride; stride *= props[i].values.length; }
    const block: Block = {
      id: rb.id, name: rb.name, displayName: rb.displayName,
      hardness: rb.hardness == null ? -1 : rb.hardness, resistance: rb.resistance ?? 0, stackSize: rb.stackSize ?? 64,
      diggable: rb.diggable, material: rb.material ?? 'default', transparent: rb.transparent,
      emitLight: rb.emitLight ?? 0, filterLight: rb.filterLight ?? 0,
      defaultState: rb.defaultState, minStateId: rb.minStateId, maxStateId: rb.maxStateId,
      props, strides,
      harvestTools: rb.harvestTools ? new Set(Object.keys(rb.harvestTools).map(Number)) : null,
      drops: rb.drops ?? [], boundingBox: rb.boundingBox ?? 'block',
      soundType: guessSoundType(rb.name, rb.material ?? ''),
    };
    this.blocks[block.id] = block;
    this.byName.set(block.name, block);
    for (let s = block.minStateId; s <= block.maxStateId; s++) {
      this.stateBlock[s] = block.id;
      this.filterLight[s] = block.filterLight;
      this.emitLight[s] = block.emitLight;
      let shape = -1;
      if (typeof shapeInfo === 'number') shape = shapeInfo;
      else if (Array.isArray(shapeInfo)) shape = shapeInfo[s - block.minStateId] ?? shapeInfo[0] ?? -1;
      if (shape >= 0 && this.shapes[shape] && this.shapes[shape].length === 0) shape = -1;
      this.shapeIndex[s] = shape;
      if (shape >= 0) {
        const boxes = this.shapes[shape];
        this.fullCube[s] = boxes.length === 1 && boxes[0][0] === 0 && boxes[0][1] === 0 && boxes[0][2] === 0 && boxes[0][3] === 1 && boxes[0][4] === 1 && boxes[0][5] === 1 ? 1 : 0;
      }
    }
    // per-state light overrides for common state-dependent emitters
    this.applyStateLightOverrides(block);
  }

  private applyStateLightOverrides(block: Block): void {
    const litIdx = block.props.findIndex((p) => p.name === 'lit');
    if (litIdx >= 0 && block.emitLight > 0) {
      for (let s = block.minStateId; s <= block.maxStateId; s++) {
        if (this.getProp(s, 'lit') === 'false') this.emitLight[s] = 0;
      }
    }
    if (block.name === 'redstone_ore' || block.name === 'deepslate_redstone_ore') {
      for (let s = block.minStateId; s <= block.maxStateId; s++) this.emitLight[s] = this.getProp(s, 'lit') === 'true' ? 9 : 0;
    }
    if (block.name === 'furnace' || block.name === 'blast_furnace' || block.name === 'smoker') {
      for (let s = block.minStateId; s <= block.maxStateId; s++) this.emitLight[s] = this.getProp(s, 'lit') === 'true' ? 13 : 0;
    }
    if (block.name === 'campfire' || block.name === 'soul_campfire') {
      for (let s = block.minStateId; s <= block.maxStateId; s++) this.emitLight[s] = this.getProp(s, 'lit') === 'true' ? (block.name === 'campfire' ? 15 : 10) : 0;
    }
    if (block.name === 'redstone_lamp') {
      for (let s = block.minStateId; s <= block.maxStateId; s++) this.emitLight[s] = this.getProp(s, 'lit') === 'true' ? 15 : 0;
    }
    if (block.name === 'redstone_torch' || block.name === 'redstone_wall_torch') {
      for (let s = block.minStateId; s <= block.maxStateId; s++) this.emitLight[s] = this.getProp(s, 'lit') === 'true' ? 7 : 0;
    }
    if (block.name === 'sea_pickle') {
      for (let s = block.minStateId; s <= block.maxStateId; s++) {
        const n = +(this.getProp(s, 'pickles') ?? 1); this.emitLight[s] = this.getProp(s, 'waterlogged') === 'true' ? 6 + 3 * n : 0;
      }
    }
    if (block.name === 'cave_vines' || block.name === 'cave_vines_plant') {
      for (let s = block.minStateId; s <= block.maxStateId; s++) this.emitLight[s] = this.getProp(s, 'berries') === 'true' ? 14 : 0;
    }
    if (block.name === 'copper_bulb' || block.name.endsWith('_copper_bulb')) {
      for (let s = block.minStateId; s <= block.maxStateId; s++) this.emitLight[s] = this.getProp(s, 'lit') === 'true' ? (block.name.startsWith('oxidized') ? 4 : block.name.startsWith('weathered') ? 8 : block.name.startsWith('exposed') ? 12 : 15) : 0;
    }
  }

  block(state: number): Block { return this.blocks[this.stateBlock[state]]; }
  blockByName(name: string): Block | undefined { return this.byName.get(name.replace(/^minecraft:/, '')); }
  nameOf(state: number): string { return this.block(state).name; }
  isAir(state: number): boolean { return state === this.AIR || state === this.CAVE_AIR || state === this.VOID_AIR; }

  defaultState(name: string): number {
    const c = this.nameToStateCache.get(name);
    if (c !== undefined) return c;
    const b = this.blockByName(name);
    const s = b ? b.defaultState : 0;
    this.nameToStateCache.set(name, s);
    return s;
  }

  /** Decode the properties of a state (cached). */
  getProps(state: number): Readonly<Record<string, string>> {
    let p = this.propCache[state];
    if (p) return p;
    const b = this.block(state);
    if (!b || b.props.length === 0) return NO_PROPS;
    p = {};
    let off = state - b.minStateId;
    for (let i = 0; i < b.props.length; i++) {
      const prop = b.props[i];
      const idx = Math.floor(off / b.strides[i]) % prop.values.length;
      p[prop.name] = prop.values[idx];
    }
    this.propCache[state] = p;
    return p;
  }

  getProp(state: number, name: string): string | undefined { return this.getProps(state)[name]; }

  /** Compute a state id for a block given (partial) properties; unspecified ones use the default state's values. */
  stateWith(block: Block, props: Record<string, string>): number {
    const base = this.getProps(block.defaultState);
    let id = block.minStateId;
    for (let i = 0; i < block.props.length; i++) {
      const prop = block.props[i];
      const v = props[prop.name] ?? base[prop.name];
      let idx = prop.values.indexOf(v);
      if (idx < 0) idx = prop.values.indexOf(base[prop.name]);
      if (idx < 0) idx = 0;
      id += idx * block.strides[i];
    }
    return id;
  }

  /** Return a new state with one property changed. */
  withProp(state: number, name: string, value: string | number | boolean): number {
    const b = this.block(state);
    const i = b.props.findIndex((p) => p.name === name);
    if (i < 0) return state;
    const prop = b.props[i];
    const cur = this.getProps(state);
    const curIdx = prop.values.indexOf(cur[name]);
    const newIdx = prop.values.indexOf(String(value));
    if (newIdx < 0 || curIdx < 0) return state;
    return state + (newIdx - curIdx) * b.strides[i];
  }

  hasProp(state: number, name: string): boolean { return this.block(state).props.some((p) => p.name === name); }

  /** Parse "minecraft:oak_stairs[facing=north,half=top]" into a state id. */
  parseState(str: string): number {
    const m = /^(?:minecraft:)?([a-z0-9_]+)(?:\[(.*)\])?$/.exec(str.trim());
    if (!m) return 0;
    const b = this.blockByName(m[1]);
    if (!b) return 0;
    if (!m[2]) return b.defaultState;
    const props: Record<string, string> = {};
    for (const kv of m[2].split(',')) { const [k, v] = kv.split('='); props[k.trim()] = v.trim(); }
    return this.stateWith(b, props);
  }

  collisionBoxes(state: number): number[][] {
    const si = this.shapeIndex[state];
    return si < 0 ? EMPTY_BOXES : this.shapes[si];
  }

  isFluid(state: number): boolean {
    const id = this.stateBlock[state];
    return id === this.stateBlock[this.WATER] || id === this.stateBlock[this.LAVA];
  }
  isWater(state: number): boolean { return this.stateBlock[state] === this.stateBlock[this.WATER]; }
  isLava(state: number): boolean { return this.stateBlock[state] === this.stateBlock[this.LAVA]; }
  isWaterlogged(state: number): boolean { return this.getProps(state).waterlogged === 'true' || this.implicitWater[this.stateBlock[state]] === 1; }
  /** blocks that always contain water (seagrass, kelp, bubble columns) */
  implicitWater!: Uint8Array;
  /** True if the position contains water (water block or waterlogged). */
  hasWater(state: number): boolean { return this.isWater(state) || this.isWaterlogged(state); }
  fluidLevel(state: number): number { return +(this.getProps(state).level ?? 0); }
}

const EMPTY_BOXES: number[][] = [];

/** Vanilla sound type approximation from block name / material. */
export function guessSoundType(name: string, material: string): string {
  const n = name;
  if (/wool$/.test(n) || n === 'white_wool') return 'wool';
  if (/carpet$/.test(n) && !/moss/.test(n)) return 'wool';
  if (/^(grass_block|podzol|mycelium|dirt_path|rooted_dirt|farmland)$/.test(n)) return 'grass';
  if (/^(dirt|coarse_dirt|mud)$/.test(n)) return n === 'mud' ? 'mud' : 'gravel';
  if (/^(gravel|clay|(red_)?sand|soul_sand)$/.test(n)) return n.includes('sand') && !n.includes('soul') ? 'sand' : n === 'soul_sand' ? 'soul_sand' : 'gravel';
  if (n === 'soul_soil') return 'soul_soil';
  if (/snow/.test(n) && !/powder/.test(n)) return 'snow';
  if (n === 'powder_snow') return 'powder_snow';
  if (/glass|ice$|beacon|sea_lantern|glowstone|redstone_lamp|tinted_glass/.test(n)) return n.endsWith('_ice') || n === 'ice' ? 'glass' : 'glass';
  if (/^(bamboo|bamboo_sapling)$/.test(n)) return 'bamboo';
  if (/scaffolding/.test(n)) return 'scaffolding';
  if (/^(.*_leaves|azalea_leaves)$/.test(n)) return 'grass';
  if (/^(short_grass|tall_grass|fern|large_fern|dead_bush|.*_sapling|.*_flower|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|rose_bush|peony|sugar_cane|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|attached_.*|kelp|kelp_plant|seagrass|tall_seagrass|vine|lily_pad|sweet_berry_bush|nether_sprouts|.*_roots|cave_vines.*|spore_blossom|glow_lichen|hanging_roots|moss_carpet|pink_petals|torchflower.*|pitcher_.*|cocoa|cactus_flower|wildflowers|bush|firefly_bush|leaf_litter)$/.test(n)) return 'grass';
  if (/^(nether_wart|nether_wart_block|warped_wart_block)$/.test(n)) return 'nether_wart';
  if (/^(shroomlight)$/.test(n)) return 'shroomlight';
  if (/^(crimson|warped)_(stem|hyphae|planks|slab|stairs|fence|fence_gate|door|trapdoor|pressure_plate|button|sign|wall_sign|hanging_sign|wall_hanging_sign)$/.test(n) || /stripped_(crimson|warped)/.test(n)) return 'nether_wood';
  if (/^(.*_stem|.*_hyphae|crimson_fungus|warped_fungus|.*_mushroom|.*_mushroom_block|mushroom_stem)$/.test(n)) return /stem$|hyphae$/.test(n) ? 'stem' : 'fungus';
  if (/^(ladder)$/.test(n)) return 'ladder';
  if (/^(chain|iron_chain|.*_chain|anvil|.*_anvil|iron_block|gold_block|.*copper.*|iron_bars|iron_door|iron_trapdoor|cauldron|.*_cauldron|hopper|lantern|soul_lantern|lightning_rod|chain_command_block|bell|netherite_block|raw_iron_block|raw_gold_block|raw_copper_block|heavy_core|iron_bars)$/.test(n)) return n.includes('copper') && !n.includes('raw') ? 'copper' : n === 'lantern' || n === 'soul_lantern' ? 'lantern' : n.includes('anvil') ? 'anvil' : n.includes('chain') ? 'chain' : 'metal';
  if (/^(.*_planks|.*_log|.*_wood|stripped_.*|oak_.*|spruce_.*|birch_.*|jungle_.*|acacia_.*|dark_oak_.*|mangrove_.*|cherry_.*|pale_oak_.*|bamboo_.*|crafting_table|bookshelf|chest|trapped_chest|barrel|lectern|composter|loom|cartography_table|fletching_table|smithing_table|jukebox|note_block|.*_sign|.*_hanging_sign|ladder|beehive|bee_nest|chiseled_bookshelf|daylight_detector|piston|sticky_piston|piston_head|campfire|soul_campfire|.*_bed|.*_banner|.*_wall_banner)$/.test(n)) return n.startsWith('cherry') ? 'cherry_wood' : n.startsWith('bamboo') ? 'bamboo_wood' : 'wood';
  if (/^(slime_block)$/.test(n)) return 'slime_block';
  if (/^(honey_block)$/.test(n)) return 'honey_block';
  if (/^(coral.*)$/.test(n)) return 'coral_block';
  if (/^(sponge|wet_sponge)$/.test(n)) return n === 'sponge' ? 'sponge' : 'wet_sponge';
  if (/^(netherrack|nether_.*ore|magma_block)$/.test(n)) return 'netherrack';
  if (/^(basalt|polished_basalt|smooth_basalt)$/.test(n)) return 'basalt';
  if (/^(bone_block)$/.test(n)) return 'bone_block';
  if (/^(nether_bricks|.*nether_brick.*)$/.test(n)) return 'nether_bricks';
  if (/^(tuff|.*tuff.*)$/.test(n)) return 'tuff';
  if (/^(calcite)$/.test(n)) return 'calcite';
  if (/^(dripstone_block|pointed_dripstone)$/.test(n)) return n === 'pointed_dripstone' ? 'pointed_dripstone' : 'dripstone_block';
  if (/^(deepslate.*|.*deepslate.*)$/.test(n)) return n.includes('bricks') ? 'deepslate_bricks' : n.includes('tiles') ? 'deepslate_tiles' : n.includes('polished') ? 'polished_deepslate' : 'deepslate';
  if (/^(amethyst.*|.*amethyst.*)$/.test(n)) return 'amethyst';
  if (/^(sculk.*)$/.test(n)) return 'sculk';
  if (/^(froglight|.*froglight)$/.test(n)) return 'froglight';
  if (/^(mud_bricks|.*mud_brick.*|packed_mud)$/.test(n)) return 'mud_bricks';
  if (/^(mangrove_roots)$/.test(n)) return 'mangrove_roots';
  if (/^(muddy_mangrove_roots)$/.test(n)) return 'muddy_mangrove_roots';
  if (/^(azalea|flowering_azalea)$/.test(n)) return 'azalea';
  if (/^(moss_block|moss_carpet|pale_moss_block|pale_moss_carpet)$/.test(n)) return 'moss';
  if (/^(big_dripleaf|small_dripleaf)$/.test(n)) return 'big_dripleaf';
  if (/^(hanging_roots)$/.test(n)) return 'hanging_roots';
  if (/^(candle|.*_candle|.*candle_cake)$/.test(n)) return 'candle';
  if (/^(cake)$/.test(n)) return 'wool';
  if (/^(decorated_pot)$/.test(n)) return 'decorated_pot';
  if (/^(.*_shulker_box|shulker_box)$/.test(n)) return 'shulker_box';
  if (/^(.*_head|.*_skull|.*_wall_head|.*_wall_skull)$/.test(n)) return 'stone';
  if (/^(cobweb)$/.test(n)) return 'cobweb';
  if (/^(hay_block|target|dried_kelp_block)$/.test(n)) return 'grass';
  if (/^(honeycomb_block)$/.test(n)) return 'coral_block';
  if (/^(bricks|.*_bricks)$/.test(n)) return 'stone';
  if (/^(ancient_debris)$/.test(n)) return 'ancient_debris';
  if (/^(lodestone)$/.test(n)) return 'lodestone';
  if (/^(nether_gold_ore)$/.test(n)) return 'nether_gold_ore';
  if (/^(lava|water)$/.test(n)) return 'liquid';
  if (/^(air|cave_air|void_air)$/.test(n)) return 'none';
  if (/^(torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|redstone_wall_torch|copper_torch|copper_wall_torch)$/.test(n)) return 'wood';
  if (/^(redstone_wire|repeater|comparator|lever|tripwire|tripwire_hook|.*_pressure_plate|.*_button)$/.test(n)) return n.includes('wooden') || n.startsWith('oak') || n.includes('_pressure_plate') && !n.includes('stone') && !n.includes('weighted') ? 'wood' : 'stone';
  if (/^(sea_pickle)$/.test(n)) return 'slime_block';
  if (/^(end_rod|end_portal_frame)$/.test(n)) return 'stone';
  if (/^(bubble_column|.*_head)$/.test(n)) return 'none';
  if (/pickaxe/.test(material)) return 'stone';
  if (/axe/.test(material)) return 'wood';
  if (/shovel/.test(material)) return 'gravel';
  if (/hoe/.test(material)) return 'grass';
  return 'stone';
}
