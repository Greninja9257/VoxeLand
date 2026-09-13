// Weather: rain/thunder cycles, precipitation rendering, lightning.
import type { Game } from './game';
import type { World } from '../world/world';
import { BIOMES } from '../world/gen/biomes';
import { VERTEX_STRIDE } from '../render/mesher';
import { mat4Identity } from '../math';
import type { SkyState } from '../render/sky';

const IDENTITY = mat4Identity(new Float32Array(16));

export class Weather {
  raining = false; thundering = false;
  rainTime = 12000 + Math.floor(Math.random() * 168000);
  thunderTime = 12000 + Math.floor(Math.random() * 168000);
  rainLevel = 0; thunderLevel = 0; prevRainLevel = 0;
  private buf = new ArrayBuffer(2000 * 4 * VERTEX_STRIDE);
  private lightningFlash = 0;
  constructor(private game: Game) {}

  get rainStrength(): number { return this.rainLevel; }

  tick(): void {
    const g = this.game;
    if (g.world.dimension !== 'overworld') { this.rainLevel = 0; this.thunderLevel = 0; return; }
    if (g.rules.doWeatherCycle !== false) {
      if (--this.thunderTime <= 0) { this.thundering = !this.thundering; this.thunderTime = this.thundering ? 3600 + Math.floor(Math.random() * 12000) : 12000 + Math.floor(Math.random() * 168000); if (this.thundering) this.raining = true; }
      if (--this.rainTime <= 0) { this.raining = !this.raining; this.rainTime = this.raining ? 12000 + Math.floor(Math.random() * 12000) : 12000 + Math.floor(Math.random() * 168000); }
    }
    this.prevRainLevel = this.rainLevel;
    this.rainLevel = Math.max(0, Math.min(1, this.rainLevel + (this.raining ? 0.01 : -0.01)));
    this.thunderLevel = Math.max(0, Math.min(1, this.thunderLevel + (this.thundering ? 0.01 : -0.01)));
    if (this.lightningFlash > 0) this.lightningFlash--;
    // lightning strikes
    if (this.thunderLevel > 0.9 && Math.random() < 1 / 100000 * 20 && g.player) {
      const x = Math.floor(g.player.x + (Math.random() - 0.5) * 128), z = Math.floor(g.player.z + (Math.random() - 0.5) * 128);
      if (g.world.isLoaded(x, z) && this.biomeRains(g.world, x, z)) this.strikeLightning(x, g.world.getHeight(x, z), z);
    }
    this.tickRainSound();
    // fill cauldrons / extinguish fire near the player
    if (this.rainLevel > 0.5 && g.world.time % 20 === 0 && g.player) {
      const px = Math.floor(g.player.x), pz = Math.floor(g.player.z);
      for (let i = 0; i < 4; i++) {
        const x = px + Math.floor((Math.random() - 0.5) * 32), z = pz + Math.floor((Math.random() - 0.5) * 32);
        const y = g.world.getHeight(x, z) - 1;
        const s = g.world.getBlock(x, y, z);
        if (!s || !this.biomeRains(g.world, x, z)) continue;
        const n = g.registry.nameOf(s);
        if (n === 'cauldron' && Math.random() < 0.05) g.world.setBlock(x, y, z, g.registry.stateWith(g.registry.blockByName('water_cauldron')!, { level: '1' }));
        else if (n === 'water_cauldron' && Math.random() < 0.05 && g.registry.getProps(s).level !== '3') g.world.setBlock(x, y, z, g.registry.withProp(s, 'level', String(+g.registry.getProps(s).level + 1)));
        else if (n === 'fire') g.world.setBlock(x, y, z, 0);
        else if (n === 'campfire' && g.registry.getProps(s).lit === 'true') g.world.setBlock(x, y, z, g.registry.withProp(s, 'lit', 'false'));
        const biome = BIOMES[g.world.getBiome(x, z)];
        if (biome.precipitation === 'snow' && (s === 0 || g.registry.isAir(s)) === false && Math.random() < 0.1) { const above = g.world.getBlock(x, y + 1, z); if (above === 0 && g.registry.fullCube[s]) g.world.setBlock(x, y + 1, z, g.registry.defaultState('snow')); if (n === 'water' && g.registry.fluidLevel(s) === 0) g.world.setBlock(x, y, z, g.registry.defaultState('ice')); }
      }
    }
  }

