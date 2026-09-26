/* THE CHOOSER, AND THE TRAP NEXT TO IT.
 *
 * The engine-side lane gives `model.name` a control class of its own -- `pick`,
 * meaning "chosen from a list this product discovers at run time, not from a
 * fixed one". This file is the window's half: the branch that draws a chooser
 * for that class, and the guard that keeps it from being drawn for anything
 * else.
 *
 * WHY THE GUARD IS THE MORE IMPORTANT HALF. `readback` is the class this
 * registry uses for values the system maintains and shows -- the permission
 * tier, the workspace roots, the captured-rule list. Those are readback
 * PRECISELY because nobody should pick them. A chooser wired to "any class this
 * file cannot otherwise draw" would put a control on all three. Worse, the
 * branch that catches everything else today is the CHECKBOX: a row of a class
 * this file does not know currently renders a tick a person can press, which
 * for a string-valued row would ask the installed application to store `true`
 * in it. So the first test here is not about the feature at all. It is that a
 * class this build cannot draw offers nothing to press.
 *
 * ASSERTED BY WHAT A PERSON CAN PRESS, not by class names or markup shape. The
 * attributes matched here are the ones the section's own click and change
 * handlers read (`data-research-choice`, `data-research-value`,
 * `data-research-setting`), so an assertion that passes means a press really
 * reaches the writer -- and a nicer implementation is free to change every
 * class name in the file without going red.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const { createResearchSettings, sectionOfRow } = await import('../../src/research-settings.js')

const PICK_ROW = Object.freeze({
  id: 'model.name',
  present: true,
  control: 'pick',
  label: 'Which model your AI service uses',
  value: 'qwen3.5:9b',
  /* The list is discovered at run time -- what the person's own endpoint says
     it is serving -- so it arrives on the row rather than out of the registry.
     Two of these three are the published-repository form, which is the shape a
     fixed options list could never contain. */
  choices: Object.freeze([
    'qwen3.5:9b',
    'hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-gguf:Q3_K_M',
    'hf.co/John1604/Qwen3-Coder-30B-A3B-Instruct-gguf:q3_k_s',
  ]),
  provenance: { source: 'user', atMs: 1, directive: null },
  enforcement: { declared: true, enforcedBy: 'payload src/lib/providers/customer-model.js' },
})

const READBACK_ROW = Object.freeze({
  id: 'capability.workspace_roots',
  present: true,
  control: 'readback',
  label: 'The folders your assistants may work in',
  value: 'a folder list this window does not choose',
  provenance: { source: 'installer', atMs: 1, directive: null },
  enforcement: { declared: true, enforcedBy: 'payload src/lib/workspace-boundary.js' },
})

/* PAINTED UNDER THE HEADING THE ROW ITSELF BELONGS TO, asked of the module
   rather than written down here. The module draws two headings and filters each
   to its own rows, so a fixture that named one heading by hand would quietly
   stop exercising anything the day a row moved: the assertions below are all of
   the form "this is not in the markup", and a row filtered out of the heading
   under test satisfies every one of them for the wrong reason. */
async function paint(rows) {
  const controller = createResearchSettings({
    shell: {
      read: async () => ({ ok: true, available: true, rows }),
      set: async () => ({ ok: true }),
    },
  })
  await controller.load()
  return controller.markup({ section: sectionOfRow(rows[0].id) })
}

for (const unsupported of [false, true]) {
test(unsupported ? 'a class this build cannot draw offers nothing to press' : 'a readback row displays its value without an editable control', async () => {
  const html = await paint([{ ...READBACK_ROW, ...(unsupported ? { control: 'future-control' } : {}) }])
  assert.equal(html.includes(`data-research-setting="${READBACK_ROW.id}"`), false,
    'a row whose class this file cannot draw must not fall through to the checkbox: a tick on a'
    + ' string-valued row asks the installed application to store true in it, and these classes'
    + ' exist precisely because the value is not the person\'s to choose')
  assert.equal(html.includes(`data-research-choice="${READBACK_ROW.id}"`), false,
    'nor may it be handed the chooser: the permission tier and the workspace roots are readback'
    + ' because nobody should pick them')
  assert.ok(html.includes(unsupported ? 'can only be changed on the computer itself' : 'This information is read-only.'),
    'it must still say why it cannot be changed here, rather than drawing an empty space')
})
}

test('a pick row offers one press per model the endpoint is serving', async () => {
  const html = await paint([PICK_ROW])
  for (const choice of PICK_ROW.choices) {
    assert.ok(html.includes(`data-research-value="${choice}"`),
      `${choice} is being served and must be offerable: the person picks the exact string the`
      + ' runtime reports, because that is what the local tier and the model tool match against')
  }
  assert.ok(html.includes(`data-research-choice="${PICK_ROW.id}"`),
    'each press must carry the row it writes, which is what the click handler reads')
  assert.equal(html.includes(`data-research-setting="${PICK_ROW.id}"`), false,
    'a pick row is a choice among several, never a tick')
})

test('the model in use is shown as the one chosen, not merely listed', async () => {
  const html = await paint([PICK_ROW])
  const chosen = html.slice(html.indexOf(`data-research-value="${PICK_ROW.value}"`) - 200,
    html.indexOf(`data-research-value="${PICK_ROW.value}"`) + 200)
  assert.ok(/aria-pressed="true"/.test(chosen),
    'the model currently in use must read as chosen to a screen reader as well as to the eye,'
    + ' or a person cannot tell which of three models is answering them')
})

test('a pick row with nothing discovered yet offers nothing to press', async () => {
  const html = await paint([{ ...PICK_ROW, choices: [] }])
  assert.equal(html.includes(`data-research-choice="${PICK_ROW.id}"`), false,
    'an endpoint that answered with no models must not draw an empty chooser: there is nothing'
    + ' to choose, and a control with no options is the shape a person reads as broken')
  assert.equal(html.includes(`data-research-setting="${PICK_ROW.id}"`), false,
    'and it must not fall through to the checkbox either')
})

