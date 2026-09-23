
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { assertValidProjection } from '../gen-projection-lib.mjs'
import { parseRoute } from '../../src/route-parse.js'

const ROOT = resolve(import.meta.dirname, '..', '..')
const read = path => readFileSync(resolve(ROOT, path), 'utf8')

// The SHIPPED research envelope. Two clauses in this file used to assert its
// contents -- 7 safe rows, 7 gated rows, 7 method notes, an observed-empty
// findings register. T4c ("ship honest empty data instead of the owner's
// snapshot") replaced every shipped projection with an unavailable envelope,
// because the populated ones carried the titles and absolute paths of ~14 of
// the owner's private reports into the installer. Those assertions then read a
// file that policy requires to be empty.
//
// The counts are properties of the GENERATOR, not of a shipping decision, and
// they now live in research-generator.test.mjs against a fixture that cannot be
// emptied out from under them -- with two clauses that were missing there
// (methodNotes length, and the exact source-out-of-scope reasons) carried over.
//
// What stays here is what this file is actually about: the view's contract, and
// the shipped file's structural honesty in whichever state it ships. These are
// deliberately written to hold BOTH before and after the open question of
// whether real data should ship is settled, so settling it does not turn this
// suite red again.
const shippedEnvelope = () => JSON.parse(read('public/data/research.json'))

function assertHonestEnvelope(envelope) {
  assert.doesNotThrow(() => assertValidProjection('research', envelope))
  if (envelope.ok === true) {
    assert.equal(envelope.reason, null, 'an available envelope states no reason')
    assert.notEqual(envelope.data, null, 'an available envelope carries data')
    return true
  }
  assert.equal(envelope.data, null, 'an unavailable envelope must carry no data at all')
  assert.equal(typeof envelope.reason, 'string')
  assert.notEqual(envelope.reason.length, 0, 'an unavailable envelope must say why')
  return false
}

test('research projection validation rejects an unavailable envelope carrying data', () => {
  const invalidEnvelope = {
    ...shippedEnvelope(),
    data: {},
  }
  assert.throws(
    () => assertValidProjection('research', invalidEnvelope),
    error => error?.code === 'PROJECTION_SCHEMA_REJECTED',
  )
})

test('research is an independent ring route backed by the research projection', () => {
  const main = read('src/main.js')
  const liveStatus = read('src/live-status.js')

  // THE RING IS EXTRACTED AND RUN, NOT SPELLED OUT. This was an exact-literal
  // match on the whole array until the vault page joined the ring and reddened
  // it without changing anything about research. tools/test/REGRESSION-NOTES.md,
  // "Writing a source-shape pin", asks one question: can this text change while
  // the behaviour this test protects stays true? For an array literal the answer
  // is always yes -- it grows a stop every time the product grows a page -- so
  // the invariant gets pinned instead of the spelling, by technique 3 there
  // (extract the statement and EXECUTE it, then assert on behaviour).
  //
  // What this test is called is what it now pins: research is a stop on the
  // ring. The arrows are the only navigation, so a route absent from the ring is
  // a route nobody can reach.
  //
  // THE PIN HAS A SECOND HALF, and without it the first half is worth nothing.
  // The constant was renamed ORDER -> RING when checkout became conditional: it
  // shipped the operator's own purchase list to strangers, so that stop exists
  // only on a copy that has a list (src/checkout-visibility.js). Membership of
  // RING is therefore not sufficient for reachability -- a predicate in
  // CONDITIONAL_STOPS can take a stop off the ring at runtime, which is the one
  // thing reading the array cannot see. So research is pinned as being on the
  // ring AND as not being conditional.
  //
  // The review gate the old literal also served -- "an added or removed route is
  // a visible, reviewed change" -- is not lost, and is not this file's job. It
  // belongs to tools/test/help-page-pages.test.mjs, which compares the router's
  // routes against the guide's rows and names the route that moved.
  const ringLiteral = main.match(/\nconst RING = (\[[^\]]*\])/)
  assert.ok(ringLiteral, 'the ring is gone from src/main.js; research reachability cannot be checked here')
  const ring = new Function(`return ${ringLiteral[1]}`)()
  assert.ok(Array.isArray(ring) && ring.length > 0 && ring.every(stop => typeof stop === 'string'),
    'the ring is no longer a plain list of stop names')
  assert.ok(ring.includes('research'), 'research must be a stop on the ring; the arrows are the only navigation')
  const conditional = main.slice(main.indexOf('const CONDITIONAL_STOPS'), main.indexOf('function stopIsOffered'))
  assert.ok(conditional.length > 0, 'the conditional-stop table is gone; ring membership may no longer mean what this test assumes')
  assert.doesNotMatch(conditional, /research/, 'research must be on every copy\'s ring, not conditional on anything')
  assert.deepEqual(parseRoute('#/research'), { name: 'research' })
  assert.match(main, /import \{ parseRoute \} from '\.\/route-parse\.js'/)
  assert.match(main, /case 'research': return researchView\(\)/)
  assert.match(main, /case 'research': return `\$\{base\} \/ research`/)
  assert.match(liveStatus, /'coordinator', 'research'/)
  assert.match(liveStatus, /export const fetchResearch = options => fetchProjection\('research', options\)/)
})

