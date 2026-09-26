import test from 'node:test'
import assert from 'node:assert/strict'

import { createCorona, cssColorToSrgb } from '../../src/corona-gl.js'

function fakeSurface({ shaderCompiles = true } = {}) {
  const calls = []
  const listeners = new Map()
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    DEPTH_TEST: 5, BLEND: 6, ONE: 7, ONE_MINUS_SRC_ALPHA: 8,
    COLOR_BUFFER_BIT: 9, TRIANGLES: 10,
    createShader: type => ({ type }),
    shaderSource() {}, compileShader() {},
    getShaderParameter: () => shaderCompiles,
    getShaderInfoLog: () => 'driver could not compile it',
    deleteShader() {}, createProgram: () => ({}), attachShader() {}, linkProgram() {},
    getProgramParameter: () => true, getProgramInfoLog: () => '',
    getUniformLocation: (_program, name) => name,
    useProgram() {}, disable() {}, enable() {}, blendFunc() {},
    viewport: (...args) => calls.push(['viewport', ...args]),
    clearColor() {}, clear() {},
    uniform2f: (name, ...values) => calls.push([name, ...values]),
    uniform1f: (name, value) => calls.push([name, value]),
    uniform3f: (name, ...values) => calls.push([name, ...values]),
    drawArrays: (...args) => calls.push(['drawArrays', ...args]),
    getExtension: () => ({ loseContext: () => calls.push(['loseContext']) }),
  }
  const canvas = {
    width: 640,
    height: 360,
    getContext(type, options) {
      calls.push(['getContext', type, options])
      return gl
    },
    addEventListener(name, listener) { listeners.set(name, listener) },
  }
  return { canvas, calls, listeners }
}

const valueOf = (calls, uniform) => calls.findLast(call => call[0] === uniform)?.slice(1)

test('CSS colours used by the crescent retain their sRGB channel values', () => {
  assert.deepEqual(cssColorToSrgb('#427b58'), [66 / 255, 123 / 255, 88 / 255],
    'hex theme colour channels must reach the shader without a second transfer curve')
  assert.deepEqual(cssColorToSrgb('rgb(150, 96, 15)'), [150 / 255, 96 / 255, 15 / 255],
    'computed rgb() theme colour channels must reach the shader')
})

test('no WebGL2 reading remains an unknown renderer result so the caller can fall back', () => {
  const canvas = { getContext: () => null }
  assert.equal(createCorona(canvas), null,
    'an unavailable WebGL2 context must return null rather than claim a renderer exists')
})

test('a shader the driver cannot read is refused without exposing a broken renderer', () => {
  const { canvas } = fakeSurface({ shaderCompiles: false })
  const warnings = []
  const originalWarn = console.warn
  console.warn = value => warnings.push(value)
  try {
    assert.equal(createCorona(canvas), null,
      'a shader compile failure must return null so the caller selects its CPU fallback')
  } finally {
    console.warn = originalWarn
  }
  assert.equal(warnings.length, 1, 'the refused GPU renderer must leave one diagnostic')
  assert.match(String(warnings[0]), /corona shader:.*could not compile it/,
    'the shader refusal diagnostic must retain the driver reason')
})

test('a transient GL setup failure is not reported or latched as WebGL absence', () => {
  const { canvas } = fakeSurface()
  const getContext = canvas.getContext
  let attempts = 0
  canvas.getContext = function (...args) {
    const gl = getContext.apply(this, args)
    gl.createProgram = () => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('GPU driver busy'), { code: 'EBUSY' })
      return {}
    }
    return gl
  }

  assert.throws(() => createCorona(canvas), error => {
    assert.equal(error.code, 'CORONA_GL_COULD_NOT_TELL')
    assert.equal(error.cause.code, 'EBUSY', 'the machine failure must remain available to diagnostics')
    assert.match(error.message, /does not claim that it is absent/)
    return true
  }, 'an indeterminate setup failure must not become the definite null fallback answer')
  assert.ok(createCorona(canvas), 'the indeterminate result must not be cached or latched; a retry must perform setup again')
  assert.equal(attempts, 2, 'both attempts must pay the setup cost because this module has no availability cache')
})

test('draw sends caller geometry, colour, and stable defaults to one GPU draw', () => {
  const { canvas, calls } = fakeSurface()
  const corona = createCorona(canvas)
  assert.ok(corona, 'a working WebGL2 context must produce a renderer')

  assert.equal(corona.draw({
    scale: 2,
    centre: [160, 170],
    rim: 91,
    unit: 91,
    color: [0.2, 0.4, 0.6],
    gain: 2.4,
    shape: { h0: .012, h1: .026, h2: .09, w1: .72, w2: .28, a1i: .4, a1x: .8, a2i: .5, a2x: 1 },
  }), true, 'a live renderer must report that it drew the requested frame')

  assert.deepEqual(valueOf(calls, 'uRes'), [640, 360], 'the shader resolution must match the drawing buffer')
  assert.deepEqual(valueOf(calls, 'uCentre'), [160, 170], 'the caller-selected ring centre must reach the shader')
  assert.deepEqual(valueOf(calls, 'uColor'), [0.2, 0.4, 0.6], 'the caller-selected status colour must reach the shader')
  assert.deepEqual(valueOf(calls, 'uHazeDose'), [0.85], 'an omitted haze dose must use the approved default')
  assert.deepEqual(valueOf(calls, 'uPaper'), [1, 1, 1], 'an omitted paper colour must remain neutral white')
  assert.deepEqual(valueOf(calls, 'uChroma'), [0.35], 'an omitted paper chroma must use the approved default')
  assert.deepEqual(calls.filter(call => call[0] === 'drawArrays'), [['drawArrays', 10, 0, 3]],
    'each frame must render the corona triangle exactly once')
})

test('context loss stops definite draw answers and destroy releases the context', () => {
  const { canvas, calls, listeners } = fakeSurface()
  const corona = createCorona(canvas)
  let prevented = false
  listeners.get('webglcontextlost')({ preventDefault() { prevented = true } })

  assert.equal(prevented, true, 'context loss must be claimed so the page can keep its fallback state')
  assert.equal(corona.lost, true, 'the renderer must expose context loss to its real caller')
  assert.equal(corona.draw({}), false, 'a lost context must not report that a frame was drawn')
  assert.equal(calls.some(call => call[0] === 'drawArrays'), false,
    'a lost context must not issue a GPU draw')
  corona.destroy()
  assert.equal(calls.some(call => call[0] === 'loseContext'), true,
    'destroy must release the WebGL context when the extension is available')
})
