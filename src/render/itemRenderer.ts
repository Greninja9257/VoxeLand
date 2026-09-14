// Item meshes: 3D block items from baked models, flat items extruded from their texture (vanilla style),
// GUI icon rendering (offscreen FBO) and display transforms.
import type { Assets } from '../assets';
import type { ItemStack } from '../items/stack';
import type { ModelBaker, BakedModel } from './models';
import { Mesher, PAD, pidx, type MeshInput } from './mesher';
import { VERTEX_STRIDE } from './mesher';
import type { Renderer } from './renderer';
import { mat4Identity, mat4Mul, mat4Ortho, mat4RotateX, mat4RotateY, mat4RotateZ, mat4Scale, mat4Translate, DEG, type Mat4 } from '../math';
import { DYE_COLORS } from './mesher';
import { imageToData } from './gl';

export interface ItemMesh { data: ArrayBuffer; quads: number; flat: boolean; display: Record<string, { rotation?: number[]; translation?: number[]; scale?: number[] }>; guiLight: 'front' | 'side'; texture?: string }

const SHADE = [0.5, 1.0, 0.8, 0.8, 0.6, 0.6];

const SPAWN_EGG_COLORS: Record<string, [number, number]> = {
  zombie: [0x00afaf, 0x799c65], skeleton: [0xc1c1c1, 0x494949], creeper: [0x0da70b, 0x000000], spider: [0x342d27, 0xa80e0e], enderman: [0x161616, 0x000000], pig: [0xf0a5a2, 0xdb635f], cow: [0x443626, 0xa1a1a1], sheep: [0xe7e7e7, 0xffb5b5], chicken: [0xa1a1a1, 0xff0000], wolf: [0xd7d3d3, 0xceaf96], slime: [0x51a03e, 0x7ebf6e], zombified_piglin: [0xea9393, 0x4c7129], witch: [0x340000, 0x51a03e], villager: [0x563c33, 0xbd8b72], squid: [0x223b4d, 0x708899], bat: [0x4c3e30, 0x0f0f0f], cave_spider: [0xc0d0e0, 0xa80e0e], ghast: [0xf9f9f9, 0xbcbcbc], magma_cube: [0x340000, 0xfcfc00], blaze: [0xf6b201, 0xfff87e], horse: [0xc09e7d, 0xeee500], rabbit: [0x995f40, 0x734831], husk: [0x797363, 0xe6cc94], stray: [0x617677, 0xddeaea], drowned: [0x8ff1d7, 0x223b4d], phantom: [0x43518a, 0x88ff00], turtle: [0xe6f6e6, 0x00ae00], dolphin: [0x223b4d, 0xf9f9f9], cod: [0xc1a76a, 0xe5c48b], salmon: [0xa00f10, 0x0e8474], polar_bear: [0xf2f2f2, 0x959590], ocelot: [0xefde7d, 0x564434], cat: [0xefc88e, 0x8f6b59], fox: [0xd5b69f, 0xcc6920], panda: [0xe7e7e7, 0x1b1b22], parrot: [0x0da70b, 0xff0000], bee: [0xedc343, 0x43241b], goat: [0xa5947c, 0x55493e], axolotl: [0xfbc1e3, 0xa62d74], glow_squid: [0x095656, 0x85f1bc], frog: [0xd07444, 0xffc77c], allay: [0x00daff, 0x00adff], warden: [0x0f4649, 0x39d6e0], camel: [0xfcc369, 0xcb9337], sniffer: [0x922929, 0x2c8f0e], armadillo: [0xad716d, 0x8e5d63], hoglin: [0xc66e55, 0x5f6464], piglin: [0x995f40, 0xf9f3a4], strider: [0x9c3436, 0x4d494d], wither_skeleton: [0x141414, 0x474d4d], guardian: [0x5a8272, 0xf17d30], iron_golem: [0xdbdbdb, 0x93b7a7], snow_golem: [0xdcdcdc, 0xefda69], vex: [0x7a90a4, 0xe8edf1], pillager: [0x532f36, 0x264a49], vindicator: [0x959b9b, 0x275e61], evoker: [0x959b9b, 0x1e1c1a], ravager: [0x757470, 0x5b5049], silverfish: [0x6e6e6e, 0x303030], endermite: [0x161616, 0x6e6e6e], shulker: [0x946794, 0x4d3852], tropical_fish: [0xef6915, 0xfff9ef], pufferfish: [0xf6f338, 0x03d3f3], mooshroom: [0xa00f10, 0xb7b7b7], donkey: [0x534539, 0x867566], mule: [0x1b0200, 0x51331d], llama: [0xc0a072, 0xa07a5b], trader_llama: [0xeaa430, 0x456296], zombie_villager: [0x563c33, 0x799c65], bogged: [0x8a9d7a, 0x4a5d3b], breeze: [0xaf94e8, 0x6e3bd0], creaking: [0x5f5f5f, 0xff6c00], zoglin: [0xc66e55, 0xe6e6e6], piglin_brute: [0x592a10, 0xf9f3a4], wandering_trader: [0x2a274f, 0xd6a1a1], wither: [0x141414, 0x4d72a0], ender_dragon: [0x1c1c1c, 0xe079fa], elder_guardian: [0xceccba, 0x747693], zombie_horse: [0x315234, 0x9aa2a4], skeleton_horse: [0x68684e, 0xe5e5d8], tadpole: [0x6d533d, 0x160a00], happy_ghast: [0xf9f9f9, 0xd7d7ff], nautilus: [0x8ea9c9, 0xffffff], camel_husk: [0xa38a63, 0x7a6b4c], zombie_nautilus: [0x5a7a3e, 0x9caa7d], parched: [0xc3b58e, 0x5c4b32], copper_golem: [0xc76a4f, 0x7ac4b4],
};

