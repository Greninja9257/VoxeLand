// Piece-based structures (vanilla StructurePiece): a local (x, y, z) frame inside an oriented bounding box, with
// the same world mapping as vanilla getWorldX/getWorldZ so the piece code can be ported line by line.
import type { Random } from '../../math';
import { rotateY } from '../../blocks/placement';
import type { Box, StructureWriter } from './structures';

export type Dir = 'north' | 'south' | 'east' | 'west';
export const DIRS: Dir[] = ['north', 'south', 'east', 'west'];

/** StructurePiece.orientBox */
export function orientBox(x: number, y: number, z: number, offX: number, offY: number, offZ: number, sx: number, sy: number, sz: number, dir: Dir): Box {
  switch (dir) {
    case 'north': return [x + offX, y + offY, z - sz + 1 + offZ, x + sx - 1 + offX, y + sy - 1 + offY, z + offZ];
    case 'west': return [x - sz + 1 + offZ, y + offY, z + offX, x + offZ, y + sy - 1 + offY, z + sx - 1 + offX];
    case 'east': return [x + offZ, y + offY, z + offX, x + sz - 1 + offZ, y + sy - 1 + offY, z + sx - 1 + offX];
    default: return [x + offX, y + offY, z + offZ, x + sx - 1 + offX, y + sy - 1 + offY, z + sz - 1 + offZ];
  }
}
export function boxesIntersect(a: Box, b: Box): boolean { return a[0] <= b[3] && a[3] >= b[0] && a[1] <= b[4] && a[4] >= b[1] && a[2] <= b[5] && a[5] >= b[2]; }
export function ySpan(b: Box): number { return b[4] - b[1] + 1; }

/** Facing transform of the piece orientation (vanilla setOrientation mirror/rotation applied to a state). */
export function transformDir(d: string, dir: Dir): string {
  switch (dir) {
    case 'north': return d === 'north' ? 'south' : d === 'south' ? 'north' : d;           // mirror LEFT_RIGHT
    case 'west': return rotateY(d);                                                        // clockwise 90
    case 'east': return d === 'north' ? 'west' : d === 'west' ? 'north' : d === 'south' ? 'east' : d === 'east' ? 'south' : d; // ccw 90 + mirror
    default: return d;
  }
}

export interface Piece { box: Box; dir: Dir; depth: number; kind: string; [k: string]: any }

