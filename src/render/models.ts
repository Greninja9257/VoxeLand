// Vanilla JSON block-model resolver + baker. Pure (runs in workers and on the main thread).
// Implements: parent inheritance, texture variables, element rotation (+rescale), face UVs
// (explicit, default, rotation), blockstate x/y rotation with uvlock, cullface rotation,
// variants (weighted lists) and multipart (AND/OR conditions).
import type { AtlasMeta, ModelBundle } from '../assets';
import type { BlockRegistry } from '../blocks/registry';
import { DIR_INDEX, DIR_NAMES, DIR_VEC, hash3 } from '../math';

export const LAYER_SOLID = 0, LAYER_CUTOUT = 1, LAYER_TRANSLUCENT = 2;

export interface BakedQuad {
  pos: Float32Array;   // 12 floats: 4 vertices, block-local (0..1, may exceed slightly)
  uv: Float32Array;    // 8 floats: atlas-normalized
  face: number;        // dominant axis direction 0-5 (for shading / AO)
  cull: number;        // -1 or direction 0-5
  tint: number;        // tintindex or -1
  shade: boolean;
  layer: number;
  texture: string;     // atlas tile name (e.g. "block/stone")
  onBoundary: boolean; // lies exactly on the block face plane `face` (full or partial)
  fullFace: boolean;   // covers the entire face
  nx: number; ny: number; nz: number; // normal
}

export interface BakedModel {
  quads: BakedQuad[];
  ao: boolean;
  particle: string;
  /** bitmask of faces fully covered by opaque quads at the boundary (occlusion) */
  occlusion: number;
  /** highest render layer used by any quad */
  layerMask: number;
  guiLight: 'front' | 'side';
  display: Record<string, { rotation?: number[]; translation?: number[]; scale?: number[] }>;
}

interface ResolvedModel {
  textures: Record<string, string | { sprite: string; force_translucent?: boolean }>;
  elements: any[] | null;
  ao: boolean;
  display: Record<string, any>;
  guiLight: 'front' | 'side';
  builtin: string | null; // 'generated' for item/generated chain
}

export interface StateModelChoice { model: BakedModel; weight: number }

const FACE_CORNERS: number[][][] = [
  // [xSel, ySel, zSel] per vertex: 0 = from, 1 = to. Order from vanilla FaceInfo.
  [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]], // down
  [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], // up
  [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]], // north
  [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]], // south
  [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]], // west
  [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]], // east
];

function defaultUv(face: number, from: number[], to: number[]): number[] {
  switch (face) {
    case 0: return [from[0], 16 - to[2], to[0], 16 - from[2]];
    case 1: return [from[0], from[2], to[0], to[2]];
    case 2: return [16 - to[0], 16 - to[1], 16 - from[0], 16 - from[1]];
    case 3: return [from[0], 16 - to[1], to[0], 16 - from[1]];
    case 4: return [from[2], 16 - to[1], to[2], 16 - from[1]];
    default: return [16 - to[2], 16 - to[1], 16 - from[2], 16 - from[1]];
  }
}

function normalizeName(n: string): string {
  n = n.replace(/^minecraft:/, '');
  return n;
}

function rotateVec(v: number[], axis: number, rad: number, out: number[]): void {
  const c = Math.cos(rad), s = Math.sin(rad);
  const [x, y, z] = v;
  if (axis === 0) { out[0] = x; out[1] = y * c - z * s; out[2] = y * s + z * c; }
  else if (axis === 1) { out[0] = x * c + z * s; out[1] = y; out[2] = -x * s + z * c; }
  else { out[0] = x * c - y * s; out[1] = x * s + y * c; out[2] = z; }
}

function dirFromNormal(nx: number, ny: number, nz: number): number {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ay >= ax && ay >= az) return ny > 0 ? 1 : 0;
  if (az >= ax) return nz > 0 ? 3 : 2;
  return nx > 0 ? 5 : 4;
}

