/* Producer/consumer contract for the local-model controls in Settings,
 * under "This computer".
 *
 * The packets below have the exact shape documented and emitted by
 * shell/provider-login.cjs. Expected user-visible words are imported from
 * their copy modules rather than duplicated here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

import { GUIDE_LOCAL_MODEL_STOP_IDLE } from '../../src/chat-copy.js'
import { LOCAL_MODEL_SETUP } from '../../src/local-model-setup-copy.js'

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

const {
  applyLocalModelEvent,
  applyLocalModelStopAnswer,
  localModelStopPayload,
} = await import('../../src/this-computer-settings.js')

function eventHarness() {
  const status = { textContent: '' }
  const log = { textContent: '', hidden: true }
  const stop = { hidden: false }
  const slot = {
    querySelector(selector) {
      return new Map([
        ['[data-local-status]', status],
        ['[data-local-log]', log],
        ['[data-local-stop]', stop],
      ]).get(selector) || null
    },
  }
  return {
    status,
    stop,
    root: { querySelector: selector => selector === '[data-local-model]' ? slot : null },
  }
}

test('a producer kill (code null) is reported as the person\'s stop, not a failure', () => {
  const { root, status, stop } = eventHarness()
  applyLocalModelEvent(root, { provider: 'ollama', kind: 'exit', op: 'install', code: null })
  assert.equal(status.textContent, LOCAL_MODEL_SETUP.stopped,
    'bad value caught: code null collapsed into installDoneFail')
  assert.equal(stop.hidden, true,
    'bad value caught: a killed flight left its Stop control visible')
})

test('a producer nonzero exit remains a real operation-specific failure', () => {
  const install = eventHarness()
  applyLocalModelEvent(install.root, { provider: 'ollama', kind: 'exit', op: 'install', code: 7 })
  assert.equal(install.status.textContent, LOCAL_MODEL_SETUP.installDoneFail,
    'bad value caught: nonzero install code 7 reported as a person stop')

  const pull = eventHarness()
  applyLocalModelEvent(pull.root, { provider: 'ollama', kind: 'exit', op: 'pull', code: 7 })
  assert.equal(pull.status.textContent, LOCAL_MODEL_SETUP.downloadDoneFail,
    'bad value caught: producer op pull ignored and reported as an install failure')
})

test('an idle stop (stopped false) does not claim that real work was stopped', () => {
  const status = { textContent: '' }
  const stop = { hidden: false }
  applyLocalModelStopAnswer({ action: { ok: true, stopped: false }, status, stop })
  assert.equal(status.textContent, GUIDE_LOCAL_MODEL_STOP_IDLE,
    'bad value caught: stopped false collapsed into the real-stop sentence')
  assert.equal(stop.hidden, true,
    'bad value caught: an idle stop left a stale Stop control visible')
})

test('a real stop (stopped true) is reported distinctly', () => {
  const status = { textContent: '' }
  const stop = { hidden: false }
  applyLocalModelStopAnswer({ action: { ok: true, stopped: true }, status, stop })
  assert.equal(status.textContent, LOCAL_MODEL_SETUP.stopped,
    'bad value caught: stopped true reported as though no flight existed')
  assert.notEqual(status.textContent, GUIDE_LOCAL_MODEL_STOP_IDLE,
    'bad value caught: idle and real stop outcomes use one sentence')
})

test('the stop payload carries the field main.cjs selects on', () => {
  assert.deepEqual(localModelStopPayload('ollama', undefined), { runtime: 'ollama' },
    'bad value caught: an install stop accidentally carried a model field')
  assert.deepEqual(localModelStopPayload('ollama', 'qwen3:8b'), { runtime: 'ollama', model: 'qwen3:8b' },
    'bad value caught: a pull stop omitted model and selected the install flight')
})