  private rainSoundTime = 0;
  /** vanilla LevelRenderer.tickRain: short rain clips are played at random rained-on surface positions near the camera. */
  private tickRainSound(): void {
    const g = this.game, p = g.player;
    if (!p || this.rainLevel <= 0 || g.world.dimension !== 'overworld') return;
    const cx = Math.floor(p.x), cy = Math.floor(p.eyeY), cz = Math.floor(p.z);
    let found: [number, number, number] | null = null;
    for (let i = 0; i < 100 && !found; i++) {
      const x = cx + Math.floor(Math.random() * 21) - 10, z = cz + Math.floor(Math.random() * 21) - 10;
      if (!g.world.isLoaded(x, z)) continue;
      const y = g.world.getHeight(x, z);
      if (y > cy - 10 && y < cy + 10 && this.isRainingAt(g.world, x, y, z)) found = [x, y, z];
    }
    if (found && Math.floor(Math.random() * 3) < this.rainSoundTime++) {
      this.rainSoundTime = 0;
      const [x, y, z] = found;
      if (y > cy + 1 && g.world.getHeight(cx, cz) > cy) g.sounds.playAt('weather.rain.above', x + 0.5, y, z + 0.5, 0.1, 0.5);
      else g.sounds.playAt('weather.rain', x + 0.5, y, z + 0.5, 0.2, 1);
    }
  }

  biomeRains(world: World, x: number, z: number): boolean { return BIOMES[world.getBiome(x, z)].precipitation !== 'none'; }

  isRainingAt(world: World, x: number, y: number, z: number): boolean {
    if (this.rainLevel <= 0 || world.dimension !== 'overworld') return false;
    const bx = Math.floor(x), bz = Math.floor(z);
    if (!this.biomeRains(world, bx, bz)) return false;
    return world.getHeight(bx, bz) <= y + 0.5 && BIOMES[world.getBiome(bx, bz)].precipitation === 'rain';
  }

