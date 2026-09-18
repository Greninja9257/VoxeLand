// Guest side of multiplayer: connects to a relay, joins a hosted world and mirrors it. The local player runs
// its own physics and inventory; everything else (blocks, mobs, items, time) comes from the host.
import type { Game } from '../game/game';
import { RemotePlayer } from '../entity/remotePlayer';
import { Entity, LivingEntity, ItemEntity, ExperienceOrb } from '../entity/entity';
import { Mob, MOB_DEFS } from '../entity/mobs';
import { BoatEntity } from '../entity/boat';
import { ArrowEntity, FallingBlockEntity, PrimedTnt, ThrownProjectile } from '../entity/misc';
import { ItemStack, Inventory } from '../items/stack';
import { SET_UPDATE_NEIGHBORS, type WorldListener } from '../world/world';
import { Chunk, chunkKey } from '../world/chunk';
import { decodeChunk, unpackFrame, FRAME_CHUNK, PROTOCOL_VERSION, defaultRelayUrl, shouldApplyInventoryState, type ServerInfo, type PlayerListEntry } from './protocol';

/** Joining either lands us in a running world or assigns us as the public world's simulation coordinator. */
export type JoinResult =
  | { kind: 'joined'; welcome: any; info: any }
  | { kind: 'coordinator'; world: any; chunks: Uint8Array[] };

/** The relay asked us to try again shortly (someone is just becoming the public world's coordinator). */
export class RetryLater extends Error { constructor(msg = 'Try again in a moment') { super(msg); } }

/** Thrown when a private server refused the password we sent (or were missing). */
export class PasswordRequired extends Error { constructor(msg = 'This server is private.') { super(msg); } }

/** Fetch the server list from a relay. */
export function listServers(relayUrl = defaultRelayUrl()): Promise<ServerInfo[]> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try { ws = new WebSocket(relayUrl); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error('timeout')); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'list' }));
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.t === 'servers') { clearTimeout(timer); ws.close(); resolve(m.servers); } };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('Could not reach ' + relayUrl)); };
  });
}

export class NetClient implements WorldListener {
  ws: WebSocket | null = null;
  clientId = 0;
  welcome: any = null;
  info: any = null;
  status = 'connecting';
  players: PlayerListEntry[] = [];
  private queue: any[] = [];
  private chunkFrames: Uint8Array[] = [];
  /** entity id (host side) -> local entity */
  entities = new Map<number, Entity>();
  applying = false;
  private ticks = 0;
  private lastHeld = '';
  private lastArmor = '';
  ping = 0;
  container: { x: number; y: number; z: number; inv: Inventory; be?: any } | null = null;
  disconnectReason = '';
  private wanted = new Set<number>();
  private requested = new Set<number>();
  private audioAttached = false;

  constructor(public game: Game, public relayUrl: string) {}

  /** Snapshot handed to this client when it is assigned live-simulation coordination. */
  private snapshotChunks: Uint8Array[] = [];
  private collectingSnapshot = false;
  /** Set when the backend asks everyone to reconnect after coordinator migration. */
  rehostId: string | null = null;

