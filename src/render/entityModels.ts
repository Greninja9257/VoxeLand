// Box-model definitions using vanilla model-space conventions (pixels, y-down, feet at y=24, front = -z).
export interface BoxDef { x: number; y: number; z: number; w: number; h: number; d: number; u: number; v: number; inflate?: number; mirror?: boolean }
export interface PartDef { name: string; pivot: [number, number, number]; boxes: BoxDef[]; rot?: [number, number, number]; children?: PartDef[]; texture?: string; visible?: boolean; scaleWithSlime?: boolean }
export interface ModelDef { texW: number; texH: number; parts: PartDef[]; scale?: number; overlay?: { texture: string; inflate: number } }

const box = (x: number, y: number, z: number, w: number, h: number, d: number, u: number, v: number, o: Partial<BoxDef> = {}): BoxDef => ({ x, y, z, w, h, d, u, v, ...o });
const part = (name: string, pivot: [number, number, number], boxes: BoxDef[], o: Partial<PartDef> = {}): PartDef => ({ name, pivot, boxes, ...o });

function humanoid(texW: number, texH: number, slim = false, zombieArms = false): ModelDef {
  const legacy = texH === 32;
  const aw = slim ? 3 : 4;
  return {
    texW, texH,
    parts: [
      part('head', [0, 0, 0], [box(-4, -8, -4, 8, 8, 8, 0, 0)], { children: [part('hat', [0, 0, 0], [box(-4, -8, -4, 8, 8, 8, 32, 0, { inflate: 0.5 })])] }),
      part('body', [0, 0, 0], [box(-4, 0, -2, 8, 12, 4, 16, 16)]),
      part('rightArm', [-5, 2, 0], [box(slim ? -2 : -3, -2, -2, aw, 12, 4, 40, 16)]),
      part('leftArm', [5, 2, 0], legacy ? [box(-1, -2, -2, 4, 12, 4, 40, 16, { mirror: true })] : [box(-1, -2, -2, aw, 12, 4, 32, 48)]),
      part('rightLeg', [-1.9, 12, 0], [box(-2, 0, -2, 4, 12, 4, 0, 16)]),
      part('leftLeg', [1.9, 12, 0], legacy ? [box(-2, 0, -2, 4, 12, 4, 0, 16, { mirror: true })] : [box(-2, 0, -2, 4, 12, 4, 16, 48)]),
    ],
  };
}

function skeleton(): ModelDef {
  return {
    texW: 64, texH: 32,
    parts: [
      part('head', [0, 0, 0], [box(-4, -8, -4, 8, 8, 8, 0, 0)]),
      part('body', [0, 0, 0], [box(-4, 0, -2, 8, 12, 4, 16, 16)]),
      part('rightArm', [-5, 2, 0], [box(-1, -2, -1, 2, 12, 2, 40, 16)]),
      part('leftArm', [5, 2, 0], [box(-1, -2, -1, 2, 12, 2, 40, 16, { mirror: true })]),
      part('rightLeg', [-2, 12, 0], [box(-1, 0, -1, 2, 12, 2, 0, 16)]),
      part('leftLeg', [2, 12, 0], [box(-1, 0, -1, 2, 12, 2, 0, 16, { mirror: true })]),
    ],
  };
}

function creeper(): ModelDef {
  return {
    texW: 64, texH: 32,
    parts: [
      part('head', [0, 6, 0], [box(-4, -8, -4, 8, 8, 8, 0, 0)]),
      part('body', [0, 6, 0], [box(-4, 0, -2, 8, 12, 4, 16, 16)]),
      part('leg0', [-2, 18, 4], [box(-2, 0, -2, 4, 6, 4, 0, 16)]),
      part('leg1', [2, 18, 4], [box(-2, 0, -2, 4, 6, 4, 0, 16)]),
      part('leg2', [-2, 18, -4], [box(-2, 0, -2, 4, 6, 4, 0, 16)]),
      part('leg3', [2, 18, -4], [box(-2, 0, -2, 4, 6, 4, 0, 16)]),
    ],
  };
}

function spider(): ModelDef {
  const legs: PartDef[] = [];
  for (let i = 0; i < 4; i++) {
    const z = 2 - i * 3 + (i > 1 ? 1 : 0);
    const zz = [2, 1, 0, -1][i];
    legs.push(part(`legR${i}`, [-4, 15, zz], [box(-15, -1, -1, 16, 2, 2, 18, 0)]));
    legs.push(part(`legL${i}`, [4, 15, zz], [box(-1, -1, -1, 16, 2, 2, 18, 0)]));
    void z;
  }
  return {
    texW: 64, texH: 32,
    parts: [
      part('head', [0, 15, -3], [box(-4, -4, -8, 8, 8, 8, 32, 4)]),
      part('neck', [0, 15, 0], [box(-3, -3, -3, 6, 6, 6, 0, 0)]),
      part('body', [0, 15, 9], [box(-5, -4, -6, 10, 8, 12, 0, 12)]),
      ...legs,
    ],
  };
}

function quadruped(legH: number, bodyU = 28, bodyV = 8, o: { headBoxes?: BoxDef[]; headPivot?: [number, number, number]; bodyBox?: BoxDef; extra?: PartDef[]; legU?: number; legV?: number; legW?: number } = {}): ModelDef {
  const legW = o.legW ?? 4;
  const lu = o.legU ?? 0, lv = o.legV ?? 16;
  return {
    texW: 64, texH: 32,
    parts: [
      part('head', o.headPivot ?? [0, 24 - legH - 6, -6], o.headBoxes ?? [box(-4, -4, -8, 8, 8, 8, 0, 0)]),
      part('body', [0, 24 - legH - 7, 2], [o.bodyBox ?? box(-5, -10, -7, 10, 16, 8, bodyU, bodyV)], { rot: [Math.PI / 2, 0, 0] }),
      part('leg0', [-3, 24 - legH, 7], [box(-2, 0, -2, legW, legH, legW, lu, lv)]),
      part('leg1', [3, 24 - legH, 7], [box(-2, 0, -2, legW, legH, legW, lu, lv)]),
      part('leg2', [-3, 24 - legH, -5], [box(-2, 0, -2, legW, legH, legW, lu, lv)]),
      part('leg3', [3, 24 - legH, -5], [box(-2, 0, -2, legW, legH, legW, lu, lv)]),
      ...(o.extra ?? []),
    ],
  };
}

