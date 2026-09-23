/* THE PREVIEW'S MARKING PRIMITIVES, WHICH NOTHING GUARDED.
 *
 * public/preview/surfaces.js states the rule in its own header: "EVERY DATUM
 * GOES THROUGH simValue(). Every state chip goes through stateChip()." The
 * marker those two stamp is what tells a visitor that a number on the preview
 * is fabricated rather than read off a real machine.
 *
 * MEASURED 2026-08-27, two independent ways: no file under tools/test named
 * simValue, named dataRegion, or contained the literal "data-sim". So the whole
 * marking layer could be deleted and every suite would stay green -- and a
 * visitor would read invented figures as live readings with nothing saying
 * otherwise. preview-honesty.test.mjs is not that guard: it imports DISCLOSURE,
 * SIMULATED_STATES, PAID_GATED, LIVENESS_CLAIM, LIVENESS_MARKERS and
 * assertUnpaid, and never touches these three functions.
 *
 * PROVED TO BITE before it was committed. Removing the setAttribute line from
 * simValue turns this file red; restoring it turns it green.
 *
 * The stand-in below is deliberately the smallest thing that can answer the
 * question. It records what was set rather than simulating a browser, so a
 * failure names the attribute that went missing instead of a DOM discrepancy.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

function standInDocument() {
  return {
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        className: '',
        textContent: '',
        dataset: {},
        attributes: new Map(),
        children: [],
        setAttribute(name, value) { this.attributes.set(name, String(value)) },
        getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null },
        appendChild(child) { this.children.push(child); return child },
      }
    },
  }
}

async function withDocument(run) {
  const prior = globalThis.document
  globalThis.document = standInDocument()
  try {
    const { simValue, dataRegion, stateChip, SIMULATED_STATES } =
      await import('../../public/preview/honesty.js')
    return await run({ simValue, dataRegion, stateChip, SIMULATED_STATES })
  } finally {
    if (prior === undefined) delete globalThis.document
    else globalThis.document = prior
  }
}

test('a simulated value carries the marker that says it is simulated', async () => {
  await withDocument(({ simValue }) => {
    const el = simValue('47 agents')
    assert.equal(el.getAttribute('data-sim'), '1',
      'simValue returned a datum with no simulated marker; a visitor would read it as a live reading')
    assert.equal(el.textContent, '47 agents')
  })
})

test('every value goes through the marker, whatever tag or class it is given', async () => {
  /* The options path is the one a caller reaches for when styling a datum, and
     it is exactly where a marker gets dropped without anyone noticing -- the
     value still renders, it just stops being labelled. */
  await withDocument(({ simValue }) => {
    const el = simValue(12, { tag: 'strong', className: 'pv-branch-name' })
    assert.equal(el.tagName, 'STRONG')
    assert.equal(el.className, 'pv-branch-name')
    assert.equal(el.getAttribute('data-sim'), '1',
      'a styled datum lost its simulated marker while an unstyled one kept it')
    assert.equal(el.textContent, '12', 'a non-string datum must still be rendered as text')
  })
})

test('a state chip is marked too, and an unknown state cannot be painted at all', async () => {
  await withDocument(({ stateChip, SIMULATED_STATES }) => {
    const id = Object.keys(SIMULATED_STATES)[0]
    const chip = stateChip(id)
    assert.equal(chip.getAttribute('data-sim'), '1',
      'a state chip painted without the simulated marker reads as a real status badge')
    assert.equal(chip.dataset.simState, SIMULATED_STATES[id].id)

    assert.throws(() => stateChip('live'), /not a simulated state/,
      'painting a state outside the simulated vocabulary must be unreachable, not merely discouraged')
  })
})

test('a data region is identifiable as one, so unmarked data inside it can be audited', async () => {
  /* dataRegion is what makes the marker AUDITABLE rather than merely present:
     the region says "everything in here is a reading", so anything inside it
     lacking data-sim is a finding. A region with no class cannot be found. */
  await withDocument(({ dataRegion }) => {
    assert.equal(dataRegion().className, 'sim-data-region',
      'a data region with no marker class cannot be audited for unmarked data inside it')
    assert.equal(dataRegion({ tag: 'ul', className: 'pv-v' }).className, 'sim-data-region pv-v',
      'a caller class must be added to the region marker, never replace it')
    assert.equal(dataRegion({ tag: 'ul' }).tagName, 'UL')
  })
})
