// Item registry (from minecraft-data) + tags + tool/armor/food semantics + block<->item mapping.
import type { Assets, DataBundle, McDataItem } from '../assets';
import type { BlockRegistry } from '../blocks/registry';

export type ToolType = 'sword' | 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'shears' | 'none';
export type ToolTier = 'wood' | 'stone' | 'iron' | 'diamond' | 'netherite' | 'gold' | 'copper' | 'none';
export type ArmorSlot = 'head' | 'chest' | 'legs' | 'feet';

export interface Item {
  id: number;
  name: string;
  displayName: string;
  stackSize: number;
  maxDurability: number;
  tool: ToolType;
  tier: ToolTier;
  attackDamage: number;   // total damage when held (vanilla: 1 base + item bonus)
  attackSpeed: number;
  armorSlot: ArmorSlot | null;
  armor: number;
  armorToughness: number;
  food: { points: number; saturation: number; alwaysEat: boolean; fast: boolean } | null;
  blockName: string | null; // block placed by this item
  repairWith: string[];
  enchantCategories: string[];
  fuelTicks: number;      // 0 = not fuel
  isFireResistant: boolean;
}

export const TIER_LEVEL: Record<ToolTier, number> = { none: 0, wood: 0, gold: 0, stone: 1, copper: 1, iron: 2, diamond: 3, netherite: 4 };
export const TIER_SPEED: Record<ToolTier, number> = { none: 1, wood: 2, stone: 4, copper: 5, iron: 6, diamond: 8, netherite: 9, gold: 12 };
const TIER_DAMAGE: Record<ToolTier, number> = { none: 0, wood: 0, gold: 0, stone: 1, copper: 1, iron: 2, diamond: 3, netherite: 4 };

const ARMOR: Record<string, [number, number, number, number, number]> = {
  // helmet, chest, legs, boots, toughness
  leather: [1, 3, 2, 1, 0], chainmail: [2, 5, 4, 1, 0], iron: [2, 6, 5, 2, 0], golden: [2, 5, 3, 1, 0], copper: [2, 4, 3, 1, 0], diamond: [3, 8, 6, 3, 2], netherite: [3, 8, 6, 3, 3], turtle: [2, 0, 0, 0, 0],
};

const BLOCK_TO_ITEM: Record<string, string | null> = {
  wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds', melon_stem: 'melon_seeds', pumpkin_stem: 'pumpkin_seeds',
  attached_melon_stem: 'melon_seeds', attached_pumpkin_stem: 'pumpkin_seeds', redstone_wire: 'redstone', tripwire: 'string', cocoa: 'cocoa_beans',
  sweet_berry_bush: 'sweet_berries', kelp_plant: 'kelp', bamboo_sapling: 'bamboo', tall_seagrass: 'seagrass', water: 'water_bucket', lava: 'lava_bucket',
  powder_snow: 'powder_snow_bucket', fire: null, soul_fire: null, nether_portal: null, end_portal: null, end_gateway: null, piston_head: null, moving_piston: null,
  cave_vines: 'glow_berries', cave_vines_plant: 'glow_berries', weeping_vines_plant: 'weeping_vines', twisting_vines_plant: 'twisting_vines', torchflower_crop: 'torchflower_seeds',
  pitcher_crop: 'pitcher_pod', bubble_column: null, air: null, cave_air: null, void_air: null, frosted_ice: null, candle_cake: 'cake', big_dripleaf_stem: 'big_dripleaf',
  potted_oak_sapling: 'flower_pot', pumpkin: 'pumpkin', lava_cauldron: 'cauldron', water_cauldron: 'cauldron', powder_snow_cauldron: 'cauldron', frogspawn: 'frogspawn',
};

export class ItemRegistry {
  items: Item[] = [];
  byName = new Map<string, Item>();
  tags = new Map<string, Set<string>>(); // "item/planks" -> names (without minecraft:)
  blockTags = new Map<string, Set<string>>();
  fuel = new Map<string, number>();
  private itemForBlockCache = new Map<string, Item | null>();

