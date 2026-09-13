// Block updates: neighbour reactions, scheduled ticks (fluids, buttons, falling blocks, fire …) and random ticks (growth, decay, spread).
import type { Game } from '../game/game';
import type { WorldListener } from '../world/world';
import { SET_UPDATE_NEIGHBORS } from '../world/world';
import { MIN_Y, MAX_Y } from '../world/chunk';
import { canSurvive, updateConnections, facingOffset, isSolidTop, oppositeFacing, isReplaceable } from './placement';
import { FeatureStates, TreeGen, type BlockSink } from '../world/gen/features';
import { ItemStack } from '../items/stack';
import { Random } from '../math';
import { FallingBlockEntity } from '../entity/misc';
import { playNote } from './interaction';

const HDIRS: [string, number, number][] = [['north', 0, -1], ['south', 0, 1], ['west', -1, 0], ['east', 1, 0]];
const ALL_DIRS: [number, number, number][] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

// [ignite odds, burn odds] per block name pattern
function flammability(n: string): [number, number] {
  if (n.endsWith('_planks') || n.endsWith('_slab') && !n.includes('stone') && !n.includes('brick') || n.endsWith('_fence') || n.endsWith('_fence_gate') || n.endsWith('_stairs') && (n.startsWith('oak') || n.startsWith('spruce') || n.startsWith('birch') || n.startsWith('jungle') || n.startsWith('acacia') || n.startsWith('dark_oak') || n.startsWith('mangrove') || n.startsWith('cherry') || n.startsWith('bamboo') || n.startsWith('pale_oak'))) return [5, 20];
  if (n.endsWith('_log') || n.endsWith('_wood') || n.startsWith('stripped_')) return [5, 5];
  if (n.endsWith('_leaves')) return [30, 60];
  if (n.endsWith('_wool') || n.endsWith('_carpet')) return [30, 60];
  if (n === 'bookshelf' || n === 'chiseled_bookshelf') return [30, 20];
  if (n === 'tnt') return [15, 100];
  if (n === 'short_grass' || n === 'tall_grass' || n === 'fern' || n === 'large_fern' || n === 'dead_bush' || n === 'vine' || n === 'sunflower' || n === 'lilac' || n === 'rose_bush' || n === 'peony' || n === 'bush' || n === 'firefly_bush' || n === 'leaf_litter' || n === 'wildflowers') return [60, 100];
  if (n === 'hay_block' || n === 'target' || n === 'dried_kelp_block' || n === 'bamboo' || n === 'scaffolding' || n === 'bee_nest' || n === 'beehive' || n === 'azalea' || n === 'flowering_azalea' || n === 'mangrove_roots' || n === 'sweet_berry_bush' || n === 'lectern' || n === 'composter' || n.endsWith('_bed') && false) return [60, 20];
  if (n === 'coal_block') return [5, 5];
  if (n === 'hanging_roots' || n === 'glow_lichen' || n === 'spore_blossom' || n === 'moss_block' || n === 'moss_carpet' || n === 'big_dripleaf' || n === 'small_dripleaf' || n === 'cave_vines' || n === 'cave_vines_plant' || n === 'pale_moss_block' || n === 'pale_moss_carpet') return [15, 60];
  if (n === 'flower' || n === 'dandelion' || n === 'poppy' || n.endsWith('_tulip') || n === 'allium' || n === 'azure_bluet' || n === 'oxeye_daisy' || n === 'cornflower' || n === 'lily_of_the_valley' || n === 'blue_orchid' || n === 'wither_rose' || n === 'torchflower' || n === 'pitcher_plant') return [60, 100];
  return [0, 0];
}

export class BlockTicker implements WorldListener {
  private st: FeatureStates;
  private trees: TreeGen;
  constructor(private game: Game) {
    this.st = new FeatureStates(game.registry);
    this.trees = new TreeGen(game.registry, this.st);
  }

  private get reg() { return this.game.registry; }
  private get world() { return this.game.world; }

  private worldSink(): BlockSink {
    const w = this.world, reg = this.reg;
    return {
      get: (x, y, z) => w.isLoaded(x, z) ? w.getBlock(x, y, z) : -1,
      set: (x, y, z, s) => { const cur = w.getBlock(x, y, z); if (cur === 0 || reg.isAir(cur) || reg.nameOf(cur).endsWith('_leaves') || reg.nameOf(cur).endsWith('_sapling') || reg.nameOf(cur) === 'short_grass' || reg.nameOf(cur) === 'vine') w.setBlock(x, y, z, s); },
    };
  }

  // ---------- listeners ----------
  onBlockChanged(x: number, y: number, z: number, oldState: number, newState: number): void {
    const reg = this.reg, world = this.world;
    if (newState !== 0) {
      if (reg.isFluid(newState)) world.scheduleTick(x, y, z, reg.isLava(newState) ? this.lavaDelay() : 5);
      const n = reg.nameOf(newState);
      if (n === 'fire' || n === 'soul_fire') world.scheduleTick(x, y, z, 30 + Math.floor(Math.random() * 10));
      if (n.endsWith('_leaves')) world.scheduleTick(x, y, z, 1);
      if (n === 'composter' && reg.getProps(newState).level === '7') world.scheduleTick(x, y, z, 20);
      if (n === 'sponge') this.absorbWater(x, y, z, newState);
    }
    if (oldState !== 0 && reg.nameOf(oldState).endsWith('_leaves') === false && reg.nameOf(oldState).endsWith('_log')) {
      // logs removed -> leaves distances update via neighbour ticks
    }
    // adjacent fluids need to re-flow into the new space
    for (const [dx, dy, dz] of ALL_DIRS) { const s = world.getBlock(x + dx, y + dy, z + dz); if (s !== 0 && (reg.isFluid(s) || reg.isWaterlogged(s))) world.scheduleTick(x + dx, y + dy, z + dz, reg.isLava(s) ? this.lavaDelay() : 5); }
    this.game.redstone.onBlockChanged(x, y, z, oldState, newState);
  }

  onNeighborChanged(x: number, y: number, z: number, fx: number, fy: number, fz: number): void {
    const reg = this.reg, world = this.world;
    const state = world.getBlockOrUnloaded(x, y, z);
    if (state <= 0) return;
    const b = reg.block(state);
    const n = b.name;
    // support check
    if (!canSurvive(reg, world, x, y, z, state)) {
      if (n.endsWith('_door') && reg.getProps(state).half === 'upper') { world.setBlock(x, y, z, 0); return; }
      this.game.breakBlock(x, y, z, null, true, true);
      return;
    }
    // connection updates
    const updated = updateConnections(reg, world, x, y, z, state);
    if (updated !== state) world.setBlock(x, y, z, updated, 0);
    // gravity
    if (this.isGravityBlock(n)) { const below = world.getBlock(x, y - 1, z); if (this.canFallInto(below)) world.scheduleTick(x, y, z, 2); }
    if (reg.isFluid(state) || reg.isWaterlogged(state)) world.scheduleTick(x, y, z, reg.isLava(state) ? this.lavaDelay() : 5);
    if (n.endsWith('_leaves')) world.scheduleTick(x, y, z, 1);
    if (n.endsWith('_door') && reg.getProps(state).half === 'lower') {
      // keep both halves in sync
      const up = world.getBlock(x, y + 1, z);
      if (up === 0 || reg.block(up) !== b) world.setBlock(x, y, z, 0);
    }
    if (n === 'note_block') {
      const below = world.getBlock(x, y - 1, z);
      const inst = noteInstrument(below ? reg.nameOf(below) : 'air');
      if (reg.getProps(state).instrument !== inst) world.setBlock(x, y, z, reg.withProp(state, 'instrument', inst), 0);
    }
    if (n === 'fire' || n === 'soul_fire') { const below = world.getBlock(x, y - 1, z); if (n === 'soul_fire' && !(below && (reg.nameOf(below) === 'soul_sand' || reg.nameOf(below) === 'soul_soil'))) world.setBlock(x, y, z, 0); }
    if (n === 'farmland') { const above = world.getBlock(x, y + 1, z); if (above !== 0 && reg.fullCube[above] && !reg.isFluid(above)) world.setBlock(x, y, z, reg.DIRT); }
    if (n === 'dirt_path') { const above = world.getBlock(x, y + 1, z); if (above !== 0 && reg.fullCube[above]) world.setBlock(x, y, z, reg.DIRT); }
    if (n === 'chorus_flower') { /* survival check above */ }
    if (n.endsWith('_bed')) {
      const props = reg.getProps(state); const [dx, , dz] = facingOffset(props.part === 'foot' ? props.facing : oppositeFacing(props.facing));
      const other = world.getBlock(x + dx, y, z + dz); if (other === 0 || reg.block(other) !== b) world.setBlock(x, y, z, 0, 0);
    }
    if (n === 'tripwire_hook' || n === 'tripwire') this.game.redstone.updateTripwire(x, y, z);
    this.game.redstone.onNeighborChanged(x, y, z, fx, fy, fz);
    if (n === 'water_cauldron' || n === 'cauldron') { /* rain filling handled elsewhere */ }
    if (n === 'bubble_column' || n === 'magma_block' || n === 'soul_sand') { const above = world.getBlock(x, y + 1, z); if (above !== 0 && reg.isWater(above) && reg.fluidLevel(above) === 0 && n !== 'bubble_column') world.setBlock(x, y + 1, z, reg.stateWith(reg.blockByName('bubble_column')!, { drag: String(n === 'magma_block') })); }
  }

