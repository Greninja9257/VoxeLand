// Small linear algebra + geometry helpers (column-major mat4, like WebGL expects).

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array<ArrayBufferLike>;

export const DEG = Math.PI / 180;

export function clamp(x: number, a: number, b: number): number { return x < a ? a : x > b ? b : x; }
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
export function floor(x: number): number { return Math.floor(x); }
export function mod(a: number, n: number): number { return ((a % n) + n) % n; }
export function smoothstep(e0: number, e1: number, x: number): number { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
export function wrapDegrees(d: number): number { d = d % 360; if (d >= 180) d -= 360; if (d < -180) d += 360; return d; }

export function mat4Identity(out: Mat4 = new Float32Array(16)): Mat4 {
  out.fill(0); out[0] = out[5] = out[10] = out[15] = 1; return out;
}

export function mat4Perspective(out: Mat4, fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect; out[5] = f;
  out[10] = (far + near) / (near - far); out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function mat4Ortho(out: Mat4, l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  out.fill(0);
  out[0] = 2 / (r - l); out[5] = 2 / (t - b); out[10] = -2 / (f - n);
  out[12] = -(r + l) / (r - l); out[13] = -(t + b) / (t - b); out[14] = -(f + n) / (f - n); out[15] = 1;
  return out;
}

export function mat4Mul(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  const r = out === a || out === b ? new Float32Array(16) : out;
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) {
    r[c * 4 + rr] = a[rr] * b[c * 4] + a[4 + rr] * b[c * 4 + 1] + a[8 + rr] * b[c * 4 + 2] + a[12 + rr] * b[c * 4 + 3];
  }
  if (r !== out) out.set(r);
  return out;
}

export function mat4Translate(out: Mat4, m: Mat4, x: number, y: number, z: number): Mat4 {
  if (out !== m) out.set(m);
  out[12] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[13] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[14] = m[2] * x + m[6] * y + m[10] * z + m[14];
  out[15] = m[3] * x + m[7] * y + m[11] * z + m[15];
  return out;
}

export function mat4Scale(out: Mat4, m: Mat4, x: number, y: number, z: number): Mat4 {
  if (out !== m) out.set(m);
  for (let i = 0; i < 4; i++) { out[i] = m[i] * x; out[4 + i] = m[4 + i] * y; out[8 + i] = m[8 + i] * z; }
  return out;
}

export function mat4Rotate(out: Mat4, m: Mat4, rad: number, ax: number, ay: number, az: number): Mat4 {
  const len = Math.hypot(ax, ay, az); ax /= len; ay /= len; az /= len;
  const s = Math.sin(rad), c = Math.cos(rad), t = 1 - c;
  const b00 = ax * ax * t + c, b01 = ay * ax * t + az * s, b02 = az * ax * t - ay * s;
  const b10 = ax * ay * t - az * s, b11 = ay * ay * t + c, b12 = az * ay * t + ax * s;
  const b20 = ax * az * t + ay * s, b21 = ay * az * t - ax * s, b22 = az * az * t + c;
  const a = m === out ? Float32Array.from(m) : m;
  for (let i = 0; i < 4; i++) {
    out[i] = a[i] * b00 + a[4 + i] * b01 + a[8 + i] * b02;
    out[4 + i] = a[i] * b10 + a[4 + i] * b11 + a[8 + i] * b12;
    out[8 + i] = a[i] * b20 + a[4 + i] * b21 + a[8 + i] * b22;
  }
  if (out !== m) { out[12] = m[12]; out[13] = m[13]; out[14] = m[14]; out[15] = m[15]; }
  return out;
}

export function mat4RotateX(out: Mat4, m: Mat4, rad: number): Mat4 { return mat4Rotate(out, m, rad, 1, 0, 0); }
export function mat4RotateY(out: Mat4, m: Mat4, rad: number): Mat4 { return mat4Rotate(out, m, rad, 0, 1, 0); }
export function mat4RotateZ(out: Mat4, m: Mat4, rad: number): Mat4 { return mat4Rotate(out, m, rad, 0, 0, 1); }

export function mat4Invert(out: Mat4, a: Mat4): Mat4 {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return out;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

export function transformPoint(out: Vec3, m: Mat4, x: number, y: number, z: number): Vec3 {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

/** View matrix from camera position and yaw/pitch (Minecraft convention: yaw 0 = +Z (south), pitch + = looking down). */
export function mat4View(out: Mat4, x: number, y: number, z: number, yawDeg: number, pitchDeg: number): Mat4 {
  mat4Identity(out);
  mat4RotateX(out, out, pitchDeg * DEG);
  mat4RotateY(out, out, (yawDeg + 180) * DEG);
  mat4Translate(out, out, -x, -y, -z);
  return out;
}

/** Look direction from yaw/pitch (Minecraft convention). */
export function lookDir(yawDeg: number, pitchDeg: number): Vec3 {
  const yaw = yawDeg * DEG, pitch = pitchDeg * DEG;
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, -Math.sin(pitch), Math.cos(yaw) * cp];
}

// ---------- Frustum ----------
export class Frustum {
  planes = new Float32Array(24);
  update(vp: Mat4): void {
    const m = vp, p = this.planes;
    const set = (i: number, a: number, b: number, c: number, d: number) => {
      const l = Math.hypot(a, b, c); p[i * 4] = a / l; p[i * 4 + 1] = b / l; p[i * 4 + 2] = c / l; p[i * 4 + 3] = d / l;
    };
    set(0, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]);
    set(1, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]);
    set(2, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]);
    set(3, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]);
    set(4, m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]);
    set(5, m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]);
  }
  intersectsBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const p = this.planes;
    for (let i = 0; i < 6; i++) {
      const a = p[i * 4], b = p[i * 4 + 1], c = p[i * 4 + 2], d = p[i * 4 + 3];
      const px = a > 0 ? x1 : x0, py = b > 0 ? y1 : y0, pz = c > 0 ? z1 : z0;
      if (a * px + b * py + c * pz + d < 0) return false;
    }
    return true;
  }
}

