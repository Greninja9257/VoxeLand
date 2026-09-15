// Minecraft Java TCP gateway. Browsers cannot open TCP sockets, so each WebSocket session owns one
// minecraft-protocol client. The browser receives decoded server packets but may only send a small set of
// semantic intentions; it can never ask the gateway to write an arbitrary packet.
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import minecraftProtocolModule from 'minecraft-protocol';
import minecraftDataLoader from 'minecraft-data';
import prismarineChunkLoader from 'prismarine-chunk';

const minecraftProtocol = minecraftProtocolModule.default ?? minecraftProtocolModule;
export const JAVA_VERSION = minecraftProtocol.defaultVersion;
const mcData = minecraftDataLoader(JAVA_VERSION);
const JavaChunk = prismarineChunkLoader(JAVA_VERSION);
const CHAT_COLORS = { black: '0', dark_blue: '1', dark_green: '2', dark_aqua: '3', dark_red: '4', dark_purple: '5', gold: '6', gray: '7', dark_gray: '8', blue: '9', green: 'a', aqua: 'b', red: 'c', light_purple: 'd', yellow: 'e', white: 'f' };
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_MINECRAFT === 'true';
const ALLOWED_HOSTS = new Set((process.env.MINECRAFT_ALLOWED_HOSTS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));

export function parseJavaAddress(input) {
  const value = String(input ?? '').trim();
  if (!value || value.length > 255 || /[\s/\\@]/.test(value)) throw new Error('Invalid Minecraft server address.');
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) throw new Error('Invalid IPv6 server address.');
    const host = value.slice(1, end);
    const port = value.slice(end + 1).startsWith(':') ? Number(value.slice(end + 2)) : 25565;
    if (!net.isIPv6(host) || !validPort(port)) throw new Error('Invalid Minecraft server address.');
    return { host, port };
  }
  const colon = value.lastIndexOf(':');
  const hasPort = colon > 0 && value.indexOf(':') === colon;
  const host = (hasPort ? value.slice(0, colon) : value).toLowerCase();
  const port = hasPort ? Number(value.slice(colon + 1)) : 25565;
  if (!host || !/^[a-z0-9._-]+$/i.test(host) || !validPort(port)) throw new Error('Invalid Minecraft server address.');
  return { host, port };
}

function validPort(port) { return Number.isInteger(port) && port > 0 && port <= 65535; }
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const n = ip.toLowerCase();
  return n === '::1' || n === '::' || n.startsWith('fc') || n.startsWith('fd') || /^fe[89ab]/.test(n);
}

async function assertAllowed(address) {
  if (ALLOW_PRIVATE || ALLOWED_HOSTS.has(address.host)) return;
  const resolved = await dns.lookup(address.host, { all: true, verbatim: true });
  if (!resolved.length || resolved.some((x) => privateIp(x.address))) throw new Error('Private-network Minecraft servers are disabled on this gateway.');
}

