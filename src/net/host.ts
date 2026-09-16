// Host side of multiplayer: the browser running the world registers with the relay and serves guests.
// The host is authoritative for the world and every guest player. Guests send predicted movement and gameplay
// intentions; the host validates them and sends corrections/state back. The player who opened the world remains
// trusted as its owner, matching vanilla's integrated-server model.
import type { Game } from '../game/game';
import { RemotePlayer } from '../entity/remotePlayer';
import { Entity, LivingEntity, ItemEntity, ExperienceOrb } from '../entity/entity';
import { Mob } from '../entity/mobs';
import { BoatEntity } from '../entity/boat';
import { ArrowEntity, FallingBlockEntity, PrimedTnt, ThrownProjectile } from '../entity/misc';
import { Inventory, ItemStack } from '../items/stack';
import type { WorldListener } from '../world/world';
import { encodeChunk, packFrame, FRAME_CHUNK, PROTOCOL_VERSION, TARGET_SERVER, defaultRelayUrl, isGuestMessage } from './protocol';
import type { Chunk } from '../world/chunk';

interface Guest {
  id: number; playerId: string; name: string; player: RemotePlayer;
  known: Set<number>;            // entity ids the guest has full info for
  chunks: Set<number>;           // chunk keys sent
  wantChunks: Set<number>;       // requested but not yet loaded
  container: { x: number; y: number; z: number; inv: Inventory; onClose?: () => void; be?: any } | null;
  ready: boolean;
  ridingSent?: boolean;
  lastMoveTick: number;
  movementViolations: number;
}

export interface HostOptions {
  name: string; motd: string; gameMode: string; cheats: boolean; maxPlayers: number; relayUrl?: string;
  /** '' = public (anyone may join), otherwise the password guests must enter */
  password?: string;
  /** true when coordinating live simulation for the backend-owned public world */
  official?: boolean;
}

