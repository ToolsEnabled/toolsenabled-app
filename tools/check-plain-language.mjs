#!/usr/bin/env node

/* THE WORDS ARE THE TRUST SURFACE. THIS IS THE GATE THAT KEEPS THEM PLAIN.
 *
 * The owner, on the product a stranger meets: "the wording is dense and not easy
 * to consume or friendly for users."
 *
 * That is not a cosmetic finding. This product asks a person to let an assistant
 * reach their files, their mail, their money and their machine, and they decide
 * whether to trust it inside ten minutes, from the words on the screen. Dense
 * wording reads as "this is not for me". So density is a defect with a gate, the
 * same as a payload leak or a missing licence notice.
 *
 * WHAT IT MEASURES, and each rule is here because a real string on this tree
 * broke it:
 *
 *   long-sentence  a sentence a person has to read twice. 25 words, which is
 *                  not a style opinion -- it is roughly where a reader stops
 *                  holding the beginning of the clause while reaching the end.
 *   identifier     SCREAMING_SNAKE in front of a person. src/refusal-copy.js
 *                  already owns that rule for refusals; this applies it to
 *                  every string, not only the refusing ones.
 *   internal-id    an id from inside the program printed in a sentence --
 *                  `subscription-launch-env`, a permission-level key, a lane
 *                  name. A person is owed the LABEL, never the key.
 *   jargon         a word that names a mechanism the reader has never been
 *                  shown. Each entry names the plain word to use instead, so
 *                  the finding is a rewrite instruction rather than a scolding.
 *   dead-end       a failure that says what broke and not what to do. "An error
 *                  occurred" is the canonical one; so is "unavailable" alone.
 *
 * WHAT IT SCANS, AND WHY THAT IS THE WHOLE TRICK. String literals, not source.
 * A scan over source text in this repository measures the wrong thing twice
 * over: the comments QUOTE the sentences they replaced, so a naive scan finds
 * the defect inside the note explaining that the defect was removed; and the
 * identifiers, selectors and class names look exactly like violations and are
 * not. tools/lib/user-visible-strings.mjs does the extraction -- comments
 * blanked, regular expressions understood, template literals split at their
 * values, markup tags removed with the tag state carried across the values
 * inside them -- and reports what it threw away and why, so the coverage is
 * visible rather than taken on trust.
 *
 * RELEASE NOTES are also customer copy. Only docs/RELEASE-NOTES-*.md is
 * added: read as Markdown prose using the publication reader, with wrapped
 * sentences joined and code examples omitted. Other docs are not added.
 *
 * WHY IT IS A RATCHET AND NOT A PASS/FAIL. There are 3,000-odd strings on this
 * tree and this gate did not exist while they were written. A gate that goes red
 * on all of them on day one is a gate somebody deletes on day two, and a deleted
 * gate is worse than none because it still reads as protection. So the accepted
 * findings live in tools/plain-language-baseline.json BY IDENTITY, and:
 *
 *   a finding not in the baseline    -> block. Density crept back.
 *   a baselined finding now gone     -> block, saying "lower the baseline",
 *                                       because a ratchet that silently absorbs
 *                                       improvement stops ratcheting.
 *
 * Identity is file + rule + the text itself, never the line number: copy moves
 * down a file every time somebody adds a paragraph above it, and a baseline
 * keyed on lines would go red on an edit that changed nothing it measures.
 *
 * EXIT CODES follow tools/check-no-owner-data.mjs and tools/check-product-naming.mjs,
 * because the ship path chains these together:
 *   0  clean, or every finding is one the baseline already accepts
 *   1  a finding the baseline does not accept, or an accepted one that is fixed
 *   2  a setup problem -- and an empty scan is a setup problem, never a pass
 *
 * RUN IT:
 *   node tools/check-plain-language.mjs
 *   node tools/check-plain-language.mjs --all        every finding, baselined or not
 *   node tools/check-plain-language.mjs --coverage   what was skipped, and why
 *   node tools/check-plain-language.mjs --update     rewrite the baseline
 */

import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { IDENTIFIER_RE } from '../src/refusal-copy.js'
import { passagesFrom, releaseNoteFiles, withoutMarkdownCode } from './check-github-claims.mjs'
import {
  describeRejections,
  sentencesOf,
  visibleTextFrom,
  wordsOf,
} from './lib/user-visible-strings.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = path.join(REPO_ROOT, 'tools', 'plain-language-baseline.json')

/* The renderer, which is everything a customer's eyes reach. shell/ is the main
   process and prints to a log; tools/ is this repository talking to itself. */
