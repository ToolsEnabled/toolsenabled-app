#!/usr/bin/env node

/* THE PRODUCT MAY BE PUBLISHED ON GITHUB. IT MAY NOT CLAIM TO RUN ON IT.
 *
 * The owner's ruling, verbatim, because every edge case below is decided by it
 * and a paraphrase would decide them differently:
 *
 *   "we keep the github link -> we want people to know we are open source and
 *   such. BUT we dont want to say we are USING or USE github. THOUGH we still
 *   WANT to be able to connect a user to their github. SO we want github
 *   integration, with github source code publication, BUT WE DONT WANT TO SAY
 *   AGENT COMMS IS DISCORD AND WE DONT WANT TO SAY FILEKEEPER IS GITHUB. WE
 *   just want to make sure we are identifying things correctly."
 *
 * So there are three things in play and only one of them is forbidden:
 *
 *   PUBLICATION is fine.  "Published at github.com/ToolsEnabled", "read the
 *                         source", "open source". That is the link he wants kept.
 *   INTEGRATION is fine.  The `github.*` connector, the "GitHub personal access
 *                         token" credential label, connecting a PERSON to THEIR
 *                         OWN GitHub account. That is a tool the product offers.
 *   THE CLAIM is not.     "ToolsEnabled runs on GitHub." "Your files are stored
 *                         on GitHub." "Filekeeper is GitHub." Those name a
 *                         mechanism this product does not have, and they name
 *                         somebody else's company as the thing holding a
 *                         customer's work.
 *
 * WHY A GUARD AND NOT A FIX. A sweep of this tree found no offending sentence in
 * the product today. There is nothing to repair. What there is, is a rule that
 * currently lives only in a person's memory: the day somebody writes "we use
 * GitHub to keep your files in sync" on a settings screen, nothing goes red. The
 * two sentences that DO mention GitHub today -- the help page's "the source code
 * is published under the ToolsEnabled organization on GitHub", and README's "the
 * official project will live under the ToolsEnabled GitHub organization" -- are
 * both publication, both correct, and both must keep passing. That pair is what
 * makes this a guard with something to measure rather than a scan over an empty
 * room.
 *
 * WHAT COUNTS AS USER-FACING, and it is taken from the neighbours rather than
 * guessed:
 *
 *   1. THE RENDERER. src/*.js and src/views/*.js, read through
 *      tools/lib/user-visible-strings.mjs -- string literals only, comments
 *      blanked, template values cut out, markup tags removed, selectors and
 *      class lists thrown away. That is exactly the set
 *      tools/check-plain-language.mjs calls "what a person reads", and taking a
 *      second opinion on it here would give this repository two answers to one
 *      question. It is also what makes CODE COMMENTS PASS: a note explaining
 *      that a defect was removed necessarily quotes the defect, and a scanner
 *      that reads comments finds the defect inside the note.
 *
 *   2. THE SHIPPED HELP PAGE. public/help/*.html. A customer reads it inside the
 *      application, and it is the one file in this repository where a GitHub
 *      sentence actually lives. A guard that skipped the only place the risk is
 *      real would be the "defined and never reached" kind.
 *
 *   3. THE PUBLISHED DOCUMENTS. Imported from tools/check-product-naming.mjs,
 *      not re-listed, because "which documents are public promises" is a
 *      judgement that must have one home. That guard's own words: it is "a
 *      deliberate manual step, because that is a judgement, not a glob".
 *
 * WHAT IS DELIBERATELY NOT SCANNED. The engine tree. tools/check-product-naming.mjs
 * reaches it through --source / TOOLSENABLED_SOURCE / private/capability-source.owner.json
 * and exits 2 when it cannot be found -- correct for a guard that runs in the
 * ship path, fatal for one that must run in `npm test` on any checkout. capability/
 * is a STAGED COPY of that tree, so guarding it would be guarding the copy and
 * not the original. The engine's own user-facing strings are the engine repo's to
 * guard; the rules below are exported so that guard can import them rather than
 * retype them.
 *
 * EXIT CODES follow tools/check-no-owner-data.mjs and tools/check-product-naming.mjs,
 * because the ship path chains these together and a novel contract in one of them
 * is a bug waiting for a pipe:
 *   0  no surface claims the product uses GitHub
 *   1  a claim was found
 *   2  a setup problem -- and an empty scan is a setup problem, never a pass
 *
 * RELEASE NOTES: docs/RELEASE-NOTES-*.md also contains customer promises.
 * Only top-level matching files are added; other docs remain outside this
 * surface. Notes use the same Markdown reader as published documents.
 *
 * RUN IT:
 *   node tools/check-github-claims.mjs
 *   node tools/check-github-claims.mjs --coverage   what was read, and every
 *                                                  sentence that named GitHub
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PUBLISHED_DOCUMENTS } from './check-product-naming.mjs'
import { sentencesOf, textOfChunk, visibleTextFrom } from './lib/user-visible-strings.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* The renderer, which is everything a customer's eyes reach inside the window.
   Same two roots as tools/check-plain-language.mjs, for the same reason: shell/
   prints to a log and tools/ is this repository talking to itself. */
