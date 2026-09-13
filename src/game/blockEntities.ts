// Runtime block entities (containers, furnaces, hoppers, campfires, brewing stands, spawners, jukeboxes …).
import type { Game } from './game';
import { Inventory, ItemStack } from '../items/stack';
import type { Chunk } from '../world/chunk';
import { facingOffset, oppositeFacing } from '../blocks/placement';
import { ItemEntity } from '../entity/entity';
import { MOB_DEFS, Mob } from '../entity/mobs';

export interface BlockEntity {
  type: string; x: number; y: number; z: number;
  inventory: Inventory;
  [k: string]: any;
}

export class BlockEntityManager {
  private map = new Map<string, BlockEntity>();
  constructor(private game: Game) {}

  private key(x: number, y: number, z: number): string { return `${x},${y},${z}`; }
  get(x: number, y: number, z: number): BlockEntity | undefined { return this.map.get(this.key(x, y, z)); }
  all(): IterableIterator<BlockEntity> { return this.map.values(); }

  getOrCreate(x: number, y: number, z: number, type: string, init: () => { items?: number; [k: string]: any }): BlockEntity {
    let be = this.map.get(this.key(x, y, z));
    if (be) return be;
    const i = init();
    be = { type, x, y, z, inventory: new Inventory(i.items ?? 0), ...i };
    delete (be as any).items;
    this.map.set(this.key(x, y, z), be);
    const c = this.game.world.chunkAt(x, z); if (c) c.modified = true;
    return be;
  }
  put(x: number, y: number, z: number, data: any): void {
    if (!data) return;
    const be = this.deserializeOne({ ...data, x, y, z });
    this.map.set(this.key(x, y, z), be);
  }
  /** Remove and return serialized data. */
  take(x: number, y: number, z: number): any {
    const be = this.map.get(this.key(x, y, z));
    if (!be) return null;
    this.map.delete(this.key(x, y, z));
    return this.serializeOne(be);
  }
  remove(x: number, y: number, z: number): BlockEntity | undefined { const k = this.key(x, y, z); const be = this.map.get(k); this.map.delete(k); return be; }

  /** Drop container contents (on block break). */
  dropContents(x: number, y: number, z: number): void {
    const be = this.remove(x, y, z);
    if (!be) return;
    if (be.type === 'shulker_box') return;
    for (const s of be.inventory.slots) if (s) this.game.dropItem(x + 0.5, y + 0.5, z + 0.5, s, [(Math.random() - 0.5) * 0.2, 0.2, (Math.random() - 0.5) * 0.2]);
    if (be.record) { const s = ItemStack.deserialize(be.record, this.game.items); if (s) this.game.dropItem(x + 0.5, y + 1, z + 0.5, s); this.game.sounds.stopRecord(); }
    if (be.xp) this.game.spawnXp(x + 0.5, y + 0.5, z + 0.5, Math.floor(be.xp));
  }

  setOpen(x: number, y: number, z: number, open: boolean): void { const be = this.get(x, y, z); if (be) be.viewers = Math.max(0, (be.viewers ?? 0) + (open ? 1 : -1)); if (be && be.type === 'chest') this.game.redstone.sourceChanged(x, y, z); }

  /** Combined double-chest view. */
  combined(a: BlockEntity, b: BlockEntity): Inventory {
    const inv = new Inventory(54);
    inv.slots = new Proxy([] as (ItemStack | null)[], {
      get: (_t, prop) => { if (prop === 'length') return 54; const i = Number(prop); if (!Number.isNaN(i)) return i < 27 ? a.inventory.slots[i] : b.inventory.slots[i - 27]; return (Array.prototype as any)[prop]; },
      set: (_t, prop, v) => { const i = Number(prop); if (!Number.isNaN(i)) { if (i < 27) a.inventory.slots[i] = v; else b.inventory.slots[i - 27] = v; return true; } return true; },
    }) as any;
    inv.onChange = () => { a.inventory.onChange?.(); b.inventory.onChange?.(); };
    return inv;
  }

