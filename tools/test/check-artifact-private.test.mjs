/* The cut gate for owner ruling R1191, asserted by running it.
 *
 * Run: node --test tools/test/check-artifact-private.test.mjs
 *
 * Every case here builds a real directory and invokes the real step, so what is
 * pinned is BEHAVIOUR -- "does this artefact ship" -- and not the spelling of a
 * pattern. A test that asserted the regex source would pass against a rule that
 * matches nothing, and would fail against a better rule.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const STEP = path.join(REPO_ROOT, 'tools', 'check-artifact-private.mjs')

/* A syntactically valid machine SID that belongs to no real machine. The gate
   must not need a real one to be tested, and a test fixture is the last place a
   real identifier should live. */
const FIXTURE_SID = 'S-1-5-21-111111111-222222222-333333333-1001'

let fixtureRoot

before(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'check-artifact-private-'))
})

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
})

function run(...arguments_) {
  return spawnSync(process.execPath, [STEP, ...arguments_], { cwd: REPO_ROOT, encoding: 'utf8' })
}

function output(result) {
  return `${result.stdout}${result.stderr}`
}

async function artefact(name, files) {
  const root = path.join(fixtureRoot, name)
  for (const [relative, body] of Object.entries(files)) {
    const full = path.join(root, relative)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, body)
  }
  return root
}

/* NEGATIVE CONTROL, and it comes first on purpose. Without it every refusal
   below is also satisfied by a step that refuses everything -- which is the
   cheapest way to make this file green and the most useless gate to ship. */
test('a clean artefact passes and says what it scanned', async () => {
  const root = await artefact('clean', {
    'resources/app/index.js': 'module.exports = 1\n',
    'resources/capability/tools/secrets.ps1': '# the vault SCRIPT ships; the vault CONTENTS do not\n',
    'resources/capability/src/lib/secret-patterns.js': 'export const patterns = []\n',
  })

  const result = run(root)

  assert.equal(result.status, 0, output(result))
  assert.match(result.stdout, /clean: 3 files/)
})

test('saved Metrics histories and account preferences cannot enter an installer payload', async t => {
  for (const name of ['renderer-prefs.json', 'agent-spawn-key.enc', 'agent-spawn-records.jsonl', 'agent-turn-usage-records.jsonl',
    'product-accounts.json', 'hosted-product-accounts.json', 'product-session.enc', `accounts/${'a'.repeat(32)}.json`]) {
    await t.test(name, async () => {
      const root = await artefact(`metrics-${name.replaceAll('/', '-')}`, { [`resources/app/${name}`]: '{"private":"metrics-install-test"}' })
      const result = run(root)
      assert.notEqual(result.status, 0, output(result))
      assert.match(output(result), /named |saved account data/)
    })
  }
  const clean = await artefact('metrics-source', {
    'shell/metrics-record-query.cjs': 'module.exports = {}',
    'dist/durable-storage.js': '/* account storage implementation */',
    'dist/data/metrics.json': '{"example":true}',
  })
  assert.equal(run(clean).status, 0, 'the product implementation and built-in examples still ship')
})

/* THE VAULT SCRIPT MUST KEEP SHIPPING. This is the case that makes the gate
   satisfiable, and it is asserted separately because it is the one a stricter
   "any filename containing secret" rule would break -- turning the gate into
   something that has to be overridden, after which it checks nothing. */
test('the shipped vault script and secret-pattern module are not treated as secrets', async () => {
  const root = await artefact('vault-script', {
    'resources/capability/tools/secrets.ps1': '# ships on purpose\n',
    'resources/capability/src/lib/secret-patterns.js': 'export const patterns = []\n',
  })

  const result = run(root)

  assert.equal(result.status, 0, output(result))
})

