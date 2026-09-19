// Host side of multiplayer: the browser running the world registers with the relay and serves guests.
// The host is authoritative for the world and every guest player. Guests send predicted movement and gameplay
// intentions; the host validates them and sends corrections/state back. The player who opened the world remains
// trusted as its owner, matching vanilla's integrated-server model.
import type { Game, DimensionInstance } from '../game/game';
import type { Dimension, WorldListener } from '../world/world';
import { RemotePlayer } from '../entity/remotePlayer';
import { Entity, LivingEntity, ItemEntity, ExperienceOrb } from '../entity/entity';
import { Mob } from '../entity/mobs';
import { BoatEntity } from '../entity/boat';
import { ArrowEntity, EyeOfEnderEntity, FallingBlockEntity, PrimedTnt, ThrownProjectile } from '../entity/misc';
import { nearestStronghold } from '../world/gen/structures';
import { isSchematic, pasteSchematic, type Schematic } from '../game/schematics';
import { Inventory, ItemStack } from '../items/stack';
import { encodeChunk, packFrame, FRAME_CHUNK, PROTOCOL_VERSION, TARGET_SERVER, defaultRelayUrl, isGuestMessage, serializedStackIdentity, type PlayerListEntry } from './protocol';
import type { Chunk } from '../world/chunk';
import type { Player } from '../entity/player';
import { runCommand } from '../game/commands';

interface Guest {
  id: number; playerId: string; name: string; player: RemotePlayer;
  /** entity id of the merchant this guest is trading with */
  trading?: number | null;
  /** the dimension this guest's copy lives in (its world instance on the host) */
  dim: Dimension;
  known: Set<number>;            // entity ids the guest has full info for
  chunks: Set<number>;           // chunk keys sent
  wantChunks: Set<number>;       // requested but not yet loaded
  container: { x: number; y: number; z: number; inv: Inventory; onClose?: () => void; be?: any } | null;
  ready: boolean;
  /** network id of the vehicle the guest was last told about (null = on foot) */
  rideId: number | null;
  lastMoveTick: number;
  movementViolations: number;
  /** move packets received during the current host tick (vanilla receivedMovePacketCount - knownMovePacketCount) */
  movesThisTick: number;
  /** chunk frames sent and not yet acknowledged by the guest (flow control through the relay) */
  chunksInFlight: number;
  /** id of the last position correction sent; moves not stamped with it are stale (vanilla awaitingTeleport) */
  teleportId: number;
  /** latest creative inventory edit applied from this guest (echoed so the guest can ignore older pushes) */
  creativeRev: number;
  craftingSize: 2 | 3;
  inventoryRevision: number;
  crafting: Inventory;
  cursor: Inventory;
  /** last server-owned stats sent (vanilla sends SetHealth/SetExperience/effect packets the moment they change) */
  statsKey: string;
  inventoryDirty: boolean;
}

export interface HostOptions {
  name: string; motd: string; gameMode: string; cheats: boolean; maxPlayers: number; relayUrl?: string;
  /** '' = public (anyone may join), otherwise the password guests must enter */
  password?: string;
  /** true when coordinating live simulation for the backend-owned public world */
  official?: boolean;
}

export /** unacknowledged chunk frames allowed per guest (vanilla's chunk sender keeps a similar small window) */
const MAX_CHUNKS_IN_FLIGHT = 10;
/** bytes our WebSocket may have queued before chunk streaming pauses */
const MAX_SOCKET_BACKLOG = 256 * 1024;

export class NetHost {
  ws: WebSocket | null = null;
  serverId = '';
  guests = new Map<number, Guest>();
  status = 'connecting';
  isPublic = true; official = false;
  /** chunks changed since the last upload of the public world ("dim:cx,cz" -> [dim, cx, cz]) */
  private dirtyChunks = new Map<string, [Dimension, number, number]>();
  /** block changes since the last tick, per dimension */
  private blockBatches = new Map<Dimension, number[]>();
  /** the world listener registered on each simulated dimension */
  private listeners = new Map<DimensionInstance, WorldListener>();
  private queue: any[] = [];
  /** guest whose forwarded sound or predicted block use is being handled: the sounds it causes are tagged so that
   *  guest, which already played them locally, does not hear them a second time */
  private soundOrigin = 0;
  private ticks = 0;
  private sleepAnnounced = '';
  hostName = 'Host';
  onStatus: ((s: string) => void) | null = null;

  constructor(public game: Game, public opts: HostOptions) {}

