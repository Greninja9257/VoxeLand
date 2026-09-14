// Particle system: camera-facing quads batched into one chunk-format buffer per frame.
import type { Game } from '../game/game';
import { VERTEX_STRIDE } from './mesher';
import type { SkyState } from './sky';
import { mat4Identity } from '../math';
import type { AtlasTile } from '../assets';

interface Particle {
  x: number; y: number; z: number; px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  age: number; life: number;
  size: number; gravity: number; drag: number;
  r: number; g: number; b: number; alpha: number;
  u0: number; v0: number; u1: number; v1: number;
  frames?: string[]; // animated texture names
  physics: boolean;
  fullBright: boolean;
  fade: boolean;
  grow?: number;
  kind: string;
}

const IDENTITY = mat4Identity(new Float32Array(16));

export class Particles {
  list: Particle[] = [];
  private buf = new ArrayBuffer(4096 * 4 * VERTEX_STRIDE);
  max = 4000;
  constructor(private game: Game) {}

  private tile(name: string): AtlasTile | undefined { return this.game.assets.atlas.tiles[name]; }
  private uv(name: string): [number, number, number, number] {
    const t = this.tile(name);
    const W = this.game.assets.atlas.width, H = this.game.assets.atlas.height;
    if (!t) return [0, 0, 0, 0];
    return [t.x / W, t.y / H, (t.x + t.w) / W, (t.y + Math.min(t.h, t.w)) / H];
  }

  private add(p: Partial<Particle> & { x: number; y: number; z: number }): Particle | null {
    if (this.list.length >= this.max) return null;
    // Particles option: Decreased drops most cosmetic particles, Minimal keeps only a few
    const lvl = this.game.options.particles;
    if (lvl > 0 && p.kind !== 'rain' && p.kind !== 'explosion') { if (lvl === 2 && Math.random() < 0.9) return null; if (lvl === 1 && Math.random() < 0.5) return null; }
    const q: Particle = { px: p.x, py: p.y, pz: p.z, vx: 0, vy: 0, vz: 0, age: 0, life: 20, size: 0.1, gravity: 0, drag: 0.98, r: 1, g: 1, b: 1, alpha: 1, u0: 0, v0: 0, u1: 0, v1: 0, physics: true, fullBright: false, fade: false, kind: 'generic', ...p };
    this.list.push(q);
    return q;
  }

