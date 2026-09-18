// Strongholds: a port of vanilla StrongholdPieces — weighted piece selection from small doors, the spiral start
// staircase, corridors, prison hall, libraries, crossings and the portal room, generated until a portal room exists.
import { Random } from '../../math';
import { hashSeed } from './noise';
import { SEA_LEVEL } from '../chunk';
import { strongholdPositions, type StructureType, type StructureWriter, type Box } from './structures';
import { Frame, orientBox, boxesIntersect, childForward, childLeft, childRight, DIRS, type Dir, type Piece } from './pieces';

type Door = 'opening' | 'wood' | 'grates' | 'iron';
interface SPiece extends Piece { door: Door; kind: string; leftChild?: boolean; rightChild?: boolean; isTall?: boolean; type?: number; leftLow?: boolean; leftHigh?: boolean; rightLow?: boolean; rightHigh?: boolean; steps?: number }

interface Weight { kind: string; weight: number; max: number; placed: number; minDepth: number }
const WEIGHTS = (): Weight[] => [
  { kind: 'straight', weight: 40, max: 0, placed: 0, minDepth: 0 }, { kind: 'prison', weight: 5, max: 5, placed: 0, minDepth: 0 },
  { kind: 'left', weight: 20, max: 0, placed: 0, minDepth: 0 }, { kind: 'right', weight: 20, max: 0, placed: 0, minDepth: 0 },
  { kind: 'room', weight: 10, max: 6, placed: 0, minDepth: 0 }, { kind: 'straightStairs', weight: 5, max: 5, placed: 0, minDepth: 0 },
  { kind: 'stairs', weight: 5, max: 5, placed: 0, minDepth: 0 }, { kind: 'five', weight: 5, max: 4, placed: 0, minDepth: 0 },
  { kind: 'chest', weight: 5, max: 4, placed: 0, minDepth: 0 }, { kind: 'library', weight: 10, max: 2, placed: 0, minDepth: 5 },
  { kind: 'portal', weight: 20, max: 1, placed: 0, minDepth: 6 },
];

class Gen {
  pieces: SPiece[] = [];
  pending: SPiece[] = [];
  weights = WEIGHTS();
  previous: Weight | null = null;
  portal: SPiece | null = null;
  constructor(public rnd: Random, public startX: number, public startZ: number) {}

  private randomDoor(): Door { switch (this.rnd.nextInt(5)) { case 2: return 'wood'; case 3: return 'grates'; case 4: return 'iron'; default: return 'opening'; } }
  private ok(box: Box | null): box is Box { return !!box && box[1] > 10 && !this.pieces.some((p) => boxesIntersect(p.box, box)); }

  /** StrongholdPieces.findAndCreatePieceFactory */
  private create(kind: string, x: number, y: number, z: number, dir: Dir, depth: number): SPiece | null {
    const rnd = this.rnd;
    const mk = (box: Box, extra: Partial<SPiece> = {}): SPiece => ({ kind, box, dir, depth, door: this.randomDoor(), ...extra });
    switch (kind) {
      case 'straight': { const b = orientBox(x, y, z, -1, -1, 0, 5, 5, 7, dir); return this.ok(b) ? mk(b, { leftChild: rnd.nextInt(2) === 0, rightChild: rnd.nextInt(2) === 0 }) : null; }
      case 'prison': { const b = orientBox(x, y, z, -1, -1, 0, 9, 5, 11, dir); return this.ok(b) ? mk(b) : null; }
      case 'left': case 'right': { const b = orientBox(x, y, z, -1, -1, 0, 5, 5, 5, dir); return this.ok(b) ? mk(b) : null; }
      case 'room': { const b = orientBox(x, y, z, -4, -1, 0, 11, 7, 11, dir); return this.ok(b) ? mk(b, { type: rnd.nextInt(5) }) : null; }
      case 'straightStairs': { const b = orientBox(x, y, z, -1, -7, 0, 5, 11, 8, dir); return this.ok(b) ? mk(b) : null; }
      case 'stairs': { const b = orientBox(x, y, z, -1, -7, 0, 5, 11, 5, dir); return this.ok(b) ? mk(b) : null; }
      case 'five': { const b = orientBox(x, y, z, -4, -3, 0, 10, 9, 11, dir); return this.ok(b) ? mk(b, { leftLow: rnd.next() < 0.5, leftHigh: rnd.next() < 0.5, rightLow: rnd.next() < 0.5, rightHigh: rnd.nextInt(3) > 0 }) : null; }
      case 'chest': { const b = orientBox(x, y, z, -1, -1, 0, 5, 5, 7, dir); return this.ok(b) ? mk(b) : null; }
      case 'library': { let b = orientBox(x, y, z, -4, -1, 0, 14, 11, 15, dir); let tall = true; if (!this.ok(b)) { b = orientBox(x, y, z, -4, -1, 0, 14, 6, 15, dir); tall = false; if (!this.ok(b)) return null; } return mk(b, { isTall: tall }); }
      case 'portal': { const b = orientBox(x, y, z, -4, -1, 0, 11, 8, 16, dir); return this.ok(b) ? mk(b) : null; }
    }
    return null;
  }

