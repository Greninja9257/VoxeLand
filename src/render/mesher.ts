// Section mesher: turns an 18^3 padded block/light array into vertex buffers (solid / cutout / translucent).
// Vertex layout (20 bytes): x,y,z f32 | u,v u16n | r,g,b u8 | light u8 (sky<<4 | block)
import type { BlockRegistry } from '../blocks/registry';
import { ModelBaker, LAYER_CUTOUT, LAYER_SOLID, LAYER_TRANSLUCENT, type BakedModel, type BakedQuad } from './models';
import { DIR_VEC } from '../math';

export const VERTEX_STRIDE = 20;
export const PAD = 18;
export const P2 = PAD * PAD;
export const pidx = (x: number, y: number, z: number): number => ((y + 1) * P2) + ((z + 1) * PAD) + (x + 1);

export interface MeshInput {
  cx: number; sy: number; cz: number;
  blocks: Uint16Array;  // 18^3
  light: Uint8Array;    // 18^3
  tints: Uint8Array;    // 16*16*12 : grass rgb, foliage rgb, water rgb, dry rgb per column
}

export interface LayerMesh { data: ArrayBuffer; quads: number }
export interface MeshOutput { cx: number; sy: number; cz: number; layers: (LayerMesh | null)[]; time: number }

class VertexWriter {
  buf = new ArrayBuffer(1 << 16);
  f32 = new Float32Array(this.buf);
  u16 = new Uint16Array(this.buf);
  u8 = new Uint8Array(this.buf);
  count = 0; // vertices
  reset(): void { this.count = 0; }
  ensure(n: number): void {
    const need = (this.count + n) * VERTEX_STRIDE;
    if (need > this.buf.byteLength) {
      let size = this.buf.byteLength * 2;
      while (size < need) size *= 2;
      const nb = new ArrayBuffer(size);
      new Uint8Array(nb).set(this.u8.subarray(0, this.count * VERTEX_STRIDE));
      this.buf = nb; this.f32 = new Float32Array(nb); this.u16 = new Uint16Array(nb); this.u8 = new Uint8Array(nb);
    }
  }
  vertex(x: number, y: number, z: number, u: number, v: number, r: number, g: number, b: number, light: number): void {
    const o = this.count * VERTEX_STRIDE;
    const fo = o >> 2;
    this.f32[fo] = x; this.f32[fo + 1] = y; this.f32[fo + 2] = z;
    const uo = (o + 12) >> 1;
    this.u16[uo] = Math.max(0, Math.min(65535, Math.round(u * 65535)));
    this.u16[uo + 1] = Math.max(0, Math.min(65535, Math.round(v * 65535)));
    this.u8[o + 16] = r; this.u8[o + 17] = g; this.u8[o + 18] = b; this.u8[o + 19] = light;
    this.count++;
  }
  finish(): LayerMesh | null {
    if (this.count === 0) return null;
    return { data: this.buf.slice(0, this.count * VERTEX_STRIDE), quads: this.count / 4 };
  }
}

const SHADE = [0.5, 1.0, 0.8, 0.8, 0.6, 0.6];
const TINT_GRASS = 1, TINT_FOLIAGE = 2, TINT_WATER = 3, TINT_DRY = 4, TINT_CONST = 5, TINT_REDSTONE = 6, TINT_STEM = 7, TINT_NONE = 0;

export class Mesher {
  /** Video options that change mesh output (set via the worker 'options' message). */
  options = { smoothLighting: true, fancy: true };
  private writers = [new VertexWriter(), new VertexWriter(), new VertexWriter()];
  private occl: Uint8Array;      // per state: 6-bit mask | 0x80 computed
  private tintKind: Uint8Array;  // per block id
  private tintConst: Int32Array; // per block id
  private isLeaves: Uint8Array;  // per block id
  private modelScratch: BakedModel[] = [];
  private redstoneColors: number[] = [];
  private waterTile: { u0: number; v0: number; u1: number; v1: number };
  private waterFlowTile: { u0: number; v0: number; u1: number; v1: number };
  private lavaTile: { u0: number; v0: number; u1: number; v1: number };
  private lavaFlowTile: { u0: number; v0: number; u1: number; v1: number };
  private waterBlockId: number; private lavaBlockId: number;
  private chestBlocks = new Map<number, string>();
  private shulkerBlocks = new Map<number, string>();
  private skullBlocks = new Map<number, { tex: string; wall: boolean; layout: 'skull' | 'zombie' | 'creeper' | 'player' | 'piglin' }>();
  private bannerBlocks = new Map<number, { color: number; wall: boolean }>();
  private endPortalId: number; private endGatewayId: number; private conduitId: number; private decoratedPotId: number;