  isGravityBlock(n: string): boolean { return n === 'sand' || n === 'red_sand' || n === 'gravel' || n.endsWith('_concrete_powder') || n.endsWith('anvil') || n === 'dragon_egg' || n === 'suspicious_sand' || n === 'suspicious_gravel' || n === 'scaffolding' && false; }
  private canFallInto(s: number): boolean { if (s === 0) return true; const reg = this.reg; if (reg.isAir(s) || reg.isFluid(s)) return true; const n = reg.nameOf(s); return n === 'fire' || n === 'soul_fire' || n === 'snow' && reg.getProps(s).layers === '1' || n === 'short_grass' || n === 'tall_grass' || n === 'fern' || n === 'dead_bush' || n === 'vine' || n === 'seagrass'; }
  private lavaDelay(): number { return this.world.dimension === 'the_nether' ? 10 : 30; }

  // ---------- scheduled ticks ----------
  scheduledTick(x: number, y: number, z: number, expected: number): void {
    const reg = this.reg, world = this.world;
    const state = world.getBlock(x, y, z);
    if (state === 0) return;
    const n = reg.nameOf(state);
    const props = reg.getProps(state);
    if (reg.isFluid(state)) { this.fluidTick(x, y, z, state); return; }
    if (reg.isWaterlogged(state)) { this.spreadFrom(x, y, z, reg.WATER, 8, false); return; }
    if (n.endsWith('_button')) { if (props.powered === 'true') { world.setBlock(x, y, z, reg.withProp(state, 'powered', 'false')); this.game.sounds.playAt(n.includes('stone') || n.includes('polished') || n.includes('blackstone') ? 'block.stone_button.click_off' : 'block.wooden_button.click_off', x + 0.5, y + 0.5, z + 0.5, 0.3, 0.5); this.game.redstone.sourceChanged(x, y, z); } return; }
    if (n.endsWith('_pressure_plate')) { this.game.redstone.tickPressurePlate(x, y, z, state); return; }
    if (this.isGravityBlock(n)) {
      const below = world.getBlock(x, y - 1, z);
      if (this.canFallInto(below) && y > MIN_Y) {
        world.setBlock(x, y, z, 0, 0);
        world.updateNeighbors(x, y, z);
        const e = new FallingBlockEntity(state, this.game.blockEntities.take(x, y, z));
        e.setPos(x + 0.5, y, z + 0.5);
        this.game.addEntity(e);
      }
      return;
    }
    if (n === 'fire' || n === 'soul_fire') { this.fireTick(x, y, z, state); return; }
    if (n.endsWith('_leaves')) { this.updateLeafDistance(x, y, z, state); return; }
    if (n === 'repeater' || n === 'comparator' || n === 'observer' || n === 'redstone_torch' || n === 'redstone_wall_torch' || n === 'dispenser' || n === 'dropper' || n === 'piston' || n === 'sticky_piston' || n === 'crafter' || n === 'hopper') { this.game.redstone.scheduledTick(x, y, z, state); return; }
    if (n === 'composter' && props.level === '7') { world.setBlock(x, y, z, reg.withProp(state, 'level', '8')); this.game.sounds.playAt('block.composter.ready', x + 0.5, y + 0.5, z + 0.5, 1, 1); return; }
    if (n === 'sponge') return;
    if (n === 'frosted_ice') { world.setBlock(x, y, z, reg.WATER); return; }
    if (n === 'bubble_column') { const below = world.getBlock(x, y - 1, z); if (!below || !(reg.nameOf(below) === 'magma_block' || reg.nameOf(below) === 'soul_sand' || reg.nameOf(below) === 'bubble_column')) world.setBlock(x, y, z, reg.WATER); return; }
    void expected;
  }

  private updateLeafDistance(x: number, y: number, z: number, state: number): void {
    const reg = this.reg, world = this.world;
    if (reg.getProps(state).persistent === 'true') return;
    let best = 7;
    for (const [dx, dy, dz] of ALL_DIRS) {
      const s = world.getBlock(x + dx, y + dy, z + dz);
      if (s === 0) continue;
      const nn = reg.nameOf(s);
      if (nn.endsWith('_log') || nn.endsWith('_wood') || nn.startsWith('stripped_') && (nn.endsWith('_log') || nn.endsWith('_wood')) || nn.endsWith('_stem') && !nn.includes('melon') && !nn.includes('pumpkin') || nn.endsWith('_hyphae')) { best = 1; break; }
      if (nn.endsWith('_leaves')) best = Math.min(best, +(reg.getProps(s).distance ?? 7) + 1);
    }
    best = Math.min(7, best);
    if (String(best) !== reg.getProps(state).distance) {
      world.setBlock(x, y, z, reg.withProp(state, 'distance', String(best)), 0);
      for (const [dx, dy, dz] of ALL_DIRS) { const s = world.getBlock(x + dx, y + dy, z + dz); if (s !== 0 && reg.nameOf(s).endsWith('_leaves')) world.scheduleTick(x + dx, y + dy, z + dz, 1); }
    }
  }

