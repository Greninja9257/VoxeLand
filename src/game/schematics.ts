// Schematics: copy a selected region (with block entities) into the browser's IndexedDB, paste it back relative to
// where the player stands (WorldEdit //copy + //paste semantics), and export/import as JSON files.
import type { Game } from './game';
import { storage } from '../save/storage';
import { parseBlockString, rotateProps, rotPos } from '../world/gen/jigsaw';
import { MIN_Y, MAX_Y } from '../world/chunk';

export interface Schematic {
  name: string;
  size: [number, number, number];
  /** "name[prop=value,…]" per palette entry */
  palette: string[];
  /** palette index per block, x-major within z within y (index = (y * sz + z) * sx + x); -1 = structure void (not copied) */
  blocks: number[];
  blockEntities: { x: number; y: number; z: number; data: any }[];
  /** the copy origin (where the player stood) relative to the region's minimum corner */
  offset: [number, number, number];
  created: number;
}

export const MAX_SCHEMATIC_BLOCKS = 2_000_000;
const INDEX_KEY = 'schem:index';
const key = (name: string) => 'schem:' + name.toLowerCase();

export const schematicStore = {
  async list(): Promise<string[]> { return (await storage.loadState<string[]>('global', INDEX_KEY).catch(() => undefined)) ?? []; },
  load(name: string): Promise<Schematic | undefined> { return storage.loadState<Schematic>('global', key(name)); },
  async save(s: Schematic): Promise<void> {
    await storage.saveState('global', key(s.name), s);
    const names = await this.list();
    if (!names.some((n) => n.toLowerCase() === s.name.toLowerCase())) { names.push(s.name); await storage.saveState('global', INDEX_KEY, names); }
  },
  async delete(name: string): Promise<boolean> {
    const names = await this.list();
    const i = names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    if (i < 0) return false;
    names.splice(i, 1);
    await storage.saveState('global', INDEX_KEY, names);
    await storage.deleteState('global', key(name));
    return true;
  },
};

export function validSchematicName(name: string): boolean { return /^[\w.-]{1,32}$/.test(name); }

/** Copy the blocks between corners a and b; `origin` is the player's block position. */
export function captureSchematic(g: Game, name: string, a: [number, number, number], b: [number, number, number], origin: [number, number, number]): Schematic {
  const reg = g.registry, w = g.world;
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.max(MIN_Y, Math.min(a[1], b[1])), y1 = Math.min(MAX_Y - 1, Math.max(a[1], b[1])), z0 = Math.min(a[2], b[2]), z1 = Math.max(a[2], b[2]);
  const sx = x1 - x0 + 1, sy = y1 - y0 + 1, sz = z1 - z0 + 1;
  if (sx * sy * sz > MAX_SCHEMATIC_BLOCKS) throw new Error(`Selection too large (${sx}×${sy}×${sz}; at most ${MAX_SCHEMATIC_BLOCKS.toLocaleString()} blocks)`);
  const palette: string[] = [], paletteIndex = new Map<number, number>();
  const blocks = new Array<number>(sx * sy * sz);
  const blockEntities: Schematic['blockEntities'] = [];
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const wx = x0 + x, wy = y0 + y, wz = z0 + z;
    const st = w.isLoaded(wx, wz) ? w.getBlock(wx, wy, wz) : 0;
    let pi = paletteIndex.get(st);
    if (pi === undefined) {
      const props = reg.getProps(st); const keys = Object.keys(props);
      pi = palette.length; palette.push(reg.nameOf(st) + (keys.length ? '[' + keys.map((k) => `${k}=${props[k]}`).join(',') + ']' : ''));
      paletteIndex.set(st, pi);
    }
    blocks[(y * sz + z) * sx + x] = pi;
    const be = g.blockEntities.get(wx, wy, wz);
    if (be) blockEntities.push({ x, y, z, data: stripBlockEntity(g.blockEntities.serializeOne(be)) });
  }
  return { name, size: [sx, sy, sz], palette, blocks, blockEntities, offset: [origin[0] - x0, origin[1] - y0, origin[2] - z0], created: Date.now() };
}

function stripBlockEntity(d: any): any { const out = { ...d }; delete out.x; delete out.y; delete out.z; delete out.viewers; return out; }

/** Paste with the region placed relative to `origin` like it was copied; rot = 0/90/180/270 clockwise. Returns blocks set. */
export function pasteSchematic(g: Game, s: Schematic, origin: [number, number, number], rot = 0): number {
  const reg = g.registry, w = g.world;
  const [sx, sy, sz] = s.size;
  const r = ((Math.round(rot / 90) % 4) + 4) % 4;
  const states = s.palette.map((p) => {
    const { name, props } = parseBlockString(p);
    const b = reg.blockByName(name);
    return b ? reg.stateWith(b, r ? rotateProps(props, r) : props) : 0;
  });
  // the copy origin rotates with the region: local = (x - ox, z - oz) rotated, then placed at the player
  const [ox, oy, oz] = s.offset;
  const pos = (x: number, y: number, z: number): [number, number, number] => { const [rx, rz] = rotPos(x - ox, z - oz, r); return [origin[0] + rx, origin[1] + y - oy, origin[2] + rz]; };
  let n = 0;
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const pi = s.blocks[(y * sz + z) * sx + x];
    if (pi === undefined || pi < 0) continue;
    const [wx, wy, wz] = pos(x, y, z);
    if (wy < MIN_Y || wy >= MAX_Y || !w.isLoaded(wx, wz)) continue;
    g.blockEntities.remove(wx, wy, wz);
    w.setBlock(wx, wy, wz, states[pi] ?? 0, 0);
    n++;
  }
  for (const be of s.blockEntities) {
    const [wx, wy, wz] = pos(be.x, be.y, be.z);
    if (wy < MIN_Y || wy >= MAX_Y || !w.isLoaded(wx, wz) || !w.getBlock(wx, wy, wz)) continue;
    g.blockEntities.put(wx, wy, wz, be.data);
  }
  return n;
}

/** Structural check for schematic data received from another client or a file. */
export function isSchematic(d: any): d is Schematic {
  if (!d || typeof d !== 'object' || typeof d.name !== 'string' || !Array.isArray(d.size) || d.size.length !== 3 || !Array.isArray(d.palette) || !Array.isArray(d.blocks) || !Array.isArray(d.offset)) return false;
  const [sx, sy, sz] = d.size;
  if (![sx, sy, sz].every((v) => Number.isInteger(v) && v > 0) || sx * sy * sz > MAX_SCHEMATIC_BLOCKS || d.blocks.length !== sx * sy * sz) return false;
  if (!d.palette.every((p: any) => typeof p === 'string' && p.length < 256) || d.palette.length > 65536) return false;
  if (!Array.isArray(d.blockEntities)) d.blockEntities = [];
  return d.offset.every((v: any) => Number.isInteger(v));
}

/** Download as a .json file. */
export function exportSchematic(s: Schematic): void {
  const blob = new Blob([JSON.stringify(s)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${s.name}.schem.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** File picker → parsed schematic (or null when cancelled). */
export function importSchematic(): Promise<Schematic | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0]; if (!f) { resolve(null); return; }
      try { const d = JSON.parse(await f.text()); if (!isSchematic(d)) throw new Error('not a schematic'); d.name = String(d.name).replace(/[^\w.-]/g, '_').slice(0, 32) || f.name.replace(/\..*$/, '').slice(0, 32); resolve(d); }
      catch { resolve(null); }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
