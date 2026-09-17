// Day/night cycle math (vanilla formulas) → sky/fog colours, sun angle, light factor.
import type { Dimension } from '../world/world';
import { clamp } from '../math';

export interface SkyState {
  timeOfDay: number;    // 0..1
  sunAngle: number;     // radians, sun rotates around the X axis (east-west)
  dayFactor: number;    // 0.2..1 (sky light multiplier)
  skyColor: [number, number, number];
  fogColor: [number, number, number];
  voidColor: [number, number, number];
  sunset: [number, number, number, number]; // rgb + strength
  starBrightness: number;
  moonPhase: number;
  rainLevel: number;
  fogStart: number; fogEnd: number;
  voidStrength: number;
}

export function timeOfDay(dayTime: number): number {
  const f = ((dayTime / 24000) - 0.25) % 1;
  const fr = f < 0 ? f + 1 : f;
  const f1 = 1 - (Math.cos(fr * Math.PI) + 1) / 2;
  return fr + (f1 - fr) / 3;
}

export function computeSky(dayTime: number, dimension: Dimension, biomeSky: number, biomeFog: number | undefined, viewDistance: number, rain: number, thunder: number, camY: number, medium: 'air' | 'water' | 'lava' | 'powder_snow', waterColor: number): SkyState {
  const tod = timeOfDay(dayTime);
  const angle = tod * Math.PI * 2;
  const cosA = Math.cos(angle);
  let dayFactor = clamp(1 - (1 - (cosA * 2 + 0.2)), 0, 1);
  dayFactor = 1 - clamp(1 - (cosA * 2 + 0.2), 0, 1);
  dayFactor *= 1 - rain * 5 / 16; dayFactor *= 1 - thunder * 5 / 16;
  dayFactor = dayFactor * 0.8 + 0.2;
  const bright = clamp(cosA * 2 + 0.5, 0, 1);
  const toRgb = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
  let sky = toRgb(biomeSky).map((v) => v * bright) as [number, number, number];
  let fog = toRgb(biomeFog ?? 0xc0d8ff).map((v) => v * bright) as [number, number, number];
  if (rain > 0) {
    const g = 1 - rain * 0.5;
    const lum = (sky[0] * 0.3 + sky[1] * 0.59 + sky[2] * 0.11);
    sky = sky.map((v) => (v * (1 - rain * 0.75) + lum * rain * 0.75) * g) as [number, number, number];
    fog = fog.map((v) => (v * (1 - rain * 0.75) + lum * rain * 0.75) * g) as [number, number, number];
  }
  if (thunder > 0) { const g = 1 - thunder * 0.5; sky = sky.map((v) => v * g) as any; fog = fog.map((v) => v * g) as any; }
  // sunrise/sunset colour
  let sunset: [number, number, number, number] = [0, 0, 0, 0];
  if (cosA >= -0.4 && cosA <= 0.4 && dimension === 'overworld') {
    const f = cosA / 0.4 * 0.5 + 0.5;
    let a = 1 - (1 - Math.sin(f * Math.PI)) * 0.99;
    a *= a;
    sunset = [f * 0.3 + 0.7, f * f * 0.7 + 0.2, f * f * 0 + 0.2, a * (1 - rain)];
  }
  const starBrightness = dimension === 'overworld' ? clamp(1 - (cosA * 2 + 0.25), 0, 1) * (1 - rain) : dimension === 'the_end' ? 0.3 : 0;
  let fogStart = viewDistance * 16 * 0.75, fogEnd = viewDistance * 16;
  if (dimension === 'the_nether') { sky = [0.2, 0.03, 0.03]; fog = toRgb(biomeFog ?? 0x330808); fogStart = 8; fogEnd = Math.min(viewDistance * 16, 96); }
  if (dimension === 'the_end') { sky = [0, 0, 0]; fog = toRgb(0xa080a0).map((v) => v * 0.15) as any; fogStart = viewDistance * 16 * 0.5; fogEnd = viewDistance * 16; }
  if (medium === 'water') { fog = toRgb(waterColor).map((v) => v * (0.15 + 0.5 * bright)) as any; fogStart = -8; fogEnd = 24 + bright * 24; }
  else if (medium === 'lava') { fog = [0.6, 0.1, 0]; fogStart = 0.25; fogEnd = 1; }
  else if (medium === 'powder_snow') { fog = [0.62, 0.8, 0.92]; fogStart = 0; fogEnd = 2; }
  // below the world: darken
  if (camY < -60 && dimension === 'overworld') { const t = clamp((-60 - camY) / 20, 0, 1); fog = fog.map((v) => v * (1 - t)) as any; sky = sky.map((v) => v * (1 - t)) as any; }
  const voidColor: [number, number, number] = [sky[0] * 0.2, sky[1] * 0.2, sky[2] * 0.2];
  const voidStrength = dimension === 'overworld' ? clamp((-40 - camY) / 24, 0, 1) : 0;
  // vanilla Level.getMoonPhase: phase 0 (the first night) is the full moon
  const moonPhase = Math.floor(dayTime / 24000) % 8;
  return { timeOfDay: tod, sunAngle: angle, dayFactor, skyColor: sky, fogColor: fog, voidColor, sunset, starBrightness, moonPhase, rainLevel: rain, fogStart, fogEnd, voidStrength };
}

