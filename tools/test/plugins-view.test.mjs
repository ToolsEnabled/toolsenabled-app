/* src/views/plugins.js, driven: what the status line says after Save and
 * Withdraw, and what happens when the bridge rejects.
 *
 * plugins-markup.test.mjs proves the page's markup; this proves the page's
 * behaviour, which the markup cannot. Three defects it was written to catch,
 * each seen red against the plugin lane's view before the fix (release
 * integration, 1.0.49):
 *
 *   1. THE ANSWER WAS OVERWRITTEN. Save and Withdraw said their result and then
 *      refreshed the list in a finally block, and refresh() says "Reading…" and
 *      then the plugin count. The engine's own refusal sentence, or "This takes
 *      effect the next time you open the app", was on screen for milliseconds.
 *   2. A REJECTED BRIDGE CALL WAS UNHANDLED. There was no catch around
 *      bridge.grant()/bridge.revoke(), so an IPC failure became an unhandled
 *      rejection and the person was told nothing about their click.
 *   3. DOUBLE ESCAPING. The first-load failure ran esc() on text that say() then
 *      set through textContent, so "a < b" reached the screen as "a &lt; b".
 *
 * The DOM is the repository's stand-in (tools/test/lib/dom-stand-in.mjs), whose
 * selector subset does not include the compound checkbox selector the view uses
 * to read the ticked boxes; that is why no assertion here is about WHICH
 * capabilities a Save sends -- plugins-markup and the engine's grants suite own
 * that. Run: node --test tools/test/plugins-view.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

import { installDomStandIn } from './lib/dom-stand-in.mjs'

register('./css-loader.mjs', import.meta.url)
installDomStandIn()

const { pluginsView } = await import('../../src/views/plugins.js')

const SHA = 'febdd76b95423581f2c6bc062a66f6b11e66827b05af3dd7adfaf5eee47843c5'

function listing() {
  return {
    ok: true,
    root: '/p',
    refused: [],
    packages: [{
      id: 'plugin-febdd76b95423581', sha256: SHA, name: 'notes', displayName: 'Notes',
      summary: 'Keeps a searchable index of your own notes.',
      requested: ['subprocess'], granted: ['subprocess'], inForce: ['subprocess'], withheld: [],
      effectFloor: 'local-write', tools: [], roleCount: 0,
      declaresSettings: false, declaresRestrictions: false, hasSkin: false,
      settings: [], limits: null, skin: {}, contributionsRefused: [],
      grantedAt: '2026-09-26T12:00:00Z', grantedBy: 'the person using this computer', revoked: null,
    }],
  }
}

/* A bridge whose answers the test chooses, counting its calls. */
function bridge({ grant, revoke, list } = {}) {
  const calls = { list: 0, grant: 0, revoke: 0 }
  return {
    calls,
    async list() { calls.list += 1; return list ? list() : listing() },
    async grant(request) { calls.grant += 1; return grant(request) },
    async revoke(request) { calls.revoke += 1; return revoke(request) },
  }
}

/* Let every pending promise and its continuations run. */
async function settle() {
  for (let index = 0; index < 20; index += 1) await new Promise(resolve => setImmediate(resolve))
}

/* Unhandled rejections are collected, not thrown, so a test can say which click
   produced one; each test asserts the list is empty at its end. */
const unhandled = []
process.on('unhandledRejection', reason => { unhandled.push(reason) })

async function mounted(plugins) {
  const view = pluginsView({ plugins })
  await settle()
  const status = () => view.el.querySelector('[data-plugins-status]')
  return { view, status }
}

function click(view, selector) {
  const button = view.el.querySelector(selector)
  assert.ok(button, `no ${selector} on the page`)
  button.dispatchEvent({ type: 'click' })
}

test('after Save, the status line keeps the answer rather than the plugin count', async () => {
  unhandled.length = 0
  const plugins = bridge({ grant: () => ({ ok: true, capabilities: ['subprocess'] }) })
  const { view, status } = await mounted(plugins)
  assert.match(status().textContent, /^1 plugin, 1 allowed something$/)

  click(view, '.plugin-save')
  await settle()
  assert.equal(plugins.calls.grant, 1)
  assert.equal(plugins.calls.list, 2, 'the list is read again so the cards show what is in force')
  // In the row titles the person ticked, never the capability's internal name
  // (1.0.49 plugins walk: "Allowed: subprocess, roles").
  assert.equal(status().textContent, 'Saved. It may run the programs it ships. This takes effect the next time you open the app.')
  assert.match(status().className, /is-good/)
  assert.deepEqual(unhandled, [])
})

