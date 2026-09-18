// WebGL2 world renderer: chunk sections, atlas animation, lightmap, sky, sun/moon, clouds, outlines.
import type { Assets, AtlasAnimation } from '../assets';
import { mat4Rotate, Frustum, mat4Identity, mat4Invert, mat4Mul, mat4Perspective, mat4RotateX, mat4RotateY, mat4RotateZ as mat4RotZ, mat4Translate, mat4Scale, DEG, type Mat4 } from '../math';
import { MIN_Y, SECTION_COUNT } from '../world/chunk';
import { Program, createTexture, buildMips, imageToData } from './gl';
import { CHUNK_FS, CHUNK_VS, ENTITY_FS, ENTITY_VS, LINE_FS, LINE_VS, SKY_FS, SKY_VS, QUAD_FS, QUAD_VS, CLOUD_FS, CLOUD_VS } from './shaders';
import { VERTEX_STRIDE, type MeshOutput } from './mesher';
import { buildLightmap, type SkyState } from './sky';
import type { Dimension } from '../world/world';
import type { SectionMeshTarget } from '../world/chunkManager';

interface LayerGpu { vao: WebGLVertexArrayObject; vbo: WebGLBuffer; quads: number }
interface SectionGpu { cx: number; sy: number; cz: number; layers: (LayerGpu | null)[]; empty: boolean }

export interface Camera { x: number; y: number; z: number; yaw: number; pitch: number; fov: number }

const MAX_QUADS = 1 << 18;

export class Renderer implements SectionMeshTarget {
  gl: WebGL2RenderingContext;
  chunkProg: Program; entityProg: Program; skyProg: Program; lineProg: Program; quadProg: Program; cloudProg: Program;
  atlasTex: WebGLTexture; lightmapTex: WebGLTexture;
  private lightmapData = new Uint8Array(16 * 16 * 4);
  private quadIbo: WebGLBuffer;
  sections = new Map<number, SectionGpu>();
  private skyVao: WebGLVertexArrayObject;
  private lineVao: WebGLVertexArrayObject; private lineVbo: WebGLBuffer;
  private quadVao: WebGLVertexArrayObject; private quadVbo: WebGLBuffer;
  private celestialVao: WebGLVertexArrayObject; private celestialVbo: WebGLBuffer;
  private cloudVao: WebGLVertexArrayObject | null = null; private cloudVbo: WebGLBuffer | null = null; private cloudQuads = 0; private cloudTex: WebGLTexture | null = null;
  private celestial: Record<string, WebGLTexture> = {};
  // matrices
  proj = new Float32Array(16); view = new Float32Array(16); vp = new Float32Array(16); invVp = new Float32Array(16);
  /** rotation-only view-projection for the sky dome, sun, moon and stars (vanilla renders the sky before the
   *  camera translation is applied, so it never parallaxes or jumps with the player's position) */
  skyVp = new Float32Array(16); invSkyVp = new Float32Array(16);
  frustum = new Frustum();
  camera: Camera = { x: 0, y: 80, z: 0, yaw: 0, pitch: 0, fov: 70 };
  // animation
  private animData: ImageData;
  private animState: { a: AtlasAnimation; frame: number; tick: number; seq: number[]; times: number[] }[] = [];
  private atlasMipLevels = 4;
  private atlasData!: ImageData;
  stats = { drawCalls: 0, sections: 0, quads: 0 };
  viewDistance = 8;
  private sortedTranslucent: SectionGpu[] = [];
  private visible: SectionGpu[] = [];
  fancyClouds = true;
  private cloudMeshFancy = true;
  cloudsEnabled = true;
  /** Rebuild the atlas mip chain with a different level count (Mipmap Levels option). */
  setMipmapLevels(levels: number): void {
    levels = Math.max(0, Math.min(4, Math.round(levels)));
    if (levels === this.atlasMipLevels) return;
    this.atlasMipLevels = levels;
    const gl = this.gl;
    const mips = buildMips(new Uint8Array(this.atlasData.data.buffer), this.atlasData.width, this.atlasData.height, levels);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    for (let l = 0; l < mips.length; l++) gl.texImage2D(gl.TEXTURE_2D, l, gl.RGBA, mips[l].width, mips[l].height, 0, gl.RGBA, gl.UNSIGNED_BYTE, mips[l].data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 0 ? gl.NEAREST_MIPMAP_LINEAR : gl.NEAREST);
  }

