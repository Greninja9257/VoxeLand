// Redstone: power model (weak/strong signals), wire propagation, and powered components.
import type { Game } from '../game/game';
import { DIR_NAMES, DIR_VEC, DIR_OPPOSITE } from '../math';
import { facingOffset, oppositeFacing, rotateY, rotateYCCW, isReplaceable } from './placement';
import { SET_UPDATE_NEIGHBORS } from '../world/world';
import { ItemStack } from '../items/stack';
import { ArrowEntity, PrimedTnt, ThrownProjectile } from '../entity/misc';
import { playNote } from './interaction';

const DIRS = DIR_NAMES;
const HDIRS = ['north', 'south', 'west', 'east'];

export class Redstone {
  private queue: number[] = [];
  private queued = new Set<string>();
  private processing = false;
  constructor(private game: Game) {}
  private get reg() { return this.game.registry; }
  private get world() { return this.game.world; }

  private isConductor(state: number): boolean {
    if (state === 0) return false;
    const reg = this.reg;
    if (!reg.fullCube[state]) return false;
    const n = reg.nameOf(state);
    if (reg.isFluid(state) || n === 'redstone_block' || n === 'observer' || n === 'piston' || n === 'sticky_piston' || n === 'glass' || n.endsWith('_stained_glass') || n === 'tinted_glass' || n === 'glowstone' || n === 'sea_lantern' || n === 'ice' || n === 'packed_ice' || n === 'blue_ice' || n.endsWith('_leaves') || n === 'beacon' || n === 'slime_block' || n === 'honey_block' || n === 'redstone_lamp' && false || n.endsWith('shulker_box') || n === 'hopper' || n === 'daylight_detector' || n === 'barrier' || n === 'target' && false || n === 'moving_piston' || n === 'piston_head' || n === 'end_portal_frame' || n === 'spawner' || n === 'chest' || n === 'trapped_chest' || n === 'ender_chest' || n === 'brewing_stand') return false;
    return true;
  }

  /** Signal the block at (x,y,z) emits toward direction dir (index). */
  weakSignal(x: number, y: number, z: number, dir: number, excludeWires = false): number {
    const reg = this.reg, world = this.world;
    const s = world.getBlock(x, y, z);
    if (s === 0) return 0;
    const n = reg.nameOf(s);
    const props = reg.getProps(s);
    const dirName = DIRS[dir];
    switch (n) {
      case 'redstone_block': return 15;
      case 'redstone_wire': { if (excludeWires) return 0; if (dir === 1) return 0; if (dir === 0) return +props.power; const side = props[dirName]; return side !== 'none' ? +props.power : 0; }
      case 'redstone_torch': return props.lit === 'true' && dir !== 0 ? 15 : 0;
      case 'redstone_wall_torch': return props.lit === 'true' && props.facing !== oppositeFacing(dirName) ? 15 : 0;
      case 'lever': return props.powered === 'true' ? 15 : 0;
      case 'daylight_detector': return +props.power;
      case 'target': return +props.power;
      case 'trapped_chest': { const be = this.game.blockEntities.get(x, y, z); return be?.viewers ? Math.min(15, be.viewers) : 0; }
      case 'lectern': return props.powered === 'true' ? 15 : 0;
      case 'tripwire_hook': return props.powered === 'true' ? 15 : 0;
      case 'detector_rail': return props.powered === 'true' ? 15 : 0;
      case 'observer': return props.powered === 'true' && props.facing === oppositeFacing(dirName) ? 15 : 0;
      case 'repeater': return props.powered === 'true' && props.facing === oppositeFacing(dirName) ? 15 : 0;
      case 'comparator': return props.facing === oppositeFacing(dirName) ? (this.game.blockEntities.get(x, y, z)?.output ?? 0) : 0;
      case 'jukebox': return props.has_record === 'true' ? 15 : 0;
      case 'sculk_sensor': case 'calibrated_sculk_sensor': return +(props.power ?? 0);
      case 'lightning_rod': return props.powered === 'true' ? 15 : 0;
    }
    if (n.endsWith('_button')) return props.powered === 'true' ? 15 : 0;
    if (n.endsWith('_pressure_plate')) return props.powered === 'true' ? 15 : +(props.power ?? 0);
    return 0;
  }

