/* Classic worker: MediaPipe's WASM loader uses importScripts. No network
 * endpoints are used at runtime; the versioned assets ship with the app. */
let tracker
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      importScripts('./vendor/vision_bundle.js')
      const canvas = new OffscreenCanvas(640, 480)
      tracker = await Vision.HandLandmarker.createFromOptions({
        wasmLoaderPath: new URL('./vendor/vision_wasm_internal.js', self.location.href).href,
        wasmBinaryPath: new URL('./vendor/vision_wasm_internal.wasm', self.location.href).href,
      }, {
        baseOptions: {
          modelAssetPath: new URL('./vendor/hand_landmarker.task', self.location.href).href,
          delegate: 'GPU',
        },
        canvas,
        runningMode: 'VIDEO', numHands: 1,
        minHandDetectionConfidence: 0.65, minHandPresenceConfidence: 0.65, minTrackingConfidence: 0.65,
      })
      const gl = canvas.getContext('webgl2')
      const debug = gl?.getExtension('WEBGL_debug_renderer_info')
      self.postMessage({ type: 'ready', delegate: 'GPU', renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unavailable' })
    } catch (error) { self.postMessage({ type: 'error', message: String(error.message) }) }
  } else if (data.type === 'frame') {
    const started = performance.now()
    try {
      if (!tracker) throw new Error('Hand tracker is not ready')
      const result = tracker.detectForVideo(data.frame, data.at)
      self.postMessage({ type: 'result', at: data.at, ms: performance.now() - started,
        landmarks: result.landmarks[0] || null,
        hand: result.handedness[0]?.[0]?.categoryName || '' })
    } catch (error) { self.postMessage({ type: 'error', message: String(error.message) }) }
    finally { data.frame?.close() }
  }
}
