/* A RESUME LANDING AFTER AN AWAIT MUST NOT REBUILD THE RAIL OUT FROM UNDER A
 * PERSON STILL TYPING TO THAT SAME NODE.
 *
 * THE DEFECT (t5-LANE-W12-keystrokes-moved.md, measured by Manager at
 * 8e1e5c4): resumeNodeSessionUnguarded's tail --
 *
 *   if (controlsPage.classList.contains('is-active') && currentRailTreeNode
 *       && currentRailTreeNode.id === node.id) {
 *     showTreeNodeControls(treeStore ? treeStore.getNode(node.id) || node : node)
 *   }
 *
 * -- fires after two real awaits (bridge.close, then bridge.start over a live
 * child process). A person looking at this same node can still be mid-word in
 * its composer, its actions filter, or an open [data-compose-field] when this
 * runs. showTreeNodeControls is an innerHTML rebuild of the whole rail: it
 * calls disposeRailChat() and replaces the composer and any open popup, which
 * moves the caret and can drop characters in flight -- the same mechanism
 * rail-status-repaint.test.mjs pins for the status-landing callers.
 *
 * WHY THIS SEAM CANNOT JUST REPAINT INSTEAD, unlike those status landings: a
 * resume attaches a NEW sessionId to the node. repaintRailStatus only updates
 * the status hosts of the chat that is already mounted -- it has no way to
 * rebind the composer to a different session's buildChat config. The fix
 * here is deferral, not substitution: hold the rebuild until the field
 * blurs, then run it exactly once, same as it would have run right away.
 *
 * Two things are pinned. First, that the tail actually routes through the new
 * guard (a wiring pin at the source level, the same technique
 * resume-keeps-the-conversation.test.mjs already uses for this closure-
 * private function -- resumeNodeSessionUnguarded cannot be called directly
 * from a test process). Second, the guard itself as real behaviour: instantiated
 * from its own source slice (the same technique
 * tools/test/rail-status-repaint.test.mjs uses for repaintRailStatus) and
 * driven with the project's dom-stand-in, focusing each of the three
 * protected surfaces in turn with typed text and a caret position, and
 * proving the rebuild never runs, and nothing about the field moves, until
 * that field blurs.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

/* Comments are blanked to spaces, newlines kept, so a sentence in a comment can
   never satisfy (or unbalance) an assertion about code -- same technique as
   rail-status-repaint.test.mjs. */