const RENDERER_ROOTS = Object.freeze(['src', path.join('src', 'views')])

/* The pages that ship inside the application and are opened by a person. */
const HELP_ROOT = path.join('public', 'help')

/* FILES ALLOWED TO SPELL THE FORBIDDEN SENTENCES, and it is empty on purpose.
   tools/check-preview-honesty.mjs needs such a list because its definition file
   must spell the words it recognises; this guard's own vocabulary lives in
   tools/, which is not a scanned surface, so nothing here is self-tripping. The
   list exists named and empty so that adding to it is a visible act rather than
   a widened regex. */
const NOT_CUSTOMER_COPY = Object.freeze(new Set([]))

/* ---------------------------------------------------------------
   Rule 1 -- the product claiming GitHub as its own mechanism.
   --------------------------------------------------------------- */

/* THE ANCHORING IS THE WHOLE DESIGN, AND IT IS WHAT KEEPS THE CONNECTOR LEGAL.
 *
 * Every pattern below requires GitHub to sit IMMEDIATELY after the verb that
 * claims it, with only `the`, `a`, `our` or `its` allowed in between. That one
 * decision does the work of an exemption list:
 *
 *   "we use GitHub to keep your files"      -> matches. A claim.
 *   "ToolsEnabled uses your GitHub account" -> does NOT match. `your` is not one
 *                                              of the four determiners, so a
 *                                              GitHub the READER owns can never
 *                                              reach these patterns.
 *   "published under the ToolsEnabled organization on GitHub"
 *                                           -> does NOT match. `on GitHub` alone
 *                                              is a place, not a claim; there is
 *                                              no claiming verb governing it.
 *   "Sign in with GitHub", "Connect your GitHub account",
 *   "GitHub personal access token"          -> do NOT match. No claiming verb.
 *
 * A structural exemption is better than a list here because a list has to
 * anticipate every way the connector will be described, and this one does not.
 *
 * WHY "hosted on" IS REFUSED EVEN THOUGH "our source is hosted on GitHub" READS
 * INNOCENT. Whether the subject of that sentence is the SOURCE or the PRODUCT is
 * not a distinction a regular expression can draw, and the two readings are one
 * word apart in front of a customer. The safe half is the one that publishes:
 * "published at github.com/ToolsEnabled" says the same true thing and cannot be
 * misread. Reword rather than argue with this rule.
 */
const DETERMINER = '(?:the\\s+|a\\s+|an\\s+|our\\s+|its\\s+)?'

