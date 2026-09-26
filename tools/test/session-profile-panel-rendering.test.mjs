import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { parseAst } from 'rollup/parseAst'
import { controlState } from '../../src/components.js'
import { profileControls } from '../../src/session-profile-controls.js'
import { PROFILE_PANEL } from '../../src/fleet-tree-copy.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

// Execute the actual closure-private panel, not a second rendering of the
// control decisions. The stand-in checks text, attributes and event wiring;
// it deliberately makes no claims about native layout or OS dialog behavior.
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const ast = parseAst(source)
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const value of Object.values(node)) {
    if (!value || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      for (const child of value) { const found = find(child, predicate); if (found) return found }
    } else { const found = find(value, predicate); if (found) return found }
  }
  return null
}
const panelNode = find(ast, node => node.type === 'FunctionDeclaration' && node.id?.name === 'mountProfilePanel')
const escapeNode = find(ast, node => node.type === 'VariableDeclarator' && node.id?.name === 'escapeMarkup')
assert.ok(panelNode && escapeNode)
const escapeMarkup = new Function(`return (${source.slice(escapeNode.init.start, escapeNode.init.end)})`)()

async function mount(bridge) {
  const dom = installDomStandIn()
  const slots = []
  const panel = new Function('window', 'mockSource', 'exampleExitSentence', 'readComposeFolders',
    'escapeMarkup', 'PROFILE_PANEL', 'controlState', 'profileControls', 'refusalCode',
    `return (${source.slice(panelNode.start, panelNode.end)})`
  )({ mcAgent: bridge }, () => false, () => '', async () => {
    const value = typeof bridge?.profiles === 'function' ? await bridge.profiles().catch(() => null) : null
    slots.push(value)
    return value
  },
    escapeMarkup, PROFILE_PANEL, controlState, profileControls, error => error?.code || '')
  const slot = dom.document.createElement('section')
  dom.document.body.append(slot)
  try { await panel(slot) } catch (error) { dom.restore(); throw error }
  return { slot, slots, restore: () => dom.restore() }
}

const listed = () => ({
  ok: true, profiles: [{ id: 'fixture-folder', name: 'Fixture folder', cwd: 'fixture-folder-path' }],
})

test('an enabled installed folder picker renders no unsupported warning or misleading accessible name', async () => {
  const view = await mount({
    profiles: async () => listed(), profileCreate: async () => ({ ok: true }), profileRemove: async () => ({ ok: true }),
  })
  try {
    assert.equal(view.slot.querySelector('[data-profile-out]').textContent, '')
    const add = view.slot.querySelector('[data-profile-add]')
    const name = view.slot.querySelector('[data-profile-name]')
    const remove = view.slot.querySelector('[data-profile-remove]')
    assert.equal(add.disabled, false)
    assert.equal(name.disabled, false)
    assert.equal(remove.disabled, false)
    assert.equal(add.getAttribute('title'), null)
    assert.equal(remove.getAttribute('title'), null)
    assert.equal(name.getAttribute('aria-label'), PROFILE_PANEL.namePlaceholder)
    assert.doesNotMatch(view.slot.textContent, /cannot create|cannot remove|computer itself/i)
  } finally { view.restore() }
})

test('a bridge without the native picker renders a disabled picker with an actionable reason, not a disabled list', async () => {
  const view = await mount({ profiles: async () => listed(), profileRemove: async () => ({ ok: true }) })
  try {
    assert.equal(view.slot.querySelector('[data-profile-add]').disabled, true)
    assert.equal(view.slot.querySelector('[data-profile-name]').disabled, true)
    assert.equal(view.slot.querySelector('[data-profile-remove]').disabled, false)
    assert.equal(view.slot.querySelector('[data-profile-out]').textContent, PROFILE_PANEL.addNeedsMachine)
    assert.ok(view.slot.querySelector('[data-profile-add]').getAttribute('aria-label').includes(PROFILE_PANEL.addNeedsMachine))
    assert.match(view.slot.querySelector('[data-profile-list]').textContent, /Fixture folder/)
  } finally { view.restore() }
})

test('a refused profile read disables editing even when the bridge exposes native verbs', async () => {
  const view = await mount({
    profiles: async () => ({ ok: false }), profileCreate: async () => ({ ok: true }), profileRemove: async () => ({ ok: true }),
  })
  try {
    assert.equal(view.slot.querySelector('[data-profile-add]').disabled, true)
    assert.equal(view.slot.querySelector('[data-profile-name]').disabled, true)
    assert.match(view.slot.querySelector('[data-profile-out]').textContent, /could not read session profiles/)
  } finally { view.restore() }
})

test('an enabled picker press reaches the supplied bridge once with the typed name', async () => {
  const requests = []
  const view = await mount({
    profiles: async () => listed(),
    profileCreate: async request => { requests.push(request); return { ok: true } },
    profileRemove: async () => ({ ok: true }),
  })
  try {
    view.slot.querySelector('[data-profile-name]').value = '  Typed fixture name  '
    view.slot.querySelector('[data-profile-add]').click()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(requests, [{ name: 'Typed fixture name' }])
    assert.equal(view.slot.querySelector('[data-profile-out]').textContent, PROFILE_PANEL.cancelled)
  } finally { view.restore() }
})
