// Does the staleness guard actually refuse a stale payload?
//
// tools/check-payload-current.mjs was added after the shipped payload was found
// to have drifted from source on three security-critical files while every
// other gate reported clean. It is wired into `npm run dist`. It had no test.
//
// A gate nothing tests is the thing this whole night has been about: it can
// stop guarding silently, and the build keeps printing green. Worse than an
// absent gate, because its green is quoted.
//
// These assertions RUN the tool against real directories and read its real exit
// code. They do not read its source. A source assertion cannot see reachability
// -- dead code matches a text search exactly as well as live code does, which is
// how a lane tonight shipped a repair that emptied a whole settings screen while
// its suite stayed green. The only thing that sees "did it refuse" is running it
// and looking at what came back.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { collectProviderRuntimePayload } from '../lib/provider-runtime-payload.mjs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TOOL_RELATIVE = 'tools/check-payload-current.mjs'
const TOOL = path.join(REPO_ROOT, TOOL_RELATIVE)

const MANIFEST = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tools', 'capability-manifest.json'), 'utf8'))
const NEUTRAL = MANIFEST.neutralDefaults

function put(root, relative, contents) {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

function walk(root, base = root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

function git(repository, ...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function writePayloadRecord(staged, sourceRef) {
  const files = walk(staged).filter((relative) => relative !== 'PAYLOAD.json').sort()
  const digest = createHash('sha256')
  let byteCount = 0
  for (const relative of files) {
    const bytes = readFileSync(path.join(staged, relative))
    byteCount += bytes.length
    digest.update(relative)
    digest.update('\0')
    digest.update(bytes)
  }
  put(staged, 'PAYLOAD.json', `${JSON.stringify({
    schemaVersion: 1,
    sourceRef,
    entrypoints: MANIFEST.entrypoints,
    bridgeEntrypoint: MANIFEST.entrypoints[0],
    ownerHostModule: 'src/owner-host.js',
    hostModules: MANIFEST.hostModules || [],
    spawnedPrograms: MANIFEST.spawnedPrograms || [],
    helperPrograms: MANIFEST.helperPrograms || [],
    ...(MANIFEST.providerRuntimes?.length ? { providerRuntimes: collectProviderRuntimePayload(staged, MANIFEST.providerRuntimes).records } : {}),
    fileCount: files.length,
    byteCount,
    payloadSha256: digest.digest('hex'),
    neutralDefaults: NEUTRAL,
    ownerDataClean: true,
  }, null, 2)}\n`)
}

// Builds a source tree and a staged payload that mirrors it, plus the marker
// the source resolver keys on (tools/mission-bridge.js).
function scaffold() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'mc-cpc-'))
  const appRoot = path.join(base, 'app')
  const source = path.join(base, 'engine')
  const staged = path.join(base, 'capability')

  /* The checker binds every declared source ref, including this app's private
     owner setting. Running it from the developer checkout made that REAL pin
     conflict with every invented fixture commit before any byte comparison.
     Copy the unmodified checker and its inputs into an isolated app root;
     never remove or override the installed app's binding to make a test pass. */
  for (const relative of [
    TOOL_RELATIVE,
    'tools/lib/capability-source-git.mjs',
    'tools/lib/provider-runtime-payload.mjs',
    'tools/capability-manifest.json',
    ...NEUTRAL.map(relative => `capability-defaults/${relative}`),
  ]) {
    put(appRoot, relative, readFileSync(path.join(REPO_ROOT, relative)))
  }

  mkdirSync(source, { recursive: true })
  git(source, 'init', '--initial-branch=main')
  git(source, 'config', 'user.email', 'fixture@example.test')
  git(source, 'config', 'user.name', 'Payload Current Fixture')

  put(source, 'tools/mission-bridge.js', '// resolver marker\n')
  put(source, 'src/lib/thing.js', 'module.exports = 1\n')
  put(source, 'src/lib/providers/scrub.js', '// the scrub\n')

  put(staged, 'tools/mission-bridge.js', '// resolver marker\n')
  put(staged, 'src/lib/thing.js', 'module.exports = 1\n')
  put(staged, 'src/lib/providers/scrub.js', '// the scrub\n')
  // The neutral defaults are copied from the REAL capability-defaults/, because
  // that is what the packer does and what the guard therefore compares against.
  // An invented fixture here mismatches the real defaults and makes the
  // baseline case fail for a fictional reason -- which is exactly what the first
  // draft of this test did, and it took the guard's own correct refusal to show
  // it. The fixture was wrong, not the tool.
  for (const relative of NEUTRAL) {
    put(staged, relative, readFileSync(path.join(REPO_ROOT, 'capability-defaults', relative)))
  }
  for (const runtime of MANIFEST.providerRuntimes || []) {
    const bytes = Buffer.from('export const quotaFixture = true;\n')
    const relative = `provider-runtimes/${runtime.id}/sdk.mjs`
    const descriptor = { schemaVersion: 1, id: runtime.id, version: '0.58.0', runtimePath: `provider-runtimes/${runtime.id}`, entrypoint: 'sdk.mjs',
      files: { 'sdk.mjs': { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } } }
    for (const root of [source, staged]) {
      put(root, relative, bytes)
      put(root, runtime.manifest, JSON.stringify(descriptor))
    }
  }
  git(source, 'add', '--all')
  git(source, 'commit', '-m', 'fixture source')
  const sourceRef = git(source, 'rev-parse', 'HEAD')
  writePayloadRecord(staged, sourceRef)

  return { base, appRoot, source, sourceRef, staged }
}

