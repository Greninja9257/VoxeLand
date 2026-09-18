// Block placement rules (vanilla-like): orientation, halves, connections, two-block blocks, support checks.
import type { BlockRegistry, Block } from './registry';
import type { World } from '../world/world';
import { DIR_NAMES } from '../math';

export interface PlaceContext {
  world: World;
  reg: BlockRegistry;
  /** clicked block position and face (0-5) */
  cx: number; cy: number; cz: number; face: number;
  /** hit point inside the clicked block 0..1 */
  hx: number; hy: number; hz: number;
  /** player orientation */
  yaw: number; pitch: number;
  playerX: number; playerY: number; playerZ: number;
  sneaking: boolean;
  /** whether the target position is currently water (for waterlogging) */
  inWater: boolean;
}

export interface Placement { x: number; y: number; z: number; state: number; extra?: { x: number; y: number; z: number; state: number }[]; replace?: boolean }

const OPP = ['up', 'down', 'south', 'north', 'east', 'west'];
export const HFACINGS = ['north', 'south', 'west', 'east'];

export function horizontalFacing(yaw: number): string {
  const a = ((yaw % 360) + 360) % 360;
  if (a >= 45 && a < 135) return 'west';
  if (a >= 135 && a < 225) return 'north';
  if (a >= 225 && a < 315) return 'east';
  return 'south';
}
export function oppositeFacing(f: string): string { return { north: 'south', south: 'north', west: 'east', east: 'west', up: 'down', down: 'up' }[f] ?? f; }
export function facingOffset(f: string): [number, number, number] { return { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] }[f] as [number, number, number] ?? [0, 0, 0]; }
/** nearest looking direction incl. vertical (vanilla getNearestLookingDirection) */
export function lookingDirection(yaw: number, pitch: number): string {
  if (pitch > 45) return 'down';
  if (pitch < -45) return 'up';
  return horizontalFacing(yaw);
}
export function rotateY(f: string): string { return { north: 'east', east: 'south', south: 'west', west: 'north' }[f] ?? f; }
export function rotateYCCW(f: string): string { return { north: 'west', west: 'south', south: 'east', east: 'north' }[f] ?? f; }

export function isReplaceable(reg: BlockRegistry, state: number): boolean {
  if (state === 0 || reg.isAir(state)) return true;
  const n = reg.nameOf(state);
  return n === 'water' || n === 'lava' || n === 'short_grass' || n === 'tall_grass' || n === 'fern' || n === 'large_fern' || n === 'dead_bush' || n === 'seagrass' || n === 'tall_seagrass' || n === 'fire' || n === 'soul_fire' || n === 'vine' || n === 'glow_lichen' || n === 'bubble_column' || n === 'light' || n === 'structure_void' || n === 'hanging_roots' || n === 'warped_roots' || n === 'crimson_roots' || n === 'nether_sprouts' || (n === 'snow' && reg.getProps(state).layers === '1') || n === 'bush' || n === 'firefly_bush' || n === 'leaf_litter' || n === 'wildflowers' || n === 'pink_petals';
}

export function isSolidTop(reg: BlockRegistry, world: World, x: number, y: number, z: number): boolean {
  const s = world.getBlock(x, y, z);
  if (s === 0) return false;
  const boxes = reg.collisionBoxes(s);
  for (const b of boxes) if (b[4] >= 1 && b[0] <= 0.001 && b[3] >= 0.999 && b[2] <= 0.001 && b[5] >= 0.999) return true;
  // stairs/slabs top halves
  const n = reg.nameOf(s);
  if (n.endsWith('_slab') && reg.getProps(s).type !== 'bottom') return true;
  if (n.endsWith('_stairs') && reg.getProps(s).half === 'top') return true;
  return false;
}

export function isSolidFace(reg: BlockRegistry, world: World, x: number, y: number, z: number, dir: number): boolean {
  // whether block at (x,y,z) has a full solid face in direction dir (used for attaching torches, ladders …)
  const s = world.getBlock(x, y, z);
  if (s === 0) return false;
  const b = reg.block(s);
  if (reg.fullCube[s] && b.boundingBox === 'block' && !reg.isFluid(s)) return true;
  const n = b.name;
  if (n.endsWith('_leaves') || n === 'glass' || n.endsWith('_stained_glass') || n === 'ice' || n === 'tinted_glass' || n.endsWith('glass_pane') === false && n.endsWith('_glass')) return reg.fullCube[s] === 1;
  const boxes = reg.collisionBoxes(s);
  // check if boxes cover the full face
  const axis = dir >> 1, pos = dir & 1;
  for (const bx of boxes) {
    const covers = axis === 0 ? (pos ? bx[4] >= 1 : bx[1] <= 0) && bx[0] <= 0 && bx[3] >= 1 && bx[2] <= 0 && bx[5] >= 1
      : axis === 1 ? (pos ? bx[5] >= 1 : bx[2] <= 0) && bx[0] <= 0 && bx[3] >= 1 && bx[1] <= 0 && bx[4] >= 1
        : (pos ? bx[3] >= 1 : bx[0] <= 0) && bx[2] <= 0 && bx[5] >= 1 && bx[1] <= 0 && bx[4] >= 1;
    if (covers) return true;
  }
  return false;
}

function isDirtLike(n: string): boolean {
  return n === 'grass_block' || n === 'dirt' || n === 'coarse_dirt' || n === 'podzol' || n === 'farmland' || n === 'mycelium' || n === 'rooted_dirt' || n === 'moss_block' || n === 'mud' || n === 'muddy_mangrove_roots' || n === 'pale_moss_block';
}
function isSandLike(n: string): boolean { return n === 'sand' || n === 'red_sand' || n === 'suspicious_sand'; }