export class Frame {
  constructor(public w: StructureWriter, public box: Box, public dir: Dir, public rnd: Random) {}
  wx(x: number, z: number): number { switch (this.dir) { case 'north': case 'south': return this.box[0] + x; case 'west': return this.box[3] - z; default: return this.box[0] + z; } }
  wz(x: number, z: number): number { switch (this.dir) { case 'north': return this.box[5] - z; case 'south': return this.box[2] + z; default: return this.box[2] + x; } }
  wy(y: number): number { return this.box[1] + y; }
  private inside(wx: number, wy: number, wz: number): boolean { const b = this.box; return wx >= b[0] && wx <= b[3] && wy >= b[1] && wy <= b[4] && wz >= b[2] && wz <= b[5]; }
  /** block state by name with the facing/axis props transformed into world orientation */
  st(name: string, props?: Record<string, string>): number {
    if (!props) return this.w.ctx.st.id(name);
    const p: Record<string, string> = { ...props };
    if (p.facing) p.facing = transformDir(p.facing, this.dir);
    if (p.axis && (this.dir === 'east' || this.dir === 'west')) p.axis = p.axis === 'x' ? 'z' : p.axis === 'z' ? 'x' : p.axis;
    if (p.north !== undefined) { const src = { ...p }; for (const d of ['north', 'south', 'east', 'west']) p[transformDir(d, this.dir)] = src[d]; }
    return this.w.ctx.st.withProps(name, p);
  }
  place(x: number, y: number, z: number, state: number): void {
    const wx = this.wx(x, z), wy = this.wy(y), wz = this.wz(x, z);
    if (this.inside(wx, wy, wz)) this.w.set(wx, wy, wz, state);
  }
  get(x: number, y: number, z: number): number { const wx = this.wx(x, z), wy = this.wy(y), wz = this.wz(x, z); return this.inside(wx, wy, wz) ? this.w.get(wx, wy, wz) : 0; }
  isAir(x: number, y: number, z: number): boolean { const s = this.get(x, y, z); return s <= 0 || this.w.reg.isAir(s); }
  /** generateBox(x1..z2, boundary, interior, skipExisting): shell of `edge`, `inner` inside (default same) */
  fill(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, edge: number, inner = edge, skipExisting = false): void {
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
      if (skipExisting && this.isAir(x, y, z)) continue;
      const isEdge = x === x1 || x === x2 || y === y1 || y === y2 || z === z1 || z === z2;
      this.place(x, y, z, isEdge ? edge : inner);
    }
  }
  /** generateBox with a block selector (stone-brick mix): boundary blocks from the selector, interior air */
  fillSel(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, skipExisting: boolean, sel: (rnd: Random, edge: boolean) => number): void {
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
      if (skipExisting && this.isAir(x, y, z)) continue;
      const isEdge = x === x1 || x === x2 || y === y1 || y === y2 || z === z1 || z === z2;
      this.place(x, y, z, sel(this.rnd, isEdge));
    }
  }
  /** generateMaybeBox: each block placed with probability p */
  maybeFill(p: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, state: number, edgeOnly = false, skipExisting = false): void {
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
      if (this.rnd.next() > p) continue;
      if (skipExisting && this.isAir(x, y, z)) continue;
      if (edgeOnly && !(x === x1 || x === x2 || y === y1 || y === y2 || z === z1 || z === z2)) continue;
      this.place(x, y, z, state);
    }
  }
  maybe(p: number, x: number, y: number, z: number, state: number): void { if (this.rnd.next() < p) this.place(x, y, z, state); }
  /** fillColumnDown: from (x, y, z) downwards through air/liquid until something solid, at most 60 blocks */
  columnDown(state: number, x: number, y: number, z: number): void {
    const wx = this.wx(x, z), wz = this.wz(x, z);
    const reg = this.w.reg;
    for (let wy = this.wy(y), n = 0; wy > -60 && n < 60; wy--, n++) {
      const s = this.w.get(wx, wy, wz);
      if (!(s <= 0 || reg.isAir(s) || reg.isFluid(s) || reg.collisionBoxes(s).length === 0)) break;
      this.w.set(wx, wy, wz, state);
    }
  }
  chest(x: number, y: number, z: number, lootTable: string, facing = 'north'): void {
    const wx = this.wx(x, z), wy = this.wy(y), wz = this.wz(x, z);
    if (this.inside(wx, wy, wz)) this.w.chest(wx, wy, wz, this.st('chest', { facing }), lootTable);
  }
  spawner(x: number, y: number, z: number, mob: string): void {
    const wx = this.wx(x, z), wy = this.wy(y), wz = this.wz(x, z);
    if (this.inside(wx, wy, wz)) this.w.spawner(wx, wy, wz, mob);
  }
  /** a block whose connections (fence, bars, wall, stairs shape) are resolved after the whole structure is written */
  connect(x: number, y: number, z: number, state: number): void { const wx = this.wx(x, z), wy = this.wy(y), wz = this.wz(x, z); if (this.inside(wx, wy, wz)) { this.w.set(wx, wy, wz, state); this.w.connectLater(wx, wy, wz); } }
}

/** the four child-attachment points shared by strongholds and fortresses (generateSmallDoorChild* / generateChild*) */
export function childForward(b: Box, dir: Dir, xOff: number, yOff: number): [number, number, number, Dir] {
  switch (dir) {
    case 'north': return [b[0] + xOff, b[1] + yOff, b[2] - 1, 'north'];
    case 'south': return [b[0] + xOff, b[1] + yOff, b[5] + 1, 'south'];
    case 'west': return [b[0] - 1, b[1] + yOff, b[2] + xOff, 'west'];
    default: return [b[3] + 1, b[1] + yOff, b[2] + xOff, 'east'];
  }
}
export function childLeft(b: Box, dir: Dir, yOff: number, zOff: number): [number, number, number, Dir] {
  if (dir === 'north' || dir === 'south') return [b[0] - 1, b[1] + yOff, b[2] + zOff, 'west'];
  return [b[0] + zOff, b[1] + yOff, b[2] - 1, 'north'];
}
export function childRight(b: Box, dir: Dir, yOff: number, zOff: number): [number, number, number, Dir] {
  if (dir === 'north' || dir === 'south') return [b[3] + 1, b[1] + yOff, b[2] + zOff, 'east'];
  return [b[0] + zOff, b[1] + yOff, b[5] + 1, 'south'];
}
