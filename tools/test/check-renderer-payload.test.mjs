import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GATE = path.join(REPO_ROOT, 'tools', 'check-renderer-payload.mjs')

function emptyAsar() {
  const json = Buffer.from(JSON.stringify({ files: {} }))
  const header = Buffer.alloc(16)
  header.writeUInt32LE(json.length, 12)
  return Buffer.concat([header, json])
}

test('check-renderer-payload refuses an empty packaged payload instead of passing a blind enumeration', () => {
  const packagedRoot = mkdtempSync(path.join(os.tmpdir(), 'check-renderer-payload-'))
  try {
    const resources = path.join(packagedRoot, 'resources')
    mkdirSync(resources)
    writeFileSync(path.join(resources, 'app.asar'), emptyAsar())

    const result = spawnSync(process.execPath, [GATE, packagedRoot], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(
      result.stderr,
      /app\.asar contains no files, so the packaged payload enumeration checked nothing; that is not a pass/,
    )
    assert.doesNotMatch(result.stdout, /check-renderer-payload: OK/)
  } finally {
    rmSync(packagedRoot, { recursive: true, force: true })
  }
})

test('check-renderer-payload still accepts the healthy authored payload', () => {
  const output = execFileSync(process.execPath, [GATE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })

  assert.match(output, /classified \d+ authored file\(s\)/)
  assert.match(output, /check-renderer-payload: OK/)
})

/* THE THIRD CLASSIFICATION, AND WHY IT NEEDED ITS OWN RULE.
 *
 * `operator` already kept files out of the payload, but it means "somebody's
 * private document", and the subscription price catalog is nobody's private
 * document -- it is a product surface the owner ruled out of the launch
 * (R1214: "we are NOT collecting payments at first public launch"). It shipped
 * because public/ ships by default, and #/subscribe and #/pricing rendered a
 * Team price and a three-seat minimum out of it. `withheld` is the record of
 * that decision, and these two tests are what makes the record load-bearing
 * instead of a comment: the fixture repo is a temp tree because REPO_ROOT is
 * derived from the gate's own location, and a test that staged a file into the
 * real public/ would be racing every other suite. */

function fixtureRepo(manifest, publicFiles) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'renderer-payload-fixture-'))
  mkdirSync(path.join(root, 'tools'), { recursive: true })
  mkdirSync(path.join(root, 'config'), { recursive: true })
  writeFileSync(path.join(root, 'tools', 'check-renderer-payload.mjs'), readFileSync(GATE))
  writeFileSync(path.join(root, 'config', 'renderer-payload-boundary.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [relative, body] of Object.entries(publicFiles)) {
    const file = path.join(root, 'public', ...relative.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  return root
}

test('a withheld file staged under public/ is refused, and the refusal names the decision instead of the person', () => {
  const root = fixtureRepo(
    {
      schemaVersion: 1,
      shipped: { paths: ['brand-icon.svg'] },
      operator: { paths: [] },
      withheld: { paths: ['data/subscription-catalog.json'] },
    },
    { 'brand-icon.svg': '<svg/>', 'data/subscription-catalog.json': '{"plans":[{"monthlyUsd":299}]}' },
  )
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'tools', 'check-renderer-payload.mjs')], { encoding: 'utf8' })
    assert.equal(result.status, 1,
      'mutation `classify the price catalog as shipped again` survived: expected the gate to exit 1 on a withheld file staged under public/')
    assert.match(result.stderr, /1 file\(s\) this release withholds are under public\//,
      'mutation `let a withheld file fall through the unclassified branch` survived: expected the withheld rule to report it by its own name')
    assert.match(result.stderr, /data\/subscription-catalog\.json/,
      'mutation `report a count without the path` survived: expected the refusal to name the file')
    assert.doesNotMatch(result.stderr, /classified nowhere/,
      'mutation `drop withheld from the classified set` survived: expected a withheld file to be classified, not unclassified')
    assert.doesNotMatch(result.stdout, /check-renderer-payload: OK/,
      'mutation `report OK alongside a violation` survived: expected no OK line')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a manifest with no withheld group is a guard error, not a clean sweep', () => {
  /* The group is not optional. A manifest that has lost it has lost the only
     record of why the price catalog is not in the payload, and a guard that
     shrugged at that would report a clean payload while enforcing one rule
     fewer than its reader believes -- the exact shape this whole file exists
     to refuse, one layer up. */
  const root = fixtureRepo(
    { schemaVersion: 1, shipped: { paths: ['brand-icon.svg'] }, operator: { paths: [] } },
    { 'brand-icon.svg': '<svg/>' },
  )
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'tools', 'check-renderer-payload.mjs')], { encoding: 'utf8' })
    assert.equal(result.status, 2,
      'mutation `default the withheld group to an empty list` survived: expected a manifest without it to be a setup error (exit 2)')
    assert.match(result.stderr, /must contain a "withheld\.paths" array/,
      'mutation `swallow the missing group` survived: expected the error to name the missing group')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
