import test from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceAudioVisualizer, VOICE_VISUALIZER_BAR_COUNT } from '../../src/voice-audio-visualizer.js'

class Events {
  listeners = new Map()
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(callback)
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback) }
  dispatch(type) { for (const callback of [...this.listeners.get(type) || []]) callback() }
  listenerCount() { return [...this.listeners.values()].reduce((total, set) => total + set.size, 0) }
}

function stream(sample = () => 0) {
  const track = Object.assign(new Events(), { readyState: 'live', enabled: true, muted: false, stops: 0 })
  track.stop = () => { track.stops++; track.readyState = 'ended' }
  return { sample, track, getAudioTracks: () => [track] }
}

function harness(options = {}) {
  const frames = [], contexts = [], pending = new Map(), canceled = [], observers = []
  const documentRef = Object.assign(new Events(), { hidden: false, visibilityState: 'visible' })
  const classes = new Set()
  documentRef.body = { classList: { contains: name => classes.has(name) } }
  documentRef.defaultView = {
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.connected = false; observers.push(this) }
      observe(target, config) { this.connected = true; this.target = target; this.config = config }
      disconnect() { this.connected = false }
    },
  }
  const mediaQuery = Object.assign(new Events(), { matches: false })
  let nextHandle = 0
  function makeContext() {
    if (options.createError) throw Error('AudioContext unavailable')
    const context = Object.assign(new Events(), {
      state: options.suspended ? 'suspended' : 'running',
      destination: {}, nodes: [], analysers: [], closeCalls: 0, resumeCalls: 0, suspendCalls: 0,
      close() {
        this.closeCalls++
        this.state = 'closed'
        this.dispatch('statechange')
        return options.close?.(this) || Promise.resolve()
      },
      resume() {
        this.resumeCalls++
        if (options.resume) return options.resume(this)
        this.state = 'running'
        this.dispatch('statechange')
        return Promise.resolve()
      },
      suspend() {
        this.suspendCalls++
        if (options.suspend) return options.suspend(this)
        this.state = 'suspended'
        this.dispatch('statechange')
        return Promise.resolve()
      },
      createMediaStreamSource(value) {
        if (options.sourceError) throw Error('Source unavailable')
        const node = {
          stream: value, connections: [], disconnectCalls: 0,
          connect(target) {
            assert.notEqual(target, context.destination, 'observation must never create playback')
            this.connections.push(target)
            target.stream = value
            if (options.connectError) throw Error('Cannot connect')
          },
          disconnect() { this.disconnectCalls++; this.connections.length = 0 },
        }
        context.nodes.push(node)
        return node
      },
      createAnalyser() {
        if (options.analyserError) throw Error('Analyser unavailable')
        const analyser = {
          fftSize: 0, smoothingTimeConstant: 1, reads: 0, disconnectCalls: 0,
          getFloatTimeDomainData(samples) {
            this.reads++
            if (this.stream.readError) throw Error('Source stopped')
            assert.equal(samples.length, this.fftSize)
            for (let index = 0; index < samples.length; index++) samples[index] = this.stream.sample(index)
          },
          disconnect() { this.disconnectCalls++ },
        }
        context.analysers.push(analyser)
        return analyser
      },
    })
    contexts.push(context)
    return context
  }
  const visualizer = createVoiceAudioVisualizer({
    documentRef,
    matchMedia: query => { assert.equal(query, '(prefers-reduced-motion: reduce)'); return mediaQuery },
    createContext: makeContext,
    onFrame: levels => { frames.push([...levels]); options.onFrame?.(levels) },
    schedule(callback, delay) {
      assert.ok(delay >= 1000 / 30, 'sample no more than 30 frames per second')
      const handle = ++nextHandle
      pending.set(handle, callback)
      return handle
    },
    cancel(handle) { canceled.push(pending.get(handle)); pending.delete(handle) },
  })
  return {
    visualizer, frames, contexts, documentRef, mediaQuery, pending, canceled, observers,
    tick() {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback()
    },
    reduceMotion(value) {
      if (value) classes.add('reduce-motion'); else classes.delete('reduce-motion')
      for (const observer of observers) if (observer.connected) observer.callback()
    },
    latest: () => frames.at(-1),
  }
}

const silence = levels => assert.deepEqual(levels, Array(VOICE_VISUALIZER_BAR_COUNT).fill(0))
const flushPromises = async () => { await Promise.resolve(); await Promise.resolve() }