/* THE COMPANY'S NAME, WRITTEN SO THAT AN IDENTIFIER IS NOT IT.
 *
 * The connector's tools are named `github_issue_create` and `github.issue.list`,
 * and its credential key is `github_pat`. Those are things the product OFFERS,
 * and the owner keeps them: "we still WANT to be able to connect a user to their
 * github". Two shapes have to be told apart from the name:
 *
 *   github_issue_create   `\b` already refuses it -- `_` is a word character, so
 *                         there is no boundary after `github`. Free.
 *   github.issue.list     `\b` DOES hold before a dot, so `Use the github.issue.list
 *                         tool` would otherwise read as "use ... GitHub" and this
 *                         guard would go red on the integration it is supposed to
 *                         protect. The lookahead below refuses a dot that CARRIES
 *                         ON into another word.
 *
 * THE LOOKAHEAD IS `(?!\.\w)` AND NOT `(?![\w.])`, WHICH IS THE BUG THIS COMMENT
 * EXISTS TO STOP SOMEBODY REINTRODUCING. The broader form refuses any following
 * dot at all -- including the FULL STOP AT THE END OF A SENTENCE. Written that
 * way, "The assistant runs on GitHub." and "Everything you write is stored on
 * GitHub." both sailed through green, which is to say the guard was blind to the
 * claim in its most natural form: at the end of a sentence. It was caught by
 * tools/test/github-claims.test.mjs before this file was wired into anything.
 *
 * `github.com` is spelled out as the one dotted form that IS the company, so
 * "your files are stored on github.com" is still caught. The URL itself remains
 * legal for the reason every publication sentence is: no claiming verb governs it.
 */
const GITHUB_NAME = 'github(?:\\.com)?\\b(?!\\.\\w)'

const CLAIMS = Object.freeze([
  Object.freeze({
    id: 'uses-github',
    pattern: new RegExp(`\\b(?:use|uses|used|using)\\s+${DETERMINER}${GITHUB_NAME}`, 'i'),
    instead: 'the owner\'s words are "we dont want to say we are USING or USE github". '
      + 'Say what the product itself does, or say where the source is published.',
  }),
  Object.freeze({
    id: 'runs-on-github',
    pattern: new RegExp(`\\b(?:run|runs|ran|running)\\s+(?:on\\s+top\\s+of|on|in|inside|from|off)\\s+${DETERMINER}${GITHUB_NAME}`, 'i'),
    instead: 'the product runs on the customer\'s own computer. Say that instead.',
  }),
  Object.freeze({
    id: 'hosted-on-github',
    pattern: new RegExp(`\\bhost(?:ed|s|ing)?\\s+(?:on|by|in|at|with)\\s+${DETERMINER}${GITHUB_NAME}`, 'i'),
    instead: 'say "published at github.com/ToolsEnabled" — publication is what the owner wants kept, '
      + 'and it cannot be misread as the product being operated by somebody else.',
  }),
  Object.freeze({
    id: 'built-on-github',
    pattern: new RegExp(`\\b(?:built|build|builds|building)\\s+(?:on\\s+top\\s+of|on|upon|atop|with|around)\\s+${DETERMINER}${GITHUB_NAME}`, 'i'),
    instead: 'name what the product is actually built out of, or say nothing about it.',
  }),
  Object.freeze({
    id: 'powered-by-github',
    pattern: new RegExp(`\\b(?:powered|driven|backed|run)\\s+by\\s+${DETERMINER}${GITHUB_NAME}`, 'i'),
    instead: 'nothing in this product is powered by GitHub. Delete the clause.',
  }),
  /* NOT ONE OF THE FIVE VERBS THE BRIEF NAMED, AND HERE ON JUDGEMENT. "Your
     files are stored on GitHub" is the same false claim wearing the Filekeeper
     half of the ruling: it tells a customer that somebody else's company holds
     their work. The connector's own verbs -- push, pull, clone, commit, open a
     pull request, all of which act on the PERSON's repository -- are deliberately
     absent, so describing the integration stays legal. */
  Object.freeze({
    id: 'stored-on-github',
    pattern: new RegExp(
      '\\b(?:stored|stores|store|storing|kept|keeps|keep|saved|saves|save|synced|syncs|sync|syncing|'
      + 'backed\\s+up|held)\\s+(?:on|in|to|at|with|by)\\s+' + DETERMINER + GITHUB_NAME, 'i'),
    instead: 'a customer\'s files are not on GitHub. Name where they really are.',
  }),
])

