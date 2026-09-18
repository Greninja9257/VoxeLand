// Villager trade listings (vanilla VillagerTrades.TRADES): per profession, per level, two random offers are picked
// when a villager reaches that level.
import type { ItemRegistry } from '../items/registry';

export interface Trade {
  a: string; ac: number;          // first cost
  b?: string; bc?: number;        // optional second cost
  r: string; rc: number;          // result
  uses: number; maxUses: number;  // stock (reset when the villager restocks at its job site)
  xp: number;                     // villager xp granted per trade
  /** result enchantments (enchanted tools/armor/books) */
  ench?: { id: string; level: number }[];
  /** result extra data (dyed leather colour, enchanted book, potion) */
  extra?: Record<string, any>;
}

type Listing = (rnd: () => number, items: ItemRegistry, ctx: ListingContext) => Trade | null;
export interface ListingContext { villagerType: string; enchant(item: string, level: number, rnd: () => number): { id: string; level: number }[]; bookEnchant(rnd: () => number): { id: string; level: number } }

const ri = (rnd: () => number, n: number) => Math.floor(rnd() * n);
// vanilla listing types
const emeraldFor = (item: string, cost: number, maxUses: number, xp: number): Listing => () => ({ a: item, ac: cost, r: 'emerald', rc: 1, uses: 0, maxUses, xp });
const itemsFor = (item: string, emeralds: number, count: number, maxUses: number, xp: number): Listing => () => ({ a: 'emerald', ac: emeralds, r: item, rc: count, uses: 0, maxUses, xp });
const itemsAndEmeraldsToItems = (from: string, fromCount: number, emeralds: number, to: string, toCount: number, maxUses: number, xp: number): Listing => () => ({ a: from, ac: fromCount, b: 'emerald', bc: emeralds, r: to, rc: toCount, uses: 0, maxUses, xp });
/** EnchantedItemForEmeralds: enchanted with a random level 5–19; price = base + that level (capped at 64) */
const enchantedItem = (item: string, base: number, maxUses: number, xp: number): Listing => (rnd, _items, ctx) => { const lvl = 5 + ri(rnd, 15); return { a: 'emerald', ac: Math.min(base + lvl, 64), r: item, rc: 1, uses: 0, maxUses, xp, ench: ctx.enchant(item, lvl, rnd) }; };
/** EnchantBookForEmeralds: one random enchantment; price 2–6 + 10 per level (×2 for treasure), capped at 64 */
const enchantBook = (xp: number): Listing => (rnd, _items, ctx) => { const e = ctx.bookEnchant(rnd); let price = 2 + ri(rnd, 5 + e.level * 10) + 3 * e.level; if (e.id === 'mending' || e.id === 'frost_walker' || e.id === 'soul_speed' || e.id === 'swift_sneak') price *= 2; return { a: 'emerald', ac: Math.min(price, 64), b: 'book', bc: 1, r: 'enchanted_book', rc: 1, uses: 12, maxUses: 12, xp, extra: { enchantments: [e] } }; };
const dyedArmor = (item: string, emeralds: number, maxUses = 12, xp = 1): Listing => (rnd) => { const dyes = [0xf9fffe, 0xf9801d, 0xc74ebd, 0x3ab3da, 0xfed83d, 0x80c71f, 0xf38baa, 0x474f52, 0x9d9d97, 0x169c9c, 0x8932b8, 0x3c44aa, 0x835432, 0x5e7c16, 0xb02e26, 0x1d1d21]; return { a: 'emerald', ac: emeralds, r: item, rc: 1, uses: 0, maxUses, xp, extra: { dyeColor: dyes[ri(rnd, dyes.length)] } }; };
const suspiciousStew = (maxUses: number, xp: number): Listing => () => ({ a: 'emerald', ac: 1, r: 'suspicious_stew', rc: 1, uses: 0, maxUses, xp });
const boatFor = (): Listing => (_rnd, _items, ctx) => { const wood: Record<string, string> = { plains: 'oak', desert: 'oak', savanna: 'acacia', snow: 'spruce', taiga: 'spruce', jungle: 'jungle', swamp: 'dark_oak' }; return { a: 'emerald', ac: 1, r: (wood[ctx.villagerType] ?? 'oak') + '_boat', rc: 1, uses: 0, maxUses: 12, xp: 30 }; };
const WOOLS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];

