import test from 'node:test'
import assert from 'node:assert/strict'

import {
  controlState,
  formatInlineText,
  openMemory,
  ownDisclosure,
  setViewMorph,
  takeViewMorph,
} from '../../src/components.js'

test('control state keeps the decision and its user-facing refusal together', () => {
  const enabled = controlState({ enabled: true, why: null })
  assert.deepEqual(enabled, { enabled: true, disabled: false, why: '' },
    'an enabled control must expose the matching enabled and disabled flags')

  const sentence = '  Connect an account before starting research.  '
  const refused = controlState({ enabled: false, why: sentence })
  assert.deepEqual(refused, {
    enabled: false,
    disabled: true,
    why: 'Connect an account before starting research.',
  }, 'a refused control must retain its non-empty explanation, without surrounding whitespace')
  assert.equal(Object.isFrozen(refused), true,
    'callers must not be able to separate a refusal from its explanation after validation')
})

test('control state rejects incomplete or ambiguous decisions', () => {
  assert.throws(() => controlState({ enabled: false, why: '   ' }), {
    name: 'TypeError',
    message: /reason when disabled/i,
  }, 'a disabled control without a usable refusal reason must be rejected')
  assert.throws(() => controlState({ enabled: 'false', why: 'Not available.' }), {
    name: 'TypeError',
    message: /boolean/i,
  }, 'a truthy string must not be accepted as a definite enablement decision')
})

test('fold memory distinguishes a storage read failure from a definite answer', () => {
  const previous = globalThis.localStorage
  globalThis.localStorage = {
    getItem() { throw new Error('storage unavailable') },
    setItem() { throw new Error('storage unavailable') },
  }
  try {
    const memory = openMemory('mc.test:')
    assert.equal(memory.recall('run-7'), null,
      'a could-not-read result must remain unknown, not collapse to open or closed')
    assert.doesNotThrow(() => memory.remember('run-7', true),
      'a storage refusal must not prevent the disclosure changing for this session')
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

test('fold memory uses caller prefixes and only recalls definite stored choices', () => {
  const previous = globalThis.localStorage
  const values = new Map([
    ['mc.home:run-1', 'open'],
    ['mc.home:run-2', 'closed'],
    ['mc.home:run-3', 'unexpected'],
  ])
  globalThis.localStorage = {
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, value) },
  }
  try {
    const memory = openMemory('mc.home:')
    assert.deepEqual(
      [memory.recall('run-1'), memory.recall('run-2'), memory.recall('run-3'), memory.recall('')],
      ['open', 'closed', null, null],
      'only explicit open and closed values under the caller prefix are definite answers',
    )
    memory.remember('run-4', false)
    assert.equal(values.get('mc.home:run-4'), 'closed',
      'remembering a closed disclosure must write the caller-prefixed closed choice')
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

test('inline operational prose is safe while retaining useful emphasis', () => {
  const formatted = formatInlineText('<img src=x> Atlas & Q7 took 12 seconds at logs/run-2', {
    agents: [{ name: 'Atlas', role: 'helper' }],
  })
  assert.equal(formatted.includes('<img'), false,
    'person-controlled markup must be escaped before operational emphasis is added')
  assert.match(formatted, /&lt;img src=x&gt;/,
    'escaping must preserve the person-visible text rather than dropping it')
  assert.match(formatted, /inline-agent role-helper[^>]*>Atlas</,
    'a caller-provided agent must retain its valid visual role')
  assert.match(formatted, /inline-register[^>]*>Q7</i,
    'a request identifier must receive quiet register emphasis')
  assert.match(formatted, /inline-number[^>]*>12 seconds</,
    'a measured duration must receive quiet numeric emphasis')
  assert.match(formatted, /inline-register[^>]*>logs\/run-2</,
    'an operational path must receive quiet register emphasis')
})

test('owned disclosure toggles only its owned row and reports the new state', () => {
  const listeners = new Map()
  const details = {
    open: false,
    addEventListener(type, listener) { listeners.set(type, listener) },
  }
  const child = {}
  const summary = { contains(target) { return target === child } }
  const changes = []
  ownDisclosure(details, { within: summary, onToggle: open => changes.push(open) })

  let prevented = 0
  listeners.get('click')({ target: {}, preventDefault() { prevented += 1 } })
  assert.equal(details.open, false,
    'a press in the open body must not collapse a disclosure owned by its summary')
  listeners.get('click')({ target: child, preventDefault() { prevented += 1 } })
  assert.deepEqual({ open: details.open, prevented, changes }, { open: true, prevented: 1, changes: [true] },
    'a press in the owned row must toggle once, suppress the native double-toggle, and report the new state')
})

test('view morph handoff is a defensive, one-shot snapshot', () => {
  const source = { kind: 'zoom', x: 18, y: 42 }
  setViewMorph(source)
  source.x = 999
  const received = takeViewMorph()
  assert.equal(received.x, 18,
    'navigation must receive the point captured at announcement time, not later caller mutations')
  assert.equal(typeof received.at, 'number',
    'the morph snapshot must carry its announcement time for age checks')
  assert.equal(takeViewMorph(), null,
    'a view morph must be consumed once rather than leaking into later navigation')
})