  constructor(public canvas: HTMLCanvasElement, public assets: Assets) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false })!;
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    this.chunkProg = new Program(gl, CHUNK_VS, CHUNK_FS, ['uVP', 'uModel', 'uOffset', 'uCamPos', 'uAtlas', 'uLightmap', 'uFogColor', 'uFogRange', 'uAlphaCut', 'uColorMul', 'uLightOverride'], 'chunk');
    this.entityProg = new Program(gl, ENTITY_VS, ENTITY_FS, ['uVP', 'uModel', 'uCamPos', 'uTex', 'uLightmap', 'uLight', 'uColor', 'uFogColor', 'uFogRange', 'uAlphaCut'], 'entity');
    this.skyProg = new Program(gl, SKY_VS, SKY_FS, ['uInvVP', 'uSkyColor', 'uFogColor', 'uVoidColor', 'uSunDir', 'uSunset', 'uStarBrightness', 'uSunAngle', 'uTime', 'uDimension'], 'sky');
    this.lineProg = new Program(gl, LINE_VS, LINE_FS, ['uVP', 'uColor', 'uViewport', 'uWidth'], 'line');
    this.quadProg = new Program(gl, QUAD_VS, QUAD_FS, ['uVP', 'uModel', 'uTex', 'uColor'], 'quad');
    this.cloudProg = new Program(gl, CLOUD_VS, CLOUD_FS, ['uVP', 'uOffset', 'uCamPos', 'uTex', 'uColor', 'uFogRange', 'uFogColor'], 'cloud');

    // atlas with alpha-weighted mips
    const atlasData = imageToData(assets.atlasImage);
    this.atlasData = atlasData;
    const mips = buildMips(new Uint8Array(atlasData.data.buffer), atlasData.width, atlasData.height, this.atlasMipLevels);
    this.atlasTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    for (let l = 0; l < mips.length; l++) gl.texImage2D(gl.TEXTURE_2D, l, gl.RGBA, mips[l].width, mips[l].height, 0, gl.RGBA, gl.UNSIGNED_BYTE, mips[l].data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, this.atlasMipLevels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.animData = imageToData(assets.animImage);
    for (const a of assets.atlas.animations) {
      const seq: number[] = [], times: number[] = [];
      if (a.frames) for (const f of a.frames) { if (typeof f === 'number') { seq.push(f); times.push(a.frametime); } else { seq.push(f.index); times.push(f.time ?? a.frametime); } }
      else for (let i = 0; i < a.frameCount; i++) { seq.push(i); times.push(a.frametime); }
      this.animState.push({ a, frame: 0, tick: 0, seq, times });
    }
    this.lightmapTex = createTexture(gl, null, { width: 16, height: 16, nearest: false });
    // shared quad index buffer
    const idx = new Uint32Array(MAX_QUADS * 6);
    for (let i = 0, v = 0; i < MAX_QUADS; i++, v += 4) { const o = i * 6; idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2; idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3; }
    this.quadIbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    // sky full-screen triangle
    this.skyVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.skyVao);
    const svb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, svb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // lines
    this.lineVao = gl.createVertexArray()!; this.lineVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.lineVao); gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    // per vertex: pos(3) other(3) side(1) -> 28 bytes
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);
    // celestial quads (sun/moon), vertices uploaded per frame like vanilla's BufferBuilder
    this.celestialVao = gl.createVertexArray()!; this.celestialVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.celestialVao); gl.bindBuffer(gl.ARRAY_BUFFER, this.celestialVbo);
    gl.bufferData(gl.ARRAY_BUFFER, 4 * 5 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    // textured quad (shadows)
    this.quadVao = gl.createVertexArray()!; this.quadVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.quadVao); gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 0, 1, 1, -1, 0, 1, 1, 1, 1, 0, 1, 0, -1, 1, 0, 0, 0]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);
    this.loadCelestial();
    this.buildClouds();
  }

  private async loadCelestial(): Promise<void> {
    const load = async (name: string, path: string) => {
      try {
        const r = await fetch('./assets/pack/assets/minecraft/textures/' + path);
        if (!r.ok) return;
        const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none' });
        this.celestial[name] = createTexture(this.gl, bmp, { nearest: true });
      } catch { /* optional */ }
    };
    await Promise.all([
      load('sun', 'environment/celestial/sun.png'), load('sun_old', 'environment/sun.png'),
      ...['new_moon', 'waxing_crescent', 'first_quarter', 'waxing_gibbous', 'full_moon', 'waning_gibbous', 'third_quarter', 'waning_crescent'].map((m) => load('moon_' + m, `environment/celestial/moon/${m}.png`)),
            load('clouds', 'environment/clouds.png'),
      load('shadow', 'misc/shadow.png'),
    ]);
    if (this.celestial.clouds) this.cloudTex = this.celestial.clouds;
  }

  private buildClouds(): void {
    // cloud mesh from clouds.png built lazily when texture arrives (see drawClouds)
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr), h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.gl.viewport(0, 0, w, h);
  }

  // ---------- sections ----------
  private key(cx: number, sy: number, cz: number): number { return ((cx + 0x8000) * 0x10000 + ((cz + 0x8000) & 0xffff)) * 32 + sy; }

  setSectionMesh(cx: number, sy: number, cz: number, out: MeshOutput): void {
    const gl = this.gl;
    const k = this.key(cx, sy, cz);
    let s = this.sections.get(k);
    if (!s) { s = { cx, sy, cz, layers: [null, null, null], empty: true }; this.sections.set(k, s); }
    let empty = true;
    for (let l = 0; l < 3; l++) {
      const lm = out.layers[l];
      const cur = s.layers[l];
      if (!lm) { if (cur) { gl.deleteVertexArray(cur.vao); gl.deleteBuffer(cur.vbo); s.layers[l] = null; } continue; }
      empty = false;
      let g = cur;
      if (!g) {
        const vao = gl.createVertexArray()!, vbo = gl.createBuffer()!;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_STRIDE, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.UNSIGNED_SHORT, true, VERTEX_STRIDE, 12);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, VERTEX_STRIDE, 16);
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, true, VERTEX_STRIDE, 19);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIbo);
        gl.bindVertexArray(null);
        g = { vao, vbo, quads: 0 };
        s.layers[l] = g;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, lm.data, gl.STATIC_DRAW);
      g.quads = Math.min(lm.quads, MAX_QUADS);
    }
    s.empty = empty;
    if (empty) { this.sections.delete(k); }
  }

  removeChunkMeshes(cx: number, cz: number): void {
    const gl = this.gl;
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const k = this.key(cx, sy, cz);
      const s = this.sections.get(k);
      if (!s) continue;
      for (const l of s.layers) if (l) { gl.deleteVertexArray(l.vao); gl.deleteBuffer(l.vbo); }
      this.sections.delete(k);
    }
  }

  // ---------- per-frame ----------
  cameraRoll = 0; cameraPitchOffset = 0;
  /** View-space scene shift (view bobbing), applied before the roll. */
  cameraShift = [0, 0];
  /** Damage tilt: [direction degrees, roll degrees] and the death-screen roll (vanilla bobHurt). */
  hurtTilt = [0, 0]; deathRoll = 0;
  /** Nausea / portal whirl (vanilla GameRenderer confusion): [intensity 0..1, animation angle degrees] */
  nausea = [0, 0];
  /** Integer part of the camera position; chunk offsets are relative to this so shared vertices are bit-identical. */
  camBase = [0, 0, 0];
  updateMatrices(): void {
    const c = this.camera;
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    mat4Perspective(this.proj, c.fov * DEG, aspect, 0.05, Math.max(256, this.viewDistance * 16 * 2.5));
    mat4Identity(this.view);
    if (this.deathRoll) mat4RotZ(this.view, this.view, this.deathRoll * DEG);
    if (this.hurtTilt[1]) { mat4RotateY(this.view, this.view, -this.hurtTilt[0] * DEG); mat4RotZ(this.view, this.view, this.hurtTilt[1] * DEG); mat4RotateY(this.view, this.view, this.hurtTilt[0] * DEG); }
    if (this.cameraShift[0] || this.cameraShift[1]) mat4Translate(this.view, this.view, this.cameraShift[0], this.cameraShift[1], 0);
    if (this.cameraRoll) mat4RotZ(this.view, this.view, this.cameraRoll * DEG);
    if (this.cameraPitchOffset) mat4RotateX(this.view, this.view, this.cameraPitchOffset * DEG);
    if (this.nausea[0] > 0) {
      const f = this.nausea[0];
      let f1 = 5 / (f * f + 5) - f * 0.04; f1 *= f1;
      const a = this.nausea[1] * DEG, s2 = Math.SQRT1_2;
      mat4Rotate(this.view, this.view, a, 0, s2, s2);
      mat4Scale(this.view, this.view, 1 / f1, 1, 1);
      mat4Rotate(this.view, this.view, -a, 0, s2, s2);
    }
    mat4RotateX(this.view, this.view, c.pitch * DEG);
    mat4RotateY(this.view, this.view, (c.yaw + 180) * DEG);
    mat4Mul(this.skyVp, this.proj, this.view);
    mat4Invert(this.invSkyVp, this.skyVp);
    this.camBase = [Math.floor(c.x), Math.floor(c.y), Math.floor(c.z)];
    mat4Translate(this.view, this.view, -(c.x - this.camBase[0]), -(c.y - this.camBase[1]), -(c.z - this.camBase[2]));
    mat4Mul(this.vp, this.proj, this.view);
    mat4Invert(this.invVp, this.vp);
    this.frustum.update(this.vp);
  }

  /** Advance texture animations by one game tick. */
  tickAnimations(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    const src = this.animData;
    for (const st of this.animState) {
      st.tick++;
      const a = st.a;
      const dur = st.times[st.frame] || 1;
      const changed = st.tick >= dur;
      if (changed) { st.tick = 0; st.frame = (st.frame + 1) % st.seq.length; }
      if (!changed && !a.interpolate) continue;
      const fi = st.seq[st.frame], fn = st.seq[(st.frame + 1) % st.seq.length];
      const w = a.w, h = a.h;
      const px = new Uint8Array(w * h * 4);
      const t = a.interpolate ? st.tick / dur : 0;
      for (let y = 0; y < h; y++) {
        const so = ((a.srcY + fi * h + y) * src.width + a.srcX) * 4;
        const so2 = ((a.srcY + fn * h + y) * src.width + a.srcX) * 4;
        const doff = y * w * 4;
        if (t === 0) px.set(src.data.subarray(so, so + w * 4), doff);
        else for (let i = 0; i < w * 4; i++) px[doff + i] = src.data[so + i] * (1 - t) + src.data[so2 + i] * t;
      }
      const mips = buildMips(px, w, h, this.atlasMipLevels);
      for (let l = 0; l < mips.length; l++) {
        if ((a.x >> l) + mips[l].width > (this.assets.atlas.width >> l)) break;
        gl.texSubImage2D(gl.TEXTURE_2D, l, a.x >> l, a.y >> l, mips[l].width, mips[l].height, gl.RGBA, gl.UNSIGNED_BYTE, mips[l].data);
      }
    }
  }

  updateLightmap(dayFactor: number, gamma: number, dimension: Dimension, nightVision: number, underwaterDark: number): void {
    buildLightmap(this.lightmapData, dayFactor, gamma, dimension, nightVision, underwaterDark);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lightmapTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 16, 16, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.lightmapData);
  }

  beginFrame(sky: SkyState, dimension: Dimension, timeSec: number): void {
    const gl = this.gl;
    this.resize();
    this.updateMatrices();
    gl.clearColor(sky.fogColor[0], sky.fogColor[1], sky.fogColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.stats.drawCalls = 0; this.stats.sections = 0; this.stats.quads = 0;
    // sky
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    this.skyProg.use();
    gl.uniformMatrix4fv(this.skyProg.u('uInvVP'), false, this.invSkyVp);
    gl.uniform3fv(this.skyProg.u('uSkyColor'), sky.skyColor);
    gl.uniform3fv(this.skyProg.u('uFogColor'), sky.fogColor);
    gl.uniform4f(this.skyProg.u('uVoidColor'), sky.voidColor[0], sky.voidColor[1], sky.voidColor[2], sky.voidStrength);
    const sd = this.sunDir(sky.sunAngle);
    gl.uniform3fv(this.skyProg.u('uSunDir'), sd);
    gl.uniform4fv(this.skyProg.u('uSunset'), sky.sunset);
    gl.uniform1f(this.skyProg.u('uStarBrightness'), sky.starBrightness * (1 - sky.rainLevel));
    gl.uniform1f(this.skyProg.u('uSunAngle'), sky.sunAngle);
    gl.uniform1f(this.skyProg.u('uTime'), timeSec);
    gl.uniform1i(this.skyProg.u('uDimension'), dimension === 'overworld' ? 0 : dimension === 'the_nether' ? 1 : 2);
    gl.bindVertexArray(this.skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (dimension === 'overworld') this.drawSunMoon(sky);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  /** Sun direction: noon = straight up (angle 0); rises in the east (+x), sets in the west (-x). */
  sunDir(angle: number): [number, number, number] {
    return [-Math.sin(angle), Math.cos(angle), 0];
  }

  /** Entity blob shadows (vanilla EntityRenderDispatcher.renderShadow, simplified to one quad per entity). */
  drawShadows(list: { x: number; y: number; z: number; radius: number; alpha: number }[]): void {
    const gl = this.gl, tex = this.celestial.shadow;
    if (!tex || !list.length) return;
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    this.quadProg.use();
    gl.uniformMatrix4fv(this.quadProg.u('uVP'), false, this.vp);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(this.quadProg.u('uTex'), 0);
    gl.bindVertexArray(this.quadVao);
    const m = new Float32Array(16), cb = this.camBase;
    for (const s of list) {
      mat4Identity(m);
      mat4Translate(m, m, s.x - cb[0], s.y - cb[1] + 0.005, s.z - cb[2]);
      mat4Scale(m, m, s.radius, 1, s.radius);
      mat4RotateX(m, m, -Math.PI / 2);
      gl.uniformMatrix4fv(this.quadProg.u('uModel'), false, m);
      gl.uniform4f(this.quadProg.u('uColor'), 1, 1, 1, s.alpha);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    }
    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /** vanilla LevelRenderer.renderSky: the sun (60 wide at y=100) and moon (40 wide at y=-100, phase from the
   *  atlas order full → waning → new → waxing) sit on a sphere rotated by rotY(-90°)·rotX(timeOfDay·360°), drawn
   *  additively and faded out by rain. */
  private drawSunMoon(sky: SkyState): void {
    const gl = this.gl;
    const sun = this.celestial.sun ?? this.celestial.sun_old;
    if (!sun) return;
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ZERO);
    this.quadProg.use();
    gl.uniformMatrix4fv(this.quadProg.u('uVP'), false, this.skyVp);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.quadProg.u('uTex'), 0);
    const m = new Float32Array(16);
    mat4Identity(m);
    mat4RotateY(m, m, -Math.PI / 2);
    mat4RotateX(m, m, sky.sunAngle);
    gl.uniformMatrix4fv(this.quadProg.u('uModel'), false, m);
    const alpha = 1 - sky.rainLevel;
    gl.uniform4f(this.quadProg.u('uColor'), 1, 1, 1, alpha);
    gl.bindVertexArray(this.celestialVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.celestialVbo);
    // vanilla sizes: the 32x32 sprites have always been a small bright body inside a soft glow, drawn on a
    // 60-unit quad for the sun and a 40-unit one for the moon
    const s = 30;
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([-s, 100, -s, 0, 0, s, 100, -s, 1, 0, s, 100, s, 1, 1, -s, 100, s, 0, 1]));
    gl.bindTexture(gl.TEXTURE_2D, sun);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    // moon (its texture is mirrored horizontally, exactly as vanilla maps the atlas cell)
    const phases = ['full_moon', 'waning_gibbous', 'third_quarter', 'waning_crescent', 'new_moon', 'waxing_crescent', 'first_quarter', 'waxing_gibbous'];
    const moon = this.celestial['moon_' + phases[sky.moonPhase]];
    if (moon) {
      const q = 20;
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([-q, -100, q, 1, 1, q, -100, q, 0, 1, q, -100, -q, 0, 0, -q, -100, -q, 1, 0]));
      gl.bindTexture(gl.TEXTURE_2D, moon);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Bind chunk program with common uniforms. */
  useChunkProgram(sky: SkyState): void {
    const gl = this.gl;
    this.chunkProg.use();
    gl.uniformMatrix4fv(this.chunkProg.u('uVP'), false, this.vp);
    gl.uniformMatrix4fv(this.chunkProg.u('uModel'), false, IDENTITY);
    gl.uniform3f(this.chunkProg.u('uCamPos'), 0, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.atlasTex); gl.uniform1i(this.chunkProg.u('uAtlas'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.lightmapTex); gl.uniform1i(this.chunkProg.u('uLightmap'), 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform4f(this.chunkProg.u('uFogColor'), sky.fogColor[0], sky.fogColor[1], sky.fogColor[2], 1);
    gl.uniform2f(this.chunkProg.u('uFogRange'), sky.fogStart, sky.fogEnd);
    gl.uniform4f(this.chunkProg.u('uColorMul'), 1, 1, 1, 1);
    gl.uniform1f(this.chunkProg.u('uLightOverride'), -1);
    gl.uniform1f(this.chunkProg.u('uAlphaCut'), 0);
  }

  /** Draw all chunk sections: solid + cutout now; translucent via drawTranslucent(). */
  drawChunks(sky: SkyState): void {
    const gl = this.gl;
    const cam = { x: this.camBase[0], y: this.camBase[1], z: this.camBase[2] };
    const vis = this.visible; vis.length = 0;
    const maxD = this.viewDistance * 16 + 16;
    const ccx = Math.floor(cam.x / 16), ccz = Math.floor(cam.z / 16);
    for (const s of this.sections.values()) {
      const dx = (s.cx - ccx), dz = (s.cz - ccz);
      if (dx * dx + dz * dz > (this.viewDistance + 1) * (this.viewDistance + 1)) continue;
      const x0 = s.cx * 16 - cam.x, y0 = s.sy * 16 + MIN_Y - cam.y, z0 = s.cz * 16 - cam.z;
      if (!this.frustum.intersectsBox(x0, y0, z0, x0 + 16, y0 + 16, z0 + 16)) continue;
      vis.push(s);
    }
    // front-to-back for solid
    const dist = (s: SectionGpu) => { const dx = s.cx * 16 + 8 - cam.x, dy = s.sy * 16 + MIN_Y + 8 - cam.y, dz = s.cz * 16 + 8 - cam.z; return dx * dx + dy * dy + dz * dz; };
    vis.sort((a, b) => dist(a) - dist(b));
    this.useChunkProgram(sky);
    const uOff = this.chunkProg.u('uOffset');
    gl.disable(gl.BLEND);
    for (let layer = 0; layer < 2; layer++) {
      gl.uniform1f(this.chunkProg.u('uAlphaCut'), layer === 1 ? 0.1 : 0);
      for (let i = 0; i < vis.length; i++) {
        const s = vis[i];
        const g = s.layers[layer];
        if (!g) continue;
        gl.uniform3f(uOff, s.cx * 16 - cam.x, s.sy * 16 + MIN_Y - cam.y, s.cz * 16 - cam.z);
        gl.bindVertexArray(g.vao);
        gl.drawElements(gl.TRIANGLES, g.quads * 6, gl.UNSIGNED_INT, 0);
        this.stats.drawCalls++; this.stats.quads += g.quads;
      }
    }
    this.stats.sections = vis.length;
    this.sortedTranslucent = vis.filter((s) => s.layers[2]).reverse();
    gl.bindVertexArray(null);
    void maxD;
  }

  drawTranslucent(sky: SkyState): void {
    const gl = this.gl;
    const cam = { x: this.camBase[0], y: this.camBase[1], z: this.camBase[2] };
    this.useChunkProgram(sky);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(this.chunkProg.u('uAlphaCut'), 0.01);
    const uOff = this.chunkProg.u('uOffset');
    for (const s of this.sortedTranslucent) {
      const g = s.layers[2]!;
      gl.uniform3f(uOff, s.cx * 16 - cam.x, s.sy * 16 + MIN_Y - cam.y, s.cz * 16 - cam.z);
      gl.bindVertexArray(g.vao);
      gl.drawElements(gl.TRIANGLES, g.quads * 6, gl.UNSIGNED_INT, 0);
      this.stats.drawCalls++; this.stats.quads += g.quads;
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  /** Draw a batch of chunk-format vertices (items, particles, held item) with a model matrix (camera-relative). */
  drawChunkFormatBuffer(data: ArrayBuffer, quads: number, model: Mat4, sky: SkyState, opts: { light?: number; alphaCut?: number; blend?: boolean; blendFunc?: [number, number]; colorMul?: [number, number, number, number]; noCull?: boolean; noDepth?: boolean; noFog?: boolean } = {}): void {
    const gl = this.gl;
    if (quads === 0) return;
    this.useChunkProgram(sky);
    gl.uniformMatrix4fv(this.chunkProg.u('uModel'), false, model);
    gl.uniform3f(this.chunkProg.u('uOffset'), 0, 0, 0);
    gl.uniform1f(this.chunkProg.u('uLightOverride'), opts.light ?? -1);
    gl.uniform1f(this.chunkProg.u('uAlphaCut'), opts.alphaCut ?? 0.1);
    if (opts.colorMul) gl.uniform4fv(this.chunkProg.u('uColorMul'), opts.colorMul);
    if (opts.noFog) gl.uniform2f(this.chunkProg.u('uFogRange'), 1e6, 1e6 + 1);
    if (opts.blend) { gl.enable(gl.BLEND); if (opts.blendFunc) gl.blendFunc(opts.blendFunc[0], opts.blendFunc[1]); else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); }
    if (opts.noCull) gl.disable(gl.CULL_FACE);
    if (opts.noDepth) gl.disable(gl.DEPTH_TEST);
    const vao = this.scratchVao(data);
    gl.bindVertexArray(vao);
    gl.drawElements(gl.TRIANGLES, Math.min(quads, MAX_QUADS) * 6, gl.UNSIGNED_INT, 0);
    this.stats.drawCalls++;
    gl.bindVertexArray(null);
    if (opts.blend) gl.disable(gl.BLEND);
    if (opts.noCull) gl.enable(gl.CULL_FACE);
    if (opts.noDepth) gl.enable(gl.DEPTH_TEST);
    gl.uniformMatrix4fv(this.chunkProg.u('uModel'), false, IDENTITY);
  }

  private scratch: { vao: WebGLVertexArrayObject; vbo: WebGLBuffer } | null = null;
  private scratchVao(data: ArrayBuffer): WebGLVertexArrayObject {
    const gl = this.gl;
    if (!this.scratch) {
      const vao = gl.createVertexArray()!, vbo = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_STRIDE, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.UNSIGNED_SHORT, true, VERTEX_STRIDE, 12);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, VERTEX_STRIDE, 16);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, true, VERTEX_STRIDE, 19);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIbo);
      gl.bindVertexArray(null);
      this.scratch = { vao, vbo };
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.scratch.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    return this.scratch.vao;
  }

  /** Draw line segments (camera-relative coordinates, pairs of points) with a pixel width. */
  drawLines(verts: Float32Array, color: [number, number, number, number], width = 1): void {
    const gl = this.gl;
    const segs = verts.length / 6;
    if (!segs) return;
    // expand each segment into two triangles: (a,-1) (a,+1) (b,+1) / (a,-1) (b,+1) (b,-1)
    const out = new Float32Array(segs * 6 * 7);
    let o = 0;
    const put = (px: number, py: number, pz: number, qx: number, qy: number, qz: number, side: number) => { out[o++] = px; out[o++] = py; out[o++] = pz; out[o++] = qx; out[o++] = qy; out[o++] = qz; out[o++] = side; };
    for (let i = 0; i < segs; i++) {
      const ax = verts[i * 6], ay = verts[i * 6 + 1], az = verts[i * 6 + 2], bx = verts[i * 6 + 3], by = verts[i * 6 + 4], bz = verts[i * 6 + 5];
      put(ax, ay, az, bx, by, bz, -1); put(ax, ay, az, bx, by, bz, 1); put(bx, by, bz, ax, ay, az, -1);
      put(ax, ay, az, bx, by, bz, -1); put(bx, by, bz, ax, ay, az, -1); put(bx, by, bz, ax, ay, az, 1);
    }
    this.lineProg.use();
    gl.uniformMatrix4fv(this.lineProg.u('uVP'), false, this.vp);
    gl.uniform4fv(this.lineProg.u('uColor'), color);
    gl.uniform2f(this.lineProg.u('uViewport'), gl.drawingBufferWidth / 2, gl.drawingBufferHeight / 2);
    // vanilla: max(2.5, width/1920*2.5) pixels
    gl.uniform1f(this.lineProg.u('uWidth'), width * Math.max(1, gl.drawingBufferWidth / 1920) / 2);
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, out, gl.DYNAMIC_DRAW);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLES, 0, segs * 6);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  /** Wireframe box outline (world coords). */
  drawBoxOutline(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: [number, number, number, number]): void {
    const c = { x: this.camBase[0], y: this.camBase[1], z: this.camBase[2] };
    x0 -= c.x; x1 -= c.x; y0 -= c.y; y1 -= c.y; z0 -= c.z; z1 -= c.z;
    const v = new Float32Array([
      x0, y0, z0, x1, y0, z0, x1, y0, z0, x1, y0, z1, x1, y0, z1, x0, y0, z1, x0, y0, z1, x0, y0, z0,
      x0, y1, z0, x1, y1, z0, x1, y1, z0, x1, y1, z1, x1, y1, z1, x0, y1, z1, x0, y1, z1, x0, y1, z0,
      x0, y0, z0, x0, y1, z0, x1, y0, z0, x1, y1, z0, x1, y0, z1, x1, y1, z1, x0, y0, z1, x0, y1, z1,
    ]);
    this.drawLines(v, color, 2.5);
  }

  drawClouds(sky: SkyState, timeSec: number, cloudY: number): void {
    if (!this.cloudsEnabled || !this.cloudTex) return;
    const gl = this.gl;
    if (!this.cloudVao || this.cloudMeshFancy !== this.fancyClouds) this.buildCloudMesh();
    if (!this.cloudVao || this.cloudQuads === 0) return;
    const cam = { x: this.camBase[0], y: this.camBase[1], z: this.camBase[2] };
    this.cloudProg.use();
    gl.uniformMatrix4fv(this.cloudProg.u('uVP'), false, this.vp);
    const scroll = timeSec * 0.03 * 12; // vanilla: clouds drift +x slowly
    // cloud texture covers 256 cells of 12 blocks = 3072 blocks; wrap relative to camera
    const period = 256 * 12;
    let ox = -cam.x + scroll; let oz = -cam.z;
    ox = ((ox % period) + period) % period - period / 2; oz = ((oz % period) + period) % period - period / 2;
    gl.uniform3f(this.cloudProg.u('uOffset'), ox - period / 2, cloudY - cam.y, oz - period / 2);
    gl.uniform3f(this.cloudProg.u('uCamPos'), 0, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.cloudTex); gl.uniform1i(this.cloudProg.u('uTex'), 0);
    const b = sky.dayFactor * 0.95 + 0.05;
    gl.uniform4f(this.cloudProg.u('uColor'), b, b, b, 0.8);
    gl.uniform2f(this.cloudProg.u('uFogRange'), this.viewDistance * 16 * 1.5, this.viewDistance * 16 * 3);
    gl.uniform4f(this.cloudProg.u('uFogColor'), sky.fogColor[0], sky.fogColor[1], sky.fogColor[2], 1);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.cloudVao);
    // draw twice for wrap-around
    gl.drawElements(gl.TRIANGLES, this.cloudQuads * 6, gl.UNSIGNED_INT, 0);
    gl.uniform3f(this.cloudProg.u('uOffset'), ox + period / 2, cloudY - cam.y, oz - period / 2);
    gl.drawElements(gl.TRIANGLES, this.cloudQuads * 6, gl.UNSIGNED_INT, 0);
    gl.uniform3f(this.cloudProg.u('uOffset'), ox - period / 2, cloudY - cam.y, oz + period / 2);
    gl.drawElements(gl.TRIANGLES, this.cloudQuads * 6, gl.UNSIGNED_INT, 0);
    gl.uniform3f(this.cloudProg.u('uOffset'), ox + period / 2, cloudY - cam.y, oz + period / 2);
    gl.drawElements(gl.TRIANGLES, this.cloudQuads * 6, gl.UNSIGNED_INT, 0);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    this.stats.drawCalls += 4;
  }

  private buildCloudMesh(): void {
    // Build box clouds (fancy) from the clouds.png alpha: each opaque pixel = 12x4x12 block box.
    const gl = this.gl;
    if (this.cloudVao) { gl.deleteVertexArray(this.cloudVao); this.cloudVao = null; }
    if (this.cloudVbo) { gl.deleteBuffer(this.cloudVbo); this.cloudVbo = null; }
    const img = this.assets.atlas.tiles['environment/clouds'];
    const atlasData = imageToData(this.assets.atlasImage);
    if (!img) return;
    const W = 256, H = 256;
    const cell = 12, height = 4;
    const verts: number[] = [];
    let quads = 0;
    const solid = (x: number, z: number) => atlasData.data[(((img.y + ((z % H) + H) % H) * atlasData.width) + img.x + ((x % W) + W) % W) * 4 + 3] > 128;
    const push = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, x3: number, y3: number, z3: number, shade: number) => {
      const u = 0.5, v = 0.5; // texture sampled flat (colour from vertex), use alpha=1 area: cloud pixel is opaque white
      for (const [x, y, z] of [[x0, y0, z0], [x1, y1, z1], [x2, y2, z2], [x3, y3, z3]]) verts.push(x, y, z, u, v, shade, shade, shade);
      quads++;
    };
    const fancy = this.fancyClouds;
    this.cloudMeshFancy = fancy;
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
      if (!solid(x, z)) continue;
      const x0 = x * cell, z0 = z * cell, x1 = x0 + cell, z1 = z0 + cell;
      if (!fancy) { push(x0, 0, z1, x0, 0, z0, x1, 0, z0, x1, 0, z1, 1.0); push(x0, 0, z0, x0, 0, z1, x1, 0, z1, x1, 0, z0, 1.0); continue; } // fast: flat sheet
      push(x0, height, z0, x0, height, z1, x1, height, z1, x1, height, z0, 1.0); // top
      push(x0, 0, z1, x0, 0, z0, x1, 0, z0, x1, 0, z1, 0.7); // bottom
      if (!solid(x - 1, z)) push(x0, height, z0, x0, 0, z0, x0, 0, z1, x0, height, z1, 0.9);
      if (!solid(x + 1, z)) push(x1, height, z1, x1, 0, z1, x1, 0, z0, x1, height, z0, 0.9);
      if (!solid(x, z - 1)) push(x1, height, z0, x1, 0, z0, x0, 0, z0, x0, height, z0, 0.8);
      if (!solid(x, z + 1)) push(x0, height, z1, x0, 0, z1, x1, 0, z1, x1, height, z1, 0.8);
    }
    if (quads === 0) return;
    // make sure the sampled texel is opaque: use a 1x1 white texture instead of clouds.png
    const white = createTexture(gl, null, { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) });
    this.cloudTex = white;
    const vao = gl.createVertexArray()!, vbo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 32, 20);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIbo);
    gl.bindVertexArray(null);
    this.cloudVao = vao; this.cloudVbo = vbo; this.cloudQuads = Math.min(quads, MAX_QUADS);
  }
}

const IDENTITY = mat4Identity(new Float32Array(16));

function mat4RotateZ(m: Mat4, rad: number): void {
  const c = Math.cos(rad), s = Math.sin(rad);
  const a0 = m[0], a1 = m[1], a4 = m[4], a5 = m[5];
  m[0] = a0 * c + a4 * s; m[1] = a1 * c + a5 * s; m[4] = a0 * -s + a4 * c; m[5] = a1 * -s + a5 * c;
}