export const TRADES: Record<string, Listing[][]> = {
  farmer: [
    [emeraldFor('wheat', 20, 16, 2), emeraldFor('potato', 26, 16, 2), emeraldFor('carrot', 22, 16, 2), emeraldFor('beetroot', 15, 16, 2), itemsFor('bread', 1, 6, 16, 1)],
    [emeraldFor('pumpkin', 6, 12, 10), itemsFor('pumpkin_pie', 1, 4, 12, 5), itemsFor('apple', 1, 4, 16, 5)],
    [itemsFor('cookie', 3, 18, 12, 10), emeraldFor('melon', 4, 12, 20)],
    [itemsFor('cake', 1, 1, 12, 15), suspiciousStew(12, 15)],
    [itemsFor('golden_carrot', 3, 3, 12, 30), itemsFor('glistering_melon_slice', 4, 3, 12, 30)],
  ],
  fisherman: [
    [emeraldFor('string', 20, 16, 2), emeraldFor('coal', 10, 16, 2), itemsAndEmeraldsToItems('cod', 6, 1, 'cooked_cod', 6, 16, 1), itemsFor('cod_bucket', 3, 1, 16, 1)],
    [emeraldFor('cod', 15, 16, 10), itemsAndEmeraldsToItems('salmon', 6, 1, 'cooked_salmon', 6, 16, 5), itemsFor('campfire', 2, 1, 12, 5)],
    [emeraldFor('salmon', 13, 16, 20), enchantedItem('fishing_rod', 3, 3, 10)],
    [emeraldFor('tropical_fish', 6, 12, 30)],
    [emeraldFor('pufferfish', 4, 12, 30), boatFor()],
  ],
  shepherd: [
    [emeraldFor('white_wool', 18, 16, 2), emeraldFor('brown_wool', 18, 16, 2), emeraldFor('black_wool', 18, 16, 2), emeraldFor('gray_wool', 18, 16, 2), itemsFor('shears', 2, 1, 12, 1)],
    [emeraldFor('white_dye', 12, 16, 10), emeraldFor('gray_dye', 12, 16, 10), emeraldFor('black_dye', 12, 16, 10), emeraldFor('light_blue_dye', 12, 16, 10), emeraldFor('lime_dye', 12, 16, 10), ...WOOLS.map((c) => itemsFor(c + '_wool', 1, 1, 16, 5)), ...WOOLS.map((c) => itemsFor(c + '_carpet', 1, 4, 16, 5))],
    [emeraldFor('yellow_dye', 12, 16, 20), emeraldFor('light_gray_dye', 12, 16, 20), emeraldFor('orange_dye', 12, 16, 20), emeraldFor('red_dye', 12, 16, 20), emeraldFor('pink_dye', 12, 16, 20), ...WOOLS.map((c) => itemsFor(c + '_bed', 3, 1, 12, 10))],
    [emeraldFor('brown_dye', 12, 16, 30), emeraldFor('purple_dye', 12, 16, 30), emeraldFor('blue_dye', 12, 16, 30), emeraldFor('green_dye', 12, 16, 30), emeraldFor('magenta_dye', 12, 16, 30), emeraldFor('cyan_dye', 12, 16, 30), ...WOOLS.map((c) => itemsFor(c + '_banner', 3, 1, 12, 15))],
    [itemsFor('painting', 2, 3, 12, 30)],
  ],
  fletcher: [
    [emeraldFor('stick', 32, 16, 2), itemsFor('arrow', 1, 16, 12, 1), itemsAndEmeraldsToItems('gravel', 10, 1, 'flint', 10, 12, 1)],
    [emeraldFor('flint', 26, 12, 10), itemsFor('bow', 2, 1, 12, 5)],
    [emeraldFor('string', 14, 16, 20), itemsFor('crossbow', 3, 1, 12, 10)],
    [emeraldFor('feather', 24, 16, 30), enchantedItem('bow', 2, 3, 15)],
    [emeraldFor('tripwire_hook', 8, 12, 30), enchantedItem('crossbow', 3, 3, 15), itemsAndEmeraldsToItems('arrow', 5, 2, 'tipped_arrow', 5, 12, 30)],
  ],
  librarian: [
    [emeraldFor('paper', 24, 16, 2), enchantBook(1), itemsFor('bookshelf', 9, 1, 12, 1)],
    [emeraldFor('book', 4, 12, 10), enchantBook(5), itemsFor('lantern', 1, 1, 12, 5)],
    [emeraldFor('ink_sac', 5, 12, 20), enchantBook(10), itemsFor('glass', 1, 4, 12, 10)],
    [emeraldFor('writable_book', 2, 12, 30), enchantBook(15), itemsFor('clock', 5, 1, 12, 15), itemsFor('compass', 4, 1, 12, 15)],
    [itemsFor('name_tag', 20, 1, 12, 30)],
  ],
  cartographer: [
    [emeraldFor('paper', 24, 16, 2), itemsFor('map', 7, 1, 12, 1)],
    [emeraldFor('glass_pane', 11, 16, 10), itemsFor('map', 13, 1, 12, 5)],
    [emeraldFor('compass', 1, 12, 20), itemsFor('map', 14, 1, 12, 10)],
    [itemsFor('item_frame', 7, 1, 12, 15), ...WOOLS.map((c) => itemsFor(c + '_banner', 3, 1, 12, 15))],
    [itemsFor('globe_banner_pattern', 8, 1, 12, 30)],
  ],
  cleric: [
    [emeraldFor('rotten_flesh', 32, 16, 2), itemsFor('redstone', 1, 2, 12, 1)],
    [emeraldFor('gold_ingot', 3, 12, 10), itemsFor('lapis_lazuli', 1, 1, 12, 5)],
    [emeraldFor('rabbit_foot', 2, 12, 20), itemsFor('glowstone', 4, 1, 12, 10)],
    [emeraldFor('turtle_scute', 4, 12, 30), emeraldFor('glass_bottle', 9, 12, 30), itemsFor('ender_pearl', 5, 1, 12, 15)],
    [emeraldFor('nether_wart', 22, 12, 30), itemsFor('experience_bottle', 3, 1, 12, 30)],
  ],
  armorer: [
    [emeraldFor('coal', 15, 16, 2), itemsFor('iron_leggings', 7, 1, 12, 1), itemsFor('iron_boots', 4, 1, 12, 1), itemsFor('iron_helmet', 5, 1, 12, 1), itemsFor('iron_chestplate', 9, 1, 12, 1)],
    [emeraldFor('iron_ingot', 4, 12, 10), itemsFor('bell', 36, 1, 12, 5), itemsFor('chainmail_boots', 1, 1, 12, 5), itemsFor('chainmail_leggings', 3, 1, 12, 5)],
    [emeraldFor('lava_bucket', 1, 12, 20), emeraldFor('diamond', 1, 12, 20), itemsFor('chainmail_helmet', 1, 1, 12, 10), itemsFor('chainmail_chestplate', 4, 1, 12, 10), itemsFor('shield', 5, 1, 12, 10)],
    [enchantedItem('diamond_leggings', 14, 3, 15), enchantedItem('diamond_boots', 8, 3, 15)],
    [enchantedItem('diamond_helmet', 8, 3, 30), enchantedItem('diamond_chestplate', 16, 3, 30)],
  ],
  weaponsmith: [
    [emeraldFor('coal', 15, 16, 2), itemsFor('iron_axe', 3, 1, 12, 1), enchantedItem('iron_sword', 2, 3, 1)],
    [emeraldFor('iron_ingot', 4, 12, 10), itemsFor('bell', 36, 1, 12, 5)],
    [emeraldFor('flint', 24, 12, 20)],
    [emeraldFor('diamond', 1, 12, 30), enchantedItem('diamond_axe', 12, 3, 15)],
    [enchantedItem('diamond_sword', 8, 3, 30)],
  ],
  toolsmith: [
    [emeraldFor('coal', 15, 16, 2), itemsFor('stone_axe', 1, 1, 12, 1), itemsFor('stone_shovel', 1, 1, 12, 1), itemsFor('stone_pickaxe', 1, 1, 12, 1), itemsFor('stone_hoe', 1, 1, 12, 1)],
    [emeraldFor('iron_ingot', 4, 12, 10), itemsFor('bell', 36, 1, 12, 5)],
    [emeraldFor('flint', 30, 12, 20), enchantedItem('iron_axe', 1, 3, 10), enchantedItem('iron_shovel', 2, 3, 10), enchantedItem('iron_pickaxe', 3, 3, 10), itemsFor('diamond_hoe', 4, 1, 3, 10)],
    [emeraldFor('diamond', 1, 12, 30), enchantedItem('diamond_axe', 12, 3, 15), enchantedItem('diamond_shovel', 5, 3, 15)],
    [enchantedItem('diamond_pickaxe', 13, 3, 30)],
  ],
  butcher: [
    [emeraldFor('chicken', 14, 16, 2), emeraldFor('porkchop', 7, 16, 2), emeraldFor('rabbit', 4, 16, 2), itemsFor('rabbit_stew', 1, 1, 12, 1)],
    [emeraldFor('coal', 15, 16, 2), itemsFor('cooked_porkchop', 1, 5, 16, 5), itemsFor('cooked_chicken', 1, 8, 16, 5)],
    [emeraldFor('mutton', 7, 16, 20), emeraldFor('beef', 10, 16, 20)],
    [emeraldFor('dried_kelp_block', 10, 12, 30)],
    [emeraldFor('sweet_berries', 10, 12, 30)],
  ],
  leatherworker: [
    [emeraldFor('leather', 6, 16, 2), dyedArmor('leather_leggings', 3), dyedArmor('leather_chestplate', 7)],
    [emeraldFor('flint', 26, 12, 10), dyedArmor('leather_helmet', 5, 12, 5), dyedArmor('leather_boots', 4, 12, 5)],
    [emeraldFor('rabbit_hide', 9, 12, 20), dyedArmor('leather_chestplate', 7, 12, 10)],
    [emeraldFor('turtle_scute', 4, 12, 30), dyedArmor('leather_horse_armor', 6, 12, 15)],
    [itemsFor('saddle', 6, 1, 12, 30), dyedArmor('leather_helmet', 5, 12, 30)],
  ],
  mason: [
    [emeraldFor('clay_ball', 10, 16, 2), itemsFor('brick', 1, 10, 16, 1)],
    [emeraldFor('stone', 20, 16, 10), itemsFor('chiseled_stone_bricks', 1, 4, 16, 5)],
    [emeraldFor('granite', 16, 16, 20), emeraldFor('andesite', 16, 16, 20), emeraldFor('diorite', 16, 16, 20), itemsFor('polished_andesite', 1, 4, 16, 10), itemsFor('polished_diorite', 1, 4, 16, 10), itemsFor('polished_granite', 1, 4, 16, 10), itemsFor('dripstone_block', 1, 4, 16, 10)],
    [emeraldFor('quartz', 12, 12, 30), ...WOOLS.map((c) => itemsFor(c + '_terracotta', 1, 1, 12, 15)), ...WOOLS.map((c) => itemsFor(c + '_glazed_terracotta', 1, 1, 12, 15))],
    [itemsFor('quartz_pillar', 1, 1, 12, 30), itemsFor('quartz_block', 1, 1, 12, 30)],
  ],
};

