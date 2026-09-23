/* Home circle -- THE IN-CANVAS BACKDROP the body refracts.
 *
 * The fluid canvas is composited by the browser over the page, so the shader
 * can never sample what the page draws behind it: page content shows through
 * by alpha only and can never be bent. Anything the body is to REFRACT has to
 * be drawn inside the canvas first. This module is that first pass: a lit
 * ground disc, structural rings, and the thin dye (trails, ring pulses, mist)
 * that the solve already carries, rendered to a texture the display pass then
 * samples through home-circle-optics.js (`uOpticsBackdrop`, `uOpticsBackdropOn = 1`).
 *
 * Offered take-it-or-leave-it to the body lane. Two ways in:
 *   - GLSL only: paste BACKDROP_GLSL into your own program and call
 *     backdropShade(uv, thin, thinColour) per pixel; upload with uploadBackdrop().
 *   - the whole pass: createBackdropPass(gl, { size }) compiles its own program,
 *     owns a texture + framebuffer, and draw(values, dye) fills it. Bind
 *     pass.texture as uOpticsBackdrop.
 *
 * Conventions: linear light in and out; GLSL ES 1.00; uv is the canvas uv; the
 * canvas is the ring's face (a disc), so outside uBackdropDisc.z the pass writes
 * alpha 0 and the page still shows there. Nothing here declares precision.
 */

export const BACKDROP_GLSL = [
  'uniform vec3 uBackdropGround;     // the theme ground at the disc edge, linear',
  'uniform vec3 uBackdropLift;       // the lit centre of the disc, linear (brighter than the ground on dark themes; a tint on light ones)',
  'uniform vec4 uBackdropDisc;       // disc centre uv, radius uv, edge softness uv',
  'uniform vec3 uBackdropLightDir;   // the one illuminant direction; the ground is lit from it (a soft gradient, off-centre)',
  'uniform vec4 uBackdropRingA;      // structural ring: radius uv, half-width uv, strength, softness uv',
  'uniform vec4 uBackdropRingB;      // second structural ring, same layout',
  'uniform vec3 uBackdropRingColour; // the structure colour (the theme accent at its structural step), linear',
  'uniform vec3 uBackdropGrain;      // fine structure on the ground: amplitude, frequency (cycles per uv), drift',
  'uniform vec3 uBackdropThinColour; // what thin dye (trails, pulses, mist) is drawn with, linear',
  'uniform vec3 uBackdropThin;       // ink at which dye stops being thin and becomes the body; gain on the thin dye (the host mist scalar belongs here); the thin-fluid rate',
  /* A lit disc. The ground colour at the edge, the lift at the centre, and the
     centre pushed toward the light so it reads as lit from somewhere rather
     than glowing on its own. */
  'vec3 backdropGround (vec2 uv) {',
  '  vec2 d = uv - uBackdropDisc.xy;',
  '  vec2 toLight = normalize(uBackdropLightDir.xy + vec2(0.0001));',
  '  float r = length(d) / max(uBackdropDisc.z, 0.001);',
  '  float lit = 1.0 - smoothstep(0.15, 1.05, r + 0.22 * dot(normalize(d + vec2(0.0001)), -toLight) * r);',
  '  vec3 ground = mix(uBackdropGround, uBackdropLift, lit * lit);',
  /* Fine structure so a displacement is visible even over the flat part of
     the ground: a soft two-way weave, a few percent, at a frequency well
     above the body's bevel width. Zero amplitude turns it off. */
  '  float w = sin((d.x + 0.31 * d.y) * uBackdropGrain.y + uBackdropGrain.z) * sin((d.y - 0.27 * d.x) * uBackdropGrain.y * 1.13 - uBackdropGrain.z);',
  '  return ground * (1.0 + uBackdropGrain.x * w);',
  '}',
  /* A structural ring: an analytic stroke with a soft edge in uv, so it is
     crisp at any DPR and gives the refraction a real edge to bend. */
  'float backdropRing (vec2 uv, vec4 ring) {',
  '  float r = length(uv - uBackdropDisc.xy);',
  '  float band = abs(r - ring.x) - ring.y;',
  '  return ring.z * (1.0 - smoothstep(0.0, max(ring.w, 0.0005), band));',
  '}',
  /* Coverage of the disc itself: 1 inside, 0 outside, soft over the stated
     edge. Outside the disc the page shows through unchanged. */
  'float backdropCoverage (vec2 uv) {',
  '  float r = length(uv - uBackdropDisc.xy);',
  '  return 1.0 - smoothstep(uBackdropDisc.z - uBackdropDisc.w, uBackdropDisc.z, r);',
  '}',
  /* The whole backdrop, premultiplied: ground + rings + thin dye, cut by the
     disc. `thin` is the host\'s thin-dye amount (0 if it keeps drawing the
     mist itself); `thinColour` its colour. */
  'vec4 backdropShade (vec2 uv, float thin, vec3 thinColour) {',
  '  vec3 c = backdropGround(uv);',
  '  float rings = backdropRing(uv, uBackdropRingA) + backdropRing(uv, uBackdropRingB);',
  '  c = mix(c, uBackdropRingColour, clamp(rings, 0.0, 1.0));',
  '  c += thinColour * thin * uBackdropThin.y;',
  '  float a = backdropCoverage(uv);',
  '  return vec4(c * a, a);',
  '}',
  /* Thin dye from the host\'s own field: the thin-fluid law (1 - exp(-rate *
     ink), the same shape the host uses for mist) on everything below the body
     edge, cut just under the edge where the body\'s own coverage takes over.
     The gain is the host\'s mist scalar: with no mist the tails of the field
     are not drawn at all, exactly as the crisp body cuts them today. */
  'float backdropThin (float ink) {',
  '  float edge = max(uBackdropThin.x, 0.001);',
  '  return (1.0 - exp(-uBackdropThin.z * ink)) * (1.0 - smoothstep(edge * 0.8, edge, ink));',
  '}'
].join('\n');

