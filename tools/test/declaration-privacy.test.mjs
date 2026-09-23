/* Does the document that LEAVES with the release carry the builder with it?
 *
 * THE DEFECT THIS PINS: DECLARATION.md is the provenance statement written into
 * the transfer directory beside the installer, for whoever verifies the release
 * to read. Every declaration this packager produced embedded the builder's home
 * directory -- measured on the shipped 1.0.4: 11 occurrences of the account name
 * across 10 lines of DECLARATION.md, and 7 more in the declaration-facts.json
 * beside it. `check-no-owner-data.mjs` did not catch any of it, because it scans
 * `release/win-unpacked` and these two files are not in the package; they are
 * written after it, by the packager. The one document designed to travel had no
 * privacy gate at all.
 *
 * WHAT IS ACTUALLY TESTED HERE, and why it is three things and not one:
 *
 *   1. The renderer no longer emits owner data. Necessary, and on its own the
 *      kind of fix that regresses the next time someone needs a path in a
 *      sentence.
 *   2. Redaction did not cost the document its usefulness. A declaration whose
 *      reproduction steps a recipient cannot follow has failed at its only job,
 *      so "no absolute paths" is only half a passing bar -- vagueness would
 *      satisfy check 1 completely.
 *   3. The guard refuses to WRITE a leaking declaration. This is the part that
 *      survives someone adding a new field two months from now: 1 and 2 test
 *      today's renderer, 3 tests every future one. Note where it is proved --
 *      the file must not exist afterwards, not merely a throw, because a
 *      half-written document in the transfer directory is a document that can
 *      be transferred.
 *
 * These spawn the real check-no-owner-data.mjs rather than stubbing a pattern
 * list, for the same reason the guard itself does: a second copy of the patterns
 * drifts, and a stale copy still reports "clean".
 *
 * NO OWNER VALUE IS WRITTEN INTO THIS FILE. Anything identity-shaped is either
 * read from the running environment (os.userInfo(), os.hostname(), os.homedir())
 * or is a fixture invented here. A test that hardcodes the values it is meant to
 * keep out of shipped files has leaked them into the repository instead.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assertNoOwnerData } from '../check-declaration-privacy.mjs'
import { writeDeclarationArtifacts } from '../release-packager/cut-release-candidate.mjs'
import { prepareDeclarationArtifacts } from '../release-packager/lib/declaration-preflight.mjs'
import { renderDeclaration, writeDeclaration } from '../release-packager/generate-declaration.mjs'
import {
  BUILD_WORKTREE_TOKEN,
  HOME_PLACEHOLDER,
  portablePath,
  portableValue,
  toDeclarableFacts,
} from '../release-packager/lib/portable-paths.mjs'

const TOOLS_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAYLOAD_SCANNER = path.join(TOOLS_DIRECTORY, 'check-no-owner-data.mjs')
const DECLARATION_GUARD = path.join(TOOLS_DIRECTORY, 'check-declaration-privacy.mjs')
const REPO_ROOT = path.resolve(TOOLS_DIRECTORY, '..')
const OWNER_PROFILE = path.join(REPO_ROOT, 'private', 'owner-data-patterns.owner.json')

// Keep this suite hermetic on fresh checkouts. The production scanner correctly
// refuses to run without a builder identity profile, while CI intentionally has
// no private/ directory. Supply a disposable, ignored profile and a home with
// enough path segments for portablePath's shallow-root safety check. Neither
// fixture contains or derives real owner identity.
//
// private/ is where the REAL developer keeps owner-data-patterns.owner.json
// (git-ignored) beside other real, hand-maintained local files that this test
// did not write: fleet-profile.owner.json and research-queue.authored.json are
// git-tracked and always present, capability-source.owner.json is another
// git-ignored local file. Cleanup below removes only the exact fixture file (and,
// if this test also had to create the directory itself, that now-empty
// directory) -- never the directory recursively -- so a worktree that simply
// has not had owner-data-patterns.owner.json copied in yet cannot lose its
// siblings. That used to be `rm(path.dirname(OWNER_PROFILE), {recursive: true,
// force: true})`, which deletes the whole private/ directory. Measured: with
// only owner-data-patterns.owner.json absent (the normal state of a fresh
// worktree, since it is git-ignored), running this file alone deleted
// fleet-profile.owner.json and research-queue.authored.json (`git status`
// reported both ` D`) plus capability-source.owner.json outright -- three real
// files this test never created.
let originalHome
let originalAccountOverride
let fixtureHome
let createdOwnerProfile = false
let createdOwnerProfileDir = false

// Remove exactly what creating the fixture profile added, and nothing this
// suite did not put there itself. Exported at module scope (rather than
// inlined in test.after) so the regression test below exercises this exact
// code, not a restatement of it that could drift from what actually runs.
async function removeCreatedProfileFixture(profilePath, dirWasCreated) {
  await rm(profilePath, { force: true })
  // rmdir, never `rm(dir, {recursive: true})`: this only removes the
  // directory when THIS run created it from nothing, and even then only if
  // it is now empty -- it silently no-ops rather than touching a directory
  // that turned out to hold anything else.
  if (dirWasCreated) await rmdir(path.dirname(profilePath)).catch(() => {})
}

test.before(async () => {
  originalHome = process.env.HOME
  originalAccountOverride = process.env.MC_IDENTITY_PROFILE_ACCOUNT
  fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'declaration-builder-home-'))
  process.env.HOME = path.join(fixtureHome, 'accounts', FIXTURE_ACCOUNT)

  if (!existsSync(OWNER_PROFILE)) {
    createdOwnerProfileDir = !existsSync(path.dirname(OWNER_PROFILE))
    await mkdir(path.dirname(OWNER_PROFILE), { recursive: true })
    await writeFile(OWNER_PROFILE, JSON.stringify({ patterns: [{ value: FIXTURE_ACCOUNT }] }))
    createdOwnerProfile = true
    process.env.MC_IDENTITY_PROFILE_ACCOUNT = FIXTURE_ACCOUNT
  }
})

test.after(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalAccountOverride === undefined) delete process.env.MC_IDENTITY_PROFILE_ACCOUNT
  else process.env.MC_IDENTITY_PROFILE_ACCOUNT = originalAccountOverride
  if (createdOwnerProfile) await removeCreatedProfileFixture(OWNER_PROFILE, createdOwnerProfileDir)
  if (fixtureHome) await rm(fixtureHome, { recursive: true, force: true })
})

/* ---------- 0. this suite's own fixture cleanup is hermetic ---------- */

