// Jigsaw structure assembly: a port of vanilla JigsawPlacement over the client's NBT templates, template pools
// and processor lists (data/minecraft/structure, worldgen/template_pool, worldgen/processor_list). Villages,
// outposts, bastions, trail ruins… are all built this way in vanilla; VoxeLand currently uses it for villages.
import type { BlockRegistry } from '../../blocks/registry';
import { Random } from '../../math';
import { rotateY, oppositeFacing } from '../../blocks/placement';
import { hashSeed } from './noise';

export interface TemplateData {
  size: [number, number, number];
  palette: { name: string; props: Record<string, string> }[];
  /** flat [paletteIndex, x, y, z, …] */
  blocks: number[];
  /** block NBT keyed by block index (jigsaws, chests with loot tables, signs…) */
  nbts: Record<string, any>;
  entities: { pos: number[]; nbt: any }[];
}
export interface PoolElement { element_type: string; location?: string; feature?: string; processors?: string | { processors: any[] }; projection?: string; elements?: PoolElement[] }
export interface TemplatePool { elements: { element: PoolElement; weight: number }[]; fallback: string }
export interface StructureBundle {
  templates: Record<string, TemplateData>;
  pools: Record<string, TemplatePool>;
  processors: Record<string, { processors: any[] }>;
  structures: Record<string, any>;
  structureSets: Record<string, any>;
  blockTags: Record<string, { values: (string | { id: string })[] }>;
}

export type Box = [number, number, number, number, number, number]; // inclusive min/max

export interface Jigsaw { x: number; y: number; z: number; front: string; top: string; name: string; target: string; pool: string; joint: string; finalState: string }

export interface JigsawPiece {
  element: PoolElement;
  template: TemplateData | null;
  /** world position of template-local (0,0,0) */
  x: number; y: number; z: number;
  /** 0 none, 1 clockwise 90, 2 180, 3 counter-clockwise 90 (vanilla Rotation order) */
  rot: number;
  box: Box;
  rigid: boolean;
  legacy: boolean;
  groundLevelDelta: number;
  depth: number;
  processors: any[];
  innerClaimed: Box[];
}

export interface JigsawContext {
  bundle: StructureBundle;
  reg: BlockRegistry;
  /** WORLD_SURFACE_WG: y of the first air block above the terrain (water counts as terrain) */
  surfaceY(x: number, z: number): number;
}

const key = (s: string) => s.replace(/^minecraft:/, '');

// ---------- rotation helpers (vanilla StructureTemplate.transform) ----------
export function rotPos(x: number, z: number, rot: number): [number, number] {
  switch (rot & 3) { case 1: return [-z, x]; case 2: return [-x, -z]; case 3: return [z, -x]; default: return [x, z]; }
}
export function rotVec(x: number, z: number, rot: number): [number, number] {
  switch (rot & 3) { case 1: return [1 - z, x]; case 2: return [1 - x, 1 - z]; case 3: return [z, 1 - x]; default: return [x, z]; }
}
export function rotDir(d: string, rot: number): string { for (let i = 0; i < (rot & 3); i++) d = rotateY(d); return d; }
const HORIZ = new Set(['north', 'south', 'east', 'west']);
const RAIL_ROT: Record<string, string> = { north_south: 'east_west', east_west: 'north_south', ascending_east: 'ascending_south', ascending_south: 'ascending_west', ascending_west: 'ascending_north', ascending_north: 'ascending_east', south_east: 'south_west', south_west: 'north_west', north_west: 'north_east', north_east: 'south_east' };

/** Rotate a block's property map (vanilla BlockState.rotate). */
export function rotateProps(props: Record<string, string>, rot: number): Record<string, string> {
  rot &= 3;
  if (!rot) return props;
  const out: Record<string, string> = { ...props };
  if (props.facing && HORIZ.has(props.facing)) out.facing = rotDir(props.facing, rot);
  if (props.axis && rot & 1) out.axis = props.axis === 'x' ? 'z' : props.axis === 'z' ? 'x' : props.axis;
  if (props.rotation !== undefined) out.rotation = String((parseInt(props.rotation) + rot * 4) & 15);
  if (props.shape && RAIL_ROT[props.shape]) { let s = props.shape; for (let i = 0; i < rot; i++) s = RAIL_ROT[s]; out.shape = s; }
  if (props.north !== undefined && props.south !== undefined) for (const d of HORIZ) out[rotDir(d, rot)] = props[d];
  if (props.orientation) { const [f, t] = props.orientation.split('_'); out.orientation = (HORIZ.has(f) ? rotDir(f, rot) : f) + '_' + (HORIZ.has(t) ? rotDir(t, rot) : t); }
  return out;
}

