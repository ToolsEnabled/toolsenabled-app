/* Home circle -- THE OPTICS OF THE BODY.
 *
 * GLSL chunks (strings) plus the uniform descriptors that feed them, for the
 * rich-scheme body renderer in home-circle-fluid.js. This module owns six terms
 * and nothing else: refraction, thickness profile, environment reflection,
 * Fresnel, caustic and surface irregularity. It draws no frame, runs no solve
 * and touches no CSS. The render lane imports it once and calls opticsShade()
 * once for a body pixel (and opticsGroundLight() once for a ground pixel).
 *
 * Every term is a function of the body's OWN field -- the ink it laid down,
 * the thickness built from that ink, the normal built from that thickness.
 * None of them exists where there is no body and none would look identical
 * over a different shape. That is the standing test against a "gloss layer".
 *
 * Conventions the chunks assume (STANDARD-RENDER-20260918.md section 1):
 *   - colours are LINEAR light; decode sRGB once at the edge (opticsLinear()),
 *     encode once at the end. The illuminant may exceed 1.0.
 *   - GLSL ES 1.00 (WebGL1): texture2D, no dynamic loops, no `in`/`out`.
 *   - the eye looks straight at the face: eye = (0, 0, 1). n.z = 1 is flat-on.
 *   - n.xy points OUTWARD from the mass (height falls toward the rim), which
 *     is what the host's finite-difference normal already produces.
 *   - uv is the canvas uv the host samples its own textures with.
 *
 * Nothing here declares `precision`; the host header does that.
 */

/* ------------------------------------------------------------------------ */
/* PRELUDE: the small helpers every other chunk leans on.                    */
/* ------------------------------------------------------------------------ */
export const OPTICS_PRELUDE = [
  'const vec3 OPTICS_EYE = vec3(0.0, 0.0, 1.0);',
  'float opticsLuma (vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }',
  /* Integer-free hash so it runs on GLSL ES 1.00 without bit ops. Deterministic
     per input, so the skin below is the same skin every frame at the same
     body-local point. */
  'float opticsHash (vec2 p) {',
  '  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));',
  '  q += dot(q, q.yzx + 33.33);',
  '  return fract((q.x + q.y) * q.z);',
  '}',
  /* Value noise with a smooth (Hermite) blend, returning the value in .z and
     its analytic gradient in .xy -- the gradient is what a surface normal
     needs, and finite-differencing noise would cost four more hashes. */
  'vec3 opticsNoise (vec2 p) {',
  '  vec2 i = floor(p), f = fract(p);',
  '  vec2 u = f * f * (3.0 - 2.0 * f);',
  '  vec2 du = 6.0 * f * (1.0 - f);',
  '  float a = opticsHash(i), b = opticsHash(i + vec2(1.0, 0.0));',
  '  float c = opticsHash(i + vec2(0.0, 1.0)), d = opticsHash(i + vec2(1.0, 1.0));',
  '  float k0 = a, k1 = b - a, k2 = c - a, k3 = a - b - c + d;',
  '  float v = k0 + k1 * u.x + k2 * u.y + k3 * u.x * u.y;',
  '  vec2 g = du * vec2(k1 + k3 * u.y, k2 + k3 * u.x);',
  '  return vec3(g, v);',
  '}',
  'vec3 opticsLinear (vec3 srgb) {',
  '  vec3 lo = srgb / 12.92;',
  '  vec3 hi = pow((srgb + 0.055) / 1.055, vec3(2.4));',
  '  return mix(lo, hi, step(0.04045, srgb));',
  '}',
  'vec3 opticsEncode (vec3 lin) {',
  '  vec3 lo = lin * 12.92;',
  '  vec3 hi = 1.055 * pow(max(lin, 0.0), vec3(1.0 / 2.4)) - 0.055;',
  '  return mix(lo, hi, step(0.0031308, lin));',
  '}'
].join('\n');