function rotateDir(dir: number, xRot: number, yRot: number): number {
  if (dir < 0) return dir;
  const v = DIR_VEC[dir].slice();
  const o = [0, 0, 0];
  rotateVec(v, 0, -xRot * Math.PI / 180, o);
  rotateVec(o, 1, -yRot * Math.PI / 180, v);
  return dirFromNormal(v[0], v[1], v[2]);
}

export class ModelBaker {
  private resolved = new Map<string, ResolvedModel | null>();
  private baked = new Map<string, BakedModel>();
  private stateModels: (StateModelChoice[][] | null | undefined)[] = [];
  private missingTile: { u0: number; v0: number; u1: number; v1: number; a: number };
  readonly tileUv = new Map<string, { u0: number; v0: number; u1: number; v1: number; a: number }>();

  constructor(public bundle: ModelBundle, public atlas: AtlasMeta, public registry: BlockRegistry) {
    const W = atlas.width, H = atlas.height;
    for (const [name, t] of Object.entries(atlas.tiles)) {
      this.tileUv.set(name, { u0: t.x / W, v0: t.y / H, u1: (t.x + t.w) / W, v1: (t.y + t.h) / H, a: (t as any).a ?? 0 });
    }
    this.missingTile = this.tileUv.get('block/debug') ?? this.tileUv.get('block/stone') ?? { u0: 0, v0: 0, u1: 0, v1: 0, a: 0 };
    this.stateModels = new Array(registry.stateCount);
  }

  // ---------- resolution ----------
  resolve(name: string): ResolvedModel | null {
    name = normalizeName(name);
    if (this.resolved.has(name)) return this.resolved.get(name)!;
    this.resolved.set(name, null); // cycle guard
    if (name === 'builtin/generated' || name === 'builtin/entity' || name === 'builtin/missing') {
      const r: ResolvedModel = { textures: {}, elements: null, ao: true, display: {}, guiLight: 'side', builtin: name.slice(8) };
      this.resolved.set(name, r);
      return r;
    }
    const json = this.bundle.models[name];
    if (!json) { return null; }
    let parent: ResolvedModel | null = null;
    if (json.parent) parent = this.resolve(json.parent);
    const r: ResolvedModel = {
      textures: { ...(parent?.textures ?? {}), ...(json.textures ?? {}) },
      elements: json.elements ?? parent?.elements ?? null,
      ao: json.ambientocclusion ?? parent?.ao ?? true,
      display: { ...(parent?.display ?? {}), ...(json.display ?? {}) },
      guiLight: json.gui_light ?? parent?.guiLight ?? 'side',
      builtin: parent?.builtin ?? null,
    };
    this.resolved.set(name, r);
    return r;
  }

  resolveTexture(model: ResolvedModel, ref: string): string { return this.resolveTextureInfo(model, ref).name; }
  /** Texture references are strings or (26.x) objects { sprite, force_translucent }. */
  resolveTextureInfo(model: ResolvedModel, ref: string | { sprite: string; force_translucent?: boolean }): { name: string; translucent: boolean } {
    let guard = 0, translucent = false;
    for (;;) {
      if (typeof ref === 'object' && ref) { translucent = translucent || !!ref.force_translucent; ref = ref.sprite ?? '#missing'; }
      if (typeof ref !== 'string') return { name: 'missing', translucent };
      if (!ref.startsWith('#') || guard++ >= 16) break;
      const next = model.textures[ref.slice(1)];
      if (next === undefined) return { name: 'missing', translucent };
      ref = next;
    }
    return { name: normalizeName(ref), translucent };
  }

  // ---------- baking ----------
  bake(name: string, xRot = 0, yRot = 0, uvlock = false): BakedModel {
    const key = `${name}|${xRot}|${yRot}|${uvlock ? 1 : 0}`;
    let b = this.baked.get(key);
    if (b) return b;
    b = this.bakeUncached(name, xRot, yRot, uvlock);
    this.baked.set(key, b);
    return b;
  }

