/* THE LOCAL MODEL ROWS: CAN A PERSON CHOOSE THE MODEL THAT ANSWERS THEM?
 *
 * `model.provider`, `model.endpoint` and `model.name` are declared in the
 * settings registry and enforced by the payload, and until this lane nothing on
 * the settings page could write any of them: they are absent from
 * shell/product-settings.cjs WRITABLE_IDS and from src/research-settings.js
 * PRODUCT_SETTING_IDS. This file asserts the behaviour a person is promised by
 * the design note the owner is being shown -- pick a model the endpoint is
 * really serving, and have both the local spawn tier and the customer-model
 * tool use it.
 *
 * WHAT IT ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. Every assertion here
 * calls the writer with a value and reads the value back. None of them matches
 * a sentence, a code spelling or a control class name: a name-shaped assertion
 * fails against a better implementation, and the quickest way back to green
 * would be to put the defect back.
 *
 * THE MOST VALUABLE CASE IN THIS FILE is the run-time-discovered name. A model
 * name comes from whatever the person's own runtime is serving -- Ollama
 * reports names of the `hf.co/<publisher>/<repo>-gguf:<quant>` form -- so it can
 * never appear in a static options array. A registry class validated against
 * `entry.options` (`seg`, `select`) would refuse every such name. This test is
 * what stops that being done later by someone who only sees a picker and
 * reaches for `select`.
 *
 * THE PAYLOAD IS NAMED BY A VARIABLE, NEVER A PATH. A test that named a machine
 * would be green at one desk and red at every other. It defaults to this
 * checkout's own staged payload; when neither is present the drive SKIPS BY
 * NAME and says which requirement was missing, because a silent skip is the
 * defect this repository keeps re-finding.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const PROVIDER_ID = 'model.provider'
const ENDPOINT_ID = 'model.endpoint'
const NAME_ID = 'model.name'
const MODEL_ROW_IDS = Object.freeze([PROVIDER_ID, ENDPOINT_ID, NAME_ID])

const PAYLOAD = process.env.MC_TEST_LOCAL_MODELS_PAYLOAD || path.join(ROOT, 'capability')
const REGISTRY_FILE = path.join(PAYLOAD, 'config', 'settings-registry.json')
const payloadPresent = existsSync(path.join(PAYLOAD, 'src', 'lib', 'settings.js')) && existsSync(REGISTRY_FILE)

/* Every write lands in a fresh temporary file, never in the settings of
   whatever machine runs the suite. The payload's own resolver honours these
   variables, so nothing here rebuilds a path it would have to keep in step
   with the payload's src/lib/settings.js. */
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'local-models-settings-'))
process.env.TOOLSENABLED_SETTINGS_PATH = path.join(SCRATCH, 'settings.json')
process.env.TOOLSENABLED_STATE_ROOT = SCRATCH

const shell = require_(path.join(ROOT, 'shell', 'product-settings.cjs'))
const section = await import('../../src/research-settings.js')

console.log(`[local-models] payload ${PAYLOAD}`)
console.log(`[local-models] ${payloadPresent
  ? 'PAYLOAD PRESENT -- driving control -> settings file -> read back'
  : 'PAYLOAD ABSENT -- the write drive did NOT run here; point MC_TEST_LOCAL_MODELS_PAYLOAD at a payload carrying src/lib/settings.js and config/settings-registry.json'}`)

const skipNoPayload = t => t.skip(
  `this payload lacks src/lib/settings.js or config/settings-registry.json at ${PAYLOAD};`
  + ' the control -> settings file -> read-back drive did not run;'
  + ' point MC_TEST_LOCAL_MODELS_PAYLOAD at a payload carrying both')

/* A model the person's own runtime reports. Written as a constant because it is
   the SHAPE that matters -- publisher, repository and quantisation, with the
   separators Ollama itself uses -- not this particular model. */
const DISCOVERED_NAME = 'hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-gguf:Q3_K_M'

function storedValue(id) {
  const document = JSON.parse(readFileSync(process.env.TOOLSENABLED_SETTINGS_PATH, 'utf8'))
  return document && document.values ? document.values[id] : undefined
}

