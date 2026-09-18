// Nether fortresses: a port of vanilla NetherBridgePieces — bridge network from a crossing start, blaze-spawner
// thrones, and the enclosed castle corridors (stalk rooms, stairs, balconies) grown from castle entrances.
import { Random } from '../../math';
import { hashSeed } from './noise';
import { randomSpreadCandidates, type StructureType, type StructureWriter, type Box } from './structures';
import { Frame, orientBox, boxesIntersect, childForward, childLeft, childRight, DIRS, type Dir, type Piece } from './pieces';

interface FPiece extends Piece { castle: boolean; i?: number }
interface Weight { kind: string; weight: number; max: number; placed: number; allowInRow?: boolean }
const BRIDGE = (): Weight[] => [
  { kind: 'bridgeStraight', weight: 30, max: 0, placed: 0, allowInRow: true }, { kind: 'bridgeCrossing', weight: 10, max: 4, placed: 0 },
  { kind: 'roomCrossing', weight: 10, max: 4, placed: 0 }, { kind: 'stairsRoom', weight: 10, max: 3, placed: 0 },
  { kind: 'throne', weight: 5, max: 2, placed: 0 }, { kind: 'castleEntrance', weight: 5, max: 1, placed: 0 },
];
const CASTLE = (): Weight[] => [
  { kind: 'corridor', weight: 25, max: 0, placed: 0, allowInRow: true }, { kind: 'corridorCrossing', weight: 15, max: 5, placed: 0 },
  { kind: 'corridorRight', weight: 5, max: 10, placed: 0 }, { kind: 'corridorLeft', weight: 5, max: 10, placed: 0 },
  { kind: 'corridorStairs', weight: 10, max: 3, placed: 0, allowInRow: true }, { kind: 'balcony', weight: 7, max: 2, placed: 0 },
  { kind: 'stalkRoom', weight: 5, max: 2, placed: 0 },
];

class Gen {
  pieces: FPiece[] = [];
  pending: FPiece[] = [];
  bridge = BRIDGE(); castle = CASTLE();
  previous: Weight | null = null;
  constructor(public rnd: Random, public startX: number, public startZ: number) {}
  private ok(b: Box): boolean { return b[1] > 10 && !this.pieces.some((p) => boxesIntersect(p.box, b)); }

  private create(kind: string, x: number, y: number, z: number, dir: Dir, depth: number): FPiece | null {
    const mk = (b: Box, castle: boolean, extra: Partial<FPiece> = {}): FPiece | null => (this.ok(b) ? { kind, box: b, dir, depth, castle, ...extra } : null);
    switch (kind) {
      case 'bridgeStraight': return mk(orientBox(x, y, z, -1, -3, 0, 5, 10, 19, dir), false);
      case 'bridgeCrossing': return mk(orientBox(x, y, z, -8, -3, 0, 19, 10, 19, dir), false);
      case 'roomCrossing': return mk(orientBox(x, y, z, -2, 0, 0, 7, 9, 7, dir), false);
      case 'stairsRoom': return mk(orientBox(x, y, z, -2, 0, 0, 7, 11, 7, dir), false);
      case 'throne': return mk(orientBox(x, y, z, -2, 0, 0, 7, 8, 9, dir), false);
      case 'castleEntrance': return mk(orientBox(x, y, z, -5, -3, 0, 13, 14, 13, dir), false);
      case 'corridor': return mk(orientBox(x, y, z, -1, 0, 0, 5, 7, 5, dir), true);
      case 'corridorCrossing': return mk(orientBox(x, y, z, -1, 0, 0, 5, 7, 5, dir), true);
      case 'corridorRight': case 'corridorLeft': return mk(orientBox(x, y, z, -1, 0, 0, 5, 7, 5, dir), true, { i: this.rnd.nextInt(3) });
      case 'corridorStairs': return mk(orientBox(x, y, z, -1, -7, 0, 5, 14, 10, dir), true);
      case 'balcony': return mk(orientBox(x, y, z, -3, 0, 0, 9, 7, 9, dir), true, { i: this.rnd.nextInt(2) === 0 ? 1 : 5 });
      case 'stalkRoom': return mk(orientBox(x, y, z, -5, -3, 0, 13, 14, 13, dir), true);
      case 'bridgeEnd': return mk(orientBox(x, y, z, -1, -3, 0, 5, 10, 8, dir), false);
    }
    return null;
  }

