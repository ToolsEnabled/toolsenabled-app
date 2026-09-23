import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Driven on a fresh packaged baseline with the scripted acceptance engine:
// open the new circle while Start awaits, then session attachment rebinds its
// chat. The successful Start tail restored the old overview and hid that chat.
// Extract the closure-private function, as the neighboring rail suites do,
// so these tests execute the actual close behavior without a provider session.
const view = readFileSync(fileURLToPath(new URL('../../src/views/computers.js', import.meta.url)), 'utf8')
const code = view.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))

function sourceOf(name) {
  const at = code.indexOf(`function ${name}(`)
  assert.notEqual(at, -1, `${name} must remain callable`)
  const open = code.indexOf('{', at)
  let depth = 1
  let end = open + 1
  while (depth > 0 && end < code.length) {
    if (code[end] === '{') depth += 1
    else if (code[end] === '}') depth -= 1
    end += 1
  }
  assert.equal(depth, 0)
  return code.slice(at, end)
}

function fixture({ active = 'compose', prior = 'stats' } = {}) {
  const calls = []
  const makePanel = name => ({ name, destroy() { calls.push(`destroy:${name}`) } })
  const first = makePanel('first')
  const make = new Function('first', 'initialActive', 'initialPrior', 'calls', `
    let composePanel = first
    let active = initialActive
    let railBeforeCompose = initialPrior
    const composePage = {
      innerHTML: 'first panel',
      classList: { contains: value => value === 'is-active' && active === 'compose' },
    }
    const activateRail = page => { active = page; calls.push('activate:' + page) }
    ${sourceOf('closeComposePanel')}
    return {
      close: closeComposePanel,
      replace(panel) { composePanel = panel; composePage.innerHTML = 'new draft'; active = 'compose' },
      snapshot: () => ({ panel: composePanel, active, prior: railBeforeCompose, html: composePage.innerHTML }),
    }
  `)
  return { ...make(first, active, prior, calls), first, makePanel, calls }
}

test('ordinary completion or Cancel restores the rail behind the visible compose panel', () => {
  for (const prior of ['stats', 'controls']) {
    const state = fixture({ prior })
    state.close()
    assert.deepEqual(state.calls, ['destroy:first', `activate:${prior}`])
    assert.deepEqual(state.snapshot(), { panel: null, active: prior, prior: null, html: '' })
  }
})

test('late Start completion preserves the chat rail the person selected while it awaited', () => {
  const state = fixture({ active: 'controls', prior: 'stats' })
  state.close(state.first)
  assert.deepEqual(state.calls, ['destroy:first'], 'completion must not reactivate the old overview')
  assert.deepEqual(state.snapshot(), { panel: null, active: 'controls', prior: null, html: '' })
})

test('late completion also preserves an explicit return to the overview', () => {
  const state = fixture({ active: 'stats', prior: 'controls' })
  state.close(state.first)
  assert.equal(state.snapshot().active, 'stats')
  assert.deepEqual(state.calls, ['destroy:first'])
})

test('an older Start may not destroy a newer compose panel or its draft', () => {
  const state = fixture()
  const newer = state.makePanel('newer')
  state.replace(newer)
  state.close(state.first)
  assert.deepEqual(state.calls, [])
  assert.deepEqual(state.snapshot(), { panel: newer, active: 'compose', prior: 'stats', html: 'new draft' })
})

test('a completion after the initiating compose panel was already closed does nothing', () => {
  const state = fixture()
  state.close()
  state.calls.length = 0
  state.close(state.first)
  assert.deepEqual(state.calls, [])
  assert.deepEqual(state.snapshot(), { panel: null, active: 'stats', prior: null, html: '' })
})

test('the actual asynchronous Start captures its initiating panel before awaiting and closes only that panel', () => {
  const queued = code.slice(code.indexOf('async function startDraftNodeQueued('), code.indexOf('async function startDraftNodeUnguarded('))
  assert.match(queued, /const startPanel = options.closePanel \? composePanel : null/,
    'a resource retry must retain the original panel, not capture whichever panel is open at the next attempt')
  assert.ok(queued.indexOf('const startPanel =') < queued.indexOf('createTreeLaunchQueue('))
  assert.match(queued, /startDraftNodeUnguarded\(pending, \{ \.\.\.options, startPanel,/)
  const start = code.slice(code.indexOf('async function startDraftNodeUnguarded('), code.indexOf('function statusNote('))
  assert.match(start, /startPanel = closePanel \? composePanel : null/,
    'a non-queued batch call must still capture its initiating panel before awaiting')
  const captured = /const (\w+) = startPanel/.exec(start)
  assert.ok(captured, 'capture the initiating panel, not whatever is open after Start finishes')
  assert.ok(captured.index < start.indexOf('await ensureSeatForNode('), 'capture before the first asynchronous boundary')
  assert.match(start, new RegExp(`if \\(closePanel\\) closeComposePanel\\(${captured[1]}\\)`))
})
