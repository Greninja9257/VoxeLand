// WebGL2 helpers.
export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string, name = 'program'): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${name} shader compile error: ${gl.getShaderInfoLog(s)}\n${src}`);
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name} link error: ${gl.getProgramInfoLog(p)}`);
  return p;
}

export class Program {
  prog: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null> = {};
  constructor(public gl: WebGL2RenderingContext, vs: string, fs: string, uniformNames: string[], name?: string) {
    this.prog = createProgram(gl, vs, fs, name);
    for (const u of uniformNames) this.uniforms[u] = gl.getUniformLocation(this.prog, u);
  }
  use(): void { this.gl.useProgram(this.prog); }
  u(name: string): WebGLUniformLocation | null { return this.uniforms[name]; }
}

export function createTexture(gl: WebGL2RenderingContext, source: TexImageSource | null, opts: { nearest?: boolean; mipmap?: boolean; repeat?: boolean; width?: number; height?: number; data?: ArrayBufferView | null } = {}): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  if (source) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, opts.width ?? 1, opts.height ?? 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, opts.data ?? null);
  const filt = opts.nearest !== false ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.mipmap ? gl.NEAREST_MIPMAP_LINEAR : filt);
  const wrap = opts.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (opts.mipmap) gl.generateMipmap(gl.TEXTURE_2D);
  return tex;
}

/** Build alpha-weighted mip levels for an RGBA8 image (keeps 16px-aligned atlas tiles separate for 4 levels). */
export function buildMips(data: Uint8Array, width: number, height: number, levels: number): { data: Uint8Array; width: number; height: number }[] {
  const out: { data: Uint8Array; width: number; height: number }[] = [{ data, width, height }];
  let src = data, w = width, h = height;
  for (let l = 1; l <= levels; l++) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const dst = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = ((y * 2 + dy) * w + (x * 2 + dx)) * 4;
        const al = src[i + 3];
        if (al > 0) { r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; n++; }
      }
      const o = (y * nw + x) * 4;
      if (a > 0) { dst[o] = r / a; dst[o + 1] = g / a; dst[o + 2] = b / a; dst[o + 3] = a / 4; }
    }
    out.push({ data: dst, width: nw, height: nh });
    src = dst; w = nw; h = nh;
  }
  return out;
}

export function imageToData(img: ImageBitmap | HTMLImageElement, w = img.width, h = img.height): ImageData {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}