  private bakeUncached(name: string, xRot: number, yRot: number, uvlock: boolean): BakedModel {
    const model = this.resolve(name);
    const quads: BakedQuad[] = [];
    let particle = 'block/stone';
    let ao = true, guiLight: 'front' | 'side' = 'side', display: Record<string, any> = {};
    if (model) {
      ao = model.ao; guiLight = model.guiLight; display = model.display;
      particle = this.resolveTexture(model, '#particle');
      if (particle === 'missing') particle = 'block/stone';
      if (model.elements) for (const el of model.elements) this.bakeElement(model, el, xRot, yRot, uvlock, quads);
    }
    let occlusion = 0, layerMask = 0;
    for (const q of quads) {
      layerMask |= 1 << q.layer;
      if (q.fullFace && q.layer === LAYER_SOLID) occlusion |= 1 << q.face;
    }
    return { quads, ao, particle, occlusion, layerMask, guiLight, display };
  }

  private bakeElement(model: ResolvedModel, el: any, xRot: number, yRot: number, uvlock: boolean, out: BakedQuad[]): void {
    const from: number[] = el.from, to: number[] = el.to;
    const rot = el.rotation;
    const shade = el.shade !== false;
    const xr = -xRot * Math.PI / 180, yr = -yRot * Math.PI / 180;
    let ax = -1, angle = 0, origin = [8, 8, 8], rescale = false;
    if (rot) {
      ax = rot.axis === 'x' ? 0 : rot.axis === 'y' ? 1 : 2; angle = (rot.angle ?? 0) * Math.PI / 180; origin = rot.origin ?? [8, 8, 8]; rescale = !!rot.rescale;
    }
    let rs = 1;
    if (rescale && angle !== 0) rs = 1 / Math.cos(angle);

    for (const faceName of DIR_NAMES) {
      const f = el.faces?.[faceName];
      if (!f) continue;
      const face = DIR_INDEX[faceName];
      const texInfo = this.resolveTextureInfo(model, f.texture ?? '#missing');
      const tex = texInfo.name;
      const tile = this.tileUv.get(tex) ?? this.missingTile;
      let uv: number[] = f.uv ?? defaultUv(face, from, to);
      const uvRot = ((f.rotation ?? 0) / 90) | 0;
      const corners = FACE_CORNERS[face];
      const pos = new Float32Array(12);
      const tmp = [0, 0, 0], tmp2 = [0, 0, 0];
      for (let i = 0; i < 4; i++) {
        const c = corners[i];
        let x = c[0] ? to[0] : from[0], y = c[1] ? to[1] : from[1], z = c[2] ? to[2] : from[2];
        if (rot && angle !== 0) {
          tmp[0] = x - origin[0]; tmp[1] = y - origin[1]; tmp[2] = z - origin[2];
          rotateVec(tmp, ax, angle, tmp2);
          if (rescale) { if (ax !== 0) tmp2[0] *= rs; if (ax !== 1) tmp2[1] *= rs; if (ax !== 2) tmp2[2] *= rs; }
          x = tmp2[0] + origin[0]; y = tmp2[1] + origin[1]; z = tmp2[2] + origin[2];
        }
        // block-state rotation around block center
        if (xRot || yRot) {
          tmp[0] = x - 8; tmp[1] = y - 8; tmp[2] = z - 8;
          rotateVec(tmp, 0, xr, tmp2);
          rotateVec(tmp2, 1, yr, tmp);
          x = tmp[0] + 8; y = tmp[1] + 8; z = tmp[2] + 8;
        }
        pos[i * 3] = x / 16; pos[i * 3 + 1] = y / 16; pos[i * 3 + 2] = z / 16;
      }
      // normal
      const e1x = pos[3] - pos[0], e1y = pos[4] - pos[1], e1z = pos[5] - pos[2];
      const e2x = pos[6] - pos[0], e2y = pos[7] - pos[1], e2z = pos[8] - pos[2];
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      // Degenerate (zero-area) faces still need a facing: rotate the original.
      const outFace = nl < 1e-6 ? rotateDir(face, xRot, yRot) : dirFromNormal(nx, ny, nz);
      if (nl < 1e-6) { const v = DIR_VEC[outFace]; nx = v[0]; ny = v[1]; nz = v[2]; }
      const flat = (from[0] === to[0]) || (from[1] === to[1]) || (from[2] === to[2]);

      // UVs
      const uvs = new Float32Array(8);
      let order = [0, 1, 2, 3];
      if (uvlock && (xRot || yRot)) {
        // Re-associate corners with the rotated face's canonical order so the texture stays world-locked.
        order = this.uvlockOrder(pos, outFace);
      }
      for (let i = 0; i < 4; i++) {
        const k = (order[i] + uvRot) & 3;
        const u = uv[k !== 0 && k !== 1 ? 2 : 0];
        const v = uv[k !== 0 && k !== 3 ? 3 : 1];
        uvs[i * 2] = tile.u0 + (tile.u1 - tile.u0) * (u / 16);
        uvs[i * 2 + 1] = tile.v0 + (tile.v1 - tile.v0) * (v / 16);
      }
      const cull = f.cullface ? rotateDir(DIR_INDEX[f.cullface] ?? -1, xRot, yRot) : -1;
      // boundary / full-face detection (after rotation)
      const axis = outFace >> 1; // 0 y,1 z,2 x  => coordinate index: y=1, z=2, x=0
      const ci = axis === 0 ? 1 : axis === 1 ? 2 : 0;
      const plane = outFace & 1 ? 1 : 0;
      let onBoundary = true, minA = 1, maxA = 0, minB = 1, maxB = 0;
      const ai = ci === 0 ? 1 : 0, bi = ci === 2 ? 1 : 2;
      for (let i = 0; i < 4; i++) {
        if (Math.abs(pos[i * 3 + ci] - plane) > 1e-4) onBoundary = false;
        const a = pos[i * 3 + ai], b = pos[i * 3 + bi];
        minA = Math.min(minA, a); maxA = Math.max(maxA, a); minB = Math.min(minB, b); maxB = Math.max(maxB, b);
      }
      const fullFace = onBoundary && minA <= 1e-4 && maxA >= 1 - 1e-4 && minB <= 1e-4 && maxB >= 1 - 1e-4 && !flat;
      const layer = tile.a === 2 || texInfo.translucent ? LAYER_TRANSLUCENT : tile.a === 1 ? LAYER_CUTOUT : LAYER_SOLID;
      out.push({ pos, uv: uvs, face: outFace, cull, tint: f.tintindex ?? -1, shade, layer, texture: tex, onBoundary, fullFace, nx, ny, nz });
    }
  }

