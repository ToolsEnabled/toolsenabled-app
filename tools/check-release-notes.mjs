#!/usr/bin/env node

/* A RELEASE NOTE IS A PROMISE, AND NOTHING WAS CHECKING IT.
 *
 * docs/RELEASE-NOTES-TEMPLATE.md has carried a careful contract since it was
 * written: every section filled, known issues stated even when the list is long,
 * the installer hash recorded, the publisher and copyright block left exactly as
 * ATTRIBUTION.md fixes it, and the pre-publication checklist deleted before the
 * note is published. On 2026-09-09 not one line of tooling read that contract.
 * `npm run dist` chains twenty-odd check-*.mjs guards and `release:cut` four
 * more; none of them opens a release note. Neither does docs/release-preparation.md,
 * which describes the whole qualification path and never mentions notes at all.
 *
 * WHAT GOES WRONG WITHOUT IT, in the order it actually goes wrong: a placeholder
 * ships unreplaced, because a backticked <installer sha256> looks like content at
 * a glance; the Known issues section is dropped because it is the one section
 * nobody enjoys writing, which the template already warns is "a support queue
 * later"; the pre-publication checklist ships attached to the published note; and
 * the copyright block drifts, which is the one thing on the page that is not the
 * release team's to reword -- ATTRIBUTION.md owns those strings and the notes only
 * copy them.
 *
 * WHAT THIS GUARD IS NOT. It does not write, grade or approve a release note, and
 * it has no opinion about whether the release is any good. It reads one file and
 * asks whether the template's own contract was met. It reads no artifact, runs no
 * build, and deliberately does not look at the signing, sealing, payload-boundary
 * or owner-data gates -- those are other guards' jobs and other lanes' scope. The
 * SHA-256 check below asserts the SHAPE of a recorded digest, never that it
 * matches a file.
 *
 * EXIT CODES follow tools/check-no-owner-data.mjs and tools/check-product-naming.mjs
 * deliberately, because a build script chains these together and a novel contract
 * in one of them is a bug waiting for a pipe: 0 clean, 1 the note is incomplete,
 * 2 a setup problem. A MISSING NOTE IS A SETUP PROBLEM (2), NOT A PASS. That is
 * the absence-as-emptiness defect this codebase keeps rediscovering, and a notes
 * guard that "passed" because there was no note to read would be the same hole in
 * a new place.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* The sections the template lays out, in the order it lays them out. A note that
 * drops one has dropped the thing that section exists to force somebody to say. */
export const REQUIRED_SECTIONS = [
  'Highlights',
  'Added',
  'Changed',
  'Fixed',
  'Known issues',
  'Install',
  'Publisher and copyright'
]

/* Sections that must carry at least one bullet. A release with nothing to report
 * under one of these writes "- None." and says so; it does not leave the heading
 * bare and let a reader guess whether it was empty or forgotten. */
const SECTIONS_NEEDING_CONTENT = ['Highlights', 'Added', 'Changed', 'Fixed', 'Known issues']

/* Fixed by docs/ATTRIBUTION.md, not by whoever is cutting. Compared after
 * blockquote markers and line wrapping are normalised away, so re-wrapping the
 * paragraph is allowed and rewording it is not. */
const PUBLISHER_LINE = 'Published by ToolsEnabled, Inc. (in formation)'
const FOUNDING_LINE =
  'ToolsEnabled was founded and created by Joshua Pinckard. The original platform was ' +
  "developed by directing autonomous AI-agent fleets through the system's own evolving " +
  'coordination architecture.'

const COPYRIGHT_LINE = /Copyright © \d{4} Joshua Pinckard/
const REGISTERED_MARK = '®'
/* How far either side of "ToolsEnabled, Inc." a qualifying "(in formation)" still
   counts. Wide enough for the template's incorporation parenthetical, narrow enough
   that one qualified mention cannot vouch for an unrelated claim a paragraph away. */