/** Job-site block → profession (vanilla PoiTypes / VillagerProfession). */
export const JOB_SITES: Record<string, string> = { composter: 'farmer', barrel: 'fisherman', loom: 'shepherd', fletching_table: 'fletcher', lectern: 'librarian', cartography_table: 'cartographer', brewing_stand: 'cleric', blast_furnace: 'armorer', grindstone: 'weaponsmith', smithing_table: 'toolsmith', smoker: 'butcher', cauldron: 'leatherworker', water_cauldron: 'leatherworker', stonecutter: 'mason' };

/** xp needed to reach level 2..5 (VillagerData.NEXT_LEVEL_XP_THRESHOLDS) */
export const LEVEL_XP = [0, 10, 70, 150, 250];
export const MAX_LEVEL = 5;

/** Pick two offers of the given level (VillagerTrades.addOffersFromItemListings with 2). */
export function offersForLevel(profession: string, level: number, rnd: () => number, items: ItemRegistry, ctx: ListingContext): Trade[] {
  const listings = TRADES[profession]?.[level - 1];
  if (!listings) return [];
  const pool = listings.slice();
  const out: Trade[] = [];
  while (pool.length && out.length < 2) {
    const i = Math.floor(rnd() * pool.length);
    const t = pool.splice(i, 1)[0](rnd, items, ctx);
    if (t && items.get(t.r) && items.get(t.a) && (!t.b || items.get(t.b))) out.push(t);
  }
  return out;
}