test('a credential container is refused, by shape rather than by exact name', async (t) => {
  for (const fixture of [
    { name: 'dotenv', file: 'resources/.env', reason: /dotenv file|named \.env/ },
    { name: 'dotenv-suffixed', file: 'resources/.env.production', reason: /dotenv file/ },
    { name: 'private-key', file: 'resources/app/server.key', reason: /\.key file/ },
    { name: 'certificate', file: 'resources/app/server.pem', reason: /\.pem file/ },
    { name: 'ssh-key', file: 'resources/app/id_rsa', reason: /private SSH key|named id_rsa/ },
    { name: 'ssh-key-backup', file: 'resources/app/id_ed25519.bak', reason: /private SSH key/ },
    { name: 'keystore', file: 'resources/app/keystore.jks', reason: /keystore/ },
    { name: 'vault-contents', file: 'resources/app/secrets.json', reason: /named secrets\.json/ },
  ]) {
    await t.test(fixture.name, async () => {
      const root = await artefact(`container-${fixture.name}`, {
        'resources/app/index.js': 'module.exports = 1\n',
        [fixture.file]: 'placeholder; no real credential value is used in a fixture\n',
      })

      const result = run(root)

      assert.equal(result.status, 1, `${fixture.file} was allowed into the artefact.\n${output(result)}`)
      assert.match(result.stderr, /REFUSING/)
      assert.match(result.stderr, fixture.reason)
    })
  }
})

test('a machine SID is refused, and the gate does not print it', async () => {
  const root = await artefact('sid', {
    'resources/app/index.js': 'module.exports = 1\n',
    'resources/app/task.xml': `<Principal><UserId>${FIXTURE_SID}</UserId></Principal>\n`,
  })

  const result = run(root)

  assert.equal(result.status, 1, output(result))
  assert.match(result.stderr, /machine SID/)
  assert.match(result.stderr, /resources\/app\/task\.xml/)
  /* The whole point of reporting by file and count: a guard that echoes the
     identifier has moved it into the build log rather than kept it out. */
  assert.doesNotMatch(output(result), new RegExp(FIXTURE_SID), 'the gate printed the SID it is meant to keep out')
})

test('a SID stored as UTF-16 is found too', async () => {
  const root = await artefact('sid-wide', { 'resources/app/index.js': 'module.exports = 1\n' })
  await writeFile(path.join(root, 'resources', 'app', 'version.bin'), Buffer.from(FIXTURE_SID, 'utf16le'))

  const result = run(root)

  assert.equal(result.status, 1, `a UTF-16 SID was invisible to the gate.\n${output(result)}`)
  assert.match(result.stderr, /machine SID/)
})

/* Well-known SIDs are identical on every Windows machine and identify nobody.
   Refusing them would make the gate fire on ordinary manifests, and a gate that
   fires on ordinary content is a gate that gets switched off. */
test('well-known Windows SIDs are not treated as machine identity', async () => {
  const root = await artefact('sid-wellknown', {
    'resources/app/acl.xml': '<Sid>S-1-5-18</Sid><Sid>S-1-5-32-544</Sid>\n',
  })

  const result = run(root)

  assert.equal(result.status, 0, output(result))
})

/* Owner ruling R1191 names "secrets". The WORD is deliberately not matched as a
   substring -- that would refuse tools/secrets.ps1, the file the packer exists to
   ship -- but a file named exactly `secrets` with no extension is not a program,
   it is a store, and it must not ship. This is the narrow half of that ruling. */
test('an extensionless file named exactly "secrets" is refused', async () => {
  const root = await artefact('bare-secrets', {
    'resources/app/index.js': 'module.exports = 1\n',
    'resources/app/secrets': 'placeholder; no real credential value is used in a fixture\n',
  })

  const result = run(root)

  assert.equal(result.status, 1, output(result))
  assert.match(result.stderr, /named secrets/)
})

/* The companion assertion to the one above, and the reason the substring rule was
   rejected: the vault SCRIPT keeps shipping. If this ever goes red, the gate has
   become unsatisfiable and will be switched off rather than fixed. */
test('the vault script still ships alongside the bare-name rule', async () => {
  const root = await artefact('secrets-script-still-ships', {
    'resources/capability/tools/secrets.ps1': '# ships on purpose\n',
    'resources/capability/src/lib/secret-patterns.js': 'export const patterns = []\n',
  })

  assert.equal(run(root).status, 0)
})

/* The exact-SID check is a redundancy over the shape rule, so what must be
   asserted is not that it fires -- the shape rule fires first -- but that the
   step SAYS which checks ran. A degradation nobody can see is a silent skip. */