  /** BFS through leaves (max 6 steps) for the nearest log; 7 if none. */
  leafDistanceBFS(x: number, y: number, z: number): number {
    const reg = this.reg, world = this.world;
    const isLog = (s: number) => { if (!s) return false; const nn = reg.nameOf(s); return nn.endsWith('_log') || nn.endsWith('_wood') || (nn.startsWith('stripped_') && (nn.endsWith('_log') || nn.endsWith('_wood'))) || (nn.endsWith('_stem') && !nn.includes('melon') && !nn.includes('pumpkin')) || nn.endsWith('_hyphae'); };
    const seen = new Set<number>();
    let frontier: number[][] = [[x, y, z]];
    seen.add(((x & 0xfff) << 20) | ((z & 0xfff) << 8) | (y & 0xff));
    for (let d = 1; d <= 6; d++) {
      const next: number[][] = [];
      for (const [cx, cy, cz] of frontier) for (const [dx, dy, dz] of ALL_DIRS) {
        const nx = cx + dx, ny = cy + dy, nz = cz + dz;
        const k = ((nx & 0xfff) << 20) | ((nz & 0xfff) << 8) | (ny & 0xff);
        if (seen.has(k)) continue; seen.add(k);
        const s = world.getBlock(nx, ny, nz);
        if (!s) continue;
        if (isLog(s)) return d;
        if (reg.nameOf(s).endsWith('_leaves')) next.push([nx, ny, nz]);
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return 7;
  }

  // ---------- fluids ----------
  private fluidAmount(state: number, lava: boolean): number {
    const reg = this.reg;
    if (state === 0) return 0;
    if (lava ? reg.isLava(state) : reg.isWater(state)) { const l = reg.fluidLevel(state); return l === 0 ? 8 : l >= 8 ? 8 : 8 - l; }
    if (!lava && reg.isWaterlogged(state)) return 8;
    return 0;
  }
  private isSource(state: number): boolean { return this.reg.isFluid(state) && this.reg.fluidLevel(state) === 0 || (this.reg.isWaterlogged(state)); }
  private fluidCanReplace(state: number): boolean {
    if (state === 0) return true;
    const reg = this.reg;
    if (reg.isAir(state)) return true;
    if (reg.isFluid(state)) return true;
    const n = reg.nameOf(state);
    return isReplaceable(reg, state) && !reg.isWaterlogged(state) || n === 'seagrass' || n === 'kelp' || n === 'kelp_plant' || n === 'sea_pickle' && false;
  }
  private fluidState(lava: boolean, amount: number, falling: boolean): number {
    const reg = this.reg;
    const b = reg.block(lava ? reg.LAVA : reg.WATER);
    if (falling) return reg.stateWith(b, { level: '8' });
    if (amount >= 8) return reg.stateWith(b, { level: '0' });
    return reg.stateWith(b, { level: String(8 - amount) });
  }

  private fluidTick(x: number, y: number, z: number, state: number): void {
    const reg = this.reg, world = this.world;
    const lava = reg.isLava(state);
    const decay = lava ? (world.dimension === 'the_nether' ? 1 : 2) : 1;
    const level = reg.fluidLevel(state);
    const source = level === 0;
    let amount = this.fluidAmount(state, lava);
    // lava/water contact
    if (this.checkMix(x, y, z, state)) return;
    if (!source) {
      // recompute from neighbours
      const above = world.getBlock(x, y + 1, z);
      let newAmount = 0;
      let falling = false;
      if (this.fluidAmount(above, lava) > 0) { newAmount = 8; falling = true; }
      else {
        let sources = 0;
        for (const [, dx, dz] of HDIRS) {
          const s = world.getBlock(x + dx, y, z + dz);
          const a = this.fluidAmount(s, lava);
          if (a > 0) newAmount = Math.max(newAmount, a - decay);
          if (a === 8 && (reg.fluidLevel(s) === 0 || reg.isWaterlogged(s)) && !(reg.isFluid(s) && reg.fluidLevel(s) >= 8)) sources++;
        }
        // infinite water: two adjacent sources + solid or source below
        if (!lava && sources >= 2) {
          const below = world.getBlock(x, y - 1, z);
          if ((below !== 0 && !this.fluidCanReplace(below)) || this.isSource(below) && reg.isWater(below)) { newAmount = 8; }
        }
      }
      if (newAmount <= 0) { world.setBlock(x, y, z, 0); return; }
      const ns = this.fluidState(lava, newAmount, falling);
      if (ns !== state) { world.setBlock(x, y, z, ns); state = ns; }
      amount = newAmount;
      if (newAmount === 8 && !falling) { /* became source */ }
    }
    this.spreadFrom(x, y, z, state, amount, lava);
  }

  private spreadFrom(x: number, y: number, z: number, state: number, amount: number, lava: boolean): void {
    const reg = this.reg, world = this.world;
    const decay = lava ? (world.dimension === 'the_nether' ? 1 : 2) : 1;
    const delay = lava ? this.lavaDelay() : 5;
    // flow down
    const below = world.getBlock(x, y - 1, z);
    if (y - 1 >= MIN_Y && this.fluidCanReplace(below) && !(reg.isFluid(below) && (reg.isLava(below) === lava) && (reg.fluidLevel(below) === 0 || reg.fluidLevel(below) >= 8))) {
      if (reg.isFluid(below) && reg.isLava(below) !== lava) { this.mixAt(x, y - 1, z, lava, false); return; }
      if (below !== 0 && !reg.isFluid(below) && !reg.isAir(below)) this.game.breakBlock(x, y - 1, z, null, true, true);
      world.setBlock(x, y - 1, z, this.fluidState(lava, 8, true));
      return;
    }
    const canSpreadSideways = below !== 0 && (!this.fluidCanReplace(below) || (reg.isFluid(below) && reg.isLava(below) === lava));
    if (!canSpreadSideways && y - 1 >= MIN_Y) return;
    const next = amount - decay;
    if (next <= 0) return;
    // prefer directions that lead to a drop within 4 blocks
    const dist: number[] = [];
    for (const [, dx, dz] of HDIRS) dist.push(this.slopeDistance(x + dx, y, z + dz, dx, dz, lava, 1));
    const min = Math.min(...dist);
    for (let i = 0; i < 4; i++) {
      if (dist[i] !== min) continue;
      const [, dx, dz] = HDIRS[i];
      const tx = x + dx, tz = z + dz;
      const t = world.getBlock(tx, y, tz);
      if (!this.fluidCanReplace(t)) continue;
      if (reg.isFluid(t)) {
        if (reg.isLava(t) !== lava) { this.mixAt(tx, y, tz, lava, true); continue; }
        if (this.fluidAmount(t, lava) >= next) continue;
      } else if (t !== 0 && !reg.isAir(t)) this.game.breakBlock(tx, y, tz, null, true, true);
      world.setBlock(tx, y, tz, this.fluidState(lava, next, false));
    }
    void delay;
  }

  /** Distance (1..5) to a position where fluid can flow down; 1000 if none within 4. */
  private slopeDistance(x: number, y: number, z: number, fromDx: number, fromDz: number, lava: boolean, depth: number): number {
    const reg = this.reg, world = this.world;
    const t = world.getBlock(x, y, z);
    if (!this.fluidCanReplace(t) || (reg.isFluid(t) && this.isSource(t))) return 1000;
    const below = world.getBlock(x, y - 1, z);
    if (this.fluidCanReplace(below) && !(reg.isFluid(below) && (reg.isLava(below) === lava) && this.isSource(below))) return depth;
    if (depth >= 4) return 1000;
    let best = 1000;
    for (const [, dx, dz] of HDIRS) {
      if (dx === -fromDx && dz === -fromDz) continue;
      best = Math.min(best, this.slopeDistance(x + dx, y, z + dz, dx, dz, lava, depth + 1));
    }
    return best;
  }

  /** Lava/water contact at this position: converts blocks. Returns true if the block changed. */
  private checkMix(x: number, y: number, z: number, state: number): boolean {
    const reg = this.reg, world = this.world;
    const lava = reg.isLava(state);
    if (!lava) return false;
    let touching = false;
    for (const [dx, dy, dz] of ALL_DIRS) { if (dy < 0) continue; const s = world.getBlock(x + dx, y + dy, z + dz); if (s !== 0 && reg.hasWater(s)) { touching = true; break; } }
    if (!touching) return false;
    const src = reg.fluidLevel(state) === 0;
    world.setBlock(x, y, z, reg.defaultState(src ? 'obsidian' : 'cobblestone'));
    this.game.sounds.playAt('block.lava.extinguish', x + 0.5, y + 0.5, z + 0.5, 0.5, 2.6 + Math.random() * 0.8 - 0.4);
    this.game.particles.spawnSmoke(x + 0.5, y + 1.2, z + 0.5, 8);
    return true;
  }
  private mixAt(tx: number, ty: number, tz: number, flowingIsLava: boolean, horizontal: boolean): void {
    const reg = this.reg, world = this.world;
    const t = world.getBlock(tx, ty, tz);
    if (flowingIsLava) {
      // lava flowing into water -> stone (vanilla: lava flowing onto water makes stone)
      world.setBlock(tx, ty, tz, reg.defaultState(reg.fluidLevel(t) === 0 && !horizontal ? 'stone' : 'stone'));
    } else {
      // water flowing into lava: source -> obsidian, flowing -> cobblestone
      world.setBlock(tx, ty, tz, reg.defaultState(reg.fluidLevel(t) === 0 ? 'obsidian' : 'cobblestone'));
    }
    this.game.sounds.playAt('block.lava.extinguish', tx + 0.5, ty + 0.5, tz + 0.5, 0.5, 2.6 + Math.random() * 0.8 - 0.4);
    this.game.particles.spawnSmoke(tx + 0.5, ty + 1.2, tz + 0.5, 8);
  }

  private absorbWater(x: number, y: number, z: number, state: number): void {
    const reg = this.reg, world = this.world;
    const q: [number, number, number, number][] = [[x, y, z, 0]];
    const seen = new Set<string>();
    let absorbed = 0;
    while (q.length && absorbed < 64) {
      const [cx, cy, cz, d] = q.shift()!;
      for (const [dx, dy, dz] of ALL_DIRS) {
        const nx = cx + dx, ny = cy + dy, nz = cz + dz;
        const k = `${nx},${ny},${nz}`;
        if (seen.has(k) || d + 1 > 6) continue;
        seen.add(k);
        const s = world.getBlock(nx, ny, nz);
        if (s === 0) continue;
        if (reg.isWater(s)) { world.setBlock(nx, ny, nz, 0); absorbed++; q.push([nx, ny, nz, d + 1]); }
        else if (reg.isWaterlogged(s)) { world.setBlock(nx, ny, nz, reg.withProp(s, 'waterlogged', 'false')); absorbed++; q.push([nx, ny, nz, d + 1]); }
        else if (reg.nameOf(s) === 'kelp' || reg.nameOf(s) === 'kelp_plant' || reg.nameOf(s) === 'seagrass' || reg.nameOf(s) === 'tall_seagrass') { this.game.breakBlock(nx, ny, nz, null, true, true); absorbed++; q.push([nx, ny, nz, d + 1]); }
      }
    }
    if (absorbed > 0) world.setBlock(x, y, z, reg.defaultState('wet_sponge'));
  }

  // ---------- fire ----------
  private fireTick(x: number, y: number, z: number, state: number): void {
    const reg = this.reg, world = this.world;
    const props = reg.getProps(state);
    const age = +(props.age ?? 0);
    const below = world.getBlock(x, y - 1, z);
    const belowName = below ? reg.nameOf(below) : 'air';
    const infinite = belowName === 'netherrack' || belowName === 'magma_block' || belowName === 'soul_sand' || belowName === 'soul_soil' || (world.dimension === 'the_end' && belowName === 'bedrock');
    if (!infinite && this.game.weather.isRainingAt(world, x, y, z) && Math.random() < 0.3) { world.setBlock(x, y, z, 0); return; }
    const newAge = Math.min(15, age + Math.floor(Math.random() * 3) / 2);
    if (newAge !== age) world.setBlock(x, y, z, reg.withProp(state, 'age', String(Math.floor(newAge))), 0);
    if (!infinite) {
      let flammableNear = false;
      for (const [dx, dy, dz] of ALL_DIRS) { const s = world.getBlock(x + dx, y + dy, z + dz); if (s !== 0 && flammability(reg.nameOf(s))[0] > 0) { flammableNear = true; break; } }
      if (!flammableNear && (age > 3 || !isSolidTop(reg, world, x, y - 1, z))) { if (!isSolidTop(reg, world, x, y - 1, z) || age > 3) { world.setBlock(x, y, z, 0); return; } }
      if (age >= 15 && Math.random() < 0.25 && !flammableNear) { world.setBlock(x, y, z, 0); return; }
    }
    world.scheduleTick(x, y, z, 30 + Math.floor(Math.random() * 10));
    if (this.game.difficulty === 0 && false) return;
    // burn neighbours
    const tryBurn = (bx: number, by: number, bz: number, chance: number) => {
      const s = world.getBlock(bx, by, bz);
      if (s === 0) return;
      const [, burn] = flammability(reg.nameOf(s));
      if (burn > 0 && Math.random() * 300 < burn + chance * 0) {
        if (reg.nameOf(s) === 'tnt') { this.game.igniteTnt(bx, by, bz); return; }
        if (Math.random() < 0.5 + age / 30) world.setBlock(bx, by, bz, this.fireStateFor(bx, by, bz)); else world.setBlock(bx, by, bz, 0);
      }
    };
    tryBurn(x + 1, y, z, 300); tryBurn(x - 1, y, z, 300); tryBurn(x, y - 1, z, 250); tryBurn(x, y + 1, z, 250); tryBurn(x, y, z - 1, 300); tryBurn(x, y, z + 1, 300);
    // spread to nearby air blocks adjacent to flammable material
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 4; dy++) {
      if (dx === 0 && dy === 0 && dz === 0) continue;
      const tx = x + dx, ty = y + dy, tz = z + dz;
      const t = world.getBlock(tx, ty, tz);
      if (t !== 0) continue;
      let odds = 0;
      for (const [ox, oy, oz] of ALL_DIRS) { const s = world.getBlock(tx + ox, ty + oy, tz + oz); if (s !== 0) odds = Math.max(odds, flammability(reg.nameOf(s))[0]); }
      if (odds === 0) continue;
      const range = dy > 1 ? 100 + (dy - 1) * 100 : 100;
      const chance = (odds + 40 + this.game.difficulty * 7) / (age + 30);
      if (Math.random() * range < chance * 0.5 && !this.game.weather.isRainingAt(world, tx, ty, tz)) world.setBlock(tx, ty, tz, this.fireStateFor(tx, ty, tz));
    }
  }

  fireStateFor(x: number, y: number, z: number): number {
    const reg = this.reg, world = this.world;
    const below = world.getBlock(x, y - 1, z);
    const bn = below ? reg.nameOf(below) : '';
    if (bn === 'soul_sand' || bn === 'soul_soil') return reg.defaultState('soul_fire');
    const b = reg.blockByName('fire')!;
    const props: Record<string, string> = { age: '0' };
    const solidBelow = isSolidTop(reg, world, x, y - 1, z);
    for (const [d, dx, dz] of HDIRS) { const s = world.getBlock(x + dx, y, z + dz); props[d] = String(!solidBelow && s !== 0 && flammability(reg.nameOf(s))[0] > 0); }
    const up = world.getBlock(x, y + 1, z); props.up = String(!solidBelow && up !== 0 && flammability(reg.nameOf(up))[0] > 0);
    return reg.stateWith(b, props);
  }

  // ---------- random ticks ----------
  randomTick(x: number, y: number, z: number, state: number): void {
    const reg = this.reg, world = this.world;
    const n = reg.nameOf(state);
    const props = reg.getProps(state);
    const rnd = Math.random;
    const lightAbove = () => world.getLightLevel(x, y + 1, z, this.game.skyDarken());
    switch (n) {
      case 'grass_block': case 'mycelium': case 'podzol': {
        const above = world.getBlock(x, y + 1, z);
        const aboveOpaque = above !== 0 && reg.filterLight[above] >= 15 && !reg.isAir(above);
        if (n === 'podzol') return;
        if (lightAbove() < 4 && aboveOpaque || reg.isWater(above)) { world.setBlock(x, y, z, reg.DIRT); return; }
        if (lightAbove() >= 9) for (let i = 0; i < 4; i++) {
          const tx = x + Math.floor(rnd() * 3) - 1, ty = y + Math.floor(rnd() * 5) - 3, tz = z + Math.floor(rnd() * 3) - 1;
          const t = world.getBlock(tx, ty, tz);
          if (t !== reg.DIRT) continue;
          const ta = world.getBlock(tx, ty + 1, tz);
          if (ta !== 0 && (reg.filterLight[ta] >= 15 || reg.isWater(ta))) continue;
          if (world.getLightLevel(tx, ty + 1, tz, this.game.skyDarken()) >= 4) world.setBlock(tx, ty, tz, reg.defaultState(n));
        }
        return;
      }
      case 'wheat': case 'carrots': case 'potatoes': case 'beetroots': case 'torchflower_crop': case 'pitcher_crop': {
        const max = n === 'beetroots' ? 3 : n === 'torchflower_crop' ? 2 : n === 'pitcher_crop' ? 4 : 7;
        const age = +props.age;
        if (age >= max || lightAbove() < 9) return;
        const chance = this.cropGrowthChance(x, y, z);
        if (rnd() < 1 / (Math.floor(25 / chance) + 1)) world.setBlock(x, y, z, reg.withProp(state, 'age', String(age + 1)));
        return;
      }
      case 'melon_stem': case 'pumpkin_stem': {
        const age = +props.age;
        if (lightAbove() < 9) return;
        const chance = this.cropGrowthChance(x, y, z);
        if (rnd() >= 1 / (Math.floor(25 / chance) + 1)) return;
        if (age < 7) { world.setBlock(x, y, z, reg.withProp(state, 'age', String(age + 1))); return; }
        // grow fruit
        const fruit = n === 'melon_stem' ? 'melon' : 'pumpkin';
        for (const [, dx, dz] of HDIRS) { const t = world.getBlock(x + dx, y, z + dz); const tn = t ? reg.nameOf(t) : ''; if (tn === fruit) return; }
        const [dir, dx, dz] = HDIRS[Math.floor(rnd() * 4)];
        const t = world.getBlock(x + dx, y, z + dz);
        const below = world.getBlock(x + dx, y - 1, z + dz);
        const bn = below ? reg.nameOf(below) : '';
        if ((t === 0 || reg.isAir(t)) && (bn === 'farmland' || bn === 'dirt' || bn === 'grass_block' || bn === 'coarse_dirt')) {
          world.setBlock(x + dx, y, z + dz, reg.defaultState(fruit));
          world.setBlock(x, y, z, reg.stateWith(reg.blockByName('attached_' + n)!, { facing: dir }));
        }
        return;
      }
      case 'attached_melon_stem': case 'attached_pumpkin_stem': {
        const f = props.facing; const [dx, , dz] = facingOffset(f);
        const t = world.getBlock(x + dx, y, z + dz);
        const fruit = n === 'attached_melon_stem' ? 'melon' : 'pumpkin';
        if (!t || reg.nameOf(t) !== fruit) world.setBlock(x, y, z, reg.stateWith(reg.blockByName(n.replace('attached_', ''))!, { age: '7' }));
        return;
      }
      case 'farmland': {
        const moist = +props.moisture;
        const water = this.waterNear(x, y, z, 4, 1);
        const rain = this.game.weather.isRainingAt(world, x, y + 1, z);
        if (!water && !rain) {
          if (moist > 0) world.setBlock(x, y, z, reg.withProp(state, 'moisture', String(moist - 1)));
          else { const above = world.getBlock(x, y + 1, z); const an = above ? reg.nameOf(above) : ''; if (!(an === 'wheat' || an === 'carrots' || an === 'potatoes' || an === 'beetroots' || an.endsWith('_stem') || an === 'torchflower_crop' || an === 'pitcher_crop')) world.setBlock(x, y, z, reg.DIRT); }
        } else if (moist < 7) world.setBlock(x, y, z, reg.withProp(state, 'moisture', '7'));
        return;
      }
      case 'sugar_cane': case 'cactus': case 'kelp': case 'bamboo': case 'chorus_flower': case 'twisting_vines': case 'weeping_vines': case 'cave_vines': {
        if (n === 'sugar_cane' || n === 'cactus') {
          if (world.getBlock(x, y + 1, z) !== 0) return;
          let h = 1; while (world.getBlock(x, y - h, z) !== 0 && reg.nameOf(world.getBlock(x, y - h, z)) === n) h++;
          if (h >= 3) return;
          const age = +props.age;
          if (age >= 15) { world.setBlock(x, y + 1, z, reg.stateWith(reg.block(state), { age: '0' })); world.setBlock(x, y, z, reg.withProp(state, 'age', '0')); }
          else world.setBlock(x, y, z, reg.withProp(state, 'age', String(age + 1)));
          return;
        }
        if (n === 'kelp') { const above = world.getBlock(x, y + 1, z); const age = +props.age; if (age < 25 && above !== 0 && reg.isWater(above) && reg.fluidLevel(above) === 0 && rnd() < 0.14) { world.setBlock(x, y, z, reg.defaultState('kelp_plant')); world.setBlock(x, y + 1, z, reg.withProp(state, 'age', String(age + 1))); } return; }
        if (n === 'bamboo') { if (rnd() < 1 / 3 && world.getBlock(x, y + 1, z) === 0 && lightAbove() >= 9) { let h = 1; while (reg.nameOf(world.getBlock(x, y - h, z) || reg.AIR) === 'bamboo') h++; if (h < 12 + Math.floor(rnd() * 5)) { world.setBlock(x, y + 1, z, reg.stateWith(reg.block(state), { age: h > 4 ? '1' : '0', leaves: 'large', stage: '0' })); world.setBlock(x, y, z, reg.withProp(state, 'leaves', 'small')); const b2 = world.getBlock(x, y - 1, z); if (b2 && reg.nameOf(b2) === 'bamboo') world.setBlock(x, y - 1, z, reg.withProp(b2, 'leaves', 'none')); } } return; }
        if (n === 'chorus_flower') { const age = +props.age; if (age < 5 && world.getBlock(x, y + 1, z) === 0 && rnd() < 0.5) { let h = 1; while (reg.nameOf(world.getBlock(x, y - h, z) || reg.AIR) === 'chorus_plant') h++; if (h < 5) { world.setBlock(x, y + 1, z, state); world.setBlock(x, y, z, reg.stateWith(reg.blockByName('chorus_plant')!, { up: 'true', down: 'true' })); } else world.setBlock(x, y, z, reg.withProp(state, 'age', '5')); } return; }
        if (n === 'twisting_vines') { if (rnd() < 0.1 && world.getBlock(x, y + 1, z) === 0 && +props.age < 25) { world.setBlock(x, y, z, reg.defaultState('twisting_vines_plant')); world.setBlock(x, y + 1, z, reg.withProp(state, 'age', String(+props.age + 1))); } return; }
        if (n === 'weeping_vines') { if (rnd() < 0.1 && world.getBlock(x, y - 1, z) === 0 && +props.age < 25) { world.setBlock(x, y, z, reg.defaultState('weeping_vines_plant')); world.setBlock(x, y - 1, z, reg.withProp(state, 'age', String(+props.age + 1))); } return; }
        if (n === 'cave_vines') { if (rnd() < 0.1 && world.getBlock(x, y - 1, z) === 0 && +props.age < 25) { world.setBlock(x, y, z, reg.stateWith(reg.blockByName('cave_vines_plant')!, { berries: props.berries })); world.setBlock(x, y - 1, z, reg.stateWith(reg.block(state), { age: String(+props.age + 1), berries: String(rnd() < 0.11) })); } return; }
        return;
      }
      case 'sweet_berry_bush': { const age = +props.age; if (age < 3 && lightAbove() >= 9 && rnd() < 0.2) world.setBlock(x, y, z, reg.withProp(state, 'age', String(age + 1))); return; }
      case 'cocoa': { const age = +props.age; if (age < 2 && rnd() < 0.2) world.setBlock(x, y, z, reg.withProp(state, 'age', String(age + 1))); return; }
      case 'nether_wart': { const age = +props.age; if (age < 3 && rnd() < 0.1) world.setBlock(x, y, z, reg.withProp(state, 'age', String(age + 1))); return; }
      case 'vine': { if (rnd() < 0.25) this.spreadVine(x, y, z, state); return; }
      case 'brown_mushroom': case 'red_mushroom': {
        if (rnd() < 0.04) {
          let count = 0;
          for (let dx = -4; dx <= 4; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -4; dz <= 4; dz++) if (world.getBlock(x + dx, y + dy, z + dz) === state) count++;
          if (count < 5) { const tx = x + Math.floor(rnd() * 3) - 1, ty = y + Math.floor(rnd() * 2) - Math.floor(rnd() * 2), tz = z + Math.floor(rnd() * 3) - 1; if (world.getBlock(tx, ty, tz) === 0 && world.getLightLevel(tx, ty, tz, 0) < 13 && canSurvive(reg, world, tx, ty, tz, state)) world.setBlock(tx, ty, tz, state); }
        }
        return;
      }
      case 'ice': case 'snow': case 'frosted_ice': {
        if (world.getLightLevel(x, y, z, this.game.skyDarken()) > 11 && this.game.biomeAt(x, z).temperature > 0.15) {
          if (n === 'snow') { const l = +props.layers; world.setBlock(x, y, z, 0); void l; }
          else { const below = world.getBlock(x, y - 1, z); world.setBlock(x, y, z, world.dimension === 'the_nether' || below === 0 ? 0 : reg.WATER); }
        }
        return;
      }
      case 'fire': case 'soul_fire': return;
      case 'redstone_ore': case 'deepslate_redstone_ore': { if (props.lit === 'true') world.setBlock(x, y, z, reg.withProp(state, 'lit', 'false')); return; }
      case 'budding_amethyst': {
        if (rnd() < 0.2) {
          const [dx, dy, dz] = ALL_DIRS[Math.floor(rnd() * 6)];
          const t = world.getBlock(x + dx, y + dy, z + dz);
          const tn = t ? reg.nameOf(t) : 'air';
          const dir = ['down', 'up', 'north', 'south', 'west', 'east'][ALL_DIRS.findIndex((d) => d[0] === dx && d[1] === dy && d[2] === dz)];
          const next = tn === 'air' || t === 0 ? 'small_amethyst_bud' : tn === 'small_amethyst_bud' ? 'medium_amethyst_bud' : tn === 'medium_amethyst_bud' ? 'large_amethyst_bud' : tn === 'large_amethyst_bud' ? 'amethyst_cluster' : null;
          if (next && (t === 0 || reg.getProps(t).facing === dir)) world.setBlock(x + dx, y + dy, z + dz, reg.stateWith(reg.blockByName(next)!, { facing: dir, waterlogged: t !== 0 && reg.isWaterlogged(t) ? 'true' : 'false' }));
        }
        return;
      }
      case 'turtle_egg': { if (rnd() < 0.05 && this.game.world.dayTime > 12000) { const h = +props.hatch; if (h < 2) world.setBlock(x, y, z, reg.withProp(state, 'hatch', String(h + 1))); else { world.setBlock(x, y, z, 0); for (let i = 0; i < +props.eggs; i++) this.game.spawnMob('turtle', x + 0.5, y, z + 0.5, true); } } return; }
      case 'dead_bush': case 'seagrass': return;
    }
    if (n.endsWith('_sapling') || n === 'mangrove_propagule') {
      if (lightAbove() >= 9 && rnd() < 1 / 7) {
        const stage = +(props.stage ?? 0);
        if (stage === 0 && props.stage !== undefined) world.setBlock(x, y, z, reg.withProp(state, 'stage', '1'), 0);
        else this.growTree(x, y, z, state);
      }
      return;
    }
    if (n.endsWith('_leaves')) {
      if (props.persistent === 'false' && props.distance === '7') {
        // generated leaves start at 7: verify with a real search before decaying
        const d = this.leafDistanceBFS(x, y, z);
        if (d < 7) world.setBlock(x, y, z, reg.withProp(state, 'distance', String(d)), 0);
        else this.game.breakBlock(x, y, z, null, true, true);
      }
      return;
    }
    // copper oxidation
    if (n.includes('copper') && !n.startsWith('waxed_') && !n.startsWith('oxidized_') && !n.includes('_ore') && n !== 'raw_copper_block') {
      if (rnd() < 0.05688889 * 0.3) {
        const next = n.startsWith('weathered_') ? n.replace('weathered_', 'oxidized_') : n.startsWith('exposed_') ? n.replace('exposed_', 'weathered_') : 'exposed_' + n;
        const nb = reg.blockByName(next);
        if (nb) world.setBlock(x, y, z, reg.stateWith(nb, { ...props }));
      }
      return;
    }
    if (n === 'cave_air' || n === 'lava' && world.dimension === 'the_nether') return;
    if (n === 'lava') {
      // lava randomly ignites nearby flammable blocks (fire spread)
      if (rnd() < 0.3 && this.game.difficulty > 0) {
        const tx = x + Math.floor(rnd() * 3) - 1, ty = y + Math.floor(rnd() * 2), tz = z + Math.floor(rnd() * 3) - 1;
        if (world.getBlock(tx, ty, tz) === 0) { let flam = false; for (const [dx, dy, dz] of ALL_DIRS) { const s = world.getBlock(tx + dx, ty + dy, tz + dz); if (s && flammability(reg.nameOf(s))[0] > 0) flam = true; } if (flam) world.setBlock(tx, ty, tz, this.fireStateFor(tx, ty, tz)); }
      }
      return;
    }
    if (n === 'bee_nest' || n === 'beehive' || n === 'moss_block' || n === 'sculk_catalyst' || n.endsWith('_coral') || n.endsWith('_coral_fan') || n.endsWith('_coral_block')) {
      if ((n.endsWith('_coral') || n.endsWith('_coral_fan') || n.endsWith('_coral_block')) && !n.startsWith('dead_')) {
        let water = false;
        for (const [dx, dy, dz] of ALL_DIRS) { const s = world.getBlock(x + dx, y + dy, z + dz); if (s && reg.hasWater(s)) water = true; }
        if (reg.isWaterlogged(state)) water = true;
        if (!water) { const dead = reg.blockByName('dead_' + n); if (dead) world.setBlock(x, y, z, reg.stateWith(dead, { ...props })); }
      }
    }
  }

  private cropGrowthChance(x: number, y: number, z: number): number {
    const reg = this.reg, world = this.world;
    let f = 1;
    const cropState = world.getBlock(x, y, z);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const s = world.getBlock(x + dx, y - 1, z + dz);
      let g = 0;
      if (s !== 0 && reg.nameOf(s) === 'farmland') g = reg.getProps(s).moisture === '7' ? 3 : 1;
      if (dx !== 0 || dz !== 0) g /= 4;
      f += g;
    }
    // same crop diagonally reduces
    const same = (dx: number, dz: number) => { const s = world.getBlock(x + dx, y, z + dz); return s !== 0 && reg.block(s) === reg.block(cropState); };
    const ns = same(0, -1) || same(0, 1), ew = same(-1, 0) || same(1, 0);
    const diag = same(-1, -1) || same(1, -1) || same(-1, 1) || same(1, 1);
    if ((ns && ew) || diag) f /= 2;
    return f;
  }

