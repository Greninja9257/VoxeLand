// GLSL sources.
export const CHUNK_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUv;
layout(location=2) in vec3 aColor;
layout(location=3) in float aLight;
uniform mat4 uVP;
uniform mat4 uModel;
uniform vec3 uOffset;
uniform vec3 uCamPos;
out vec2 vUv;
out vec3 vColor;
out vec2 vLight;
out float vDist;
void main() {
  vec4 world = uModel * vec4(aPos + uOffset, 1.0);
  gl_Position = uVP * world;
  vUv = aUv;
  vColor = aColor;
  float l = aLight * 255.0 + 0.5;
  vLight = vec2(mod(l, 16.0), floor(l / 16.0));
  vDist = length(world.xyz - uCamPos);
}`;

export const CHUNK_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec3 vColor;
in vec2 vLight;
in float vDist;
uniform sampler2D uAtlas;
uniform sampler2D uLightmap;
uniform vec4 uFogColor;
uniform vec2 uFogRange; // start, end
uniform float uAlphaCut;
uniform vec4 uColorMul;
uniform float uLightOverride; // <0: use vertex light; else lightmap index packed
out vec4 fragColor;
void main() {
  vec4 tex = texture(uAtlas, vUv);
  if (tex.a < uAlphaCut) discard;
  vec2 lc = vLight;
  if (uLightOverride >= 0.0) { lc = vec2(mod(uLightOverride, 16.0), floor(uLightOverride / 16.0)); }
  vec3 light = texture(uLightmap, (floor(lc) + 0.5) / 16.0).rgb;
  vec3 col = tex.rgb * vColor * light * uColorMul.rgb;
  float fog = clamp((vDist - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
  fragColor = vec4(mix(col, uFogColor.rgb, fog * uFogColor.a), tex.a * uColorMul.a);
}`;

export const ENTITY_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUv;
layout(location=2) in vec3 aNormal;
uniform mat4 uVP;
uniform mat4 uModel;
uniform vec3 uCamPos;
out vec2 vUv;
out float vShade;
out float vDist;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  gl_Position = uVP * world;
  vUv = aUv;
  vec3 n = normalize(mat3(uModel) * aNormal);
  // vanilla-style directional entity lighting (two lights)
  vec3 l0 = normalize(vec3(0.2, 1.0, -0.7));
  vec3 l1 = normalize(vec3(-0.2, 1.0, 0.7));
  float d = max(0.0, dot(n, l0)) + max(0.0, dot(n, l1));
  vShade = min(1.0, 0.4 + d * 0.6);
  vDist = length(world.xyz - uCamPos);
}`;

export const ENTITY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in float vShade;
in float vDist;
uniform sampler2D uTex;
uniform sampler2D uLightmap;
uniform vec2 uLight; // block, sky
uniform vec4 uColor;
uniform vec4 uFogColor;
uniform vec2 uFogRange;
uniform float uAlphaCut;
out vec4 fragColor;
void main() {
  vec4 tex = texture(uTex, vUv);
  if (tex.a < uAlphaCut) discard;
  vec3 light = texture(uLightmap, (uLight + 0.5) / 16.0).rgb;
  vec3 col = tex.rgb * uColor.rgb * light * vShade;
  float fog = clamp((vDist - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
  fragColor = vec4(mix(col, uFogColor.rgb, fog * uFogColor.a), tex.a * uColor.a);
}`;