/** Can this state survive at (x,y,z)? (support rules) */
export function canSurvive(reg: BlockRegistry, world: World, x: number, y: number, z: number, state: number): boolean {
  const b = reg.block(state);
  if (!b) return false;
  const n = b.name;
  const props = reg.getProps(state);
  const below = world.getBlock(x, y - 1, z);
  const belowName = below ? reg.nameOf(below) : 'air';
  if (n.endsWith('_sapling') || n === 'short_grass' || n === 'fern' || n === 'dandelion' || n === 'poppy' || n === 'blue_orchid' || n === 'allium' || n === 'azure_bluet' || n.endsWith('_tulip') || n === 'oxeye_daisy' || n === 'cornflower' || n === 'lily_of_the_valley' || n === 'wither_rose' || n === 'torchflower' || n === 'bush' || n === 'firefly_bush' || n === 'wildflowers' || n === 'pink_petals' || n === 'leaf_litter' || n === 'closed_eyeblossom' || n === 'open_eyeblossom' || n === 'azalea' || n === 'flowering_azalea' || n === 'mangrove_propagule') {
    if (n === 'leaf_litter') return isSolidTop(reg, world, x, y - 1, z);
    if (n === 'wither_rose' && (belowName === 'netherrack' || belowName === 'soul_sand' || belowName === 'soul_soil')) return true;
    return isDirtLike(belowName) || (n === 'mangrove_propagule' && belowName === 'clay');
  }
  if (n === 'tall_grass' || n === 'large_fern' || n === 'sunflower' || n === 'lilac' || n === 'rose_bush' || n === 'peony' || n === 'pitcher_plant') {
    if (props.half === 'upper') { const lower = world.getBlock(x, y - 1, z); return lower !== 0 && reg.block(lower) === b; }
    return isDirtLike(belowName);
  }
  if (n === 'wheat' || n === 'carrots' || n === 'potatoes' || n === 'beetroots' || n === 'melon_stem' || n === 'pumpkin_stem' || n === 'attached_melon_stem' || n === 'attached_pumpkin_stem' || n === 'torchflower_crop' || n === 'pitcher_crop') return belowName === 'farmland';
  if (n === 'sugar_cane') {
    if (belowName === 'sugar_cane') return true;
    if (!(isDirtLike(belowName) || isSandLike(belowName))) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const s = world.getBlock(x + dx, y - 1, z + dz); if (s !== 0 && (reg.hasWater(s) || reg.nameOf(s) === 'frosted_ice')) return true; }
    return false;
  }
  if (n === 'cactus') {
    if (!(belowName === 'cactus' || isSandLike(belowName))) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const s = world.getBlock(x + dx, y, z + dz); if (s !== 0 && reg.fullCube[s] && !reg.isFluid(s)) return false; }
    return true;
  }
  if (n === 'dead_bush') return isSandLike(belowName) || belowName === 'terracotta' || belowName.endsWith('_terracotta') || isDirtLike(belowName);
  if (n === 'brown_mushroom' || n === 'red_mushroom') return isSolidTop(reg, world, x, y - 1, z) || belowName === 'mycelium' || belowName === 'podzol';
  if (n === 'nether_wart') return belowName === 'soul_sand';
  if (n === 'crimson_fungus' || n === 'warped_fungus' || n === 'crimson_roots' || n === 'warped_roots' || n === 'nether_sprouts') return belowName === 'crimson_nylium' || belowName === 'warped_nylium' || belowName === 'soul_soil' || isDirtLike(belowName) || belowName === 'netherrack';
  if (n === 'lily_pad') return below !== 0 && (reg.isWater(below) || belowName === 'ice' || belowName === 'frosted_ice');
  if (n === 'seagrass' || n === 'kelp' || n === 'kelp_plant' || n === 'sea_pickle' || n.endsWith('_coral') || n.endsWith('_coral_fan') || n === 'tall_seagrass') {
    if (n === 'tall_seagrass' && props.half === 'upper') return true;
    if (n === 'kelp' || n === 'kelp_plant') return belowName === 'kelp_plant' || isSolidTop(reg, world, x, y - 1, z);
    return isSolidTop(reg, world, x, y - 1, z) || belowName === 'kelp_plant';
  }
  if (n === 'snow') return below !== 0 && (reg.fullCube[below] === 1 || belowName === 'snow' || belowName.endsWith('_leaves') === false && isSolidTop(reg, world, x, y - 1, z)) && belowName !== 'ice' && belowName !== 'packed_ice' && belowName !== 'barrier';
  if (n === 'torch' || n === 'soul_torch' || n === 'redstone_torch' || n === 'copper_torch') return isSolidTop(reg, world, x, y - 1, z) || (below !== 0 && (belowName.endsWith('_fence') || belowName.endsWith('_wall') || belowName === 'glass' || belowName.endsWith('_stained_glass') || belowName === 'hopper' || belowName.endsWith('_slab') && reg.getProps(below).type !== 'bottom'));
  if (n === 'wall_torch' || n === 'soul_wall_torch' || n === 'redstone_wall_torch' || n === 'copper_wall_torch' || n === 'ladder' || n.endsWith('_wall_sign') || n.endsWith('_wall_banner') || n === 'tripwire_hook' || n.endsWith('_wall_fan') || n.endsWith('_wall_hanging_sign')) {
    const f = props.facing ?? 'north';
    const [dx, , dz] = facingOffset(oppositeFacing(f));
    return isSolidFace(reg, world, x + dx, y, z + dz, DIR_NAMES.indexOf(f as any));
  }
  if (n === 'lever' || n.endsWith('_button')) {
    const face = props.face ?? 'wall', f = props.facing ?? 'north';
    if (face === 'floor') return isSolidTop(reg, world, x, y - 1, z);
    if (face === 'ceiling') return isSolidFace(reg, world, x, y + 1, z, 0);
    const [dx, , dz] = facingOffset(oppositeFacing(f));
    return isSolidFace(reg, world, x + dx, y, z + dz, DIR_NAMES.indexOf(f as any));
  }
  if (n.endsWith('_pressure_plate') || n === 'redstone_wire' || n === 'repeater' || n === 'comparator' || n.endsWith('_carpet') || n === 'moss_carpet' || n === 'pale_moss_carpet' || n === 'rail' || n === 'powered_rail' || n === 'detector_rail' || n === 'activator_rail' || n === 'flower_pot' || n.startsWith('potted_') || n.endsWith('_candle') || n === 'candle' || n === 'turtle_egg' || n === 'sniffer_egg' || n.endsWith('_head') && !n.includes('wall') || n.endsWith('_skull') && !n.includes('wall') || n === 'cake' || n.endsWith('candle_cake') || n === 'sculk_vein' && false || n === 'decorated_pot' || n === 'lightning_rod' && false) {
    return isSolidTop(reg, world, x, y - 1, z) || (n.endsWith('_carpet') && belowName !== 'air');
  }
  if (n.endsWith('_door')) {
    if (props.half === 'upper') { const lower = world.getBlock(x, y - 1, z); return lower !== 0 && reg.block(lower) === b; }
    return isSolidTop(reg, world, x, y - 1, z);
  }
  if (n.endsWith('_bed')) return true;
  if (n === 'vine') {
    for (const d of ['north', 'south', 'west', 'east']) if (props[d] === 'true') { const [dx, , dz] = facingOffset(d); const s = world.getBlock(x + dx, y, z + dz); if (s !== 0 && reg.fullCube[s]) return true; }
    const above = world.getBlock(x, y + 1, z);
    return above !== 0 && (reg.nameOf(above) === 'vine' || reg.fullCube[above] === 1);
  }
  if (n === 'glow_lichen' || n === 'sculk_vein') {
    for (const d of DIR_NAMES) if (props[d] === 'true') { const [dx, dy, dz] = facingOffset(d); const s = world.getBlock(x + dx, y + dy, z + dz); if (s !== 0 && reg.fullCube[s]) return true; }
    return false;
  }
  if (n === 'lantern' || n === 'soul_lantern') return props.hanging === 'true' ? world.getBlock(x, y + 1, z) !== 0 : isSolidTop(reg, world, x, y - 1, z) || belowName.endsWith('_fence') || belowName.endsWith('_wall') || belowName === 'hopper' || belowName === 'iron_bars' || belowName.endsWith('_slab');
  if (n === 'weeping_vines' || n === 'weeping_vines_plant' || n === 'hanging_roots' || n === 'spore_blossom' || n === 'cave_vines' || n === 'cave_vines_plant') { const above = world.getBlock(x, y + 1, z); return above !== 0 && !reg.isAir(above); }
  if (n === 'twisting_vines' || n === 'twisting_vines_plant' || n === 'bamboo' || n === 'bamboo_sapling' || n === 'small_dripleaf' || n === 'big_dripleaf' || n === 'big_dripleaf_stem' || n === 'chorus_flower' || n === 'chorus_plant' || n === 'cocoa' || n === 'sweet_berry_bush' || n === 'scaffolding' || n === 'pointed_dripstone' || n === 'sculk_shrieker' && false) {
    if (n === 'cocoa') { const f = props.facing ?? 'north'; const [dx, , dz] = facingOffset(f); const s = world.getBlock(x + dx, y, z + dz); return s !== 0 && reg.nameOf(s) === 'jungle_log'; }
    if (n === 'chorus_flower' || n === 'chorus_plant') return belowName === 'end_stone' || belowName === 'chorus_plant' || true;
    if (n === 'sweet_berry_bush') return isDirtLike(belowName);
    if (n === 'bamboo' || n === 'bamboo_sapling') return isDirtLike(belowName) || belowName === 'bamboo' || belowName === 'bamboo_sapling' || belowName === 'gravel' || isSandLike(belowName);
    if (n === 'pointed_dripstone') { if (props.vertical_direction === 'up') return isSolidTop(reg, world, x, y - 1, z) || belowName === 'pointed_dripstone'; const above = world.getBlock(x, y + 1, z); return above !== 0 && (reg.fullCube[above] === 1 || reg.nameOf(above) === 'pointed_dripstone'); }
    return below !== 0;
  }
  return true;
}

