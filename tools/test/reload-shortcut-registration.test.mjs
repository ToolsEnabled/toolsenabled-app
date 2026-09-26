import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const MAIN_FILE = fileURLToPath(new URL('../../shell/main.cjs', import.meta.url))

// Read and execute the registration expression that is actually present in
// main.cjs. This keeps the fixture causal for both the old inline handler and
// the successor helper registration. It never loads main.cjs itself: the
// shell has Electron/profile side effects before it reaches this registration.
function actualCall(source, anchor) {
  const start = source.indexOf(anchor)
  assert.notEqual(start, -1, `main.cjs is missing the ${anchor} registration`)
  const open = source.indexOf('(', start)
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = open; index < source.length; index++) {
    const character = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      continue
    }
    if (character === '(') depth++
    else if (character === ')' && --depth === 0) return source.slice(start, index + 1)
  }
  assert.fail(`unterminated ${anchor} registration in main.cjs`)
}

function registerActualHandler(win) {
  const source = readFileSync(MAIN_FILE, 'utf8')
  if (source.includes('attachShellInputHandler(')) {
    const expression = actualCall(source, 'attachShellInputHandler(')
    // Only the actual helper registration is allowed to load the helper. The
    // 953 baseline has no helper file and must execute its own inline source.
    const requireFromMain = createRequire(MAIN_FILE)
    const { attachShellInputHandler } = requireFromMain('./reload-shortcut.cjs')
    new Function('win', 'attachShellInputHandler', `${expression};`)(win, attachShellInputHandler)
    return 'helper'
  }

  const expression = actualCall(source, "win.webContents.on('before-input-event'")
  new Function('win', `${expression};`)(win)
  return 'inline'
}

class InertWebContents extends EventEmitter {
  reloadCalls = 0
  devToolsCalls = 0

  reload() {
    this.reloadCalls++
  }

  toggleDevTools() {
    this.devToolsCalls++
  }
}

function dispatch(contents, input) {
  let prevented = 0
  contents.emit('before-input-event', { preventDefault() { prevented++ } }, input)
  return prevented
}

function key(extra = {}) {
  return { type: 'keyDown', control: true, key: 'r', ...extra }
}

test('the actual main.cjs registration synchronously fences draft reloads', () => {
  // focus/draft fields are synthetic event metadata only. This fixture proves
  // the native before-input causal path, not renderer DOM focus or persistence.
  const contents = new InertWebContents()
  const kind = registerActualHandler({ webContents: contents })
  assert.ok(kind === 'inline' || kind === 'helper', `unexpected registration kind: ${kind}`)

  const inputs = [
    key({ focus: 'textarea', draft: 'typed words' }),
    key({ control: false, meta: true, key: 'R', focus: 'contenteditable', attachment: 'pasted-picture.png' }),
    key({ shift: true, repeat: true, focus: 'unknown', draft: 'uncertain focus' }),
  ]
  for (const input of inputs) {
    assert.equal(dispatch(contents, input), 1, JSON.stringify(input))
    // Keep this immediately after each dispatch: on the 953 baseline the
    // first old-handler Ctrl+R must fail here, before Meta/other variants run.
    assert.equal(contents.reloadCalls, 0, 'the actual main registration must not reload a draft-bearing renderer')
  }

  assert.equal(dispatch(contents, { type: 'keyDown', key: 'F12' }), 1)
  assert.equal(contents.devToolsCalls, 1, 'F12 must retain its developer-tools action')
  assert.equal(dispatch(contents, { type: 'keyDown', key: 'a' }), 0, 'ordinary keys must pass through')
  assert.equal(dispatch(contents, { type: 'keyUp', control: true, key: 'r' }), 0, 'key-up must pass through')
})
