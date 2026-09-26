import test from 'node:test'
import assert from 'node:assert/strict'
import { mountHomeChatLayout } from '../../src/home-chat-layout.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

// Exercise the real layout and takeover against supplied workspace dimensions.
// This stand-in does not measure CSS, composer fit, or native focus/paint.
function fixture(width, height) {
  const dom = installDomStandIn()
  const dimensions = { width, height }, observers = [], mounts = new Map(), released = []
  const create = dom.document.createElement.bind(dom.document)
  dom.document.createElement = tag => {
    const node = create(tag)
    Object.defineProperties(node, {
      clientWidth: { get: () => node.className === 'home-chat-layout' ? dimensions.width : 0 },
      clientHeight: { get: () => node.className === 'home-chat-layout' ? dimensions.height : 0 },
    })
    return node
  }
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe(target) { this.target = target }
    disconnect() { this.target = null }
  }
  const surface = create('section'), host = create('div')
  const tabs = create('div'); tabs.className = 'home-chat-pane-tabs'
  surface.append(tabs, host)
  for (const key of ['commands', 'new', 'arrange', 'layout']) {
    const control = create(key === 'layout' ? 'select' : 'button')
    control.setAttribute(`data-chat-${key}`, '')
    surface.appendChild(control)
  }
  dom.document.body.appendChild(surface)
  const choices = Array.from({ length: 4 }, (_, index) => ({
    id: `agent:fixture:${index}`, kind: 'agent', agentId: String(index),
    computerId: 'fixture', treeNode: true, label: `Conversation ${index + 1}`,
  }))
  let layout
  try {
    layout = mountHomeChatLayout(host, {
      surface, choices, subjectId: choices[0].id, live: true,
      renderAgent(body, subject) {
        assert.equal(mounts.has(subject.id), false, 'each conversation mounts only once')
        const input = create('textarea'), log = create('div')
        input.value = `unsent words for ${subject.id}`; log.scrollTop = 137
        body.append(input, log); mounts.set(subject.id, { body, input, log })
        return () => released.push(subject.id)
      },
    })
  } catch (error) { dom.restore(); throw error }
  return {
    layout, surface, tabs, choices, mounts, released,
    panes: () => host.querySelectorAll('.home-chat-pane'),
    shown: () => host.querySelectorAll('.home-chat-pane').filter(pane => !pane.hidden),
    resize(nextWidth, nextHeight) {
      dimensions.width = nextWidth; dimensions.height = nextHeight
      for (const observer of observers) if (observer.target) observer.callback([{ target: observer.target }])
    },
    destroy() {
      try {
        layout.destroy()
        assert.equal(released.length, mounts.size, 'every inert conversation released once at destroy')
        assert.ok(observers.every(observer => observer.target === null), 'resize observer disconnected')
      } finally { dom.restore() }
    },
  }
}

test('Four uses two full-height panels in the reported 693px Home workspace', () => {
  const f = fixture(1408, 693)
  try {
    f.layout.setLayout('four')
    assert.equal(f.panes().length, 4, 'all four conversations stay mounted')
    assert.equal(f.shown().length, 2, '341px stacked windows cannot hold the reported agent controls')
    assert.ok(f.shown().every(pane => Number.parseFloat(pane.style.height) === 693))
    assert.equal(f.tabs.querySelectorAll('[data-pane-tab]').length, 4, 'every conversation remains reachable')
  } finally { f.destroy() }
})

test('Four retains existing short and narrow fallbacks and allows four in the taller workspace', () => {
  const f = fixture(1888, 873)
  try {
    f.layout.setLayout('four')
    for (const [width, height, count] of [[1888, 873, 4], [1248, 593, 2], [992, 561, 2], [600, 693, 1]]) {
      f.resize(width, height)
      assert.equal(f.shown().length, count, `workspace ${width}x${height}`)
      for (const pane of f.shown()) {
        const x = Number.parseFloat(pane.style.left), y = Number.parseFloat(pane.style.top)
        const w = Number.parseFloat(pane.style.width), h = Number.parseFloat(pane.style.height)
        assert.ok(x >= 0 && y >= 0 && x + w <= width && y + h <= height, 'window stays inside workspace')
      }
    }
  } finally { f.destroy() }
})

test('resizing Four preserves the active conversation and retained words and scroll without remount', () => {
  const f = fixture(1888, 873)
  try {
    f.layout.setLayout('four')
    f.layout.show(f.choices[3].id)
    const before = f.panes(), active = f.layout.activeHost
    const records = [...f.mounts.entries()]
    f.resize(1408, 693)
    assert.equal(f.shown().length, 2)
    assert.equal(f.layout.activeHost, active)
    assert.ok(f.shown().some(pane => pane.contains(active)), 'active fourth conversation remains shown')
    const hidden = f.panes().find(pane => pane.hidden)
    const tab = f.tabs.querySelector(`[data-pane-tab="${hidden.dataset.paneId}"]`)
    tab.click()
    assert.equal(hidden.hidden, false, 'window bar reveals a parked conversation')
    f.resize(1888, 873)
    assert.equal(f.shown().length, 4)
    assert.deepEqual(f.panes(), before, 'same window nodes survive both resizes')
    assert.equal(f.mounts.size, 4); assert.deepEqual(f.released, [])
    for (const [id, saved] of records) {
      assert.equal(f.mounts.get(id), saved)
      assert.equal(saved.input.value, `unsent words for ${id}`)
      assert.equal(saved.log.scrollTop, 137)
    }
  } finally { f.destroy() }
})

test('Single and Double remain selectable without closing other conversations', () => {
  const f = fixture(1408, 693)
  try {
    f.layout.setLayout('four')
    for (const [name, count] of [['single', 1], ['double', 2]]) {
      f.layout.setLayout(name)
      assert.equal(f.shown().length, count)
      assert.equal(f.panes().length, 4)
      assert.ok(f.shown().every(pane => Number.parseFloat(pane.style.height) === 693))
    }
    assert.deepEqual(f.released, [])
  } finally { f.destroy() }
})