  comparatorLevel(x: number, y: number, z: number): number {
    const be = this.get(x, y, z);
    const reg = this.game.registry;
    const s = this.game.world.getBlock(x, y, z);
    const n = s ? reg.nameOf(s) : '';
    if (n === 'cake') return 14 - 2 * +reg.getProps(s).bites;
    if (n === 'composter') return +reg.getProps(s).level;
    if (n === 'water_cauldron') return +reg.getProps(s).level;
    if (n === 'lava_cauldron') return 3;
    if (n === 'end_portal_frame') return reg.getProps(s).eye === 'true' ? 15 : 0;
    if (n === 'jukebox') return be?.record ? 15 : 0;
    if (!be || be.inventory.size === 0) return 0;
    let f = 0, items = 0;
    for (const st of be.inventory.slots) if (st) { f += st.count / st.maxStack; items++; }
    return items === 0 ? 0 : Math.floor(f / be.inventory.size * 14) + 1;
  }

  // ---------- ticking ----------
  tick(): void {
    const g = this.game, world = g.world, reg = g.registry;
    for (const be of this.map.values()) {
      switch (be.type) {
        case 'furnace': case 'blast_furnace': case 'smoker': this.tickFurnace(be); break;
        case 'hopper': if (world.time % 8 === 0) this.tickHopper(be); break;
        case 'campfire': this.tickCampfire(be); break;
        case 'brewing_stand': this.tickBrewing(be); break;
        case 'bell': if (be.ringTicks > 0) be.ringTicks--; break;
        case 'spawner': this.tickSpawner(be); break;
        case 'beacon': if (world.time % 80 === 0) this.tickBeacon(be); break;
      }
    }
    void reg;
  }

  private tickFurnace(be: BlockEntity): void {
    const g = this.game, world = g.world, reg = g.registry;
    const inv = be.inventory;
    const input = inv.get(0), fuel = inv.get(1), output = inv.get(2);
    const kind = be.type === 'furnace' ? 'smelting' : be.type === 'blast_furnace' ? 'blasting' : 'smoking';
    const recipe = input ? g.recipes.cookingFor(input, kind) : null;
    const canOutput = recipe && (!output || (output.item === recipe.result && output.count < output.maxStack));
    if (be.burnTime === undefined) { be.burnTime = 0; be.burnDuration = 0; be.cookTime = 0; be.cookDuration = 200; }
    const wasBurning = be.burnTime > 0;
    if (be.burnTime > 0) be.burnTime--;
    if (canOutput && be.burnTime <= 0 && fuel) {
      const ft = g.items.fuel.get(fuel.item.name) ?? 0;
      if (ft > 0) {
        be.burnTime = ft; be.burnDuration = ft;
        if (fuel.item.name === 'lava_bucket') inv.set(1, new ItemStack(g.items.get('bucket')!, 1));
        else { fuel.count--; if (fuel.count <= 0) inv.set(1, null); else inv.onChange?.(); }
      }
    }
    if (canOutput && be.burnTime > 0) {
      be.cookTime = (be.cookTime ?? 0) + 1;
      be.cookDuration = recipe!.time;
      if (be.cookTime >= recipe!.time) {
        be.cookTime = 0;
        if (output) { output.count++; inv.onChange?.(); } else inv.set(2, new ItemStack(recipe!.result, 1));
        input!.count--; if (input!.count <= 0) inv.set(0, null); else inv.onChange?.();
        be.xp = (be.xp ?? 0) + recipe!.experience;
        if (input && input.item.name === 'wet_sponge' && fuel?.item.name === 'bucket') inv.set(1, new ItemStack(g.items.get('water_bucket')!, 1));
      }
    } else if (be.cookTime > 0) be.cookTime = Math.max(0, be.cookTime - 2);
    const burning = be.burnTime > 0;
    if (burning !== wasBurning || world.time % 40 === 0) {
      const s = world.getBlock(be.x, be.y, be.z);
      if (s && reg.getProps(s).lit !== String(burning) && reg.hasProp(s, 'lit')) world.setBlock(be.x, be.y, be.z, reg.withProp(s, 'lit', String(burning)));
    }
    if (burning && world.time % 40 === 0 && Math.random() < 0.3) { const s = world.getBlock(be.x, be.y, be.z); const f = s ? reg.getProps(s).facing : 'north'; const [dx, , dz] = facingOffset(f ?? 'north'); g.sounds.playAt(be.type === 'furnace' ? 'block.furnace.fire_crackle' : be.type === 'blast_furnace' ? 'block.blastfurnace.fire_crackle' : 'block.smoker.smoke', be.x + 0.5, be.y + 0.5, be.z + 0.5, 1, 1); g.particles.spawnSmoke(be.x + 0.5 + dx * 0.52, be.y + 0.3, be.z + 0.5 + dz * 0.52, 1); g.particles.spawnFlame(be.x + 0.5 + dx * 0.52, be.y + 0.3, be.z + 0.5 + dz * 0.52); }
  }

