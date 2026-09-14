// Natural mob spawning (hostile at night/dark, passive on grass, water mobs, ambient bats, phantoms).
import type { Game } from './game';
import { Mob, MOB_DEFS } from '../entity/mobs';
import { EndCrystalEntity } from '../entity/boss';
import { BIOMES } from '../world/gen/biomes';
import type { Chunk } from '../world/chunk';
import { SEA_LEVEL } from '../world/chunk';

const CAPS = { hostile: 70, passive: 10, water: 5, ambient: 15 };

export class Spawner {
  constructor(private game: Game) {}

  /** Called every tick. */
  tick(): void {
    const g = this.game;
    if (g.world.time % 1 !== 0) return;
    const p = g.player;
    if (!p || p.removed) return;
    const chunks = g.world.chunks.size;
    const scale = Math.max(1, chunks) / 289;
    const counts = { hostile: 0, passive: 0, water: 0, ambient: 0 };
    for (const e of g.entities) if (e instanceof Mob && !e.removed) { const c = e.def.category === 'neutral' ? (e.hostile ? 'hostile' : 'passive') : e.def.category; if (e.type === 'enderman' || e.type === 'zombified_piglin' || e.type === 'wolf' && e.angerTicks > 0) counts.hostile++; else (counts as any)[c]++; }
    const peaceful = g.difficulty === 0;
    if (!peaceful && counts.hostile < CAPS.hostile * scale) this.trySpawn('hostile');
    if (g.world.time % 400 === 0 && counts.passive < CAPS.passive * scale) this.trySpawn('passive');
    if (g.world.time % 40 === 0 && counts.water < CAPS.water * scale) this.trySpawn('water');
    if (g.world.time % 200 === 0 && counts.ambient < CAPS.ambient * scale) this.trySpawn('ambient');
    // phantoms
    if (!peaceful && g.world.dimension === 'overworld' && p.ticksSinceLastSleep > 72000 && g.world.time % 1200 === 0 && !g.isDay() && Math.random() < 0.3) {
      const sky = g.world.getSky(Math.floor(p.x), Math.floor(p.eyeY), Math.floor(p.z));
      if (sky >= 15 && p.y >= SEA_LEVEL) { const n = 1 + Math.floor(Math.random() * 3); for (let i = 0; i < n; i++) g.spawnMob('phantom', p.x + (Math.random() - 0.5) * 20, p.y + 20 + Math.random() * 10, p.z + (Math.random() - 0.5) * 20); }
    }
  }

  private trySpawn(kind: 'hostile' | 'passive' | 'water' | 'ambient'): void {
    const g = this.game, world = g.world, reg = g.registry;
    const p = g.player;
    // pick a random loaded chunk near the player
    const r = Math.min(8, g.chunks.viewDistance);
    const cx = (Math.floor(p.x) >> 4) + Math.floor(Math.random() * (r * 2 + 1)) - r, cz = (Math.floor(p.z) >> 4) + Math.floor(Math.random() * (r * 2 + 1)) - r;
    const c = world.getChunk(cx, cz);
    if (!c) return;
    const lx = Math.floor(Math.random() * 16), lz = Math.floor(Math.random() * 16);
    const x = cx * 16 + lx, z = cz * 16 + lz;
    const h = c.getHeight(lx, lz);
    if (h <= -64) return;
    let y: number;
    if (kind === 'water') y = SEA_LEVEL - 1 - Math.floor(Math.random() * 20);
    else if (kind === 'ambient') y = -60 + Math.floor(Math.random() * (Math.min(h, 63) + 60));
    else if (kind === 'passive') y = h;
    else y = -60 + Math.floor(Math.random() * (h + 61));
    const biome = BIOMES[c.biomes[(lz << 4) | lx]];
    const list = kind === 'hostile' ? biome.hostile : kind === 'ambient' ? (world.dimension === 'overworld' ? ['bat'] : []) : kind === 'water' ? biome.passive.filter((m) => MOB_DEFS[m]?.category === 'water' || MOB_DEFS[m]?.ai.water) : biome.passive.filter((m) => MOB_DEFS[m] && !MOB_DEFS[m].ai.water && MOB_DEFS[m].category !== 'water');
    if (!list.length) return;
    const name = list[Math.floor(Math.random() * list.length)];
    const def = MOB_DEFS[name];
    if (!def) return;
    const dsq = p.distSq(x + 0.5, y, z + 0.5);
    if (dsq < 24 * 24 || dsq > 128 * 128) return;
    const packSize = kind === 'hostile' ? 1 + Math.floor(Math.random() * 4) : kind === 'passive' ? 2 + Math.floor(Math.random() * 3) : kind === 'water' ? 2 + Math.floor(Math.random() * 3) : 1;
    let spawned = 0;
    for (let i = 0; i < packSize * 3 && spawned < packSize; i++) {
      const sx = x + Math.floor((Math.random() - 0.5) * 10) + 0.5, sz = z + Math.floor((Math.random() - 0.5) * 10) + 0.5;
      const sy = kind === 'passive' ? world.getHeight(Math.floor(sx), Math.floor(sz)) : y;
      if (!this.canSpawnAt(def, sx, sy, sz, kind)) continue;
      const m = g.spawnMob(name, sx, sy, sz, kind === 'passive' && Math.random() < 0.1);
      if (m) spawned++;
    }
  }

