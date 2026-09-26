/* QA drives pick a provider, then a model (1.0.48 picker, QA stage).
 *
 * The start panel now draws Provider ([data-compose-field="provider"]) and
 * Model ([data-compose-field="tier"]) on one row, and the Model menu holds only
 * the chosen provider's rows. A drive that still walks the Model menu alone
 * cannot reach a Claude row from the Codex default, and a provider change
 * lands the menu on that provider's default (Claude's is `claude-opus`), which
 * sits BELOW `claude-sonnet` and `claude-fable`, so an ArrowDown-only walk from
 * there never reaches either.
 *
 * Two halves: the shared helper's order, run for real against recorders; and
 * a scan of every drive under tools/, so a drive added or left behind that
 * picks a model without its provider, or walks without Home, is named here.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import {
  COMPOSE_MODEL,
  COMPOSE_PROVIDER,
  chooseProviderThenModel,
  providerOfModel,
} from '../lib/compose-model-choice.mjs'

const TOOLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ------------------------------------------------------------ the helper -- */

test('the helper names the product\'s own two compose menus', () => {
  assert.equal(COMPOSE_PROVIDER, '[data-compose-field="provider"]')
  assert.equal(COMPOSE_MODEL, '[data-compose-field="tier"]')
})

test('every model row\'s provider is read off the product\'s table, pinned rows included', () => {
  for (const row of LAUNCH_TIERS) assert.equal(providerOfModel(row.id), row.provider, row.id)
  assert.equal(providerOfModel('claude-opus-5'), 'claude')
  assert.equal(providerOfModel('claude-sonnet-5'), 'claude')
  assert.equal(providerOfModel('astra'), 'codex')
  assert.equal(providerOfModel('local'), 'local')
  assert.equal(providerOfModel('no-such-model'), null)
})

test('the provider is chosen before the model, each with the drive\'s own gesture', async () => {
  const calls = []
  const choose = async (selector, value) => { calls.push([selector, value]); return { ok: true, presses: calls.length, label: `${value} label` } }
  const result = await chooseProviderThenModel(choose, 'claude-sonnet')
  assert.deepEqual(calls, [[COMPOSE_PROVIDER, 'claude'], [COMPOSE_MODEL, 'claude-sonnet']])
  assert.equal(result.ok, true)
  assert.equal(result.provider, 'claude')
  assert.equal(result.label, 'claude-sonnet label', 'the model pick\'s own result is what the caller reads')
})

test('a provider the drive cannot reach stops there: the model is never walked under the wrong provider', async () => {
  const calls = []
  const choose = async (selector, value) => { calls.push([selector, value]); return { ok: false, why: 'never reached', after: 'codex' } }
  const result = await chooseProviderThenModel(choose, 'claude-fable')
  assert.deepEqual(calls, [[COMPOSE_PROVIDER, 'claude']])
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'provider')
  assert.match(result.why, /^provider claude: never reached$/)
  assert.equal(result.after, 'codex', 'the chooser\'s own reading rides along for the drive\'s note')
})

test('a model missed under its provider says which provider it was looked for under', async () => {
  const choose = async selector => selector === COMPOSE_PROVIDER ? { ok: true } : { ok: false, why: 'never reached claude-opus-5 in 24 presses' }
  const result = await chooseProviderThenModel(choose, 'claude-opus-5')
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'model')
  assert.match(result.why, /^model claude-opus-5 under claude: never reached/)
})

test('an id no provider runs is refused before any key is pressed; a caller may still name the provider', async () => {
  const calls = []
  const choose = async (selector, value) => { calls.push([selector, value]); return { ok: true } }
  const unknown = await chooseProviderThenModel(choose, 'no-such-model')
  assert.equal(unknown.ok, false)
  assert.deepEqual(calls, [])
  const named = await chooseProviderThenModel(choose, 'astra', { provider: 'codex', modelField: '#model' })
  assert.equal(named.ok, true)
  assert.deepEqual(calls, [[COMPOSE_PROVIDER, 'codex'], ['#model', 'astra']])
})

/* A Model menu as the product builds it on a provider change: that provider's
   rows, landed on its default. The walk a drive makes after Escape. */
function claudeModelMenu() {
  const rows = LAUNCH_TIERS.filter(row => row.provider === 'claude').map(row => row.id)
  return { rows, at: rows.indexOf('claude-opus') }
}
function walk(menu, wanted, { home }) {
  let at = menu.at
  if (home && menu.rows[at] !== wanted) at = 0
  for (let press = 0; press < 24; press += 1) {
    if (menu.rows[at] === wanted) return true
    at = Math.min(menu.rows.length - 1, at + 1)
  }
  return false
}