test('the settings window can write the row that decides which model answers', () => {
  for (const id of MODEL_ROW_IDS) {
    assert.ok(shell.WRITABLE_IDS.includes(id),
      `${id} must be writable from the settings window: a row a person cannot change is a row`
      + ' the product decided for them, and the owner asked to choose the local model by name')
  }
})

test('the page offers exactly the rows the writer accepts', () => {
  assert.deepEqual([...section.PRODUCT_SETTING_IDS], [...shell.WRITABLE_IDS],
    'which rows a person is offered stays ONE decision and not two -- a row in only one of'
    + ' these lists is either a control the writer refuses or a value written by nothing on screen')
})

test('a model name discovered at run time survives the writer unchanged', t => {
  if (!payloadPresent) return skipNoPayload(t)
  const written = shell.setProductSetting({ id: NAME_ID, value: DISCOVERED_NAME }, { root: PAYLOAD })
  assert.equal(written.ok, true,
    `a name the runtime is really serving must be accepted; the writer refused it: ${written.reason || written.message || ''}`)
  assert.equal(storedValue(NAME_ID), DISCOVERED_NAME,
    'the exact name the endpoint reports is what must reach the settings file: the local tier'
    + ' and the customer-model tool both match this string against what the runtime lists,'
    + ' so a normalised or truncated name selects nothing')
})

test('the endpoint and provider a local-only setup needs are writable together', t => {
  if (!payloadPresent) return skipNoPayload(t)
  const provider = shell.setProductSetting({ id: PROVIDER_ID, value: 'Ollama' }, { root: PAYLOAD })
  assert.equal(provider.ok, true, `the provider row must accept a declared option: ${provider.reason || provider.message || ''}`)
  const endpoint = shell.setProductSetting({ id: ENDPOINT_ID, value: 'http://127.0.0.1:11434' }, { root: PAYLOAD })
  assert.equal(endpoint.ok, true, `the endpoint row must accept a loopback address: ${endpoint.reason || endpoint.message || ''}`)
  assert.equal(storedValue(PROVIDER_ID), 'Ollama')
  assert.equal(storedValue(ENDPOINT_ID), 'http://127.0.0.1:11434')
})

/* THE TRAP THIS GUARDS, BY NAME. tools/test/settings-rows-do-something.test.mjs
   requires every offered row to be declared in the STAGED payload's registry,
   and src/research-settings.js titleOf() puts the raw identifier on the glass
   for a row the registry does not declare. A row offered before its payload
   declares it therefore breaks two standing gates at once -- which is exactly
   why agent.agent_api waited. These three are already declared, and this test
   is what says so out loud rather than leaving it to luck. */
test('every model row offered is already declared in the staged payload registry', t => {
  if (!payloadPresent) return skipNoPayload(t)
  const registry = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'))
  for (const id of MODEL_ROW_IDS) {
    const entry = registry.entries.find(item => item && item.id === id)
    assert.ok(entry, `${id} is not in the staged registry, so offering it would draw a row with no reader`)
    assert.ok(typeof registry.titles[id] === 'string' && registry.titles[id].trim().length > 0,
      `${id} has no plain name in the staged registry, so the page would draw its identifier`)
  }
})

/* WHY THIS ONE IS NOT A SPELLING PIN. It asserts what the class DOES -- accept a
   name that no static list could contain -- rather than that the class is called
   anything in particular. A better implementation may rename the class freely;
   it may not start refusing the person's own models. */
test('the class chosen for the model name must not be one validated against a fixed list', t => {
  if (!payloadPresent) return skipNoPayload(t)
  const registry = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'))
  const entry = registry.entries.find(item => item && item.id === NAME_ID)
  assert.ok(entry, `${NAME_ID} is not in the staged registry`)
  assert.equal(Array.isArray(entry.options), false,
    'a model name is whatever the person\'s runtime is serving, so a row validated against a'
    + ' static options array would refuse every name the runtime discovers, including every'
    + ' hf.co-published model the owner currently has installed')
})

