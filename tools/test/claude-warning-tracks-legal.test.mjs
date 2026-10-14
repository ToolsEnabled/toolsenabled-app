/* THE SHIPPED WARNING IS A PARAPHRASE OF AN ADOPTED TEXT, SO SOMETHING HAS TO
 * NOTICE WHEN THE ADOPTED TEXT MOVES.
 *
 * tools/test/account-panel-copy.test.mjs already pins what the shipped warning
 * must SAY: four specifics, in order, the risk-is-yours point first, and an
 * alternative this build really has. What no test could see until this one is
 * the other half of the same obligation — the source those four specifics come
 * from is a document in the legal lane, it is edited, and the shipped copy is a
 * DELIBERATE PARAPHRASE (plainer English, and one recorded departure: the
 * position names key-based sign-in as the alternative, this build does not
 * carry that transport, so the shipped text names the alternative that exists).
 *
 * A paraphrase cannot be checked mechanically against its source. What CAN be
 * checked is whether the source still says what the paraphrase was written
 * against. So this is a drift tripwire, not a content assertion: it fingerprints
 * the adopted section and fails when it changes, telling whoever changed it to
 * re-read the shipped copy against the new text and re-record the fingerprint.
 *
 * THIS IS NOT HYPOTHETICAL. On 2026-08-18 the privacy rider's R4 was corrected
 * AFTER the engine lane had applied it verbatim; the correction was caught by a
 * file timestamp and a manual diff, not by anything mechanical, and only because
 * someone happened to look. This test is that look, made automatic, for the one
 * piece of legal text this product paraphrases rather than quotes.
 *
 * WHEN THE FINGERPRINT FAILS, the fix is never to update the constant alone.
 * Read the new section, decide whether each shipped point still carries its
 * specific, change the copy if it does not — then record the new fingerprint in
 * the same commit as the copy change, so the two move together.
 *
 * THE SOURCE LIVES OUTSIDE THIS REPOSITORY (the legal lane's own tree), so a
 * checkout that cannot reach it SKIPS WITH ITS REASON PRINTED rather than
 * passing quietly. A skip that looks like a pass is the failure mode this whole
 * suite exists to refuse.
 *
 * Run: node --test tools/test/claude-warning-tracks-legal.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CLAUDE_ACCOUNT_RISK } from '../../src/account-panel-copy.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/* The legal lane's tree sits beside the product's, not inside it. The env var
   is how a machine with a different layout points at the same document; the
   default is where it lives on the machine this was written against. */
const POSITION_DOC = process.env.TOOLSENABLED_PROVIDER_POSITION_DOC
  || path.join(REPO, '..', '..', 'legal', 'positions', 'PROVIDER-SUBSCRIPTION-AGENTS.md')

const SECTION_START = '## The user warning'
const SECTION_END = '## Cross-cutting obligations'

/* Recorded 2026-08-18 against the owner-adopted text; RE-RECORDED 2026-08-19
   when the tripwire fired on legal's ratification stamp — the section gained
   the paragraph recording that the shipped paraphrase is RATIFIED and is now
   the reference wording (FROM-LEGAL-2026-08-19-claude-warning-ruling.md). The
   four specifics were verified word-for-word unchanged, so the shipped copy
   needed no change and this constant moves alone WITH that verification, which
   is the one case the rule below permits. Normalisation: CRLF folded to LF,
   runs of spaces and tabs collapsed to one, ends trimmed — so re-wrapping a
   paragraph does not cry drift, but changing a word does. */
const ADOPTED_FINGERPRINT = 'f72395d4679bffb292f9fe5ce7de95a4764a9b3139642165811e4257bfb63a4d'

function adoptedSection() {
  const text = readFileSync(POSITION_DOC, 'utf8')
  const start = text.indexOf(SECTION_START)
  const end = text.indexOf(SECTION_END)
  if (start === -1 || end === -1 || end <= start) return null
  return text.slice(start, end).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
}

test('the adopted warning text has not changed under the paraphrase that ships', (t) => {
  assert.equal(typeof CLAUDE_ACCOUNT_RISK.today, 'string',
    'the shipped warning must retain its practical alternative while the legal source is unavailable')
  assert.ok(CLAUDE_ACCOUNT_RISK.today.trim(),
    'the shipped warning must not replace its practical alternative with an empty value')

  if (!existsSync(POSITION_DOC)) {
    /* Stated as a real skip in the runner's own tallies, never as a pass. */
    t.skip(`the position document is not reachable from this checkout (${POSITION_DOC}). `
      + 'Set TOOLSENABLED_PROVIDER_POSITION_DOC to check the shipped warning against its source.')
    return
  }
  const section = adoptedSection()
  assert.ok(section, `the position document no longer carries a "${SECTION_START}" section ending at "${SECTION_END}" — `
    + 'the warning\'s source has been restructured and the shipped copy must be re-read against it')

  const fingerprint = createHash('sha256').update(section, 'utf8').digest('hex')
  assert.equal(fingerprint, ADOPTED_FINGERPRINT,
    'THE ADOPTED WARNING TEXT HAS CHANGED. The four specifics this product paraphrases were edited in '
    + `${POSITION_DOC}. Re-read the section, check each shipped point in src/account-panel-copy.js still `
    + 'carries its specific, change the copy where it does not, and record the new fingerprint in the same '
    + 'commit as the copy change. Do NOT update the fingerprint alone.')
})

test('the source still carries four numbered specifics, which is what the shipped list mirrors', (t) => {
  assert.equal(CLAUDE_ACCOUNT_RISK.points.length, 4,
    'the shipped warning must retain its four adopted specifics while the legal source is unavailable')

  if (!existsSync(POSITION_DOC)) {
    t.skip(`the position document is not reachable from this checkout (${POSITION_DOC}).`)
    return
  }
  const section = adoptedSection()
  assert.ok(section, 'the warning section could not be located in the position document')
  const numbered = section.match(/^\d+\.\s+\*\*/gm) || []
  assert.equal(numbered.length, 4,
    `the position now lists ${numbered.length} specifics, not four; the shipped warning lists `
    + `${CLAUDE_ACCOUNT_RISK.points.length} and would no longer mirror it`)
  assert.equal(CLAUDE_ACCOUNT_RISK.points.length, numbered.length,
    'the shipped warning and the adopted position disagree on how many specifics there are')
})