/* The standalone pass program: samples an optional dye texture for the thin
   term and writes backdropShade. Host programs that already read the dye can
   ignore this and call backdropShade themselves. */
export const BACKDROP_PASS_FRAGMENT = [
  'varying vec2 vUv;',
  BACKDROP_GLSL,
  'uniform sampler2D uBackdropDye; uniform float uBackdropDyeOn;',
  'void main () {',
  '  vec2 dye = max(texture2D(uBackdropDye, vUv).xy, 0.0);',
  '  float thin = backdropThin(dye.x + dye.y) * step(0.5, uBackdropDyeOn);',
  '  gl_FragColor = backdropShade(vUv, thin, uBackdropThinColour);',
  '}'
].join('\n');

export const BACKDROP_PASS_VERTEX = 'attribute vec2 aPosition; varying vec2 vUv; void main () { vUv = aPosition * 0.5 + 0.5; gl_Position = vec4(aPosition, 0.0, 1.0); }';

const u = (name, type, value, doc) => Object.freeze({ name, type, value: Object.freeze(value), doc });

export const BACKDROP_UNIFORMS = Object.freeze([
  u('uBackdropGround', 'vec3', [0.012, 0.013, 0.016], 'theme ground at the disc edge, linear'),
  u('uBackdropLift', 'vec3', [0.21, 0.22, 0.24], 'lit centre of the disc, linear'),
  u('uBackdropDisc', 'vec4', [0.5, 0.5, 0.5, 0.01], 'disc centre uv, radius uv, edge softness uv'),
  u('uBackdropLightDir', 'vec3', [-0.45, 0.65, 0.62], 'the one illuminant direction'),
  u('uBackdropRingA', 'vec4', [0.43, 0.006, 0.85, 0.003], 'ring radius uv, half-width uv, strength, softness uv'),
  u('uBackdropRingB', 'vec4', [0.27, 0.005, 0.55, 0.003], 'second ring, same layout'),
  u('uBackdropRingColour', 'vec3', [0.012, 0.013, 0.016], 'structure colour, linear (dark on the plate; see backdropFromTheme)'),
  u('uBackdropGrain', 'vec3', [0.10, 90.0, 0.0], 'ground weave amplitude, frequency, drift'),
  u('uBackdropThinColour', 'vec3', [0.55, 0.11, 0.09], 'thin dye colour, linear'),
  u('uBackdropThin', 'vec3', [0.5, 0.0, 1.6], 'body edge in ink, thin dye gain (the mist scalar), thin-fluid rate'),
  u('uBackdropDye', 'sampler2D', [0], 'texture unit of the dye field (pass program only)'),
  u('uBackdropDyeOn', 'float', [0], '1 to draw the thin dye from uBackdropDye (pass program only)')
]);