  /** StrongholdPieces.generatePieceFromSmallDoor (+ the filler corridor fallback) */
  private generatePiece(x: number, y: number, z: number, dir: Dir, depth: number): SPiece | null {
    const rnd = this.rnd;
    let total = 0; for (const w of this.weights) { if (w.max > 0 && w.placed >= w.max) continue; total += w.weight; }
    if (total <= 0) return null;
    for (let j = 0; j < 5; j++) {
      let k = rnd.nextInt(total);
      for (const w of this.weights) {
        if (w.max > 0 && w.placed >= w.max) continue;
        k -= w.weight;
        if (k >= 0) continue;
        if (depth < w.minDepth || w === this.previous) break;
        const p = this.create(w.kind, x, y, z, dir, depth);
        if (p) { w.placed++; this.previous = w; if (w.kind === 'portal') this.portal = p; return p; }
        break;
      }
    }
    // FillerCorridor.findPieceBox: a dead-end tube up to 4 long
    for (let steps = 4; steps >= 1; steps--) {
      const b = orientBox(x, y, z, -1, -1, 0, 5, 5, steps, dir);
      if (this.ok(b)) return { kind: 'filler', box: b, dir, depth, door: 'opening', steps };
    }
    return null;
  }

  private add(x: number, y: number, z: number, dir: Dir, depth: number): void {
    // vanilla limits depth (50) and radius (112); the piece cap keeps the block map and build time in check
    if (depth > 50 || this.pieces.length >= 160 || Math.abs(x - this.startX) > 112 || Math.abs(z - this.startZ) > 112) return;
    const p = this.generatePiece(x, y, z, dir, depth + 1);
    if (p) { this.pieces.push(p); this.pending.push(p); }
  }

  /** StructurePiece.addChildren for each piece kind */
  addChildren(p: SPiece): void {
    const b = p.box, d = p.dir, depth = p.depth;
    const fwd = (xo: number, yo: number) => { const [x, y, z, dir] = childForward(b, d, xo, yo); this.add(x, y, z, dir, depth); };
    const left = (yo: number, zo: number) => { const [x, y, z, dir] = childLeft(b, d, yo, zo); this.add(x, y, z, dir, depth); };
    const right = (yo: number, zo: number) => { const [x, y, z, dir] = childRight(b, d, yo, zo); this.add(x, y, z, dir, depth); };
    switch (p.kind) {
      case 'straight': fwd(1, 1); if (p.leftChild) left(1, 2); if (p.rightChild) right(1, 2); break;
      case 'prison': fwd(1, 1); break;
      case 'left': if (d === 'north' || d === 'east') left(1, 1); else right(1, 1); break;
      case 'right': if (d === 'north' || d === 'east') right(1, 1); else left(1, 1); break;
      case 'room': fwd(4, 1); left(1, 4); right(1, 4); break;
      case 'straightStairs': case 'stairs': case 'chest': fwd(1, 1); break;
      case 'five': { let i = 3, j = 5; if (d === 'west' || d === 'north') { i = 8 - i; j = 8 - j; } fwd(5, 1); if (p.leftLow) left(i, 1); if (p.leftHigh) left(j, 7); if (p.rightLow) right(i, 1); if (p.rightHigh) right(j, 7); break; }
      case 'library': fwd(4, 1); break;
    }
  }