test('no context, media acquisition, or frame loop before an explicit audio stream', () => {
  const h = harness()
  h.visualizer.setMuted(false)
  h.visualizer.setPlaybackActive(true)
  h.visualizer.setInputStream(null)
  h.visualizer.setOutputStream({ getAudioTracks: () => [] })
  assert.equal(h.contexts.length, 0)
  assert.equal(h.pending.size, 0)
  silence(h.latest())
  h.visualizer.destroy()
})

test('silence is exactly zero; deterministic audio samples produce bounded RMS bars', () => {
  const h = harness(), input = stream()
  h.visualizer.setInputStream(input)
  assert.equal(h.contexts.length, 1)
  assert.equal(h.pending.size, 1)
  h.tick()
  silence(h.latest())
  input.sample = () => 0.1
  h.tick()
  assert.equal(h.latest().length, 12)
  for (const value of h.latest()) assert.ok(Math.abs(value - 0.3) < 0.000001)
  input.sample = index => Math.sin(index * Math.PI / 19) * 0.4
  h.tick()
  assert.ok(h.latest().every(value => value > 0 && value <= 1))
  assert.ok(new Set(h.latest()).size > 1, 'bars use their real sample windows')
  input.sample = () => 10
  h.tick()
  assert.ok(h.latest().every(value => value === 1))
  input.sample = () => 0
  h.tick()
  silence(h.latest())
  assert.equal(h.contexts[0].analysers[0].fftSize, 256)
  assert.equal(h.contexts[0].analysers[0].smoothingTimeConstant, 0)
  assert.deepEqual(h.contexts[0].nodes[0].connections, [h.contexts[0].analysers[0]])
  h.visualizer.destroy()
  assert.equal(input.track.stops, 0)
})

test('microphone mute suppresses input while received output requires actual playback', async () => {
  const h = harness(), input = stream(() => 0.1), output = stream(() => 0.2)
  h.visualizer.setInputStream(input)
  h.visualizer.setOutputStream(output)
  h.tick()
  assert.ok(Math.abs(h.latest()[0] - 0.3) < 0.000001)
  assert.equal(h.contexts[0].analysers[1].reads, 0)
  h.visualizer.setMuted(true)
  silence(h.latest())
  assert.equal(h.pending.size, 0)
  assert.equal(h.contexts[0].state, 'suspended')
  h.visualizer.setPlaybackActive(true)
  await flushPromises()
  h.tick()
  assert.ok(Math.abs(h.latest()[0] - 0.6) < 0.000001)
  assert.equal(h.contexts[0].analysers[0].reads, 1, 'muted input is not sampled')
  h.visualizer.setPlaybackActive(false)
  silence(h.latest())
  assert.equal(h.pending.size, 0)
  assert.equal(h.contexts[0].state, 'suspended')
  h.visualizer.setMuted(false)
  await flushPromises()
  h.tick()
  assert.ok(Math.abs(h.latest()[0] - 0.3) < 0.000001)
  h.visualizer.destroy()
  assert.equal(input.track.stops + output.track.stops, 0)
})

test('both hidden documents and both reduced-motion controls suspend rendering and safely resume', async () => {
  const h = harness()
  h.visualizer.setInputStream(stream(() => 0.15))
  h.tick()
  assert.ok(h.latest()[0] > 0)
  let pauses = 0
  for (const [pause, resume] of [
    [() => { h.documentRef.hidden = true; h.documentRef.dispatch('visibilitychange') },
      () => { h.documentRef.hidden = false; h.documentRef.dispatch('visibilitychange') }],
    [() => { h.mediaQuery.matches = true; h.mediaQuery.dispatch('change') },
      () => { h.mediaQuery.matches = false; h.mediaQuery.dispatch('change') }],
    [() => h.reduceMotion(true), () => h.reduceMotion(false)],
  ]) {
    pause()
    pauses++
    assert.equal(h.pending.size, 0)
    silence(h.latest())
    assert.equal(h.contexts[0].state, 'suspended')
    assert.equal(h.contexts[0].suspendCalls, pauses)
    const reads = h.contexts[0].analysers[0].reads
    h.tick()
    assert.equal(h.contexts[0].analysers[0].reads, reads)
    resume()
    await flushPromises()
    assert.equal(h.contexts[0].state, 'running')
    assert.equal(h.contexts[0].resumeCalls, pauses)
    assert.equal(h.pending.size, 1)
    h.tick()
    assert.ok(h.latest()[0] > 0)
  }
  h.visualizer.destroy()
})

