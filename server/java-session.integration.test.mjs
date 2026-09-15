import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import minecraftProtocolModule from 'minecraft-protocol';
import minecraftDataLoader from 'minecraft-data';

const minecraftProtocol = minecraftProtocolModule.default ?? minecraftProtocolModule;

test('gateway logs into a real 26.1 protocol server and reaches play state', { timeout: 15_000 }, async () => {
  process.env.ALLOW_PRIVATE_MINECRAFT = 'true';
  const { createJavaSession, JAVA_VERSION } = await import(`./java-gateway.mjs?integration=${Date.now()}`);
  const server = minecraftProtocol.createServer({ version: JAVA_VERSION, host: '127.0.0.1', port: 0, 'online-mode': false, motd: 'VoxeLand test' });
  const mcData = minecraftDataLoader(JAVA_VERSION);
  let receiveMovement;
  const movement = new Promise((resolve) => { receiveMovement = resolve; });
  let receiveAttack, receiveUse;
  const attack = new Promise((resolve) => { receiveAttack = resolve; });
  const use = new Promise((resolve) => { receiveUse = resolve; });
  server.on('playerJoin', (client) => {
    client.write('login', { ...mcData.loginPacket, entityId: client.id, enforcesSecureChat: false });
    client.write('position', { teleportId: 1, x: 0, y: 80, z: 0, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: { x: false, y: false, z: false, yaw: false, pitch: false, dx: false, dy: false, dz: false, rotateDelta: false } });
    client.on('position_look', receiveMovement);
    client.on('attack', receiveAttack);
    client.on('use_entity', receiveUse);
  });
  await once(server, 'listening');
  const port = server.socketServer.address().port;
  const messages = [];
  let gatewaySession;
  const reachedPlay = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway did not reach play state')), 10_000);
    const receive = (message) => {
      messages.push(message);
      if (message.t === 'javaState' && message.state === 'play') { clearTimeout(timer); resolve(); }
      if (message.t === 'javaError') { clearTimeout(timer); reject(new Error(message.reason)); }
    };
    createJavaSession({ address: `127.0.0.1:${port}`, username: 'GatewayTest', auth: 'offline', profilesFolder: '/tmp/voxeland-test-auth', send: receive, sendBinary: () => {} })
      .then((session) => { gatewaySession = session; })
      .catch(reject);
  });
  try {
    await reachedPlay;
    assert.ok(messages.some((message) => message.t === 'javaState' && message.state === 'tcp_connected'));
    assert.ok(messages.some((message) => message.t === 'javaPacket' && message.name === 'login'));
    gatewaySession.intent({ kind: 'move', x: 1, y: 80, z: 2, yaw: 90, pitch: 0, onGround: true });
    const moved = await movement;
    assert.equal(moved.x, 1); assert.equal(moved.z, 2); assert.equal(moved.flags.onGround, true);
    gatewaySession.intent({ kind: 'attack_entity', id: 42 });
    gatewaySession.intent({ kind: 'use_entity', id: 43, sneaking: true });
    assert.equal((await attack).entityId, 42);
    const used = await use; assert.equal(used.target, 43); assert.equal(used.hand, 'main_hand'); assert.equal(used.sneaking, true);
  } finally {
    gatewaySession?.close();
    server.close();
  }
});