const WINDOW = 90
const PLACEHOLDER = /`<[^`\n]*>`/g

function parseArguments(argv) {
  const rest = []
  let notes = null
  let packetPlatform = null
  let sourcePlan = false
  const platforms = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--notes') {
      notes = argv[index + 1] ?? null
      index += 1
      continue
    }
    if (argv[index] === '--platform') {
      const value = argv[index + 1]
      if (typeof value === 'string' && value.length > 0) platforms.push(value.trim().toLowerCase())
      index += 1
      continue
    }
    if (argv[index] === '--packet-platform') {
      const value = argv[index + 1]
      if (packetPlatform !== null || typeof value !== 'string' || value.length === 0) throw new Error('--packet-platform requires exactly one platform name')
      packetPlatform = value.trim().toLowerCase()
      index += 1
      continue
    }
    if (argv[index] === '--source-plan') {
      if (sourcePlan) throw new Error('--source-plan may be supplied once')
      sourcePlan = true
      continue
    }
    rest.push(argv[index])
  }
  if (sourcePlan && packetPlatform !== null) throw new Error('--source-plan and --packet-platform are mutually exclusive')
  if ((sourcePlan || packetPlatform !== null) && platforms.length === 0) throw new Error('--source-plan and --packet-platform require one or more --platform values')
  if (packetPlatform !== null && !platforms.includes(packetPlatform)) throw new Error('--packet-platform must be one of the declared --platform values')
  return { notes: notes ?? rest[0] ?? null, platforms, packetPlatform, sourcePlan }
}

/* Collapse blockquote markers and wrapping so a fixed string can be compared as
 * one sentence regardless of how the note wraps it. */
function normalise(text) {
  return text.replace(/^[>\s]+/gm, ' ').replace(/\s+/g, ' ').trim()
}

/* The document split at its `##` headings: { title, body } in document order. The
 * `#` title line is not a section and is read separately. */
export function splitSections(text) {
  const sections = []
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      if (current) sections.push(current)
      current = { title: heading[1], lines: [] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) sections.push(current)
  return sections.map(section => ({ title: section.title, body: section.lines.join('\n') }))
}

function bulletsIn(body) {
  return body
    .split(/\r?\n/)
    .filter(line => /^\s*[-*]\s+\S/.test(line))
    .map(line => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(bullet => bullet.length > 0)
}

/* ONE NOTE, ONE BUILD TAG, TWO PLATFORMS.
 *
 * A release is cut for Windows and for Linux from the same source tip, so the note
 * at that tip carries an install record for each. Neither digest can exist while the
 * note is being written -- the artifact does not exist yet -- so each record declares
 * its digest `pending` and the platform cutter fills its own record in the PACKET copy
 * from its own receipt. The guard then runs against that packet copy and must exit 0
 * before publication.
 *
 * That is why "pending" is a DISTINCT state and not just a missing digest. The three
 * outcomes a reader of this guard cares about are different problems with different
 * fixes:
 *
 *   filled      a 64-hex digest        -> nothing to do
 *   pending     the literal word       -> the cutter has not filled this record yet
 *   malformed   anything else, or a    -> the record is broken and no cutter will
 *               missing SHA-256 row       repair it by running; a person must
 *
 * Collapsing pending into malformed would tell a release operator to go fix a note
 * that is exactly as it should be at that moment; collapsing malformed into pending
 * would tell them to wait for a cutter that will never fix it. The distinction is the
 * whole point of this function.
 *
 * A body with no `###` headings is one unnamed record, which is the single-platform
 * shape and stays valid: a Linux-only packet note with its own digest filled passes.
 */
const PENDING_DIGEST = /^`?pending`?$/i

export function installRecords(body) {
  const lines = body.split(/\r?\n/)
  const records = []
  let current = { name: null, lines: [] }
  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/.exec(line)
    if (heading) {
      if (current.lines.length > 0 || current.name !== null) records.push(current)
      current = { name: heading[1], lines: [] }
      continue
    }
    current.lines.push(line)
  }
  records.push(current)
  /* A RECORD IS A TABLE, NOT PROSE. The section opens with a paragraph explaining why
   * the digests are pending, and an earlier draft of this function counted that
   * paragraph as a nameless record -- so the guard reported a missing SHA-256 row and
   * an unfilled Signed row against a block that was never meant to carry either. A
   * nameless block therefore only counts when it actually has a table row in it, which
   * is exactly the single-platform shape this still has to accept. A NAMED block always
   * counts: `### Linux package` with no table under it is a broken record and saying so
   * is the point. */
  return records
    .filter(record => record.name !== null || record.lines.some(line => line.includes('|')))
    .map(record => ({ name: record.name, body: record.lines.join('\n') }))
}

