import { isDarkTheme } from './theme-choice.js'
/* Puts the eclipse corona on the page, and keeps CSS in charge of colour.
   =====================================================================

   The shader owns the SHAPE of the light. home.css still owns everything else —
   which hue each state is on each sheet, the `--glow` slider, the
   `--cres-halo-o` dose, the 1.4s transition between states, and reduced motion.
   That division is deliberate: those hues carry measured WCAG ratios in their
   comments and are an accessibility requirement, so they must not migrate into
   a shader constant where nobody will find them.

   The trick that keeps CSS authoritative over the transition is the probe: a
   hidden element carrying `background-color: var(--load-col)` with the real
   transition on it. During a state change the browser interpolates it, this
   file samples the interpolated value each frame and redraws. So the timing
   curve, the duration and the per-theme colours are still stated once, in CSS,
   and there is no second implementation of them here to drift.

   If WebGL2 is unavailable or the context is lost, this falls back to the CPU
   field renderer (crescent-field.js), which is deterministic and unit-tested.
   The fallback markup is the older three-masked-layer arrangement, which is why
   those rules are still in home.css.
*/

import { createCorona, cssColorToSrgb } from './corona-gl.js'
import { crescentSpec } from './crescent-field.js'
import { crescentMasks } from './crescent-render.js'
import { onNextFrame } from './page-frames.js'

const rad = (d) => (d * Math.PI) / 180

/* Shape of the corona, in units of the rim radius, arrived at by rendering and
   looking rather than by theory — the owner reviewed these. `h0` sets the clean
   sliver of sheet between the rim and the light, which is what stops the pair
   reading as one heavy shadowed edge; `h1` is the bright band; `h2` the outer
   haze. The angular limits come from measuring the owner's drawing: the glow's
   half-extent there is 53-56 degrees. */
export const SHAPE = {
  h0: 0.012, h1: 0.026, h2: 0.090,
  w1: 0.72, w2: 0.28,
  a1i: rad(25), a1x: rad(50),
  a2i: rad(30), a2x: rad(60),
}
export const BASE_GAIN = 2.4

const num = (styles, name, fallback) => {
  const v = parseFloat(styles.getPropertyValue(name))
  return Number.isFinite(v) ? v : fallback
}

/**
 * Mount the crescent into `root` (the .uring element) and return a controller.
 * Returns { el, redraw, destroy, mode } where mode is 'gl' or 'cpu'.
 */
