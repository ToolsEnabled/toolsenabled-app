// Run: node --test tools/test/check-no-owner-data.test.mjs

import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE_GATE = path.join(REPO_ROOT, 'tools', 'check-no-owner-data.mjs')
const ACCOUNT = 'owner-data-gate-fixture-builder'
// Synthetic shape-rule positives, assembled at run time: this file ships in the
// source tree the gate scans, where a literal one would be reported as a finding.
const CAMPUS = ['campus', 'edu'].join('.')
const MAIL_CO = ['mail', 'co'].join('.')
const HOSTNAME = ['desktop', 'ab12cd3'].join('-')
const RETIRED_PROVIDER_MARKER = ['Digital', 'Ocean'].join('')
const RETIRED_PROVIDER_SPACED_MARKER = ['Digital', ' ', 'Ocean'].join('')
const RETIRED_PROVIDER_HYPHEN_MARKER = ['Digital', '-', 'Ocean'].join('')
// A builder's own retired names (another project, a private mirror, a code-host
// handle) are profile entries, not built-in rules; these stand in for them.
const RETIRED_NAMES = ['RetiredSampleProject', 'sample_private_mirror', 'sample-code-host-handle']
// The five profile-filled built-in slots (see the top of check-no-owner-data.mjs).
// Synthetic values: the real ones are one builder's names, kept in their profile.
const RETIRED_CROSS_PRODUCT_MARKER = 'RetiredSampleProduct'
const RETIRED_CROSS_PRODUCT_SPACED_MARKER = 'Retired Sample Product'
const RETIRED_CROSS_PRODUCT_HYPHEN_MARKER = 'Retired-Sample-Product'
const OWNER_MIRROR_DEFAULT_MARKER = 'sample_mirror_default'
const OWNER_GITHUB_HANDLE_MARKER = 'samplecodehosthandle'
const BUILT_IN_MARKERS = {
  'retired cross-product metadata': [RETIRED_CROSS_PRODUCT_MARKER, RETIRED_CROSS_PRODUCT_SPACED_MARKER, RETIRED_CROSS_PRODUCT_HYPHEN_MARKER],
  'owner mirror default': [OWNER_MIRROR_DEFAULT_MARKER],
  'owner GitHub handle': [OWNER_GITHUB_HANDLE_MARKER],
}

let fixtureRoot
let gate
let cleanPayload
let emptyPayload

before(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'check-no-owner-data-'))
  gate = path.join(fixtureRoot, 'tools', 'check-no-owner-data.mjs')
  cleanPayload = path.join(fixtureRoot, 'payload-clean')
  emptyPayload = path.join(fixtureRoot, 'payload-empty')

  await mkdir(path.dirname(gate), { recursive: true })
  await mkdir(path.join(fixtureRoot, 'private'), { recursive: true })
  await mkdir(cleanPayload)
  await mkdir(emptyPayload)
  await cp(SOURCE_GATE, gate)
  await writeFile(
    path.join(fixtureRoot, 'private', 'owner-data-patterns.owner.json'),
    `${JSON.stringify({ patterns: [ACCOUNT], builtInMarkers: BUILT_IN_MARKERS })}\n`,
  )
  await writeFile(path.join(cleanPayload, 'artifact.txt'), 'ordinary packaged bytes\n')
})

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
})

function run(script, ...arguments_) {
  return spawnSync(process.execPath, [script, ...arguments_], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: { ...process.env, MC_IDENTITY_PROFILE_ACCOUNT: ACCOUNT },
  })
}

function output(result) {
  return `${result.stdout}${result.stderr}`
}

test('check-no-owner-data refuses an empty enumeration instead of passing blind', () => {
  const result = run(gate, emptyPayload)

  assert.equal(result.status, 2, output(result))
  assert.match(result.stderr, /nothing to check: scanned 0 files in 1 directory/)
  assert.doesNotMatch(result.stdout, /Total matches: 0/)
})

