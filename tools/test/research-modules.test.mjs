import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createResearchRegistry,
  RESEARCH_MODULE_READ_FAILED,
  RESEARCH_MODULE_STORE_KEY,
} from '../../src/research-modules.js'

const element = name => ({ name, querySelector: () => null })
test('benchmark module presets persist atomically and new optional modules remain off until explicitly enabled', () => {
  const configured = [...modules(), { id: 'resource', title: 'Resource action', size: 'full', el: element('resource'), defaultOn: false }]
  const storage = memoryStorage(JSON.stringify({ v: 1, disabled: ['queue'] }))
  const registry = createResearchRegistry({ modules: configured, storage })
  assert.equal(registry.isEnabled('resource'), false)
  registry.setActive(['designer', 'results'])
  const restored = createResearchRegistry({ modules: configured, storage })
  assert.deepEqual(restored.enabled().map(module => module.id), ['designer', 'results'])
  restored.setEnabled('resource', true)
  assert.equal(createResearchRegistry({ modules: configured, storage }).isEnabled('resource'), true)
  restored.setAll(true)
  assert.equal(createResearchRegistry({ modules: configured, storage }).isEnabled('resource'), true)
})
const modules = () => [
  { id: 'designer', title: 'Experiment designer', size: 'full', el: element('designer') },
  { id: 'queue', title: 'Research queue', size: 'slot', el: element('queue') },
  { id: 'results', title: 'Results', size: 'full', el: element('results') },
]

function memoryStorage(seed) {
  const values = new Map(seed === undefined ? [] : [[RESEARCH_MODULE_STORE_KEY, seed]])
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    read: () => values.get(RESEARCH_MODULE_STORE_KEY),
  }
}

test('the caller-facing registry preserves order and persists toggle choices', () => {
  const storage = memoryStorage()
  const changes = []
  const registry = createResearchRegistry({ modules: modules(), storage, onChange: (...args) => changes.push(args) })

  const initiallyEnabled = registry.enabled().map(module => module.id)
  const disabled = registry.setEnabled('queue', false)
  const afterDisable = registry.enabled().map(module => module.id)
  const saved = JSON.parse(storage.read())
  const repeated = registry.setEnabled('queue', false)
  const enabled = registry.setEnabled('queue', true)

  assert.deepEqual({ initiallyEnabled, disabled, afterDisable, saved, repeated, enabled, stored: storage.read(), changes }, {
    initiallyEnabled: ['designer', 'queue', 'results'],
    disabled: false,
    afterDisable: ['designer', 'results'],
    saved: { v: 1, disabled: ['queue'] },
    repeated: false,
    enabled: true,
    stored: undefined,
    changes: [['queue', false], ['queue', true]],
  }, 'a module choice must immediately drive the workbench, survive storage, and notify only on a real change')
})

test('an unreadable preference is not reported as absent while invalid stored data retains the default', () => {
  let reads = 0
  const busy = Object.assign(new Error('too many open files'), { code: 'EMFILE' })
  const unreadable = {
    getItem() {
      reads += 1
      if (reads === 1) throw busy
      return JSON.stringify({ v: 1, disabled: ['queue'] })
    },
  }
  assert.throws(
    () => createResearchRegistry({ modules: modules(), storage: unreadable }),
    error => error.code === RESEARCH_MODULE_READ_FAILED
      && /not claiming.*absent/i.test(error.message)
      && error.cause === busy,
    'a busy machine needs a distinct could-not-read result, not the absent/default answer',
  )

  const retried = createResearchRegistry({ modules: modules(), storage: unreadable })
  const cases = [
    createResearchRegistry({ modules: modules(), storage: memoryStorage('{not json') }),
    createResearchRegistry({ modules: modules(), storage: memoryStorage(JSON.stringify({ v: 2, disabled: ['queue'] })) }),
    createResearchRegistry({ modules: modules(), storage: memoryStorage(JSON.stringify({ v: 1, disabled: 'queue' })) }),
  ]

  assert.deepEqual({ reads, enabled: retried.enabled().map(module => module.id) },
    { reads: 2, enabled: ['designer', 'results'] },
    'the could-not-read result must not be cached: a later construction retries and applies the stored choice')
  assert.deepEqual(cases.map(registry => ({ enabled: registry.enabled().map(module => module.id), queue: registry.isEnabled('queue') })),
    cases.map(() => ({ enabled: ['designer', 'queue', 'results'], queue: true })),
    'invalid preference data keeps the documented default-on face')

  const cachedStorage = memoryStorage(JSON.stringify({ v: 1, disabled: ['queue'] }))
  const cached = createResearchRegistry({ modules: modules(), storage: cachedStorage })
  cachedStorage.setItem(RESEARCH_MODULE_STORE_KEY, JSON.stringify({ v: 1, disabled: ['designer'] }))
  assert.deepEqual(cached.enabled().map(module => module.id), ['designer', 'results'],
    'CONTROL: a successfully read choice remains latched for the registry lifetime')
})