  /** NetherBridgePieces.generatePiece */
  private generatePiece(weights: Weight[], x: number, y: number, z: number, dir: Dir, depth: number): FPiece | null {
    let total = 0; for (const w of weights) if (w.max === 0 || w.placed < w.max) total += w.weight;
    if (total > 0 && depth <= 30) {
      for (let j = 0; j < 5; j++) {
        let k = this.rnd.nextInt(total);
        for (const w of weights) {
          if (w.max > 0 && w.placed >= w.max) continue;
          k -= w.weight;
          if (k >= 0) continue;
          if (w === this.previous && !w.allowInRow) break;
          const p = this.create(w.kind, x, y, z, dir, depth);
          if (p) { w.placed++; this.previous = w; return p; }
          break;
        }
      }
    }
    return this.create('bridgeEnd', x, y, z, dir, depth);
  }

  add(x: number, y: number, z: number, dir: Dir, depth: number, castle: boolean): void {
    if (Math.abs(x - this.startX) > 112 || Math.abs(z - this.startZ) > 112 || this.pieces.length >= 200) return;
    const p = this.generatePiece(castle ? this.castle : this.bridge, x, y, z, dir, depth + 1);
    if (p) { this.pieces.push(p); this.pending.push(p); }
  }

  addChildren(p: FPiece): void {
    const b = p.box, d = p.dir, depth = p.depth;
    const fwd = (xo: number, yo: number, castle: boolean) => { const [x, y, z, dir] = childForward(b, d, xo, yo); this.add(x, y, z, dir, depth, castle); };
    const left = (yo: number, zo: number, castle: boolean) => { const [x, y, z, dir] = childLeft(b, d, yo, zo); this.add(x, y, z, dir, depth, castle); };
    const right = (yo: number, zo: number, castle: boolean) => { const [x, y, z, dir] = childRight(b, d, yo, zo); this.add(x, y, z, dir, depth, castle); };
    switch (p.kind) {
      case 'bridgeStraight': fwd(1, 3, false); break;
      case 'bridgeCrossing': fwd(8, 3, false); left(3, 8, false); right(3, 8, false); break;
      case 'roomCrossing': fwd(2, 0, false); left(0, 2, false); right(0, 2, false); break;
      case 'stairsRoom': right(6, 2, false); break;
      case 'castleEntrance': fwd(5, 3, true); break;
      case 'corridor': fwd(1, 0, true); break;
      case 'corridorCrossing': fwd(1, 0, true); left(0, 1, true); right(0, 1, true); break;
      case 'corridorRight': right(0, 1, true); break;
      case 'corridorLeft': left(0, 1, true); break;
      case 'corridorStairs': fwd(1, 0, true); break;
      case 'balcony': left(0, p.i ?? 1, true); right(0, p.i ?? 1, true); break;
      case 'stalkRoom': fwd(5, 3, true); fwd(5, 11, true); break;
    }
  }

  start(dir: Dir): void {
    const p: FPiece = { kind: 'bridgeCrossing', box: orientBox(this.startX, 64, this.startZ, -8, -3, 0, 19, 10, 19, dir), dir, depth: 0, castle: false };
    this.pieces.push(p); this.pending.push(p);
  }
}

