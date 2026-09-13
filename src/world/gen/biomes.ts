// Biome table + multi-noise selection (a compact version of vanilla's overworld biome layout).
export interface BiomeDef {
  name: string;          // vanilla id (used for tints / display name)
  temperature: number;
  downfall: number;
  precipitation: 'none' | 'rain' | 'snow';
  top: string; filler: string; underwater: string;
  trees: [string, number][]; // [treeType, per-chunk attempts]
  grass: number;   // per-chunk grass patches
  flowers: number;
  extra?: string[]; // extra feature tags
  skyColor?: number; fogColor?: number; waterColor?: number; waterFogColor?: number; grassColor?: number; foliageColor?: number;
  passive: string[]; hostile: string[];
  ocean?: boolean; river?: boolean; beach?: boolean; mountain?: boolean;
  dimension?: 'overworld' | 'the_nether' | 'the_end';
}

const PLAINS_PASSIVE = ['sheep', 'pig', 'chicken', 'cow', 'horse'];
const FOREST_PASSIVE = ['sheep', 'pig', 'chicken', 'cow'];
const HOSTILE = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch'];
const OCEAN_PASSIVE = ['squid', 'cod', 'salmon'];

const b = (name: string, temperature: number, downfall: number, o: Partial<BiomeDef> = {}): BiomeDef => ({
  name, temperature, downfall,
  precipitation: o.precipitation ?? (temperature < 0.15 ? 'snow' : downfall === 0 ? 'none' : 'rain'),
  top: o.top ?? 'grass_block', filler: o.filler ?? 'dirt', underwater: o.underwater ?? 'gravel',
  trees: o.trees ?? [], grass: o.grass ?? 0, flowers: o.flowers ?? 0, extra: o.extra ?? [],
  passive: o.passive ?? PLAINS_PASSIVE, hostile: o.hostile ?? HOSTILE,
  ...o,
});