  /** Strong signal from block at (x,y,z) into the neighbour in direction dir. */
  strongSignal(x: number, y: number, z: number, dir: number, excludeWires = false): number {
    const reg = this.reg, world = this.world;
    const s = world.getBlock(x, y, z);
    if (s === 0) return 0;
    const n = reg.nameOf(s);
    const props = reg.getProps(s);
    const dirName = DIRS[dir];
    switch (n) {
      case 'redstone_wire': return excludeWires ? 0 : this.weakSignal(x, y, z, dir);
      case 'redstone_torch': return dir === 1 && props.lit === 'true' ? 15 : 0;
      case 'redstone_wall_torch': return dir === 1 && props.lit === 'true' ? 15 : 0;
      case 'lever': { const face = props.face, f = props.facing; const attached = face === 'floor' ? 'down' : face === 'ceiling' ? 'up' : oppositeFacing(f); return props.powered === 'true' && dirName === attached ? 15 : 0; }
      case 'repeater': return props.powered === 'true' && props.facing === oppositeFacing(dirName) ? 15 : 0;
      case 'comparator': return props.facing === oppositeFacing(dirName) ? (this.game.blockEntities.get(x, y, z)?.output ?? 0) : 0;
      case 'observer': return props.powered === 'true' && props.facing === oppositeFacing(dirName) ? 15 : 0;
      case 'tripwire_hook': return props.powered === 'true' && props.facing === oppositeFacing(dirName) ? 15 : 0;
      case 'daylight_detector': return 0;
      case 'trapped_chest': return dir === 0 ? this.weakSignal(x, y, z, dir) : 0;
      case 'lectern': return dir === 0 && props.powered === 'true' ? 15 : 0;
      case 'detector_rail': return dir === 0 && props.powered === 'true' ? 15 : 0;
    }
    if (n.endsWith('_button')) { const face = props.face, f = props.facing; const attached = face === 'floor' ? 'down' : face === 'ceiling' ? 'up' : oppositeFacing(f); return props.powered === 'true' && dirName === attached ? 15 : 0; }
    if (n.endsWith('_pressure_plate')) return dir === 0 ? this.weakSignal(x, y, z, dir) : 0;
    return 0;
  }

  /** Strong power a conductor block receives (max direct signal into it). */
  strongPowerInto(x: number, y: number, z: number, excludeWires = false): number {
    let best = 0;
    for (let d = 0; d < 6; d++) {
      const v = DIR_VEC[d];
      best = Math.max(best, this.strongSignal(x + v[0], y + v[1], z + v[2], DIR_OPPOSITE[d], excludeWires));
      if (best >= 15) break;
    }
    return best;
  }

  /** Power level received at position (vanilla getBestNeighborSignal). */
  signalAt(x: number, y: number, z: number, excludeWires = false): number {
    let best = 0;
    const world = this.world;
    for (let d = 0; d < 6; d++) {
      const v = DIR_VEC[d];
      const nx = x + v[0], ny = y + v[1], nz = z + v[2];
      const ns = world.getBlock(nx, ny, nz);
      let sig = this.weakSignal(nx, ny, nz, DIR_OPPOSITE[d], excludeWires);
      if (this.isConductor(ns)) sig = Math.max(sig, this.strongPowerInto(nx, ny, nz, excludeWires));
      if (sig > best) best = sig;
      if (best >= 15) break;
    }
    return best;
  }

  /** Signal received from a specific direction (used by repeaters/comparators/torches). */
  signalFrom(x: number, y: number, z: number, dir: number): number {
    const v = DIR_VEC[dir];
    const nx = x + v[0], ny = y + v[1], nz = z + v[2];
    const ns = this.world.getBlock(nx, ny, nz);
    let sig = this.weakSignal(nx, ny, nz, DIR_OPPOSITE[dir]);
    if (this.isConductor(ns)) sig = Math.max(sig, this.strongPowerInto(nx, ny, nz));
    return sig;
  }

  isPowered(x: number, y: number, z: number): boolean { return this.signalAt(x, y, z) > 0; }

  // ---------- updates ----------
  sourceChanged(x: number, y: number, z: number): void { this.enqueueAround(x, y, z, 2); this.process(); }

  onBlockChanged(x: number, y: number, z: number, _old: number, _new: number): void { this.enqueueAround(x, y, z, 2); this.observe(x, y, z); if (!this.processing) this.process(); }
  onNeighborChanged(x: number, y: number, z: number, _fx: number, _fy: number, _fz: number): void { this.enqueue(x, y, z); if (!this.processing) this.process(); }