/* ------------------------------------------------------------------------ */
/* 1. THICKNESS PROFILE.                                                     */
/* A gummy is a 3D form: deep through the middle, thin at the edge. For a    */
/* body defined by a field, thickness is a function of how far inside the    */
/* silhouette you are, and the ink the source laid down is exactly that.     */
/* The dome law is a quarter circle in the normalised ink: the thickness     */
/* rises steeply from zero at the rim and flattens over the mass, which is   */
/* the profile of a drop sitting on a plate and not of a cone.               */
/*                                                                           */
/* Beer-Lambert over that thickness inverts the shipped look: the light      */
/* travelling through the thin rim is barely absorbed, so the rim is BRIGHT  */
/* and PALE (near the illuminant, low chroma); the mass absorbs hard, so the */
/* core is DEEP and SATURATED. Luminance rises toward the rim, chroma falls. */
/* ------------------------------------------------------------------------ */
export const OPTICS_THICKNESS = [
  'uniform vec3 uOpticsThick; // ink at which the body is thinnest, ink at which it is fully thick, fatness of the edge',
  'uniform vec2 uOpticsPath;  // optical path per unit thickness, and the path the thinnest rim still has',
  /* Superellipse profile: fatness 2 is a hemisphere; higher keeps the body
     thick right up to a fast roll-off at the rim, which is the rounded-cube
     edge of the reference gummy rather than a lens that thins from the middle. */
  'float opticsThickness (float ink) {',
  '  float t = clamp((ink - uOpticsThick.x) / max(uOpticsThick.y - uOpticsThick.x, 0.001), 0.0, 1.0);',
  '  float s = 1.0 - t, k = max(uOpticsThick.z, 1.0);',
  '  return pow(max(1.0 - pow(s, k), 0.0), 1.0 / k);',
  '}',
  'float opticsPath (float thick) {',
  '  return uOpticsPath.y + thick * uOpticsPath.x;',
  '}',
  /* The surface normal OF THAT PROFILE, from the host's four neighbour ink
     taps. The raw ink is a gaussian whose tail flattens toward the rim, so a
     normal built straight from it turns hardest mid-body and lies down again
     at the edge -- the opposite of a rounded solid. The thickness profile
     turns hardest exactly at the rim, so every optical term (refraction,
     Fresnel, reflection, skin) reads the same surface the colour does.
     Returns the UNNORMALISED slope; add opticsSkin() to .xy, then normalize. */
  'uniform float uOpticsNormalGain; // slope per unit thickness change across one uv',
  'vec3 opticsSlope (float iL, float iR, float iB, float iT, vec2 texel) {',
  '  vec2 g = vec2(opticsThickness(iL) - opticsThickness(iR), opticsThickness(iB) - opticsThickness(iT)) / (2.0 * texel);',
  '  return vec3(g * uOpticsNormalGain, 1.0);',
  '}',
  /* Per-channel transmittance over the path. absorb is -log(deep / light) per
     channel (opticsAbsorbFromStops below), so path 1 lands exactly on the deep
     stop and path 0 on the illuminant. */
  'vec3 opticsTransmit (vec3 absorb, float thick) {',
  '  return exp(-absorb * opticsPath(thick));',
  '}'
].join('\n');