export const BIOMES: BiomeDef[] = [
  b('ocean', 0.5, 0.5, { ocean: true, top: 'gravel', filler: 'gravel', underwater: 'gravel', passive: OCEAN_PASSIVE, extra: ['kelp', 'seagrass'] }),
  b('deep_ocean', 0.5, 0.5, { ocean: true, top: 'gravel', filler: 'gravel', passive: OCEAN_PASSIVE, extra: ['kelp', 'seagrass'] }),
  b('warm_ocean', 0.5, 0.5, { ocean: true, top: 'sand', filler: 'sand', underwater: 'sand', passive: ['tropical_fish', 'pufferfish', 'dolphin', 'squid'], extra: ['seagrass', 'coral', 'sea_pickle'], waterColor: 0x43d5ee }),
  b('lukewarm_ocean', 0.5, 0.5, { ocean: true, top: 'sand', filler: 'sand', underwater: 'sand', passive: OCEAN_PASSIVE, extra: ['kelp', 'seagrass'], waterColor: 0x45adf2 }),
  b('cold_ocean', 0.5, 0.5, { ocean: true, top: 'gravel', filler: 'gravel', passive: OCEAN_PASSIVE, extra: ['kelp', 'seagrass'], waterColor: 0x3d57d6 }),
  b('frozen_ocean', 0.0, 0.5, { ocean: true, top: 'gravel', filler: 'gravel', passive: ['squid', 'polar_bear'], extra: ['ice_sheet'], waterColor: 0x3938c9 }),
  b('river', 0.5, 0.5, { river: true, top: 'sand', filler: 'sand', underwater: 'sand', passive: ['squid', 'salmon'], extra: ['seagrass'] }),
  b('frozen_river', 0.0, 0.5, { river: true, top: 'sand', filler: 'sand', underwater: 'sand', passive: ['squid', 'salmon'], extra: ['ice_sheet'], waterColor: 0x3938c9 }),
  b('beach', 0.8, 0.4, { beach: true, top: 'sand', filler: 'sand', underwater: 'sand', passive: ['turtle'], extra: ['sugar_cane'] }),
  b('snowy_beach', 0.05, 0.3, { beach: true, top: 'sand', filler: 'sand', underwater: 'sand', passive: [], extra: ['snow'] }),
  b('stony_shore', 0.2, 0.3, { beach: true, top: 'stone', filler: 'stone', underwater: 'gravel', passive: [] }),
  b('plains', 0.8, 0.4, { trees: [['oak', 0.05]], grass: 6, flowers: 2, extra: ['sugar_cane', 'pumpkin'] }),
  b('sunflower_plains', 0.8, 0.4, { trees: [['oak', 0.05]], grass: 6, flowers: 2, extra: ['sunflower', 'sugar_cane'] }),
  b('snowy_plains', 0.0, 0.5, { trees: [['spruce', 0.05]], grass: 1, extra: ['snow'], passive: ['rabbit', 'polar_bear'], hostile: [...HOSTILE, 'stray'] }),
  b('ice_spikes', 0.0, 0.5, { top: 'snow_block', filler: 'snow_block', extra: ['snow', 'ice_spikes'], passive: ['rabbit', 'polar_bear'], hostile: [...HOSTILE, 'stray'] }),
  b('forest', 0.7, 0.8, { trees: [['oak', 8], ['birch', 2], ['fancy_oak', 0.5]], grass: 4, flowers: 2, extra: ['mushroom'], passive: [...FOREST_PASSIVE, 'wolf'] }),
  b('flower_forest', 0.7, 0.8, { trees: [['oak', 4], ['birch', 2]], grass: 4, flowers: 40, passive: [...FOREST_PASSIVE, 'rabbit'] }),
  b('birch_forest', 0.6, 0.6, { trees: [['birch', 10]], grass: 4, flowers: 2, extra: ['mushroom'], passive: FOREST_PASSIVE }),
  b('old_growth_birch_forest', 0.6, 0.6, { trees: [['tall_birch', 10]], grass: 4, flowers: 2, extra: ['mushroom'], passive: FOREST_PASSIVE }),
  b('dark_forest', 0.7, 0.8, { trees: [['dark_oak', 8], ['oak', 2], ['fancy_oak', 1], ['huge_mushroom', 0.5]], grass: 4, flowers: 1, extra: ['mushroom'], passive: FOREST_PASSIVE }),
  b('taiga', 0.25, 0.8, { trees: [['spruce', 8], ['pine', 4]], grass: 6, flowers: 1, extra: ['sweet_berries', 'mushroom', 'fern'], passive: ['wolf', 'rabbit', 'fox', ...FOREST_PASSIVE] }),
  b('snowy_taiga', -0.5, 0.4, { trees: [['spruce', 8], ['pine', 4]], grass: 3, extra: ['snow', 'sweet_berries', 'fern'], passive: ['wolf', 'rabbit', 'fox', ...FOREST_PASSIVE], hostile: [...HOSTILE, 'stray'] }),
  b('old_growth_pine_taiga', 0.3, 0.8, { top: 'podzol', trees: [['mega_pine', 2], ['spruce', 6], ['pine', 3]], grass: 6, extra: ['mushroom', 'fern', 'sweet_berries'], passive: ['wolf', 'rabbit', 'fox', ...FOREST_PASSIVE] }),
  b('old_growth_spruce_taiga', 0.25, 0.8, { top: 'podzol', trees: [['mega_spruce', 2], ['spruce', 6], ['pine', 3]], grass: 6, extra: ['mushroom', 'fern', 'sweet_berries'], passive: ['wolf', 'rabbit', 'fox', ...FOREST_PASSIVE] }),
  b('savanna', 1.2, 0.0, { precipitation: 'none', trees: [['acacia', 1], ['oak', 0.5]], grass: 20, flowers: 1, passive: ['horse', 'donkey', 'armadillo', ...PLAINS_PASSIVE] }),
  b('savanna_plateau', 1.0, 0.0, { precipitation: 'none', trees: [['acacia', 1], ['oak', 0.5]], grass: 20, flowers: 1, passive: ['horse', 'donkey', 'llama', 'armadillo', ...PLAINS_PASSIVE] }),
  b('windswept_savanna', 1.1, 0.0, { precipitation: 'none', trees: [['acacia', 1]], grass: 20, mountain: true, passive: ['horse', 'donkey', ...PLAINS_PASSIVE] }),
  b('windswept_hills', 0.2, 0.3, { trees: [['spruce', 0.3], ['oak', 0.2]], grass: 2, mountain: true, extra: ['emerald'], passive: ['llama', ...PLAINS_PASSIVE] }),
  b('windswept_forest', 0.2, 0.3, { trees: [['spruce', 3], ['oak', 2]], grass: 3, mountain: true, extra: ['emerald'], passive: ['llama', ...PLAINS_PASSIVE] }),
  b('windswept_gravelly_hills', 0.2, 0.3, { top: 'gravel', filler: 'gravel', trees: [['spruce', 0.3]], grass: 1, mountain: true, extra: ['emerald'], passive: ['llama', ...PLAINS_PASSIVE] }),
  b('jungle', 0.95, 0.9, { trees: [['jungle', 10], ['jungle_bush', 15], ['mega_jungle', 1], ['oak', 1]], grass: 25, flowers: 4, extra: ['melon', 'cocoa', 'vines', 'bamboo_sparse'], passive: ['parrot', 'ocelot', 'panda', 'chicken'] }),
  b('sparse_jungle', 0.95, 0.8, { trees: [['jungle', 2], ['jungle_bush', 4], ['oak', 1]], grass: 25, flowers: 4, extra: ['melon', 'vines'], passive: ['parrot', 'chicken'] }),
  b('bamboo_jungle', 0.95, 0.9, { top: 'podzol', trees: [['jungle', 4], ['mega_jungle', 1]], grass: 10, extra: ['bamboo', 'melon'], passive: ['panda', 'parrot', 'chicken'] }),
  b('desert', 2.0, 0.0, { precipitation: 'none', top: 'sand', filler: 'sand', underwater: 'sand', extra: ['cactus', 'dead_bush', 'sugar_cane', 'desert_well'], passive: ['rabbit', 'camel'], hostile: [...HOSTILE, 'husk'] }),
  b('swamp', 0.8, 0.9, { trees: [['swamp_oak', 2]], grass: 5, flowers: 1, extra: ['lily_pad', 'mushroom', 'blue_orchid', 'sugar_cane', 'swamp_water'], passive: ['frog', 'slime', ...FOREST_PASSIVE], hostile: [...HOSTILE, 'slime', 'bogged'], waterColor: 0x617b64, grassColor: 0x6a7039, foliageColor: 0x6a7039 }),
  b('mangrove_swamp', 0.8, 0.9, { top: 'mud', filler: 'mud', underwater: 'mud', trees: [['mangrove', 6]], grass: 5, extra: ['lily_pad', 'swamp_water'], passive: ['frog', 'slime'], hostile: [...HOSTILE, 'slime', 'bogged'], waterColor: 0x3a7a6a, grassColor: 0x6a7039, foliageColor: 0x8db127 }),
  b('badlands', 2.0, 0.0, { precipitation: 'none', top: 'red_sand', filler: 'terracotta', underwater: 'red_sand', extra: ['dead_bush', 'badlands_layers', 'gold'], passive: [], grassColor: 0x90814d, foliageColor: 0x9e814d }),
  b('wooded_badlands', 2.0, 0.0, { precipitation: 'none', top: 'coarse_dirt', filler: 'terracotta', underwater: 'red_sand', trees: [['oak', 5]], grass: 4, extra: ['dead_bush', 'badlands_layers', 'gold'], passive: [], grassColor: 0x90814d, foliageColor: 0x9e814d }),
  b('eroded_badlands', 2.0, 0.0, { precipitation: 'none', top: 'red_sand', filler: 'terracotta', underwater: 'red_sand', extra: ['dead_bush', 'badlands_layers', 'gold', 'hoodoos'], passive: [], grassColor: 0x90814d, foliageColor: 0x9e814d }),
  b('meadow', 0.5, 0.8, { trees: [['oak', 0.1], ['birch', 0.1]], grass: 10, flowers: 12, mountain: true, extra: ['tall_flowers'], passive: ['sheep', 'donkey', 'rabbit'] }),
  b('cherry_grove', 0.5, 0.8, { trees: [['cherry', 4]], grass: 10, flowers: 4, mountain: true, extra: ['pink_petals'], passive: ['sheep', 'pig', 'rabbit'] }),
  b('grove', -0.2, 0.8, { top: 'snow_block', filler: 'dirt', trees: [['spruce', 10]], mountain: true, extra: ['snow', 'powder_snow'], passive: ['wolf', 'rabbit', 'fox'] }),
  b('snowy_slopes', -0.3, 0.9, { top: 'snow_block', filler: 'snow_block', mountain: true, extra: ['snow', 'powder_snow'], passive: ['rabbit', 'goat'] }),
  b('jagged_peaks', -0.7, 0.9, { top: 'snow_block', filler: 'stone', mountain: true, extra: ['snow', 'emerald'], passive: ['goat'] }),
  b('frozen_peaks', -0.7, 0.9, { top: 'snow_block', filler: 'packed_ice', mountain: true, extra: ['snow', 'emerald'], passive: ['goat'] }),
  b('stony_peaks', 1.0, 0.3, { top: 'stone', filler: 'stone', mountain: true, extra: ['calcite_layers', 'emerald'], passive: [] }),
  b('mushroom_fields', 0.9, 1.0, { top: 'mycelium', filler: 'dirt', trees: [['huge_mushroom', 3]], extra: ['mushroom'], passive: ['mooshroom'], hostile: [] }),
  b('pale_garden', 0.7, 0.8, { trees: [['pale_oak', 8]], grass: 2, extra: ['pale_moss'], passive: [], hostile: ['creaking'], grassColor: 0x778272, foliageColor: 0x878d76 }),
  // cave biomes (assigned by depth / noise)
  b('dripstone_caves', 0.8, 0.4, { passive: [], extra: ['dripstone'] }),
  b('lush_caves', 0.5, 0.5, { passive: ['axolotl', 'glow_squid'], extra: ['lush'] }),
  b('deep_dark', 0.8, 0.4, { passive: [], hostile: [], extra: ['sculk'] }),
  // nether
  b('nether_wastes', 2.0, 0.0, { precipitation: 'none', dimension: 'the_nether', top: 'netherrack', filler: 'netherrack', underwater: 'netherrack', passive: ['strider'], hostile: ['zombified_piglin', 'ghast', 'magma_cube', 'piglin', 'enderman'], fogColor: 0x330808 }),
  b('soul_sand_valley', 2.0, 0.0, { precipitation: 'none', dimension: 'the_nether', top: 'soul_sand', filler: 'soul_soil', underwater: 'soul_sand', passive: ['strider'], hostile: ['skeleton', 'ghast', 'enderman'], fogColor: 0x1b4745, extra: ['basalt_pillars', 'bone_spines'] }),
  b('crimson_forest', 2.0, 0.0, { precipitation: 'none', dimension: 'the_nether', top: 'crimson_nylium', filler: 'netherrack', underwater: 'netherrack', trees: [['crimson_fungus', 8]], passive: ['strider'], hostile: ['zombified_piglin', 'hoglin', 'piglin'], fogColor: 0x330303, extra: ['crimson_roots', 'weeping_vines', 'shroomlight'] }),
  b('warped_forest', 2.0, 0.0, { precipitation: 'none', dimension: 'the_nether', top: 'warped_nylium', filler: 'netherrack', underwater: 'netherrack', trees: [['warped_fungus', 8]], passive: ['strider'], hostile: ['enderman'], fogColor: 0x1a051a, extra: ['warped_roots', 'twisting_vines', 'nether_sprouts'] }),
  b('basalt_deltas', 2.0, 0.0, { precipitation: 'none', dimension: 'the_nether', top: 'basalt', filler: 'blackstone', underwater: 'basalt', passive: ['strider'], hostile: ['ghast', 'magma_cube'], fogColor: 0x685f70, extra: ['basalt_columns', 'delta_lava'] }),
  // end
  b('the_end', 0.5, 0.5, { precipitation: 'none', dimension: 'the_end', top: 'end_stone', filler: 'end_stone', underwater: 'end_stone', passive: [], hostile: ['enderman'], fogColor: 0xa080a0, skyColor: 0 }),
  b('end_highlands', 0.5, 0.5, { precipitation: 'none', dimension: 'the_end', top: 'end_stone', filler: 'end_stone', underwater: 'end_stone', trees: [['chorus', 4]], passive: [], hostile: ['enderman'], fogColor: 0xa080a0, skyColor: 0 }),
  b('end_midlands', 0.5, 0.5, { precipitation: 'none', dimension: 'the_end', top: 'end_stone', filler: 'end_stone', underwater: 'end_stone', passive: [], hostile: ['enderman'], fogColor: 0xa080a0, skyColor: 0 }),
  b('small_end_islands', 0.5, 0.5, { precipitation: 'none', dimension: 'the_end', top: 'end_stone', filler: 'end_stone', underwater: 'end_stone', passive: [], hostile: ['enderman'], fogColor: 0xa080a0, skyColor: 0 }),
  b('end_barrens', 0.5, 0.5, { precipitation: 'none', dimension: 'the_end', top: 'end_stone', filler: 'end_stone', underwater: 'end_stone', passive: [], hostile: ['enderman'], fogColor: 0xa080a0, skyColor: 0 }),
];