  constructor(public assets: Assets, public blocks: BlockRegistry) {
    const foods = new Map(assets.mcdata.foods.map((f) => [f.name, f]));
    for (const raw of assets.mcdata.items) this.items[raw.id] = this.makeItem(raw, foods.get(raw.name));
    for (const it of this.items) if (it) this.byName.set(it.name, it);
    this.buildTags(assets.data);
    this.buildFuels();
  }

  private makeItem(raw: McDataItem, food: { foodPoints: number; saturation: number } | undefined): Item {
    const n = raw.name;
    let tool: ToolType = 'none', tier: ToolTier = 'none';
    const m = /^(wooden|stone|iron|golden|diamond|netherite|copper)_(sword|pickaxe|axe|shovel|hoe)$/.exec(n);
    if (m) { tier = m[1] === 'wooden' ? 'wood' : m[1] === 'golden' ? 'gold' : (m[1] as ToolTier); tool = m[2] as ToolType; }
    if (n === 'shears') tool = 'shears';
    let attackDamage = 1, attackSpeed = 4;
    if (tool === 'sword') { attackDamage = 4 + TIER_DAMAGE[tier]; attackSpeed = 1.6; }
    else if (tool === 'axe') { attackDamage = tier === 'wood' || tier === 'gold' ? 7 : tier === 'netherite' ? 10 : 9; attackSpeed = tier === 'wood' || tier === 'stone' ? 0.8 : tier === 'iron' ? 0.9 : 1.0; }
    else if (tool === 'pickaxe') { attackDamage = 2 + TIER_DAMAGE[tier]; attackSpeed = 1.2; }
    else if (tool === 'shovel') { attackDamage = 2.5 + TIER_DAMAGE[tier]; attackSpeed = 1.0; }
    else if (tool === 'hoe') { attackDamage = 1; attackSpeed = tier === 'wood' || tier === 'gold' ? 1 : tier === 'stone' ? 2 : tier === 'iron' ? 3 : 4; }
    else if (n === 'trident') { attackDamage = 9; attackSpeed = 1.1; }
    else if (n === 'mace') { attackDamage = 6; attackSpeed = 0.6; }
    let armorSlot: ArmorSlot | null = null, armor = 0, toughness = 0;
    const am = /^(leather|chainmail|iron|golden|diamond|netherite|copper|turtle)_(helmet|chestplate|leggings|boots)$/.exec(n);
    if (am) {
      const t = ARMOR[am[1]];
      armorSlot = am[2] === 'helmet' ? 'head' : am[2] === 'chestplate' ? 'chest' : am[2] === 'leggings' ? 'legs' : 'feet';
      armor = t[armorSlot === 'head' ? 0 : armorSlot === 'chest' ? 1 : armorSlot === 'legs' ? 2 : 3]; toughness = t[4];
    }
    if (n === 'elytra') armorSlot = 'chest';
    if (n === 'carved_pumpkin' || n.endsWith('_head') || n.endsWith('_skull')) armorSlot = 'head';
    const blockName = n in BLOCK_TO_ITEM ? null : (this.blocks.blockByName(n) ? n : null);
    return {
      id: raw.id, name: n, displayName: raw.displayName, stackSize: raw.stackSize ?? 64, maxDurability: raw.maxDurability ?? 0,
      tool, tier, attackDamage, attackSpeed, armorSlot, armor, armorToughness: toughness,
      food: food ? { points: food.foodPoints, saturation: food.saturation, alwaysEat: n === 'golden_apple' || n === 'enchanted_golden_apple' || n === 'honey_bottle' || n === 'chorus_fruit' || n === 'suspicious_stew' || n === 'milk_bucket', fast: n === 'dried_kelp' } : null,
      blockName, repairWith: raw.repairWith ?? [], enchantCategories: raw.enchantCategories ?? [], fuelTicks: 0, isFireResistant: n.startsWith('netherite') || n === 'ancient_debris',
    };
  }