/** Vanilla light brightness curve. */
export function brightness(level: number, ambient = 0): number {
  const f = level / 15;
  const b = f / (4 - 3 * f);
  return b + (1 - b) * ambient;
}

/** Fill a 16x16 RGB lightmap (x = block light, y = sky light). */
export function buildLightmap(out: Uint8Array, dayFactor: number, gamma: number, dimension: Dimension, nightVision: number, underwaterDark: number): void {
  const ambient = dimension === 'the_nether' ? 0.1 : dimension === 'the_end' ? 0 : 0;
  const skyTint = dimension === 'the_end' ? [0.22, 0.28, 0.25] : null;
  for (let sky = 0; sky < 16; sky++) for (let block = 0; block < 16; block++) {
    const b = brightness(block, ambient);
    let s = brightness(sky, ambient) * dayFactor;
    if (dimension === 'the_nether') s = 0;
    // block light: warm colour
    let r = b, g = b * ((b * 0.6) + 0.4), bl = b * ((b * b * 0.6) + 0.4);
    // sky light: slightly blue at night
    const night = 1 - clamp((dayFactor - 0.2) / 0.8, 0, 1);
    const sr = s * (1 - night * 0.3), sg = s * (1 - night * 0.3), sb = s;
    r += sr; g += sg; bl += sb;
    if (skyTint) { r = Math.max(r, skyTint[0]); g = Math.max(g, skyTint[1]); bl = Math.max(bl, skyTint[2]); }
    // ambient minimum
    r = Math.max(r, 0.03); g = Math.max(g, 0.03); bl = Math.max(bl, 0.03);
    if (nightVision > 0) { const m = Math.max(r, g, bl); const inv = 1 / m; r = r * (1 - nightVision) + r * inv * nightVision; g = g * (1 - nightVision) + g * inv * nightVision; bl = bl * (1 - nightVision) + bl * inv * nightVision; }
    if (underwaterDark > 0) { r *= 1 - underwaterDark * 0.5; g *= 1 - underwaterDark * 0.5; bl *= 1 - underwaterDark * 0.3; }
    // gamma (vanilla "brightness" option)
    const gam = (v: number) => { v = clamp(v, 0, 1); const inv = 1 - v; const vv = 1 - inv * inv * inv * inv; return v * (1 - gamma) + vv * gamma; };
    r = gam(r); g = gam(g); bl = gam(bl);
    const o = (sky * 16 + block) * 4;
    out[o] = r * 255; out[o + 1] = g * 255; out[o + 2] = bl * 255; out[o + 3] = 255;
  }
}