/* THE DEFECT THIS PINS: the hook above used to read
 * `rm(path.dirname(OWNER_PROFILE), {recursive: true, force: true})` whenever
 * it had written a disposable owner-data-patterns.owner.json -- deleting the
 * whole private/ directory, not the one file it created. Measured on this
 * repo: private/fleet-profile.owner.json and private/research-queue.authored.json
 * are git-tracked and always present; private/owner-data-patterns.owner.json
 * is git-ignored and is not. Simulating a worktree where only the ignored file
 * is missing (`node --test tools/test/declaration-privacy.test.mjs` run alone
 * with that one file moved aside) made every test in this file pass while
 * `git status` reported the two tracked siblings deleted, plus the git-ignored
 * private/capability-source.owner.json destroyed outright with no git copy to
 * recover it from -- three real files this suite never touched.
 *
 * dirWasCreated is passed false here because that is this repo's actual
 * condition: private/ already exists (it holds tracked files), only the one
 * git-ignored profile inside it is ever absent. */
test('cleanup after creating the fixture profile removes only that file, not real sibling data in private/', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'declaration-privacy-cleanup-'))
  try {
    const privateDir = path.join(fixtureRoot, 'private')
    await mkdir(privateDir, { recursive: true })
    const sibling = path.join(privateDir, 'fleet-profile.owner.json')
    await writeFile(sibling, '{"real":"data"}')
    const created = path.join(privateDir, 'owner-data-patterns.owner.json')
    await writeFile(created, '{"patterns":[]}')

    await removeCreatedProfileFixture(created, false)

    assert.equal(existsSync(created), false, 'the fixture file itself should be gone')
    assert.equal(existsSync(sibling), true, 'a real sibling file in private/ must survive cleanup')
    assert.equal(existsSync(privateDir), true, 'the private/ directory itself must survive when it pre-existed')
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('cleanup removes a private/ directory only when this suite created it from nothing', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'declaration-privacy-cleanup-'))
  try {
    const privateDir = path.join(fixtureRoot, 'private')
    await mkdir(privateDir, { recursive: true })
    const created = path.join(privateDir, 'owner-data-patterns.owner.json')
    await writeFile(created, '{"patterns":[]}')

    await removeCreatedProfileFixture(created, true)

    assert.equal(existsSync(created), false, 'the fixture file itself should be gone')
    assert.equal(existsSync(privateDir), false, 'a directory this suite created empty-handed should not be left behind')
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

// A home directory belonging to somebody who is not the account running this
// test. It can never be redacted by portablePath (which only knows THIS home)
// and it always trips check-no-owner-data.mjs's built-in `C:\Users` pattern --
// so it exercises the guard deterministically without depending on what the
// local identity profile happens to contain, and without putting a real name
// anywhere near this repository.
const FOREIGN_HOME_PATH = 'C:\\Users\\someone-else\\Desktop\\stray'

/* A Windows path inside JSON is not the same bytes as the path.
 *
 * `JSON.stringify(facts).includes(os.homedir())` -- the obvious way to write the
 * serialisation assertions below, and the way the sibling suite
 * require-clean-tree.test.mjs writes them -- CANNOT MATCH ON WINDOWS: stringify
 * doubles every backslash, so the needle `C:\Users\me` is looking for something
 * that is never present in a haystack containing `C:\\Users\\me`. Caught by
 * planting a mutant that removed array recursion from portableValue and watching
 * the assertion that should have killed it pass. So both forms are searched, and
 * the escaped one is the one that actually does the work here. */
function leaks(haystack, needle) {
  if (typeof needle !== 'string' || needle.length === 0) return false
  const escaped = JSON.stringify(needle).slice(1, -1)
  return haystack.includes(needle) || haystack.includes(escaped)
}

/* Facts stuffed with real, local, identifying values in every field the
 * declaration is known to render a path from. Deliberately built from the live
 * machine: a fixture path like "C:\fixture\repo" would let a renderer that
 * stopped redacting keep passing. */
function leakyFacts(overrides = {}) {
  const home = os.homedir()
  return {
    test: false,
    date: '2026-08-11',
    version: '1.0.4',
    previousVersion: '1.0.3',
    repo: path.join(home, 'Desktop', 'wt-capability'),
    branch: 'packaging/capability-layer',
    sourceRef: '0c13106',
    buildRef: 'b'.repeat(40),
    branchAdvanced: false,
    candidate: { filename: 'ToolsEnabled Setup 1.0.4.exe', bytes: 101509214, sha256: 'ABCDEF01'.repeat(8) },
    publisher: 'ToolsEnabled, Inc. in formation',
    treeState: {
      worktreePath: path.join(home, 'Desktop', 'wt-release-build-1.0.4'),
      worktreeRemoved: true,
      buildInfoConfirmedClean: true,
    },
    versionInfo: {
      companyName: 'ToolsEnabled, Inc.',
      productName: 'ToolsEnabled',
      fileVersion: '1.0.4',
      productVersion: '1.0.4',
      legalCopyright: 'Copyright \u00A9 2026 ToolsEnabled',
    },
    appId: { configured: 'com.toolsenabled.desktop' },
    unsigned: { signExecutable: false },
    pipeline: { verifySummary: null, checkNoOwnerData: null, smokePackagedLine: null, distExitCode: 0, packagedQaExitCode: 0 },
    excludedWip: {
      sourceWorktree: path.join(home, 'Desktop', 'wt-capability'),
      measuredAt: '2026-08-11T00:00:00.000Z',
      dirtyFiles: [' M src/main.js'],
    },
    otherCandidates: [
      {
        path: path.join(home, 'Desktop', 'ToolsEnabled-INSTALLER-CANDIDATE', '1.0.3', 'ToolsEnabled Setup 1.0.3.exe'),
        bytes: 101490181,
        sha256: 'CAFEBABE',
        mtime: '2026-08-11T00:05:26.219Z',
      },
    ],
    stagingDir: path.join(home, 'Desktop', 'ToolsEnabled-INSTALLER-CANDIDATE', '1.0.4'),
    privateInputsCopied: ['owner-data-patterns.owner.json'],
    privateInputsSkippedTracked: [],
    ...overrides,
  }
}

/* ---------- 1. the document carries no builder identity ---------- */

test('the rendered declaration carries no absolute path, username, or hostname', () => {
  const markdown = renderDeclaration(leakyFacts())

  assert.ok(!markdown.includes(os.homedir()), 'the build account home directory was rendered into the declaration')
  assert.ok(!markdown.includes(path.basename(os.homedir())), 'the builder username was rendered into the declaration')
  assert.ok(!markdown.includes(os.hostname()), 'the builder hostname was rendered into the declaration')
  // Belt to the above braces: catches a home directory shape this machine does
  // not happen to have, which is the case a same-machine test would miss.
  assert.doesNotMatch(markdown, /[A-Za-z]:\\Users\\/, 'a Windows user path leaked into the declaration')
  assert.doesNotMatch(markdown, /\/Users\/|\/home\//, 'a POSIX home path leaked into the declaration')
})

test('the serialised facts file carries no absolute path, username, or hostname either', () => {
  // The renderer and the facts JSON are written into the SAME transfer
  // directory. Fixing only the markdown leaves a clean-reading declaration
  // sitting beside a JSON file that names the builder seven times, which is
  // what the shipped 1.0.2 and 1.0.4 pairs actually look like.
  const serialised = JSON.stringify(toDeclarableFacts(leakyFacts()))

  assert.ok(!leaks(serialised, os.homedir()), 'the build account home directory was serialised into the facts file')
  assert.ok(!leaks(serialised, path.basename(os.homedir())), 'the builder username was serialised into the facts file')
  assert.ok(!leaks(serialised, os.hostname()), 'the builder hostname was serialised into the facts file')
  assert.doesNotMatch(serialised, /[A-Za-z]:\\\\Users\\\\/, 'a Windows user path leaked into the facts file')
})

test('the facts file is scanned before it is written, so unredacted facts cannot reach the transfer directory', async () => {
  // The layer below the redaction. cut-release-candidate.mjs scans the exact
  // JSON string it is about to write, so if a future edit serialises the raw
  // measured facts again -- which is what the shipped 1.0.2 and 1.0.4
  // declaration-facts.json files are -- the run fails instead of the file
  // shipping. Proved against raw facts here because that is the regression:
  // redaction is what SHOULD happen, this is what happens when it does not.
  //
  // The raw facts carry this suite's fixture home (HOME is redirected to
  // .../accounts/fixture-builder in test.before), and only an identity profile
  // that describes that account can recognise it; no built-in rule covers a
  // POSIX home. The checkout's own private/owner-data-patterns.owner.json is
  // the fixture profile only when test.before had to create it. In a worktree
  // that already holds a builder's real profile (the release cutter copies one
  // in), the real profile does not name fixture-builder, so the scan correctly
  // finds nothing and this case failed for a reason unrelated to the gate.
  // The byte-identical guard/scanner pair in a fixture tree, with a profile
  // that describes the fixture builder, proves the same function on every
  // checkout. The real-profile case is the builder's own home, which that
  // profile does describe.
  await withFixtureRepo(async ({ guard }) => {
    const { assertNoOwnerData: fixtureAssertNoOwnerData } = await import(pathToFileURL(guard).href)
    const previousAccount = process.env.MC_IDENTITY_PROFILE_ACCOUNT
    process.env.MC_IDENTITY_PROFILE_ACCOUNT = FIXTURE_ACCOUNT
    try {
      assert.throws(
        () => fixtureAssertNoOwnerData('declaration-facts.json', `${JSON.stringify(leakyFacts(), null, 2)}\n`, { log: () => {} }),
        /contains owner-identifying data and was NOT written/,
        'unredacted facts passed the pre-write scan',
      )
      assert.doesNotThrow(
        () => fixtureAssertNoOwnerData('declaration-facts.json', `${JSON.stringify(toDeclarableFacts(leakyFacts()), null, 2)}\n`, { log: () => {} }),
        'redacted facts were rejected by the pre-write scan -- the gate is failing shut on everything',
      )
    } finally {
      if (previousAccount === undefined) delete process.env.MC_IDENTITY_PROFILE_ACCOUNT
      else process.env.MC_IDENTITY_PROFILE_ACCOUNT = previousAccount
    }
  })
})

test('local-only path fields are dropped from the facts, not merely rewritten', () => {
  // %USERPROFILE%\Desktop\wt-capability would pass every leak assertion above
  // and still be useless to a recipient. These three fields have no portable
  // form worth keeping, so the fix is deletion; buildRef is what identifies the
  // source on any clone.
  const declarable = toDeclarableFacts(leakyFacts())

  assert.equal(declarable.repo, undefined, 'facts.repo (the day-to-day checkout path) survived redaction')
  assert.equal(declarable.treeState.worktreePath, undefined, 'facts.treeState.worktreePath survived redaction')
  assert.equal(
    declarable.excludedWip.sourceWorktree,
    undefined,
    'facts.excludedWip.sourceWorktree survived redaction -- this is the field set at cut-release-candidate.mjs:411',
  )
  assert.equal(declarable.buildRef, 'b'.repeat(40), 'redaction removed the build ref, which is the source identity')
  assert.deepEqual(
    declarable.excludedWip.dirtyFiles,
    [' M src/main.js'],
    'the excluded-WIP file list is the information in that section and must survive',
  )
})

test('a home path embedded mid-sentence is rewritten, not just one at the start of a string', () => {
  // branchAdvanceError is captured git output with a path inside prose. A
  // prefix-only rule passes it through untouched and the guard finds it after
  // the fact -- which is a failed build instead of a correct document.
  const home = os.homedir()
  const sentence = `fatal: could not lock ref in ${home}\\Desktop\\wt-capability\\.git -- retry`

  const portable = portablePath(sentence)
  assert.ok(!portable.includes(home), 'an embedded home path was left in place by portablePath')
  assert.ok(portable.includes(HOME_PLACEHOLDER), 'portablePath dropped the path instead of making it portable')
  assert.ok(portable.includes('fatal: could not lock ref'), 'portablePath destroyed the surrounding message')
})

test('portablePath refuses to treat a too-shallow directory as a home directory', () => {
  // A blank or drive-root home would rewrite every path on the machine to
  // %USERPROFILE%, silently corrupting documents rather than protecting anyone.
  const value = 'C:\\Users\\builder\\Desktop\\thing'
  assert.equal(portablePath(value, { home: 'C:\\' }), value, 'a drive root was accepted as a home directory')
  assert.equal(portablePath(value, { home: '' }), value, 'an empty home directory was accepted')
  assert.equal(portablePath(value, { home: undefined }), value, 'an undefined home directory was accepted')
})

test('portableValue rewrites strings nested in arrays and objects, not just top-level ones', () => {
  // otherCandidates[].path is an array of objects; a shallow map leaves the
  // exclusion list -- the longest run of absolute paths in the document -- untouched.
  const home = os.homedir()
  const rewritten = portableValue({ list: [{ path: path.join(home, 'a', 'b') }], depth: { one: { two: home } } })

  assert.ok(!leaks(JSON.stringify(rewritten), home), 'portableValue did not reach a string nested inside an array')
  assert.equal(rewritten.depth.one.two, HOME_PLACEHOLDER, 'a deeply nested home path was not rewritten')
})

/* ---------- 2. redaction did not cost the document its usefulness ---------- */

test('the redacted declaration still gives a verifier everything they act on', () => {
  const markdown = renderDeclaration(leakyFacts())

  assert.match(markdown, /ABCDEF01/, 'the SHA-256 a recipient checks the bytes against is missing')
  assert.match(markdown, /101,509,214/, 'the exact byte count is missing')
  assert.match(markdown, /b{40}/, 'the build ref -- the only portable identity of the source -- is missing')
  assert.match(markdown, /ToolsEnabled Setup 1\.0\.4\.exe/, 'the candidate filename is missing')

  // The transfer location must stay FINDABLE. %USERPROFILE% resolves as written
  // in Explorer, cmd and PowerShell, so this is still a working path.
  assert.match(
    markdown,
    /%USERPROFILE%[\\/]Desktop[\\/]ToolsEnabled-INSTALLER-CANDIDATE[\\/]1\.0\.4[\\/]ToolsEnabled Setup 1\.0\.4\.exe/,
    'the immutable transfer location is no longer a path anyone can follow',
  )
  // The reproduction steps must stay RUNNABLE.
  assert.match(
    markdown,
    /git worktree add --detach <isolated build worktree> 0c13106/,
    'the reproduction command lost the checkout step a verifier has to run',
  )
  assert.match(markdown, /git status --porcelain/, 'the clean-tree evidence step is missing')
  assert.match(
    markdown,
    /git show b{40}:package\.json/,
    'the command that proves the version-bump commit is reproducible is missing',
  )
  // And the reader must be told how to read the substitutions, or a portable
  // path is just an unexplained one.
  assert.match(markdown, /### Paths in this document/, 'nothing explains what %USERPROFILE% and the placeholders mean')
  assert.ok(
    markdown.includes(BUILD_WORKTREE_TOKEN),
    'the build-worktree placeholder is used but never appears where it is explained',
  )
  // The exclusion list is the section that says "do not trust these bytes"; it
  // is worthless without paths a reader can resolve.
  assert.match(
    markdown,
    /%USERPROFILE%[\\/]Desktop[\\/]ToolsEnabled-INSTALLER-CANDIDATE[\\/]1\.0\.3[\\/]ToolsEnabled Setup 1\.0\.3\.exe/,
    'the "artifacts that are NOT this candidate" list lost the paths that make it actionable',
  )
})

/* ---------- 3. the guard refuses to write a leaking declaration ---------- */

async function withStaging(run) {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'declaration-privacy-'))
  try {
    await run(staging)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

test('declaration metadata redacts all three documents before readiness can authorize writing', async () => {
  // The wiring, not the pieces. Redaction and scanning each had their own tests
  // while this sequence was inline in main(); a mutant that serialised the raw
  // measured facts into declaration-facts.json survived all of them, because
  // nothing could reach main() without running a build. That mutant is exactly
  // the shipped 1.0.2/1.0.4 defect, so it has to be reachable from a test.
  await withStaging(async (staging) => {
    const { declarationMarkdown: markdown, factsJson, manifestJson } = prepareDeclarationArtifacts(staging, leakyFacts())
    await assert.rejects(() => writeDeclarationArtifacts(staging, leakyFacts()), /readiness|receipt|adapter/i)
    assert.equal(existsSync(path.join(staging, 'DECLARATION.md')), false)

    assert.ok(!leaks(markdown, os.homedir()), 'the written DECLARATION.md carries the build account home directory')
    assert.ok(
      !leaks(factsJson, os.homedir()),
      'the written declaration-facts.json carries the build account home directory -- the renderer was fixed and the facts file was not',
    )
    assert.ok(!leaks(factsJson, path.basename(os.homedir())), 'the written declaration-facts.json carries the builder username')
    assert.ok(!leaks(manifestJson, os.homedir()), 'the written download.json carries the build account home directory')
    assert.equal(JSON.parse(manifestJson).productVersion, '1.0.4')
    assert.match(markdown, /ABCDEF01/, 'the written declaration is not the rendered document')
  })
})

test('writeDeclarationArtifacts writes no publication document when one would leak', async () => {
  await withStaging(async (staging) => {
    const facts = leakyFacts({
      pipeline: {
        verifySummary: null,
        checkNoOwnerData: null,
        smokePackagedLine: `PASS staged from ${FOREIGN_HOME_PATH}`,
        distExitCode: 0,
        packagedQaExitCode: 0,
      },
    })

    await assert.rejects(
      () => writeDeclarationArtifacts(staging, facts),
      /contains owner-identifying data and was NOT written/,
      'a leaking publication set was written to the transfer directory',
    )
    assert.ok(!existsSync(path.join(staging, 'DECLARATION.md')), 'a rejected run still left DECLARATION.md behind')
    assert.ok(
      !existsSync(path.join(staging, 'declaration-facts.json')),
      'a rejected run left part of the publication set behind -- a lone facts file next to an installer reads as a declared candidate',
    )
    assert.ok(!existsSync(path.join(staging, 'download.json')), 'a rejected run left a publishable download.json behind')
  })
})

test('clean declaration metadata passes privacy but cannot be written without readiness', async () => {
  await withStaging(async (staging) => {
    const target = path.join(staging, 'DECLARATION.md')
    const rendered = renderDeclaration(leakyFacts())
    assert.doesNotThrow(() => assertNoOwnerData(target, rendered), 'the privacy positive control must really pass')
    assert.match(rendered, /ABCDEF01/)
    await assert.rejects(() => writeDeclaration(target, leakyFacts()), /readiness|receipt|adapter/i)
    assert.equal(existsSync(target), false, 'clean metadata is not a full release-readiness verdict')
  })
})

test('writeDeclaration REFUSES to write a declaration containing owner data, and leaves no file behind', async () => {
  await withStaging(async (staging) => {
    const target = path.join(staging, 'DECLARATION.md')
    // smokePackagedLine is free text captured from pipeline output and rendered
    // verbatim -- exactly the shape of field a future change adds without
    // thinking about redaction. A foreign home path also proves the point the
    // renderer cannot: path rewriting only knows THIS builder's home, so the
    // guard is what covers every other one.
    const facts = leakyFacts({
      pipeline: {
        verifySummary: null,
        checkNoOwnerData: null,
        smokePackagedLine: `PASS staged from ${FOREIGN_HOME_PATH}`,
        distExitCode: 0,
      },
    })

    await assert.rejects(
      () => writeDeclaration(target, facts),
      /contains owner-identifying data and was NOT written/,
      'a declaration carrying a user home path was written without complaint',
    )
    assert.ok(
      !existsSync(target),
      'the refusal still left a declaration on disk -- a half-written document in a transfer directory can be transferred',
    )
  })
})

/* ---------- the guard, exercised hermetically against fixture patterns ---------- */
//
// A temp tree containing both guards and a fixture identity profile. This is the
// same shape tools/test/no-owner-data.test.mjs uses, and it is what lets the
// identity-pattern half be tested without a real name appearing anywhere: the
// guard resolves its scanner relative to its own location, so a copied pair is a
// working pair.

const FIXTURE_ACCOUNT = 'fixture-builder'
const FIXTURE_ALIAS = 'fixture-private-alias'

async function withFixtureRepo(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'declaration-privacy-fixture-'))
  try {
    const tools = path.join(home, 'tools')
    const privateDirectory = path.join(home, 'private')
    await mkdir(tools, { recursive: true })
    await mkdir(privateDirectory, { recursive: true })

    await copyFile(PAYLOAD_SCANNER, path.join(tools, 'check-no-owner-data.mjs'))
    await copyFile(DECLARATION_GUARD, path.join(tools, 'check-declaration-privacy.mjs'))
    await writeFile(
      path.join(privateDirectory, 'owner-data-patterns.owner.json'),
      JSON.stringify({ patterns: [{ value: FIXTURE_ACCOUNT }, { value: FIXTURE_ALIAS }] }),
    )

    await run({ home, guard: path.join(tools, 'check-declaration-privacy.mjs') })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

function runGuard(guard, files, extraEnv = {}) {
  const result = spawnSync(process.execPath, [guard, ...files], {
    encoding: 'utf8',
    env: { ...process.env, MC_IDENTITY_PROFILE_ACCOUNT: FIXTURE_ACCOUNT, ...extraEnv },
    windowsHide: true,
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

test('the guard CLI fails on a declaration naming the builder and passes on the same document without it', async () => {
  await withFixtureRepo(async ({ home, guard }) => {
    const dirty = path.join(home, 'DIRTY-DECLARATION.md')
    const clean = path.join(home, 'DECLARATION.md')
    await writeFile(dirty, `# Declaration\n\nBuilt by ${FIXTURE_ALIAS} from %USERPROFILE%\\Desktop.\n`)
    await writeFile(clean, '# Declaration\n\nBuilt from %USERPROFILE%\\Desktop.\n')

    const dirtyRun = runGuard(guard, [dirty])
    assert.equal(dirtyRun.status, 1, `a declaration naming the builder was reported clean:\n${dirtyRun.output}`)
    assert.match(dirtyRun.output, /owner-data-found/, 'the failure does not say WHY the declaration was rejected')
    assert.match(dirtyRun.output, /DIRTY-DECLARATION\.md/, 'the failure does not name the document that tripped it')

    const cleanRun = runGuard(guard, [clean])
    assert.equal(cleanRun.status, 0, `a clean declaration was rejected:\n${cleanRun.output}`)
  })
})

test('the guard uses the identity profile, not a private copy of the pattern list that could drift', async () => {
  await withFixtureRepo(async ({ home, guard }) => {
    // FIXTURE_ALIAS is in the fixture profile and in no built-in pattern. If
    // this guard had restated check-no-owner-data.mjs's patterns instead of
    // running it, the per-builder half would be invisible here.
    const file = path.join(home, 'facts.json')
    await writeFile(file, JSON.stringify({ note: `configured for ${FIXTURE_ALIAS}` }))

    const run = runGuard(guard, [file])
    assert.equal(run.status, 1, `a per-builder identity pattern was not applied:\n${run.output}`)
    assert.match(run.output, /facts\.json/, 'the failure does not name the file')
  })
})

test('a scanner that cannot run is a FAILURE, not a pass -- unchecked is not clean', async () => {
  await withFixtureRepo(async ({ home, guard }) => {
    const file = path.join(home, 'DECLARATION.md')
    await writeFile(file, '# Declaration\n\nNothing identifying here.\n')

    // A blank account override makes check-no-owner-data.mjs exit 2: it refuses
    // to let the variable become an off switch. Whatever makes the scan
    // impossible, the answer here must never be "clean" -- that is the
    // absence-as-emptiness defect one level up.
    const run = runGuard(guard, [file], { MC_IDENTITY_PROFILE_ACCOUNT: '   ' })
    assert.equal(run.status, 2, `an unrunnable scanner was treated as a clean result:\n${run.output}`)
    assert.match(run.output, /scanner-error/, 'a setup failure is not distinguished from a real leak')
  })
})

test('the guard refuses a file that does not exist instead of reporting it clean', async () => {
  await withFixtureRepo(async ({ home, guard }) => {
    const run = runGuard(guard, [path.join(home, 'never-generated.md')])
    assert.equal(run.status, 2, `a missing document exited 0 -- "nothing to check" reported as success:\n${run.output}`)
    assert.match(run.output, /nothing to check/, 'the failure does not say the file was absent')
  })
})

test('the guard refuses to run with no arguments rather than exiting 0 having scanned nothing', async () => {
  await withFixtureRepo(async ({ guard }) => {
    const run = runGuard(guard, [])
    assert.equal(run.status, 2, `the guard exited 0 with nothing to scan:\n${run.output}`)
    assert.match(run.output, /usage:/, 'the guard failed without telling the caller what it wanted')
  })
})
