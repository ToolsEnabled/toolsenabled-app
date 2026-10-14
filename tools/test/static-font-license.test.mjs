import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'static-font-license-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const directory of ['tools', 'src/assets/fonts', 'node_modules/owned-font-fixture']) mkdirSync(join(root, directory), { recursive: true })
  copyFileSync(join(repo, 'tools/check-license-notices.mjs'), join(root, 'tools/check-license-notices.mjs'))
  for (const doc of ['LICENSE', 'NOTICE', 'CONTRIBUTING.md']) copyFileSync(join(repo, doc), join(root, doc))
  const dependencyBody = 'Owned synthetic package license text for this behavioral fixture; retain all of this notice.\n'
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'owned-font-fixture': '1.0.0' } }))
  writeFileSync(join(root, 'node_modules/owned-font-fixture/package.json'), JSON.stringify({ name: 'owned-font-fixture', version: '1.0.0' }))
  writeFileSync(join(root, 'node_modules/owned-font-fixture/LICENSE'), dependencyBody)
  const font = join(root, 'src/assets/fonts/geist-latin-wght-normal.woff2')
  const bytes = readFileSync(join(repo, 'src/assets/fonts/geist-latin-wght-normal.woff2'))
  writeFileSync(font, bytes)
  const license = readFileSync(join(repo, 'src/assets/fonts/GEIST-LICENSE.txt'), 'utf8')
  writeFileSync(join(root, 'src/assets/fonts/GEIST-LICENSE.txt'), license)
  writeFileSync(join(root, 'src/tokens.css'), '@font-face { font-family: Geist; src: url("./assets/fonts/geist-latin-wght-normal.woff2") format("woff2"); }\n')
  const notice = join(root, 'THIRD-PARTY-LICENSES.md')
  const baseNotice = `### owned-font-fixture 1.0.0 — FIXTURE\n\n${dependencyBody}`
  const fullNotice = `${baseNotice}\n### Geist — OFL-1.1\n\n${license}`
  writeFileSync(notice, fullNotice)
  const run = () => {
    const result = spawnSync(process.execPath, [join(root, 'tools/check-license-notices.mjs')], { encoding: 'utf8' })
    return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` }
  }
  return { root, font, bytes, notice, baseNotice, fullNotice, run }
}

test('static font license coverage accepts the complete asset and supplied notice', t => {
  const f = fixture(t)
  const result = f.run()
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /LICENSE NOTICE GATE: PASS/)
})

test('missing declared static font goes RED, then byte-restored asset goes GREEN', t => {
  const f = fixture(t)
  const before = digest(f.bytes)
  rmSync(f.font)
  const red = f.run()
  assert.equal(red.status, 1, red.output)
  assert.match(red.output, /static font declared .* is missing: .*geist-latin-wght-normal/)
  writeFileSync(f.font, f.bytes)
  assert.equal(digest(readFileSync(f.font)), before)
  const green = f.run()
  assert.equal(green.status, 0, green.output)
  console.log(`MUTATION missing-font RED exit=${red.status}: ${red.output.trim()}\nRESTORED GREEN exit=${green.status}: ${green.output.trim()}`)
})

test('missing static-font notice goes RED, then restored complete notice goes GREEN', t => {
  const f = fixture(t)
  writeFileSync(f.notice, f.baseNotice)
  const red = f.run()
  assert.equal(red.status, 1, red.output)
  assert.match(red.output, /static font notice is missing or incomplete/)
  writeFileSync(f.notice, f.fullNotice)
  assert.equal(readFileSync(f.notice, 'utf8'), f.fullNotice)
  const green = f.run()
  assert.equal(green.status, 0, green.output)
  console.log(`MUTATION missing-notice RED exit=${red.status}: ${red.output.trim()}\nRESTORED GREEN exit=${green.status}: ${green.output.trim()}`)
})


test('copied preview font requires exact licensed canonical bytes, RED then restored GREEN', t => {
  const f = fixture(t)
  const directory = join(f.root, 'public/preview/fonts')
  mkdirSync(directory, { recursive: true })
  const copy = join(directory, 'geist-latin-wght-normal.woff2')
  writeFileSync(copy, f.bytes)
  writeFileSync(join(f.root, 'public/preview/preview.css'), '@font-face { font-family: Geist; src: url("./fonts/geist-latin-wght-normal.woff2") format("woff2"); }\n')
  const healthy = f.run()
  assert.equal(healthy.status, 0, healthy.output)
  const changed = Buffer.from(f.bytes)
  changed[changed.length - 1] ^= 1
  writeFileSync(copy, changed)
  const red = f.run()
  assert.equal(red.status, 1, red.output)
  assert.match(red.output, /static font has no readable license source: .*public.*preview.*geist-latin-wght-normal/)
  writeFileSync(copy, f.bytes)
  assert.equal(digest(readFileSync(copy)), digest(f.bytes))
  const green = f.run()
  assert.equal(green.status, 0, green.output)
  console.log(`MUTATION copied-font-mismatch RED exit=${red.status}: ${red.output.trim()}\nRESTORED GREEN exit=${green.status}: ${green.output.trim()}`)
})