  private containerAt(x: number, y: number, z: number): BlockEntity | null {
    const s = this.game.world.getBlock(x, y, z);
    if (!s) return null;
    const n = this.game.registry.nameOf(s);
    if (n === 'chest' || n === 'trapped_chest' || n.endsWith('copper_chest')) return this.getOrCreate(x, y, z, 'chest', () => ({ items: 27 }));
    if (n === 'barrel') return this.getOrCreate(x, y, z, 'barrel', () => ({ items: 27 }));
    if (n.endsWith('shulker_box')) return this.getOrCreate(x, y, z, 'shulker_box', () => ({ items: 27 }));
    if (n === 'hopper') return this.getOrCreate(x, y, z, 'hopper', () => ({ items: 5 }));
    if (n === 'dispenser' || n === 'dropper') return this.getOrCreate(x, y, z, n, () => ({ items: 9 }));
    if (n === 'furnace' || n === 'blast_furnace' || n === 'smoker') return this.getOrCreate(x, y, z, n, () => ({ items: 3 }));
    if (n === 'brewing_stand') return this.getOrCreate(x, y, z, 'brewing_stand', () => ({ items: 5 }));
    return null;
  }

  private tickHopper(be: BlockEntity): void {
    const g = this.game, world = g.world, reg = g.registry;
    const s = world.getBlock(be.x, be.y, be.z);
    if (!s || reg.getProps(s).enabled === 'false') return;
    const facing = reg.getProps(s).facing;
    const [dx, dy, dz] = facingOffset(facing);
    // push
    const target = this.containerAt(be.x + dx, be.y + dy, be.z + dz);
    if (target) {
      for (let i = 0; i < be.inventory.size; i++) {
        const st = be.inventory.get(i);
        if (!st) continue;
        const one = st.clone(); one.count = 1;
        const range: [number, number] | undefined = target.type === 'furnace' || target.type === 'blast_furnace' || target.type === 'smoker' ? (facing === 'down' ? [0, 1] : [1, 2]) : target.type === 'brewing_stand' ? (facing === 'down' ? [3, 4] : [0, 3]) : undefined;
        if (target.type.includes('furnace') || target.type === 'smoker') { if (facing !== 'down' && !(g.items.fuel.get(st.item.name))) continue; }
        const left = target.inventory.add(one, range);
        if (left === 0) { st.count--; if (st.count <= 0) be.inventory.set(i, null); else be.inventory.onChange?.(); break; }
      }
    }
    // pull from above container
    const above = this.containerAt(be.x, be.y + 1, be.z);
    if (above) {
      for (let i = 0; i < above.inventory.size; i++) {
        if (above.type.includes('furnace') || above.type === 'smoker') { if (i !== 2) continue; }
        const st = above.inventory.get(i);
        if (!st) continue;
        const one = st.clone(); one.count = 1;
        if (be.inventory.add(one) === 0) { st.count--; if (st.count <= 0) above.inventory.set(i, null); else above.inventory.onChange?.(); return; }
      }
    } else {
      // pull item entities above
      for (const e of g.entities) {
        if (e.removed || !(e instanceof ItemEntity)) continue;
        if (e.bb.maxX > be.x && e.bb.minX < be.x + 1 && e.bb.maxZ > be.z && e.bb.minZ < be.z + 1 && e.bb.minY >= be.y + 0.5 && e.bb.minY < be.y + 2) {
          const left = be.inventory.add(e.stack);
          if (left <= 0) e.remove(); else e.stack.count = left;
          break;
        }
      }
    }
  }

