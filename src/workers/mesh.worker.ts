// Section meshing worker.
import { BlockRegistry } from '../blocks/registry';
import { ModelBaker } from '../render/models';
import { Mesher, type MeshInput } from '../render/mesher';

let mesher: Mesher;

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    const reg = new BlockRegistry(m.mcdata);
    const baker = new ModelBaker(m.models, m.atlas, reg);
    mesher = new Mesher(reg, baker, m.redstoneTint);
    (self as any).postMessage({ type: 'ready' });
  } else if (m.type === 'options') {
    mesher.options = { ...mesher.options, ...m.options };
  } else if (m.type === 'mesh') {
    const input = m.input as MeshInput;
    const out = mesher.mesh(input);
    const transfer: ArrayBuffer[] = [];
    for (const l of out.layers) if (l) transfer.push(l.data);
    (self as any).postMessage({ type: 'mesh', id: m.id, out }, transfer);
  }
};