/* ------------------------------------------------------------------------ */
/* 2. REFRACTION.                                                            */
/* The identifying feature of a transparent solid: the background seen       */
/* through it is displaced, magnified and bent -- strongly near the rim      */
/* where the surface turns away, weakly through the middle where it is       */
/* flat-on. The ray from the eye is refracted by Snell at the body's own     */
/* normal, travels the body's own thickness, and lands on the backdrop at    */
/* an offset. A flat normal gives zero offset; a turned one gives an offset  */
/* that grows with the turn. A little dispersion (R, G, B landing at         */
/* slightly different offsets) is the cheap signature of a thick sweet.      */
/*                                                                           */
/* uOpticsBackdropOn = 1: uOpticsBackdrop faithfully holds what is behind    */
/*   the canvas; opticsShade then returns full coverage and REPLACES it.     */
/* uOpticsBackdropOn = 0: no texture; a procedural lit ground (a bright,     */
/*   structured disc, which is what transparency needs behind it) is used    */
/*   instead and can be drawn behind the body by the same shader.            */
/* ------------------------------------------------------------------------ */
export const OPTICS_REFRACTION = [
  'uniform sampler2D uOpticsBackdrop; uniform float uOpticsBackdropOn;',
  'uniform vec4 uOpticsRefract;   // index of refraction, displacement scale (uv per unit thickness), dispersion, rim thickness floor',
  'uniform vec3 uOpticsGround;    // procedural ground colour, linear',
  'uniform vec3 uOpticsGroundLit; // procedural lit-disc colour, linear',
  'uniform vec4 uOpticsGroundAt;  // lit disc centre (uv), radius (uv), stripe frequency (structure behind the body)',
  'vec3 opticsGround (vec2 uv) {',
  '  vec2 d = uv - uOpticsGroundAt.xy;',
  '  float disc = 1.0 - smoothstep(uOpticsGroundAt.z * 0.6, uOpticsGroundAt.z, length(d));',
  '  float stripes = 0.5 + 0.5 * sin((d.x + d.y) * uOpticsGroundAt.w);',
  '  vec3 lit = mix(uOpticsGroundLit * 0.82, uOpticsGroundLit, stripes);',
  '  return mix(uOpticsGround, lit, disc);',
  '}',
  'vec3 opticsBackdrop (vec2 uv) {',
  '  vec3 tex = texture2D(uOpticsBackdrop, clamp(uv, 0.0, 1.0)).rgb;',
  '  return mix(opticsGround(uv), tex, step(0.5, uOpticsBackdropOn));',
  '}',
  /* Where the refracted ray lands, relative to the pixel: the refracted
     direction's lateral run over the distance travelled. The travel is the
     body's thickness plus a rim floor -- a gummy has a fat edge, not a knife
     edge, so the last band still has material to bend through, and that is
     where the surface turns hardest. A flat-on normal gives exactly zero. */
  'vec2 opticsRefractOffset (vec3 n, float thick) {',
  '  vec3 r = refract(vec3(0.0, 0.0, -1.0), normalize(n), 1.0 / max(uOpticsRefract.x, 1.0001));',
  '  float travel = thick + uOpticsRefract.w;',
  '  return r.xy / max(-r.z, 0.2) * travel * uOpticsRefract.y;',
  '}',
  'vec3 opticsRefracted (vec2 uv, vec3 n, float thick) {',
  '  vec2 off = opticsRefractOffset(n, thick);',
  '  float disp = uOpticsRefract.z;',
  '  float r = opticsBackdrop(uv + off * (1.0 - disp)).r;',
  '  float g = opticsBackdrop(uv + off).g;',
  '  float b = opticsBackdrop(uv + off * (1.0 + disp)).b;',
  '  return vec3(r, g, b);',
  '}'
].join('\n');

/* ------------------------------------------------------------------------ */
/* 3. ENVIRONMENT REFLECTION.                                                */
/* A single sub-pixel dot is the signature of plastic. A real sweet reflects */
/* its whole surround: a broad soft gradient across the turning surface      */
/* (bright above, dim below), plus one or two small sharp catches from the   */
/* lights themselves. This is a tiny procedural environment sampled by the   */
/* reflected eye ray, so it is entirely a function of the body's normal and  */
/* moves and breaks with the body.                                           */
/* ------------------------------------------------------------------------ */
export const OPTICS_ENVIRONMENT = [
  'uniform vec3 uOpticsEnvSky;     // radiance above the horizon, linear',
  'uniform vec3 uOpticsEnvHorizon; // radiance at the horizon, linear',
  'uniform vec3 uOpticsEnvGround;  // radiance below the horizon, linear',
  'uniform vec4 uOpticsEnvKey;     // softbox direction (xyz, normalised on upload) and where its soft edge starts (dot threshold)',
  'uniform vec4 uOpticsEnvCatch;   // hot-core direction (xyz) and its tightness (dot threshold)',
  'uniform vec4 uOpticsEnvLevels;  // softbox radiance, hot-core radiance, horizontal stretch of both, fill (mirrored, dimmer) softbox radiance',
  'vec3 opticsEnvironment (vec3 d) {',
  '  float up = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);',
  /* THE HORIZON HAD A KNEE IN IT, AND THE KNEE WAS THE DECAL'S STRAIGHT EDGE.
     This was two smoothsteps butted together at up = 0.5 -- smoothstep(0, 0.5)
     into the horizon, smoothstep(0.5, 1) out of it. Both are flat at 0.5, so
     the pair is continuous in value but its SLOPE reverses there, and a slope
     reversal in a reflected environment draws a line on the body. up is
     d.y * 0.5 + 0.5, so up = 0.5 is d.y = 0: one horizontal contour straight
     across the dome, which is the dead-straight horizontal bottom edge the
     owner has been looking at. Nothing about the body is straight; the
     straightness was entirely this seam.
     A quadratic Bezier over the same three radiances has no knee anywhere --
     it is the de Casteljau double-mix, smooth in every derivative -- and it
     keeps both ends exactly: ground at up = 0, sky at up = 1, with the
     horizon pulling the middle. The environment still darkens downward, it
     just no longer does it along a line. */
  '  vec3 env = mix(mix(uOpticsEnvGround, uOpticsEnvHorizon, up), mix(uOpticsEnvHorizon, uOpticsEnvSky, up), up);',
  /* The softbox: a wide, soft-edged bar of light, stretched sideways like a
     strip light. Its reflection is the broad pale band across the top of the
     reference gummy. Inside it sits the hot core: the same light seen
     directly, hard-edged and many times brighter. A dimmer mirror of the
     softbox on the other side is the fill. */
  '  vec3 dd = normalize(d * vec3(1.0 / max(uOpticsEnvLevels.z, 0.05), 1.0, 1.0));',
  '  vec3 kd = normalize(uOpticsEnvKey.xyz);',
  '  float soft = smoothstep(uOpticsEnvKey.w, min(uOpticsEnvKey.w + 0.18, 1.0), dot(dd, kd));',
  '  float fill = smoothstep(uOpticsEnvKey.w, min(uOpticsEnvKey.w + 0.18, 1.0), dot(dd, kd * vec3(-1.0, 1.0, 1.0)));',
  '  float hot = smoothstep(uOpticsEnvCatch.w, 1.0, dot(dd, normalize(uOpticsEnvCatch.xyz)));',
  '  env += vec3(1.0) * (uOpticsEnvLevels.x * soft + uOpticsEnvLevels.w * fill + uOpticsEnvLevels.y * hot);',
  '  return env;',
  '}',
  'vec3 opticsReflection (vec3 n) {',
  '  return opticsEnvironment(reflect(-OPTICS_EYE, normalize(n)));',
  '}'
].join('\n');