  private key(x: number, y: number, z: number): string { return x + ',' + y + ',' + z; }
  private enqueue(x: number, y: number, z: number): void { const k = this.key(x, y, z); if (this.queued.has(k)) return; this.queued.add(k); this.queue.push(x, y, z); }
  private enqueueAround(x: number, y: number, z: number, r: number): void {
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) <= r) this.enqueue(x + dx, y + dy, z + dz);
  }

  /** Observers watching the changed position pulse. */
  private observe(x: number, y: number, z: number): void {
    const reg = this.reg, world = this.world;
    for (let d = 0; d < 6; d++) {
      const v = DIR_VEC[d];
      const s = world.getBlock(x + v[0], y + v[1], z + v[2]);
      if (s !== 0 && reg.nameOf(s) === 'observer' && reg.getProps(s).facing === DIRS[DIR_OPPOSITE[d]] && reg.getProps(s).powered === 'false') world.scheduleTick(x + v[0], y + v[1], z + v[2], 2);
    }
  }

  private process(): void {
    if (this.processing) return;
    this.processing = true;
    let guard = 0;
    while (this.queue.length && guard++ < 20000) {
      const z = this.queue.pop()!, y = this.queue.pop()!, x = this.queue.pop()!;
      this.queued.delete(this.key(x, y, z));
      this.updateAt(x, y, z);
    }
    this.queue.length = 0; this.queued.clear();
    this.processing = false;
  }

  private updateAt(x: number, y: number, z: number): void {
    const reg = this.reg, world = this.world;
    const s = world.getBlockOrUnloaded(x, y, z);
    if (s <= 0) return;
    const n = reg.nameOf(s);
    const props = reg.getProps(s);
    switch (n) {
      case 'redstone_wire': {
        let target = this.signalAt(x, y, z, true);
        // neighbouring wires (same level, one up if not covered, one down if neighbour is not solid)
        const upSolid = this.isConductor(world.getBlock(x, y + 1, z));
        for (const d of HDIRS) {
          const [dx, , dz] = facingOffset(d);
          const side = world.getBlock(x + dx, y, z + dz);
          if (side !== 0 && reg.nameOf(side) === 'redstone_wire') target = Math.max(target, +reg.getProps(side).power - 1);
          if (this.isConductor(side)) { if (!upSolid) { const up = world.getBlock(x + dx, y + 1, z + dz); if (up !== 0 && reg.nameOf(up) === 'redstone_wire') target = Math.max(target, +reg.getProps(up).power - 1); } }
          else { const down = world.getBlock(x + dx, y - 1, z + dz); if (down !== 0 && reg.nameOf(down) === 'redstone_wire') target = Math.max(target, +reg.getProps(down).power - 1); }
        }
        target = Math.max(0, Math.min(15, target));
        if (target !== +props.power) {
          world.setBlock(x, y, z, reg.withProp(s, 'power', String(target)), 0);
          this.enqueueAround(x, y, z, 2);
        }
        return;
      }
      case 'redstone_torch': case 'redstone_wall_torch': {
        const attachedDir = n === 'redstone_torch' ? 0 : DIRS.indexOf(oppositeFacing(props.facing) as any);
        const v = DIR_VEC[attachedDir];
        const ax = x + v[0], ay = y + v[1], az = z + v[2];
        const as = world.getBlock(ax, ay, az);
        // torch turns off when the attached block emits/receives signal (excluding this torch)
        let powered = this.weakSignal(ax, ay, az, DIR_OPPOSITE[attachedDir]) > 0;
        if (this.isConductor(as)) powered = powered || this.strongPowerInto(ax, ay, az) > 0;
        const shouldLit = !powered;
        if (shouldLit !== (props.lit === 'true')) world.scheduleTick(x, y, z, 2);
        return;
      }
      case 'redstone_lamp': { const p = this.isPowered(x, y, z); if (p !== (props.lit === 'true')) { if (p) world.setBlock(x, y, z, reg.withProp(s, 'lit', 'true'), 0); else world.scheduleTick(x, y, z, 4); this.enqueueAround(x, y, z, 1); } return; }
      case 'repeater': {
        const facing = props.facing; const behind = DIRS.indexOf(facing as any);
        const input = this.signalFrom(x, y, z, behind) > 0;
        const left = rotateY(facing), right = rotateYCCW(facing);
        const locked = [left, right].some((d) => { const [dx, , dz] = facingOffset(d); const ss = world.getBlock(x + dx, y, z + dz); if (ss === 0) return false; const nn = reg.nameOf(ss); const pp = reg.getProps(ss); return (nn === 'repeater' || nn === 'comparator') && pp.powered === 'true' && pp.facing === oppositeFacing(d) && (nn === 'repeater' || (this.game.blockEntities.get(x + dx, y, z + dz)?.output ?? 0) > 0); });
        if (locked !== (props.locked === 'true')) world.setBlock(x, y, z, reg.withProp(s, 'locked', String(locked)), 0);
        if (!locked && input !== (props.powered === 'true')) world.scheduleTick(x, y, z, +props.delay * 2, input ? -1 : 0);
        return;
      }
      case 'comparator': { world.scheduleTick(x, y, z, 2); return; }
      case 'piston': case 'sticky_piston': { world.scheduleTick(x, y, z, 1); return; }
      case 'dispenser': case 'dropper': { const p = this.isPowered(x, y, z) || this.isPowered(x, y + 1, z); if (p && props.triggered === 'false') { world.setBlock(x, y, z, reg.withProp(s, 'triggered', 'true'), 0); world.scheduleTick(x, y, z, 4); } else if (!p && props.triggered === 'true') world.setBlock(x, y, z, reg.withProp(s, 'triggered', 'false'), 0); return; }
      case 'note_block': { const p = this.isPowered(x, y, z); if (p !== (props.powered === 'true')) { world.setBlock(x, y, z, reg.withProp(s, 'powered', String(p)), 0); if (p) playNote(this.game, x, y, z, s); } return; }
      case 'tnt': { if (this.isPowered(x, y, z)) this.game.igniteTnt(x, y, z); return; }
      case 'hopper': { const p = this.isPowered(x, y, z); if (p !== (props.enabled === 'false')) world.setBlock(x, y, z, reg.withProp(s, 'enabled', String(!p)), 0); return; }
      case 'bell': { if (this.isPowered(x, y, z) && props.powered === 'false') { world.setBlock(x, y, z, reg.withProp(s, 'powered', 'true'), 0); this.game.sounds.playAt('block.bell.use', x + 0.5, y + 0.5, z + 0.5, 2, 1); this.game.blockEntities.getOrCreate(x, y, z, 'bell', () => ({})).ringTicks = 50; } else if (!this.isPowered(x, y, z) && props.powered === 'true') world.setBlock(x, y, z, reg.withProp(s, 'powered', 'false'), 0); return; }
      case 'powered_rail': case 'activator_rail': { const p = this.isPowered(x, y, z); if (p !== (props.powered === 'true')) world.setBlock(x, y, z, reg.withProp(s, 'powered', String(p)), 0); return; }
      case 'copper_bulb': { const p = this.isPowered(x, y, z); if (p !== (props.powered === 'true')) { let ns = reg.withProp(s, 'powered', String(p)); if (p) ns = reg.withProp(ns, 'lit', String(props.lit !== 'true')); world.setBlock(x, y, z, ns, 0); this.game.sounds.playAt(props.lit === 'true' ? 'block.copper_bulb.turn_off' : 'block.copper_bulb.turn_on', x + 0.5, y + 0.5, z + 0.5, 1, 1); } return; }
      case 'crafter': { const p = this.isPowered(x, y, z); if (p !== (props.triggered === 'true')) { world.setBlock(x, y, z, reg.withProp(s, 'triggered', String(p)), 0); if (p) world.scheduleTick(x, y, z, 4); } return; }
    }
    if (n.endsWith('_copper_bulb')) { const p = this.isPowered(x, y, z); if (p !== (props.powered === 'true')) { let ns = reg.withProp(s, 'powered', String(p)); if (p) ns = reg.withProp(ns, 'lit', String(props.lit !== 'true')); world.setBlock(x, y, z, ns, 0); } return; }
    if (n.endsWith('_door')) {
      const other = props.half === 'lower' ? y + 1 : y - 1;
      const p = this.isPowered(x, y, z) || this.isPowered(x, other, z);
      if (p !== (props.powered === 'true')) {
        const os = world.getBlock(x, other, z);
        let ns = reg.withProp(reg.withProp(s, 'powered', String(p)), 'open', String(p));
        world.setBlock(x, y, z, ns, 0);
        if (os !== 0 && reg.block(os) === reg.block(s)) world.setBlock(x, other, z, reg.withProp(reg.withProp(os, 'powered', String(p)), 'open', String(p)), 0);
        const kind = n.includes('iron') ? 'iron' : n.includes('copper') ? 'copper' : 'wooden';
        this.game.sounds.playAt(`block.${kind}_door.${p ? 'open' : 'close'}`, x + 0.5, y + 0.5, z + 0.5, 1, 1);
      }
      return;
    }
    if (n.endsWith('_trapdoor')) { const p = this.isPowered(x, y, z); if (p !== (props.powered === 'true')) { world.setBlock(x, y, z, reg.withProp(reg.withProp(s, 'powered', String(p)), 'open', String(p)), 0); const kind = n.includes('iron') ? 'iron' : n.includes('copper') ? 'copper' : 'wooden'; this.game.sounds.playAt(`block.${kind}_trapdoor.${p ? 'open' : 'close'}`, x + 0.5, y + 0.5, z + 0.5, 1, 1); } return; }
    if (n.endsWith('_fence_gate')) { const p = this.isPowered(x, y, z); if (p !== (props.powered === 'true')) { world.setBlock(x, y, z, reg.withProp(reg.withProp(s, 'powered', String(p)), 'open', String(p)), 0); this.game.sounds.playAt(p ? 'block.fence_gate.open' : 'block.fence_gate.close', x + 0.5, y + 0.5, z + 0.5, 1, 1); } return; }
  }

  scheduledTick(x: number, y: number, z: number, s: number): void {
    const reg = this.reg, world = this.world;
    const n = reg.nameOf(s);
    const props = reg.getProps(s);
    switch (n) {
      case 'redstone_torch': case 'redstone_wall_torch': {
        const attachedDir = n === 'redstone_torch' ? 0 : DIRS.indexOf(oppositeFacing(props.facing) as any);
        const v = DIR_VEC[attachedDir];
        const ax = x + v[0], ay = y + v[1], az = z + v[2];
        const as = world.getBlock(ax, ay, az);
        let powered = this.weakSignal(ax, ay, az, DIR_OPPOSITE[attachedDir]) > 0;
        if (this.isConductor(as)) powered = powered || this.strongPowerInto(ax, ay, az) > 0;
        const lit = !powered;
        if (lit !== (props.lit === 'true')) { world.setBlock(x, y, z, reg.withProp(s, 'lit', String(lit))); this.enqueueAround(x, y, z, 2); this.process(); }
        return;
      }
      case 'redstone_lamp': { if (!this.isPowered(x, y, z)) world.setBlock(x, y, z, reg.withProp(s, 'lit', 'false'), 0); this.enqueueAround(x, y, z, 1); this.process(); return; }
      case 'repeater': {
        const behind = DIRS.indexOf(props.facing as any);
        const input = this.signalFrom(x, y, z, behind) > 0;
        if (props.locked === 'true') return;
        if (input !== (props.powered === 'true')) { world.setBlock(x, y, z, reg.withProp(s, 'powered', String(input))); if (!input) { /* falling edge */ } this.enqueueAround(x, y, z, 2); this.process(); }
        return;
      }
      case 'comparator': {
        const facing = props.facing; const behind = DIRS.indexOf(facing as any);
        const bv = DIR_VEC[behind];
        let rear = this.signalFrom(x, y, z, behind);
        // container reading
        const cont = this.game.blockEntities.comparatorLevel(x + bv[0], y + bv[1], z + bv[2]);
        if (cont > 0) rear = Math.max(rear, cont);
        const sideVal = (d: string) => { const [dx, , dz] = facingOffset(d); const ss = world.getBlock(x + dx, y, z + dz); if (ss === 0) return 0; const nn = reg.nameOf(ss); if (nn === 'redstone_wire') return +reg.getProps(ss).power; if (nn === 'repeater' || nn === 'comparator' || nn === 'redstone_block' || nn === 'redstone_torch' || nn === 'lever' || nn.endsWith('_button')) return this.weakSignal(x + dx, y, z + dz, DIRS.indexOf(oppositeFacing(d) as any)); return 0; };
        const side = Math.max(sideVal(rotateY(facing)), sideVal(rotateYCCW(facing)));
        const out = props.mode === 'subtract' ? Math.max(0, rear - side) : (side > rear ? 0 : rear);
        const be = this.game.blockEntities.getOrCreate(x, y, z, 'comparator', () => ({}));
        if ((be.output ?? 0) !== out) { be.output = out; world.setBlock(x, y, z, reg.withProp(s, 'powered', String(out > 0)), 0); this.enqueueAround(x, y, z, 2); this.process(); }
        return;
      }
      case 'observer': {
        if (props.powered === 'true') { world.setBlock(x, y, z, reg.withProp(s, 'powered', 'false'), 0); }
        else { world.setBlock(x, y, z, reg.withProp(s, 'powered', 'true'), 0); world.scheduleTick(x, y, z, 2); }
        this.enqueueAround(x, y, z, 2); this.process();
        return;
      }
      case 'dispenser': case 'dropper': this.dispense(x, y, z, s); return;
      case 'piston': case 'sticky_piston': this.updatePiston(x, y, z, s); return;
      case 'crafter': return;
      case 'hopper': return;
    }
  }

  // ---------- pressure plates ----------
  tickPressurePlate(x: number, y: number, z: number, s: number): void {
    const reg = this.reg, world = this.world;
    const n = reg.nameOf(s);
    const props = reg.getProps(s);
    const entities = this.game.entities.filter((e) => !e.removed && e.bb.maxX > x + 0.0625 && e.bb.minX < x + 0.9375 && e.bb.maxZ > z + 0.0625 && e.bb.minZ < z + 0.9375 && e.bb.minY <= y + 0.25 && e.bb.maxY >= y);
    { const p = this.game.player; if (p && !p.removed && !p.isSpectator && p.bb.maxX > x + 0.0625 && p.bb.minX < x + 0.9375 && p.bb.maxZ > z + 0.0625 && p.bb.minZ < z + 0.9375 && p.bb.minY <= y + 0.25 && p.bb.maxY >= y) entities.push(p); }
    let ns = s;
    if (n.startsWith('light_weighted') || n.startsWith('heavy_weighted')) {
      const power = Math.min(15, Math.ceil(entities.length / (n.startsWith('light') ? 1 : 10)));
      ns = reg.withProp(s, 'power', String(power));
    } else {
      const any = n === 'stone_pressure_plate' || n === 'polished_blackstone_pressure_plate' ? entities.some((e) => (e as any).isPlayer || (e as any).isMob) : entities.length > 0;
      ns = reg.withProp(s, 'powered', String(any));
    }
    if (ns !== s) {
      world.setBlock(x, y, z, ns, 0);
      const on = reg.getProps(ns).powered === 'true' || +(reg.getProps(ns).power ?? 0) > 0;
      this.game.sounds.playAt(n.includes('stone') ? (on ? 'block.stone_pressure_plate.click_on' : 'block.stone_pressure_plate.click_off') : (on ? 'block.wooden_pressure_plate.click_on' : 'block.wooden_pressure_plate.click_off'), x + 0.5, y + 0.1, z + 0.5, 0.3, on ? 0.6 : 0.5);
      this.sourceChanged(x, y, z);
    }
    if (entities.length) world.scheduleTick(x, y, z, 20);
  }

  /** Called each tick for entities standing on plates. */
  entityStepped(x: number, y: number, z: number): void {
    const s = this.world.getBlock(x, y, z);
    if (s === 0) return;
    const n = this.reg.nameOf(s);
    if (n.endsWith('_pressure_plate')) { const p = this.reg.getProps(s); if (p.powered === 'false' || p.power === '0') this.tickPressurePlate(x, y, z, s); }
    if (n === 'tripwire') this.updateTripwire(x, y, z);
  }

  updateTripwire(x: number, y: number, z: number): void {
    // find hooks along the string and update their powered state based on entities on any tripwire between them
    const reg = this.reg, world = this.world;
    const s = world.getBlock(x, y, z);
    if (s === 0) return;
    const n = reg.nameOf(s);
    if (n !== 'tripwire' && n !== 'tripwire_hook') return;
    for (const axis of [['west', 'east'], ['north', 'south']]) {
      for (const dir of axis) {
        const [dx, , dz] = facingOffset(dir);
        let cx = x, cz = z, hook: [number, number] | null = null, len = 0;
        while (len < 42) {
          const st = world.getBlock(cx, y, cz); const nn = st ? reg.nameOf(st) : '';
          if (nn === 'tripwire_hook') { hook = [cx, cz]; break; }
          if (nn !== 'tripwire') break;
          cx += dx; cz += dz; len++;
        }
        if (!hook) continue;
        const [ox, , oz] = facingOffset(oppositeFacing(dir));
        let hook2: [number, number] | null = null; let anyEntity = false; let px = x, pz = z; let l2 = 0;
        while (l2 < 42) {
          const st = world.getBlock(px, y, pz); const nn = st ? reg.nameOf(st) : '';
          if (nn === 'tripwire_hook' && (px !== hook[0] || pz !== hook[1])) { hook2 = [px, pz]; break; }
          if (nn !== 'tripwire') break;
          if (this.game.entities.some((e) => !e.removed && e.bb.minX < px + 1 && e.bb.maxX > px && e.bb.minZ < pz + 1 && e.bb.maxZ > pz && e.bb.minY < y + 0.16 && e.bb.maxY > y) || (this.game.player && this.game.player.bb.minX < px + 1 && this.game.player.bb.maxX > px && this.game.player.bb.minZ < pz + 1 && this.game.player.bb.maxZ > pz && this.game.player.bb.minY < y + 0.16 && this.game.player.bb.maxY > y)) anyEntity = true;
          px += ox; pz += oz; l2++;
        }
        for (const h of [hook, hook2]) {
          if (!h) continue;
          const hs = world.getBlock(h[0], y, h[1]);
          const attached = hook2 !== null;
          let ns = reg.withProp(hs, 'attached', String(attached));
          ns = reg.withProp(ns, 'powered', String(attached && anyEntity));
          if (ns !== hs) { world.setBlock(h[0], y, h[1], ns, 0); this.sourceChanged(h[0], y, h[1]); }
        }
        if (anyEntity) world.scheduleTick(x, y, z, 10);
      }
    }
  }

  // ---------- dispensers ----------
  private dispense(x: number, y: number, z: number, s: number): void {
    const reg = this.reg, world = this.world;
    const n = reg.nameOf(s);
    const props = reg.getProps(s);
    const be = this.game.blockEntities.getOrCreate(x, y, z, n, () => ({ items: 9 }));
    const inv = be.inventory;
    const filled: number[] = [];
    for (let i = 0; i < 9; i++) if (inv.get(i)) filled.push(i);
    if (!filled.length) { this.game.sounds.playAt('block.dispenser.fail', x + 0.5, y + 0.5, z + 0.5, 1, 1.2); return; }
    const slot = filled[Math.floor(Math.random() * filled.length)];
    const stack = inv.get(slot)!;
    const f = props.facing;
    const [dx, dy, dz] = facingOffset(f);
    const tx = x + dx, ty = y + dy, tz = z + dz;
    const ox = x + 0.5 + dx * 0.7, oy = y + 0.5 + dy * 0.7 - (dy === 0 ? 0.125 : 0), oz = z + 0.5 + dz * 0.7;
    const spd = 6;
    const vel = (): [number, number, number] => [dx * 1.1 * spd / 20 + (Math.random() - 0.5) * 0.1, dy * 1.1 * spd / 20 + 0.2 * (dy === 0 ? 1 : 0) + (Math.random() - 0.5) * 0.1, dz * 1.1 * spd / 20 + (Math.random() - 0.5) * 0.1];
    let handled = false;
    if (n === 'dispenser') {
      const name = stack.item.name;
      const ts = world.getBlock(tx, ty, tz);
      if (name === 'arrow' || name === 'spectral_arrow' || name === 'tipped_arrow') { const a = new ArrowEntity(null, 2, name === 'spectral_arrow' ? 'spectral' : 'normal'); a.setPos(ox, oy, oz); const v = vel(); a.vx = v[0] * 3; a.vy = v[1] * 3; a.vz = v[2] * 3; a.pickup = true; this.game.addEntity(a); this.game.sounds.playAt('entity.arrow.shoot', x + 0.5, y + 0.5, z + 0.5, 1, 1); stack.count--; handled = true; }
      else if (name === 'snowball' || name === 'egg' || name === 'ender_pearl' || name === 'splash_potion' || name === 'lingering_potion' || name === 'experience_bottle' || name === 'fire_charge') { const p = new ThrownProjectile(name, null, stack.clone()); p.setPos(ox, oy, oz); const v = vel(); p.vx = v[0] * 3; p.vy = v[1] * 3; p.vz = v[2] * 3; this.game.addEntity(p); stack.count--; handled = true; }
      else if (name === 'water_bucket' || name === 'lava_bucket' || name === 'powder_snow_bucket') { if (isReplaceable(reg, ts) && !(ts !== 0 && reg.isFluid(ts))) { world.setBlock(tx, ty, tz, reg.defaultState(name === 'water_bucket' ? 'water' : name === 'lava_bucket' ? 'lava' : 'powder_snow')); inv.set(slot, new ItemStack(this.game.items.get('bucket')!, 1)); handled = true; } }
      else if (name === 'bucket') { if (ts !== 0 && reg.isFluid(ts) && reg.fluidLevel(ts) === 0) { const full = reg.isLava(ts) ? 'lava_bucket' : 'water_bucket'; world.setBlock(tx, ty, tz, 0); stack.count--; const left = inv.add(new ItemStack(this.game.items.get(full)!, 1)); if (left) this.game.dropItem(ox, oy, oz, new ItemStack(this.game.items.get(full)!, 1)); handled = true; } }
      else if (name === 'flint_and_steel') { if (ts === 0) { world.setBlock(tx, ty, tz, this.game.blocks.fireStateFor(tx, ty, tz)); stack.hurt(1); handled = true; } else if (reg.nameOf(ts) === 'tnt') { this.game.igniteTnt(tx, ty, tz); stack.hurt(1); handled = true; } }
      else if (name === 'tnt') { world.setBlock(tx, ty, tz, 0); const t = new PrimedTnt(80); t.setPos(tx + 0.5, ty, tz + 0.5); this.game.addEntity(t); stack.count--; handled = true; }
      else if (name === 'bone_meal') { if (ts !== 0 && this.game.blocks.boneMeal(tx, ty, tz, ts)) { stack.count--; handled = true; this.game.particles.spawnHappyVillager(tx + 0.5, ty + 0.5, tz + 0.5, 10); } }
      else if (name.endsWith('_spawn_egg')) { this.game.spawnMob(name.replace('_spawn_egg', ''), tx + 0.5, ty, tz + 0.5); stack.count--; handled = true; }
      else if (name === 'shears') { /* shear sheep in front */ const sheep = this.game.entities.find((e) => (e as any).type === 'sheep' && !(e as any).sheared && e.bb.intersects({ minX: tx, minY: ty, minZ: tz, maxX: tx + 1, maxY: ty + 1, maxZ: tz + 1 } as any)); if (sheep) { (sheep as any).shear(); stack.hurt(1); handled = true; } }
      else if (name === 'glass_bottle' || name === 'honey_bottle' && false) { /* fill from water */ if (ts !== 0 && reg.isWater(ts)) { stack.count--; inv.add(new ItemStack(this.game.items.get('potion')!, 1, 0, [], null, { potion: 'water' })); handled = true; } }
      else if (name.endsWith('_helmet') || name.endsWith('_chestplate') || name.endsWith('_leggings') || name.endsWith('_boots') || name === 'elytra' || name === 'carved_pumpkin' || name.endsWith('_head') || name.endsWith('_skull')) { const p = this.game.player; if (p && p.bb.intersects({ minX: tx, minY: ty, minZ: tz, maxX: tx + 1, maxY: ty + 1, maxZ: tz + 1 } as any) && p.equipArmor(stack)) { handled = true; } }
      else if (stack.item.blockName && (name.endsWith('shulker_box') || name === 'carved_pumpkin' || name === 'wither_skeleton_skull')) { if (ts === 0) { world.setBlock(tx, ty, tz, reg.defaultState(stack.item.blockName)); stack.count--; handled = true; } }
    }
    if (!handled) {
      // drop the item
      const drop = stack.split(1);
      this.game.dropItem(ox, oy, oz, drop, vel());
      this.game.sounds.playAt('block.dispenser.dispense', x + 0.5, y + 0.5, z + 0.5, 1, 1);
    } else this.game.sounds.playAt('block.dispenser.dispense', x + 0.5, y + 0.5, z + 0.5, 1, 1);
    if (stack.count <= 0) inv.set(slot, null); else inv.onChange?.();
    this.game.particles.spawnSmoke(ox, oy, oz, 3);
  }

  // ---------- pistons ----------
  private updatePiston(x: number, y: number, z: number, s: number): void {
    const reg = this.reg, world = this.world;
    const props = reg.getProps(s);
    const facing = props.facing;
    const [dx, dy, dz] = facingOffset(facing);
    // quasi-connectivity: also powered if the block above is powered
    const powered = this.isPowered(x, y, z) || this.isPowered(x, y + 1, z) && facing !== 'up' || this.isPowered(x, y + 1, z);
    const sticky = reg.nameOf(s) === 'sticky_piston';
    if (powered && props.extended === 'false') {
      // gather blocks to push
      const line: [number, number, number, number][] = [];
      let px = x + dx, py = y + dy, pz = z + dz;
      for (let i = 0; i < 13; i++) {
        const bs = world.getBlock(px, py, pz);
        if (bs === 0 || reg.isAir(bs)) break;
        if (this.isPushDestroyable(bs)) { this.game.breakBlock(px, py, pz, null, true, true); break; }
        if (!this.isPushable(bs, px, py, pz, facing)) return; // blocked
        line.push([px, py, pz, bs]);
        if (line.length > 12) return;
        px += dx; py += dy; pz += dz;
      }
      // move blocks
      for (let i = line.length - 1; i >= 0; i--) {
        const [bx, by, bz, bs] = line[i];
        const be = this.game.blockEntities.take(bx, by, bz);
        world.setBlock(bx + dx, by + dy, bz + dz, bs, SET_UPDATE_NEIGHBORS);
        if (be) this.game.blockEntities.put(bx + dx, by + dy, bz + dz, be);
      }
      const head = reg.stateWith(reg.blockByName('piston_head')!, { facing, type: sticky ? 'sticky' : 'normal', short: 'false' });
      world.setBlock(x + dx, y + dy, z + dz, head, SET_UPDATE_NEIGHBORS);
      world.setBlock(x, y, z, reg.withProp(s, 'extended', 'true'), SET_UPDATE_NEIGHBORS);
      this.game.sounds.playAt('block.piston.extend', x + 0.5, y + 0.5, z + 0.5, 0.5, 0.6 + Math.random() * 0.25);
      // push entities
      for (const e of [...this.game.entities, this.game.player]) { if (!e || e.removed) continue; for (const [bx, by, bz] of line.map((l) => [l[0] + dx, l[1] + dy, l[2] + dz]).concat([[x + dx, y + dy, z + dz]])) { if (e.bb.maxX > bx && e.bb.minX < bx + 1 && e.bb.maxY > by && e.bb.minY < by + 1 && e.bb.maxZ > bz && e.bb.minZ < bz + 1) { e.move(dx * 1.01, dy * 1.01, dz * 1.01); if (dy > 0) e.vy = Math.max(e.vy, 0.3); } } }
    } else if (!powered && props.extended === 'true') {
      const hs = world.getBlock(x + dx, y + dy, z + dz);
      if (hs !== 0 && reg.nameOf(hs) === 'piston_head') world.setBlock(x + dx, y + dy, z + dz, 0, SET_UPDATE_NEIGHBORS);
      world.setBlock(x, y, z, reg.withProp(s, 'extended', 'false'), SET_UPDATE_NEIGHBORS);
      if (sticky) {
        const bx = x + dx * 2, by = y + dy * 2, bz = z + dz * 2;
        const bs = world.getBlock(bx, by, bz);
        if (bs !== 0 && !reg.isAir(bs) && this.isPushable(bs, bx, by, bz, oppositeFacing(facing)) && !this.isPushDestroyable(bs)) {
          const be = this.game.blockEntities.take(bx, by, bz);
          world.setBlock(bx, by, bz, 0, SET_UPDATE_NEIGHBORS);
          world.setBlock(x + dx, y + dy, z + dz, bs, SET_UPDATE_NEIGHBORS);
          if (be) this.game.blockEntities.put(x + dx, y + dy, z + dz, be);
        }
      }
      this.game.sounds.playAt('block.piston.contract', x + 0.5, y + 0.5, z + 0.5, 0.5, 0.6 + Math.random() * 0.15);
    }
  }

  private isPushDestroyable(s: number): boolean {
    const reg = this.reg;
    const b = reg.block(s);
    const n = b.name;
    if (reg.isFluid(s)) return true;
    return b.hardness === 0 && !reg.fullCube[s] || n === 'snow' || n.endsWith('_leaves') && false || b.boundingBox === 'empty' && b.hardness >= 0 && b.hardness <= 0.2;
  }
  private isPushable(s: number, x: number, y: number, z: number, dir: string): boolean {
    const reg = this.reg;
    const b = reg.block(s);
    const n = b.name;
    if (b.hardness < 0) return false; // bedrock, end portal frame …
    if (n === 'obsidian' || n === 'crying_obsidian' || n === 'respawn_anchor' || n === 'reinforced_deepslate' || n === 'enchanting_table' || n === 'ender_chest' || n === 'spawner' || n === 'beacon' || n === 'jukebox' || n === 'lodestone' || n === 'end_rod' && false) return false;
    if (n === 'piston' || n === 'sticky_piston') return reg.getProps(s).extended === 'false';
    if (n === 'piston_head' || n === 'moving_piston') return false;
    if (this.game.blockEntities.get(x, y, z) && !n.endsWith('shulker_box') && n !== 'bell' && n !== 'comparator' && n !== 'campfire' && n !== 'decorated_pot') return false;
    if (n.endsWith('shulker_box')) return false;
    if (y + facingOffset(dir)[1] < -64 || y + facingOffset(dir)[1] >= 320) return false;
    return true;
  }
}