// ---------- AABB ----------
export class AABB {
  constructor(public minX = 0, public minY = 0, public minZ = 0, public maxX = 0, public maxY = 0, public maxZ = 0) {}
  set(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): this {
    this.minX = minX; this.minY = minY; this.minZ = minZ; this.maxX = maxX; this.maxY = maxY; this.maxZ = maxZ; return this;
  }
  copy(o: AABB): this { return this.set(o.minX, o.minY, o.minZ, o.maxX, o.maxY, o.maxZ); }
  clone(): AABB { return new AABB(this.minX, this.minY, this.minZ, this.maxX, this.maxY, this.maxZ); }
  offset(x: number, y: number, z: number): this { this.minX += x; this.maxX += x; this.minY += y; this.maxY += y; this.minZ += z; this.maxZ += z; return this; }
  expand(x: number, y: number, z: number): this {
    if (x < 0) this.minX += x; else this.maxX += x;
    if (y < 0) this.minY += y; else this.maxY += y;
    if (z < 0) this.minZ += z; else this.maxZ += z;
    return this;
  }
  grow(x: number, y: number, z: number): this { this.minX -= x; this.maxX += x; this.minY -= y; this.maxY += y; this.minZ -= z; this.maxZ += z; return this; }
  intersects(o: AABB): boolean {
    return this.minX < o.maxX && this.maxX > o.minX && this.minY < o.maxY && this.maxY > o.minY && this.minZ < o.maxZ && this.maxZ > o.minZ;
  }
  contains(x: number, y: number, z: number): boolean {
    return x >= this.minX && x < this.maxX && y >= this.minY && y < this.maxY && z >= this.minZ && z < this.maxZ;
  }
  /** Vanilla-style swept collision: how far can we move along X before hitting `o`. */
  clipX(o: AABB, dx: number): number {
    if (o.maxY <= this.minY || o.minY >= this.maxY || o.maxZ <= this.minZ || o.minZ >= this.maxZ) return dx;
    if (dx > 0 && o.minX >= this.maxX) { const d = o.minX - this.maxX; if (d < dx) dx = d; }
    else if (dx < 0 && o.maxX <= this.minX) { const d = o.maxX - this.minX; if (d > dx) dx = d; }
    return dx;
  }
  clipY(o: AABB, dy: number): number {
    if (o.maxX <= this.minX || o.minX >= this.maxX || o.maxZ <= this.minZ || o.minZ >= this.maxZ) return dy;
    if (dy > 0 && o.minY >= this.maxY) { const d = o.minY - this.maxY; if (d < dy) dy = d; }
    else if (dy < 0 && o.maxY <= this.minY) { const d = o.maxY - this.minY; if (d > dy) dy = d; }
    return dy;
  }
  clipZ(o: AABB, dz: number): number {
    if (o.maxX <= this.minX || o.minX >= this.maxX || o.maxY <= this.minY || o.minY >= this.maxY) return dz;
    if (dz > 0 && o.minZ >= this.maxZ) { const d = o.minZ - this.maxZ; if (d < dz) dz = d; }
    else if (dz < 0 && o.maxZ <= this.minZ) { const d = o.maxZ - this.minZ; if (d > dz) dz = d; }
    return dz;
  }
  /** Ray/box intersection; returns [t, face] or null. face: 0=-y,1=+y,2=-z,3=+z,4=-x,5=+x */
  rayIntersect(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): [number, number] | null {
    let tmin = -Infinity, tmax = Infinity, face = -1;
    const axes: [number, number, number, number, number, number][] = [
      [ox, dx, this.minX, this.maxX, 4, 5], [oy, dy, this.minY, this.maxY, 0, 1], [oz, dz, this.minZ, this.maxZ, 2, 3],
    ];
    for (const [o, d, mn, mx, fneg, fpos] of axes) {
      if (Math.abs(d) < 1e-9) { if (o < mn || o > mx) return null; continue; }
      let t1 = (mn - o) / d, t2 = (mx - o) / d, f = fneg;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; f = fpos; }
      if (t1 > tmin) { tmin = t1; face = f; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (tmax < 0) return null;
    return [tmin < 0 ? 0 : tmin, face];
  }
}

// ---------- Directions (Minecraft order) ----------
// 0 down (-y), 1 up (+y), 2 north (-z), 3 south (+z), 4 west (-x), 5 east (+x)
export const DIR_NAMES = ['down', 'up', 'north', 'south', 'west', 'east'] as const;
export type DirName = typeof DIR_NAMES[number];
export const DIR_VEC: Vec3[] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
export const DIR_OPPOSITE = [1, 0, 3, 2, 5, 4];
export const DIR_INDEX: Record<string, number> = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
export const HORIZONTAL = ['north', 'south', 'west', 'east'];

// Simple deterministic hash / RNG
export function hash3(x: number, y: number, z: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export class Random {
  private s: number;
  constructor(seed: number) { this.s = (seed | 0) || 0x9e3779b9; }
  nextU32(): number {
    let x = this.s; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.s = x | 0; return x >>> 0;
  }
  next(): number { return this.nextU32() / 4294967296; }
  nextInt(n: number): number { return Math.floor(this.next() * n); }
  nextFloat(): number { return this.next(); }
  nextGaussian(): number { const u = 1 - this.next(), v = this.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  nextBetween(a: number, b: number): number { return a + this.nextInt(b - a + 1); }
}