export class NetHost implements WorldListener {
  ws: WebSocket | null = null;
  serverId = '';
  guests = new Map<number, Guest>();
  status = 'connecting';
  isPublic = true; official = false;
  /** chunks changed since the last upload of the public world (key -> [cx, cz]) */
  private dirtyChunks = new Map<number, [number, number]>();
  private blockBatch: number[] = [];
  private queue: any[] = [];
  private soundOrigin = 0;
  private ticks = 0;
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
    g.world.listeners.push(this);
    g.sounds.onSound = (event, x, y, z, volume, pitch, attenuate) => this.broadcast({ t: 'snd', e: event, x, y, z, v: volume, p: pitch, a: attenuate, o: this.soundOrigin });
    g.sounds.onMusic = (name, kind, volume) => this.broadcast({ t: 'music', name, kind, v: volume });
    g.sounds.onRecord = (disc, x, y, z) => this.broadcast({ t: 'record', disc, x, y, z });
  }
  private detach(): void {
    const g = this.game;
    if (g.world) g.world.listeners = g.world.listeners.filter((l) => l !== this);
    g.sounds.onSound = null; g.sounds.onMusic = null; g.sounds.onRecord = null;
    for (const gu of this.guests.values()) gu.player.remove();
    this.guests.clear();
  }

  /** World changed dimension (host travelled): guests stay behind, so tell them and drop them. */
  onDimensionChanged(): void { for (const gu of this.guests.values()) this.send(gu.id, { t: 'kicked', reason: 'The host travelled to another dimension.' }); this.detach(); this.game.world.listeners.push(this); this.attach(); }

  send(to: number, m: any): void { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'msg', to, d: m })); }
  broadcast(m: any): void { if (this.guests.size) this.send(0, m); }
  private sendBinary(to: number, payload: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    const out = new Uint8Array(4 + payload.length); new DataView(out.buffer).setUint32(0, to, true); out.set(payload, 4); this.ws.send(out);
  }

  // ---- world listener ----
  onBlockChanged(x: number, y: number, z: number, _old: number, s: number): void {
    this.blockBatch.push(x, y, z, s);
    if (this.official) { const cx = x >> 4, cz = z >> 4; this.dirtyChunks.set(((cx + 0x8000) << 16) | ((cz + 0x8000) & 0xffff), [cx, cz]); }
  }

  /** Public world: push changed chunks and world meta to the backend so it survives us leaving. */
  private uploadWorld(): void {
    const g = this.game;
    if (!this.ws || this.ws.readyState !== 1) return;
    let sent = 0;
    for (const [key, [cx, cz]] of this.dirtyChunks) {
      const c = g.world.getChunk(cx, cz);
      this.dirtyChunks.delete(key);
      if (!c) continue;
      const { header, body } = encodeChunk(c, g.world.dimension);
      const payload = packFrame(FRAME_CHUNK, header, body);
      const out = new Uint8Array(4 + payload.length);
      new DataView(out.buffer).setUint32(0, TARGET_SERVER, true); out.set(payload, 4);
      this.ws.send(out);
      if (++sent >= 8) break;   // trickle: at most 8 chunks per upload tick
    }
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
    if (this.blockBatch.length) { this.broadcast({ t: 'blk', b: this.blockBatch }); this.blockBatch = []; }
    for (const gu of this.guests.values()) {
      if (!gu.ready) continue;
      if (gu.ridingSent && (!gu.player.vehicle || gu.player.vehicle.removed)) { gu.ridingSent = false; gu.player.vehicle = null; this.send(gu.id, { t: 'ride', id: null, x: gu.player.x, y: gu.player.y, z: gu.player.z }); }
      else if (!gu.ridingSent && gu.player.vehicle) gu.ridingSent = true;
      this.streamChunks(gu);
      this.pickups(gu);
      if (gu.container && this.ticks % 5 === 0) this.sendContainer(gu, false);
      if (this.ticks % 20 === 0) this.send(gu.id, { t: 'self', mode: gu.player.gameMode, state: this.playerState(gu.player) });
    }
    if (this.ticks % 2 === 0) this.sendEntities();
    if (this.official && this.ticks % 20 === 0 && this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ t: 'playerState', playerId: g.options.playerId, saved: g.player.serialize() }));
    }
    if (this.official && this.ticks % 100 === 0) this.uploadWorld();
    if (this.ticks % 20 === 0) this.broadcast({ t: 'time', time: g.world.time, day: g.world.dayTime, rain: g.weather.rainLevel, thunder: g.weather.thunderLevel, raining: g.weather.raining, thundering: g.weather.thundering, diff: g.difficulty });
  }

  private processQueue(): void {
    const q = this.queue; this.queue = [];
    for (const m of q) {
      try {
        if (m.t === 'bin') continue; // guests send no binary
        if (m.t === 'guestJoined') this.onJoin(m.from, m.playerId, m.name, m.skin);
        else if (m.t === 'guestLeft') this.onLeave(m.from);
        else if (m.from !== undefined) { const gu = this.guests.get(m.from); if (gu && isGuestMessage(m)) this.onGuestMessage(gu, m); }
      } catch (e) { console.error('host message error', e); }
    }
  }

  private onJoin(id: number, playerId: string, name: string, skin?: string): void {
    const g = this.game;
    playerId = String(playerId || name).slice(0, 80);
    if ([...this.guests.values()].some((x) => x.name === name) || name === this.hostName) { name = name + '_' + id; }
    const p = new RemotePlayer(name);
    p.clientId = id; p.skin = skin === 'alex' ? 'alex' : 'steve';
    p.hurtHandler = (d) => queueMicrotask(() => this.send(id, { t: 'hurt', damage: d.amount, source: d.source, health: p.health, absorption: p.absorption, vx: p.vx, vy: p.vy, vz: p.vz, fire: p.fireTicks, dead: p.health <= 0 }));
    // Stable ids prevent renamed players (or two players with the same display name) sharing inventories.
    // The name fallback migrates saves made by older versions.
    const saved = g.playerData.get(playerId) ?? g.playerData.get(name);
    const spawn = g.worldSpawn ?? [Math.floor(g.player.x), Math.floor(g.player.y), Math.floor(g.player.z)];
    g.addEntity(p);
    if (saved) { try { p.deserialize(saved); } catch { /* reject incompatible legacy state and use spawn */ } }
    p.setPos(saved?.x ?? spawn[0] + 0.5, saved?.y ?? spawn[1], saved?.z ?? spawn[2] + 0.5); p.tx = p.x; p.ty = p.y; p.tz = p.z;
    p.setGameMode(this.opts.gameMode as any);
    const gu: Guest = { id, playerId, name, player: p, known: new Set(), chunks: new Set(), wantChunks: new Set(), container: null, ready: false, lastMoveTick: this.ticks, movementViolations: 0 };
    this.guests.set(id, gu);
    this.send(id, { t: 'welcome', name, hostName: this.official ? this.opts.name : this.hostName, dimension: g.world.dimension, seed: g.world.seed, time: g.world.time, dayTime: g.world.dayTime, spawn, saved: saved ?? null, gameMode: this.opts.gameMode, cheats: this.opts.cheats, difficulty: g.difficulty, rules: g.rules, weather: g.weather.serialize(), version: g.version, protocol: PROTOCOL_VERSION, players: this.playerList(), music: g.sounds.currentMusic() });
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

  playerList(): { name: string; id: number }[] { return [{ name: this.hostName, id: -1 }, ...[...this.guests.values()].map((gu) => ({ name: gu.name, id: gu.id }))]; }

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
        const elapsed = Math.max(1, this.ticks - gu.lastMoveTick);
        gu.lastMoveTick = this.ticks;
        const dx = m.x - p.x, dy = m.y - p.y, dz = m.z - p.z;
        // Vanilla also corrects impossible movement. Keep a generous allowance for latency, knockback and elytra;
        // repeated outliers are ignored and the authoritative position is returned to the guest.
        const max = p.isCreative || p.isSpectator ? 2.5 * elapsed : 1.25 * elapsed;
        if (!p.vehicle && (Math.abs(dy) > max * 2 || dx * dx + dz * dz > max * max)) {
          gu.movementViolations++;
          this.send(gu.id, { t: 'correct', x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch });
          break;
        }
        gu.movementViolations = Math.max(0, gu.movementViolations - 1);
        const slot = Number.isInteger(m.slot) && m.slot >= 0 && m.slot < 9 ? m.slot : p.selectedSlot;
        const safe = { ...m, slot, br: undefined, health: undefined, mode: undefined, dead: undefined, fly: p.isCreative || p.isSpectator ? !!m.fly : false };
        if (p.vehicle) { p.tyaw = m.yaw; p.tpitch = m.pitch; p.applySnapshot({ ...safe, x: p.x, y: p.y, z: p.z }); }
        else p.applySnapshot(safe);
        // The target is only a hint. The host raycasts and advances vanilla mining progress itself, so a guest
        // cannot submit stage 9 immediately or mine through walls.
        const target = m.br && [m.br.x, m.br.y, m.br.z].every(Number.isInteger) ? m.br : null;
        const hit = target ? p.raycast() : null;
        p.continueBreaking(hit && hit.x === target.x && hit.y === target.y && hit.z === target.z ? hit : null);
        break;
      }
      case 'inv': // Creative players may choose any item; survival inventory stays host-authoritative.
        if (p.isCreative) {
          const held = m.held ? ItemStack.deserialize(m.held, g.items) : null;
          if (!held || held.count > 0) p.inventory.slots[p.selectedSlot] = held;
        }
        this.send(gu.id, { t: 'self', mode: p.gameMode, state: this.playerState(p) });
        break;
      case 'chunk': for (const k of m.keys as number[]) gu.wantChunks.add(k); break;
      case 'set': { // Never accept a guest-selected final state or block-entity payload.
        const b = Array.isArray(m.b) ? m.b : [];
        const [x, y, z] = b;
        if ([x, y, z].every(Number.isInteger) && w.isLoaded(x, z)) this.send(gu.id, { t: 'blk', b: [x, y, z, w.getBlock(x, y, z)] });
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
        this.soundOrigin = gu.id;
        try { g.sounds.playAt(m.e, x, y, z, Math.max(0, Math.min(16, m.v)), Math.max(0.25, Math.min(4, m.p)), m.a !== false); }
        finally { this.soundOrigin = 0; }
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
      case 'drop': {
        const held = p.heldItem();
        if (!held) break;
        const requested = Number.isInteger(m.count) ? m.count : Number.isInteger(m.stack?.count) ? m.stack.count : 1;
        const count = Math.max(1, Math.min(held.count, requested));
        const st = held.clone(); st.count = count; held.count -= count;
        if (held.count <= 0) p.inventory.slots[p.selectedSlot] = null;
        const yaw = p.yaw * Math.PI / 180, pitch = p.pitch * Math.PI / 180;
        const speed = 0.3, dir: [number, number, number] = [-Math.sin(yaw) * Math.cos(pitch) * speed, -Math.sin(pitch) * speed + 0.1, Math.cos(yaw) * Math.cos(pitch) * speed];
        const e = g.dropItem(p.x, p.eyeY - 0.3, p.z, st, dir);
        if (e) { e.pickupDelay = 40; e.thrower = p.uuid; }
        this.send(gu.id, { t: 'self', mode: p.gameMode, state: this.playerState(p) });
        break;
      }
      case 'chat': this.chat(gu, String(m.text).slice(0, 256)); break;
      case 'death': break; // Death text and state are produced by the authoritative player simulation.
      case 'cont': {
        if (!gu.container || !Array.isArray(m.slots) || !Array.isArray(m.player)) break;
        const nextContainer = new Inventory(gu.container.inv.size), nextPlayer = new Inventory(p.inventory.size);
        nextContainer.deserialize(m.slots, g.items); nextPlayer.deserialize(m.player, g.items);
        // Transitional transaction validation: moving items is allowed only when the complete multiset across
        // the open menu and player inventory is unchanged. This closes item creation/deletion while explicit
        // vanilla click-mode messages are introduced.
        if (!this.sameItems([gu.container.inv, p.inventory], [nextContainer, nextPlayer])) { this.sendContainer(gu, true); this.send(gu.id, { t: 'self', mode: p.gameMode, state: this.playerState(p) }); break; }
        gu.container.inv.deserialize(m.slots, g.items); p.inventory.deserialize(m.player, g.items);
        gu.container.inv.onChange?.(); p.inventory.onChange?.();
        const c = w.chunkAt(gu.container.x, gu.container.z); if (c) c.modified = true;
        for (const other of this.guests.values()) if (other !== gu && other.container && other.container.x === gu.container.x && other.container.y === gu.container.y && other.container.z === gu.container.z) this.sendContainer(other, false);
        break;
      }
      case 'close': { if (gu.container) { gu.container.onClose?.(); gu.container = null; } break; }
      case 'respawn': { if (p.health <= 0 || p.isDead) { p.health = 20; p.isDead = false; p.deathTime = 0; p.setPos(g.worldSpawn[0] + 0.5, g.worldSpawn[1], g.worldSpawn[2] + 0.5); this.send(gu.id, { t: 'correct', x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch }); } break; }
      case 'sleep': { if (m.sleeping) { p.sleeping = true; } else p.sleeping = false; this.checkSleep(); break; }
      case 'xp': { const e = g.entities.find((x) => x.id === m.id); if (e instanceof ExperienceOrb && !e.removed && e.distSq(p.x, p.y + 0.9, p.z) <= 2.25) { p.addXp(e.value); this.send(gu.id, { t: 'givexp', v: e.value }); e.remove(); } break; }
      case 'spawn': this.remoteSpawn(gu, m); break;
      case 'boatInput': { const b = p.vehicle; if (b instanceof BoatEntity && b.passengerIndex(p) === 0) { b.inputUp = !!m.up; b.inputDown = !!m.down; b.inputLeft = !!m.left; b.inputRight = !!m.right; } break; }
      case 'dismount': { const b = p.vehicle; if (b instanceof BoatEntity) { b.ejectPassenger(p); this.send(gu.id, { t: 'ride', id: null, x: p.x, y: p.y, z: p.z }); } break; }
      case 'ping': this.send(gu.id, { t: 'pong', time: m.time }); break;
    }
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
      const allowed = new Set(['snowball', 'egg', 'ender_pearl', 'experience_bottle', 'splash_potion', 'lingering_potion']);
      if (!allowed.has(kind) || heldName !== kind || !held) return;
      const stack = held.clone(); stack.count = 1;
      e = new ThrownProjectile(kind, p, stack);
      if (!p.isCreative && --held.count <= 0) p.inventory.slots[p.selectedSlot] = null;
    }
    else if (m.kind === 'mob') return; // spawn eggs are handled by authoritative useBlock; never accept a mob description
    else if (m.kind === 'boat') {
      if (!held || (!heldName.endsWith('_boat') && !heldName.endsWith('_raft'))) return;
      const wood = heldName.replace(/_chest_(boat|raft)$/, '').replace(/_(boat|raft)$/, '');
      const b = new BoatEntity(wood, heldName.includes('_chest_')); b.setPos(p.x, p.y, p.z); b.yaw = p.yaw;
      if (g.entities.some((x) => !x.removed && x !== p && x.bb.intersects(b.bb))) return;
      g.addEntity(b); if (!p.isCreative && --held.count <= 0) p.inventory.slots[p.selectedSlot] = null;
      this.send(gu.id, { t: 'self', mode: p.gameMode, state: this.playerState(p) }); return;
    }
    if (!e) return;
    const v = Array.isArray(m.v) && m.v.length === 3 && m.v.every(Number.isFinite) ? m.v : [0, 0, 0];
    const speed = Math.hypot(v[0], v[1], v[2]), scale = speed > 3.2 ? 3.2 / speed : 1;
    e.setPos(p.x, p.eyeY - 0.1, p.z); e.vx = v[0] * scale; e.vy = v[1] * scale; e.vz = v[2] * scale; e.yaw = p.yaw; e.pitch = p.pitch;
    g.addEntity(e);
    this.send(gu.id, { t: 'self', mode: p.gameMode, state: this.playerState(p) });
  }
  allSleeping(): boolean { return [...this.guests.values()].every((gu) => gu.player.sleeping); }

  private chat(gu: Guest, text: string): void {
    const g = this.game;
    if (text.startsWith('/')) {
      // Opening a singleplayer world with cheats makes its owner an operator; it does not grant every joining
      // player operator permissions. A later permission list can opt individual guests in explicitly.
      this.send(gu.id, { t: 'chat', text: '§cYou do not have permission to use commands on this server' });
      return;
    }
    const line = `<${gu.name}> ${text}`;
    g.gui.addChat(line);
    for (const other of this.guests.values()) if (other !== gu) this.send(other.id, { t: 'chat', text: line }); // the sender already echoed it
  }

  /** Night skipping needs every player in bed. */
  checkSleep(): void {
    const g = this.game;
    const all = [g.player, ...[...this.guests.values()].map((x) => x.player)];
    if (all.every((p) => p.sleeping)) { g.world.dayTime = Math.floor(g.world.dayTime / 24000) * 24000 + 24000; g.weather.raining = false; g.weather.thundering = false; for (const p of all) { if (p === g.player) { p.wakeUp(); g.gui.sleepFade = 0; } } this.broadcast({ t: 'wake' }); }
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
      else this.send(gu.id, { t: 'open', kind: o.kind, x, y, z });
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
        const data = stack.serialize(); const amount = data.count; data.count = 1;
        const key = JSON.stringify(data); totals.set(key, (totals.get(key) ?? 0) + amount);
      }
      return totals;
    };
    const a = count(before), b = count(after);
    if (!a || !b || a.size !== b.size) return false;
    for (const [key, amount] of a) if (b.get(key) !== amount) return false;
    return true;
  }
  private sendContainer(gu: Guest, _force: boolean): void {
    const c = gu.container!;
    this.send(gu.id, { t: 'contUpd', x: c.x, y: c.y, z: c.z, slots: c.inv.serialize(), be: c.be ? this.beState(c.be) : undefined });
  }

  // ---- chunk streaming ----
  private streamChunks(gu: Guest): void {
    const g = this.game;
    let sent = 0;
    for (const key of gu.wantChunks) {
      const c = g.world.chunks.get(key);
      if (!c) continue;
      gu.wantChunks.delete(key);
      if (gu.chunks.has(key)) continue;
      this.sendChunk(gu, c);
      if (++sent >= 6) break;
    }
  }
  private sendChunk(gu: Guest, c: Chunk): void {
    const { header, body } = encodeChunk(c);
    this.sendBinary(gu.id, packFrame(FRAME_CHUNK, header, body));
    gu.chunks.add(chunkKeyOf(c.cx, c.cz));
  }
  /** Positions the chunk manager should keep loaded (guest positions). */
  extraCenters(): { x: number; z: number }[] { return [...this.guests.values()].map((gu) => ({ x: gu.player.x, z: gu.player.z })); }
  onChunkUnloaded(c: Chunk): void { const k = chunkKeyOf(c.cx, c.cz); for (const gu of this.guests.values()) gu.chunks.delete(k); }

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
  private sendEntities(): void {
    const g = this.game;
    const list: Entity[] = [];
    for (const e of g.entities) if (!e.removed) list.push(e);
    for (const gu of this.guests.values()) {
      if (!gu.ready) continue;
      const p = gu.player;
      const ents: any[] = [], rm: number[] = [];
      const seen = new Set<number>();
      const R2 = 96 * 96;
      // host player as an entity
      const hp = g.player;
      const hostBoat = hp.vehicle instanceof BoatEntity ? hp.vehicle : null;
      const hostSnap: any = { i: -1, pid: -1, t: 'player', x: r3(hp.x), y: r3(hp.y), z: r3(hp.z), yaw: r1(hp.yaw), pitch: r1(hp.pitch), sneak: hp.isSneaking, sprint: hp.isSprinting, swim: hp.swimmingPose, sleep: hp.sleeping, fly: hp.flying, hurt: hp.hurtTime > 0, dead: hp.health <= 0, swing: hp.swinging && hp.swingTime <= 1, use: !!hp.usingItem, mode: hp.gameMode, vid: hostBoat?.id ?? null, seat: hostBoat?.passengerIndex(hp) ?? -1, br: hp.breaking ? { x: hp.breaking.x, y: hp.breaking.y, z: hp.breaking.z, stage: hp.breakStage, state: hp.breaking.state } : null };
      if (!gu.known.has(-1)) { hostSnap.full = { name: this.hostName, skin: g.options.skin }; gu.known.add(-1); }
      if (this.ticks % 10 === 0) hostSnap.held = hp.heldItem()?.serialize() ?? null, hostSnap.armor = hp.armor.serialize();
      ents.push(hostSnap); seen.add(-1);
      for (const e of list) {
        if (e === p) continue;
        if (e.distSq(p.x, p.y, p.z) > R2) continue;
        const s = this.snapshot(e, gu);
        if (!s) continue;
        ents.push(s); seen.add(e.id);
      }
      for (const k of gu.known) if (!seen.has(k) && k !== -1) rm.push(k);
      for (const k of rm) gu.known.delete(k);
      if (ents.length || rm.length) this.send(gu.id, { t: 'ent', e: ents, rm });
    }
  }
  private snapshot(e: Entity, gu: Guest): any | null {
    const first = !gu.known.has(e.id);
    const s: any = { i: e.id, x: r3(e.x), y: r3(e.y), z: r3(e.z), yaw: r1(e.yaw), pitch: r1(e.pitch) };
    if (e instanceof RemotePlayer) {
      const boat = e.vehicle instanceof BoatEntity ? e.vehicle : null;
      s.t = 'player'; s.pid = e.clientId; s.sneak = e.isSneaking; s.sprint = e.isSprinting; s.swim = e.swimmingPose; s.sleep = e.sleeping; s.fly = e.flying; s.hurt = e.hurtTime > 0; s.dead = e.health <= 0; s.swing = e.swinging && e.swingTime <= 1; s.mode = e.gameMode; s.use = !!e.usingItem; s.vid = boat?.id ?? null; s.seat = boat?.passengerIndex(e) ?? -1; s.br = e.breaking ? { x: e.breaking.x, y: e.breaking.y, z: e.breaking.z, stage: e.breakStage, state: e.breaking.state } : null;
      if (first) s.full = { name: e.name, skin: e.skin };
      if (this.ticks % 10 === 0 || first) { s.held = e.heldItem()?.serialize() ?? null; s.armor = e.armor.serialize(); }
    } else if (e instanceof Mob) {
      s.t = e.type; s.hy = r1(e.headYaw); s.by = r1(e.bodyYaw); s.h = r1(e.health); s.hurt = e.hurtTime > 0; s.dt = e.deathTime; s.swing = e.swinging && e.swingTime <= 1; s.og = e.onGround;
      s.ex = { baby: e.isBaby, sheared: e.sheared, wool: e.woolColor, tamed: e.tamed, sit: e.sitting, swell: e.swell, anger: e.angerTicks > 0, size: e.slimeSize, variant: e.variant, charged: e.charged, name: (e as any).customName, eat: e.eatTimer, scream: e.screaming, carried: e.carriedBlock, attack: e.attackAnim, saddled: e.saddled };
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
