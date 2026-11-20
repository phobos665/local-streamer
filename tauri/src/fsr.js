// WebGL2 renderer for the capture feed, used whenever the plain <video> element
// isn't enough: cropping, a forced aspect ratio, sharp / integer scaling, or FSR.
// main.js supplies a layout function (which part of the frame, and where on the
// canvas) and picks a filter:
//   linear  - bilinear, one pass.
//   nearest - nearest-neighbour ("sharp pixels"), one pass. Integer scaling is
//             nearest with a layout that uses a whole number of pixels per line.
//   fsr     - FSR 1 (AMD FidelityFX Super Resolution 1.0), two passes:
//             EASU edge-adaptive upscale from the crop to the on-screen size
//             (plain bilinear when the window is smaller), then RCAS robust
//             contrast-adaptive sharpening at output resolution.
//             Port of the algorithm in ffx_fsr1.h (MIT, AMD), written for texelFetch.
// Renders once per new video frame (requestVideoFrameCallback), so it adds no
// queueing; the GPU cost at 1440p is a fraction of a millisecond.

const VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Single pass from the crop to the output rectangle, bilinear or nearest.
const SIMPLE = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_texSize; // whole video frame
uniform vec2 u_inOff;   // crop origin (texels, from the top left)
uniform vec2 u_inSize;  // crop size
uniform vec2 u_outSize; // output rectangle size
uniform vec2 u_offset;  // output rectangle origin in window coordinates (bottom left)
uniform int u_nearest;
out vec4 o;

void main() {
  vec2 op = vec2(gl_FragCoord.x - u_offset.x, u_outSize.y - (gl_FragCoord.y - u_offset.y));
  vec2 sp = u_inOff + op * (u_inSize / u_outSize);
  if (u_nearest == 1) {
    ivec2 lo = ivec2(u_inOff);
    o = vec4(texelFetch(u_src, clamp(ivec2(floor(sp)), lo, lo + ivec2(u_inSize) - 1), 0).rgb, 1.0);
  } else {
    sp = clamp(sp, u_inOff + 0.5, u_inOff + u_inSize - 0.5); // no bleed from outside the crop
    o = vec4(texture(u_src, sp / u_texSize).rgb, 1.0);
  }
}`;

const EASU = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_texSize;
uniform vec2 u_inOff;
uniform vec2 u_inSize;
uniform vec2 u_outSize;
uniform int u_mode; // 0 = bilinear, 1 = EASU
out vec4 o;

vec3 T(ivec2 p) {
  ivec2 lo = ivec2(u_inOff);
  return texelFetch(u_src, clamp(p, lo, lo + ivec2(u_inSize) - 1), 0).rgb;
}
float Lu(vec3 c) { return c.g + 0.5 * (c.r + c.b); }

void setF(inout vec2 dir, inout float len, float w,
          float lA, float lB, float lC, float lD, float lE) {
  float dx = lD - lB;
  float lx = clamp(abs(dx) / max(max(abs(lD - lC), abs(lC - lB)), 1e-5), 0.0, 1.0);
  float dy = lE - lA;
  float ly = clamp(abs(dy) / max(max(abs(lE - lC), abs(lC - lA)), 1e-5), 0.0, 1.0);
  dir += vec2(dx, dy) * w;
  len += (lx * lx + ly * ly) * w;
}

void tap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2,
         float lob, float clp, vec3 c) {
  vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x))) * len2;
  float d2 = min(dot(v, v), clp);
  float wB = 0.4 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = 1.5625 * wB - 0.5625;
  float w = wB * wA;
  aC += c * w;
  aW += w;
}

void main() {
  // Output pixel centre, top-down (video texture row 0 is the top of the image).
  vec2 op = vec2(gl_FragCoord.x, u_outSize.y - gl_FragCoord.y);
  if (u_mode == 0) {
    vec2 sp = clamp(u_inOff + op * (u_inSize / u_outSize), u_inOff + 0.5, u_inOff + u_inSize - 0.5);
    o = vec4(texture(u_src, sp / u_texSize).rgb, 1.0);
    return;
  }
  vec2 pp = u_inOff + op * (u_inSize / u_outSize) - 0.5;
  vec2 fp = floor(pp);
  vec2 f = pp - fp;
  ivec2 i = ivec2(fp);
  //      b c
  //    e f g h
  //    i j k l
  //      n o
  vec3 bC = T(i + ivec2(0, -1)), cC = T(i + ivec2(1, -1));
  vec3 eC = T(i + ivec2(-1, 0)), fC = T(i), gC = T(i + ivec2(1, 0)), hC = T(i + ivec2(2, 0));
  vec3 iC = T(i + ivec2(-1, 1)), jC = T(i + ivec2(0, 1)), kC = T(i + ivec2(1, 1)), lC = T(i + ivec2(2, 1));
  vec3 nC = T(i + ivec2(0, 2)), oC = T(i + ivec2(1, 2));
  float bL = Lu(bC), cL = Lu(cC), eL = Lu(eC), fL = Lu(fC), gL = Lu(gC), hL = Lu(hC);
  float iL = Lu(iC), jL = Lu(jC), kL = Lu(kC), lL = Lu(lC), nL = Lu(nC), oL = Lu(oC);

  vec2 dir = vec2(0.0);
  float len = 0.0;
  setF(dir, len, (1.0 - f.x) * (1.0 - f.y), bL, eL, fL, gL, jL);
  setF(dir, len, f.x * (1.0 - f.y), cL, fL, gL, hL, kL);
  setF(dir, len, (1.0 - f.x) * f.y, fL, iL, jL, kL, nL);
  setF(dir, len, f.x * f.y, gL, jL, kL, lL, oL);

  float dirR = dot(dir, dir);
  bool zro = dirR < 1.0 / 32768.0;
  dirR = zro ? 1.0 : inversesqrt(dirR);
  dir.x = zro ? 1.0 : dir.x;
  dir *= dirR;
  len *= 0.5;
  len *= len;
  float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  float clp = 1.0 / lob;

  vec3 aC = vec3(0.0);
  float aW = 0.0;
  tap(aC, aW, vec2( 0.0, -1.0) - f, dir, len2, lob, clp, bC);
  tap(aC, aW, vec2( 1.0, -1.0) - f, dir, len2, lob, clp, cC);
  tap(aC, aW, vec2(-1.0,  1.0) - f, dir, len2, lob, clp, iC);
  tap(aC, aW, vec2( 0.0,  1.0) - f, dir, len2, lob, clp, jC);
  tap(aC, aW, vec2( 0.0,  0.0) - f, dir, len2, lob, clp, fC);
  tap(aC, aW, vec2(-1.0,  0.0) - f, dir, len2, lob, clp, eC);
  tap(aC, aW, vec2( 1.0,  1.0) - f, dir, len2, lob, clp, kC);
  tap(aC, aW, vec2( 2.0,  1.0) - f, dir, len2, lob, clp, lC);
  tap(aC, aW, vec2( 2.0,  0.0) - f, dir, len2, lob, clp, hC);
  tap(aC, aW, vec2( 1.0,  0.0) - f, dir, len2, lob, clp, gC);
  tap(aC, aW, vec2( 1.0,  2.0) - f, dir, len2, lob, clp, oC);
  tap(aC, aW, vec2( 0.0,  2.0) - f, dir, len2, lob, clp, nC);

  // De-ring: clamp to the 2x2 neighbourhood.
  vec3 mn = min(min(fC, gC), min(jC, kC));
  vec3 mx = max(max(fC, gC), max(jC, kC));
  o = vec4(clamp(aC / aW, mn, mx), 1.0);
}`;