  private tickCampfire(be: BlockEntity): void {
    const g = this.game, world = g.world, reg = g.registry;
    const s = world.getBlock(be.x, be.y, be.z);
    if (!s || reg.getProps(s).lit !== 'true') return;
    be.cookTimes = be.cookTimes ?? [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const st = be.inventory.get(i);
      if (!st) continue;
      be.cookTimes[i]++;
      if (be.cookTimes[i] >= 600) {
        const r = g.recipes.cookingFor(st, 'campfire_cooking');
        be.inventory.set(i, null);
        if (r) g.dropItem(be.x + 0.5, be.y + 1, be.z + 0.5, new ItemStack(r.result, 1));
        be.cookTimes[i] = 0;
      }
    }
    if (world.time % 4 === 0 && Math.random() < 0.5) g.particles.spawnCampfireSmoke(be.x + 0.5, be.y + 1, be.z + 0.5, reg.getProps(s).signal_fire === 'true');
  }

  private tickBrewing(be: BlockEntity): void {
    const g = this.game;
    const inv = be.inventory;
    const ingredient = inv.get(3);
    const fuel = inv.get(4);
    if (be.fuel === undefined) be.fuel = 0;
    if (be.fuel <= 0 && fuel && fuel.item.name === 'blaze_powder') { be.fuel = 20; fuel.count--; if (fuel.count <= 0) inv.set(4, null); else inv.onChange?.(); }
    const bottles = [0, 1, 2].map((i) => inv.get(i)).filter((s): s is ItemStack => !!s);
    const recipe = ingredient ? brewResult(ingredient.item.name) : null;
    const canBrew = recipe && be.fuel > 0 && bottles.some((b) => recipe.from(b));
    if (canBrew) {
      be.brewTime = (be.brewTime ?? 0) + 1;
      if (be.brewTime >= 400) {
        be.brewTime = 0; be.fuel--;
        for (let i = 0; i < 3; i++) { const b = inv.get(i); if (b && recipe!.from(b)) inv.set(i, recipe!.to(b, g)); }
        ingredient!.count--; if (ingredient!.count <= 0) inv.set(3, null); else inv.onChange?.();
        g.sounds.playAt('block.brewing_stand.brew', be.x + 0.5, be.y + 0.5, be.z + 0.5, 1, 1);
      }
    } else be.brewTime = 0;
  }

  private tickSpawner(be: BlockEntity): void {
    const g = this.game;
    const mob = be.mob ?? 'zombie';
    if (!MOB_DEFS[mob]) return;
    const p = g.player;
    if (!p || p.distSq(be.x + 0.5, be.y + 0.5, be.z + 0.5) > 16 * 16) return;
    if (g.world.time % 4 === 0 && Math.random() < 0.5) { g.particles.spawnFlame(be.x + Math.random(), be.y + Math.random(), be.z + Math.random()); g.particles.spawnSmoke(be.x + Math.random(), be.y + Math.random(), be.z + Math.random(), 1); }
    be.delay = (be.delay ?? 20) - 1;
    if (be.delay > 0) return;
    be.delay = 200 + Math.floor(Math.random() * 600);
    let nearby = 0;
    for (const e of g.entities) if (e instanceof Mob && e.type === mob && e.distSq(be.x, be.y, be.z) < 8 * 8) nearby++;
    if (nearby >= 6) return;
    for (let i = 0; i < 4; i++) {
      const x = be.x + 0.5 + (Math.random() - 0.5) * 8, y = be.y + Math.floor(Math.random() * 3) - 1, z = be.z + 0.5 + (Math.random() - 0.5) * 8;
      if (g.canStandAt(x, y, z) && g.world.getLightLevel(Math.floor(x), y, Math.floor(z), g.skyDarken()) <= 7) { g.spawnMob(mob, x, y, z); g.particles.spawnPoof(x, y + 1, z, 10); }
    }
  }