test('research view keeps authorization-gated rows metadata-only', () => {
  const view = read('src/views/research.js')
  const lockedBranch = view.slice(
    view.indexOf('function lockedReportMarkup'),
    view.indexOf('function safeReportMarkup'),
  )
  assert.match(view, /report\?\.needsOwnerAuthorization === true/)
  assert.match(lockedBranch, /report\?\.title/)
  assert.match(lockedBranch, /report\?\.authorizationReason/)
  assert.doesNotMatch(lockedBranch, /report\?\.(?:summary|path|bytes|dateObserved|source|id)/)

  // The shipped envelope must never contradict that view contract. Counts are
  // proved in research-generator.test.mjs; what is proved here is that no gated
  // row can reach the installer carrying the fields the locked branch refuses
  // to render. When the file ships unavailable this is true because there are
  // no rows at all, which is asserted rather than assumed.
  const envelope = shippedEnvelope()
  if (!assertHonestEnvelope(envelope)) return
  const catalog = envelope.data.corpusCatalog.value
  const locked = catalog.filter(item => item.needsOwnerAuthorization === true)
  for (const item of locked) {
    assert.equal(typeof item.title, 'string')
    assert.equal(typeof item.authorizationReason, 'string')
    assert.equal(Object.hasOwn(item, 'summary'), false)
  }
})

test('research view distinguishes unavailable observations from observed-empty data', () => {
  const view = read('src/views/research.js')

  // The distinction itself: an observation that could not be made renders
  // differently from one that was made and found nothing. This is the clause
  // that matters, and it is a property of the view.
  assert.match(view, /if \(!observation\?\.ok\) return unavailableMarkup/)
  assert.match(view, /observation\.value\.length === 0\) return emptyMarkup/)
  // Order matters: an unavailable observation has no .value to measure, so the
  // ok check must come first or an unavailable section renders as "empty" --
  // which is the exact false-liveness claim T4c was fixing.
  assert.ok(
    view.indexOf('if (!observation?.ok) return unavailableMarkup') < view.indexOf('observation.value.length === 0'),
    'the unavailable check must precede the empty check',
  )

  // The shipped envelope must state its own availability honestly, whichever
  // state it ships in. The generator's observed-empty vs out-of-scope sections
  // are proved in research-generator.test.mjs.
  const envelope = shippedEnvelope()
  if (!assertHonestEnvelope(envelope)) return
  assert.equal(envelope.data.findingsRegister.ok, true)
  assert.deepEqual(envelope.data.findingsRegister.value, [])
  assert.equal(envelope.data.failureTaxonomy.ok, false)
  assert.equal(envelope.data.failureTaxonomy.reason, 'source-out-of-scope')
  assert.equal(envelope.data.openQuestions.ok, false)
  assert.equal(envelope.data.openQuestions.reason, 'source-out-of-scope')
})

