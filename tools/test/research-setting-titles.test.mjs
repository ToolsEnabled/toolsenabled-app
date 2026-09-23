/* THE PLAIN NAME OF A RESEARCH SWITCH, OR ITS IDENTIFIER.
 *
 * Written failing-first for the settings-truth lane. Measured on this
 * checkout's own shipped payload before the fix:
 *
 *   node -e "readProductSettings({ root: 'capability' })"
 *     research.pipeline        | present: true | label: null
 *     research.runner_agent    | present: true | label: null
 *     research.runner_process  | present: true | label: null
 *     research.runner_http     | present: true | label: null
 *     agent.tool_summary       | present: true | label: null
 *
 * Every label came back null, so src/research-settings.js `titleOf()` fell to
 * its last resort and put the IDENTIFIER on the glass. An external user opened
 * Settings and read "research.pipeline" where "Running research jobs on this
 * computer" belongs -- four times, in the one section of the page whose rows
 * are genuinely enforced.
 *
 * THE CAUSE WAS ONE WORD. shell/product-settings.cjs read `parsed.labels`. The
 * shipped registry's top-level keys are exactly ["schemaVersion","titles",
 * "entries"] -- the map is called `titles`, and always has been in every copy
 * of it in this tree. The reader therefore returned {} unconditionally,
 * on every machine, for every row, and the fallback in the page was not a
 * fallback: it was the only path.
 *
 * WHY THIS TEST ASSERTS A KNOWN SENTENCE RATHER THAN "a label exists". A test
 * for truthiness would have gone green on the id itself, which is a non-empty
 * string. It has to know what the registry says and demand exactly that, and
 * it has to read the registry rather than restate it, so that renaming a title
 * in the registry moves the test with it instead of breaking it.
 *
 * THE THIRD TEST IS THE STRUCTURAL ONE. Reading a key the file does not carry
 * fails silently by design here (an unreadable or key-less registry is meant to
 * yield no label, not an exception), so the shape of the registry is asserted
 * directly. That is the assertion that would have caught this on the day the
 * key was named.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/* Named before the first require of anything that resolves a state root: the
   payload's settings reader resolves its values path at call time, and a probe
   that leaves it unset reads (and could create) the real installation's own
   settings beside the real program. */
process.env.TOOLSENABLED_STATE_ROOT = path.join(os.tmpdir(), 'mc-research-setting-titles')

const require_ = createRequire(import.meta.url)
const PAYLOAD_ROOT = path.join(ROOT, 'capability')
const REGISTRY_PATH = path.join(PAYLOAD_ROOT, 'config', 'settings-registry.json')

function registryDocument() {
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
}

test('the shipped registry names its plain-name map `titles`', () => {
  const parsed = registryDocument()
  assert.ok(
    parsed.titles && typeof parsed.titles === 'object' && !Array.isArray(parsed.titles),
    'the registry carries a `titles` map of plain names',
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed, 'labels'),
    false,
    'there is no `labels` map -- a reader that asks for one gets nothing, silently',
  )
  assert.equal(parsed.titles['research.pipeline'], 'Running research jobs on this computer')
})

test('every writable row comes back with the registry\'s own plain name', () => {
  const { readProductSettings, WRITABLE_IDS } = require_(path.join(ROOT, 'shell', 'product-settings.cjs'))
  const titles = registryDocument().titles
  const answer = readProductSettings({ root: PAYLOAD_ROOT, fresh: true })
  assert.equal(answer.available, true, answer.reason || 'the checkout payload is readable')

  for (const id of WRITABLE_IDS) {
    const row = answer.rows.find(item => item.id === id)
    assert.ok(row, `${id} is reported`)
    if (!row.present) continue
    assert.equal(
      row.label,
      titles[id],
      `${id} carries the registry's plain name, not null`,
    )
    assert.notEqual(row.label, id, `${id} is not titled with its own identifier`)
  }
})

test('the research section draws the plain name, never the identifier', async () => {
  const { readProductSettings } = require_(path.join(ROOT, 'shell', 'product-settings.cjs'))
  const { createResearchSettings } = await import('../../src/research-settings.js')

  const answer = readProductSettings({ root: PAYLOAD_ROOT, fresh: true })
  const section = createResearchSettings({
    shell: { read: async () => answer, set: async () => ({ ok: false }) },
  })
  await section.load()
  const html = section.markup()

  /* The id is allowed in data attributes -- the row is addressed by it -- so
     the assertion is about what a person READS: the row's own title element.
     The title text comes first; an "Unsaved" pending mark may follow it inside
     the same element, so the match stops at the first nested tag. */
  const names = [...html.matchAll(/<div class="settings-name"[^>]*>([^<]*)/g)].map(m => m[1])
  assert.ok(names.length >= 4, `the section drew its rows (${names.length})`)
  for (const name of names) {
    assert.ok(!/^[a-z_]+\.[a-z_]+$/.test(name), `"${name}" is a sentence, not an identifier`)
  }
  assert.ok(
    names.includes('Enable research jobs'),
    'the master switch has the shorter, descriptive Settings title',
  )
})
