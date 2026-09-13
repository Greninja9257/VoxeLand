// Sky + block light propagation (vanilla semantics: 0-15, opaque blocks stop light,
// sky light 15 travels straight down undiminished through transparent blocks).
import type { BlockRegistry } from '../blocks/registry';
import type { World } from './world';
import { Chunk, MIN_Y, MAX_Y, CHUNK_W } from './chunk';

class Queue {
  data = new Int32Array(1 << 16);
  head = 0; tail = 0;
  push(x: number, y: number, z: number, l: number): void {
    if (this.tail + 4 > this.data.length) {
      if (this.head > 0) { this.data.copyWithin(0, this.head, this.tail); this.tail -= this.head; this.head = 0; }
      if (this.tail + 4 > this.data.length) { const n = new Int32Array(this.data.length * 2); n.set(this.data); this.data = n; }
    }
    const d = this.data, t = this.tail;
    d[t] = x; d[t + 1] = y; d[t + 2] = z; d[t + 3] = l; this.tail = t + 4;
  }
  get empty(): boolean { return this.head >= this.tail; }
  reset(): void { this.head = this.tail = 0; }
}

const NB = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

export class LightEngine {
  hasSky = true;
  private removeQ = new Queue();
  private propQ = new Queue();
  /** chunk sections touched during the last operation (for re-meshing) */
  touched = new Set<number>();

  constructor(private world: World, private reg: BlockRegistry) {}

  // ---------- helpers ----------
  private chunkOf(x: number, z: number): Chunk | undefined { return this.world.getChunk(x >> 4, z >> 4); }

  private getSky(c: Chunk, x: number, y: number, z: number): number { return c.getLight(x & 15, y, z & 15) >> 4; }
  private getBlk(c: Chunk, x: number, y: number, z: number): number { return c.getLight(x & 15, y, z & 15) & 15; }
  private setSky(c: Chunk, x: number, y: number, z: number, v: number): void {
    c.setLight(x & 15, y, z & 15, (v << 4) | (c.getLight(x & 15, y, z & 15) & 15));
    c.dirtySections |= 1 << ((y - MIN_Y) >> 4); this.touched.add(((y - MIN_Y) >> 4) + 24 * (((c.cx & 0xffff) << 16) | (c.cz & 0xffff)));
  }
  private setBlk(c: Chunk, x: number, y: number, z: number, v: number): void {
    c.setLight(x & 15, y, z & 15, (c.getLight(x & 15, y, z & 15) & 0xf0) | v);
    c.dirtySections |= 1 << ((y - MIN_Y) >> 4);
  }
  private opacity(c: Chunk, x: number, y: number, z: number): number { return this.reg.filterLight[c.getBlock(x & 15, y, z & 15)]; }

  // ---------- incremental updates ----------
  onBlockChanged(x: number, y: number, z: number, oldState: number, newState: number): void {
    const reg = this.reg;
    const c = this.chunkOf(x, z);
    if (!c) return;
    const oldOp = reg.filterLight[oldState], newOp = reg.filterLight[newState];
    const oldEm = reg.emitLight[oldState], newEm = reg.emitLight[newState];
    if (oldOp !== newOp || oldEm !== newEm) {
      // block light: remove old value at pos then re-propagate
      const oldL = this.getBlk(c, x, y, z);
      if (oldL > 0) this.removeBlockLight(x, y, z, oldL);
      if (newEm > 0) { this.setBlk(c, x, y, z, newEm); this.propQ.push(x, y, z, newEm); }
      else this.seedFromNeighbors(x, y, z, false);
      this.propagate(false);
    }
    if (this.hasSky && oldOp !== newOp) {
      const oldS = this.getSky(c, x, y, z);
      this.updateSkyHeight(c, x & 15, z & 15);
      if (oldS > 0) this.removeSkyLight(x, y, z, oldS);
      this.seedFromNeighbors(x, y, z, true);
      this.propagate(true);
    }
  }

  private updateSkyHeight(c: Chunk, lx: number, lz: number): void {
    let y = MAX_Y - 1;
    while (y >= MIN_Y && this.reg.filterLight[c.getBlock(lx, y, lz)] === 0) y--;
    c.skyHeight[(lz << 4) | lx] = y + 1;
  }

