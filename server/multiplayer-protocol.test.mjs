import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/net/protocol.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const protocol = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const relaySource = await readFile(new URL('./index.mjs', import.meta.url), 'utf8');

test('relay and game require the same multiplayer protocol', () => {
  const relayProtocol = Number(relaySource.match(/const VOXELAND_PROTOCOL = (\d+);/)?.[1]);
  assert.equal(relayProtocol, protocol.PROTOCOL_VERSION);
  assert.match(relaySource, /case 'join':[\s\S]*endsWith\(`\/\$\{VOXELAND_PROTOCOL\}`\)[\s\S]*assignOfficialCoordinator/);
});

test('accepts revisioned inventory and container transactions', () => {
  assert.equal(protocol.isGuestMessage({ t: 'invTxn', rev: 0, inventory: [], armor: [], offhand: [], grid: [] }), true);
  assert.equal(protocol.isGuestMessage({ t: 'contTxn', rev: 4, inventory: [], armor: [], offhand: [], slots: [] }), true);
});

test('rejects malformed or unrevisioned inventory transactions', () => {
  assert.equal(protocol.isGuestMessage({ t: 'invTxn', rev: 0.5, inventory: [], armor: [], offhand: [], grid: [] }), false);
  assert.equal(protocol.isGuestMessage({ t: 'contTxn', rev: 1, inventory: {}, armor: [], offhand: [], slots: [] }), false);
  assert.equal(protocol.isGuestMessage({ t: 'invTxn', inventory: [], armor: [], offhand: [], grid: [] }), false);
});

test('stale successful inventory acknowledgements cannot roll back newer guest clicks', () => {
  assert.equal(protocol.shouldApplyInventoryState(2, 1, true), false);
  assert.equal(protocol.shouldApplyInventoryState(2, 2, true), true);
  assert.equal(protocol.shouldApplyInventoryState(2, 1, false), true);
});

test('stack identity excludes quantity so guest drag splitting conserves items', () => {
  const whole = protocol.serializedStackIdentity({ n: 'oak_planks', c: 12 });
  const splitA = protocol.serializedStackIdentity({ n: 'oak_planks', c: 5 });
  const splitB = protocol.serializedStackIdentity({ n: 'oak_planks', c: 7 });
  assert.equal(whole.key, splitA.key);
  assert.equal(splitA.key, splitB.key);
  assert.equal(splitA.count + splitB.count, whole.count);
});