test('an already-muted track stays still until its real unmute event', async () => {
  const h = harness(), input = stream(() => 0.15)
  input.track.muted = true
  h.visualizer.setInputStream(input)
  silence(h.latest())
  assert.equal(h.pending.size, 0)
  input.track.muted = false
  input.track.dispatch('unmute')
  await flushPromises()
  h.tick()
  assert.ok(h.latest()[0] > 0)
  input.track.muted = true
  input.track.dispatch('mute')
  silence(h.latest())
  assert.equal(h.pending.size, 0)
  h.visualizer.destroy()
})

test('ending and replacing tracks detach nodes and listeners without stopping owned media', () => {
  const h = harness(), first = stream(() => 0.1), replacement = stream(() => 0.2)
  h.visualizer.setInputStream(first)
  const context = h.contexts[0]
  h.visualizer.setInputStream(replacement)
  assert.equal(first.track.listenerCount(), 0)
  assert.equal(context.nodes[0].disconnectCalls, 1)
  assert.equal(context.analysers[0].disconnectCalls, 1)
  assert.equal(context.closeCalls, 0)
  h.tick()
  assert.ok(Math.abs(h.latest()[0] - 0.6) < 0.000001)
  replacement.track.readyState = 'ended'
  replacement.track.dispatch('ended')
  silence(h.latest())
  assert.equal(context.closeCalls, 1)
  assert.equal(context.nodes[1].disconnectCalls, 1)
  assert.equal(context.analysers[1].disconnectCalls, 1)
  assert.equal(replacement.track.listenerCount(), 0)
  assert.equal(h.pending.size, 0)
  assert.equal(first.track.stops + replacement.track.stops, 0)
  h.visualizer.destroy()
})

test('ending reply audio leaves an independently live microphone intact', () => {
  const h = harness(), input = stream(() => 0.1), output = stream(() => 0.2)
  h.visualizer.setInputStream(input)
  h.visualizer.setOutputStream(output)
  h.visualizer.setPlaybackActive(true)
  output.track.readyState = 'ended'
  output.track.dispatch('ended')
  h.tick()
  assert.ok(Math.abs(h.latest()[0] - 0.3) < 0.000001)
  assert.equal(h.contexts[0].closeCalls, 0)
  assert.equal(output.track.listenerCount(), 0)
  h.visualizer.destroy()
})

test('stop closes and disconnects all resources, rejects canceled callbacks, and is reusable', () => {
  const h = harness(), input = stream(() => 0.1), output = stream(() => 0.2)
  h.visualizer.setInputStream(input)
  h.visualizer.setOutputStream(output)
  h.visualizer.setPlaybackActive(true)
  h.tick()
  const lateCallback = [...h.pending.values()][0]
  const first = h.contexts[0]
  h.visualizer.stop()
  silence(h.latest())
  assert.equal(h.pending.size, 0)
  assert.equal(first.closeCalls, 1)
  for (const node of [...first.nodes, ...first.analysers]) assert.equal(node.disconnectCalls, 1)
  assert.equal(first.listenerCount() + input.track.listenerCount() + output.track.listenerCount(), 0)
  lateCallback()
  silence(h.latest())
  assert.equal(h.pending.size, 0)
  h.visualizer.setInputStream(input)
  h.tick()
  assert.ok(h.latest()[0] > 0)
  assert.equal(h.contexts.length, 2)
  h.visualizer.destroy()
  assert.equal(h.contexts[1].closeCalls, 1)
  assert.equal(input.track.stops + output.track.stops, 0)
})

test('destroy removes document, motion, and stream listeners and cannot restart', () => {
  const h = harness(), input = stream(() => 0.1)
  h.visualizer.setInputStream(input)
  h.visualizer.destroy()
  h.visualizer.destroy()
  assert.equal(h.documentRef.listenerCount() + h.mediaQuery.listenerCount() + input.track.listenerCount(), 0)
  assert.ok(h.observers.every(observer => !observer.connected))
  h.visualizer.setInputStream(input)
  h.visualizer.setOutputStream(input)
  h.visualizer.setMuted(false)
  h.visualizer.setPlaybackActive(true)
  assert.equal(h.contexts.length, 1)
  assert.equal(h.pending.size, 0)
  silence(h.latest())
})