/** Compute state to place for an item (block name) given the context. Returns null if it can't be placed. */
export function getPlacement(blockName: string, ctx: PlaceContext): Placement | null {
  const { reg, world, face } = ctx;
  const block = reg.blockByName(blockName);
  if (!block) return null;
  const n = block.name;
  // target position: replace clicked block if replaceable, else adjacent
  const clicked = world.getBlock(ctx.cx, ctx.cy, ctx.cz);
  let x = ctx.cx, y = ctx.cy, z = ctx.cz;
  let replace = false;
  const clickedName = clicked ? reg.nameOf(clicked) : 'air';
  const sameBlock = clicked !== 0 && reg.block(clicked) === block;
  // stackable blocks: snow layers, candles, sea pickles, turtle eggs, pink petals, slabs
  if (sameBlock && (n === 'snow' || n.endsWith('candle') || n === 'candle' || n === 'sea_pickle' || n === 'turtle_egg' || n === 'pink_petals' || n === 'wildflowers' || n === 'leaf_litter')) {
    const prop = n === 'snow' ? 'layers' : n === 'sea_pickle' ? 'pickles' : n === 'turtle_egg' ? 'eggs' : n === 'pink_petals' || n === 'wildflowers' ? 'flower_amount' : n === 'leaf_litter' ? 'segment_amount' : 'candles';
    const cur = +(reg.getProps(clicked)[prop] ?? 1);
    const max = n === 'snow' ? 8 : 4;
    if (cur < max) return { x, y, z, state: reg.withProp(clicked, prop, String(cur + 1)), replace: true };
  }
  if (sameBlock && n.endsWith('_slab')) {
    const t = reg.getProps(clicked).type;
    if (t !== 'double') {
      const wantTop = face === 1 || (face >= 2 && ctx.hy > 0.5);
      if ((t === 'bottom' && (face === 1 || (face >= 2 && ctx.hy >= 0.5))) || (t === 'top' && (face === 0 || (face >= 2 && ctx.hy < 0.5)))) return { x, y, z, state: reg.stateWith(block, { type: 'double', waterlogged: 'false' }), replace: true };
      void wantTop;
    }
  }
  if (isReplaceable(reg, clicked) && !(n === 'snow' && clickedName === 'snow')) replace = true;
  else {
    const [dx, dy, dz] = DIR_OFFSETS[face];
    x += dx; y += dy; z += dz;
    const target = world.getBlock(x, y, z);
    if (!isReplaceable(reg, target)) {
      // clicking a slab side to fill its other half handled above; otherwise fail
      return null;
    }
    // slab merge when target has the other half
    if (target !== 0 && reg.block(target) === block && n.endsWith('_slab')) {
      return { x, y, z, state: reg.stateWith(block, { type: 'double', waterlogged: 'false' }), replace: true };
    }
  }
  const targetState = world.getBlock(x, y, z);
  const inWater = targetState !== 0 && reg.isWater(targetState) && reg.fluidLevel(targetState) === 0 || (targetState !== 0 && reg.isWaterlogged(targetState));
  const props: Record<string, string> = {};
  const hf = horizontalFacing(ctx.yaw);
  const hasProp = (p: string) => block.props.some((q) => q.name === p);
  if (hasProp('waterlogged')) props.waterlogged = inWater ? 'true' : 'false';
  // vanilla KelpBlock/SeagrassBlock.getStateForPlacement: only into a water source; the block then *is* that water
  if ((n === 'kelp' || n === 'kelp_plant' || n === 'seagrass' || n === 'tall_seagrass') && !inWater) return null;
  const belowName = (() => { const s = world.getBlock(x, y - 1, z); return s ? reg.nameOf(s) : 'air'; })();

  // ---- orientation rules ----
  if (n.endsWith('_stairs')) {
    props.facing = hf;
    props.half = (face === 0 || (face >= 2 && ctx.hy > 0.5)) ? 'top' : 'bottom';
    props.shape = 'straight';
  } else if (n.endsWith('_slab')) {
    props.type = (face === 0 || (face >= 2 && ctx.hy > 0.5)) ? 'top' : 'bottom';
  } else if (n.endsWith('_trapdoor')) {
    props.facing = face >= 2 ? DIR_NAMES[face] : oppositeFacing(hf);
    props.half = (face === 0 || (face >= 2 && ctx.hy > 0.5)) ? 'top' : 'bottom';
    props.open = 'false';
  } else if (n.endsWith('_door')) {
    if (y + 1 >= 320) return null;
    const above = world.getBlock(x, y + 1, z);
    if (!isReplaceable(reg, above) || !isSolidTop(reg, world, x, y - 1, z)) return null;
    props.facing = hf; props.half = 'lower'; props.open = 'false'; props.powered = 'false';
    // hinge: based on neighbours & hit position
    const left = rotateYCCW(hf), right = rotateY(hf);
    const [lx, , lz] = facingOffset(left), [rx, , rz] = facingOffset(right);
    const leftBlock = world.getBlock(x + lx, y, z + lz), rightBlock = world.getBlock(x + rx, y, z + rz);
    const leftSolid = leftBlock !== 0 && reg.fullCube[leftBlock], rightSolid = rightBlock !== 0 && reg.fullCube[rightBlock];
    const leftDoor = leftBlock !== 0 && reg.block(leftBlock) === block, rightDoor = rightBlock !== 0 && reg.block(rightBlock) === block;
    let hinge = 'left';
    if (leftDoor && !rightDoor) hinge = 'right';
    else if (rightDoor && !leftDoor) hinge = 'left';
    else if (leftSolid !== rightSolid) hinge = leftSolid ? 'left' : 'right';
    else {
      // use hit position along the door's width axis
      const t = hf === 'north' ? ctx.hx : hf === 'south' ? 1 - ctx.hx : hf === 'west' ? 1 - ctx.hz : ctx.hz;
      hinge = t < 0.5 ? 'left' : 'right';
      if (hf === 'west') hinge = ctx.hz > 0.5 ? 'left' : 'right';
    }
    props.hinge = hinge;
    const lower = reg.stateWith(block, props);
    const upper = reg.stateWith(block, { ...props, half: 'upper' });
    return { x, y, z, state: lower, extra: [{ x, y: y + 1, z, state: upper }], replace };
  } else if (n.endsWith('_bed')) {
    const [dx, , dz] = facingOffset(hf);
    const head = world.getBlock(x + dx, y, z + dz);
    if (!isReplaceable(reg, head)) return null;
    props.facing = hf; props.part = 'foot'; props.occupied = 'false';
    return { x, y, z, state: reg.stateWith(block, props), extra: [{ x: x + dx, y, z: z + dz, state: reg.stateWith(block, { ...props, part: 'head' }) }], replace };
  } else if (n === 'sunflower' || n === 'lilac' || n === 'rose_bush' || n === 'peony' || n === 'tall_grass' || n === 'large_fern' || n === 'pitcher_plant' || n === 'small_dripleaf' || n === 'tall_seagrass') {
    const above = world.getBlock(x, y + 1, z);
    if (!isReplaceable(reg, above)) return null;
    props.half = 'lower';
    const lower = reg.stateWith(block, props);
    if (!canSurvive(reg, world, x, y, z, lower)) return null;
    return { x, y, z, state: lower, extra: [{ x, y: y + 1, z, state: reg.stateWith(block, { ...props, half: 'upper' }) }], replace };
  } else if (hasProp('axis')) {
    props.axis = face <= 1 ? 'y' : face <= 3 ? 'z' : 'x';
  } else if (n === 'torch' || n === 'soul_torch' || n === 'redstone_torch' || n === 'copper_torch') {
    // side placement -> wall torch
    if (face >= 2) {
      const wall = reg.blockByName(n.replace('torch', 'wall_torch'));
      if (wall) {
        const st = reg.stateWith(wall, { facing: DIR_NAMES[face] });
        if (canSurvive(reg, world, x, y, z, st)) return { x, y, z, state: st, replace };
      }
    }
    // try floor, else any wall
    const st = block.defaultState;
    if (canSurvive(reg, world, x, y, z, st)) return { x, y, z, state: st, replace };
    const wall = reg.blockByName(n.replace('torch', 'wall_torch'));
    if (wall) for (const f of HFACINGS) { const s = reg.stateWith(wall, { facing: f }); if (canSurvive(reg, world, x, y, z, s)) return { x, y, z, state: s, replace }; }
    return null;
  } else if (n === 'ladder' || n === 'tripwire_hook') {
    if (face < 2) { for (const f of HFACINGS) { const s = reg.stateWith(block, { ...props, facing: f }); if (canSurvive(reg, world, x, y, z, s)) return { x, y, z, state: s, replace }; } return null; }
    props.facing = DIR_NAMES[face];
  } else if (n.endsWith('_sign') && !n.includes('hanging')) {
    // standing vs wall sign
    if (face >= 2) {
      const wall = reg.blockByName(n.replace('_sign', '_wall_sign'));
      if (wall) { const st = reg.stateWith(wall, { facing: DIR_NAMES[face], waterlogged: props.waterlogged ?? 'false' }); if (canSurvive(reg, world, x, y, z, st)) return { x, y, z, state: st, replace }; }
    }
    if (face === 0) return null;
    props.rotation = String(Math.floor((((ctx.yaw + 180) % 360 + 360) % 360) / 22.5 + 0.5) & 15);
  } else if (n.endsWith('_hanging_sign')) {
    if (face === 1) return null;
    if (face === 0) { props.attached = 'false'; props.rotation = String(Math.floor((((ctx.yaw + 180) % 360 + 360) % 360) / 22.5 + 0.5) & 15); }
    else { const wall = reg.blockByName(n.replace('_hanging_sign', '_wall_hanging_sign')); if (wall) return { x, y, z, state: reg.stateWith(wall, { facing: DIR_NAMES[face], waterlogged: props.waterlogged ?? 'false' }), replace }; }
  } else if (n.endsWith('_banner')) {
    if (face >= 2) { const wall = reg.blockByName(n.replace('_banner', '_wall_banner')); if (wall) return { x, y, z, state: reg.stateWith(wall, { facing: DIR_NAMES[face] }), replace }; }
    if (face === 0) return null;
    props.rotation = String(Math.floor((((ctx.yaw + 180) % 360 + 360) % 360) / 22.5 + 0.5) & 15);
  } else if ((n.endsWith('_head') || n.endsWith('_skull')) && !n.includes('wall')) {
    if (face >= 2) { const wall = reg.blockByName(n.replace(/_(head|skull)$/, '_wall_$1')); if (wall) return { x, y, z, state: reg.stateWith(wall, { facing: DIR_NAMES[face] }), replace }; }
    if (face === 0) return null;
    props.rotation = String(Math.floor((((ctx.yaw + 180) % 360 + 360) % 360) / 22.5 + 0.5) & 15);
  } else if (n === 'lever' || n.endsWith('_button')) {
    props.face = face === 1 ? 'floor' : face === 0 ? 'ceiling' : 'wall';
    props.facing = face >= 2 ? DIR_NAMES[face] : hf;
    props.powered = 'false';
  } else if (n === 'lantern' || n === 'soul_lantern') {
    props.hanging = face === 0 ? 'true' : 'false';
  } else if (n === 'hopper') {
    props.facing = face === 1 || face === 0 ? 'down' : OPP[face];
  } else if (n === 'dispenser' || n === 'dropper' || n === 'piston' || n === 'sticky_piston' || n === 'end_rod' && false || n === 'barrel' || n === 'command_block') {
    props.facing = oppositeFacing(lookingDirection(ctx.yaw, ctx.pitch));
    if (n === 'piston' || n === 'sticky_piston') props.extended = 'false';
  } else if (n === 'observer') {
    props.facing = lookingDirection(ctx.yaw, ctx.pitch);
  } else if (n === 'end_rod' || n === 'lightning_rod' || n === 'amethyst_cluster' || n.endsWith('_amethyst_bud') || n === 'chain' || n === 'iron_chain' && false) {
    props.facing = DIR_NAMES[face];
    if (n === 'chain') { props.axis = face <= 1 ? 'y' : face <= 3 ? 'z' : 'x'; delete props.facing; }
  } else if (n === 'anvil' || n === 'chipped_anvil' || n === 'damaged_anvil') {
    props.facing = rotateY(hf);
  } else if (n.endsWith('_fence_gate')) {
    props.facing = hf; props.open = 'false'; props.powered = 'false';
    // in_wall if walls on the sides
    const s1 = world.getBlock(x + (hf === 'north' || hf === 'south' ? 1 : 0), y, z + (hf === 'west' || hf === 'east' ? 1 : 0));
    props.in_wall = s1 !== 0 && reg.nameOf(s1).endsWith('_wall') ? 'true' : 'false';
  } else if (n === 'rail' || n === 'powered_rail' || n === 'detector_rail' || n === 'activator_rail') {
    if (!isSolidTop(reg, world, x, y - 1, z)) return null;
    props.shape = hf === 'north' || hf === 'south' ? 'north_south' : 'east_west';
    // ascend toward neighbouring rails one block up
    const check = (f: string) => { const [dx, , dz] = facingOffset(f); const s = world.getBlock(x + dx, y + 1, z + dz); return s !== 0 && reg.nameOf(s).endsWith('rail'); };
    if (n === 'rail' || true) {
      if (props.shape === 'north_south') { if (check('north')) props.shape = 'ascending_north'; else if (check('south')) props.shape = 'ascending_south'; }
      else { if (check('east')) props.shape = 'ascending_east'; else if (check('west')) props.shape = 'ascending_west'; }
    }
  } else if (n === 'vine') {
    if (face < 2) return null;
    props[OPP[face]] = 'true';
    // adding faces to an existing vine
    if (clicked !== 0 && reg.nameOf(clicked) === 'vine') { const st = reg.withProp(clicked, OPP[face], 'true'); return { x: ctx.cx, y: ctx.cy, z: ctx.cz, state: st, replace: true }; }
  } else if (n === 'glow_lichen' || n === 'sculk_vein' || n === 'resin_clump') {
    props[OPP[face]] = 'true';
    if (clicked !== 0 && reg.block(clicked) === block) { return { x: ctx.cx, y: ctx.cy, z: ctx.cz, state: reg.withProp(clicked, OPP[face], 'true'), replace: true }; }
  } else if (n === 'cocoa') {
    if (face < 2) return null;
    props.facing = OPP[face]; props.age = '0';
    const st = reg.stateWith(block, props);
    if (!canSurvive(reg, world, x, y, z, st)) return null;
    return { x, y, z, state: st, replace };
  } else if (n === 'redstone_wire') {
    // connections computed by neighbours
    props.power = '0';
  } else if (n === 'repeater' || n === 'comparator') {
    props.facing = oppositeFacing(hf);
    if (n === 'repeater') { props.delay = '1'; props.locked = 'false'; props.powered = 'false'; } else { props.mode = 'compare'; props.powered = 'false'; }
  } else if (n === 'campfire' || n === 'soul_campfire') {
    props.facing = hf; props.lit = inWater ? 'false' : 'true'; props.signal_fire = belowName === 'hay_block' ? 'true' : 'false';
  } else if (n === 'bell') {
    props.attachment = face === 1 ? 'floor' : face === 0 ? 'ceiling' : 'single_wall';
    props.facing = face >= 2 ? DIR_NAMES[face] : hf;
  } else if (n === 'grindstone') {
    props.face = face === 1 ? 'floor' : face === 0 ? 'ceiling' : 'wall';
    props.facing = face >= 2 ? DIR_NAMES[face] : hf;
  } else if (n === 'small_amethyst_bud' || n === 'medium_amethyst_bud' || n === 'large_amethyst_bud') {
    props.facing = DIR_NAMES[face];
  } else if (n === 'pointed_dripstone') {
    props.vertical_direction = face === 0 ? 'down' : 'up';
    props.thickness = 'tip';
    if (face >= 2) props.vertical_direction = ctx.hy > 0.5 ? 'down' : 'up';
  } else if (n === 'bamboo') {
    props.age = '0'; props.leaves = 'none'; props.stage = '0';
  } else if (n === 'sweet_berry_bush') props.age = '0';
  else if (n === 'chest' || n === 'trapped_chest' || n.endsWith('copper_chest')) {
    props.facing = oppositeFacing(hf); props.type = 'single';
    // join with an adjacent single chest of the same block & facing to form a double chest
    if (!ctx.sneaking) {
      const left = rotateYCCW(props.facing), right = rotateY(props.facing);
      for (const [side, f] of [['left', right], ['right', left]] as [string, string][]) {
        const [dx, , dz] = facingOffset(f);
        const nb = world.getBlock(x + dx, y, z + dz);
        if (nb !== 0 && reg.block(nb) === block && reg.getProps(nb).type === 'single' && reg.getProps(nb).facing === props.facing) {
          props.type = side;
          const other = side === 'left' ? 'right' : 'left';
          return { x, y, z, state: reg.stateWith(block, props), extra: [{ x: x + dx, y, z: z + dz, state: reg.withProp(nb, 'type', other) }], replace };
        }
      }
    }
  } else if (hasProp('facing') && hasProp('lit') && (n === 'furnace' || n === 'blast_furnace' || n === 'smoker')) {
    props.facing = oppositeFacing(hf); props.lit = 'false';
  } else if (n === 'stonecutter' || n === 'loom' || n === 'lectern' || n === 'carved_pumpkin' || n === 'jack_o_lantern' || n.endsWith('_glazed_terracotta') || n === 'beehive' || n === 'bee_nest' || n === 'chiseled_bookshelf' || n === 'decorated_pot' || n === 'crafter' || n === 'vault' || n === 'trial_spawner' && false || n === 'big_dripleaf' || n === 'small_dripleaf' || n === 'attached_melon_stem' || n === 'ender_chest' || n === 'end_portal_frame' || n === 'fletching_table' && false || n === 'respawn_anchor' && false || n.endsWith('_shelf') || n === 'wall_hanging_sign' && false) {
    props.facing = (n === 'ender_chest' || n === 'end_portal_frame' || n === 'stonecutter' && false) ? oppositeFacing(hf) : n.endsWith('_glazed_terracotta') ? hf : oppositeFacing(hf);
    if (n === 'stonecutter') props.facing = hf;
    if (n === 'lectern') props.facing = oppositeFacing(hf);
  } else if (n.endsWith('shulker_box')) {
    props.facing = DIR_NAMES[face];
  } else if (n === 'iron_bars' || n.endsWith('_glass_pane') || n.endsWith('_fence') && !n.endsWith('_fence_gate') || n.endsWith('_wall')) {
    // connections set by neighbour update
  } else if (n === 'snow') {
    props.layers = '1';
    if (!isSolidTop(reg, world, x, y - 1, z) && belowName !== 'snow') return null;
  } else if (n === 'candle' || n.endsWith('_candle')) { props.candles = '1'; props.lit = 'false'; }
  else if (n === 'sea_pickle') { props.pickles = '1'; if (!inWater) props.waterlogged = 'false'; }
  else if (n === 'turtle_egg') { props.eggs = '1'; }
  else if (n === 'pink_petals' || n === 'wildflowers') { props.flower_amount = '1'; props.facing = hf; }
  else if (n === 'leaf_litter') { props.segment_amount = '1'; props.facing = hf; }
  else if (n === 'tnt') props.unstable = 'false';
  else if (hasProp('facing') && !hasProp('face')) {
    // generic horizontal-facing blocks face the player
    const p = block.props.find((q) => q.name === 'facing')!;
    props.facing = p.values.length === 6 ? oppositeFacing(lookingDirection(ctx.yaw, ctx.pitch)) : oppositeFacing(hf);
  } else if (hasProp('rotation')) props.rotation = String(Math.floor((((ctx.yaw + 180) % 360 + 360) % 360) / 22.5 + 0.5) & 15);

  let state = reg.stateWith(block, props);
  if (!canSurvive(reg, world, x, y, z, state)) return null;
  return { x, y, z, state, replace };
}