  private waterNear(x: number, y: number, z: number, r: number, up: number): boolean {
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = 0; dy <= up; dy++) { const s = this.world.getBlock(x + dx, y + dy, z + dz); if (s !== 0 && this.reg.hasWater(s)) return true; }
    return false;
  }

  private spreadVine(x: number, y: number, z: number, state: number): void {
    const reg = this.reg, world = this.world;
    const props = reg.getProps(state);
    const r = Math.floor(Math.random() * 3);
    if (r === 0) { // spread down
      const below = world.getBlock(x, y - 1, z);
      if (below === 0) { const p: Record<string, string> = {}; for (const [d] of HDIRS) if (props[d] === 'true' && Math.random() < 0.5) p[d] = 'true'; if (Object.keys(p).length) world.setBlock(x, y - 1, z, reg.stateWith(reg.block(state), p)); }
    } else if (r === 1) { // spread sideways
      const [d, dx, dz] = HDIRS[Math.floor(Math.random() * 4)];
      if (props[d] === 'true') return;
      const t = world.getBlock(x + dx, y, z + dz);
      if (t !== 0 && reg.fullCube[t]) world.setBlock(x, y, z, reg.withProp(state, d, 'true'));
      else if (t === 0) { const ld = HDIRS.find(([dd]) => props[dd] === 'true'); if (ld) { const [, ldx, ldz] = ld; const s2 = world.getBlock(x + dx + ldx, y, z + dz + ldz); if (s2 !== 0 && reg.fullCube[s2]) world.setBlock(x + dx, y, z + dz, reg.stateWith(reg.block(state), { [ld[0]]: 'true' })); } }
    }
  }

  growTree(x: number, y: number, z: number, state: number): boolean {
    const reg = this.reg, world = this.world;
    const n = reg.nameOf(state);
    const kind = n.replace('_sapling', '').replace('_propagule', '');
    const sink = this.worldSink();
    const rnd = new Random((Math.random() * 1e9) | 0);
    const isSap = (bx: number, bz: number) => { const s = world.getBlock(bx, y, bz); return s === state; };
    world.setBlock(x, y, z, 0, 0);
    let type = kind === 'dark_oak' || kind === 'pale_oak' ? kind : kind === 'jungle' ? 'jungle' : kind === 'spruce' ? (rnd.next() < 0.5 ? 'spruce' : 'pine') : kind === 'oak' ? (rnd.next() < 0.1 ? 'fancy_oak' : 'oak') : kind;
    let ox = x, oz = z;
    // 2x2 mega trees
    if (kind === 'dark_oak' || kind === 'pale_oak' || kind === 'jungle' || kind === 'spruce') {
      for (const [dx, dz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
        if (isSap(x + dx, z + dz) && isSap(x + dx + 1, z + dz) && isSap(x + dx, z + dz + 1) && isSap(x + dx + 1, z + dz + 1) || (dx === 0 && dz === 0 && false)) {
          for (const [ax, az] of [[0, 0], [1, 0], [0, 1], [1, 1]]) world.setBlock(x + dx + ax, y, z + dz + az, 0, 0);
          ox = x + dx; oz = z + dz;
          type = kind === 'jungle' ? 'mega_jungle' : kind === 'spruce' ? 'mega_spruce' : kind;
          const ok = this.trees.place(type, sink, rnd, ox, y, oz);
          if (!ok) { for (const [ax, az] of [[0, 0], [1, 0], [0, 1], [1, 1]]) world.setBlock(x + dx + ax, y, z + dz + az, state, 0); }
          return ok;
        }
      }
      if (kind === 'dark_oak' || kind === 'pale_oak') { world.setBlock(x, y, z, state, 0); return false; }
    }
    const ok = this.trees.place(type, sink, rnd, ox, y, oz);
    if (!ok) world.setBlock(x, y, z, state, 0);
    return ok;
  }

  /** Called when an eye of ender is placed: fills a complete 3x3 frame ring with the end portal. */
  checkEndPortal(x: number, y: number, z: number): void {
    const reg = this.reg, world = this.world;
    const frame = reg.blockByName('end_portal_frame')!;
    const isEye = (bx: number, bz: number) => { const s = world.getBlock(bx, y, bz); return s !== 0 && reg.block(s) === frame && reg.getProps(s).eye === 'true'; };
    for (let ox = -4; ox <= 0; ox++) for (let oz = -4; oz <= 0; oz++) {
      const cx = x + ox, cz = z + oz; // candidate ring top-left corner
      let ok = true;
      for (let i = 1; i <= 3 && ok; i++) { if (!isEye(cx + i, cz) || !isEye(cx + i, cz + 4) || !isEye(cx, cz + i) || !isEye(cx + 4, cz + i)) ok = false; }
      if (!ok) continue;
      const portal = reg.defaultState('end_portal');
      for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) world.setBlock(cx + i, y, cz + j, portal, 0);
      this.game.sounds.playAt('block.end_portal.spawn', x, y, z, 1, 1);
      return;
    }
  }

  /** Bone meal: returns true if something grew. */
  boneMeal(x: number, y: number, z: number, state: number): boolean {
    const reg = this.reg, world = this.world;
    const n = reg.nameOf(state);
    const props = reg.getProps(state);
    if (n.endsWith('_sapling') || n === 'mangrove_propagule') { if (Math.random() < 0.45) { if (props.stage === '0') world.setBlock(x, y, z, reg.withProp(state, 'stage', '1'), 0); else this.growTree(x, y, z, state); } return true; }
    if (n === 'wheat' || n === 'carrots' || n === 'potatoes' || n === 'beetroots' || n === 'melon_stem' || n === 'pumpkin_stem' || n === 'torchflower_crop' || n === 'pitcher_crop') {
      const max = n === 'beetroots' ? 3 : n === 'torchflower_crop' ? 2 : n === 'pitcher_crop' ? 4 : 7; const age = +props.age; if (age >= max) return false;
      world.setBlock(x, y, z, reg.withProp(state, 'age', String(Math.min(max, age + 2 + Math.floor(Math.random() * 4))))); return true;
    }
    if (n === 'grass_block') {
      for (let i = 0; i < 64; i++) {
        const tx = x + Math.floor(Math.random() * 7) - 3, tz = z + Math.floor(Math.random() * 7) - 3, ty = y + Math.floor(Math.random() * 3) - 1;
        if (world.getBlock(tx, ty, tz) !== reg.GRASS_BLOCK || world.getBlock(tx, ty + 1, tz) !== 0) continue;
        const r = Math.random();
        const biome = this.game.biomeAt(tx, tz);
        const flowers = biome.name === 'flower_forest' ? ['dandelion', 'poppy', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley'] : biome.name === 'swamp' ? ['blue_orchid'] : ['dandelion', 'poppy'];
        if (r < 0.1) world.setBlock(tx, ty + 1, tz, reg.defaultState(flowers[Math.floor(Math.random() * flowers.length)]));
        else if (r < 0.2 && world.getBlock(tx, ty + 2, tz) === 0) { world.setBlock(tx, ty + 1, tz, reg.stateWith(reg.blockByName('tall_grass')!, { half: 'lower' })); world.setBlock(tx, ty + 2, tz, reg.stateWith(reg.blockByName('tall_grass')!, { half: 'upper' })); }
        else world.setBlock(tx, ty + 1, tz, reg.defaultState('short_grass'));
      }
      return true;
    }
    if (n === 'short_grass' || n === 'fern') { if (world.getBlock(x, y + 1, z) === 0) { const tall = reg.blockByName(n === 'fern' ? 'large_fern' : 'tall_grass')!; world.setBlock(x, y, z, reg.stateWith(tall, { half: 'lower' })); world.setBlock(x, y + 1, z, reg.stateWith(tall, { half: 'upper' })); return true; } return false; }
    if (n === 'sweet_berry_bush' && +props.age < 3) { world.setBlock(x, y, z, reg.withProp(state, 'age', String(+props.age + 1))); return true; }
    if (n === 'cocoa' && +props.age < 2) { world.setBlock(x, y, z, reg.withProp(state, 'age', String(+props.age + 1))); return true; }
    if (n === 'brown_mushroom' || n === 'red_mushroom') { if (Math.random() < 0.4) { world.setBlock(x, y, z, 0, 0); const ok = this.trees.hugeMushroom(this.worldSink(), new Random((Math.random() * 1e9) | 0), x, y, z, n === 'red_mushroom' ? 'red' : 'brown'); if (!ok) world.setBlock(x, y, z, state, 0); } return true; }
    if (n === 'sunflower' || n === 'lilac' || n === 'rose_bush' || n === 'peony') { this.game.dropItem(x + 0.5, y + 0.5, z + 0.5, new ItemStack(this.game.items.get(n)!, 1)); return true; }
    if (n === 'bamboo' || n === 'bamboo_sapling') { for (let i = 0; i < 1 + Math.floor(Math.random() * 2); i++) { let top = y; while (reg.nameOf(world.getBlock(x, top + 1, z) || reg.AIR) === 'bamboo') top++; if (world.getBlock(x, top + 1, z) === 0 && top - y < 15) world.setBlock(x, top + 1, z, reg.stateWith(reg.blockByName('bamboo')!, { age: '1', leaves: 'large', stage: '0' })); } if (n === 'bamboo_sapling') world.setBlock(x, y, z, reg.stateWith(reg.blockByName('bamboo')!, { age: '0', leaves: 'small', stage: '0' })); return true; }
    if (n === 'kelp' || n === 'seagrass' || n === 'sea_pickle' || n === 'cave_vines' || n === 'weeping_vines' || n === 'twisting_vines' || n === 'moss_block' || n === 'crimson_nylium' || n === 'warped_nylium' || n === 'azalea' || n === 'flowering_azalea' || n === 'pink_petals' || n === 'wildflowers' || n === 'mangrove_propagule' || n === 'glow_lichen' || n === 'big_dripleaf' || n === 'small_dripleaf' || n === 'rooted_dirt' || n === 'netherrack' && false || n === 'nether_wart' && false) {
      if (n === 'pink_petals' || n === 'wildflowers') { const a = +props.flower_amount; if (a < 4) world.setBlock(x, y, z, reg.withProp(state, 'flower_amount', String(a + 1))); else this.game.dropItem(x + 0.5, y + 0.5, z + 0.5, new ItemStack(this.game.items.get(n)!, 1)); return true; }
      if (n === 'azalea' || n === 'flowering_azalea') { if (Math.random() < 0.45) { world.setBlock(x, y, z, 0, 0); const ok = this.trees.oak(this.worldSink(), new Random((Math.random() * 1e9) | 0), x, y, z, 'oak'); if (ok) { for (let dy = 3; dy < 8; dy++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) { const s = world.getBlock(x + dx, y + dy, z + dz); if (s && reg.nameOf(s) === 'oak_leaves') world.setBlock(x + dx, y + dy, z + dz, reg.stateWith(reg.blockByName(Math.random() < 0.3 ? 'flowering_azalea_leaves' : 'azalea_leaves')!, {}), 0); } } else world.setBlock(x, y, z, state, 0); } return true; }
      if (n === 'moss_block') { for (let i = 0; i < 20; i++) { const tx = x + Math.floor(Math.random() * 7) - 3, tz = z + Math.floor(Math.random() * 7) - 3; const ty = y + (world.getBlock(tx, y + 1, tz) === 0 ? 0 : 1); if (world.getBlock(tx, ty + 1, tz) === 0 && (world.getBlock(tx, ty, tz) === reg.STONE || world.getBlock(tx, ty, tz) === reg.DIRT || reg.nameOf(world.getBlock(tx, ty, tz) || reg.AIR) === 'moss_block')) { world.setBlock(tx, ty, tz, state); const r = Math.random(); if (r < 0.3) world.setBlock(tx, ty + 1, tz, reg.defaultState('moss_carpet')); else if (r < 0.5) world.setBlock(tx, ty + 1, tz, reg.defaultState('short_grass')); else if (r < 0.6) world.setBlock(tx, ty + 1, tz, reg.defaultState('azalea')); } } return true; }
      if (n === 'crimson_nylium' || n === 'warped_nylium') { const kind = n === 'crimson_nylium' ? 'crimson' : 'warped'; for (let i = 0; i < 10; i++) { const tx = x + Math.floor(Math.random() * 5) - 2, tz = z + Math.floor(Math.random() * 5) - 2; if (world.getBlock(tx, y, tz) === state && world.getBlock(tx, y + 1, tz) === 0) world.setBlock(tx, y + 1, tz, reg.defaultState(Math.random() < 0.7 ? kind + '_roots' : Math.random() < 0.5 ? kind + '_fungus' : 'nether_sprouts')); } return true; }
      if (n === 'kelp') { const age = +props.age; if (age < 25) { let top = y; while (reg.nameOf(world.getBlock(x, top, z) || reg.AIR) === 'kelp_plant' || top === y) { if (top !== y) break; top++; } const above = world.getBlock(x, y + 1, z); if (above !== 0 && reg.isWater(above)) { world.setBlock(x, y, z, reg.defaultState('kelp_plant')); world.setBlock(x, y + 1, z, reg.withProp(state, 'age', String(age + 1))); } } return true; }
      if (n === 'glow_lichen') { for (const [dx, dy, dz] of ALL_DIRS) { const t = world.getBlock(x + dx, y + dy, z + dz); if (t === 0) { for (const d of ['down', 'up', 'north', 'south', 'west', 'east']) { const [ox, oy, oz] = facingOffset(d); const s = world.getBlock(x + dx + ox, y + dy + oy, z + dz + oz); if (s !== 0 && reg.fullCube[s] && Math.random() < 0.3) { world.setBlock(x + dx, y + dy, z + dz, reg.stateWith(reg.block(state), { [d]: 'true' })); return true; } } } } return false; }
      if (n === 'rooted_dirt') { const below = world.getBlock(x, y - 1, z); if (below === 0) { world.setBlock(x, y - 1, z, reg.defaultState('hanging_roots')); return true; } return false; }
      if (n === 'cave_vines') { world.setBlock(x, y, z, reg.withProp(state, 'berries', 'true')); return true; }
      if (n === 'weeping_vines' || n === 'twisting_vines') { for (let i = 0; i < 2; i++) this.randomTick(x, y, z, world.getBlock(x, y, z)); return true; }
      if (n === 'sea_pickle') { for (let i = 0; i < 10; i++) { const tx = x + Math.floor(Math.random() * 5) - 2, tz = z + Math.floor(Math.random() * 5) - 2; const b = world.getBlock(tx, y - 1, tz); if (b && reg.nameOf(b).endsWith('_coral_block') && world.getBlock(tx, y, tz) !== 0 && reg.isWater(world.getBlock(tx, y, tz))) world.setBlock(tx, y, tz, reg.stateWith(reg.block(state), { pickles: String(1 + Math.floor(Math.random() * 4)), waterlogged: 'true' })); } return true; }
      return false;
    }
    return false;
  }
}