test('late resume and close settlements cannot revive a stopped context or close its replacement', async () => {
  let finishResume, finishClose
  const h = harness({
    suspended: true,
    resume: context => new Promise(resolve => { finishResume = () => { context.state = 'running'; resolve() } }),
    close: () => new Promise(resolve => { finishClose = resolve }),
  })
  h.visualizer.setInputStream(stream(() => 0.1))
  const oldResume = finishResume, oldCloseContext = h.contexts[0]
  assert.equal(h.pending.size, 0)
  h.visualizer.stop()
  const oldClose = finishClose
  h.visualizer.setInputStream(stream(() => 0.2))
  const replacementResume = finishResume
  oldResume()
  oldClose()
  await flushPromises()
  assert.equal(h.pending.size, 0)
  assert.equal(oldCloseContext.closeCalls, 1)
  assert.equal(h.contexts[1].closeCalls, 0)
  replacementResume()
  await flushPromises()
  h.tick()
  assert.ok(Math.abs(h.latest()[0] - 0.6) < 0.000001)
  h.visualizer.destroy()
  finishClose()
  await flushPromises()
  assert.equal(h.pending.size, 0)
})

test('a late suspend finishes before resuming newly visible audio', async () => {
  let finishSuspend
  const h = harness({
    suspend: context => new Promise(resolve => {
      finishSuspend = () => { context.state = 'suspended'; context.dispatch('statechange'); resolve() }
    }),
  })
  h.visualizer.setInputStream(stream(() => 0.1))
  const context = h.contexts[0]
  h.reduceMotion(true)
  h.reduceMotion(false)
  h.documentRef.dispatch('visibilitychange')
  assert.equal(context.suspendCalls, 1)
  assert.equal(context.resumeCalls, 0, 'resume must wait for the pending suspend')
  assert.equal(h.pending.size, 0)
  silence(h.latest())
  finishSuspend()
  await flushPromises()
  assert.equal(context.resumeCalls, 1)
  assert.equal(context.state, 'running')
  assert.equal(h.pending.size, 1)
  h.tick()
  assert.ok(h.latest()[0] > 0)
  h.visualizer.destroy()
})

test('a late resume is immediately followed by suspension if the document became hidden', async () => {
  let finishResume
  const h = harness({
    suspended: true,
    resume: context => new Promise(resolve => {
      finishResume = () => { context.state = 'running'; context.dispatch('statechange'); resolve() }
    }),
  })
  h.visualizer.setInputStream(stream(() => 0.1))
  const context = h.contexts[0]
  h.documentRef.hidden = true
  h.documentRef.dispatch('visibilitychange')
  assert.equal(context.suspendCalls, 0, 'suspend must wait for the pending resume')
  finishResume()
  await flushPromises()
  assert.equal(context.suspendCalls, 1)
  assert.equal(context.state, 'suspended')
  assert.equal(h.pending.size, 0)
  assert.equal(context.analysers[0].reads, 0)
  silence(h.latest())
  h.visualizer.destroy()
})

test('late suspend settlements after stop cannot affect a replacement context', async () => {
  for (const rejected of [false, true]) {
    let settleSuspend
    const h = harness({
      suspend: context => new Promise((resolve, reject) => {
        settleSuspend = () => {
          if (rejected) reject(Error('Old context already closed'))
          else { context.state = 'suspended'; context.dispatch('statechange'); resolve() }
        }
      }),
    })
    h.visualizer.setInputStream(stream(() => 0.1))
    h.reduceMotion(true)
    h.visualizer.stop()
    h.reduceMotion(false)
    h.visualizer.setInputStream(stream(() => 0.2))
    settleSuspend()
    await flushPromises()
    assert.equal(h.contexts[0].closeCalls, 1)
    assert.equal(h.contexts[1].closeCalls, 0)
    assert.equal(h.contexts[1].suspendCalls + h.contexts[1].resumeCalls, 0)
    assert.equal(h.pending.size, 1)
    h.tick()
    assert.ok(Math.abs(h.latest()[0] - 0.6) < 0.000001)
    h.visualizer.destroy()
  }
})

