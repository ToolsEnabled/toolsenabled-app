/* Turns the crescent's computed light field into three CSS mask images.
 *
 * The division of labour matters and is deliberate: this file produces
 * INTENSITY only, as an alpha mask per layer. Colour never comes near it. The
 * per-theme hue table in home.css keeps painting `--load-col` on plain elements
 * behind these masks, so its measured contrast ratios, its `--cres-halo-o`
 * dose, the `--glow` slider, the 1.4s state transition and the reduced-motion
 * rule all keep working exactly as written. Three layers stay three layers for
 * the same reason: the black sheet doses haze and halo down while leaving the
 * core alone, and folding them would quietly dim that theme.
 *
 * Results are cached per (size, scale) because the field depends on nothing
 * else — not the theme, not the load state, not the clock.
 */

import { crescentSpec, buildRadialTable, rasterizeLayer } from './crescent-field.js'

const cache = new Map()
let worker = null
let workerBroken = false
let nextId = 1
const pending = new Map()

function getWorker() {
  if (workerBroken) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./crescent-worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
      const entry = pending.get(e.data.id)
      if (!entry) return
      pending.delete(e.data.id)
      e.data.ok ? entry.resolve(e.data) : entry.reject(new Error(e.data.error))
    }
    worker.onerror = () => {
      /* One failure retires the worker for the session and everything falls
         back to the synchronous path. Identical pixels, just on the main
         thread — a slower hero beats no hero. */
      workerBroken = true
      for (const [, entry] of pending) entry.reject(new Error('crescent worker failed'))
      pending.clear()
      try { worker.terminate() } catch { /* already gone */ }
      worker = null
    }
  } catch {
    workerBroken = true
    return null
  }
  return worker
}

function rasteriseInWorker(size, scale) {
  const w = getWorker()
  if (!w) return null
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ id, size, scale })
  })
}

function rasteriseHere(size, scale) {
  const spec = crescentSpec(size)
  const planes = {}
  for (const layer of spec.layers) {
    planes[layer.key] = rasterizeLayer(spec, layer, scale, buildRadialTable(spec, layer)).data
  }
  return {
    width: Math.round(spec.box.width * scale),
    height: Math.round(spec.box.height * scale),
    planes,
  }
}

/** An alpha plane becomes an image whose RGB is irrelevant and whose alpha is
 *  the light. `mask-image` on a bitmap reads the alpha channel, so white pixels
 *  at varying alpha are exactly the right thing to hand it. */
function planeToBlobUrl(plane, width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(width, height)
  const d = img.data
  for (let i = 0, p = 0; i < plane.length; i++, p += 4) {
    d[p] = 255; d[p + 1] = 255; d[p + 2] = 255; d[p + 3] = plane[i]
  }
  ctx.putImageData(img, 0, 0)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(URL.createObjectURL(blob))
        return
      }
      const error = new Error('The browser could not encode a crescent mask; this is not claiming the mask is absent.')
      error.code = 'CRESCENT_MASK_ENCODE_UNKNOWN'
      reject(error)
    }, 'image/png')
  })
}

/**
 * Mask URLs and the box they are drawn in, for a ring of `size` CSS pixels.
 *
 * Resolves to { box, urls: { haze, halo, core } }. The box is in `.uring`
 * coordinates and is the same for all three, so one position rule places them.
 */
export function crescentMasks(size, scale = (globalThis.devicePixelRatio || 1)) {
  const key = `${size}@${scale}`
  const hit = cache.get(key)
  if (hit) return hit

  const spec = crescentSpec(size)
  const job = (async () => {
    let raster = null
    try {
      raster = await rasteriseInWorker(size, scale)
    } catch {
      raster = null
    }
    if (!raster) raster = rasteriseHere(size, scale)

    const urls = {}
    for (const layer of spec.layers) {
      urls[layer.key] = await planeToBlobUrl(raster.planes[layer.key], raster.width, raster.height)
    }
    return { box: spec.box, spec, urls }
  })()

  cache.set(key, job)
  job.catch(() => {
    /* A failed job says only that this attempt could not render the masks. Do
       not let that uncertainty become the answer for the rest of the page. */
    if (cache.get(key) === job) cache.delete(key)
  })
  return job
}

/** Release every cached mask. The blobs are held by the document for as long as
 *  their URLs exist, so a long-lived app that never revoked them would leak a
 *  few megabytes per distinct ring size. */
export function releaseCrescentMasks() {
  for (const [, job] of cache) {
    Promise.resolve(job).then(r => {
      for (const url of Object.values(r.urls)) if (url) URL.revokeObjectURL(url)
    }).catch(() => { /* never resolved; nothing to revoke */ })
  }
  cache.clear()
}