  /** For uvlock: find for each canonical corner (of the rotated facing) which rotated vertex sits there. */
  private uvlockOrder(pos: Float32Array, face: number): number[] {
    const corners = FACE_CORNERS[face];
    let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
    for (let i = 0; i < 4; i++) {
      minX = Math.min(minX, pos[i * 3]); maxX = Math.max(maxX, pos[i * 3]);
      minY = Math.min(minY, pos[i * 3 + 1]); maxY = Math.max(maxY, pos[i * 3 + 1]);
      minZ = Math.min(minZ, pos[i * 3 + 2]); maxZ = Math.max(maxZ, pos[i * 3 + 2]);
    }
    // order[i] = canonical uv index for vertex i
    const order = [0, 1, 2, 3];
    for (let i = 0; i < 4; i++) {
      let best = 0, bestD = 1e9;
      for (let k = 0; k < 4; k++) {
        const c = corners[k];
        const cx = c[0] ? maxX : minX, cy = c[1] ? maxY : minY, cz = c[2] ? maxZ : minZ;
        const d = (pos[i * 3] - cx) ** 2 + (pos[i * 3 + 1] - cy) ** 2 + (pos[i * 3 + 2] - cz) ** 2;
        if (d < bestD) { bestD = d; best = k; }
      }
      order[i] = best;
    }
    return order;
  }

