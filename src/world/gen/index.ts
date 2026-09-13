import type { BlockRegistry } from '../../blocks/registry';
import type { Dimension } from '../world';
import { OverworldGen, type Generator } from './overworld';
import { NetherGen } from './nether';
import { EndGen } from './end';

export type { Generator };

export function createGenerator(dimension: Dimension, seed: number, reg: BlockRegistry): Generator {
  if (dimension === 'the_nether') return new NetherGen(seed, reg);
  if (dimension === 'the_end') return new EndGen(seed, reg);
  return new OverworldGen(seed, reg);
}