const DIR_OFFSETS: [number, number, number][] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

/** Recompute connection properties (fences, walls, panes, bars, redstone, stairs shape, tripwire) for a placed state. */
export function updateConnections(reg: BlockRegistry, world: World, x: number, y: number, z: number, state: number): number {
  const b = reg.block(state);
  if (!b) return state;
  const n = b.name;
  const props = reg.getProps(state);
  const nb = (dx: number, dy: number, dz: number) => world.getBlock(x + dx, y + dy, z + dz);
  if ((n.endsWith('_fence') && !n.endsWith('_fence_gate')) || n === 'iron_bars' || n.endsWith('_glass_pane') || n.endsWith('_wall')) {
    const isWall = n.endsWith('_wall');
    const isFence = n.endsWith('_fence');
    const conn = (s: number, dir: string): boolean => {
      if (s === 0) return false;
      const on = reg.nameOf(s);
      if (isFence) {
        if (on.endsWith('_fence') && !on.endsWith('_fence_gate')) { const nether = on === 'nether_brick_fence'; const meN = n === 'nether_brick_fence'; return nether === meN; }
        if (on.endsWith('_fence_gate')) { const gf = reg.getProps(s).facing; return (dir === 'north' || dir === 'south') ? (gf === 'west' || gf === 'east') : (gf === 'north' || gf === 'south'); }
        return reg.fullCube[s] === 1 && !on.endsWith('_leaves') && on !== 'barrier' && !on.endsWith('shulker_box') && on !== 'melon' && on !== 'pumpkin' && on !== 'carved_pumpkin' && on !== 'jack_o_lantern';
      }
      if (isWall) {
        if (on.endsWith('_wall') || on === 'iron_bars' || on.endsWith('_glass_pane')) return true;
        if (on.endsWith('_fence_gate')) { const gf = reg.getProps(s).facing; return (dir === 'north' || dir === 'south') ? (gf === 'west' || gf === 'east') : (gf === 'north' || gf === 'south'); }
        return reg.fullCube[s] === 1 && !on.endsWith('_leaves') && on !== 'barrier' && !on.endsWith('shulker_box');
      }
      // panes / bars
      if (on === 'iron_bars' || on.endsWith('_glass_pane') || on.endsWith('_wall')) return true;
      return reg.fullCube[s] === 1 && !on.endsWith('_leaves') && on !== 'barrier';
    };
    const p: Record<string, string> = { ...props };
    const N = conn(nb(0, 0, -1), 'north'), S = conn(nb(0, 0, 1), 'south'), W = conn(nb(-1, 0, 0), 'west'), E = conn(nb(1, 0, 0), 'east');
    if (isWall) {
      const above = nb(0, 1, 0);
      const aboveSolid = above !== 0 && (reg.fullCube[above] === 1 || reg.nameOf(above).endsWith('_wall'));
      const tall = (v: boolean, dir: string) => { if (!v) return 'none'; const a = above !== 0 ? reg.nameOf(above) : ''; if (a.endsWith('_wall')) { const ap = reg.getProps(above); return ap[dir] !== 'none' ? 'tall' : 'low'; } return aboveSolid ? 'tall' : 'low'; };
      p.north = tall(N, 'north'); p.south = tall(S, 'south'); p.west = tall(W, 'west'); p.east = tall(E, 'east');
      const straightNS = N && S && !W && !E, straightEW = W && E && !N && !S;
      p.up = (!(straightNS || straightEW) || aboveSolid) ? 'true' : 'false';
    } else { p.north = String(N); p.south = String(S); p.west = String(W); p.east = String(E); }
    return reg.stateWith(b, p);
  }
  if (n.endsWith('_stairs')) {
    return reg.withProp(state, 'shape', stairsShape(reg, world, x, y, z, state));
  }
  if (n === 'redstone_wire') {
    const p: Record<string, string> = { ...props };
    const upSolid = (() => { const a = nb(0, 1, 0); return a !== 0 && reg.fullCube[a] === 1; })();
    for (const [dir, dx, dz] of [['north', 0, -1], ['south', 0, 1], ['west', -1, 0], ['east', 1, 0]] as [string, number, number][]) {
      const s = nb(dx, 0, dz);
      let v = 'none';
      if (s !== 0 && connectsRedstone(reg, s, dir)) v = 'side';
      else {
        const solid = s !== 0 && reg.fullCube[s] === 1;
        if (solid && !upSolid) { const up = nb(dx, 1, dz); if (up !== 0 && reg.nameOf(up) === 'redstone_wire') v = 'up'; }
        else if (!solid) { const down = nb(dx, -1, dz); if (down !== 0 && reg.nameOf(down) === 'redstone_wire') v = 'side'; }
      }
      p[dir] = v;
    }
    // a wire with exactly one connection becomes a straight line
    const dirs = ['north', 'south', 'west', 'east'];
    const cnt = dirs.filter((d) => p[d] !== 'none');
    if (cnt.length === 0) { /* dot */ }
    else if (cnt.length === 1) { const o = oppositeFacing(cnt[0]); if (p[o] === 'none') p[o] = 'side'; }
    return reg.stateWith(b, p);
  }
  if (n.endsWith('_fence_gate')) {
    const f = props.facing;
    const s1 = nb(f === 'north' || f === 'south' ? 1 : 0, 0, f === 'west' || f === 'east' ? 1 : 0), s2 = nb(f === 'north' || f === 'south' ? -1 : 0, 0, f === 'west' || f === 'east' ? -1 : 0);
    const inWall = (s1 !== 0 && reg.nameOf(s1).endsWith('_wall')) || (s2 !== 0 && reg.nameOf(s2).endsWith('_wall'));
    return reg.withProp(state, 'in_wall', String(inWall));
  }
  if (n === 'tripwire') {
    const p: Record<string, string> = { ...props };
    for (const [dir, dx, dz] of [['north', 0, -1], ['south', 0, 1], ['west', -1, 0], ['east', 1, 0]] as [string, number, number][]) {
      const s = nb(dx, 0, dz); const on = s ? reg.nameOf(s) : '';
      p[dir] = String(on === 'tripwire' || (on === 'tripwire_hook' && reg.getProps(s).facing === oppositeFacing(dir)));
    }
    return reg.stateWith(b, p);
  }
  if (n === 'chorus_plant' || n === 'mushroom_stem' || n === 'brown_mushroom_block' || n === 'red_mushroom_block') {
    if (n === 'chorus_plant') {
      const p: Record<string, string> = {};
      for (const d of DIR_NAMES) { const [dx, dy, dz] = facingOffset(d); const s = nb(dx, dy, dz); const on = s ? reg.nameOf(s) : ''; p[d] = String(on === 'chorus_plant' || on === 'chorus_flower' || (d === 'down' && on === 'end_stone')); }
      return reg.stateWith(b, p);
    }
  }
  if (n === 'grass_block' || n === 'podzol' || n === 'mycelium') {
    const above = nb(0, 1, 0);
    const snowy = above !== 0 && (reg.nameOf(above) === 'snow' || reg.nameOf(above) === 'snow_block' || reg.nameOf(above) === 'powder_snow');
    return reg.withProp(state, 'snowy', String(snowy));
  }
  return state;
}