const blankButNewlines = text => text.replace(/[^\n]/g, ' ')
const stripped = source => source
  .replace(/\/\*[\s\S]*?\*\//g, blankButNewlines)
  .replace(/(^|[^:"'`])\/\/[^\n]*/g, (match, before) => before + blankButNewlines(match.slice(before.length)))
const code = stripped(view)

/** Slice a whole function (or block) by its header, brace-balanced. Only safe
 * for a header whose own text is free of braces -- resumeNodeSessionUnguarded's
 * destructured default parameter is not, so that one is sliced by a plain
 * string range below instead, the same way resume-keeps-the-conversation.test.mjs
 * already does for this function. */
function sliceBlock(source, header, what) {
  const at = source.indexOf(header)
  assert.ok(at !== -1, `${what} is gone: ${JSON.stringify(header)} is not in the source`)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(at, i + 1)
    }
  }
  assert.fail(`${what} never closes its braces; the slice marker is stale`)
}

/* -------------------- the resume tail routes through the guard -------------------- */

test('the resumeNodeSession tail defers its rebuild instead of rebuilding the rail unconditionally', () => {
  const start = code.indexOf('async function resumeNodeSession')
  const end = code.indexOf('async function runPaletteAction')
  assert.ok(start !== -1 && end > start, 'resumeNodeSession or runPaletteAction moved; re-aim this slice')
  const resume = code.slice(start, end)
  assert.match(resume, /deferRailRebuildWhileTyping\(\(\) => \{/,
    'the resume tail no longer defers its rebuild -- a resume landing after the await can rebuild the rail and drop keystrokes in flight (measured: the resumeNodeSession tail fires AFTER an await, so a person may be typing by then)')
  assert.equal((resume.match(/showTreeNodeControls\(/g) || []).length, 1,
    'the resume tail must still rebuild exactly once -- a resumed node carries a NEW sessionId, which a repaint cannot rebind -- it must wait for that rebuild rather than skip or duplicate it')
})

/* -------------------------- the guard itself, as behaviour ------------------------ */

const guardSource = () => sliceBlock(code, 'function deferRailRebuildWhileTyping(run) {', 'deferRailRebuildWhileTyping')

const moduleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(moduleUrl)

/* THE STAND-IN IS INSTALLED PER TEST, AND TORN DOWN BY THE TEST'S OWN HOOK.
   It used to be installed once at module scope with `after(() => restore())`
   beside it. That is a real trap rather than a style choice: this file has a
   top-level `await import(...)` above, and a module-scope after() registered
   below a top-level await is not attached to the file's own root test on every
   runner. Measured on this machine: 3 of 6 red on the pinned runner
   C:\agent-apps\node-v22.19.0\node.exe (the stand-in was restored before the
   tests that needed it ran, so `document` was gone) and 6 of 6 green on PATH
   node v22.14.0 -- the same source, the same assertions, two answers. A gate
   whose colour depends on which node started it cannot tell anybody whether
   the product works, and this one guards a defect the person reported in their
   own words ("keystrokes getting moved randomly"). A per-test hook is attached
   to a test that certainly exists, so both runners agree. */
let document = null
function useDom(t) {
  const installed = installDomStandIn(globalThis)
  document = installed.document
  t.after(() => {
    installed.restore()
    document = null
  })
  assert.equal(installed.document, globalThis.document, 'the DOM stand-in did not become the global document for this test')
  return installed.document
}

/* Instantiated fresh per test from the REAL sliced source: `new Function` runs
   in the global scope and sees none of computers.js's module bindings, so the
   guard's only free reference (the global `document`) is exactly what the
   dom-stand-in installed above -- nothing here is a stand-in for the guard's
   own logic, only for the DOM underneath it. */
function instantiateGuard() {
  const factory = new Function(`${guardSource()}\nreturn deferRailRebuildWhileTyping`)
  return factory()
}

function mountComposer() {
  const host = document.createElement('div')
  host.setAttribute('data-rail-chat-host', '')
  const wrap = document.createElement('div')
  wrap.className = 'chat-input'
  const input = document.createElement('input')
  wrap.appendChild(input)
  host.appendChild(wrap)
  document.body.appendChild(host)
  return input
}

function mountFilter() {
  const host = document.createElement('div')
  host.setAttribute('data-rail-chat-host', '')
  const filter = document.createElement('input')
  filter.className = 'chat-actions-filter'
  host.appendChild(filter)
  document.body.appendChild(host)
  return filter
}

function mountComposeField() {
  const field = document.createElement('input')
  field.setAttribute('data-compose-field', 'message')
  document.body.appendChild(field)
  return field
}

test('nothing focused: the rebuild runs at once -- this is not a new delay for the ordinary case', t => {
  useDom(t)
  document.activeElement = null
  const guard = instantiateGuard()
  let ran = 0
  guard(() => { ran += 1 })
  assert.equal(ran, 1, 'with no protected field focused, the rebuild must still run immediately')
})

test('focus somewhere unrelated does not hold up the rebuild', t => {
  useDom(t)
  const button = document.createElement('button')
  document.body.appendChild(button)
  button.focus()
  const guard = instantiateGuard()
  let ran = 0
  guard(() => { ran += 1 })
  assert.equal(ran, 1, 'a field outside the three protected surfaces still blocked the rebuild -- the guard is too broad')
})

test('the rail composer input holds focus: the rebuild waits for blur, and the field is left alone while it waits', t => {
  useDom(t)
  const input = mountComposer()
  input.value = 'typed while a resume was in flight'
  input.selectionStart = 7
  input.focus()
  const guard = instantiateGuard()
  let ran = 0
  guard(() => { ran += 1 })
  assert.equal(ran, 0, 'the rebuild fired immediately while the composer held focus -- this is the caret-moving defect the guard exists to stop')
  assert.equal(input.value, 'typed while a resume was in flight', 'the guard changed the composer value before the rebuild it deferred ever ran')
  assert.equal(input.selectionStart, 7, 'the guard moved the caret before the rebuild it deferred ever ran')
  assert.equal(document.activeElement, input, 'the guard moved focus away before the rebuild it deferred ever ran')
  input.dispatch('blur')
  assert.equal(ran, 1, 'blurring the composer never released the deferred rebuild')
  input.dispatch('blur')
  assert.equal(ran, 1, 'a second blur ran the rebuild again -- the deferred listener must fire exactly once')
})

test('the actions filter holds focus: the rebuild also waits for it', t => {
  useDom(t)
  const filter = mountFilter()
  filter.value = 'rewi'
  filter.focus()
  const guard = instantiateGuard()
  let ran = 0
  guard(() => { ran += 1 })
  assert.equal(ran, 0, 'the rebuild ran while the actions filter held focus')
  assert.equal(filter.value, 'rewi', 'the guard changed the filter text before the rebuild it deferred ever ran')
  filter.dispatch('blur')
  assert.equal(ran, 1, 'the deferred rebuild never ran once the filter blurred')
})

test('the new-circle compose field holds focus: the rebuild also waits for it', t => {
  useDom(t)
  const field = mountComposeField()
  field.value = 'a brief being typed'
  field.focus()
  const guard = instantiateGuard()
  let ran = 0
  guard(() => { ran += 1 })
  assert.equal(ran, 0, 'the rebuild ran while a [data-compose-field] held focus')
  field.dispatch('blur')
  assert.equal(ran, 1, 'the deferred rebuild never ran once the compose field blurred')
})