  private tickBeacon(be: BlockEntity): void {
    const g = this.game, reg = g.registry, world = g.world;
    // check pyramid
    let levels = 0;
    for (let l = 1; l <= 4; l++) {
      let ok = true;
      for (let dx = -l; dx <= l && ok; dx++) for (let dz = -l; dz <= l; dz++) { const s = world.getBlock(be.x + dx, be.y - l, be.z + dz); const n = s ? reg.nameOf(s) : ''; if (!(n === 'iron_block' || n === 'gold_block' || n === 'diamond_block' || n === 'emerald_block' || n === 'netherite_block')) { ok = false; break; } }
      if (!ok) break; levels = l;
    }
    be.levels = levels;
    if (levels > 0 && be.effect) { const r = 10 + levels * 10; const p = g.player; if (p && p.distSq(be.x, be.y, be.z) < r * r) p.addEffect({ id: be.effect, amplifier: levels >= 4 && be.effect === be.effect2 ? 1 : 0, duration: (9 + levels * 2) * 20 }); if (levels >= 4 && be.effect2 === 'regeneration' && p && p.distSq(be.x, be.y, be.z) < r * r) p.addEffect({ id: 'regeneration', amplifier: 0, duration: 180 }); }
  }

  // ---------- persistence ----------
  serializeOne(be: BlockEntity): any {
    const out: any = { ...be, inventory: be.inventory.serialize(), invSize: be.inventory.size };
    return out;
  }
  private deserializeOne(d: any): BlockEntity {
    const inv = new Inventory(d.invSize ?? (Array.isArray(d.inventory) ? d.inventory.length : 0));
    inv.deserialize(Array.isArray(d.inventory) ? d.inventory : undefined, this.game.items);
    const be: BlockEntity = { ...d, inventory: inv };
    delete (be as any).invSize;
    return be;
  }
  /** Store runtime BEs of a chunk back into the chunk (before save/unload). */
  flushChunk(c: Chunk): void {
    c.blockEntities.clear();
    for (const be of this.map.values()) if ((be.x >> 4) === c.cx && (be.z >> 4) === c.cz) c.setBlockEntity(be.x & 15, be.y, be.z & 15, this.serializeOne(be));
  }
  flushAll(): void { for (const c of this.game.world.chunks.values()) this.flushChunk(c); }
  loadChunk(c: Chunk): void {
    for (const d of c.blockEntities.values()) { const be = this.deserializeOne(d); this.map.set(this.key(be.x, be.y, be.z), be); }
  }
  unloadChunk(c: Chunk): void {
    this.flushChunk(c);
    for (const [k, be] of this.map) if ((be.x >> 4) === c.cx && (be.z >> 4) === c.cz) this.map.delete(k);
  }
  clear(): void { this.map.clear(); }
}