/** Wandering trader offers (vanilla WANDERING_TRADER_TRADES: 5 common + 1 rare). */
export function wanderingTraderOffers(rnd: () => number, items: ItemRegistry): Trade[] {
  const common: [string, number, number][] = [['sea_pickle', 2, 1], ['slime_ball', 4, 1], ['glowstone', 2, 1], ['nautilus_shell', 5, 1], ['fern', 1, 1], ['sugar_cane', 1, 1], ['pumpkin', 1, 1], ['kelp', 3, 1], ['cactus', 3, 1], ['dandelion', 1, 1], ['poppy', 1, 1], ['blue_orchid', 1, 1], ['allium', 1, 1], ['azure_bluet', 1, 1], ['red_tulip', 1, 1], ['orange_tulip', 1, 1], ['white_tulip', 1, 1], ['pink_tulip', 1, 1], ['oxeye_daisy', 1, 1], ['cornflower', 1, 1], ['lily_of_the_valley', 1, 1], ['wheat_seeds', 1, 1], ['beetroot_seeds', 1, 1], ['pumpkin_seeds', 1, 1], ['melon_seeds', 1, 1], ['acacia_sapling', 5, 1], ['birch_sapling', 5, 1], ['dark_oak_sapling', 5, 1], ['jungle_sapling', 5, 1], ['oak_sapling', 5, 1], ['spruce_sapling', 5, 1], ['cherry_sapling', 5, 1], ['red_dye', 1, 3], ['white_dye', 1, 3], ['blue_dye', 1, 3], ['pink_dye', 1, 3], ['black_dye', 1, 3], ['green_dye', 1, 3], ['light_gray_dye', 1, 3], ['magenta_dye', 1, 3], ['yellow_dye', 1, 3], ['gray_dye', 1, 3], ['purple_dye', 1, 3], ['light_blue_dye', 1, 3], ['lime_dye', 1, 3], ['orange_dye', 1, 3], ['brown_dye', 1, 3], ['cyan_dye', 1, 3], ['brain_coral_block', 3, 1], ['bubble_coral_block', 3, 1], ['fire_coral_block', 3, 1], ['horn_coral_block', 3, 1], ['tube_coral_block', 3, 1], ['vine', 1, 1], ['brown_mushroom', 1, 1], ['red_mushroom', 1, 1], ['lily_pad', 1, 2], ['small_dripleaf', 1, 2], ['sand', 1, 8], ['red_sand', 1, 4], ['pointed_dripstone', 1, 2], ['rooted_dirt', 1, 2], ['moss_block', 1, 2]];
  const rare: [string, number, number][] = [['tropical_fish_bucket', 5, 1], ['pufferfish_bucket', 5, 1], ['packed_ice', 3, 1], ['blue_ice', 6, 1], ['gunpowder', 1, 1], ['podzol', 3, 3]];
  const out: Trade[] = [];
  const pick = (list: [string, number, number][], n: number, maxUses: number) => { const pool = list.filter(([n]) => items.get(n)); for (let i = 0; i < n && pool.length; i++) { const [name, cost, count] = pool.splice(Math.floor(rnd() * pool.length), 1)[0]; out.push({ a: 'emerald', ac: cost, r: name, rc: count, uses: 0, maxUses, xp: 1 }); } };
  pick(common, 5, 12); pick(rare, 1, 6);
  return out;
}

/** VillagerType.byBiome */
export function villagerTypeFor(biome: string): string {
  if (biome === 'desert') return 'desert';
  if (biome === 'jungle' || biome === 'sparse_jungle' || biome === 'bamboo_jungle') return 'jungle';
  if (biome === 'savanna' || biome === 'savanna_plateau' || biome === 'windswept_savanna') return 'savanna';
  if (biome.startsWith('snowy') || biome === 'ice_spikes' || biome === 'frozen_river' || biome === 'frozen_ocean' || biome === 'deep_frozen_ocean' || biome === 'frozen_peaks' || biome === 'jagged_peaks' || biome === 'grove') return 'snow';
  if (biome === 'swamp' || biome === 'mangrove_swamp') return 'swamp';
  if (biome === 'taiga' || biome === 'old_growth_pine_taiga' || biome === 'old_growth_spruce_taiga' || biome === 'windswept_forest' || biome === 'windswept_hills' || biome === 'windswept_gravelly_hills') return 'taiga';
  return 'plains';
}