test('the step states whether the exact-SID check ran, and never prints the value', async () => {
  const root = await artefact('sid-reporting', { 'resources/app/index.js': 'module.exports = 1\n' })

  const result = run(root)

  assert.equal(result.status, 0, output(result))
  /* T330: asserted by BEHAVIOUR rather than by the sentence the step happens to
     print. The previous form matched one of two exact wordings, so it pinned a
     spelling -- and it pinned the wording of a degradation that has since become
     a refusal, which means it would have failed against the better behaviour and
     the quickest way back to green would have been to reinstate the defect.
     What actually has to hold is: the step names the machine-SID checks, and it
     says whether the exact-value one ran -- in either direction. */
  const sidLine = result.stdout.split('\n').find((line) => line.includes('machine SID:'))
  assert.ok(sidLine, `the step did not report on the machine-SID checks at all.\n${output(result)}`)
  assert.match(sidLine, /shape rule/, 'the step did not say the shape rule ran')
  assert.ok(
    /own SID/.test(sidLine) || /does not apply/.test(sidLine),
    `the step did not say whether the exact-value SID check ran: ${sidLine}`,
  )
  /* Whatever it read, it must not echo an S-1-5-21 value into the build log. */
  assert.doesNotMatch(output(result), /S-1-5-21-\d/, 'the step printed a machine SID into its own output')
})

/* OWNER RULING R1180: the cut removes the owner's run records; live keeps them.
 *
 * The four records and the probe are asserted BY THE NAMES THE RULING GIVES, one
 * planted file per class, because a rule that only matches a pattern I invented
 * would pass while the actual named files shipped. */
test('the owner run records named in R1180 are refused if they reach the artefact', async (t) => {
  for (const fixture of [
    { name: 'pre-fix-capture', file: 'resources/app/captures-w16e/pre-fix/capture.log', reason: /capture\/evaluation run records/ },
    { name: 'post-fix-capture', file: 'resources/app/captures-w16e/post-fix/capture.log', reason: /capture\/evaluation run records/ },
    { name: 'pre-fix-results', file: 'resources/app/captures-w16e/pre-fix/results.json', reason: /capture\/evaluation run records/ },
    { name: 'cardroom-evidence', file: 'resources/app/evidence/w16d-cardroom.json', reason: /evidence dump/ },
    { name: 'probe-with-pins', file: 'resources/app/tools/w16e-card-lines-check.mjs', reason: /development probe/ },
  ]) {
    await t.test(fixture.name, async () => {
      const root = await artefact(`r1180-${fixture.name}`, {
        'resources/app/index.js': 'module.exports = 1\n',
        [fixture.file]: 'owner run record placeholder\n',
      })

      const result = run(root)

      assert.equal(result.status, 1, `${fixture.file} was allowed into the artefact.\n${output(result)}`)
      assert.match(result.stderr, /R1180/)
      assert.match(result.stderr, fixture.reason)
    })
  }
})

/* POSITIVE CONTROL ON A FILE THAT IS PRESENT. "Zero matches" is only evidence if
   the walk actually saw the tree. This asserts the count the step reports is the
   real file count, so a zero produced by walking nothing cannot pass for a clean
   artefact -- the failure mode this codebase keeps re-finding. */
test('the R1180 zero is reported against a tree the step demonstrably walked', async () => {
  const root = await artefact('r1180-control', {
    'resources/app/index.js': 'module.exports = 1\n',
    'resources/app/lib/ordinary.js': 'module.exports = 2\n',
    'resources/capability/tools/secrets.ps1': '# ships on purpose\n',
  })

  const result = run(root)

  assert.equal(result.status, 0, output(result))
  assert.match(result.stdout, /owner run records \(R1180\): 0 of 3 files match/)
  assert.match(result.stdout, /scanning 3 files/)
})

/* A legitimate file whose name merely contains one of the words must still ship:
   the patterns are anchored on path segments, not substrings, for the same reason
   the "secrets" word is not matched. */
test('an ordinary file that merely contains the word evidence still ships', async () => {
  const root = await artefact('r1180-no-overmatch', {
    'resources/app/lib/evidence-formatter.js': 'module.exports = 1\n',
    'resources/app/lib/captures-helper.js': 'module.exports = 2\n',
  })

  assert.equal(run(root).status, 0, output(run(root)))
})

/* THE DEPTH HOLE. The directory rules used to be prefix-anchored, so they only saw
   these names at the root of the scanned tree. In a built artefact a credential
   directory sits several segments down -- inside app.asar.unpacked, inside a
   package -- which is exactly where it would hide. Each fixture below is nested,
   because a root-level fixture passes against the very bug this closes. */
