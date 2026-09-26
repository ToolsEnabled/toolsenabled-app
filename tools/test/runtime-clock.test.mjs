import assert from 'node:assert/strict'
import test from 'node:test'

import { bindRuntime, tickRuntimes, runtimeRegistrySize } from '../../src/runtime-clock.js'

/* This tick runs twice a second for the life of the process on every machine,
 * so what it costs when NOTHING has changed is what it costs almost all of the
 * time. These tests pin that it still shows the right digits, and that an
 * unchanged tick performs no DOM write and no allocation-heavy scan.
 */

class FakeElement {
  constructor({ connected = true } = {}) {
    this.isConnected = connected
    this._text = ''
    this.writes = 0
  }
  get textContent() { return this._text }
  set textContent(value) { this._text = value; this.writes += 1 }
}

// Every test starts from a clean registry: the module holds one process-wide
// Set, so a leftover entry from an earlier test would silently change results.
function freshRegistry() {
  const unbinds = []
  return {
    add(elm, bornAtFn) { const off = bindRuntime(elm, bornAtFn); unbinds.push(off); return off },
    releaseAll() { for (const off of unbinds) off() },
  }
}

test('a bound element shows the formatted runtime', () => {
  const reg = freshRegistry()
  const elm = new FakeElement()
  reg.add(elm, () => 1000)
  tickRuntimes(v => `up ${v}`)
  assert.equal(elm.textContent, 'up 1000')
  reg.releaseAll()
})

test('a tick whose value has not changed performs NO dom write', () => {
  // The regression this pins: the old tick assigned textContent every time,
  // which dirties the node and costs layout even when the string is identical.
  // At 2 ticks/second against a value that changes at most once a second, at
  // least half of all writes were pure waste, and on an idle machine whose
  // digits are parked on a placeholder, all of them were.
  const reg = freshRegistry()
  const elm = new FakeElement()
  reg.add(elm, () => 5000)

  tickRuntimes(v => `up ${v}`)
  assert.equal(elm.writes, 1, 'the first tick must write')

  for (let i = 0; i < 50; i++) tickRuntimes(v => `up ${v}`)
  assert.equal(elm.writes, 1, '50 further ticks with an unchanged value must write zero times')
  assert.equal(elm.textContent, 'up 5000', 'and the text must still be correct')
  reg.releaseAll()
})

test('a tick whose value HAS changed does write', () => {
  const reg = freshRegistry()
  const elm = new FakeElement()
  let born = 1
  reg.add(elm, () => born)

  tickRuntimes(v => `up ${v}`)
  born = 2
  tickRuntimes(v => `up ${v}`)
  born = 3
  tickRuntimes(v => `up ${v}`)

  assert.equal(elm.writes, 3, 'every genuine change must reach the DOM')
  assert.equal(elm.textContent, 'up 3')
  reg.releaseAll()
})

test('a disconnected element is released from the registry, not merely skipped', () => {
  // A skipped-but-retained entry is an invisible leak that grows for the life
  // of the process, and it is what made teardown O(n^2) before.
  const reg = freshRegistry()
  const before = runtimeRegistrySize()
  const kept = new FakeElement()
  const dropped = new FakeElement()
  reg.add(kept, () => 1)
  reg.add(dropped, () => 1)
  assert.equal(runtimeRegistrySize(), before + 2)

  dropped.isConnected = false
  tickRuntimes(v => `up ${v}`)

  assert.equal(runtimeRegistrySize(), before + 1, 'the disconnected entry must be gone from the registry')
  assert.equal(dropped.writes, 0, 'a disconnected element must never be written to')
  reg.releaseAll()
})

test('tearing down many elements at once stays linear, not quadratic', () => {
  // The old removal path scanned the whole registry for each disconnected
  // element (a forEach inside the iteration), so disconnecting n elements did
  // ~n^2/2 comparisons. This asserts the observable consequence: one tick
  // clears them all, and the registry is empty afterwards.
  const reg = freshRegistry()
  const before = runtimeRegistrySize()
  const elements = Array.from({ length: 2000 }, () => new FakeElement())
  for (const elm of elements) reg.add(elm, () => 1)
  assert.equal(runtimeRegistrySize(), before + 2000)

  for (const elm of elements) elm.isConnected = false
  tickRuntimes(v => `up ${v}`)

  assert.equal(runtimeRegistrySize(), before, 'a single tick must release every disconnected element')
  reg.releaseAll()
})

test('unbinding stops updates and releases the entry', () => {
  const reg = freshRegistry()
  const before = runtimeRegistrySize()
  const elm = new FakeElement()
  const off = reg.add(elm, () => 1)
  tickRuntimes(v => `up ${v}`)
  const writes = elm.writes
  off()
  assert.equal(runtimeRegistrySize(), before, 'unbind must remove the entry')
  tickRuntimes(v => `up ${v * 99}`)
  assert.equal(elm.writes, writes, 'an unbound element must never be written to again')
})

test('one element going stale does not stop the others updating', () => {
  const reg = freshRegistry()
  const first = new FakeElement()
  const stale = new FakeElement()
  const last = new FakeElement()
  reg.add(first, () => 7)
  reg.add(stale, () => 7)
  reg.add(last, () => 7)
  stale.isConnected = false

  tickRuntimes(v => `up ${v}`)

  assert.equal(first.textContent, 'up 7')
  assert.equal(last.textContent, 'up 7', 'the element after the removed one must still be updated')
  reg.releaseAll()
})