export const BIOME_INDEX = new Map<string, number>(BIOMES.map((bd, i) => [bd.name, i]));
export const biomeId = (name: string): number => BIOME_INDEX.get(name) ?? 0;

/** Vanilla-ish sky colour from temperature. */
export function skyColorFor(biome: BiomeDef): number {
  if (biome.skyColor !== undefined) return biome.skyColor;
  const t = Math.max(-1, Math.min(1, biome.temperature / 3));
  return hsvToRgb(0.62222224 - t * 0.05, 0.5 + t * 0.1, 1.0);
}

export function hsvToRgb(h: number, s: number, v: number): number {
  const i = Math.floor(h * 6) % 6, f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, bl = 0;
  switch (i) { case 0: r = v; g = t; bl = p; break; case 1: r = q; g = v; bl = p; break; case 2: r = p; g = v; bl = t; break; case 3: r = p; g = q; bl = v; break; case 4: r = t; g = p; bl = v; break; default: r = v; g = p; bl = q; }
  return ((r * 255) << 16) | ((g * 255) << 8) | (bl * 255);
}

/**
 * Overworld biome from climate parameters, all roughly in [-1, 1]:
 * T temperature, H humidity, C continentalness, E erosion, PV peaks/valleys, W weirdness.
 */
export function selectOverworldBiome(T: number, H: number, C: number, E: number, PV: number, W: number, height: number, seaLevel: number): number {
  const tIdx = T < -0.45 ? 0 : T < -0.15 ? 1 : T < 0.2 ? 2 : T < 0.55 ? 3 : 4;
  const hIdx = H < -0.35 ? 0 : H < -0.1 ? 1 : H < 0.1 ? 2 : H < 0.3 ? 3 : 4;
  // oceans
  if (C < -0.19) {
    const deep = C < -0.55;
    if (tIdx === 0) return biomeId(deep ? 'frozen_ocean' : 'frozen_ocean');
    if (tIdx === 1) return biomeId(deep ? 'deep_ocean' : 'cold_ocean');
    if (tIdx === 4) return biomeId(deep ? 'deep_ocean' : 'warm_ocean');
    if (tIdx === 3) return biomeId(deep ? 'deep_ocean' : 'lukewarm_ocean');
    return biomeId(deep ? 'deep_ocean' : 'ocean');
  }
  // rivers
  if (Math.abs(W) < 0.05 && C > -0.1 && E > -0.3 && height <= seaLevel + 1) return biomeId(tIdx === 0 ? 'frozen_river' : 'river');
  // beaches / shores
  if (C < -0.11 && height <= seaLevel + 3) {
    if (E < -0.2 && PV > 0) return biomeId('stony_shore');
    return biomeId(tIdx === 0 ? 'snowy_beach' : 'beach');
  }
  if (C < -0.11 && E < -0.4 && height < seaLevel + 20) return biomeId('stony_shore');
  // mountains (high peaks / low erosion)
  const mountainous = PV > 0.35 && E < -0.2;
  if (mountainous) {
    if (PV > 0.7 && E < -0.5) {
      if (tIdx <= 1) return biomeId(W < 0 ? 'jagged_peaks' : 'frozen_peaks');
      if (tIdx === 2) return biomeId(W < 0 ? 'jagged_peaks' : 'stony_peaks');
      return biomeId('stony_peaks');
    }
    if (tIdx <= 1) return biomeId(hIdx <= 1 ? 'snowy_slopes' : 'grove');
    if (tIdx === 2) return biomeId(hIdx <= 1 ? 'meadow' : hIdx === 2 ? 'cherry_grove' : 'grove');
    if (tIdx === 3) return biomeId(hIdx <= 1 ? 'savanna_plateau' : 'meadow');
    return biomeId(hIdx <= 2 ? 'badlands' : 'wooded_badlands');
  }
  if (E < -0.35 && PV > 0.05) {
    // windswept hills
    if (tIdx === 4) return biomeId('windswept_savanna');
    if (tIdx <= 2) return biomeId(hIdx <= 1 ? 'windswept_gravelly_hills' : hIdx === 2 ? 'windswept_hills' : 'windswept_forest');
    return biomeId('windswept_hills');
  }
  // swamps: low, flat, wet & warm
  if (E > 0.5 && height <= seaLevel + 4 && hIdx >= 3 && tIdx >= 2) return biomeId(tIdx === 4 ? 'mangrove_swamp' : 'swamp');
  // badlands for hot + eroded plateaus
  if (tIdx === 4 && E < -0.05) return biomeId(hIdx >= 3 ? 'wooded_badlands' : W > 0.3 ? 'eroded_badlands' : 'badlands');
  // middle biomes
  const table: string[][] = [
    ['snowy_plains', 'snowy_plains', 'snowy_plains', 'snowy_taiga', 'taiga'],
    ['plains', 'plains', 'forest', 'taiga', 'old_growth_spruce_taiga'],
    ['flower_forest', 'plains', 'forest', 'birch_forest', 'dark_forest'],
    ['savanna', 'savanna', 'forest', 'jungle', 'jungle'],
    ['desert', 'desert', 'desert', 'desert', 'desert'],
  ];
  let name = table[tIdx][hIdx];
  if (W > 0.4) {
    if (name === 'plains') name = 'sunflower_plains';
    else if (name === 'birch_forest') name = 'old_growth_birch_forest';
    else if (name === 'jungle') name = hIdx === 3 ? 'sparse_jungle' : 'bamboo_jungle';
    else if (name === 'taiga' && tIdx === 1) name = 'old_growth_pine_taiga';
    else if (name === 'snowy_plains' && hIdx === 2) name = 'ice_spikes';
    else if (name === 'dark_forest') name = 'pale_garden';
  }
  if (name === 'jungle' && hIdx === 3) name = 'sparse_jungle';
  return biomeId(name);
}
