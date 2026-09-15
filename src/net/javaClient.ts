// Browser side of the Java gateway. The gateway owns TCP/authentication and converts vanilla chunks into the
// same binary representation used by VoxeLand-hosted worlds; this class applies authoritative server updates.
import type { Game } from '../game/game';
import type { WorldListener } from '../world/world';
import { SET_UPDATE_NEIGHBORS } from '../world/world';
import { Chunk } from '../world/chunk';
import { decodeChunk, FRAME_CHUNK, unpackFrame } from './protocol';
import { ItemStack } from '../items/stack';
import { RemotePlayer } from '../entity/remotePlayer';
import { Mob, MOB_DEFS } from '../entity/mobs';
import type { Entity } from '../entity/entity';

export interface JavaWelcome {
  name: string; hostName: string; dimension: 'overworld' | 'the_nether' | 'the_end'; seed: number;
  spawn: [number, number, number]; gameMode: string; difficulty: number; cheats: boolean;
  rules: Record<string, any>; weather: Record<string, any>; time: number; dayTime: number;
}

export class JavaNetClient implements WorldListener {
  ws: WebSocket | null = null;
  applying = false;
  status = 'connecting';
  disconnectReason = '';
  rehostId: string | null = null;
  ping = 0;
  players: { name: string; id: number }[] = [];
  welcome: JavaWelcome | null = null;
  private packets: any[] = [];
  private chunks: Uint8Array[] = [];
  private ticks = 0;
  private sequence = 0;
  private digging: { x: number; y: number; z: number; face: number } | null = null;
  private lastSlot = -1;
  private serverEntities = new Map<number, Entity>();
  private playerNames = new Map<string, string>();
  private changingDimension = false;
  private readyToApply = false;

  constructor(public game: Game, public relayUrl: string) {}

