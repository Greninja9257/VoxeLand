#!/usr/bin/env node
/**
 * VoxeLand asset fetcher.
 *
 * Downloads (into ./public/assets, which is git-ignored — nothing proprietary is committed):
 *   1. The "Default Template Resource Pack (Vanilla Minecraft)" from CurseForge (by Truyty),
 *      which is an unmodified extraction of the vanilla Minecraft Java Edition client assets
 *      (textures, block models, blockstates, item definitions, fonts, language files).
 *   2. Vanilla Minecraft sounds straight from Mojang's official asset index
 *      (the same server the Minecraft Launcher downloads from).
 *   3. The client jar's data-pack files (recipes, loot tables, tags) + sounds.json.
 *   4. PrismarineJS minecraft-data (MIT) for block hardness, state tables, collision shapes,
 *      foods, entities, biomes, tints, etc.
 *
 * Then it bakes: a texture atlas (atlas.png / atlas.json / anim.png), a models bundle, and
 * JSON bundles for data, so the game boots with a handful of requests instead of ~20k.
 *
 * Usage: node scripts/fetch-assets.mjs [--no-music] [--no-sounds] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'assets');
const args = new Set(process.argv.slice(2));
const NO_MUSIC = args.has('--no-music');
const NO_SOUNDS = args.has('--no-sounds');
const FORCE = args.has('--force');

const MC_VERSION = '26.2';
const CF_PROJECT_ID = 1631584;
const CF_FILE_ID = 8540189; // texture-pack-default1.20.5-26.2.zip
const CF_PAGE = 'https://www.curseforge.com/minecraft/texture-packs/default-template-resource-pack-vanilla-minecraft';
const CF_DOWNLOAD = `https://www.curseforge.com/api/v1/mods/${CF_PROJECT_ID}/files/${CF_FILE_ID}/download`;
const MCDATA_VERSION = '26.1';
const MCDATA_RAW = `https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/${MCDATA_VERSION}`;
const MCDATA_FILES = ['blocks', 'blockCollisionShapes', 'items', 'foods', 'biomes', 'entities', 'materials', 'tints', 'effects', 'enchantments', 'attributes', 'particles'];
const MCDATA_FILES_120 = ['blockLoot', 'entityLoot'];

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log('[fetch-assets]', ...a);

async function download(url, dest, { retries = 4 } = {}) {
  if (fs.existsSync(dest) && !FORCE) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'VoxeLand-asset-fetcher/1.0' }, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(dest + '.part', buf);
      fs.renameSync(dest + '.part', dest);
      return dest;
    } catch (e) {
      if (attempt === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

// ---------- minimal ZIP reader (central directory + deflate) ----------
function readZip(buf) {
  const entries = new Map();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Bad central directory');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    entries.set(name, { method, csize, usize, lho });
    off += 46 + nlen + elen + clen;
  }
  return {
    names: () => [...entries.keys()],
    has: (n) => entries.has(n),
    read(n) {
      const e = entries.get(n);
      if (!e) throw new Error('missing zip entry ' + n);
      const nlen = buf.readUInt16LE(e.lho + 26);
      const elen = buf.readUInt16LE(e.lho + 28);
      const start = e.lho + 30 + nlen + elen;
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) return zlib.inflateRawSync(data);
      throw new Error('unsupported zip method ' + e.method);
    },
  };
}

function extractZip(zip, filter, destRoot, rewrite = (n) => n) {
  let n = 0;
  for (const name of zip.names()) {
    if (name.endsWith('/')) continue;
    if (!filter(name)) continue;
    const dest = path.join(destRoot, rewrite(name));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, zip.read(name));
    n++;
  }
  return n;
}

// ---------- 1. resource pack ----------
async function fetchPack() {
  const zipPath = path.join(CACHE, `default-template-pack-${CF_FILE_ID}.zip`);
  log('Downloading Default Template Resource Pack from CurseForge …');
  await download(CF_DOWNLOAD, zipPath);
  const zip = readZip(fs.readFileSync(zipPath));
  const dest = path.join(OUT, 'pack');
  if (fs.existsSync(path.join(dest, 'pack.mcmeta')) && !FORCE) { log('pack already extracted'); return; }
  const n = extractZip(zip, (name) => name === 'pack.mcmeta' || name.startsWith('assets/minecraft/'), dest);
  log(`extracted ${n} pack files`);
}

// ---------- 2/3. client jar (data files + sounds.json) & asset index ----------
async function fetchVersionJson() {
  const manifestPath = path.join(CACHE, 'version_manifest_v2.json');
  await download('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', manifestPath, {});
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const ver = manifest.versions.find((v) => v.id === MC_VERSION) ?? manifest.versions.find((v) => v.id === manifest.latest.release);
  const vpath = path.join(CACHE, `version-${ver.id}.json`);
  await download(ver.url, vpath);
  return JSON.parse(fs.readFileSync(vpath, 'utf8'));
}

async function fetchJarData(version) {
  const jarPath = path.join(CACHE, `client-${version.id}.jar`);
  log(`Downloading Minecraft ${version.id} client jar (for data files: recipes, loot tables, tags) …`);
  await download(version.downloads.client.url, jarPath);
  const zip = readZip(fs.readFileSync(jarPath));
  const dest = path.join(OUT, 'data');
  const n = extractZip(
    zip,
    (name) => /^data\/minecraft\/(recipe|loot_table|tags|worldgen\/biome|worldgen\/configured_feature)\//.test(name) || name === 'assets/minecraft/sounds.json' || name === 'assets/minecraft/regional_compliancies.json',
    dest,
    (name) => name.replace(/^data\/minecraft\//, '').replace(/^assets\/minecraft\//, ''),
  );
  log(`extracted ${n} data files from jar`);
  return zip;
}

async function loadAssetIndex(version) {
  const idxPath = path.join(CACHE, `assets-index-${version.assetIndex.id}.json`);
  await download(version.assetIndex.url, idxPath);
  return JSON.parse(fs.readFileSync(idxPath, 'utf8')).objects;
}

const objUrl = (o) => `https://resources.download.minecraft.net/${o.hash.slice(0, 2)}/${o.hash}`;

// sounds.json (event -> files mapping) and a few extras live in the asset index, not the jar
async function fetchIndexExtras(version) {
  const index = await loadAssetIndex(version);
  await download(objUrl(index['minecraft/sounds.json']), path.join(OUT, 'data', 'sounds.json'));
  const extras = Object.keys(index).filter((k) => k.startsWith('minecraft/textures/'));
  for (const k of extras) { const dest = path.join(OUT, 'pack', 'assets', k); if (fs.existsSync(dest) && fs.statSync(dest).size < 1000) fs.unlinkSync(dest); await download(objUrl(index[k]), dest); }
}

async function fetchSounds(version) {
  if (NO_SOUNDS) { log('skipping sounds (--no-sounds)'); return; }
  const index = await loadAssetIndex(version);
  const wanted = Object.entries(index).filter(([k]) => k.startsWith('minecraft/sounds/') && !(NO_MUSIC && (k.startsWith('minecraft/sounds/music/') || k.startsWith('minecraft/sounds/records/'))));
  const total = wanted.reduce((a, [, v]) => a + v.size, 0);
  log(`Downloading ${wanted.length} vanilla sound files (${(total / 1e6).toFixed(0)} MB) from Mojang's asset server …`);
  let done = 0, doneBytes = 0;
  const queue = wanted.slice();
  const worker = async () => {
    while (queue.length) {
      const [name, { hash, size }] = queue.pop();
      const dest = path.join(OUT, 'sounds', name.replace(/^minecraft\/sounds\//, ''));
      if (!fs.existsSync(dest) || fs.statSync(dest).size !== size) {
        await download(objUrl({ hash }), dest);
      }
      done++; doneBytes += size;
      if (done % 250 === 0) log(`  sounds ${done}/${wanted.length} (${(doneBytes / 1e6).toFixed(0)} MB)`);
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  log('sounds done');
}

// ---------- 4. minecraft-data ----------
async function fetchMcData() {
  const dest = path.join(OUT, 'mcdata');
  fs.mkdirSync(dest, { recursive: true });
  log('Downloading PrismarineJS minecraft-data …');
  await Promise.all([
    ...MCDATA_FILES.map((f) => download(`${MCDATA_RAW}/${f}.json`, path.join(dest, `${f}.json`))),
    ...MCDATA_FILES_120.map((f) => download(`https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/1.20/${f}.json`, path.join(dest, `${f}.json`))),
  ]);
  fs.writeFileSync(path.join(dest, 'LICENSE'), `MIT License

Copyright (c) PrismarineJS contributors (https://github.com/PrismarineJS/minecraft-data)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`);
}

// ---------- 5. bundles ----------
function readJsonDir(dir, prefix = '') {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) Object.assign(out, readJsonDir(path.join(dir, ent.name), prefix + ent.name + '/'));
    else if (ent.name.endsWith('.json')) {
      try { out[prefix + ent.name.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, ent.name), 'utf8')); } catch (e) { log('bad json', ent.name); }
    }
  }
  return out;
}

function buildModelBundle() {
  const packRoot = path.join(OUT, 'pack', 'assets', 'minecraft');
  const bundle = {
    blockstates: readJsonDir(path.join(packRoot, 'blockstates')),
    models: readJsonDir(path.join(packRoot, 'models')),
    items: readJsonDir(path.join(packRoot, 'items')),
  };
  fs.mkdirSync(path.join(OUT, 'bundle'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'bundle', 'models.json'), JSON.stringify(bundle));
  log(`models bundle: ${Object.keys(bundle.blockstates).length} blockstates, ${Object.keys(bundle.models).length} models, ${Object.keys(bundle.items).length} item defs`);
  const lang = JSON.parse(fs.readFileSync(path.join(packRoot, 'lang', 'en_us.json'), 'utf8'));
  fs.writeFileSync(path.join(OUT, 'bundle', 'lang.json'), JSON.stringify(lang));
  const splashes = fs.existsSync(path.join(packRoot, 'texts', 'splashes.txt')) ? fs.readFileSync(path.join(packRoot, 'texts', 'splashes.txt'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : [];
  fs.writeFileSync(path.join(OUT, 'bundle', 'splashes.json'), JSON.stringify(splashes));
}

function buildDataBundle() {
  const dataRoot = path.join(OUT, 'data');
  const data = {
    recipes: readJsonDir(path.join(dataRoot, 'recipe')),
    lootTables: readJsonDir(path.join(dataRoot, 'loot_table')),
    tags: readJsonDir(path.join(dataRoot, 'tags')),
    sounds: JSON.parse(fs.readFileSync(path.join(dataRoot, 'sounds.json'), 'utf8')),
  };
  fs.writeFileSync(path.join(OUT, 'bundle', 'data.json'), JSON.stringify(data));
  log(`data bundle: ${Object.keys(data.recipes).length} recipes, ${Object.keys(data.lootTables).length} loot tables, ${Object.keys(data.tags).length} tags, ${Object.keys(data.sounds).length} sound events`);
  const mc = {};
  for (const f of [...MCDATA_FILES, ...MCDATA_FILES_120]) mc[f] = JSON.parse(fs.readFileSync(path.join(OUT, 'mcdata', f + '.json'), 'utf8'));
  fs.writeFileSync(path.join(OUT, 'bundle', 'mcdata.json'), JSON.stringify(mc));
  log(`mcdata bundle: ${mc.blocks.length} blocks, ${mc.items.length} items, ${mc.entities.length} entities`);
}

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

function buildAtlas() {
  const texRoot = path.join(OUT, 'pack', 'assets', 'minecraft', 'textures');
  const tiles = [];
  // entity textures needed for block-entity meshes (chests, beds, signs, shulker boxes, bell, decorated pot)
  const extraDirs = ['entity/chest', 'entity/shulker', 'entity/bell', 'entity/decorated_pot', 'entity/conduit', 'entity/banner', 'entity/skeleton', 'entity/zombie', 'entity/creeper', 'entity/piglin', 'entity/player/wide', 'entity', 'environment', 'environment/celestial', 'environment/celestial/moon', 'particle', 'mob_effect'];
  for (const dir of ['block', 'item', ...extraDirs]) {
    const d = path.join(texRoot, dir);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.png')) continue;
      if (dir === 'environment' && !/^(rain|snow)\.png$/.test(f)) continue;
      if (dir === 'entity' && !/^(end_portal|enchanting_table_book|lead_knot)\.png$/.test(f)) continue;
      const png = readPng(path.join(d, f));
      if (png.width > 256 || png.height > 1024) continue;
      const name = `${dir}/${f.slice(0, -4)}`;
      const metaFile = path.join(d, f + '.mcmeta');
      let anim = null;
      if (fs.existsSync(metaFile)) {
        try { anim = JSON.parse(fs.readFileSync(metaFile, 'utf8')).animation ?? null; } catch { anim = null; }
      }
      let w = png.width, h = png.height;
      if (anim) {
        // frames are stacked vertically; frame size is width x width unless specified
        w = anim.width ?? png.width;
        h = anim.height ?? png.width;
      }
      tiles.push({ name, png, w, h, anim });
    }
  }
  // shelf packing: sort by height desc, then width desc
  tiles.sort((a, b) => b.h - a.h || b.w - a.w || a.name.localeCompare(b.name));
  const W = 2048;
  let x = 0, y = 0, shelfH = 0;
  for (const t of tiles) {
    if (x + t.w > W) { x = 0; y += shelfH; shelfH = 0; }
    t.x = x; t.y = y; x += t.w; shelfH = Math.max(shelfH, t.h);
  }
  let H = 1; while (H < y + shelfH) H <<= 1;
  const atlas = new PNG({ width: W, height: H });
  atlas.data.fill(0);
  const blit = (dst, dx, dy, src, sx, sy, w, h) => {
    for (let j = 0; j < h; j++) {
      const so = ((sy + j) * src.width + sx) * 4;
      const do_ = ((dy + j) * dst.width + dx) * 4;
      src.data.copy(dst.data, do_, so, so + w * 4);
    }
  };
  const meta = { width: W, height: H, tiles: {}, animations: [] };
  // animated frames go into a second image
  const animTiles = tiles.filter((t) => t.anim);
  let ax = 0, ay = 0, ashelf = 0;
  const AW = 1024;
  for (const t of animTiles) {
    const frames = Math.floor(t.png.height / t.h) * Math.floor(t.png.width / t.w);
    t.frameCount = frames;
    if (ax + t.w > AW) { ax = 0; ay += ashelf; ashelf = 0; }
    t.ax = ax; t.ay = ay; ax += t.w; ashelf = Math.max(ashelf, t.png.height);
  }
  let AH = 1; while (AH < ay + ashelf) AH <<= 1;
  const animPng = new PNG({ width: AW, height: Math.max(AH, 1) });
  animPng.data.fill(0);
  const alphaClass = (png, w, h) => { // 0 opaque, 1 cutout (only fully transparent pixels), 2 translucent (partial alpha)
    let cls = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const a = png.data[((j * png.width) + i) * 4 + 3];
      if (a === 0) cls = Math.max(cls, 1); else if (a < 255) return 2;
    }
    return cls;
  };
  for (const t of tiles) {
    blit(atlas, t.x, t.y, t.png, 0, 0, t.w, t.h);
    meta.tiles[t.name] = { x: t.x, y: t.y, w: t.w, h: t.h, a: alphaClass(t.png, t.w, t.anim ? t.png.height : t.h) };
    if (t.anim) {
      blit(animPng, t.ax, t.ay, t.png, 0, 0, t.png.width, t.png.height);
      const a = t.anim;
      meta.animations.push({
        name: t.name, x: t.x, y: t.y, w: t.w, h: t.h,
        srcX: t.ax, srcY: t.ay, frameCount: t.frameCount,
        frametime: a.frametime ?? 1, interpolate: !!a.interpolate,
        frames: a.frames ?? null,
      });
    }
  }
  fs.writeFileSync(path.join(OUT, 'bundle', 'atlas.png'), PNG.sync.write(atlas));
  fs.writeFileSync(path.join(OUT, 'bundle', 'anim.png'), PNG.sync.write(animPng));
  fs.writeFileSync(path.join(OUT, 'bundle', 'atlas.json'), JSON.stringify(meta));
  log(`atlas: ${tiles.length} textures packed into ${W}x${H}, ${animTiles.length} animated (anim sheet ${AW}x${animPng.height})`);
}

function writeCredits(version) {
  const credits = `VoxeLand — third-party asset credits
=====================================

VoxeLand's own source code is MIT licensed (see LICENSE). The assets in this folder are
NOT part of that license; they are downloaded at setup time by scripts/fetch-assets.mjs
and are never redistributed with VoxeLand. Each remains the property of its owner:

1. Textures, block/item models, blockstates, fonts, GUI sprites, language files
   ----------------------------------------------------------------------------
   Source : "Default Template Resource Pack (Vanilla Minecraft)" by Truyty on CurseForge
            ${CF_PAGE}
            (file id ${CF_FILE_ID}, "texture-pack-default1.20.5-26.2.zip")
   Content: unmodified vanilla Minecraft: Java Edition ${version.id} client assets.
   Owner  : © Mojang AB / Microsoft. Minecraft is a trademark of Mojang AB.
            Use is subject to the Minecraft Usage Guidelines:
            https://www.minecraft.net/en-us/usage-guidelines
   Location: public/assets/pack/ and the baked bundles in public/assets/bundle/

2. Sounds
   ------
   Source : Mojang's official asset index for Minecraft ${version.id}
            (asset index ${version.assetIndex.id}; https://resources.download.minecraft.net)
   Owner  : © Mojang AB / Microsoft. Subject to the Minecraft Usage Guidelines above.
   Location: public/assets/sounds/

3. Recipes, loot tables, tags, sounds.json
   ---------------------------------------
   Source : data files inside the Minecraft ${version.id} client jar (piston-data.mojang.com)
   Owner  : © Mojang AB / Microsoft.
   Location: public/assets/data/ and public/assets/bundle/data.json

4. Block/item/entity/biome/food metadata
   ------------------------------------
   Source : minecraft-data by PrismarineJS (version pc/${MCDATA_VERSION}, plus pc/1.20 loot tables)
            https://github.com/PrismarineJS/minecraft-data
   License: MIT (see public/assets/mcdata/LICENSE)
   Location: public/assets/mcdata/ and public/assets/bundle/mcdata.json

VoxeLand is not an official Minecraft product. It is not approved by or associated with
Mojang Studios or Microsoft.
`;
  fs.writeFileSync(path.join(OUT, 'CREDITS.txt'), credits);
}

(async () => {
  const t0 = Date.now();
  await fetchPack();
  const version = await fetchVersionJson();
  await fetchJarData(version);
  await fetchMcData();
  await fetchIndexExtras(version);
  buildModelBundle();
  buildDataBundle();
  buildAtlas();
  writeCredits(version);
  await fetchSounds(version);
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ mcVersion: version.id, mcdataVersion: MCDATA_VERSION, packFileId: CF_FILE_ID, builtAt: new Date().toISOString(), music: !NO_MUSIC, sounds: !NO_SOUNDS }));
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch((e) => { console.error(e); process.exit(1); });
