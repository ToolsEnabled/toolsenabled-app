/* WHERE THE LIST COMES FROM, AND THE FOUR ANSWERS IT CAN GIVE.
 *
 * The chooser draws whatever `row.choices` holds. This file is about who fills
 * it: a read of the machine, through the same bridge the This computer section already
 * uses, which answers with every local runtime it found and the models each is
 * serving. No new channel is added for this.
 *
 * THE FOUR ANSWERS ARE NOT THREE. A person's endpoint can be serving models; it
 * can be answering and serving none; it can be absent, with something else
 * listening elsewhere; and the read itself can fail. The last two are the pair
 * this product keeps collapsing, and collapsing them is what sends a person to
 * fix the wrong thing: "could not check" is not "nothing is there".
 *
 * MATCHED ON THE ADDRESS THE PERSON CONFIGURED. The read scans the usual local
 * ports, so it can find a runtime the person did not name. Offering that
 * runtime's models under a setting pointed somewhere else would be this window
 * choosing a service on their behalf, which is the one thing the model rows
 * exist to stop.
 *
 * The sentences are asserted through the exported constants rather than as
 * literals: this file checks that the right STATE is reached, and leaves the
 * wording to the copy it belongs to.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const {
  createResearchSettings, sectionOfRow, LOCAL_MODELS_SECTION,
  NOTHING_DISCOVERED_YET, COULD_NOT_CHECK_ENDPOINT, ENDPOINT_DID_NOT_ANSWER, UNUSABLE_ENDPOINT,
  ENDPOINT_NOT_CONFIGURED, ENDPOINT_NOT_PROBED,
} = await import('../../src/research-settings.js')

const ENDPOINT = 'http://127.0.0.1:11434'
const SERVED = Object.freeze([
  'qwen3.5:9b',
  'hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-gguf:Q3_K_M',
  'hf.co/John1604/Qwen3-Coder-30B-A3B-Instruct-gguf:q3_k_s',
])

const rows = (name = 'qwen3.5:9b', endpoint = ENDPOINT) => ([
  /* THE ADDRESS IS NOT A CHOICE, AND THIS FIXTURE SAYS SO BECAUSE THE PRODUCT
     DOES. The engine lane moves only `model.name` to the chooser class; the
     address stays a shown value, because an address is typed rather than picked
     from a list something discovered. Writing it here as a chooser row was my
     first draft and a test caught it: the address row then drew "nothing has
     been discovered to choose from yet", which is meaningless about a field a
     person types. The consequence is a real and stated gap -- the writer will
     now accept this row, but nothing on screen edits it yet, so a person whose
     runtime is not on the usual address still cannot point the product at it
     from this page. */
  {
    id: 'model.endpoint', present: true, control: 'readback', label: 'Where your AI service is running',
    value: endpoint, provenance: { source: 'user', atMs: 1, directive: null },
    enforcement: { declared: true, enforcedBy: 'a reader' },
  },
  {
    id: 'model.name', present: true, control: 'pick', label: 'Which model your AI service uses',
    value: name, provenance: { source: 'user', atMs: 1, directive: null },
    enforcement: { declared: true, enforcedBy: 'a reader' },
  },
])

async function paint({ read, name, endpoint } = {}) {
  const controller = createResearchSettings({
    shell: { read: async () => ({ ok: true, available: true, rows: rows(name, endpoint) }), set: async () => ({ ok: true }) },
    readLocalRuntimes: read,
  })
  await controller.load()
  return controller.markup({ section: sectionOfRow('model.name') })
}

const listening = (host, port, models) => async () => ({
  ok: true,
  runtimes: [{ runtime: 'ollama', displayName: 'Ollama', host, port, listening: true, models }],
})

test('a direct visit to Local models repaints when its asynchronous settings read finishes', async () => {
  const panel = { outerHTML: '', dataset: { productSection: LOCAL_MODELS_SECTION }, querySelector: () => null }
  const root = {
    querySelector: selector => selector === '[data-local-models-settings]' ? panel : null,
    querySelectorAll: selector => selector === '[data-product-section]' ? [panel] : [],
    addEventListener() {}, removeEventListener() {},
  }
  const controller = createResearchSettings({
    shell: { read: async () => ({ ok: true, available: true, rows: rows() }), set: async () => ({ ok: true }) },
    readLocalRuntimes: listening('127.0.0.1', 11434, SERVED),
  })
  controller.bind(root)
  assert.match(controller.markup({ section: LOCAL_MODELS_SECTION }), /Reading settings/)
  await controller.load()
  assert.match(panel.outerHTML, /data-setting-id="model.name"/)
  assert.ok(panel.outerHTML.includes(SERVED[0]))
  assert.doesNotMatch(panel.outerHTML, /Reading settings/)
  controller.destroy()
})

test('the models the configured endpoint is serving are the ones offered', async () => {
  const html = await paint({ read: listening('127.0.0.1', 11434, SERVED) })
  for (const model of SERVED) {
    assert.ok(html.includes(`data-research-value="${model}"`),
      `${model} is being served at the address the person configured and must be offerable`)
  }
})

test('a runtime found at some other address does not have its models offered', async () => {
  const html = await paint({ read: listening('127.0.0.1', 1234, SERVED) })
  for (const model of SERVED) {
    assert.equal(html.includes(`data-research-value="${model}"`), false,
      'a runtime the person did not point this setting at must not have its models offered:'
      + ' choosing one would silently send their prompts to a service they did not name')
  }
  assert.ok(html.includes(ENDPOINT_NOT_PROBED),
    'a local scan of other addresses cannot establish that this endpoint failed')
  assert.equal(html.includes(ENDPOINT_DID_NOT_ANSWER), false)
})