const RCAS = `#version 300 es
precision highp float;
uniform sampler2D u_img;
uniform ivec2 u_size;
uniform vec2 u_offset;
uniform float u_sharp; // exp2(-stops)
out vec4 o;

vec3 S(ivec2 p) { return texelFetch(u_img, clamp(p, ivec2(0), u_size - 1), 0).rgb; }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy - u_offset);
  //    b
  //  d e f
  //    h
  vec3 b = S(p + ivec2(0, 1)), d = S(p + ivec2(-1, 0)), e = S(p);
  vec3 f = S(p + ivec2(1, 0)), h = S(p + ivec2(0, -1));
  vec3 mn4 = min(min(b, d), min(f, h));
  vec3 mx4 = max(max(b, d), max(f, h));
  vec3 hitMin = min(mn4, e) / max(4.0 * mx4, 1e-5);
  vec3 hitMax = (1.0 - max(mx4, e)) / min(4.0 * mn4 - 4.0, -1e-5);
  vec3 lobeRGB = max(-hitMin, hitMax);
  float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * u_sharp;
  o = vec4((lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0), 1.0);
}`;

function compile(gl, vsSrc, fsSrc) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vsSrc], [gl.FRAGMENT_SHADER, fsSrc]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(prog, s);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const u = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(prog, i).name;
    u[name] = gl.getUniformLocation(prog, name);
  }
  return { prog, u };
}

/** Default layout: whole frame, fitted and centred. */
function fitLayout(vw, vh, cw, ch) {
  const s = Math.min(cw / vw, ch / vh);
  const w = Math.max(1, Math.round(vw * s));
  const h = Math.max(1, Math.round(vh * s));
  return {
    crop: { x: 0, y: 0, w: vw, h: vh },
    dest: { x: Math.floor((cw - w) / 2), y: Math.floor((ch - h) / 2), w, h },
  };
}

