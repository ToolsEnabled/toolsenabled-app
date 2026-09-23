/* The thresholds the home-circle picture and motion gates judge against, and
 * the provenance of every one of them.
 *
 * SEPARATE FILE ON PURPOSE. The browser drivers that measure the live app and
 * the pure tests that prove the gates can discriminate must judge against the
 * SAME numbers. If a driver kept its own copy, the tests could prove a
 * threshold works while the gate shipped a different one.
 *
 * No number here was chosen by looking at what the shader currently scores.
 * Each is either quoted from the owner-facing brief / standard, measured on
 * the owner's reference, or derived from a synthetic control whose right
 * answer is known by construction, and says which in its `from`.
 *
 * The owner's reference (.lane-scratch/w4/f/reference-and-ours.png, left
 * panel) was measured with tools/test/home-circle-picture-measure.mjs on
 * 2026-09-18 (.lane-scratch/gate/ref-probe.mjs): edge width 0.061 of radius,
 * core Oklab L 0.595, rim-to-core hue travel 50 -> 53 degrees with a dip to 39
 * in between, chroma 0.13-0.16 at every band. Where the reference and the
 * brief disagree the entry says so; the reference is a CUBE in perspective, so
 * a radial thickness proxy is not its thickness, and the rim/core numbers it
 * yields are not used as thresholds.
 */
export const THRESHOLDS = {
  transmissionFloor: {
    value: 0.08,
    from: 'BRIEF-JELLY-GATE section 5.1 requires interior change under two backdrops to be non-zero. '
      + '"Non-zero" is not measurable against a body that is still animating, so the floor is set at '
      + 'roughly twice the same-ground control residual measured on this box (0.044 of the ground '
      + 'separation, 2026-09-18). Below that a reading is indistinguishable from the animation.'
  },
  transmissionOverControl: {
    value: 4,
    from: 'The signal must also beat its own measured noise floor by 4x, so a body is never called '
      + 'translucent on the strength of the fluid churning. An opaque body scores ~0 by construction '
      + '(unit test "an OPAQUE body transmits nothing").'
  },
  chromaDipMax: {
    value: 0.010,
    from: 'BRIEF section 5.2: chroma must not dip across the thickness sweep. In Oklab chroma a synthetic '
      + 'mid-band collapse towards grey scores above 0.02 and a monotone ramp below 0.01 (unit tests), so '
      + '0.010 sits between the two measured cases rather than being picked.'
  },
  hueSwingMax: {
    value: 8,
    from: 'Quoted from both briefs: hue within ~8 degrees of the scheme hue at every thickness. Measured in '
      + 'Oklab hue over the INTERIOR bands only (thickness >= 25%). The thin skin is exempt because at zero '
      + 'thickness the transmitted light is the illuminant and carries its hue, not the dye\'s '
      + '(STANDARD-RENDER section 9, corrected), and the owner\'s reference rim sits 11-14 degrees off its '
      + 'own interior. The interior of the reference holds within 8 degrees (39-45 over bands 1-3, 52-55 '
      + 'over 4-7 in the ref-probe), and the brown-band defect this gate exists for rotated the interior '
      + 'by 21-28 degrees.'
  },
  hueInteriorFrom: {
    value: 0.25,
    from: 'The thickness fraction from which the hue gate applies (see hueSwingMax).'
  },
  coreLuminanceLo: {
    value: 0.45,
    from: 'Quoted from both briefs: core luminance 0.45-0.70 on dark themes. Bound to Oklab L. The owner\'s '
      + 'reference core measures 0.595.'
  },
  coreLuminanceHi: {
    value: 0.70,
    from: 'Quoted from both briefs: core luminance 0.45-0.70 on dark themes.'
  },
  edgeWidthMax: {
    value: 0.15,
    from: 'BRIEF section 5.5: the silhouette is a razor. Measured as the distance over which ink falls from '
      + '80% to 20% of its peak along rays from the centroid, as a fraction of body radius. The owner\'s '
      + 'reference measures 0.061; a synthetic hard-edged disc under 0.05. 0.15 leaves room for '
      + 'antialiasing and a real gummy edge.'
  },
  haloMax: {
    value: 4,
    from: 'BRIEF section 5.5: no soft halo outside the outline. Mean ink (0-255) outside the silhouette\'s '
      + '20%-of-peak foot, out to 1.5x the radius. Synthetic controls: a razor edge scores under 2 and a '
      + 'visible exponential skirt above 4 (unit tests); 4 is the skirt\'s own score, so anything a '
      + 'person could see as a glow is red.'
  },
  rimChromaRiseMin: {
    value: 0.03,
    from: 'Ruled 2026-09-18 (M6 ground-aware): on a DARK ground a clear rim transmits the dark ground and '
      + 'carries less dye than the core, so chroma rises rim-to-core. The body lane measures rim C 0.136 to '
      + 'core C 0.209 (a rise of 0.07); 0.03 is under half of that and above the 0.01 band noise the '
      + 'monotone-ramp control shows. A flat disc (0.153 to 0.151) fails it.'
  },
  rimDarkGlowMax: {
    value: 0.02,
    from: 'On a dark ground the rim may not be BRIGHTER than the core by more than band noise: a rim that '
      + 'lights up over black is emission at the edge -- the soft glow the owner rejected and this '
      + 'afternoon removed. The flat-disc control measured 0.005 of L across the whole body.'
  },
  rimStepMin: {
    value: 0.05,
    from: 'STANDARD-OPTICS section 5.1 and BRIEF 5.6, applied on a LIGHT ground only (ruled 2026-09-18): the '
      + 'thin rim transmits the light ground and is brighter than the core, luminance rising toward the rim '
      + 'monotonically by a stated margin (the body lane measures white rim 0.81 falling to core 0.66). The flat-disc failure measured 0.005 of L '
      + 'across the whole body; 0.05 is ten times that and is a step a person can see. NOT calibrated on '
      + 'the reference photo: it is a cube in perspective and its radial proxy reads the core 0.03 '
      + 'brighter than the rim.'
  },
  rimDropMax: {
    value: 0.02,
    from: 'The largest rim-ward DROP in L between adjacent thickness bands a monotone ramp may show; '
      + 'a synthetic monotone ramp scores under 0.01 (unit test), 0.02 allows band noise.'
  },
  specularAreaLo: {
    value: 0.01,
    from: 'STANDARD-OPTICS section 5.3: the catch must have area, not be a pin-prick. Measured by PEAKS '
      + '(ruled 2026-09-18): the region within 0.05 L of the catch\'s blurred maximum. The owner\'s '
      + 'reference catch is 7.5% of body pixels; a synthetic 9 px catch on a 60 px body scores ~2%; a '
      + 'pin-prick under 0.5%. 1% is the floor.'
  },
  specularAreaHi: {
    value: 0.15,
    from: 'Twice the reference\'s 7.5%; a matte sheen over half the body reads as a wide plateau within '
      + '0.05 L of its own maximum and scores far above 0.15, and a sheen is the plastic read the '
      + 'standard names.'
  },
  solidityMin: {
    value: 0.96,
    from: 'STANDARD-HAPPY-AND-MERGE Part A: the merged body is ONE body with no cleft. Solidity is mask '
      + 'area over convex-hull area. A synthetic disc scores above 0.97 and two overlapping lobes with a '
      + 'waist below 0.95 (unit tests); 0.96 sits between.'
  }
}

