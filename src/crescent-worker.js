/* Rasterises the crescent's three alpha planes off the main thread.
 *
 * The work is ~53ms at device scale 2 (measured on this machine, 1356x1356 per
 * layer). That is three dropped frames if it happens on the main thread while
 * the home view is mounting, which is exactly when it happens — so it happens
 * here instead. There is a synchronous fallback in crescent-render.js for when
 * a worker cannot be created; it produces identical pixels, just later.
 */

import { buildRadialTable, crescentSpec, rasterizeLayer } from './crescent-field.js'

self.onmessage = (e) => {
  const { id, size, scale } = e.data
  try {
    const spec = crescentSpec(size)
    const planes = {}
    const transfer = []
    for (const layer of spec.layers) {
      const img = rasterizeLayer(spec, layer, scale, buildRadialTable(spec, layer))
      /* A Uint8ClampedArray view cannot be transferred, only its buffer, and the
         buffer is exactly the plane here so there is nothing to copy. */
      planes[layer.key] = img.data
      transfer.push(img.data.buffer)
    }
    const first = planes[spec.layers[0].key]
    self.postMessage({
      id,
      ok: true,
      width: Math.round(spec.box.width * scale),
      height: Math.round(first.length / Math.round(spec.box.width * scale)),
      planes,
    }, transfer)
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) })
  }
}