test('check-no-owner-data refuses a missing input instead of treating absence as clean', () => {
  const missing = path.join(fixtureRoot, 'payload-missing')
  const result = run(gate, missing)

  assert.equal(result.status, 2, output(result))
  assert.match(result.stderr, /nothing to check: directory does not exist:/)
  assert.doesNotMatch(result.stdout, /Total matches: 0/)
})

test('check-no-owner-data runs through differently named copied entry paths', async (t) => {
  const upperNamed = path.join(fixtureRoot, 'tools', 'CHECK-NO-OWNER-DATA-COPY.mjs')
  const renamed = path.join(fixtureRoot, 'tools', 'owner-data-gate-renamed.mjs')
  await cp(gate, upperNamed)
  await cp(gate, renamed)

  for (const script of [upperNamed, renamed]) {
    await t.test(path.basename(script), () => {
      const result = run(script, emptyPayload)
      assert.equal(result.status, 2, output(result))
      assert.match(result.stderr, /nothing to check: scanned 0 files in 1 directory/)
    })
  }
})

test('check-no-owner-data still passes after scanning a present clean artifact', () => {
  const result = run(gate, cleanPayload)

  assert.equal(result.status, 0, output(result))
  assert.match(result.stdout, /Scanned 1 files \(24 bytes\)\. Total matches: 0\./)
})

