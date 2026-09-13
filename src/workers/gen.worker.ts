// Terrain generation worker: builds a chunk + its initial (isolated) lighting.
import { BlockRegistry } from '../blocks/registry';
import { World, type Dimension } from '../world/world';
import { createGenerator, type Generator } from '../world/gen/index';

let reg: BlockRegistry, gen: Generator, world: World;

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    reg = new BlockRegistry(m.mcdata);
    world = new World(reg, m.dimension as Dimension);
    world.isolated = true;
    gen = createGenerator(m.dimension, m.seed, reg);
    (self as any).postMessage({ type: 'ready' });
  } else if (m.type === 'gen') {
    const t0 = performance.now();
    const chunk = gen.generate(m.cx, m.cz);
    world.chunks.clear();
    world.addChunk(chunk);
    world.light.lightChunk(chunk);
    const data = chunk.serialize();
    const transfer: ArrayBuffer[] = [];
    for (const s of data.sections) if (s) transfer.push(s.buffer as ArrayBuffer);
    for (const l of data.light ?? []) if (l) transfer.push(l.buffer as ArrayBuffer);
    transfer.push(data.heightmap.buffer as ArrayBuffer, data.biomes.buffer as ArrayBuffer);
    if (data.skyHeight) transfer.push(data.skyHeight.buffer as ArrayBuffer);
    (self as any).postMessage({ type: 'chunk', id: m.id, data, time: performance.now() - t0 }, transfer);
  } else if (m.type === 'spawn') {
    // find a decent spawn near the origin: land above sea level
    let best: [number, number, number] | null = null;
    for (let r = 0; r < 64 && !best; r += 8) {
      for (let a = 0; a < 16 && !best; a++) {
        const x = Math.round(Math.cos(a * Math.PI / 8) * r * 8), z = Math.round(Math.sin(a * Math.PI / 8) * r * 8);
        const y = gen.spawnHeight(x, z);
        if (y > 63 && y < 200) best = [x, y, z];
      }
    }
    (self as any).postMessage({ type: 'spawn', id: m.id, pos: best ?? [0, gen.spawnHeight(0, 0), 0] });
  }
};
