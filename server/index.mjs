#!/usr/bin/env node
// VoxeLand multiplayer relay + static host.
//   node server/index.mjs            -> serves ./dist on :8080 and the WebSocket relay on /ws
//   PORT=... PUBLIC=1                -> on a public host (e.g. Railway) list "public" servers to everyone
//
// A browser that hosts a world connects as a "host" and registers its server; other browsers list servers
// and join. The relay only forwards messages (the host's browser is authoritative), so it needs no game logic
// and no persistent state. LAN-only servers are listed only to clients on private/loopback addresses.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const PORT = +(process.env.PORT || 8080);
const DIST = process.env.DIST || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const PUBLIC_HOST = process.env.PUBLIC === '1' || process.env.RAILWAY_ENVIRONMENT !== undefined;
const MAX_PLAYERS_DEFAULT = 8;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ogg': 'audio/ogg', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

const http_ = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/servers') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(listServers(isPrivateAddress(req.socket.remoteAddress))));
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

const wss = new WebSocketServer({ server: http_, path: '/ws', maxPayload: 64 * 1024 * 1024 });

/** @type {Map<string, {id:string, ws:import('ws').WebSocket, info:any, guests:Map<number, import('ws').WebSocket>, lan:boolean}>} */
const servers = new Map();
let nextClientId = 1;

function isPrivateAddress(addr) {
  if (!addr) return false;
  const a = addr.replace('::ffff:', '');
  return a === '127.0.0.1' || a === '::1' || a.startsWith('10.') || a.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || a.startsWith('fe80:') || a.startsWith('fd') || a === 'localhost';
}

function listServers(privateClient) {
  const out = [];
  for (const s of servers.values()) {
    if (!s.info.public && !(privateClient && s.lan)) continue;
    out.push({ id: s.id, name: s.info.name, host: s.info.host, motd: s.info.motd ?? '', players: s.guests.size + 1, maxPlayers: s.info.maxPlayers ?? MAX_PLAYERS_DEFAULT, gameMode: s.info.gameMode, version: s.info.version, public: !!s.info.public, lan: s.lan });
  }
  return out;
}

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

wss.on('connection', (ws, req) => {
  const privateClient = isPrivateAddress(req.socket.remoteAddress);
  let role = null; // 'host' | 'guest'
  let server = null; // server record (host: own; guest: joined)
  let clientId = 0;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (role === 'host' && server) {
        const target = buf.readUInt32LE(0); const payload = buf.subarray(4);
        if (target === 0) { for (const g of server.guests.values()) if (g.readyState === 1) g.send(payload); }
        else { const g = server.guests.get(target); if (g && g.readyState === 1) g.send(payload); }
      } else if (role === 'guest' && server) {
        const out = Buffer.alloc(4 + buf.length); out.writeUInt32LE(clientId, 0); buf.copy(out, 4);
        if (server.ws.readyState === 1) server.ws.send(out);
      }
      return;
    }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    switch (m.t) {
      case 'host': {
        if (role) return;
        role = 'host';
        const id = Math.random().toString(36).slice(2, 10);
        server = { id, ws, info: { name: String(m.name ?? 'VoxeLand world').slice(0, 48), host: String(m.host ?? 'Player').slice(0, 24), motd: String(m.motd ?? '').slice(0, 64), maxPlayers: Math.min(32, Math.max(1, m.maxPlayers ?? MAX_PLAYERS_DEFAULT)), gameMode: m.gameMode, version: m.version, public: !!m.public && (PUBLIC_HOST || !!m.forcePublic) }, guests: new Map(), lan: privateClient || !PUBLIC_HOST };
        servers.set(id, server);
        send(ws, { t: 'hosted', id, public: server.info.public, lan: server.lan });
        console.log(`[relay] hosted ${id} "${server.info.name}" by ${server.info.host} public=${server.info.public} lan=${server.lan}`);
        break;
      }
      case 'update': { if (role === 'host' && server) { if (m.gameMode) server.info.gameMode = m.gameMode; if (m.motd !== undefined) server.info.motd = String(m.motd).slice(0, 64); if (typeof m.public === 'boolean') server.info.public = m.public && (PUBLIC_HOST || !!m.forcePublic); } break; }
      case 'list': send(ws, { t: 'servers', servers: listServers(privateClient) }); break;
      case 'join': {
        if (role) return;
        const s = servers.get(m.id);
        if (!s) { send(ws, { t: 'error', reason: 'Server not found (it may have closed).' }); return; }
        if (s.guests.size + 1 >= (s.info.maxPlayers ?? MAX_PLAYERS_DEFAULT)) { send(ws, { t: 'error', reason: 'The server is full.' }); return; }
        if (!s.info.public && !(privateClient && s.lan)) { send(ws, { t: 'error', reason: 'That server is LAN-only.' }); return; }
        role = 'guest'; server = s; clientId = nextClientId++;
        s.guests.set(clientId, ws);
        send(ws, { t: 'joined', id: s.id, clientId, info: s.info });
        send(s.ws, { t: 'guestJoined', from: clientId, name: String(m.name ?? 'Player').slice(0, 16), skin: m.skin });
        break;
      }
      case 'msg': { // envelope: { t:'msg', to?, d: payload }
        const d = m.d; if (!d || typeof d !== 'object') return;
        if (role === 'host' && server) {
          const to = m.to;
          if (!to) { const text = JSON.stringify(d); for (const g of server.guests.values()) if (g.readyState === 1) g.send(text); }
          else { const g = server.guests.get(to); if (g && g.readyState === 1) g.send(JSON.stringify(d)); }
        } else if (role === 'guest' && server) { d.from = clientId; send(server.ws, d); }
        break;
      }
      case 'kick': { if (role === 'host' && server) { const g = server.guests.get(m.id); if (g) { send(g, { t: 'kicked', reason: m.reason ?? 'Kicked by the host' }); g.close(); } } break; }
      case 'ping': send(ws, { t: 'pong', time: m.time }); break;
    }
  });

  ws.on('close', () => {
    if (role === 'host' && server) {
      for (const g of server.guests.values()) { send(g, { t: 'kicked', reason: 'The host closed the world.' }); g.close(); }
      servers.delete(server.id);
      console.log(`[relay] closed ${server.id}`);
    } else if (role === 'guest' && server) {
      server.guests.delete(clientId);
      send(server.ws, { t: 'guestLeft', from: clientId });
    }
  });
});

http_.listen(PORT, () => {
  console.log(`VoxeLand server on http://localhost:${PORT}  (relay: /ws, ${PUBLIC_HOST ? 'public' : 'LAN'} mode, serving ${DIST})`);
});