/* The two grounds the body is composited over for the transmission measure.
   Maximally separated on purpose: the transmission signal scales with the ground
   separation while the animation's own movement does not. */
export const GROUND_A = [0, 0, 0]
export const GROUND_B = [255, 255, 255]

/* ------------------------------------------------------------- motion */

export const MOTION = {
  determinismMaxDiffering: {
    value: 0,
    from: 'BRIEF section 4 and STANDARD-RENDER section 7: fixed timestep, seeded state, reproducible frames. '
      + 'Two runs from the same seed stepped the same number of fixed frames must agree to the pixel; the '
      + 'tolerance per channel is 2/255 so 8-bit dither with a seeded generator still passes.'
  },
  overshootCrossings: {
    value: 2,
    from: 'BRIEF section 6.1 verbatim: the silhouette must overshoot and cross rest twice. A damped spring at '
      + 'the standard\'s 4-6 Hz and damping ratio ~0.2 crosses rest 4+ times in 1.5 s; an exponential ease '
      + 'crosses zero times (unit tests).'
  },
  blendResidualMin: {
    value: 0.12,
    from: 'BRIEF section 6.2: an intermediate frame must not be reproducible as a linear blend of its endpoints. '
      + 'Residual is the RMS the best three-coefficient fit cannot explain, over the RMS difference of the '
      + 'endpoints. Controls (unit tests): a literal crossfade, with or without a brightness ramp, scores '
      + 'under 0.06; an ellipse deforming between two ellipses scores above 0.12.'
  },
  axisCorrelationMax: {
    value: -0.5,
    from: 'BRIEF section 6.3: axes move in opposition. Pearson correlation of frame-to-frame width and height '
      + 'changes; a volume-preserving squash scores near -1 and a uniform scale +1 (unit tests).'
  },
  areaDriftMax: {
    value: 0.08,
    from: 'BRIEF section 6.3: area preserved. Peak relative excursion of width*height from its mean over the '
      + 'transition. A synthetic squash with 20% axis swing drifts under 0.08 through pixel rounding; a '
      + '20% uniform scale drifts 0.4.'
  },
  stateSeparationD: {
    value: 2,
    from: 'BRIEF section 6.4: solid, liquid and mist separate on two independent measures. Separation is the gap '
      + 'of two states\' means in pooled standard deviations (Cohen\'s d); d = 2 means the distributions '
      + 'barely overlap, so a person seeing either would not confuse them. '
      + 'RECALIBRATED 2026-09-18 (Worker 5) against LIVE states, not the synthetic controls this was set from. '
      + 'Cohen\'s d is scale-free, so on its own it passes a pair whose means differ by an amount nobody could '
      + 'see as long as the variance is smaller still. The absolute anchors below come from the presence proof '
      + 'and are required ALONGSIDE d, so a separation has to be both statistically real and visible.'
  },
  /* ABSOLUTE state anchors, measured live 2026-09-18 (body lane presence proof).
     Each one is a floor a person could point at, not a statistic. */
  cloudOverBodyCoverageMin: {
    value: 2,
    from: 'LIVE 2026-09-18: thinking cloud covers 0.146 of the canvas against the idle body\'s 0.042, a ratio '
      + 'of 3.5x. The floor is set at 2x so the gate has room for tuning but still refuses a "cloud" that '
      + 'covers what the body covers. Synthetic controls never fixed this ratio at all.'
  },
  solidEdgeMaxFraction: {
    value: 0.15,
    from: 'The standard states this as "the solid body has an edge of 3-8 px at 2x where mist has none", but '
      + 'silhouetteProfile returns edgeWidth as mean(widths)/radius -- a FRACTION OF BODY RADIUS, not pixels '
      + '(home-circle-picture-measure.mjs). Stating it in px would be a unit error that can never pass, so it '
      + 'is carried here in the measure\'s own units and tied to the value the material gate already uses: '
      + 'edgeWidthMax 0.15, against the owner\'s reference gummy at 0.061. On a 128 px sample a body radius '
      + 'near 40 px makes 3-8 px = 0.075-0.2 of radius, which brackets this.'
  },
  mistOverSolidEdgeMin: {
    value: 1.5,
    from: '"where mist has none" is a RELATIVE claim and is the half that actually separates the two states: '
      + 'mist\'s edge must be at least 1.5x as soft as the solid body\'s. An unmeasurable mist edge is '
      + 'reported as 1.0 by the driver, which passes this comfortably against any real rim. Measured live '
      + '2026-09-18 the two sat at solid 0.356 / mist 0.484 = 1.36x, i.e. NOT separated -- see the report.'
  },
  solidChromaMin: {
    value: 0.14,
    from: 'LIVE 2026-09-18: the solid body measures chroma 0.14-0.23. Below 0.14 it has lost the dye that '
      + 'makes it read as a sweet rather than a grey form.'
  },
  mistChromaMax: {
    value: 0.10,
    from: 'LIVE 2026-09-18: mist measures under 0.1 chroma. The band between 0.10 and 0.14 is deliberately '
      + 'left empty so solid and mist cannot meet in the middle and both pass.'
  },
  interiorNoiseFloorLsb: {
    value: 2,
    from: 'REPLACES interiorLagLoMs/HiMs (was "BRIEF section 6.5 verbatim: interior lag 40-80 ms"). '
      + 'RETIRED AS A GATE 2026-09-18 (Worker 5, on the body lane\'s evidence): that band was written for the '
      + 'fluid substrate, where a dye layer really did trail the boundary. The body is now ONE analytic field '
      + 'and HAS no interior that can lag its own outline -- the deformation memory is the spring on the shape, '
      + 'which T1 (overshootCrossings) measures directly and gates on. The 134 ms the proof reported is the '
      + 'liquid layer\'s dye trail or 1 LSB of dither, cross-correlated into a confident-looking number. '
      + 'What survives is this floor: an interior series whose robust peak-to-peak is at or under 2 ink LSB '
      + 'is UNDECIDABLE and is reported as such, never scored. A gate that reads dither is worse than no gate, '
      + 'because it goes green on noise.'
  },
  transitionLoMs: { value: 350, from: 'BRIEF section 6.6 verbatim: each transition 350-600 ms.' },
  transitionHiMs: { value: 600, from: 'BRIEF section 6.6 verbatim: each transition 350-600 ms.' },

  /* M7 OVER-STOP WHITE. Added 2026-09-19 after REPORT-JELLY-GATE-20260918.md
     section 0aa.5 found the only enforcement of the owner's four rejections of
     additive white was arithmetic lifted from the shader BY NAME, which stopped
     binding when the colour law moved to an absorption model: "nothing measures
     it now". These two are what the pixel measure judges instead. */
  overStopAreaMax: {
    value: 0.15,
    from: "The fraction of the body that may sit above the material's own declared light stop "
      + '(stats().stops.light, the thin end after exposure and the tonemap, encoded to sRGB like the '
      + 'pixels). NOT chosen by looking at what the shader scores: it is tied to specularAreaHi, the area '
      + 'M9 already allows the one wet CATCH, because a reflection is the only thing in this picture that '
      + 'is permitted over the stop. Anything larger is a coat, which is the additive white the owner has '
      + 'rejected four times. Synthetic controls (home-circle-picture-measure.test.mjs): a body drawn by '
      + 'absorption alone scores 0; a 144 px hard-edged catch on a 5027 px body scores 0.029 with the '
      + "catch excluded; the shader's own liquid mix(1.0, 1.25, ...) and mist 1.3x score above 0.9. "
      + "Judged on the FRACTION and not on the peak multiple, because the peak detector's skirt is M9's "
      + "catch CORE and a catch's own rim survives exclusion at 2x the stop -- gating that would put M7 "
      + 'and M9 in the mutually-unsatisfiable state M5 and M9 were found in on 2026-09-18.'
  },
  overStopTolerance: {
    value: 0.02,
    from: 'A measurement allowance, not a grant. 8-bit quantisation and the premultiplied framebuffer '
      + 'readback both round, and 2/255 of a mid-grey stop is about 1%; 2% is twice that. The defect this '
      + 'gate exists for is 25% and 30% over the stop, so the allowance cannot swallow it.'
  },
}

