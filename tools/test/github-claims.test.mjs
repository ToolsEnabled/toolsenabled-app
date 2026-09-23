/* THE PROOF THAT THE GITHUB GUARD IS STILL LOOKING AT SOMETHING.
 *
 * tools/check-github-claims.mjs keeps the product from ever CLAIMING it uses or
 * runs on GitHub, while leaving the published-source link and the GitHub
 * connector completely alone. The owner's ruling it enforces is quoted in full
 * at the top of that file.
 *
 * That guard has a failure mode this repository has been bitten by in five
 * different places already: it can go GREEN BY MEASURING NOTHING. There is no
 * offending sentence on this tree today, so a guard whose extractor quietly
 * stopped finding text would look identical to a guard doing its job, forever.
 * So the assertions here are in three halves and the first is the important one:
 *
 *   1. THE EXTRACTOR IS CORRECT on inputs whose right answer is written down
 *      here -- code comments blanked, HTML comments dropped, a sentence
 *      hand-wrapped across three lines read as one sentence, fenced code and
 *      inline code in markdown thrown away.
 *   2. THE RULES FIRE on the claim and DO NOT FIRE on publication, on the
 *      connector, or on a code comment. Every must-pass case the brief names has
 *      its own assertion here, by name.
 *   3. THE VERDICT OVER THE REAL TREE, through the same scan() the command-line
 *      guard uses, so `npm test` goes red the moment somebody writes the
 *      sentence -- without anybody having to remember to run a separate command.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { visibleTextFrom } from '../lib/user-visible-strings.mjs'
import {
  CLAIM_PATTERNS,
  filekeeperAsGithub,
  findingsInText,
  passagesFrom,
  scan,
  withoutMarkdownCode,
} from '../check-github-claims.mjs'

/** The rule ids fired by one piece of prose. */
const rules = text => new Set(findingsInText(text).map(finding => finding.rule))

/* ---------------------------------------------------------------
   1 · the extractor cannot go blind
   --------------------------------------------------------------- */

test('a code comment is not something a person reads, and a string literal is', () => {
  /* THE MUST-PASS CASE THE BRIEF NAMES LAST, AND THE ONE MOST LIKELY TO BE GOT
     WRONG. Every guard in this repository is explained in a comment that quotes
     the sentence it forbids -- including the guard under test, whose own header
     spells "ToolsEnabled runs on GitHub". A scanner that read comments would
     report the defect inside the note explaining that the defect is forbidden. */
  const source = [
    '// The product runs on GitHub, historically, and that sentence is why this exists.',
    '/* We use GitHub for everything. Never write this. */',
    'const shown = "Your work is stored on GitHub."',
  ].join('\n')
  const visible = visibleTextFrom(source).visible.map(entry => entry.text)

  assert.deepEqual(
    visible.flatMap(text => findingsInText(text).map(finding => finding.rule)),
    ['stored-on-github'],
    'the comment lines reached the rules, or the string literal did not',
  )
  assert.ok(
    !visible.some(text => text.includes('historically')),
    'a line comment survived into the visible set',
  )
  assert.ok(
    !visible.some(text => text.includes('Never write this')),
    'a block comment survived into the visible set',
  )
})

test('an HTML comment is dropped and a hand-wrapped sentence is read as one sentence', () => {
  /* Both halves are load-bearing on the real tree. docs/github-org/profile-README.md
     opens with a publishing instruction inside `<!-- -->` that mentions GitHub
     three times, and public/help/getting-started.html wraps its publication
     sentence across three lines with a `<span>` in the middle of it. A reader
     sees neither of those the way the file is written. */
  const passages = passagesFrom([
    '<!--',
    '  We use GitHub for this. A note to whoever publishes the page.',
    '-->',
    '<p>If you go looking: the source code is published under the',
    '<span class="label">ToolsEnabled</span> organization on GitHub — the application,',
    'the engine it runs, and the relay.</p>',
  ].join('\n'))

  assert.equal(passages.length, 1, `the comment or the wrapping produced ${passages.length} passages, not 1`)
  assert.ok(!passages[0].text.includes('note to whoever'), 'an HTML comment reached the rules')
  assert.match(passages[0].text, /published under the ToolsEnabled organization on GitHub/,
    'the sentence was not rejoined across the lines it is wrapped over')
  assert.equal(passages[0].line, 4, 'the passage was not reported at the line it starts on')
  assert.deepEqual(findingsInText(passages[0].text), [], 'the publication sentence was read as a claim')
})

