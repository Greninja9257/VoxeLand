// Trees, plants and ore blobs. Features write through a BlockSink so they can be clipped to a chunk.
import type { BlockRegistry } from '../../blocks/registry';
import { Random } from '../../math';

export interface BlockSink {
  get(x: number, y: number, z: number): number; // -1 if outside the writable area
  set(x: number, y: number, z: number, state: number, force?: boolean): void;
}

export class FeatureStates {
  s: Record<string, number> = {};
  constructor(public reg: BlockRegistry) {}
  id(name: string): number {
    let v = this.s[name];
    if (v === undefined) { v = this.reg.defaultState(name); this.s[name] = v; }
    return v;
  }
  withProps(name: string, props: Record<string, string>): number {
    const key = name + JSON.stringify(props);
    let v = this.s[key];
    if (v === undefined) { const b = this.reg.blockByName(name); v = b ? this.reg.stateWith(b, props) : 0; this.s[key] = v; }
    return v;
  }
}

export function isReplaceableForTree(reg: BlockRegistry, state: number): boolean {
  if (state <= 0) return state === 0;
  const n = reg.nameOf(state);
  return reg.isAir(state) || n.endsWith('_leaves') || n === 'short_grass' || n === 'tall_grass' || n === 'fern' || n === 'large_fern' || n === 'vine' || n === 'snow' || n.endsWith('_sapling') || n === 'water' && false;
}

function isSoil(reg: BlockRegistry, state: number): boolean {
  const n = reg.nameOf(state);
  return n === 'grass_block' || n === 'dirt' || n === 'coarse_dirt' || n === 'podzol' || n === 'mycelium' || n === 'rooted_dirt' || n === 'moss_block' || n === 'mud' || n === 'sand' || n === 'red_sand' && false || n === 'snow_block' || n === 'farmland' || n === 'pale_moss_block';
}

/** Standard leaf sphere-ish blob placement helper */
function placeLeavesBlob(sink: BlockSink, reg: BlockRegistry, rnd: Random, cx: number, cy: number, cz: number, radius: number, leaves: number, layers: number[], logs?: number): void {
  for (let i = 0; i < layers.length; i++) {
    const r = layers[i], y = cy + i;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.abs(dx) === r && Math.abs(dz) === r && (r > 1 || rnd.next() < 0.5) && r > 0) continue;
      const cur = sink.get(cx + dx, y, cz + dz);
      if (cur !== -1 && !isReplaceableForTree(reg, cur)) continue;
      sink.set(cx + dx, y, cz + dz, leaves);
    }
  }
}

export class TreeGen {
  /** When set, canPlace() reads from this (pristine terrain) view instead of the write sink, so results are order-independent. */
  checkSink: BlockSink | null = null;
  constructor(private reg: BlockRegistry, private st: FeatureStates) {}

  private leaves(name: string): number { return this.st.withProps(name, { persistent: 'false', distance: '7' }); }
  private logAxis(name: string, axis: 'x' | 'y' | 'z'): number { return this.st.withProps(name, { axis }); }

  canPlace(sink: BlockSink, x: number, y: number, z: number, height: number, radius = 1, trunk = 1): boolean {
    if (this.checkSink) sink = this.checkSink;
    const ground = sink.get(x, y - 1, z);
    if (ground === -1) return false;
    if (!isSoil(this.reg, ground)) return false;
    for (let dy = 0; dy < height; dy++) {
      const r = dy < 2 ? trunk - 1 : radius;
      for (let dx = -r; dx <= r + trunk - 1; dx++) for (let dz = -r; dz <= r + trunk - 1; dz++) {
        const s = sink.get(x + dx, y + dy, z + dz);
        if (s !== -1 && !isReplaceableForTree(this.reg, s)) return false;
      }
    }
    return true;
  }