/* ------------------------------------------------ presence and frame time */

export const PRESENCE = {
  minStepsPerSecond: {
    value: 10,
    from: 'The renderer must be STEPPING in every real agent state. Its slowest ladder rung is well above 10 '
      + 'steps/s; Manager measured the "waiting" state at state "paused", steps 0, ring interior empty '
      + '(2026-09-18, .lane-scratch/mgr-body2-black.png), which is the defect this floor names.'
  },
  minCoverage: {
    value: 0.001,
    from: 'A body must cover at least 0.1% of the canvas at half-peak ink. The resting eye pair covers '
      + '~0.5% of a 128 px sample and the thinking cloud ~70%; an empty canvas covers 0.'
  },
  minPeakInk: {
    value: 40,
    from: 'The 90th-percentile ink of the drawn body must reach 40/255. The resting body peaks at 120-170; '
      + 'a canvas holding only dither or a faint veil peaks under 20.'
  },
  p95OverBudget: {
    value: 1.5,
    from: 'Owner: "we need to keep lag in mind." The 95th-percentile interval between drawn frames may be at '
      + 'most 1.5x the budget of the ladder rung the renderer chose (the rung is its own promise); worse '
      + 'than that is a visible stutter. This is the baseline gate taken BEFORE 3D geometry lands.'
  },
  minGroundContrast: {
    value: 0.12,
    from: 'Owner-visible defect 2026-09-18: on black the body drew as "two faint smudges" while the same '
      + 'build on white drew a clear dome. Mean Oklab distance of the composited body from the theme '
      + 'ground; 0.04 is roughly where two colours stop reading as the same, and a character a person '
      + 'must notice at a glance needs three times that. The resting salmon body over black measures '
      + '~0.4; the reference gummy over its mint ground ~0.5.'
  },
  unfocusedRuns: {
    value: 6,
    from: 'The never-focused empty circle is a RACE (Manager measured 173 steps on one build and 0 on the '
      + 'next), so one load proves nothing. Six fresh loads, and any single empty one is red: a person '
      + 'who opens Home behind another window one time in six still sees the empty circle.'
  },
  plainRuns: {
    value: 3,
    from: 'The careless shape -- open, never raised, no CDP, wait, read back -- is how the owner meets the '
      + 'screen and found four defects the rigorous shape passed (Manager, 2026-09-18). Three fresh loads, '
      + 'any one empty is red.'
  },
  unfocusedWaitMs: {
    value: 6000,
    from: 'Six seconds after load on an unfocused page: past the 1.6 s reveal transition and the 47 boot '
      + 'steps several times over, so a body that is going to appear has appeared.'
  },
  droppedMax: {
    value: 0.05,
    from: 'At most 5% of drawn-frame intervals may exceed twice the median; a steady renderer on this box '
      + 'measured 0-2% while sampling.'
  }
}