/* ---------------------------------------------------------------
   Rule 2 -- Filekeeper presented as GitHub.
   --------------------------------------------------------------- */

/* The service, and the identifier the engine carries it under
   (@toolsenabled/internal-vcs, in capability/src/lib/cloud-agent/contract.js).
   Both spellings, because "FileKeeper" and "Filekeeper" both occur and a person
   reads them identically. */
const FILEKEEPER = /\b(?:file\s?keeper|internal-vcs)\b/gi
const GITHUB = /\bgithub\b/gi

/* WHAT "PRESENTING ONE AS THE OTHER" LOOKS LIKE IN TEXT. The two names in one
 * sentence is NOT the test -- "Filekeeper holds your drafts; you can also connect
 * your GitHub account" names both and is true. What makes it a presentation is
 * an EQUATING LINK between them, so the link is what is matched, in the text
 * lying between the nearest occurrence of each name.
 *
 * A comma is deliberately not a link. "Filekeeper, GitHub and Comms" is a list,
 * and a guard that cried wolf on a list is one somebody deletes. */
const EQUATES = /\b(?:is|are|was|were|means?|really|just|basically|essentially|simply|namely|aka|equals?|our|as|like|which\s+is|built\s+on|powered\s+by|runs?\s+on|backed\s+by|stored\s+(?:in|on)|hosted\s+(?:on|in|by)|lives?\s+(?:in|on)|under\s+the\s+hood)\b|=|\bi\.e\.|\ba\.k\.a\./i

/* An apposition: the two names touching, with only the punctuation that puts one
   in place of the other between them. "Filekeeper (GitHub)", "Filekeeper —
   GitHub", "internal-vcs/GitHub". */