/* WHICH PLATFORM A RECORD IS ABOUT.
 *
 * The "Platform" row is the record's own answer, so it is read first; the `###`
 * heading is only a fallback, because a heading is a label a person wrote and the
 * row is the field the cutter fills. A record that names neither returns null and
 * is left alone: this guard refuses to guess a platform and then accuse a note of
 * shipping it. */
const KNOWN_PLATFORMS = ['linux', 'windows', 'macos']

export function recordPlatform(record) {
  const row = /\|\s*Platform\s*\|([^|]*)\|/i.exec(record.body)
  const stated = row ? row[1].replace(/`/g, '').trim().toLowerCase() : ''
  if (KNOWN_PLATFORMS.includes(stated)) return stated
  const name = (record.name ?? '').toLowerCase()
  for (const platform of KNOWN_PLATFORMS) if (name.includes(platform)) return platform
  return null
}

function digestCell(recordBody) {
  const row = /\|\s*SHA-256\s*\|([^|]*)\|/i.exec(recordBody)
  if (!row) return { state: 'absent' }
  const value = row[1].trim()
  if (/^[0-9a-f]{64}$/i.test(value.replace(/`/g, ''))) return { state: 'filled' }
  if (value === '' || PENDING_DIGEST.test(value)) return { state: 'pending' }
  return { state: 'malformed', value }
}