/* ------------------------------------------------------------------------ */
/* 4. FRESNEL.                                                               */
/* How much of the environment the surface actually mirrors. Schlick from    */
/* the material's own index: face-on a gelatin reflects ~3%, at grazing it   */
/* reflects everything, which is what makes the silhouette bright and        */
/* glassy rather than a soft fade. 1 - n.z is largest exactly where the      */
/* body's own surface rolls over into its rim, and zero across the flat      */
/* interior, so this cannot exist off the body.                              */
/* ------------------------------------------------------------------------ */
export const OPTICS_FRESNEL = [
  'uniform vec3 uOpticsFresnel; // rim gain, rim falloff exponent, grazing bias (keeps the outermost pixels mirror-like)',
  'float opticsFresnel (vec3 n) {',
  '  float ior = max(uOpticsRefract.x, 1.0001);',
  '  float f0 = (ior - 1.0) / (ior + 1.0); f0 *= f0;',
  '  float c = clamp(dot(normalize(n), OPTICS_EYE), 0.0, 1.0);',
  '  float s = 1.0 - c;',
  '  float s2 = s * s;',
  '  return f0 + (1.0 - f0) * s2 * s2 * s;',
  '}',
  /* The silhouette term on top of Schlick: at the last band the normal the
     field gives is never fully sideways (a finite-difference normal on a
     smooth field cannot be), so the grazing term is biased up there by
     how far the surface has turned. Cut by coverage so it lives inside. */
  'float opticsRim (vec3 n, float coverage) {',
  '  float turn = 1.0 - clamp(normalize(n).z, 0.0, 1.0);',
  '  return uOpticsFresnel.x * pow(turn + uOpticsFresnel.z * turn * (1.0 - turn), uOpticsFresnel.y) * coverage;',
  '}'
].join('\n');