test('suspend rejection and synchronous failure close only observation resources', async () => {
  for (const synchronous of [false, true]) {
    const input = stream(() => 0.1), output = stream(() => 0.2)
    const h = harness({
      suspend: () => {
        if (synchronous) throw Error('Suspend failed')
        return Promise.reject(Error('Suspend failed'))
      },
    })
    h.visualizer.setInputStream(input)
    h.visualizer.setOutputStream(output)
    assert.doesNotThrow(() => h.reduceMotion(true))
    await flushPromises()
    silence(h.latest())
    assert.equal(h.pending.size, 0)
    assert.equal(h.contexts[0].closeCalls, 1)
    for (const node of [...h.contexts[0].nodes, ...h.contexts[0].analysers]) assert.equal(node.disconnectCalls, 1)
    assert.equal(input.track.stops + output.track.stops, 0)
    assert.equal(input.track.readyState, 'live')
    assert.equal(output.track.readyState, 'live')
    h.visualizer.destroy()
  }
})

test('a resume that remains interrupted does not spin and can recover on a real state change', async () => {
  const h = harness({ suspended: true, resume: () => Promise.resolve() })
  h.visualizer.setInputStream(stream(() => 0.1))
  for (let turn = 0; turn < 5; turn++) await flushPromises()
  assert.equal(h.contexts[0].resumeCalls, 1)
  assert.equal(h.pending.size, 0)
  silence(h.latest())
  h.contexts[0].state = 'running'
  h.contexts[0].dispatch('statechange')
  h.tick()
  assert.ok(h.latest()[0] > 0)
  assert.equal(h.contexts[0].resumeCalls, 1)
  h.visualizer.destroy()
})

test('resume rejection is isolated and releases the observer context', async () => {
  const h = harness({ suspended: true, resume: () => Promise.reject(Error('Blocked')) })
  const input = stream(() => 0.1)
  assert.doesNotThrow(() => h.visualizer.setInputStream(input))
  await flushPromises()
  silence(h.latest())
  assert.equal(h.pending.size, 0)
  assert.equal(h.contexts[0].closeCalls, 1)
  assert.equal(input.track.listenerCount(), 0)
  assert.equal(input.track.stops, 0)
  h.visualizer.destroy()
})

test('context, node, and connection failures leave zero levels without affecting voice tracks', () => {
  for (const failure of ['createError', 'sourceError', 'analyserError', 'connectError']) {
    const h = harness({ [failure]: true }), input = stream(() => 0.1)
    assert.doesNotThrow(() => h.visualizer.setInputStream(input))
    silence(h.latest())
    assert.equal(h.pending.size, 0)
    for (const context of h.contexts) {
      assert.equal(context.closeCalls, 1)
      for (const node of [...context.nodes, ...context.analysers]) assert.ok(node.disconnectCalls >= 1)
    }
    assert.equal(input.track.stops, 0)
    assert.equal(input.track.listenerCount(), 0)
    h.visualizer.destroy()
  }
})

test('read failures detach only the failing stream while the remaining audio is observed', () => {
  const h = harness(), input = stream(() => 0.1), output = stream(() => 0.2)
  input.readError = true
  h.visualizer.setInputStream(input)
  h.visualizer.setOutputStream(output)
  h.visualizer.setPlaybackActive(true)
  assert.doesNotThrow(() => h.tick())
  assert.ok(Math.abs(h.latest()[0] - 0.6) < 0.000001)
  assert.equal(input.track.listenerCount(), 0)
  assert.equal(h.contexts[0].closeCalls, 0)
  output.readError = true
  assert.doesNotThrow(() => h.tick())
  silence(h.latest())
  assert.equal(h.pending.size, 0)
  assert.equal(h.contexts[0].closeCalls, 1)
  h.visualizer.destroy()
})

test('callback and asynchronous close failures never escape into the voice owner', async () => {
  const h = harness({
    onFrame: () => { throw Error('Detached UI') },
    close: () => Promise.reject(Error('Context already closing')),
  })
  assert.doesNotThrow(() => h.visualizer.setInputStream(stream(() => 0.1)))
  assert.doesNotThrow(() => h.tick())
  assert.doesNotThrow(() => h.visualizer.stop())
  await flushPromises()
  assert.equal(h.pending.size, 0)
  assert.doesNotThrow(() => h.visualizer.destroy())
})