function build(w: StructureWriter, p: FPiece, rnd: Random): void {
  const f = new Frame(w, p.box, p.dir, rnd);
  const st = w.ctx.st;
  const nb = st.id('nether_bricks'), air = 0, soul = st.id('soul_sand');
  const fenceNS = () => f.st('nether_brick_fence', { north: 'true', south: 'true', east: 'false', west: 'false' });
  const fenceEW = () => f.st('nether_brick_fence', { north: 'false', south: 'false', east: 'true', west: 'true' });
  const stairs = (facing: string) => f.st('nether_brick_stairs', { facing });
  const wart = () => st.withProps('nether_wart', { age: String(rnd.nextInt(4)) });
  switch (p.kind) {
    case 'bridgeStraight': {
      f.fill(0, 3, 0, 4, 4, 18, nb); f.fill(1, 5, 0, 3, 7, 18, air); f.fill(0, 5, 0, 0, 5, 18, nb); f.fill(4, 5, 0, 4, 5, 18, nb);
      f.fill(0, 2, 0, 4, 2, 5, nb); f.fill(0, 2, 13, 4, 2, 18, nb); f.fill(0, 0, 0, 1, 1, 4, nb); f.fill(3, 0, 0, 4, 1, 4, nb); f.fill(0, 0, 14, 1, 1, 18, nb); f.fill(3, 0, 14, 4, 1, 18, nb);
      for (let i = 0; i <= 4; i++) for (let j = 0; j <= 2; j++) { f.columnDown(nb, i, -1, j); f.columnDown(nb, i, -1, 18 - j); }
      break;
    }
    case 'bridgeEnd': {
      // BridgeEndFrame: a broken-off bridge whose deck, rails and arches end at random lengths
      f.fill(0, 3, 0, 4, 4, 7, air); f.fill(0, 5, 0, 4, 7, 7, air);
      for (let i = 0; i <= 4; i++) for (let j = 3; j <= 4; j++) { const k = rnd.nextInt(8); f.fill(i, j, 0, i, j, k, nb); }
      { const k = rnd.nextInt(8); f.fill(0, 5, 0, 0, 5, k, nb); } { const k = rnd.nextInt(8); f.fill(4, 5, 0, 4, 5, k, nb); }
      for (let i = 0; i <= 4; i++) { const k = rnd.nextInt(5); f.fill(i, 2, 0, i, 2, k, nb); }
      for (let i = 0; i <= 4; i++) for (let j = 0; j <= 1; j++) { const k = rnd.nextInt(3); f.fill(i, j, 0, i, j, k, nb); }
      break;
    }
    case 'bridgeCrossing': {
      f.fill(7, 3, 0, 11, 4, 18, nb); f.fill(0, 3, 7, 18, 4, 11, nb); f.fill(8, 5, 0, 10, 7, 18, air); f.fill(0, 5, 8, 18, 7, 10, air);
      f.fill(7, 5, 0, 7, 5, 7, nb); f.fill(7, 5, 11, 7, 5, 18, nb); f.fill(11, 5, 0, 11, 5, 7, nb); f.fill(11, 5, 11, 11, 5, 18, nb);
      f.fill(0, 5, 7, 7, 5, 7, nb); f.fill(11, 5, 7, 18, 5, 7, nb); f.fill(0, 5, 11, 7, 5, 11, nb); f.fill(11, 5, 11, 18, 5, 11, nb);
      f.fill(7, 2, 0, 11, 2, 5, nb); f.fill(7, 2, 13, 11, 2, 18, nb); f.fill(7, 0, 0, 11, 1, 3, nb); f.fill(7, 0, 15, 11, 1, 18, nb);
      for (let i = 7; i <= 11; i++) for (let j = 0; j <= 2; j++) { f.columnDown(nb, i, -1, j); f.columnDown(nb, i, -1, 18 - j); }
      f.fill(0, 2, 7, 5, 2, 11, nb); f.fill(13, 2, 7, 18, 2, 11, nb); f.fill(0, 0, 7, 3, 1, 11, nb); f.fill(15, 0, 7, 18, 1, 11, nb);
      for (let i = 0; i <= 2; i++) for (let j = 7; j <= 11; j++) { f.columnDown(nb, i, -1, j); f.columnDown(nb, 18 - i, -1, j); }
      break;
    }
    case 'roomCrossing': {
      f.fill(0, 0, 0, 6, 1, 6, nb); f.fill(0, 2, 0, 6, 7, 6, air);
      f.fill(0, 2, 0, 1, 6, 0, nb); f.fill(0, 2, 6, 1, 6, 6, nb); f.fill(5, 2, 0, 6, 6, 0, nb); f.fill(5, 2, 6, 6, 6, 6, nb);
      f.fill(0, 2, 0, 0, 6, 1, nb); f.fill(0, 2, 5, 0, 6, 6, nb); f.fill(6, 2, 0, 6, 6, 1, nb); f.fill(6, 2, 5, 6, 6, 6, nb);
      f.fill(2, 6, 0, 4, 6, 0, fenceEW()); f.fill(2, 5, 0, 4, 5, 0, fenceEW()); f.fill(2, 6, 6, 4, 6, 6, fenceEW()); f.fill(2, 5, 6, 4, 5, 6, fenceEW());
      f.fill(0, 6, 2, 0, 6, 4, fenceNS()); f.fill(0, 5, 2, 0, 5, 4, fenceNS()); f.fill(6, 6, 2, 6, 6, 4, fenceNS()); f.fill(6, 5, 2, 6, 5, 4, fenceNS());
      f.fill(0, 7, 0, 6, 8, 6, nb); f.fill(1, 8, 1, 5, 8, 5, air);
      for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) f.columnDown(nb, i, -1, j);
      break;
    }
    case 'stairsRoom': {
      f.fill(0, 0, 0, 6, 1, 6, nb); f.fill(0, 2, 0, 6, 10, 6, air);
      f.fill(0, 2, 0, 1, 8, 0, nb); f.fill(5, 2, 0, 6, 8, 0, nb); f.fill(0, 2, 1, 0, 8, 6, nb); f.fill(6, 2, 1, 6, 8, 6, nb); f.fill(1, 2, 6, 5, 8, 6, nb);
      f.fill(0, 3, 2, 0, 5, 4, fenceNS()); f.fill(6, 3, 2, 6, 5, 2, fenceNS()); f.fill(6, 3, 4, 6, 5, 4, fenceNS());
      f.place(5, 2, 5, nb); f.fill(4, 2, 5, 4, 3, 5, nb); f.fill(3, 2, 5, 3, 4, 5, nb); f.fill(2, 2, 5, 2, 5, 5, nb); f.fill(1, 2, 5, 1, 6, 5, nb); f.fill(1, 7, 1, 5, 7, 4, nb); f.fill(6, 8, 2, 6, 8, 4, air);
      f.fill(2, 6, 0, 4, 8, 0, fenceEW()); f.fill(2, 5, 0, 4, 5, 0, fenceEW());
      for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) f.columnDown(nb, i, -1, j);
      break;
    }
    case 'throne': {
      f.fill(0, 2, 0, 6, 7, 7, air); f.fill(1, 0, 0, 5, 1, 7, nb); f.fill(1, 2, 1, 5, 2, 7, nb); f.fill(1, 3, 2, 5, 3, 7, nb); f.fill(1, 4, 3, 5, 4, 7, nb); f.fill(1, 2, 0, 1, 4, 2, nb); f.fill(5, 2, 0, 5, 4, 2, nb); f.fill(1, 5, 2, 1, 5, 3, nb); f.fill(5, 5, 2, 5, 5, 3, nb); f.fill(0, 5, 3, 0, 5, 8, nb); f.fill(6, 5, 3, 6, 5, 8, nb); f.fill(1, 5, 8, 5, 5, 8, nb);
      f.place(1, 6, 3, fenceEW()); f.place(5, 6, 3, fenceEW()); f.place(0, 6, 3, f.st('nether_brick_fence', { east: 'true', south: 'true', north: 'false', west: 'false' })); f.place(6, 6, 3, f.st('nether_brick_fence', { west: 'true', south: 'true', north: 'false', east: 'false' }));
      f.fill(0, 6, 4, 0, 6, 7, fenceNS()); f.fill(6, 6, 4, 6, 6, 7, fenceNS());
      f.place(0, 6, 8, f.st('nether_brick_fence', { east: 'true', north: 'true', south: 'false', west: 'false' })); f.place(6, 6, 8, f.st('nether_brick_fence', { west: 'true', north: 'true', south: 'false', east: 'false' }));
      f.fill(1, 6, 8, 5, 6, 8, fenceEW()); f.place(1, 7, 8, f.st('nether_brick_fence', { east: 'true', north: 'false', south: 'false', west: 'false' })); f.fill(2, 7, 8, 4, 7, 8, fenceEW()); f.place(5, 7, 8, f.st('nether_brick_fence', { west: 'true', north: 'false', south: 'false', east: 'false' }));
      f.place(2, 8, 8, f.st('nether_brick_fence', { east: 'true', north: 'false', south: 'false', west: 'false' })); f.place(3, 8, 8, fenceEW()); f.place(4, 8, 8, f.st('nether_brick_fence', { west: 'true', north: 'false', south: 'false', east: 'false' }));
      f.spawner(3, 5, 5, 'blaze');
      for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) f.columnDown(nb, i, -1, j);
      break;
    }
    case 'castleEntrance': {
      f.fill(0, 3, 0, 12, 4, 12, nb); f.fill(0, 5, 0, 12, 13, 12, air); f.fill(0, 5, 0, 1, 12, 12, nb); f.fill(11, 5, 0, 12, 12, 12, nb); f.fill(2, 5, 11, 4, 12, 12, nb); f.fill(8, 5, 11, 10, 12, 12, nb); f.fill(5, 9, 11, 7, 12, 12, nb); f.fill(2, 5, 0, 4, 12, 1, nb); f.fill(8, 5, 0, 10, 12, 1, nb); f.fill(5, 9, 0, 7, 12, 1, nb); f.fill(2, 11, 2, 10, 12, 10, nb); f.fill(5, 8, 0, 7, 8, 0, fenceEW());
      for (let i = 1; i <= 11; i += 2) { f.fill(i, 10, 0, i, 11, 0, fenceEW()); f.fill(i, 10, 12, i, 11, 12, fenceEW()); f.fill(0, 10, i, 0, 11, i, fenceNS()); f.fill(12, 10, i, 12, 11, i, fenceNS()); f.place(i, 13, 0, nb); f.place(i, 13, 12, nb); f.place(0, 13, i, nb); f.place(12, 13, i, nb); if (i !== 11) { f.place(i + 1, 13, 0, fenceEW()); f.place(i + 1, 13, 12, fenceEW()); f.place(0, 13, i + 1, fenceNS()); f.place(12, 13, i + 1, fenceNS()); } }
      f.place(0, 13, 0, f.st('nether_brick_fence', { north: 'true', east: 'true', south: 'false', west: 'false' })); f.place(0, 13, 12, f.st('nether_brick_fence', { south: 'true', east: 'true', north: 'false', west: 'false' })); f.place(12, 13, 12, f.st('nether_brick_fence', { south: 'true', west: 'true', north: 'false', east: 'false' })); f.place(12, 13, 0, f.st('nether_brick_fence', { north: 'true', west: 'true', south: 'false', east: 'false' }));
      for (let j = 3; j <= 9; j += 2) { f.fill(1, 7, j, 1, 8, j, fenceNS()); f.fill(11, 7, j, 11, 8, j, fenceNS()); }
      f.fill(4, 2, 0, 8, 2, 12, nb); f.fill(0, 2, 4, 12, 2, 8, nb); f.fill(4, 5, 4, 8, 5, 8, nb); f.fill(1, 3, 1, 3, 3, 3, nb); f.fill(9, 3, 1, 11, 3, 3, nb); f.fill(9, 3, 9, 11, 3, 11, nb); f.fill(1, 3, 9, 3, 3, 11, nb);
      f.fill(4, 3, 4, 4, 5, 4, nb); f.fill(8, 3, 4, 8, 5, 4, nb); f.fill(4, 3, 8, 4, 5, 8, nb); f.fill(8, 3, 8, 8, 5, 8, nb);
      f.fill(5, 4, 5, 7, 4, 7, air); f.place(6, 3, 6, st.id('lava')); // vanilla: the entrance well of lava
      for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) if (i === 0 || i === 12 || j === 0 || j === 12) f.columnDown(nb, i, -1, j);
      break;
    }
    case 'corridor': {
      f.fill(0, 0, 0, 4, 1, 4, nb); f.fill(0, 2, 0, 4, 5, 4, air); f.fill(0, 2, 0, 0, 5, 4, nb); f.fill(4, 2, 0, 4, 5, 4, nb);
      f.fill(0, 3, 1, 0, 4, 1, fenceNS()); f.fill(0, 3, 3, 0, 4, 3, fenceNS()); f.fill(4, 3, 1, 4, 4, 1, fenceNS()); f.fill(4, 3, 3, 4, 4, 3, fenceNS());
      f.fill(0, 6, 0, 4, 6, 4, nb);
      break;
    }
    case 'corridorCrossing': { f.fill(0, 0, 0, 4, 1, 4, nb); f.fill(0, 2, 0, 4, 5, 4, air); f.fill(0, 2, 0, 0, 5, 0, nb); f.fill(4, 2, 0, 4, 5, 0, nb); f.fill(0, 2, 4, 0, 5, 4, nb); f.fill(4, 2, 4, 4, 5, 4, nb); f.fill(0, 6, 0, 4, 6, 4, nb); break; }
    case 'corridorRight': case 'corridorLeft': {
      const right = p.kind === 'corridorRight';
      f.fill(0, 0, 0, 4, 1, 4, nb); f.fill(0, 2, 0, 4, 5, 4, air);
      if (right) { f.fill(4, 2, 0, 4, 5, 4, nb); f.fill(4, 3, 1, 4, 4, 1, fenceNS()); f.fill(4, 3, 3, 4, 4, 3, fenceNS()); f.fill(0, 2, 0, 0, 5, 0, nb); f.fill(1, 2, 4, 4, 5, 4, nb); f.fill(1, 3, 4, 1, 4, 4, fenceEW()); f.fill(3, 3, 4, 3, 4, 4, fenceEW()); }
      else { f.fill(0, 2, 0, 0, 5, 4, nb); f.fill(0, 3, 1, 0, 4, 1, fenceNS()); f.fill(0, 3, 3, 0, 4, 3, fenceNS()); f.fill(4, 2, 0, 4, 5, 0, nb); f.fill(0, 2, 4, 3, 5, 4, nb); f.fill(1, 3, 4, 1, 4, 4, fenceEW()); f.fill(3, 3, 4, 3, 4, 4, fenceEW()); }
      f.fill(0, 6, 0, 4, 6, 4, nb);
      break;
    }
    case 'corridorStairs': {
      // CastleSmallCorridorStairsPiece: the corridor drops 7 blocks over its 10-block length
      for (let z = 0; z <= 9; z++) {
        const h = Math.max(1, 8 - z); // floor top
        f.fill(0, 0, z, 0, Math.min(13, h + 6), z, nb); f.fill(4, 0, z, 4, Math.min(13, h + 6), z, nb);
        f.fill(1, 0, z, 3, h - 1, z, nb);
        f.fill(1, h, z, 3, h, z, z >= 8 ? nb : stairs('north'));
        f.fill(1, h + 1, z, 3, Math.min(13, h + 5), z, air);
        if (h + 6 <= 13) f.fill(1, h + 6, z, 3, h + 6, z, nb);
      }
      f.fill(0, 10, 2, 0, 11, 2, fenceNS()); f.fill(4, 10, 2, 4, 11, 2, fenceNS()); f.fill(0, 6, 6, 0, 7, 6, fenceNS()); f.fill(4, 6, 6, 4, 7, 6, fenceNS());
      break;
    }
    case 'balcony': {
      f.fill(0, 0, 0, 8, 1, 8, nb); f.fill(0, 2, 0, 8, 5, 8, air); f.fill(0, 6, 0, 8, 6, 5, nb); f.fill(0, 2, 0, 2, 5, 0, nb); f.fill(6, 2, 0, 8, 5, 0, nb); f.fill(1, 3, 0, 1, 4, 0, fenceEW()); f.fill(7, 3, 0, 7, 4, 0, fenceEW()); f.fill(0, 2, 4, 8, 2, 8, nb); f.fill(1, 1, 6, 7, 1, 7, air); f.fill(1, 2, 6, 7, 3, 7, air);
      f.fill(1, 3, 8, 7, 3, 8, fenceEW()); f.fill(2, 4, 8, 6, 4, 8, fenceEW()); f.place(1, 4, 8, f.st('nether_brick_fence', { east: 'true', north: 'false', south: 'false', west: 'false' })); f.place(7, 4, 8, f.st('nether_brick_fence', { west: 'true', north: 'false', south: 'false', east: 'false' }));
      f.fill(0, 3, 6, 0, 4, 8, fenceNS()); f.fill(8, 3, 6, 8, 4, 8, fenceNS()); f.place(0, 3, 5, fenceNS()); f.place(8, 3, 5, fenceNS());
      f.fill(0, 2, 0, 0, 5, 4, nb); f.fill(8, 2, 0, 8, 5, 4, nb); f.fill(0, 3, 1, 0, 4, 1, fenceNS()); f.fill(0, 3, 3, 0, 4, 3, fenceNS()); f.fill(8, 3, 1, 8, 4, 1, fenceNS()); f.fill(8, 3, 3, 8, 4, 3, fenceNS());
      break;
    }
    case 'stalkRoom': {
      f.fill(0, 3, 0, 12, 4, 12, nb); f.fill(0, 5, 0, 12, 13, 12, air); f.fill(0, 5, 0, 1, 12, 12, nb); f.fill(11, 5, 0, 12, 12, 12, nb); f.fill(2, 5, 11, 4, 12, 12, nb); f.fill(8, 5, 11, 10, 12, 12, nb); f.fill(5, 9, 11, 7, 12, 12, nb); f.fill(2, 5, 0, 4, 12, 1, nb); f.fill(8, 5, 0, 10, 12, 1, nb); f.fill(5, 9, 0, 7, 12, 1, nb); f.fill(2, 11, 2, 10, 12, 10, nb); f.fill(5, 8, 0, 7, 8, 0, fenceEW());
      for (let i = 1; i <= 11; i += 2) { f.fill(i, 10, 0, i, 11, 0, fenceEW()); f.fill(i, 10, 12, i, 11, 12, fenceEW()); f.fill(0, 10, i, 0, 11, i, fenceNS()); f.fill(12, 10, i, 12, 11, i, fenceNS()); f.place(i, 13, 0, nb); f.place(i, 13, 12, nb); f.place(0, 13, i, nb); f.place(12, 13, i, nb); if (i !== 11) { f.place(i + 1, 13, 0, fenceEW()); f.place(i + 1, 13, 12, fenceEW()); f.place(0, 13, i + 1, fenceNS()); f.place(12, 13, i + 1, fenceNS()); } }
      f.place(0, 13, 0, f.st('nether_brick_fence', { north: 'true', east: 'true', south: 'false', west: 'false' })); f.place(0, 13, 12, f.st('nether_brick_fence', { south: 'true', east: 'true', north: 'false', west: 'false' })); f.place(12, 13, 12, f.st('nether_brick_fence', { south: 'true', west: 'true', north: 'false', east: 'false' })); f.place(12, 13, 0, f.st('nether_brick_fence', { north: 'true', west: 'true', south: 'false', east: 'false' }));
      for (let j = 3; j <= 9; j += 2) { f.fill(1, 7, j, 1, 8, j, fenceNS()); f.fill(11, 7, j, 11, 8, j, fenceNS()); }
      // the two-storey stalk garden: nether brick stairs up the sides and soul sand beds with nether wart
      for (let k = 0; k <= 6; k++) { const l = k + 4; for (let m = 5; m <= 7; m++) f.place(m, 5 + k, l, stairs('south')); if (l >= 5 && l <= 8) f.fill(5, 5, l, 7, 4 + k, l, nb); else if (l >= 9 && l <= 10) { f.fill(5, 8, l, 7, 4 + k, l, nb); f.fill(5, 5, l, 7, 7, l, nb); } if (k >= 1) f.fill(5, 6 + k, l, 7, 9 + k, l, air); }
      for (let m = 5; m <= 7; m++) f.place(m, 12, 11, stairs('south'));
      f.fill(5, 6, 7, 5, 7, 7, fenceNS()); f.fill(7, 6, 7, 7, 7, 7, fenceNS()); f.fill(5, 13, 12, 7, 13, 12, air); f.fill(2, 5, 2, 3, 5, 3, nb); f.fill(2, 5, 9, 3, 5, 10, nb); f.fill(2, 5, 4, 2, 5, 8, nb); f.fill(9, 5, 2, 10, 5, 3, nb); f.fill(9, 5, 9, 10, 5, 10, nb); f.fill(10, 5, 4, 10, 5, 8, nb);
      f.fill(4, 2, 0, 8, 2, 12, nb); f.fill(0, 2, 4, 12, 2, 8, nb); f.fill(4, 5, 4, 8, 5, 8, nb); f.fill(1, 3, 1, 3, 3, 3, nb); f.fill(9, 3, 1, 11, 3, 3, nb); f.fill(9, 3, 9, 11, 3, 11, nb); f.fill(1, 3, 9, 3, 3, 11, nb);
      f.fill(4, 3, 4, 4, 5, 4, nb); f.fill(8, 3, 4, 8, 5, 4, nb); f.fill(4, 3, 8, 4, 5, 8, nb); f.fill(8, 3, 8, 8, 5, 8, nb);
      f.fill(3, 4, 4, 4, 4, 8, soul); f.fill(8, 4, 4, 9, 4, 8, soul); for (let x = 3; x <= 4; x++) for (let z = 4; z <= 8; z++) f.place(x, 5, z, wart()); for (let x = 8; x <= 9; x++) for (let z = 4; z <= 8; z++) f.place(x, 5, z, wart());
      f.fill(5, 4, 5, 7, 4, 7, air);
      for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) if (i === 0 || i === 12 || j === 0 || j === 12) f.columnDown(nb, i, -1, j);
      break;
    }
  }
}