  /** Block breaking particles (vanilla: 4x4x4 grid of block texture fragments). */
  spawnBlockBreak(bx: number, by: number, bz: number, state: number): void {
    const model = this.game.baker.firstModel(state);
    const tex = model?.particle ?? 'block/stone';
    const [u0, v0, u1, v1] = this.uv(tex);
    const tint = this.game.blockParticleTint(state, bx, bz);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) {
      const x = bx + (i + 0.5) / 4, y = by + (j + 0.5) / 4, z = bz + (k + 0.5) / 4;
      this.spawnCrack(x, y, z, x - bx - 0.5, y - by - 0.5, z - bz - 0.5, u0, v0, u1, v1, tint);
    }
  }
  /** vanilla LivingEntity.spawnItemParticles: bits of the eaten item fly out of the mouth towards the ground. */
  spawnItemCrumbs(e: { x: number; y: number; z: number; eyeY: number; yaw: number; pitch: number; width: number }, stack: any, count: number): void {
    const mesh = this.game.itemRenderer.getMesh(stack);
    const tex = (mesh as any).texture ?? ('item/' + stack.item.name);
    const tile = this.tile(tex) ?? this.tile('block/' + stack.item.name);
    if (!tile) return;
    const W = this.game.assets.atlas.width, H = this.game.assets.atlas.height;
    for (let i = 0; i < count; i++) {
      // random 4x4 px patch of the item texture
      const px = Math.floor(Math.random() * 12), py = Math.floor(Math.random() * 12);
      const u0 = (tile.x + px) / W, v0 = (tile.y + py) / H, u1 = (tile.x + px + 4) / W, v1 = (tile.y + py + 4) / H;
      let vx = (Math.random() - 0.5) * 0.1, vy = Math.random() * 0.1 + 0.1, vz = 0;
      // rotate by pitch/yaw like vanilla and push 0.3 in front of the mouth
      const pr = -e.pitch * Math.PI / 180, yr = -e.yaw * Math.PI / 180;
      let x = (Math.random() - 0.5) * 0.3, y = -Math.random() * 0.6 - 0.3, z = 0.6;
      { const cy = Math.cos(pr), sy = Math.sin(pr); const y2 = y * cy - z * sy, z2 = y * sy + z * cy; y = y2; z = z2; const vy2 = vy * cy - vz * sy, vz2 = vy * sy + vz * cy; vy = vy2; vz = vz2; }
      { const c = Math.cos(yr), sn = Math.sin(yr); const x2 = x * c - z * sn, z2 = x * sn + z * c; x = x2; z = z2; const vx2 = vx * c - vz * sn, vz2 = vx * sn + vz * c; vx = vx2; vz = vz2; }
      const p = this.add({ x: e.x + x, y: e.eyeY + y, z: e.z + z, kind: 'crumb', u0, v0, u1, v1, size: 0.08, life: 10 + Math.floor(Math.random() * 10), gravity: 0.04, drag: 0.98, r: 1, g: 1, b: 1, physics: true });
      if (p) { p.vx = vx; p.vy = vy + 0.05; p.vz = vz; }
    }
  }
  spawnBlockHit(bx: number, by: number, bz: number, face: number, state: number): void {
    const model = this.game.baker.firstModel(state);
    const [u0, v0, u1, v1] = this.uv(model?.particle ?? 'block/stone');
    const tint = this.game.blockParticleTint(state, bx, bz);
    let x = bx + Math.random(), y = by + Math.random(), z = bz + Math.random();
    const o = 0.1;
    if (face === 0) y = by - o; if (face === 1) y = by + 1 + o; if (face === 2) z = bz - o; if (face === 3) z = bz + 1 + o; if (face === 4) x = bx - o; if (face === 5) x = bx + 1 + o;
    this.spawnCrack(x, y, z, 0, 0, 0, u0, v0, u1, v1, tint);
  }
  private spawnCrack(x: number, y: number, z: number, dx: number, dy: number, dz: number, u0: number, v0: number, u1: number, v1: number, tint: number): void {
    const su = Math.random() * 0.75, sv = Math.random() * 0.75;
    const sh = 0.6 + Math.random() * 0.4;
    const p = this.add({ x, y, z, kind: 'crack', size: 0.1 * (0.5 + Math.random() * 0.5), gravity: 0.04, life: 10 + Math.floor(Math.random() * 20), u0: u0 + (u1 - u0) * su, v0: v0 + (v1 - v0) * sv, u1: u0 + (u1 - u0) * (su + 0.25), v1: v0 + (v1 - v0) * (sv + 0.25), r: sh * ((tint >> 16) & 255) / 255, g: sh * ((tint >> 8) & 255) / 255, b: sh * (tint & 255) / 255 });
    if (!p) return;
    const sp = (Math.random() + Math.random() + 1) * 0.15;
    const l = Math.hypot(dx, dy, dz) || 1;
    p.vx = (dx / l + (Math.random() - 0.5) * 0.4) * sp * 0.4; p.vy = (dy / l + (Math.random() - 0.5) * 0.4) * sp * 0.4 + 0.1; p.vz = (dz / l + (Math.random() - 0.5) * 0.4) * sp * 0.4;
  }
  spawnItemBreak(x: number, y: number, z: number, itemName: string, n: number): void {
    const [u0, v0, u1, v1] = this.uv(this.tile('item/' + itemName) ? 'item/' + itemName : 'block/' + itemName);
    for (let i = 0; i < n; i++) { this.spawnCrack(x + (Math.random() - 0.5) * 0.3, y, z + (Math.random() - 0.5) * 0.3, Math.random() - 0.5, Math.random(), Math.random() - 0.5, u0, v0, u1, v1, 0xffffff); }
  }
  spawnSmoke(x: number, y: number, z: number, n: number, big = false): void {
    for (let i = 0; i < n; i++) {
      const fr = big ? Array.from({ length: 12 }, (_, k) => `particle/big_smoke_${11 - k}`) : Array.from({ length: 8 }, (_, k) => `particle/generic_${7 - k}`);
      const p = this.add({ x: x + (Math.random() - 0.5) * 0.5, y: y + (Math.random() - 0.5) * 0.3, z: z + (Math.random() - 0.5) * 0.5, kind: 'smoke', frames: fr, size: (big ? 0.25 : 0.12) * (0.8 + Math.random() * 0.4), life: 20 + Math.floor(Math.random() * 20), gravity: -0.004, drag: 0.96, r: 0.3 + Math.random() * 0.3, g: 0.3 + Math.random() * 0.3, b: 0.3 + Math.random() * 0.3, physics: false });
      if (p) { p.vx = (Math.random() - 0.5) * 0.02; p.vy = 0.02 + Math.random() * 0.02; p.vz = (Math.random() - 0.5) * 0.02; }
    }
  }
  spawnFlame(x: number, y: number, z: number): void { const [u0, v0, u1, v1] = this.uv('particle/flame'); const p = this.add({ x, y, z, kind: 'flame', u0, v0, u1, v1, size: 0.08, life: 30 + Math.floor(Math.random() * 20), gravity: 0, drag: 0.96, fullBright: true, physics: false }); if (p) { p.vx = (Math.random() - 0.5) * 0.01; p.vy = 0.01; p.vz = (Math.random() - 0.5) * 0.01; } }
  spawnCrit(x: number, y: number, z: number, n: number): void { const [u0, v0, u1, v1] = this.uv('particle/critical_hit'); for (let i = 0; i < n; i++) { const p = this.add({ x, y, z, kind: 'crit', u0, v0, u1, v1, size: 0.1, life: 10 + Math.floor(Math.random() * 10), gravity: 0.02, drag: 0.9, fade: true }); if (p) { p.vx = (Math.random() - 0.5) * 0.3; p.vy = Math.random() * 0.3; p.vz = (Math.random() - 0.5) * 0.3; } } }
  spawnHappyVillager(x: number, y: number, z: number, n: number): void { const [u0, v0, u1, v1] = this.uv('particle/glint'); for (let i = 0; i < n; i++) this.add({ x: x + (Math.random() - 0.5), y: y + Math.random(), z: z + (Math.random() - 0.5), kind: 'happy', u0, v0, u1, v1, size: 0.1, life: 20 + Math.floor(Math.random() * 10), gravity: -0.002, physics: false, r: 0.5, g: 1, b: 0.5, fullBright: true }); }
  spawnHeart(x: number, y: number, z: number, n = 1): void { const [u0, v0, u1, v1] = this.uv('particle/heart'); for (let i = 0; i < n; i++) { const p = this.add({ x: x + (Math.random() - 0.5), y: y + Math.random() * 0.5, z: z + (Math.random() - 0.5), kind: 'heart', u0, v0, u1, v1, size: 0.15, life: 16 + Math.floor(Math.random() * 6), gravity: -0.002, physics: false, fullBright: true }); if (p) p.vy = 0.05; } }
  spawnNote(x: number, y: number, z: number, hue: number): void { const [u0, v0, u1, v1] = this.uv('particle/note'); const c = hsv(hue, 1, 1); const p = this.add({ x, y, z, kind: 'note', u0, v0, u1, v1, size: 0.15, life: 6 + Math.floor(Math.random() * 6), gravity: -0.002, physics: false, fullBright: true, r: c[0], g: c[1], b: c[2] }); if (p) p.vy = 0.1; }
  spawnDragonBreath(x: number, y: number, z: number): void { const [u0, v0, u1, v1] = this.uv('particle/effect_0'); const p = this.add({ x, y, z, kind: 'breath', u0, v0, u1, v1, size: 0.15, life: 20 + Math.floor(Math.random() * 20), gravity: 0, drag: 0.96, physics: false, r: 0.75, g: 0.3, b: 0.9, fade: true, fullBright: true }); if (p) { p.vx = (Math.random() - 0.5) * 0.02; p.vy = 0.02 + Math.random() * 0.02; p.vz = (Math.random() - 0.5) * 0.02; } }
  spawnPortal(x: number, y: number, z: number, n: number): void { const [u0, v0, u1, v1] = this.uv('particle/glitter_0'); for (let i = 0; i < n; i++) { const p = this.add({ x: x + (Math.random() - 0.5) * 2, y: y + Math.random() * 2, z: z + (Math.random() - 0.5) * 2, kind: 'portal', u0, v0, u1, v1, size: 0.1, life: 20 + Math.floor(Math.random() * 20), gravity: 0, physics: false, r: 0.8, g: 0.3, b: 1, fullBright: true }); if (p) { p.vx = (x - p.x) * 0.05; p.vy = (y + 1 - p.y) * 0.05; p.vz = (z - p.z) * 0.05; } } }
  spawnSplash(x: number, y: number, z: number, color: number): void { const [u0, v0, u1, v1] = this.uv('particle/effect_0'); for (let i = 0; i < 30; i++) { const p = this.add({ x, y, z, kind: 'splash', u0, v0, u1, v1, size: 0.12, life: 15 + Math.floor(Math.random() * 10), gravity: 0.01, r: ((color >> 16) & 255) / 255, g: ((color >> 8) & 255) / 255, b: (color & 255) / 255, fade: true }); if (p) { p.vx = (Math.random() - 0.5) * 0.4; p.vy = Math.random() * 0.3; p.vz = (Math.random() - 0.5) * 0.4; } } }
  spawnBubble(x: number, y: number, z: number): void { const [u0, v0, u1, v1] = this.uv('particle/bubble'); const p = this.add({ x, y, z, kind: 'bubble', u0, v0, u1, v1, size: 0.08, life: 8 + Math.floor(Math.random() * 20), gravity: -0.005, physics: false }); if (p) p.vy = 0.05; }
  spawnPoof(x: number, y: number, z: number, n: number): void { for (let i = 0; i < n; i++) { const fr = Array.from({ length: 8 }, (_, k) => `particle/generic_${7 - k}`); const p = this.add({ x: x + (Math.random() - 0.5), y: y + (Math.random() - 0.5), z: z + (Math.random() - 0.5), kind: 'poof', frames: fr, size: 0.2, life: 10 + Math.floor(Math.random() * 10), gravity: 0, drag: 0.9, r: 0.9, g: 0.9, b: 0.9, physics: false }); if (p) { p.vx = (Math.random() - 0.5) * 0.2; p.vy = (Math.random() - 0.5) * 0.2; p.vz = (Math.random() - 0.5) * 0.2; } } }
  spawnExplosion(x: number, y: number, z: number, power: number): void {
    const fr = Array.from({ length: 16 }, (_, k) => `particle/explosion_${k}`);
    this.add({ x, y, z, kind: 'explosion', frames: fr, size: power * 0.6, life: 16, gravity: 0, physics: false, fullBright: true });
    for (let i = 0; i < power * 8; i++) { const p = this.add({ x: x + (Math.random() - 0.5) * power, y: y + (Math.random() - 0.5) * power, z: z + (Math.random() - 0.5) * power, kind: 'explosion', frames: fr, size: 0.4 + Math.random() * 0.6, life: 12 + Math.floor(Math.random() * 6), gravity: 0, physics: false, fullBright: true }); if (p) { p.vx = (Math.random() - 0.5) * 0.1; p.vy = (Math.random() - 0.5) * 0.1; p.vz = (Math.random() - 0.5) * 0.1; } }
    this.spawnSmoke(x, y, z, power * 6, true);
  }
  spawnSweep(x: number, y: number, z: number): void { const fr = Array.from({ length: 8 }, (_, k) => `particle/sweep_${k}`); this.add({ x, y, z, kind: 'sweep', frames: fr, size: 0.8, life: 4, gravity: 0, physics: false, fullBright: true }); }
  spawnDust(x: number, y: number, z: number, color: number): void { const [u0, v0, u1, v1] = this.uv('particle/generic_0'); this.add({ x, y, z, kind: 'dust', u0, v0, u1, v1, size: 0.08, life: 20, gravity: 0, physics: false, fullBright: true, r: ((color >> 16) & 255) / 255, g: ((color >> 8) & 255) / 255, b: (color & 255) / 255 }); }
  spawnDrip(x: number, y: number, z: number, water: boolean): void { const [u0, v0, u1, v1] = this.uv('particle/drip_hang'); const p = this.add({ x, y, z, kind: 'drip', u0, v0, u1, v1, size: 0.08, life: 40, gravity: 0.01, r: water ? 0.3 : 1, g: water ? 0.5 : 0.3, b: water ? 1 : 0, fullBright: !water }); void p; }
  spawnRain(x: number, y: number, z: number): void { const [u0, v0, u1, v1] = this.uv('particle/splash_0'); const p = this.add({ x, y, z, kind: 'rain', u0, v0, u1, v1, size: 0.08, life: 6, gravity: 0.03, r: 0.6, g: 0.7, b: 1, physics: false }); if (p) { p.vx = (Math.random() - 0.5) * 0.2; p.vy = 0.15; p.vz = (Math.random() - 0.5) * 0.2; } }
  spawnCampfireSmoke(x: number, y: number, z: number, signal: boolean): void { const fr = Array.from({ length: 12 }, (_, k) => `particle/big_smoke_${11 - k}`); const p = this.add({ x: x + (Math.random() - 0.5) * 0.3, y, z: z + (Math.random() - 0.5) * 0.3, kind: 'smoke', frames: fr, size: 0.3, life: signal ? 300 : 120, gravity: -0.0002, drag: 0.999, r: 0.7, g: 0.7, b: 0.7, physics: false }); if (p) { p.vy = 0.05 + Math.random() * 0.02; p.vx = (Math.random() - 0.5) * 0.005; p.vz = (Math.random() - 0.5) * 0.005; } }
  spawnEnchant(x: number, y: number, z: number): void { const [u0, v0, u1, v1] = this.uv('particle/sga_a'); const p = this.add({ x: x + (Math.random() - 0.5) * 3, y: y + Math.random() * 2, z: z + (Math.random() - 0.5) * 3, kind: 'ench', u0, v0, u1, v1, size: 0.08, life: 30, gravity: 0, physics: false, fullBright: true, r: 0.8, g: 0.8, b: 1 }); if (p) { p.vx = (x - p.x) * 0.03; p.vy = (y + 0.5 - p.y) * 0.03; p.vz = (z - p.z) * 0.03; } }
  spawnTotem(x: number, y: number, z: number): void { const [u0, v0, u1, v1] = this.uv('particle/glint'); for (let i = 0; i < 100; i++) { const p = this.add({ x, y, z, kind: 'totem', u0, v0, u1, v1, size: 0.12, life: 40 + Math.floor(Math.random() * 30), gravity: 0.003, drag: 0.95, fullBright: true, r: Math.random() < 0.5 ? 0.4 : 1, g: 1, b: 0.3, fade: true }); if (p) { p.vx = (Math.random() - 0.5) * 0.6; p.vy = Math.random() * 0.6; p.vz = (Math.random() - 0.5) * 0.6; } } }

  tick(): void {
    const reg = this.game.registry, world = this.game.world;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.px = p.x; p.py = p.y; p.pz = p.z;
      p.age++;
      if (p.age >= p.life) { this.list[i] = this.list[this.list.length - 1]; this.list.pop(); continue; }
      p.vy -= p.gravity;
      if (p.physics) {
        // simple block collision
        const nx = p.x + p.vx, ny = p.y + p.vy, nz = p.z + p.vz;
        const solid = (x: number, y: number, z: number) => { const s = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)); return s !== 0 && reg.collisionBoxes(s).length > 0; };
        if (solid(p.x, ny, p.z)) { p.vy = 0; p.vx *= 0.7; p.vz *= 0.7; } else p.y = ny;
        if (!solid(nx, p.y, p.z)) p.x = nx; else p.vx = 0;
        if (!solid(p.x, p.y, nz)) p.z = nz; else p.vz = 0;
      } else { p.x += p.vx; p.y += p.vy; p.z += p.vz; }
      p.vx *= p.drag; p.vy *= p.drag; p.vz *= p.drag;
      if (p.frames) { const f = p.frames[Math.min(p.frames.length - 1, Math.floor(p.age / p.life * p.frames.length))]; [p.u0, p.v0, p.u1, p.v1] = this.uv(f); }
      if (p.grow) p.size += p.grow;
    }
  }

  draw(sky: SkyState, partial: number): void {
    const n = this.list.length;
    if (!n) return;
    const need = n * 4 * VERTEX_STRIDE;
    if (this.buf.byteLength < need) this.buf = new ArrayBuffer(need * 2);
    const f32 = new Float32Array(this.buf), u16 = new Uint16Array(this.buf), u8 = new Uint8Array(this.buf);
    const cam = this.game.renderer.camera; const cb = this.game.renderer.camBase;
    const yaw = cam.yaw * Math.PI / 180, pitch = cam.pitch * Math.PI / 180;
    // camera right & up vectors
    const rx = Math.cos(yaw), rz = Math.sin(yaw);
    const ux = -Math.sin(yaw) * Math.sin(pitch) * -1, uy = Math.cos(pitch), uz = Math.cos(yaw) * Math.sin(pitch) * -1;
    let vi = 0;
    let quads = 0;
    const world = this.game.world;
    for (let i = 0; i < n; i++) {
      const p = this.list[i];
      const x = p.px + (p.x - p.px) * partial - cb[0], y = p.py + (p.y - p.py) * partial - cb[1], z = p.pz + (p.z - p.pz) * partial - cb[2];
      const s = p.size;
      const a = p.fade ? 1 - p.age / p.life : 1;
      const l = p.fullBright ? 0xff : world.getLight(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      const corners = [[-1, -1, p.u0, p.v1], [-1, 1, p.u0, p.v0], [1, 1, p.u1, p.v0], [1, -1, p.u1, p.v1]];
      for (const [cx, cy, u, v] of corners) {
        const o = vi * VERTEX_STRIDE;
        f32[o >> 2] = x + (rx * cx + ux * cy) * s; f32[(o >> 2) + 1] = y + (uy * cy) * s; f32[(o >> 2) + 2] = z + (rz * cx + uz * cy) * s;
        u16[(o + 12) >> 1] = u * 65535; u16[(o + 14) >> 1] = v * 65535;
        u8[o + 16] = p.r * 255 * a; u8[o + 17] = p.g * 255 * a; u8[o + 18] = p.b * 255 * a; u8[o + 19] = l;
        vi++;
      }
      quads++;
    }
    this.game.renderer.drawChunkFormatBuffer(this.buf.slice(0, quads * 4 * VERTEX_STRIDE), quads, IDENTITY, sky, { alphaCut: 0.05, noCull: true, blend: true });
  }
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (i % 6) { case 0: return [v, t, p]; case 1: return [q, v, p]; case 2: return [p, v, t]; case 3: return [p, q, v]; case 4: return [t, p, v]; default: return [v, p, q]; }
}