  start(): Promise<void> {
    const g = this.game;
    this.hostName = g.options.playerName || 'Host';
    return new Promise((resolve, reject) => {
      const url = this.opts.relayUrl || defaultRelayUrl();
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => { ws.send(JSON.stringify({ t: 'host', name: this.opts.name, host: this.hostName, playerId: g.options.playerId, motd: this.opts.motd, gameMode: this.opts.gameMode, password: this.opts.password ?? '', official: !!this.opts.official, maxPlayers: this.opts.maxPlayers, version: `${g.version}/${PROTOCOL_VERSION}` })); };
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') { this.queue.push({ t: 'bin', data: new Uint8Array(e.data) }); return; }
        const m = JSON.parse(e.data);
        if (m.t === 'hosted') { this.serverId = m.id; this.isPublic = !m.private; this.official = !!m.official; this.status = 'open'; this.attach(); resolve(); }
        else if (m.t === 'error' && this.status === 'connecting') { this.status = 'error'; reject(new Error(m.reason)); }
        else this.queue.push(m);
      };
      ws.onerror = () => { this.status = 'error'; reject(new Error('Could not reach the relay server at ' + url)); };
      ws.onclose = () => { this.status = 'closed'; this.onStatus?.('closed'); this.detach(); };
    });
  }

  stop(): void {
    if (this.official && this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ t: 'playerState', playerId: this.game.options.playerId, saved: this.game.player.serialize() }));
      this.uploadWorld();
    }
    this.detach(); try { this.ws?.close(); } catch { /* */ } this.ws = null;
  }

  private attach(): void {
    const g = this.game;
    for (const inst of g.dims.values()) this.attachTo(inst);
    // sounds and records belong to the dimension the game is simulating at that moment (Game.bound)
    g.sounds.onSound = (event, x, y, z, volume, pitch, attenuate) => this.broadcastIn(g.bound.dim, { t: 'snd', e: event, x, y, z, v: volume, p: pitch, a: attenuate, o: this.soundOrigin });
    g.sounds.onMusic = (name, kind, volume) => this.broadcast({ t: 'music', name, kind, v: volume });
    g.sounds.onRecord = (disc, x, y, z) => this.broadcastIn(g.bound.dim, { t: 'record', disc, x, y, z });
  }
  private detach(): void {
    const g = this.game;
    for (const inst of [...this.listeners.keys()]) this.detachFrom(inst);
    g.sounds.onSound = null; g.sounds.onMusic = null; g.sounds.onRecord = null;
    for (const gu of this.guests.values()) gu.player.remove();
    this.guests.clear();
  }
  /** Follow block changes of a simulated dimension (called for every instance, including ones created later). */
  attachTo(inst: DimensionInstance): void {
    if (this.listeners.has(inst)) return;
    const l: WorldListener = { onBlockChanged: (x, y, z, _o, s) => this.onBlockChanged(inst.dim, x, y, z, s) };
    inst.world.listeners.push(l);
    this.listeners.set(inst, l);
  }
  detachFrom(inst: DimensionInstance): void {
    const l = this.listeners.get(inst);
    if (l) { inst.world.listeners = inst.world.listeners.filter((x) => x !== l); this.listeners.delete(inst); }
    const k = inst.dim;
    for (const gu of this.guests.values()) if (gu.dim === k) gu.chunks.clear();
  }
  guestsIn(dim: Dimension): number { let n = 0; for (const gu of this.guests.values()) if (gu.dim === dim) n++; return n; }

  send(to: number, m: any): void { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'msg', to, d: m })); }
  broadcast(m: any): void { if (this.guests.size) this.send(0, m); }
  /** Everyone whose copy is in that dimension. */
  broadcastIn(dim: Dimension, m: any): void { for (const gu of this.guests.values()) if (gu.dim === dim) this.send(gu.id, m); }
  private sendBinary(to: number, payload: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    const out = new Uint8Array(4 + payload.length); new DataView(out.buffer).setUint32(0, to, true); out.set(payload, 4); this.ws.send(out);
  }

  private onBlockChanged(dim: Dimension, x: number, y: number, z: number, s: number): void {
    let batch = this.blockBatches.get(dim);
    if (!batch) this.blockBatches.set(dim, batch = []);
    batch.push(x, y, z, s);
    if (this.official) { const cx = x >> 4, cz = z >> 4; this.dirtyChunks.set(`${dim}:${cx},${cz}`, [dim, cx, cz]); }
  }

  /** Public world: push changed chunks and world meta to the backend so it survives us leaving. */
  private uploadWorld(maxChunks = 8, includeMeta = true): void {
    const g = this.game;
    if (!this.ws || this.ws.readyState !== 1) return;
    let sent = 0;
    for (const [key, [dim, cx, cz]] of this.dirtyChunks) {
      const c = g.dims.get(dim)?.world.getChunk(cx, cz);
      this.dirtyChunks.delete(key);
      if (!c) continue;
      const { header, body } = encodeChunk(c, dim);
      const payload = packFrame(FRAME_CHUNK, header, body);
      const out = new Uint8Array(4 + payload.length);
      new DataView(out.buffer).setUint32(0, TARGET_SERVER, true); out.set(payload, 4);
      this.ws.send(out);
      if (++sent >= maxChunks) break;
    }
    if (!includeMeta) return;
    const playerData: Record<string, any> = {};
    for (const gu of this.guests.values()) if (gu.player.lastSaved) playerData[gu.playerId] = gu.player.lastSaved;
    playerData[g.options.playerId] = g.player.serialize();
    this.ws.send(JSON.stringify({ t: 'meta', meta: { time: g.world.time, dayTime: g.world.dayTime, weather: g.weather.serialize(), rules: g.rules, worldSpawn: g.worldSpawn, dragonKills: g.dragonKills }, playerData }));
  }

  /** Called every game tick from Game.tick. */
  tick(): void {
    this.ticks++;
    this.processQueue();
    const g = this.game;
    for (const [dim, batch] of this.blockBatches) if (batch.length) this.broadcastIn(dim, { t: 'blk', b: batch });
    this.blockBatches.clear();
    for (const gu of this.guests.values()) {
      gu.movesThisTick = 0;
      if (!gu.ready || !g.dims.has(gu.dim)) continue;
      const p = gu.player;
      g.withDimension(gu.dim, () => {
        // vanilla ClientboundSetPassengersPacket: whenever what the guest rides changes, tell it
        if (p.vehicle?.removed) p.stopRiding();
        const vid = p.vehicle ? this.netId(p.vehicle) : null;
        if (vid !== gu.rideId) { gu.rideId = vid; this.send(gu.id, { t: 'ride', id: vid, seat: p.vehicle instanceof BoatEntity ? p.vehicle.passengerIndex(p) : -1, x: p.x, y: p.y, z: p.z }); }
        this.streamChunks(gu);
        this.pickups(gu);
      });
      if (p.needsCorrection) { p.needsCorrection = false; this.correct(gu, p.x, p.y, p.z, p.yaw, p.pitch); }
      const stats = this.stats(p), key = JSON.stringify(stats);
      if (key !== gu.statsKey) { gu.statsKey = key; this.send(gu.id, { t: 'stats', ...stats }); }
      if (gu.container && this.ticks % 5 === 0) this.sendContainer(gu, false);
      if (gu.inventoryDirty || this.ticks % 20 === 0) { gu.inventoryDirty = false; this.send(gu.id, { t: 'self', mode: p.gameMode, creativeRev: gu.creativeRev, state: this.playerState(p) }); }
    }
    this.checkSleep();
    if (this.ticks % 2 === 0) this.sendEntities(this.ticks % 4 === 0);
    if (this.official && this.ticks % 20 === 0 && this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ t: 'playerState', playerId: g.options.playerId, saved: g.player.serialize() }));
    }
    // Smooth persistence work across ticks: encoding several full chunks in one frame caused a visible hitch.
    if (this.official && this.ticks % 20 === 0) this.uploadWorld(1, this.ticks % 100 === 0);
    if (this.ticks % 200 === 0 && this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'ping', time: 0 })); // keep the relay connection alive while nobody is here
    if (this.ticks % 20 === 0) this.broadcast({ t: 'time', time: g.world.time, day: g.world.dayTime, rain: g.weather.rainLevel, thunder: g.weather.thunderLevel, raining: g.weather.raining, thundering: g.weather.thundering, diff: g.difficulty });
  }

  private processQueue(): void {
    const q = this.queue; this.queue = [];
    for (const m of q) {
      try {
        if (m.t === 'bin') continue; // guests send no binary
        if (m.t === 'guestJoined') this.onJoin(m.from, m.playerId, m.name, m.skin);
        else if (m.t === 'guestLeft') this.onLeave(m.from);
        else if (m.from !== undefined) { const gu = this.guests.get(m.from); if (gu && isGuestMessage(m) && this.game.dims.has(gu.dim)) this.game.withDimension(gu.dim, () => { const own = m.t === 'use' || m.t === 'snd'; if (own) this.soundOrigin = gu.id; try { this.onGuestMessage(gu, m); } finally { this.soundOrigin = 0; } }); }
      } catch (e) { console.error('host message error', e); }
    }
  }

  private onJoin(id: number, playerId: string, name: string, skin?: string): void {
    const g = this.game;
    playerId = String(playerId || name).slice(0, 80);
    if ([...this.guests.values()].some((x) => x.name === name) || name === this.hostName) { name = name + '_' + id; }
    // Stable ids prevent renamed players (or two players with the same display name) sharing inventories.
    // The name fallback migrates saves made by older versions.
    const saved = g.playerData.get(playerId) ?? g.playerData.get(name);
    const dim: Dimension = ['overworld', 'the_nether', 'the_end'].includes(saved?.dimension) ? saved.dimension : 'overworld';
    // the guest's dimension has to be simulated before its copy can exist; the join completes once it is
    const inst = g.dims.get(dim);
    if (inst) this.finishJoin(id, playerId, name, skin, saved, inst);
    else { g.reserveDimension(dim); g.ensureDimension(dim).then((created) => { if (this.status === 'open' && !this.guests.has(id)) this.finishJoin(id, playerId, name, skin, saved, created); }).catch((e) => console.error('join', e)).finally(() => g.releaseDimension(dim)); }
  }
  private finishJoin(id: number, playerId: string, name: string, skin: string | undefined, saved: any, inst: DimensionInstance): void {
    const g = this.game;
    const p = new RemotePlayer(name);
    p.clientId = id; p.skin = skin === 'alex' ? 'alex' : 'steve';
    // sent synchronously so the damage cue precedes the stats update of the same tick
    p.hurtHandler = (d) => { if (p.health <= 0) { const gu = this.guests.get(id); if (gu) gu.inventoryDirty = true; } this.send(id, { t: 'hurt', damage: d.amount, source: d.source, health: p.health, absorption: p.absorption, vx: p.vx, vy: p.vy, vz: p.vz, fire: p.fireTicks, dead: p.health <= 0, deathMessage: p.health <= 0 ? p.deathMessage : undefined, attacker: d.attacker ? { x: d.attacker.x, z: d.attacker.z } : null }); };
    const spawn = g.worldSpawn ?? [Math.floor(g.player.x), Math.floor(g.player.y), Math.floor(g.player.z)];
    g.withDimension(inst, () => {
      g.addEntity(p);
      if (saved) { try { p.deserialize(saved); } catch { /* reject incompatible legacy state and use spawn */ } }
    });
    p.setPos(saved?.x ?? spawn[0] + 0.5, saved?.y ?? spawn[1], saved?.z ?? spawn[2] + 0.5); p.needsCorrection = false;
    p.setGameMode(this.opts.gameMode as any);
    p.cheats = this.opts.cheats || g.ops.has(playerId);
    const gu: Guest = { id, playerId, name, player: p, dim: inst.dim, known: new Set(), chunks: new Set(), wantChunks: new Set(), container: null, ready: false, lastMoveTick: this.ticks, movementViolations: 0, craftingSize: 2, inventoryRevision: 0, crafting: new Inventory(4), cursor: new Inventory(1), statsKey: '', inventoryDirty: false, rideId: null, movesThisTick: 0, chunksInFlight: 0, teleportId: 0, creativeRev: 0 };
    this.guests.set(id, gu);
    this.send(id, { t: 'welcome', name, selfId: p.id, hostName: this.official ? this.opts.name : this.hostName, dimension: inst.dim, seed: inst.world.seed, time: inst.world.time, dayTime: inst.world.dayTime, spawn, saved: saved ?? null, gameMode: this.opts.gameMode, cheats: p.cheats, difficulty: g.difficulty, rules: g.rules, weather: g.weather.serialize(), version: g.version, protocol: PROTOCOL_VERSION, players: this.playerList(), music: g.sounds.currentMusic() });
    g.gui.addChat(`§e${name} joined the game`);
    this.broadcast({ t: 'chat', text: `§e${name} joined the game` });
    this.broadcast({ t: 'players', list: this.playerList() });
    this.onStatus?.('players');
  }

  private onLeave(id: number): void {
    const gu = this.guests.get(id); if (!gu) return;
    this.savePlayer(gu);
    gu.player.remove();
    if (gu.container) gu.container.onClose?.();
    this.guests.delete(id);
    this.game.gui.addChat(`§e${gu.name} left the game`);
    this.broadcast({ t: 'chat', text: `§e${gu.name} left the game` });
    this.broadcast({ t: 'players', list: this.playerList() });
    this.onStatus?.('players');
  }

  /** Game.travelRemotePlayer moved a guest's copy: reset what the guest knows and tell it to switch worlds. */
  onGuestDimension(p: RemotePlayer, dim: Dimension, dest: [number, number, number]): void {
    for (const gu of this.guests.values()) {
      if (gu.player !== p) continue;
      gu.dim = dim; gu.chunks.clear(); gu.wantChunks.clear(); gu.known.clear(); gu.rideId = null; p.stopRiding();
      if (gu.container) { gu.container.onClose?.(); gu.container = null; }
      const inst = this.game.dims.get(dim)!;
      this.send(gu.id, { t: 'dim', dimension: dim, seed: inst.world.seed, time: inst.world.time, dayTime: inst.world.dayTime, x: dest[0], y: dest[1], z: dest[2] });
    }
  }
  playerList(): PlayerListEntry[] {
    const g = this.game;
    return [{ name: this.hostName, id: -1, ping: 0, skin: g.options.skin, mode: g.player.gameMode }, ...[...this.guests.values()].map((gu) => ({ name: gu.name, id: gu.id, ping: gu.player.ping, skin: gu.player.skin, mode: gu.player.gameMode }))];
  }
  /** Entity id as guests know it: the host player is -1, everything else its entity id. */
  netId(e: Entity): number { return e === this.game.player ? -1 : e.id; }
  /** A command mounted/dismounted a player: the tick loop notices via rideId, nothing else to do here. */
  onRideChanged(_rider: Entity): void {}
  /** Push a guest's complete inventory now (after a command or host-side change touched it). */
  syncInventory(p: Player): void { for (const gu of this.guests.values()) if (gu.player === p) gu.inventoryDirty = true; }
  /** vanilla ClientboundPlayerPositionPacket: move the guest and stamp the correction so its stale moves are ignored */
  private correct(gu: Guest, x: number, y: number, z: number, yaw: number, pitch: number): void {
    gu.teleportId = (gu.teleportId + 1) & 0xffff;
    this.send(gu.id, { t: 'correct', id: gu.teleportId, x, y, z, yaw, pitch });
  }
  /** a guest copied a region with /schem save: the data goes to its browser, not ours */
  sendSchematic(p: Player, schem: Schematic): void {
    for (const gu of this.guests.values()) if (gu.player === p) this.send(gu.id, { t: 'schem', data: schem });
  }
  /** vanilla /op, /deop: operator status persists with the world (ops.json) */
  setOp(p: Player, on: boolean): boolean {
    const g = this.game;
    for (const gu of this.guests.values()) if (gu.player === p) {
      if (on) g.ops.add(gu.playerId); else g.ops.delete(gu.playerId);
      const cheats = this.opts.cheats || on;
      if (gu.player.cheats === cheats) return false;
      gu.player.cheats = cheats;
      this.send(gu.id, { t: 'perm', cheats });
      return true;
    }
    return false;
  }
  /** Change the shared world's rules while hosting (the "Open to LAN" settings, vanilla /defaultgamemode + /publish). */
  setRules(o: { cheats?: boolean; gameMode?: string }): void {
    if (o.gameMode) { this.opts.gameMode = o.gameMode; if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'update', gameMode: o.gameMode })); }
    if (o.cheats !== undefined) {
      this.opts.cheats = o.cheats;
      this.game.cheats = o.cheats || this.game.cheats;
      for (const gu of this.guests.values()) { const cheats = o.cheats || this.game.ops.has(gu.playerId); if (gu.player.cheats !== cheats) { gu.player.cheats = cheats; this.send(gu.id, { t: 'perm', cheats }); } }
    }
  }
  isOp(p: Player): boolean { for (const gu of this.guests.values()) if (gu.player === p) return this.game.ops.has(gu.playerId); return p === this.game.player; }
  /** A guest right-clicked a merchant: open the trading screen on their side. */
  openTrading(p: Player, mob: Mob): void {
    for (const gu of this.guests.values()) if (gu.player === p) { gu.trading = mob.id; this.send(gu.id, { t: 'open', kind: 'trading', id: mob.id, mtype: mob.type, prof: mob.profession, level: mob.villagerLevel, xp: mob.villagerXp, trades: mob.ensureTrades() }); }
  }
  private stats(p: RemotePlayer): any {
    return { health: p.health, absorption: p.absorption, foodLevel: p.foodLevel, saturation: p.saturation, air: p.air, xpLevel: p.xpLevel, xpProgress: p.xpProgress, totalXp: p.totalXp, mode: p.gameMode, effects: p.effects, fire: p.fireTicks > 0 };
  }

  private savePlayer(gu: Guest): void { this.game.playerData.set(gu.playerId, gu.player.serialize()); }
  saveAllPlayers(): void { for (const gu of this.guests.values()) this.savePlayer(gu); }

  kick(id: number, reason = 'Kicked by the host'): void { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'kick', id, reason })); }

  private onGuestMessage(gu: Guest, m: any): void {
    const g = this.game, p = gu.player, w = g.world, reg = g.registry;
    switch (m.t) {
      case 'ready': gu.ready = true; break;
      case 'move': {
        const values = [m.x, m.y, m.z, m.yaw, m.pitch];
        if (!values.every(Number.isFinite)) { gu.movementViolations++; break; }
        // vanilla ServerGamePacketListenerImpl.awaitingPositionFromClient: after a teleport, moves the guest sent
        // before it saw the new position are dropped instead of being "corrected" again and again
        if ((m.tp | 0) !== gu.teleportId) break;
        gu.lastMoveTick = this.ticks;
        gu.movesThisTick++;
        // vanilla ServerGamePacketListenerImpl.handleMovePlayer ("moved too quickly!"): the squared distance from the
        // last accepted position may be at most 100 (300 when gliding) per packet received this tick. Packets bunch
        // up over a real link, so the budget scales with the burst instead of snapping the player back.
        const last = p.networkSnapshot();
        const dx = m.x - last.x, dy = m.y - last.y, dz = m.z - last.z;
        const limit = (p.isCreative || p.isSpectator || p.fallFlying ? 300 : 100) * gu.movesThisTick;
        if (!p.vehicle && dx * dx + dy * dy + dz * dz > limit) {
          gu.movementViolations++;
          this.correct(gu, last.x, last.y, last.z, last.yaw, last.pitch);
          break;
        }
        gu.movementViolations = Math.max(0, gu.movementViolations - 1);
        const slot = Number.isInteger(m.slot) && m.slot >= 0 && m.slot < 9 ? m.slot : p.selectedSlot;
        const safe = { ...m, slot, br: undefined, health: undefined, mode: undefined, dead: undefined, fly: p.isCreative || p.isSpectator ? !!m.fly : false };
        if (p.vehicle) { p.tyaw = m.yaw; p.tpitch = m.pitch; p.applySnapshot({ ...safe, x: p.x, y: p.y, z: p.z }); }
        else p.applySnapshot(safe);
        // Like vanilla's player-action packet, the target is an intent. Validate reach and advance mining using
        // host-owned block/tool state; never trust the stage or state submitted by the guest.
        const target = m.br && [m.br.x, m.br.y, m.br.z].every(Number.isInteger) ? m.br : null;
        let hit: any = null;
        if (target && w.isLoaded(target.x, target.z)) {
          const state = w.getBlock(target.x, target.y, target.z);
          const reach = p.isCreative ? 5 : p.reachDistance;
          const ddx = target.x + 0.5 - m.x, ddy = target.y + 0.5 - (m.y + p.eyeHeight), ddz = target.z + 0.5 - m.z;
          if (state && ddx * ddx + ddy * ddy + ddz * ddz <= (reach + 0.75) * (reach + 0.75)) {
            hit = { x: target.x, y: target.y, z: target.z, face: Number.isInteger(target.face) ? target.face : 1, hx: 0.5, hy: 0.5, hz: 0.5, t: Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz), state };
          }
        }
        p.continueBreaking(hit);
        break;
      }
      case 'inv': // Creative players may choose any item; survival inventory stays host-authoritative.
        if (p.isCreative) {
          if (Number.isInteger(m.rev)) gu.creativeRev = m.rev;
          if (Array.isArray(m.inventory) && m.inventory.length === p.inventory.size) {
            p.inventory.deserialize(m.inventory, g.items);
            if (Array.isArray(m.armor) && m.armor.length === p.armor.size) p.armor.deserialize(m.armor, g.items);
            if (Array.isArray(m.off) && m.off.length === p.offhand.size) p.offhand.deserialize(m.off, g.items);
          } else {
            const held = m.held ? ItemStack.deserialize(m.held, g.items) : null;
            if (!held || held.count > 0) p.inventory.slots[p.selectedSlot] = held;
          }
          gu.inventoryDirty = true;
        }
        break;
      case 'invTxn': this.inventoryTransaction(gu, m); break;
      case 'contTxn': this.containerTransaction(gu, m); break;
      case 'chunk': for (const k of m.keys as number[]) { if (Number.isInteger(k)) { gu.chunks.delete(k); gu.wantChunks.add(k); } } break;
      case 'chunkAck': gu.chunksInFlight = Math.max(0, gu.chunksInFlight - Math.min(64, Math.max(0, m.n | 0))); break;
      case 'set': { // Never accept a guest-selected final state or block-entity payload: answer with the truth.
        const b: number[] = Array.isArray(m.b) ? m.b : [];
        const out: number[] = [];
        for (let i = 0; i + 2 < b.length; i += 4) { const x = b[i], y = b[i + 1], z = b[i + 2]; if (w.isLoaded(x, z)) out.push(x, y, z, w.getBlock(x, y, z)); }
        if (out.length) this.send(gu.id, { t: 'blk', b: out });
        break;
      }
      case 'break': {
        const { x, y, z } = m;
        if (![x, y, z].every(Number.isInteger) || !w.isLoaded(x, z)) break;
        if (p.distSq(x + 0.5, y + 0.5, z + 0.5) <= 64) {
          const state = w.getBlock(x, y, z);
          const breaking = p.breaking;
          if (state && (p.isCreative || (!!breaking && breaking.x === x && breaking.y === y && breaking.z === z))) {
            g.breakBlock(x, y, z, p, !p.isCreative, false); p.breaking = null; p.breakCooldown = 5;
            this.broadcast({ t: 'breakFx', x, y, z, s: state });
          }
        }
        this.send(gu.id, { t: 'blk', b: [x, y, z, w.getBlock(x, y, z)] });
        break;
      }
      case 'use': this.remoteUse(gu, m); break;
      case 'attack': { const e = m.playerId === -1 ? g.player : typeof m.playerId === 'number' ? this.guests.get(m.playerId)?.player : g.entities.find((x) => x.id === m.id); if (e instanceof LivingEntity && e !== p && !e.removed && e.distSq(p.x, p.y, p.z) < 36) p.attack(e); break; }
      case 'snd': {
        const { x, y, z } = m;
        if (typeof m.e !== 'string' || m.e.length > 128 || !g.sounds.events[m.e.replace(/^minecraft:/, '')] || ![x, y, z, m.v, m.p].every(Number.isFinite) || p.distSq(x, y, z) > 1024) break;
        g.sounds.playAt(m.e, x, y, z, Math.max(0, Math.min(16, m.v)), Math.max(0.25, Math.min(4, m.p)), m.a !== false);
        break;
      }
      case 'interact': {
        const e = g.entities.find((x) => x.id === m.id);
        if (!e || e.removed || e.distSq(p.x, p.y, p.z) > 36) break;
        const held = p.heldItem();
        if (e instanceof Mob) { if (e.interact(p, held)) this.send(gu.id, { t: 'consumed', held: p.heldItem()?.serialize() ?? null }); }
        else if (e instanceof BoatEntity) { if (e.interact(p, held) && p.vehicle === e) this.send(gu.id, { t: 'ride', id: e.id, seat: e.passengerIndex(p) }); }
        break;
      }
      case 'throw': this.remoteThrow(gu, m); break;
      case 'release': { p.usingItem = null; p.itemUseTicks = 0; break; } // bows/tridents arrive as 'spawn'
      case 'chat': this.chat(gu, String(m.text).slice(0, 256)); break;
      case 'cont': {
        if (!gu.container || !Array.isArray(m.slots) || !Array.isArray(m.player)) break;
        const nextContainer = new Inventory(gu.container.inv.size), nextPlayer = new Inventory(p.inventory.size);
        nextContainer.deserialize(m.slots, g.items); nextPlayer.deserialize(m.player, g.items);
        // Transitional transaction validation: moving items is allowed only when the complete multiset across
        // the open menu and player inventory is unchanged. This closes item creation/deletion while explicit
        // vanilla click-mode messages are introduced.
        if (!this.sameItems([gu.container.inv, p.inventory], [nextContainer, nextPlayer])) { this.sendContainer(gu, true); this.send(gu.id, { t: 'self', mode: p.gameMode, creativeRev: gu.creativeRev, state: this.playerState(p) }); break; }
        gu.container.inv.deserialize(m.slots, g.items); p.inventory.deserialize(m.player, g.items);
        gu.container.inv.onChange?.(); p.inventory.onChange?.();
        const c = w.chunkAt(gu.container.x, gu.container.z); if (c) c.modified = true;
        for (const other of this.guests.values()) if (other !== gu && other.container && other.container.x === gu.container.x && other.container.y === gu.container.y && other.container.z === gu.container.z) this.sendContainer(other, false);
        break;
      }
      case 'craft': this.remoteCraft(gu, m.id, m.all); break;
      case 'schemPaste': {
        if (!(this.opts.cheats || p.cheats)) { this.send(gu.id, { t: 'chat', text: '§cYou are not allowed to paste schematics here' }); break; }
        if (!isSchematic(m.data)) { this.send(gu.id, { t: 'chat', text: '§cThat schematic could not be read' }); break; }
        const n = pasteSchematic(g, m.data, [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)], Number(m.rot) || 0);
        this.send(gu.id, { t: 'chat', text: `Pasted "${m.data.name}" (${n.toLocaleString()} blocks)` });
        break;
      }
      case 'trade': {
        const mob = g.entities.find((x) => x.id === m.id);
        if (!(mob instanceof Mob) || gu.trading !== mob.id || mob.removed || mob.distSq(p.x, p.y, p.z) > 64) break;
        const t = mob.ensureTrades()[m.i | 0];
        if (!t || t.uses >= t.maxUses) break;
        const inv = p.inventory;
        if (inv.count(t.a) < t.ac || (t.b && inv.count(t.b) < t.bc!)) break;
        const item = g.items.get(t.r); if (!item) break;
        inv.remove(t.a, t.ac); if (t.b) inv.remove(t.b, t.bc!);
        p.give(new ItemStack(item, t.rc, 0, t.ench ? t.ench.map((e) => ({ ...e })) : [], null, t.extra ? { ...t.extra } : {}));
        mob.onTraded(t);
        g.sounds.playAt('entity.villager.yes', mob.x, mob.y, mob.z, 1, 1);
        g.spawnXp(p.x, p.y + 0.5, p.z, 3 + Math.floor(Math.random() * 4));
        gu.inventoryDirty = true;
        this.send(gu.id, { t: 'tradeUpd', id: mob.id, trades: mob.trades, level: mob.villagerLevel, xp: mob.villagerXp });
        break;
      }
      case 'close': {
        gu.trading = null;
        if (gu.container) { gu.container.onClose?.(); gu.container = null; }
        for (const stack of [...gu.crafting.slots, ...gu.cursor.slots]) if (stack) { const copy = stack.clone(); if (p.inventory.add(copy) > 0) g.dropItem(p.x, p.y + 0.5, p.z, copy); }
        gu.craftingSize = 2; gu.crafting = new Inventory(4); gu.cursor = new Inventory(1); gu.inventoryRevision++;
        break;
      }
      case 'respawn': {
        if (p.health <= 0 || p.isDead) {
          let spawn = p.spawnPos;
          if (spawn && !p.spawnForced) {
            const state = w.getBlock(spawn[0], spawn[1], spawn[2]);
            if (!state || !reg.nameOf(state).endsWith('_bed')) spawn = null;
          }
          const target = spawn ?? g.worldSpawn;
          p.health = p.maxHealth; p.isDead = false; p.removed = false; p.deathTime = 0;
          p.foodLevel = 20; p.saturation = 5; p.exhaustion = 0; p.fireTicks = 0; p.effects = []; p.absorption = 0; p.air = 300; p.fallDistance = 0; p.vx = p.vy = p.vz = 0;
          // vanilla: no usable bed in this dimension means respawning at the Overworld spawn
          if (!spawn && p.world.dimension !== 'overworld') void g.travelRemotePlayer(p, 'overworld', [target[0] + 0.5, target[1], target[2] + 0.5]);
          else p.setPos(target[0] + 0.5, target[1], target[2] + 0.5);
          gu.inventoryDirty = true;
        }
        break;
      }
      case 'sleep': { p.sleeping = !!m.sleeping; if (!p.sleeping) p.sleepTimer = 0; break; }
      case 'xp': { const e = g.entities.find((x) => x.id === m.id); if (e instanceof ExperienceOrb && !e.removed && e.distSq(p.x, p.y + 0.9, p.z) <= 2.25) { p.addXp(e.value); this.send(gu.id, { t: 'givexp', v: e.value }); e.remove(); } break; }
      case 'spawn': this.remoteSpawn(gu, m); break;
      case 'boatInput': { const b = p.vehicle; if (b instanceof BoatEntity && b.passengerIndex(p) === 0) { b.inputUp = !!m.up; b.inputDown = !!m.down; b.inputLeft = !!m.left; b.inputRight = !!m.right; } break; }
      case 'dismount': { const b = p.vehicle; if (b instanceof BoatEntity) b.ejectPassenger(p); else if (b) p.stopRiding(); break; }
      case 'dimready': { gu.known.clear(); gu.chunks.clear(); gu.wantChunks.clear(); gu.chunksInFlight = 0; gu.inventoryDirty = true; break; }
      case 'ping': { if (Number.isFinite(m.ping)) p.ping = Math.max(0, Math.min(9999, Math.round(m.ping))); this.send(gu.id, { t: 'pong', time: m.time }); break; }
    }
  }

  /** A guest throws a stack out of its window (Q, or a click outside the inventory). The stack has to exist in the
   *  guest's cursor, inventory, offhand or crafting grid; it is removed there and thrown by the authoritative copy. */
  private remoteThrow(gu: Guest, m: any): void {
    const g = this.game, p = gu.player;
    const st = m.stack ? ItemStack.deserialize(m.stack, g.items) : null;
    const wanted = st ? serializedStackIdentity(st.serialize()) : null;
    if (!st || !wanted) return;
    const take = (inv: Inventory): boolean => {
      for (let i = 0; i < inv.size; i++) {
        const slot = inv.slots[i];
        if (!slot || slot.count < wanted.count) continue;
        const id = serializedStackIdentity(slot.serialize());
        if (!id || id.key !== wanted.key) continue;
        slot.count -= wanted.count;
        if (slot.count <= 0) inv.slots[i] = null;
        return true;
      }
      return false;
    };
    const held = p.inventory.slots[p.selectedSlot];
    const fromHeld = !!held && held.count >= wanted.count && serializedStackIdentity(held.serialize())?.key === wanted.key;
    if (fromHeld) { held!.count -= wanted.count; if (held!.count <= 0) p.inventory.slots[p.selectedSlot] = null; }
    else if (!take(gu.cursor) && !take(p.inventory) && !take(p.offhand) && !take(gu.crafting)) { if (gu.container) this.sendContainerState(gu); else this.sendInventoryState(gu); return; }
    p.inventory.onChange?.();
    p.throwItem(st);
    gu.inventoryRevision++;
    if (gu.container) this.sendContainerState(gu, true); else this.sendInventoryState(gu, true);
  }

  /** Projectiles / spawn-egg mobs created by a guest. */
  private remoteSpawn(gu: Guest, m: any): void {
    const g = this.game, p = gu.player;
    const held = p.heldItem(), heldName = held?.item.name ?? '';
    let e: Entity | null = null;
    if (m.kind === 'arrow') {
      if (!['bow', 'crossbow', 'trident'].includes(heldName)) return;
      if (heldName !== 'trident' && !p.isCreative) {
        const arrow = ['arrow', 'spectral_arrow', 'tipped_arrow'].find((name) => p.inventory.count(name) + p.offhand.count(name) > 0);
        if (!arrow) return;
        if ((held?.enchantLevel('infinity') ?? 0) === 0) { if (!p.offhand.remove(arrow, 1)) p.inventory.remove(arrow, 1); }
      }
      const a = new ArrowEntity(p, 2, 'normal');
      if (heldName === 'trident' && held) { (a as any).trident = held.clone(); (a as any).trident.count = 1; (a as any).type = 'trident'; if (!p.isCreative) p.inventory.slots[p.selectedSlot] = null; }
      e = a;
    }
    else if (m.kind === 'thrown') {
      const kind = String(m.extra?.tkind ?? '');
      const allowed = new Set(['snowball', 'egg', 'ender_pearl', 'experience_bottle', 'splash_potion', 'lingering_potion', 'ender_eye']);
      if (!allowed.has(kind) || heldName !== kind || !held) return;
      const stack = held.clone(); stack.count = 1;
      if (kind === 'ender_eye') { if (g.world.dimension !== 'overworld') return; const eye = new EyeOfEnderEntity(p, stack); eye.setPos(p.x, p.y + p.height * 0.5, p.z); const [sx, sz] = nearestStronghold(g.world.seed, p.x, p.z); eye.signalTo(sx, p.y, sz); e = eye; }
      else e = new ThrownProjectile(kind, p, stack);
      if (!p.isCreative && --held.count <= 0) p.inventory.slots[p.selectedSlot] = null;
    }
    else if (m.kind === 'mob') return; // spawn eggs are handled by authoritative useBlock; never accept a mob description
    else if (m.kind === 'boat') {
      if (!held || (!heldName.endsWith('_boat') && !heldName.endsWith('_raft'))) return;
      const wood = heldName.replace(/_chest_(boat|raft)$/, '').replace(/_(boat|raft)$/, '');
      const b = new BoatEntity(wood, heldName.includes('_chest_')); b.setPos(p.x, p.y, p.z); b.yaw = p.yaw;
      if (g.entities.some((x) => !x.removed && x !== p && x.bb.intersects(b.bb))) return;
      g.addEntity(b); if (!p.isCreative && --held.count <= 0) p.inventory.slots[p.selectedSlot] = null;
      this.send(gu.id, { t: 'self', mode: p.gameMode, creativeRev: gu.creativeRev, state: this.playerState(p) }); return;
    }
    if (!e) return;
    const v = Array.isArray(m.v) && m.v.length === 3 && m.v.every(Number.isFinite) ? m.v : [0, 0, 0];
    const speed = Math.hypot(v[0], v[1], v[2]), scale = speed > 3.2 ? 3.2 / speed : 1;
    if (e instanceof EyeOfEnderEntity) { g.addEntity(e); return; }
    e.setPos(p.x, p.eyeY - 0.1, p.z); e.vx = v[0] * scale; e.vy = v[1] * scale; e.vz = v[2] * scale; e.yaw = p.yaw; e.pitch = p.pitch;
    g.addEntity(e);
    this.send(gu.id, { t: 'self', mode: p.gameMode, creativeRev: gu.creativeRev, state: this.playerState(p) });
  }

  private chat(gu: Guest, text: string): void {
    const g = this.game;
    if (text.startsWith('/')) {
      // vanilla IntegratedServer.publishServer: "Allow Cheats" makes every player on the shared world an operator
      runCommand(g, text, gu.player, (t) => this.send(gu.id, { t: 'chat', text: t }), this.opts.cheats || gu.player.cheats);
      return;
    }
    const line = `<${gu.name}> ${text}`;
    g.gui.addChat(line);
    for (const other of this.guests.values()) if (other !== gu) this.send(other.id, { t: 'chat', text: line }); // the sender already echoed it
  }

  /** vanilla ServerLevel sleep handling: everyone in bed (SleepStatus) for 100 ticks skips the night and clears the
   *  weather; the "x/y players sleeping" / "Sleeping through this night" status goes to every player's action bar. */
  checkSleep(): void {
    const g = this.game;
    // vanilla counts the players of the Overworld (beds explode anywhere else)
    const all = [...(g.current.dim === 'overworld' ? [g.player] : []), ...[...this.guests.values()].filter((x) => x.dim === 'overworld').map((x) => x.player)];
    if (!all.length) return;
    const sleeping = all.filter((p) => p.sleeping).length;
    const announce = sleeping === 0 ? '' : sleeping === all.length ? 'all' : `${sleeping}/${all.length}`;
    if (announce !== this.sleepAnnounced) {
      this.sleepAnnounced = announce;
      if (announce) {
        const lang = g.assets.lang;
        const text = announce === 'all' ? (lang['sleep.skipping_night'] ?? 'Sleeping through this night') : (lang['sleep.players_sleeping'] ?? '%s/%s players sleeping').replace('%s', String(sleeping)).replace('%s', String(all.length));
        g.gui.showActionBar(text);
        this.broadcast({ t: 'actionbar', text });
      }
    }
    if (sleeping === all.length && all.every((p) => p.sleepTimer >= 100)) {
      if (g.rules.doDaylightCycle !== false) g.world.dayTime = Math.floor(g.world.dayTime / 24000) * 24000 + 24000;
      if (g.rules.doWeatherCycle !== false) { g.weather.raining = false; g.weather.thundering = false; }
      g.player.wakeUp(); g.gui.sleepFade = 0;
      for (const p of all) { p.sleeping = false; p.sleepTimer = 0; }
      this.broadcast({ t: 'wake' });
    }
  }

  /** Run a block interaction for a guest with the GUI redirected to the guest. */
  private remoteUse(gu: Guest, m: any): void {
    const g = this.game, p = gu.player, w = g.world;
    const { x, y, z, face, hit } = m;
    if (!w.isLoaded(x, z) || p.distSq(x, y, z) > 64 || !Number.isInteger(face) || !Array.isArray(hit) || hit.length !== 3 || !hit.every(Number.isFinite)) return;
    const state = w.getBlock(x, y, z);
    // A creative inventory is intentionally unbounded, so the selected stack must accompany the action.
    // Survival/adventure stacks remain authoritative on the host.
    if (p.isCreative) {
      const held = m.held ? ItemStack.deserialize(m.held, g.items) : null;
      if (!held || held.count > 0) p.inventory.slots[p.selectedSlot] = held;
    }
    const realGui = g.gui;
    const self = this;
    const opened: any[] = [];
    const proxy: any = new Proxy(realGui, {
      get(t, k) {
        if (k === 'openContainer') return (inv: Inventory, titleKey: string, rows: number, onClose?: () => void, cols = 9) => { opened.push({ kind: 'container', inv, titleKey, rows, cols, onClose }); };
        if (k === 'openFurnace') return (be: any, kind: string) => opened.push({ kind: 'furnace', be, fkind: kind });
        if (k === 'openBrewing') return (be: any) => opened.push({ kind: 'brewing', be });
        if (k === 'openCrafting') return () => opened.push({ kind: 'crafting' });
        if (k === 'openStonecutter') return () => opened.push({ kind: 'stonecutter' });
        if (k === 'openAnvil') return () => opened.push({ kind: 'anvil' });
        if (k === 'openSmithing') return () => opened.push({ kind: 'smithing' });
        if (k === 'openGrindstone') return () => opened.push({ kind: 'grindstone' });
        if (k === 'openEnchanting') return () => opened.push({ kind: 'enchanting', x, y, z });
        if (k === 'showActionBar') return (text: string) => self.send(gu.id, { t: 'actionbar', text });
        if (k === 'addChat') return (text: string) => self.send(gu.id, { t: 'chat', text });
        if (k === 'open' || k === 'close' || k === 'openTrading' || k === 'showTitle') return () => {};
        return (t as any)[k];
      },
    });
    (g as any).gui = proxy;
    try { p.use({ x, y, z, face, hx: hit[0], hy: hit[1], hz: hit[2], t: Math.sqrt(p.distSq(x + hit[0], y + hit[1], z + hit[2])), state }); }
    finally { (g as any).gui = realGui; }
    for (const o of opened) {
      if (o.kind === 'container') { if (gu.container) gu.container.onClose?.(); gu.container = { x, y, z, inv: o.inv, onClose: o.onClose }; this.send(gu.id, { t: 'open', kind: 'container', x, y, z, title: o.titleKey, rows: o.rows, cols: o.cols, slots: o.inv.serialize() }); }
      else if (o.kind === 'furnace' || o.kind === 'brewing') { if (gu.container) gu.container.onClose?.(); gu.container = { x, y, z, inv: o.be.inventory, be: o.be }; this.send(gu.id, { t: 'open', kind: o.kind, fkind: o.fkind, x, y, z, slots: o.be.inventory.serialize(), be: this.beState(o.be) }); }
      else { if (o.kind === 'crafting') { gu.craftingSize = 3; gu.crafting = new Inventory(9); gu.cursor = new Inventory(1); } this.send(gu.id, { t: 'open', kind: o.kind, x, y, z }); }
    }
  }
  private beState(be: any): any { return { burnTime: be.burnTime ?? 0, burnTotal: be.burnTotal ?? 0, cookTime: be.cookTime ?? 0, cookTotal: be.cookTotal ?? 200, xp: be.xp ?? 0, brewTime: be.brewTime ?? 0, fuel: be.fuel ?? 0 }; }
  private playerState(p: RemotePlayer): any {
    return {
      inventory: p.inventory.serialize(), armor: p.armor.serialize(), offhand: p.offhand.serialize(),
      selectedSlot: p.selectedSlot, health: p.health, absorption: p.absorption,
      foodLevel: p.foodLevel, saturation: p.saturation, exhaustion: p.exhaustion,
      xpLevel: p.xpLevel, xpProgress: p.xpProgress, totalXp: p.totalXp,
    };
  }
  private sameItems(before: Inventory[], after: Inventory[]): boolean {
    const count = (inventories: Inventory[]): Map<string, number> | null => {
      const totals = new Map<string, number>();
      for (const inv of inventories) for (const stack of inv.slots) {
        if (!stack) continue;
        if (!Number.isInteger(stack.count) || stack.count <= 0 || stack.count > stack.item.stackSize) return null;
        const identity = serializedStackIdentity(stack.serialize());
        if (!identity) return null;
        totals.set(identity.key, (totals.get(identity.key) ?? 0) + identity.count);
      }
      return totals;
    };
    const a = count(before), b = count(after);
    if (!a || !b || a.size !== b.size) return false;
    for (const [key, amount] of a) if (b.get(key) !== amount) return false;
    return true;
  }
  private inventoryTransaction(gu: Guest, m: any): void {
    const g = this.game, p = gu.player;
    if (m.rev !== gu.inventoryRevision || m.gridSize !== gu.crafting.size) { this.sendInventoryState(gu); return; }
    const inventory = new Inventory(p.inventory.size), armor = new Inventory(p.armor.size), offhand = new Inventory(p.offhand.size);
    const grid = new Inventory(gu.crafting.size), cursor = new Inventory(1);
    inventory.deserialize(m.inventory, g.items); armor.deserialize(m.armor, g.items); offhand.deserialize(m.offhand, g.items);
    grid.deserialize(m.grid, g.items); cursor.deserialize([m.cursor], g.items);
    if (!this.sameItems([p.inventory, p.armor, p.offhand, gu.crafting, gu.cursor], [inventory, armor, offhand, grid, cursor])) { this.sendInventoryState(gu); return; }
    p.inventory.deserialize(m.inventory, g.items); p.armor.deserialize(m.armor, g.items); p.offhand.deserialize(m.offhand, g.items);
    gu.crafting.deserialize(m.grid, g.items); gu.cursor.deserialize([m.cursor], g.items);
    gu.inventoryRevision++;
    this.sendInventoryState(gu, true);
  }
  private sendInventoryState(gu: Guest, accepted = false): void {
    const p = gu.player;
    this.send(gu.id, { t: 'invState', rev: gu.inventoryRevision, accepted, inventory: p.inventory.serialize(), armor: p.armor.serialize(), offhand: p.offhand.serialize(), grid: gu.crafting.serialize(), cursor: gu.cursor.get(0)?.serialize() ?? null });
  }
  private containerTransaction(gu: Guest, m: any): void {
    const g = this.game, p = gu.player, open = gu.container;
    if (!open || m.rev !== gu.inventoryRevision) { this.sendContainerState(gu); return; }
    const container = new Inventory(open.inv.size), inventory = new Inventory(p.inventory.size), armor = new Inventory(p.armor.size), offhand = new Inventory(p.offhand.size), cursor = new Inventory(1);
    container.deserialize(m.slots, g.items); inventory.deserialize(m.inventory, g.items); armor.deserialize(m.armor, g.items); offhand.deserialize(m.offhand, g.items); cursor.deserialize([m.cursor], g.items);
    if (!this.sameItems([open.inv, p.inventory, p.armor, p.offhand, gu.cursor], [container, inventory, armor, offhand, cursor])) { this.sendContainerState(gu); return; }
    open.inv.deserialize(m.slots, g.items); p.inventory.deserialize(m.inventory, g.items); p.armor.deserialize(m.armor, g.items); p.offhand.deserialize(m.offhand, g.items); gu.cursor.deserialize([m.cursor], g.items);
    open.inv.onChange?.(); gu.inventoryRevision++;
    this.sendContainerState(gu, true);
  }
  private sendContainerState(gu: Guest, accepted = false): void {
    const p = gu.player, open = gu.container;
    if (!open) { this.sendInventoryState(gu); return; }
    this.send(gu.id, { t: 'windowState', rev: gu.inventoryRevision, accepted, slots: open.inv.serialize(), inventory: p.inventory.serialize(), armor: p.armor.serialize(), offhand: p.offhand.serialize(), cursor: gu.cursor.get(0)?.serialize() ?? null });
  }
  /** Craft from the authoritative window grid; output is placed on the cursor or shift-moved to inventory. */
  private remoteCraft(gu: Guest, id: string, all: boolean): void {
    const g = this.game, p = gu.player;
    const limit = all ? 64 : 1;
    let made = 0;
    for (let crafted = 0; crafted < limit; crafted++) {
      const recipe = g.recipes.match(gu.crafting.slots, gu.craftingSize, gu.craftingSize);
      if (!recipe || recipe.id !== id) break;
      const out = g.recipes.craftResult(recipe, gu.crafting.slots);
      if (!all) {
        const cursor = gu.cursor.get(0);
        if (cursor && (!cursor.canStackWith(out) || cursor.count + out.count > cursor.maxStack)) break;
      }
      for (let i = 0; i < gu.crafting.size; i++) {
        const stack = gu.crafting.slots[i];
        if (!stack) continue;
        const remainder = g.recipes.remainder(stack);
        if (--stack.count <= 0) gu.crafting.slots[i] = remainder;
        else if (remainder && p.inventory.add(remainder) > 0) g.dropItem(p.x, p.y + 0.5, p.z, remainder);
      }
      if (all) { if (p.inventory.add(out) > 0) { g.dropItem(p.x, p.y + 0.5, p.z, out); made++; break; } }
      else { const cursor = gu.cursor.get(0); if (cursor) cursor.count += out.count; else gu.cursor.set(0, out); }
      made++;
    }
    if (made) gu.inventoryRevision++;
    this.sendInventoryState(gu);
  }
  private sendContainer(gu: Guest, _force: boolean): void {
    const c = gu.container!;
    this.send(gu.id, { t: 'contUpd', x: c.x, y: c.y, z: c.z, slots: c.inv.serialize(), be: c.be ? this.beState(c.be) : undefined });
  }

  // ---- chunk streaming ----
  /** Stream requested chunks with end-to-end flow control: at most MAX_CHUNKS_IN_FLIGHT unacknowledged chunk frames
   *  per guest, and none while our own socket is backed up — otherwise a slow link queues megabytes of chunk data in
   *  front of movement and entity updates and the guest sees everything seconds late (vanilla paces chunk sending too). */
  private streamChunks(gu: Guest): void {
    const g = this.game;
    const world = g.dims.get(gu.dim)?.world; if (!world) return;
    if (!this.ws || this.ws.bufferedAmount > MAX_SOCKET_BACKLOG) return;
    let sent = 0;
    for (const key of gu.wantChunks) {
      if (gu.chunksInFlight >= MAX_CHUNKS_IN_FLIGHT || this.ws.bufferedAmount > MAX_SOCKET_BACKLOG) break;
      const c = world.chunks.get(key);
      if (!c) continue;
      gu.wantChunks.delete(key);
      if (gu.chunks.has(key)) continue;
      this.sendChunk(gu, c);
      gu.chunksInFlight++;
      if (++sent >= 6) break;
    }
  }
  private sendChunk(gu: Guest, c: Chunk): void {
    const { header, body } = encodeChunk(c, gu.dim);
    this.sendBinary(gu.id, packFrame(FRAME_CHUNK, header, body));
    gu.chunks.add(chunkKeyOf(c.cx, c.cz));
  }
  /** Positions a dimension's chunk manager should keep loaded (the guests in it). */
  extraCenters(dim: Dimension): { x: number; z: number }[] { return [...this.guests.values()].filter((gu) => gu.dim === dim).map((gu) => ({ x: gu.player.x, z: gu.player.z })); }
  onChunkUnloaded(c: Chunk, dim: Dimension): void { const k = chunkKeyOf(c.cx, c.cz); for (const gu of this.guests.values()) if (gu.dim === dim) gu.chunks.delete(k); }

  // ---- pickups for remote players ----
  private pickups(gu: Guest): void {
    const g = this.game, p = gu.player;
    if (p.health <= 0 || p.isSpectator) return;
    for (const e of g.entities) {
      if (e.removed) continue;
      if (e instanceof ItemEntity) {
        if (e.pickupDelay > 0 || e.age < 10) continue;
        if (e.distSq(p.x, p.y + 0.9, p.z) > 1.8) continue;
        const offered = e.stack.count;
        const incoming = e.stack.clone();
        const left = p.inventory.add(incoming);
        const accepted = offered - left;
        if (accepted <= 0) continue;
        const picked = e.stack.clone(); picked.count = accepted;
        this.send(gu.id, { t: 'give', stack: picked.serialize(), x: e.x, y: e.y, z: e.z });
        if (left > 0) e.stack.count = left; else e.remove();
      } else if (e instanceof ExperienceOrb) {
        if (e.distSq(p.x, p.y + 0.9, p.z) > 1.5) continue;
        p.addXp(e.value); this.send(gu.id, { t: 'givexp', v: e.value }); e.remove();
      }
    }
  }

  // ---- entity snapshots ----
  private sendEntities(includeWorld: boolean): void {
    const g = this.game;
    for (const gu of this.guests.values()) {
      if (!gu.ready) continue;
      const inst = g.dims.get(gu.dim); if (!inst) continue;
      const list = inst === g.bound ? g.entities : inst.entities;
      const p = gu.player;
      const ents: any[] = [], rm: number[] = [];
      const seen = new Set<number>();
      const R2 = 96 * 96;
      // host player as an entity, when it is in the same dimension
      const hp = g.player;
      if (g.current === inst) {
        const hostBoat = hp.vehicle instanceof BoatEntity ? hp.vehicle : null;
        const hostSnap: any = { i: -1, pid: -1, t: 'player', x: r3(hp.x), y: r3(hp.y), z: r3(hp.z), yaw: r1(hp.yaw), pitch: r1(hp.pitch), sneak: hp.isSneaking, sprint: hp.isSprinting, swim: hp.swimmingPose, sleep: hp.sleeping, fly: hp.flying, hurt: hp.hurtTime > 0, dead: hp.health <= 0, swing: hp.swinging && hp.swingTime <= 1, use: !!hp.usingItem, mode: hp.gameMode, vid: hp.vehicle ? this.netId(hp.vehicle) : null, seat: hostBoat?.passengerIndex(hp) ?? -1, br: hp.breaking ? { x: hp.breaking.x, y: hp.breaking.y, z: hp.breaking.z, stage: hp.breakStage, state: hp.breaking.state } : null };
        if (!gu.known.has(-1)) { hostSnap.full = { name: this.hostName, skin: g.options.skin }; gu.known.add(-1); }
        if (this.ticks % 10 === 0) hostSnap.held = hp.heldItem()?.serialize() ?? null, hostSnap.armor = hp.armor.serialize();
        ents.push(hostSnap); seen.add(-1);
      } else if (gu.known.has(-1)) { rm.push(-1); gu.known.delete(-1); }
      for (const e of list) {
        if (e.removed) continue;
        if (e === p) continue;
        if (!includeWorld && !(e instanceof RemotePlayer)) continue;
        if (e.distSq(p.x, p.y, p.z) > R2) continue;
        const s = this.snapshot(e, gu);
        if (!s) continue;
        ents.push(s); seen.add(e.id);
      }
      if (includeWorld) {
        for (const k of gu.known) if (!seen.has(k) && k !== -1) rm.push(k);
        for (const k of rm) gu.known.delete(k);
      }
      // guests only ever see the entities of their own dimension; the copies of players elsewhere are not sent
      // several small messages rather than one huge one: the relay caps message sizes and a single JSON blob
      // for hundreds of entities stalls the guest's frame
      for (let i = 0; i < ents.length || (i === 0 && rm.length); i += 80) this.send(gu.id, { t: 'ent', e: ents.slice(i, i + 80), rm: i === 0 ? rm : [] });
    }
  }
  private snapshot(e: Entity, gu: Guest): any | null {
    const first = !gu.known.has(e.id);
    const s: any = { i: e.id, x: r3(e.x), y: r3(e.y), z: r3(e.z), yaw: r1(e.yaw), pitch: r1(e.pitch) };
    if (e instanceof RemotePlayer) {
      const boat = e.vehicle instanceof BoatEntity ? e.vehicle : null;
      s.t = 'player'; s.pid = e.clientId; s.sneak = e.isSneaking; s.sprint = e.isSprinting; s.swim = e.swimmingPose; s.sleep = e.sleeping; s.fly = e.flying; s.hurt = e.hurtTime > 0; s.dead = e.health <= 0; s.swing = e.swinging && e.swingTime <= 1; s.mode = e.gameMode; s.use = !!e.usingItem; s.vid = e.vehicle ? this.netId(e.vehicle) : null; s.seat = boat?.passengerIndex(e) ?? -1; s.br = e.breaking ? { x: e.breaking.x, y: e.breaking.y, z: e.breaking.z, stage: e.breakStage, state: e.breaking.state } : null;
      if (first) s.full = { name: e.name, skin: e.skin };
      if (this.ticks % 10 === 0 || first) { s.held = e.heldItem()?.serialize() ?? null; s.armor = e.armor.serialize(); }
    } else if (e instanceof Mob) {
      s.t = e.type; s.hy = r1(e.headYaw); s.by = r1(e.bodyYaw); s.h = r1(e.health); s.hurt = e.hurtTime > 0; s.dt = e.deathTime; s.swing = e.swinging && e.swingTime <= 1; s.og = e.onGround; s.vid = e.vehicle ? this.netId(e.vehicle) : null;
      s.ex = { baby: e.isBaby, sheared: e.sheared, wool: e.woolColor, tamed: e.tamed, sit: e.sitting, swell: e.swell, anger: e.angerTicks > 0, size: e.slimeSize, variant: e.variant, charged: e.charged, name: (e as any).customName, eat: e.eatTimer, scream: e.screaming, carried: e.carriedBlock, attack: e.attackAnim, saddled: e.saddled, prof: e.isVillager || e.isZombieVillager ? e.profession : undefined, vtype: e.villagerType, vlevel: e.villagerLevel, curing: e.conversionTime > 0 || undefined };
      if (first) s.full = { type: e.type };
    } else if (e instanceof ItemEntity) { s.t = 'item'; if (first) s.full = { stack: e.stack.serialize() }; else if (this.ticks % 20 === 0) s.stack = e.stack.serialize(); }
    else if (e instanceof ExperienceOrb) { s.t = 'xp'; if (first) s.full = { value: e.value }; }
    else if (e instanceof FallingBlockEntity) { s.t = 'falling_block'; if (first) s.full = { state: e.blockState }; }
    else if (e instanceof PrimedTnt) { s.t = 'tnt'; s.fuse = e.fuse; }
    else if (e instanceof BoatEntity) { s.t = 'boat'; s.pl = e.paddleLeft; s.pr = e.paddleRight; s.dmg = e.damage; if (first) s.full = { wood: e.wood, chest: e.chest }; }
    else if (e instanceof ArrowEntity) { s.t = 'arrow'; s.ig = e.inGround; s.vx = r3(e.vx); s.vy = r3(e.vy); s.vz = r3(e.vz); if (first) s.full = { kind: (e as any).kind, trident: (e as any).trident?.serialize?.() }; }
    else if (e instanceof ThrownProjectile) { s.t = 'thrown'; if (first) s.full = { kind: e.kind, stack: e.stack?.serialize() ?? null }; }
    else return null;
    if (first) gu.known.add(e.id);
    return s;
  }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r1 = (v: number) => Math.round(v * 10) / 10;
function chunkKeyOf(cx: number, cz: number): number { return ((cx + 0x8000) << 16) | ((cz + 0x8000) & 0xffff); }
