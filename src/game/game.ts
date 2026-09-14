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
import { mergeOptions, type Options } from './options';
import { Weather } from './weather';
import { NetHost, type HostOptions } from '../net/host';
import { NetClient } from '../net/client';
import { decodeChunk, unpackFrame } from '../net/protocol';
import { RemotePlayer } from '../entity/remotePlayer';
import { BoatEntity } from '../entity/boat';
import { EnderDragonEntity, WitherEntity, EndCrystalEntity, AreaEffectCloud } from '../entity/boss';
import { Spawner } from './spawning';
import { runCommand, completeCommand, suggestCommand, COMMAND_USAGE } from './commands';
import { MIN_Y, MAX_Y, SEA_LEVEL, SECTION_COUNT, type Chunk } from '../world/chunk';
import { VERTEX_STRIDE } from '../render/mesher';
import { createTexture } from '../render/gl';
import { TitleScreen } from './gui/screens';
import { DisconnectedScreen } from './gui/multiplayer';
import { facingOffset } from '../blocks/placement';


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
  options: Options = mergeOptions(null);
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
  /** multiplayer */
  host: NetHost | null = null;
  client: NetClient | null = null;
  /** saved state of guests that visited this world (by name) */
  playerData = new Map<string, any>();
  get isRemote(): boolean { return this.client !== null; }
  allPlayers(): Player[] { const out: Player[] = []; if (this.player && !this.player.removed) out.push(this.player); for (const e of this.entities) if (e instanceof RemotePlayer && !e.removed) out.push(e); return out; }
  nearestPlayer(x: number, y: number, z: number): Player | null { let best: Player | null = null, bd = Infinity; for (const p of this.allPlayers()) { const d = p.distSq(x, y, z); if (d < bd) { bd = d; best = p; } } return best; }
  biomeColors!: Uint8Array;
  // loop
  private lastTime = 0; private tickAcc = 0; private running = false;
  targetBlock: BlockHit | null = null;
  targetEntity: (LivingEntity | BoatEntity) | null = null;
  private partial = 0;
  private swingT = 0; private equipProgress = 0; private lastHeldName = '';
  private cameraTilt = 0;
  private sprintFov = 0;
  private sneakToggled = false; private sprintToggled = false;
  private lastFrameTime = 0;
  private saveTimer = 0;
  private panoramaTex: (WebGLTexture | null)[] = [];
  private panoramaAngle = 0;
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
    this.options = mergeOptions(saved);
    if (saved?.bindings) for (const [k, v] of Object.entries(saved.bindings)) this.input.bindings.set(k, v);
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
    // Background tabs throttle requestAnimationFrame/timers; a worker timer keeps the simulation (and a hosted
    // multiplayer world) ticking at 20 TPS while the tab is hidden. Rendering is skipped until it is visible again.
    try {
      const w = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 50)'], { type: 'text/javascript' })));
      w.onmessage = () => { if (document.hidden && this.inWorld && this.running) this.backgroundTick(); };
    } catch { /* no worker support */ }
  }
  private backgroundTick(): void {
    try {
      this.input.discardTick();
      if (!this.paused) this.tick();
      this.lastTime = performance.now(); this.tickAcc = 0;
    } catch (e) { console.error(e); }
  }

  saveOptions(): void {
    const bindings: Record<string, string> = {};
    for (const [k, v] of this.input.bindings) bindings[k] = v;
    storage.saveOptions({ ...this.options, bindings }).catch(() => {});
    this.applyOptions();
  }
  applyOptions(): void {
    const o = this.options;
    if (this.chunks) { this.chunks.viewDistance = o.renderDistance; this.renderer.viewDistance = o.renderDistance; this.chunks.simulationDistance = o.simulationDistance; }
    this.renderer.cloudsEnabled = o.clouds !== 'off';
    this.renderer.fancyClouds = o.clouds === 'fancy';
    this.renderer.camera.fov = o.fov;
    this.renderer.setMipmapLevels(o.mipmapLevels);
    for (const [k, v] of Object.entries(o.volumes)) (this.sounds.volumes as any)[k] = v;
    this.sounds.applyVolumes();
    this.gui.showSubtitles = o.subtitles;
    this.input.rawInput = o.rawInput;
    if (o.fullscreen !== !!document.fullscreenElement) { if (o.fullscreen) document.documentElement.requestFullscreen?.().catch(() => {}); else if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
    // mesh-affecting options need the chunks rebuilt
    const meshKey = `${o.smoothLighting}|${o.graphics}|${o.biomeBlend}`;
    if (this.chunks && meshKey !== this.meshOptionsKey) { this.meshOptionsKey = meshKey; this.chunks.setMeshOptions({ smoothLighting: o.smoothLighting, fancy: o.graphics !== 'fast', biomeBlend: o.biomeBlend }); }
  }
  private meshOptionsKey = '';

  // ---------- world lifecycle ----------
  async loadWorld(meta: WorldMeta): Promise<void> {
    this.worldMeta = meta;
    this.gui.open(new LoadingScreen('Loading world…'));
    this.difficulty = meta.difficulty; this.cheats = meta.cheats || meta.gameMode === 'creative';
    const state = await storage.loadState<any>(meta.id, 'world').catch(() => undefined);
    if (state?.rules) Object.assign(this.rules, state.rules);
    if (state?.worldSpawn) this.worldSpawn = state.worldSpawn;
    this.playerData = new Map(Object.entries(state?.playerData ?? {}));
    this.dragonKills = state?.dragonKills ?? 0;
    const dim: Dimension = state?.player?.dimension ?? 'overworld';
    await this.setupDimension(dim, meta.seed, state?.time?.[dim]);
    this.player = new Player();
    this.player.world = this.world; this.player.game = this;
    this.player.name = this.options.playerName || 'Player';
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
    this.chunks = new ChunkManager(this.world, this.assets, this.renderer, this.worldMeta!.id, this.biomeColors, this.client);
    this.chunks.viewDistance = this.options.renderDistance; this.renderer.viewDistance = this.options.renderDistance;
    this.chunks.onChunkLoaded = (c) => { this.blockEntities.loadChunk(c); if ((c as any).fresh) this.spawner.populateChunk(c); };
    this.chunks.onChunkUnloaded = (c) => { this.blockEntities.unloadChunk(c); this.unloadEntitiesIn(c); this.host?.onChunkUnloaded(c); };
    if (this.client) this.chunks.simulationDistance = 0;
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
    if (!this.inWorld || !this.worldMeta || this.isRemote) return;
    this.blockEntities.flushAll();
    this.chunks.saveAll();
    const entities: Record<string, any[]> = {};
    for (const [d, v] of this.otherDims) entities[d] = v.entities;
    entities[this.world.dimension] = this.entities.filter((e) => !e.removed && !(e instanceof ExperienceOrb) && !(e instanceof RemotePlayer)).map((e) => e.serialize());
    const time: Record<string, any> = {};
    for (const [d, v] of this.otherDims) time[d] = { time: v.time, dayTime: this.world.dayTime };
    time[this.world.dimension] = { time: this.world.time, dayTime: this.world.dayTime };
    this.host?.saveAllPlayers();
    storage.saveState(this.worldMeta.id, 'world', { player: this.player.serialize(), weather: this.weather.serialize(), entities, time, rules: this.rules, worldSpawn: this.worldSpawn, playerData: Object.fromEntries(this.playerData), dragonKills: this.dragonKills }).catch(console.error);
    this.worldMeta.lastPlayed = Date.now();
    storage.saveWorldMeta(this.worldMeta).catch(() => {});
  }

  quitToTitle(): void {
    this.saveAll();
    if (this.host) { this.host.stop(); this.host = null; }
    if (this.client) { this.client.send({ t: 'move', x: this.player.x, y: this.player.y, z: this.player.z, yaw: this.player.yaw, pitch: this.player.pitch, saved: this.player.serialize() }); this.client.close(); this.client = null; }
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
    if (this.isRemote) { this.gui.showActionBar('Dimension travel is not available while playing on a server'); p.portalCooldown = 100; return; }
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
    if (target === 'the_end') {
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) { this.world.setBlock(100 + dx, 48, dz, this.registry.defaultState('obsidian'), 0); for (let dy = 49; dy < 52; dy++) this.world.setBlock(100 + dx, dy, dz, 0, 0); } p.setPos(100.5, 49, 0.5);
      // the dragon (and its crystals) await on the first visit
      if (this.dragonKills === 0 && !this.entities.some((e) => e instanceof EnderDragonEntity)) { const d = this.spawnMob('ender_dragon', 0, 90, 0); if (d) { d.yaw = 0; } }
    }
    this.gui.close();
    this.sounds.playAt('block.portal.travel', p.x, p.y, p.z, 0.5, 1);
    p.portalCooldown = 300;
    this.host?.onDimensionChanged();
  }

  /** vanilla PortalForcer: reuse a portal within 16 blocks, else search for a spot with ground and headroom for a
   *  4x5 frame (radius 16); if nothing fits, force one at the target on a small obsidian platform. */
  private placePortalNear(x: number, z: number, dim: Dimension): void {
    const reg = this.registry, w = this.world, p = this.player;
    const yMin = dim === 'the_nether' ? 5 : MIN_Y + 5, yMax = dim === 'the_nether' ? 122 : Math.min(MAX_Y - 10, 250);
    // 1. existing portal within 16 blocks: enter at its lowest block
    let best: [number, number, number] | null = null, bd = Infinity;
    for (let dx = -16; dx <= 16; dx++) for (let dz = -16; dz <= 16; dz++) for (let y = yMin; y < yMax; y++) {
      const s = w.getBlock(x + dx, y, z + dz);
      if (!s || reg.nameOf(s) !== 'nether_portal') continue;
      const d = dx * dx + dz * dz + (y - p.y) * (y - p.y) * 0.1;
      if (d < bd) { bd = d; best = [x + dx, y, z + dz]; }
      break;
    }
    if (best) { p.setPos(best[0] + 0.5, best[1], best[2] + 0.5); return; }
    const solid = (bx: number, by: number, bz: number) => { const s = w.getBlock(bx, by, bz); return s !== 0 && reg.fullCube[s] && !reg.isFluid(s); };
    const empty = (bx: number, by: number, bz: number) => { const s = w.getBlock(bx, by, bz); return s === 0 || (!reg.fullCube[s] && !reg.isFluid(s) && reg.block(s).hardness >= 0); };
    // 2. search: frame along axis a needs 4 (along) x 5 (tall) x 1 with 1 block of air on each side and ground under
    const axes: ('x' | 'z')[] = ['x', 'z'];
    let found: { x: number; y: number; z: number; axis: 'x' | 'z' } | null = null; let fd = Infinity;
    for (let dx = -16; dx <= 16 && !found; dx++) for (let dz = -16; dz <= 16; dz++) {
      const bx = x + dx, bz = z + dz;
      if (!w.isLoaded(bx, bz)) continue;
      for (let y = Math.min(yMax, w.getHeight(bx, bz) + 1); y > yMin; y--) {
        if (!solid(bx, y - 1, bz) || !empty(bx, y, bz)) continue;
        for (const axis of axes) {
          const ax = axis === 'x' ? 1 : 0, az = axis === 'x' ? 0 : 1;
          let ok = true;
          for (let i = -1; i < 3 && ok; i++) for (let j = -1; j < 4 && ok; j++) for (let k = -1; k <= 1 && ok; k++) {
            const px = bx + i * ax + k * az, py = y + j, pz = bz + i * az + k * ax;
            if (j === -1) { if (k === 0 && i >= 0 && i < 2 && !solid(px, py, pz)) ok = false; }
            else if (!empty(px, py, pz)) ok = false;
          }
          if (!ok) continue;
          const d = dx * dx + dz * dz + (y - p.y) * (y - p.y) * 0.25;
          if (d < fd) { fd = d; found = { x: bx, y, z: bz, axis }; }
        }
        break;
      }
    }
    const obs = reg.defaultState('obsidian');
    let fx = x, fy: number, fz = z, axis: 'x' | 'z' = 'x';
    if (found) { fx = found.x; fy = found.y; fz = found.z; axis = found.axis; }
    else {
      // 3. forced: clamp height, build a 3x2 obsidian platform with air above it
      fy = dim === 'the_nether' ? Math.max(yMin + 1, Math.min(yMax - 6, 70)) : Math.max(yMin + 1, Math.min(yMax - 6, w.getHeight(x, z)));
      const ax = 1, az = 0;
      for (let i = -1; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = -1; k < 3; k++) w.setBlock(fx + j * ax + i * az, fy + k, fz + j * az + i * ax, k < 0 ? obs : 0, 0);
    }
    const ax = axis === 'x' ? 1 : 0, az = axis === 'x' ? 0 : 1;
    const portal = reg.stateWith(reg.blockByName('nether_portal')!, { axis });
    for (let i = -1; i < 3; i++) for (let j = -1; j < 4; j++) {
      const edge = i === -1 || i === 2 || j === -1 || j === 3;
      w.setBlock(fx + i * ax, fy + j, fz + i * az, edge ? obs : portal, 0);
    }
    p.setPos(fx + 0.5 + ax * 0.5, fy, fz + 0.5 + az * 0.5);
    p.portalCooldown = 300;
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
  addEntity(e: Entity): void {
    e.world = this.world; e.game = this; e.updateBB();
    if (this.client && !e.remote && !(e instanceof RemotePlayer)) { this.forwardSpawn(e); return; }
    this.entities.push(e);
  }
  /** Guest-created entities (drops, projectiles, spawn eggs) are created by the host instead. */
  private forwardSpawn(e: Entity): void {
    const c = this.client!;
    if (e instanceof ItemEntity) c.send({ t: 'drop', stack: e.stack.serialize(), x: e.x, y: e.y, z: e.z, dir: [e.vx, e.vy, e.vz] });
    else if (e instanceof BoatEntity) c.send({ t: 'spawn', kind: 'boat', x: e.x, y: e.y, z: e.z, v: [0, 0, 0], yaw: e.yaw, extra: { wood: e.wood, chest: e.chest } });
    else if (e instanceof ArrowEntity || e instanceof ThrownProjectile || e instanceof Mob) c.send({ t: 'spawn', e: e.serialize(), x: e.x, y: e.y, z: e.z, v: [e.vx, e.vy, e.vz], kind: e instanceof ArrowEntity ? 'arrow' : e instanceof ThrownProjectile ? 'thrown' : 'mob', extra: e instanceof ArrowEntity ? { damage: e.damage, akind: e.kind, trident: (e as any).trident?.serialize?.(), effect: (e as any).effect } : e instanceof ThrownProjectile ? { tkind: e.kind, stack: e.stack?.serialize() ?? null } : { type: e.type, baby: (e as Mob).isBaby } });
  }
  /** number of dragon kills in this world (first kill drops far more XP and opens the gateway) */
  dragonKills = 0;
  onDragonKilled(d: Mob): void {
    this.dragonKills++;
    const reg = this.registry, w = this.world;
    // the exit portal lights up and the dragon egg appears on the bedrock pillar
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (dx * dx + dz * dz <= 6) w.setBlock(dx, 61, dz, reg.defaultState('end_portal'), 0);
    if (this.dragonKills === 1) w.setBlock(0, 66, 0, reg.defaultState('dragon_egg'), 0);
    for (const e of this.entities) if (e instanceof EndCrystalEntity) e.remove();
    this.gui.addChat('§dThe End is free once more.');
    void d;
  }
  spawnMob(name: string, x: number, y: number, z: number, baby = false): Mob | null {
    const def = MOB_DEFS[name];
    if (!def) return null;
    const m = name === 'ender_dragon' ? new EnderDragonEntity() : name === 'wither' ? new WitherEntity() : new Mob(def);
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
        if (d.type === 'ender_dragon') e = new EnderDragonEntity();
        else if (d.type === 'wither') e = new WitherEntity();
        else if (d.type === 'end_crystal') e = new EndCrystalEntity();
        else if (MOB_DEFS[d.type]) e = new Mob(MOB_DEFS[d.type]);
        else if (d.type === 'item') { const s = ItemStack.deserialize(d.stack, this.items); if (s) e = new ItemEntity(s); }
        else if (d.type === 'falling_block') e = new FallingBlockEntity(d.blockState);
        else if (d.type === 'tnt') e = new PrimedTnt(d.fuse);
        else if (d.type === 'boat') e = new BoatEntity(d.wood, !!d.chest);
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
    this.client?.send({ t: 'respawn' });
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
  project(x: number, y: number, z: number): [number, number, number] | null {
    const cb = this.renderer.camBase;
    const v = [0, 0, 0] as [number, number, number];
    const m = this.renderer.vp;
    const px = x - cb[0], py = y - cb[1], pz = z - cb[2];
    const cw = m[3] * px + m[7] * py + m[11] * pz + m[15];
    if (cw <= 0) return null;
    transformPoint(v, m, px, py, pz);
    return [(v[0] / cw * 0.5 + 0.5) * this.canvas.width, (1 - (v[1] / cw * 0.5 + 0.5)) * this.canvas.height, cw];
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
    if (this.client && player === this.player) {
      // guest: predict locally (no drops), the host breaks it for real and broadcasts the change
      if (!silentPlayer) { this.sounds.playAt(`block.${b.soundType}.break`, x + 0.5, y + 0.5, z + 0.5, 1, 0.8); this.particles.spawnBlockBreak(x, y, z, s); }
      this.client.applying = true; try { w.setBlock(x, y, z, reg.isWaterlogged(s) && !reg.implicitWater[reg.stateBlock[s]] ? reg.WATER : 0, SET_UPDATE_NEIGHBORS); } finally { this.client.applying = false; }
      this.client.send({ t: 'break', x, y, z });
      const tool = player.heldItem();
      if (tool && !player.isCreative && tool.item.tool !== 'none' && b.hardness > 0) player.damageHeld(tool, tool.item.tool === 'sword' ? 2 : 1);
      return;
    }
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
  handleChat(text: string): void {
    if (this.client) { this.client.send({ t: 'chat', text }); if (!text.startsWith('/')) this.gui.addChat(`<${this.player.name}> ${text}`); return; }
    if (text.startsWith('/')) runCommand(this, text);
    else { const line = `<${this.player.name}> ${text}`; this.gui.addChat(line); this.host?.broadcast({ t: 'chat', text: line }); }
  }
  completeCommand(text: string): string | null { return completeCommand(this, text); }
  commandSuggestions(text: string): string[] { return suggestCommand(this, text); }
  commandUsage(text: string): string | null { const name = text.slice(1).split(' ')[0]; return COMMAND_USAGE[name] ?? null; }
  setDifficulty(d: number): void { this.difficulty = d; if (this.worldMeta) { this.worldMeta.difficulty = d; storage.saveWorldMeta(this.worldMeta).catch(() => {}); } if (d === 0) for (const e of this.entities) if (e instanceof Mob && e.hostile) e.remove(); }
  /** Menus pause singleplayer only; a world open to LAN (or a server we joined) keeps running like vanilla. */
  onScreenChanged(): void { this.paused = !!this.gui.screen && this.gui.screen.pausesGame && !this.host && !this.client; }

  // ---------- main loop ----------
  private frame(t: number): void {
    if (!this.running) return;
    // Max Framerate option: skip frames that come too early
    const maxFps = this.options.maxFps;
    if (maxFps > 0 && maxFps < 260 && t - this.lastFrameTime < 1000 / maxFps - 1) { requestAnimationFrame((tt) => this.frame(tt)); return; }
    this.lastFrameTime = t;
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
      p.yaw += input.mouseDx * f; p.pitch = Math.max(-90, Math.min(90, p.pitch + input.mouseDy * f * (this.options.invertMouse ? -1 : 1)));
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
    if (this.client) { this.tickRemote(); return; }
    // time
    w.time++;
    if (this.rules.doDaylightCycle !== false && w.dimension === 'overworld') w.dayTime++;
    // player input
    this.updatePlayerInput();
    // chunks stream
    if (this.host) this.chunks.extraCenters = this.host.extraCenters();
    this.chunks.update(p.x, p.z, 0.05);
    // sleeping skips night
    if (p.sleeping && p.sleepTimer >= 100 && (!this.host || this.host.allSleeping())) { w.dayTime = Math.floor(w.dayTime / 24000) * 24000 + 24000; this.weather.raining = false; this.weather.thundering = false; p.wakeUp(); this.gui.sleepFade = 0; this.host?.broadcast({ t: 'wake' }); }
    // scheduled ticks
    for (const t of w.popDueTicks()) if (w.isLoaded(t.x, t.z)) this.blocks.scheduledTick(t.x, t.y, t.z, t.state);
    // random ticks
    this.randomTicks();
    // entities (only within the simulation distance)
    const simD = this.chunks.simulationDistance, pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
    for (const e of this.entities) {
      if (e.removed) continue;
      if (!w.isLoaded(Math.floor(e.x), Math.floor(e.z))) continue;
      if (!(e instanceof RemotePlayer) && !this.host && (Math.abs((Math.floor(e.x) >> 4) - pcx) > simD || Math.abs((Math.floor(e.z) >> 4) - pcz) > simD)) continue;
      e.tick();
    }
    if (this.entities.some((e) => e.removed)) this.entities = this.entities.filter((e) => !e.removed);
    // player
    p.tick();
    if (p.health <= 0 && !this.gui.isOpen) this.gui.openDeath();
    this.host?.tick();
    if (this.host && this.host.status === 'closed') { this.gui.addChat('§cLost connection to the relay: the world is no longer open to other players'); this.host = null; }
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

  /** Guest tick: our player runs locally, the host drives everything else. */
  private tickRemote(): void {
    const p = this.player, w = this.world, c = this.client!;
    if (c.status === 'closed') {
      const reason = c.disconnectReason || 'Disconnected';
      const rehost = c.rehostId, last = this.lastServer;
      this.client = null;
      this.leaveRemoteWorld(reason);
      // public world host migration: reconnect (the first client back becomes the new host)
      if (rehost && last) setTimeout(() => { if (!this.inWorld) this.joinServer(last.relayUrl, rehost, last.password).catch((e) => this.gui.open(new DisconnectedScreen(String(e?.message ?? e)))); }, 1500 + Math.random() * 1500);
      return;
    }
    this.updatePlayerInput();
    this.chunks.update(p.x, p.z, 0.05);
    for (const e of this.entities) { if (e.removed) continue; if (e.remote) e.remoteTick(); }
    if (this.entities.some((e) => e.removed)) this.entities = this.entities.filter((e) => !e.removed);
    p.tick();
    if (p.health <= 0 && !this.gui.isOpen) this.gui.openDeath();
    c.tick();
    for (const b of this.lightningBolts) b.life--;
    this.lightningBolts = this.lightningBolts.filter((b) => b.life > 0);
    this.particles.tick();
    this.renderer.tickAnimations();
    this.sounds.updateListener(p.x, p.eyeY, p.z, p.yaw, p.pitch);
    this.sounds.setUnderwater(p.eyeInWater);
    this.sounds.tickMusic(p.isCreative ? 'creative' : p.eyeInWater ? 'under_water' : 'game', 1);
    this.updateTargets();
    const hn = p.heldItem()?.item.name ?? '';
    if (hn !== this.lastHeldName) { this.lastHeldName = hn; this.equipProgress = 1; this.gui.onHeldItemChanged(); }
    this.equipProgress = Math.max(0, this.equipProgress - 0.25);
    if (p.eyeInWater && Math.random() < 0.2) this.particles.spawnBubble(p.x + (Math.random() - 0.5), p.eyeY, p.z + (Math.random() - 0.5));
    if (p.flying) p.fallDistance = 0;
    void w;
  }

  /** Publish the current singleplayer world through a relay so others can join. */
  async openToLan(opts: HostOptions): Promise<NetHost> {
    if (this.host) this.host.stop();
    const h = new NetHost(this, opts);
    await h.start();
    this.host = h;
    this.cheats = opts.cheats || this.cheats;
    this.onScreenChanged();
    return h;
  }

  /** Join a server. Joining the backend's public world with nobody hosting promotes us to host instead. */
  async joinServer(relayUrl: string, serverId: string, password = ''): Promise<void> {
    const c = new NetClient(this, relayUrl);
    this.gui.open(new LoadingScreen('Connecting…'));
    const res = await c.connect(serverId, this.options.playerName || 'Player', this.options.skin, password);
    if (res.kind === 'host') { c.close(); await this.hostPublicWorld(relayUrl, res.world, res.chunks); return; }
    const welcome = res.welcome;
    this.gui.open(new LoadingScreen('Joining world…'));
    this.client = c;
    this.worldMeta = { id: 'remote', name: welcome.hostName + "'s world", seed: welcome.seed, created: Date.now(), lastPlayed: Date.now(), gameMode: welcome.gameMode, difficulty: welcome.difficulty, cheats: welcome.cheats, version: this.version };
    this.difficulty = welcome.difficulty; this.cheats = welcome.cheats;
    Object.assign(this.rules, welcome.rules ?? {});
    this.worldSpawn = welcome.spawn;
    await this.setupDimension(welcome.dimension, welcome.seed, { time: welcome.time, dayTime: welcome.day });
    this.world.listeners = [c];
    this.player = new Player();
    this.player.world = this.world; this.player.game = this;
    this.player.name = welcome.name; this.player.cheats = welcome.cheats;
    this.player.setGameMode(welcome.gameMode);
    this.player.inventory.onChange = () => this.gui.onHeldItemChanged();
    if (welcome.saved) { try { this.player.deserialize(welcome.saved); } catch { /* fresh */ } }
    else { this.player.setPos(welcome.spawn[0] + 0.5, welcome.spawn[1], welcome.spawn[2] + 0.5); this.player.setSpawn(welcome.spawn[0], welcome.spawn[1], welcome.spawn[2], false); }
    this.weather.deserialize(welcome.weather);
    this.inWorld = true;
    this.gui.close();
    this.input.lockPointer();
    this.gui.onHeldItemChanged();
    await this.waitForChunks();
    this.sounds.stopMusic();
    this.lastServer = { relayUrl, serverId, password };
    this.gui.addChat(`§eJoined ${welcome.hostName}'s world`);
  }
  /** Relay + id + password of the server we are on, so a host migration can reconnect us. */
  lastServer: { relayUrl: string; serverId: string; password: string } | null = null;

  /** Take over hosting the backend's persistent public world from the snapshot it handed us. */
  private async hostPublicWorld(relayUrl: string, world: any, chunkFrames: Uint8Array[]): Promise<void> {
    this.gui.open(new LoadingScreen('Starting the public world…'));
    // the backend's stored chunks are the authoritative copy: write them into local storage, then load normally
    const data: any[] = [];
    for (const f of chunkFrames) {
      try {
        const { json, body } = unpackFrame(f);
        if (json.dim && json.dim !== 'overworld') continue;   // guests only ever see the overworld of the public world
        const d = decodeChunk(json, body);
        data.push({ ...d, decorated: true });
      } catch (e) { console.error('snapshot chunk', e); }
    }
    const meta: WorldMeta = { id: 'public', name: world.name ?? 'Public world', seed: world.seed, created: Date.now(), lastPlayed: Date.now(), gameMode: (world.gameMode ?? 'survival') as any, difficulty: world.difficulty ?? 2, cheats: false, version: this.version };
    await storage.saveWorldMeta(meta).catch(() => {});
    if (data.length) await storage.saveChunks('public', 'overworld', data as any).catch((e) => console.error(e));
    // world-level state from the backend (time, weather, rules, spawn, everyone's saved players)
    await storage.saveState('public', 'world', {
      player: world.playerData?.[this.options.playerName || 'Player'] ?? undefined,
      weather: world.meta?.weather, time: { overworld: { time: world.meta?.time ?? 0, dayTime: world.meta?.dayTime ?? 0 } },
      rules: world.meta?.rules, worldSpawn: world.meta?.worldSpawn, playerData: world.playerData ?? {}, dragonKills: world.meta?.dragonKills ?? 0,
    }).catch(() => {});
    await this.loadWorld(meta);
    const h = await this.openToLan({ name: world.name ?? 'Public world', motd: world.motd ?? '', gameMode: world.gameMode ?? 'survival', cheats: false, maxPlayers: world.maxPlayers ?? 16, relayUrl, official: true });
    this.lastServer = { relayUrl, serverId: 'official', password: '' };
    this.gui.addChat('§eYou are hosting the public world — it is saved on the server and passes on when you leave.');
    void h;
  }

  private leaveRemoteWorld(reason: string): void {
    this.chunks.dispose();
    this.renderer.sections.clear();
    this.entities = [];
    this.inWorld = false;
    this.particles.list = [];
    this.sounds.stopRecord(); this.sounds.setUnderwater(false); this.sounds.setRain(0);
    this.gui.open(new DisconnectedScreen(reason));
  }

  private randomTicks(): void {
    const w = this.world;
    const speed = this.rules.randomTickSpeed ?? 3;
    if (speed <= 0) return;
    const p = this.player;
    const pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
    const sim = Math.min(this.chunks.simulationDistance, this.chunks.viewDistance);
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
    // toggle sneak / sprint options (vanilla ToggleKeyMapping)
    if (this.options.toggleSneak) { if (input.wasPressed('sneak')) this.sneakToggled = !this.sneakToggled; } else this.sneakToggled = false;
    if (this.options.toggleSprint) { if (input.wasPressed('sprint')) this.sprintToggled = !this.sprintToggled; } else this.sprintToggled = false;
    p.applyInput(fwd, strafe, input.isDown('jump'), this.options.toggleSneak ? this.sneakToggled : input.isDown('sneak'), this.options.toggleSprint ? this.sprintToggled : input.isDown('sprint'), input.wasDoubleTapped('forward') && fwd > 0, flyToggle);
    // hotbar
    if (input.tickWheel) { const steps = this.options.discreteScroll ? Math.sign(input.tickWheel) : Math.round(input.tickWheel * this.options.wheelSensitivity); if (steps) { p.selectedSlot = ((p.selectedSlot + steps) % 9 + 9) % 9; this.gui.onHeldItemChanged(); } }
    for (let i = 1; i <= 9; i++) if (input.wasPressed('hotbar' + i)) { p.selectedSlot = i - 1; this.gui.onHeldItemChanged(); }
    if (input.wasPressed('drop')) p.dropHeld(input.keys.has('ControlLeft') || input.keys.has('MetaLeft'));
    if (input.wasPressed('swapHands')) { const a = p.inventory.get(p.selectedSlot), b = p.offhand.get(0); p.inventory.set(p.selectedSlot, b); p.offhand.set(0, a); }
    if (input.wasPressed('pickBlock')) this.pickBlock();
    // attack / break
    const attackDown = input.isDown('attack');
    if (attackDown && input.pointerLocked) {
      if (this.targetEntity && input.wasPressed('attack')) {
        if (this.client) { this.client.send({ t: 'attack', id: this.targetEntity.remoteId }); p.swing(); p.attackCooldownTicks = 0; p.stopBreaking(); }
        else if (this.targetEntity instanceof BoatEntity) { this.targetEntity.hurt({ amount: p.isCreative ? 100 : Math.max(1, p.heldItem()?.item.attackDamage ?? 1), source: 'attack', attacker: p }); p.swing(); p.attackCooldownTicks = 0; p.stopBreaking(); }
        else { p.attack(this.targetEntity); p.stopBreaking(); }
      }
      else if (!this.targetEntity) p.continueBreaking(this.targetBlock);
      else p.stopBreaking();
      if (input.wasPressed('attack') && !this.targetBlock && !this.targetEntity) p.swing();
    } else p.stopBreaking();
    // use
    const useDown = input.isDown('use');
    if (input.wasPressed('use') || (useDown && p.useCooldown === 0 && !p.usingItem && input.pointerLocked)) {
      if (input.pointerLocked) {
        if (this.targetEntity && (this.targetEntity as any).interact && input.wasPressed('use')) {
          if (this.client) { this.client.send({ t: 'interact', id: this.targetEntity.remoteId, held: p.heldItem()?.serialize() ?? null }); p.swing(); p.useCooldown = 4; }
          else if ((this.targetEntity as Mob | BoatEntity).interact(p, p.heldItem())) { p.swing(); p.useCooldown = 4; } else p.use(this.targetBlock);
        }
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
      if (e.removed || e === p.vehicle) continue;
      if (!(e instanceof LivingEntity || e instanceof BoatEntity)) continue;
      if (e instanceof LivingEntity && e.health <= 0) continue;
      const r = e.bb.clone().grow(0.1, 0.1, 0.1).rayIntersect(p.x, p.eyeY, p.z, d[0], d[1], d[2]);
      if (r && r[0] < best && r[0] <= reach) { best = r[0]; this.targetEntity = e as any; }
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
    // vanilla getFieldOfViewModifier: sprint/fly 1.1, bow draw, speed effects; scaled by the FOV Effects option
    let fovMod = 1;
    if ((p.isSprinting && !p.usingItem) || (p.flying && p.isSprinting)) fovMod *= 1.1;
    if (p.usingItem?.item.name === 'bow') fovMod *= 1 - Math.min(1, p.itemUseTicks / 20) ** 2 * 0.15;
    if (p.hasEffect('speed')) fovMod *= 1 + 0.1 * p.effectLevel('speed');
    if (p.hasEffect('slowness')) fovMod *= 1 - 0.1 * p.effectLevel('slowness');
    fovMod = 1 + (fovMod - 1) * this.options.fovEffects;
    if (this.gui.spyglass) fovMod = 0.1;
    this.sprintFov += (fovMod - this.sprintFov) * 0.5;
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
    // portal / nausea whirl (vanilla: confusionAnimationTick * 20 deg, 7 with the nausea effect)
    { const pt = (p.prevPortalTime + (p.portalTime - p.prevPortalTime) * partial) * this.options.screenEffects; r.nausea[0] = pt; if (pt > 0) r.nausea[1] = (w.time + partial) * (p.hasEffect('nausea') ? 7 : 20); }
    // vanilla GameRenderer.bobHurt: tilt towards the damage direction, sin(f^4 * PI) * 14 degrees; death roll
    r.hurtTilt[0] = 0; r.hurtTilt[1] = 0; r.deathRoll = 0;
    if (p.deathTime > 0) r.deathRoll = 40 - 8000 / (p.deathTime + partial + 200);
    if (p.hurtTime > 0) { let f = (p.hurtTime - partial) / p.hurtDuration; f = Math.sin(f * f * f * f * Math.PI); r.hurtTilt[0] = p.hurtDir; r.hurtTilt[1] = -f * 14 * (this.options.damageTilt ?? 1); }
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
    const dayTimeF = this.rules.doDaylightCycle !== false && !this.paused ? w.dayTime + partial : w.dayTime;
    let sky = computeSky(dayTimeF, w.dimension, skyColorFor(biome), biome.fogColor, r.viewDistance, this.weather.rainLevel, this.weather.thunderLevel, cam.y, medium as any, waterColor);
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
      // vanilla RenderType.crumbling: blend(DST_COLOR, SRC_COLOR) with the block's own light, alpha < 0.1 discarded
      const gl = this.renderer.gl;
      const nl = this.world.getLight(t.x + (t.face === 5 ? 1 : t.face === 4 ? -1 : 0), t.y + (t.face === 1 ? 1 : t.face === 0 ? -1 : 0), t.z + (t.face === 3 ? 1 : t.face === 2 ? -1 : 0));
      this.renderer.drawChunkFormatBuffer(buf, quads, mat4Identity(new Float32Array(16)), sky, { light: nl, alphaCut: 0.1, blend: true, blendFunc: [gl.DST_COLOR, gl.SRC_COLOR], noCull: true });
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
  /** Menu panorama: VoxeLand's own scene (public/panorama), falling back to the resource pack's. */
  /** Menu panorama: VoxeLand's own scene, falling back to the resource pack's if it is missing. */
  private async loadPanorama(): Promise<void> {
    const sources = [`./panorama/panorama_`, `./assets/pack/assets/minecraft/textures/gui/title/background/panorama_`];
    for (const base of sources) {
      let ok = true;
      for (let i = 0; i < 6; i++) {
        try {
          const r = await fetch(`${base}${i}.png`);
          if (!r.ok) { ok = false; break; }
          const bmp = await createImageBitmap(await r.blob());
          this.panoramaTex[i] = createTexture(this.renderer.gl, bmp, { nearest: false });
        } catch { ok = false; break; }
      }
      if (ok) return;
    }
  }
  private renderPanorama(timeSec: number): void {
    const r = this.renderer, gl = r.gl;
    r.resize();
    gl.clearColor(0.1, 0.1, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.panoramaTex[0]) return;
    const cam = r.camera; cam.fov = 85; this.panoramaAngle += (this.options.panoramaSpeed ?? 1) * 0.05; cam.pitch = -5 + Math.sin(timeSec * 0.1) * 3; cam.yaw = this.panoramaAngle % 360; cam.x = cam.y = cam.z = 0;
    r.updateMatrices();
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE); // the mirrored cube faces would otherwise be back-face culled
    r.quadProg.use();
    gl.uniformMatrix4fv(r.quadProg.u('uVP'), false, r.vp);
    gl.uniform4f(r.quadProg.u('uColor'), 1, 1, 1, 1);
    gl.activeTexture(gl.TEXTURE0); gl.uniform1i(r.quadProg.u('uTex'), 0);
    // vanilla panorama order: 0 north, 1 east, 2 south, 3 west, 4 up, 5 down
    const m = new Float32Array(16);
    const faces: [number, number, number, number][] = [[0, 0, 0, 0], [1, 0, 90, 0], [2, 0, 180, 0], [3, 0, 270, 0], [4, 90, 0, 0], [5, -90, 0, 0]];
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
    gl.enable(gl.CULL_FACE);
    void mat4Mul;
  }
}

const ORE_XP: Record<string, [number, number]> = { coal_ore: [0, 2], diamond_ore: [3, 7], emerald_ore: [3, 7], lapis_ore: [2, 5], nether_quartz_ore: [2, 5], redstone_ore: [1, 5], nether_gold_ore: [0, 1], sculk: [1, 1], sculk_sensor: [5, 5], sculk_catalyst: [5, 5], sculk_shrieker: [5, 5] };

class LoadingScreen extends TitleScreen {
  constructor(private msg: string) { super(); }
  build(): void {}
  render(ctx: CanvasRenderingContext2D): void { this.gui.drawTiled(ctx, 'gui/menu_background', 0, 0, this.width, this.height, 32); this.gui.font.drawCentered(ctx, this.msg, this.width / 2, this.height / 2 - 4, 0xffffff); }
}