function jsonSafe(value, depth = 0) {
  if (depth > 24) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map((x) => jsonSafe(x, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = jsonSafe(item, depth + 1);
    return out;
  }
  return value;
}

function unwrapNbt(value) {
  if (Array.isArray(value)) return value.map(unwrapNbt);
  if (!value || typeof value !== 'object') return value;
  if (typeof value.type === 'string' && Object.hasOwn(value, 'value')) {
    if (value.type === 'compound') return unwrapNbt(value.value);
    if (value.type === 'list') return unwrapNbt(value.value?.value ?? value.value);
    return value.value;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = unwrapNbt(item);
  return out;
}

function stylePrefix(style) {
  let out = '§r';
  const color = style.color;
  if (typeof color === 'string') {
    const named = CHAT_COLORS[color.toLowerCase()];
    if (named) out += `§${named}`;
    else if (/^#[0-9a-f]{6}$/i.test(color)) out += `§x${[...color.slice(1)].map((c) => `§${c}`).join('')}`;
  }
  if (style.obfuscated) out += '§k';
  if (style.bold) out += '§l';
  if (style.strikethrough) out += '§m';
  if (style.underlined || style.underline) out += '§n';
  if (style.italic) out += '§o';
  return out;
}

function applyTranslation(template, args, style) {
  let automatic = 0;
  return template.replace(/%%|%(?:(\d+)\$)?s/g, (token, explicit) => {
    if (token === '%%') return '%';
    const index = explicit ? Number(explicit) - 1 : automatic++;
    return renderText(args[index] ?? '', style);
  });
}

function renderText(component, inherited) {
  if (component == null) return '';
  if (Array.isArray(component)) return component.map((part) => renderText(part, inherited)).join('');
  if (typeof component !== 'object') return stylePrefix(inherited) + String(component);
  const style = { ...inherited };
  for (const key of ['color', 'bold', 'italic', 'underlined', 'underline', 'strikethrough', 'obfuscated']) if (component[key] !== undefined) style[key] = component[key];
  let body = '';
  if (component.text !== undefined) body = stylePrefix(style) + String(component.text);
  else if (component.translate !== undefined) {
    const template = mcData.language?.[component.translate] ?? String(component.translate);
    body = stylePrefix(style) + applyTranslation(template, component.with ?? [], style);
  } else if (component.keybind !== undefined) body = stylePrefix(style) + String(component.keybind);
  else if (component.selector !== undefined) body = stylePrefix(style) + String(component.selector);
  if (component.extra) body += renderText(component.extra, style);
  return body;
}

/** Convert a network NBT/JSON text component into formatting codes understood by VoxeLand's font. */
export function formatJavaTextComponent(component) {
  return renderText(unwrapNbt(component), {}).replace(/^§r/, '');
}

function formattedChat(metaName, data) {
  if (metaName === 'system_chat') return formatJavaTextComponent(data.content);
  if (metaName === 'player_chat') {
    const name = formatJavaTextComponent(data.networkName);
    const message = formatJavaTextComponent(data.unsignedChatContent ?? data.plainMessage);
    return `${name ? `${name}§r: ` : ''}${message}`;
  }
  if (metaName === 'profileless_chat') {
    const name = formatJavaTextComponent(data.name);
    return `${name ? `${name}§r: ` : ''}${formatJavaTextComponent(data.message)}`;
  }
  return null;
}

function rle(values, wordBytes) {
  const parts = [];
  for (let i = 0; i < values.length;) {
    const value = values[i]; let count = 1;
    const max = wordBytes === 2 ? 65535 : 255;
    while (i + count < values.length && values[i + count] === value && count < max) count++;
    if (wordBytes === 2) { const b = Buffer.allocUnsafe(4); b.writeUInt16LE(count, 0); b.writeUInt16LE(value, 2); parts.push(b); }
    else parts.push(Buffer.from([count, value]));
    i += count;
  }
  return Buffer.concat(parts);
}

/** Convert a vanilla 26.1 chunk into VoxeLand's existing fixed-height binary chunk frame. */
export function encodeChunkPacket(packet, dimension = { name: 'overworld', minY: -64, height: 384 }) {
  const minY = Number.isInteger(dimension.minY) ? dimension.minY : -64;
  const height = Number.isInteger(dimension.height) && dimension.height > 0 && dimension.height % 16 === 0 ? dimension.height : 384;
  const chunkData = Buffer.from(packet.chunkData);
  let column = new JavaChunk({ minY, worldHeight: height });
  try {
    column.load(chunkData);
  } catch (originalError) {
    // Some protocol translators advertise the modern Overworld height but emit the old 0..255
    // section stream. Accept a candidate only when re-serialising consumes exactly the whole packet.
    column = null;
    for (let candidateHeight = 16; candidateHeight <= 384; candidateHeight += 16) {
      try {
        const candidate = new JavaChunk({ minY: 0, worldHeight: candidateHeight });
        candidate.load(chunkData);
        if (candidate.dump().length === chunkData.length) { column = candidate; dimension.minY = 0; dimension.height = candidateHeight; break; }
      } catch { /* not this section count */ }
    }
    if (!column) throw originalError;
  }
  column.loadParsedLight(packet.skyLight, packet.blockLight, packet.skyLightMask, packet.blockLightMask, packet.emptySkyLightMask, packet.emptyBlockLightMask);
  const sectionParts = [], lightParts = [], sections = [], light = [];
  const heightmap = new Array(256).fill(-64), skyHeight = new Array(256).fill(-64), biomes = new Array(256).fill(0);
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const i = z * 16 + x;
    for (let y = 319; y >= -64; y--) {
      const rawState = column.getBlockStateId({ x, y, z }) ?? 0;
      const state = mcData.blocksByStateId[rawState] ? rawState : 0;
      if (!state) continue;
      if (skyHeight[i] === -64) skyHeight[i] = y + 1;
      const block = mcData.blocksByStateId[state];
      if (block?.boundingBox === 'block') { heightmap[i] = y + 1; break; }
    }
    biomes[i] = column.getBiome({ x, y: Math.max(-64, heightmap[i] - 1), z }) ?? 0;
  }
  for (let sy = 0; sy < 24; sy++) {
    const states = new Uint16Array(4096), lights = new Uint8Array(4096); let nonAir = false, nonDefaultLight = false;
    const y0 = -64 + sy * 16;
    for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const pos = { x, y: y0 + y, z }, index = (y << 8) | (z << 4) | x;
      const rawState = column.getBlockStateId(pos) ?? 0;
      const state = mcData.blocksByStateId[rawState] ? rawState : 0;
      states[index] = state; if (state) nonAir = true;
      // Vanilla's direct skylight is always 15 above the top sky-blocking block. Some protocol
      // translators send zero-filled light cells there, which otherwise renders exposed terrain black.
      const directSky = dimension.name === 'overworld' && pos.y >= skyHeight[z * 16 + x];
      const packedLight = ((directSky ? 15 : (column.getSkyLight(pos) ?? 0)) << 4) | (column.getBlockLight(pos) ?? 0);
      lights[index] = packedLight; if (packedLight !== 0xf0) nonDefaultLight = true;
    }
    if (nonAir) { const enc = rle(states, 2); sections.push(enc.length); sectionParts.push(enc); } else sections.push(null);
    if (nonDefaultLight) { const enc = rle(lights, 1); light.push(enc.length); lightParts.push(enc); } else light.push(null);
  }
  const header = { cx: packet.x, cz: packet.z, dim: dimension.name, sections, light, heightmap, skyHeight, biomes, blockEntities: [] };
  const json = Buffer.from(JSON.stringify(header)); const prefix = Buffer.allocUnsafe(5);
  prefix[0] = 1; prefix.writeUInt32LE(json.length, 1);
  return Buffer.concat([prefix, json, ...sectionParts, ...lightParts]);
}

export async function pingJavaServer(input) {
  const address = parseJavaAddress(input);
  await assertAllowed(address);
  const result = await minecraftProtocol.ping({ ...address, version: JAVA_VERSION, closeTimeout: 5000 });
  return jsonSafe({ ...result, requestedVersion: JAVA_VERSION });
}

export async function createJavaSession({ address: input, username, auth = 'offline', profilesFolder, send, sendBinary }) {
  const address = parseJavaAddress(input);
  await assertAllowed(address);
  if (auth !== 'offline' && auth !== 'microsoft') throw new Error('Unsupported authentication mode.');
  const safeName = String(username ?? 'Player').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'Player';
  const options = {
    ...address, username: safeName, auth, version: JAVA_VERSION, hideErrors: true,
    profilesFolder: path.resolve(profilesFolder),
    onMsaCode: (code) => send({ t: 'javaAuthCode', code: jsonSafe(code) }),
    clientSettings: { locale: 'en_us', viewDistance: 10, chatFlags: 0, chatColors: true, skinParts: 0x7f, mainHand: 1 },
  };
  const client = minecraftProtocol.createClient(options);
  let closed = false;
  let dimension = { name: 'overworld', minY: -64, height: 384 };
  client.on('connect', () => send({ t: 'javaState', state: 'tcp_connected', version: JAVA_VERSION }));
  client.on('login', () => send({ t: 'javaState', state: 'play', username: client.username, uuid: client.uuid, version: client.version }));
  client.on('packet', (data, meta) => {
    if (closed || meta.state !== 'play') return;
    if (meta.name === 'login' || meta.name === 'respawn') {
      const name = data.worldState?.name ?? data.name ?? '';
      const type = client.registry?.dimensionsById?.[data.worldState?.dimension];
      dimension = {
        name: name.includes('the_nether') ? 'the_nether' : name.includes('the_end') ? 'the_end' : 'overworld',
        minY: Number.isInteger(type?.minY) ? type.minY : -64,
        height: Number.isInteger(type?.height) ? type.height : 384,
      };
    }
    if (meta.name === 'map_chunk') {
      try { sendBinary(encodeChunkPacket(data, dimension)); } catch (error) { send({ t: 'javaWarning', reason: `Skipped malformed chunk ${data.x},${data.z}: ${error?.message ?? error}` }); }
      return;
    }
    if (meta.name === 'chunk_batch_finished') client.write('chunk_batch_received', { chunksPerTick: 12 });
    const packet = jsonSafe(data);
    const chat = formattedChat(meta.name, data);
    if (chat !== null) packet.formatted = chat;
    send({ t: 'javaPacket', name: meta.name, data: packet });
  });
  client.on('error', (error) => send({ t: 'javaError', reason: error?.message ?? String(error) }));
  client.on('end', (reason) => { closed = true; send({ t: 'javaEnd', reason: String(reason ?? 'Connection closed') }); });

  return {
    intent(message) {
      if (!message || typeof message !== 'object') return;
      switch (message.kind) {
        case 'move': {
          const { x, y, z, yaw, pitch, onGround } = message;
          if (![x, y, z, yaw, pitch].every(Number.isFinite)) return;
          client.write('position_look', { x, y, z, yaw, pitch, flags: { onGround: !!onGround, hasHorizontalCollision: false } });
          break;
        }
        case 'teleport_confirm': if (Number.isInteger(message.id)) client.write('teleport_confirm', { teleportId: message.id }); break;
        case 'chat': if (typeof message.text === 'string' && message.text.length <= 256) client.chat(message.text); break;
        case 'held_slot': if (Number.isInteger(message.slot) && message.slot >= 0 && message.slot < 9) client.write('held_item_slot', { slotId: message.slot }); break;
        case 'dig': {
          if (![message.x, message.y, message.z, message.face, message.status, message.sequence].every(Number.isInteger)) break;
          if (message.status < 0 || message.status > 2 || message.face < 0 || message.face > 5) break;
          client.write('block_dig', { status: message.status, location: { x: message.x, y: message.y, z: message.z }, face: message.face, sequence: message.sequence });
          break;
        }
        case 'use_block': {
          if (![message.x, message.y, message.z, message.face, message.sequence].every(Number.isInteger)) break;
          const cursor = Array.isArray(message.cursor) ? message.cursor.map((x) => Math.max(0, Math.min(1, Number(x) || 0))) : [0.5, 0.5, 0.5];
          client.write('block_place', { hand: 0, location: { x: message.x, y: message.y, z: message.z }, direction: message.face, cursorX: cursor[0], cursorY: cursor[1], cursorZ: cursor[2], insideBlock: false, worldBorderHit: false, sequence: message.sequence });
          break;
        }
        case 'attack_entity': if (Number.isInteger(message.id)) client.write('attack', { entityId: message.id }); break;
        case 'use_entity': if (Number.isInteger(message.id)) client.write('use_entity', { target: message.id, hand: 'main_hand', location: { x: 0, y: 0, z: 0 }, sneaking: !!message.sneaking }); break;
        case 'drop': if (Number.isInteger(message.sequence)) client.write('block_dig', { status: message.all ? 3 : 4, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: message.sequence }); break;
        case 'respawn': client.write('client_command', { actionId: 'perform_respawn' }); break;
        default: break;
      }
    },
    close() { closed = true; try { client.end('VoxeLand client disconnected'); } catch { /* already closed */ } },
  };
}