  private buildTags(data: DataBundle): void {
    const resolve = (key: string, seen = new Set<string>()): Set<string> => {
      const out = new Set<string>();
      const t = data.tags[key];
      if (!t || seen.has(key)) return out;
      seen.add(key);
      for (const v of t.values) {
        const val = typeof v === 'string' ? v : (v as any).id;
        if (!val) continue;
        if (val.startsWith('#')) { const sub = key.split('/')[0] + '/' + val.slice(1).replace('minecraft:', ''); for (const x of resolve(sub, seen)) out.add(x); }
        else out.add(val.replace('minecraft:', ''));
      }
      return out;
    };
    for (const key of Object.keys(data.tags)) {
      if (key.startsWith('item/')) this.tags.set(key.slice(5), resolve(key));
      else if (key.startsWith('block/')) this.blockTags.set(key.slice(6), resolve(key));
    }
  }

  private buildFuels(): void {
    const set = (names: Iterable<string>, ticks: number) => { for (const n of names) if (this.byName.has(n)) this.fuel.set(n, ticks); };
    set(['lava_bucket'], 20000); set(['coal_block'], 16000); set(['blaze_rod'], 2400); set(['coal', 'charcoal'], 1600);
    set(this.tag('logs'), 300); set(this.tag('planks'), 300); set(this.tag('wooden_stairs'), 300); set(this.tag('wooden_slabs'), 150); set(this.tag('wooden_trapdoors'), 300);
    set(this.tag('wooden_pressure_plates'), 300); set(this.tag('wooden_fences'), 300); set(this.tag('fence_gates'), 300); set(this.tag('wooden_doors'), 200);
    set(['crafting_table', 'bookshelf', 'chest', 'trapped_chest', 'lectern', 'daylight_detector', 'jukebox', 'note_block', 'barrel', 'cartography_table', 'fletching_table', 'smithing_table', 'loom', 'composter', 'chiseled_bookshelf'], 300);
    set(this.tag('saplings'), 100); set(['stick'], 100); set(this.tag('wool'), 100); set(this.tag('wool_carpets'), 67); set(['ladder', 'bow', 'fishing_rod', 'wooden_sword', 'wooden_pickaxe', 'wooden_axe', 'wooden_shovel', 'wooden_hoe', 'bowl'], 200);
    set(['dried_kelp_block'], 4000); set(this.tag('signs'), 200); set(this.tag('hanging_signs'), 800); set(this.tag('boats'), 1200); set(['bamboo', 'scaffolding', 'bamboo_mosaic'], 50); set(['dead_bush', 'azalea', 'flowering_azalea'], 100);
    set(this.tag('banners'), 300); set(['bamboo_block', 'stripped_bamboo_block'], 300);
  }

  tag(name: string): Set<string> { return this.tags.get(name) ?? EMPTY_SET; }
  blockTag(name: string): Set<string> { return this.blockTags.get(name) ?? EMPTY_SET; }
  inTag(item: string, tag: string): boolean { return this.tag(tag).has(item); }

  get(name: string): Item | undefined { return this.byName.get(name.replace(/^minecraft:/, '')); }
  byId(id: number): Item | undefined { return this.items[id]; }

  /** The item that represents a block (for pick-block / creative). */
  itemForBlock(blockName: string): Item | null {
    let c = this.itemForBlockCache.get(blockName);
    if (c !== undefined) return c;
    let name: string | null | undefined = BLOCK_TO_ITEM[blockName];
    if (name === undefined) {
      if (this.byName.has(blockName)) name = blockName;
      else if (blockName.includes('_wall_')) name = blockName.replace('_wall_', '_');
      else if (blockName.startsWith('wall_')) name = blockName.slice(5);
      else if (blockName.startsWith('potted_')) name = 'flower_pot';
      else if (blockName.endsWith('_wall_fan')) name = blockName.replace('_wall_fan', '_fan');
      else name = null;
    }
    c = name ? this.byName.get(name) ?? null : null;
    this.itemForBlockCache.set(blockName, c);
    return c;
  }

  displayName(name: string): string {
    const it = this.get(name);
    if (it) return this.assets.lang['item.minecraft.' + it.name] ?? this.assets.lang['block.minecraft.' + it.name] ?? it.displayName;
    return name;
  }
}

const EMPTY_SET = new Set<string>();