/** The fortress mob list is only used inside its pieces (vanilla structure spawn overrides with PIECE bounds). */
export const FORTRESS_MOBS: [string, number][] = [['blaze', 10], ['zombified_piglin', 5], ['wither_skeleton', 8], ['skeleton', 2], ['magma_cube', 3]];

export const FORTRESS: StructureType = {
  name: 'fortress', dimension: 'the_nether', reach: 8,
  candidates(ctx, cx, cz) {
    const set = ctx.bundle?.structureSets.nether_complexes?.placement ?? { spacing: 27, separation: 4, salt: 30084232 };
    return randomSpreadCandidates(ctx.seed, set.spacing, set.separation, set.salt, this.reach, cx, cz);
  },
  valid(ctx, cx, cz) { return pickComplex(ctx.seed, cx, cz, ctx.biomeAt(cx * 16, cz * 16).name) === 'fortress'; },
  build(ctx, cx, cz, w) {
    if (this.valid && !this.valid(ctx, cx, cz)) return false;
    const rnd = new Random(hashSeed(ctx.seed, cx, cz, 0xf047));
    const gen = new Gen(rnd, cx * 16 + 2, cz * 16 + 2);
    gen.start(DIRS[rnd.nextInt(4)]);
    while (gen.pending.length) { const i = rnd.nextInt(gen.pending.length); const p = gen.pending.splice(i, 1)[0]; gen.addChildren(p); }
    for (const p of gen.pieces) { build(w, p, rnd); w.start.pieceBoxes.push(p.box); }
    return true;
  },
};

/** vanilla nether_complexes set: fortress (weight 2) or bastion (weight 3) per placement chunk; bastions aren't
 *  generated, but their slots stay empty so fortress density matches vanilla. Basalt deltas never get bastions. */
function pickComplex(seed: number, cx: number, cz: number, biome: string): 'fortress' | 'bastion' | null {
  const rnd = new Random(hashSeed(seed, cx, cz, 0xba5710));
  const entries: ['fortress' | 'bastion', number][] = [['fortress', 2], ['bastion', 3]];
  let total = 5;
  while (entries.length) {
    let r = rnd.nextInt(total), idx = 0;
    for (; idx < entries.length; idx++) { r -= entries[idx][1]; if (r < 0) break; }
    const [kind, weight] = entries[Math.min(idx, entries.length - 1)];
    if (kind === 'fortress') return 'fortress';
    if (biome !== 'basalt_deltas') return 'bastion';
    entries.splice(entries.indexOf(entries[Math.min(idx, entries.length - 1)]), 1); total -= weight;
  }
  return null;
}
