// LAUNCH ring: the 09-11..09-15 Home circle -- the band, the lip and the
// travelling crest that spins every 16 s -- from src/home-circle.js at an earlier commit, with its
// classes renamed launch-* so it can sit beside Classic and Blob. The original notes follow.
// The stripe widens into one tapered crest. Its silhouette carries the motion;
// the color stays flat and the underlying circle and readout remain still.
// Two blurred layers carry the glow: a halo on the lip, and a larger soft
// crest inside the same rotating group so the light travels with the crest.
let instances = 0
export function launchCircleMarkup() {
  const point = (r, angle) => {
    const radians = angle * Math.PI / 180
    return [260 + r * Math.cos(radians), 260 + r * Math.sin(radians)]
  }
  const xy = p => p.map(n => n.toFixed(3)).join(' ')
  // The lip circle and the crest share this radius: the band spans r 228 to
  // 244, and the lip sits at its centre.
  const lightRadius = 236, start = -182, span = 156, shoulder = .74
  // The long tail and short leading edge meet with matching slope and
  // curvature. The crest stays inside the band's edges.
  const edge = (t, depth) => {
    const arriving = t <= shoulder
    const phase = arriving ? t / shoulder : (1 - t) / (1 - shoulder)
    const weight = phase ** 3 * (10 + phase * (-15 + 6 * phase))
    const slope = 30 * phase ** 2 * (phase - 1) ** 2 / (arriving ? shoulder : shoulder - 1)
    const angle = start + span * t, radians = angle * Math.PI / 180
    const radius = lightRadius + depth * weight, speed = span * Math.PI / 180
    return {
      p: point(radius, angle),
      d: [depth * slope * Math.cos(radians) - radius * Math.sin(radians) * speed,
        depth * slope * Math.sin(radians) + radius * Math.cos(radians) * speed],
    }
  }
  const contour = (depth, from, to) => {
    // Put a curve boundary at the shoulder so its peak is rendered exactly.
    return [[from, shoulder], [shoulder, to]].flatMap(([start, end]) => {
      const steps = Math.max(1, Math.round(24 * Math.abs(end - start))), step = (end - start) / steps
      return Array.from({ length: steps }, (_, i) => {
        const a = edge(start + i * step, depth), b = edge(start + (i + 1) * step, depth)
        const control = (p, d, gain) => p.map((n, axis) => n + d[axis] * gain)
        return `C ${xy(control(a.p, a.d, step / 3))} ${xy(control(b.p, b.d, -step / 3))} ${xy(b.p)}`
      })
    }).join(' ')
  }
  const crestPath = (out, inward) => `M ${xy(edge(0, out).p)} ${contour(out, 0, 1)} ${contour(inward, 1, 0)} Z`
  const crest = crestPath(8, -3.8)
  const trail = crestPath(12, -6.5)
  // Filter ids are per instance: the router can hold two home views during
  // a transition, and a shared id would point both circles at one filter.
  const id = `launch-core-${instances += 1}`
  return `<div class="launch-circle-finish" aria-hidden="true">
    <svg viewBox="0 0 520 520" focusable="false">
      <defs>
        <filter id="${id}-halo" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
          <feGaussianBlur stdDeviation="5"/>
        </filter>
        <filter id="${id}-trail" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">
          <feGaussianBlur stdDeviation="9"/>
        </filter>
      </defs>
      <g class="launch-core-pinstripe-design">
        <circle class="launch-core-face" cx="260" cy="260" r="224" fill="none"/>
        <path class="launch-core-foundation" fill-rule="evenodd"
          d="M 504 260 A 244 244 0 1 1 16 260 A 244 244 0 1 1 504 260 Z
             M 488 260 A 228 228 0 1 1 32 260 A 228 228 0 1 1 488 260 Z"/>
      </g>
      <circle class="launch-core-halo" cx="260" cy="260" r="${lightRadius}" filter="url(#${id}-halo)"/>
      <circle class="launch-core-lip" cx="260" cy="260" r="${lightRadius}"/>
      <g class="launch-core-sweep">
        <path class="launch-core-light-glow" d="${trail}" filter="url(#${id}-trail)"/>
        <path class="launch-core-light" d="${crest}"/>
      </g>
    </svg>
  </div>`
}