export class VideoRenderer {
  constructor(canvas, video, onStatus = () => {}) {
    this.canvas = canvas;
    this.video = video;
    this.onStatus = onStatus;
    this.enabled = false;
    this.filter = "linear";
    this.layout = fitLayout;
    this.sharp = Math.pow(2, -0.4);
    this.frameHandle = 0;
    this.lastStatus = "";

    const gl = canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: false, stencil: false,
      desynchronized: true, // low-latency canvas path
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.simple = compile(gl, VERT, SIMPLE);
    this.easu = compile(gl, VERT, EASU);
    this.rcas = compile(gl, VERT, RCAS);
    gl.bindVertexArray(gl.createVertexArray());

    this.srcTex = this.#makeTex(gl.LINEAR);
    this.midTex = this.#makeTex(gl.NEAREST);
    this.fbo = gl.createFramebuffer();
    this.midW = 0;
    this.midH = 0;

    new ResizeObserver(() => this.#resize()).observe(canvas);
    this.#resize();
  }

  #makeTex(filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  #resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.enabled) this.#draw();
  }

  /**
   * filter: "linear" | "nearest" | "fsr".
   * layout(videoW, videoH, canvasW, canvasH) -> { crop, dest, note? } in device
   * pixels; crop is part of the video frame, dest the rectangle on the canvas
   * (both {x, y, w, h}, measured from the top left).
   */
  configure({ filter, layout }) {
    if (filter) this.filter = filter;
    if (layout) this.layout = layout;
    if (this.enabled) this.#draw();
  }

  /** 0..100 -> RCAS stops 2..0 (100 = strongest). */
  setSharpness(percent) {
    this.sharp = Math.pow(2, -((100 - percent) / 50));
    if (this.enabled) this.#draw();
  }

  /** Safe to call repeatedly, e.g. after the video source changes. */
  setEnabled(on) {
    this.enabled = on;
    this.canvas.hidden = !on;
    if (this.frameHandle) this.video.cancelVideoFrameCallback?.(this.frameHandle);
    this.frameHandle = 0;
    if (on) {
      this.#schedule();
      this.#draw();
    } else {
      this.lastStatus = "";
      this.onStatus("");
    }
  }

  #schedule() {
    if (!this.enabled) return;
    this.frameHandle = this.video.requestVideoFrameCallback(() => {
      this.#draw();
      this.#schedule();
    });
  }

  #draw() {
    const { gl, video } = this;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const { crop, dest, note } = this.layout(vw, vh, cw, ch);
    const ow = Math.max(1, Math.round(dest.w));
    const oh = Math.max(1, Math.round(dest.h));
    const ox = Math.round(dest.x);
    const oy = ch - Math.round(dest.y) - oh; // GL viewports count from the bottom

    // Upload the current video frame (GPU-to-GPU copy in Chromium).
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let status;
    if (this.filter === "fsr") status = this.#drawFsr(vw, vh, crop, ow, oh, ox, oy);
    else {
      gl.viewport(ox, oy, ow, oh);
      const p = this.simple;
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.uniform1i(p.u.u_src, 0);
      gl.uniform2f(p.u.u_texSize, vw, vh);
      gl.uniform2f(p.u.u_inOff, crop.x, crop.y);
      gl.uniform2f(p.u.u_inSize, crop.w, crop.h);
      gl.uniform2f(p.u.u_outSize, ow, oh);
      gl.uniform2f(p.u.u_offset, ox, oy);
      gl.uniform1i(p.u.u_nearest, this.filter === "nearest" ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      status = `${this.filter === "nearest" ? "Sharp" : "Smooth"}: ${crop.w}x${crop.h} -> ${ow}x${oh}`;
    }
    if (note) status += ` (${note})`;
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.onStatus(status);
    }
  }

  #drawFsr(vw, vh, crop, ow, oh, ox, oy) {
    const { gl } = this;
    const upscaling = ow > crop.w || oh > crop.h;

    // Pass 1 -> intermediate texture at output size.
    if (this.midW !== ow || this.midH !== oh) {
      gl.bindTexture(gl.TEXTURE_2D, this.midTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ow, oh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.midTex, 0);
      this.midW = ow;
      this.midH = oh;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, ow, oh);
    gl.useProgram(this.easu.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(this.easu.u.u_src, 0);
    gl.uniform2f(this.easu.u.u_texSize, vw, vh);
    gl.uniform2f(this.easu.u.u_inOff, crop.x, crop.y);
    gl.uniform2f(this.easu.u.u_inSize, crop.w, crop.h);
    gl.uniform2f(this.easu.u.u_outSize, ow, oh);
    gl.uniform1i(this.easu.u.u_mode, upscaling ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 2 -> screen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(ox, oy, ow, oh);
    gl.useProgram(this.rcas.prog);
    gl.bindTexture(gl.TEXTURE_2D, this.midTex);
    gl.uniform1i(this.rcas.u.u_img, 0);
    gl.uniform2i(this.rcas.u.u_size, ow, oh);
    gl.uniform2f(this.rcas.u.u_offset, ox, oy);
    gl.uniform1f(this.rcas.u.u_sharp, this.sharp);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    return upscaling
      ? `FSR: ${crop.w}x${crop.h} -> ${ow}x${oh} (${(ow / crop.w).toFixed(2)}x upscale + sharpen)`
      : `FSR: window is not larger than ${crop.w}x${crop.h} - sharpening only`;
  }
}
