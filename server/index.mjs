#!/usr/bin/env node
// VoxeLand backend: static game host + multiplayer relay + the persistent public world.
//
//   node server/index.mjs                 -> serves ./dist on :8080, relay on /ws
//   PORT=... DATA_DIR=... PUBLIC_SEED=...
//
// Servers are registered by the browser that opens a world. They are either **public** (anyone may join) or
// **private** (a password is required). Every server on a relay is listed to every client of that relay, so a
// player can also point the game at another VoxeLand backend by IP and see the worlds hosted there.
//
// The backend additionally owns one **persistent public world** (id "official"): its seed, time, weather,
// per-player data and modified chunks live on the server, so it is always listed and has no player host. An
// automatically selected client coordinates live simulation while players are connected; that internal role is
// never exposed as ownership of the server and can move without moving player inventories.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createJavaSession, pingJavaServer, JAVA_VERSION } from './java-gateway.mjs';

const VOXELAND_PROTOCOL = 17;

const PORT = +(process.env.PORT || 8080);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIST = process.env.DIST || path.join(ROOT, 'dist');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, '.data');
const MAX_PLAYERS_DEFAULT = 8;
const OFFICIAL_ID = 'official';
const OFFICIAL_MAX = +(process.env.PUBLIC_MAX_PLAYERS || 16);
const MAX_STORED_CHUNKS = +(process.env.PUBLIC_MAX_CHUNKS || 2048);
/** Guests send small intents; the host's snapshots, inventories and public-world metadata are legitimately large. */
const MAX_GUEST_CONTROL_BYTES = 64 * 1024;
const MAX_HOST_CONTROL_BYTES = 4 * 1024 * 1024;
const MAX_GUEST_MESSAGES_PER_SECOND = 400;
const HEARTBEAT_MS = 30_000;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ogg': 'audio/ogg', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

// ---------------------------------------------------------------- persistent public world

/** @type {{ seed:number, name:string, motd:string, gameMode:string, difficulty:number, meta:any, playerData:any, chunks:Map<string,Buffer>, dirty:boolean }} */
const official = {
  seed: +(process.env.PUBLIC_SEED || 0) || Math.floor(Math.random() * 2 ** 31),
  name: process.env.PUBLIC_NAME || 'VoxeLand Public Server',
  motd: process.env.PUBLIC_MOTD || 'Open to everyone · Try it out! · Cheats enabled',
  gameMode: process.env.PUBLIC_GAMEMODE || 'survival',
  difficulty: +(process.env.PUBLIC_DIFFICULTY ?? 2),
  /** every player is an operator, like a LAN world with Allow Cheats on (it is a test server) */
  cheats: (process.env.PUBLIC_CHEATS ?? 'true') !== 'false',
  meta: null,            // { time, dayTime, weather, rules, worldSpawn, dragonKills }
  playerData: {},        // by player name
  chunks: new Map(),     // "dim:cx,cz" -> binary chunk frame
  dirty: false,
  /** socket that was handed the coordinator snapshot and has not registered as host yet */
  pendingCoordinator: null,
};

function loadOfficial() {
  try {
    const metaFile = path.join(DATA_DIR, 'public-world.json');
    if (fs.existsSync(metaFile)) {
      const d = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      official.seed = d.seed ?? official.seed;
      official.meta = d.meta ?? null;
      official.playerData = d.playerData ?? {};
    }
    const blobFile = path.join(DATA_DIR, 'public-chunks.bin');
    if (fs.existsSync(blobFile)) {
      const buf = fs.readFileSync(blobFile);
      const indexLen = buf.readUInt32LE(0);
      const index = JSON.parse(buf.subarray(4, 4 + indexLen).toString('utf8'));
      let o = 4 + indexLen;
      for (const [key, len] of index) { official.chunks.set(key, buf.subarray(o, o + len)); o += len; }
    }
    console.log(`[world] public world seed ${official.seed}, ${official.chunks.size} stored chunks`);
  } catch (e) { console.error('[world] load failed', e); }
}

function saveOfficial() {
  if (!official.dirty) return;
  official.dirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'public-world.json'), JSON.stringify({ seed: official.seed, meta: official.meta, playerData: official.playerData }));
    const index = [], parts = [];
    for (const [key, buf] of official.chunks) { index.push([key, buf.length]); parts.push(buf); }
    const head = Buffer.from(JSON.stringify(index), 'utf8');
    const len = Buffer.alloc(4); len.writeUInt32LE(head.length, 0);
    fs.writeFileSync(path.join(DATA_DIR, 'public-chunks.bin'), Buffer.concat([len, head, ...parts]));
  } catch (e) { console.error('[world] save failed', e); }
}
setInterval(saveOfficial, 60_000).unref?.();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveOfficial(); process.exit(0); });

