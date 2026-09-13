// Improved Perlin noise (2D/3D) with fBm, seeded. Pure.
export class Perlin {
  private p = new Uint8Array(512);
  constructor(seed: number) {
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    let s = seed >>> 0 || 1;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
  }
  private static fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }
  private static grad3(h: number, x: number, y: number, z: number): number {
    switch (h & 15) {
      case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
      case 4: return x + z; case 5: return -x + z; case 6: return x - z; case 7: return -x - z;
      case 8: return y + z; case 9: return -y + z; case 10: return y - z; case 11: return -y - z;
      case 12: return y + x; case 13: return -y + z; case 14: return y - x; default: return -y - z;
    }
  }
  private static grad2(h: number, x: number, y: number): number {
    switch (h & 7) {
      case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
      case 4: return x; case 5: return -x; case 6: return y; default: return -y;
    }
  }
  noise3(x: number, y: number, z: number): number {
    const p = this.p;
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = Perlin.fade(x), v = Perlin.fade(y), w = Perlin.fade(z);
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z, B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    const g = Perlin.grad3;
    const l = (a: number, b: number, t: number) => a + t * (b - a);
    return l(
      l(l(g(p[AA], x, y, z), g(p[BA], x - 1, y, z), u), l(g(p[AB], x, y - 1, z), g(p[BB], x - 1, y - 1, z), u), v),
      l(l(g(p[AA + 1], x, y, z - 1), g(p[BA + 1], x - 1, y, z - 1), u), l(g(p[AB + 1], x, y - 1, z - 1), g(p[BB + 1], x - 1, y - 1, z - 1), u), v),
      w);
  }
  noise2(x: number, y: number): number {
    const p = this.p;
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = Perlin.fade(x), v = Perlin.fade(y);
    const A = p[X] + Y, B = p[X + 1] + Y;
    const g = Perlin.grad2;
    const l = (a: number, b: number, t: number) => a + t * (b - a);
    return l(l(g(p[A], x, y), g(p[B], x - 1, y), u), l(g(p[A + 1], x, y - 1), g(p[B + 1], x - 1, y - 1), u), v);
  }
}

/** Fractal Brownian motion over several octaves. Output roughly in [-1, 1]. */
export class FBM {
  private octaves: Perlin[] = [];
  private norm: number;
  constructor(seed: number, public count: number, public lacunarity = 2, public persistence = 0.5) {
    for (let i = 0; i < count; i++) this.octaves.push(new Perlin(seed + i * 7919));
    let n = 0, a = 1;
    for (let i = 0; i < count; i++) { n += a; a *= persistence; }
    this.norm = 1 / n;
  }
  noise2(x: number, y: number, freq: number): number {
    let sum = 0, amp = 1, f = freq;
    for (let i = 0; i < this.count; i++) { sum += this.octaves[i].noise2(x * f, y * f) * amp; amp *= this.persistence; f *= this.lacunarity; }
    return sum * this.norm;
  }
  noise3(x: number, y: number, z: number, freq: number): number {
    let sum = 0, amp = 1, f = freq;
    for (let i = 0; i < this.count; i++) { sum += this.octaves[i].noise3(x * f, y * f, z * f) * amp; amp *= this.persistence; f *= this.lacunarity; }
    return sum * this.norm;
  }
  /** Ridged variant: 1 - |n| */
  ridged2(x: number, y: number, freq: number): number {
    let sum = 0, amp = 1, f = freq;
    for (let i = 0; i < this.count; i++) { sum += (1 - Math.abs(this.octaves[i].noise2(x * f, y * f))) * amp; amp *= this.persistence; f *= this.lacunarity; }
    return sum * this.norm * 2 - 1;
  }
}

/** Piecewise-linear spline helper: points sorted by x. */
export function spline(points: [number, number][], x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1], [x1, y1] = points[i];
      const t = (x - x0) / (x1 - x0);
      const s = t * t * (3 - 2 * t);
      return y0 + (y1 - y0) * s;
    }
  }
  return points[points.length - 1][1];
}

export function hashSeed(seed: number, a: number, b: number, c = 0): number {
  let h = (seed ^ Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b) ^ Math.imul(c, 0xc2b2ae35)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