test('an untouched endpoint is unconfigured rather than an invalid address or a failed service', async () => {
  for (const endpoint of ['', '   ']) {
    const html = await paint({ read: listening('127.0.0.1', 11434, SERVED), endpoint })
    assert.ok(html.includes(ENDPOINT_NOT_CONFIGURED))
    assert.equal(html.includes(UNUSABLE_ENDPOINT), false)
    assert.equal(html.includes(ENDPOINT_DID_NOT_ANSWER), false)
  }
})

test('a runtime actually probed at the configured address can report that it did not answer', async () => {
  const html = await paint({ read: async () => ({ ok: true,
    runtimes: [{ host: '127.0.0.1', port: 11434, listening: false }] }) })
  assert.ok(html.includes(ENDPOINT_DID_NOT_ANSWER))
  assert.equal(html.includes(ENDPOINT_NOT_PROBED), false)
})

test('remote endpoints and unscanned local ports retain manual model entry without claiming a failed connection', async () => {
  for (const endpoint of ['https://models.example.test/v1', 'http://models.example.test/v1', 'http://127.0.0.1:45678']) {
    const html = await paint({ read: listening('127.0.0.1', 11434, SERVED), endpoint })
    assert.ok(html.includes(ENDPOINT_NOT_PROBED), endpoint)
    assert.equal(html.includes(UNUSABLE_ENDPOINT), false, endpoint)
    assert.equal(html.includes(ENDPOINT_DID_NOT_ANSWER), false, endpoint)
    assert.match(html, /data-research-text="model.name"/)
  }
})

test('standard HTTP ports and bracketed IPv6 match the address actually probed', async () => {
  for (const [endpoint, host, port] of [['http://localhost', '127.0.0.1', 80], ['http://[::1]:11434', '::1', 11434]]) {
    const html = await paint({ read: listening(host, port, SERVED), endpoint })
    assert.ok(html.includes(`data-research-value="${SERVED[0]}"`), endpoint)
  }
  const html = await paint({ read: listening('127.0.0.1', 443, SERVED), endpoint: 'https://127.0.0.1' })
  assert.ok(html.includes(ENDPOINT_NOT_PROBED), 'an HTTP response is not proof about HTTPS on the same port')
})

test('unsupported address schemes give an address remedy even when a local runtime is present', async () => {
  for (const endpoint of ['file:///tmp/model', 'ftp://localhost:11434', 'http://localhost:0']) {
    const html = await paint({ read: listening('127.0.0.1', 11434, SERVED), endpoint })
    assert.ok(html.includes(UNUSABLE_ENDPOINT), endpoint)
    assert.equal(html.includes(ENDPOINT_DID_NOT_ANSWER), false, endpoint)
  }
})

test('an endpoint that answers and serves nothing says exactly that', async () => {
  const html = await paint({ read: listening('127.0.0.1', 11434, []) })
  assert.ok(html.includes(NOTHING_DISCOVERED_YET),
    'an endpoint that is up with no models is a different state from one that did not answer')
  assert.equal(html.includes('data-research-choice="model.name"'), false,
    'and it draws no chooser, because there is nothing to choose')
})

test('a read that could not be made is never reported as nothing being there', async () => {
  const html = await paint({ read: async () => { throw new Error('the bridge is not there') } })
  assert.ok(html.includes(COULD_NOT_CHECK_ENDPOINT),
    'could not check and nothing is there send a person to fix two different things, so they are'
    + ' two sentences; merging them is how somebody restarts a service that was already running')
  assert.equal(html.includes(NOTHING_DISCOVERED_YET), false,
    'and the failed read must not borrow the empty-endpoint sentence')
})

test('with no reader at all the row still says which of the two silences this is', async () => {
  const html = await paint({ read: undefined })
  assert.ok(html.includes(COULD_NOT_CHECK_ENDPOINT),
    'a window with no bridge to the machine has not discovered that nothing is served; it has not'
    + ' looked, and the row says so')
})

/* FOUND BY RUNNING THIS AGAINST THE MACHINE'S OWN RUNTIME RATHER THAN A STUB.
   An address the product cannot parse was answering "nothing answered at the
   address above", which sends a person to restart a service when what is wrong
   is the text they typed. An unusable address is its own state and says so. */
test('an address the product cannot use says so, rather than blaming the service', async () => {
  const html = await paint({ read: listening('127.0.0.1', 11434, SERVED), endpoint: 'not an address' })
  assert.ok(html.includes(UNUSABLE_ENDPOINT),
    'a person whose address is mistyped must be told the address is unusable, not that their'
    + ' service failed to answer: those two sentences send them to fix different things')
  assert.equal(html.includes(ENDPOINT_DID_NOT_ANSWER), false,
    'and it must not borrow the sentence about a service that did not answer')
})

test('the model in use is offered even while it is the one already chosen', async () => {
  const html = await paint({ read: listening('127.0.0.1', 11434, SERVED), name: SERVED[1] })
  assert.ok(html.includes(`data-research-value="${SERVED[1]}"`),
    'the chosen model stays in the list rather than being drawn as a special case')
  const at = html.indexOf(`data-research-value="${SERVED[1]}"`)
  assert.ok(/aria-pressed="true"/.test(html.slice(at - 200, at + 200)),
    'and it reads as the chosen one')
})