export function templateBox(t: TemplateData, x: number, y: number, z: number, rot: number): Box {
  const [ax, az] = rotPos(0, 0, rot), [bx, bz] = rotPos(t.size[0] - 1, t.size[2] - 1, rot);
  return [x + Math.min(ax, bx), y, z + Math.min(az, bz), x + Math.max(ax, bx), y + t.size[1] - 1, z + Math.max(az, bz)];
}

export function boxIntersects(a: Box, b: Box): boolean { return a[0] <= b[3] && a[3] >= b[0] && a[1] <= b[4] && a[4] >= b[1] && a[2] <= b[5] && a[5] >= b[2]; }
export function boxContains(a: Box, x: number, y: number, z: number): boolean { return x >= a[0] && x <= a[3] && y >= a[1] && y <= a[4] && z >= a[2] && z <= a[5]; }
function boxInside(inner: Box, outer: Box): boolean { return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] >= outer[2] && inner[3] <= outer[3] && inner[4] <= outer[4] && inner[5] <= outer[5]; }

/** Parse "minecraft:oak_stairs[facing=east,half=bottom]" */
export function parseBlockString(s: string): { name: string; props: Record<string, string> } {
  const m = /^([^[]+)(?:\[(.*)\])?$/.exec(s.trim());
  const props: Record<string, string> = {};
  if (m && m[2]) for (const kv of m[2].split(',')) { const [k, v] = kv.split('='); if (k && v !== undefined) props[k.trim()] = v.trim(); }
  return { name: key(m ? m[1] : s), props };
}

const tagCache = new Map<string, Set<string>>();
/** Resolved block tag (nested #tags expanded). */
export function blockTag(bundle: StructureBundle, tag: string): Set<string> {
  let s = tagCache.get(tag);
  if (s) return s;
  s = new Set(); tagCache.set(tag, s);
  for (const v of bundle.blockTags[tag]?.values ?? []) {
    const id = typeof v === 'string' ? v : v.id;
    if (id.startsWith('#')) for (const n of blockTag(bundle, key(id.slice(1)))) s.add(n); else s.add(key(id));
  }
  return s;
}

// ---------- templates ----------
const jigsawCache = new WeakMap<TemplateData, Jigsaw[]>();
export function templateJigsaws(t: TemplateData): Jigsaw[] {
  let list = jigsawCache.get(t);
  if (list) return list;
  list = [];
  for (const [i, nbt] of Object.entries(t.nbts)) {
    if (nbt.id !== 'minecraft:jigsaw') continue;
    const bi = +i * 4;
    const [front, top] = (t.palette[t.blocks[bi]].props.orientation ?? 'north_up').split('_');
    list.push({ x: t.blocks[bi + 1], y: t.blocks[bi + 2], z: t.blocks[bi + 3], front, top, name: key(nbt.name ?? 'minecraft:empty'), target: key(nbt.target ?? 'minecraft:empty'), pool: key(nbt.pool ?? 'minecraft:empty'), joint: nbt.joint ?? 'rollable', finalState: nbt.final_state ?? 'minecraft:air' });
  }
  jigsawCache.set(t, list);
  return list;
}

/** Jigsaws of a piece in world space (position + rotated front/top). */
function pieceJigsaws(p: JigsawPiece, rnd: Random): Jigsaw[] {
  const out: Jigsaw[] = [];
  if (p.template) {
    for (const j of templateJigsaws(p.template)) {
      const [rx, rz] = rotPos(j.x, j.z, p.rot);
      out.push({ ...j, x: p.x + rx, y: p.y + j.y, z: p.z + rz, front: HORIZ.has(j.front) ? rotDir(j.front, p.rot) : j.front, top: HORIZ.has(j.top) ? rotDir(j.top, p.rot) : j.top });
    }
  } else if (p.element.element_type === 'minecraft:feature_pool_element') {
    // vanilla FeaturePoolElement: a single synthetic "bottom" jigsaw facing down
    out.push({ x: p.x, y: p.y, z: p.z, front: 'down', top: 'south', name: 'bottom', target: 'empty', pool: 'empty', joint: 'rollable', finalState: 'minecraft:air' });
  }
  shuffle(out, rnd);
  return out;
}

function elementJigsaws(ctx: JigsawContext, e: PoolElement, rot: number, rnd: Random): Jigsaw[] {
  const t = elementTemplate(ctx, e);
  const p: JigsawPiece = { element: e, template: t, x: 0, y: 0, z: 0, rot, box: [0, 0, 0, 0, 0, 0], rigid: true, legacy: false, groundLevelDelta: 1, depth: 0, processors: [], innerClaimed: [] };
  return pieceJigsaws(p, rnd);
}

export function elementTemplate(ctx: JigsawContext, e: PoolElement): TemplateData | null {
  if (e.element_type === 'minecraft:single_pool_element' || e.element_type === 'minecraft:legacy_single_pool_element') return ctx.bundle.templates[key(e.location!)] ?? null;
  if (e.element_type === 'minecraft:list_pool_element' && e.elements?.length) return elementTemplate(ctx, e.elements[0]);
  return null;
}
function elementBox(ctx: JigsawContext, e: PoolElement, x: number, y: number, z: number, rot: number): Box {
  const t = elementTemplate(ctx, e);
  return t ? templateBox(t, x, y, z, rot) : [x, y, z, x, y, z];
}
function elementProcessors(ctx: JigsawContext, e: PoolElement): any[] {
  const p = e.processors;
  if (!p) return [];
  if (typeof p === 'string') return ctx.bundle.processors[key(p)]?.processors ?? [];
  return p.processors ?? [];
}

function shuffle<T>(a: T[], rnd: Random): T[] { for (let i = a.length - 1; i > 0; i--) { const j = rnd.nextInt(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

/** StructureTemplatePool.getShuffledTemplates: each element repeated `weight` times, shuffled, first occurrences kept. */
function shuffledTemplates(pool: TemplatePool | undefined, rnd: Random): PoolElement[] {
  if (!pool) return [];
  const list: PoolElement[] = [];
  for (const e of pool.elements) for (let i = 0; i < Math.max(1, e.weight); i++) list.push(e.element);
  shuffle(list, rnd);
  const seen = new Set<PoolElement>(), out: PoolElement[] = [];
  for (const e of list) if (!seen.has(e)) { seen.add(e); out.push(e); }
  return out;
}
function randomTemplate(pool: TemplatePool, rnd: Random): PoolElement | null {
  let total = 0; for (const e of pool.elements) total += e.weight;
  if (!total) return null;
  let r = rnd.nextInt(total);
  for (const e of pool.elements) { r -= e.weight; if (r < 0) return e.element; }
  return pool.elements[pool.elements.length - 1].element;
}

/** JigsawBlock.canAttach */
function canAttach(a: Jigsaw, b: Jigsaw): boolean {
  return a.front === oppositeFacing(b.front) && (a.joint === 'rollable' || a.top === b.top) && a.target === b.name;
}

const poolHeightCache = new Map<string, number>();
/** Tallest template in a pool (+ its fallback) — the "expansion hack" reserves this much room above pieces whose jigsaws point inside. */
function poolMaxHeight(ctx: JigsawContext, poolName: string, depth = 0): number {
  const c = poolHeightCache.get(poolName);
  if (c !== undefined) return c;
  const pool = ctx.bundle.pools[poolName];
  let h = 0;
  if (pool) {
    for (const e of pool.elements) { const t = elementTemplate(ctx, e.element); h = Math.max(h, t ? t.size[1] : 1); }
    if (depth < 4 && pool.fallback && key(pool.fallback) !== poolName) h = Math.max(h, poolMaxHeight(ctx, key(pool.fallback), depth + 1));
  }
  poolHeightCache.set(poolName, h);
  return h;
}

export interface JigsawOptions { startPool: string; maxDepth: number; useExpansionHack: boolean; maxDistanceFromCenter: number; projectStartToHeightmap: boolean; startY: number }

/** JigsawPlacement.addPieces: assemble the pieces of one structure start at chunk corner (x, z). */
export function assembleJigsaw(ctx: JigsawContext, o: JigsawOptions, x: number, z: number, rnd: Random): JigsawPiece[] {
  const startPool = ctx.bundle.pools[key(o.startPool)];
  if (!startPool) return [];
  const rot = rnd.nextInt(4);
  const startEl = randomTemplate(startPool, rnd);
  if (!startEl || startEl.element_type === 'minecraft:empty_pool_element') return [];
  const start = makePiece(ctx, startEl, x, o.startY, z, rot, 0);
  const cx = (start.box[0] + start.box[3]) >> 1, cz = (start.box[2] + start.box[5]) >> 1;
  const y = o.projectStartToHeightmap ? o.startY + ctx.surfaceY(cx, cz) : o.startY;
  movePiece(start, y - (start.box[1] + start.groundLevelDelta));
  const pieces = [start];
  if (o.maxDepth <= 0) return pieces;
  const d = o.maxDistanceFromCenter;
  const allowed: Box = [cx - d, y - d, cz - d, cx + d, y + d, cz + d];
  const claimed: Box[] = [start.box];
  const queue: JigsawPiece[] = [start];
  while (queue.length) {
    const piece = queue.shift()!;
    tryPlacingChildren(ctx, o, piece, allowed, claimed, pieces, queue, rnd);
  }
  return pieces;
}

function makePiece(ctx: JigsawContext, e: PoolElement, x: number, y: number, z: number, rot: number, depth: number, box?: Box): JigsawPiece {
  const t = elementTemplate(ctx, e);
  return { element: e, template: t, x, y, z, rot, box: box ?? elementBox(ctx, e, x, y, z, rot), rigid: (e.projection ?? 'rigid') === 'rigid', legacy: e.element_type === 'minecraft:legacy_single_pool_element', groundLevelDelta: 1, depth, processors: elementProcessors(ctx, e), innerClaimed: [] };
}
function movePiece(p: JigsawPiece, dy: number): void { p.y += dy; p.box[1] += dy; p.box[4] += dy; }

/** JigsawPlacement.Placer.tryPlacingChildren */
function tryPlacingChildren(ctx: JigsawContext, o: JigsawOptions, piece: JigsawPiece, allowed: Box, claimed: Box[], pieces: JigsawPiece[], queue: JigsawPiece[], rnd: Random): void {
  const minY = piece.box[1];
  const rigid = piece.rigid;
  outer: for (const j of pieceJigsaws(piece, rnd)) {
    const step = j.front === 'up' ? 1 : j.front === 'down' ? -1 : 0;
    const tx = j.x + (j.front === 'east' ? 1 : j.front === 'west' ? -1 : 0), ty = j.y + step, tz = j.z + (j.front === 'south' ? 1 : j.front === 'north' ? -1 : 0);
    const jy = j.y - minY;
    let surface = -1;
    const pool = ctx.bundle.pools[j.pool];
    if (!pool) continue;
    const fallback = ctx.bundle.pools[key(pool.fallback ?? 'minecraft:empty')];
    // a jigsaw pointing into its own piece places the child inside it (houses and decor on the wide street templates);
    // otherwise into the shared free space
    const inside = boxContains(piece.box, tx, ty, tz);
    const candidates: PoolElement[] = [];
    if (piece.depth !== o.maxDepth) candidates.push(...shuffledTemplates(pool, rnd));
    candidates.push(...shuffledTemplates(fallback, rnd));
    for (const cand of candidates) {
      if (cand.element_type === 'minecraft:empty_pool_element') break;
      const rots = shuffle([0, 1, 2, 3], rnd);
      for (const rot of rots) {
        const cjigsaws = elementJigsaws(ctx, cand, rot, rnd);
        const cbox0 = elementBox(ctx, cand, 0, 0, 0, rot);
        let expand = 0;
        if (o.useExpansionHack && cbox0[4] - cbox0[1] + 1 <= 16) {
          for (const cj of cjigsaws) {
            const ox = cj.x + (cj.front === 'east' ? 1 : cj.front === 'west' ? -1 : 0), oy = cj.y + (cj.front === 'up' ? 1 : cj.front === 'down' ? -1 : 0), oz = cj.z + (cj.front === 'south' ? 1 : cj.front === 'north' ? -1 : 0);
            if (!boxContains(cbox0, ox, oy, oz)) continue;
            expand = Math.max(expand, poolMaxHeight(ctx, cj.pool));
          }
        }
        for (const cj of cjigsaws) {
          if (!canAttach(j, cj)) continue;
          const ox = tx - cj.x, oy = ty - cj.y, oz = tz - cj.z;
          const cbox = elementBox(ctx, cand, ox, oy, oz, rot);
          const crigid = (cand.projection ?? 'rigid') === 'rigid';
          const j1 = cj.y;
          const k1 = jy - j1 + step;
          let l1: number;
          if (rigid && crigid) l1 = minY + k1;
          else { if (surface === -1) surface = ctx.surfaceY(j.x, j.z); l1 = surface - j1; }
          const dy = l1 - cbox[1];
          const box: Box = [cbox[0], cbox[1] + dy, cbox[2], cbox[3], cbox[4] + dy, cbox[5]];
          if (expand > 0) box[4] = Math.max(box[4], box[1] + Math.max(expand + 1, box[4] - box[1]));
          // free-space test (vanilla: candidate box deflated by 0.25 must lie entirely inside the free shape)
          if (inside) { if (!boxInside(box, piece.box) || piece.innerClaimed.some((b) => boxIntersects(b, box))) continue; }
          else { if (!boxInside(box, allowed) || claimed.some((b) => boxIntersects(b, box))) continue; }
          if (inside) piece.innerClaimed.push(box); else claimed.push(box);
          const child = makePiece(ctx, cand, ox, oy + dy, oz, rot, piece.depth + 1, box);
          child.groundLevelDelta = crigid ? piece.groundLevelDelta - k1 : 1;
          pieces.push(child);
          if (piece.depth + 1 <= o.maxDepth) queue.push(child);
          continue outer;
        }
      }
    }
  }
}

// ---------- placing a piece's blocks ----------
export interface PlacedBlock { x: number; y: number; z: number; state: number; nbt?: any }

/** Resolve one template block through rotation and the piece's processors. `worldAt` reads the existing block
 *  (structure blocks placed so far, then terrain) for location predicates. Returns null when nothing is placed. */
export function processBlock(ctx: JigsawContext, piece: JigsawPiece, name: string, props: Record<string, string>, wx: number, wy: number, wz: number, worldAt: (x: number, y: number, z: number) => number, seed: number): number | null {
  const reg = ctx.reg;
  if (name === 'structure_void' || name === 'structure_block') return null;
  if (name === 'jigsaw') return null; // replaced by its final_state by the caller
  if (piece.legacy && name === 'air') return null;
  let cur = { name, props: rotateProps(props, piece.rot) };
  let rnd: Random | null = null;
  const random = () => (rnd ??= new Random(hashSeed(seed, wx, wz, wy))).next();
  for (const proc of piece.processors) {
    if (proc.processor_type !== 'minecraft:rule') continue;
    for (const rule of proc.rules ?? []) {
      if (!matchPredicate(ctx, rule.input_predicate, cur.name, cur.props, random)) continue;
      if (rule.location_predicate && rule.location_predicate.predicate_type !== 'minecraft:always_true') {
        const ws = worldAt(wx, wy, wz);
        const wb = ws < 0 ? null : reg.block(ws);
        if (!wb || !matchPredicate(ctx, rule.location_predicate, wb.name, reg.getProps(ws), random)) continue;
      }
      const out = rule.output_state;
      cur = { name: key(out.Name), props: out.Properties ?? {} };
      break;
    }
  }
  if (cur.name === 'air' && piece.legacy) return null;
  const b = reg.blockByName(cur.name);
  if (!b) return null;
  return reg.stateWith(b, cur.props);
}

function matchPredicate(ctx: JigsawContext, p: any, name: string, props: Readonly<Record<string, string>>, random: () => number): boolean {
  switch (key(p.predicate_type)) {
    case 'always_true': return true;
    case 'block_match': return key(p.block) === name;
    case 'random_block_match': return key(p.block) === name && random() < p.probability;
    case 'blockstate_match': { const bs = p.block_state; if (key(bs.Name) !== name) return false; for (const [k, v] of Object.entries(bs.Properties ?? {})) if (props[k] !== v) return false; return true; }
    case 'random_blockstate_match': { const bs = p.block_state; if (key(bs.Name) !== name) return false; for (const [k, v] of Object.entries(bs.Properties ?? {})) if (props[k] !== v) return false; return random() < p.probability; }
    case 'tag_match': return blockTag(ctx.bundle, key(p.tag)).has(name);
    default: return false;
  }
}