function run(staged, source, sourceRef) {
  const env = { ...process.env }
  delete env.TOOLSENABLED_SOURCE
  delete env.TOOLSENABLED_SOURCE_REF
  if (source) env.TOOLSENABLED_SOURCE = source
  if (sourceRef) env.TOOLSENABLED_SOURCE_REF = sourceRef
  const appRoot = path.join(path.dirname(staged), 'app')
  const isolatedTool = path.join(appRoot, TOOL_RELATIVE)
  assert.equal(readFileSync(isolatedTool, 'utf8'), readFileSync(TOOL, 'utf8'),
    'the fixture must execute the exact production checker, not a test rewrite')
  const result = spawnSync(process.execPath, [isolatedTool, staged], { cwd: appRoot, encoding: 'utf8', env, windowsHide: true })
  return { code: result.status, out: `${result.stdout}${result.stderr}` }
}

function withScaffold(body) {
  const made = scaffold()
  try { body(made) } finally { rmSync(made.base, { recursive: true, force: true }) }
}

/* ---------- the ordinary case ---------- */

test('a payload matching its source passes', () => {
  withScaffold(({ source, sourceRef, staged }) => {
    const { code, out } = run(staged, source, sourceRef)
    assert.equal(code, 0, `a current payload was refused: ${out}`)
    assert.match(out, /is current/, 'a passing run must say what it verified, not just exit 0')
  })
})

test('the real checker accepts a matching owner binding and refuses conflicting exact declarations', () => {
  withScaffold(({ appRoot, source, sourceRef, staged }) => {
    const binding = 'private/capability-source.owner.json'
    put(appRoot, binding, `${JSON.stringify({ path: source, ref: sourceRef })}\n`)
    const matching = run(staged, source, sourceRef)
    assert.equal(matching.code, 0, `a matching owner binding was refused: ${matching.out}`)

    const conflictingRef = (sourceRef[0] === '0' ? '1' : '0') + sourceRef.slice(1)
    put(appRoot, binding, `${JSON.stringify({ path: source, ref: conflictingRef })}\n`)
    const conflicting = run(staged, source, sourceRef)
    assert.equal(conflicting.code, 1, 'a conflicting owner binding was silently ignored')
    assert.match(conflicting.out, /source ref declarations disagree/)
    assert.match(conflicting.out, /private\/capability-source\.owner\.json/)
  })
})

/* ---------- the defect it exists for ---------- */

test('one stale file is refused and NAMED', () => {
  withScaffold(({ source, staged }) => {
    // The real incident's shape: the source moved on, the payload did not.
    put(source, 'src/lib/providers/scrub.js', '// the scrub, now case-insensitive\n')
    git(source, 'add', '--all')
    git(source, 'commit', '-m', 'advance source')
    const sourceRef = git(source, 'rev-parse', 'HEAD')

    const { code, out } = run(staged, source, sourceRef)
    assert.equal(code, 1, 'a stale payload was accepted')
    assert.match(out, /src\/lib\/providers\/scrub\.js/,
      'the refusal must name the stale file; a count tells nobody what to re-stage')
    assert.doesNotMatch(out, /src\/lib\/thing\.js/,
      'files that DID match must not be listed, or the real one is lost in noise')
  })
})