/* ------------------------------------------------------------------------ */
/* 5. CAUSTIC.                                                               */
/* Light focused through the body brightens the ground behind and below it.  */
/* This is the term that proves to the eye that light went THROUGH rather    */
/* than around. A ground pixel receives the light that passed through the    */
/* body point up-light of it -- so the host samples its own field at         */
/* opticsCausticTap(uv) and hands the thickness there to opticsCaustic().    */
/* The patch carries the body's transmitted colour (the mint ground under    */
/* the reference gummy goes ORANGE, not white), and it is strongest where    */
/* the lens is thick enough to gather light yet thin enough to pass it.      */
/* An inner caustic is provided too: the far flank of the lens from the      */
/* light, where the converged light lands inside the mass.                   */
/* ------------------------------------------------------------------------ */
export const OPTICS_CAUSTIC = [
  'uniform vec3 uOpticsLightDir; // the one illuminant direction (normalised on upload); z toward the eye',
  'uniform vec4 uOpticsCaustic;  // ground caustic strength, its path fraction, its shift (uv), inner caustic strength',
  'vec2 opticsCausticTap (vec2 uv) {',
  '  return uv + normalize(uOpticsLightDir).xy * uOpticsCaustic.z;',
  '}',
  /* Ground pixel: illum * transmittance through the tapped thickness, gated
     by (1 - coverage here) so nothing is added under the body itself. The
     thick * (1 - thick) shape is the lens gathering: zero at the rim (no
     lens), zero at the flat core (no convergence), peaked between. */
  'vec3 opticsCaustic (vec3 illum, vec3 absorb, float thickTap, float coverHere) {',
  '  float gather = 4.0 * thickTap * (1.0 - thickTap);',
  '  vec3 through = illum * exp(-absorb * opticsPath(thickTap) * uOpticsCaustic.y);',
  '  return through * uOpticsCaustic.x * gather * (1.0 - coverHere);',
  '}',
  /* Inner caustic: the curvature of the body's own height field says where
     it converges; the flank facing away from the light is where that light
     lands. lap is the height Laplacian from the host's four neighbour taps
     (negative is convergence). */
  'vec3 opticsInnerCaustic (vec3 illum, vec3 absorb, float lap, vec3 n, float thick) {',
  '  vec3 l = normalize(uOpticsLightDir);',
  '  float focus = max(0.0, -lap) * smoothstep(-0.15, 0.55, -dot(normalize(n).xy, l.xy));',
  '  return illum * uOpticsCaustic.w * focus * exp(-absorb * opticsPath(thick) * uOpticsCaustic.y);',
  '}'
].join('\n');

/* ------------------------------------------------------------------------ */
/* 6. SURFACE IRREGULARITY.                                                  */
/* A mathematically perfect surface is the most CG-plastic thing you can     */
/* draw. Real gelatin has a faintly uneven, slightly wet skin. Two octaves   */
/* of value noise in BODY-LOCAL coordinates, so the unevenness travels with  */
/* the body; its amplitude rides the slope the surface already has, because  */
/* a skin is an unevenness OF a surface and a flat field has nothing to be   */
/* uneven. Returns a perturbation to add to the normal's xy before the       */
/* normal is normalised.                                                     */
/* ------------------------------------------------------------------------ */
export const OPTICS_SKIN = [
  'uniform vec3 uOpticsSkin; // amplitude, frequency (cycles per uv), slow drift phase',
  'vec2 opticsSkin (vec2 bodyLocal, vec3 slope) {',
  '  vec2 p = bodyLocal * uOpticsSkin.y + uOpticsSkin.z;',
  '  vec3 n1 = opticsNoise(p);',
  '  vec3 n2 = opticsNoise(p * 2.13 + 7.31);',
  '  vec2 g = n1.xy + 0.5 * n2.xy;',
  '  return g * uOpticsSkin.x * clamp(length(slope.xy), 0.0, 1.0);',
  '}'
].join('\n');