  connect(serverId: string, playerId: string, name: string, skin: string, password = ''): Promise<JoinResult> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(this.relayUrl); } catch (e) { reject(e); return; }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timer = setTimeout(() => { if (this.status === 'connecting') { reject(new Error('Timed out waiting for the host')); ws.close(); } }, 20000);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'join', id: serverId, playerId, name, skin, password, version: `${this.game.version}/${PROTOCOL_VERSION}` }));
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') { (this.collectingSnapshot ? this.snapshotChunks : this.chunkFrames).push(new Uint8Array(e.data)); return; }
        const m = JSON.parse(e.data);
        if (this.status === 'connecting') {
          if (m.t === 'error') { clearTimeout(timer); this.status = 'error'; ws.close(); reject(m.needPassword ? new PasswordRequired(m.reason) : m.retry ? new RetryLater(m.reason) : new Error(m.reason)); return; }
          // Accept the former name during rolling deploys: an old backend may still be serving a newly loaded UI.
          if (m.t === 'becomeCoordinator' || m.t === 'becomeHost') { this.collectingSnapshot = true; this.snapshotChunks = []; (this as any).pendingWorld = m.world; return; }
          if (m.t === 'worldReady') {
            const world = (this as any).pendingWorld;
            if (!world || !Number.isFinite(world.seed)) { clearTimeout(timer); this.status = 'error'; reject(new Error('The public server did not provide a valid world snapshot. Please retry.')); ws.close(); return; }
            clearTimeout(timer); this.status = 'coordinator'; resolve({ kind: 'coordinator', world, chunks: this.snapshotChunks }); return;
          }
          if (m.t === 'joined') { this.clientId = m.clientId; this.info = m.info; return; }
          if (m.t === 'welcome') { clearTimeout(timer); this.welcome = m; this.players = m.players ?? []; this.status = 'joined'; if (m.protocol !== PROTOCOL_VERSION) { this.status = 'error'; reject(new Error(`Incompatible server version (${m.version})`)); ws.close(); return; } resolve({ kind: 'joined', welcome: m, info: this.info }); return; }
          if (m.t === 'kicked' || m.t === 'rehost') { clearTimeout(timer); this.status = 'error'; reject(new Error(m.reason ?? 'Disconnected')); return; }
          return;
        }
        this.queue.push(m);
      };
      ws.onerror = () => { if (this.status === 'connecting') { clearTimeout(timer); reject(new Error('Could not reach the relay server at ' + this.relayUrl)); } this.status = 'error'; };
      ws.onclose = () => {
        if (this.status !== 'joined') return;
        // the server closes us right after a 'rehost'/'kicked' notice: take the reason out of the pending queue
        const pending = this.queue.find((m) => m.t === 'rehost' || m.t === 'kicked');
        if (pending?.t === 'rehost') this.rehostId = pending.id ?? null;
        this.status = 'closed';
        this.disconnectReason = this.disconnectReason || pending?.reason || 'Connection lost';
      };
    });
  }

  send(m: any): void { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'msg', d: m })); }
  attachAudio(): void {
    if (this.audioAttached) return;
    this.audioAttached = true;
    const sounds = this.game.sounds;
    sounds.musicControlled = true;
    sounds.onSound = (event, x, y, z, volume, pitch, attenuate) => this.send({ t: 'snd', e: event, x, y, z, v: volume, p: pitch, a: attenuate });
    const music = this.welcome?.music;
    if (music) sounds.playMusicRemote(music.name, music.kind, music.volume);
  }
  close(): void {
    this.status = 'closed'; try { this.ws?.close(); } catch { /* */ } this.ws = null;
    if (this.audioAttached) { const sounds = this.game.sounds; sounds.onSound = null; sounds.musicControlled = false; this.audioAttached = false; }
  }

  // ---- world listener: locally predicted block changes are sent to the host ----
  private predicted: number[] = [];
  onBlockChanged(x: number, y: number, z: number, _old: number, s: number): void {
    if (this.applying) return;
    if (this.predicted.length < 1024) this.predicted.push(x, y, z, s);
  }

  /** Forget everything about the current dimension before the host moves us to another one. */
  resetWorld(): void {
    for (const e of this.entities.values()) e.remove();
    this.entities.clear(); this.wanted.clear(); this.requested.clear(); this.chunkFrames = []; this.container = null; this.predicted = [];
  }
  /** ChunkManager (remote mode) asks for chunks here. */
  requestChunk(cx: number, cz: number): void { const k = chunkKey(cx, cz); if (this.requested.has(k)) return; this.requested.add(k); this.wanted.add(k); }
  forgetChunk(cx: number, cz: number): void { this.requested.delete(chunkKey(cx, cz)); }

  /** Per tick: apply everything received, then send our snapshot. */
  tick(): void {
    const g = this.game, p = g.player;
    this.ticks++;
    if (this.wanted.size) { this.send({ t: 'chunk', keys: [...this.wanted] }); this.wanted.clear(); }
    // every block we predicted this tick, in one message; the host answers with the authoritative states
    if (this.predicted.length) { this.send({ t: 'set', b: this.predicted }); this.predicted = []; }
    // chunks
    const frames = this.chunkFrames; this.chunkFrames = [];
    if (this.switching) frames.length = 0;
    for (const f of frames) {
      try {
        const { kind, json, body } = unpackFrame(f);
        if (kind === FRAME_CHUNK) { const d = decodeChunk(json, body); const c = Chunk.deserialize({ ...d, decorated: true } as any); c.modified = false; this.applying = true; try { g.chunks.addRemoteChunk(c); } finally { this.applying = false; } }
      } catch (e) { console.error('chunk decode', e); }
    }
    const q = this.queue; this.queue = [];
    for (const m of q) { try { this.handle(m); } catch (e) { console.error('client message error', e); } }
    // our snapshot (not while the host is moving us to another dimension: our position is meaningless there)
    if (this.ticks === 1) this.send({ t: 'ready' });
    if (this.switching) return;
    const face = p.breaking && g.targetBlock && p.breaking.x === g.targetBlock.x && p.breaking.y === g.targetBlock.y && p.breaking.z === g.targetBlock.z ? g.targetBlock.face : 1;
    // vanilla ServerboundMovePlayerPacket: position, look, onGround plus the pose/animation flags others render
    const snap: any = { t: 'move', x: r3(p.x), y: r3(p.y), z: r3(p.z), yaw: r1(p.yaw), pitch: r1(p.pitch), og: p.onGround, sneak: p.isSneaking, sprint: p.isSprinting, swim: p.swimmingPose, sleep: p.sleeping, fly: p.flying, slot: p.selectedSlot, swing: p.swinging && p.swingTime <= 1, use: !!p.usingItem, br: p.breaking ? { x: p.breaking.x, y: p.breaking.y, z: p.breaking.z, face, stage: p.breakStage, state: p.breaking.state } : null };
    this.send(snap);
    // creative players pick items out of thin air, so the host has to be told what is in the hand
    if (p.isCreative) {
      const held = JSON.stringify(p.heldItem()?.serialize() ?? null), armor = JSON.stringify(p.armor.serialize()) + JSON.stringify(p.offhand.serialize());
      if (held !== this.lastHeld || armor !== this.lastArmor) { this.lastHeld = held; this.lastArmor = armor; this.send({ t: 'inv', held: p.heldItem()?.serialize() ?? null, armor: p.armor.serialize(), off: p.offhand.serialize() }); }
    }
    if (this.ticks % 40 === 0) this.send({ t: 'ping', time: performance.now(), ping: this.ping });
  }
  containerDirty = false;
  private inventoryRevision = 0;

  /** Vanilla-style optimistic window transaction; the host acks or replaces the complete window state. */
  syncInventoryScreen(screen: any): void {
    const p = this.game.player;
    const grid = screen?.grid instanceof Inventory ? screen.grid : null;
    if (!grid || (grid.size !== 4 && grid.size !== 9)) {
      if (this.container) this.send({ t: 'contTxn', rev: this.inventoryRevision++, slots: this.container.inv.serialize(), inventory: p.inventory.serialize(), armor: p.armor.serialize(), offhand: p.offhand.serialize(), cursor: screen?.carried?.serialize?.() ?? null });
      return;
    }
    this.send({
      t: 'invTxn', rev: this.inventoryRevision++,
      inventory: p.inventory.serialize(), armor: p.armor.serialize(), offhand: p.offhand.serialize(),
      grid: grid.serialize(), gridSize: grid.size,
      cursor: screen?.carried?.serialize?.() ?? null,
    });
  }

  /** set while the host has moved us to another dimension and the new world is still being set up */
  switching = false;
  private handle(m: any): void {
    const g = this.game, p = g.player, w = g.world;
    // world-bound messages for the dimension we are leaving are dropped; the host resends after 'dimready'
    if (this.switching && ['blk', 'breakFx', 'ent', 'contUpd', 'open', 'snd', 'record'].includes(m.t)) return;
    switch (m.t) {
      case 'blk': { this.applying = true; try { const b = m.b as number[]; for (let i = 0; i < b.length; i += 4) { if (w.isLoaded(b[i], b[i + 2])) w.setBlock(b[i], b[i + 1], b[i + 2], b[i + 3], SET_UPDATE_NEIGHBORS); } } finally { this.applying = false; } break; }
      case 'breakFx': g.particles.spawnBlockBreak(m.x, m.y, m.z, m.s); break;
      case 'snd': { if (m.o === this.clientId) break; const d = Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z); if (d < 64 || m.a === false) g.sounds.playAtRemote(m.e, m.x, m.y, m.z, m.v, m.p, m.a !== false); break; }
      case 'music': g.sounds.playMusicRemote(m.name, m.kind, m.v); break;
      case 'record': { if (m.disc) g.sounds.playRecordRemote(m.disc, m.x, m.y, m.z); else g.sounds.stopRecordRemote(m.x, m.y, m.z); break; }
      case 'time': { w.time = m.time; w.dayTime = m.day; g.weather.rainLevel = m.rain; g.weather.thunderLevel = m.thunder; g.weather.raining = m.raining; g.weather.thundering = m.thundering; g.difficulty = m.diff; break; }
      case 'ent': this.applyEntities(m.e ?? [], m.rm ?? []); break;
      case 'chat': g.gui.addChat(m.text); break;
      case 'actionbar': g.gui.showActionBar(m.text); break;
      case 'players': this.players = m.list; break;
      case 'self': {
        if (m.mode) p.setGameMode(m.mode);
        const s = m.state;
        if (s) {
          if (Array.isArray(s.inventory)) p.inventory.deserialize(s.inventory, g.items);
          if (Array.isArray(s.armor)) p.armor.deserialize(s.armor, g.items);
          if (Array.isArray(s.offhand)) p.offhand.deserialize(s.offhand, g.items);
          if (Number.isInteger(s.selectedSlot) && s.selectedSlot >= 0 && s.selectedSlot < 9) p.selectedSlot = s.selectedSlot;
          this.applyStats(s);
          if (Number.isFinite(s.exhaustion)) p.exhaustion = s.exhaustion;
          p.inventory.onChange?.();
        }
        break;
      }
      case 'stats': this.applyStats(m); break;
      case 'invState': {
        if (!shouldApplyInventoryState(this.inventoryRevision, m.rev, m.accepted === true)) break;
        this.inventoryRevision = m.rev;
        if (Array.isArray(m.inventory)) p.inventory.deserialize(m.inventory, g.items);
        if (Array.isArray(m.armor)) p.armor.deserialize(m.armor, g.items);
        if (Array.isArray(m.offhand)) p.offhand.deserialize(m.offhand, g.items);
        const screen = g.gui.screen as any;
        if (screen?.grid instanceof Inventory && Array.isArray(m.grid) && screen.grid.size === m.grid.length) {
          screen.grid.deserialize(m.grid, g.items); screen.grid.onChange?.();
        }
        if (screen && 'carried' in screen) screen.carried = m.cursor ? ItemStack.deserialize(m.cursor, g.items) : null;
        p.inventory.onChange?.();
        break;
      }
      case 'windowState': {
        if (!shouldApplyInventoryState(this.inventoryRevision, m.rev, m.accepted === true)) break;
        this.inventoryRevision = m.rev; this.containerDirty = false;
        if (Array.isArray(m.inventory)) p.inventory.deserialize(m.inventory, g.items);
        if (Array.isArray(m.armor)) p.armor.deserialize(m.armor, g.items);
        if (Array.isArray(m.offhand)) p.offhand.deserialize(m.offhand, g.items);
        if (this.container && Array.isArray(m.slots)) this.container.inv.deserialize(m.slots, g.items);
        const screen = g.gui.screen as any;
        if (screen && 'carried' in screen) screen.carried = m.cursor ? ItemStack.deserialize(m.cursor, g.items) : null;
        p.inventory.onChange?.();
        break;
      }
      case 'correct': {
        if ([m.x, m.y, m.z, m.yaw, m.pitch].every(Number.isFinite)) {
          p.setPos(m.x, m.y, m.z); p.yaw = m.yaw; p.pitch = m.pitch;
          p.vx = 0; p.vy = 0; p.vz = 0;
        }
        break;
      }
      case 'hurt': { if (Number.isFinite(m.health)) p.applyServerHurt(m); break; }
      // the host already fitted this into our authoritative inventory; anything that does not fit locally is a
      // prediction mismatch the next inventory sync repairs
      case 'give': { const st = ItemStack.deserialize(m.stack, g.items); if (!st) break; p.inventory.add(st); p.inventory.onChange?.(); g.sounds.playAt('entity.item.pickup', p.x, p.y, p.z, 0.2, ((Math.random() - Math.random()) * 0.7 + 1) * 2); break; }
      case 'givexp': p.addXp(m.v); g.sounds.playAt('entity.experience_orb.pickup', p.x, p.y, p.z, 0.1, 1 + Math.random() * 0.5); break;
      case 'consumed': { p.inventory.slots[p.selectedSlot] = m.held ? ItemStack.deserialize(m.held, g.items) : null; p.inventory.onChange?.(); break; }
      case 'open': this.openRemote(m); break;
      case 'contUpd': { if (this.container && this.container.x === m.x && this.container.y === m.y && this.container.z === m.z && !this.containerDirty) { this.container.inv.deserialize(m.slots, g.items); if (m.be && this.container.be) Object.assign(this.container.be, m.be); } break; }
      case 'wake': { if (p.sleeping) { p.wakeUp(); g.gui.sleepFade = 0; } break; }
      case 'dim': {
        if (!['overworld', 'the_nether', 'the_end'].includes(m.dimension) || ![m.x, m.y, m.z, m.seed, m.time, m.dayTime].every(Number.isFinite)) break;
        this.switching = true;
        g.switchDimensionRemote(m).catch((e) => console.error('dimension switch', e)).finally(() => { if (this.switching) { this.switching = false; this.send({ t: 'dimready' }); } });
        break;
      }
      case 'kicked': { this.disconnectReason = m.reason ?? 'Disconnected'; this.status = 'closed'; break; }
      case 'rehost': { this.disconnectReason = m.reason ?? 'Reconnecting…'; this.rehostId = m.id ?? null; this.status = 'closed'; break; }
      case 'pong': this.ping = Math.round(performance.now() - m.time); break;
      case 'ride': {
        const v = m.id !== null && m.id !== undefined ? this.entities.get(m.id) : null;
        const leave = () => { if (p.vehicle instanceof BoatEntity) p.vehicle.detachPassenger(p); else p.stopRiding(); };
        if (v instanceof BoatEntity) { if (p.vehicle !== v) { leave(); v.addPassenger(p, m.seat); } }
        else if (v) { if (p.vehicle !== v) { leave(); p.startRiding(v); } }
        else { leave(); if (m.x !== undefined) { p.setPos(m.x, m.y, m.z); p.vy = 0; } }
        break;
      }
    }
  }

  /** Server-owned survival state (vanilla SetHealth / SetExperience / UpdateMobEffect / game mode packets). */
  private applyStats(s: any): void {
    const p = this.game.player;
    if (s.mode) p.setGameMode(s.mode);
    if (Number.isFinite(s.health)) p.health = s.health;
    if (Number.isFinite(s.absorption)) p.absorption = s.absorption;
    if (Number.isFinite(s.foodLevel)) p.foodLevel = s.foodLevel;
    if (Number.isFinite(s.saturation)) p.saturation = s.saturation;
    if (Number.isFinite(s.air)) p.air = s.air;
    if (Number.isFinite(s.xpLevel)) p.xpLevel = s.xpLevel;
    if (Number.isFinite(s.xpProgress)) p.xpProgress = s.xpProgress;
    if (Number.isFinite(s.totalXp)) p.totalXp = s.totalXp;
    if (Array.isArray(s.effects)) p.effects = s.effects.filter((e: any) => e && typeof e.id === 'string' && Number.isFinite(e.duration)).map((e: any) => ({ id: e.id, amplifier: e.amplifier | 0, duration: e.duration, ambient: !!e.ambient }));
    if (s.fire === false) p.fireTicks = 0; else if (s.fire === true && p.fireTicks <= 0) p.fireTicks = 20;
  }

  private openRemote(m: any): void {
    const g = this.game;
    const closeMsg = () => { this.send({ t: 'close' }); this.container = null; };
    if (m.kind === 'container') {
      const inv = new Inventory(m.slots.length); inv.deserialize(m.slots, g.items);
      this.container = { x: m.x, y: m.y, z: m.z, inv };
      inv.onChange = () => { this.containerDirty = true; };
      g.gui.openContainer(inv, m.title, m.rows, closeMsg, m.cols);
    } else if (m.kind === 'furnace' || m.kind === 'brewing') {
      const be = g.blockEntities.getOrCreate(m.x, m.y, m.z, m.kind === 'furnace' ? m.fkind : 'brewing_stand', () => ({ items: m.slots.length }));
      be.inventory.deserialize(m.slots, g.items); Object.assign(be, m.be);
      this.container = { x: m.x, y: m.y, z: m.z, inv: be.inventory, be };
      be.inventory.onChange = () => { this.containerDirty = true; };
      if (m.kind === 'furnace') g.gui.openFurnace(be, m.fkind); else g.gui.openBrewing(be);
      const s = g.gui.screen!; const orig = s.onClose.bind(s); s.onClose = () => { orig(); closeMsg(); };
    } else if (m.kind === 'crafting') {
      g.gui.openCrafting();
      const s = g.gui.screen!; const orig = s.onClose.bind(s); s.onClose = () => { orig(); closeMsg(); };
    }
    else if (m.kind === 'stonecutter') g.gui.openStonecutter();
    else if (m.kind === 'anvil') g.gui.openAnvil();
    else if (m.kind === 'smithing') g.gui.openSmithing();
    else if (m.kind === 'grindstone') g.gui.openGrindstone();
    else if (m.kind === 'enchanting') g.gui.openEnchanting(m.x, m.y, m.z);
  }

  private applyEntities(list: any[], rm: number[]): void {
    const g = this.game;
    for (const id of rm) { const e = this.entities.get(id); if (e) { if (e.vehicle instanceof BoatEntity) e.vehicle.detachPassenger(e); e.remove(); this.entities.delete(id); } }
    for (const s of list) {
      let e: Entity | undefined = this.entities.get(s.i);
      if (!e) {
        e = this.createEntity(s) ?? undefined;
        if (!e) continue;
        e.remoteId = s.i; e.remote = true;
        e.setPos(s.x, s.y, s.z); e.prevX = e.x; e.prevY = e.y; e.prevZ = e.z; e.yaw = e.prevYaw = s.yaw; e.pitch = e.prevPitch = s.pitch;
        if (e instanceof LivingEntity) { e.bodyYaw = e.prevBodyYaw = s.by ?? s.yaw; e.headYaw = e.prevHeadYaw = s.hy ?? s.yaw; }
        this.entities.set(s.i, e);
        g.entities.push(e); e.world = g.world; e.game = g; e.updateBB();
      }
      if (e instanceof RemotePlayer) {
        if (s.pid !== undefined) e.clientId = s.pid;
        e.applySnapshot(s);
        if (s.held !== undefined) { e.inventory.slots[e.selectedSlot] = s.held ? ItemStack.deserialize(s.held, g.items) : null; }
        if (s.armor) e.armor.deserialize(s.armor, g.items);
      } else e.applySnapshot(s);
    }
    this.reconcileRemotePassengers();
  }

  /** Mirror who rides what: boats seat their passengers, anything else (mobs, players, even us) carries them. */
  private reconcileRemotePassengers(): void {
    const g = this.game, selfId = this.welcome?.selfId;
    for (const e of this.entities.values()) {
      const id = e.remoteVehicleId;
      const wanted = id === null ? null : id === selfId ? g.player : this.entities.get(id) ?? null;
      const boat = wanted instanceof BoatEntity ? wanted : null;
      const wrongSeat = boat !== null && e.vehicle === boat && boat.passengerIndex(e) !== e.remoteVehicleSeat;
      if ((e.vehicle !== wanted || wrongSeat) && e.vehicle) { if (e.vehicle instanceof BoatEntity) e.vehicle.detachPassenger(e); else e.stopRiding(); }
      if (boat && e.vehicle !== boat) boat.addPassenger(e, e.remoteVehicleSeat);
      else if (wanted && !boat && e.vehicle !== wanted) e.startRiding(wanted);
    }
  }

  private createEntity(s: any): Entity | null {
    const g = this.game;
    if (s.t === 'player') { const p = new RemotePlayer(s.full?.name ?? 'Player'); p.skin = s.full?.skin === 'alex' ? 'alex' : 'steve'; p.gameMode = s.mode ?? 'survival'; return p; }
    if (MOB_DEFS[s.t]) { const m = new Mob(MOB_DEFS[s.t]); return m; }
    if (s.t === 'item') { const st = s.full?.stack ? ItemStack.deserialize(s.full.stack, g.items) : null; if (!st) return null; const e = new ItemEntity(st); return e; }
    if (s.t === 'xp') return new ExperienceOrb(s.full?.value ?? 1);
    if (s.t === 'falling_block') return new FallingBlockEntity(s.full?.state ?? 1);
    if (s.t === 'tnt') return new PrimedTnt(s.fuse ?? 80);
    if (s.t === 'boat') return new BoatEntity(s.full?.wood ?? 'oak', !!s.full?.chest);
    if (s.t === 'arrow') { const a = new ArrowEntity(null, 2, s.full?.kind ?? 'normal'); if (s.full?.trident) { (a as any).trident = ItemStack.deserialize(s.full.trident, g.items); (a as any).type = 'trident'; } return a; }
    if (s.t === 'thrown') { const st = s.full?.stack ? ItemStack.deserialize(s.full.stack, g.items) : null; return new ThrownProjectile(s.full?.kind ?? 'snowball', null, st); }
    return null;
  }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r1 = (v: number) => Math.round(v * 10) / 10;