test('a refused Save shows the engine’s own sentence, and it stays', async () => {
  unhandled.length = 0
  const reason = 'network was not requested by this plugin, so it cannot be allowed. Nothing was changed.'
  const plugins = bridge({ grant: () => ({ ok: false, code: 'PLUGIN_CAPABILITY_NOT_REQUESTED', reason }) })
  const { view, status } = await mounted(plugins)
  click(view, '.plugin-save')
  await settle()
  assert.equal(status().textContent, reason)
  assert.match(status().className, /is-bad/)
  assert.ok(!status().textContent.includes('PLUGIN_CAPABILITY_NOT_REQUESTED'), 'the code is not the sentence')
  assert.deepEqual(unhandled, [])
})

test('after Withdraw, the status line keeps what was withdrawn', async () => {
  unhandled.length = 0
  const plugins = bridge({ revoke: () => ({ ok: true, removed: true, withdrawn: ['subprocess'] }) })
  const { view, status } = await mounted(plugins)
  click(view, '.plugin-revoke')
  await settle()
  assert.equal(plugins.calls.revoke, 1)
  assert.equal(status().textContent,
    'Withdrawn. It may no longer run the programs it ships. That takes effect the next time you open the app.')
  assert.deepEqual(unhandled, [])
})

test('a bridge that rejects on Save or Withdraw is answered on the page, not left unhandled', async () => {
  for (const [selector, verb] of [['.plugin-save', 'grant'], ['.plugin-revoke', 'revoke']]) {
    unhandled.length = 0
    const plugins = bridge({ [verb]: () => { throw new Error('the engine did not answer') } })
    const { view, status } = await mounted(plugins)
    click(view, selector)
    await settle()
    assert.deepEqual(unhandled.map(reason => String(reason && reason.message)), [],
      `a rejected ${verb} became an unhandled rejection`)
    assert.match(status().textContent, /the engine did not answer/, `${verb}: the person is told why`)
    assert.match(status().textContent, /Refresh to see what is in force now/)
    assert.match(status().className, /is-bad/)
    assert.equal(plugins.calls.list, 2, `${verb}: the list is still read again`)
    const button = view.el.querySelector(selector)
    assert.ok(button && !button.disabled, `${verb}: the button is usable again`)
  }
})

test('a first read that rejects is said once, with its text as written', async () => {
  unhandled.length = 0
  const plugins = bridge({ list: () => { throw new Error('state root <missing> & unreadable') } })
  const { view, status } = await mounted(plugins)
  assert.doesNotMatch(status().textContent, /&lt;|&amp;/, 'escaped twice: textContent already makes it text')
  assert.match(status().textContent, /state root <missing> & unreadable/)
  assert.match(status().className, /is-bad/)
  // And the list says it could not be read, rather than looking empty.
  assert.match(view.el.querySelector('[data-plugins-list]').textContent, /The plugin list could not be read/)
  assert.deepEqual(unhandled, [])
})

test('Save and Withdraw name two or more capabilities by their row titles', async () => {
  unhandled.length = 0
  const plugins = bridge({
    grant: () => ({ ok: true, capabilities: ['subprocess', 'roles'] }),
    revoke: () => ({ ok: true, removed: true, withdrawn: ['subprocess', 'roles', 'skin'] }),
  })
  const { view, status } = await mounted(plugins)
  click(view, '.plugin-save')
  await settle()
  assert.equal(status().textContent,
    'Saved. It may run the programs it ships and add roles. This takes effect the next time you open the app.')
  assert.ok(!/subprocess/.test(status().textContent))
  click(view, '.plugin-revoke')
  await settle()
  assert.equal(status().textContent, 'Withdrawn. It may no longer run the programs it ships, add roles or set a few '
    + 'colours. That takes effect the next time you open the app.')
  assert.deepEqual(unhandled, [])
})