test('a credential directory is refused at any depth, not only at the scanned root', async (t) => {
  for (const fixture of [
    { name: 'vault-inside-asar-unpacked', file: 'resources/app.asar.unpacked/some-pkg/vault/blob.bin', segment: /vault\/ directory/ },
    { name: 'state-deep', file: 'resources/app.asar.unpacked/a/b/c/state/session.dat', segment: /state\/ directory/ },
    { name: 'private-deep', file: 'resources/app/lib/private/owner.json', segment: /private\/ directory/ },
    { name: 'logs-deep', file: 'resources/app/vendor/pkg/logs/run.txt', segment: /logs\/ directory/ },
    { name: 'reports-deep', file: 'resources/app/x/reports/summary.txt', segment: /reports\/ directory/ },
    { name: 'dotgit-deep', file: 'resources/app/vendor/pkg/.git/config', segment: /\.git\/ directory/ },
  ]) {
    await t.test(fixture.name, async () => {
      const root = await artefact(`depth-${fixture.name}`, {
        'resources/app/index.js': 'module.exports = 1\n',
        [fixture.file]: 'placeholder; no real credential value is used in a fixture\n',
      })

      const result = run(root)

      assert.equal(result.status, 1, `${fixture.file} was allowed into the artefact.\n${output(result)}`)
      assert.match(result.stderr, fixture.segment, 'the refusal did not name the offending segment')
    })
  }
})

/* WHOLE SEGMENTS ONLY. Without this the fix trades a false negative for a false
   positive, and a gate that fires on ordinary product files gets switched off. */
test('names that merely contain a store word are not treated as directories', async () => {
  const root = await artefact('depth-no-overmatch', {
    'resources/app/lib/state-machine.js': 'module.exports = 1\n',
    'resources/app/lib/fleet-supervisor/state.js': 'module.exports = 2\n',
    'resources/app/lib/restore/index.js': 'module.exports = 3\n',
    'resources/app/lib/vaulting-helper.js': 'module.exports = 4\n',
    'resources/app/private-notes.md': 'not a private/ directory\n',
  })

  const result = run(root)

  assert.equal(result.status, 0, output(result))
})

/* A SID INSIDE A JSON STRING, asserted because it was asked for -- and reported
   honestly for what it is. MEASURED: JSON.stringify leaves a SID BYTE-IDENTICAL,
   because a SID contains no backslash, quote or control character for JSON to
   escape. So this control CONFIRMS the existing rule rather than covering a new
   encoding, unlike the profile path where JSON escaping genuinely defeats a naive
   matcher. It is kept because it is cheap and because it pins the claim: if anyone
   later makes the SID rule encoding-sensitive, this goes red. Calling it new
   coverage would be coverage theatre. */
test('a SID inside a JSON string refuses (same bytes as raw -- a confirmation, not new coverage)', async () => {
  const root = await artefact('sid-json', {
    'resources/app/index.js': 'module.exports = 1\n',
    'resources/app/task.json': `${JSON.stringify({ Principal: { UserId: FIXTURE_SID } })}\n`,
  })

  const result = run(root)

  assert.equal(result.status, 1, output(result))
  assert.match(result.stderr, /machine SID/)
  assert.doesNotMatch(output(result), new RegExp(FIXTURE_SID), 'the gate printed the SID it is meant to keep out')
})

/* Every refusal must name its rule class, because the three classes have three
   different remedies: a container is removed from the build, a run record is
   excluded by the cut, and a machine SID means something is embedding build-host
   identity and the fix is upstream of packaging. A path with no class leaves the
   reader to open the file and guess. */
test('each refusal names the rule class that fired', async (t) => {
  for (const fixture of [
    { name: 'container', file: 'resources/app/server.key', tag: /\[container-shape\]/ },
    { name: 'run record', file: 'resources/app/evidence/w16d-cardroom.json', tag: /\[owner-run-record\]/ },
  ]) {
    await t.test(fixture.name, async () => {
      const root = await artefact(`class-${fixture.name.replace(/\s/g, '-')}`, {
        'resources/app/index.js': 'module.exports = 1\n',
        [fixture.file]: 'placeholder\n',
      })
      const result = run(root)
      assert.equal(result.status, 1, output(result))
      assert.match(result.stderr, fixture.tag)
    })
  }

  await t.test('machine SID', async () => {
    const root = await artefact('class-sid', {
      'resources/app/index.js': 'module.exports = 1\n',
      'resources/app/acl.txt': `${FIXTURE_SID}\n`,
    })
    const result = run(root)
    assert.equal(result.status, 1, output(result))
    assert.match(result.stderr, /\[machine-sid\]/)
    /* Naming the class must not become a way of leaking the value. */
    assert.doesNotMatch(output(result), new RegExp(FIXTURE_SID))
  })
})

