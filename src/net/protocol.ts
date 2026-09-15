// Multiplayer wire protocol. The relay server forwards JSON control messages and binary frames between a host
// (the browser running the world) and its guests. Binary frames carry chunk payloads:
//   host -> relay : [u32 targetClientId (0 = all guests)] [payload]
//   relay -> guest: [payload]
//   guest -> relay: [payload]           relay -> host: [u32 fromClientId] [payload]
// Payload: [u8 kind] [u32 jsonLength] [json utf8] [binary body]

export const PROTOCOL_VERSION = 7;

/** A server as advertised by a relay. `private` servers need a password; `official` is the backend's own world. */
export type ServerInfo = { id: string; name: string; host: string; motd: string; players: number; maxPlayers: number; gameMode: string; version: string; private: boolean; official: boolean; online?: boolean };

/** Binary frame target used by the public world's host to persist a chunk on the backend. */
export const TARGET_SERVER = 0xffffffff;

/** Chunk section run-length encoding (u16 values -> [count u16, value u16]*). */
export function rleEncode16(src: Uint16Array): Uint16Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    const v = src[i]; let n = 1;
    while (i + n < src.length && src[i + n] === v && n < 65535) n++;
    out.push(n, v); i += n;
  }
  return Uint16Array.from(out);
}
export function rleDecode16(src: Uint16Array, length: number): Uint16Array {
  const out = new Uint16Array(length);
  let o = 0;
  for (let i = 0; i < src.length; i += 2) { const n = src[i], v = src[i + 1]; out.fill(v, o, o + n); o += n; }
  return out;
}
export function rleEncode8(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    const v = src[i]; let n = 1;
    while (i + n < src.length && src[i + n] === v && n < 255) n++;
    out.push(n, v); i += n;
  }
  return Uint8Array.from(out);
}
export function rleDecode8(src: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let o = 0;
  for (let i = 0; i < src.length; i += 2) { const n = src[i], v = src[i + 1]; out.fill(v, o, o + n); o += n; }
  return out;
}

/** Serialised chunk for the network: sections/light RLE'd into one buffer with a JSON directory. */
export interface ChunkWire {
  cx: number; cz: number; dim?: string;
  sections: (number | null)[]; // byte length of each RLE section, null = empty
  light: (number | null)[];
  heightmap: number[]; skyHeight: number[]; biomes: number[];
  blockEntities: any[];
}

export function encodeChunk(c: { cx: number; cz: number; sections: (Uint16Array | null)[]; light: (Uint8Array | null)[]; heightmap: Int16Array; skyHeight: Int16Array; biomes: Uint8Array; blockEntities: Map<number, any> }, dim?: string): { header: ChunkWire; body: Uint8Array } {
  const parts: Uint8Array[] = [];
  const sections: (number | null)[] = [], light: (number | null)[] = [];
  for (const s of c.sections) {
    if (!s || !s.some((v) => v !== 0)) { sections.push(null); continue; }
    const enc = rleEncode16(s); const u8 = new Uint8Array(enc.buffer, enc.byteOffset, enc.byteLength); parts.push(u8); sections.push(u8.length);
  }
  for (const l of c.light) {
    if (!l) { light.push(null); continue; }
    const enc = rleEncode8(l); parts.push(enc); light.push(enc.length);
  }
  let total = 0; for (const p of parts) total += p.length;
  const body = new Uint8Array(total); let o = 0; for (const p of parts) { body.set(p, o); o += p.length; }
  return { header: { cx: c.cx, cz: c.cz, dim, sections, light, heightmap: Array.from(c.heightmap), skyHeight: Array.from(c.skyHeight), biomes: Array.from(c.biomes), blockEntities: [...c.blockEntities.values()] }, body };
}

export function decodeChunk(h: ChunkWire, body: Uint8Array): { cx: number; cz: number; sections: (Uint16Array | null)[]; light: (Uint8Array | null)[]; heightmap: Int16Array; skyHeight: Int16Array; biomes: Uint8Array; blockEntities: any[] } {
  let o = 0;
  const sections = h.sections.map((n) => { if (n === null) return null; const bytes = body.slice(o, o + n); o += n; return rleDecode16(new Uint16Array(bytes.buffer, 0, bytes.length >> 1), 4096); });
  const light = h.light.map((n) => { if (n === null) return null; const bytes = body.subarray(o, o + n); o += n; return rleDecode8(bytes, 4096); });
  return { cx: h.cx, cz: h.cz, sections, light, heightmap: Int16Array.from(h.heightmap), skyHeight: Int16Array.from(h.skyHeight), biomes: Uint8Array.from(h.biomes), blockEntities: h.blockEntities ?? [] };
}

/** Pack a binary frame: kind + json + body. */
export function packFrame(kind: number, json: any, body: Uint8Array): Uint8Array {
  const js = new TextEncoder().encode(JSON.stringify(json));
  const out = new Uint8Array(1 + 4 + js.length + body.length);
  const dv = new DataView(out.buffer);
  out[0] = kind; dv.setUint32(1, js.length, true); out.set(js, 5); out.set(body, 5 + js.length);
  return out;
}
export function unpackFrame(buf: Uint8Array): { kind: number; json: any; body: Uint8Array } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const kind = buf[0], len = dv.getUint32(1, true);
  const json = JSON.parse(new TextDecoder().decode(buf.subarray(5, 5 + len)));
  return { kind, json, body: buf.subarray(5 + len) };
}

export const FRAME_CHUNK = 1;

/** Turn anything the player may type (an IP, host:port, http(s):// or ws(s):// URL) into a relay WebSocket URL. */
export function normalizeRelayUrl(input: string): string {
  let t = input.trim();
  if (!t) return defaultRelayUrl();
  t = t.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  if (!/^wss?:\/\//i.test(t)) {
    // bare host / host:port — plain ws locally or on a private address, wss for public hosts
    const hostOnly = t.split('/')[0].split(':')[0];
    // plain ws for localhost and raw IPs (no certificate to validate), wss for real hostnames
    const plain = hostOnly === 'localhost' || !hostOnly.includes('.') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostOnly);
    t = (plain ? 'ws://' : 'wss://') + t;
  }
  t = t.replace(/\/+$/, '');
  if (!/\/ws$/.test(t)) t += '/ws';
  return t;
}

/** Default relay: same origin when served by the VoxeLand server, otherwise localhost:8080 (dev). */
export function defaultRelayUrl(): string {
  const loc = location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  if (loc.port === '5173' || loc.port === '4173') return `${proto}//${loc.hostname}:8080/ws`;
  return `${proto}//${loc.host}/ws`;
}