export function installProblems(body, platforms = [], { sourcePlan = false, packetPlatform = null } = {}) {
  const problems = []
  const records = installRecords(body)
  const label = record => record.name ? `Install record "${record.name}"` : 'Install'
  const pending = []
  if (sourcePlan && packetPlatform !== null) problems.push('A source plan cannot also qualify a measured packet.')
  if ((sourcePlan || packetPlatform !== null) && (!platforms.length || platforms.some(platform => !KNOWN_PLATFORMS.includes(platform)))) {
    problems.push('Source plans and packets require an explicit known release-platform inventory.')
  }
  if (packetPlatform !== null && !platforms.includes(packetPlatform)) problems.push('The packet platform must belong to the declared release.')
  const requiredPlatforms = packetPlatform === null ? platforms : [packetPlatform]

  for (const record of records) {
    const digest = digestCell(record.body)
    if (digest.state === 'absent') {
      problems.push(
        `${label(record)} has no "SHA-256" row at all. A record without that row is malformed: ` +
        'no cutter will repair it by running, so a person has to.'
      )
    } else if (digest.state === 'malformed') {
      problems.push(
        `${label(record)} records ${JSON.stringify(digest.value)} where a 64-character SHA-256 ` +
        'or the word "pending" belongs. A reader cannot check the download they were handed ' +
        'against the one you published, and no cutter will fill a field that is already occupied.'
      )
    } else if (digest.state === 'pending' && !sourcePlan) {
      pending.push(label(record))
    }
    if (sourcePlan && digest.state === 'filled') problems.push(`${label(record)} is already measured; a source plan must keep its digest pending.`)
    if (sourcePlan || packetPlatform !== null) {
      const platform = recordPlatform(record)
      if (!platform) problems.push(`${label(record)} must identify its platform for a source plan or packet.`)
      if (packetPlatform !== null && platform !== packetPlatform) problems.push(`${label(record)} names ${platform} in a ${packetPlatform} packet.`)
      if (records.filter(candidate => recordPlatform(candidate) === platform).length !== 1) problems.push(`${label(record)} must be the only install record for ${platform}.`)
      for (const field of ['Package', 'Platform', 'Bytes', 'SHA-256', 'Signed']) {
        const rows = [...record.body.matchAll(new RegExp('^\\|\\s*' + field + '\\s*\\|([^|]*)\\|[ \\t]*$', 'gm'))]
        if (rows.length !== 1) { problems.push(`${label(record)} needs exactly one ${field} row.`); continue }
        const value = rows[0][1].replace(/`/g, '').trim()
        if (!value) problems.push(`${label(record)} has an empty ${field} row.`)
        if (packetPlatform !== null && PENDING_DIGEST.test(value)) problems.push(`${label(record)} still has a pending ${field} measurement.`)
        if (packetPlatform !== null && field === 'Bytes' && (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))) problems.push(`${label(record)} has no measured positive byte count.`)
      }
    }
    if (!/\|\s*Signed\s*\|\s*[^|\s]/i.test(record.body)) {
      problems.push(
        `${label(record)} has no filled "Signed" row. If the build is unsigned, say so here ` +
        'rather than letting the user discover it from a SmartScreen warning.'
      )
    }
  }

  /* A NOTE MUST NOT PROMISE A PLATFORM THE RELEASE DOES NOT SHIP.
   *
   * The template's normal shape is one note, one build tag, two platforms, and for a
   * two-platform release that is right. 1.0.44 is not that release: standing request
   * R1212 makes it a Linux-only cut, and the note at the cut tip still carried a
   * "### Windows installer" record with a pending digest. Pending is the state that
   * means "a cutter will fill this", so the note read as a promise that a Windows
   * 1.0.44 package was coming. No Windows cutter was ever going to run, so the record
   * would have stayed pending through publication, or worse, been filled by hand.
   *
   * Nothing mechanical caught that, because every check above asks whether a record is
   * WELL FORMED and none asks whether it should EXIST. The caller that knows the answer
   * is the cutter: a Linux cut passes --platform linux, and this then reads the note
   * against the release it is actually cutting. Without --platform the guard behaves
   * exactly as before, so a two-platform release and every existing caller are
   * unaffected.
   *
   * Both directions are errors and they are different mistakes: an extra record
   * promises an artifact nobody is building, and a missing one hides an artifact that
   * is being shipped with no digest for a reader to check. */
  if (platforms.length > 0) {
    const covered = new Set()
    for (const record of records) {
      const platform = recordPlatform(record)
      if (platform === null) continue
      covered.add(platform)
      if (!requiredPlatforms.includes(platform)) {
        problems.push(
          `${label(record)} is an install record for ${platform}, but this release ships ` +
          `${platforms.join(' and ')}. A record with a pending digest reads as a promise that a ` +
          `${platform} package is coming; remove the record, or say in Known issues that ` +
          `${platform} is not released in this version.`
        )
      }
    }
    for (const platform of requiredPlatforms) {
      if (!covered.has(platform)) {
        problems.push(
          `this release ships ${platform}, but the note has no install record for it. A reader ` +
          'cannot check the download they were handed against the one you published.'
        )
      }
    }
  }

  /* Reported LAST and as one line, so an operator reading a failing note sees the
   * malformed records -- the ones only they can fix -- above the pending ones, which
   * the cutter fills on its own. */
  if (pending.length > 0) {
    problems.push(
      `install digest pending: ${pending.join(', ')}. The platform cutter fills this from its ` +
      'own receipt in the packet copy of the note. Never write a digest by hand.'
    )
  }
  return problems
}

/* Each cutter checks the full source inventory before keeping just its own
 * measured record. Publication later combines both independently qualified
 * records. Removing an unbuilt platform here never qualifies that platform. */
export function assertSourceInstallPlan(text, platforms) {
  const install = splitSections(text).find(section => section.title.toLowerCase() === 'install')
  if (!install) throw new Error('The source release note has no Install section')
  const problems = installProblems(install.body, platforms, { sourcePlan: true })
  if (problems.length) throw new Error(`The source release plan is incomplete: ${problems.join('; ')}`)
}

export function packetReleaseNotes(text, { platforms, packetPlatform }) {
  const sectionPattern = /^## Install[ \t]*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m
  const section = sectionPattern.exec(text)
  if (!section) throw new Error('The release note has no Install section')
  const records = installRecords(section[1]).filter(record => recordPlatform(record) === packetPlatform)
  if (records.length !== 1) throw new Error(`A packet needs exactly one ${packetPlatform} install record`)
  const record = records[0]
  const body = `${record.name ? `### ${record.name}\n` : ''}${record.body.trim()}\n`
  const problems = installProblems(body, platforms, { packetPlatform })
  if (problems.length) throw new Error(`The measured packet is incomplete: ${problems.join('; ')}`)
  return text.replace(sectionPattern, `## Install\n\nThis packet records the measured ${packetPlatform} artifact. Compare its SHA-256\nwith the downloaded file. Other platforms require their own qualified packet.\n\n${body}\n`)
}

export function checkReleaseNotes({ text, expectedVersion, platforms = [], sourcePlan = false, packetPlatform = null }) {
  const problems = []
  const sections = splitSections(text)
  const byTitle = new Map(sections.map(section => [section.title.toLowerCase(), section]))

  for (const required of REQUIRED_SECTIONS) {
    if (!byTitle.has(required.toLowerCase())) {
      problems.push(`the "${required}" section is missing.`)
    }
  }

  for (const required of SECTIONS_NEEDING_CONTENT) {
    const section = byTitle.get(required.toLowerCase())
    if (!section) continue
    if (bulletsIn(section.body).length === 0) {
      problems.push(
        `"${required}" has no entries. Write one, or write "- None." -- a bare heading ` +
        'does not say whether it was empty or forgotten.'
      )
    }
  }

  /* The title carries the version a reader believes they are installing. */
  const title = /^#\s+ToolsEnabled\s+`?([^\s`]+)`?\s*$/m.exec(text)
  if (!title) {
    problems.push('there is no "# ToolsEnabled <version>" title line.')
  } else if (expectedVersion && title[1] !== expectedVersion) {
    problems.push(
      `the title says ${JSON.stringify(title[1])} but package.json says ` +
      `${JSON.stringify(expectedVersion)}. One of them is wrong about what is shipping.`
    )
  }

  if (!/^\*Released\s+`?\d{4}-\d{2}-\d{2}`?\*\s*$/m.test(text)) {
    problems.push('there is no "*Released YYYY-MM-DD*" line with a real date.')
  }

  /* Unreplaced template placeholders. These read as content at a glance, which is
   * exactly why they ship. */
  const placeholders = [...new Set(text.match(PLACEHOLDER) ?? [])]
  if (placeholders.length > 0) {
    problems.push(
      `${placeholders.length} template placeholder${placeholders.length === 1 ? '' : 's'} ` +
      `${placeholders.length === 1 ? 'was' : 'were'} never replaced: ${placeholders.join(', ')}`
    )
  }

  const install = byTitle.get('install')
  if (install) {
    for (const problem of installProblems(install.body, platforms, { sourcePlan, packetPlatform })) problems.push(problem)
  }

  /* ATTRIBUTION.md owns these strings; the notes only copy them. */
  const publisher = byTitle.get('publisher and copyright')
  if (publisher) {
    const flat = normalise(publisher.body)
    if (!flat.includes(PUBLISHER_LINE)) {
      problems.push(`the publisher line is not the fixed wording: expected ${JSON.stringify(PUBLISHER_LINE)}.`)
    }
    if (!COPYRIGHT_LINE.test(flat)) {
      problems.push('the copyright line is not the fixed "Copyright <symbol> <year> Joshua Pinckard" wording.')
    }
    if (!flat.includes(FOUNDING_LINE)) {
      problems.push('the founding line is missing or reworded. docs/ATTRIBUTION.md fixes it verbatim.')
    }
    if (!/Contributors and maintainers are never founders\./.test(flat)) {
      problems.push('the "Contributors and maintainers are never founders." rule is missing.')
    }
  }

  /* The company does not exist yet, and a release note is a published claim. Read
   * this over the flattened document, not line by line: a note that wraps
   * "ToolsEnabled, Inc." and "(in formation)" onto two lines is correct, and a
   * guard that called that a violation would be deleted rather than obeyed. */
  const flatDocument = normalise(text)
  for (const match of flatDocument.matchAll(/ToolsEnabled, Inc\./g)) {
    const end = match.index + match[0].length
    /* Look BOTH ways, not just forward. The template's own closing parenthetical --
     * "Once ToolsEnabled, Inc. is incorporated, drop \"(in formation)\" and change the
     * copyright holder to ToolsEnabled, Inc." -- names the company twice and qualifies
     * both with one "(in formation)" sitting between them. A forward-only window called
     * the second one a false claim, on a sentence the template tells people to keep. */
    if (/in formation/.test(flatDocument.slice(end, end + WINDOW))) continue
    if (/in formation/.test(flatDocument.slice(Math.max(0, match.index - WINDOW), match.index))) continue
    problems.push(
      `ToolsEnabled, Inc. is claimed without "(in formation)": ${JSON.stringify(flatDocument.slice(Math.max(0, match.index - 40), end + 60).trim())}`
    )
  }

  if (text.includes(REGISTERED_MARK)) {
    problems.push('the notes carry a registered-trademark symbol. There is no registered mark.')
  }

  /* The template says to delete this before release, in the section itself. */
  if (byTitle.has('pre-publication checklist')) {
    problems.push(
      'the "Pre-publication checklist" section is still attached. The template says to delete ' +
      'it before release -- it is working notes, not something a user reads.'
    )
  }

  return { problems, sectionCount: sections.length }
}

function readVersion() {
  const manifest = path.join(REPO_ROOT, 'package.json')
  if (!existsSync(manifest)) throw new Error(`no package.json at ${manifest}`)
  const version = JSON.parse(readFileSync(manifest, 'utf8')).version
  if (typeof version !== 'string' || !version) throw new Error('package.json declares no version')
  return version
}

function main() {
  const { notes, platforms, sourcePlan, packetPlatform } = parseArguments(process.argv.slice(2))
  const version = readVersion()
  const notesFile = path.resolve(REPO_ROOT, notes ?? path.join('docs', `RELEASE-NOTES-${version}.md`))

  if (!existsSync(notesFile)) {
    throw new Error(
      `no release notes at ${path.relative(REPO_ROOT, notesFile)}. Copy docs/RELEASE-NOTES-TEMPLATE.md ` +
      'there and fill it in, or name the note you meant with --notes. A release with no note is ' +
      'not a release that passed this check.'
    )
  }

  const text = readFileSync(notesFile, 'utf8')
  if (text.trim().length === 0) throw new Error(`${path.relative(REPO_ROOT, notesFile)} is empty`)

  const relative = path.relative(REPO_ROOT, notesFile)
  console.log(`Release notes: ${relative}`)
  console.log(`Version under test: ${version}`)
  if (platforms.length > 0) console.log(`Platforms this release ships: ${platforms.join(', ')}`)
  if (sourcePlan) console.log('Checking source release plan: every declared record must remain pending.')
  if (packetPlatform !== null) console.log(`Checking measured packet record: ${packetPlatform}.`)

  const { problems, sectionCount } = checkReleaseNotes({ text, expectedVersion: version, platforms, sourcePlan, packetPlatform })

  if (problems.length > 0) {
    console.error(`\n${relative} is incomplete:`)
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(
      '\nThe contract is docs/RELEASE-NOTES-TEMPLATE.md, and the publisher and copyright wording ' +
      'is fixed by docs/ATTRIBUTION.md. Fill the note; do not delete a section to make this pass.'
    )
    process.exitCode = 1
    return
  }

  console.log(`\nChecked ${sectionCount} sections against the template contract. Complete.`)
}

/* RUN AS A COMMAND, NOT ON IMPORT -- same shape as tools/check-product-naming.mjs,
 * and for the same reason: this file exports checkReleaseNotes and REQUIRED_SECTIONS,
 * and an unguarded main() would mean importing either one runs the whole check as a
 * side effect and sets the importer's exit code. */
if (
  process.argv[1] &&
  realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))
) {
  try {
    main()
  } catch (error) {
    console.error(`Release-notes guard error: ${error.message}`)
    process.exitCode = 2
  }
}
