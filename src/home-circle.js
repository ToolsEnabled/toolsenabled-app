// Standard is a continuous soft bevel around an inset status line. Simple restores
// the original SVG rim and three static crescent layers (pre-corona Home).
// Neither border has an animation loop. IDs stay local to each mounted view.
let instances = 0
export function homeCircleMarkup() {
  const id = `home-core-${instances += 1}`
  /* arcAt returns the path AND its two endpoints, because a light that stops
     dead is a dash, not a specular: the endpoints are what the fade gradients
     below are pinned to. A chord from one end of an arc to the other projects
     the arc's midpoint to exactly 0.5 and its ends to 0 and 1, so a linear
     gradient laid on that chord tapers the stroke symmetrically to nothing at
     both ends -- with no blur wide enough to also wash out the light itself. */
  const arcAt = (radius, start, end) => {
    const xy = angle => [260 + radius * Math.cos(angle * Math.PI / 180), 260 + radius * Math.sin(angle * Math.PI / 180)]
    const fmt = p => p.map(n => n.toFixed(3)).join(' ')
    const a = xy(start), b = xy(end)
    return { d: `M ${fmt(a)} A ${radius} ${radius} 0 0 1 ${fmt(b)}`, a, b }
  }
  const arc = (radius, start, end) => arcAt(radius, start, end).d
  const fade = (gid, v, { a, b }) => `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${a[0].toFixed(3)}" y1="${a[1].toFixed(3)}" x2="${b[0].toFixed(3)}" y2="${b[1].toFixed(3)}">
          <stop offset="0" stop-color="var(${v})" stop-opacity="0"/>
          <stop offset=".22" stop-color="var(${v})" stop-opacity=".35"/>
          <stop offset=".5" stop-color="var(${v})" stop-opacity="1"/>
          <stop offset=".78" stop-color="var(${v})" stop-opacity=".35"/>
          <stop offset="1" stop-color="var(${v})" stop-opacity="0"/>
        </linearGradient>`
  const wet = arcAt(248.2, 170, 280)
  /* r247.4 -> r246.0 and the blur 3.2 -> 2.5, MEASURED, not guessed: at the
     first values the outermost painted radius on black moved 253.25 -> 255.00
     (.lane-scratch/mgr2/rim/freeze-check.mjs, which finds the last radius at
     which the photograph still differs from the page). The contract freezes the
     footprint, and a soft shadow's tail is still paint. At these values the
     arc's own outer edge is 248.5 and its tail dies inside the feather the
     foundation's blur already put there. */
  const contact = arcAt(246.0, 356, 106)
  return `<div class="home-circle-finish" aria-hidden="true">
    <svg viewBox="0 0 520 520" focusable="false">
      <defs>
        <radialGradient id="${id}-glass-edge" gradientUnits="userSpaceOnUse" cx="260" cy="260" r="250">
          <stop offset=".934" stop-color="var(--core-glass-dark)"/>
          <stop offset=".946" stop-color="var(--core-glass-dark)"/>
          <stop offset=".958" stop-color="var(--core-glass-mid)"/>
          <stop offset=".973" stop-color="var(--core-glass-light)"/>
          <stop offset=".981" stop-color="var(--core-glass-mid)"/>
          <stop offset=".996" stop-color="var(--core-glass-dark)"/>
          <stop offset="1" stop-color="var(--core-glass-light)"/>
        </radialGradient>
        <linearGradient id="${id}-glass-light" gradientUnits="userSpaceOnUse" x1="60" y1="50" x2="455" y2="450">
          <stop offset="0" stop-color="var(--core-glint)" stop-opacity=".95"/>
          <stop offset=".28" stop-color="var(--core-glint)" stop-opacity=".55"/>
          <stop offset=".5" stop-color="var(--core-glint)" stop-opacity="0"/>
          <stop offset=".73" stop-color="var(--jelly-structure)" stop-opacity=".5"/>
          <stop offset="1" stop-color="var(--core-glint)" stop-opacity=".85"/>
        </linearGradient>
        <linearGradient id="${id}-bezel" gradientUnits="userSpaceOnUse" x1="100" y1="20" x2="420" y2="500">
          <stop offset="0" stop-color="var(--core-frame-light)"/>
          <stop offset=".55" stop-color="var(--core-frame)"/>
          <stop offset="1" stop-color="var(--core-frame-shade)"/>
        </linearGradient>
        <!-- THE CROSS-SECTION. The bezel above runs corner to corner across the
             whole 520 viewBox, so it varies AROUND the ring and is CONSTANT
             ACROSS the band's width -- which is why the band reads flat however
             its colours are tuned. This gradient is the missing axis: it is
             concentric with the ring, so every stop is a RADIUS and the shading
             it paints runs across the band and is the same all the way round.
             Offsets are radius/250, so they name the band's own geometry:
             .912 = r228 (the inner turn), .956 = r239 (the lit crown),
             1 = r250 (the outer turn, meeting the silhouette exactly).
             The stops are black and white at a dose, not colours, so this
             MODELS whatever the bezel laid down underneath rather than
             replacing it -- the theme's own ink still decides the hue, and
             both axes are now present at once. Transparent stops are paired
             with a same-colour neighbour so no interpolation ever crosses
             black to white and hazes the middle of the band grey. -->
        <radialGradient id="${id}-tube" gradientUnits="userSpaceOnUse" cx="260" cy="260" r="250">
          <stop offset=".900" stop-color="var(--core-tube-shade)" stop-opacity="0"/>
          <stop offset=".912" stop-color="var(--core-tube-shade)" stop-opacity="1"/>
          <stop offset=".922" stop-color="var(--core-tube-shade)" stop-opacity=".5"/>
          <stop offset=".938" stop-color="var(--core-tube-shade)" stop-opacity="0"/>
          <stop offset=".942" stop-color="var(--core-tube-crown)" stop-opacity="0"/>
          <stop offset=".956" stop-color="var(--core-tube-crown)" stop-opacity="1"/>
          <stop offset=".970" stop-color="var(--core-tube-crown)" stop-opacity=".45"/>
          <stop offset=".982" stop-color="var(--core-tube-crown)" stop-opacity="0"/>
          <stop offset=".986" stop-color="var(--core-tube-shade)" stop-opacity="0"/>
          <stop offset=".994" stop-color="var(--core-tube-shade)" stop-opacity=".9"/>
          <stop offset="1" stop-color="var(--core-tube-shade)" stop-opacity="1"/>
        </radialGradient>
        <filter id="${id}-halo" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3"/></filter>
        <!-- The two directional arcs' tapers, pinned to their own endpoints. -->
        ${fade(`${id}-wet-fade`, '--core-wet', wet)}
        ${fade(`${id}-contact-fade`, '--core-contact', contact)}
        <!-- Blurs are in viewBox units so the wet edge and the contact shadow
             are one shape at every circle size. -->
        <filter id="${id}-wet" x="-12%" y="-12%" width="124%" height="124%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="1.1"/></filter>
        <filter id="${id}-contact" x="-12%" y="-12%" width="124%" height="124%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2.5"/></filter>
        <filter id="${id}-simple-haze" x="-75%" y="-75%" width="250%" height="250%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="26"/></filter>
        <filter id="${id}-simple-halo" x="-70%" y="-70%" width="240%" height="240%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="11.44"/></filter>
        <filter id="${id}-simple-core" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2.08"/></filter>
      </defs>
      <g class="home-core-standard-design">
        <circle class="home-core-foundation" cx="260" cy="260" r="239"/>
        <circle class="home-core-bezel" cx="260" cy="260" r="239" stroke="url(#${id}-bezel)"/>
        <circle class="home-core-tube" cx="260" cy="260" r="239" stroke="url(#${id}-tube)"/>
        <circle class="home-core-crystal" display="none" cx="260" cy="260" r="243" stroke="url(#${id}-glass-edge)"/>
        <circle class="home-core-engraving" display="none" cx="260" cy="260" r="243"/>
        <path class="home-core-facets" display="none" d="${arc(245.5, 192, 234)} ${arc(245.5, 250, 276)} ${arc(239.5, 17, 57)}" stroke="url(#${id}-glass-light)"/>
        <circle class="home-core-highlight" cx="260" cy="260" r="241"/>
        <!-- THE WET EDGE. A catchlight on the outer turn, on ONE side only: a
             specular is where the light is, and a specular that goes all the
             way round is a drawn ring, which is the thing this rim keeps being
             accused of. Upper-left, the same quarter the bezel gradient is lit
             from (x1/y1 100/20), so the two agree about where the light is. -->
        <path class="home-core-wet" d="${wet.d}" stroke="url(#${id}-wet-fade)" filter="url(#${id}-wet)"/>
        <!-- ...and its opposite number: the band darkens where it turns away
             and meets the page, lower-right. Contact, not elevation -- it sits
             INSIDE the silhouette (r246.0 +/- 2.5 = 243.5..248.5) so it darkens
             the rim itself rather than throwing a shape onto the page. -->
        <path class="home-core-contact" d="${contact.d}" stroke="url(#${id}-contact-fade)" filter="url(#${id}-contact)"/>
        <circle class="home-core-outline" cx="260" cy="260" r="250"/>
        <circle class="home-core-recess" cx="260" cy="260" r="224"/>
        <circle class="home-core-halo" cx="260" cy="260" r="229" filter="url(#${id}-halo)"/>
        <circle class="home-core-lip" cx="260" cy="260" r="229"/>
      </g>
      <g class="home-core-simple-design">
        <g transform="translate(-11.44 0)">
          <path class="home-simple-haze" d="${arc(242.6, 118, 242)}" filter="url(#${id}-simple-haze)"/>
          <path class="home-simple-halo" d="${arc(242.6, 126, 234)}" filter="url(#${id}-simple-halo)"/>
          <path class="home-simple-core" d="${arc(242.6, 139, 221)}" filter="url(#${id}-simple-core)"/>
        </g>
        <circle class="home-simple-rim" cx="260" cy="260" r="242.6"/>
      </g>
    </svg>
  </div>`
}
