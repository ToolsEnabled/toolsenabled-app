/* A GREEN DOT OVER MOCK DATA IS A WORDLESS LIE.
 *
 * Harvested from public/preview/honesty.js -- the old hand-written website
 * preview's runtime auditor -- before that directory retires with the second
 * render. Its two lists are the only machinery in the tree that catches a
 * LIVENESS INDICATOR with no words in it: Machine B's original finding was not
 * a sentence, it was a dot. "A dot has no words; it still makes a claim."
 *
 * Under one render fed by three sources this defect gets EASIER to ship, not
 * harder: the same DOM is painted from mock and from a real machine, so a
 * class that means "live" will happily sit over the example fleet unless
 * something looks. The old auditor ran at runtime over one page; this guard is
 * static over the view sources, so it is weaker in reach and stronger in
 * placement -- it runs on every `npm test`, not on one retired surface.
 *
 * WHAT IT PINS:
 *   1. The lists themselves stay exported here for the packaged QA drives to
 *      import, so the vocabulary of "things that claim liveness" has one home.
 *   2. Known indicator sites in mock-reachable templates keep their words:
 *      metrics' `sim-dot` renders beside "made-up numbers" -- the words are
 *      load-bearing, the dot alone is the defect.
 *   3. No view source mints a NEW liveness-marker class token in a template
 *      that also renders the example badge, without this file being told --
 *      an allowlist assertion, so the failure message names the file and the
 *      token instead of silently passing.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

/* Verbatim from public/preview/honesty.js. If that file is gone, these are its
 * survivors; if it still exists, the pair are asserted identical below so the
 * vocabulary cannot fork while both live. */
export const LIVENESS_CLAIM =
  /\b(live|real[\s-]?time|realtime|connected|online|streaming now|actually running|right now)\b/i

export const LIVENESS_MARKERS = Object.freeze([
  '.live', '.is-live', '.live-dot', '.dot-live', '.online', '.is-online',
  '.realtime', '.status-live', '.badge-live', '.pulse-live',
  '[data-live]', '[data-status="live"]', '[data-status="online"]',
  '[data-state="live"]', '[data-realtime]', '[aria-live="live"]',
])

test('while the old preview auditor exists, the harvested lists behave identically', async () => {
  const preview = join(ROOT, 'public', 'preview', 'honesty.js')
  if (!existsSync(preview)) return
  const {
    LIVENESS_CLAIM: previewLivenessClaim,
    LIVENESS_MARKERS: previewLivenessMarkers,
  } = await import(new URL(`../../public/preview/honesty.js?guard=${Date.now()}`, import.meta.url))
  const probes = [
    'live', 'LIVE', 'real time', 'real-time', 'realtime', 'connected', 'online',
    'streaming now', 'actually running', 'right now',
    'alive', 'delivered', 'clive', 'simulation', '',
  ]
  for (const probe of probes) {
    assert.equal(previewLivenessClaim.test(probe), LIVENESS_CLAIM.test(probe),
      `public/preview/honesty.js and this guard disagree about whether "${probe}" claims liveness`)
  }
  assert.deepEqual(previewLivenessMarkers, LIVENESS_MARKERS,
    'public/preview/honesty.js and this guard refuse different liveness marker vocabularies')
})

test('the metrics sim-dot never sheds its words', () => {
  const source = read('src/views/metrics.js')
  const at = source.indexOf('sim-dot')
  assert.notEqual(at, -1, 'the sim-dot indicator left metrics.js -- retire this pin deliberately, not by accident')
  /* The words must be in the same template as the dot: near enough that no
     refactor can ship the dot to one element and the sentence to a dead one. */
  const neighbourhood = source.slice(Math.max(0, at - 400), at + 400)
  assert.match(neighbourhood, /made-up numbers/,
    'the sim-dot renders without "made-up numbers" beside it -- the dot alone is a wordless liveness claim over the example')
})

test('no view mints a new liveness-marker class without this guard being told', () => {
  /* Class tokens (dot-prefixed markers) that a view may legitimately emit,
     with the reason. Attribute markers are not scanned here: `data-live-mode`
     is the product's own DOM vocabulary carrying 'simulated' as a VALUE, which
     is the opposite of a liveness claim. */
  const ALLOWED = new Map([
    /* none today -- the live faces earn their dots from real data and the
       mock faces carry words. Add entries here ONLY with the words check. */
  ])
  const classTokens = new Set(LIVENESS_MARKERS.filter(m => m.startsWith('.')).map(m => m.slice(1)))
  const views = readdirSync(join(ROOT, 'src', 'views')).filter(f => f.endsWith('.js'))
  for (const view of views) {
    const source = read(join('src', 'views', view))
    /* WHOLE TOKENS, not substrings. The first draft used word boundaries,
       which fired on the hyphenated middle of "data-live-mode" -- an attribute
       that carries 'simulated' as a value and is the OPPOSITE of a liveness
       claim. A marker is a class token in its entirety, so the attribute is
       split the way the DOM splits it. */
    for (const attr of source.match(/class="([^"]*)"/g) || []) {
      for (const token of attr.slice(7, -1).split(/\s+/)) {
        if (!classTokens.has(token)) continue
        assert.ok(ALLOWED.get(view)?.includes(token),
          `src/views/${view} emits liveness marker class "${token}" -- if the surface can render mock data, that dot is a claim; add words and an ALLOWED entry naming why`)
      }
    }
  }
})