/* ------------------------------------------------------------------------ */
/* THE ONE CALL SITE.                                                        */
/* Body pixel -> premultiplied radiance and coverage. Terms in the order the  */
/* light takes: what is behind the body arrives refracted and absorbed over  */
/* the body's thickness; the illuminant arrives from behind through the same */
/* thickness (the backlight that makes the thin rim bright); the environment */
/* is mirrored by the surface with Fresnel weight; the inner caustic is the  */
/* light the lens converged. The host supplies its own ink, normal (already  */
/* perturbed with opticsSkin if wanted), coverage, absorber and illuminant.  */
/*                                                                           */
/* When the backdrop texture is authoritative the result REPLACES what is    */
/* behind the canvas (alpha = coverage). When it is the procedural ground,   */
/* alpha is still coverage, and the host draws opticsGround(uv) behind the   */
/* body -- opticsGroundLight() returns that ground plus the caustic.         */
/* ------------------------------------------------------------------------ */
export const OPTICS_SHADE = [
  'uniform vec2 uOpticsMix; // how much of the refracted backdrop the body shows, how much backlight it sends',
  'vec4 opticsShade (vec2 uv, float ink, vec3 n, float coverage, vec3 absorb, vec3 illum, float lap) {',
  '  float thick = opticsThickness(ink);',
  '  vec3 T = opticsTransmit(absorb, thick);',
  '  vec3 behind = opticsRefracted(uv, n, thick) * T * uOpticsMix.x;',
  '  vec3 back = illum * T * uOpticsMix.y;',
  '  float F = opticsFresnel(n);',
  '  vec3 mirror = opticsReflection(n) * F;',
  '  float rim = opticsRim(n, coverage);',
  '  vec3 inner = opticsInnerCaustic(illum, absorb, lap, n, thick);',
  '  vec3 radiance = (behind + back) * (1.0 - F) + mirror + inner + illum * T * rim;',
  '  return vec4(radiance * coverage, coverage);',
  '}',
  /* Ground pixel (coverage ~ 0): the ground itself, if procedural, plus the
     caustic the body throws on it. thickTap is opticsThickness(ink sampled at
     opticsCausticTap(uv)). With an authoritative backdrop the ground part is
     zero and only the caustic is added, premultiplied over the page. */
  'vec4 opticsGroundLight (vec2 uv, float thickTap, float coverHere, vec3 absorb, vec3 illum) {',
  '  vec3 ground = opticsGround(uv) * (1.0 - step(0.5, uOpticsBackdropOn));',
  '  vec3 caust = opticsCaustic(illum, absorb, thickTap, coverHere);',
  '  float a = (1.0 - step(0.5, uOpticsBackdropOn)) * (1.0 - coverHere);',
  '  return vec4(ground * a + caust, a);',
  '}'
].join('\n');

/* Every chunk, in dependency order. Paste this once above main(). */
export const OPTICS_GLSL = [
  OPTICS_PRELUDE, OPTICS_THICKNESS, OPTICS_REFRACTION, OPTICS_ENVIRONMENT,
  OPTICS_FRESNEL, OPTICS_CAUSTIC, OPTICS_SKIN, OPTICS_SHADE
].join('\n');

/* ------------------------------------------------------------------------ */
/* UNIFORM DESCRIPTORS. One per uniform the chunks declare: name, GLSL type, */
/* default value (linear light where it is a colour), and what it means.     */
/* Defaults are the values proven in .lane-scratch/optics against the        */
/* owner's reference; the render lane may retune any of them.                */
/* ------------------------------------------------------------------------ */
const u = (name, type, value, doc) => Object.freeze({ name, type, value: Object.freeze(value), doc });

export const OPTICS_UNIFORMS = Object.freeze({
  thickness: Object.freeze([
    u('uOpticsThick', 'vec3', [0.05, 0.9, 5.0], 'Ink at the silhouette and at full thickness, followed by body shape. The silhouette uses the host edge ink; slope is zero outside coverage. Shape 2 is a hemisphere; shape 5 is a flat plateau with a bevelled rim.'),
    u('uOpticsPath', 'vec2', [0.6, 0.1], 'optical path per unit thickness, and the path the thinnest rim still has'),
    u('uOpticsNormalGain', 'float', [0.25], 'slope per unit thickness change across one uv (sets how far the rim turns)')
  ]),
  refraction: Object.freeze([
    u('uOpticsBackdrop', 'sampler2D', [0], 'texture unit holding what is behind the canvas'),
    u('uOpticsBackdropOn', 'float', [0], '1 when uOpticsBackdrop is authoritative, 0 for the procedural ground'),
    u('uOpticsRefract', 'vec4', [1.42, 0.08, 0.06, 0.5], 'index of refraction, displacement scale (uv per unit travel), dispersion, rim travel floor (thickness units)'),
    u('uOpticsGround', 'vec3', [0.010, 0.011, 0.013], 'procedural ground colour, linear'),
    u('uOpticsGroundLit', 'vec3', [0.52, 0.80, 0.42], 'procedural lit-disc colour, linear (the reference mint)'),
    u('uOpticsGroundAt', 'vec4', [0.5, 0.5, 0.42, 160.0], 'lit disc centre uv, radius uv, stripe frequency')
  ]),
  environment: Object.freeze([
    u('uOpticsEnvSky', 'vec3', [1.2, 1.25, 1.4], 'radiance above the horizon, linear (a dim studio; reflected at ~3% face-on)'),
    u('uOpticsEnvHorizon', 'vec3', [0.6, 0.6, 0.66], 'radiance at the horizon, linear'),
    u('uOpticsEnvGround', 'vec3', [0.08, 0.08, 0.08], 'radiance below the horizon, linear'),
    u('uOpticsEnvKey', 'vec4', [0.0, 0.60, 0.80, 0.92], 'softbox direction xyz, where its soft edge starts (dot threshold)'),
    u('uOpticsEnvCatch', 'vec4', [-0.04, 0.62, 0.78, 0.992], 'hot-core direction xyz, tightness (dot threshold)'),
    u('uOpticsEnvLevels', 'vec4', [14.0, 60.0, 6.0, 3.0], 'softbox radiance, hot-core radiance (a lamp: tens of times the sky), horizontal stretch, fill softbox radiance')
  ]),
  fresnel: Object.freeze([
    u('uOpticsFresnel', 'vec3', [1.6, 2.2, 1.2], 'rim gain, rim falloff exponent, grazing bias')
  ]),
  caustic: Object.freeze([
    u('uOpticsLightDir', 'vec3', [-0.45, 0.65, 0.62], 'the one illuminant direction; z toward the eye'),
    u('uOpticsCaustic', 'vec4', [0.7, 2.5, 0.035, 18.0], 'ground caustic strength, path fraction, shift (uv), inner caustic strength')
  ]),
  skin: Object.freeze([
    u('uOpticsSkin', 'vec3', [0.09, 7.0, 0.0], 'amplitude, frequency (cycles per uv), drift phase')
  ]),
  shade: Object.freeze([
    u('uOpticsMix', 'vec2', [1.0, 0.2], 'share of the refracted backdrop shown, share of the backlight sent')
  ])
});