export function noteInstrument(below: string): string {
  if (below.endsWith('_planks') || below.endsWith('_log') || below.endsWith('_wood') || below === 'note_block' || below === 'bookshelf' || below === 'chest' || below === 'crafting_table' || below.endsWith('_fence') || below === 'jukebox' || below.endsWith('_slab') && !below.includes('stone') || below.startsWith('stripped_') || below === 'bamboo_block' || below.endsWith('_stem') || below.endsWith('_hyphae')) return 'bass';
  if (below === 'sand' || below === 'red_sand' || below === 'gravel' || below.endsWith('_concrete_powder') || below === 'suspicious_sand' || below === 'suspicious_gravel') return 'snare';
  if (below === 'glass' || below.endsWith('_stained_glass') || below === 'glass_pane' || below.endsWith('_glass_pane') || below === 'sea_lantern' || below === 'beacon' || below === 'tinted_glass') return 'hat';
  if (below === 'stone' || below === 'cobblestone' || below === 'netherrack' || below === 'obsidian' || below === 'sandstone' || below.endsWith('_ore') || below === 'bricks' || below.endsWith('_bricks') || below.endsWith('_stone') || below === 'deepslate' || below.endsWith('deepslate') || below === 'blackstone' || below.endsWith('blackstone') || below.endsWith('_concrete') || below === 'bedrock' || below.endsWith('_terracotta') || below === 'terracotta' || below === 'quartz_block' || below === 'prismarine' || below === 'purpur_block' || below === 'end_stone' || below === 'coal_block' || below === 'magma_block' || below === 'basalt' || below === 'calcite' || below === 'tuff' || below === 'dripstone_block' || below === 'stone_bricks' || below === 'granite' || below === 'diorite' || below === 'andesite' || below === 'mud_bricks' || below === 'packed_mud') return 'basedrum';
  if (below === 'gold_block') return 'bell';
  if (below === 'clay' || below === 'honeycomb_block' || below.endsWith('_froglight') || below === 'infested_stone') return 'flute';
  if (below === 'packed_ice') return 'chime';
  if (below.endsWith('_wool')) return 'guitar';
  if (below === 'bone_block') return 'xylophone';
  if (below === 'iron_block') return 'iron_xylophone';
  if (below === 'soul_sand') return 'cow_bell';
  if (below === 'pumpkin' || below === 'carved_pumpkin') return 'didgeridoo';
  if (below === 'emerald_block') return 'bit';
  if (below === 'hay_block') return 'banjo';
  if (below === 'glowstone') return 'pling';
  return 'harp';
}

export { playNote, SET_UPDATE_NEIGHBORS, MAX_Y };
