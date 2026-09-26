/* ZOOM IN THE DESKTOP WINDOW (T1567).
 *
 * The shell removes the application menu, and Electron's zoom accelerators
 * live in that menu, so Ctrl+Plus, Ctrl+Minus, Ctrl+0 and Ctrl+wheel did
 * nothing and the most a person could enlarge the app was the 112% Text size.
 * shell/window-zoom.cjs gives the keys and the wheel back, in a desktop
 * browser's steps up to at least 200%, and remembers the level. The key
 * presses themselves are proved on a private rig Electron with real X keys
 * (bughunt-rig hunt-crosscut/c13b-zoom-xkeys.mjs).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const load = () => { try { return require('../../shell/window-zoom.cjs') } catch { return null } }
const key = (key, extra = {}) => ({ type: 'keyDown', control: true, key, code: '', ...extra })

test('the zoom keys a desktop browser offers are read as zoom in, out and reset', () => {
  const zoom = load()
  assert.ok(zoom?.zoomIntent, 'the desktop window has no zoom keys at all')
  assert.equal(zoom.zoomIntent(key('=')), 'in')
  assert.equal(zoom.zoomIntent(key('+', { shift: true })), 'in')
  assert.equal(zoom.zoomIntent(key('+', { code: 'NumpadAdd' })), 'in')
  assert.equal(zoom.zoomIntent(key('-')), 'out')
  assert.equal(zoom.zoomIntent(key('-', { code: 'NumpadSubtract' })), 'out')
  assert.equal(zoom.zoomIntent(key('0')), 'reset')
  assert.equal(zoom.zoomIntent(key('r')), null, 'Ctrl+R is the reload key, not zoom')
  assert.equal(zoom.zoomIntent({ type: 'keyDown', key: '=', control: false }), null, 'plain = typed in a field must stay a character')
  assert.equal(zoom.zoomIntent(key('=', { alt: true })), null)
  assert.equal(zoom.zoomIntent({ ...key('='), type: 'keyUp' }), null)
})

test('zoom reaches 200% and back in browser steps, and a saved level survives only if it is a step', () => {
  const zoom = load()
  assert.ok(zoom?.nextZoom)
  let factor = 1
  const seen = []
  for (let press = 0; press < 20; press += 1) { factor = zoom.nextZoom(factor, 'in'); seen.push(factor) }
  assert.ok(seen.includes(2), 'zoom never reaches 200%')
  assert.equal(factor, zoom.ZOOM_STEPS.at(-1), 'zoom does not stop at its largest step')
  for (let press = 0; press < 20; press += 1) factor = zoom.nextZoom(factor, 'out')
  assert.equal(factor, zoom.ZOOM_STEPS[0])
  assert.equal(zoom.nextZoom(1.75, 'reset'), 1)
  assert.equal(zoom.nextZoom(1, 'in'), 1.1)
  assert.equal(zoom.savedZoom(1.5), 1.5)
  for (const bad of [undefined, null, 'x', 0, -1, 7, 1.3]) assert.equal(zoom.savedZoom(bad), 1, `a saved ${bad} is used`)
})

test('the window zooms on the keys and the wheel, remembers the level and applies it after a reload', () => {
  const zoom = load()
  assert.ok(zoom?.attachWindowZoom)
  const contents = new EventEmitter()
  let live = 1
  contents.getZoomFactor = () => live
  contents.setZoomFactor = value => { live = value }
  const saved = []
  zoom.attachWindowZoom(contents, { initial: 1.25, save: value => saved.push(value) })
  contents.emit('did-finish-load')
  assert.equal(live, 1.25, 'the remembered level is not applied when the page loads')
  let prevented = 0
  const press = input => contents.emit('before-input-event', { preventDefault() { prevented += 1 } }, input)
  press(key('='))
  assert.equal(live, 1.5)
  press(key('-'))
  press(key('-'))
  assert.equal(live, 1.1)
  press(key('0'))
  assert.equal(live, 1)
  press(key('a'))
  assert.equal(prevented, 4, 'a key that is not zoom was swallowed, or a zoom key reached the page')
  contents.emit('zoom-changed', {}, 'in')
  assert.equal(live, 1.1, 'Ctrl+wheel does nothing')
  contents.emit('zoom-changed', {}, 'out')
  assert.equal(live, 1)
  assert.deepEqual(saved, [1.5, 1.25, 1.1, 1, 1.1, 1])
})

test('the shell attaches zoom to its window and keeps the level in its state file', () => {
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  assert.match(main, /const \{ attachWindowZoom \} = require\('\.\/window-zoom\.cjs'\)/)
  assert.match(main, /attachWindowZoom\(win\.webContents, \{ initial: readState\(\)\.zoom, save: zoom => writeState\(\{ zoom \}\) \}\)/)
  assert.match(main, /Menu\.setApplicationMenu\(null\)/, 'the menu is back; its own accelerators would now zoom twice')
})
