// A self-contained WebGL2 globe: one full-screen triangle, the fragment shader ray-casts a unit
// sphere, rotates the hit point into world space and samples an equirectangular Sentinel-2 texture.
// No map library and no tile server, so the first frame paints as soon as the 15 KB texture lands.
//
//   const globe = createGlobe(canvas);          // null when WebGL2 is unavailable
//   globe.setTexture(image);                    // any time; the 2k image replaces the 512 px one
//   globe.render(lon0, lat0);                   // radians: the point facing the viewer
//   globe.resize(cssSize, dpr); globe.dispose();
//
// project() is the same rotation on the CPU, for the overlay (arcs, dots, cards) to line up.

/** Globe radius as a fraction of the half-size of the stage (matches the old MapLibre fit: 37 % of width). */
export const RADIUS = 0.74;

const VERT = `#version 300 es
in vec2 p;
out vec2 v;
void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v;
out vec4 o;
uniform sampler2D tex;
uniform float R;      // globe radius in clip units
uniform float px;     // one device pixel in unit-sphere units (edge antialiasing)
uniform vec2 rot;     // (lon0, lat0) in radians
const float PI = 3.14159265359;
const vec3 L = normalize(vec3(-0.55, 0.45, 0.72));   // light from upper left, in front
const vec3 ATMO = vec3(0.36, 0.62, 1.0);

void main() {
  vec2 q = v / R;
  float d = length(q);

  // soft atmosphere outside the limb
  float halo = exp(-(d - 1.0) * 8.0) * 0.5 * step(1.0, d);

  if (d >= 1.0 + px) { o = vec4(ATMO * halo, halo); return; }

  vec3 n = vec3(q, sqrt(max(0.0, 1.0 - d * d)));
  // view -> world: undo the tilt (lat0) then the spin (lon0)
  float ca = cos(rot.y), sa = sin(rot.y);
  float y1 = n.y * ca + n.z * sa;
  float z1 = -n.y * sa + n.z * ca;
  float co = cos(rot.x), so = sin(rot.x);
  float x2 = n.x * co + z1 * so;
  float z2 = -n.x * so + z1 * co;
  float lat = asin(clamp(y1, -1.0, 1.0));
  float lon = atan(x2, z2);

  // Tarini's seam fix: pick whichever u is continuous here, so mip selection never jumps at +-180.
  float uA = fract(lon / (2.0 * PI) + 0.5);
  float uB = fract(lon / (2.0 * PI)) - 0.5;
  float u = fwidth(uA) <= fwidth(uB) + 1e-6 ? uA : uB;
  vec3 col = texture(tex, vec2(u, 0.5 - lat / PI)).rgb;

  // lighting: soft terminator, gentle specular on the oceans, fresnel rim
  float diff = max(dot(n, L), 0.0);
  col *= 0.38 + 0.78 * diff;
  float spec = pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 70.0);
  col += vec3(1.0, 0.96, 0.9) * spec * 0.10;
  float rim = pow(1.0 - n.z, 2.6);
  col = mix(col, ATMO, rim * 0.6);

  // antialiased edge blending into the halo
  float a = clamp((1.0 - d) / px, 0.0, 1.0);
  o = vec4(col * a + ATMO * halo * (1.0 - a), max(a, halo));
}`;

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
  return s;
}

export function createGlobe(canvas) {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false, alpha: true });
  if (!gl) return null;
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
  } catch (e) {
    console.warn('[globe] WebGL program failed, using the CSS globe:', e.message);
    return null;
  }
  gl.useProgram(prog);

  // one oversized triangle covers the viewport
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u = name => gl.getUniformLocation(prog, name);
  const uR = u('R'), uPx = u('px'), uRot = u('rot');
  gl.uniform1f(uR, RADIUS);

  const tex = gl.createTexture();
  let hasTex = false, size = 0;

  const api = {
    setTexture(img) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      hasTex = true;
    },
    resize(cssSize, dpr) {
      size = Math.round(cssSize * dpr);
      canvas.width = canvas.height = size;
      gl.viewport(0, 0, size, size);
      // one device pixel, measured in unit-sphere radii
      gl.uniform1f(uPx, 2 / (size * RADIUS));
    },
    render(lon0, lat0) {
      if (!hasTex || !size) return;
      gl.uniform2f(uRot, lon0, lat0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    get ready() { return hasTex; },
    dispose() {
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
  return api;
}

/** World (lon, lat radians) -> view space on the unit sphere, for a globe facing (lon0, lat0).
 *  x right, y up, z toward the viewer; z > 0 means the point is on the visible face. */
export function project(lon, lat, lon0, lat0) {
  const cl = Math.cos(lat);
  const x = cl * Math.sin(lon), y = Math.sin(lat), z = cl * Math.cos(lon);
  const c0 = Math.cos(lon0), s0 = Math.sin(lon0);
  const x1 = x * c0 - z * s0, z1 = x * s0 + z * c0;
  const ca = Math.cos(lat0), sa = Math.sin(lat0);
  return { x: x1, y: y * ca - z1 * sa, z: y * sa + z1 * ca };
}