function connectsRedstone(reg: BlockRegistry, s: number, dir: string): boolean {
  const n = reg.nameOf(s);
  if (n === 'redstone_wire' || n === 'redstone_torch' || n === 'redstone_wall_torch' || n === 'redstone_block' || n === 'lever' || n.endsWith('_button') || n.endsWith('_pressure_plate') || n === 'daylight_detector' || n === 'target' || n === 'tripwire_hook' || n === 'detector_rail' || n === 'lectern' || n === 'trapped_chest' || n === 'sculk_sensor' || n === 'calibrated_sculk_sensor' || n === 'lightning_rod' || n === 'jukebox') return true;
  if (n === 'repeater' || n === 'comparator') { const f = reg.getProps(s).facing; return f === dir || f === oppositeFacing(dir); }
  if (n === 'observer') return reg.getProps(s).facing === dir;
  if (n === 'redstone_lamp' || n === 'piston' || n === 'sticky_piston' || n === 'dispenser' || n === 'dropper' || n === 'note_block' || n === 'tnt' || n.endsWith('_door') || n.endsWith('_trapdoor') || n.endsWith('_fence_gate') || n === 'hopper' || n === 'powered_rail' || n === 'activator_rail' || n === 'bell' || n === 'copper_bulb' || n.endsWith('_copper_bulb') || n === 'crafter') return true;
  return false;
}