export class ItemRenderer {
  private cache = new Map<string, ItemMesh>();
  private iconCache = new Map<string, HTMLCanvasElement>();
  private atlasData: ImageData;
  private fbo: WebGLFramebuffer | null = null; private fboTex: WebGLTexture | null = null; private fboDepth: WebGLRenderbuffer | null = null;
  readonly ICON = 64;

  constructor(public assets: Assets, public baker: ModelBaker, public renderer: Renderer) {
    this.atlasData = imageToData(assets.atlasImage);
  }

  /** Resolve the item definition to a model name. */
  private resolveModelName(itemName: string, stack?: ItemStack | null): string {
    const def = this.assets.models.items[itemName];
    if (!def) return this.assets.models.models['item/' + itemName] ? 'item/' + itemName : 'block/' + itemName;
    const pick = (m: any): string => {
      if (!m) return 'item/' + itemName;
      const t = String(m.type ?? '').replace('minecraft:', '');
      switch (t) {
        case 'model': return m.model;
        case 'condition': return pick(m.on_false ?? m.on_true);
        case 'range_dispatch': return pick(m.fallback ?? m.entries?.[0]?.model);
        case 'select': { const cases = m.cases ?? []; if (m.property === 'minecraft:trim_material' || String(m.property).includes('trim')) return pick(m.fallback ?? cases[0]?.model); return pick(m.fallback ?? cases[0]?.model); }
        case 'composite': return pick(m.models?.[0]);
        case 'special': return m.base ?? 'item/' + itemName;
        case 'bundle/selected_item': return pick(m.fallback);
        case 'empty': return 'item/' + itemName;
        default: return m.model ?? m.base ?? 'item/' + itemName;
      }
    };
    void stack;
    return pick(def.model);
  }

  getMesh(stack: ItemStack): ItemMesh {
    const key = stack.item.name + (stack.item.name === 'potion' || stack.item.name === 'splash_potion' || stack.item.name === 'lingering_potion' || stack.item.name === 'tipped_arrow' ? ':' + (stack.extra?.color ?? '') : '') + (stack.extra?.dyeColor ? ':' + stack.extra.dyeColor : '');
    let m = this.cache.get(key);
    if (m) return m;
    m = this.bake(stack);
    this.cache.set(key, m);
    return m;
  }