// ---------- brewing ----------
const POTION_EFFECTS: Record<string, { id: string; amp: number; dur: number; color: number }> = {
  speed: { id: 'speed', amp: 0, dur: 3600, color: 0x33ebff }, slowness: { id: 'slowness', amp: 0, dur: 1800, color: 0x8bafe0 }, strength: { id: 'strength', amp: 0, dur: 3600, color: 0xffc700 }, healing: { id: 'instant_health', amp: 0, dur: 1, color: 0xf82423 }, harming: { id: 'instant_damage', amp: 0, dur: 1, color: 0xa9656a }, leaping: { id: 'jump_boost', amp: 0, dur: 3600, color: 0xfdff84 }, regeneration: { id: 'regeneration', amp: 0, dur: 900, color: 0xcd5cab }, fire_resistance: { id: 'fire_resistance', amp: 0, dur: 3600, color: 0xff9900 }, water_breathing: { id: 'water_breathing', amp: 0, dur: 3600, color: 0x98dac0 }, invisibility: { id: 'invisibility', amp: 0, dur: 3600, color: 0xf6f6f6 }, night_vision: { id: 'night_vision', amp: 0, dur: 3600, color: 0xc2ff66 }, weakness: { id: 'weakness', amp: 0, dur: 1800, color: 0x484d48 }, poison: { id: 'poison', amp: 0, dur: 900, color: 0x87a363 }, slow_falling: { id: 'slow_falling', amp: 0, dur: 1800, color: 0xf3cfb9 }, turtle_master: { id: 'resistance', amp: 2, dur: 400, color: 0x7d9c8e },
};
const INGREDIENTS: Record<string, string> = { sugar: 'speed', rabbit_foot: 'leaping', blaze_powder: 'strength', glistering_melon_slice: 'healing', spider_eye: 'poison', ghast_tear: 'regeneration', magma_cream: 'fire_resistance', pufferfish: 'water_breathing', golden_carrot: 'night_vision', phantom_membrane: 'slow_falling', turtle_helmet: 'turtle_master' };

export function potionColor(kind: string): number { return POTION_EFFECTS[kind]?.color ?? 0x385dc6; }

function brewResult(ingredient: string): { from: (b: ItemStack) => boolean; to: (b: ItemStack, g: Game) => ItemStack } | null {
  const isWater = (b: ItemStack) => b.item.name === 'potion' && b.extra?.potion === 'water';
  const isAwkward = (b: ItemStack) => b.item.name === 'potion' && b.extra?.potion === 'awkward';
  const hasEffect = (b: ItemStack) => !!b.extra?.effect;
  const mk = (base: ItemStack, name: string, kind: string, effect: any) => { const s = base.clone(); s.item = base.item; s.extra = { potion: kind, effect, color: POTION_EFFECTS[kind]?.color ?? 0x385dc6 }; s.customName = null; void name; return s; };
  if (ingredient === 'nether_wart') return { from: isWater, to: (b) => { const s = b.clone(); s.extra = { potion: 'awkward', color: 0x385dc6 }; return s; } };
  if (ingredient === 'gunpowder') return { from: (b) => b.item.name === 'potion', to: (b, g) => { const s = b.clone(); s.item = g.items.get('splash_potion')!; return s; } };
  if (ingredient === 'dragon_breath') return { from: (b) => b.item.name === 'splash_potion', to: (b, g) => { const s = b.clone(); s.item = g.items.get('lingering_potion')!; return s; } };
  if (ingredient === 'redstone') return { from: hasEffect, to: (b) => { const s = b.clone(); s.extra = { ...s.extra, effect: { ...s.extra.effect, duration: s.extra.effect.duration * 8 / 3 } }; return s; } };
  if (ingredient === 'glowstone_dust') return { from: hasEffect, to: (b) => { const s = b.clone(); s.extra = { ...s.extra, effect: { ...s.extra.effect, amplifier: Math.min(1, s.extra.effect.amplifier + 1), duration: Math.floor(s.extra.effect.duration / 2) } }; return s; } };
  if (ingredient === 'fermented_spider_eye') return { from: (b) => hasEffect(b) || isWater(b), to: (b) => { const e = b.extra?.effect?.id; const kind = e === 'speed' || e === 'jump_boost' ? 'slowness' : e === 'instant_health' || e === 'poison' ? 'harming' : e === 'night_vision' ? 'invisibility' : 'weakness'; return mk(b, kind, kind, { ...POTION_EFFECTS[kind] ? { id: POTION_EFFECTS[kind].id, amplifier: POTION_EFFECTS[kind].amp, duration: POTION_EFFECTS[kind].dur } : { id: 'weakness', amplifier: 0, duration: 1800 } }); } };
  const kind = INGREDIENTS[ingredient];
  if (kind) return { from: isAwkward, to: (b) => mk(b, kind, kind, { id: POTION_EFFECTS[kind].id, amplifier: POTION_EFFECTS[kind].amp, duration: POTION_EFFECTS[kind].dur }) };
  return null;
}

export { oppositeFacing };