  constructor(public reg: BlockRegistry, public baker: ModelBaker, redstoneTint: { keys: number[]; color: number }[]) {
    this.occl = new Uint8Array(reg.stateCount);
    this.tintKind = new Uint8Array(reg.blocks.length);
    this.tintConst = new Int32Array(reg.blocks.length);
    this.isLeaves = new Uint8Array(reg.blocks.length);
    for (const b of reg.blocks) {
      if (!b) continue;
      const n = b.name;
      if (n.endsWith('_leaves')) this.isLeaves[b.id] = 1;
      let kind = TINT_NONE, c = 0xffffff;
      if (['grass_block', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'potted_fern', 'pink_petals', 'wildflowers', 'bush', 'sugar_cane'].includes(n)) kind = TINT_GRASS;
      else if (['oak_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'pale_oak_leaves', 'vine'].includes(n)) kind = TINT_FOLIAGE;
      else if (n === 'birch_leaves') { kind = TINT_CONST; c = 0x80a755; }
      else if (n === 'spruce_leaves') { kind = TINT_CONST; c = 0x619961; }
      else if (n === 'lily_pad') { kind = TINT_CONST; c = 0x208030; }
      else if (n === 'attached_melon_stem' || n === 'attached_pumpkin_stem') { kind = TINT_CONST; c = 0xe0c71c; }
      else if (n === 'melon_stem' || n === 'pumpkin_stem') kind = TINT_STEM;
      else if (n === 'redstone_wire') kind = TINT_REDSTONE;
      else if (n === 'leaf_litter') kind = TINT_DRY;
      else if (n === 'water' || n === 'water_cauldron' || n === 'bubble_column') kind = TINT_WATER;
      this.tintKind[b.id] = kind; this.tintConst[b.id] = c;
      if (n === 'chest' || n === 'trapped_chest' || n === 'ender_chest' || n.endsWith('copper_chest')) this.chestBlocks.set(b.id, n === 'chest' ? 'normal' : n === 'trapped_chest' ? 'trapped' : n === 'ender_chest' ? 'ender' : n.replace('waxed_', '').replace('_chest', '').replace(/^copper$/, 'copper').replace(/^(exposed|weathered|oxidized)_copper$/, 'copper_$1'));
      if (n.endsWith('shulker_box')) this.shulkerBlocks.set(b.id, n === 'shulker_box' ? 'shulker' : 'shulker_' + n.replace('_shulker_box', ''));
      if (n.endsWith('_head') || n.endsWith('_skull')) {
        const wall = n.includes('_wall_');
        const base = n.replace('_wall', '').replace(/_(head|skull)$/, '');
        const map: Record<string, { tex: string; layout: any }> = { skeleton: { tex: 'entity/skeleton/skeleton', layout: 'skull' }, wither_skeleton: { tex: 'entity/skeleton/wither_skeleton', layout: 'skull' }, zombie: { tex: 'entity/zombie/zombie', layout: 'zombie' }, creeper: { tex: 'entity/creeper/creeper', layout: 'creeper' }, player: { tex: 'entity/player/wide/steve', layout: 'player' }, piglin: { tex: 'entity/piglin/piglin', layout: 'piglin' }, dragon: { tex: 'entity/enderdragon/dragon', layout: 'skull' } };
        const m = map[base]; if (m) this.skullBlocks.set(b.id, { tex: m.tex, wall, layout: m.layout });
      }
      if (n.endsWith('_banner')) this.bannerBlocks.set(b.id, { color: DYE_COLORS[n.replace('_wall_banner', '').replace('_banner', '')] ?? 0xffffff, wall: n.includes('_wall_') });
    }
    for (const e of redstoneTint) for (const k of e.keys) this.redstoneColors[k] = e.color & 0xffffff;
    const tile = (n: string) => baker.tileUv.get(n) ?? { u0: 0, v0: 0, u1: 0, v1: 0 };
    this.waterTile = tile('block/water_still'); this.waterFlowTile = tile('block/water_flow');
    this.lavaTile = tile('block/lava_still'); this.lavaFlowTile = tile('block/lava_flow');
    this.waterBlockId = reg.blockByName('water')!.id; this.lavaBlockId = reg.blockByName('lava')!.id;
    this.endPortalId = reg.blockByName('end_portal')?.id ?? -1; this.endGatewayId = reg.blockByName('end_gateway')?.id ?? -1;
    this.conduitId = reg.blockByName('conduit')?.id ?? -1; this.decoratedPotId = reg.blockByName('decorated_pot')?.id ?? -1;
  }

  /** occlusion bitmask for a state (which of its faces are full & opaque) */
  occlusion(state: number): number {
    let v = this.occl[state];
    if (v & 0x80) return v & 0x3f;
    const block = this.reg.block(state);
    let m = 0;
    if (block && !this.reg.isAir(state)) {
      if (this.reg.isFluid(state)) m = 0;
      else {
        m = this.baker.occlusionOf(state);
        // leaves never occlude (fancy graphics)
        if (this.isLeaves[block.id]) m = 0;
      }
    }
    this.occl[state] = 0x80 | m;
    return m;
  }

  private opaqueForAO(state: number): boolean {
    if (state === 0) return false;
    return this.occlusion(state) === 0x3f;
  }

  mesh(input: MeshInput): MeshOutput {
    const t0 = performance.now();
    const { blocks, light, tints } = input;
    const reg = this.reg, baker = this.baker;
    const W = this.writers;
    for (const w of W) w.reset();
    const models = this.modelScratch;
    const wx0 = input.cx * 16, wy0 = input.sy * 16 - 64, wz0 = input.cz * 16;
    for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const i = pidx(x, y, z);
      const s = blocks[i];
      if (s === 0) continue;
      const block = reg.block(s);
      if (!block) continue;
      const bid = block.id;
      if (bid === this.waterBlockId || bid === this.lavaBlockId) { this.meshFluid(input, x, y, z, s, bid === this.lavaBlockId); continue; }
      if (reg.isWaterlogged(s)) this.meshFluid(input, x, y, z, reg.WATER, false);
      if (this.chestBlocks.has(bid)) { this.meshChest(input, x, y, z, s, this.chestBlocks.get(bid)!); continue; }
      if (this.shulkerBlocks.has(bid)) { this.meshShulker(input, x, y, z, s, this.shulkerBlocks.get(bid)!); continue; }
      if (this.skullBlocks.has(bid)) { this.meshSkull(input, x, y, z, s, this.skullBlocks.get(bid)!); continue; }
      if (this.bannerBlocks.has(bid)) { this.meshBanner(input, x, y, z, s, this.bannerBlocks.get(bid)!); continue; }
      if (bid === this.endPortalId || bid === this.endGatewayId) { this.meshEndPortal(input, x, y, z); continue; }
      if (bid === this.conduitId) { this.meshBox(input, x, y, z, 5, 5, 5, 11, 11, 11, 'entity/conduit/base', [[0, 0, 6, 6], [6, 0, 12, 6], [0, 6, 6, 12], [6, 6, 12, 12], [12, 6, 18, 12], [18, 6, 24, 12]], 24, 12, LAYER_SOLID, 0xffffff, true, 0, 0); continue; }
      if (bid === this.decoratedPotId) { this.meshDecoratedPot(input, x, y, z, s); continue; }
      baker.modelsAt(s, wx0 + x, wy0 + y, wz0 + z, models);
      if (models.length === 0) continue;
      const tintKind = this.tintKind[bid];
      let tintColor = 0xffffff;
      if (tintKind !== TINT_NONE) tintColor = this.tintFor(tintKind, bid, s, tints, x, z);
      for (let m = 0; m < models.length; m++) {
        const model = models[m];
        const quads = model.quads;
        const useAO = model.ao && this.options.smoothLighting;
        // fast graphics: leaves are opaque (vanilla draws them in the solid layer without alpha testing)
        const fastLeaves = !this.options.fancy && this.isLeaves[bid];
        for (let q = 0; q < quads.length; q++) {
          const quad = quads[q];
          if (quad.cull >= 0) {
            const d = DIR_VEC[quad.cull];
            const ni = pidx(x + d[0], y + d[1], z + d[2]);
            const ns = blocks[ni];
            if (ns !== 0) {
              const nocc = this.occlusion(ns);
              if (nocc & (1 << (quad.cull ^ 1))) continue;
              // same-block culling for translucent/cutout full cubes (glass, ice, ...)
              if (quad.fullFace && reg.stateBlock[ns] === bid && quad.layer !== LAYER_SOLID && !this.isLeaves[bid]) continue;
              if (quad.fullFace && quad.layer === LAYER_SOLID && reg.stateBlock[ns] === bid && this.occlusion(s) & (1 << quad.cull)) continue;
            }
          }
          this.emitQuad(input, x, y, z, quad, useAO, quad.tint >= 0 ? tintColor : 0xffffff, fastLeaves ? LAYER_SOLID : -1);
        }
      }
    }
    const layers = W.map((w) => w.finish());
    return { cx: input.cx, sy: input.sy, cz: input.cz, layers, time: performance.now() - t0 };
  }

  private tintFor(kind: number, bid: number, state: number, tints: Uint8Array, x: number, z: number): number {
    const o = ((z << 4) | x) * 12;
    switch (kind) {
      case TINT_GRASS: return (tints[o] << 16) | (tints[o + 1] << 8) | tints[o + 2];
      case TINT_FOLIAGE: return (tints[o + 3] << 16) | (tints[o + 4] << 8) | tints[o + 5];
      case TINT_WATER: return (tints[o + 6] << 16) | (tints[o + 7] << 8) | tints[o + 8];
      case TINT_DRY: return (tints[o + 9] << 16) | (tints[o + 10] << 8) | tints[o + 11];
      case TINT_CONST: return this.tintConst[bid];
      case TINT_REDSTONE: { const p = +(this.reg.getProps(state).power ?? 0); return this.redstoneColors[p] ?? 0x4c0000; }
      case TINT_STEM: { const age = +(this.reg.getProps(state).age ?? 0); return ((age * 32) << 16) | ((255 - age * 8) << 8) | (age * 4); }
    }
    return 0xffffff;
  }

  /** Emit one baked quad with smooth lighting + AO. */
  private emitQuad(input: MeshInput, x: number, y: number, z: number, quad: BakedQuad, useAO: boolean, tint: number, forceLayer = -1): void {
    const { blocks, light } = input;
    const w = this.writers[forceLayer >= 0 ? forceLayer : quad.layer];
    w.ensure(4);
    const face = quad.face;
    const d = DIR_VEC[face];
    const shade = quad.shade ? SHADE[face] : 1;
    const tr = ((tint >> 16) & 255) / 255, tg = ((tint >> 8) & 255) / 255, tb = (tint & 255) / 255;
    // base cell for light sampling: neighbor if the quad sits on the boundary, else self
    const bx = quad.onBoundary ? x + d[0] : x, by = quad.onBoundary ? y + d[1] : y, bz = quad.onBoundary ? z + d[2] : z;
    const pos = quad.pos, uv = quad.uv;
    // tangent axes for AO sampling
    const ax = face >> 1 === 0 ? [1, 0, 0] : [0, 1, 0]; // first tangent
    const az = face >> 1 === 0 ? [0, 0, 1] : face >> 1 === 1 ? [1, 0, 0] : [0, 0, 1];
    if (face >> 1 === 2) { ax[0] = 0; ax[1] = 1; ax[2] = 0; az[0] = 0; az[1] = 0; az[2] = 1; }
    if (face >> 1 === 1) { ax[0] = 1; ax[1] = 0; ax[2] = 0; az[0] = 0; az[1] = 1; az[2] = 0; }
    for (let v = 0; v < 4; v++) {
      const px = pos[v * 3], py = pos[v * 3 + 1], pz = pos[v * 3 + 2];
      let sky: number, blk: number, ao = 1;
      if (useAO && quad.onBoundary) {
        // vertex corner sign along tangents
        const sa = (ax[0] ? px : ax[1] ? py : pz) >= 0.5 ? 1 : -1;
        const sb = (az[0] ? px : az[1] ? py : pz) >= 0.5 ? 1 : -1;
        const i0 = pidx(bx, by, bz);
        const i1 = pidx(bx + ax[0] * sa, by + ax[1] * sa, bz + ax[2] * sa);
        const i2 = pidx(bx + az[0] * sb, by + az[1] * sb, bz + az[2] * sb);
        const i3 = pidx(bx + ax[0] * sa + az[0] * sb, by + ax[1] * sa + az[1] * sb, bz + ax[2] * sa + az[2] * sb);
        const o1 = this.opaqueForAO(blocks[i1]), o2 = this.opaqueForAO(blocks[i2]);
        const o3 = o1 && o2 ? true : this.opaqueForAO(blocks[i3]);
        const n = (o1 ? 1 : 0) + (o2 ? 1 : 0) + (o3 ? 1 : 0);
        ao = n === 0 ? 1 : n === 1 ? 0.8 : n === 2 ? 0.6 : 0.4;
        if (o1 && o2) ao = 0.4;
        // average light over non-opaque cells
        let ss = 0, bb = 0, cnt = 0;
        const l0 = light[i0]; ss += l0 >> 4; bb += l0 & 15; cnt++;
        if (!o1) { const l = light[i1]; ss += l >> 4; bb += l & 15; cnt++; }
        if (!o2) { const l = light[i2]; ss += l >> 4; bb += l & 15; cnt++; }
        if (!o3) { const l = light[i3]; ss += l >> 4; bb += l & 15; cnt++; }
        // vanilla: opaque cells contribute the centre light instead of 0
        const add = 4 - cnt; ss += (l0 >> 4) * add; bb += (l0 & 15) * add;
        sky = ss / 4; blk = bb / 4;
      } else {
        const l0 = light[pidx(bx, by, bz)];
        sky = l0 >> 4; blk = l0 & 15;
        if (!quad.onBoundary) {
          // inner faces: take max with the self cell so torches etc. are lit by their own emission
          const ls = light[pidx(x, y, z)];
          sky = Math.max(sky, ls >> 4); blk = Math.max(blk, ls & 15);
        }
      }
      const f = shade * ao * 255;
      w.vertex(x + px, y + py, z + pz, uv[v * 2], uv[v * 2 + 1], (tr * f) | 0, (tg * f) | 0, (tb * f) | 0, (Math.round(sky) << 4) | Math.round(blk));
    }
  }

  // ---------- generic textured box (for chests, skulls, shulkers …) ----------
  /**
   * Box from (x0..x1, y0..y1, z0..z1) in 16ths, faces UV rects in texture pixels [u0,v0,u1,v1] per direction
   * (down, up, north, south, west, east), rotated by `yRot` (0..3 quarter turns clockwise) around block centre.
   */
  private meshBox(input: MeshInput, x: number, y: number, z: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tex: string, faceUv: (number[] | null)[], texW: number, texH: number, layer: number, tint: number, shade: boolean, yRot: number, xRot: number): void {
    const tile = this.baker.tileUv.get(tex);
    if (!tile) return;
    const from = [x0, y0, z0], to = [x1, y1, z1];
    const corners = FACE_CORNERS;
    for (let face = 0; face < 6; face++) {
      const rect = faceUv[face];
      if (!rect) continue;
      const pos = new Float32Array(12);
      for (let v = 0; v < 4; v++) {
        const c = corners[face][v];
        let px = (c[0] ? to[0] : from[0]) / 16 - 0.5, py = (c[1] ? to[1] : from[1]) / 16 - 0.5, pz = (c[2] ? to[2] : from[2]) / 16 - 0.5;
        if (xRot) { const s = Math.sin(-xRot * Math.PI / 2), co = Math.cos(-xRot * Math.PI / 2); const ny = py * co - pz * s, nz = py * s + pz * co; py = ny; pz = nz; }
        for (let r = 0; r < yRot; r++) { const nx = -pz, nz = px; px = nx; pz = nz; }
        pos[v * 3] = px + 0.5; pos[v * 3 + 1] = py + 0.5; pos[v * 3 + 2] = pz + 0.5;
      }
      const uvs = new Float32Array(8);
      const [u0, v0, u1, v1] = rect;
      const U = (u: number) => tile.u0 + (tile.u1 - tile.u0) * (u / texW), V = (v: number) => tile.v0 + (tile.v1 - tile.v0) * (v / texH);
      uvs[0] = U(u0); uvs[1] = V(v0); uvs[2] = U(u0); uvs[3] = V(v1); uvs[4] = U(u1); uvs[5] = V(v1); uvs[6] = U(u1); uvs[7] = V(v0);
      // normal after rotation
      let nf = face;
      if (xRot) nf = rotDirX(nf, xRot);
      for (let r = 0; r < yRot; r++) nf = ROT_Y[nf];
      const n = DIR_VEC[nf];
      const quad: BakedQuad = { pos, uv: uvs, face: nf, cull: -1, tint: tint === 0xffffff ? -1 : 0, shade, layer, texture: tex, onBoundary: false, fullFace: false, nx: n[0], ny: n[1], nz: n[2] };
      this.emitQuad(input, x, y, z, quad, false, tint);
    }
  }

  private yRotOfFacing(facing: string | undefined): number {
    // model default faces north; y rotation quarter turns clockwise viewed from above
    return facing === 'east' ? 1 : facing === 'south' ? 2 : facing === 'west' ? 3 : 0;
  }

  private meshChest(input: MeshInput, x: number, y: number, z: number, state: number, kind: string): void {
    const props = this.reg.getProps(state);
    const type = props.type ?? 'single';
    const rot = this.yRotOfFacing(props.facing);
    const tex = 'entity/chest/' + kind + (type === 'left' ? '_left' : type === 'right' ? '_right' : '');
    if (!this.baker.tileUv.has(tex)) return this.meshBoxFallback(input, x, y, z, state);
    // vanilla ChestModel (64x64): lid texOffs(0,0) box 14x5x14, base texOffs(0,19) box 14x10x14, lock texOffs(0,0) box 2x4x1
    // vanilla ModelPart.Cube unwrap: the DOWN face sits at (u+d, v) and UP at (u+d+w, v) — the lid's wooden top is the
    // second square, the first is its dark underside (they were swapped, which painted the inside on top)
    const boxUv = (u: number, v: number, w: number, h: number, d: number): number[][] => [
      [u + d, v, u + d + w, v + d],              // down
      [u + d + w, v, u + d + 2 * w, v + d],      // up
      // our local frame is vanilla's model rotated a half turn (front on our north), so front/back and the two
      // ends swap unwrap squares
      [u + d + w + d, v + d, u + 2 * d + 2 * w, v + d + h], // north = vanilla SOUTH square (the front, with the latch)
      [u + d, v + d, u + d + w, v + d + h],      // south = vanilla NORTH square (the back)
      [u + d + w, v + d, u + 2 * d + w, v + d + h], // west = vanilla EAST square
      [u, v + d, u + d, v + d + h],              // east = vanilla WEST square
    ];
    // the lock (z 0..1, our north side) must end up on the `facing` side: north needs no rotation
    const r = rot;
    if (type === 'single') {
      this.meshBox(input, x, y, z, 1, 0, 1, 15, 10, 15, tex, boxUv(0, 19, 14, 10, 14), 64, 64, LAYER_SOLID, 0xffffff, true, r, 0);
      this.meshBox(input, x, y, z, 1, 9, 1, 15, 14, 15, tex, boxUv(0, 0, 14, 5, 14), 64, 64, LAYER_SOLID, 0xffffff, true, r, 0);
      this.meshBox(input, x, y, z, 7, 7, 0, 9, 11, 1, tex, boxUv(0, 0, 2, 4, 1), 64, 64, LAYER_SOLID, 0xffffff, true, r, 0);
    } else {
      // double chest halves: 15 wide each, textures are 64x64 "left"/"right" variants
      // the seam is on the partner's side: for the left half that is our local east edge (x = 16)
      const left = type === 'left';
      const bx0 = left ? 1 : 0, bx1 = left ? 16 : 15;
      const bw = 15;
      this.meshBox(input, x, y, z, bx0, 0, 1, bx1, 10, 15, tex, boxUv(0, 19, bw, 10, 14), 64, 64, LAYER_SOLID, 0xffffff, true, r, 0);
      this.meshBox(input, x, y, z, bx0, 9, 1, bx1, 14, 15, tex, boxUv(0, 0, bw, 5, 14), 64, 64, LAYER_SOLID, 0xffffff, true, r, 0);
      if (left) this.meshBox(input, x, y, z, 15, 7, 0, 16, 11, 1, tex, boxUv(0, 0, 1, 4, 1), 64, 64, LAYER_SOLID, 0xffffff, true, r, 0);
      else this.meshBox(input, x, y, z, 0, 7, 0, 1, 11, 1, tex, boxUv(0, 0, 1, 4, 1), 64, 64, LAYER_SOLID, 0xffffff, true, r, 0);
    }
  }

  private meshShulker(input: MeshInput, x: number, y: number, z: number, state: number, tex: string): void {
    const t = 'entity/shulker/' + tex;
    if (!this.baker.tileUv.has(t)) return this.meshBoxFallback(input, x, y, z, state);
    // vanilla renders shulkers and banners with scale(1, -1, -1), which swaps the unwrap's up/down squares
    const boxUv = (u: number, v: number, w: number, h: number, d: number): number[][] => [
      [u + d + w, v, u + d + 2 * w, v + d], [u + d, v, u + d + w, v + d],
      [u + d + w + d, v + d, u + 2 * d + 2 * w, v + d + h], [u + d, v + d, u + d + w, v + d + h],
      [u, v + d, u + d, v + d + h], [u + d + w, v + d, u + 2 * d + w, v + d + h],
    ];
    const facing = this.reg.getProps(state).facing ?? 'up';
    const xr = facing === 'down' ? 2 : facing === 'up' ? 0 : 1;
    const yr = facing === 'north' ? 2 : facing === 'south' ? 0 : facing === 'west' ? 1 : facing === 'east' ? 3 : 0;
    this.meshBox(input, x, y, z, 0, 0, 0, 16, 8, 16, t, boxUv(0, 28, 16, 8, 16), 64, 64, LAYER_SOLID, 0xffffff, true, yr, xr);
    this.meshBox(input, x, y, z, 0, 4, 0, 16, 16, 16, t, boxUv(0, 0, 16, 12, 16), 64, 64, LAYER_SOLID, 0xffffff, true, yr, xr);
  }

  private meshSkull(input: MeshInput, x: number, y: number, z: number, state: number, info: { tex: string; wall: boolean; layout: string }): void {
    if (!this.baker.tileUv.has(info.tex)) return;
    const props = this.reg.getProps(state);
    const texW = 64, texH = info.layout === 'zombie' || info.layout === 'player' || info.layout === 'piglin' ? 64 : 32;
    // head box 8x8x8 at UV (0,0)
    const head = [[16, 0, 24, 8], [8, 0, 16, 8], [24, 8, 32, 16], [8, 8, 16, 16], [0, 8, 8, 16], [16, 8, 24, 16]];
    let yRot = 0;
    let y0 = 0, z0 = 4;
    if (info.wall) { yRot = this.yRotOfFacing(props.facing); yRot = (yRot + 2) & 3; y0 = 4; z0 = 0; }
    else { const r = +(props.rotation ?? 0); yRot = 0; }
    const rot16 = info.wall ? 0 : +(props.rotation ?? 0);
    if (!info.wall) {
      // 16-step rotation: approximate with quarter turns (fine detail rotation would need arbitrary angle)
      yRot = ((rot16 + 2) >> 2) & 3;
    }
    this.meshBox(input, x, y, z, 4, y0, z0, 12, y0 + 8, z0 + 8, info.tex, head, texW, texH, LAYER_SOLID, 0xffffff, true, yRot, 0);
    if (info.layout === 'player' || info.layout === 'zombie' || info.layout === 'piglin') {
      const hat = [[48, 0, 56, 8], [40, 0, 48, 8], [56, 8, 64, 16], [40, 8, 48, 16], [32, 8, 40, 16], [48, 8, 56, 16]];
      this.meshBox(input, x, y, z, 3.75, y0 - 0.25, z0 - 0.25, 12.25, y0 + 8.25, z0 + 8.25, info.tex, hat, texW, texH, LAYER_CUTOUT, 0xffffff, true, yRot, 0);
    }
  }

  private meshBanner(input: MeshInput, x: number, y: number, z: number, state: number, info: { color: number; wall: boolean }): void {
    const tex = 'entity/banner/base';
    if (!this.baker.tileUv.has(tex)) return this.meshBoxFallback(input, x, y, z, state);
    const props = this.reg.getProps(state);
    // banner model (64x64): flag 20x40x1 at (0,0), pole 2x42x2 at (44,0), crossbar 20x2x2 at (0,42)
    // vanilla renders shulkers and banners with scale(1, -1, -1), which swaps the unwrap's up/down squares
    const boxUv = (u: number, v: number, w: number, h: number, d: number): number[][] => [
      [u + d + w, v, u + d + 2 * w, v + d], [u + d, v, u + d + w, v + d],
      [u + d + w + d, v + d, u + 2 * d + 2 * w, v + d + h], [u + d, v + d, u + d + w, v + d + h],
      [u, v + d, u + d, v + d + h], [u + d + w, v + d, u + 2 * d + w, v + d + h],
    ];
    if (info.wall) {
      const r = (this.yRotOfFacing(props.facing) + 2) & 3;
      this.meshBox(input, x, y, z, -2, -14, 1, 18, 14, 2, tex, boxUv(0, 0, 20, 40, 1), 64, 64, LAYER_CUTOUT, info.color, true, r, 0);
      this.meshBox(input, x, y, z, -2, 14, 0, 18, 16, 2, tex, boxUv(0, 42, 20, 2, 2), 64, 64, LAYER_CUTOUT, 0xffffff, true, r, 0);
    } else {
      const r = ((+(props.rotation ?? 0) + 2) >> 2) & 3;
      this.meshBox(input, x, y, z, 7, 0, 7, 9, 30, 9, tex, boxUv(44, 0, 2, 42, 2), 64, 64, LAYER_CUTOUT, 0xffffff, true, r, 0);
      this.meshBox(input, x, y, z, -2, 28, 6, 18, 30, 8, tex, boxUv(0, 42, 20, 2, 2), 64, 64, LAYER_CUTOUT, 0xffffff, true, r, 0);
      this.meshBox(input, x, y, z, -2, 2, 8.5, 18, 28, 9.5, tex, boxUv(0, 0, 20, 40, 1), 64, 64, LAYER_CUTOUT, info.color, true, r, 0);
    }
  }

  private meshDecoratedPot(input: MeshInput, x: number, y: number, z: number, state: number): void {
    const base = 'entity/decorated_pot/decorated_pot_base', side = 'entity/decorated_pot/decorated_pot_side';
    if (!this.baker.tileUv.has(base)) return this.meshBoxFallback(input, x, y, z, state);
    const r = this.yRotOfFacing(this.reg.getProps(state).facing);
    // body 14x14x14 (sides use side texture 16x16 region), neck & top from base (32x32)
    this.meshBox(input, x, y, z, 1, 0, 1, 15, 16, 15, side, [null, null, [1, 1, 15, 15], [1, 1, 15, 15], [1, 1, 15, 15], [1, 1, 15, 15]], 16, 16, LAYER_SOLID, 0xffffff, true, r, 0);
    this.meshBox(input, x, y, z, 1, 0, 1, 15, 16, 15, base, [[0, 13, 14, 27], [0, 0, 14, 14], null, null, null, null], 32, 32, LAYER_SOLID, 0xffffff, true, r, 0);
    this.meshBox(input, x, y, z, 5, 16, 5, 11, 20, 11, base, [null, [0, 0, 6, 6], [0, 0, 6, 4], [0, 0, 6, 4], [0, 0, 6, 4], [0, 0, 6, 4]], 32, 32, LAYER_SOLID, 0xffffff, true, r, 0);
  }

  private meshEndPortal(input: MeshInput, x: number, y: number, z: number): void {
    const tile = this.baker.tileUv.get('block/end_portal_frame_top') ?? this.baker.tileUv.get('block/obsidian');
    if (!tile) return;
    const pos = new Float32Array([0, 0.75, 0, 0, 0.75, 1, 1, 0.75, 1, 1, 0.75, 0]);
    const uv = new Float32Array([tile.u0, tile.v0, tile.u0, tile.v1, tile.u1, tile.v1, tile.u1, tile.v0]);
    const quad: BakedQuad = { pos, uv, face: 1, cull: -1, tint: 0, shade: false, layer: LAYER_SOLID, texture: '', onBoundary: false, fullFace: false, nx: 0, ny: 1, nz: 0 };
    this.emitQuad(input, x, y, z, quad, false, 0x101030);
  }

  private meshBoxFallback(input: MeshInput, x: number, y: number, z: number, state: number): void {
    const model = this.baker.firstModel(state);
    const tex = model?.particle ?? 'block/stone';
    const r = [0, 0, 16, 16];
    this.meshBox(input, x, y, z, 1, 0, 1, 15, 14, 15, tex, [r, r, r, r, r, r], 16, 16, LAYER_SOLID, 0xffffff, true, 0, 0);
  }

  // ---------- fluids ----------
  private fluidHeight(state: number, lava: boolean): number {
    const bid = this.reg.stateBlock[state];
    if (bid === (lava ? this.lavaBlockId : this.waterBlockId)) {
      const level = +(this.reg.getProps(state).level ?? 0);
      if (level === 0 || level >= 8) return 8 / 9;
      return (8 - level) / 9;
    }
    if (!lava && this.reg.isWaterlogged(state)) return 8 / 9;
    return -1;
  }

  private meshFluid(input: MeshInput, x: number, y: number, z: number, state: number, lava: boolean): void {
    const { blocks, light, tints } = input;
    const reg = this.reg;
    const sameFluid = (s: number) => this.fluidHeight(s, lava) >= 0;
    const above = blocks[pidx(x, y + 1, z)];
    const aboveFluid = sameFluid(above);
    // corner heights
    const cornerH = (dx: number, dz: number): number => {
      if (aboveFluid) return 1;
      let total = 0, n = 0;
      for (let i = 0; i < 4; i++) {
        const ox = dx + (i & 1) - 1, oz = dz + (i >> 1) - 1; // offsets: (dx-1|dx, dz-1|dz)
        const s = blocks[pidx(x + ox, y, z + oz)];
        if (sameFluid(blocks[pidx(x + ox, y + 1, z + oz)])) return 1;
        const h = this.fluidHeight(s, lava);
        if (h >= 0) { if (h >= 0.8) { total += h * 10; n += 10; } else { total += h; n++; } }
        else if (s === 0 || this.occlusion(s) !== 0x3f) { n++; }
      }
      return n === 0 ? 8 / 9 : total / n;
    };
    const hNW = cornerH(0, 0), hNE = cornerH(1, 0), hSW = cornerH(0, 1), hSE = cornerH(1, 1);
    const tintO = ((z << 4) | x) * 12;
    const color = lava ? 0xffffff : (tints[tintO + 6] << 16) | (tints[tintO + 7] << 8) | tints[tintO + 8];
    const layer = lava ? LAYER_SOLID : LAYER_TRANSLUCENT;
    const still = lava ? this.lavaTile : this.waterTile, flow = lava ? this.lavaFlowTile : this.waterFlowTile;
    const w = this.writers[layer];
    const l0 = light[pidx(x, y, z)];
    const lightAt = (nx: number, ny: number, nz: number) => { const s = blocks[pidx(nx, ny, nz)]; return s !== 0 && this.occlusion(s) === 0x3f ? l0 : light[pidx(nx, ny, nz)]; };
    const emit = (px: number, py: number, pz: number, u: number, v: number, shade: number, lt: number) => {
      const f = shade * 255;
      w.vertex(x + px, y + py, z + pz, u, v, ((((color >> 16) & 255) / 255) * f) | 0, ((((color >> 8) & 255) / 255) * f) | 0, (((color & 255) / 255) * f) | 0, lava ? 0xff : lt);
    };
    // top face
    if (!aboveFluid) {
      const lt = lightAt(x, y + 1, z);
      // flow direction from corner heights
      const fx = (hNE + hSE) - (hNW + hSW), fz = (hSW + hSE) - (hNW + hNE);
      const flowing = Math.abs(fx) > 0.01 || Math.abs(fz) > 0.01;
      w.ensure(4);
      if (!flowing) {
        emit(0, hNW, 0, still.u0, still.v0, 1, lt); emit(0, hSW, 1, still.u0, still.v1, 1, lt); emit(1, hSE, 1, still.u1, still.v1, 1, lt); emit(1, hNE, 0, still.u1, still.v0, 1, lt);
      } else {
        const angle = Math.atan2(fz, fx) - Math.PI / 2; // texture "flow" points -v; rotate accordingly
        const cu = (flow.u0 + flow.u1) / 2, cv = (flow.v0 + flow.v1) / 2, ru = (flow.u1 - flow.u0) / 4, rv = (flow.v1 - flow.v0) / 4;
        const s = Math.sin(angle), c = Math.cos(angle);
        const uvAt = (ox: number, oz: number): [number, number] => { const dx = ox - 0.5, dz = oz - 0.5; return [cu + (dx * c - dz * s) * 2 * ru, cv + (dx * s + dz * c) * 2 * rv]; };
        const a = uvAt(0, 0), b = uvAt(0, 1), cc = uvAt(1, 1), d = uvAt(1, 0);
        emit(0, hNW, 0, a[0], a[1], 1, lt); emit(0, hSW, 1, b[0], b[1], 1, lt); emit(1, hSE, 1, cc[0], cc[1], 1, lt); emit(1, hNE, 0, d[0], d[1], 1, lt);
      }
      // underside of the top surface (visible from below when inside water)
      if (!lava) { w.ensure(4); emit(0, hNW, 0, still.u0, still.v0, 1, lt); emit(1, hNE, 0, still.u1, still.v0, 1, lt); emit(1, hSE, 1, still.u1, still.v1, 1, lt); emit(0, hSW, 1, still.u0, still.v1, 1, lt); }
    }
    // bottom
    const below = blocks[pidx(x, y - 1, z)];
    if (!sameFluid(below) && !(below !== 0 && (this.occlusion(below) & 2))) {
      const lt = lightAt(x, y - 1, z);
      w.ensure(4);
      emit(0, 0, 1, still.u0, still.v1, 0.5, lt); emit(0, 0, 0, still.u0, still.v0, 0.5, lt); emit(1, 0, 0, still.u1, still.v0, 0.5, lt); emit(1, 0, 1, still.u1, still.v1, 0.5, lt);
    }
    // sides: north(-z), south(+z), west(-x), east(+x)
    const sides: [number, number, number, number, number, number, number, number, number][] = [
      // dx, dz, x0, z0, h0, x1, z1, h1, shade
      [0, -1, 1, 0, hNE, 0, 0, hNW, 0.8],
      [0, 1, 0, 1, hSW, 1, 1, hSE, 0.8],
      [-1, 0, 0, 0, hNW, 0, 1, hSW, 0.6],
      [1, 0, 1, 1, hSE, 1, 0, hNE, 0.6],
    ];
    for (const [dx, dz, x0, z0, h0, x1, z1, h1, sh] of sides) {
      const ns = blocks[pidx(x + dx, y, z + dz)];
      if (sameFluid(ns)) continue;
      const dir = dx === 0 ? (dz < 0 ? 2 : 3) : (dx < 0 ? 4 : 5);
      if (ns !== 0 && (this.occlusion(ns) & (1 << (dir ^ 1)))) continue;
      const lt = lightAt(x + dx, y, z + dz);
      const fu0 = flow.u0, fu1 = flow.u0 + (flow.u1 - flow.u0) * 0.5, fv0 = flow.v0, fvh = (flow.v1 - flow.v0) * 0.5;
      w.ensure(4);
      emit(x0, h0, z0, fu0, fv0 + fvh * (1 - h0), sh, lt);
      emit(x0, 0, z0, fu0, fv0 + fvh, sh, lt);
      emit(x1, 0, z1, fu1, fv0 + fvh, sh, lt);
      emit(x1, h1, z1, fu1, fv0 + fvh * (1 - h1), sh, lt);
    }
  }
}

const FACE_CORNERS: number[][][] = [
  [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
  [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]],
  [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]],
  [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]],
  [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
];
// quarter turn clockwise (viewed from above): north->east->south->west
const ROT_Y = [0, 1, 5, 4, 2, 3];
function rotDirX(d: number, q: number): number {
  // rotate about X by q quarter turns (-x direction per our meshBox convention): up->north->down->south
  const cycle = [1, 2, 0, 3];
  const i = cycle.indexOf(d);
  if (i < 0) return d;
  return cycle[(i + q) & 3];
}

export const DYE_COLORS: Record<string, number> = {
  white: 0xf9fffe, orange: 0xf9801d, magenta: 0xc74ebd, light_blue: 0x3ab3da, yellow: 0xfed83d, lime: 0x80c71f, pink: 0xf38baa, gray: 0x474f52,
  light_gray: 0x9d9d97, cyan: 0x169c9c, purple: 0x8932b8, blue: 0x3c44aa, brown: 0x835432, green: 0x5e7c16, red: 0xb02e26, black: 0x1d1d21,
};