export const OPTICS_ALL_UNIFORMS = Object.freeze(Object.values(OPTICS_UNIFORMS).flat());

/* Fresh, mutable copy of every default, keyed by uniform name. */
export function opticsDefaults() {
  const out = {};
  for (const d of OPTICS_ALL_UNIFORMS) out[d.name] = d.value.slice();
  return out;
}

/* Per-channel absorption that carries `light` to `deep` over one unit of
   optical path: exp(-k) = deep / light. Both in linear light. Clamped so a
   channel already near zero cannot produce an infinite coefficient. */
export function opticsAbsorbFromStops(light, deep) {
  return [0, 1, 2].map(i => Math.max(0, Math.min(8, -Math.log(Math.max(1e-3, deep[i]) / Math.max(1e-3, light[i])))));
}

/* A DYE, not a gradient. -log(deep/light) (above) makes the dominant channel
   absorb too -- the ledger's deep stop is a darker red, so red is eaten along
   with green and blue and the mass goes brown-mauve over a green ground. A
   real red gummy's dye passes red almost losslessly and eats the rest; the
   deep core is still bright red, just with no green or blue left in it. This
   derives that spectrum from ONE stop: the dominant channel absorbs zero, the
   others absorb in proportion to how far below it they sit. `density` is the
   total optical strength (how quickly the off-hue channels go). Hue is
   untouched: the ratios between the absorbed channels are the stop's own. */
export function opticsAbsorbFromDye(stopLinear, density, body) {
  const top = Math.max(stopLinear[0], stopLinear[1], stopLinear[2], 1e-3);
  const k = density === undefined ? 1 : density;
  /* `body` (0..1) is how much the dominant channel is absorbed too, as a
     fraction of the strongest off-hue absorption: 0 is a pure filter (a red
     gummy over a white ground is as bright as the ground), a little gives the
     thick core real depth without changing the hue. */
  const b = body === undefined ? 0.25 : body;
  const off = [0, 1, 2].map(i => Math.min(8, -Math.log(Math.max(1e-3, stopLinear[i]) / top)));
  const strongest = Math.max(off[0], off[1], off[2]);
  return off.map(o => (o + b * strongest) * k);
}

/* Upload every descriptor present in `locations` (a name -> WebGLUniformLocation
   map, as the host's program builder already produces). Samplers are given
   the texture unit number. Directions are normalised here so the chunks can
   assume unit vectors where they need them. */
export function uploadOptics(gl, locations, values) {
  const v = values || opticsDefaults();
  for (const d of OPTICS_ALL_UNIFORMS) {
    const loc = locations && locations[d.name];
    if (!loc) continue;
    let x = v[d.name] !== undefined ? v[d.name] : d.value;
    if (d.name === 'uOpticsLightDir') x = unit3(x);
    if (d.name === 'uOpticsEnvKey' || d.name === 'uOpticsEnvCatch') x = unit3(x.slice(0, 3)).concat([x[3]]);
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

function unit3(a) {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
}
