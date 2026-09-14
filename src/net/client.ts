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
import { decodeChunk, unpackFrame, FRAME_CHUNK, PROTOCOL_VERSION, defaultRelayUrl, type ServerInfo } from './protocol';

export interface JoinResult { welcome: any; info: any }

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
  players: { name: string; id: number }[] = [];
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

  constructor(public game: Game, public relayUrl: string) {}

  connect(serverId: string, name: string, skin: string): Promise<JoinResult> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(this.relayUrl); } catch (e) { reject(e); return; }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timer = setTimeout(() => { if (this.status === 'connecting') { reject(new Error('Timed out waiting for the host')); ws.close(); } }, 15000);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'join', id: serverId, name, skin }));
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') { this.chunkFrames.push(new Uint8Array(e.data)); return; }
        const m = JSON.parse(e.data);
        if (this.status === 'connecting') {
          if (m.t === 'error') { clearTimeout(timer); this.status = 'error'; reject(new Error(m.reason)); return; }
          if (m.t === 'joined') { this.clientId = m.clientId; this.info = m.info; return; }
          if (m.t === 'welcome') { clearTimeout(timer); this.welcome = m; this.players = m.players ?? []; this.status = 'joined'; if (m.protocol !== PROTOCOL_VERSION) { this.status = 'error'; reject(new Error(`Incompatible server version (${m.version})`)); ws.close(); return; } resolve({ welcome: m, info: this.info }); return; }
          if (m.t === 'kicked') { clearTimeout(timer); this.status = 'error'; reject(new Error(m.reason)); return; }
          return;
        }
        this.queue.push(m);
      };
      ws.onerror = () => { if (this.status === 'connecting') { clearTimeout(timer); reject(new Error('Could not reach the relay server at ' + this.relayUrl)); } this.status = 'error'; };
      ws.onclose = () => { if (this.status === 'joined') { this.status = 'closed'; this.disconnectReason = this.disconnectReason || 'Connection lost'; } };
    });
  }

  send(m: any): void { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'msg', d: m })); }
  close(): void { this.status = 'closed'; try { this.ws?.close(); } catch { /* */ } this.ws = null; }

  // ---- world listener: locally predicted block changes are sent to the host ----
  onBlockChanged(x: number, y: number, z: number, _old: number, s: number): void {
    if (this.applying) return;
    const be = this.game.blockEntities.get(x, y, z);
    this.send({ t: 'set', b: [x, y, z, s], be: be ? this.game.blockEntities.serializeOne(be) : undefined });
  }

  /** ChunkManager (remote mode) asks for chunks here. */
  requestChunk(cx: number, cz: number): void { const k = chunkKey(cx, cz); if (this.requested.has(k)) return; this.requested.add(k); this.wanted.add(k); }
  forgetChunk(cx: number, cz: number): void { this.requested.delete(chunkKey(cx, cz)); }

  /** Per tick: apply everything received, then send our snapshot. */
  tick(): void {
    const g = this.game, p = g.player;
    this.ticks++;
    if (this.wanted.size) { this.send({ t: 'chunk', keys: [...this.wanted] }); this.wanted.clear(); }
    // chunks
    const frames = this.chunkFrames; this.chunkFrames = [];
    for (const f of frames) {
      try {
        const { kind, json, body } = unpackFrame(f);
        if (kind === FRAME_CHUNK) { const d = decodeChunk(json, body); const c = Chunk.deserialize({ ...d, decorated: true } as any); c.modified = false; this.applying = true; try { g.chunks.addRemoteChunk(c); } finally { this.applying = false; } }
      } catch (e) { console.error('chunk decode', e); }
    }
    const q = this.queue; this.queue = [];
    for (const m of q) { try { this.handle(m); } catch (e) { console.error('client message error', e); } }
    // our snapshot
    if (this.ticks === 1) this.send({ t: 'ready' });
    const snap: any = { t: 'move', x: r3(p.x), y: r3(p.y), z: r3(p.z), yaw: r1(p.yaw), pitch: r1(p.pitch), sneak: p.isSneaking, sprint: p.isSprinting, swim: p.swimmingPose, sleep: p.sleeping, fly: p.flying, health: p.health, slot: p.selectedSlot, mode: p.gameMode, swing: p.swinging && p.swingTime <= 1, use: !!p.usingItem, hurt: p.hurtTime === p.hurtDuration, dead: p.health <= 0 };
    if (this.ticks % 100 === 0) snap.saved = p.serialize();
    this.send(snap);
    const held = JSON.stringify(p.heldItem()?.serialize() ?? null), armor = JSON.stringify(p.armor.serialize()) + JSON.stringify(p.offhand.serialize());
    if (held !== this.lastHeld || armor !== this.lastArmor) { this.lastHeld = held; this.lastArmor = armor; this.send({ t: 'inv', held: p.heldItem()?.serialize() ?? null, armor: p.armor.serialize(), off: p.offhand.serialize() }); }
    if (this.ticks % 40 === 0) this.send({ t: 'ping', time: performance.now() });
    if (this.container && this.ticks % 2 === 0 && this.containerDirty) { this.containerDirty = false; this.send({ t: 'cont', slots: this.container.inv.serialize() }); }
  }
  containerDirty = false;

  private handle(m: any): void {
    const g = this.game, p = g.player, w = g.world;
    switch (m.t) {
      case 'blk': { this.applying = true; try { const b = m.b as number[]; for (let i = 0; i < b.length; i += 4) { if (w.isLoaded(b[i], b[i + 2])) w.setBlock(b[i], b[i + 1], b[i + 2], b[i + 3], SET_UPDATE_NEIGHBORS); } } finally { this.applying = false; } break; }
      case 'snd': { const d = Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z); if (d < 64) g.sounds.playAt(m.e, m.x, m.y, m.z, m.v, m.p, true); break; }
      case 'time': { w.time = m.time; w.dayTime = m.day; g.weather.rainLevel = m.rain; g.weather.thunderLevel = m.thunder; g.weather.raining = m.raining; g.weather.thundering = m.thundering; g.difficulty = m.diff; break; }
      case 'ent': this.applyEntities(m.e ?? [], m.rm ?? []); break;
      case 'chat': g.gui.addChat(m.text); break;
      case 'actionbar': g.gui.showActionBar(m.text); break;
      case 'players': this.players = m.list; break;
      case 'hurt': { const attacker = m.ax !== undefined ? ({ x: m.ax, y: m.ay, z: m.az } as any) : undefined; p.hurt({ amount: m.amount, source: m.source, bypassArmor: m.bypassArmor, attacker: attacker as any }); if (attacker) { const dx = p.x - m.ax, dz = p.z - m.az, d = Math.hypot(dx, dz) || 1; p.vx += dx / d * 0.4; p.vz += dz / d * 0.4; p.vy += 0.4; } break; }
      case 'give': { const st = ItemStack.deserialize(m.stack, g.items); if (!st) break; const left = p.inventory.add(st); g.sounds.playAt('entity.item.pickup', p.x, p.y, p.z, 0.2, 1.5 + Math.random() * 0.5); if (left > 0) this.send({ t: 'drop', stack: st.serialize(), x: p.x, y: p.y + 1, z: p.z, dir: [0, 0, 0] }); break; }
      case 'givexp': p.addXp(m.v); g.sounds.playAt('entity.experience_orb.pickup', p.x, p.y, p.z, 0.1, 1 + Math.random() * 0.5); break;
      case 'consumed': { p.inventory.slots[p.selectedSlot] = m.held ? ItemStack.deserialize(m.held, g.items) : null; p.inventory.onChange?.(); break; }
      case 'open': this.openRemote(m); break;
      case 'contUpd': { if (this.container && this.container.x === m.x && this.container.y === m.y && this.container.z === m.z && !this.containerDirty) { this.container.inv.deserialize(m.slots, g.items); if (m.be && this.container.be) Object.assign(this.container.be, m.be); } break; }
      case 'wake': { if (p.sleeping) { p.wakeUp(); g.gui.sleepFade = 0; } break; }
      case 'kicked': { this.disconnectReason = m.reason ?? 'Disconnected'; this.status = 'closed'; break; }
      case 'pong': this.ping = Math.round(performance.now() - m.time); break;
      case 'ride': { const v = m.id !== null ? this.entities.get(m.id) : null; if (v instanceof BoatEntity) { if (p.vehicle !== v) { p.vehicle = v; if (!v.passengers.includes(p)) v.passengers.push(p); v.positionPassengers(); p.prevX = p.x; p.prevY = p.y; p.prevZ = p.z; } } else { const old = p.vehicle; if (old) { old.passengers = old.passengers.filter((x) => x !== p); p.vehicle = null; } if (m.x !== undefined) { p.setPos(m.x, m.y, m.z); p.vy = 0; } } break; }
    }
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
    } else if (m.kind === 'crafting') g.gui.openCrafting();
    else if (m.kind === 'stonecutter') g.gui.openStonecutter();
    else if (m.kind === 'anvil') g.gui.openAnvil();
    else if (m.kind === 'smithing') g.gui.openSmithing();
    else if (m.kind === 'grindstone') g.gui.openGrindstone();
    else if (m.kind === 'enchanting') g.gui.openEnchanting(m.x, m.y, m.z);
  }

  private applyEntities(list: any[], rm: number[]): void {
    const g = this.game;
    for (const id of rm) { const e = this.entities.get(id); if (e) { e.remove(); this.entities.delete(id); } }
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
        e.applySnapshot(s);
        if (s.held !== undefined) { e.inventory.slots[e.selectedSlot] = s.held ? ItemStack.deserialize(s.held, g.items) : null; }
        if (s.armor) e.armor.deserialize(s.armor, g.items);
      } else e.applySnapshot(s);
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