  start(dir: Dir): SPiece {
    const p: SPiece = { kind: 'stairs', box: orientBox(this.startX, 64, this.startZ, -1, -7, 0, 5, 11, 5, dir), dir, depth: 0, door: 'opening' };
    this.pieces.push(p); this.pending.push(p);
    return p;
  }
}

// ---------- block placement ----------
function smoothStone(f: Frame): (rnd: Random, edge: boolean) => number {
  const st = f.w.ctx.st;
  const bricks = st.id('stone_bricks'), mossy = st.id('mossy_stone_bricks'), cracked = st.id('cracked_stone_bricks'), infested = st.id('infested_stone_bricks'), air = st.id('cave_air');
  return (rnd, edge) => { if (!edge) return air; const v = rnd.next(); return v < 0.2 ? cracked : v < 0.5 ? mossy : v < 0.55 ? infested : bricks; };
}

function smallDoor(f: Frame, type: Door, x: number, y: number, z: number): void {
  const st = f.w.ctx.st, air = st.id('cave_air'), bricks = st.id('stone_bricks');
  switch (type) {
    case 'opening': f.fill(x, y, z, x + 2, y + 2, z, air); break;
    case 'wood': case 'iron': {
      for (const [dx, dy] of [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2], [2, 1], [2, 0]]) f.place(x + dx, y + dy, z, bricks);
      const door = type === 'wood' ? 'oak_door' : 'iron_door';
      f.place(x + 1, y, z, f.st(door, { facing: 'south', half: 'lower', hinge: 'left' })); f.place(x + 1, y + 1, z, f.st(door, { facing: 'south', half: 'upper', hinge: 'left' }));
      if (type === 'iron') { f.place(x + 2, y + 1, z + 1, f.st('stone_button', { face: 'wall', facing: 'north' })); f.place(x + 2, y + 1, z - 1, f.st('stone_button', { face: 'wall', facing: 'south' })); }
      break;
    }
    case 'grates': {
      f.place(x + 1, y, z, air); f.place(x + 1, y + 1, z, air);
      for (const [dx, dy] of [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2], [2, 1], [2, 0]]) f.connect(x + dx, y + dy, z, st.id('iron_bars'));
      break;
    }
  }
}