  private bake(stack: ItemStack): ItemMesh {
    const name = stack.item.name;
    const modelName = this.resolveModelName(name, stack).replace(/^minecraft:/, '');
    const resolved = this.baker.resolve(modelName);
    const tint = this.itemTint(stack);
    if (resolved && resolved.elements && resolved.elements.length) {
      const baked = this.baker.bake(modelName, 0, 0, false);
      return this.bakeBlockModel(baked, tint, resolved.display, resolved.guiLight);
    }
    // flat item from textures.layer0.. (generated) — chest/shulker "special" items fall back to their block model
    const layers: string[] = [];
    if (resolved) for (let i = 0; i < 5; i++) { const t = resolved.textures['layer' + i]; if (t) layers.push((typeof t === 'string' ? t : t.sprite).replace('minecraft:', '')); }
    if (!layers.length) {
      const blockModel = this.baker.firstModel(this.baker.registry.defaultState(name));
      if (blockModel && blockModel.quads.length) return this.bakeBlockModel(blockModel, tint, blockModel.display, blockModel.guiLight);
      // chests, shulker boxes, heads, banners, pots, bells: mesh the block-entity model with the world mesher
      const special = this.bakeSpecialBlock(name, resolved?.display ?? {});
      if (special) return special;
      layers.push(this.baker.tileUv.has('item/' + name) ? 'item/' + name : 'block/' + name);
    }
    return this.bakeFlat(layers, tint, resolved?.display ?? {}, name);
  }

  private mesher: Mesher | null = null;
  /** Mesh a single block state with the chunk mesher (used for blocks drawn by custom code, not JSON models). */
  private bakeSpecialBlock(name: string, display: any): ItemMesh | null {
    const reg = this.baker.registry;
    const block = reg.blockByName(name);
    if (!block) return null;
    if (!this.mesher) this.mesher = new Mesher(reg, this.baker, this.assets.mcdata.tints.redstone.data);
    const input: MeshInput = { cx: 0, sy: 0, cz: 0, blocks: new Uint16Array(PAD * PAD * PAD), light: new Uint8Array(PAD * PAD * PAD).fill(0xff), tints: new Uint8Array(16 * 16 * 12).fill(255) };
    input.blocks[pidx(1, 1, 1)] = reg.defaultState(name);
    const out = this.mesher.mesh(input);
    let quads = 0; for (const l of out.layers) if (l) quads += l.quads;
    if (!quads) return null;
    const buf = new ArrayBuffer(quads * 4 * VERTEX_STRIDE);
    const f32 = new Float32Array(buf), u8 = new Uint8Array(buf);
    let o = 0;
    for (const l of out.layers) {
      if (!l) continue;
      u8.set(new Uint8Array(l.data, 0, l.quads * 4 * VERTEX_STRIDE), o);
      o += l.quads * 4 * VERTEX_STRIDE;
    }
    for (let i = 0; i < quads * 4; i++) { const b = i * 5; f32[b] -= 1.5; f32[b + 1] -= 1.5; f32[b + 2] -= 1.5; u8[i * VERTEX_STRIDE + 19] = 0xff; }
    const disp = Object.keys(display ?? {}).length ? display : (this.baker.resolve('block/block')?.display ?? {});
    return { data: buf, quads, flat: false, display: disp, guiLight: 'side' };
  }

  private itemTint(stack: ItemStack): number[] {
    const n = stack.item.name;
    if (n.endsWith('_spawn_egg')) { const c = SPAWN_EGG_COLORS[n.replace('_spawn_egg', '')] ?? [0xffffff, 0xffffff]; return [c[0], c[1]]; }
    if (n.startsWith('leather_') && n !== 'leather') return [stack.extra?.dyeColor ?? 0xa06540, 0xffffff];
    if (n === 'potion' || n === 'splash_potion' || n === 'lingering_potion' || n === 'tipped_arrow') return [stack.extra?.color ?? 0x385dc6, 0xffffff];
    if (n === 'grass_block' || n === 'short_grass' || n === 'tall_grass' || n === 'fern' || n === 'large_fern') return [0x7cbd6b, 0x7cbd6b];
    if (n === 'oak_leaves' || n === 'jungle_leaves' || n === 'acacia_leaves' || n === 'dark_oak_leaves' || n === 'mangrove_leaves' || n === 'vine' || n === 'pale_oak_leaves') return [0x48b518, 0x48b518];
    if (n === 'birch_leaves') return [0x80a755, 0x80a755];
    if (n === 'spruce_leaves') return [0x619961, 0x619961];
    if (n === 'lily_pad') return [0x208030, 0x208030];
    if (n === 'filled_map') return [0xffffff, 0x8b6f4c];
    if (n === 'firework_star') return [0xffffff, stack.extra?.color ?? 0x8a8a8a];
    if (n === 'wolf_armor') return [0xffffff, stack.extra?.dyeColor ?? 0xffffff];
    if (n.endsWith('_bundle') || n === 'bundle') return [0xffffff, 0xffffff];
    return [0xffffff, 0xffffff];
  }