test('stale stored ids are ignored while known choices still apply', () => {
  const storage = memoryStorage(JSON.stringify({ v: 1, disabled: ['retired-module', 'queue'] }))
  const registry = createResearchRegistry({ modules: modules(), storage })

  assert.deepEqual({ enabled: registry.enabled().map(module => module.id), retired: registry.isEnabled('retired-module') },
    { enabled: ['designer', 'results'], retired: false },
    'stored choices must affect known modules without making a retired id look available')
})

test('a storage write failure does not undo the choice the user just made', () => {
  const storage = {
    getItem: () => null,
    setItem() { throw new Error('quota exceeded') },
    removeItem() { throw new Error('quota exceeded') },
  }
  const changes = []
  const registry = createResearchRegistry({ modules: modules(), storage, onChange: (...args) => changes.push(args) })

  let result
  let error = null
  try { result = registry.setEnabled('results', false) }
  catch (caught) { error = caught }
  assert.deepEqual({ error, result, enabled: registry.enabled().map(module => module.id), changes },
    { error: null, result: false, enabled: ['designer', 'queue'], changes: [['results', false]] },
    'a failed preference write must not crash or contradict the live workbench choice')
})

test('bulk choices update every module and emit one aggregate notification', () => {
  const storage = memoryStorage()
  const changes = []
  const registry = createResearchRegistry({ modules: modules(), storage, onChange: (...args) => changes.push(args) })

  registry.setAll(false)
  const allOff = registry.enabled().map(module => module.id)
  const offRaw = storage.read()
  const offStore = offRaw === undefined ? null : JSON.parse(offRaw)
  registry.setAll(false)
  registry.setAll(true)

  assert.deepEqual({ allOff, offStore, final: registry.enabled().map(module => module.id), stored: storage.read(), changes }, {
    allOff: [],
    offStore: { v: 1, disabled: ['designer', 'queue', 'results'] },
    final: ['designer', 'queue', 'results'],
    stored: undefined,
    changes: [[null, false], [null, true]],
  }, 'the all-on and all-off controls must cover the whole registry and notify once per changed bulk choice')
})

test('bad wiring and unknown controls are refused with actionable reasons', () => {
  const invalidCalls = [
    () => createResearchRegistry({ modules: [] }),
    () => createResearchRegistry({ modules: [{ id: '', title: 'Empty id', size: 'full', el: element('bad') }] }),
    () => createResearchRegistry({ modules: [...modules(), { ...modules()[0] }] }),
    () => createResearchRegistry({ modules: [{ id: 'x', title: '', size: 'full', el: element('bad') }] }),
    () => createResearchRegistry({ modules: [{ id: 'x', title: 'X', size: 'wide', el: element('bad') }] }),
    () => createResearchRegistry({ modules: [{ id: 'x', title: 'X', size: 'full', el: null }] }),
    () => createResearchRegistry({ modules: modules() }).setEnabled('retired-module', true),
  ]
  const reasonPatterns = [
    /non-empty.*modules/i,
    /non-empty.*id/i,
    /duplicate.*id/i,
    /needs.*title/i,
    /size.*full.*slot/i,
    /needs.*element/i,
    /unknown.*module/i,
  ]
  const refusals = invalidCalls.map((call, index) => {
    try { call(); return { threw: false, useful: false } }
    catch (error) { return { threw: error instanceof TypeError, useful: reasonPatterns[index].test(error.message) } }
  })

  assert.deepEqual(refusals, invalidCalls.map(() => ({ threw: true, useful: true })),
    'each invalid registration or control must throw TypeError and explain the rejected property without pinning exact copy')
})