test('why the walk starts with Home: Claude\'s default sits below the rows the drives want', () => {
  const menu = claudeModelMenu()
  assert.ok(menu.at > 0, 'Claude lands on claude-opus, which is not its first row')
  for (const wanted of ['claude-fable', 'claude-sonnet']) {
    assert.equal(walk(menu, wanted, { home: false }), false, `${wanted} is above the default; ArrowDown alone never reaches it`)
    assert.equal(walk(menu, wanted, { home: true }), true, `${wanted} is reached once the walk starts at the top`)
  }
  for (const wanted of ['claude-opus-5', 'claude-sonnet-5']) assert.equal(walk(menu, wanted, { home: true }), true, wanted)
})

/* ------------------------------------------------------------ the drives -- */

function driveFiles(dir = TOOLS, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'test' || name === 'node_modules') continue
      driveFiles(full, out)
    } else if (/\.(mjs|cjs)$/.test(name)) out.push(full)
  }
  return out
}
const DRIVES = driveFiles().map(file => ({ file: path.relative(TOOLS, file), source: readFileSync(file, 'utf8') }))

/* Code only: a comment that still says `[data-compose-field="tier"]` is not a pick. */
const code = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

const MODEL = /\[data-compose-field=\\?"tier\\?"\]/
const PROVIDER = /\[data-compose-field=\\?"provider\\?"\]|COMPOSE_PROVIDER|chooseProviderThenModel/

test('the scan reaches the drives this stage names', () => {
  const names = new Set(DRIVES.map(drive => drive.file.split(path.sep).join('/')))
  for (const expected of ['claude-tree-start-proof.mjs', 'cut-check-drive.mjs', 'spine-defects-drive.mjs', 'inside-agents-drive.mjs',
    'palette-keyboard-qa.mjs', 'owner-walkthrough-drive.mjs', 'lib/local-agent-native-journey.mjs', 'lib/drivers/desktop-journeys.mjs',
    'lib/page2-native-scenarios.cjs']) {
    assert.ok(names.has(expected), `tools/${expected} was not scanned`)
  }
})

test('no drive walks the Model menu by keyboard on its own: every such pick goes through its provider first', () => {
  const direct = []
  for (const { file, source } of DRIVES) {
    for (const line of code(source).split('\n')) {
      if (/chooseByKeyboard\(/.test(line) && MODEL.test(line) && !/chooseProviderThenModel/.test(line)) direct.push(`${file}: ${line.trim()}`)
      if (/chooseByKeyboard\([^)]*\b(TIER|tierSelector)\b/.test(line) && !/chooseProviderThenModel/.test(line)) direct.push(`${file}: ${line.trim()}`)
    }
  }
  assert.deepEqual(direct, [], 'these drives still pick a model without choosing its provider first')
})

test('every drive that picks from the compose Model menu also chooses the provider', () => {
  const picking = /chooseByKeyboard|chooseEnabled|\.select\(|\bchoose\(/
  const missing = DRIVES
    .filter(({ source }) => MODEL.test(code(source)) && picking.test(code(source)))
    .filter(({ source }) => !PROVIDER.test(code(source)))
    .map(({ file }) => file)
  assert.deepEqual(missing, [])
})

test('a scripted Model select is always preceded by its Provider select', () => {
  const unpaired = []
  for (const { file, source } of DRIVES) {
    const lines = code(source).split('\n').map(line => line.trim()).filter(Boolean)
    lines.forEach((line, index) => {
      if (!/\.select\(/.test(line) || !MODEL.test(line)) return
      if (!/\.select\(/.test(lines[index - 1] || '') || !/\[data-compose-field=\\?"provider\\?"\]/.test(lines[index - 1])) unpaired.push(`${file}: ${line}`)
    })
  }
  assert.deepEqual(unpaired, [])
})

test('every compose drive\'s own keyboard walk can start at the top of the menu', () => {
  const noHome = []
  for (const { file, source } of DRIVES) {
    const body = code(source)
    if (!/\[data-compose-field=/.test(body) || !body.includes('async function chooseByKeyboard(')) continue
    const start = body.indexOf('async function chooseByKeyboard(')
    const end = body.indexOf('\n}\n', start)
    const chooser = body.slice(start, end < 0 ? undefined : end)
    if (!/'Home'|pressHome\(/.test(chooser)) noHome.push(file)
  }
  assert.deepEqual(noHome, [], 'these choosers walk only downward from wherever the menu sits')
})
