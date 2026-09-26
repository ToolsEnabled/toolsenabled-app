/* The production imports deliberately precede browser installation. Successful
 * mounts below therefore prove that browser globals are read by mountCrescent,
 * rather than while its module is evaluated. */

import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

import { BASE_GAIN, SHAPE, mountCrescent } from '../../src/crescent-mount.js'
import { crescentSpec } from '../../src/crescent-field.js'

const domModuleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(domModuleUrl)

function webgl(draws) {
  const constants = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    DEPTH_TEST: 5, BLEND: 6, ONE: 7, ONE_MINUS_SRC_ALPHA: 8,
    COLOR_BUFFER_BIT: 9, TRIANGLES: 10,
  }
  const gl = {
    ...constants,
    createShader: () => ({}), shaderSource() {}, compileShader() {},
    getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader() {},
    createProgram: () => ({}), attachShader() {}, linkProgram() {},
    getProgramParameter: () => true, getProgramInfoLog: () => '',
    getUniformLocation: (_program, name) => name,
    useProgram() {}, disable() {}, enable() {}, blendFunc() {}, viewport() {},
    clearColor() {}, clear() {}, uniform2f() {}, uniform3f() {},
    uniform1f(name, value) { if (name === 'uGain') draws.at(-1).gain = value; if (name === 'uBreath') draws.at(-1).breath = value },
    drawArrays() {}, getExtension: () => ({ loseContext() { gl.lost = true } }),
  }
  const originalClear = gl.clear
  gl.clear = (...args) => { draws.push({}); originalClear(...args) }
  return gl
}

function install({ gl = null, maskReadFails = false } = {}) {
  const installed = installDomStandIn(globalThis)
  const localNames = ['performance', 'getComputedStyle', 'Worker', 'devicePixelRatio']
  const previous = new Map(localNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const draws = []
  const frames = []
  const observers = []
  const computed = new Map()
  const { document } = installed
  document.visibilityState = 'visible'
  document.documentElement.dataset.theme = 'paper'
  window.devicePixelRatio = 1

  const contextProvider = (kind, _options) => {
    if (kind === 'webgl2') return gl || null
    if (kind === '2d' && maskReadFails) return { createImageData() { throw new Error(String(0)) } }
    return null
  }
  const createElement = document.createElement.bind(document)
  document.createElement = tag => {
    const element = createElement(tag)
    if (element.tagName === 'CANVAS') {
      element.getContext = (kind, options) => contextProvider(kind, options)
    }
    return element
  }

  globalThis.devicePixelRatio = 1
  globalThis.performance = { now: () => 0 }
  globalThis.getComputedStyle = element => ({
    backgroundColor: element === document.body ? 'rgb(0, 0, 0)' : element.classList.contains('cres-probe') ? 'rgba(0, 0, 0, 0)' : '',
    getPropertyValue: name => computed.get(name) ?? '',
  })
  globalThis.requestAnimationFrame = fn => { frames.push(fn); return frames.length }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.MutationObserver = class {
    constructor(fn) { this.fn = fn; this.disconnected = false; observers.push(this) }
    observe() {}
    disconnect() { this.disconnected = true }
  }

  return {
    document, draws, frames, observers, computed,
    restore() {
      installed.restore()
      for (const name of localNames) {
        const descriptor = previous.get(name)
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete globalThis[name]
      }
    },
  }
}

test('the caller size and live CSS state determine the mounted GPU corona', { concurrency: false }, () => {
  const draws = []
  const gl = webgl(draws)
  const env = install({ gl })
  try {
    const sizeSentinel = 317 // API input only; it does not represent shipped layout.
    const dpr = 1
    const spec = crescentSpec(sizeSentinel)
    const boxHalf = Math.ceil(spec.r * 1.72)
    const expectedBox = boxHalf * 2
    const glow = 0.5
    const sheetGain = 1.25
    const stateGain = 0.8
    env.computed.set('--glow', String(glow))
    env.computed.set('--cres-gain', String(sheetGain))
    env.computed.set('--cres-state-gain', String(stateGain))
    const root = env.document.createElement('div')

    const mounted = mountCrescent(root, sizeSentinel)
    const probe = root.querySelector('.cres-probe')
    assert.equal(mounted.mode, 'gl', 'a working WebGL2 context must select the GPU renderer')
    assert.equal(mounted.el.width, Math.round(expectedBox * dpr), 'canvas width must derive from the public geometry contract and DPR')
    assert.equal(mounted.el.height, Math.round(expectedBox * dpr), 'canvas height must derive from the public geometry contract and DPR')
    assert.ok(probe, 'mounting must insert the real colour probe')
    assert.equal(root.firstChild, probe, 'the probe must be inserted first')
    assert.equal(root.children[1], mounted.el, 'the mounted canvas must immediately follow the probe')
    assert.equal(env.frames.length, 1, 'mounting on a visible page must schedule exactly one initial draw')
    env.frames.shift()(100)

    assert.equal(draws.length, 1, 'the initial frame must paint the corona once')
    assert.equal(draws[0].gain, BASE_GAIN * glow * sheetGain * stateGain, 'gain must combine the supplied dimensionless CSS factors')
    assert.equal(draws[0].breath, 0, 'an ordinary load state must not start the failure animation')
    assert.ok(SHAPE.a1i < SHAPE.a1x && SHAPE.a2i < SHAPE.a2x, 'each corona band must fade across a non-empty angular interval')

    assert.ok(env.observers.length > 0, 'mounting must create at least one document observer')
    mounted.destroy()
    assert.equal(root.children.length, 0, 'destroy must remove every element the mount inserted')
    assert.ok(env.observers.every(observer => observer.disconnected), 'destroy must disconnect every document observer owned by the mount')
    assert.equal(gl.lost, true, 'destroy must release the WebGL context rather than retaining GPU resources')
  } finally {
    env.restore()
  }
})

test('a mask read failure remains an unknown dark fallback, not a definite painted answer', { concurrency: false }, async () => {
  const env = install({ maskReadFails: true })
  try {
    globalThis.Worker = class { constructor() { throw new Error(String(0)) } }
    const sizeSentinel = 137 // API input only; it does not represent shipped layout.
    const root = env.document.createElement('div')
    const mounted = mountCrescent(root, sizeSentinel)

    assert.equal(mounted.mode, 'cpu', 'a caller without WebGL2 must still receive the CPU fallback controller')
    assert.equal(mounted.el, root.querySelector('.cres-layers'), 'the parsed fallback container must be the mounted element')
    assert.equal(mounted.el.children.length, 3, 'the parsed fallback must contain exactly three layers')
    const layers = Object.fromEntries(['haze', 'halo', 'core'].map(key => [key, mounted.el.querySelector(`.cres-${key}`)]))
    for (const [key, layer] of Object.entries(layers)) assert.ok(layer, `the parsed fallback must contain its cres-${key} layer`)

    await new Promise(resolve => setImmediate(resolve))
    assert.equal(mounted.el.dataset.ready, undefined, 'an unreadable mask must not be marked ready as though it were a definite render')
    for (const [key, layer] of Object.entries(layers)) {
      assert.equal(layer.style.maskImage, undefined, `an unreadable ${key} mask must stay dark instead of painting an unmasked rectangle`)
    }

    mounted.destroy()
    assert.equal(root.children.length, 0, 'destroy must remove both fallback layers and their colour probe')
  } finally {
    env.restore()
  }
})