function build(w: StructureWriter, p: SPiece, rnd: Random): void {
  const f = new Frame(w, p.box, p.dir, rnd);
  const st = w.ctx.st, sel = smoothStone(f);
  const air = st.id('cave_air'), bricks = st.id('stone_bricks'), slab = st.id('smooth_stone_slab'), bslab = st.id('stone_brick_slab'), cobble = st.id('cobblestone'), planks = st.id('oak_planks'), bars = st.id('iron_bars');
  const torch = (facing: string) => f.st('wall_torch', { facing });
  const stairs = (facing: string) => f.st('stone_brick_stairs', { facing });
  switch (p.kind) {
    case 'straight': {
      f.fillSel(0, 0, 0, 4, 4, 6, true, sel); smallDoor(f, p.door, 1, 1, 0); f.fill(1, 1, 6, 3, 3, 6, air);
      f.maybe(0.1, 1, 2, 1, torch('east')); f.maybe(0.1, 3, 2, 1, torch('west'));
      if (p.leftChild) f.fill(0, 1, 2, 0, 3, 4, air);
      if (p.rightChild) f.fill(4, 1, 2, 4, 3, 4, air);
      break;
    }
    case 'filler': { for (let i = 0; i < (p.steps ?? 1); i++) { for (let x = 0; x <= 4; x++) { f.place(x, 0, i, bricks); f.place(x, 4, i, bricks); } for (let j = 1; j <= 3; j++) { f.place(0, j, i, bricks); f.place(1, j, i, air); f.place(2, j, i, air); f.place(3, j, i, air); f.place(4, j, i, bricks); } } break; }
    case 'prison': {
      f.fillSel(0, 0, 0, 8, 4, 10, true, sel); smallDoor(f, p.door, 1, 1, 0); f.fill(1, 1, 10, 3, 3, 10, air);
      f.fillSel(4, 1, 1, 4, 3, 1, false, sel); f.fillSel(4, 1, 3, 4, 3, 3, false, sel); f.fillSel(4, 1, 7, 4, 3, 7, false, sel); f.fillSel(4, 1, 9, 4, 3, 9, false, sel);
      for (let i = 1; i <= 3; i++) { f.connect(4, i, 4, bars); f.connect(4, i, 5, bars); f.connect(4, i, 6, bars); f.connect(5, i, 5, bars); f.connect(6, i, 5, bars); f.connect(7, i, 5, bars); }
      f.connect(4, 3, 2, bars); f.connect(4, 3, 8, bars);
      f.place(4, 1, 2, f.st('iron_door', { facing: 'west', half: 'lower', hinge: 'left' })); f.place(4, 2, 2, f.st('iron_door', { facing: 'west', half: 'upper', hinge: 'left' }));
      f.place(4, 1, 8, f.st('iron_door', { facing: 'west', half: 'lower', hinge: 'left' })); f.place(4, 2, 8, f.st('iron_door', { facing: 'west', half: 'upper', hinge: 'left' }));
      break;
    }
    case 'left': case 'right': {
      f.fillSel(0, 0, 0, 4, 4, 4, true, sel); smallDoor(f, p.door, 1, 1, 0);
      const openLeft = p.kind === 'left' ? (p.dir === 'north' || p.dir === 'east') : !(p.dir === 'north' || p.dir === 'east');
      if (openLeft) f.fill(0, 1, 1, 0, 3, 3, air); else f.fill(4, 1, 1, 4, 3, 3, air);
      break;
    }
    case 'room': {
      f.fillSel(0, 0, 0, 10, 6, 10, true, sel); smallDoor(f, p.door, 4, 1, 0); f.fill(4, 1, 10, 6, 3, 10, air); f.fill(0, 1, 4, 0, 3, 6, air); f.fill(10, 1, 4, 10, 3, 6, air);
      switch (p.type) {
        case 0:
          f.place(5, 1, 5, bricks); f.place(5, 2, 5, bricks); f.place(5, 3, 5, bricks);
          f.place(4, 3, 5, torch('west')); f.place(6, 3, 5, torch('east')); f.place(5, 3, 4, torch('north')); f.place(5, 3, 6, torch('south'));
          for (const [x, z] of [[4, 4], [4, 5], [4, 6], [6, 4], [6, 5], [6, 6], [5, 4], [5, 6]]) f.place(x, 1, z, slab);
          break;
        case 1: {
          for (let i = 0; i < 5; i++) { f.place(3, 1, 3 + i, bricks); f.place(7, 1, 3 + i, bricks); f.place(3 + i, 1, 3, bricks); f.place(3 + i, 1, 7, bricks); }
          f.place(5, 1, 5, bricks); f.place(5, 2, 5, bricks); f.place(5, 3, 5, bricks); f.place(5, 4, 5, st.id('water'));
          break;
        }
        case 2: {
          for (let i = 1; i <= 9; i++) { f.place(1, 3, i, cobble); f.place(9, 3, i, cobble); f.place(i, 3, 1, cobble); f.place(i, 3, 9, cobble); }
          for (const [x, y, z] of [[5, 1, 4], [5, 1, 6], [5, 3, 4], [5, 3, 6], [4, 1, 5], [6, 1, 5], [4, 3, 5], [6, 3, 5]]) f.place(x, y, z, cobble);
          for (let i = 1; i <= 3; i++) { f.place(4, i, 4, cobble); f.place(6, i, 4, cobble); f.place(4, i, 6, cobble); f.place(6, i, 6, cobble); }
          f.place(5, 3, 5, st.id('torch'));
          for (let i = 2; i <= 8; i++) { f.place(2, 3, i, planks); f.place(3, 3, i, planks); if (i <= 3 || i >= 7) f.place(4, 3, i, planks); f.place(7, 3, i, planks); f.place(8, 3, i, planks); if (i <= 3 || i >= 7) f.place(6, 3, i, planks); }
          f.place(9, 1, 3, planks); f.place(9, 2, 3, planks); f.place(9, 3, 3, planks);
          f.chest(3, 4, 8, 'chests/stronghold_crossing', 'south');
          break;
        }
      }
      break;
    }
    case 'straightStairs': {
      f.fillSel(0, 0, 0, 4, 10, 7, true, sel); smallDoor(f, p.door, 1, 7, 0); f.fill(1, 1, 7, 3, 3, 7, air);
      for (let i = 0; i < 6; i++) { f.place(1, 6 - i, 1 + i, stairs('south')); f.place(2, 6 - i, 1 + i, stairs('south')); f.place(3, 6 - i, 1 + i, stairs('south')); if (i < 5) { f.place(1, 5 - i, 1 + i, bricks); f.place(2, 5 - i, 1 + i, bricks); f.place(3, 5 - i, 1 + i, bricks); } }
      break;
    }
    case 'stairs': {
      f.fillSel(0, 0, 0, 4, 10, 4, true, sel); smallDoor(f, p.door, 1, 7, 0); smallDoor(f, 'opening', 1, 1, 4);
      const spiral: [number, number, number, number][] = [[2, 6, 1, bricks], [1, 5, 1, bricks], [1, 6, 1, slab], [1, 5, 2, bricks], [1, 4, 3, bricks], [1, 5, 3, slab], [2, 4, 3, bricks], [3, 3, 3, bricks], [3, 4, 3, slab], [3, 3, 2, bricks], [3, 2, 1, bricks], [3, 3, 1, slab], [2, 2, 1, bricks], [1, 1, 1, bricks], [1, 2, 1, slab], [1, 1, 2, bricks], [1, 1, 3, slab]];
      for (const [x, y, z, s] of spiral) f.place(x, y, z, s);
      break;
    }
    case 'five': {
      f.fillSel(0, 0, 0, 9, 8, 10, true, sel); smallDoor(f, p.door, 4, 3, 0);
      if (p.leftLow) f.fill(0, 3, 1, 0, 5, 3, air); if (p.rightLow) f.fill(9, 3, 1, 9, 5, 3, air); if (p.leftHigh) f.fill(0, 5, 7, 0, 7, 9, air); if (p.rightHigh) f.fill(9, 5, 7, 9, 7, 9, air);
      f.fill(5, 1, 10, 7, 3, 10, air);
      f.fillSel(1, 2, 1, 8, 2, 6, false, sel); f.fillSel(4, 1, 5, 4, 4, 9, false, sel); f.fillSel(8, 1, 5, 8, 4, 9, false, sel); f.fillSel(1, 4, 7, 3, 4, 9, false, sel); f.fillSel(1, 3, 5, 3, 3, 6, false, sel);
      f.fill(1, 3, 4, 3, 3, 4, slab); f.fill(1, 4, 6, 3, 4, 6, slab); f.fillSel(5, 1, 7, 7, 1, 8, false, sel); f.fill(5, 1, 9, 7, 1, 9, slab); f.fill(5, 2, 7, 7, 2, 7, slab); f.fill(4, 5, 7, 4, 5, 9, slab); f.fill(8, 5, 7, 8, 5, 9, slab); f.fill(5, 5, 7, 7, 5, 9, st.withProps('smooth_stone_slab', { type: 'double' }));
      f.place(6, 5, 6, torch('south'));
      break;
    }
    case 'chest': {
      f.fillSel(0, 0, 0, 4, 4, 6, true, sel); smallDoor(f, p.door, 1, 1, 0); f.fill(1, 1, 6, 3, 3, 6, air);
      f.fill(3, 1, 2, 3, 1, 4, bricks); f.place(3, 1, 1, bslab); f.place(3, 1, 5, bslab); f.place(3, 2, 2, bslab); f.place(3, 2, 4, bslab);
      for (let i = 2; i <= 4; i++) f.place(2, 1, i, bslab);
      f.chest(3, 2, 3, 'chests/stronghold_corridor', 'west');
      break;
    }
    case 'library': {
      const h = p.isTall ? 11 : 6;
      f.fillSel(0, 0, 0, 13, h - 1, 14, true, sel); smallDoor(f, p.door, 4, 1, 0);
      f.maybeFill(0.07, 2, 1, 1, 11, 4, 13, st.id('cobweb'));
      const shelf = st.id('bookshelf');
      for (let k = 1; k <= 13; k++) {
        const pillar = (k - 1) % 4 === 0;
        f.fill(1, 1, k, 1, 4, k, planks); f.fill(12, 1, k, 12, 4, k, planks);
        if (pillar) { f.fill(2, 3, k, 3, 3, k, planks); f.fill(10, 3, k, 11, 3, k, planks); }
        else { f.fill(2, 1, k, 3, 3, k, shelf); f.fill(10, 1, k, 11, 3, k, shelf); }
      }
      for (let l = 3; l < 12; l += 2) { f.fill(3, 1, l, 4, 3, l, shelf); f.fill(6, 1, l, 7, 3, l, shelf); f.fill(9, 1, l, 10, 3, l, shelf); }
      if (p.isTall) {
        f.fill(1, 5, 1, 3, 5, 13, planks); f.fill(10, 5, 1, 12, 5, 13, planks); f.fill(4, 5, 1, 9, 5, 2, planks); f.fill(4, 5, 12, 9, 5, 13, planks);
        f.place(9, 5, 11, planks); f.place(8, 5, 11, planks); f.place(9, 5, 10, planks);
        const fence = st.id('oak_fence');
        for (let z = 3; z <= 11; z++) { f.connect(3, 6, z, fence); f.connect(10, 6, z, fence); }
        for (let x = 4; x <= 9; x++) f.connect(x, 6, 2, fence);
        for (let x = 4; x <= 7; x++) f.connect(x, 6, 12, fence);
        f.connect(3, 6, 2, fence); f.connect(3, 6, 12, fence); f.connect(10, 6, 2, fence); f.connect(10, 6, 12, fence); f.connect(8, 6, 12, fence);
        f.connect(9, 6, 12, fence); f.connect(9, 6, 11, fence); f.connect(8, 6, 11, fence); f.connect(9, 6, 10, fence);
        for (let y = 1; y <= 7; y++) f.place(10, y, 13, f.st('ladder', { facing: 'north' }));
        f.place(6, 9, 7, st.id('oak_planks')); f.place(7, 9, 7, st.id('oak_planks'));
        f.place(5, 9, 7, f.st('oak_fence', { north: 'false', south: 'false', east: 'true', west: 'false' })); f.place(8, 9, 7, f.st('oak_fence', { north: 'false', south: 'false', east: 'false', west: 'true' }));
        for (let y = 8; y >= 6; y--) { f.place(6, y, 7, fence); f.place(7, y, 7, fence); }
        f.place(6, 8, 6, st.id('torch')); f.place(7, 8, 6, st.id('torch')); f.place(6, 8, 8, st.id('torch')); f.place(7, 8, 8, st.id('torch'));
        f.chest(12, 8, 1, 'chests/stronghold_library', 'south');
      }
      f.chest(3, 3, 5, 'chests/stronghold_library', 'east');
      break;
    }
    case 'portal': {
      f.fillSel(0, 0, 0, 10, 7, 15, false, sel); smallDoor(f, 'grates', 4, 1, 0);
      const i = 6;
      f.fillSel(1, i, 1, 1, i, 14, false, sel); f.fillSel(9, i, 1, 9, i, 14, false, sel); f.fillSel(2, i, 1, 8, i, 2, false, sel); f.fillSel(2, i, 14, 8, i, 14, false, sel);
      f.fillSel(1, 1, 1, 2, 1, 4, false, sel); f.fillSel(8, 1, 1, 9, 1, 4, false, sel);
      const lava = st.id('lava');
      f.fill(1, 1, 1, 1, 1, 3, lava); f.fill(9, 1, 1, 9, 1, 3, lava);
      f.fillSel(3, 1, 8, 7, 1, 12, false, sel); f.fill(4, 1, 9, 6, 1, 11, lava);
      for (let k = 3; k < 14; k += 2) { f.connect(0, 3, k, bars); f.connect(0, 4, k, bars); f.connect(10, 3, k, bars); f.connect(10, 4, k, bars); }
      for (let k = 2; k < 9; k += 2) { f.connect(k, 3, 15, bars); f.connect(k, 4, 15, bars); }
      f.fillSel(4, 1, 5, 6, 1, 7, false, sel); f.fillSel(4, 2, 6, 6, 2, 7, false, sel); f.fillSel(4, 3, 7, 6, 3, 7, false, sel);
      for (let k = 4; k <= 6; k++) { f.place(k, 1, 4, stairs('north')); f.place(k, 2, 5, stairs('north')); f.place(k, 3, 6, stairs('north')); }
      const frame = (x: number, z: number, facing: string) => { const eye = rnd.next() > 0.9; f.place(x, 3, z, f.st('end_portal_frame', { facing, eye: String(eye) })); return eye; };
      let eyes = 0;
      eyes += +frame(4, 8, 'north') + +frame(5, 8, 'north') + +frame(6, 8, 'north');
      eyes += +frame(4, 12, 'south') + +frame(5, 12, 'south') + +frame(6, 12, 'south');
      eyes += +frame(3, 9, 'east') + +frame(3, 10, 'east') + +frame(3, 11, 'east');
      eyes += +frame(7, 9, 'west') + +frame(7, 10, 'west') + +frame(7, 11, 'west');
      if (eyes === 12) f.fill(4, 3, 9, 6, 3, 11, st.id('end_portal'));
      f.spawner(5, 3, 6, 'silverfish');
      break;
    }
  }
}