test('markdown code is not prose, and blanking it keeps the line numbers honest', () => {
  /* CONTRIBUTORS.md really does carry `- Name (@github-handle) — what you
     contributed` as a template to copy. It is an instruction to type something,
     not a sentence about what the product uses. */
  const blanked = withoutMarkdownCode([
    'Add yourself as `- Name (@github-handle) — what you contributed`.',
    '',
    '```sh',
    'git remote add origin https://github.com/ToolsEnabled/toolsenabled',
    '```',
    '',
    'The official project lives under the ToolsEnabled GitHub organization.',
  ].join('\n'))

  const lines = blanked.split('\n')
  assert.equal(lines.length, 7, 'blanking changed the line count, so every reported line would be wrong')
  assert.ok(!lines[0].includes('github-handle'), 'an inline code span survived')
  assert.equal(lines[3], '', 'a fenced block survived')
  assert.match(lines[6], /ToolsEnabled GitHub organization/, 'prose outside the fence was blanked too')
})

/* ---------------------------------------------------------------
   2a · the rules fire on the claim
   --------------------------------------------------------------- */

test('the five claims the owner refuses each go red', () => {
  assert.ok(rules('ToolsEnabled uses GitHub to keep your work in step.').has('uses-github'))
  assert.ok(rules('The assistant runs on GitHub.').has('runs-on-github'))
  assert.ok(rules('Your projects are hosted on GitHub.').has('hosted-on-github'))
  assert.ok(rules('This product is built on GitHub.').has('built-on-github'))
  assert.ok(rules('Agent handoff is powered by GitHub.').has('powered-by-github'))
})

test('telling a customer their files sit on somebody else\'s service goes red', () => {
  /* Not one of the five verbs, and here on judgement: it is the Filekeeper half
     of the ruling written without the word Filekeeper. */
  assert.ok(rules('Everything you write is stored on GitHub.').has('stored-on-github'))
  assert.ok(rules('Your drafts are kept on github.com.').has('stored-on-github'),
    'the domain spelling let the claim through')
})

test('presenting Filekeeper as GitHub goes red, in either order and either spelling', () => {
  assert.ok(rules('Filekeeper is GitHub.').has('filekeeper-is-github'))
  assert.ok(rules('FileKeeper is really just our GitHub for documents.').has('filekeeper-is-github'))
  assert.ok(rules('Think of Filekeeper as GitHub for your notes.').has('filekeeper-is-github'))
  assert.ok(rules('Filekeeper (GitHub) holds the proof.').has('filekeeper-is-github'),
    'an apposition presents one as the other just as plainly as the word "is"')
  assert.ok(rules('GitHub is what Filekeeper really is.').has('filekeeper-is-github'),
    'the rule only looked in one direction')
})

test('the internal-vcs identifier is Filekeeper for this purpose', () => {
  /* The engine carries the service as @toolsenabled/internal-vcs. A sentence that
     equates that identifier with GitHub misidentifies exactly the same thing. */
  assert.ok(rules('internal-vcs is GitHub under the hood.').has('filekeeper-is-github'))
  assert.ok(rules('Custody is handled by internal-vcs / GitHub.').has('filekeeper-is-github'))
})

/* ---------------------------------------------------------------
   2b · the rules do not fire on publication, or on the connector
   --------------------------------------------------------------- */

test('publication passes — the link the owner explicitly keeps', () => {
  /* "we keep the github link -> we want people to know we are open source and
     such." Each of these is a sentence he wants to stay writable. */
  assert.deepEqual(findingsInText('The source is published at github.com/ToolsEnabled/toolsenabled.'), [])
  assert.deepEqual(findingsInText('Read the source before you install it.'), [])
  assert.deepEqual(findingsInText('ToolsEnabled is free and open source.'), [])
  assert.deepEqual(findingsInText('The official project lives under the ToolsEnabled GitHub organization.'), [])
  assert.deepEqual(
    findingsInText('If you go looking: the source code is published under the ToolsEnabled organization on '
      + 'GitHub — the application, the engine it runs, and the relay — so you can read every line before you install.'),
    [],
    'the sentence that is on the shipped help page today was read as a claim',
  )
})