  private seedFromNeighbors(x: number, y: number, z: number, sky: boolean): void {
    for (const [dx, dy, dz] of NB) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (ny < MIN_Y || ny >= MAX_Y) { if (sky && ny >= MAX_Y) this.propQ.push(nx, ny, nz, 15); continue; }
      const nc = this.chunkOf(nx, nz);
      if (!nc) continue;
      const l = sky ? this.getSky(nc, nx, ny, nz) : this.getBlk(nc, nx, ny, nz);
      if (l > 0) this.propQ.push(nx, ny, nz, l);
    }
  }

  private removeBlockLight(x: number, y: number, z: number, level: number): void {
    const rq = this.removeQ; rq.reset();
    const c0 = this.chunkOf(x, z)!;
    this.setBlk(c0, x, y, z, 0);
    rq.push(x, y, z, level);
    while (!rq.empty) {
      const d = rq.data, h = rq.head; rq.head += 4;
      const cx = d[h], cy = d[h + 1], cz = d[h + 2], cl = d[h + 3];
      for (const [dx, dy, dz] of NB) {
        const nx = cx + dx, ny = cy + dy, nz = cz + dz;
        if (ny < MIN_Y || ny >= MAX_Y) continue;
        const nc = this.chunkOf(nx, nz);
        if (!nc) continue;
        const nl = this.getBlk(nc, nx, ny, nz);
        if (nl === 0) continue;
        if (nl < cl) {
          // could this neighbor be an emitter itself? keep emitter value
          const em = this.reg.emitLight[nc.getBlock(nx & 15, ny, nz & 15)];
          if (em > 0 && em >= nl) { this.propQ.push(nx, ny, nz, nl); continue; }
          this.setBlk(nc, nx, ny, nz, 0);
          rq.push(nx, ny, nz, nl);
        } else {
          this.propQ.push(nx, ny, nz, nl);
        }
      }
    }
  }

  private removeSkyLight(x: number, y: number, z: number, level: number): void {
    const rq = this.removeQ; rq.reset();
    const c0 = this.chunkOf(x, z)!;
    this.setSky(c0, x, y, z, 0);
    rq.push(x, y, z, level);
    while (!rq.empty) {
      const d = rq.data, h = rq.head; rq.head += 4;
      const cx = d[h], cy = d[h + 1], cz = d[h + 2], cl = d[h + 3];
      for (let i = 0; i < 6; i++) {
        const nx = cx + NB[i][0], ny = cy + NB[i][1], nz = cz + NB[i][2];
        if (ny >= MAX_Y) continue;
        if (ny < MIN_Y) continue;
        const nc = this.chunkOf(nx, nz);
        if (!nc) continue;
        const nl = this.getSky(nc, nx, ny, nz);
        if (nl === 0) continue;
        // the cell below at 15 depends on us if we were 15 (direct sunlight column)
        if (nl < cl || (i === 0 && cl === 15 && nl === 15)) {
          // is it directly lit from the sky itself?
          if (nl === 15 && ny >= nc.skyHeight[((nz & 15) << 4) | (nx & 15)]) { this.propQ.push(nx, ny, nz, nl); continue; }
          this.setSky(nc, nx, ny, nz, 0);
          rq.push(nx, ny, nz, nl);
        } else {
          this.propQ.push(nx, ny, nz, nl);
        }
      }
    }
  }

  /** Run the propagation queue for one channel. */
  propagate(sky: boolean): void {
    const q = this.propQ;
    const reg = this.reg;
    while (!q.empty) {
      const d = q.data, h = q.head; q.head += 4;
      const x = d[h], y = d[h + 1], z = d[h + 2];
      let level = d[h + 3];
      if (y >= MAX_Y) { // virtual sky cell above the world
        if (!sky) continue;
        const nc = this.chunkOf(x, z);
        if (!nc) continue;
        const ny = MAX_Y - 1;
        if (reg.filterLight[nc.getBlock(x & 15, ny, z & 15)] === 0 && this.getSky(nc, x, ny, z) < 15) { this.setSky(nc, x, ny, z, 15); q.push(x, ny, z, 15); }
        continue;
      }
      const c = this.chunkOf(x, z);
      if (!c) continue;
      const cur = sky ? this.getSky(c, x, y, z) : this.getBlk(c, x, y, z);
      if (cur !== level) { if (cur === 0) continue; level = cur; }
      if (level <= 1) continue;
      for (let i = 0; i < 6; i++) {
        const nx = x + NB[i][0], ny = y + NB[i][1], nz = z + NB[i][2];
        if (ny < MIN_Y || ny >= MAX_Y) continue;
        const nc = (nx >> 4) === (x >> 4) && (nz >> 4) === (z >> 4) ? c : this.chunkOf(nx, nz);
        if (!nc) continue;
        const op = reg.filterLight[nc.getBlock(nx & 15, ny, nz & 15)];
        if (op >= 15) continue;
        let nl: number;
        if (sky && i === 0 && level === 15 && op === 0) nl = 15;
        else nl = level - (op > 1 ? op : 1);
        if (nl <= 0) continue;
        const existing = sky ? this.getSky(nc, nx, ny, nz) : this.getBlk(nc, nx, ny, nz);
        if (existing >= nl) continue;
        if (sky) this.setSky(nc, nx, ny, nz, nl); else this.setBlk(nc, nx, ny, nz, nl);
        q.push(nx, ny, nz, nl);
      }
    }
    q.reset();
  }

  // ---------- initial chunk lighting ----------
  /** Compute sky + block light for a chunk (in isolation from neighbors). */
  lightChunk(c: Chunk): void {
    const reg = this.reg;
    const filter = reg.filterLight, emit = reg.emitLight;
    // clear light arrays
    for (let i = 0; i < c.light.length; i++) c.light[i] = null;
    if (!this.hasSky) {
      for (let i = 0; i < c.light.length; i++) c.light[i] = new Uint8Array(4096);
    }
    // sky columns
    if (this.hasSky) {
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        let level = 15;
        let skyH = MIN_Y;
        let foundTop = false;
        for (let y = MAX_Y - 1; y >= MIN_Y; y--) {
          const si = (y - MIN_Y) >> 4;
          const sec = c.sections[si];
          const st = sec ? sec[((y & 15) << 8) | (z << 4) | x] : 0;
          const op = filter[st];
          if (op > 0 && !foundTop) { foundTop = true; skyH = y + 1; }
          if (op > 0) level = Math.max(0, level - Math.max(1, op));
          else if (level < 15) level = Math.max(0, level - 1);
          if (level !== 15) c.setLight(x, y, z, (level << 4));
          if (level === 0 && !sec) {
            // skip whole empty section quickly (remains 0)
            let yy = y - 1;
            const secStart = si * 16 + MIN_Y;
            while (yy >= secStart) { c.setLight(x, yy, z, 0); yy--; }
            y = secStart;
          }
        }
        c.skyHeight[(z << 4) | x] = skyH;
      }
      // seed horizontal spread: cells brighter than a horizontal neighbor by more than 1
      const q = this.propQ;
      const wx0 = c.cx * 16, wz0 = c.cz * 16;
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        const h = c.skyHeight[(z << 4) | x];
        let maxNbH = h;
        if (x > 0) maxNbH = Math.max(maxNbH, c.skyHeight[(z << 4) | (x - 1)]);
        if (x < 15) maxNbH = Math.max(maxNbH, c.skyHeight[(z << 4) | (x + 1)]);
        if (z > 0) maxNbH = Math.max(maxNbH, c.skyHeight[((z - 1) << 4) | x]);
        if (z < 15) maxNbH = Math.max(maxNbH, c.skyHeight[((z + 1) << 4) | x]);
        // cells in this column between h and maxNbH are lit and adjacent to darker columns
        for (let y = h; y < maxNbH; y++) {
          const l = c.getLight(x, y, z) >> 4;
          if (l > 1) q.push(wx0 + x, y, wz0 + z, l);
        }
        // also below h where partial light exists (through water/leaves), seed all lit cells adjacent to darker
        for (let y = h - 1; y >= MIN_Y; y--) {
          const l = c.getLight(x, y, z) >> 4;
          if (l <= 1) break;
          q.push(wx0 + x, y, wz0 + z, l);
        }
      }
      this.propagate(true);
    }
    // block light emitters
    const q = this.propQ;
    const wx0 = c.cx * 16, wz0 = c.cz * 16;
    for (let si = 0; si < c.sections.length; si++) {
      const sec = c.sections[si];
      if (!sec) continue;
      for (let i = 0; i < 4096; i++) {
        const st = sec[i];
        if (st === 0) continue;
        const e = emit[st];
        if (e > 0) {
          const x = i & 15, z = (i >> 4) & 15, y = (i >> 8) + si * 16 + MIN_Y;
          c.setLight(x, y, z, (c.getLight(x, y, z) & 0xf0) | e);
          q.push(wx0 + x, y, wz0 + z, e);
        }
      }
    }
    this.propagate(false);
    c.dirtySections = (1 << 24) - 1;
  }

  /** After neighbors are loaded: exchange light across chunk borders. */
  propagateBorders(c: Chunk): void {
    const wx0 = c.cx * 16, wz0 = c.cz * 16;
    const sides: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const sky of this.hasSky ? [true, false] : [false]) {
      const q = this.propQ;
      for (const [dx, dz] of sides) {
        const n = this.world.getChunk(c.cx + dx, c.cz + dz);
        if (!n) continue;
        for (let i = 0; i < 16; i++) {
          const ax = dx === 0 ? wx0 + i : dx < 0 ? wx0 : wx0 + 15;
          const az = dz === 0 ? wz0 + i : dz < 0 ? wz0 : wz0 + 15;
          const bx = ax + dx, bz = az + dz;
          for (let y = MIN_Y; y < MAX_Y; y++) {
            const la = sky ? this.getSky(c, ax, y, az) : this.getBlk(c, ax, y, az);
            const lb = sky ? this.getSky(n, bx, y, bz) : this.getBlk(n, bx, y, bz);
            if (la > lb + 1) q.push(ax, y, az, la);
            else if (lb > la + 1) q.push(bx, y, bz, lb);
          }
        }
      }
      this.propagate(sky);
    }
  }
}

export { CHUNK_W };
