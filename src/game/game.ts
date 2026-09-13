// The game: world lifecycle, 20 TPS simulation, rendering orchestration, player actions.
import type { Assets } from '../assets';
import { loadImage } from '../assets';
import { BlockRegistry } from '../blocks/registry';
import { ModelBaker } from '../render/models';
import { Renderer } from '../render/renderer';
import { computeSky, type SkyState } from '../render/sky';
import { World, SET_UPDATE_NEIGHBORS, type Dimension } from '../world/world';
import { ChunkManager, computeBiomeColors } from '../world/chunkManager';
import { BIOMES, skyColorFor } from '../world/gen/biomes';
import { imageToData } from '../render/gl';
import { lookDir, mat4Identity, mat4Mul, mat4RotateX, mat4RotateY, mat4Scale, mat4Translate, DEG, AABB, transformPoint } from '../math';
import { storage, type WorldMeta } from '../save/storage';
import { ItemRegistry } from '../items/registry';
import { RecipeManager } from '../items/recipes';
import { LootTables } from '../items/loot';
import { ItemStack } from '../items/stack';
import { Entity, LivingEntity, ItemEntity, ExperienceOrb } from '../entity/entity';
import { Player, type BlockHit } from '../entity/player';
import { Mob, MOB_DEFS } from '../entity/mobs';
import { FallingBlockEntity, PrimedTnt, ArrowEntity, ThrownProjectile } from '../entity/misc';
import { ItemRenderer } from '../render/itemRenderer';
import { EntityRenderer } from '../render/entityRenderer';
import { Particles } from '../render/particles';
import { SoundManager } from '../audio/sounds';
import { Gui } from './gui/gui';
import { Input } from './input';
import { BlockTicker } from '../blocks/ticking';
import { Redstone } from '../blocks/redstone';
import { BlockEntityManager } from './blockEntities';
import { Weather } from './weather';
import { Spawner } from './spawning';
import { runCommand, completeCommand } from './commands';
import { MIN_Y, MAX_Y, SEA_LEVEL, SECTION_COUNT, type Chunk } from '../world/chunk';
import { VERTEX_STRIDE } from '../render/mesher';
import { createTexture } from '../render/gl';
import { TitleScreen } from './gui/screens';
import { facingOffset } from '../blocks/placement';

export interface Options { fov: number; renderDistance: number; gamma: number; sensitivity: number; guiScale: number; clouds: boolean; viewBobbing: boolean; attackIndicator: boolean; subtitles: boolean; autoJump: boolean; volumes: Record<string, number>; bindings?: Record<string, string> }

export class Game {
  version = '0.1.0';
  registry: BlockRegistry;
  items: ItemRegistry;
  recipes: RecipeManager;
  loot: LootTables;
  baker: ModelBaker;
  renderer: Renderer;
  itemRenderer: ItemRenderer;
  entityRenderer: EntityRenderer;
  particles: Particles;
  sounds: SoundManager;
  gui: Gui;
  input: Input;
  options: Options = { fov: 70, renderDistance: 10, gamma: 0.5, sensitivity: 0.5, guiScale: 0, clouds: true, viewBobbing: true, attackIndicator: true, subtitles: false, autoJump: false, volumes: { master: 0.7, music: 0.5, record: 1, weather: 1, block: 1, hostile: 1, neutral: 1, player: 1, ambient: 1 } };
  // world state
  world!: World;
  chunks!: ChunkManager;
  blocks!: BlockTicker;
  redstone!: Redstone;
  blockEntities!: BlockEntityManager;
  weather!: Weather;
  spawner!: Spawner;
  player!: Player;
  entities: Entity[] = [];
  worldMeta: WorldMeta | null = null;
  inWorld = false;
  difficulty = 2;
  hardcore = false;
  cheats = true;
  rules: Record<string, any> = { keepInventory: false, doDaylightCycle: true, doWeatherCycle: true, mobGriefing: true, naturalRegeneration: true, doMobSpawning: true, doFireTick: true, doTileDrops: true, fallDamage: true, doImmediateRespawn: false, randomTickSpeed: 3 };
  worldSpawn: [number, number, number] = [0, 70, 0];
  lightningBolts: { x: number; y: number; z: number; life: number }[] = [];
  private otherDims = new Map<Dimension, { entities: any[]; time: number }>();
  biomeColors!: Uint8Array;
  // loop
  private lastTime = 0; private tickAcc = 0; private running = false;
  targetBlock: BlockHit | null = null;
  targetEntity: LivingEntity | null = null;
  private partial = 0;
  private swingT = 0; private equipProgress = 0; private lastHeldName = '';
  private cameraTilt = 0;
  private sprintFov = 0;
  private saveTimer = 0;
  private panoramaTex: (WebGLTexture | null)[] = [];
  private paused = false;