const MODELS: Record<string, ModelDef> = {
  player: humanoid(64, 64),
  player_slim: humanoid(64, 64, true),
  zombie: humanoid(64, 64, false, true),
  villager_biped: humanoid(64, 64),
  skeleton: skeleton(),
  creeper: creeper(),
  spider: spider(),
  // 1.21.5+ pig/cow textures are 64x64 (same layout in the top half; the cow gained a nose at texOffs(0,32))
  pig: { ...quadruped(6, 28, 8, { headBoxes: [box(-4, -4, -8, 8, 8, 8, 0, 0), box(-2, 0, -9, 4, 3, 1, 16, 16)] }), texH: 64 },
  cow: {
    texW: 64, texH: 64,
    parts: [
      part('head', [0, 4, -8], [box(-4, -4, -6, 8, 8, 6, 0, 0), box(-5, -5, -4, 1, 3, 1, 22, 0), box(4, -5, -4, 1, 3, 1, 22, 0), box(-3, 1, -8, 6, 3, 2, 0, 32)]),
      part('body', [0, 5, 2], [box(-6, -10, -7, 12, 18, 10, 18, 4), box(-2, 2, -8, 4, 6, 1, 52, 0)], { rot: [Math.PI / 2, 0, 0] }),
      part('leg0', [-4, 12, 7], [box(-2, 0, -2, 4, 12, 4, 0, 16)]),
      part('leg1', [4, 12, 7], [box(-2, 0, -2, 4, 12, 4, 0, 16)]),
      part('leg2', [-4, 12, -6], [box(-2, 0, -2, 4, 12, 4, 0, 16)]),
      part('leg3', [4, 12, -6], [box(-2, 0, -2, 4, 12, 4, 0, 16)]),
    ],
  },
  sheep: {
    texW: 64, texH: 32,
    parts: [
      part('head', [0, 6, -8], [box(-3, -4, -6, 6, 6, 8, 0, 0)]),
      part('body', [0, 5, 2], [box(-4, -10, -7, 8, 16, 6, 28, 8)], { rot: [Math.PI / 2, 0, 0] }),
      part('leg0', [-3, 12, 7], [box(-2, 0, -2, 4, 12, 4, 0, 16)]),
      part('leg1', [3, 12, 7], [box(-2, 0, -2, 4, 12, 4, 0, 16)]),
      part('leg2', [-3, 12, -5], [box(-2, 0, -2, 4, 12, 4, 0, 16)]),
      part('leg3', [3, 12, -5], [box(-2, 0, -2, 4, 12, 4, 0, 16)]),
    ],
  },
  sheep_fur: {
    texW: 64, texH: 32,
    parts: [
      part('head', [0, 6, -8], [box(-3, -4, -4, 6, 6, 6, 0, 0, { inflate: 0.6 })]),
      part('body', [0, 5, 2], [box(-4, -10, -7, 8, 16, 6, 28, 8, { inflate: 1.75 })], { rot: [Math.PI / 2, 0, 0] }),
      part('leg0', [-3, 12, 7], [box(-2, 0, -2, 4, 6, 4, 0, 16, { inflate: 0.5 })]),
      part('leg1', [3, 12, 7], [box(-2, 0, -2, 4, 6, 4, 0, 16, { inflate: 0.5 })]),
      part('leg2', [-3, 12, -5], [box(-2, 0, -2, 4, 6, 4, 0, 16, { inflate: 0.5 })]),
      part('leg3', [3, 12, -5], [box(-2, 0, -2, 4, 6, 4, 0, 16, { inflate: 0.5 })]),
    ],
  },
  chicken: {
    texW: 64, texH: 32,
    parts: [
      part('head', [0, 15, -4], [box(-2, -6, -2, 4, 6, 3, 0, 0), box(-2, -4, -4, 4, 2, 2, 14, 0), box(-1, -2, -3, 2, 2, 2, 14, 4)]),
      part('body', [0, 16, 0], [box(-3, -4, -3, 6, 8, 6, 0, 9)], { rot: [Math.PI / 2, 0, 0] }),
      part('leg0', [-2, 19, 1], [box(-1, 0, -3, 3, 5, 3, 26, 0)]),
      part('leg1', [1, 19, 1], [box(-1, 0, -3, 3, 5, 3, 26, 0)]),
      part('wingR', [-4, 13, 0], [box(0, 0, -3, 1, 4, 6, 24, 13)]),
      part('wingL', [4, 13, 0], [box(-1, 0, -3, 1, 4, 6, 24, 13)]),
    ],
  },
  slime: {
    texW: 64, texH: 32,
    parts: [
      part('inner', [0, 0, 0], [box(-3, 17, -3, 6, 6, 6, 0, 16), box(-3.25, 18, -3.5, 2, 2, 2, 32, 0), box(1.25, 18, -3.5, 2, 2, 2, 32, 0), box(0, 21, -3.5, 1, 1, 1, 32, 8)]),
      part('outer', [0, 0, 0], [box(-4, 16, -4, 8, 8, 8, 0, 0)]),
    ],
  },
  magma_cube: {
    texW: 64, texH: 32,
    parts: [
      part('core', [0, 0, 0], [box(-2, 18, -2, 4, 4, 4, 0, 16)]),
      ...Array.from({ length: 8 }, (_, i) => part(`seg${i}`, [0, 0, 0], [box(-4, 16 + i, -4, 8, 1, 8, 0, i * 2 + (i > 1 ? 1 : 0))])),
    ],
  },
  enderman: {
    texW: 64, texH: 32,
    parts: [
      part('head', [0, -14, 0], [box(-4, -8, -4, 8, 8, 8, 0, 0)], { children: [part('hat', [0, 0, 0], [box(-4, -8, -4, 8, 8, 8, 0, 16, { inflate: -0.5 })])] }),
      part('body', [0, -14, 0], [box(-4, 0, -2, 8, 12, 4, 32, 16)]),
      part('rightArm', [-5, -12, 0], [box(-1, -2, -1, 2, 30, 2, 56, 0)]),
      part('leftArm', [5, -12, 0], [box(-1, -2, -1, 2, 30, 2, 56, 0)]),
      part('rightLeg', [-2, -5, 0], [box(-1, 0, -1, 2, 30, 2, 56, 0)]),
      part('leftLeg', [2, -5, 0], [box(-1, 0, -1, 2, 30, 2, 56, 0)]),
    ],
  },
  wolf: {
    texW: 64, texH: 32,
    parts: [
      part('head', [-1, 13.5, -7], [box(-2, -3, -2, 6, 6, 4, 0, 0), box(-2, -5, 0, 2, 2, 1, 16, 14), box(2, -5, 0, 2, 2, 1, 16, 14), box(-0.5, 0, -5, 3, 3, 4, 0, 10)]),
      part('body', [0, 14, 2], [box(-3, -2, -3, 6, 9, 6, 18, 14)], { rot: [Math.PI / 2, 0, 0] }),
      part('mane', [-1, 14, -3], [box(-3, -3, -3, 8, 6, 7, 21, 0)], { rot: [Math.PI / 2, 0, 0] }),
      part('leg0', [-2.5, 16, 7], [box(-1, 0, -1, 2, 8, 2, 0, 18)]),
      part('leg1', [0.5, 16, 7], [box(-1, 0, -1, 2, 8, 2, 0, 18)]),
      part('leg2', [-2.5, 16, -4], [box(-1, 0, -1, 2, 8, 2, 0, 18)]),
      part('leg3', [0.5, 16, -4], [box(-1, 0, -1, 2, 8, 2, 0, 18)]),
      part('tail', [-1, 12, 8], [box(-1, 0, -1, 2, 8, 2, 9, 18)], { rot: [Math.PI / 4, 0, 0] }),
    ],
  },
  squid: {
    texW: 64, texH: 32,
    parts: [
      part('body', [0, 8, 0], [box(-6, -8, -6, 12, 16, 12, 0, 0)]),
      ...Array.from({ length: 8 }, (_, i) => { const a = i * Math.PI * 2 / 8; return part(`t${i}`, [Math.cos(a) * 5, 15, Math.sin(a) * 5], [box(-1, 0, -1, 2, 18, 2, 48, 0)], { rot: [0, -a + Math.PI / 2, 0] }); }),
    ],
  },
  cod: {
    texW: 32, texH: 32,
    parts: [
      part('body', [0, 22, 0], [box(-1, -2, 0, 2, 4, 7, 0, 0)]),
      part('head', [0, 22, 0], [box(-1, -2, -3, 2, 4, 3, 11, 0), box(-1, -2, -1, 2, 3, 1, 0, 0)]),
      part('tail', [0, 22, 7], [box(0, -2, 0, 0, 4, 6, 22, 3)]),
      part('finTop', [0, 20, 0], [box(0, -1, -1, 0, 1, 6, 20, 0)]),
      part('finR', [-1, 23, 0], [box(-2, 0, -1, 2, 0, 2, 24, 4)]),
      part('finL', [1, 23, 0], [box(0, 0, -1, 2, 0, 2, 24, 4)]),
    ],
  },
  salmon: {
    texW: 32, texH: 32,
    parts: [
      part('body', [0, 20, 0], [box(-1, -2, 0, 2, 4, 8, 0, 0)]),
      part('head', [0, 20, 0], [box(-1, -2, -3, 2, 4, 3, 22, 0)]),
      part('tail', [0, 20, 8], [box(-1, -2, 0, 2, 4, 8, 0, 13)], { children: [part('fin', [0, 0, 8], [box(0, -2, 0, 0, 4, 6, 20, 10)])] }),
      part('finTop', [0, 18, 3], [box(0, -1, 0, 0, 2, 4, 2, 3)]),
    ],
  },
  ghast: {
    texW: 64, texH: 32,
    parts: [
      part('body', [0, 17.6, 0], [box(-8, -8, -8, 16, 16, 16, 0, 0)]),
      ...Array.from({ length: 9 }, (_, i) => { const x = (i % 3 - 1) * 2.6, z = (Math.floor(i / 3) - 1) * 2.6; return part(`t${i}`, [x, 24.6, z], [box(-1, 0, -1, 2, 6 + (i * 7) % 6, 2, 0, 0)]); }),
    ],
  },
  blaze: {
    texW: 64, texH: 32,
    parts: [
      part('head', [0, 4, 0], [box(-4, -4, -4, 8, 8, 8, 0, 0)]),
      ...Array.from({ length: 12 }, (_, i) => part(`rod${i}`, [0, 0, 0], [box(0, 0, 0, 2, 8, 2, 0, 16)])),
    ],
  },
  bat: {
    texW: 64, texH: 64,
    parts: [
      part('head', [0, 0, 0], [box(-3, -3, -3, 6, 6, 6, 0, 0), box(-4, -6, -2, 3, 4, 1, 24, 0), box(1, -6, -2, 3, 4, 1, 24, 0, { mirror: true })]),
      part('body', [0, 0, 0], [box(-3, 4, -3, 6, 12, 6, 0, 16), box(-5, 16, 0, 10, 6, 1, 0, 34)]),
      part('wingR', [0, 0, 0], [box(-12, 1, 1.5, 10, 16, 1, 42, 0)]),
      part('wingL', [0, 0, 0], [box(2, 1, 1.5, 10, 16, 1, 42, 0, { mirror: true })]),
    ],
  },
  villager: {
    texW: 64, texH: 64,
    parts: [
      part('head', [0, 0, 0], [box(-4, -10, -4, 8, 10, 8, 0, 0), box(-1, -3, -6, 2, 4, 2, 24, 0)], { children: [part('hat', [0, 0, 0], [box(-4, -10, -4, 8, 10, 8, 32, 0, { inflate: 0.51 })])] }),
      part('body', [0, 0, 0], [box(-4, 0, -3, 8, 12, 6, 16, 20), box(-4, 0, -3, 8, 18, 6, 0, 38, { inflate: 0.5 })]),
      part('arms', [0, 2, 0], [box(-8, -2, -2, 4, 8, 4, 44, 22), box(4, -2, -2, 4, 8, 4, 44, 22, { mirror: true }), box(-4, 2, -2, 8, 4, 4, 40, 38)], { rot: [-0.75, 0, 0] }),
      part('rightLeg', [-2, 12, 0], [box(-2, 0, -2, 4, 12, 4, 0, 22)]),
      part('leftLeg', [2, 12, 0], [box(-2, 0, -2, 4, 12, 4, 0, 22, { mirror: true })]),
    ],
  },
  iron_golem: {
    texW: 128, texH: 128,
    parts: [
      part('head', [0, -7, -2], [box(-4, -12, -5.5, 8, 10, 8, 0, 0), box(-1, -5, -7.5, 2, 4, 2, 24, 0)]),
      part('body', [0, -7, 0], [box(-9, -2, -6, 18, 12, 11, 0, 40), box(-4.5, 10, -3, 9, 5, 6, 0, 70, { inflate: 0.5 })]),
      part('rightArm', [0, -7, 0], [box(-13, -2.5, -3, 4, 30, 6, 60, 21)]),
      part('leftArm', [0, -7, 0], [box(9, -2.5, -3, 4, 30, 6, 60, 58)]),
      part('rightLeg', [-4, 11, 0], [box(-3.5, -3, -3, 6, 16, 5, 37, 0)]),
      part('leftLeg', [5, 11, 0], [box(-3.5, -3, -3, 6, 16, 5, 60, 0)]),
    ],
  },
  snow_golem: {
    texW: 64, texH: 64,
    parts: [
      part('head', [0, 4, 0], [box(-4, -8, -4, 8, 8, 8, 0, 0, { inflate: -0.5 })]),
      part('body', [0, 13, 0], [box(-5, -10, -5, 10, 10, 10, 0, 16)]),
      part('lower', [0, 24, 0], [box(-6, -12, -6, 12, 12, 12, 0, 36)]),
      part('rightArm', [0, 6, 0], [box(-1, 0, -1, 12, 2, 2, 32, 0)], { rot: [0, 0, 1] }),
      part('leftArm', [0, 6, 0], [box(-11, 0, -1, 12, 2, 2, 32, 0)], { rot: [0, 0, -1] }),
    ],
  },
  phantom: {
    texW: 64, texH: 64,
    parts: [
      part('body', [0, 0, 0], [box(-3, -2, -8, 5, 3, 9, 0, 8)]),
      part('head', [0, 1, -7], [box(-4, -2, -5, 7, 3, 5, 0, 0)]),
      part('wingL', [3, -2, 1], [box(0, 0, 0, 6, 2, 9, 23, 12)], { children: [part('tipL', [6, 0, 0], [box(0, 0, 0, 13, 1, 9, 16, 24)])] }),
      part('wingR', [-2, -2, 1], [box(-6, 0, 0, 6, 2, 9, 23, 12, { mirror: true })], { children: [part('tipR', [-6, 0, 0], [box(-13, 0, 0, 13, 1, 9, 16, 24, { mirror: true })])] }),
      part('tail', [0, -2, 1], [box(-2, 0, 0, 3, 2, 6, 3, 20), box(-1, 0.5, 6, 1, 1, 6, 4, 29)]),
    ],
  },
  hoglin: {
    texW: 128, texH: 128,
    parts: [
      part('head', [0, 2, -12], [box(-7, -3, -19, 14, 6, 19, 61, 1), box(-8, -4, -12, 1, 3, 3, 1, 1), box(7, -4, -12, 1, 3, 3, 1, 1)]),
      part('body', [0, 7, 0], [box(-8, -7, -13, 16, 14, 26, 1, 1)]),
      part('leg0', [-4, 10, -8], [box(-3, 0, -3, 6, 14, 6, 66, 42)]),
      part('leg1', [4, 10, -8], [box(-3, 0, -3, 6, 14, 6, 66, 42, { mirror: true })]),
      part('leg2', [-5, 9, 9], [box(-2.5, 0, -2.5, 5, 15, 5, 21, 45)]),
      part('leg3', [5, 9, 9], [box(-2.5, 0, -2.5, 5, 15, 5, 21, 45, { mirror: true })]),
    ],
  },
  strider: {
    texW: 64, texH: 128,
    parts: [
      part('body', [0, 8, 0], [box(-8, -6, -8, 16, 14, 16, 0, 0)]),
      part('leg0', [-4, 16, 0], [box(-2, 0, -2, 4, 16, 4, 0, 32)]),
      part('leg1', [4, 16, 0], [box(-2, 0, -2, 4, 16, 4, 0, 55)]),
    ],
  },
  turtle: {
    texW: 128, texH: 64,
    parts: [
      part('head', [0, 19, -10], [box(-3, -1, -3, 6, 5, 6, 3, 0)]),
      part('body', [0, 11, -10], [box(-9.5, 3, -10, 19, 20, 6, 7, 37), box(-4.5, 3, -14, 9, 18, 1, 70, 33)], { rot: [Math.PI / 2, 0, 0] }),
      part('leg0', [-3.5, 22, 11], [box(-2, 0, 0, 4, 1, 10, 1, 23)]),
      part('leg1', [3.5, 22, 11], [box(-2, 0, 0, 4, 1, 10, 1, 12)]),
      part('leg2', [-5, 21, -4], [box(-13, 0, -2, 13, 1, 5, 27, 30)]),
      part('leg3', [5, 21, -4], [box(0, 0, -2, 13, 1, 5, 27, 24)]),
    ],
  },
  // vanilla RabbitModel: haunches + hind feet + front legs, ears on the head, nose, tail
  rabbit: {
    texW: 64, texH: 32,
    parts: [
      part('head', [0, 16, -1], [box(-2.5, -4, -5, 5, 4, 5, 32, 0), box(-0.5, -2.5, -5.5, 1, 1, 1, 32, 9)]),
      part('earR', [0, 16, -1], [box(-2.5, -9, -1, 2, 5, 1, 52, 0)], { rot: [0, -0.2617994, 0] }),
      part('earL', [0, 16, -1], [box(0.5, -9, -1, 2, 5, 1, 58, 0)], { rot: [0, 0.2617994, 0] }),
      part('body', [0, 19, 8], [box(-3, -2, -10, 6, 5, 10, 0, 0)], { rot: [-0.34906584, 0, 0] }),
      part('haunchL', [3, 17.5, 3.7], [box(-1, 0, 0, 2, 4, 5, 30, 15)], { rot: [-0.34906584, 0, 0] }),
      part('haunchR', [-3, 17.5, 3.7], [box(-1, 0, 0, 2, 4, 5, 16, 15)], { rot: [-0.34906584, 0, 0] }),
      part('footL', [3, 17.5, 3.7], [box(-1, 5.5, -3.7, 2, 1, 7, 26, 24)]),
      part('footR', [-3, 17.5, 3.7], [box(-1, 5.5, -3.7, 2, 1, 7, 8, 24)]),
      part('legL', [3, 17, -1], [box(-1, 0, -1, 2, 7, 2, 8, 15)], { rot: [-0.17453292, 0, 0] }),
      part('legR', [-3, 17, -1], [box(-1, 0, -1, 2, 7, 2, 0, 15)], { rot: [-0.17453292, 0, 0] }),
      part('tail', [0, 20, 7], [box(-1.5, -1.5, 0, 3, 3, 2, 52, 6)], { rot: [-0.34906584, 0, 0] }),
    ],
  },
  cat: {
    texW: 64, texH: 32,
    parts: [
      part('head', [0, 15, -9], [box(-2.5, -2, -3, 5, 4, 5, 0, 0), box(-1.5, 0, -4, 3, 2, 2, 0, 24), box(-2, -3, 0, 1, 1, 2, 0, 10), box(1, -3, 0, 1, 1, 2, 6, 10)]),
      part('body', [0, 12, 0], [box(-2, 3, -8, 4, 16, 6, 20, 0)], { rot: [Math.PI / 2, 0, 0] }),
      part('leg0', [1.1, 18, 5], [box(-1, 0, 1, 2, 6, 2, 8, 13)]),
      part('leg1', [-1.1, 18, 5], [box(-1, 0, 1, 2, 6, 2, 8, 13)]),
      part('leg2', [1.2, 14.1, -5], [box(-1, 0, 0, 2, 10, 2, 40, 0)]),
      part('leg3', [-1.2, 14.1, -5], [box(-1, 0, 0, 2, 10, 2, 40, 0)]),
      part('tail', [0, 15, 8], [box(-0.5, 0, 0, 1, 8, 1, 0, 15)], { rot: [0.9, 0, 0] }),
    ],
  },
  fox: {
    texW: 48, texH: 32,
    parts: [
      part('head', [-1, 16.5, -3], [box(-3, -2, -5, 8, 6, 6, 1, 5), box(-4, -4, -4, 2, 2, 1, 8, 1), box(2, -4, -4, 2, 2, 1, 15, 1), box(-1, 2, -8, 4, 2, 3, 6, 18)]),
      part('body', [0, 16, -6], [box(-3, 3.999, -3.5, 6, 11, 6, 24, 15)], { rot: [Math.PI / 2, 0, 0] }),
      part('leg0', [-5, 17.5, 7], [box(2, 0, 0, 2, 6, 2, 13, 24)]),
      part('leg1', [-1, 17.5, 7], [box(2, 0, 0, 2, 6, 2, 4, 24)]),
      part('leg2', [-5, 17.5, 0], [box(2, 0, 0, 2, 6, 2, 13, 24)]),
      part('leg3', [-1, 17.5, 0], [box(2, 0, 0, 2, 6, 2, 4, 24)]),
      part('tail', [-4, 15, -1], [box(2, 0, -1, 4, 9, 5, 30, 0)], { rot: [-0.05, 0, 0] }),
    ],
  },
  polar_bear: {
    texW: 128, texH: 64,
    parts: [
      part('head', [0, 10, -16], [box(-3.5, -3, -3, 7, 7, 7, 0, 0), box(-2.5, 1, -6, 5, 3, 3, 0, 44), box(-4.5, -4, -1, 2, 2, 1, 26, 0), box(2.5, -4, -1, 2, 2, 1, 26, 0)]),
      part('body', [-2, 9, 12], [box(-5, -13, -7, 14, 14, 11, 0, 19), box(-4, -25, -7, 12, 12, 10, 39, 0)], { rot: [Math.PI / 2, 0, 0] }),
      part('leg0', [-4.5, 14, 6], [box(-2, 0, -2, 4, 10, 8, 50, 22)]),
      part('leg1', [4.5, 14, 6], [box(-2, 0, -2, 4, 10, 8, 50, 22)]),
      part('leg2', [-3.5, 14, -8], [box(-2, 0, -2, 4, 10, 6, 50, 40)]),
      part('leg3', [3.5, 14, -8], [box(-2, 0, -2, 4, 10, 6, 50, 40)]),
    ],
  },
  panda: {
    texW: 64, texH: 64,
    parts: [
      part('head', [0, 11.5, -17], [box(-6.5, -5, -4, 13, 10, 9, 0, 6), box(-8.5, -7, 1, 5, 4, 1, 45, 16), box(3.5, -7, 1, 5, 4, 1, 52, 16), box(-3.5, 0, -6, 7, 5, 2, 52, 25)]),
      part('body', [0, 10, 0], [box(-9.5, 1, -6.5, 19, 26, 13, 0, 25)], { rot: [Math.PI / 2, 0, 0] }),
      part('leg0', [-5.5, 15, 9], [box(-3, 0, -3, 6, 9, 6, 40, 0)]),
      part('leg1', [5.5, 15, 9], [box(-3, 0, -3, 6, 9, 6, 40, 0)]),
      part('leg2', [-5.5, 15, -9], [box(-3, 0, -3, 6, 9, 6, 40, 0)]),
      part('leg3', [5.5, 15, -9], [box(-3, 0, -3, 6, 9, 6, 40, 0)]),
    ],
  },
  goat: quadruped(12, 34, 0, { headBoxes: [box(-3, -5, -10, 6, 7, 11, 34, 46), box(-2, -1, -13, 4, 3, 4, 34, 17)], headPivot: [0, 8, -6], bodyBox: box(-4, -5, -7, 9, 11, 16, 1, 1), legU: 36, legV: 29 }),
  llama: { texW: 128, texH: 64, parts: [part('head', [0, 7, -6], [box(-2, -14, -10, 4, 4, 9, 0, 0), box(-4, -16, -6, 8, 18, 6, 0, 14), box(-4, -17, -6, 3, 3, 2, 17, 0), box(1, -17, -6, 3, 3, 2, 17, 0)]), part('body', [0, 5, 2], [box(-6, -10, -7, 12, 18, 10, 29, 0)], { rot: [Math.PI / 2, 0, 0] }), part('leg0', [-3.5, 10, 6], [box(-2, 0, -2, 4, 14, 4, 29, 29)]), part('leg1', [3.5, 10, 6], [box(-2, 0, -2, 4, 14, 4, 29, 29)]), part('leg2', [-3.5, 10, -5], [box(-2, 0, -2, 4, 14, 4, 29, 29)]), part('leg3', [3.5, 10, -5], [box(-2, 0, -2, 4, 14, 4, 29, 29)])] },
  // vanilla HorseModel: body + head_parts (neck, head, mane, upper mouth, ears) + legs + tail
  horse: {
    texW: 64, texH: 64,
    parts: [
      part('body', [0, 11, 5], [box(-5, -8, -17, 10, 10, 22, 0, 32, { inflate: 0.05 })], { children: [part('tail', [0, -5, 2], [box(-1.5, 0, 0, 3, 14, 4, 42, 36)], { rot: [0.5236, 0, 0] })] }),
      part('head', [0, 4, -12], [box(-2.05, -6, -2, 4, 12, 7, 0, 35), box(-3, -11, -2, 6, 5, 7, 0, 13), box(-1, -11, 5.01, 2, 16, 2, 56, 36), box(-2, -11, -7, 4, 5, 5, 0, 25), box(0.55, -13, 4, 2, 3, 1, 19, 16, { inflate: -0.001 }), box(-2.55, -13, 4, 2, 3, 1, 19, 16, { inflate: -0.001 })], { rot: [0.5236, 0, 0] }),
      part('leg0', [4, 14, 7], [box(-3, -1.01, -1, 4, 11, 4, 48, 21, { mirror: true })]),
      part('leg1', [-4, 14, 7], [box(-1, -1.01, -1, 4, 11, 4, 48, 21)]),
      part('leg2', [4, 14, -10], [box(-3, -1.01, -1.9, 4, 11, 4, 48, 21, { mirror: true })]),
      part('leg3', [-4, 14, -10], [box(-1, -1.01, -1.9, 4, 11, 4, 48, 21)]),
    ],
  },  bee: { texW: 64, texH: 64, parts: [part('body', [0, 19, 0], [box(-3.5, -4, -5, 7, 7, 10, 0, 0), box(-2, -9, -5, 1, 2, 1, 2, 0), box(1, -9, -5, 1, 2, 1, 2, 3), box(-1.5, -2, 5, 3, 2, 2, 26, 0), box(-3.5, 0, -5, 7, 5, 10, 0, 11, { inflate: -0.001 })]), part('wingR', [-1.5, 15, -3], [box(-9, 0, 0, 9, 0, 6, 0, 18)], { rot: [0.26, 0, -0.5] }), part('wingL', [1.5, 15, -3], [box(0, 0, 0, 9, 0, 6, 0, 18, { mirror: true })], { rot: [0.26, 0, 0.5] }), part('leg0', [1.5, 20, -2], [box(-5, 0, 0, 7, 2, 0, 26, 1)]), part('leg1', [1.5, 20, 0], [box(-5, 0, 0, 7, 2, 0, 26, 3)]), part('leg2', [1.5, 20, 2], [box(-5, 0, 0, 7, 2, 0, 26, 5)])] },
  frog: { texW: 48, texH: 48, parts: [part('body', [0, 20, 0], [box(-3.5, -2, -8, 7, 3, 9, 3, 1), box(-3.5, -1, -8, 7, 0, 9, 23, 22)]), part('head', [0, 20, -8], [box(-3.5, -2, -1, 7, 0, 9, 23, 13), box(-3.5, -1, -1, 7, 3, 9, 0, 13), box(-4, -2, -3, 3, 2, 3, 0, 0), box(1, -2, -3, 3, 2, 3, 0, 5)]), part('leg0', [3.5, 22, 5], [box(-1, 0, -1, 2, 3, 2, 14, 25)]), part('leg1', [-3.5, 22, 5], [box(-1, 0, -1, 2, 3, 2, 14, 25)]), part('leg2', [3.5, 22, -3], [box(-2, 0, -1, 3, 3, 2, 30, 30)]), part('leg3', [-3.5, 22, -3], [box(-1, 0, -1, 3, 3, 2, 30, 30)])] },
  armadillo: { texW: 64, texH: 64, parts: [part('body', [0, 21, 4], [box(-4, -7, -10, 8, 8, 12, 0, 20)], { rot: [0, 0, 0] }), part('head', [0, 18, -7], [box(-2, -3, -5, 4, 5, 5, 0, 0)]), part('leg0', [-2, 21, 3], [box(-1, 0, -1, 2, 3, 2, 48, 21)]), part('leg1', [2, 21, 3], [box(-1, 0, -1, 2, 3, 2, 48, 21)]), part('leg2', [-2, 21, -3], [box(-1, 0, -1, 2, 3, 2, 48, 21)]), part('leg3', [2, 21, -3], [box(-1, 0, -1, 2, 3, 2, 48, 21)])] },
  camel: { texW: 128, texH: 128, parts: [part('body', [0, 4, 9], [box(-7.5, -12, -23.5, 15, 12, 27, 0, 25), box(-4.5, -16, -13.5, 8, 5, 9, 74, 0), box(-3.5, -20, -6.5, 7, 8, 10, 74, 15)]), part('head', [0, 1, -12], [box(-3.5, -7, -15, 7, 8, 19, 60, 24), box(-3.5, -21, -15, 7, 14, 7, 21, 0), box(-3.5, -22, -8, 7, 0, 7, 50, 0)]), part('leg0', [-4.9, 23, 9.5], [box(-2.5, 2, -2.5, 5, 21, 5, 122, 0)]), part('leg1', [4.9, 23, 9.5], [box(-2.5, 2, -2.5, 5, 21, 5, 122, 0)]), part('leg2', [-4.9, 23, -10.5], [box(-2.5, 2, -2.5, 5, 21, 5, 122, 0)]), part('leg3', [4.9, 23, -10.5], [box(-2.5, 2, -2.5, 5, 21, 5, 122, 0)])] },
  axolotl: { texW: 64, texH: 64, parts: [part('body', [0, 20, 4], [box(-4, -2, -9, 8, 4, 10, 0, 11)]), part('head', [0, 20, -5], [box(-4, -3, -5, 8, 5, 5, 0, 1)]), part('tail', [0, 20, 5], [box(0, -3, 0, 0, 5, 12, 2, 19)]), part('leg0', [-3.5, 21, 1], [box(-2, 0, -1, 3, 5, 0, 2, 13)]), part('leg1', [3.5, 21, 1], [box(-1, 0, -1, 3, 5, 0, 2, 13)]), part('leg2', [-3.5, 21, -4], [box(-2, 0, -1, 3, 5, 0, 2, 13)]), part('leg3', [3.5, 21, -4], [box(-1, 0, -1, 3, 5, 0, 2, 13)])] },
  dolphin: { texW: 64, texH: 64, parts: [part('body', [0, 22, -5], [box(-4, -7, 0, 8, 7, 13, 22, 0)]), part('head', [0, 22, -5], [box(-4, -5, -3, 8, 7, 6, 0, 0), box(-1, 2, -7, 2, 2, 4, 0, 13)]), part('tail', [0, 18, 8], [box(-2, 0, 0, 4, 5, 11, 0, 19)], { children: [part('fluke', [0, 2.5, 11], [box(-8, 0, 0, 16, 1, 6, 0, 33)])] }), part('finTop', [0, 15, 3], [box(-0.5, -4, 0, 1, 4, 5, 0, 44)]), part('finR', [-4, 18, 1], [box(-8, 0, 0, 8, 1, 4, 48, 20)]), part('finL', [4, 18, 1], [box(0, 0, 0, 8, 1, 4, 48, 20, { mirror: true })])] },
  pufferfish: { texW: 32, texH: 32, parts: [part('body', [0, 16, 0], [box(-4, -8, -4, 8, 8, 8, 0, 0)])] },
  guardian: { texW: 64, texH: 64, parts: [part('body', [0, 12, 0], [box(-6, -6, -6, 12, 12, 12, 0, 0), box(-6, -8, -5, 12, 2, 10, 0, 24), box(-6, 6, -5, 12, 2, 10, 0, 24), box(-5, -6, 6, 10, 12, 1, 24, 0)]), part('eye', [0, 12, -6], [box(-1, -1, -0.5, 2, 2, 1, 8, 0)]), part('tail', [0, 12, 6], [box(-2, -2, 0, 4, 4, 8, 40, 0)])] },
  silverfish: { texW: 64, texH: 32, parts: [part('seg0', [0, 21, -3.5], [box(-1.5, -1, -1, 3, 2, 2, 0, 0)]), part('seg1', [0, 20.5, -1], [box(-2, -1.5, -1.5, 4, 3, 3, 0, 4)]), part('seg2', [0, 20, 2], [box(-3, -2, -2, 6, 4, 4, 0, 9)]), part('seg3', [0, 20.5, 6], [box(-2, -1.5, -1.5, 4, 3, 3, 0, 4)]), part('seg4', [0, 21, 9], [box(-1.5, -1, -1, 3, 2, 2, 0, 0)])] },
  vex: humanoid(64, 64),
  shulker: { texW: 64, texH: 64, parts: [part('base', [0, 24, 0], [box(-8, -8, -8, 16, 8, 16, 0, 28)]), part('lid', [0, 24, 0], [box(-8, -16, -8, 16, 12, 16, 0, 0)]), part('head', [0, 12, 0], [box(-3, 0, -3, 6, 6, 6, 0, 52)])] },
  ravager: { texW: 128, texH: 128, parts: [part('head', [0, -7, -16], [box(-8, -14, -14, 16, 20, 16, 0, 0), box(-2, 2, -18, 4, 8, 4, 0, 36)]), part('body', [0, 1, 2], [box(-7, -10, -18, 14, 16, 20, 0, 55), box(-6, 6, -18, 12, 13, 18, 0, 91)]), part('leg0', [-8, 6, 9], [box(-4, 0, -4, 8, 37, 8, 96, 0)]), part('leg1', [8, 6, 9], [box(-4, 0, -4, 8, 37, 8, 96, 0, { mirror: true })]), part('leg2', [-8, 6, -8], [box(-4, 0, -4, 8, 37, 8, 64, 0)]), part('leg3', [8, 6, -8], [box(-4, 0, -4, 8, 37, 8, 64, 0, { mirror: true })])] },
  warden: { texW: 128, texH: 128, parts: [part('head', [0, -13, 0], [box(-8, -16, -5, 16, 16, 10, 0, 32)]), part('body', [0, -13, 0], [box(-9, 0, -4, 18, 21, 11, 0, 0)]), part('rightArm', [-13, -13, 0], [box(-4, 0, -4, 8, 28, 8, 44, 50)]), part('leftArm', [13, -13, 0], [box(-4, 0, -4, 8, 28, 8, 0, 58)]), part('rightLeg', [-5.9, 8, 0], [box(-3, 0, -3, 6, 13, 6, 76, 48)]), part('leftLeg', [5.9, 8, 0], [box(-3, 0, -3, 6, 13, 6, 76, 76)])] },
  breeze: humanoid(64, 64),
  creaking: humanoid(64, 64),
  sniffer: { texW: 192, texH: 192, parts: [part('body', [0, 5, 0], [box(-15, -14, -20, 30, 28, 40, 62, 68)]), part('head', [0, 6.5, -19.5], [box(-6.5, -7.5, -11.5, 13, 18, 11, 8, 15), box(-6.5, 2.5, -19.5, 13, 8, 8, 10, 45)]), part('leg0', [-7.5, 10, 15], [box(-3.5, 0, -3.5, 7, 14, 7, 32, 87)]), part('leg1', [7.5, 10, 15], [box(-3.5, 0, -3.5, 7, 14, 7, 32, 87)]), part('leg2', [-7.5, 10, -15], [box(-3.5, 0, -3.5, 7, 14, 7, 32, 87)]), part('leg3', [7.5, 10, -15], [box(-3.5, 0, -3.5, 7, 14, 7, 32, 87)])] },
  parrot: { texW: 32, texH: 32, parts: [part('body', [0, 16.5, -3], [box(-1.5, 0, -1.5, 3, 6, 3, 2, 8)]), part('head', [0, 15.7, -2.8], [box(-1, -2, -1, 2, 3, 2, 2, 2), box(-1, -0.5, -2, 2, 1, 4, 10, 0), box(-0.5, -1, -1.5, 1, 2, 1, 11, 7), box(-0.5, -2.5, -1.5, 1, 1, 1, 2, 0)]), part('tail', [0, 21.07, 1.16], [box(-1.5, 0, -1, 3, 4, 1, 22, 1)]), part('wingL', [1.5, 16.94, -2.76], [box(-0.5, 0, -1.5, 1, 5, 3, 19, 8)]), part('wingR', [-1.5, 16.94, -2.76], [box(-0.5, 0, -1.5, 1, 5, 3, 19, 8)]), part('leg0', [1, 22, -1.05], [box(-0.5, 0, -0.5, 1, 2, 1, 14, 18)]), part('leg1', [-1, 22, -1.05], [box(-0.5, 0, -0.5, 1, 2, 1, 14, 18)])] },
  dragon: { texW: 256, texH: 256, parts: [part('body', [0, 4, 8], [box(-12, 0, -16, 24, 24, 64, 0, 0)]), part('head', [0, 20, -24], [box(-6, -1, -24, 12, 5, 16, 176, 44), box(-8, -8, -10, 16, 16, 16, 112, 30)]), part('wingL', [12, 5, 2], [box(0, -4, -4, 56, 8, 8, 112, 88), box(0, 0, 2, 56, 0, 56, -56, 88)]), part('wingR', [-12, 5, 2], [box(-56, -4, -4, 56, 8, 8, 112, 88, { mirror: true }), box(-56, 0, 2, 56, 0, 56, -56, 88, { mirror: true })]), part('leg0', [-12, 19, 4], [box(-4, -4, -4, 8, 24, 8, 112, 0)]), part('leg1', [12, 19, 4], [box(-4, -4, -4, 8, 24, 8, 112, 0)]), part('tail', [0, 10, 56], [box(-5, -5, 0, 10, 10, 40, 152, 88)])] },
  wither: { texW: 64, texH: 64, parts: [part('body', [0, 0, 0], [box(-10, 3.9, -0.5, 20, 3, 3, 0, 16), box(-2, 6.9, -0.5, 4, 10, 3, 0, 22), box(-2, 6.9, 0.5, 11, 2, 2, 24, 22)], { rot: [0.3, 0, 0] }), part('head', [0, 0, 0], [box(-4, -4, -4, 8, 8, 8, 0, 0)]), part('headL', [-8, 4, 0], [box(-4, -4, -4, 6, 6, 6, 32, 0)]), part('headR', [10, 4, 0], [box(-4, -4, -4, 6, 6, 6, 32, 0)])] },
};