// ---------------------------------------------------------------- http

const http_ = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/servers') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(listServers()));
    return;
  }
  if (url.pathname === '/api/health' || url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Build the game first: npm run build'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
});

// permessage-deflate: chunk frames and the JSON entity/block traffic shrink several times over the wire, in both
// directions (browsers compress what they send once the extension is negotiated)
const wss = new WebSocketServer({ server: http_, path: '/ws', maxPayload: 64 * 1024 * 1024, perMessageDeflate: { threshold: 512, zlibDeflateOptions: { level: 4, memLevel: 7 }, concurrencyLimit: 8 } });

/** Player-hosted servers plus the backend-owned official server. */
const servers = new Map();
let nextClientId = 1;

function listServers() {
  const out = [{ id: OFFICIAL_ID, name: official.name, host: '', motd: official.motd, players: servers.get(OFFICIAL_ID) ? servers.get(OFFICIAL_ID).guests.size + 1 : 0, maxPlayers: OFFICIAL_MAX, gameMode: official.gameMode, version: 'public', private: false, official: true, online: true }];
  for (const s of servers.values()) {
    if (s.id === OFFICIAL_ID) continue;
    out.push({ id: s.id, name: s.info.name, host: s.info.host, motd: s.info.motd ?? '', players: s.guests.size + 1, maxPlayers: s.info.maxPlayers ?? MAX_PLAYERS_DEFAULT, gameMode: s.info.gameMode, version: s.info.version, private: !!s.info.password, official: false, online: true });
  }
  return out;
}

const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const sendBin = (ws, buf) => { if (ws && ws.readyState === 1) ws.send(buf); };

/** Hand an automatically selected client the live-simulation coordinator snapshot. */
function assignOfficialCoordinator(ws) {
  send(ws, { t: 'becomeCoordinator', id: OFFICIAL_ID, world: { seed: official.seed, name: official.name, motd: official.motd, gameMode: official.gameMode, difficulty: official.difficulty, cheats: official.cheats, meta: official.meta, playerData: official.playerData, maxPlayers: OFFICIAL_MAX }, chunkCount: official.chunks.size });
  for (const buf of official.chunks.values()) sendBin(ws, buf);
  send(ws, { t: 'worldReady' });
}

