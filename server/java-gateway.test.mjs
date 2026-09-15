import test from 'node:test';
import assert from 'node:assert/strict';
import prismarineChunkLoader from 'prismarine-chunk';
import { parseJavaAddress, encodeChunkPacket, formatJavaTextComponent, JAVA_VERSION } from './java-gateway.mjs';

test('uses an explicit supported Java protocol version', () => {
  assert.match(JAVA_VERSION, /^(?:\d+\.)*\d+$/);
});

test('parses Java hostnames, ports and bracketed IPv6', () => {
  assert.deepEqual(parseJavaAddress('play.example.com'), { host: 'play.example.com', port: 25565 });
  assert.deepEqual(parseJavaAddress('PLAY.EXAMPLE.COM:25566'), { host: 'play.example.com', port: 25566 });
  assert.deepEqual(parseJavaAddress('[2001:db8::1]:25567'), { host: '2001:db8::1', port: 25567 });
});

test('rejects URLs, credentials and invalid ports', () => {
  for (const input of ['', 'https://example.com', 'user@example.com', 'host:0', 'host:65536', 'host:not-a-port']) {
    assert.throws(() => parseJavaAddress(input));
  }
});

test('formats nested vanilla NBT chat components, translations and styles', () => {
  const component = { type: 'compound', value: {
    color: { type: 'string', value: 'yellow' },
    translate: { type: 'string', value: 'multiplayer.player.joined' },
    with: { type: 'list', value: { type: 'compound', value: [{
      bold: { type: 'byte', value: 1 }, text: { type: 'string', value: 'Alex' },
      extra: { type: 'list', value: { type: 'compound', value: [{ italic: { type: 'byte', value: 1 }, text: { type: 'string', value: '!' } }] } },
    }] } },
  } };
  const text = formatJavaTextComponent(component);
  assert.match(text, /§e/); assert.match(text, /§lAlex/); assert.match(text, /§o!/); assert.match(text, /joined the game/);
  assert.equal(formatJavaTextComponent({ text: 'RGB', color: '#12abef' }), '§x§1§2§a§b§e§fRGB');
});

test('detects translated legacy chunk height and writes all block sections before light data', () => {
  const JavaChunk = prismarineChunkLoader(JAVA_VERSION);
  const source = new JavaChunk({ minY: 0, worldHeight: 256 });
  source.setBlockStateId({ x: 1, y: 0, z: 2 }, 1);
  source.setBlockStateId({ x: 3, y: 16, z: 4 }, 2);
  const geometry = { name: 'overworld', minY: -64, height: 384 };
  const frame = encodeChunkPacket({
    x: 7, z: -9, chunkData: source.dump(),
    skyLight: [], blockLight: [], skyLightMask: [], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [],
  }, geometry);
  const jsonLength = frame.readUInt32LE(1);
  const header = JSON.parse(frame.subarray(5, 5 + jsonLength));
  let offset = 5 + jsonLength;
  const decoded = [];
  for (const length of header.sections) {
    if (length === null) { decoded.push(null); continue; }
    const values = new Uint16Array(4096); let out = 0;
    for (let end = offset + length; offset < end; offset += 4) {
      const count = frame.readUInt16LE(offset), value = frame.readUInt16LE(offset + 2);
      values.fill(value, out, out + count); out += count;
    }
    decoded.push(values);
  }
  assert.equal(header.cx, 7); assert.equal(header.cz, -9);
  assert.deepEqual(geometry, { name: 'overworld', minY: 0, height: 256 });
  assert.equal(decoded[4][(0 << 8) | (2 << 4) | 1], 1);
  assert.equal(decoded[5][(0 << 8) | (4 << 4) | 3], 2);
});