const SCAN_ROOTS = Object.freeze(['src', path.join('src', 'views')])

/* THE FILES OUTSIDE THE RENDERER WHOSE STRINGS A PERSON READS.
 *
 * The sentence above -- "shell/ is the main process and prints to a log" --
 * stopped being true on 2026-08-27. shell/agent-notifications.cjs holds the
 * titles and bodies of the desktop notifications, which are the first words
 * this product puts in front of somebody OUTSIDE its own window, on a screen
 * they may be sharing, with no page around them to give them context. They are
 * the copy in this product that needs the rules most, and they were the only
 * copy the gate could not see.
 *
 * NAMED FILES RATHER THAN A `shell` ROOT, and that is the whole point. Adding
 * the directory would sweep in thirty files of log lines and refusal codes,
 * which are this program talking to itself; each one would need a baseline
 * entry, and a baseline that long is a licence rather than a record. A file
 * earns its place on this list by containing words a person reads. */
const SCAN_FILES = Object.freeze([
  path.join('shell', 'agent-notifications.cjs'),
  /* THE ACCOUNTS MENU SHOWS THESE TWO FILES' SENTENCES VERBATIM, since
     2026-09-02. shell/account-registry.cjs refuses with { code, reason } and
     shell/provider-login.cjs answers a sign-in the same way; shell/main.cjs
     answers both as records instead of throwing, and the menu's refusalOf()
     prints `reason` on its status line. A sentence written in either file is
     read on screen, which is the test for a place on this list. */
  path.join('shell', 'account-registry.cjs'),
  path.join('shell', 'provider-login.cjs'),
])

/* THE FILES THAT ARE ALLOWED TO SPELL THE FORBIDDEN WORDS, and the list is two
   entries long on purpose. tools/check-preview-honesty.mjs has the same
   mechanism for the same reason: a guard whose own vocabulary trips it is a
   guard that reports itself. Nothing here is exempt from the RULES -- these
   files are simply not customer copy. */
const NOT_CUSTOMER_COPY = Object.freeze(new Set([
  /* Codes in, sentences out. Its keys ARE identifiers and its own header says
     so; the sentences those keys resolve to are scanned like everything else,
     because they are the half a person reads. Handled per string below rather
     than by skipping the file. */
]))

/* ---------------------------------------------------------------
   Rule 1 -- a sentence a person has to read twice.
   --------------------------------------------------------------- */

/* 25 WORDS. It is not a house style and it is not arbitrary: it is about where a
   reader stops being able to hold the start of a sentence while reaching its
   end, and it is the number the owner's own instruction implies -- "Short
   sentences. Plain words. One idea per line." A sentence past this length is
   almost always two ideas joined by a semicolon or a dash. */
const MAX_WORDS = 25

/* ---------------------------------------------------------------
   Rule 2 -- an identifier in front of a person.
   --------------------------------------------------------------- */

/* Derived from the anchored rule in src/refusal-copy.js rather than retyped, the
   same way tools/refusal-copy-qa.mjs derives its own: one definition of what a
   code looks like, and a copy rule that cannot drift from the refusal rule. */
const EMBEDDED_IDENTIFIER = new RegExp(
  IDENTIFIER_RE.source.replace(/^\^/, '\\b').replace(/\$$/, '\\b'),
  'g',
)

/* Each of these is a false positive that has to be NAMED to be excluded, which
   is the convention tools/refusal-copy-qa.mjs sets. A widened pattern would
   excuse the next real one silently. */
const IDENTIFIER_ALLOWED = Object.freeze(new Set([
  'SHA_256',      // no instance today; kept so a rename cannot slip past
]))

/* ---------------------------------------------------------------
   Rule 3 -- an id from inside the program, printed in a sentence.
   --------------------------------------------------------------- */

/* THE OWNER'S OWN LIST, PLUS THE ONES THIS TREE ACTUALLY HAS. "A customer must
   never see `operator`, `hosted-relay`, `BRIDGE_*` or a tier key. Look up the
   label." BRIDGE_* is rule 2's business. These are the rest: lower-case slugs
   that are keys in this program and mean nothing outside it.
 *
 * A TIER KEY IS THE SUBTLE ONE. `guided`, `standard` and `unrestricted` are also
 * ordinary English words, so the test is not the word -- it is the word wearing
 * quotation marks or backticks, which is how a key gets printed when somebody
 * interpolates one instead of looking up TIER_CHOICES[].label. That keeps "the
 * assistant works inside one folder that you pick" (prose) and catches
 * `the “guided” level` (a key). */