  private bakeBlockModel(model: BakedModel, tint: number[], display: any, guiLight: 'front' | 'side'): ItemMesh {
    const quads = model.quads;
    const buf = new ArrayBuffer(quads.length * 4 * VERTEX_STRIDE);
    const f32 = new Float32Array(buf), u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
    let vi = 0;
    for (const q of quads) {
      const shade = q.shade ? SHADE[q.face] : 1;
      const t = q.tint >= 0 ? tint[Math.min(q.tint, tint.length - 1)] : 0xffffff;
      const tr = ((t >> 16) & 255) / 255, tg = ((t >> 8) & 255) / 255, tb = (t & 255) / 255;
      for (let v = 0; v < 4; v++) {
        const o = vi * VERTEX_STRIDE;
        f32[o >> 2] = q.pos[v * 3] - 0.5; f32[(o >> 2) + 1] = q.pos[v * 3 + 1] - 0.5; f32[(o >> 2) + 2] = q.pos[v * 3 + 2] - 0.5;
        u16[(o + 12) >> 1] = Math.round(q.uv[v * 2] * 65535); u16[(o + 14) >> 1] = Math.round(q.uv[v * 2 + 1] * 65535);
        u8[o + 16] = tr * shade * 255; u8[o + 17] = tg * shade * 255; u8[o + 18] = tb * shade * 255; u8[o + 19] = 0xff;
        vi++;
      }
    }
    return { data: buf, quads: quads.length, flat: false, display: display ?? {}, guiLight };
  }