test('check-no-owner-data fails when the scanned artifact contains owner data', async () => {
  const leakingPayload = path.join(fixtureRoot, 'payload-leaking')
  await mkdir(leakingPayload)
  await writeFile(path.join(leakingPayload, 'artifact.txt'), `${ACCOUNT}\n`)

  const result = run(gate, leakingPayload)

  assert.equal(result.status, 1, output(result))
  assert.match(result.stdout, /Total matches: 1\./)
  // T334 review: a profile value is never printed as a label. The hit line names
  // the pattern by class and index; only the excerpt line carries the bytes.
  assert.match(result.stdout, /pattern=profile#\d+ \| matches=1/)
  const outsideExcerpts = result.stdout.split('\n').filter((line) => !line.includes('excerpt=')).join('\n')
  assert.ok(!outsideExcerpts.includes(ACCOUNT), 'the profile value must appear only in an excerpt line, never as a pattern label')
})

/* A PROFILE PATH IS A LEAK IN EVERY ENCODING IT IS WRITTEN IN.
 *
 * MEASURED 2026-09-07 against this guard as it stood, with three one-file
 * payloads carrying the same path and nothing else identifying (the drive
 * letter is written <drive> here, so this comment is not itself a match):
 *
 *   <drive>:\Users\some-builder\...            -> refused, backslash rule
 *   file:///<drive>:/Users/some-builder/...    -> refused, forward-slash rule
 *   {"workingDirectory":"<drive>:\\Users\\..."} -> "Total matches: 0.", EXIT 0
 *
 * The third is the one that ships. The needle is the eight bytes C : \ U s e r s;
 * a JSON file escapes its backslashes, so the bytes on disk are C : \ \ U s e r s
 * and the fourth byte compared is a backslash where the needle wants "U". The scan
 * cannot match at any offset. Every JSON record in the artefact -- and the release
 * seal records are exactly that shape -- is therefore invisible to the rule written
 * to catch it, and the guard reports clean.
 *
 * This is the same instrument failure twice in one release: a `Select-String` for
 * the single-backslash drive-rooted Users path over the 1.0.41 seal records also
 * returns nothing while every value in them is a profile path. A zero is a claim about the instrument before it is a claim about
 * the bytes, which is why all three encodings are asserted here together: a fix for
 * one that silently drops another would pass a single-encoding test.
 *
 * The fixtures use a neutral account name on purpose. If they used the builder's,
 * the identity profile would catch them and this test would pass without the
 * path rule working at all -- green for the wrong reason. */
test('check-no-owner-data refuses a profile path in every encoding it can ship in', async (t) => {
  const NEUTRAL_ACCOUNT = 'some-builder'
  // Interpolated in the forward-slash spellings below: the literal drive, colon,
  // slash and Users is itself a rule of the gate that scans this source file.
  const DRIVE = 'C:'
  for (const fixture of [
    {
      directory: 'payload-path-plain',
      file: 'record.txt',
      body: `workingDirectory=C:\\Users\\${NEUTRAL_ACCOUNT}\\Desktop\\ws\n`,
      encoding: 'plain backslash',
    },
    {
      directory: 'payload-path-json-escaped',
      file: 'record.json',
      /* JSON.stringify produces the escaped form: this is what a real record
         on disk looks like, not a hand-built string. */
      body: `${JSON.stringify({ workingDirectory: `C:\\Users\\${NEUTRAL_ACCOUNT}\\Desktop\\ws` })}\n`,
      encoding: 'JSON-escaped double backslash',
    },
    {
      directory: 'payload-path-file-url',
      file: 'record.json',
      body: `${JSON.stringify({ href: `file:///${DRIVE}/Users/${NEUTRAL_ACCOUNT}/Desktop/ws` })}\n`,
      encoding: 'file:// forward slash',
    },
    {
      directory: 'payload-path-percent-encoded',
      file: 'state.json',
      /* Built with encodeURIComponent rather than hand-written, so the fixture is
         what the product would actually persist, not what I imagine it persists. */
      body: `${JSON.stringify({ cwd: encodeURIComponent(`C:\\Users\\${NEUTRAL_ACCOUNT}\\Desktop\\ws`) })}\n`,
      encoding: 'percent-encoded',
    },
    {
      directory: 'payload-path-percent-encoded-slash',
      file: 'query.txt',
      body: `?root=${encodeURIComponent(`${DRIVE}/Users/${NEUTRAL_ACCOUNT}/Desktop`)}\n`,
      encoding: 'percent-encoded with forward slashes',
    },
    /* SEPARATOR COUNTS OTHER THAN ONE-OR-TWO. The four fixtures below all PASSED the
       guard when measured on 2026-09-10, because the rules above cover exactly two
       counts: one separator (the byte scans) and two backslashes (the JSON-escaped
       regex). Nothing covered any other count, so a path escaped simply by being
       escaped twice, or by being joined with a separator on both sides.

       These are not exotic spellings. Double escaping is what happens when a JSON
       record carrying a path is itself serialised into another JSON record, which is
       what a log line holding a state blob is. `C://` is what path joining produces
       when a root and a relative part each bring their own separator. */
    {
      directory: 'payload-path-double-json-escaped',
      file: 'log.json',
      /* Serialised twice, as a record embedded in a record actually is. */
      body: `${JSON.stringify({ blob: JSON.stringify({ cwd: `C:\\Users\\${NEUTRAL_ACCOUNT}\\ws` }) })}\n`,
      encoding: 'double JSON-escaped, four backslashes',
    },
    {
      directory: 'payload-path-triple-backslash',
      file: 'record.json',
      body: `{"cwd":"C:\\\\\\Users\\${NEUTRAL_ACCOUNT}\\ws"}\n`,
      encoding: 'triple backslash',
    },
    {
      directory: 'payload-path-double-slash',
      file: 'record.json',
      body: `${JSON.stringify({ href: `C://Users/${NEUTRAL_ACCOUNT}/ws` })}\n`,
      encoding: 'doubled forward slash',
    },
    {
      directory: 'payload-path-mixed-separators',
      file: 'record.json',
      body: `{"href":"C:\\/Users/${NEUTRAL_ACCOUNT}/ws"}\n`,
      encoding: 'mixed backslash and forward slash',
    },
  ]) {
    await t.test(fixture.encoding, async () => {
      const leakingPayload = path.join(fixtureRoot, fixture.directory)
      await mkdir(leakingPayload, { recursive: true })
      await writeFile(path.join(leakingPayload, fixture.file), fixture.body)

      const result = run(gate, leakingPayload)

      assert.equal(
        result.status,
        1,
        `a profile path written as ${fixture.encoding} did not fail the guard.\n${output(result)}`,
      )
      assert.doesNotMatch(
        result.stdout,
        /Total matches: 0\./,
        `the guard scanned the ${fixture.encoding} payload and reported nothing found`,
      )
    })
  }

  /* NEGATIVE CONTROL. Without this, every assertion above is also satisfied by a
     rule that refuses any file at all, and the fix for this test would be to fail
     on everything -- which passes the gate by making it useless. */
  await t.test('a payload with no profile path still passes', () => {
    const result = run(gate, cleanPayload)
    assert.equal(result.status, 0, output(result))
    assert.match(result.stdout, /Total matches: 0\./)
  })
})

// CF31: a fresh worktree/checkout has no private/owner-data-patterns.owner.json.
// That is expected -- the file is owner-provided local data, never generated or
// committed -- but the refusal it produces has to be actionable: a single named
// code an operator (or a caller like tools/pack-capability-layer.mjs) can match
// on, the exact path the file is expected at, and one sentence saying the file
// is owner-provided and must be copied in from wherever the owner keeps it.
//
// These two tests run check-no-owner-data.mjs in a throwaway temp directory that
// deliberately has no private/ directory at all, so neither test can touch, read,
// or depend on any real private/*.owner.json anywhere on this machine.
test('check-no-owner-data refuses with a named, actionable code when the owner-data-patterns file is absent', async () => {
  const missingProfileRoot = await mkdtemp(path.join(os.tmpdir(), 'check-no-owner-data-missing-profile-'))
  try {
    const localGate = path.join(missingProfileRoot, 'tools', 'check-no-owner-data.mjs')
    await mkdir(path.dirname(localGate), { recursive: true })
    await cp(SOURCE_GATE, localGate)
    const payload = path.join(missingProfileRoot, 'payload')
    await mkdir(payload)
    await writeFile(path.join(payload, 'artifact.txt'), 'ordinary packaged bytes\n')

    const before = await readdir(missingProfileRoot, { recursive: true })

    const result = spawnSync(process.execPath, [localGate, payload], {
      cwd: missingProfileRoot,
      encoding: 'utf8',
      env: { ...process.env, MC_IDENTITY_PROFILE_ACCOUNT: ACCOUNT },
    })

    assert.equal(result.status, 2, output(result))
    assert.match(
      result.stderr,
      /OWNER_DATA_PATTERNS_MISSING/,
      'the refusal must carry a single named, greppable code',
    )
    assert.match(
      result.stderr,
      /Expected path \(relative to the repository root\): private\/owner-data-patterns\.owner\.json/,
      'the refusal must name the exact expected path relative to the worktree root',
    )
    assert.match(
      result.stderr,
      /owner-provided.*must be copied in from wherever the owner keeps/s,
      'the refusal must tell the operator, in one sentence, that this is owner data to be copied in -- not generated',
    )
    // Must not name a real owner path/account -- only the generic instruction.
    assert.doesNotMatch(result.stderr, /[A-Za-z]:\\Users\\/)

    const after = await readdir(missingProfileRoot, { recursive: true })
    assert.deepEqual(after, before, 'a setup refusal must not write any output artefact')
  } finally {
    await rm(missingProfileRoot, { recursive: true, force: true })
  }
})

test('check-no-owner-data proceeds past the setup check with a synthetic minimal patterns file', async () => {
  const minimalProfileRoot = await mkdtemp(path.join(os.tmpdir(), 'check-no-owner-data-minimal-profile-'))
  try {
    const localGate = path.join(minimalProfileRoot, 'tools', 'check-no-owner-data.mjs')
    await mkdir(path.dirname(localGate), { recursive: true })
    await cp(SOURCE_GATE, localGate)
    await mkdir(path.join(minimalProfileRoot, 'private'), { recursive: true })
    // Shaped from loadIdentityPatterns()'s own parser, not from any real owner
    // file: a "patterns" array whose entries are the plain strings it accepts.
    await writeFile(
      path.join(minimalProfileRoot, 'private', 'owner-data-patterns.owner.json'),
      `${JSON.stringify({ patterns: [ACCOUNT] })}\n`,
    )
    const payload = path.join(minimalProfileRoot, 'payload')
    await mkdir(payload)
    await writeFile(path.join(payload, 'artifact.txt'), 'ordinary packaged bytes\n')

    const result = spawnSync(process.execPath, [localGate, payload], {
      cwd: minimalProfileRoot,
      encoding: 'utf8',
      env: { ...process.env, MC_IDENTITY_PROFILE_ACCOUNT: ACCOUNT },
    })

    assert.equal(result.status, 0, output(result))
    assert.match(result.stdout, /Total matches: 0\./)
  } finally {
    await rm(minimalProfileRoot, { recursive: true, force: true })
  }
})

test('check-no-owner-data rejects retired product and provider metadata independently of the builder profile', async (t) => {
  for (const fixture of [
    { directory: 'payload-cross-product', body: `${JSON.stringify({ project: RETIRED_CROSS_PRODUCT_MARKER })}\n`, pattern: 'retired cross-product metadata' },
    { directory: 'payload-cross-product-spaced', body: `${JSON.stringify({ project: RETIRED_CROSS_PRODUCT_SPACED_MARKER })}\n`, pattern: 'retired cross-product metadata' },
    { directory: 'payload-cross-product-hyphen', body: `${JSON.stringify({ project: RETIRED_CROSS_PRODUCT_HYPHEN_MARKER })}\n`, pattern: 'retired cross-product metadata' },
    { directory: 'payload-foreign-provider', body: `${JSON.stringify({ provider: RETIRED_PROVIDER_MARKER.toLowerCase() })}\n`, pattern: 'retired provider metadata' },
    { directory: 'payload-foreign-provider-spaced', body: `${JSON.stringify({ provider: RETIRED_PROVIDER_SPACED_MARKER.toLowerCase() })}\n`, pattern: 'retired provider metadata' },
    { directory: 'payload-foreign-provider-hyphen', body: `${JSON.stringify({ provider: RETIRED_PROVIDER_HYPHEN_MARKER.toLowerCase() })}\n`, pattern: 'retired provider metadata' },
    { directory: 'payload-owner-mirror-default', body: `${JSON.stringify({ repository: OWNER_MIRROR_DEFAULT_MARKER })}\n`, pattern: 'owner mirror default' },
    { directory: 'payload-owner-github-handle', body: `${JSON.stringify({ owner: OWNER_GITHUB_HANDLE_MARKER })}\n`, pattern: 'owner GitHub handle' },
  ]) {
    await t.test(fixture.directory, async () => {
      const leakingPayload = path.join(fixtureRoot, fixture.directory)
      await mkdir(leakingPayload)
      await writeFile(path.join(leakingPayload, 'customer-config.json'), fixture.body)

      const result = run(gate, leakingPayload)

      assert.equal(result.status, 1, output(result))
      // Built-in rules are product facts and keep their label, prefixed by class and index.
      const escaped = fixture.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      assert.match(result.stdout, new RegExp(`pattern=builtin#\\d+\\(${escaped}\\) \\| matches=`))
      assert.match(result.stdout, /Total matches: 1\./)
    })
  }
})

test('check-no-owner-data catches a builder\'s own retired names listed in the profile, and never excuses them', async (t) => {
  const repo = await gateRepository(t, { patterns: [ACCOUNT, ...RETIRED_NAMES] })
  await writeFile(path.join(repo.payload, 'customer-config.json'),
    `${JSON.stringify({ project: RETIRED_NAMES[0], repository: RETIRED_NAMES[1], owner: RETIRED_NAMES[2].toUpperCase() })}\n`)
  const result = repo.scan()
  assert.equal(result.status, 1, output(result))
  assert.match(result.stdout, /Total matches: 3\./)
  for (const index of [2, 3, 4]) assert.match(result.stdout, new RegExp(`pattern=profile#${index} \\| matches=1`))
})

test('check-no-owner-data keeps the profile-filled built-in slots, numbered and at zero, when the profile fills none', async (t) => {
  const repo = await gateRepository(t)
  await writeFile(path.join(repo.payload, 'customer-config.json'),
    `${JSON.stringify({ provider: RETIRED_PROVIDER_MARKER, project: RETIRED_CROSS_PRODUCT_MARKER, owner: OWNER_GITHUB_HANDLE_MARKER })}\n`)
  const result = repo.scan()
  assert.equal(result.status, 1, output(result))
  assert.match(result.stdout, /Total matches: 1\./)
  assert.match(result.stdout, /pattern=builtin#17\(retired provider metadata\) \| matches=1/)
  const perPattern = /^Per-pattern matches: (.*)$/m.exec(result.stdout)?.[1] || ''
  for (const slot of ['builtin#14(retired cross-product metadata)=0', 'builtin#15(retired cross-product metadata)=0',
    'builtin#16(retired cross-product metadata)=0', 'builtin#20(owner mirror default)=0', 'builtin#21(owner GitHub handle)=0',
    'builtin#22(toolsenabled\u002Dcurrent)=0']) assert.ok(perPattern.includes(slot), `${slot} in: ${perPattern}`)
})

test('check-no-owner-data refuses a builtInMarkers object it cannot use, without printing what it holds', async (t) => {
  for (const [name, builtInMarkers, message] of [
    ['unknown label', { 'sample-unknown-rule': [OWNER_MIRROR_DEFAULT_MARKER] }, /key 1 is not the label of a profile-filled built-in rule/],
    ['too many values', { 'owner mirror default': [OWNER_MIRROR_DEFAULT_MARKER, RETIRED_NAMES[1]] }, /lists 2 values for a rule with 1 slot/],
    ['blank value', { 'owner GitHub handle': [' '] }, /must hold a non-empty string or a non-empty array of them/],
    ['not an object', [OWNER_GITHUB_HANDLE_MARKER], /must be an object keyed by built-in rule label/],
  ]) {
    await t.test(name, async (t) => {
      const repo = await gateRepository(t)
      await writeFile(path.join(repo.root, 'private', 'owner-data-patterns.owner.json'), `${JSON.stringify({ patterns: [ACCOUNT], builtInMarkers })}\n`)
      await writeFile(path.join(repo.payload, 'artifact.txt'), 'ordinary packaged bytes\n')
      const result = repo.scan()
      assert.equal(result.status, 2, output(result))
      assert.match(result.stderr, message)
      for (const value of [OWNER_MIRROR_DEFAULT_MARKER, OWNER_GITHUB_HANDLE_MARKER, RETIRED_NAMES[1], 'sample-unknown-rule']) {
        assert.ok(!output(result).includes(value), `the refusal printed a profile value or key: ${output(result)}`)
      }
    })
  }
})

/* A gate copy in its own fixture repository, with its own identity profile and,
   optionally, a pinned Electron distribution (node_modules/electron/dist) beside
   it -- the layout the build checkout has. */
async function gateRepository(t, { patterns = [ACCOUNT], electronDist = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'check-no-owner-data-repo-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const localGate = path.join(root, 'tools', 'check-no-owner-data.mjs')
  await mkdir(path.dirname(localGate), { recursive: true })
  await cp(SOURCE_GATE, localGate)
  await mkdir(path.join(root, 'private'), { recursive: true })
  await writeFile(path.join(root, 'private', 'owner-data-patterns.owner.json'), `${JSON.stringify({ patterns })}\n`)
  if (electronDist) {
    const dist = path.join(root, 'node_modules', 'electron', 'dist')
    await mkdir(dist, { recursive: true })
    for (const [name, body] of Object.entries(electronDist)) await writeFile(path.join(dist, name), body)
  }
  const payload = path.join(root, 'payload')
  await mkdir(payload)
  const scan = () => spawnSync(process.execPath, [localGate, payload], {
    cwd: root, encoding: 'utf8', env: { ...process.env, MC_IDENTITY_PROFILE_ACCOUNT: ACCOUNT },
  })
  return { root, payload, scan }
}

/* c5: THE SHAPE RULES MET CHROMIUM'S OWN FILES. The seven shape
   rules were measured over the source trees, never over the packaged runtime.
   On the built installer tree they found 70 hits in LICENSES.chromium.html --
   the public addresses and pages of third-party licence authors, copied
   byte-for-byte from the pinned Electron distribution -- so `npm run dist`,
   `dist:linux` and the release cutter all went red on bytes nobody here wrote. */
test('check-no-owner-data: a file byte-identical to the pinned Electron distribution is not held to the shape rules', async (t) => {
  const licences = `Copyright (c) 1999 A. Author <author@${CAMPUS}> https://www.${CAMPUS}/~author\n`
  const repo = await gateRepository(t, { electronDist: { 'LICENSES.chromium.html': licences } })
  await mkdir(path.join(repo.payload, 'linux-unpacked'))
  await writeFile(path.join(repo.payload, 'linux-unpacked', 'LICENSES.chromium.html'), licences)
  const result = repo.scan()
  assert.equal(result.status, 0, output(result))
  assert.match(result.stdout, /Total matches: 0\./)
  assert.match(result.stdout, /Excused as a stock Electron runtime file: 2 /)
})

test('check-no-owner-data: the Electron exemption is exact -- a changed copy is scanned, and the profile still applies', async (t) => {
  const licences = `Copyright (c) 1999 A. Author <author@${CAMPUS}> ${ACCOUNT}\n`
  const repo = await gateRepository(t, { electronDist: { 'LICENSES.chromium.html': licences } })
  await writeFile(path.join(repo.payload, 'LICENSES.chromium.html'), licences)
  await writeFile(path.join(repo.payload, 'LICENSES.edited.html'), licences.replace('1999', '2026'))
  const result = repo.scan()
  assert.equal(result.status, 1, output(result))
  // The identical copy: its mailbox is excused, the builder's own name is not.
  // The edited copy: both count. 1 + 2.
  assert.match(result.stdout, /Total matches: 3\./)
  assert.match(result.stdout, /Excused as a stock Electron runtime file: 1 /)
})

test('check-no-owner-data: with no pinned Electron distribution nothing is excused', async (t) => {
  const repo = await gateRepository(t)
  await writeFile(path.join(repo.payload, 'LICENSES.chromium.html'), `Copyright (c) 1999 A. Author <author@${CAMPUS}>\n`)
  const result = repo.scan()
  assert.equal(result.status, 1, output(result))
  assert.match(result.stdout, /Total matches: 1\./)
})

/* c5 review: ONE VALUE, TWO RULES. "Total matches: N" is parsed into the
   release declaration, so a value two rules both cover must count once. */
test('check-no-owner-data counts a build hostname once when a shape rule and the profile both cover it', async (t) => {
  const repo = await gateRepository(t, { patterns: [ACCOUNT, HOSTNAME] })
  await writeFile(path.join(repo.payload, 'build.txt'), `built on ${HOSTNAME.toUpperCase()}\n`)
  const result = repo.scan()
  assert.equal(result.status, 1, output(result))
  assert.match(result.stdout, /Total matches: 1\./, 'THE DEFECT: one hostname was counted by two rules')
})

test('check-no-owner-data counts a campus mailbox organisation name once', async (t) => {
  const repo = await gateRepository(t)
  await writeFile(path.join(repo.payload, 'org.json'), `${JSON.stringify({ org: `someone@${CAMPUS}'s Organization` })}\n`)
  await writeFile(path.join(repo.payload, 'org2.json'), `${JSON.stringify({ org: `someone@${MAIL_CO}'s Organization` })}\n`)
  const result = repo.scan()
  assert.equal(result.status, 1, output(result))
  assert.match(result.stdout, /Total matches: 2\./, 'THE DEFECT: one organisation name was counted by two rules')
  assert.match(result.stdout, /org2\.json \| pattern=builtin#\d+\(organisation name derived from a mailbox\) \| matches=1/)
})
