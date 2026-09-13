// The End: central island with obsidian pillars + exit portal frame, outer islands with chorus plants.
import type { BlockRegistry } from '../../blocks/registry';
import { Random } from '../../math';
import { Chunk, MIN_Y } from '../chunk';
import { biomeId } from './biomes';
import { FBM, Perlin, hashSeed } from './noise';
import { FeatureStates, TreeGen, type BlockSink } from './features';
import type { Generator } from './overworld';

export class EndGen implements Generator {
  private island: FBM; private detail: Perlin;
  private st: FeatureStates; private trees: TreeGen;
  private S: Record<string, number> = {};
  constructor(public seed: number, public reg: BlockRegistry) {
    this.island = new FBM(seed + 701, 3, 2, 0.5); this.detail = new Perlin(seed + 702);
    this.st = new FeatureStates(reg); this.trees = new TreeGen(reg, this.st);
    for (const n of ['end_stone', 'obsidian', 'bedrock', 'end_portal', 'end_rod', 'chorus_plant', 'chorus_flower', 'torch']) this.S[n] = reg.defaultState(n);
  }

  /** Height (0 = none) of terrain surface at column: main island radius ~120, outer islands beyond 1000. */
  private heightAt(x: number, z: number): [number, number] {
    const d = Math.hypot(x, z);
    if (d < 140) {
      const edge = Math.max(0, 1 - Math.max(0, d - 90) / 50);
      const n = this.island.noise2(x, z, 1 / 40) * 6;
      const h = 60 + n + this.detail.noise2(x / 12, z / 12) * 2;
      const thick = 8 + edge * 24 + this.island.noise2(x + 500, z, 1 / 30) * 6;
      return edge <= 0 ? [0, 0] : [h, Math.max(0, h - thick * edge)];
    }
    if (d < 900) return [0, 0];
    const n = this.island.noise2(x, z, 1 / 120) + this.island.noise2(x + 3000, z, 1 / 30) * 0.3;
    if (n < 0.28) return [0, 0];
    const t = (n - 0.28) / 0.5;
    const h = 60 + t * 12 + this.detail.noise2(x / 10, z / 10) * 2;
    return [h, h - 4 - t * 30];
  }

  generate(cx: number, cz: number): Chunk {
    const chunk = new Chunk(cx, cz);
    const S = this.S;
    const x0 = cx * 16, z0 = cz * 16;
    const rnd = new Random(hashSeed(this.seed, cx, cz, 0xe4d));
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
      const x = x0 + lx, z = z0 + lz;
      const d = Math.hypot(x, z);
      chunk.biomes[(lz << 4) | lx] = biomeId(d < 140 ? 'the_end' : d < 900 ? 'small_end_islands' : 'end_highlands');
      const [top, bottom] = this.heightAt(x, z);
      if (top > 0) for (let y = Math.floor(bottom); y <= Math.floor(top); y++) chunk.setBlock(lx, y, lz, S.end_stone);
      chunk.heightmap[(lz << 4) | lx] = top > 0 ? Math.floor(top) + 1 : MIN_Y;
    }
    const sink = new EndSink(chunk);
    // obsidian pillars around the centre
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const px = Math.round(Math.cos(a) * 42), pz = Math.round(Math.sin(a) * 42);
      const h = 76 + (i * 7) % 28, r = 3 + (i % 3);
      if (Math.abs(px - x0 - 8) > 16 + r || Math.abs(pz - z0 - 8) > 16 + r) continue;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (dx * dx + dz * dz <= r * r + 1) for (let y = 40; y < h; y++) sink.set(px + dx, y, pz + dz, S.obsidian);
      sink.set(px, h, pz, S.bedrock);
      sink.set(px, h + 1, pz, S.torch);
    }
    // exit portal frame at origin
    if (Math.abs(x0 + 8) < 24 && Math.abs(z0 + 8) < 24) {
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
        const dd = dx * dx + dz * dz;
        for (let y = 56; y < 62; y++) { if (dd <= 12) sink.set(dx, y, dz, dd <= 6 && y === 61 ? S.end_portal : y === 61 ? S.bedrock : S.bedrock); }
      }
      for (let y = 62; y < 66; y++) sink.set(0, y, 0, S.bedrock);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) sink.set(dx, 64, dz, S.torch);
    }
    // chorus plants on outer islands
    if (Math.hypot(x0 + 8, z0 + 8) > 900) {
      for (let i = 0; i < 4; i++) {
        const x = x0 + rnd.nextInt(16), z = z0 + rnd.nextInt(16);
        const y = chunk.heightmap[((z & 15) << 4) | (x & 15)];
        if (y > MIN_Y && rnd.next() < 0.5) this.trees.place('chorus', sink, new Random(hashSeed(this.seed, x, z, 9)), x, y, z);
      }
    }
    chunk.decorated = true;
    return chunk;
  }

  spawnHeight(x: number, z: number): number { return 62; }
}

class EndSink implements BlockSink {
  private x0: number; private z0: number;
  constructor(public chunk: Chunk) { this.x0 = chunk.cx * 16; this.z0 = chunk.cz * 16; }
  get(x: number, y: number, z: number): number {
    const lx = x - this.x0, lz = z - this.z0;
    if (lx < 0 || lx >= 16 || lz < 0 || lz >= 16) return -1;
    return this.chunk.getBlock(lx, y, lz);
  }
  set(x: number, y: number, z: number, state: number): void {
    const lx = x - this.x0, lz = z - this.z0;
    if (lx < 0 || lx >= 16 || lz < 0 || lz >= 16) return;
    this.chunk.setBlock(lx, y, lz, state);
  }
}
