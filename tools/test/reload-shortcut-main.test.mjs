import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { attachShellInputHandler, isReloadShortcut, preventReloadShortcut } = require('../../shell/reload-shortcut.cjs')
const key = (extra = {}) => ({ type: 'keyDown', control: true, key: 'r', ...extra })

function dispatch(contents, input) {
  let prevented = 0
  contents.emit('before-input-event', { preventDefault() { prevented++ } }, input)
  return prevented
}

test('the shell identifies Ctrl/Cmd+R across platform and repeat/shift variants', () => {
  assert.equal(isReloadShortcut(key()), true)
  assert.equal(isReloadShortcut(key({ control: false, meta: true })), true)
  assert.equal(isReloadShortcut(key({ repeat: true, shift: true })), true)
  assert.equal(isReloadShortcut(key({ type: 'keyUp' })), false)
  assert.equal(isReloadShortcut(key({ key: 'f' })), false)
  assert.equal(isReloadShortcut({ type: 'keyDown', control: true, key: 'r' }), true)
})

test('the registered shell handler synchronously prevents reload for editor, picture and uncertain focus', () => {
  const contents = new EventEmitter()
  let reloads = 0
  let devTools = 0
  contents.reload = () => { reloads++ }
  attachShellInputHandler(contents, { toggleDevTools: () => { devTools++ } })

  const cases = [
    key({ focus: 'textarea', draft: 'typed words' }),
    key({ focus: 'contenteditable', attachment: 'pasted-picture.png', shift: true, repeat: true }),
    key({ control: false, meta: true, focus: 'unknown' }),
  ]
  for (const input of cases) assert.equal(dispatch(contents, input), 1, JSON.stringify(input))
  assert.equal(reloads, 0, 'the before-input handler must not call reload for any focus state')

  assert.equal(dispatch(contents, { type: 'keyDown', key: 'F12' }), 1)
  assert.equal(devTools, 1, 'F12 must retain its developer-tools action')
  assert.equal(dispatch(contents, { type: 'keyDown', key: 'a' }), 0, 'ordinary keys must pass through')
  assert.equal(dispatch(contents, { type: 'keyUp', control: true, key: 'r' }), 0, 'key-up must pass through')
})

test('the small predicate can be used without a shell window', () => {
  let prevented = 0
  assert.equal(preventReloadShortcut({ preventDefault() { prevented++ } }, key()), true)
  assert.equal(prevented, 1)
  assert.equal(preventReloadShortcut({ preventDefault() { prevented++ } }, { type: 'keyDown', key: 'r' }), false)
  assert.equal(prevented, 1)
})

test('main.cjs registers the helper and no longer reloads from before-input-event', () => {
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  assert.match(main, /const \{ attachShellInputHandler \} = require\('\.\/reload-shortcut\.cjs'\)/)
  assert.match(main, /attachShellInputHandler\(win\.webContents, \{[\s\S]*?toggleDevTools:/)
  assert.doesNotMatch(main, /input\.control && input\.key\.toLowerCase\(\) === 'r'\) \{ win\.webContents\.reload\(\)/)
})
