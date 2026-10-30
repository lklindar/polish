// WebGL2 compositor shared by the preview (main thread, <video> source) and export (worker,
// VideoFrame source). One full-screen pass:
//  - outside the window: the source as-is (background / padding stay put);
//  - inside the (rounded) window: the zoomed viewport, with optional motion blur along the
//    camera's velocity;
//  - the webcam bubble: redrawn unzoomed on top, at its normal size;
//  - click ripples, then the caption overlay (a 2D canvas uploaded as a texture).

import type { Camera } from '../core/zoom';
import type { Circle, Rect } from '../core/layout';

export interface FrameState {
  camera: Camera;
  /** Camera velocity in viewport px per output frame, for motion blur (0,0 = none). */
  blur: { x: number; y: number };
  content: Rect;
  radius: number;
  webcam: Circle | null;
  /** Ripples in source px, progress 0–1. */
  ripples: { x: number; y: number; p: number }[];
}

const VS = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D src;
uniform sampler2D overlay;
uniform bool hasOverlay;
uniform vec2 srcSize;      // source px
uniform vec4 content;      // x, y, w, h (source px)
uniform float radius;
uniform vec4 view;         // viewport x, y, w, h (source px)
uniform vec3 cam;          // webcam x, y, r (r = 0 → none)
uniform vec2 blur;         // source px per frame
uniform vec3 ripples[4];   // x, y, progress (progress < 0 → off)
uniform float zoomed;      // scale > 1.001

float roundedBox(vec2 p, vec4 r, float rad) {
  vec2 c = r.xy + r.zw * 0.5;
  vec2 q = abs(p - c) - r.zw * 0.5 + rad;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}

vec3 sampleSrc(vec2 p) { return texture(src, p / srcSize).rgb; }

// Inside the zoomed picture, the webcam bubble would show up magnified behind the real one. What's
// under it was never recorded, so extend the surrounding content radially from the bubble edge.
vec3 sampleZoomed(vec2 q) {
  if (cam.z > 0.0) {
    vec2 d = q - cam.xy;
    float r = length(d);
    float edge = cam.z * 1.06;
    if (r < edge) q = cam.xy + (r > 0.001 ? d / r : vec2(1.0, 0.0)) * edge;
  }
  return sampleSrc(q);
}

void main() {
  vec2 p = uv * srcSize;
  vec3 base = sampleSrc(p);
  vec3 col = base;
  if (zoomed > 0.5) {
    float d = roundedBox(p, content, radius);
    float inside = clamp(0.5 - d, 0.0, 1.0);
    if (inside > 0.0) {
      vec2 q = view.xy + (p - content.xy) * (view.zw / content.zw);
      vec3 z;
      if (length(blur) > 0.75) {
        z = vec3(0.0);
        for (int i = 0; i < 8; i++) {
          float k = float(i) / 7.0 - 0.5;
          z += sampleZoomed(q + blur * k);
        }
        z /= 8.0;
      } else {
        z = sampleZoomed(q);
      }
      col = mix(base, z, inside);
    }
    if (cam.z > 0.0) {
      float dc = length(p - cam.xy) - cam.z;
      col = mix(col, base, clamp(0.5 - dc, 0.0, 1.0));
    }
  }
  for (int i = 0; i < 4; i++) {
    vec3 r = ripples[i];
    if (r.z < 0.0) continue;
    float rad = mix(8.0, 46.0, r.z) * srcSize.y / 1080.0;
    float ring = abs(length(p - r.xy) - rad);
    float a = (1.0 - r.z) * 0.55 * smoothstep(5.0 * srcSize.y / 1080.0, 0.0, ring);
    float fill = (1.0 - r.z) * 0.18 * step(length(p - r.xy), rad);
    col = mix(col, vec3(1.0), clamp(a + fill, 0.0, 1.0));
  }
  if (hasOverlay) {
    vec4 o = texture(overlay, uv);
    col = mix(col, o.rgb / max(o.a, 1e-4), o.a);
  }
  color = vec4(col, 1.0);
}`;

type GL = WebGL2RenderingContext;

export class Compositor {
  private gl: GL;
  private prog: WebGLProgram;
  private srcTex: WebGLTexture;
  private ovTex: WebGLTexture;
  private u: Record<string, WebGLUniformLocation | null> = {};

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true }) as GL | null;
    if (!gl) throw new Error('WebGL2 is not available.');
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    this.prog = p;
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.srcTex = tex();
    this.ovTex = tex();
    for (const n of ['src', 'overlay', 'hasOverlay', 'srcSize', 'content', 'radius', 'view', 'cam', 'blur', 'ripples', 'zoomed']) {
      this.u[n] = gl.getUniformLocation(p, n);
    }
    gl.uniform1i(this.u.src, 0);
    gl.uniform1i(this.u.overlay, 1);
  }

  /**
   * Draws one output frame. `srcW/srcH` is the source size the FrameState is expressed in;
   * the canvas may be any size (export resolution).
   */
  render(source: TexImageSource, srcW: number, srcH: number, s: FrameState, overlay: TexImageSource | null) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.ovTex);
    if (overlay) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, overlay);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    gl.uniform1i(this.u.hasOverlay, overlay ? 1 : 0);
    gl.uniform2f(this.u.srcSize, srcW, srcH);
    const c = s.content;
    gl.uniform4f(this.u.content, c.x, c.y, c.w, c.h);
    gl.uniform1f(this.u.radius, s.radius);
    const vw = c.w / s.camera.scale;
    const vh = c.h / s.camera.scale;
    gl.uniform4f(this.u.view, s.camera.cx - vw / 2, s.camera.cy - vh / 2, vw, vh);
    gl.uniform3f(this.u.cam, s.webcam?.x ?? 0, s.webcam?.y ?? 0, s.webcam?.r ?? 0);
    gl.uniform2f(this.u.blur, s.blur.x, s.blur.y);
    const rp = new Float32Array(12).fill(-1);
    s.ripples.slice(0, 4).forEach((r, i) => rp.set([r.x, r.y, r.p], i * 3));
    gl.uniform3fv(this.u.ripples, rp);
    gl.uniform1f(this.u.zoomed, s.camera.scale > 1.001 ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