  /** Dispatch by tree type. Returns true if placed. */
  place(type: string, sink: BlockSink, rnd: Random, x: number, y: number, z: number): boolean {
    switch (type) {
      case 'oak': return this.oak(sink, rnd, x, y, z, 'oak');
      case 'swamp_oak': return this.oak(sink, rnd, x, y, z, 'oak', true);
      case 'fancy_oak': return this.fancyOak(sink, rnd, x, y, z);
      case 'birch': return this.birch(sink, rnd, x, y, z, 5 + rnd.nextInt(3));
      case 'tall_birch': return this.birch(sink, rnd, x, y, z, 7 + rnd.nextInt(4));
      case 'spruce': return this.spruce(sink, rnd, x, y, z);
      case 'pine': return this.pine(sink, rnd, x, y, z);
      case 'mega_spruce': return this.megaSpruce(sink, rnd, x, y, z, false);
      case 'mega_pine': return this.megaSpruce(sink, rnd, x, y, z, true);
      case 'jungle': return this.jungle(sink, rnd, x, y, z);
      case 'jungle_bush': return this.jungleBush(sink, rnd, x, y, z);
      case 'mega_jungle': return this.megaJungle(sink, rnd, x, y, z);
      case 'acacia': return this.acacia(sink, rnd, x, y, z);
      case 'dark_oak': return this.darkOak(sink, rnd, x, y, z, 'dark_oak');
      case 'pale_oak': return this.darkOak(sink, rnd, x, y, z, 'pale_oak');
      case 'cherry': return this.cherry(sink, rnd, x, y, z);
      case 'mangrove': return this.mangrove(sink, rnd, x, y, z);
      case 'huge_mushroom': return rnd.next() < 0.5 ? this.hugeMushroom(sink, rnd, x, y, z, 'red') : this.hugeMushroom(sink, rnd, x, y, z, 'brown');
      case 'crimson_fungus': return this.hugeFungus(sink, rnd, x, y, z, 'crimson');
      case 'warped_fungus': return this.hugeFungus(sink, rnd, x, y, z, 'warped');
      case 'chorus': return this.chorus(sink, rnd, x, y, z);
      default: return this.oak(sink, rnd, x, y, z, 'oak');
    }
  }

  oak(sink: BlockSink, rnd: Random, x: number, y: number, z: number, wood: string, vines = false): boolean {
    const h = 4 + rnd.nextInt(3);
    if (!this.canPlace(sink, x, y, z, h + 1, 2)) return false;
    const log = this.logAxis(wood + '_log', 'y'), leaves = this.leaves(wood + '_leaves');
    sink.set(x, y - 1, z, this.st.id('dirt'));
    placeLeavesBlob(sink, this.reg, rnd, x, y + h - 3, z, 2, leaves, [2, 2, 1, 1]);
    for (let i = 0; i < h; i++) sink.set(x, y + i, z, log);
    // top plus-shape trim: corners of top layer already randomized; ensure center top
    sink.set(x, y + h, z, leaves);
    if (vines) this.hangVines(sink, rnd, x, y + h - 3, z, 3, 3);
    return true;
  }

  private hangVines(sink: BlockSink, rnd: Random, cx: number, cy: number, cz: number, r: number, h: number): void {
    const vine = (dir: string) => this.st.withProps('vine', { [dir]: 'true' });
    for (let dx = -r - 1; dx <= r + 1; dx++) for (let dz = -r - 1; dz <= r + 1; dz++) for (let dy = 0; dy < h; dy++) {
      if (rnd.next() > 0.25) continue;
      const wx = cx + dx, wy = cy + dy, wz = cz + dz;
      if (sink.get(wx, wy, wz) !== 0) continue;
      const n = this.reg;
      const isLeaf = (s: number) => s > 0 && n.nameOf(s).endsWith('_leaves');
      if (isLeaf(sink.get(wx - 1, wy, wz))) this.vineColumn(sink, rnd, wx, wy, wz, vine('west'));
      else if (isLeaf(sink.get(wx + 1, wy, wz))) this.vineColumn(sink, rnd, wx, wy, wz, vine('east'));
      else if (isLeaf(sink.get(wx, wy, wz - 1))) this.vineColumn(sink, rnd, wx, wy, wz, vine('north'));
      else if (isLeaf(sink.get(wx, wy, wz + 1))) this.vineColumn(sink, rnd, wx, wy, wz, vine('south'));
    }
  }
  private vineColumn(sink: BlockSink, rnd: Random, x: number, y: number, z: number, state: number): void {
    const len = 1 + rnd.nextInt(4);
    for (let i = 0; i < len; i++) { if (sink.get(x, y - i, z) !== 0) break; sink.set(x, y - i, z, state); }
  }

