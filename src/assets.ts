// Loads the baked asset bundles produced by scripts/fetch-assets.mjs.

export interface AtlasTile { x: number; y: number; w: number; h: number }
export interface AtlasAnimation {
  name: string; x: number; y: number; w: number; h: number; srcX: number; srcY: number;
  frameCount: number; frametime: number; interpolate: boolean; frames: (number | { index: number; time: number })[] | null;
}
export interface AtlasMeta { width: number; height: number; tiles: Record<string, AtlasTile>; animations: AtlasAnimation[] }

export interface ModelBundle {
  blockstates: Record<string, any>;
  models: Record<string, any>;
  items: Record<string, any>;
}

export interface McDataBlock {
  id: number; name: string; displayName: string; hardness: number | null; resistance: number; stackSize: number;
  diggable: boolean; material: string; transparent: boolean; emitLight: number; filterLight: number;
  defaultState: number; minStateId: number; maxStateId: number;
  states: { name: string; type: 'enum' | 'bool' | 'int'; num_values: number; values?: string[] }[];
  harvestTools?: Record<string, boolean>; drops: number[]; boundingBox: 'block' | 'empty';
}
export interface McDataItem { id: number; name: string; displayName: string; stackSize: number; maxDurability?: number; enchantCategories?: string[]; repairWith?: string[] }
export interface McDataFood { id: number; name: string; foodPoints: number; saturation: number }
export interface McDataEntity { id: number; name: string; displayName: string; width: number; height: number; type: string; category: string }
export interface McDataBiome { id: number; name: string; category: string; temperature: number; has_precipitation: boolean; dimension: string; displayName: string; color: number }
export interface McData {
  blocks: McDataBlock[];
  blockCollisionShapes: { blocks: Record<string, number | number[]>; shapes: Record<string, number[][]> };
  items: McDataItem[];
  foods: McDataFood[];
  biomes: McDataBiome[];
  entities: McDataEntity[];
  materials: Record<string, Record<string, number>>;
  tints: { grass: { data: { keys: string[]; color: number }[] }; foliage: { data: { keys: string[]; color: number }[] }; water: { data: { keys: string[]; color: number }[] }; redstone: { data: { keys: number[]; color: number }[] }; constant: { data: { keys: string[]; color: number }[] } };
  effects: { id: number; name: string; displayName: string; type: string }[];
  enchantments: any[];
  attributes: any[];
  blockLoot: { block: string; drops: { item: string; dropChance: number; stackSizeRange: number[] }[] }[];
  entityLoot: { entity: string; drops: { item: string; dropChance: number; stackSizeRange: number[] }[] }[];
}

import type { StructureBundle } from './world/gen/jigsaw';

export interface DataBundle {
  recipes: Record<string, any>;
  lootTables: Record<string, any>;
  tags: Record<string, { values: string[] }>;
  sounds: Record<string, { sounds: (string | { name: string; volume?: number; pitch?: number; weight?: number; stream?: boolean })[]; subtitle?: string }>;
}

export interface Assets {
  atlas: AtlasMeta;
  atlasImage: ImageBitmap;
  animImage: ImageBitmap;
  models: ModelBundle;
  mcdata: McData;
  data: DataBundle;
  lang: Record<string, string>;
  splashes: string[];
  /** vanilla structure templates + jigsaw pools (villages); null when the bundle is missing */
  structures: StructureBundle | null;
  manifest: { mcVersion: string; music: boolean; sounds: boolean };
}

export const ASSET_BASE = './assets/';

async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(ASSET_BASE + path);
  if (!r.ok) throw new Error(`Failed to load ${path} (${r.status}). Did you run "npm run fetch-assets"?`);
  return r.json();
}

export async function loadImageBitmap(path: string): Promise<ImageBitmap> {
  const r = await fetch(ASSET_BASE + path);
  if (!r.ok) throw new Error(`Failed to load ${path} (${r.status})`);
  const blob = await r.blob();
  return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

export async function loadAssets(onProgress?: (msg: string, frac: number) => void): Promise<Assets> {
  const steps: [string, () => Promise<any>][] = [
    ['manifest', () => fetchJson('manifest.json')],
    ['atlas metadata', () => fetchJson('bundle/atlas.json')],
    ['texture atlas', () => loadImageBitmap('bundle/atlas.png')],
    ['animated textures', () => loadImageBitmap('bundle/anim.png')],
    ['block models', () => fetchJson('bundle/models.json')],
    ['game data', () => fetchJson('bundle/mcdata.json')],
    ['recipes & loot', () => fetchJson('bundle/data.json')],
    ['language', () => fetchJson('bundle/lang.json')],
    ['splashes', () => fetchJson('bundle/splashes.json')],
    ['structures', () => fetchJson('bundle/structures.json').catch(() => null)],
  ];
  const results: any[] = [];
  let i = 0;
  for (const [name, fn] of steps) {
    onProgress?.(`Loading ${name}…`, i / steps.length);
    results.push(await fn());
    i++;
  }
  const [manifest, atlas, atlasImage, animImage, models, mcdata, data, lang, splashes, structures] = results;
  return { manifest, atlas, atlasImage, animImage, models, mcdata, data, lang, splashes, structures };
}

/** Texture path helper: "block/stone" -> "pack/assets/minecraft/textures/block/stone.png" */
export function texturePath(name: string): string {
  return `pack/assets/minecraft/textures/${name.replace(/^minecraft:/, '')}.png`;
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();
export function loadImage(name: string): Promise<HTMLImageElement> {
  let p = imageCache.get(name);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image ' + name));
      img.src = ASSET_BASE + texturePath(name);
    });
    imageCache.set(name, p);
  }
  return p;
}