const INTERNAL_SLUGS = Object.freeze([
  Object.freeze({ id: 'hosted-relay', why: 'a paid capability key from the engine' }),
  Object.freeze({ id: 'subscription-launch-env', why: 'a payload module name' }),
  Object.freeze({ id: 'agent-session-confinement', why: 'a payload module name' }),
  Object.freeze({ id: 'owner-thread', why: 'a thread key' }),
  Object.freeze({ id: 'thread-reply', why: 'a write-action flag id; the label is “Reply to your coordinator”' }),
  Object.freeze({ id: 'report-read', why: 'a write-action flag id; the label is “Read agent reports”' }),
  Object.freeze({ id: 'agent-session', why: 'a write-action flag id; the label is “Run an agent session”' }),
  Object.freeze({ id: 'cloud-launch', why: 'a write-action flag id; the label is “Launch Codex Cloud tasks”' }),
])

const QUOTED_TIER_KEY = /["'“”`]\s*(guided|standard|unrestricted)\s*["'“”`]/i

/* ---------------------------------------------------------------
   Rule 4 -- a mechanism nobody has been shown.
   --------------------------------------------------------------- */

/* EVERY ENTRY NAMES WHAT TO SAY INSTEAD, so a finding is a rewrite instruction
 * and not a complaint. That is the difference between a gate somebody uses and a
 * gate somebody argues with.
 *
 * The vocabulary is not invented here. src/local-activity.js already wrote it
 * down for the home screen -- "read-only projection", "audited bridge",
 * "coordinator thread", "source unavailable", "last health sweep": "A person
 * opening this product owns agents, a computer, and some decisions waiting on
 * them; they do not own a projection." That rule was right and it was enforced
 * on exactly one screen. This is the same rule everywhere.
 *
 * WHAT IS DELIBERATELY NOT ON THE LIST. "Agent host" is explained at length in
 * Settings, under "This computer", on purpose, because a person who has already
 * READ the words on another screen needs them translated rather than withheld.
 * A gate that banned the word would delete the one place that defines it. Same for "vault", which
 * src/account-markup.js explains in the sentence it appears in. The rule is
 * about words used AS IF the reader already had them. */
const JARGON = Object.freeze([
  Object.freeze({ word: 'projection', instead: 'say what the screen is showing, or “report”' }),
  Object.freeze({ word: 'projections', instead: 'say what the screen is showing, or “reports”' }),
  Object.freeze({ word: 'envelope', instead: 'say “reply” or name the thing that was missing' }),
  Object.freeze({ word: 'payload', instead: 'say “this copy of the program”' }),
  Object.freeze({ word: 'renderer', instead: 'say “this window”' }),
  Object.freeze({ word: 'idempotency', instead: 'say what the repeat protection does' }),
  Object.freeze({ word: 'idempotent', instead: 'say what the repeat protection does' }),
  Object.freeze({ word: 'corpus', instead: 'say “the work queue”' }),
  Object.freeze({ word: 'fanout', instead: 'say “how many run at once”' }),
  Object.freeze({ word: 'fan-out', instead: 'say “how many run at once”' }),
  Object.freeze({ word: 'stdout', instead: 'say “what it printed”' }),
  Object.freeze({ word: 'stderr', instead: 'say “what it printed”' }),
  Object.freeze({ word: 'localStorage', instead: 'say “saved on this computer”' }),
  Object.freeze({ word: 'IPC', instead: 'say “this window could not reach the program”' }),
  Object.freeze({ word: 'PID', instead: 'say “the program that was running”' }),
  Object.freeze({ word: 'schema', instead: 'say “the shape this file has to have”' }),
  Object.freeze({ word: 'inert', instead: 'say what the control does not do' }),
  Object.freeze({ word: 'confinement', instead: 'say “permission level”' }),
  Object.freeze({ word: 'principal', instead: 'say “the account”' }),
  Object.freeze({ word: 'traversal', instead: 'name the folder rule in words' }),
  /* Mechanism NAMES with an approved plain replacement already in the product. */
  Object.freeze({ word: 'audited bridge', instead: 'say “the audited connection”, which is what src/permission-guidance.js calls it' }),
  Object.freeze({ word: 'action bridge', instead: 'say “the audited connection”' }),
  Object.freeze({ word: 'bridge unavailable', instead: 'say “the audited connection is not answering yet”' }),
  Object.freeze({ word: 'coordinator thread', instead: 'say “the conversation with your coordinator”' }),
  Object.freeze({ word: 'health sweep', instead: 'say “the last check of your computers”' }),
  Object.freeze({ word: 'strict snapshot', instead: 'say what was read, in words' }),
  Object.freeze({ word: 'indexed corpus', instead: 'say “the work queue”' }),
  Object.freeze({ word: 'control target', instead: 'say “the run this page is watching”' }),
  Object.freeze({ word: 'desktop shell', instead: 'say “the installed application”' }),
])

/* ---------------------------------------------------------------
   Rule 5 -- a failure with nowhere to go.
   --------------------------------------------------------------- */

/* THE PHRASE THE OWNER NAMED: "passive dead ends (\"an error occurred\")". A
 * dead end has two properties together, and either one alone is fine:
 *   it reports a failure, AND
 *   it names nothing the reader can do about it.
 *
 * The action vocabulary is the one tools/test/refusal-copy.test.mjs already
 * asserts every curated remedy contains, extended with the verbs this product's
 * own good copy uses. Keeping the two lists in the same shape is deliberate: a
 * remedy that satisfies that suite must satisfy this one.
 *
 * THE LENGTH FLOOR IS WHAT KEEPS IT HONEST. A long explanation that names no
 * verb is usually a paragraph whose remedy is the NEXT sentence, in the next
 * element -- this scanner sees strings, not rendered blocks, so it must not
 * claim to judge composition it cannot see. Twelve words is the length below
 * which a failure string is the whole message a person gets. */
const FAILURE_SIGNAL = /\b(error|errors|failed|failure|unavailable|unable|refused|invalid|denied|not found|went wrong|no reply|malformed|unreachable|unknown)\b/i
/* The last five are the verbs a CONTROL'S OWN DESCRIPTION uses -- "Let a pretend
   problem appear", "Show practice problems", "Allow ...". A row that describes
   what a switch does is not reporting a failure, however many failure words its
   subject matter contains, and a rule that told the author of a settings label
   to "say what to do next" would be giving wrong advice. */
const ACTION_VERB = /\b(try|press|open|close|choose|pick|select|refresh|reload|check|look|correct|shorten|stop|start|wait|turn|reinstall|ask|sign|read|change|run|install|move|use|add|remove|answer|come back|go|let|allow|permit|see|show)\b/i
const DEAD_END_MAX_WORDS = 12

/* ---------------------------------------------------------------
   The scan.
   --------------------------------------------------------------- */

function sourceFiles() {
  const files = []
  for (const root of SCAN_ROOTS) {
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
  /* A NAMED FILE THAT IS NOT THERE IS A SETUP PROBLEM, never a quiet pass. The
     directory roots above already fail loudly when they cannot be read; a list
     of exact files has to do the same, or renaming one of them would retire its
     copy from the gate and report clean. */
  for (const file of SCAN_FILES) {
    const full = path.join(REPO_ROOT, file)
    try {
      if (!statSync(full).isFile()) throw new Error('not a file')
    } catch (error) {
      throw new Error(`SETUP: ${file} is named in SCAN_FILES and could not be read: ${error.message}`)
    }
    files.push(file)
  }
  return files.map(file => file.split(path.sep).join('/')).sort()
}

/* THE ONE PLACE A STRING'S ROLE, NOT ITS WORDS, DECIDES A RULE.
 *
 * src/refusal-copy.js guarantees that refusalSentence() puts a remedy after
 * whatever it is given, for every input including none at all -- that property
 * is asserted exhaustively in tools/test/refusal-copy.test.mjs. So a sentence
 * handed to it as `fallback` is HALF a message by construction, and judging it
 * alone would be judging a half. This is deliberately the only context test in
 * the file, and it excuses exactly one rule: a fallback is still held to the
 * sentence-length, identifier, id and jargon rules like everything else. */
const COMPOSED_WITH_A_REMEDY = /\b(fallback|remedy)\s*:/

/**
 * Every finding in one piece of visible prose.
 *
 * @param text        the words a person reads.
 * @param sourceLine  the line of source it was written on, for the one rule
 *                    above that depends on how the string is used.
 */
export function findingsInText(text, sourceLine = '') {
  const found = []

  for (const sentence of sentencesOf(text)) {
    const words = wordsOf(sentence)
    if (words.length > MAX_WORDS) {
      found.push({
        rule: 'long-sentence',
        detail: `${words.length} words in one sentence (limit ${MAX_WORDS}). Split it, or cut the clause after the semicolon.`,
        excerpt: sentence,
      })
    }
  }

  EMBEDDED_IDENTIFIER.lastIndex = 0
  for (const match of text.match(EMBEDDED_IDENTIFIER) || []) {
    if (IDENTIFIER_ALLOWED.has(match)) continue
    found.push({
      rule: 'identifier',
      detail: `“${match}” is a machine code. Carry it on data-refusal-code and say the sentence instead.`,
      excerpt: text,
    })
  }

  for (const slug of INTERNAL_SLUGS) {
    if (!text.includes(slug.id)) continue
    found.push({
      rule: 'internal-id',
      detail: `“${slug.id}” is ${slug.why}. Look up the label; a person is never shown the key.`,
      excerpt: text,
    })
  }
  const tierKey = text.match(QUOTED_TIER_KEY)
  if (tierKey) {
    found.push({
      rule: 'internal-id',
      detail: `“${tierKey[1]}” is a permission-level key. Use the level's own label from TIER_CHOICES.`,
      excerpt: text,
    })
  }

  const lowered = text.toLowerCase()
  for (const entry of JARGON) {
    const needle = entry.word.toLowerCase()
    /* Word-boundary matching so “bridge” inside “bridged” or a longer phrase
       that was already approved does not fire. Phrases are matched literally. */
    const pattern = /\s/.test(needle)
      ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      : new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (!pattern.test(lowered)) continue
    found.push({
      rule: 'jargon',
      detail: `“${entry.word}” names a mechanism the reader has not been shown — ${entry.instead}.`,
      excerpt: text,
    })
  }

  const words = wordsOf(text)
  if (words.length >= 2 && words.length <= DEAD_END_MAX_WORDS
    && FAILURE_SIGNAL.test(text) && !ACTION_VERB.test(text)
    && !COMPOSED_WITH_A_REMEDY.test(sourceLine)) {
    found.push({
      rule: 'dead-end',
      detail: 'A failure with nothing to do about it. Say what happened and then what to do next.',
      excerpt: text,
    })
  }

  return found
}

/** Every finding across renderer copy, named shell files and release notes. */
export function scan() {
  const files = [...sourceFiles(), ...releaseNoteFiles()].sort()
  if (files.length === 0) throw new Error('SETUP: no source files were found. An empty scan is not a clean scan.')
  const findings = []
  const skipped = []
  let strings = 0
  for (const file of files) {
    if (NOT_CUSTOMER_COPY.has(file)) continue
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8')
    let extracted
    if (file.startsWith('docs/')) {
      // Markdown is prose, not JavaScript literals. Reuse the publication
      // reader so wrapped sentences and code samples have the same treatment.
      const visible = passagesFrom(withoutMarkdownCode(source))
      if (visible.length === 0) {
        throw new Error(`SETUP: ${file} produced no readable release-note prose.`)
      }
      extracted = { visible, skipped: [] }
    } else {
      try {
        extracted = visibleTextFrom(source)
      } catch (error) {
        throw new Error(`SETUP: ${file} could not be read as JavaScript: ${error.message}`)
      }
    }
    strings += extracted.visible.length
    skipped.push(...extracted.skipped)
    for (const entry of extracted.visible) {
      for (const finding of findingsInText(entry.text, entry.sourceLine)) {
        findings.push({ file, line: entry.line, ...finding })
      }
    }
  }
  if (strings === 0) throw new Error(`SETUP: ${files.length} files were read and no visible string came out of any of them. The extractor has gone blind.`)
  return { files, strings, findings, skipped }
}

/* IDENTITY IS FILE + RULE + TEXT, NEVER THE LINE. Copy moves down a file every
   time somebody adds a paragraph above it, and a baseline keyed on line numbers
   would go red on an edit that changed nothing it measures -- which teaches
   people to run --update without reading, and a baseline nobody reads is a
   licence. The excerpt is trimmed and collapsed so a reflow is not a new key. */
export function identityOf(finding) {
  const excerpt = String(finding.excerpt || '').replace(/\s+/g, ' ').trim()
  return `${finding.file}\t${finding.rule}\t${excerpt}`
}

function readBaseline() {
  let raw
  try {
    raw = readFileSync(BASELINE_PATH, 'utf8')
  } catch {
    return { accepted: [], missing: true }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`SETUP: ${path.relative(REPO_ROOT, BASELINE_PATH)} is not readable JSON: ${error.message}`)
  }
  if (!Array.isArray(parsed.accepted)) {
    throw new Error(`SETUP: ${path.relative(REPO_ROOT, BASELINE_PATH)} has no "accepted" array, so nothing could be compared.`)
  }
  return { accepted: parsed.accepted, missing: false }
}

function writeBaseline(findings, note) {
  const accepted = [...new Set(findings.map(identityOf))].sort()
  const body = {
    $comment: 'Plain-language findings this tree has not fixed yet, by identity (file, rule, the text itself). '
      + 'Generated by `node tools/check-plain-language.mjs --update`. This list may only ever get SHORTER: a finding '
      + 'that is not here blocks, and an entry here that no longer occurs also blocks, so that fixing something is a '
      + 'visible act rather than a silent absorption. Do not add an entry by hand to make a red run green.',
    note,
    accepted,
    updated: new Date().toISOString(),
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`)
  return accepted.length
}

function main() {
  const argv = new Set(process.argv.slice(2))
  const result = scan()
  const rendered = finding => `${finding.file}:${finding.line}: [${finding.rule}] ${finding.detail}\n      ${JSON.stringify(finding.excerpt.slice(0, 160))}`

  if (argv.has('--coverage')) {
    process.stdout.write(`Plain language: ${result.strings} visible string(s) across ${result.files.length} file(s).\n`)
    process.stdout.write('Skipped, by reason (these are not copy):\n')
    for (const entry of describeRejections(result.skipped)) {
      process.stdout.write(`  ${String(entry.count).padStart(5)}  ${entry.reason}\n`)
    }
  }

  if (argv.has('--all')) {
    for (const finding of result.findings) process.stdout.write(`  - ${rendered(finding)}\n`)
  }

  if (argv.has('--update')) {
    const count = writeBaseline(result.findings, 'Rewritten by --update. Read the diff: every line added is a sentence somebody has to fix later.')
    process.stdout.write(`Plain language: baseline rewritten with ${count} accepted finding(s) from ${result.strings} visible strings.\n`)
    process.exit(0)
  }

  const { accepted, missing } = readBaseline()
  if (missing) {
    process.stdout.write('SETUP: tools/plain-language-baseline.json does not exist. Run this with --update once to record what is already here, then read the diff.\n')
    process.exit(2)
  }
  const acceptedSet = new Set(accepted)
  const seen = new Set()
  const regressions = []
  for (const finding of result.findings) {
    const identity = identityOf(finding)
    seen.add(identity)
    if (!acceptedSet.has(identity)) regressions.push(finding)
  }
  const fixed = accepted.filter(identity => !seen.has(identity))

  const byRule = new Map()
  for (const finding of result.findings) byRule.set(finding.rule, (byRule.get(finding.rule) || 0) + 1)
  const tally = [...byRule.entries()].sort().map(([rule, count]) => `${rule}=${count}`).join(' ') || 'none'
  process.stdout.write(
    `Plain language: ${result.strings} visible string(s) across ${result.files.length} file(s); `
    + `${result.findings.length} finding(s) [${tally}]; ${accepted.length} accepted by the baseline.\n`,
  )

  if (regressions.length > 0) {
    process.stdout.write(`\n${regressions.length} finding(s) the baseline does not accept — density crept back:\n`)
    for (const finding of regressions) process.stdout.write(`  - ${rendered(finding)}\n`)
    process.stdout.write(
      '\nRewrite the string. Do NOT add it to tools/plain-language-baseline.json to make this pass: '
      + 'the baseline records what was already here on the day the gate landed, and it is allowed to shrink and nothing else.\n',
    )
    process.exit(1)
  }

  if (fixed.length > 0) {
    process.stdout.write(`\n${fixed.length} baselined finding(s) no longer occur. Lower the baseline:\n`)
    for (const identity of fixed) {
      const [file, rule, excerpt] = identity.split('\t')
      process.stdout.write(`  - ${file} [${rule}] ${JSON.stringify(String(excerpt).slice(0, 120))}\n`)
    }
    process.stdout.write('\nRun `node tools/check-plain-language.mjs --update` and commit the shorter file. '
      + 'A ratchet that silently absorbs improvement stops ratcheting inside a month.\n')
    process.exit(1)
  }

  process.stdout.write('Every visible string is either plain or a finding the baseline already accepts.\n')
  process.exit(0)
}

if (process.argv[1]
  && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))) {
  try {
    main()
  } catch (error) {
    process.stdout.write(`${String(error.message).startsWith('SETUP:') ? error.message : `SETUP: plain-language gate error: ${error.message}`}\n`)
    process.exit(2)
  }
}