  canSpawnAt(def: (typeof MOB_DEFS)[string], x: number, y: number, z: number, kind: string): boolean {
    const g = this.game, world = g.world, reg = g.registry;
    const bx = Math.floor(x), bz = Math.floor(z);
    if (!world.isLoaded(bx, bz)) return false;
    const below = world.getBlock(bx, y - 1, bz);
    const at = world.getBlock(bx, y, bz), above = world.getBlock(bx, y + 1, bz);
    if (def.ai.water || def.category === 'water') { return at !== 0 && reg.isWater(at) && (above === 0 || reg.isWater(above)); }
    if (def.name === 'bat') { return at === 0 && above === 0 && world.getLightLevel(bx, y, bz, g.skyDarken()) <= 4 && y < SEA_LEVEL; }
    if (def.name === 'strider') return at !== 0 && reg.isLava(at);
    if (at !== 0 || above !== 0 && def.height > 1) return false;
    if (below === 0 || reg.isFluid(below) || reg.collisionBoxes(below).length === 0) return false;
    const bn = reg.nameOf(below);
    if (bn === 'bedrock' || bn === 'barrier' || bn.endsWith('_leaves') && kind === 'hostile') return false;
    if (kind === 'passive') { return (bn === 'grass_block' || bn === 'snow_block' && def.name === 'polar_bear' || bn === 'sand' && (def.name === 'turtle' || def.name === 'camel') || bn.endsWith('nylium') || bn === 'mycelium' && def.name === 'mooshroom' || bn === 'moss_block' || bn === 'mud') && world.getLightLevel(bx, y, bz, 0) >= 9; }
    if (kind === 'hostile') {
      if (world.dimension === 'overworld') {
        if (world.getBlockLight(bx, y, bz) > 0) return false;
        const sky = world.getSky(bx, y, bz);
        if (sky > Math.floor(Math.random() * 32)) return false;
        const raw = Math.max(sky - g.skyDarken(), 0);
        if (raw > Math.floor(Math.random() * 8)) return false;
        if (def.name === 'slime') { const swamp = BIOMES[world.getBiome(bx, bz)].name.includes('swamp'); return (swamp && y > 50 && y < 70 && Math.random() < 0.5) || (y < 40 && this.isSlimeChunk(bx >> 4, bz >> 4)); }
      } else if (world.dimension === 'the_nether') {
        if (def.name === 'ghast') return y > 30 && Math.random() < 0.05;
      }
      // don't spawn hostiles on player-lit surfaces near spawn
    }
    return true;
  }

  private isSlimeChunk(cx: number, cz: number): boolean {
    const seed = this.game.world.seed;
    let h = (seed + cx * cx * 4987142 + cx * 5947611 + cz * cz * 4392871 + cz * 389711) ^ 987234911;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) % 10 === 0;
  }

  /** Animals spawned when a chunk is first generated. */
  /** End crystals sit on the obsidian pillars (positions mirror EndGen) until the dragon is slain. */
  private populateEndCrystals(c: Chunk): void {
    const g = this.game;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const px = Math.round(Math.cos(a) * 42), pz = Math.round(Math.sin(a) * 42);
      if ((px >> 4) !== c.cx || (pz >> 4) !== c.cz) continue;
      const h = 76 + (i * 7) % 28;
      if (g.entities.some((e) => e instanceof EndCrystalEntity && Math.floor(e.x) === px && Math.floor(e.z) === pz)) continue;
      const cr = new EndCrystalEntity(); cr.setPos(px + 0.5, h + 1, pz + 0.5);
      g.addEntity(cr);
    }
  }
  populateChunk(c: Chunk): void {
    const g = this.game;
    if (g.world.dimension === 'the_end' && g.dragonKills === 0) this.populateEndCrystals(c);
    if (g.world.dimension !== 'overworld') { if (g.world.dimension === 'the_nether' && Math.random() < 0.15) { const b = BIOMES[c.biomes[0]]; const list = b.hostile.concat(b.passive); if (list.length) { const name = list[Math.floor(Math.random() * list.length)]; for (let i = 0; i < 2; i++) { const x = c.cx * 16 + Math.random() * 16, z = c.cz * 16 + Math.random() * 16; let y = 100; while (y > 32 && g.world.getBlock(Math.floor(x), y - 1, Math.floor(z)) === 0) y--; if (MOB_DEFS[name] && this.canSpawnAt(MOB_DEFS[name], x, y, z, 'hostile')) g.spawnMob(name, x, y, z); } } } return; }
    if (Math.random() > 0.1) return;
    const biome = BIOMES[c.biomes[136]];
    const list = biome.passive.filter((m) => MOB_DEFS[m] && !MOB_DEFS[m].ai.water && MOB_DEFS[m].category !== 'water');
    if (!list.length) return;
    const name = list[Math.floor(Math.random() * list.length)];
    const n = 2 + Math.floor(Math.random() * 3);
    const cx = c.cx * 16 + Math.floor(Math.random() * 16), cz = c.cz * 16 + Math.floor(Math.random() * 16);
    for (let i = 0; i < n; i++) {
      const x = cx + Math.floor((Math.random() - 0.5) * 8) + 0.5, z = cz + Math.floor((Math.random() - 0.5) * 8) + 0.5;
      const y = g.world.getHeight(Math.floor(x), Math.floor(z));
      if (this.canSpawnAt(MOB_DEFS[name], x, y, z, 'passive')) g.spawnMob(name, x, y, z, Math.random() < 0.1);
    }
  }
}