  fancyOak(sink: BlockSink, rnd: Random, x: number, y: number, z: number): boolean {
    const h = 8 + rnd.nextInt(5);
    if (!this.canPlace(sink, x, y, z, h + 1, 3)) return false;
    const log = this.logAxis('oak_log', 'y'), leaves = this.leaves('oak_leaves');
    sink.set(x, y - 1, z, this.st.id('dirt'));
    for (let i = 0; i < h; i++) sink.set(x, y + i, z, log);
    const branches = 3 + rnd.nextInt(4);
    for (let b = 0; b < branches; b++) {
      const by = y + 3 + rnd.nextInt(h - 4);
      const bx = x + rnd.nextBetween(-3, 3), bz = z + rnd.nextBetween(-3, 3);
      const steps = Math.max(Math.abs(bx - x), Math.abs(bz - z));
      for (let s = 1; s <= steps; s++) {
        const px = Math.round(x + (bx - x) * s / steps), pz = Math.round(z + (bz - z) * s / steps), py = by + Math.floor(s / 2);
        const axis = Math.abs(bx - x) >= Math.abs(bz - z) ? 'x' : 'z';
        sink.set(px, py, pz, this.logAxis('oak_log', axis));
        if (s === steps) placeLeavesBlob(sink, this.reg, rnd, px, py - 1, pz, 2, leaves, [1, 2, 2, 1]);
      }
    }
    placeLeavesBlob(sink, this.reg, rnd, x, y + h - 2, z, 2, leaves, [2, 2, 1]);
    return true;
  }

  birch(sink: BlockSink, rnd: Random, x: number, y: number, z: number, h: number): boolean {
    if (!this.canPlace(sink, x, y, z, h + 1, 2)) return false;
    const log = this.logAxis('birch_log', 'y'), leaves = this.leaves('birch_leaves');
    sink.set(x, y - 1, z, this.st.id('dirt'));
    placeLeavesBlob(sink, this.reg, rnd, x, y + h - 3, z, 2, leaves, [2, 2, 1, 1]);
    for (let i = 0; i < h; i++) sink.set(x, y + i, z, log);
    sink.set(x, y + h, z, leaves);
    return true;
  }

  spruce(sink: BlockSink, rnd: Random, x: number, y: number, z: number): boolean {
    const h = 6 + rnd.nextInt(4);
    if (!this.canPlace(sink, x, y, z, h + 2, 2)) return false;
    const log = this.logAxis('spruce_log', 'y'), leaves = this.leaves('spruce_leaves');
    sink.set(x, y - 1, z, this.st.id('dirt'));
    const start = 1 + rnd.nextInt(2);
    let r = 0;
    const layers: number[] = [];
    for (let dy = h + 1; dy >= start; dy--) {
      layers.unshift(r);
      r = (r + 1) % 3; if (dy === h + 1) r = 0; else if (dy === h) r = 1;
    }
    // cone: alternate radii 1,2 growing downward
    let rad = 0;
    for (let dy = h + 1; dy >= start; dy--) {
      const yy = y + dy;
      for (let dx = -rad; dx <= rad; dx++) for (let dz = -rad; dz <= rad; dz++) {
        if (Math.abs(dx) === rad && Math.abs(dz) === rad && rad > 0 && (rad > 1 || rnd.next() < 0.7)) continue;
        const cur = sink.get(x + dx, yy, z + dz);
        if (cur === -1 || isReplaceableForTree(this.reg, cur)) sink.set(x + dx, yy, z + dz, leaves);
      }
      if (rad >= 2) rad = rad === 3 ? 1 : (rnd.next() < 0.5 ? 1 : 2); else rad++;
      if (dy === h + 1) rad = 1;
    }
    for (let i = 0; i < h; i++) sink.set(x, y + i, z, log);
    return true;
  }