export function mountCrescent(root, size) {
  const spec = crescentSpec(size)
  const rim = spec.r
  const centre = size / 2
  const boxHalf = Math.ceil(rim * 1.72)
  const box = boxHalf * 2
  const dpr = Math.max(1, window.devicePixelRatio || 1)

  const canvas = document.createElement('canvas')
  canvas.className = 'cres-gl'
  canvas.setAttribute('aria-hidden', 'true')
  canvas.width = Math.round(box * dpr)
  canvas.height = Math.round(box * dpr)
  // Scale the existing raster with its ring when the phone rotates or text
  // size changes; its backing resolution and shader coordinates stay intact.
  canvas.style.width = `${box / size * 100}%`
  canvas.style.height = `${box / size * 100}%`
  canvas.style.left = `${(centre - boxHalf) / size * 100}%`
  canvas.style.top = `${(centre - boxHalf) / size * 100}%`

  /* The colour carrier. Hidden, but a real element so the CSS transition on
     --load-col actually runs and can be sampled mid-flight. */
  const probe = document.createElement('i')
  probe.className = 'cres-probe'
  probe.setAttribute('aria-hidden', 'true')

  root.insertBefore(canvas, root.firstChild)
  root.insertBefore(probe, root.firstChild)

  const corona = createCorona(canvas)

  if (!corona) {
    /* No GL. Drop the canvas, put the old masked layers back, and let the
       existing CSS drive them exactly as before. */
    canvas.remove()
    const layers = document.createElement('div')
    layers.className = 'cres-layers'
    layers.setAttribute('aria-hidden', 'true')
    layers.style.left = `${spec.box.left / size * 100}%`
    layers.style.top = `${spec.box.top / size * 100}%`
    layers.style.width = `${spec.box.width / size * 100}%`
    layers.style.height = `${spec.box.height / size * 100}%`
    layers.innerHTML = '<div class="cres-haze"></div><div class="cres-halo"></div><div class="cres-core"></div>'
    root.insertBefore(layers, root.firstChild)
    crescentMasks(size).then(({ urls }) => {
      for (const key of ['haze', 'halo', 'core']) {
        const node = layers.querySelector(`.cres-${key}`)
        if (node && urls[key]) {
          node.style.maskImage = `url(${urls[key]})`
          node.style.webkitMaskImage = `url(${urls[key]})`
        }
      }
      layers.dataset.ready = '1'
    }).catch(() => { /* leave it dark rather than paint three rectangles */ })
    return { el: layers, mode: 'cpu', redraw() {}, destroy() { layers.remove(); probe.remove() } }
  }

  let raf = 0
  let breathing = false
  const start = performance.now()

  function paint(now) {
    const cs = getComputedStyle(root)
    const colour = getComputedStyle(probe).backgroundColor
    const glow = num(cs, '--glow', 1)
    const dose = num(cs, '--cres-halo-o', 0.85)
    const sheetGain = num(cs, '--cres-gain', 1)
    const stateGain = num(cs, '--cres-state-gain', 1)
    const failure = root.dataset.load === 'peak' || root.dataset.load === 'failure'
    const quiet = document.body.classList.contains('reduce-motion')
    const breath = failure && !quiet ? 1 : 0

    corona.draw({
      scale: dpr,
      centre: [boxHalf, boxHalf],
      rim,
      unit: rim,
      color: cssColorToSrgb(colour),
      paper: cssColorToSrgb(getComputedStyle(document.body).backgroundColor),
      paperMode: !isDarkTheme(document.documentElement.dataset.theme),
      chroma: num(cs, '--cres-chroma', 0.35),
      gain: BASE_GAIN * glow * sheetGain * stateGain,
      hazeDose: dose,
      shape: SHAPE,
      time: ((now || performance.now()) - start) / 1000,
      breath,
    })
    return breath > 0
  }

  function loop(now) {
    const wants = paint(now)
    raf = wants ? requestAnimationFrame(loop) : 0
    breathing = !!raf
  }

  function redraw() {
    if (corona.lost) return
    /* An idle page must not burn CPU, so there is no standing animation frame.
       One paint on demand, and a loop only while the failure state is breathing
       and motion is allowed. */
    if (!breathing) { const wants = paint(); if (wants) { breathing = true; raf = requestAnimationFrame(loop) } }
  }

  /* Repaint every frame for a while. Used wherever the inputs change over time
     rather than at an instant: a slider being dragged, a theme swap and its
     colour transitions, the 1.4s state re-tint. Cheap because it is bounded and
     because an untouched page never enters it. */
  let settleUntil = 0
  function settle(ms = 500) {
    if (corona.lost) return
    settleUntil = Math.max(settleUntil, performance.now() + ms)
    if (raf) return
    const tick = (now) => {
      const breath = paint(now)
      if (breath || now < settleUntil) { raf = requestAnimationFrame(tick); breathing = breath }
      else { raf = 0; breathing = false }
    }
    raf = requestAnimationFrame(tick)
  }

  probe.addEventListener('transitionstart', () => settle(1600))
  probe.addEventListener('transitionend', () => settle(120))

  /* THE GLOW SLIDER. Both Settings and the quick-settings drawer apply it by
     writing an inline `--glow` onto the document element. A CSS custom property
     changing does not repaint a canvas — nothing in this file would ever hear
     about it — so before this observer the slider moved and the corona did not,
     which is precisely the "a setting that does not do anything" defect the
     house forbids. Watching the attribute rather than calling into either
     settings module keeps the coupling at zero and cannot be missed by a third
     caller appearing later. The same observer catches the theme swap, which
     changes the hue, the per-sheet gain and the blend mode together. */
  const rootObs = new MutationObserver(() => settle(700))
  rootObs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] })
  /* ...and reduced motion, which is a class on the body. */
  const bodyObs = new MutationObserver(() => settle(120))
  bodyObs.observe(document.body, { attributes: true, attributeFilter: ['class'] })

  /* The stored colour is only readable once styles have resolved -- and on a
     page that never gets a frame, "once styles have resolved" is NOW: this
     callback was one of the five that sat in the browser's queue for ever,
     holding this canvas and its GL context (+1 per lap of the ring,
     measured). onNextFrame draws immediately on such a page and takes the
     ordinary frame when there is going to be one. */
  onNextFrame(() => redraw())

  return {
    el: canvas,
    mode: 'gl',
    redraw,
    destroy() {
      if (raf) cancelAnimationFrame(raf)
      rootObs.disconnect()
      bodyObs.disconnect()
      corona.destroy()
      canvas.remove()
      probe.remove()
    },
  }
}
