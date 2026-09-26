import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readTool = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const codeOnly = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

test('packaged settings and checkout drives seed the identity selected by --user-data-dir', () => {
  for (const name of ['chatbox-settings-qa.mjs', 'checkout-privacy-packaged-qa.mjs']) {
    const source = codeOnly(readTool(name))
    assert.match(source, /machineRecordProductDirectory\(profile\)/,
      `${name} must derive its LOCALAPPDATA product directory from userDataFor(profile)`)
    assert.match(source, /path\.join\(profile, 'local', productDirectory\)/,
      `${name} must seed the machine record under that derived identity`)
    assert.match(source, /`--user-data-dir=\$\{userDataFor\(profile\)\}`/,
      `${name} must launch with the same userData helper`)
    assert.doesNotMatch(source, /path\.join\(profile, 'local', 'ToolsEnabled'\)/,
      `${name} restored the stale literal identity`)
  }
})

test('checkout availability proof is reproducible without an operator-private file', () => {
  const source = codeOnly(readTool('checkout-privacy-packaged-qa.mjs'))
  assert.doesNotMatch(source, /purchase-catalog\.owner\.json/,
    'a clean isolated release worktree never contains the ignored operator-private catalogue')
  assert.match(source, /JSON\.stringify\(syntheticCatalog\(\), null, 2\)/,
    'the positive surface proof must install its safe synthetic fixture into sterile userData')
  assert.match(source, /Example Vendor QAMARK-CATALOGUE/,
    'the fixture must be obviously invented rather than copied from owner data')
})

test('first-run and example-page drives seed the identity selected by their explicit userData', () => {
  for (const name of ['first-run-contract-qa.mjs', 'example-page-write-fence-qa.mjs']) {
    const source = codeOnly(readTool(name))
    assert.match(source, /machineRecordProductDirectory\(profile\)/)
    assert.match(source, /path\.join\(profile, 'local', productDirectory\)/)
    assert.match(source, /userDataFor\(profile\)/)
    assert.doesNotMatch(source, /path\.join\(profile, 'local', 'ToolsEnabled'\)/,
      `${name} restored the stale literal product identity`)
  }
})