/** Vanilla stairs shape computation. */
export function stairsShape(reg: BlockRegistry, world: World, x: number, y: number, z: number, state: number): string {
  const props = reg.getProps(state);
  const facing = props.facing, half = props.half;
  const isStairs = (s: number) => s !== 0 && reg.nameOf(s).endsWith('_stairs');
  const get = (f: string) => { const [dx, , dz] = facingOffset(f); return world.getBlock(x + dx, y, z + dz); };
  const front = get(facing);
  if (isStairs(front) && reg.getProps(front).half === half) {
    const ff = reg.getProps(front).facing;
    if (ff !== facing && ff !== oppositeFacing(facing)) {
      const back = get(oppositeFacing(facing));
      const differentOrientation = !(isStairs(back) && reg.getProps(back).half === half && reg.getProps(back).facing === ff);
      if (differentOrientation) return ff === rotateYCCW(facing) ? 'outer_left' : 'outer_right';
    }
  }
  const back = get(oppositeFacing(facing));
  if (isStairs(back) && reg.getProps(back).half === half) {
    const bf = reg.getProps(back).facing;
    if (bf !== facing && bf !== oppositeFacing(facing)) {
      const front2 = get(facing);
      const differentOrientation = !(isStairs(front2) && reg.getProps(front2).half === half && reg.getProps(front2).facing === bf);
      if (differentOrientation) return bf === rotateYCCW(facing) ? 'inner_left' : 'inner_right';
    }
  }
  return 'straight';
}