test('a stale generated payload record is refused and NAMED', () => {
  withScaffold(({ source, sourceRef, staged }) => {
    const record = JSON.parse(readFileSync(path.join(staged, 'PAYLOAD.json'), 'utf8'))
    record.fileCount += 1
    put(staged, 'PAYLOAD.json', `${JSON.stringify(record, null, 2)}\n`)

    const { code, out } = run(staged, source, sourceRef)
    assert.equal(code, 1, 'a stale shipped PAYLOAD.json was accepted')
    assert.match(out, /PAYLOAD\.json/, 'the refusal must name the stale shipped record')
  })
})

test('a stale payload record cannot redirect a neutral-default check to source', () => {
  withScaffold(({ source, staged }) => {
    const relative = 'config/toolsenabled.policy.json'
    const staleCustomerDefault = '{"policy":"stale"}\n'
    put(staged, relative, staleCustomerDefault)
    put(source, relative, staleCustomerDefault)
    git(source, 'add', '--all')
    git(source, 'commit', '-m', 'add source-side stale default')
    const sourceRef = git(source, 'rev-parse', 'HEAD')
    writePayloadRecord(staged, sourceRef)

    const record = JSON.parse(readFileSync(path.join(staged, 'PAYLOAD.json'), 'utf8'))
    record.neutralDefaults = record.neutralDefaults.filter((entry) => entry !== relative)
    put(staged, 'PAYLOAD.json', `${JSON.stringify(record, null, 2)}\n`)

    const { code, out } = run(staged, source, sourceRef)
    assert.equal(code, 1, 'a stale record redirected the policy comparison to matching source bytes')
    assert.match(out, /config\/toolsenabled\.policy\.json/,
      'the refusal must name the stale neutral default, not only its stale record')
  })
})

/* ---------- the substituted files are verified, not skipped ---------- */

// This is the assertion most likely to be quietly removed by someone "fixing" a
// false positive, and it guards the two files most likely to carry owner data.
test('a neutral-default that drifts from capability-defaults is still caught', () => {
  withScaffold(({ source, sourceRef, staged }) => {
    put(staged, NEUTRAL[0], '{"neutral":false,"leaked":"something"}\n')

    const { code, out } = run(staged, source, sourceRef)
    assert.equal(code, 1, 'a substituted config was skipped rather than verified')
    assert.match(out, new RegExp(NEUTRAL[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the refusal must name the drifted neutral default')
  })
})

/* ---------- unknown is not current ---------- */

test('an unresolvable source tree is refused', () => {
  withScaffold(({ base, sourceRef, staged }) => {
    const { code } = run(staged, path.join(base, 'no-such-tree'), sourceRef)
    assert.equal(code, 1, 'a payload that could not be compared against anything was accepted')
  })
})

test('a staged directory with no PAYLOAD.json cannot state what it is', () => {
  withScaffold(({ source, sourceRef, staged }) => {
    rmSync(path.join(staged, 'PAYLOAD.json'))
    assert.equal(run(staged, source, sourceRef).code, 1, 'a directory that cannot describe itself was accepted')
  })
})

test('a staged file with no counterpart at all is refused', () => {
  withScaffold(({ source, sourceRef, staged }) => {
    put(staged, 'src/lib/orphan.js', '// in the payload, in no source tree\n')
    const { code, out } = run(staged, source, sourceRef)
    assert.equal(code, 1, 'a staged file nothing can vouch for was accepted')
    assert.match(out, /orphan\.js/, 'the orphan must be named')
  })
})


test('runtime tampering cannot be blessed by matching a modified ignored source artifact', () => {
  withScaffold(({ source, sourceRef, staged }) => {
    const relative = 'provider-runtimes/gemini-quota/sdk.mjs'
    put(source, '.gitignore', '/provider-runtimes/\n')
    git(source, 'rm', '--cached', relative)
    git(source, 'add', '.gitignore')
    git(source, 'commit', '-m', 'generated runtime remains hash pinned')
    const ref = git(source, 'rev-parse', 'HEAD')
    writePayloadRecord(staged, ref)
    put(source, relative, 'modified untracked SDK')
    put(staged, relative, 'modified untracked SDK')
    const result = run(staged, source, ref)
    assert.notEqual(result.code, 0)
    assert.match(result.out, /provider runtime (byte count|hash) changed/)
  })
})