  /** Flat item: full-texture front/back quads plus 1px-deep edge quads (vanilla ItemModelGenerator). */
  private bakeFlat(layers: string[], tint: number[], display: any, itemName: string): ItemMesh {
    const verts: number[] = [];
    let quads = 0;
    const W = this.atlasData.width;
    const push = (x: number, y: number, z: number, u: number, v: number, r: number, g: number, b: number) => { verts.push(x, y, z, u, v, r, g, b); };
    for (let li = 0; li < layers.length; li++) {
      const tex = layers[li];
      const tile = this.assets.atlas.tiles[tex];
      if (!tile) continue;
      const t = li < tint.length ? tint[li] : 0xffffff;
      const tr = ((t >> 16) & 255) / 255, tg = ((t >> 8) & 255) / 255, tb = (t & 255) / 255;
      const tw = tile.w, th = Math.min(tile.h, tile.w);
      const u0 = tile.x / W, v0 = tile.y / this.atlasData.height, u1 = (tile.x + tw) / W, v1 = (tile.y + th) / this.atlasData.height;
      const zf = 0.5 - 1 / 32 - li * 0.001, zb = 0.5 + 1 / 32 + li * 0.001; // thickness 1/16 around z=0.5
      // front (facing -z is south? use +z front like vanilla generated model: south face has full uv, north mirrored)
      // south face (z = zb):
      push(0, 1, zb, u0, v0, tr, tg, tb); push(0, 0, zb, u0, v1, tr, tg, tb); push(1, 0, zb, u1, v1, tr, tg, tb); push(1, 1, zb, u1, v0, tr, tg, tb); quads++;
      // north face (z = zf): same texel at the same x as the south face, so nothing mirrored shows through transparent pixels
      push(1, 1, zf, u1, v0, tr, tg, tb); push(1, 0, zf, u1, v1, tr, tg, tb); push(0, 0, zf, u0, v1, tr, tg, tb); push(0, 1, zf, u0, v0, tr, tg, tb); quads++;
      // edges from pixel alpha
      const alpha = (px: number, py: number): boolean => {
        if (px < 0 || py < 0 || px >= tw || py >= th) return false;
        return this.atlasData.data[((tile.y + py) * W + tile.x + px) * 4 + 3] > 0;
      };
      const pw = 1 / tw, ph = 1 / th;
      for (let py = 0; py < th; py++) for (let px = 0; px < tw; px++) {
        if (!alpha(px, py)) continue;
        const x0 = px * pw, x1 = (px + 1) * pw, y1 = 1 - py * ph, y0 = 1 - (py + 1) * ph; // y up
        const uu0 = u0 + (u1 - u0) * (px / tw), uu1 = u0 + (u1 - u0) * ((px + 1) / tw), vv0 = v0 + (v1 - v0) * (py / th), vv1 = v0 + (v1 - v0) * ((py + 1) / th);
        const sh = 0.8;
        if (!alpha(px, py - 1)) { push(x0, y1, zf, uu0, vv0, tr * sh, tg * sh, tb * sh); push(x0, y1, zb, uu0, vv0, tr * sh, tg * sh, tb * sh); push(x1, y1, zb, uu1, vv0, tr * sh, tg * sh, tb * sh); push(x1, y1, zf, uu1, vv0, tr * sh, tg * sh, tb * sh); quads++; } // top edge
        if (!alpha(px, py + 1)) { push(x0, y0, zb, uu0, vv1, tr * 0.5, tg * 0.5, tb * 0.5); push(x0, y0, zf, uu0, vv1, tr * 0.5, tg * 0.5, tb * 0.5); push(x1, y0, zf, uu1, vv1, tr * 0.5, tg * 0.5, tb * 0.5); push(x1, y0, zb, uu1, vv1, tr * 0.5, tg * 0.5, tb * 0.5); quads++; }
        if (!alpha(px - 1, py)) { push(x0, y1, zf, uu0, vv0, tr * 0.6, tg * 0.6, tb * 0.6); push(x0, y0, zf, uu0, vv1, tr * 0.6, tg * 0.6, tb * 0.6); push(x0, y0, zb, uu0, vv1, tr * 0.6, tg * 0.6, tb * 0.6); push(x0, y1, zb, uu0, vv0, tr * 0.6, tg * 0.6, tb * 0.6); quads++; }
        if (!alpha(px + 1, py)) { push(x1, y1, zb, uu1, vv0, tr * 0.6, tg * 0.6, tb * 0.6); push(x1, y0, zb, uu1, vv1, tr * 0.6, tg * 0.6, tb * 0.6); push(x1, y0, zf, uu1, vv1, tr * 0.6, tg * 0.6, tb * 0.6); push(x1, y1, zf, uu1, vv0, tr * 0.6, tg * 0.6, tb * 0.6); quads++; }
      }
    }
    const buf = new ArrayBuffer(quads * 4 * VERTEX_STRIDE);
    const f32 = new Float32Array(buf), u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
    for (let i = 0; i < quads * 4; i++) {
      const o = i * VERTEX_STRIDE, s = i * 8;
      f32[o >> 2] = verts[s] - 0.5; f32[(o >> 2) + 1] = verts[s + 1] - 0.5; f32[(o >> 2) + 2] = verts[s + 2] - 0.5;
      u16[(o + 12) >> 1] = Math.round(verts[s + 3] * 65535); u16[(o + 14) >> 1] = Math.round(verts[s + 4] * 65535);
      u8[o + 16] = verts[s + 5] * 255; u8[o + 17] = verts[s + 6] * 255; u8[o + 18] = verts[s + 7] * 255; u8[o + 19] = 0xff;
    }
    const disp = Object.keys(display ?? {}).length ? display : (this.baker.resolve('item/generated')?.display ?? {});
    return { data: buf, quads, flat: true, display: disp, guiLight: 'front', texture: layers[0] };
  }

  /** Build a model matrix applying a vanilla display transform. */
  applyDisplay(out: Mat4, mesh: ItemMesh, kind: string, leftHand = false): Mat4 {
    const d = mesh.display[kind] ?? (kind === 'firstperson_lefthand' ? mesh.display.firstperson_righthand : kind === 'thirdperson_lefthand' ? mesh.display.thirdperson_righthand : undefined) ?? {};
    const rot = d.rotation ?? [0, 0, 0], tr = d.translation ?? [0, 0, 0], sc = d.scale ?? [1, 1, 1];
    // vanilla ItemTransform.apply(leftHand): x translation and y/z rotations are mirrored for the left hand
    const i = leftHand ? -1 : 1;
    mat4Identity(out);
    mat4Translate(out, out, i * tr[0] / 16, tr[1] / 16, tr[2] / 16);
    mat4RotateX(out, out, rot[0] * DEG); mat4RotateY(out, out, i * rot[1] * DEG); mat4RotateZ(out, out, i * rot[2] * DEG);
    mat4Scale(out, out, sc[0], sc[1], sc[2]);
    return out;
  }