test('the connector passes — connecting a person to THEIR OWN GitHub', () => {
  /* "THOUGH we still WANT to be able to connect a user to their github." The
     exemption is structural: every claim pattern requires GitHub to sit directly
     after the verb, so a GitHub the READER owns can never reach one. */
  assert.deepEqual(findingsInText('Connect your GitHub account.'), [])
  assert.deepEqual(findingsInText('Sign in with GitHub.'), [])
  assert.deepEqual(findingsInText('ToolsEnabled uses your GitHub account only to open the issue you asked for.'), [],
    '"uses your GitHub account" is the integration, not the claim')
  assert.deepEqual(findingsInText('Paste your GitHub personal access token.'), [],
    'the credential label the engine already ships went red')
  assert.deepEqual(findingsInText('GitHub personal access token'), [])
  assert.deepEqual(findingsInText('The agent will push the change to your own repository on GitHub.'), [],
    'push, pull and clone act on the person\'s repository and must stay writable')
})

test('the connector\'s tool names are identifiers, not the company', () => {
  /* `github_issue_create` and `github.issue.list` are things the product OFFERS.
     A guard that went red on the name of the tool it is supposed to protect
     would be deleted in a week. */
  assert.deepEqual(findingsInText('Use the github_issue_create tool to file it.'), [])
  assert.deepEqual(findingsInText('Use the github.issue.list tool to see what is open.'), [])
  assert.deepEqual(findingsInText('The github.repo.get tool reads it.'), [])
})

test('Filekeeper and GitHub in one true sentence is not a presentation', () => {
  /* The test is an equating LINK, not co-occurrence. A guard that cried wolf on
     a sentence naming both would push people into never mentioning either. */
  assert.deepEqual(
    findingsInText('Filekeeper holds your drafts; you can also connect your GitHub account.'),
    [],
    'two true clauses in one sentence were read as an equation',
  )
  assert.equal(filekeeperAsGithub('Filekeeper, GitHub and Comms all appear in the list.'), null,
    'a comma is a list, not a link')
})

/* ---------------------------------------------------------------
   3 · the verdict over the real tree
   --------------------------------------------------------------- */

test('every rule needs the literal word, which is what makes the pre-filter sound', () => {
  /* scan() skips any file whose bytes do not contain "github", because none of
     the rules can fire without it. That shortcut is worth about a hundred
     seconds of `npm test` -- and it is a blindness hole the moment a rule can
     fire without the word. This is the assertion that notices. */
  assert.ok(CLAIM_PATTERNS.length >= 6, 'the claim list shrank; check what was removed and why')
  for (const claim of CLAIM_PATTERNS) {
    assert.match(claim.source, /github/i,
      `the ${claim.id} rule can fire without the word "github". Delete the CANDIDATE filter in scan() before shipping it.`)
  }
  assert.equal(filekeeperAsGithub('Filekeeper is where your drafts live.'), null,
    'rule 2 fired without GitHub in the sentence, so the pre-filter would skip files it can find things in')
})

test('the scan reads all three user-facing surfaces and reports what it read', () => {
  const result = scan()
  assert.ok(result.files.length >= 100,
    `the scan found only ${result.files.length} user-facing files, so its walk has stopped matching`)

  // The help page now directs readers to downloads and says the source is
  // private. It must remain in the scan even though it no longer names GitHub.
  // README and the organization profile retain real GitHub mentions; the
  // wrapped-HTML fixture above separately proves extraction of those mentions.
  const named = new Set(result.mentions.map(mention => mention.file))
  assert.ok(result.files.includes('public/help/getting-started.html'),
    'the shipped help page was omitted from the scan')
  const help = passagesFrom(readFileSync(new URL('../../public/help/getting-started.html', import.meta.url), 'utf8'))
  assert.ok(help.some(passage => /source repositories are private/i.test(passage.text)),
    'the shipped help page no longer yields its actual source-availability wording')
  assert.ok(named.has('README.md'), 'README.md names GitHub and the scan no longer sees it')
  assert.ok(result.examined.includes('docs/github-org/profile-README.md'),
    'the org profile page is a published document and was not read')
})

test('no user-facing sentence on this tree claims the product uses GitHub', () => {
  const result = scan()
  assert.deepEqual(
    result.findings.map(finding => `${finding.file}:${finding.line} [${finding.rule}] ${JSON.stringify(finding.excerpt.slice(0, 160))}`),
    [],
    'reword the sentence. The link stays and the connector stays; neither of those is what went red.',
  )
})
