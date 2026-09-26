import test from 'node:test'
import assert from 'node:assert/strict'
import { createDocument } from './lib/dom-stand-in.mjs'
import { HAND_CONTROLS_KEY, startHandControls } from '../../src/hand-controls.js'

const platforms = ['win32', 'linux', 'darwin', undefined]

function installMediaCapability() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const current = descriptor && globalThis.navigator
  const media = { getUserMedia() { throw new Error('the injected rejection must be used') } }

  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      writable: true,
      value: { mediaDevices: media },
    })
    return () => {
      if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
      else delete globalThis.navigator
    }
  } catch (error) {
    if (!current) throw error
    const mediaDescriptor = Object.getOwnPropertyDescriptor(current, 'mediaDevices')
    Object.defineProperty(current, 'mediaDevices', { configurable: true, writable: true, value: media })
    return () => {
      if (mediaDescriptor) Object.defineProperty(current, 'mediaDevices', mediaDescriptor)
      else delete current.mediaDevices
    }
  }
}

async function rejectedStart({ platform, errorName }) {
  const doc = createDocument()
  doc.baseURI = 'https://fixture.invalid/settings/'
  doc.visibilityState = 'visible'
  doc.hasFocus = () => true

  const originalCreateElement = doc.createElement.bind(doc)
  let pauses = 0
  doc.createElement = tag => {
    const element = originalCreateElement(tag)
    if (String(tag).toLowerCase() === 'video') {
      element.pause = () => { pauses++ }
      element.play = async () => {}
    }
    return element
  }

  const win = new EventTarget()
  const cameraCalls = []
  const storageValues = new Map()
  const storage = {
    getItem(key) { return storageValues.get(key) ?? null },
    setItem(key, value) { storageValues.set(key, String(value)) },
  }
  const camera = {
    async setEnabled(value) {
      cameraCalls.push(value)
      return { ok: true }
    },
  }
  let mediaCalls = 0
  let mediaOptions
  let workers = 0
  const states = []

  Object.assign(win, {
    mcSetup: { platform },
    mcHandControls: camera,
    Worker: class {},
    createImageBitmap() {},
    innerWidth: 1280,
    innerHeight: 800,
  })

  const controller = startHandControls({
    doc,
    win,
    storage,
    camera,
    isActive: () => true,
    createWorker() {
      workers++
      return { postMessage() {}, terminate() {} }
    },
    getMedia(options) {
      mediaCalls++
      mediaOptions = options
      const error = new Error('simulated camera refusal')
      error.name = errorName
      return Promise.reject(error)
    },
  })
  const unsubscribe = controller.subscribe(state => states.push({ ...state }))

  try {
    const result = await controller.setEnabled(true)
    const state = controller.getState()
    return {
      result,
      state,
      states,
      cameraCalls: [...cameraCalls],
      mediaCalls,
      mediaOptions,
      storage: storageValues.get(HAND_CONTROLS_KEY),
      workers,
      pauses,
      videoStillMounted: doc.body.children.some(child => child.className === 'hand-control-video'),
    }
  } finally {
    unsubscribe()
    controller.destroy()
  }
}

test('actual NotFoundError guidance uses Windows Camera only for a local win32 platform', async () => {
  const restoreNavigator = installMediaCapability()
  try {
    for (const platform of platforms) {
      const observed = await rejectedStart({ platform, errorName: 'NotFoundError' })
      assert.equal(observed.result.ok, false)
      assert.equal(observed.state.phase, 'error')
      assert.match(observed.state.message, /No camera is available/)
      if (platform === 'win32') {
        assert.equal(
          observed.state.message,
          'No camera is available. Connect a webcam and check Windows Camera, then try again.',
        )
      } else {
        assert.doesNotMatch(observed.state.message, /Windows Camera|Windows settings/i)
        assert.match(observed.state.message, /check that no other program is using it/)
      }
    }
  } finally {
    restoreNavigator()
  }
})

test('actual NotAllowedError guidance uses Windows settings only for a local win32 platform', async () => {
  const restoreNavigator = installMediaCapability()
  try {
    for (const platform of platforms) {
      const observed = await rejectedStart({ platform, errorName: 'NotAllowedError' })
      assert.equal(observed.result.ok, false)
      assert.equal(observed.state.phase, 'error')
      assert.match(observed.state.message, /Camera access was denied/)
      if (platform === 'win32') {
        assert.equal(
          observed.state.message,
          'Camera access was denied. Allow camera access for desktop apps in Windows settings, then try again.',
        )
      } else {
        assert.doesNotMatch(observed.state.message, /Windows Camera|Windows settings/i)
        assert.match(observed.state.message, /this computer/)
      }
    }
  } finally {
    restoreNavigator()
  }
})

test('camera rejection refuses the enable request, persists off, tears down the camera, and never starts a worker', async () => {
  const restoreNavigator = installMediaCapability()
  try {
    for (const errorName of ['NotFoundError', 'NotAllowedError']) {
      for (const platform of platforms) {
        const observed = await rejectedStart({ platform, errorName })
        assert.equal(observed.result.ok, false, platform + '/' + errorName + ' must refuse enable')
        assert.equal(observed.storage, 'false', platform + '/' + errorName + ' must persist hand controls off')
        assert.equal(observed.state.enabled, false)
        assert.equal(observed.state.stats, null)
        assert.deepEqual(observed.cameraCalls, [true, false], platform + '/' + errorName + ' must revoke camera admission')
        assert.equal(observed.mediaCalls, 1)
        assert.equal(observed.mediaOptions.audio, false)
        assert.equal(observed.workers, 0, platform + '/' + errorName + ' must not create a worker after media refusal')
        assert.equal(observed.videoStillMounted, false, platform + '/' + errorName + ' must remove the video element')
        assert.equal(observed.pauses, 1, platform + '/' + errorName + ' must pause the stopped video')
        assert.deepEqual(
          observed.states.map(state => state.phase),
          ['off', 'starting', 'error'],
          platform + '/' + errorName + ' must publish the real refusal transition',
        )
      }
    }
  } finally {
    restoreNavigator()
  }
})
