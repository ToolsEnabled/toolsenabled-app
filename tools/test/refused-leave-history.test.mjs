/* BACK AND FORWARD AFTER 'LEAVE SETTINGS AND DISCARD UNSAVED CHANGES?' -> CANCEL
 * (T1412).
 *
 * The router hears about a move only after the address changed. On a refusal
 * it used to write Settings over whatever entry it was on: after a rail press
 * that left Settings in history twice (the next Back did nothing at all), and
 * after a Back press it overwrote the page the person came from, so Ledger
 * vanished from history for good.
 *
 * This drives src/history-entries.js, which src/main.js's render() uses, against
 * a stand-in of the browser's session history that behaves like the real one
 * where it matters: a link press drops the forward entries and pushes a new,
 * stateless entry; Back and Forward move between entries and fire hashchange
 * only when the address actually differs; replaceState rewrites the current
 * entry. The router below is main.js's render() reduced to its history calls,
 * and the last test holds main.js to those same calls.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const load = () => import('../../src/history-entries.js').catch(() => null)

function browser() {
  const entries = [{ hash: '#/', state: null }]
  let at = 0
  const queue = []
  const location = { get hash() { return entries[at].hash } }
  const fire = previous => { if (entries[at].hash !== previous) queue.push('hashchange') }
  const history = {
    get state() { return entries[at].state },
    replaceState(state, _unused, url) {
      entries[at] = { hash: url === undefined || url === null ? entries[at].hash : String(url), state }
    },
    back() { history.go(-1) },
    go(delta) {
      const previous = entries[at].hash
      at = Math.max(0, Math.min(entries.length - 1, at + delta))
      fire(previous)
    },
  }
  const press = hash => {
    const previous = entries[at].hash
    entries.splice(at + 1)
    entries.push({ hash, state: null })
    at += 1
    fire(previous)
  }
  return { entries, location, history, press, get at() { return at }, queue }
}

function app(mod, world) {
  const tracker = mod.createHistoryEntries({ history: world.history, location: world.location })
  const state = { current: null, dirty: false, prompts: 0, shown: [] }
  const render = () => {
    if (tracker.isUndoEcho(world.location.hash)) return
    if (state.current?.hash.startsWith('#/settings') && state.dirty) {
      state.prompts += 1                          // 'Leave Settings and discard unsaved changes?' -> Cancel
      tracker.refuse(state.current.hash)
      return
    }
    tracker.settle()
    state.current = { hash: world.location.hash }
    state.shown.push(world.location.hash)
  }
  const drain = () => { while (world.queue.length) { world.queue.shift(); render() } }
  render()
  return { state, drain }
}

test('Cancel after a rail press leaves history as it was, and the next Back is not a dead press', async () => {
  const mod = await load()
  assert.ok(mod?.createHistoryEntries, 'a refused leave still overwrites the current history entry')
  const world = browser()
  const { state, drain } = app(mod, world)
  world.press('#/ledger'); drain()
  world.press('#/settings?setting=write_thread-reply'); drain()
  state.dirty = true
  world.press('#/research'); drain()               // rail press, Cancel
  assert.equal(state.prompts, 1)
  assert.equal(world.location.hash, '#/settings?setting=write_thread-reply')
  assert.deepEqual(world.entries.slice(0, world.at + 1).map(e => e.hash), ['#/', '#/ledger', '#/settings?setting=write_thread-reply'],
    'Settings is in history twice after the refused rail press')
  world.history.back(); drain()                    // the mouse Back button
  assert.equal(state.prompts, 2, 'the next Back did nothing at all: no prompt, no page change')
  assert.equal(world.location.hash, '#/settings?setting=write_thread-reply')
})

test('Cancel after Back keeps the page you came from, and Back reaches it after discarding', async () => {
  const mod = await load()
  assert.ok(mod?.createHistoryEntries, 'a refused Back overwrites the previous page with Settings')
  const world = browser()
  const { state, drain } = app(mod, world)
  world.press('#/ledger'); drain()
  world.press('#/settings?setting=write_thread-reply'); drain()
  state.dirty = true
  world.history.back(); drain()                    // Back, Cancel
  assert.equal(state.prompts, 1)
  assert.equal(world.location.hash, '#/settings?setting=write_thread-reply')
  assert.deepEqual(world.entries.map(e => e.hash), ['#/', '#/ledger', '#/settings?setting=write_thread-reply'],
    'the Ledger entry was rewritten to Settings')
  state.dirty = false                              // discard
  world.history.back(); drain()
  assert.equal(world.location.hash, '#/ledger', 'Back never reaches Ledger again')
  assert.equal(state.shown.at(-1), '#/ledger')
  world.history.go(1); drain()                     // and Forward returns to Settings
  assert.equal(world.location.hash, '#/settings?setting=write_thread-reply')
})

test('a refused Forward is walked back the same way, and an accepted move is not disturbed', async () => {
  const mod = await load()
  assert.ok(mod?.createHistoryEntries)
  const world = browser()
  const { state, drain } = app(mod, world)
  world.press('#/settings'); drain()
  world.press('#/vault'); drain()
  world.history.back(); drain()                    // back on Settings
  state.dirty = true
  world.history.go(1); drain()                     // Forward, Cancel
  assert.equal(state.prompts, 1)
  assert.equal(world.location.hash, '#/settings')
  assert.deepEqual(world.entries.map(e => e.hash), ['#/', '#/settings', '#/vault'])
  state.dirty = false
  world.history.go(1); drain()
  assert.equal(world.location.hash, '#/vault')
  assert.deepEqual(state.shown, ['#/', '#/settings', '#/vault', '#/settings', '#/vault'])
})

test('main.js routes every refusal and every accepted move through that tracker', () => {
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
  const render = main.slice(main.indexOf('function render() {'), main.indexOf('\n}\n', main.indexOf('function render() {')))
  assert.match(main, /import \{ createHistoryEntries \} from '\.\/history-entries\.js'/)
  assert.match(render, /^function render\(\) \{\n[^\n]*\n  if \(historyEntries\.isUndoEcho\(location\.hash\)\) return\n/)
  assert.match(render, /if \(decision === false\) \{\n\s*historyEntries\.refuse\(current\.hash \|\| '#\/settings'\)\n\s*return/)
  assert.doesNotMatch(render, /history\.replaceState\(null/, 'a refusal writes over the current entry again')
  assert.match(render, /historyEntries\.settle\(\)\n\s*return\n\s*\}\n\s*\}\n\s*historyEntries\.settle\(\)/)
})