  pine(sink: BlockSink, rnd: Random, x: number, y: number, z: number): boolean {
    const h = 7 + rnd.nextInt(5);
    if (!this.canPlace(sink, x, y, z, h + 2, 2)) return false;
    const log = this.logAxis('spruce_log', 'y'), leaves = this.leaves('spruce_leaves');
    sink.set(x, y - 1, z, this.st.id('dirt'));
    const top = y + h;
    const layers = [1, 2, 2, 1, 1];
    for (let i = 0; i < layers.length; i++) {
      const r = layers[i], yy = top + 1 - i;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r && r > 0) continue;
        const cur = sink.get(x + dx, yy, z + dz);
        if (cur === -1 || isReplaceableForTree(this.reg, cur)) sink.set(x + dx, yy, z + dz, leaves);
      }
    }
    for (let i = 0; i < h; i++) sink.set(x, y + i, z, log);
    return true;
  }

  megaSpruce(sink: BlockSink, rnd: Random, x: number, y: number, z: number, pine: boolean): boolean {
    const h = 13 + rnd.nextInt(15);
    if (!this.canPlace(sink, x, y, z, h + 2, 3, 2)) return false;
    const log = this.logAxis('spruce_log', 'y'), leaves = this.leaves('spruce_leaves');
    const podzol = this.st.id('podzol');
    for (let dx = -2; dx <= 3; dx++) for (let dz = -2; dz <= 3; dz++) {
      const g = sink.get(x + dx, y - 1, z + dz);
      if (g > 0 && isSoil(this.reg, g) && rnd.next() < 0.7) sink.set(x + dx, y - 1, z + dz, podzol);
    }
    for (let i = 0; i < h; i++) for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++) sink.set(x + dx, y + i, z + dz, log);
    const leafStart = pine ? h - 4 - rnd.nextInt(3) : 3 + rnd.nextInt(4);
    let rad = 0;
    for (let dy = h + 1; dy >= leafStart; dy--) {
      const yy = y + dy;
      for (let dx = -rad; dx <= rad + 1; dx++) for (let dz = -rad; dz <= rad + 1; dz++) {
        const ex = dx < 0 ? -dx : dx - 1, ez = dz < 0 ? -dz : dz - 1;
        if (ex + ez > rad + 1 || (ex === rad && ez === rad && rad > 0)) continue;
        const cur = sink.get(x + dx, yy, z + dz);
        if (cur === -1 || isReplaceableForTree(this.reg, cur)) sink.set(x + dx, yy, z + dz, leaves);
      }
      rad = dy === h + 1 ? 1 : rad >= 3 ? 1 + rnd.nextInt(2) : rad + 1;
    }
    return true;
  }

  jungle(sink: BlockSink, rnd: Random, x: number, y: number, z: number): boolean {
    const h = 6 + rnd.nextInt(8);
    if (!this.canPlace(sink, x, y, z, h + 1, 2)) return false;
    const log = this.logAxis('jungle_log', 'y'), leaves = this.leaves('jungle_leaves');
    sink.set(x, y - 1, z, this.st.id('dirt'));
    placeLeavesBlob(sink, this.reg, rnd, x, y + h - 2, z, 2, leaves, [2, 2, 1]);
    for (let i = 0; i < h; i++) {
      sink.set(x, y + i, z, log);
      if (i > 0 && rnd.next() < 0.3) { // cocoa
        const dir = ['north', 'south', 'west', 'east'][rnd.nextInt(4)];
        const off = { north: [0, 1], south: [0, -1], west: [1, 0], east: [-1, 0] }[dir]!;
        if (sink.get(x + off[0], y + i, z + off[1]) === 0 && i < h - 3 && rnd.next() < 0.4) sink.set(x + off[0], y + i, z + off[1], this.st.withProps('cocoa', { facing: dir, age: String(rnd.nextInt(3)) }));
      }
    }
    this.hangVines(sink, rnd, x, y + h - 2, z, 2, 3);
    return true;
  }

  jungleBush(sink: BlockSink, rnd: Random, x: number, y: number, z: number): boolean {
    const g = sink.get(x, y - 1, z);
    if (g === -1 || !isSoil(this.reg, g)) return false;
    if (sink.get(x, y, z) !== 0) return false;
    const log = this.logAxis('jungle_log', 'y'), leaves = this.leaves('oak_leaves');
    sink.set(x, y, z, log);
    for (let dy = 0; dy < 3; dy++) {
      const r = 2 - dy;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if ((Math.abs(dx) !== r || Math.abs(dz) !== r || rnd.next() < 0.5) && !(dx === 0 && dz === 0 && dy === 0)) {
          const cur = sink.get(x + dx, y + dy, z + dz);
          if (cur === 0) sink.set(x + dx, y + dy, z + dz, leaves);
        }
      }
    }
    return true;
  }

  megaJungle(sink: BlockSink, rnd: Random, x: number, y: number, z: number): boolean {
    const h = 20 + rnd.nextInt(12);
    if (!this.canPlace(sink, x, y, z, h + 2, 3, 2)) return false;
    const log = this.logAxis('jungle_log', 'y'), leaves = this.leaves('jungle_leaves');
    for (let i = 0; i < h; i++) for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++) sink.set(x + dx, y + i, z + dz, log);
    // canopy
    for (let dy = -1; dy <= 1; dy++) {
      const r = dy === 1 ? 2 : 3;
      for (let dx = -r; dx <= r + 1; dx++) for (let dz = -r; dz <= r + 1; dz++) {
        const ex = dx < 0 ? -dx : dx - 1, ez = dz < 0 ? -dz : dz - 1;
        if (ex === r && ez === r) continue;
        const cur = sink.get(x + dx, y + h + dy, z + dz);
        if (cur === -1 || isReplaceableForTree(this.reg, cur)) sink.set(x + dx, y + h + dy, z + dz, leaves);
      }
    }
    // side branches
    for (let i = 4; i < h - 4; i += 4 + rnd.nextInt(3)) {
      const dir = rnd.nextInt(4);
      const dx = [1, -1, 0, 0][dir], dz = [0, 0, 1, -1][dir];
      const len = 2 + rnd.nextInt(3);
      let px = x + (dx > 0 ? 1 : 0), pz = z + (dz > 0 ? 1 : 0), py = y + i;
      for (let s = 1; s <= len; s++) {
        px += dx; pz += dz; if (s > 1 && rnd.next() < 0.5) py++;
        sink.set(px, py, pz, this.logAxis('jungle_log', dx ? 'x' : 'z'));
      }
      placeLeavesBlob(sink, this.reg, rnd, px, py, pz, 2, leaves, [2, 1]);
    }
    this.hangVines(sink, rnd, x, y + h - 2, z, 3, 4);
    return true;
  }

  acacia(sink: BlockSink, rnd: Random, x: number, y: number, z: number): boolean {
    const h = 5 + rnd.nextInt(3);
    if (!this.canPlace(sink, x, y, z, h + 1, 3)) return false;
    const leaves = this.leaves('acacia_leaves');
    sink.set(x, y - 1, z, this.st.id('dirt'));
    const dir = rnd.nextInt(4);
    const dx = [1, -1, 0, 0][dir], dz = [0, 0, 1, -1][dir];
    let px = x, pz = z;
    const bend = h - 2 - rnd.nextInt(2);
    for (let i = 0; i < h; i++) {
      if (i >= bend) { px += dx; pz += dz; }
      sink.set(px, y + i, pz, this.logAxis('acacia_log', 'y'));
    }
    // flat canopy
    const cy = y + h;
    for (let ddx = -3; ddx <= 3; ddx++) for (let ddz = -3; ddz <= 3; ddz++) {
      const d = Math.abs(ddx) + Math.abs(ddz);
      if (d > 4 || (Math.abs(ddx) === 3 && Math.abs(ddz) === 3)) continue;
      const cur = sink.get(px + ddx, cy - 1, pz + ddz);
      if (cur === -1 || isReplaceableForTree(this.reg, cur)) sink.set(px + ddx, cy - 1, pz + ddz, leaves);
      if (d <= 2) { const c2 = sink.get(px + ddx, cy, pz + ddz); if (c2 === -1 || isReplaceableForTree(this.reg, c2)) sink.set(px + ddx, cy, pz + ddz, leaves); }
    }
    // second, smaller branch
    const dir2 = (dir + 1 + rnd.nextInt(3)) % 4;
    const bx = x + [1, -1, 0, 0][dir2] * 2, bz = z + [0, 0, 1, -1][dir2] * 2;
    const by = y + bend;
    sink.set(x + [1, -1, 0, 0][dir2], by, z + [0, 0, 1, -1][dir2], this.logAxis('acacia_log', 'y'));
    sink.set(bx, by + 1, bz, this.logAxis('acacia_log', 'y'));
    for (let ddx = -1; ddx <= 1; ddx++) for (let ddz = -1; ddz <= 1; ddz++) {
      const cur = sink.get(bx + ddx, by + 2, bz + ddz);
      if (cur === -1 || isReplaceableForTree(this.reg, cur)) sink.set(bx + ddx, by + 2, bz + ddz, leaves);
    }
    return true;
  }

  darkOak(sink: BlockSink, rnd: Random, x: number, y: number, z: number, wood: string): boolean {
    const h = 6 + rnd.nextInt(3);
    if (!this.canPlace(sink, x, y, z, h + 1, 3, 2)) return false;
    const log = this.logAxis(wood + '_log', 'y'), leaves = this.leaves(wood + '_leaves');
    for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++) { sink.set(x + dx, y - 1, z + dz, this.st.id('dirt')); for (let i = 0; i < h; i++) sink.set(x + dx, y + i, z + dz, log); }
    // wide canopy
    for (let dy = -2; dy <= 0; dy++) {
      const r = dy === 0 ? 2 : 3;
      for (let dx = -r; dx <= r + 1; dx++) for (let dz = -r; dz <= r + 1; dz++) {
        const ex = dx < 0 ? -dx : dx - 1, ez = dz < 0 ? -dz : dz - 1;
        if (ex === r && ez === r) continue;
        if (dy === -2 && (ex + ez > r + 1)) continue;
        const cur = sink.get(x + dx, y + h + dy, z + dz);
        if (cur === -1 || isReplaceableForTree(this.reg, cur)) sink.set(x + dx, y + h + dy, z + dz, leaves);
      }
    }
    for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++) sink.set(x + dx, y + h, z + dz, leaves);
    if (wood === 'pale_oak') {
      const moss = this.st.id('pale_moss_carpet');
      for (let dx = -3; dx <= 4; dx++) for (let dz = -3; dz <= 4; dz++) if (rnd.next() < 0.3 && sink.get(x + dx, y, z + dz) === 0 && sink.get(x + dx, y - 1, z + dz) > 0) sink.set(x + dx, y, z + dz, moss);
    }
    return true;
  }

  cherry(sink: BlockSink, rnd: Random, x: number, y: number, z: number): boolean {
    const h = 4 + rnd.nextInt(3);
    if (!this.canPlace(sink, x, y, z, h + 3, 4)) return false;
    const leaves = this.leaves('cherry_leaves');
    sink.set(x, y - 1, z, this.st.id('dirt'));
    for (let i = 0; i < h; i++) sink.set(x, y + i, z, this.logAxis('cherry_log', 'y'));
    const branches = 2 + rnd.nextInt(2);
    for (let b = 0; b < branches; b++) {
      const dir = (b * 2 + rnd.nextInt(2)) % 4;
      const dx = [1, -1, 0, 0][dir], dz = [0, 0, 1, -1][dir];
      const len = 2 + rnd.nextInt(3);
      let px = x, pz = z, py = y + h - 1;
      for (let s = 0; s < len; s++) {
        px += dx; pz += dz; if (s >= 1) py++;
        sink.set(px, py, pz, this.logAxis('cherry_log', dx ? 'x' : 'z'));
      }
      // blob
      for (let ddy = -1; ddy <= 1; ddy++) {
        const r = ddy === 0 ? 3 : 2;
        for (let ddx = -r; ddx <= r; ddx++) for (let ddz = -r; ddz <= r; ddz++) {
          if (ddx * ddx + ddz * ddz > r * r + 1) continue;
          const cur = sink.get(px + ddx, py + ddy, pz + ddz);
          if (cur === -1 || isReplaceableForTree(this.reg, cur)) sink.set(px + ddx, py + ddy, pz + ddz, leaves);
        }
      }
    }
    return true;
  }

  mangrove(sink: BlockSink, rnd: Random, x: number, y: number, z: number): boolean {
    const h = 5 + rnd.nextInt(4);
    const ground = sink.get(x, y - 1, z);
    if (ground === -1) return false;
    const gn = this.reg.nameOf(ground);
    if (!(gn === 'mud' || gn === 'grass_block' || gn === 'dirt' || gn === 'water')) return false;
    const log = this.logAxis('mangrove_log', 'y'), leaves = this.leaves('mangrove_leaves'), roots = this.st.id('mangrove_roots');
    const base = gn === 'water' ? y - 1 : y;
    for (let i = 0; i < h; i++) sink.set(x, base + 2 + i, z, log);
    // roots
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const len = 1 + rnd.nextInt(2);
      for (let i = 0; i < 3; i++) {
        const s = sink.get(x + dx * len, base + i, z + dz * len);
        if (s === 0 || (s > 0 && this.reg.nameOf(s) === 'water')) sink.set(x + dx * len, base + i, z + dz * len, roots);
      }
      sink.set(x + dx * len, base + 2, z + dz * len, this.logAxis('mangrove_log', dx ? 'x' : 'z'));
      sink.set(x + dx, base + 2, z + dz, this.logAxis('mangrove_log', dx ? 'x' : 'z'));
    }
    for (let i = 0; i < 3; i++) { const s = sink.get(x, base + i, z); if (s === 0 || (s > 0 && this.reg.nameOf(s) === 'water')) sink.set(x, base + i, z, roots); }
    placeLeavesBlob(sink, this.reg, rnd, x, base + h - 1, z, 2, leaves, [2, 3, 2, 1]);
    return true;
  }

  hugeMushroom(sink: BlockSink, rnd: Random, x: number, y: number, z: number, kind: 'red' | 'brown'): boolean {
    const h = 4 + rnd.nextInt(3);
    const g = sink.get(x, y - 1, z);
    if (g === -1 || !isSoil(this.reg, g)) return false;
    const stem = this.st.withProps('mushroom_stem', { up: 'false', down: 'false' });
    for (let i = 0; i < h; i++) sink.set(x, y + i, z, stem);
    const cap = (props: Record<string, string>) => this.st.withProps(kind + '_mushroom_block', { up: 'true', down: 'false', north: 'true', south: 'true', west: 'true', east: 'true', ...props });
    if (kind === 'brown') {
      const top = y + h;
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
        if (Math.abs(dx) === 3 && Math.abs(dz) === 3) continue;
        sink.set(x + dx, top, z + dz, cap({ north: String(dz === -3), south: String(dz === 3), west: String(dx === -3), east: String(dx === 3) }));
      }
    } else {
      for (let dy = h - 3; dy <= h; dy++) {
        const r = dy === h ? 1 : 2;
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
          if (dy < h && Math.abs(dx) === r && Math.abs(dz) === r) continue;
          if (dy < h && Math.abs(dx) < r && Math.abs(dz) < r) continue;
          sink.set(x + dx, y + dy, z + dz, cap({ up: String(dy === h), north: String(dz === -r), south: String(dz === r), west: String(dx === -r), east: String(dx === r) }));
        }
      }
    }
    return true;
  }

  hugeFungus(sink: BlockSink, rnd: Random, x: number, y: number, z: number, kind: 'crimson' | 'warped'): boolean {
    const h = 5 + rnd.nextInt(6);
    const g = sink.get(x, y - 1, z);
    if (g === -1 || this.reg.nameOf(g) !== kind + '_nylium') return false;
    const stem = this.logAxis(kind + '_stem', 'y'), wart = this.st.id(kind === 'crimson' ? 'nether_wart_block' : 'warped_wart_block'), shroom = this.st.id('shroomlight');
    for (let i = 0; i < h; i++) sink.set(x, y + i, z, stem);
    for (let dy = -2; dy <= 0; dy++) {
      const r = dy === 0 ? 1 : dy === -1 ? 2 : 3;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r && r > 1) continue;
        if (dy === -2 && Math.abs(dx) < 2 && Math.abs(dz) < 2 && !(dx === 0 && dz === 0)) { if (rnd.next() < 0.3) sink.set(x + dx, y + h + dy, z + dz, shroom); continue; }
        const cur = sink.get(x + dx, y + h + dy, z + dz);
        if (cur === 0 || cur === -1) sink.set(x + dx, y + h + dy, z + dz, rnd.next() < 0.08 ? shroom : wart);
      }
    }
    sink.set(x, y + h, z, wart);
    return true;
  }

  chorus(sink: BlockSink, rnd: Random, x: number, y: number, z: number): boolean {
    const g = sink.get(x, y - 1, z);
    if (g === -1 || this.reg.nameOf(g) !== 'end_stone') return false;
    const plant = this.st.withProps('chorus_plant', { down: 'true', up: 'true' });
    const flower = this.st.withProps('chorus_flower', { age: '5' });
    const grow = (px: number, py: number, pz: number, depth: number) => {
      const h = 1 + rnd.nextInt(3);
      for (let i = 0; i < h; i++) sink.set(px, py + i, pz, plant);
      const ty = py + h;
      if (depth >= 3 || rnd.next() < 0.3) { sink.set(px, ty, pz, flower); return; }
      const n = 1 + rnd.nextInt(3);
      for (let i = 0; i < n; i++) {
        const d = rnd.nextInt(4); const dx = [1, -1, 0, 0][d], dz = [0, 0, 1, -1][d];
        if (sink.get(px + dx, ty, pz + dz) === 0) { sink.set(px, ty, pz, plant); grow(px + dx, ty, pz + dz, depth + 1); }
      }
      if (sink.get(px, ty, pz) === 0) sink.set(px, ty, pz, flower);
    };
    grow(x, y, z, 0);
    return true;
  }
}