  connect(address: string, username: string, auth: 'offline' | 'microsoft', onProgress?: (message: string) => void): Promise<JavaWelcome> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(this.relayUrl); } catch (error) { reject(error); return; }
      ws.binaryType = 'arraybuffer'; this.ws = ws;
      let login: any = null, settled = false;
      onProgress?.('Contacting the VoxeLand gateway…');
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('The Minecraft server did not finish logging in within 30 seconds')); ws.close(); } }, 30_000);
      ws.onopen = () => { onProgress?.('Resolving and connecting to the Minecraft server…'); ws.send(JSON.stringify({ t: 'javaConnect', address, username, auth })); };
      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') { this.chunks.push(new Uint8Array(event.data)); return; }
        const message = JSON.parse(event.data);
        if (message.t === 'error' || message.t === 'javaError' || message.t === 'javaEnd') {
          const reason = message.reason ?? 'Minecraft server closed the connection';
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error(reason)); }
          else { this.disconnectReason = reason; this.status = 'closed'; }
          return;
        }
        if (message.t === 'javaAuthCode') {
          const code = message.code?.user_code ?? message.code?.userCode ?? '';
          const url = message.code?.verification_uri ?? message.code?.verificationUri ?? 'https://microsoft.com/devicelogin';
          window.prompt(`Open ${url} and enter this Microsoft sign-in code:`, code);
          return;
        }
        if (message.t === 'javaState') {
          if (message.state === 'tcp_connected') onProgress?.('Server reached — waiting for login…');
          else if (message.state === 'play') onProgress?.('Login accepted — joining the world…');
          return;
        }
        if (message.t !== 'javaPacket') return;
        if (message.name === 'login') login = message.data;
        if (!settled && login && message.name === 'position') {
          const state = login.worldState ?? {};
          const dimName = String(state.name ?? '');
          const dimension = dimName.includes('the_nether') ? 'the_nether' : dimName.includes('the_end') ? 'the_end' : 'overworld';
          const seed = Number(state.hashedSeed?.$bigint ?? state.hashedSeed ?? 0) || 0;
          this.welcome = {
            name: username, hostName: address, dimension, seed,
            spawn: [message.data.x, message.data.y, message.data.z], gameMode: javaGameMode(state.gamemode),
            difficulty: 2, cheats: false, rules: {}, weather: {}, time: 0, dayTime: 0,
          };
          this.sendIntent({ kind: 'teleport_confirm', id: message.data.teleportId });
          settled = true; clearTimeout(timer); this.status = 'joined'; resolve(this.welcome); return;
        }
        this.packets.push(message);
      };
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Could not reach the VoxeLand Java gateway')); } };
      ws.onclose = () => { if (this.status === 'joined') { this.status = 'closed'; this.disconnectReason ||= 'Connection lost'; } };
    });
  }

  private sendIntent(intent: any): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'javaIntent', intent })); }
  send(message: any): void {
    if (message.t === 'move') this.sendIntent({ kind: 'move', x: message.x, y: message.y, z: message.z, yaw: message.yaw, pitch: message.pitch, onGround: this.game.player?.onGround });
    else if (message.t === 'chat') this.sendIntent({ kind: 'chat', text: message.text });
    else if (message.t === 'break' && [message.x, message.y, message.z].every(Number.isInteger)) {
      const face = this.digging?.face ?? this.game.targetBlock?.face ?? 1;
      this.sendIntent({ kind: 'dig', status: 2, x: message.x, y: message.y, z: message.z, face, sequence: this.sequence++ }); this.digging = null;
    } else if (message.t === 'use' && [message.x, message.y, message.z, message.face].every(Number.isInteger)) {
      const hit = Array.isArray(message.hit) ? message.hit : [message.x + 0.5, message.y + 0.5, message.z + 0.5];
      this.sendIntent({ kind: 'use_block', x: message.x, y: message.y, z: message.z, face: message.face, cursor: [hit[0] - message.x, hit[1] - message.y, hit[2] - message.z], sequence: this.sequence++ });
    } else if (message.t === 'attack' && Number.isInteger(message.id)) this.sendIntent({ kind: 'attack_entity', id: message.id });
    else if (message.t === 'interact' && Number.isInteger(message.id)) this.sendIntent({ kind: 'use_entity', id: message.id, sneaking: this.game.player?.isSneaking });
    else if (message.t === 'drop') this.sendIntent({ kind: 'drop', all: Number(message.count ?? message.stack?.count ?? 1) > 1, sequence: this.sequence++ });
    else if (message.t === 'respawn') this.sendIntent({ kind: 'respawn' });
  }
  requestChunk(_cx: number, _cz: number): void { /* vanilla server streams chunks from view position */ }
  forgetChunk(_cx: number, _cz: number): void { /* server controls its chunk cache */ }
  close(): void { this.status = 'closed'; try { this.ws?.close(); } catch { /* */ } this.ws = null; }
  startApplying(): void { this.readyToApply = true; }

  tick(): void {
    const g = this.game, p = g.player; this.ticks++;
    if (!this.readyToApply || this.changingDimension) return;
    const frames = this.chunks; this.chunks = [];
    for (const frame of frames) try {
      const { kind, json, body } = unpackFrame(frame);
      if (kind !== FRAME_CHUNK || (json.dim && json.dim !== g.world.dimension)) continue;
      const decoded = decodeChunk(json, body);
      for (const section of decoded.sections) if (section) for (let i = 0; i < section.length; i++) if (section[i] >= g.registry.stateCount) section[i] = 0;
      const chunk = Chunk.deserialize({ ...decoded, decorated: true } as any); chunk.modified = false;
      this.applying = true; try { g.chunks.addRemoteChunk(chunk); } finally { this.applying = false; }
    } catch (error) { console.error('Java chunk decode', error); }
    const packets = this.packets; this.packets = [];
    for (let i = 0; i < packets.length; i++) {
      const message = packets[i]; this.applyPacket(message.name, message.data);
      if (this.changingDimension) { this.packets.unshift(...packets.slice(i + 1)); break; }
    }
    const hit = p.breaking && g.targetBlock && p.breaking.x === g.targetBlock.x && p.breaking.y === g.targetBlock.y && p.breaking.z === g.targetBlock.z ? g.targetBlock : null;
    if (hit && (!this.digging || this.digging.x !== hit.x || this.digging.y !== hit.y || this.digging.z !== hit.z)) {
      if (this.digging) this.sendIntent({ kind: 'dig', status: 1, ...this.digging, sequence: this.sequence++ });
      this.digging = { x: hit.x, y: hit.y, z: hit.z, face: hit.face };
      this.sendIntent({ kind: 'dig', status: 0, ...this.digging, sequence: this.sequence++ });
    } else if (!hit && this.digging) { this.sendIntent({ kind: 'dig', status: 1, ...this.digging, sequence: this.sequence++ }); this.digging = null; }
    if (p.selectedSlot !== this.lastSlot) { this.lastSlot = p.selectedSlot; this.sendIntent({ kind: 'held_slot', slot: p.selectedSlot }); }
    this.sendIntent({ kind: 'move', x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, onGround: p.onGround });
  }

  private applyPacket(name: string, data: any): void {
    const g = this.game, p = g.player;
    if (name === 'position') {
      const f = data.flags ?? {};
      const px = finiteNumber(data.x), py = finiteNumber(data.y), pz = finiteNumber(data.z);
      if (px === null || py === null || pz === null) return;
      const x = f.x ? p.x + px : px, y = f.y ? p.y + py : py, z = f.z ? p.z + pz : pz;
      p.applyServerPosition(x, y, z); p.yaw = f.yaw ? p.yaw + data.yaw : data.yaw; p.pitch = f.pitch ? p.pitch + data.pitch : data.pitch;
      p.vx = f.dx ? p.vx + (data.dx ?? 0) : (data.dx ?? 0); p.vy = f.dy ? p.vy + (data.dy ?? 0) : (data.dy ?? 0); p.vz = f.dz ? p.vz + (data.dz ?? 0) : (data.dz ?? 0);
      this.sendIntent({ kind: 'teleport_confirm', id: data.teleportId });
    } else if (name === 'block_change') {
      const q = data.location; if (q && [q.x, q.y, q.z, data.type].every(Number.isInteger) && data.type >= 0 && data.type < g.registry.stateCount) { this.applying = true; try { g.world.setBlock(q.x, q.y, q.z, data.type, SET_UPDATE_NEIGHBORS); } finally { this.applying = false; } }
    } else if (name === 'multi_block_change') {
      const q = data.chunkCoordinates;
      if (!q || ![q.x, q.y, q.z].every(Number.isInteger) || !Array.isArray(data.records)) return;
      this.applying = true;
      try {
        for (const raw of data.records) {
          const packed = packetBigInt(raw);
          const x = q.x * 16 + Number((packed >> 8n) & 15n), y = q.y * 16 + Number(packed & 15n), z = q.z * 16 + Number((packed >> 4n) & 15n);
          const state = Number(packed >> 12n);
          if (state >= 0 && state < g.registry.stateCount && g.world.isLoaded(x, z)) g.world.setBlock(x, y, z, state, SET_UPDATE_NEIGHBORS);
        }
      } finally { this.applying = false; }
    } else if (name === 'unload_chunk') {
      if (Number.isInteger(data.chunkX) && Number.isInteger(data.chunkZ)) g.chunks.removeRemoteChunk(data.chunkX, data.chunkZ);
    } else if (name === 'window_items') {
      if (data.windowId === 0 && Array.isArray(data.items)) { this.applyPlayerInventory(data.items); p.inventory.onChange?.(); }
    } else if (name === 'set_slot') {
      if (data.windowId === 0 && Number.isInteger(data.slot)) { this.applyPlayerSlot(data.slot, data.item); p.inventory.onChange?.(); }
    } else if (name === 'update_health') {
      const health = finiteNumber(data.health), food = finiteNumber(data.food), saturation = finiteNumber(data.foodSaturation);
      if (health !== null) p.health = health; if (food !== null) p.foodLevel = food; if (saturation !== null) p.saturation = saturation;
    } else if (name === 'update_time') {
      const age = finiteNumber(data.age?.$bigint ?? data.age);
      if (age !== null) g.world.time = age;
      const clock = data.clockUpdates?.[0], ticks = finiteNumber(clock?.totalTicks?.$bigint ?? clock?.totalTicks);
      if (ticks !== null) g.world.dayTime = ticks;
    } else if (name === 'held_item_slot' && Number.isInteger(data.slot)) p.selectedSlot = data.slot;
    else if (name === 'abilities') {
      const flags = Number(data.flags) || 0;
      p.flying = (flags & 2) !== 0; p.noClip = p.gameMode === 'spectator';
      if ((flags & 8) !== 0 && p.gameMode !== 'spectator') p.setGameMode('creative');
    }
    else if (name === 'player_info') this.applyPlayerInfo(data);
    else if (name === 'spawn_entity') this.spawnServerEntity(data);
    else if (name === 'sync_entity_position') this.syncServerEntity(data);
    else if (name === 'rel_entity_move' || name === 'entity_move_look') {
      const e = this.serverEntities.get(data.entityId); if (!e) return;
      const base = e.networkSnapshot();
      const next = { x: base.x + Number(data.dX ?? 0) / 4096, y: base.y + Number(data.dY ?? 0) / 4096, z: base.z + Number(data.dZ ?? 0) / 4096, yaw: name === 'entity_move_look' ? byteAngle(data.yaw) : base.yaw, pitch: name === 'entity_move_look' ? byteAngle(data.pitch) : base.pitch };
      e.applySnapshot(next);
    }
    else if (name === 'entity_look') {
      const e = this.serverEntities.get(data.entityId); if (e) { const base = e.networkSnapshot(); e.applySnapshot({ ...base, yaw: byteAngle(data.yaw), pitch: byteAngle(data.pitch) }); }
    }
    else if (name === 'entity_head_rotation') {
      const e: any = this.serverEntities.get(data.entityId); if (e) e.headYaw = byteAngle(data.headYaw);
    }
    else if (name === 'entity_velocity') {
      const e = this.serverEntities.get(data.entityId), v = data.velocity;
      if (e && v) { e.vx = Number(v.x ?? 0); e.vy = Number(v.y ?? 0); e.vz = Number(v.z ?? 0); }
    }
    else if (name === 'entity_destroy') {
      for (const id of data.entityIds ?? []) { const e = this.serverEntities.get(id); if (e) e.remove(); this.serverEntities.delete(id); }
    }
    else if (name === 'entity_equipment') this.applyEquipment(data);
    else if (name === 'entity_metadata') this.applyMetadata(data);
    else if (name === 'game_state_change' && data.reason === 'change_game_mode') p.setGameMode(javaGameMode(Math.round(data.gameMode)));
    else if (name === 'update_view_distance' && Number.isInteger(data.viewDistance)) { g.chunks.viewDistance = Math.max(2, Math.min(g.options.renderDistance, data.viewDistance)); }
    else if (name === 'respawn') this.beginRespawn(data);
    else if (name === 'experience') {
      const progress = finiteNumber(data.experienceBar), level = finiteNumber(data.level), total = finiteNumber(data.totalExperience);
      if (progress !== null) p.xpProgress = progress; if (level !== null) p.xpLevel = level; if (total !== null) p.totalXp = total;
    }
    else if (name === 'system_chat') {
      const text = typeof data.formatted === 'string' ? data.formatted : typeof data.content === 'string' ? data.content : '';
      if (data.isActionBar) { g.gui.actionBar = { text, time: 60 }; } else g.gui.addChat(text);
    }
    else if (name === 'player_chat' || name === 'profileless_chat') {
      if (typeof data.formatted === 'string') g.gui.addChat(data.formatted);
    }
  }

  private javaSlot(slot: any): ItemStack | null {
    const count = Number(slot?.itemCount ?? 0), id = Number(slot?.itemId ?? -1);
    const item = this.game.items.byId(id);
    if (!item || count <= 0) return null;
    return new ItemStack(item, count);
  }
  private applyPlayerInventory(slots: any[]): void { for (let i = 0; i < slots.length; i++) this.applyPlayerSlot(i, slots[i]); }
  private applyPlayerSlot(slot: number, value: any): void {
    const p = this.game.player, stack = this.javaSlot(value);
    if (slot >= 36 && slot <= 44) p.inventory.slots[slot - 36] = stack;
    else if (slot >= 9 && slot <= 35) p.inventory.slots[slot] = stack;
    else if (slot >= 5 && slot <= 8) p.armor.slots[slot - 5] = stack;
    else if (slot === 45) p.offhand.slots[0] = stack;
  }
  private applyPlayerInfo(data: any): void {
    for (const row of data.data ?? []) {
      const uuid = String(row.uuid ?? ''); if (!uuid) continue;
      if (row.player?.name) this.playerNames.set(uuid, row.player.name);
      const e = [...this.serverEntities.values()].find((x: any) => x.javaUuid === uuid);
      if (e instanceof RemotePlayer && row.player?.name) e.name = row.player.name;
      if (e instanceof RemotePlayer && row.gamemode !== undefined) e.setGameMode(javaGameMode(row.gamemode));
    }
  }
  private spawnServerEntity(data: any): void {
    if (!Number.isInteger(data.entityId) || this.serverEntities.has(data.entityId)) return;
    const def = this.game.assets.mcdata.entities.find((x) => x.id === data.type);
    if (!def) return;
    let entity: Entity | null = null;
    if (def.name === 'player') { const p = new RemotePlayer(this.playerNames.get(String(data.objectUUID)) ?? 'Player'); (p as any).javaUuid = String(data.objectUUID); entity = p; }
    else if (MOB_DEFS[def.name]) entity = new Mob(MOB_DEFS[def.name]);
    if (!entity) return;
    entity.remote = true; entity.remoteId = data.entityId;
    entity.setPos(data.x, data.y, data.z); entity.yaw = entity.prevYaw = byteAngle(data.yaw); entity.pitch = entity.prevPitch = byteAngle(data.pitch);
    entity.applySnapshot({ x: data.x, y: data.y, z: data.z, yaw: entity.yaw, pitch: entity.pitch });
    this.serverEntities.set(data.entityId, entity); this.game.addEntity(entity);
  }
  private syncServerEntity(data: any): void {
    const e = this.serverEntities.get(data.entityId); if (!e) return;
    e.applySnapshot({ x: data.x, y: data.y, z: data.z, yaw: data.yaw, pitch: data.pitch, vx: data.dx, vy: data.dy, vz: data.dz });
  }
  private applyEquipment(data: any): void {
    const e = this.serverEntities.get(data.entityId); if (!(e instanceof RemotePlayer)) return;
    for (const q of data.equipments ?? []) {
      const stack = this.javaSlot(q.item), slot = Number(q.slot) & 0x7f;
      if (slot === 0) e.inventory.slots[e.selectedSlot] = stack;
      else if (slot === 1) e.offhand.slots[0] = stack;
      else if (slot >= 2 && slot <= 5) e.armor.slots[5 - slot] = stack;
    }
  }
  private applyMetadata(data: any): void {
    const e: any = this.serverEntities.get(data.entityId); if (!e) return;
    for (const m of data.metadata ?? []) {
      const key = Number(m.key ?? m.index);
      if (key === 0 && Number.isInteger(m.value)) {
        const flags = Number(m.value);
        e.isSneaking = (flags & 0x02) !== 0; e.isSprinting = (flags & 0x08) !== 0; e.swimmingPose = (flags & 0x10) !== 0; e.glowing = (flags & 0x40) !== 0; e.fallFlying = (flags & 0x80) !== 0;
      } else if (key === 9 && typeof m.value === 'number' && e instanceof RemotePlayer) e.health = m.value;
    }
  }
  private beginRespawn(data: any): void {
    if (this.changingDimension) return;
    this.changingDimension = true; this.serverEntities.clear();
    const state = data.worldState ?? {}, name = String(state.name ?? '');
    const dimension = name.includes('the_nether') ? 'the_nether' : name.includes('the_end') ? 'the_end' : 'overworld';
    const seed = Number(state.hashedSeed?.$bigint ?? state.hashedSeed ?? 0) || this.game.world.seed;
    void this.game.applyJavaRespawn(dimension, seed, javaGameMode(state.gamemode)).finally(() => { this.changingDimension = false; });
  }

  onBlockChanged(): void { /* predicted changes are reconciled by authoritative vanilla block packets */ }
}

function packetBigInt(value: any): bigint { return BigInt(value?.$bigint ?? value ?? 0); }
function finiteNumber(value: any): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }
function javaGameMode(value: any): 'survival' | 'creative' | 'adventure' | 'spectator' {
  if (typeof value === 'string' && ['survival', 'creative', 'adventure', 'spectator'].includes(value)) return value as any;
  return (['survival', 'creative', 'adventure', 'spectator'][Number(value)] ?? 'survival') as any;
}
function byteAngle(value: any): number { return (Number(value) || 0) * 360 / 256; }
