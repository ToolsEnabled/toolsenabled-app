/* THE ADDRESS: A VALUE THE PERSON TYPES.
 *
 * The engine lane added a control class for exactly this -- `text`, meaning a
 * value typed rather than chosen -- and moved `model.endpoint` onto it. It
 * validates identically to the chooser class; what differs is what this window
 * draws for it, which is this file's subject. A field, not a chooser, and never
 * a tick.
 *
 * WHY IT MUST NOT BE THE CHOOSER. An address is not one of a discovered set:
 * the whole point of typing one is to name a runtime this product did not find.
 * Drawing it as a chooser was tried and a test caught it -- the row then said
 * "nothing has been discovered to choose from yet", which is meaningless about
 * something a person types.
 *
 * WHY IT MUST NOT REACH FOR THE MACHINE BEFORE IT SAVES. Storing what was typed
 * is what lets a person correct a typo; refusing to store an address because
 * nothing answers there would trap somebody whose runtime is simply not started
 * yet. The section already says, separately and in its own words, when the
 * address it holds is unusable or unanswered.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const { createResearchSettings, sectionOfRow, DRAWABLE_CONTROLS } = await import('../../src/research-settings.js')

const ADDRESS = 'http://127.0.0.1:11434'

const addressRow = (value = ADDRESS) => ({
  id: 'model.endpoint',
  present: true,
  control: 'text',
  label: 'Where your AI service is running',
  value,
  provenance: { source: 'user', atMs: 1, directive: null },
  enforcement: { declared: true, enforcedBy: 'payload src/lib/providers/customer-model.js' },
})

async function build({ rows = [addressRow()], set } = {}) {
  const written = []
  const controller = createResearchSettings({
    shell: {
      read: async () => ({ ok: true, available: true, rows }),
      set: set || (async (id, value) => { written.push({ id, value }); return { ok: true } }),
    },
    readLocalRuntimes: null,
  })
  await controller.load()
  return { controller, written, html: controller.markup({ section: sectionOfRow('model.endpoint') }) }
}

test('the class a person types into is one this window can draw', () => {
  assert.ok(DRAWABLE_CONTROLS.has('text'),
    'a class the window cannot draw gets no control and a sentence saying so, which would leave the'
    + ' address permanently uneditable while the writer stood ready to accept it')
})

test('the address is drawn as a field holding what is stored', async () => {
  const { html } = await build()
  assert.ok(/<input[^>]+data-research-text="model\.endpoint"/.test(html),
    'the address must be an editable field carrying its own row id, which is what the change'
    + ' handler reads when the person commits it')
  assert.ok(html.includes(`value="${ADDRESS}"`),
    'and it must open holding the address actually stored, not an empty box a person must retype')
})

test('the address is never drawn as a chooser or as a tick', async () => {
  const { html } = await build()
  assert.equal(html.includes('data-research-choice="model.endpoint"'), false,
    'an address is not one of a discovered set: the reason for typing one is to name a runtime'
    + ' this product did not find')
  assert.equal(html.includes('data-research-setting="model.endpoint"'), false,
    'and a tick on an address asks the program to store true where an address belongs')
})

test('an address the person types is stored as typed', async () => {
  const { controller, written } = await build()
  await controller.setValue('model.endpoint', 'http://127.0.0.1:1234')
  assert.deepEqual(written, [{ id: 'model.endpoint', value: 'http://127.0.0.1:1234' }],
    'what the person typed is what is stored: the exact string, with no trimming to a shape this'
    + ' window guessed at')
})

test('an address nothing answers at is still stored, so a typo can be corrected', async () => {
  const { controller, written } = await build()
  await controller.setValue('model.endpoint', 'http://127.0.0.1:9')
  assert.equal(written.length, 1,
    'the writer must not require the address to be reachable: a person whose runtime is not started'
    + ' yet would be unable to save the address that would let them start it')
  assert.equal(written[0].value, 'http://127.0.0.1:9')
})

