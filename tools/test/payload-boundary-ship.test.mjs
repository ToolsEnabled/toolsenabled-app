// THE PUBLISH VERDICT IS NOT THE BUILD VERDICT.
//
// check-payload-boundary deliberately exits 0 while `pending` files still ship.
// That is the right default -- pending means the owner has ruled and the removal
// work has not landed yet, and a guard that fails every build until then is a
// guard someone switches off. But the report says so only in PROSE, and a build
// chain consumes the exit code, not the prose. Three separate lanes read "exit 0"
// as "safe to publish" while the commercial tier table with real prices sat in
// the staged payload.
//
// `--ship` is the strict verdict for the publish path. These tests pin both
// verdicts and, more importantly, pin that turning one on does not turn the other
// off: the first implementation returned early on pending and silently suppressed
// the unclassified-file report, which exited 1 for the wrong reason and would have
// sent an operator hunting for a pending file that was not the problem.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE = path.join(REPO, 'tools', 'check-payload-boundary.mjs')
const MANIFEST = path.join(REPO, 'config', 'payload-boundary.json')

// Run the gate and return BOTH streams and the real exit code. Never read an exit
// code through a pipe: `node gate.mjs | tail` reports tail's status, which is how
// a broken run reads as a pass.
function gate(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [GATE, ...args], { cwd: REPO, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, out: `${stdout}${stderr}` }))
  })
}

// A payload containing exactly one file, which the manifest classifies as `open`.
function cleanPayload() {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'boundary-')), 'capability')
  mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true })
  writeFileSync(path.join(dir, 'src', 'lib', 'agent-roles.js'), '// open per the manifest\n')
  return dir
}

// A MANIFEST WRITTEN FOR THE TEST, AND WHY THE LIVE ONE STOPPED WORKING HERE.
//
// The two tests below need a path that is `pending`, and the live manifest's
// pending block is now empty -- legitimately: the owner ruled on every entry on
// 2026-08-11 and the decoupling work landed. src/lib/entitlement.js, which these
// tests had hard-coded as their pending example, moved pending -> paid in that
// change. Both tests went red instantly, and neither the gate nor the behaviour
// they pin had changed at all.
//
// That is the wrong dependency. These tests are about the SEMANTICS of pending --
// permissive build verdict, strict publish verdict, no suppression of the
// unclassified report -- and those semantics must stay covered whether or not any
// real path happens to be pending this week. So the fixture names its own pending
// path. The live manifest is still exercised by the other tests in this file,
// which is where a real drift should surface.
//
// Written to the PARENT of the payload root on purpose: a manifest inside the
// payload would itself be an unclassified file and change the verdict it defines.
function fixtureManifest(payloadDir, { pending = {}, open = [], paid = [] } = {}) {
  const file = path.join(path.dirname(payloadDir), 'fixture-boundary.json')
  writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    status: 'proposed',
    excluded: { paths: [], prefixes: [] },
    paid: { paths: paid, prefixes: [] },
    pending,
    open: { paths: ['src/lib/agent-roles.js', ...open] },
  }, null, 2)}\n`)
  return file
}

const PENDING_FIXTURE = {
  'src/lib/entitlement.js': 'the commercial tier table, owner-ruled as paid, still shipping until the decoupling lands',
}

test('a payload with no pending file is clean under BOTH verdicts', async () => {
  const dir = cleanPayload()
  try {
    const bare = await gate([dir, '--manifest', MANIFEST])
    const ship = await gate([dir, '--manifest', MANIFEST, '--ship'])
    assert.equal(bare.code, 0, `bare run should pass:\n${bare.out}`)
    assert.equal(ship.code, 0, `--ship should pass when nothing is pending:\n${ship.out}`)
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true })
  }
})

test('a pending file passes the build verdict and FAILS the publish verdict', async () => {
  const dir = cleanPayload()
  try {
    // entitlement.js is `pending` in the FIXTURE manifest: the commercial tier
    // table, owner-ruled as paid, still shipping until the decoupling work lands.
    mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true })
    writeFileSync(path.join(dir, 'src', 'lib', 'entitlement.js'), '// the tier table\n')
    const MANIFEST = fixtureManifest(dir, { pending: PENDING_FIXTURE })

    const bare = await gate([dir, '--manifest', MANIFEST])
    assert.equal(bare.code, 0, `the build verdict must stay permissive about pending:\n${bare.out}`)

    const ship = await gate([dir, '--manifest', MANIFEST, '--ship'])
    assert.equal(ship.code, 1, `--ship must refuse while a pending file ships:\n${ship.out}`)
    assert.match(ship.out, /NOT PUBLISHABLE/)
    assert.match(ship.out, /src\/lib\/entitlement\.js/, 'the refusal must NAME the file that caused it')
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true })
  }
})

test('--ship never suppresses the unclassified report', async () => {
  // The regression this file exists for. With BOTH an unclassified file and a
  // pending file present, an operator must be told about both. The first version
  // returned early on pending and named only that -- correct exit code, wrong
  // reason, and the unclassified file (the more serious of the two) went unsaid.
  const dir = cleanPayload()
  try {
    writeFileSync(path.join(dir, 'src', 'lib', 'entitlement.js'), '// pending\n')
    writeFileSync(path.join(dir, 'NOT-IN-THE-MANIFEST.js'), '// unclassified\n')
    const MANIFEST = fixtureManifest(dir, { pending: PENDING_FIXTURE })

    const ship = await gate([dir, '--manifest', MANIFEST, '--ship'])
    assert.equal(ship.code, 1)
    assert.match(ship.out, /NOT-IN-THE-MANIFEST\.js/, 'the unclassified file was not reported under --ship')
    assert.match(ship.out, /NOT PUBLISHABLE/, 'the pending refusal was not reported under --ship')
    assert.match(ship.out, /BOUNDARY VIOLATION/, 'the violation header was not reported under --ship')
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true })
  }
})

test('an unclassified file still fails the build verdict on its own', async () => {
  // The control arm. If this ever passes, the two verdicts have been wired
  // together wrongly and --ship is carrying a check that should be unconditional.
  const dir = cleanPayload()
  try {
    writeFileSync(path.join(dir, 'NOT-IN-THE-MANIFEST.js'), '// unclassified\n')
    const bare = await gate([dir, '--manifest', MANIFEST])
    assert.equal(bare.code, 1, `an unknown file must fail without --ship too:\n${bare.out}`)
    assert.match(bare.out, /NOT-IN-THE-MANIFEST\.js/)
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true })
  }
})

test('an unknown flag is still refused, and --ship is not matched loosely', async () => {
  const dir = cleanPayload()
  try {
    const typo = await gate([dir, '--manifest', MANIFEST, '--shipp'])
    assert.equal(typo.code, 2, 'a mistyped flag must be a guard error, never a silent permissive run')
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true })
  }
})
