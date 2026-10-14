/* THE READABILITY GATE, AND THE PROOF THAT IT IS STILL LOOKING AT ANYTHING.
 *
 * The owner: "the wording is dense and not easy to consume or friendly for
 * users." tools/check-plain-language.mjs is the gate that answers it. This suite
 * is what stops the gate from quietly becoming a no-op, which is the failure
 * mode every scanner in this repository has been bitten by at least once:
 *
 *   - tools/check-suites-discovered.mjs exists because `node --test` exits 0
 *     when its glob matches nothing;
 *   - tools/check-no-owner-data.mjs treats "scanned 0 files" as an error;
 *   - tools/test/refusal-copy.test.mjs tests its own comment stripper, because
 *     a stripper that returned '' would make the scan below it pass forever.
 *
 * A copy scanner has a fourth way to go blind that none of those have: its
 * EXTRACTOR can stop finding strings. If visibleTextFrom() ever returns fewer
 * things, or the wrong things, the gate goes green by measuring less. So the
 * assertions here are in two halves and the first half is the important one:
 *
 *   1. THE EXTRACTOR IS CORRECT on inputs whose right answer is written down
 *      here -- comments blanked, regular expressions understood, template values
 *      cut out, markup tags removed with the tag state carried across a value
 *      that sits inside an attribute, and the non-copy strings rejected by name.
 *   2. THE RULES FIRE on strings that are the defect, and DO NOT FIRE on strings
 *      from this product's own good copy.
 *
 * The gate's verdict over the real tree is asserted last, through the same
 * baseline the command-line gate uses, so `npm test` fails the moment somebody
 * writes a dense sentence -- without anybody having to remember to run a
 * separate command.
 */

import test, { after, mock } from 'node:test'
import assert from 'node:assert/strict'

import {
  describeRejections,
  extractStringLiterals,
  rejectionFor,
  sentencesOf,
  textOfChunk,
  visibleTextFrom,
  withoutComments,
  wordsOf,
} from '../lib/user-visible-strings.mjs'
import { findingsInText, identityOf, scan } from '../check-plain-language.mjs'

/* ---------------------------------------------------------------
   1 · the extractor cannot go blind
   --------------------------------------------------------------- */