// Keep idle sockets alive through proxies and drop the ones that stopped answering (browsers answer pings
// themselves, even from background tabs).
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.alive === false) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }
}, HEARTBEAT_MS).unref?.();

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  let role = null;          // 'host' | 'guest'
  let server = null;        // the server record this socket belongs to
  let clientId = 0;
  let playerId = '';
  let javaSession = null;
  let rateWindow = Date.now();
  let rateMessages = 0;

  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    if (now - rateWindow >= 1000) { rateWindow = now; rateMessages = 0; }
    if (role !== 'host' && ++rateMessages > MAX_GUEST_MESSAGES_PER_SECOND) { ws.close(1008, 'Too many messages'); return; }
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (role !== 'host') return; // guests and Java clients never have a valid binary control message
      if (role === 'host' && server) {
        const target = buf.readUInt32LE(0); const payload = buf.subarray(4);
        if (target === 0xffffffff) { // persist a chunk of the public world
          if (server.id !== OFFICIAL_ID) return;
          const key = readChunkKey(payload);
          if (!key) return;
          if (!official.chunks.has(key) && official.chunks.size >= MAX_STORED_CHUNKS) return;
          official.chunks.set(key, Buffer.from(payload));
          official.dirty = true;
          return;
        }
        if (target === 0) { for (const g of server.guests.values()) sendBin(g, payload); }
        else sendBin(server.guests.get(target), payload);
      }
      return;
    }
    if (Buffer.byteLength(data) > (role === 'host' ? MAX_HOST_CONTROL_BYTES : MAX_GUEST_CONTROL_BYTES)) { ws.close(1009, 'Control message too large'); return; }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    switch (m.t) {
      case 'javaPing': {
        if (role) return;
        pingJavaServer(m.address).then((status) => send(ws, { t: 'javaStatus', status })).catch((error) => send(ws, { t: 'error', reason: error?.message ?? String(error) }));
        break;
      }
      case 'javaConnect': {
        if (role) return;
        role = 'java';
        createJavaSession({ address: m.address, username: m.username, auth: m.auth, profilesFolder: path.join(DATA_DIR, 'auth'), send: (message) => send(ws, message), sendBinary: (data) => sendBin(ws, data) })
          .then((session) => { javaSession = session; })
          .catch((error) => { send(ws, { t: 'error', reason: error?.message ?? String(error) }); try { ws.close(); } catch { /* */ } });
        break;
      }
      case 'javaIntent': { if (role === 'java' && javaSession) javaSession.intent(m.intent); break; }
      case 'host': {
        if (role) return;
        if (!String(m.version ?? '').endsWith(`/${VOXELAND_PROTOCOL}`)) { send(ws, { t: 'error', reason: 'This page is out of date. Reload before hosting a world.' }); return; }
        const wantOfficial = m.official === true;
        if (wantOfficial && servers.has(OFFICIAL_ID)) { send(ws, { t: 'error', reason: 'The public world is already active.' }); return; }
        if (wantOfficial) official.pendingCoordinator = null;
        role = 'host';
        const id = wantOfficial ? OFFICIAL_ID : Math.random().toString(36).slice(2, 10);
        server = {
          id, ws, guests: new Map(), official: wantOfficial, playerId: String(m.playerId ?? '').slice(0, 80),
          info: {
            name: wantOfficial ? official.name : String(m.name ?? 'VoxeLand world').slice(0, 48),
            host: String(m.host ?? 'Player').slice(0, 24),
            motd: wantOfficial ? official.motd : String(m.motd ?? '').slice(0, 64),
            maxPlayers: wantOfficial ? OFFICIAL_MAX : Math.min(32, Math.max(1, m.maxPlayers ?? MAX_PLAYERS_DEFAULT)),
            gameMode: m.gameMode, version: m.version,
            password: wantOfficial ? '' : String(m.password ?? '').slice(0, 64),
          },
        };
        servers.set(id, server);
        send(ws, { t: 'hosted', id, private: !!server.info.password, official: wantOfficial });
        console.log(`[relay] hosted ${id} "${server.info.name}" by ${server.info.host}${server.info.password ? ' (private)' : ''}${wantOfficial ? ' [public world]' : ''}`);
        break;
      }
      case 'update': {
        if (role !== 'host' || !server) return;
        if (m.gameMode) server.info.gameMode = m.gameMode;
        if (m.motd !== undefined && !server.official) server.info.motd = String(m.motd).slice(0, 64);
        if (m.password !== undefined && !server.official) server.info.password = String(m.password).slice(0, 64);
        break;
      }
      case 'meta': { // public world: time / weather / rules / per-player data
        if (role !== 'host' || !server?.official) return;
        if (m.meta) official.meta = m.meta;
        if (m.playerData) Object.assign(official.playerData, m.playerData);
        official.dirty = true;
        break;
      }
      case 'playerState': { // public world: the coordinator's own player, stored separately from world state
        if (role !== 'host' || !server?.official || !m.saved) return;
        const key = String(m.playerId ?? '').slice(0, 80);
        if (key) { official.playerData[key] = m.saved; official.dirty = true; }
        break;
      }
      case 'list': send(ws, { t: 'servers', servers: listServers() }); break;
      case 'join': {
        if (role) return;
        if (!String(m.version ?? '').endsWith(`/${VOXELAND_PROTOCOL}`)) { send(ws, { t: 'error', reason: 'This page is out of date. Reload before joining multiplayer.' }); return; }
        if (m.id === OFFICIAL_ID && !servers.has(OFFICIAL_ID)) {
          // two players joining an idle public world at once: only one may become its coordinator
          const pending = official.pendingCoordinator;
          if (pending && pending !== ws && pending.readyState === 1) { send(ws, { t: 'error', reason: 'The public world is starting up. Try again in a moment.', retry: true }); return; }
          official.pendingCoordinator = ws;
          assignOfficialCoordinator(ws); return;
        }
        const s = servers.get(m.id);
        if (!s) { send(ws, { t: 'error', reason: 'That server is no longer online.' }); return; }
        if (String(m.version ?? '') !== String(s.info.version ?? '')) { send(ws, { t: 'error', reason: 'Multiplayer version mismatch. Reload the page and try again.' }); return; }
        if (s.guests.size + 1 >= (s.info.maxPlayers ?? MAX_PLAYERS_DEFAULT)) { send(ws, { t: 'error', reason: 'The server is full.' }); return; }
        if (s.info.password && String(m.password ?? '') !== s.info.password) { send(ws, { t: 'error', reason: 'Incorrect password.', needPassword: true }); return; }
        // vanilla PlayerList.placeNewPlayer: the same account logging in again kicks its earlier session
        // ("You logged in from another location"); a different account using a taken name is refused
        const joinId = String(m.playerId ?? m.name ?? 'Player').slice(0, 80), joinName = String(m.name ?? 'Player').slice(0, 16);
        if (joinId && joinId === s.playerId) { send(ws, { t: 'error', reason: 'You are already playing in this world from another tab.' }); return; }
        if (joinName.toLowerCase() === String(s.info.host).toLowerCase()) { send(ws, { t: 'error', reason: 'That name is already taken' }); return; }
        for (const [gid, g] of s.guests) {
          if (g.playerId === joinId) { send(g, { t: 'kicked', reason: 'You logged in from another location' }); g.close(); s.guests.delete(gid); send(s.ws, { t: 'guestLeft', from: gid }); }
          else if (String(g.playerName).toLowerCase() === joinName.toLowerCase()) { send(ws, { t: 'error', reason: 'That name is already taken' }); return; }
        }
        role = 'guest'; server = s; clientId = nextClientId++;
        playerId = joinId;
        ws.playerId = playerId; ws.playerName = joinName;
        s.guests.set(clientId, ws);
        send(ws, { t: 'joined', id: s.id, clientId, info: { name: s.info.name, host: s.official ? '' : s.info.host, motd: s.info.motd, gameMode: s.info.gameMode, maxPlayers: s.info.maxPlayers, official: s.official } });
        send(s.ws, { t: 'guestJoined', from: clientId, playerId, name: String(m.name ?? 'Player').slice(0, 16), skin: m.skin });
        break;
      }
      case 'msg': { // envelope: { t:'msg', to?, d: payload }
        const d = m.d; if (!d || typeof d !== 'object') return;
        if (role === 'host' && server) {
          const to = m.to;
          if (!to) { const text = JSON.stringify(d); for (const g of server.guests.values()) if (g.readyState === 1) g.send(text); }
          else send(server.guests.get(to), d);
        } else if (role === 'guest' && server) {
          // The backend owns official-world player records. Saving here means a guest's inventory is never
          // dependent on the coordinator flushing it, and can never become the coordinator's inventory.
          if (server.official && d.t === 'move' && d.saved && playerId) {
            official.playerData[playerId] = d.saved;
            official.dirty = true;
          }
          d.from = clientId; send(server.ws, d);
        }
        break;
      }
      case 'kick': { if (role === 'host' && server) { const g = server.guests.get(m.id); if (g) { send(g, { t: 'kicked', reason: m.reason ?? 'Kicked by the host' }); g.close(); } } break; }
      case 'ping': send(ws, { t: 'pong', time: m.time }); break;
    }
  });

  ws.on('close', () => {
    if (official.pendingCoordinator === ws) official.pendingCoordinator = null;
    if (role === 'java') { javaSession?.close(); return; }
    if (role === 'host' && server) {
      servers.delete(server.id);
      if (server.official) {
        saveOfficial();
        // The backend-owned world lives on and automatically selects another live-simulation coordinator.
        for (const g of server.guests.values()) { send(g, { t: 'rehost', id: OFFICIAL_ID, reason: 'Reconnecting to the public world…' }); g.close(); }
        console.log('[relay] public world coordinator changed; world saved');
      } else {
        for (const g of server.guests.values()) { send(g, { t: 'kicked', reason: 'The host closed the world.' }); g.close(); }
        console.log(`[relay] closed ${server.id}`);
      }
    } else if (role === 'guest' && server) {
      server.guests.delete(clientId);
      send(server.ws, { t: 'guestLeft', from: clientId });
    }
  });
});

/** Chunk frames start with [kind u8][json length u32][json] — read cx/cz/dim without decoding the body. */
function readChunkKey(payload) {
  try {
    const len = payload.readUInt32LE(1);
    const head = JSON.parse(payload.subarray(5, 5 + len).toString('utf8'));
    if (typeof head.cx !== 'number' || typeof head.cz !== 'number') return null;
    return `${head.dim ?? 'overworld'}:${head.cx},${head.cz}`;
  } catch { return null; }
}

loadOfficial();
http_.listen(PORT, () => {
  console.log(`VoxeLand server on http://localhost:${PORT}  (relay /ws, Java ${JAVA_VERSION} gateway, public world "${official.name}", serving ${DIST})`);
});