const APPOSITION = /^[\s"'“”]*[([:=/—–-]+[\s"'“”]*$/

/** The equating link between the two names, or null when there is none. */
export function filekeeperAsGithub(sentence) {
  const text = String(sentence ?? '')
  const ours = [...text.matchAll(FILEKEEPER)]
  const theirs = [...text.matchAll(GITHUB)]
  if (ours.length === 0 || theirs.length === 0) return null

  let nearest = null
  for (const one of ours) {
    for (const other of theirs) {
      const [first, second] = one.index < other.index ? [one, other] : [other, one]
      const between = text.slice(first.index + first[0].length, second.index)
      if (nearest === null || between.length < nearest.between.length) {
        nearest = { between, first: first[0], second: second[0] }
      }
    }
  }
  if (!nearest) return null
  if (EQUATES.test(nearest.between) || APPOSITION.test(nearest.between)) return nearest
  return null
}

/* ---------------------------------------------------------------
   The rules, over one piece of prose.
   --------------------------------------------------------------- */

/**
 * Every finding in one thing a person reads.
 *
 * Judged sentence by sentence, because the brief's unit is "a user-facing
 * sentence" and a paragraph that publishes the source in one sentence and
 * describes the connector in the next must not be read as one claim.
 *
 * @param text  the words a person reads.
 */
export function findingsInText(text) {
  const found = []
  for (const sentence of sentencesOf(text)) {
    for (const claim of CLAIMS) {
      const match = sentence.match(claim.pattern)
      if (!match) continue
      found.push({
        rule: claim.id,
        detail: `“${match[0]}” claims this product uses GitHub — ${claim.instead}`,
        excerpt: sentence,
      })
    }
    const presented = filekeeperAsGithub(sentence)
    if (presented) {
      found.push({
        rule: 'filekeeper-is-github',
        detail: `“${presented.first}” and “${presented.second}” are joined by “${presented.between.trim() || 'nothing'}”, `
          + 'which presents one as the other. Filekeeper is ours and GitHub is not. '
          + 'The owner: "WE DONT WANT TO SAY FILEKEEPER IS GITHUB."',
        excerpt: sentence,
      })
    }
  }
  return found
}

/* ---------------------------------------------------------------
   The customer-facing surfaces.
   --------------------------------------------------------------- */

/* Markup and markdown, into the passages a person reads.
 *
 * The tag state is carried ACROSS LINES for the reason
 * tools/lib/user-visible-strings.mjs carries it across template chunks: a tag
 * that opens on one line and closes on the next is not a complete tag on either
 * of them, and a `<[^>]*>` regex clears neither. An HTML comment falls out of the
 * same machine -- it opens on `<` and closes on the `>` of `-->` -- which is how
 * the publishing instructions at the top of docs/github-org/profile-README.md
 * stay out of the scan. They are a note to whoever publishes the page, not
 * something a reader sees.
 *
 * Consecutive non-blank lines are joined into one passage, because a sentence in
 * a hand-wrapped document runs across three of them and a line-by-line scan would
 * be reading a third of each sentence. The passage is reported at the line it
 * starts on. */
export function passagesFrom(source) {
  const lines = source.split('\n')
  const passages = []
  let inTag = false
  let current = null
  for (const [index, raw] of lines.entries()) {
    const stripped = textOfChunk(raw.replace(/\r$/, ''), { inTag })
    inTag = stripped.inTag
    if (!stripped.text) {
      if (current) passages.push(current)
      current = null
      continue
    }
    if (current) current.text += ` ${stripped.text}`
    else current = { line: index + 1, text: stripped.text }
  }
  if (current) passages.push(current)
  return passages
}

/* Code in a markdown document is not a sentence somebody reads as a claim: a
   fenced block is a transcript and `- Name (@github-handle)` in CONTRIBUTORS.md
   is a template to copy. Blanked rather than deleted so reported line numbers
   stay the file's own. */
export function withoutMarkdownCode(markdown) {
  let fence = null
  const lines = markdown.split('\n').map((line) => {
    const opener = line.match(/^\s*(```+|~~~+)/)
    if (fence) {
      if (opener && line.trim().startsWith(fence)) fence = null
      return ''
    }
    if (opener) {
      fence = opener[1]
      return ''
    }
    return line.replace(/`[^`]*`/g, ' ')
  })
  return lines.join('\n')
}

function rendererFiles() {
  const files = []
  for (const root of RENDERER_ROOTS) {
    let entries
    try {
      entries = readdirSync(path.join(REPO_ROOT, root), { withFileTypes: true })
    } catch (error) {
      throw new Error(`SETUP: ${root} could not be read: ${error.message}`)
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.join(root, entry.name))
    }
  }
  return files.map((file) => file.split(path.sep).join('/')).sort()
}

/* Only the top-level release notes join the existing surfaces. Developer docs
   and historical evidence remain outside this gate. An unreadable or missing
   notes collection is a setup failure, never an empty successful scan. Shared
   with the plain-language gate so both measure the same published notes. */
export function releaseNoteFiles() {
  let entries
  try {
    entries = readdirSync(path.join(REPO_ROOT, 'docs'), { withFileTypes: true })
  } catch (error) {
    throw new Error(`SETUP: docs release notes could not be read: ${error.message}`)
  }
  const files = entries
    .filter((entry) => entry.isFile() && /^RELEASE-NOTES-.*\.md$/.test(entry.name))
    .map((entry) => `docs/${entry.name}`)
    .sort()
  if (files.length === 0) {
    throw new Error('SETUP: docs/RELEASE-NOTES-*.md matched no files. An empty surface is not a clean one.')
  }
  return files
}

function helpFiles() {
  let entries
  try {
    entries = readdirSync(path.join(REPO_ROOT, HELP_ROOT), { withFileTypes: true })
  } catch (error) {
    throw new Error(`SETUP: ${HELP_ROOT} could not be read: ${error.message}`)
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => `${HELP_ROOT}/${entry.name}`.split(path.sep).join('/'))
    .sort()
}

/* THE ONLY FILES WORTH READING PROPERLY, AND WHY SKIPPING THE REST IS SOUND
 * RATHER THAN CONVENIENT.
 *
 * Every rule in this file requires the literal characters `github` to be present
 * — the six claim patterns all end in the company's name, and rule 2 returns
 * null unless it finds both names. So a file whose BYTES do not contain
 * `github`, comments and code and all, cannot contain a finding. Reading it with
 * the full extractor would be work whose answer is known in advance.
 *
 * That matters here for a measured reason and not a theoretical one.
 * tools/lib/user-visible-strings.mjs walks source a character at a time and its
 * regex-may-start test inspects the whole output accumulated so far, which is
 * quadratic in file size. Measured on this tree on 2026-08-22:
 * src/views/computers.js alone took 79 SECONDS to extract, and the renderer as a
 * whole took over one hundred. A guard that adds a hundred seconds to `npm test`
 * is a guard somebody takes back out. With this filter the renderer costs one
 * readFileSync per file, because not one file under src/ mentions GitHub today.
 *
 * THE INVARIANT THIS DEPENDS ON IS ASSERTED, NOT ASSUMED.
 * tools/test/github-claims.test.mjs checks every claim pattern for the literal
 * `github`, so the day somebody adds a rule that can fire without it, that test
 * goes red and points here. Do not add such a rule without deleting this filter.
 *
 * IT IS NOT AN ANTI-BLINDNESS HOLE. The two readings below do the work the
 * skipped files cannot: every candidate file must still yield readable text, and
 * the tree as a whole must still be seen to name GitHub somewhere. The renderer
 * EXTRACTOR's own health is asserted next door by tools/test/plain-language.test.mjs,
 * which reads every one of these files through the same library on every
 * `npm test` and fails if the string count drops. A second count here would be a
 * second answer to one question.
 */
const CANDIDATE = /github|file\s?keeper|internal-vcs/i

/**
 * Every passage a person reads, across the customer-facing surfaces, with its findings.
 *
 * @returns { files, examined, passages, mentions, findings }
 *   files     every user-facing file this guard is responsible for.
 *   examined  the ones whose bytes could hold a finding, and so were read in full.
 *   mentions  the passages that name GitHub at all. This is the anti-blindness
 *             reading: this tree really does publish itself on GitHub, so a scan
 *             that finds none of those sentences has stopped seeing rather than
 *             found a clean tree.
 */
export function scan() {
  const surfaces = [
    { kind: 'renderer', files: rendererFiles() },
    { kind: 'help', files: helpFiles() },
    { kind: 'release-notes', files: releaseNoteFiles() },
    { kind: 'published', files: PUBLISHED_DOCUMENTS.map((file) => file.split(path.sep).join('/')) },
  ]

  const findings = []
  const mentions = []
  const files = []
  const examined = []
  let passages = 0

  for (const surface of surfaces) {
    if (surface.files.length === 0) {
      throw new Error(`SETUP: the ${surface.kind} surface matched no files. An empty surface is not a clean one.`)
    }
    for (const file of surface.files) {
      if (NOT_CUSTOMER_COPY.has(file)) continue
      const absolute = path.join(REPO_ROOT, file)
      if (!existsSync(absolute)) {
        throw new Error(`SETUP: ${file} is listed as a ${surface.kind} surface and does not exist.`)
      }
      files.push(file)
      const source = readFileSync(absolute, 'utf8')
      if (!CANDIDATE.test(source)) continue
      examined.push(file)

      let units
      if (surface.kind === 'renderer') {
        let extracted
        try {
          extracted = visibleTextFrom(source)
        } catch (error) {
          throw new Error(`SETUP: ${file} could not be read as JavaScript: ${error.message}`)
        }
        units = extracted.visible.map((entry) => ({ line: entry.line, text: entry.text }))
      } else if (surface.kind === 'help') {
        units = passagesFrom(source)
      } else {
        units = passagesFrom(withoutMarkdownCode(source))
      }

      /* A file that names GitHub in its bytes and yields no readable text at all
         is the extractor having gone blind ON THE ONE FILE THAT MATTERED, which
         is precisely the shape of failure a whole-tree count is too coarse to
         notice. */
      if (units.length === 0) {
        throw new Error(
          `SETUP: ${file} names GitHub in its source and produced no readable text. The extractor has gone `
          + 'blind on the one kind of file this guard exists to read.',
        )
      }

      passages += units.length
      for (const unit of units) {
        if (GITHUB.test(unit.text)) mentions.push({ file, line: unit.line, text: unit.text })
        GITHUB.lastIndex = 0
        for (const finding of findingsInText(unit.text)) {
          findings.push({ file, line: unit.line, surface: surface.kind, ...finding })
        }
      }
    }
  }

  if (mentions.length === 0) {
    throw new Error(
      'SETUP: not one user-facing passage on this tree names GitHub. This tree publishes its source there and '
      + 'says so in the help page and in README.md, so either that link has been removed — which is a decision '
      + 'the owner has not made ("we keep the github link") — or this scan has stopped reading. Both need a '
      + 'person; neither is a pass.',
    )
  }

  return { files, examined, passages, mentions, findings }
}

/** The claim patterns, exported so the suite can assert what CANDIDATE assumes. */
export const CLAIM_PATTERNS = Object.freeze(CLAIMS.map((claim) => Object.freeze({ id: claim.id, source: claim.pattern.source })))

/* ---------------------------------------------------------------
   The command line.
   --------------------------------------------------------------- */

function main() {
  const argv = new Set(process.argv.slice(2))
  const result = scan()

  process.stdout.write(
    `GitHub claims: ${result.files.length} user-facing file(s); ${result.examined.length} name GitHub in their `
    + `source and were read in full, giving ${result.passages} passage(s), ${result.mentions.length} of which name `
    + 'GitHub in front of a person.\n',
  )

  if (argv.has('--coverage')) {
    process.stdout.write('\nRead in full:\n')
    for (const file of result.examined) process.stdout.write(`  ${file}\n`)
    process.stdout.write('\nEvery user-facing passage that names GitHub:\n')
    for (const mention of result.mentions) {
      process.stdout.write(`  ${mention.file}:${mention.line}\n      ${JSON.stringify(mention.text.slice(0, 220))}\n`)
    }
    process.stdout.write(
      `\n${result.files.length - result.examined.length} file(s) do not contain the characters "github" anywhere `
      + 'in their source, so no rule in this guard can fire on them.\n',
    )
  }

  if (result.findings.length > 0) {
    process.stdout.write('\nA user-facing sentence claims this product uses GitHub:\n')
    for (const finding of result.findings) {
      process.stdout.write(
        `  - ${finding.file}:${finding.line} [${finding.rule}] ${finding.detail}\n`
        + `      ${JSON.stringify(finding.excerpt.slice(0, 220))}\n`,
      )
    }
    process.stdout.write(
      '\nThe link stays and the connector stays. Publication ("published at github.com/ToolsEnabled", "read the '
      + 'source", "open source") and integration (connecting a person to THEIR OWN GitHub account) are both fine '
      + 'and neither is what went red above. Reword the sentence; do not remove the link, and do not widen this '
      + 'guard to admit it.\n',
    )
    process.exit(1)
  }

  process.stdout.write('No user-facing sentence claims this product uses, runs on or is GitHub.\n')
  process.exit(0)
}

if (process.argv[1]
  && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))) {
  try {
    main()
  } catch (error) {
    const message = String(error.message)
    process.stdout.write(`${message.startsWith('SETUP:') ? message : `SETUP: GitHub-claims guard error: ${message}`}\n`)
    process.exit(2)
  }
}