/* THE TOOLING REPO IS NOT IN THE INSTALLER — asserted as a PLANTED ABSENCE.
 *
 * Lane A3 measured 34 lines carrying the literal fence path C:\Users\ToolsEnabled-Dev
 * across nine tooling files (27 in qualification-automation/, 7 in live/test/).
 * Those literals are correct where they live -- ACCOUNT-FENCE.md mandates the fence
 * and the person's R1179 keeps them hardcoded, and one of the files runs under a
 * live scheduled task -- so the requirement is not to rewrite them but to prove
 * they never reach a customer.
 *
 * "Absent" is only evidence if the walk happened, which is the same discipline as
 * the R1180 control: the step prints the count it checked against, and this test
 * asserts that count is the real file count. Nine absent from a walk of zero files
 * would be a vacuous pass. */
const TOOLING_FENCE_FILES = [
  'qualification-automation/Invoke-AutomaticPreflight.ps1',
  'qualification-automation/Install-AutomaticPreflight.ps1',
  'qualification-automation/LIVE-DELIVERY-CHECKPOINT.md',
  'qualification-automation/Test-AutomaticPreflight.ps1',
  'qualification-automation/Test-InstallAutomaticPreflight.ps1',
  'qualification-automation/README.md',
  'qualification-automation/PRIVATE-UI-OWNERSHIP-NEXT.md',
  'live/test/resume-circle.test.mjs',
  'live/test/auto-live-ui-ownership.test.mjs',
]

test('the nine tooling fence-literal files are absent from a walk that saw files', async () => {
  const root = await artefact('tooling-absent', {
    'resources/app/index.js': 'module.exports = 1\n',
    'resources/app/lib/ordinary.js': 'module.exports = 2\n',
    'resources/capability/tools/secrets.ps1': '# ships on purpose\n',
  })

  const result = run(root)

  assert.equal(result.status, 0, output(result))
  assert.match(
    result.stdout,
    new RegExp(`tooling repo: 0 of ${TOOLING_FENCE_FILES.length} fence-literal files present, across 3 walked files`),
    'the step must report the absence against the real walked count, not in the abstract',
  )
})