test('comments are blanked, and the three states that are not comments survive', () => {
  /* Moved here with the stripper itself. src/views/*.js are full of notes that
     QUOTE the sentence they replaced, so a scan that reads comments finds the
     defect inside the note explaining that the defect was removed. */
  const stripped = withoutComments([
    'const a = 1 // this sentence is much too long to be allowed anywhere at all',
    '/* and so is this one, at very great and unnecessary length indeed */',
    'const b = `kept: a real sentence`',
    'const c = "// not a comment"',
    'const d = value.replace(/[&<>"\']/g, x => x)',
    '/* after a regex containing quotes, this comment must still be blanked */',
    'const e = total / count / 2',
  ].join('\n')).split('\n')
  assert.ok(!stripped[0].includes('too long'), 'a line comment survived')
  assert.ok(!stripped[1].includes('unnecessary'), 'a block comment survived')
  assert.match(stripped[2], /kept: a real sentence/, 'a template literal was blanked')
  assert.match(stripped[3], /\/\/ not a comment/, 'a string containing // was treated as a comment')
  assert.match(stripped[4], /\[&<>"'\]/, 'a regex literal was mangled')
  assert.ok(!stripped[5].includes('blanked'), 'a regex containing quotes blinded the stripper')
  assert.match(stripped[6], /total \/ count \/ 2/, 'division was mistaken for a regex')
  assert.equal(stripped.length, 7, 'line numbering was not preserved')
})

test('a regular expression containing a quote does not swallow the rest of the file', () => {
  /* THE BUG THAT BROKE THE FIRST VERSION OF THE WALKER, and it is not
     hypothetical: every view in this product opens with an escaper built out of
     `.replace(/"/g, '&quot;')`. Measured before the fix: src/write-surfaces.js
     and src/views/setup.js both came back "unterminated" and contributed
     nothing. A gate that silently reads two files as zero strings is the exact
     failure this whole suite exists to prevent. */
  const source = [
    'const esc = v => String(v).replace(/"/g, "&quot;").replace(/\'/g, "&#39;")',
    'const message = "This is real copy and must be found."',
  ].join('\n')
  const texts = extractStringLiterals(withoutComments(source)).flatMap(l => l.chunks.map(c => c.text))
  assert.ok(texts.includes('This is real copy and must be found.'),
    `the walker lost its place inside a regex: ${JSON.stringify(texts)}`)
})

test('an unterminated literal is a refusal, never a short reading', () => {
  /* The doctrine tools/test-ratchet.mjs applies to its own counts: refuse to
     rule on a reading you cannot trust. Returning the chunks collected so far
     would report a clean file. */
  assert.throws(() => extractStringLiterals('const broken = "no closing quote'), /did not finish/)
})

test('a template literal is cut at its values, and its markup comes off', () => {
  const source = 'const row = `<article class="settings-row"><div class="settings-name">${esc(name)}</div><div class="settings-desc">This is what it does.</div></article>`'
  const { visible } = visibleTextFrom(source)
  const texts = visible.map(entry => entry.text)
  assert.ok(texts.includes('This is what it does.'), `the prose between the tags was lost: ${JSON.stringify(texts)}`)
  assert.ok(!texts.some(text => text.includes('settings-row')), `a class name was reported as copy: ${JSON.stringify(texts)}`)
})

test('separate controls retain their own copy while inline emphasis retains the complete sentence', () => {
  const source = 'const html = `<div><button>Save draft</button><button>Export draft</button><label>Reviewer name<input></label><p>Read <strong>every word</strong> before continuing.</p></div>`'
  assert.deepEqual(visibleTextFrom(source).visible.map(entry => entry.text), [
    'Save draft', 'Export draft', 'Reviewer name', 'Read every word before continuing.',
  ])
  const long = 'const html = `<p>This sentence has <strong>many words</strong> because it keeps explaining every single step that a person must follow before they can finally finish reading all of it.</p>`'
  const text = visibleTextFrom(long).visible.map(entry => entry.text)
  assert.equal(text.length, 1, 'inline elements cannot divide one dense sentence into passing fragments')
  assert.ok(findingsInText(text[0]).some(finding => finding.rule === 'long-sentence'))
})

test('the tag state crosses a value that sits inside an attribute', () => {
  /* THE CASE A REGEX CANNOT DO. Interpolating into an attribute cuts one tag
     into three chunks, none of which is a complete tag, so `<[^>]*>` clears none
     of them and all three arrive at the rules as prose. That is how a copy
     scanner comes to report `aria-current=` as a sentence and gets switched off
     in a week. */
  const source = 'const b = `<button data-tier="${id}" aria-current="${on}">Continue</button>`'
  const { visible } = visibleTextFrom(source)
  const texts = visible.map(entry => entry.text)
  assert.deepEqual(texts, ['Continue'], `attribute residue reached the rules: ${JSON.stringify(texts)}`)
})

test('an HTML comment inside markup is not something a person reads', () => {
  const source = 'const x = `<div><!-- a note to the next programmer, at some length -->Real copy.</div>`'
  const texts = visibleTextFrom(source).visible.map(entry => entry.text)
  assert.deepEqual(texts, ['Real copy.'])
})

test('a nested literal inside a value is copy in its own right', () => {
  /* A ternary inside a template produces two real sentences, and a person sees
     one of them. Folding them into the outer literal would lose both. */
  const source = 'const x = `<p>${ok ? "It worked." : "It did not work, so try again."}</p>`'
  const texts = visibleTextFrom(source).visible.map(entry => entry.text)
  assert.ok(texts.includes('It worked.'), JSON.stringify(texts))
  assert.ok(texts.includes('It did not work, so try again.'), JSON.stringify(texts))
})

test('a developer message is not customer copy and is not rewritten into it', () => {
  const source = 'function f(id) { throw new TypeError(`Unknown write-action flag: ${id}`) }'
  const { visible, skipped } = visibleTextFrom(source)
  assert.deepEqual(visible, [], 'a thrown error message was treated as copy a customer reads')
  assert.ok(skipped.some(entry => entry.reason === 'developer-message'), JSON.stringify(skipped))
})

test('every rejection is a thing nobody reads, and prose is never rejected', () => {
  /* THE HALF THAT DECIDES WHETHER THIS TOOL IS USABLE. A scanner that reports
     `settings-row` as a sentence gets switched off; a scanner that rejects a
     real sentence measures nothing. Both directions are asserted, by name. */
  const notCopy = [
    ['', 'empty'],
    ['#/settings', 'route-or-selector'],
    ['[data-setup-choice]', 'route-or-selector'],
    ['data-refusal-code', 'route-or-selector'],
    ['coordinator', 'single-token'],
    ['ctl-btn danger', 'class-list'],
    ['projection-state is-loading', 'class-list'],
    ['BRIDGE_UNREACHABLE', 'bare-identifier'],
    ['·', 'punctuation'],
    ['setup permission level tier guided standard unrestricted workspace working folder folders autonomy acting on its own approvals attach sign in walkthrough first run live', 'search-index'],
  ]
  for (const [text, reason] of notCopy) {
    assert.equal(rejectionFor(text), reason, `${JSON.stringify(text)} should be rejected as ${reason}`)
  }
  for (const prose of [
    'Continue',
    'Ready. Everything you do here is written down on this computer as it happens.',
    'How much should the assistant be allowed to do?',
    'This is the only computer connected',
    'Nothing on this page can be tuned.',
  ]) {
    assert.equal(rejectionFor(prose), null, `real copy was thrown away: ${JSON.stringify(prose)}`)
  }
})

test('a sentence splitter that thinks a version number ends a sentence measures nothing', () => {
  /* A splitter that breaks on every full stop reports a two-word "sentence" and
     misses the forty-word one it was sitting inside. */
  assert.deepEqual(sentencesOf('Run codex 0.146.1 now. Then sign in.'), ['Run codex 0.146.1 now.', 'Then sign in.'])
  assert.equal(wordsOf('one two three, four.').length, 4)
})

test('the rejection summary reports what a scan did not measure', () => {
  const described = describeRejections([{ reason: 'empty' }, { reason: 'empty' }, { reason: 'single-token' }])
  assert.deepEqual(described, [{ reason: 'empty', count: 2 }, { reason: 'single-token', count: 1 }])
})

test('textOfChunk hands back the tag state it finished in', () => {
  const opened = textOfChunk('<div class="')
  assert.equal(opened.inTag, true)
  assert.equal(textOfChunk('">closed</div>', { inTag: true }).text, 'closed')
})

/* ---------------------------------------------------------------
   2 · the rules fire on the defect and not on good copy
   --------------------------------------------------------------- */

const rules = text => new Set(findingsInText(text).map(finding => finding.rule))

test('a sentence past the limit is a finding, and a short one is not', () => {
  const long = 'They record what you want and this program keeps them; the parts of it that would act on them are still being built, so today they change what is remembered rather than what happens.'
  assert.ok(rules(long).has('long-sentence'), 'a 31-word sentence was not reported')
  assert.ok(!rules('They record what you want, and this program keeps them.').has('long-sentence'))
})

test('a machine code in front of a person is a finding wherever in the line it is', () => {
  /* The first repair of this defect class moved the code to the END of the line,
     which is the same line. */
  assert.ok(rules('BRIDGE_TIMEOUT: nothing came back.').has('identifier'))
  assert.ok(rules('Nothing came back in time (BRIDGE_TIMEOUT).').has('identifier'))
  assert.ok(!rules('Nothing came back in time. Look at the screen before pressing it again.').has('identifier'))
})

test('an internal id and a permission-level key are findings; the same words as English are not', () => {
  assert.ok(rules('this copy shipped without the protection (subscription-launch-env), so it will not start').has('internal-id'))
  assert.ok(rules('the “guided” level does not include it').has('internal-id'), 'a quoted tier key was not caught')
  /* The words themselves are ordinary English and the product uses them. A gate
     that cried wolf on this sentence would be deleted within a week. */
  assert.ok(!rules('You will be guided through it, and nothing happens until you press something.').has('internal-id'))
})

test('a mechanism nobody has been shown is a finding, and the plain word is not', () => {
  assert.ok(rules('Fleet projection unavailable.').has('jargon'))
  assert.ok(rules('audited bridge ready').has('jargon'))
  assert.ok(!rules('Ready. Everything you do here is written down on this computer as it happens.').has('jargon'))
})

test('a failure with nowhere to go is a finding, and one that says what to do is not', () => {
  assert.ok(rules('An error occurred.').has('dead-end'))
  assert.ok(rules('queue unavailable').has('dead-end'))
  assert.ok(rules('Copy failed.').has('dead-end'), 'the failed action is not itself a remedy')
  assert.ok(!rules('The report was not read. Check the file name above and try again.').has('dead-end'))
  assert.ok(!rules('Clipboard is unavailable. Select and copy the text in the preview.').has('dead-end'))
  /* A description of what a control DOES is not a failure report, however many
     failure words its subject matter contains. */
  assert.ok(!rules('Let a pretend problem appear on a screen that is actually healthy.').has('dead-end'))
})

test('a fallback handed to refusalSentence is half a message, and is judged as one', () => {
  const text = 'The audited connection refused it and did not say why.'
  assert.ok(findingsInText(text).some(finding => finding.rule === 'dead-end'),
    'the sentence alone is a dead end, which is the point of the exemption')
  assert.ok(!findingsInText(text, "refusalSentence(result, { fallback: 'x' })").some(finding => finding.rule === 'dead-end'),
    'a fallback is composed with a remedy by contract, so it must not be judged alone')
  /* And the exemption reaches exactly one rule. */
  assert.ok(findingsInText('BRIDGE_TIMEOUT happened.', 'fallback:').some(finding => finding.rule === 'identifier'),
    'the fallback exemption leaked into the identifier rule')
})

/* ---------------------------------------------------------------
   3 · the verdict over the real tree
   --------------------------------------------------------------- */

/* Both real-tree checks read the same renderer without changing it. Keep the
   result local to this suite process; CLI and fixture scans remain independent. */
const measuredRendererScan = mock.fn(scan)
let rendererResult
function rendererSnapshot() {
  return rendererResult ??= measuredRendererScan()
}

after(() => {
  const calls = measuredRendererScan.mock.callCount()
  // A name-filtered run may select only the in-memory fixtures and need no scan.
  assert.ok(calls <= 1, `the real-tree checks repeated the same renderer scan ${calls} times`)
})

test('the scan reads the whole renderer and reports what it read', () => {
  const result = rendererSnapshot()
  assert.ok(result.files.length >= 70, `the scan found only ${result.files.length} files, so its walk has stopped matching`)
  assert.ok(result.strings >= 2000, `the scan found only ${result.strings} visible strings, so its extractor has gone blind`)
})

test('no string a person reads is denser than the baseline already accepts', async () => {
  /* THE RATCHET. The baseline records what was already on this tree the day the
     gate landed and is allowed to shrink and nothing else. A finding that is not
     in it is density creeping back; a baselined finding that no longer occurs is
     an improvement that has to be written down, because a ratchet that silently
     absorbs improvement stops ratcheting inside a month.
     Read through the same file the command-line gate reads, so the two can never
     disagree about what is accepted. */
  const { readFileSync } = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const baseline = JSON.parse(readFileSync(path.join(repo, 'tools', 'plain-language-baseline.json'), 'utf8'))
  assert.ok(Array.isArray(baseline.accepted), 'the baseline has no accepted list, so nothing was compared')

  const accepted = new Set(baseline.accepted)
  const result = rendererSnapshot()
  const seen = new Set(result.findings.map(identityOf))

  const regressions = result.findings.filter(finding => !accepted.has(identityOf(finding)))
  assert.deepEqual(
    regressions.map(finding => `${finding.file}:${finding.line} [${finding.rule}] ${JSON.stringify(finding.excerpt.slice(0, 120))}`),
    [],
    'these strings are denser than anything the baseline accepts. Rewrite them; do not add them to the baseline.',
  )

  const fixed = [...accepted].filter(identity => !seen.has(identity))
  assert.deepEqual(fixed, [], 'these baselined findings no longer occur. Run `node tools/check-plain-language.mjs --update` and commit the shorter file.')
})