/** Resolve a model name (with fallback to a humanoid). */
// vanilla BoatModel (128x64) and RaftModel; the paddles are children so they rotate at the oarlock
MODELS.boat = {
  texW: 128, texH: 64,
  parts: [
    part('bottom', [0, 3, 1], [box(-14, -9, -3, 28, 16, 3, 0, 0)], { rot: [Math.PI / 2, 0, 0] }),
    part('back', [-15, 4, 4], [box(-13, -7, -1, 18, 6, 2, 0, 19)], { rot: [0, Math.PI * 1.5, 0] }),
    part('front', [15, 4, 0], [box(-8, -7, -1, 16, 6, 2, 0, 27)], { rot: [0, Math.PI / 2, 0] }),
    part('right', [0, 4, -9], [box(-14, -7, -1, 28, 6, 2, 0, 35)], { rot: [0, Math.PI, 0] }),
    part('left', [0, 4, 9], [box(-14, -7, -1, 28, 6, 2, 0, 43)]),
    part('paddleL', [3, -5, 9], [box(-1, 0, -5, 2, 2, 18, 62, 0), box(-1.01, -3, 8, 1, 6, 7, 62, 20)], { rot: [0, 0, 0.19634955] }),
    part('paddleR', [3, -5, -9], [box(-1, 0, -5, 2, 2, 18, 62, 0), box(-1.01, -3, 8, 1, 6, 7, 62, 20)], { rot: [0, Math.PI, 0.19634955] }),
  ],
};
MODELS.chest_boat = { ...MODELS.boat, parts: [...MODELS.boat.parts, part('chest_bottom', [-2, 3, 4], [box(0, 0, 0, 12, 8, 12, 0, 76 - 64)], { rot: [0, Math.PI * 1.5, 0] })] };
MODELS.raft = {
  texW: 128, texH: 64,
  parts: [
    part('bottom', [0, -3, 1], [box(-14, -11, -4, 28, 20, 4, 0, 0), box(-14, -9, -8, 28, 16, 4, 0, 0)], { rot: [Math.PI / 2, 0, 0] }),
    part('paddleL', [3, -4, 9], [box(-1, 0, -5, 2, 2, 18, 62, 0), box(-1.01, -3, 8, 1, 6, 7, 62, 20)], { rot: [0, 0, 0.19634955] }),
    part('paddleR', [3, -4, -9], [box(-1, 0, -5, 2, 2, 18, 62, 0), box(-1.01, -3, 8, 1, 6, 7, 62, 20)], { rot: [0, Math.PI, 0.19634955] }),
  ],
};

// vanilla EndCrystalModel (texture 128x64 in the current pack)
MODELS.end_crystal = {
  texW: 128, texH: 64,
  parts: [
    part('glass', [0, 0, 0], [box(-4, -4, -4, 8, 8, 8, 0, 0)]),
    part('cube', [0, 0, 0], [box(-4, -4, -4, 8, 8, 8, 32, 0)]),
    part('base', [0, 0, 0], [box(-6, 0, -6, 12, 4, 12, 0, 16)]),
  ],
};

export function getModel(name: string): ModelDef {
  return MODELS[name] ?? MODELS.zombie;
}
export { MODELS };