export const SKY_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
uniform mat4 uInvVP;
out vec4 vFar;
out vec4 vNear;
void main() {
  gl_Position = vec4(aPos, 0.9999, 1.0);
  // keep homogeneous coordinates: dividing per-vertex would make the interpolated direction wrong
  vFar = uInvVP * vec4(aPos, 1.0, 1.0);
  vNear = uInvVP * vec4(aPos, -1.0, 1.0);
}`;

export const SKY_FS = `#version 300 es
precision highp float;
in vec4 vFar;
in vec4 vNear;
uniform vec3 uSkyColor;
uniform vec3 uFogColor;
uniform vec4 uVoidColor; // rgb + strength
uniform vec3 uSunDir;
uniform vec4 uSunset; // rgb, strength
uniform float uStarBrightness;
uniform float uTime;
uniform int uDimension; // 0 overworld, 1 nether, 2 end
out vec4 fragColor;
float hash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec3 d = normalize(vFar.xyz / vFar.w - vNear.xyz / vNear.w);
  if (uDimension == 1) { fragColor = vec4(uFogColor, 1.0); return; }
  if (uDimension == 2) {
    // end sky: dark with faint noise
    float n = hash(floor(d * 60.0)) * 0.06;
    fragColor = vec4(vec3(0.03, 0.02, 0.04) + n, 1.0); return;
  }
  vec3 col;
  if (d.y > 0.0) col = mix(uFogColor, uSkyColor, smoothstep(0.0, 0.35, d.y));
  else col = mix(uFogColor, uVoidColor.rgb, smoothstep(0.0, 0.25, -d.y) * uVoidColor.a);
  // sunrise / sunset glow toward the sun's azimuth
  if (uSunset.a > 0.0) {
    vec2 sd = normalize(uSunDir.xz);
    vec2 dd = normalize(d.xz + vec2(1e-5));
    float az = max(0.0, dot(sd, dd));
    float band = exp(-abs(d.y) * 6.0) * pow(az, 3.0);
    col = mix(col, uSunset.rgb, band * uSunset.a);
  }
  // stars
  if (uStarBrightness > 0.0 && d.y > -0.1) {
    vec3 cell = floor(d * 90.0);
    float h = hash(cell);
    if (h > 0.985) {
      vec3 cc = (cell + 0.5 + vec3(hash(cell + 1.0), hash(cell + 2.0), hash(cell + 3.0)) - 0.5) / 90.0;
      float dist = length(normalize(cc) - d) * 90.0;
      float s = smoothstep(0.35, 0.0, dist) * uStarBrightness * (0.6 + 0.4 * hash(cell + 5.0));
      col += vec3(s);
    }
  }
  fragColor = vec4(col, 1.0);
}`;

// Lines are drawn as screen-space extruded quads (WebGL ignores lineWidth > 1): each vertex carries both
// segment endpoints and a side sign; the perpendicular offset is applied in clip space so the width is constant in pixels.
export const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aOther;
layout(location=2) in float aSide;
uniform mat4 uVP;
uniform vec2 uViewport; // width, height in pixels
uniform float uWidth;   // line width in pixels
void main() {
  vec4 a = uVP * vec4(aPos, 1.0);
  vec4 b = uVP * vec4(aOther, 1.0);
  // clip against the near plane so segments crossing the camera plane still extrude sensibly
  if (a.w < 0.01) { float t = (0.01 - a.w) / (b.w - a.w); a = mix(a, b, t); }
  if (b.w < 0.01) { float t = (0.01 - b.w) / (a.w - b.w); b = mix(b, a, t); }
  vec2 sa = a.xy / a.w * uViewport, sb = b.xy / b.w * uViewport;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 n = len > 0.0001 ? vec2(-d.y, d.x) / len : vec2(1.0, 0.0);
  vec2 off = n * aSide * uWidth / uViewport; // half-width per side, in NDC (viewport holds half sizes)
  gl_Position = vec4(a.xy + off * a.w, a.z, a.w);
}`;

export const LINE_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 fragColor;
void main() { fragColor = uColor; }`;

export const QUAD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUv;
uniform mat4 uVP;
uniform mat4 uModel;
out vec2 vUv;
void main() { gl_Position = uVP * uModel * vec4(aPos, 1.0); vUv = aUv; }`;

export const QUAD_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec4 uColor;
out vec4 fragColor;
void main() { vec4 t = texture(uTex, vUv); fragColor = vec4(t.rgb * uColor.rgb, t.a * uColor.a); }`;

export const CLOUD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUv;
layout(location=2) in vec3 aColor;
uniform mat4 uVP;
uniform vec3 uOffset;
uniform vec3 uCamPos;
out vec2 vUv;
out vec3 vColor;
out float vDist;
void main() { vec3 w = aPos + uOffset; gl_Position = uVP * vec4(w, 1.0); vUv = aUv; vColor = aColor; vDist = length(w.xz - uCamPos.xz); }`;

export const CLOUD_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vColor;
in float vDist;
uniform sampler2D uTex;
uniform vec4 uColor;
uniform vec2 uFogRange;
uniform vec4 uFogColor;
out vec4 fragColor;
void main() {
  vec4 t = texture(uTex, vUv);
  if (t.a < 0.5) discard;
  float fog = clamp((vDist - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
  fragColor = vec4(mix(t.rgb * vColor * uColor.rgb, uFogColor.rgb, fog), uColor.a);
}`;