  /** GUI icon (canvas) for an item; cached. Flat items copy their texture; block items render via GL. */
  icon(stack: ItemStack): HTMLCanvasElement {
    const key = stack.item.name + ':' + (stack.extra?.color ?? '') + ':' + (stack.extra?.dyeColor ?? '');
    let c = this.iconCache.get(key);
    if (c) return c;
    const mesh = this.getMesh(stack);
    c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    if (mesh.flat) {
      const modelName = this.resolveModelName(stack.item.name, stack).replace(/^minecraft:/, '');
      const resolved = this.baker.resolve(modelName);
      const tint = this.itemTint(stack);
      const layers: string[] = [];
      if (resolved) for (let i = 0; i < 5; i++) { const t = resolved.textures['layer' + i]; if (t) layers.push((typeof t === 'string' ? t : t.sprite).replace('minecraft:', '')); }
      if (!layers.length && mesh.texture) layers.push(mesh.texture);
      for (let li = 0; li < layers.length; li++) {
        const tile = this.assets.atlas.tiles[layers[li]];
        if (!tile) continue;
        const t = tint[Math.min(li, tint.length - 1)];
        const img = ctx.createImageData(16, 16);
        const th = Math.min(tile.h, tile.w);
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
          const sx = tile.x + Math.floor(x * tile.w / 16), sy = tile.y + Math.floor(y * th / 16);
          const si = (sy * this.atlasData.width + sx) * 4, di = (y * 16 + x) * 4;
          img.data[di] = this.atlasData.data[si] * ((t >> 16) & 255) / 255; img.data[di + 1] = this.atlasData.data[si + 1] * ((t >> 8) & 255) / 255; img.data[di + 2] = this.atlasData.data[si + 2] * (t & 255) / 255; img.data[di + 3] = this.atlasData.data[si + 3];
        }
        const tmp = document.createElement('canvas'); tmp.width = 16; tmp.height = 16; tmp.getContext('2d')!.putImageData(img, 0, 0);
        ctx.drawImage(tmp, 0, 0);
      }
    } else {
      this.renderIcon3D(mesh, c);
    }
    this.iconCache.set(key, c);
    return c;
  }

  private renderIcon3D(mesh: ItemMesh, target: HTMLCanvasElement): void {
    const gl = this.renderer.gl;
    const S = this.ICON;
    if (!this.fbo) {
      this.fbo = gl.createFramebuffer()!; this.fboTex = gl.createTexture()!; this.fboDepth = gl.createRenderbuffer()!;
      gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.fboDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, S, S);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.fboDepth);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, S, S);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // orthographic projection like vanilla GUI: item occupies 16 units, display.gui transform applied
    const proj = new Float32Array(16);
    mat4Ortho(proj, -0.5, 0.5, -0.5, 0.5, -10, 10);
    const savedVp = this.renderer.vp.slice();
    this.renderer.vp.set(proj);
    const model = new Float32Array(16);
    this.applyDisplay(model, mesh, 'gui');
    const sky = { fogColor: [0, 0, 0] as [number, number, number], fogStart: 1e6, fogEnd: 1e6 + 1 } as any;
    this.renderer.drawChunkFormatBuffer(mesh.data, mesh.quads, model, sky, { light: 0xff, alphaCut: 0.1, noFog: true, noCull: true });
    this.renderer.vp.set(savedVp);
    const px = new Uint8Array(S * S * 4);
    gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.renderer.canvas.width, this.renderer.canvas.height);
    // flip vertically into the canvas at 16x16 (downsample: nearest)
    target.width = S; target.height = S;
    const img = target.getContext('2d')!.createImageData(S, S);
    for (let y = 0; y < S; y++) img.data.set(px.subarray((S - 1 - y) * S * 4, (S - y) * S * 4), y * S * 4);
    target.getContext('2d')!.putImageData(img, 0, 0);
  }

  /** Light index for an item rendered in the world (sky<<4|block). */
  static packLight(sky: number, block: number): number { return (sky << 4) | block; }
}

export { DYE_COLORS, mat4Mul };