test('the experiment designer is builders first, with the raw text behind an Advanced disclosure', () => {
  const view = read('src/views/research.js')

  /* The builder rows and their controls: a researcher adds an axis or a result
     column as a row, never as raw text, and every row carries its way out. */
  for (const hook of [
    'data-axis-rows', 'data-axis-add', 'data-axis-row', 'data-axis-name', 'data-axis-values', 'data-axis-remove',
    'data-col-rows', 'data-col-add', 'data-col-row', 'data-col-name', 'data-col-kind', 'data-col-required', 'data-col-remove',
  ]) {
    assert.match(view, new RegExp(hook), `the designer lost its ${hook} control`)
  }
  assert.match(view, /axisRowsToObject\(/, 'the axis rows no longer compose through the grid engine helper')
  assert.match(view, /columnRowsToSchema\(/, 'the column rows no longer compose through the grid engine helper')

  /* The live preview: the grid renders as a sentence and chips before Save,
     and a parse refusal renders ITS sentence in the same spot. */
  assert.match(view, /data-exp-preview/, 'the preview host is gone')
  assert.match(view, /gridRunPreview\(/, 'the preview no longer runs the real grid engine')
  assert.match(view, /This grid makes/, 'the preview sentence is gone')
  assert.ok(view.includes('and ${model.more} more'), 'the preview no longer bounds its chips with a count of the rest')

  /* The runner select rewrites the ONE detail field to one meaning at a time;
     the field keeps its name so the submit handler keeps working. */
  assert.match(view, /The task each session runs\. Write \{axis\} tokens and \{dataset\} where values belong\./)
  assert.match(view, /The command, then each argument on its own line\./)
  assert.match(view, /The https address; \{axis\} tokens are filled per run\./)
  assert.match(view, /data-runner-detail-label/, 'the detail label lost its hook')
  assert.match(view, /name="runnerDetail"/, 'the detail field was renamed; the submit handler contract broke')

  /* Nothing was removed: the two raw fields survive behind Advanced, named as
     the submit handler reads them, and the page says the text wins there. */
  assert.match(view, /data-exp-advanced/, 'the Advanced disclosure is gone')
  assert.match(view, /name="moreAxes"/, 'the raw axes field left the form')
  assert.match(view, /name="resultColumns"/, 'the raw columns field left the form')
  assert.match(view, /replaces the axis and column rows above/, 'the Advanced-wins sentence is gone')

  /* Column kinds face the person as words; the stored names ride only on the
     option values, where no person reads them. */
  assert.match(view, /<option value="string">words<\/option>/)
  assert.match(view, /<option value="number">a number<\/option>/)
  assert.match(view, /<option value="boolean">yes or no<\/option>/)
})

test('the tracking layer gathers, duplicates, files findings, and pulses honestly', () => {
  const view = read('src/views/research.js')

  /* The gathered view: a card opens into one inline panel holding its cells,
     its queued runs, and its results — with a way back out. */
  for (const hook of ['data-exp-open', 'data-exp-gathered', 'data-exp-close', 'data-gathered-service', 'data-gathered-chart']) {
    assert.match(view, new RegExp(hook), `the gathered view lost its ${hook} hook`)
  }
  /* Reuse, not duplication: the panel renders through the boards' own
     builders, so the two surfaces cannot drift apart. */
  assert.match(view, /runDrillMarkup\(run\)/, 'the gathered view no longer reuses the drill rows')
  assert.match(view, /resultTableModel\(\{ runs: doneRuns/, 'the gathered view no longer builds the shared table model')
  assert.match(view, /createResultChart\(chartHost/, 'the gathered view lost its chart mount')

  /* Duplicate and the starter templates only PREFILL the one form; the pins
     hold the controls and the sentence that says nothing was saved. */
  for (const hook of ['data-exp-duplicate', 'data-exp-template', 'data-exp-templates']) {
    assert.match(view, new RegExp(hook), `the designer lost its ${hook} control`)
  }
  assert.match(view, /nothing is saved yet/, 'the prefill sentence stopped saying nothing was saved')
  assert.doesNotMatch(view, /expDuplicate[\s\S]{0,400}?persistExperiments/, 'Duplicate must prefill, never save')

  /* Save as finding: the claim posts through the findings client with the
     open status, and the list renders per selected project. */
  for (const hook of ['data-finding-form', 'data-finding-status', 'data-research-findings', 'data-research-findings-list']) {
    assert.match(view, new RegExp(hook), `the findings surface lost its ${hook} hook`)
  }
  // The mounted research-view-state suite verifies the actual save client,
  // submitted body, single-flight custody and newer-draft preservation.
  // Do not pin an inline read of mutable form fields across an async save.
  assert.match(view, /await readFindings\(wanted\)/, 'the findings list no longer reads through the findings client')
  assert.match(view, /selection !== wanted\) return/, 'a slow findings answer for a left project is no longer dropped')
  assert.match(view, /Recorded as \$\{saved\.findingId\}\./, 'the saved finding is no longer named back to the person')

  /* The status strip: computed from the run reads and local cells, absent
     states said honestly, never invented from a refusal. */
  assert.match(view, /data-research-pulse/, 'the status strip host is gone')
  assert.match(view, /nothing running/, 'the strip lost its honest absence sentence')
  assert.ok(view.includes('${running} running · ${queued} queued · ${finished} sessions finished'),
    'the strip must distinguish local session completion from service evidence')
  for (const label of ['results collected', 'dispatched', 'execution only', 'unverified']) assert.ok(view.includes(label))
})

test('research styling stays theme-native across white, tan, and black', () => {
  const css = read('src/research.css') + '\n' + read('src/research-benchmark.css')
  const shared = read('src/styles.css')
  // Shared themes may group equivalent palettes with :root:is(...).
  const selectors = [...shared.matchAll(/:root(?::is\(([^)]+)\)|(\[data-theme="[^"]+"\]))\s*\{/g)]
    .flatMap(match => (match[1] || match[2]).split(',').map(selector => selector.trim()))

  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  for (const theme of ['white', 'tan', 'black']) {
    assert.ok(selectors.includes(`[data-theme="${theme}"]`), `shared palette is missing ${theme}`)
  }
  for (const token of ['--ink', '--ink-2', '--ink-3', '--ink-4', '--line', '--line-2', '--brace']) {
    assert.match(css, new RegExp(token))
  }
})

test('live Sankey empty state preserves the hero slot', () => {
  const view = read('src/views/metrics.js')
  const css = read('src/metrics.css')

  /* R1522 language pass: the sentence leads with what cannot be drawn and why,
     in plain words.
   *
   * THE SENTENCE CHANGED, AND THE CHANGE IS THE POINT. It used to describe the
   * BUILD-TIME projection -- a file written on the builder's machine, absent by
   * construction on every installed copy -- so the widest panel on the page
   * reported the absence of a thing the reader had never had. The panel now
   * draws this computer's own signed record of what each turn used, and its
   * empty state is that record's own absence, which distinguishes a browser, a
   * shell too old to keep the record, a record that will not open, and a record
   * with nothing in it yet. The hero slot below is unchanged and is what this
   * test is really guarding.
   *
   * RE-AIMED with the source-axis cutover: this clause used to also pin the
   * panel's "View the demonstration" button and its setLiveView('metrics',
   * false) press -- the per-view flag machinery the one source axis
   * (src/data-source.js) replaces. Those pins are gone on purpose, and gone
   * from HERE on purpose: whether and how the empty panel still offers the
   * example is the metrics page's contract, and it belongs in the metrics
   * suite beside the code that decides it, not in a research suite that once
   * borrowed the assertion. What stays is deliberately true both before and
   * after the metrics cutover lands, so landing it does not turn this suite
   * red. */
  assert.match(view, /LOCAL_USAGE_COPY\.empty/)
  assert.doesNotMatch(view, /measured usage does not say which pool, provider, or role it belongs to/,
    'the empty state still describes a build-time file the reader does not have')
  assert.match(view, /host\.replaceChildren\(panel\)/)
  assert.match(css, /#sankey-chart\.m-sankey-empty-host[\s\S]*?min-height: 430px/)
})