export function backdropDefaults() {
  const out = {};
  for (const d of BACKDROP_UNIFORMS) out[d.name] = d.value.slice();
  return out;
}

/* Theme-derived values: the ground is the page background, the lift is the
   background moved toward the light by a stated amount (a lit plate on a dark
   theme, a faint tint on a light one), the structure is the accent. All
   inputs linear. `dark` decides which way the lift goes. */
export function backdropFromTheme({ ground, accent, dark, lift }) {
  const v = backdropDefaults();
  const k = lift === undefined ? (dark ? 0.2 : -0.05) : lift; // dark: a real lit plate (measured: below ~0.2 linear a red body over it reads opaque)
  v.uBackdropGround = ground.slice();
  v.uBackdropLift = ground.map(c => Math.max(0, Math.min(1, c + k + (dark ? 0.35 * c : 0))));
  /* The structural rings are DARK on the plate, never the accent: measured
     (.lane-scratch/optics/out/backdrop-lift-sweep.json), accent-red rings
     vanish through a red body because they converge with the plate in the
     one channel the dye passes, while dark structure keeps its contrast in
     every channel. On a dark theme that is the page ground itself; on a light
     theme a step below the plate. The thin dye keeps the body's own colour
     because it IS the body's material. */
  v.uBackdropRingColour = dark ? ground.slice() : v.uBackdropLift.map(c => Math.max(0, c - 0.18));
  v.uBackdropThinColour = accent.slice();
  return v;
}

export function uploadBackdrop(gl, locations, values) {
  const v = values || backdropDefaults();
  for (const d of BACKDROP_UNIFORMS) {
    const loc = locations && locations[d.name];
    if (!loc) continue;
    let x = v[d.name] !== undefined ? v[d.name] : d.value;
    if (d.name === 'uBackdropLightDir') { const n = Math.hypot(x[0], x[1], x[2]) || 1; x = [x[0] / n, x[1] / n, x[2] / n]; }
    switch (d.type) {
      case 'sampler2D': gl.uniform1i(loc, x[0] | 0); break;
      case 'float': gl.uniform1f(loc, x[0]); break;
      case 'vec2': gl.uniform2fv(loc, x); break;
      case 'vec3': gl.uniform3fv(loc, x); break;
      case 'vec4': gl.uniform4fv(loc, x); break;
      default: break;
    }
  }
}

/* The whole pass. Owns one RGBA8 texture + framebuffer at `size`, its own
   program and quad. draw(values, dyeTexture) renders the backdrop into the
   texture; bind pass.texture on a unit and hand that unit to uOpticsBackdrop.
   Nothing is allocated per frame; resize(size) reallocates only the target. */
export function createBackdropPass(gl, { size = 512, precision = 'mediump' } = {}) {
  const header = `precision ${precision} float;\nprecision ${precision} sampler2D;\n`;
  const compile = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('backdrop shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, BACKDROP_PASS_VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, header + BACKDROP_PASS_FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('backdrop program: ' + gl.getProgramInfoLog(program));
  const locations = {};
  for (const d of BACKDROP_UNIFORMS) locations[d.name] = gl.getUniformLocation(program, d.name);
  const aPosition = gl.getAttribLocation(program, 'aPosition');
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const texture = gl.createTexture();
  const fbo = gl.createFramebuffer();
  let width = 0;
  function resize(px) {
    width = px | 0;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, width, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  resize(size);

  function draw(values, dyeTexture) {
    const v = values || backdropDefaults();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, width);
    gl.disable(gl.BLEND);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
    if (dyeTexture) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dyeTexture); v.uBackdropDye = [0]; v.uBackdropDyeOn = [1]; }
    else v.uBackdropDyeOn = [0];
    uploadBackdrop(gl, locations, v);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function destroy() {
    gl.deleteFramebuffer(fbo); gl.deleteTexture(texture); gl.deleteBuffer(quad); gl.deleteProgram(program);
  }

  return { texture, fbo, program, locations, draw, resize, destroy, get size() { return width; } };
}