  strikeLightning(x: number, y: number, z: number): void {
    const g = this.game;
    this.lightningFlash = 4;
    g.sounds.playAt('entity.lightning_bolt.thunder', x, y, z, 10000, 0.8 + Math.random() * 0.2);
    g.sounds.playAt('entity.lightning_bolt.impact', x, y, z, 2, 0.5 + Math.random() * 0.2);
    if (g.rules.doFireTick !== false && g.world.getBlock(x, y, z) === 0) g.world.setBlock(x, y, z, g.blocks.fireStateFor(x, y, z));
    for (const e of g.livingEntitiesIncludingPlayer()) if (e.distSq(x, y, z) < 9) { e.hurt({ amount: 5, source: 'lightning' }); e.fireTicks = 160; if ((e as any).type === 'creeper') (e as any).charged = true; if ((e as any).type === 'villager') g.spawnMob('witch', e.x, e.y, e.z), e.remove(); if ((e as any).type === 'pig') g.spawnMob('zombified_piglin', e.x, e.y, e.z), e.remove(); }
    // lightning rods
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) for (let dy = -4; dy <= 8; dy++) { const s = g.world.getBlock(x + dx, y + dy, z + dz); if (s && g.registry.nameOf(s) === 'lightning_rod') { g.world.setBlock(x + dx, y + dy, z + dz, g.registry.withProp(s, 'powered', 'true')); g.world.scheduleTick(x + dx, y + dy, z + dz, 8); g.redstone.sourceChanged(x + dx, y + dy, z + dz); } }
    g.lightningBolts.push({ x, y, z, life: 6 });
  }

  get flash(): number { return this.lightningFlash; }

  /** Render precipitation around the camera. */
  draw(sky: SkyState, partial: number, timeSec: number): void {
    const g = this.game;
    const level = this.prevRainLevel + (this.rainLevel - this.prevRainLevel) * partial;
    if (level <= 0 || g.world.dimension !== 'overworld') return;
    const cam = g.renderer.camera; const cb = g.renderer.camBase;
    const cx = Math.floor(cam.x), cz = Math.floor(cam.z);
    const R = 10;
    const rain = g.assets.atlas.tiles['environment/rain'], snow = g.assets.atlas.tiles['environment/snow'];
    if (!rain || !snow) return;
    const W = g.assets.atlas.width, H = g.assets.atlas.height;
    const f32 = new Float32Array(this.buf), u16 = new Uint16Array(this.buf), u8 = new Uint8Array(this.buf);
    let vi = 0, quads = 0;
    const yaw = cam.yaw * Math.PI / 180;
    const rx = Math.cos(yaw), rz = Math.sin(yaw); // camera right; quads face the camera
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
      const x = cx + dx, z = cz + dz;
      if (dx * dx + dz * dz > R * R) continue;
      const biome = BIOMES[g.world.getBiome(x, z)];
      if (biome.precipitation === 'none') continue;
      const snowy = biome.precipitation === 'snow' || (cam.y > 150 && biome.temperature < 0.5);
      const ground = g.world.getHeight(x, z);
      const y0 = Math.max(ground, Math.floor(cam.y) - 5), y1 = Math.max(y0 + 1, Math.min(Math.floor(cam.y) + 10, ground + 20));
      if (y1 <= y0) continue;
      const tile = snowy ? snow : rain;
      const scroll = snowy ? (timeSec * 0.4 + (x * 7 + z * 13) % 4) : (timeSec * 8 + (x * 7 + z * 13) % 4);
      const v0 = tile.y / H, vh = tile.h / H;
      const u0 = tile.x / W, u1 = (tile.x + tile.w) / W;
      const l = g.world.getLight(x, y0, z);
      const alpha = level * (snowy ? 0.8 : 0.6);
      const dist = Math.sqrt(dx * dx + dz * dz);
      const a = Math.round(255 * alpha * Math.max(0, 1 - dist / R));
      const px = x + 0.5 - cb[0], pz = z + 0.5 - cb[2];
      // the atlas cannot repeat, so the column is split wherever the 4-block texture wraps
      const sf = (scroll % 4) / 4; // texture phase at the top of the column
      let top = y1, t = sf;
      while (top > y0 && quads < 2000) {
        const segH = Math.min(top - y0, (1 - t) * 4);
        const bottom = top - segH, tb = t + segH / 4;
        const va = v0 + t * vh, vb = v0 + tb * vh;
        const corners = [[-0.5, bottom, u0, vb], [-0.5, top, u0, va], [0.5, top, u1, va], [0.5, bottom, u1, vb]];
        for (const [c, y, u, v] of corners) {
          const o = vi * VERTEX_STRIDE;
          f32[o >> 2] = px + rx * c; f32[(o >> 2) + 1] = y - cb[1]; f32[(o >> 2) + 2] = pz + rz * c;
          u16[(o + 12) >> 1] = u * 65535; u16[(o + 14) >> 1] = v * 65535;
          u8[o + 16] = a; u8[o + 17] = a; u8[o + 18] = a; u8[o + 19] = l;
          vi++;
        }
        quads++;
        top = bottom; t = 0;
      }
      if (quads >= 2000) break;
    }
    if (!quads) return;
    const gl = g.renderer.gl;
    gl.depthMask(false);
    g.renderer.drawChunkFormatBuffer(this.buf.slice(0, quads * 4 * VERTEX_STRIDE), quads, IDENTITY, sky, { alphaCut: 0.01, noCull: true, blend: true, colorMul: [1, 1, 1, 1] });
    gl.depthMask(true);
    // rain splash particles
    if (Math.random() < level * 0.5) { const sx = cam.x + (Math.random() - 0.5) * 16, sz = cam.z + (Math.random() - 0.5) * 16; const gy = g.world.getHeight(Math.floor(sx), Math.floor(sz)); if (this.isRainingAt(g.world, sx, gy, sz)) g.particles.spawnRain(sx, gy + 0.1, sz); }
  }

  serialize(): any { return { raining: this.raining, thundering: this.thundering, rainTime: this.rainTime, thunderTime: this.thunderTime, rainLevel: this.rainLevel, thunderLevel: this.thunderLevel }; }
  deserialize(d: any): void { if (!d) return; this.raining = !!d.raining; this.thundering = !!d.thundering; this.rainTime = d.rainTime ?? this.rainTime; this.thunderTime = d.thunderTime ?? this.thunderTime; this.rainLevel = d.rainLevel ?? 0; this.thunderLevel = d.thunderLevel ?? 0; }
}