/** generate + write one stronghold at chunk (cx, cz) */
export const STRONGHOLD: StructureType = {
  name: 'stronghold', dimension: 'overworld', reach: 8,
  candidates(ctx, cx, cz) { return strongholdPositions(ctx.seed).filter(([sx, sz]) => Math.abs(sx - cx) <= 8 && Math.abs(sz - cz) <= 8); },
  build(ctx, cx, cz, w) {
    let gen: Gen | null = null;
    // vanilla regenerates the whole stronghold until it contains a portal room
    for (let attempt = 0; attempt < 32 && !gen?.portal; attempt++) {
      const rnd = new Random(hashSeed(ctx.seed, cx, cz, 0x5ee + attempt));
      gen = new Gen(rnd, cx * 16 + 2, cz * 16 + 2);
      gen.start(DIRS[rnd.nextInt(4)]);
      while (gen.pending.length) { const i = rnd.nextInt(gen.pending.length); const p = gen.pending.splice(i, 1)[0]; gen.addChildren(p); }
    }
    if (!gen || !gen.portal) return false;
    // StructureStart.moveBelowSeaLevel(random, 10)
    let minY = 1e9, maxY = -1e9;
    for (const p of gen.pieces) { minY = Math.min(minY, p.box[1]); maxY = Math.max(maxY, p.box[4]); }
    const i = SEA_LEVEL - 10; let j = maxY - minY + 2;
    if (j < i) j += gen.rnd.nextInt(i - j);
    const k = j - maxY;
    for (const p of gen.pieces) { p.box[1] += k; p.box[4] += k; }
    for (const p of gen.pieces) { build(w, p, gen.rnd); w.start.pieceBoxes.push(p.box); }
    return true;
  },
};