  // ---------- blockstates ----------
  /** All model parts for a state. Each part is a weighted list (pick one by position hash). */
  stateParts(state: number): StateModelChoice[][] {
    let cached = this.stateModels[state];
    if (cached !== undefined) return cached ?? EMPTY_PARTS;
    const block = this.registry.block(state);
    const props = this.registry.getProps(state);
    const bs = this.bundle.blockstates[block.name];
    const parts: StateModelChoice[][] = [];
    if (bs) {
      if (bs.variants) {
        let chosen: any = undefined;
        for (const [key, val] of Object.entries(bs.variants)) {
          if (matchVariantKey(key, props)) { chosen = val; break; }
        }
        if (chosen === undefined) chosen = bs.variants[''] ?? bs.variants['normal'] ?? Object.values(bs.variants)[0];
        if (chosen) parts.push(this.applyList(chosen));
      } else if (bs.multipart) {
        for (const part of bs.multipart) {
          if (!part.when || matchCondition(part.when, props)) parts.push(this.applyList(part.apply));
        }
      }
    }
    const result = parts.length ? parts : null;
    this.stateModels[state] = result;
    return result ?? EMPTY_PARTS;
  }

  private applyList(apply: any): StateModelChoice[] {
    const list = Array.isArray(apply) ? apply : [apply];
    return list.map((a: any) => ({ model: this.bake(a.model ?? 'block/stone', a.x ?? 0, a.y ?? 0, !!a.uvlock), weight: a.weight ?? 1 }));
  }

  /** Pick concrete models for a state at a world position (resolves weighted random variants). */
  modelsAt(state: number, x: number, y: number, z: number, out: BakedModel[] = []): BakedModel[] {
    const parts = this.stateParts(state);
    out.length = 0;
    for (let i = 0; i < parts.length; i++) {
      const list = parts[i];
      if (list.length === 1) { out.push(list[0].model); continue; }
      let total = 0;
      for (const c of list) total += c.weight;
      let r = (hash3(x, y, z, 7 + i) % 1000) / 1000 * total;
      let pick = list[list.length - 1].model;
      for (const c of list) { r -= c.weight; if (r < 0) { pick = c.model; break; } }
      out.push(pick);
    }
    return out;
  }

  /** First model of a state, for item rendering etc. */
  firstModel(state: number): BakedModel | null {
    const parts = this.stateParts(state);
    return parts.length ? parts[0][0].model : null;
  }

  /** Occlusion mask for a state (union over all parts using first variant). */
  occlusionOf(state: number): number {
    const parts = this.stateParts(state);
    let m = 0;
    for (const p of parts) m |= p[0].model.occlusion;
    return m;
  }
}

const EMPTY_PARTS: StateModelChoice[][] = [];

function matchVariantKey(key: string, props: Readonly<Record<string, string>>): boolean {
  if (key === '' || key === 'normal') return true;
  for (const kv of key.split(',')) {
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    const k = kv.slice(0, eq), v = kv.slice(eq + 1);
    if (props[k] !== v) return false;
  }
  return true;
}

function matchCondition(when: any, props: Readonly<Record<string, string>>): boolean {
  if (Array.isArray(when.OR)) return when.OR.some((c: any) => matchCondition(c, props));
  if (Array.isArray(when.AND)) return when.AND.every((c: any) => matchCondition(c, props));
  for (const [k, v] of Object.entries(when)) {
    const allowed = String(v).split('|');
    if (!allowed.includes(props[k] ?? '')) return false;
  }
  return true;
}
