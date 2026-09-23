// Dye sources inside the existing fluid solve. These are material shapes,
// not an overlay: velocity advects them, collisions compress them, and during
// an action transition ONE body of material travels from the old shape into
// the new one. See formMorph at the foot of this file for that law, and for
// why the previous law -- a dissolve of one field into the other -- could not
// be tuned into this one.
// GLSL ES 1.00 keeps the same implementation on WebGL 1 and WebGL 2.
//
// THE SHADER IS A LIST OF LINES, NOT ONE TEMPLATE LITERAL, and that is the
// same shape FRAGMENTS uses in src/home-circle-fluid.js. It matters for two
// reasons beyond matching its sibling. Prose about the shader is a real
// JavaScript comment here, so a backtick in that prose is a character rather
// than a parse error. And tools/check-plain-language.mjs reads a template
// literal as one long visible string, so the whole shader arrived at that gate
// as a single run of sentences and tripped its long-sentence rule ten times
// over. Per-line strings are read the way the sibling file's already are.
export const FLUID_FORMS = [
  'uniform vec4 uForm; // previous form, next form, transition, time',
  'uniform vec4 uBody; // centre x/y, compression axis, scale along that axis',
  'uniform float uBodyScale;',
  'uniform vec4 uParts[5]; // material centres and x/y radii',
  'uniform float uPartAngles[5];',
  'uniform vec4 uCharacter; // joined eyes, blink, breath, (reserved, held at 0)',
  'uniform vec4 uTool;     // outer band radius, inner band radius, outer sigma, inner sigma',
  'uniform vec4 uToolTurn; // outer turn, inner turn, core turn, how far the bands have opened',

  // THE JIGGLE. An axis-aligned, area-preserving squash of the whole body: x
  // is the scale across, y the scale up. Axis-aligned on purpose -- a scale
  // along the canvas axes cannot tilt the eye pair, which is the guarantee
  // 'no state can turn the eye pair' holds -- and area-preserving because a
  // squash whose axes move together is a zoom, not a squash. The renderer
  // rings it down as a damped spring after a bounce (seat.jig in
  // src/home-circle-fluid.js). (1, 1) is the identity.
  'uniform vec2 uJiggle;',
  'vec2 bodyLocal(vec2 uv) {',
  '  vec2 p = (uv - uBody.xy) / (uBodyScale * max(uJiggle, vec2(0.25)));',
  '  vec2 normal = vec2(cos(uBody.z), sin(uBody.z));',
  '  vec2 tangent = vec2(-normal.y, normal.x);',
  '  return normal * dot(p, normal) / uBody.w + tangent * dot(p, tangent) * uBody.w;',
  '}',

  // One band of the body's own water, lying on a circle around the body's
  // centre. count and duty are the SVG's stroke-dasharray read as a duty
  // cycle. track is the continuous ring the dashes ride on: .chat-orbit-track
  // in the same SVG, drawn under .chat-orbit-outer at every phase. It is what
  // stops a set of dashes reading as a set of separate marks.
  'float orbitBand(vec2 p, float r, float radius, float sigma, float turn, float count, float duty, float track) {',
  '  float s = (r - radius) / max(sigma, 0.0008);',
  '  float along = fract((atan(p.y, p.x) - turn) * count / 6.2831853);',
  '  float soft = min(0.24, duty * 0.5);',
  '  float arc = smoothstep(0.0, soft, along) * (1.0 - smoothstep(duty - soft, duty, along));',
  '  return exp(-s * s) * (track + (1.0 - track) * arc);',
  '}',

  // THE SITES TRAVEL, SO THE SOLID BODY NEVER HAS TO VANISH TO CHANGE SHAPE.
  //
  // The display pass in src/home-circle-fluid.js (jellyDist) draws the solid
  // body as a MIX OF THE TWO FORMS' DISTANCES sampled at the same point; it
  // does not run the journey morph below (formMorph), which it could not
  // afford at five taps. A distance mix is only a shape changing when the two
  // shapes stand in the same places. The eyes stand at +-0.066 and the four
  // writing droplets at +-0.0525 and +-0.1575, so half-way through that change
  // an eye's own centre was 1.25 sigma from any droplet and fell OUTSIDE the
  // body's 1.18 edge: filmed on the running page
  // (.lane-scratch/w7b/film-before), the pair shrank to slivers, a third mote
  // appeared between them, and the four droplets then grew from nothing.
  // Modelled the same way (.lane-scratch/w7b/neck-model2.mjs old), the body
  // kept 39% of its area at the half-way point.
  //
  // So for that pair the GEOMETRY itself makes the journey, and the two forms
  // agree about where the material is at every instant of it: the form that is
  // leaving slides its sites toward where the other's are, by the transition's
  // own progress, and the form that is arriving starts ON the other's sites
  // and slides home. Each eye lobe moves out to the midpoint of its two
  // droplets and widens to span them; each droplet starts inside its eye and
  // separates. Half-way, one stretched lobe per side; late, a peanut that
  // pinches into two. Same model, new law: the body holds 97-112% of the eyes'
  // area until the droplets part (neck-model2.mjs new). Nothing is added or
  // removed by this: at 0 and 1 the sites are exactly where they always were,
  // and it returns 0 -- rest layout -- for every pair but this one, so the
  // tool set and the thinking gather are untouched. The dye pass gets the same
  // travelling sites through fluidForm, so its journey and the solid body's
  // agree.
  'float formTravel(float kind) {',
  '  if (uForm.z <= 0.0 || uForm.z >= 1.0) return 0.0;',
  '  bool eyesToWriting = abs(uForm.x - 2.0) < 0.5 && abs(uForm.y - 3.0) < 0.5;',
  '  bool writingToEyes = abs(uForm.x - 3.0) < 0.5 && abs(uForm.y - 2.0) < 0.5;',
  '  if (!eyesToWriting && !writingToEyes) return 0.0;',
  '  if (abs(kind - uForm.x) < 0.5) return uForm.z;',
  '  if (abs(kind - uForm.y) < 0.5) return 1.0 - uForm.z;',
  '  return 0.0;',
  '}',

  'float fluidForm(vec2 p, float kind, float time) {',
  '  if (kind < 0.5) return 0.0;',

  // THE THINKING GATHER. A core with three pieces drawn out of it. Four
  // pieces, never five, and never a ring of satellites. See the tool form
  // below for why that shape is gone from this file entirely.
  '  if (kind < 1.5) {',
  '    float amount = 0.0;',
  '    for (int i = 0; i < 4; i++) {',
  '      if (uParts[i].z > 0.003) {',
  '        vec2 d = p - uParts[i].xy;',
  '        float c = cos(uPartAngles[i]), s = sin(uPartAngles[i]);',
  '        vec2 q = vec2(c * d.x + s * d.y, -s * d.x + c * d.y) / max(uParts[i].zw, vec2(0.003));',
  '        amount += exp(-dot(q, q));',
  '      }',
  '    }',
  '    return amount;',
  '  }',

  // THE BASE CHARACTER. The same material closes into a plump body, rests,
  // then opens back into eyes. A slightly broader lower half softens the
  // joined silhouette.
  //
  // NO ROTATION TERM HERE, AND THAT IS THE POINT. This block used to turn p by
  // uCharacter.w before scaling it. That swivelled the eye pair to the side,
  // and the owner reported it twice as creepy. Breath is uCharacter.z. It
  // scales the pose and does not rotate it.
  '  if (kind < 2.5) {',
  '    float together = uCharacter.x;',
  '    p /= uCharacter.z;',
  '    float spacing = mix(0.066, 0.0, together);',
  // THE MERGE HAS TO END ON A CIRCLE, and it used to end on an egg.
  // At together 1 the spacing is already 0, so the two lobes coincide and the
  // pair IS one lobe -- but one lobe of what shape was never checked. Width
  // ran to 0.078 against a height of 0.071, and the taper below took another
  // 9% off the top, so the settled pose measured about 1.10 wide for every 1.0
  // tall before the taper and read as an egg lying on its side. The owner
  // rejected exactly that: the merge must END AS ONE CIRCLE.
  // So the width's far end is the height's far end. Both are 0.071 at
  // together 1 and the merged lobe is a round disc by construction, at the
  // size the joined pair already had -- nothing else moves, because the NEAR
  // ends (0.032 and 0.064) are untouched and the open eye pair is what it was.
  '    float width = mix(0.032, 0.071, together);',
  '    float height = mix(0.064, 0.071, together) * (1.0 - 0.86 * uCharacter.y);',
  // PROMPT C -- A CLOSING EYE GETS WIDER, WHICH IS BOTH TRUE AND NECESSARY.
  // Closing only shrank the height, to 14% of it at full closure. In this
  // renderer that is about two dye texels tall, which is under what the grid
  // can draw: captured mid-squint, the eyes came out lumpy with ragged edges
  // and then as pointed wedges rather than as shut eyes. A lid that closes is
  // also a lid that spreads, so the width grows as the height goes, and the
  // shut eye is a wide flat lens instead of a sub-texel sliver. It is scaled
  // by uCharacter.y, so it is exactly zero whenever the eye is open and this
  // changes nothing about the resting face.
  '    width *= 1.0 + 0.55 * uCharacter.y;',
  // THE TAPER IS A TRANSITION EFFECT AND IT HAS TO LEAVE. It narrows the pose
  // toward the top, which is what gives the closing pair a head and a jaw --
  // but it was scaled by `together` alone, so it was at FULL strength exactly
  // where the pose is supposed to be a circle, and a 9% top-to-bottom taper on
  // a round lobe is an egg. 4t(1-t) is the same envelope `bridge` below
  // already uses for the same reason: zero at both ends, one in the middle, so
  // the taper is unchanged in the only place it was ever wanted -- mid-merge,
  // where a seam and a jaw are fine and expected -- and is exactly zero on the
  // settled pose. Peak strength is held at the 0.09 it had.
  '    width *= 1.0 - 0.09 * (4.0 * together * (1.0 - together)) * clamp(p.y / height, -1.0, 1.0);',
  // The journey to writing (formTravel above): each lobe slides out to the
  // midpoint of its two droplets, 0.105 in body units (p is already divided
  // by the breath here, so the target is too), and widens to span them.
  // Horizontal only, so the pair cannot turn; zero whenever the pair is at
  // rest, so the settled face is exactly what it was.
  '    float travel = formTravel(kind);',
  '    spacing = mix(spacing, 0.105 / uCharacter.z, travel);',
  '    width *= 1.0 + 1.1 * travel;',
  // Preserve the crease between the approaching eyes. At full closure
  // spacing and taper vanish, so this same field becomes one round disc.
  // The bridge exists only during the merge; open eyes remain separate.
  '    vec2 q = vec2((abs(p.x) - spacing) / width, p.y / height);',
  '    float bridge = 4.0 * together * (1.0 - together) * 0.6 * exp(-p.x * p.x / ((spacing + 0.6 * width) * (spacing + 0.6 * width)) - p.y * p.y / (height * height));',
  '    return (exp(-dot(q, q)) + bridge) * mix(1.0, 0.92, together);',
  '  }',

  // WRITING. Four droplets rising and falling in a staggered wave. This is the
  // chat window's own writing tell carried into material, so the two surfaces
  // read as the same language. See chat-writing-wave in src/chat-activity.css:
  // scaleY .55 to 1 with opacity .55 to 1, each bar delayed behind the last.
  '  if (kind < 3.5) {',
  '    float amount = 0.0;',
  // The journey from the eyes (formTravel above): each droplet starts inside
  // the eye on its own side -- the pair's live spacing, in body units -- at
  // something nearer the eye's size, and separates out to its home as the
  // change completes. The wave is held flat until it has arrived.
  '    float travel = formTravel(kind);',
  '    float site = mix(0.066, 0.0, uCharacter.x) * uCharacter.z;',
  '    for (int i = 0; i < 4; i++) {',
  '      float beat = pow(max(0.0, sin(time * 5.2 - float(i) * 0.85)), 2.0);',
  '      float radius = (0.025 + 0.006 * beat) * (1.0 + 0.8 * travel);',
  '      float home = (float(i) - 1.5) * 0.105;',
  '      vec2 q = p - vec2(mix(home, sign(home) * site, travel), 0.022 * beat * (1.0 - travel));',
  '      q /= vec2(radius * (1.0 - 0.24 * beat), radius * (1.0 + 0.62 * beat));',
  '      amount += exp(-dot(q, q)) * (0.55 + 0.85 * beat);',
  '    }',
  // THE FOUR DOTS ARE SEPARATE BY DESIGN, AND THAT IS NOT A DEFECT TO FIX.
  //
  // Measured: the homes are 0.105 apart against a radius of 0.025, so
  // neighbours sit 4.2 sigma from each other and the field at the midpoint
  // between two of them reaches 0.024, against the 0.249 the silhouette is
  // drawn at. They never touch at any point in the beat.
  //
  // A bar of material was summed along the line of the four here to join
  // them into one body with four bumps, on the reading that never touching
  // meant broken. The owner rejected it on sight -- "big regression in the
  // writing animation. they are not supposed to be connected" -- and the
  // 4th writing dot is itself an owner-requested feature (T259 item 1). The
  // separation IS the shape. The bar is gone; this is 22def14b's four
  // discrete droplets, unchanged.
  //
  // The measurement was right and the inference was wrong, and a field
  // measurement cannot tell "these are not connected" from "these are
  // broken". The four-pieces complaint this was meant to answer was about
  // the TRANSITIONS into and out of writing, which jellyDist's field union
  // handles; the destination shape was never in scope.
  '    return amount;',
  '  }',

  // TOOL USE, and this is the shape that replaced the five spinning dots.
  //
  // It was a loop of five over uParts: a core with four satellites orbiting
  // it. The owner reported the five dots three separate times. Five gaussian
  // lobes arranged on a circle read as five dots however they are spaced, so
  // the loop is gone rather than retuned.
  //
  // What stands in its place is the chat window's own tool-use language,
  // rendered as material instead of strokes.
  //   .chat-orbit-outer  r=16 in src/chat-presentation.css, and
  //                      stroke-dasharray 8 17 in the working phase in
  //                      src/chat-activity.css, so four arcs on the outer band
  //   .chat-orbit-inner  r=10, stroke-dasharray 12 19.4, reverse, so two arcs
  //                      on the inner band, turning back the other way
  //   .chat-orbit-track  the continuous ring both bands ride on
  //   .chat-orbit-core   the body's remaining water, breathing
  //
  // Every part of it is a band of THIS body's water, centred on the body. p is
  // already body-local, so the whole set travels with the blob and never sits
  // on the canvas. The bands are drawn out of the core as uToolTurn.w opens,
  // so nothing is added and nothing appears from nowhere. The arc counts and
  // duty cycles come from the dasharrays above. They are not free numbers.
  '  if (kind < 4.5) {',
  '    float r = length(p);',
  '    float open = uToolTurn.w;',
  // The core keeps its own breath in the two radii of uParts[0]. It turns
  // against both bands, which is the chat set's core against its two rings.
  '    float c = cos(uToolTurn.z), s = sin(uToolTurn.z);',
  '    vec2 d = p - uParts[0].xy;',
  '    vec2 q = vec2(c * d.x + s * d.y, -s * d.x + c * d.y) / max(uParts[0].zw, vec2(0.003));',
  '    float amount = exp(-dot(q, q));',
  '    if (open > 0.002 && r > 0.0005) {',
  '      amount += open * orbitBand(p, r, uTool.x, uTool.z, uToolTurn.x, 4.0, 8.0 / 25.0, 0.5);',
  '      amount += open * 0.82 * orbitBand(p, r, uTool.y, uTool.w, uToolTurn.y, 2.0, 12.0 / 31.4, 0.5);',
  '    }',
  '    return amount;',
  '  }',

  '  return 0.0;',
  '}',

  // THE TRANSITION. ONE BODY MOVES; NOTHING FADES INTO ANYTHING.
  //
  // WHAT WAS HERE AND WHY NO CONSTANT COULD FIX IT. fluidInk used to return
  // one form's field, and the dye pass in src/home-circle-fluid.js mixed two
  // calls of it:
  //   dye += mix(fluidInk(local, uForm.x, ..), fluidInk(local, uForm.y, ..), uForm.z)
  // That is a cross-fade. The two forms are sampled AT THE SAME POINT while
  // describing material in DIFFERENT PLACES, so at every instant of it the old
  // shape and the new one are both standing in their own places at partial
  // strength with a join between them -- and the join is not a side effect of
  // the easing, it is what a mix of two shapes IS. Measured on the shipped
  // shader before this change, through the middle of a real 0.8 s blend with
  // the real piece layout: in an eyes-to-writing change the eye region and the
  // droplet region were lit together at 0.38 of peak, and in writing-to-tool
  // at 0.47, while the body's strongest point fell to 0.62 of the line between
  // its own two ends. In a tool-to-eyes change the two orbit bands stood
  // exactly where they were and dimmed. That is the owner's seam.
  //
  // WHAT REPLACES IT IS A JOURNEY, NOT A DIFFERENT EASING. Real jelly moves
  // its material: a neck forms, thins, pinches and snaps, and the pieces
  // arrive somewhere. So before the two forms are compared at all, each piece
  // of material is asked where it is going:
  //
  //   1. Read a form as a DISTANCE rather than a brightness. -log of a sum of
  //      gaussians is the smooth minimum of their squared distances, so the
  //      field this file already builds is a soft distance field for free, and
  //      sqrt of it is an ordinary distance in body units (formRange).
  //   2. One Newton step down that distance lands on the form's NEAREST lobe,
  //      so (step onto the new form) - (step onto the old one) is the journey
  //      this material makes (formPull, and `travel` below). Nearest is what
  //      tears one body into several: material either side of a watershed is
  //      pulled to different destinations, the bridge between them thins as
  //      they separate, and ON the watershed the pull is zero -- so that is
  //      exactly where it pinches and snaps, with nothing scripting it.
  //   3. Sample the old form where this material CAME FROM and the new form
  //      where it is GOING, and blend those. Both are the same one piece of
  //      material, so the blend is a shape changing rather than two bodies
  //      overlaid.
  //
  // MEASURED THE SAME WAY AFTER: eyes-to-writing coexistence 0.38 -> 0.25,
  // writing-to-tool 0.47 -> 0.23, tool-to-eyes 0.32 -> 0.25; the worst peak
  // through any change 0.62 -> 0.78 of its own line, and the worst dip in the
  // body's substance 0.69 -> 0.75, so it conserves BETTER than the dissolve
  // did rather than paying for the seam with thinning. In tool-to-eyes the two
  // bands now travel inward and are taken back into the body instead of
  // standing still and going out.
  //
  // WHY THE BLEND ITSELF IS STILL LINEAR, having tried three that are not.
  // Combining the two samples in the log domain (either the field's log or its
  // square root, the iso-surface morph) buys a further drop in coexistence --
  // 0.25 -> 0.15 on eyes-to-writing -- and pays for it by thinning the body
  // through the middle of every change, worst dip 0.75 -> 0.48. The owner's
  // other standing complaint on this circle is material that appears and
  // disappears, so that trade is the wrong way round. The journey is what
  // removes the seam; the blend is only how one piece of material looks while
  // it changes shape, and there linear is what conserves it.
  //
  // THE MIX IN THE CALLER IS NOW AN IDENTITY, AND THAT IS DELIBERATE.
  // src/home-circle-fluid.js owns that dye pass and this lane does not write
  // it. Both of its calls land in fluidInk below, and mid-transition both
  // return the SAME one body, so mix(m, m, z) == m for every z and the
  // cross-fade annihilates itself without a line changing over there. The
  // `kind` argument still decides the answer at both ends of the blend, where
  // there is only one shape to draw and no journey to make.
  'const float formFloor = 0.0001;',  // ~exp(-9.2), and above mediump's denormals
  'const float formFar = 3.036;',     // sqrt(-log(formFloor)): where the range flattens out
  'const float formQuiet = 0.00017;', // exp(-(0.97 * formFar)^2): the pull is zero below this
  'const float formStep = 0.004;',    // finite difference, about one dye texel
  'const float formSpan = 0.34;',    // no material is asked to cross the body twice

  // Distance to this form's material, in body units.
  //
  // THE max(..., 0.0) DREW A HARD CLOSED LINE ON THE BODY, and it is the
  // hard-edged patch that survived every change to the light.
  //
  // Every form here is a SUM of lobes -- two eyes plus a bridge, four
  // thinking pieces, four writing droplets each weighted up to 1.4, two tool
  // bands over a track -- so wherever lobes overlap the sum goes ABOVE 1 and
  // -log of it goes negative. Clamped at zero, the range is then exactly 0
  // over that whole region: a flat plateau in the distance field with a
  // boundary the field crosses at a nonzero rate. Across that boundary the
  // range's curvature jumps, and the display pass reads curvature directly --
  // the inner caustic is built from the Laplacian of this profile and
  // multiplies it by 26 -- so the contour where the field passes 1 is drawn on
  // the body as a thin bright ridge. Measured on the white theme it was a
  // separate population of 70-odd pixels at luminance 253 with NOTHING between
  // it and the 233 of the surface around it: a step, not a gradient, and a
  // rounded-rectangle outline sitting on a soft sphere.
  //
  // Letting the range go signed does not help: -log crosses zero transversally
  // there, so sqrt of it has a cusp on the same contour and draws the same
  // line. The fix is for the field never to reach 1 at all. This is the same
  // knee-and-exponential-shoulder the renderer already uses for its tonemap
  // (jellyTone in src/home-circle-fluid.js): identity below the knee,
  // asymptotic to 1 above it, and C1 where they meet, because the shoulder's
  // slope is exactly 1 at the knee.
  //
  // IT DOES NOT MOVE THE SILHOUETTE. The body ends at 1.18 in these units
  // (TUNE.jelly.edge), i.e. at a field of exp(-1.18 * 1.18) = 0.249, which is
  // far below the knee and so passes through untouched. Only the interior is
  // remapped, and there it only ever makes the crown of the dome round instead
  // of flat -- the core keeps 92% of its thickness where the field reaches 1
  // and 99% where the bridge takes it to 1.5, which is below what the optical
  // path can show.
  'const float formCrown = 0.8;',   // where the field stops being taken at face value
  'float formRangeOf(float amount) {',
  '  float a = amount < formCrown ? amount',
  '    : formCrown + (1.0 - formCrown) * (1.0 - exp(-(amount - formCrown) / (1.0 - formCrown)));',
  '  return sqrt(max(-log(max(a, formFloor)), 0.0));',
  '}',
  'float formRange(vec2 p, float kind, float time) {',
  '  return formRangeOf(fluidForm(p, kind, time));',
  '}',

  // One Newton step onto the nearest material of `kind`. Zero on the peak it
  // is already standing on, and zero on a watershed between two lobes, which
  // is what makes a pinch a pinch: material either side of one is pulled to
  // different destinations and the bridge between them thins out and parts.
  //
  // A STEP IN THE JOURNEY IS A RING ON SCREEN, and it was one. The range stops
  // telling the truth once the form underneath it has dropped onto formFloor:
  // it flattens, its slope goes to zero, and the pull switched off along that
  // contour -- a hard circular edge in the middle of the change, plainly
  // visible in a filmstrip of the source. So the pull is LET GO of as the
  // range approaches the floor rather than dropped at it.
  'vec2 formPull(vec2 p, float kind, float time, float e) {',
  '  vec2 slope = vec2(formRange(p + vec2(formStep, 0.0), kind, time),',
  '                    formRange(p + vec2(0.0, formStep), kind, time)) - e;',
  '  float run = length(slope);',
  '  if (run < 0.0001) return vec2(0.0);',
  '  float reach = min(e * formStep / run, formSpan);',
  '  reach *= 1.0 - smoothstep(0.62 * formFar, 0.97 * formFar, e);',
  '  return -reach * (slope / run);',
  '}',

  // p - s * travel is where this material STARTED and p + (1 - s) * travel is
  // where it ENDS UP, so both samples describe the one piece of material that
  // is standing at p right now: what it looked like before and what it is
  // becoming. Blending those two is a shape changing. Blending the same two
  // forms WITHOUT the journey -- which is what this file used to do -- is two
  // shapes in two different places both half-there, and that is the seam.
  // Where the journey is zero the two are identical anyway and this reduces to
  // the old line exactly, which is the right answer for a pair of forms whose
  // material already coincides.
  //
  // THE EARLY RETURN IS EXACT, NOT AN APPROXIMATION, AND IT IS MOST OF THE
  // GRID. The pull is already tapered to exactly zero once a form has dropped
  // to formQuiet (that is what 0.97 * formFar works out to), so where BOTH
  // forms are that faint the journey is zero, the two samples are the ones
  // taken at p, and this line is the answer. Skipping the six form
  // evaluations behind it there costs nothing and saves them over all the
  // empty water around the body, which is where the dye grid mostly is.
  'float formMorph(vec2 p, float time) {',
  '  float s = clamp(uForm.z, 0.0, 1.0);',
  '  float was = fluidForm(p, uForm.x, time);',
  '  float now = fluidForm(p, uForm.y, time);',
  '  if (max(was, now) > formQuiet) {',
  '    vec2 travel = formPull(p, uForm.y, time, formRangeOf(now)) - formPull(p, uForm.x, time, formRangeOf(was));',
  '    was = fluidForm(p - s * travel, uForm.x, time);',
  '    now = fluidForm(p + (1.0 - s) * travel, uForm.y, time);',
  '  }',
  '  return mix(was, now, s);',
  '}',

  // WHICH BLENDS ARE THIS LAW'S BUSINESS, AND WHICH ARE NOT.
  //
  // A form of 0 is the ABSENCE of a shape, not a shape: it is what the drive
  // sets while the original cloudy fluid takes the body over for an agent
  // change (originalFluid in src/home-circle-fluid.js ramps formMix against
  // formFrom 0). Nothing is standing anywhere to be moved, so there is no
  // journey to make and no second shape to be caught beside -- and a shape
  // giving way to the storm was never the seam. Left on the caller's linear
  // ramp deliberately. Putting it through the log law instead would take the
  // character to a hundredth of its strength a quarter of the way in, which
  // is a pop, not a hand-off.
  //
  // Two equal forms are the same shape at both ends -- idle, waiting and
  // reading are all the base character -- so there is nothing to morph and the
  // answer is the shape itself.
  'vec2 fluidInk(vec2 p, float kind, float time, vec2 ink) {',
  '  bool between = uForm.z > 0.0 && uForm.z < 1.0;',
  '  bool shapes = uForm.x > 0.5 && uForm.y > 0.5 && abs(uForm.x - uForm.y) > 0.5;',
  '  if (!between || !shapes) return fluidForm(p, kind, time) * ink;',
  '  return formMorph(p, time) * ink;',
  '}',
].join('\n')