  constructor(public assets: Assets, public canvas: HTMLCanvasElement, public guiCanvas: HTMLCanvasElement) {
    this.registry = new BlockRegistry(assets.mcdata);
    this.items = new ItemRegistry(assets, this.registry);
    this.recipes = new RecipeManager(this.items, assets.data);
    this.loot = new LootTables(this.items, this.registry, assets.data);
    this.baker = new ModelBaker(assets.models, assets.atlas, this.registry);
    this.renderer = new Renderer(canvas, assets);
    this.itemRenderer = new ItemRenderer(assets, this.baker, this.renderer);
    this.entityRenderer = new EntityRenderer(this.renderer, this.itemRenderer, this);
    this.particles = new Particles(this);
    this.sounds = new SoundManager(assets);
    this.input = new Input(canvas);
    this.gui = new Gui(this, guiCanvas);
    window.addEventListener('mousedown', () => this.sounds.init(), { passive: true });
    window.addEventListener('keydown', () => this.sounds.init(), { passive: true });
    window.addEventListener('beforeunload', () => { if (this.inWorld) this.saveAll(); });
    document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement !== canvas) this.onPointerLockLost(); });
  }

  async start(): Promise<void> {
    const saved = await storage.loadOptions<Options>().catch(() => undefined);
    if (saved) { this.options = { ...this.options, ...saved, volumes: { ...this.options.volumes, ...(saved.volumes ?? {}) } }; if (saved.bindings) for (const [k, v] of Object.entries(saved.bindings)) this.input.bindings.set(k, v); }
    // migrate options saved by an early build whose mouse-button defaults were wrong (use=Mouse1, pick=Mouse2)
    if (this.input.bindings.get('use') === 'Mouse1' && this.input.bindings.get('pickBlock') === 'Mouse2') { this.input.bindings.set('use', 'Mouse2'); this.input.bindings.set('pickBlock', 'Mouse1'); }
    for (const [k, v] of Object.entries(this.options.volumes)) (this.sounds.volumes as any)[k] = v;
    this.gui.showSubtitles = this.options.subtitles;
    await this.gui.load();
    const [grass, foliage, dry] = await Promise.all([loadImage('colormap/grass'), loadImage('colormap/foliage'), loadImage('colormap/dry_foliage').catch(() => null)]);
    this.biomeColors = computeBiomeColors(this.assets, { grass: imageToData(grass), foliage: imageToData(foliage), dry: dry ? imageToData(dry) : null });
    this.loadPanorama();
    this.gui.openTitle();
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  saveOptions(): void {
    const bindings: Record<string, string> = {};
    for (const [k, v] of this.input.bindings) bindings[k] = v;
    storage.saveOptions({ ...this.options, bindings }).catch(() => {});
    this.applyOptions();
  }
  applyOptions(): void {
    if (this.chunks) { this.chunks.viewDistance = this.options.renderDistance; this.renderer.viewDistance = this.options.renderDistance; }
    this.renderer.cloudsEnabled = this.options.clouds;
    this.renderer.camera.fov = this.options.fov;
  }

  // ---------- world lifecycle ----------
  async loadWorld(meta: WorldMeta): Promise<void> {
    this.worldMeta = meta;
    this.gui.open(new LoadingScreen('Loading world…'));
    this.difficulty = meta.difficulty; this.cheats = meta.cheats || meta.gameMode === 'creative';
    const state = await storage.loadState<any>(meta.id, 'world').catch(() => undefined);
    if (state?.rules) Object.assign(this.rules, state.rules);
    if (state?.worldSpawn) this.worldSpawn = state.worldSpawn;
    const dim: Dimension = state?.player?.dimension ?? 'overworld';
    await this.setupDimension(dim, meta.seed, state?.time?.[dim]);
    this.player = new Player();
    this.player.world = this.world; this.player.game = this;
    this.player.cheats = this.cheats;
    this.player.setGameMode(meta.gameMode);
    this.player.inventory.onChange = () => this.gui.onHeldItemChanged();
    if (state?.player) this.player.deserialize(state.player);
    else {
      const spawn = await this.chunks.findSpawn();
      this.worldSpawn = spawn;
      this.player.setPos(spawn[0] + 0.5, spawn[1], spawn[2] + 0.5);
      this.player.setSpawn(spawn[0], spawn[1], spawn[2], false);
    }
    if (state?.weather) this.weather.deserialize(state.weather);
    if (state?.entities?.[dim]) this.restoreEntities(state.entities[dim]);
    for (const [d, v] of Object.entries(state?.entities ?? {})) if (d !== dim) this.otherDims.set(d as Dimension, { entities: v as any[], time: state.time?.[d] ?? 0 });
    this.inWorld = true;
    this.gui.close();
    this.input.lockPointer();
    this.gui.onHeldItemChanged();
    // wait until chunks around the player are ready
    await this.waitForChunks();
    meta.lastPlayed = Date.now();
    storage.saveWorldMeta(meta).catch(() => {});
    this.sounds.stopMusic();
  }

  private async setupDimension(dim: Dimension, seed: number, time?: { time: number; dayTime: number }): Promise<void> {
    this.world = new World(this.registry, dim);
    this.world.seed = seed;
    if (time) { this.world.time = time.time; this.world.dayTime = time.dayTime; }
    this.blocks = new BlockTicker(this);
    this.redstone = new Redstone(this);
    this.blockEntities = new BlockEntityManager(this);
    this.weather = this.weather ?? new Weather(this);
    this.spawner = new Spawner(this);
    this.world.listeners = [this.blocks];
    this.renderer.sections.clear();
    this.chunks = new ChunkManager(this.world, this.assets, this.renderer, this.worldMeta!.id, this.biomeColors);
    this.chunks.viewDistance = this.options.renderDistance; this.renderer.viewDistance = this.options.renderDistance;
    this.chunks.onChunkLoaded = (c) => { this.blockEntities.loadChunk(c); if ((c as any).fresh) this.spawner.populateChunk(c); };
    this.chunks.onChunkUnloaded = (c) => { this.blockEntities.unloadChunk(c); this.unloadEntitiesIn(c); };
    this.entities = [];
    await this.chunks.ready();
  }

  private async waitForChunks(): Promise<void> {
    const p = this.player;
    for (let i = 0; i < 600; i++) {
      this.chunks.update(p.x, p.z, 0.016);
      if (this.world.isChunkColumnLoaded(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4, 1)) { break; }
      await new Promise((r) => setTimeout(r, 30));
    }
    // make sure the player isn't inside blocks
    if (!this.canStandAt(p.x, p.y, p.z)) { const y = this.world.getHeight(Math.floor(p.x), Math.floor(p.z)); if (y > MIN_Y) p.setPos(p.x, y, p.z); }
  }

  saveAll(): void {
    if (!this.inWorld || !this.worldMeta) return;
    this.blockEntities.flushAll();
    this.chunks.saveAll();
    const entities: Record<string, any[]> = {};
    for (const [d, v] of this.otherDims) entities[d] = v.entities;
    entities[this.world.dimension] = this.entities.filter((e) => !e.removed && !(e instanceof ExperienceOrb)).map((e) => e.serialize());
    const time: Record<string, any> = {};
    for (const [d, v] of this.otherDims) time[d] = { time: v.time, dayTime: this.world.dayTime };
    time[this.world.dimension] = { time: this.world.time, dayTime: this.world.dayTime };
    storage.saveState(this.worldMeta.id, 'world', { player: this.player.serialize(), weather: this.weather.serialize(), entities, time, rules: this.rules, worldSpawn: this.worldSpawn }).catch(console.error);
    this.worldMeta.lastPlayed = Date.now();
    storage.saveWorldMeta(this.worldMeta).catch(() => {});
  }

  quitToTitle(): void {
    this.saveAll();
    this.chunks.dispose();
    this.renderer.sections.clear();
    this.entities = [];
    this.otherDims.clear();
    this.inWorld = false;
    this.particles.list = [];
    this.sounds.stopRecord(); this.sounds.setUnderwater(false); this.sounds.setRain(0);
    this.gui.openTitle();
  }

  // ---------- dimensions ----------
  async travelDimension(target: Dimension): Promise<void> {
    const p = this.player;
    const from = this.world.dimension;
    this.gui.open(new LoadingScreen(target === 'the_nether' ? 'Entering the Nether…' : target === 'the_end' ? 'Entering the End…' : 'Returning to the Overworld…'));
    this.blockEntities.flushAll();
    this.chunks.saveAll();
    this.otherDims.set(from, { entities: this.entities.filter((e) => !e.removed).map((e) => e.serialize()), time: this.world.time });
    this.chunks.dispose();
    const saved = this.otherDims.get(target);
    const dayTime = this.world.dayTime;
    await this.setupDimension(target, this.worldMeta!.seed, { time: saved?.time ?? 0, dayTime });
    p.world = this.world;
    let scale = 1;
    if (from === 'overworld' && target === 'the_nether') scale = 1 / 8; else if (from === 'the_nether' && target === 'overworld') scale = 8;
    let x = p.x * scale, z = p.z * scale, y = p.y;
    if (target === 'the_end') { x = 100; z = 0; y = 50; }
    else if (from === 'the_end') { const s = p.spawnPos ?? this.worldSpawn; x = s[0] + 0.5; y = s[1]; z = s[2] + 0.5; }
    p.setPos(x, y, z);
    if (saved) { this.restoreEntities(saved.entities); this.otherDims.delete(target); }
    await this.waitForChunks();
    if (target === 'the_nether' || (target === 'overworld' && from === 'the_nether')) this.placePortalNear(Math.floor(x), Math.floor(z), target);
    if (target === 'the_end') { for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) { this.world.setBlock(100 + dx, 48, dz, this.registry.defaultState('obsidian'), 0); for (let dy = 49; dy < 52; dy++) this.world.setBlock(100 + dx, dy, dz, 0, 0); } p.setPos(100.5, 49, 0.5); }
    this.gui.close();
    this.sounds.playAt('block.portal.travel', p.x, p.y, p.z, 0.5, 1);
    p.portalCooldown = 300;
  }

  private placePortalNear(x: number, z: number, dim: Dimension): void {
    const reg = this.registry, w = this.world, p = this.player;
    // look for an existing portal nearby
    for (let dx = -32; dx <= 32; dx += 1) for (let dz = -32; dz <= 32; dz += 1) for (let y = dim === 'the_nether' ? 30 : 40; y < (dim === 'the_nether' ? 120 : 200); y++) {
      const s = w.getBlock(x + dx, y, z + dz);
      if (s && reg.nameOf(s) === 'nether_portal' && this.canStandAt(x + dx + 0.5, y, z + dz + 0.5)) { p.setPos(x + dx + 0.5, y, z + dz + 0.5); return; }
    }
    // build a new one
    let y = dim === 'the_nether' ? 64 : w.getHeight(x, z);
    if (dim === 'the_nether') { y = 70; while (y > 34 && (w.getBlock(x, y - 1, z) === 0 || reg.isFluid(w.getBlock(x, y - 1, z)))) y--; while (y < 110 && w.getBlock(x, y, z) !== 0) y++; if (y >= 110) y = 70; }
    const obs = reg.defaultState('obsidian'), portal = reg.stateWith(reg.blockByName('nether_portal')!, { axis: 'x' });
    for (let dx = -1; dx <= 2; dx++) for (let dy = -1; dy <= 3; dy++) { const edge = dx === -1 || dx === 2 || dy === -1 || dy === 3; w.setBlock(x + dx, y + dy, z, edge ? obs : portal, 0); for (const oz of [-1, 1]) if (dy >= 0 && dy < 3 && dx >= 0 && dx < 2) w.setBlock(x + dx, y + dy, z + oz, 0, 0); }
    for (let dx = -1; dx <= 2; dx++) for (const oz of [-1, 1]) w.setBlock(x + dx, y - 1, z + oz, obs, 0);
    p.setPos(x + 0.5, y, z + 1.5);
  }

  /** Flint & steel on obsidian: detect a valid frame around (x,y,z) and light it. */
  tryCreatePortal(x: number, y: number, z: number): boolean {
    const reg = this.registry, w = this.world;
    const obs = reg.blockByName('obsidian')!.id;
    const isObs = (bx: number, by: number, bz: number) => { const s = w.getBlock(bx, by, bz); return s !== 0 && reg.stateBlock[s] === obs; };
    for (const axis of ['x', 'z'] as const) {
      const dx = axis === 'x' ? 1 : 0, dz = axis === 'z' ? 1 : 0;
      // find bottom-left of interior
      let bx = x, bz = z; while (w.getBlock(bx - dx, y, bz - dz) === 0 && Math.abs(bx - x) + Math.abs(bz - z) < 21) { bx -= dx; bz -= dz; }
      let by = y; while (w.getBlock(bx, by - 1, bz) === 0 && y - by < 21) by--;
      // measure width & height
      let width = 0; while (w.getBlock(bx + dx * width, by, bz + dz * width) === 0 && width < 21) width++;
      let height = 0; while (w.getBlock(bx, by + height, bz) === 0 && height < 21) height++;
      if (width < 2 || width > 21 || height < 3 || height > 21) continue;
      let ok = true;
      for (let i = 0; i < width && ok; i++) { if (!isObs(bx + dx * i, by - 1, bz + dz * i) || !isObs(bx + dx * i, by + height, bz + dz * i)) ok = false; for (let j = 0; j < height; j++) if (w.getBlock(bx + dx * i, by + j, bz + dz * i) !== 0) ok = false; }
      for (let j = 0; j < height && ok; j++) if (!isObs(bx - dx, by + j, bz - dz) || !isObs(bx + dx * width, by + j, bz + dz * width)) ok = false;
      if (!ok) continue;
      const portal = reg.stateWith(reg.blockByName('nether_portal')!, { axis });
      for (let i = 0; i < width; i++) for (let j = 0; j < height; j++) w.setBlock(bx + dx * i, by + j, bz + dz * i, portal, 0);
      this.sounds.playAt('block.portal.trigger', x, y, z, 1, 1);
      return true;
    }
    return false;
  }

  // ---------- entities ----------
  addEntity(e: Entity): void { e.world = this.world; e.game = this; e.updateBB(); this.entities.push(e); }
  spawnMob(name: string, x: number, y: number, z: number, baby = false): Mob | null {
    const def = MOB_DEFS[name];
    if (!def) return null;
    const m = new Mob(def);
    m.setPos(x, y, z); m.yaw = Math.random() * 360; m.bodyYaw = m.yaw;
    if (baby) m.setBaby(true);
    if (name === 'sheep' && Math.random() < 0.0 ) m.woolColor = 'pink';
    this.addEntity(m);
    return m;
  }
  dropItem(x: number, y: number, z: number, stack: ItemStack, vel?: [number, number, number]): ItemEntity | null {
    if (stack.count <= 0 || !this.rules.doTileDrops && false) return null;
    const e = new ItemEntity(stack);
    e.setPos(x, y, z);
    if (vel) { e.vx = vel[0]; e.vy = vel[1]; e.vz = vel[2]; } else { e.vx = (Math.random() - 0.5) * 0.2; e.vy = 0.2; e.vz = (Math.random() - 0.5) * 0.2; }
    this.addEntity(e);
    return e;
  }
  spawnXp(x: number, y: number, z: number, amount: number): void {
    while (amount > 0) {
      const v = amount >= 2477 ? 2477 : amount >= 1237 ? 1237 : amount >= 617 ? 617 : amount >= 307 ? 307 : amount >= 149 ? 149 : amount >= 73 ? 73 : amount >= 37 ? 37 : amount >= 17 ? 17 : amount >= 7 ? 7 : amount >= 3 ? 3 : 1;
      amount -= v;
      const o = new ExperienceOrb(v); o.setPos(x + (Math.random() - 0.5) * 0.5, y + 0.5, z + (Math.random() - 0.5) * 0.5); o.vx = (Math.random() - 0.5) * 0.2; o.vy = 0.2; o.vz = (Math.random() - 0.5) * 0.2;
      this.addEntity(o);
    }
  }
  givePlayer(stack: ItemStack): void { const left = this.player.inventory.add(stack); if (left > 0) this.player.throwItem(stack); this.player.inventory.onChange?.(); }
  livingEntitiesIncludingPlayer(): LivingEntity[] { const out: LivingEntity[] = []; for (const e of this.entities) if (e instanceof LivingEntity && !e.removed) out.push(e); if (this.player && !this.player.removed) out.push(this.player); return out; }
  entityDisplayName(e: Entity): string { if (e === this.player) return this.player.name; return (e as any).customName ?? this.assets.lang['entity.minecraft.' + e.type] ?? e.type; }
  private restoreEntities(list: any[]): void {
    for (const d of list) {
      try {
        let e: Entity | null = null;
        if (MOB_DEFS[d.type]) e = new Mob(MOB_DEFS[d.type]);
        else if (d.type === 'item') { const s = ItemStack.deserialize(d.stack, this.items); if (s) e = new ItemEntity(s); }
        else if (d.type === 'falling_block') e = new FallingBlockEntity(d.blockState);
        else if (d.type === 'tnt') e = new PrimedTnt(d.fuse);
        if (!e) continue;
        e.world = this.world; e.game = this;
        e.deserialize(d);
        this.addEntity(e);
      } catch { /* skip bad entity */ }
    }
  }
  private unloadEntitiesIn(c: Chunk): void {
    // persist entities from unloaded chunks into the chunk's block-entity-like storage (simple approach: keep them in memory)
    for (const e of this.entities) { if ((Math.floor(e.x) >> 4) === c.cx && (Math.floor(e.z) >> 4) === c.cz && !(e instanceof Mob && e.persistent)) { if (e instanceof Mob && e.def.category !== 'passive' && !e.tamed) e.remove(); } }
  }
  onItemPickedUp(e: ItemEntity, _n: number): void { void e; }
  onPlayerDied(): void { this.gui.openDeath(); }
  respawnPlayer(): void {
    const p = this.player;
    let spawn: [number, number, number] | null = p.spawnPos;
    // bed still there?
    if (spawn && !p.spawnForced) { const s = this.world.getBlock(spawn[0], spawn[1], spawn[2]); if (!s || !this.registry.nameOf(s).endsWith('_bed')) { spawn = null; this.gui.addChat(this.assets.lang['block.minecraft.spawn.not_valid'] ?? 'You have no home bed or charged respawn anchor, or it was obstructed'); } }
    const target = spawn ?? this.worldSpawn;
    if (this.world.dimension !== 'overworld' && !spawn) { this.travelDimension('overworld').then(() => this.finishRespawn(this.worldSpawn)); return; }
    this.finishRespawn(target);
  }
  private finishRespawn(target: [number, number, number]): void {
    const p = this.player;
    p.removed = false; p.isDead = false; p.health = p.maxHealth; p.deathTime = 0; p.foodLevel = 20; p.saturation = 5; p.exhaustion = 0; p.fireTicks = 0; p.effects = []; p.absorption = 0; p.air = 300; p.fallDistance = 0; p.vx = p.vy = p.vz = 0;
    let [x, y, z] = target;
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) { let yy = y; for (let i = 0; i < 4; i++) { if (this.canStandAt(x + dx + 0.5, yy, z + dz + 0.5)) { p.setPos(x + dx + 0.5, yy, z + dz + 0.5); return; } yy++; } }
    const hy = this.world.getHeight(x, z);
    p.setPos(x + 0.5, hy > MIN_Y ? hy : y, z + 0.5);
  }

  // ---------- queries ----------
  isDay(): boolean { const t = this.world.dayTime % 24000; return t < 12542 || t >= 23460; }
  skyDarken(): number { const sky = computeSky(this.world.dayTime, this.world.dimension, 0x7ba4ff, undefined, 8, this.weather.rainLevel, this.weather.thunderLevel, 64, 'air', 0); return Math.round((1 - sky.dayFactor) * 11 / 0.8 * 0.8 + 0); }
  biomeAt(x: number, z: number) { return BIOMES[this.world.getBiome(x, z)]; }
  canStandAt(x: number, y: number, z: number): boolean {
    const bb = new AABB(x - 0.3, y, z - 0.3, x + 0.3, y + 1.8, z + 0.3);
    let hit = false;
    this.world.forEachCollisionBox(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ, (x0, y0, z0, x1, y1, z1) => { if (bb.minX < x1 && bb.maxX > x0 && bb.minY < y1 && bb.maxY > y0 && bb.minZ < z1 && bb.maxZ > z0) hit = true; });
    if (hit) return false;
    const below = this.world.getBlock(Math.floor(x), Math.floor(y) - 1, Math.floor(z));
    return below !== 0 && this.registry.collisionBoxes(below).length > 0;
  }
  groundHeightNear(x: number, y: number, z: number, range: number): number | null {
    for (let dy = 0; dy <= range; dy++) { for (const s of [1, -1]) { const yy = y + dy * s; if (this.world.getBlock(x, yy, z) === 0 && this.world.getBlock(x, yy - 1, z) !== 0 && this.registry.collisionBoxes(this.world.getBlock(x, yy - 1, z)).length) return yy; } }
    return null;
  }
  canSeeBetween(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0; const d = Math.hypot(dx, dy, dz);
    if (d < 0.01) return true;
    return !this.raycastBlocks(x0, y0, z0, dx / d, dy / d, dz / d, d, false);
  }
  blockParticleTint(state: number, x: number, z: number): number {
    const n = this.registry.nameOf(state);
    const b = this.world.getBiome(x, z);
    const o = b * 12;
    const c = this.biomeColors;
    if (n === 'grass_block' || n === 'short_grass' || n === 'tall_grass' || n === 'fern' || n === 'large_fern') return (c[o] << 16) | (c[o + 1] << 8) | c[o + 2];
    if (n === 'oak_leaves' || n === 'jungle_leaves' || n === 'acacia_leaves' || n === 'dark_oak_leaves' || n === 'mangrove_leaves' || n === 'vine' || n === 'pale_oak_leaves') return (c[o + 3] << 16) | (c[o + 4] << 8) | c[o + 5];
    if (n === 'birch_leaves') return 0x80a755; if (n === 'spruce_leaves') return 0x619961;
    return 0xffffff;
  }
  project(x: number, y: number, z: number): [number, number] | null {
    const cb = this.renderer.camBase;
    const v = [0, 0, 0] as [number, number, number];
    const m = this.renderer.vp;
    const px = x - cb[0], py = y - cb[1], pz = z - cb[2];
    const cw = m[3] * px + m[7] * py + m[11] * pz + m[15];
    if (cw <= 0) return null;
    transformPoint(v, m, px, py, pz);
    return [(v[0] / cw * 0.5 + 0.5) * this.canvas.width, (1 - (v[1] / cw * 0.5 + 0.5)) * this.canvas.height];
  }

  /** DDA raycast against block collision/outline shapes. */
  raycastBlocks(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, fluids: boolean): BlockHit | null {
    const reg = this.registry, w = this.world;
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tdx = Math.abs(1 / (dx || 1e-9)), tdy = Math.abs(1 / (dy || 1e-9)), tdz = Math.abs(1 / (dz || 1e-9));
    let tmx = dx > 0 ? (x + 1 - ox) * tdx : (ox - x) * tdx, tmy = dy > 0 ? (y + 1 - oy) * tdy : (oy - y) * tdy, tmz = dz > 0 ? (z + 1 - oz) * tdz : (oz - z) * tdz;
    let t = 0;
    const box = new AABB();
    for (let i = 0; i < 400 && t <= maxDist; i++) {
      const s = w.getBlock(x, y, z);
      if (s !== 0 && !reg.isAir(s)) {
        const isFluid = reg.isFluid(s);
        if (!isFluid || fluids) {
          let boxes = reg.collisionBoxes(s);
          if (isFluid) boxes = [[0, 0, 0, 1, reg.fluidLevel(s) === 0 || reg.fluidLevel(s) >= 8 ? 8 / 9 : (8 - reg.fluidLevel(s)) / 9, 1]];
          else if (boxes.length === 0) boxes = this.outlineBoxes(s);
          let best: [number, number] | null = null;
          for (const b of boxes) {
            box.set(x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]);
            const r = box.rayIntersect(ox, oy, oz, dx, dy, dz);
            if (r && r[0] <= maxDist && (!best || r[0] < best[0])) best = r;
          }
          if (best) { const hx = ox + dx * best[0] - x, hy = oy + dy * best[0] - y, hz = oz + dz * best[0] - z; return { x, y, z, face: best[1], hx, hy, hz, t: best[0], state: s }; }
        }
      }
      if (tmx < tmy && tmx < tmz) { x += stepX; t = tmx; tmx += tdx; }
      else if (tmy < tmz) { y += stepY; t = tmy; tmy += tdy; }
      else { z += stepZ; t = tmz; tmz += tdz; }
      if (y < MIN_Y - 1 || y > MAX_Y) break;
    }
    return null;
  }
  /** Outline (selection) boxes for blocks without collision: from the baked model. */
  outlineBoxes(state: number): number[][] {
    const cached = this.outlineCache.get(state);
    if (cached) return cached;
    const model = this.baker.firstModel(state);
    let minX = 1, minY = 1, minZ = 1, maxX = 0, maxY = 0, maxZ = 0;
    if (model) for (const q of model.quads) for (let i = 0; i < 4; i++) { minX = Math.min(minX, q.pos[i * 3]); maxX = Math.max(maxX, q.pos[i * 3]); minY = Math.min(minY, q.pos[i * 3 + 1]); maxY = Math.max(maxY, q.pos[i * 3 + 1]); minZ = Math.min(minZ, q.pos[i * 3 + 2]); maxZ = Math.max(maxZ, q.pos[i * 3 + 2]); }
    const boxes = maxX > minX && maxY > minY && maxZ > minZ ? [[Math.max(0, minX), Math.max(0, minY), Math.max(0, minZ), Math.min(1, maxX), Math.min(1, maxY), Math.min(1, maxZ)]] : [[0, 0, 0, 1, 1, 1]];
    this.outlineCache.set(state, boxes);
    return boxes;
  }
  private outlineCache = new Map<number, number[][]>();

  // ---------- block actions ----------
  /** Break a block: drops (loot tables + tool), sounds, particles, container contents. */
  breakBlock(x: number, y: number, z: number, player: Player | null, drops: boolean, silentPlayer: boolean): void {
    const reg = this.registry, w = this.world;
    const s = w.getBlock(x, y, z);
    if (s === 0) return;
    const b = reg.block(s);
    const n = b.name;
    if (b.hardness < 0 && player && !player.isCreative) return;
    const tool = player?.heldItem() ?? null;
    // drops
    if (drops && !(player?.isCreative) && this.rules.doTileDrops !== false) {
      const canHarvest = player ? player.canHarvest(s) : true;
      if (canHarvest) {
        const items = this.loot.blockDrops(s, { tool });
        for (const it of items) this.dropItem(x + 0.5, y + 0.5, z + 0.5, it);
        // ore xp
        const xp = ORE_XP[n.replace('deepslate_', '')];
        if (xp && !(tool && tool.enchantLevel('silk_touch'))) this.spawnXp(x + 0.5, y + 0.5, z + 0.5, xp[0] + Math.floor(Math.random() * (xp[1] - xp[0] + 1)));
        if (n === 'spawner') this.spawnXp(x + 0.5, y + 0.5, z + 0.5, 15 + Math.floor(Math.random() * 29));
      }
    }
    if (this.blockEntities.get(x, y, z)) {
      if (n.endsWith('shulker_box') && drops && !player?.isCreative) { const be = this.blockEntities.remove(x, y, z)!; const item = this.items.get(n)!; const st = new ItemStack(item, 1); st.extra = { contents: be.inventory.serialize() }; }
      else this.blockEntities.dropContents(x, y, z);
    }
    // sound & particles
    if (!silentPlayer || !player) this.sounds.playAt(`block.${b.soundType}.break`, x + 0.5, y + 0.5, z + 0.5, 1, 0.8);
    if (!silentPlayer) this.particles.spawnBlockBreak(x, y, z, s);
    // remove (keep water if waterlogged)
    const replace = reg.isWaterlogged(s) && !reg.implicitWater[reg.stateBlock[s]] ? reg.WATER : 0;
    w.setBlock(x, y, z, replace, SET_UPDATE_NEIGHBORS);
    // second halves
    const props = reg.getProps(s);
    if (n.endsWith('_door')) { const oy = props.half === 'lower' ? y + 1 : y - 1; const o = w.getBlock(x, oy, z); if (o && reg.block(o) === b) w.setBlock(x, oy, z, 0, SET_UPDATE_NEIGHBORS); }
    if (n.endsWith('_bed')) { const [dx, , dz] = facingOffset(props.part === 'foot' ? props.facing : ({ north: 'south', south: 'north', west: 'east', east: 'west' } as any)[props.facing]); const o = w.getBlock(x + dx, y, z + dz); if (o && reg.block(o) === b) w.setBlock(x + dx, y, z + dz, 0, SET_UPDATE_NEIGHBORS); }
    if (n === 'tall_grass' || n === 'large_fern' || n === 'sunflower' || n === 'lilac' || n === 'rose_bush' || n === 'peony' || n === 'pitcher_plant' || n === 'small_dripleaf' || n === 'tall_seagrass') { const oy = props.half === 'lower' ? y + 1 : y - 1; const o = w.getBlock(x, oy, z); if (o && reg.block(o) === b) w.setBlock(x, oy, z, 0, SET_UPDATE_NEIGHBORS); }
    if (n === 'chest' || n === 'trapped_chest') { const t = props.type; if (t !== 'single') { const f = props.facing; const dir = t === 'left' ? ({ north: 'east', east: 'south', south: 'west', west: 'north' } as any)[f] : ({ north: 'west', west: 'south', south: 'east', east: 'north' } as any)[f]; const [dx, , dz] = facingOffset(dir); const o = w.getBlock(x + dx, y, z + dz); if (o && reg.block(o) === b) w.setBlock(x + dx, y, z + dz, reg.withProp(o, 'type', 'single'), 0); } }
    if (n === 'nether_portal') { // break the whole portal
      const q: [number, number, number][] = [[x, y, z]]; let guard = 0;
      while (q.length && guard++ < 512) { const [px, py, pz] = q.pop()!; for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const st = w.getBlock(px + dx, py + dy, pz + dz); if (st && reg.nameOf(st) === 'nether_portal') { w.setBlock(px + dx, py + dy, pz + dz, 0, 0); q.push([px + dx, py + dy, pz + dz]); } } }
    }
    if (n === 'ice' && drops && !(tool && tool.enchantLevel('silk_touch')) && y > MIN_Y && w.getBlock(x, y - 1, z) !== 0 && w.dimension !== 'the_nether') w.setBlock(x, y, z, reg.WATER);
    if (n === 'infested_stone' || n.startsWith('infested_')) this.spawnMob('silverfish', x + 0.5, y, z + 0.5);
    if (n === 'turtle_egg' || n === 'sniffer_egg') { /* handled by loot */ }
    if (player && tool && !player.isCreative) {
      if (tool.item.tool !== 'none' && b.hardness > 0) player.damageHeld(tool, tool.item.tool === 'sword' ? 2 : 1);
      if (tool.item.tool === 'hoe' && n.endsWith('_leaves')) player.damageHeld(tool, 1);
    }
    if (player) { player.addExhaustion(0.005); if (n === 'budding_amethyst') {/* */} }
    this.redstone.sourceChanged(x, y, z);
    if (n.endsWith('_leaves') || n === 'sweet_berry_bush' || n === 'wither_rose') { /* */ }
  }

  onBlockPlaced(x: number, y: number, z: number, state: number): void {
    const n = this.registry.nameOf(state);
    if (n === 'fire' || n === 'soul_fire') this.sounds.playAt('item.flintandsteel.use', x, y, z, 1, 1);
    // pumpkin golems
    if (n === 'carved_pumpkin' || n === 'jack_o_lantern') this.tryBuildGolem(x, y, z);
    if (n === 'wither_skeleton_skull') this.tryBuildWither(x, y, z);
    if (n === 'spawner') this.blockEntities.getOrCreate(x, y, z, 'spawner', () => ({ mob: 'zombie' }));
    if (n === 'comparator') this.world.scheduleTick(x, y, z, 2);
    if (n === 'jukebox' || n === 'bell' || n === 'beacon' || n === 'campfire' || n === 'soul_campfire') this.blockEntities.getOrCreate(x, y, z, n === 'soul_campfire' ? 'campfire' : n, () => ({ items: n.includes('campfire') ? 4 : 0 }));
  }
  private tryBuildGolem(x: number, y: number, z: number): void {
    const reg = this.registry, w = this.world;
    const is = (bx: number, by: number, bz: number, name: string) => { const s = w.getBlock(bx, by, bz); return s !== 0 && reg.nameOf(s) === name; };
    if (is(x, y - 1, z, 'snow_block') && is(x, y - 2, z, 'snow_block')) { w.setBlock(x, y, z, 0); w.setBlock(x, y - 1, z, 0); w.setBlock(x, y - 2, z, 0); const m = this.spawnMob('snow_golem', x + 0.5, y - 2, z + 0.5); if (m) m.persistent = true; return; }
    if (is(x, y - 1, z, 'iron_block') && is(x, y - 2, z, 'iron_block')) {
      for (const [dx, dz] of [[1, 0], [0, 1]]) if (is(x + dx, y - 1, z + dz, 'iron_block') && is(x - dx, y - 1, z - dz, 'iron_block')) { for (const [bx, by, bz] of [[x, y, z], [x, y - 1, z], [x, y - 2, z], [x + dx, y - 1, z + dz], [x - dx, y - 1, z - dz]]) w.setBlock(bx, by, bz, 0); const m = this.spawnMob('iron_golem', x + 0.5, y - 2, z + 0.5); if (m) { m.persistent = true; m.tamed = true; } return; }
    }
  }
  private tryBuildWither(x: number, y: number, z: number): void {
    const reg = this.registry, w = this.world;
    const is = (bx: number, by: number, bz: number, name: string) => { const s = w.getBlock(bx, by, bz); return s !== 0 && reg.nameOf(s) === name; };
    for (const [dx, dz] of [[1, 0], [0, 1]]) for (let off = -1; off <= 1; off++) {
      const cx = x + dx * off, cz = z + dz * off;
      if ([-1, 0, 1].every((i) => is(cx + dx * i, y, cz + dz * i, 'wither_skeleton_skull') && is(cx + dx * i, y - 1, cz + dz * i, 'soul_sand')) && is(cx, y - 2, cz, 'soul_sand')) {
        for (let i = -1; i <= 1; i++) { w.setBlock(cx + dx * i, y, cz + dz * i, 0); w.setBlock(cx + dx * i, y - 1, cz + dz * i, 0); } w.setBlock(cx, y - 2, cz, 0);
        this.spawnMob('wither', cx + 0.5, y - 2, cz + 0.5); this.sounds.playAt('entity.wither.spawn', cx, y, cz, 10, 1); return;
      }
    }
  }
  igniteTnt(x: number, y: number, z: number): void {
    this.world.setBlock(x, y, z, 0);
    const t = new PrimedTnt(80); t.setPos(x + 0.5, y, z + 0.5); this.addEntity(t);
    this.sounds.playAt('entity.tnt.primed', x + 0.5, y, z + 0.5, 1, 1);
  }
  damageEntitiesIn(box: AABB, amount: number, source: any): void { for (const e of this.livingEntitiesIncludingPlayer()) if (e.bb.intersects(box)) e.hurt({ amount, source }); }

  /** Vanilla-style explosion. */
  explode(x: number, y: number, z: number, power: number, breakBlocks: boolean, source: Entity | null = null, windOnly = false): void {
    const reg = this.registry, w = this.world;
    const toBreak = new Set<string>();
    if (breakBlocks && !windOnly && this.rules.mobGriefing !== false) {
      for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) for (let k = 0; k < 16; k++) {
        if (i !== 0 && i !== 15 && j !== 0 && j !== 15 && k !== 0 && k !== 15) continue;
        let dx = i / 15 * 2 - 1, dy = j / 15 * 2 - 1, dz = k / 15 * 2 - 1;
        const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
        let str = power * (0.7 + Math.random() * 0.6);
        let px = x, py = y, pz = z;
        while (str > 0) {
          const bx = Math.floor(px), by = Math.floor(py), bz = Math.floor(pz);
          const s = w.getBlock(bx, by, bz);
          if (s !== 0) { const b = reg.block(s); const res = reg.isFluid(s) ? 100 : b.resistance; str -= (res + 0.3) * 0.3; if (str > 0 && b.hardness >= 0) toBreak.add(`${bx},${by},${bz}`); }
          px += dx * 0.3; py += dy * 0.3; pz += dz * 0.3;
          str -= 0.225;
        }
      }
    }
    // entities
    const r = power * 2;
    for (const e of [...this.entities, this.player]) {
      if (!e || e.removed) continue;
      const d = Math.sqrt(e.distSq(x, y, z)) / r;
      if (d > 1) continue;
      let dx = e.x - x, dy = e.eyeY - y, dz = e.z - z; const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      const exposure = this.canSeeBetween(x, y, z, e.x, e.y + e.height / 2, e.z) ? 1 : 0.5;
      const impact = (1 - d) * exposure;
      const dmg = Math.floor((impact * impact + impact) / 2 * 7 * r + 1);
      if (!windOnly && e instanceof LivingEntity) e.hurt({ amount: dmg, source: 'explosion', attacker: source });
      else if (!windOnly) e.hurt({ amount: dmg, source: 'explosion' });
      const kb = e instanceof LivingEntity ? impact * (1 - e.enchantProtection('explosion') / 25 * 0.15) : impact;
      e.vx += dx * kb; e.vy += dy * kb; e.vz += dz * kb;
    }
    if (!windOnly) this.sounds.playAt('entity.generic.explode', x, y, z, 4, (1 + (Math.random() - Math.random()) * 0.2) * 0.7);
    else this.sounds.playAt('entity.wind_charge.wind_burst', x, y, z, 1, 1);
    this.particles.spawnExplosion(x, y, z, windOnly ? 1 : power);
    for (const k of toBreak) {
      const [bx, by, bz] = k.split(',').map(Number);
      const s = w.getBlock(bx, by, bz);
      if (s === 0) continue;
      const n = reg.nameOf(s);
      if (n === 'tnt') { w.setBlock(bx, by, bz, 0); const t = new PrimedTnt(10 + Math.floor(Math.random() * 20)); t.setPos(bx + 0.5, by, bz + 0.5); this.addEntity(t); continue; }
      if (Math.random() < 1 / power || (source instanceof PrimedTnt && false)) { const items = this.loot.blockDrops(s, { explosion: true }); for (const it of items) this.dropItem(bx + 0.5, by + 0.5, bz + 0.5, it); }
      this.blockEntities.dropContents(bx, by, bz);
      w.setBlock(bx, by, bz, 0, SET_UPDATE_NEIGHBORS);
    }
    if (source instanceof PrimedTnt || (!windOnly && Math.random() < 0.3)) for (const k of toBreak) { const [bx, by, bz] = k.split(',').map(Number); if (Math.random() < 0.05 && w.getBlock(bx, by, bz) === 0 && w.getBlock(bx, by - 1, bz) !== 0 && (source as any)?.type === 'ghast_fireball') w.setBlock(bx, by, bz, this.blocks.fireStateFor(bx, by, bz)); }
  }

  // ---------- chat ----------
  handleChat(text: string): void { if (text.startsWith('/')) runCommand(this, text); else this.gui.addChat(`<${this.player.name}> ${text}`); }
  completeCommand(text: string): string | null { return completeCommand(text); }
  setDifficulty(d: number): void { this.difficulty = d; if (this.worldMeta) { this.worldMeta.difficulty = d; storage.saveWorldMeta(this.worldMeta).catch(() => {}); } if (d === 0) for (const e of this.entities) if (e instanceof Mob && e.hostile) e.remove(); }
  onScreenChanged(): void { this.paused = !!this.gui.screen && this.gui.screen.pausesGame; }

  // ---------- main loop ----------
  private frame(t: number): void {
    if (!this.running) return;
    const dt = Math.min(0.25, (t - this.lastTime) / 1000);
    this.lastTime = t;
    try {
      const hadScreen = !!this.gui.screen;
      this.input.wantLock = this.inWorld && !this.gui.screen && !(this.player?.isDead);
      this.gui.handleInput();
      if (this.inWorld) {
        this.handleGlobalKeys(hadScreen);
        this.applyMouseLook();
        this.tickAcc += dt;
        if (this.paused) { this.tickAcc = 0; this.input.discardTick(); }
        let ticks = 0;
        while (this.tickAcc >= 0.05 && ticks < 10) { this.tickAcc -= 0.05; this.tick(); ticks++; }
        if (this.tickAcc >= 0.05) this.tickAcc = 0;
        this.partial = this.paused ? 1 : this.tickAcc / 0.05;
        this.renderWorld(t / 1000, dt);
      } else {
        this.renderPanorama(t / 1000);
        this.sounds.tickMusic('menu', dt * 20);
        this.gui.tick();
      }
      this.gui.render(this.partial, dt);
    } catch (e) { console.error(e); this.gui.addChat('§c' + String((e as any)?.message ?? e)); }
    this.input.endFrame();
    requestAnimationFrame((tt) => this.frame(tt));
  }

  /** Per-frame keys. `hadScreen` = a screen was open at the start of this frame (its key handling already ran). */
  private handleGlobalKeys(hadScreen: boolean): void {
    const input = this.input;
    if (input.framePressed('debug')) this.gui.showDebug = !this.gui.showDebug;
    if (input.framePressed('hideGui')) this.gui.hideHud = !this.gui.hideHud;
    if (input.framePressed('togglePerspective')) this.gui.thirdPerson = (this.gui.thirdPerson + 1) % 3;
    if (input.framePressed('fullscreen')) { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); }
    if (input.framePressed('screenshot')) this.takeScreenshot();
    if (!hadScreen && !this.gui.screen) {
      if (input.keyPressed('Escape')) this.gui.openPause();
      else if (input.framePressed('inventory')) this.gui.openInventory();
      else if (input.framePressed('chat')) { this.gui.openChat(); input.typed.length = 0; }
      else if (input.framePressed('command')) { this.gui.openChat('/'); input.typed.length = 0; }
      // pointer lock on click
      else if (!input.pointerLocked && input.buttonsPressed.size) { input.lockPointer(); input.discardTick(); }
    }
    if (hadScreen) input.discardTick();
  }

  /** Mouse look runs every frame (not per tick) so turning is smooth and nothing is lost. */
  private applyMouseLook(): void {
    const input = this.input, p = this.player;
    if (this.gui.screen || !input.pointerLocked || !p || p.sleeping) return;
    const sens = 0.6 * this.options.sensitivity + 0.2;
    const f = sens * sens * sens * 8 * 0.15 * (this.gui.spyglass ? 0.1 : 1);
    if (input.mouseDx || input.mouseDy) {
      p.yaw += input.mouseDx * f; p.pitch = Math.max(-90, Math.min(90, p.pitch + input.mouseDy * f));
      p.prevYaw = p.yaw; p.prevPitch = p.pitch;
    }
  }

  /** Pointer lock was lost (browser Esc): open the pause menu so a single Esc works like vanilla. */
  onPointerLockLost(): void {
    // ignore the async change events caused by our own lock/unlock calls
    if (performance.now() - this.input.lastLockRequest < 400) return;
    if (!this.inWorld || this.player?.isDead) return;
    const s = this.gui.screen;
    if (!s) this.gui.openPause();
    else if (s.closeOnEsc) { s.onClose(); this.gui.close(); } // the browser swallowed the Esc key: treat it as one
  }

  private takeScreenshot(): void {
    const c = document.createElement('canvas'); c.width = this.canvas.width; c.height = this.canvas.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(this.canvas, 0, 0); ctx.drawImage(this.guiCanvas, 0, 0, c.width, c.height);
    c.toBlob((b) => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `voxeland-${Date.now()}.png`; a.click(); this.gui.addChat('Saved screenshot'); });
  }

  private tick(): void {
    const p = this.player;
    const w = this.world;
    this.gui.tick();
    // time
    w.time++;
    if (this.rules.doDaylightCycle !== false && w.dimension === 'overworld') w.dayTime++;
    // player input
    this.updatePlayerInput();
    // chunks stream
    this.chunks.update(p.x, p.z, 0.05);
    // sleeping skips night
    if (p.sleeping && p.sleepTimer >= 100) { w.dayTime = Math.floor(w.dayTime / 24000) * 24000 + 24000; this.weather.raining = false; this.weather.thundering = false; p.wakeUp(); this.gui.sleepFade = 0; }
    // scheduled ticks
    for (const t of w.popDueTicks()) if (w.isLoaded(t.x, t.z)) this.blocks.scheduledTick(t.x, t.y, t.z, t.state);
    // random ticks
    this.randomTicks();
    // entities
    for (const e of this.entities) { if (e.removed) continue; if (!w.isLoaded(Math.floor(e.x), Math.floor(e.z))) continue; e.tick(); }
    if (this.entities.some((e) => e.removed)) this.entities = this.entities.filter((e) => !e.removed);
    // player
    p.tick();
    if (p.health <= 0 && !this.gui.isOpen) this.gui.openDeath();
    // block entities, weather, spawning
    this.blockEntities.tick();
    this.weather.tick();
    if (this.rules.doMobSpawning !== false) this.spawner.tick();
    // lightning bolts render list
    for (const b of this.lightningBolts) b.life--;
    this.lightningBolts = this.lightningBolts.filter((b) => b.life > 0);
    // particles
    this.particles.tick();
    this.renderer.tickAnimations();
    // sounds
    this.sounds.updateListener(p.x, p.eyeY, p.z, p.yaw, p.pitch);
    this.sounds.setUnderwater(p.eyeInWater);
    this.sounds.updateRecord();
    const musicKind = w.dimension === 'the_nether' ? 'nether.' + BIOMES[w.getBiome(Math.floor(p.x), Math.floor(p.z))].name : w.dimension === 'the_end' ? 'end' : p.isCreative ? 'creative' : p.eyeInWater ? 'under_water' : 'game';
    this.sounds.tickMusic(this.sounds.events?.['music.' + musicKind] ? musicKind : 'game', 1);
    // ambient cave sounds
    if (w.time % 100 === 0 && Math.random() < 0.1 && w.getSky(Math.floor(p.x), Math.floor(p.eyeY), Math.floor(p.z)) === 0 && w.getBlockLight(Math.floor(p.x), Math.floor(p.eyeY), Math.floor(p.z)) < 8 && w.dimension === 'overworld') this.sounds.playAt('ambient.cave', p.x + (Math.random() - 0.5) * 20, p.y + (Math.random() - 0.5) * 10, p.z + (Math.random() - 0.5) * 20, 0.7, 0.8 + Math.random() * 0.4);
    if (w.dimension === 'the_nether' && w.time % 200 === 0 && Math.random() < 0.3) this.sounds.playAt('ambient.' + BIOMES[w.getBiome(Math.floor(p.x), Math.floor(p.z))].name + '.loop', p.x, p.y, p.z, 0.3, 1);
    // autosave
    if (++this.saveTimer >= 6000) { this.saveTimer = 0; this.saveAll(); }
    // block interaction targets
    this.updateTargets();
    // held item change animation
    const hn = p.heldItem()?.item.name ?? '';
    if (hn !== this.lastHeldName) { this.lastHeldName = hn; this.equipProgress = 1; this.gui.onHeldItemChanged(); }
    this.equipProgress = Math.max(0, this.equipProgress - 0.25);
    // ambient particles around player
    if (w.dimension === 'the_nether' || w.dimension === 'the_end') { /* portal particles skipped */ }
    if (p.eyeInWater && Math.random() < 0.2) this.particles.spawnBubble(p.x + (Math.random() - 0.5), p.eyeY, p.z + (Math.random() - 0.5));
    if (p.isInPortal && Math.random() < 0.5) this.particles.spawnPortal(p.x, p.y + 1, p.z, 2);
    // creative flying no fall
    if (p.flying) p.fallDistance = 0;
    // mob attacks on player use pressure plates via mobs; nothing here
  }

  private randomTicks(): void {
    const w = this.world;
    const speed = this.rules.randomTickSpeed ?? 3;
    if (speed <= 0) return;
    const p = this.player;
    const pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
    const sim = Math.min(6, this.chunks.viewDistance);
    for (const c of w.chunks.values()) {
      if (Math.abs(c.cx - pcx) > sim || Math.abs(c.cz - pcz) > sim) continue;
      c.inhabitedTime++;
      for (let sy = 0; sy < SECTION_COUNT; sy++) {
        const sec = c.sections[sy];
        if (!sec) continue;
        for (let i = 0; i < speed; i++) {
          const idx = Math.floor(Math.random() * 4096);
          const s = sec[idx];
          if (s === 0) continue;
          const x = c.cx * 16 + (idx & 15), y = sy * 16 + MIN_Y + (idx >> 8), z = c.cz * 16 + ((idx >> 4) & 15);
          this.blocks.randomTick(x, y, z, s);
        }
      }
      // snow/ice from weather
      if (this.weather.rainLevel > 0.5 && Math.random() < 1 / 16) {
        const lx = Math.floor(Math.random() * 16), lz = Math.floor(Math.random() * 16);
        const x = c.cx * 16 + lx, z = c.cz * 16 + lz; const y = c.getHeight(lx, lz);
        const biome = BIOMES[c.biomes[(lz << 4) | lx]];
        if (biome.precipitation === 'snow' && y < MAX_Y - 1) {
          const top = w.getBlock(x, y - 1, z); const air = w.getBlock(x, y, z);
          if (top && this.registry.isWater(top) && this.registry.fluidLevel(top) === 0) w.setBlock(x, y - 1, z, this.registry.defaultState('ice'));
          else if (air === 0 && top && this.registry.fullCube[top] && y > SEA_LEVEL - 2) w.setBlock(x, y, z, this.registry.defaultState('snow'));
        }
      }
    }
  }

  private updatePlayerInput(): void {
    const input = this.input, p = this.player, o = this.options;
    if (this.gui.screen) { p.applyInput(0, 0, false, false, false, false, false); if (p.usingItem) p.stopUsing(); input.consumeTick(); return; }
    void o;
    let fwd = 0, strafe = 0;
    if (input.isDown('forward')) fwd += 1; if (input.isDown('back')) fwd -= 1;
    if (input.isDown('left')) strafe += 1; if (input.isDown('right')) strafe -= 1;
    const flyToggle = input.wasDoubleTapped('jump') && (p.isCreative || p.isSpectator);
    p.applyInput(fwd, strafe, input.isDown('jump'), input.isDown('sneak'), input.isDown('sprint'), input.wasDoubleTapped('forward') && fwd > 0, flyToggle);
    // hotbar
    if (input.tickWheel) { p.selectedSlot = ((p.selectedSlot + input.tickWheel) % 9 + 9) % 9; this.gui.onHeldItemChanged(); }
    for (let i = 1; i <= 9; i++) if (input.wasPressed('hotbar' + i)) { p.selectedSlot = i - 1; this.gui.onHeldItemChanged(); }
    if (input.wasPressed('drop')) p.dropHeld(input.keys.has('ControlLeft') || input.keys.has('MetaLeft'));
    if (input.wasPressed('swapHands')) { const a = p.inventory.get(p.selectedSlot), b = p.offhand.get(0); p.inventory.set(p.selectedSlot, b); p.offhand.set(0, a); }
    if (input.wasPressed('pickBlock')) this.pickBlock();
    // attack / break
    const attackDown = input.isDown('attack');
    if (attackDown && input.pointerLocked) {
      if (this.targetEntity && (input.wasPressed('attack') || p.isCreative && false)) { if (input.wasPressed('attack')) { p.attack(this.targetEntity); p.stopBreaking(); } }
      else if (!this.targetEntity) p.continueBreaking(this.targetBlock);
      else p.stopBreaking();
      if (input.wasPressed('attack') && !this.targetBlock && !this.targetEntity) p.swing();
    } else p.stopBreaking();
    // use
    const useDown = input.isDown('use');
    if (input.wasPressed('use') || (useDown && p.useCooldown === 0 && !p.usingItem && input.pointerLocked)) {
      if (input.pointerLocked) {
        if (this.targetEntity && (this.targetEntity as any).interact && input.wasPressed('use')) { if ((this.targetEntity as Mob).interact(p, p.heldItem())) { p.swing(); p.useCooldown = 4; } else p.use(this.targetBlock); }
        else p.use(this.targetBlock);
      }
    }
    if (!useDown && p.usingItem) p.stopUsing();
    input.consumeTick();
  }

  private pickBlock(): void {
    const p = this.player;
    let stack: ItemStack | null = null;
    if (this.targetEntity) { const eggName = this.targetEntity.type + '_spawn_egg'; const it = this.items.get(eggName); if (it && p.isCreative) stack = new ItemStack(it, 1); }
    else if (this.targetBlock) { const s = this.world.getBlock(this.targetBlock.x, this.targetBlock.y, this.targetBlock.z); const it = this.items.itemForBlock(this.registry.nameOf(s)); if (it) stack = new ItemStack(it, 1); }
    if (!stack) return;
    const existing = p.inventory.findSlot((s) => s.item === stack!.item);
    if (existing >= 0 && existing < 9) { p.selectedSlot = existing; }
    else if (existing >= 9) { const a = p.inventory.get(existing); p.inventory.set(existing, p.inventory.get(p.selectedSlot)); p.inventory.set(p.selectedSlot, a); }
    else if (p.isCreative) { const cur = p.inventory.get(p.selectedSlot); if (cur) { const empty = p.inventory.findSlot(() => false, 0, 9); void empty; for (let i = 0; i < 9; i++) if (!p.inventory.get(i)) { p.selectedSlot = i; break; } } p.inventory.set(p.selectedSlot, stack); }
    this.gui.onHeldItemChanged();
  }

  private updateTargets(): void {
    const p = this.player;
    this.targetBlock = p.raycast();
    this.targetEntity = null;
    const d = lookDir(p.yaw, p.pitch);
    const reach = p.isCreative ? 5 : 3;
    let best = this.targetBlock ? this.targetBlock.t : reach;
    for (const e of this.entities) {
      if (!(e instanceof LivingEntity) || e.removed || e.health <= 0) continue;
      const r = e.bb.clone().grow(0.1, 0.1, 0.1).rayIntersect(p.x, p.eyeY, p.z, d[0], d[1], d[2]);
      if (r && r[0] < best && r[0] <= reach) { best = r[0]; this.targetEntity = e; }
    }
  }

  // ---------- rendering ----------
  private renderWorld(timeSec: number, dt: number): void {
    const p = this.player, w = this.world, r = this.renderer;
    const partial = this.partial;
    const cam = r.camera;
    const ex = p.prevX + (p.x - p.prevX) * partial, ey = p.prevY + (p.y - p.prevY) * partial + (p.prevCameraEye + (p.cameraEye - p.prevCameraEye) * partial), ez = p.prevZ + (p.z - p.prevZ) * partial;
    cam.yaw = p.yaw; cam.pitch = p.pitch;
    // fov: sprint & bow
    const targetFov = (p.isSprinting && !p.usingItem ? 1.1 : 1) * (p.usingItem?.item.name === 'bow' ? 1 - Math.min(1, p.itemUseTicks / 20) * 0.15 : 1) * (p.flying && p.isSprinting ? 1.1 : 1) * (this.gui.spyglass ? 0.1 : 1);
    this.sprintFov += (targetFov - this.sprintFov) * 0.5;
    cam.fov = this.options.fov * this.sprintFov;
    // view bobbing (vanilla GameRenderer.bobView): walkDist-driven, bob <= 0.1
    r.cameraRoll = 0; r.cameraPitchOffset = 0; r.cameraShift[0] = 0; r.cameraShift[1] = 0;
    cam.x = ex; cam.y = ey; cam.z = ez;
    if (this.options.viewBobbing && this.gui.thirdPerson === 0) {
      const f = -(p.prevWalkDist + (p.walkDist - p.prevWalkDist) * partial);
      const bob = p.prevBob + (p.bob - p.prevBob) * partial;
      // the scene is shifted in view space, then rolled and pitched (vanilla order)
      r.cameraShift[0] = Math.sin(f * Math.PI) * bob * 0.5; r.cameraShift[1] = -Math.abs(Math.cos(f * Math.PI) * bob);
      r.cameraRoll = Math.sin(f * Math.PI) * bob * 3;
      r.cameraPitchOffset = Math.abs(Math.cos(f * Math.PI - 0.2) * bob) * 5;
    }
    // hurt tilt
    if (p.hurtTime > 0) r.cameraRoll += Math.sin((p.hurtTime - partial) / p.hurtDuration * Math.PI) * 14 * 0.3;
    // third person camera
    if (this.gui.thirdPerson > 0) {
      const dir = lookDir(p.yaw, p.pitch);
      const sign = this.gui.thirdPerson === 1 ? -1 : 1;
      const hit = this.raycastBlocks(ex, ey, ez, dir[0] * sign, dir[1] * sign, dir[2] * sign, 4, false);
      const dist = hit ? Math.max(0.2, hit.t - 0.3) : 4;
      cam.x = ex + dir[0] * sign * dist; cam.y = ey + dir[1] * sign * dist; cam.z = ez + dir[2] * sign * dist;
      if (this.gui.thirdPerson === 2) { cam.yaw = p.yaw + 180; cam.pitch = -p.pitch; }
    }
    const bx = Math.floor(cam.x), by = Math.floor(cam.y), bz = Math.floor(cam.z);
    const biome = BIOMES[w.getBiome(bx, bz)];
    const eyeBlock = w.getBlock(bx, by, bz);
    const medium = eyeBlock !== 0 && this.registry.hasWater(eyeBlock) && cam.y < by + 0.9 ? 'water' : eyeBlock !== 0 && this.registry.isLava(eyeBlock) ? 'lava' : eyeBlock !== 0 && this.registry.nameOf(eyeBlock) === 'powder_snow' ? 'powder_snow' : 'air';
    const wc = this.biomeColors; const wo = w.getBiome(bx, bz) * 12;
    const waterColor = (wc[wo + 6] << 16) | (wc[wo + 7] << 8) | wc[wo + 8];
    let sky = computeSky(w.dayTime, w.dimension, skyColorFor(biome), biome.fogColor, r.viewDistance, this.weather.rainLevel, this.weather.thunderLevel, cam.y, medium as any, waterColor);
    if (p.hasEffect('blindness')) { sky.fogStart = 0; sky.fogEnd = 5; }
    if (this.weather.flash > 0) { sky.skyColor = [1, 1, 1]; sky.fogColor = sky.fogColor.map((v) => Math.min(1, v + 0.5)) as any; }
    // darkness in caves: vanilla sky light drives lightmap
    const nightVision = p.hasEffect('night_vision') ? (p.effects.find((e) => e.id === 'night_vision')!.duration > 200 ? 1 : (Math.sin(p.age * 0.3) * 0.5 + 0.5)) : 0;
    r.updateLightmap(sky.dayFactor + (this.weather.flash > 0 ? 1 : 0), this.options.gamma, w.dimension, nightVision, medium === 'water' ? 1 - p.armor.get(0)!?.enchantLevel?.('respiration') * 0 : 0);
    r.beginFrame(sky, w.dimension, timeSec);
    r.drawChunks(sky);
    // entities
    this.entityRenderer.drawAll(this.entities, p, sky, partial, this.gui.thirdPerson === 0);
    // block outline & cracks
    if (this.targetBlock && !p.isSpectator && !this.gui.hideHud) this.drawBlockOutline(sky);
    // lightning
    for (const b of this.lightningBolts) this.drawLightning(b);
    // particles
    this.particles.draw(sky, partial);
    // translucent last
    r.drawTranslucent(sky);
    this.weather.draw(sky, partial, timeSec);
    if (w.dimension === 'overworld') r.drawClouds(sky, timeSec, 192);
    // first-person hand
    if (this.gui.thirdPerson === 0 && !p.isSpectator && !p.sleeping && !this.gui.spyglass) {
      const sp = p.swingAnim(partial);
      this.entityRenderer.drawFirstPerson(p, sky, partial, sp, this.equipProgress);
    }
    void dt;
  }

  private drawBlockOutline(sky: SkyState): void {
    const t = this.targetBlock!;
    const s = this.world.getBlock(t.x, t.y, t.z);
    if (s === 0) return;
    let boxes = this.registry.collisionBoxes(s);
    if (this.registry.isFluid(s)) return;
    if (boxes.length === 0) boxes = this.outlineBoxes(s);
    for (const b of boxes) this.renderer.drawBoxOutline(t.x + b[0] - 0.002, t.y + b[1] - 0.002, t.z + b[2] - 0.002, t.x + b[3] + 0.002, t.y + b[4] + 0.002, t.z + b[5] + 0.002, [0, 0, 0, 0.4]);
    // cracks
    const stage = this.player.breakStage;
    if (stage >= 0 && this.player.breaking && this.player.breaking.x === t.x && this.player.breaking.y === t.y && this.player.breaking.z === t.z) {
      const models = this.baker.modelsAt(s, t.x, t.y, t.z);
      const tile = this.baker.tileUv.get(`block/destroy_stage_${stage}`);
      if (!tile) return;
      let quads = 0; for (const m of models) quads += m.quads.length;
      const buf = new ArrayBuffer(quads * 4 * VERTEX_STRIDE);
      const f32 = new Float32Array(buf), u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
      let vi = 0;
      const cam = { x: this.renderer.camBase[0], y: this.renderer.camBase[1], z: this.renderer.camBase[2] };
      for (const m of models) for (const q of m.quads) {
        // map crack texture onto the quad using each vertex's projected 2D position
        for (let v = 0; v < 4; v++) {
          const px = q.pos[v * 3], py = q.pos[v * 3 + 1], pz = q.pos[v * 3 + 2];
          const ax = q.face >> 1 === 0 ? px : q.face >> 1 === 1 ? px : pz, ay = q.face >> 1 === 0 ? pz : py;
          const o = vi * VERTEX_STRIDE;
          const n = [q.nx, q.ny, q.nz];
          f32[o >> 2] = t.x + px + n[0] * 0.003 - cam.x; f32[(o >> 2) + 1] = t.y + py + n[1] * 0.003 - cam.y; f32[(o >> 2) + 2] = t.z + pz + n[2] * 0.003 - cam.z;
          u16[(o + 12) >> 1] = (tile.u0 + (tile.u1 - tile.u0) * Math.max(0, Math.min(1, ax))) * 65535; u16[(o + 14) >> 1] = (tile.v0 + (tile.v1 - tile.v0) * Math.max(0, Math.min(1, 1 - ay))) * 65535;
          u8[o + 16] = 255; u8[o + 17] = 255; u8[o + 18] = 255; u8[o + 19] = 0xff;
          vi++;
        }
      }
      const gl = this.renderer.gl;
      gl.enable(gl.BLEND); gl.blendFunc(gl.DST_COLOR, gl.SRC_COLOR);
      this.renderer.drawChunkFormatBuffer(buf, quads, mat4Identity(new Float32Array(16)), sky, { light: 0xff, alphaCut: 0.01, blend: true, noCull: true });
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.BLEND);
    }
  }

  private drawLightning(b: { x: number; y: number; z: number; life: number }): void {
    const pts: number[] = [];
    let x = b.x + 0.5, z = b.z + 0.5, y = b.y;
    const cb = this.renderer.camBase;
    for (let i = 0; i < 12; i++) { const nx = x + (Math.random() - 0.5) * 2, nz = z + (Math.random() - 0.5) * 2, ny = y + 8; pts.push(x - cb[0], y - cb[1], z - cb[2], nx - cb[0], ny - cb[1], nz - cb[2]); x = nx; z = nz; y = ny; }
    this.renderer.drawLines(new Float32Array(pts), [0.7, 0.7, 1, 0.9], 3);
  }

  // ---------- title panorama ----------
  private async loadPanorama(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      try { const r = await fetch(`./assets/pack/assets/minecraft/textures/gui/title/background/panorama_${i}.png`); const bmp = await createImageBitmap(await r.blob()); this.panoramaTex[i] = createTexture(this.renderer.gl, bmp, { nearest: false }); } catch { this.panoramaTex[i] = null; }
    }
  }
  private renderPanorama(timeSec: number): void {
    const r = this.renderer, gl = r.gl;
    r.resize();
    gl.clearColor(0.1, 0.1, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.panoramaTex[0]) return;
    const cam = r.camera; cam.fov = 85; cam.pitch = -5 + Math.sin(timeSec * 0.1) * 3; cam.yaw = (timeSec * 3) % 360; cam.x = cam.y = cam.z = 0;
    r.updateMatrices();
    gl.disable(gl.DEPTH_TEST);
    r.quadProg.use();
    gl.uniformMatrix4fv(r.quadProg.u('uVP'), false, r.vp);
    gl.uniform4f(r.quadProg.u('uColor'), 1, 1, 1, 1);
    gl.activeTexture(gl.TEXTURE0); gl.uniform1i(r.quadProg.u('uTex'), 0);
    // cube faces: 0 front(-z? ), 1 right, 2 back, 3 left, 4 top, 5 bottom (vanilla panorama order: front(south?), ...)
    const m = new Float32Array(16);
    const faces: [number, number, number, number][] = [[0, 0, 0, 0], [1, 0, 90, 0], [2, 0, 180, 0], [3, 0, 270, 0], [4, -90, 0, 0], [5, 90, 0, 0]];
    gl.bindVertexArray((r as any).quadVao);
    for (const [i, rx, ry] of faces) {
      const tex = this.panoramaTex[i]; if (!tex) continue;
      mat4Identity(m); mat4RotateY(m, m, ry * DEG); mat4RotateX(m, m, rx * DEG); mat4Translate(m, m, 0, 0, -1); mat4Scale(m, m, -1, 1, 1);
      gl.uniformMatrix4fv(r.quadProg.u('uModel'), false, m);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    }
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    void mat4Mul;
  }
}

const ORE_XP: Record<string, [number, number]> = { coal_ore: [0, 2], diamond_ore: [3, 7], emerald_ore: [3, 7], lapis_ore: [2, 5], nether_quartz_ore: [2, 5], redstone_ore: [1, 5], nether_gold_ore: [0, 1], sculk: [1, 1], sculk_sensor: [5, 5], sculk_catalyst: [5, 5], sculk_shrieker: [5, 5] };

class LoadingScreen extends TitleScreen {
  constructor(private msg: string) { super(); }
  build(): void {}
  render(ctx: CanvasRenderingContext2D): void { this.gui.drawTiled(ctx, 'gui/menu_background', 0, 0, this.width, this.height, 32); this.gui.font.drawCentered(ctx, this.msg, this.width / 2, this.height / 2 - 4, 0xffffff); }
}