test('any one of the nine tooling files reaching the artefact is refused by name', async (t) => {
  for (const relative of TOOLING_FENCE_FILES) {
    await t.test(relative, async () => {
      const root = await artefact(`tooling-${relative.replace(/[\\/.]/g, '-')}`, {
        'resources/app/index.js': 'module.exports = 1\n',
        /* Under a prefix, because that is how it would actually appear if the
           tooling repo were ever packaged into resources. */
        [`resources/app/${relative}`]: 'placeholder; the real file hardcodes the fence path on purpose\n',
      })

      const result = run(root)

      assert.equal(result.status, 1, `${relative} was allowed into the artefact.\n${output(result)}`)
      assert.match(result.stderr, /\[tooling-not-shipped\]/)
      assert.match(result.stderr, new RegExp(relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    })
  }
})

test('an absent or empty artefact is refused rather than reported clean', async (t) => {
  await t.test('missing directory', () => {
    const result = run(path.join(fixtureRoot, 'not-built'))
    assert.equal(result.status, 1, output(result))
    assert.match(result.stderr, /directory does not exist/)
  })

  await t.test('empty directory', async () => {
    const root = path.join(fixtureRoot, 'empty')
    await mkdir(root, { recursive: true })
    const result = run(root)
    assert.equal(result.status, 1, output(result))
    assert.match(result.stderr, /scanned 0 files/)
  })

  await t.test('no directory named at all', () => {
    const result = run()
    assert.equal(result.status, 1, output(result))
    assert.match(result.stderr, /name the artefact directory/)
  })
})

/* T330: A DEGRADED CHECK THAT STILL PRINTS "clean" IS THE DEFECT.
 *
 * MEASURED on the 1.0.45 Windows cut of app a4d37a5d: `whoami` resolved to Git
 * for Windows' POSIX copy first, which has no /user switch, so the call threw,
 * the catch returned null, and the step fell back to the shape rule and still
 * exited 0 "clean". The step was fixed (whoami.exe by absolute path inside the
 * system directory, and an unreadable value is a refusal) and NOTHING PINNED
 * THAT, so the silent fallback could come back unseen in one edit. These cases
 * are that pin.
 *
 * The degraded host is simulated by pointing SystemRoot and windir at a
 * directory that holds no whoami.exe, which is the same observable state as a
 * host where the binary cannot be reached -- and it is the only way to reach the
 * branch without breaking the machine the suite runs on. Windows only: off
 * Windows there is no machine SID and "does not apply" is correctly a pass, which
 * the Linux cut depends on. */
const windowsOnly = { skip: process.platform !== 'win32' ? 'the Windows machine SID does not exist here' : false }

/* Windows environment names are case-insensitive and this process received
   them UPPERCASED, so adding a `SystemRoot` key leaves the original SYSTEMROOT
   beside it and the child still reads the real system directory -- measured,
   and it made the first version of these cases pass over a gate that had not
   been degraded at all. Every spelling is removed before the stand-in is set. */
function runWithSystemDirectory(directory, ...arguments_) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) if (/^(systemroot|windir)$/i.test(key)) delete environment[key]
  environment.SystemRoot = directory
  environment.windir = directory
  return spawnSync(process.execPath, [STEP, ...arguments_], { cwd: REPO_ROOT, encoding: 'utf8', env: environment })
}

test('a machine SID that could not be read REFUSES instead of reporting clean', windowsOnly, async () => {
  const noWhoami = path.join(fixtureRoot, 'no-system-directory')
  await mkdir(noWhoami, { recursive: true })
  const root = await artefact('sid-unreadable', { 'resources/app/index.js': 'module.exports = 1\n' })

  const result = runWithSystemDirectory(noWhoami, root)

  assert.equal(result.status, 1, output(result))
  assert.match(result.stderr, /\[machine-sid-unreadable\]/)
  assert.match(result.stderr, /UNCHECKED/)
  assert.doesNotMatch(result.stdout, /clean: \d+ files/)
})

test('the refusal says what it tried, so the fix is on the build host and not in this file', windowsOnly, async () => {
  const noWhoami = path.join(fixtureRoot, 'no-system-directory-2')
  await mkdir(noWhoami, { recursive: true })
  const root = await artefact('sid-unreadable-detail', { 'resources/app/index.js': 'module.exports = 1\n' })

  const result = runWithSystemDirectory(noWhoami, root)

  assert.match(result.stderr, /not present/)
  assert.match(result.stderr, /whoami\.exe/)
  /* The shape rule's result is still reported for what it is worth: losing it
     would leave the reader with no evidence at all. */
  assert.match(result.stderr, /shape rule did run/)
})

test('a SID that IS present outranks "could not look" in the same run', windowsOnly, async () => {
  const noWhoami = path.join(fixtureRoot, 'no-system-directory-3')
  await mkdir(noWhoami, { recursive: true })
  const root = await artefact('sid-present-and-unreadable', {
    'resources/app/task.xml': `<Principal><UserId>${FIXTURE_SID}</UserId></Principal>`,
  })

  const result = runWithSystemDirectory(noWhoami, root)

  assert.equal(result.status, 1, output(result))
  assert.match(result.stderr, /\[machine-sid\]/)
  assert.doesNotMatch(result.stderr, /\[machine-sid-unreadable\]/)
  /* File and count only: the value is never printed, not even here. */
  assert.doesNotMatch(output(result), new RegExp(FIXTURE_SID))
})

test('on a sound host the exact-value check runs, and the log says so before it says clean', windowsOnly, async () => {
  const root = await artefact('sid-readable', { 'resources/app/index.js': 'module.exports = 1\n' })

  const result = run(root)

  assert.equal(result.status, 0, output(result))
  assert.match(result.stdout, /machine SID: shape rule \+ the building account's own SID/)
  assert.match(result.stdout, /clean: 1 files/)
})