/** Vanilla-like ore blob (ellipsoid along a random line). */
export function placeOreBlob(sink: BlockSink, rnd: Random, x: number, y: number, z: number, size: number, ore: number, deepOre: number, targets: (s: number) => 0 | 1 | 2): void {
  const angle = rnd.next() * Math.PI;
  const s8 = size / 8;
  const x1 = x + Math.sin(angle) * s8, x2 = x - Math.sin(angle) * s8;
  const z1 = z + Math.cos(angle) * s8, z2 = z - Math.cos(angle) * s8;
  const y1 = y + rnd.nextInt(3) - 2, y2 = y + rnd.nextInt(3) - 2;
  for (let i = 0; i < size; i++) {
    const t = i / size;
    const cx = x1 + (x2 - x1) * t, cy = y1 + (y2 - y1) * t, cz = z1 + (z2 - z1) * t;
    const r = ((Math.sin(Math.PI * t) + 1) * rnd.next() * size / 16 + 1) / 2;
    const bx0 = Math.floor(cx - r), bx1 = Math.floor(cx + r), by0 = Math.floor(cy - r), by1 = Math.floor(cy + r), bz0 = Math.floor(cz - r), bz1 = Math.floor(cz + r);
    for (let px = bx0; px <= bx1; px++) {
      const dx = (px + 0.5 - cx) / r;
      if (dx * dx >= 1) continue;
      for (let py = by0; py <= by1; py++) {
        const dy = (py + 0.5 - cy) / r;
        if (dx * dx + dy * dy >= 1) continue;
        for (let pz = bz0; pz <= bz1; pz++) {
          const dz = (pz + 0.5 - cz) / r;
          if (dx * dx + dy * dy + dz * dz >= 1) continue;
          const cur = sink.get(px, py, pz);
          if (cur <= 0) continue;
          const kind = targets(cur);
          if (kind === 1) sink.set(px, py, pz, ore);
          else if (kind === 2) sink.set(px, py, pz, deepOre);
        }
      }
    }
  }
}
