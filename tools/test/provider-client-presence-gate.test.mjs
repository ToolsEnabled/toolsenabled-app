/* ONE WORD ANSWERING FOR TWO DIFFERENT PROGRAMS.
 *
 * A Gemini agent can run under two different clients on one computer, and each
 * is a different executable: the plain Gemini CLI is `gemini`, and Antigravity
 * is `agy`. The account registry already knows the difference -- rotation.js
 * filters accountsFor(registry, provider) by (account.client || null) === client
 * and refuses rather than letting one client's account stand in for another's.
 *
 * TWO LAYERS ABOVE IT DID NOT KNOW THE DIFFERENCE.
 *
 *   shell/provider-cli-presence.cjs answered the Gemini row with an OR across
 *   both executables: agy present OR gemini present reported `installed: 'yes'`.
 *   One word, two programs.
 *
 *   src/account-switcher.js decided add-button visibility from
 *   `programs[button.dataset.provider]` alone, ignoring dataset.client, even
 *   though the Antigravity button is declared data-provider="gemini"
 *   data-client="antigravity".
 *
 * SO EACH CONTROL COULD BE OFFERED WITH ITS EXECUTABLE ABSENT. On a machine
 * with agy and no gemini, the OR reported gemini installed and the PLAIN Gemini
 * add button appeared. On a machine with gemini and no agy, the same word was
 * 'yes' and the ANTIGRAVITY button appeared with no agy behind it.
 *
 * Neither is what a person on this machine hit: here agy 1.2.0 and gemini
 * 0.58.0 are both installed, so both controls are correctly pressable and the
 * Antigravity start failed for a different and correct reason -- no registered
 * account carries client antigravity. That refusal is right and is not touched
 * here. What is repaired is the gate one layer earlier, which was giving the
 * right answer on this machine by luck rather than by asking.
 *
 * WHAT THIS FILE ASSERTS IS THE PAIR OF MACHINES THAT EXPOSE IT: agy without
 * gemini, and gemini without agy. On today's code the first two tests report
 * the wrong word and the last two draw the wrong button.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { providerCliPresence } = require_(path.join(REPO_ROOT, 'shell', 'provider-cli-presence.cjs'))

/* A Linux machine carrying exactly the named commands on its PATH and nothing
   else. Every reader is injected, so nothing here consults the real computer. */
function machineCarrying(commands) {
  const present = new Set(commands.map(command => path.posix.join('/programs', command)))
  return {
    platform: 'linux',
    env: { PATH: '/programs' },
    homedir: () => '/home/somebody',
    searchPath: { directories: ['/programs'], complete: true },
    statSync: candidate => {
      if (!present.has(candidate)) throw Object.assign(new Error('nothing here'), { code: 'ENOENT' })
      return { isFile: () => true }
    },
    accessSync: () => {},
    existsSync: () => false,
  }
}

const providerRow = (answer, id) => answer.providers.find(provider => provider.id === id)
const clientRow = (answer, provider, client) => (answer.clients || [])
  .find(row => row.provider === provider && row.client === client)

test('a machine with Antigravity and no Gemini CLI does not report the plain Gemini program installed', () => {
  const answer = providerCliPresence(machineCarrying(['agy', 'codex', 'claude']))

  assert.equal(providerRow(answer, 'gemini').installed, 'no',
    'the Gemini CLI is absent from this machine, and the Antigravity executable must not answer for it')
  assert.deepEqual(clientRow(answer, 'gemini', 'antigravity'), { provider: 'gemini', client: 'antigravity', installed: 'yes' },
    'the client axis must report the Antigravity executable in its own right')
})

test('a machine with the Gemini CLI and no Antigravity does not report the Antigravity program installed', () => {
  const answer = providerCliPresence(machineCarrying(['gemini', 'codex', 'claude']))

  assert.equal(providerRow(answer, 'gemini').installed, 'yes')
  assert.deepEqual(clientRow(answer, 'gemini', 'antigravity'), { provider: 'gemini', client: 'antigravity', installed: 'no' },
    'the Antigravity executable is absent and must be reported absent, whatever the Gemini CLI answers')
})

test('the client rows stay in the closed-set vocabulary and carry no path', () => {
  const answer = providerCliPresence(machineCarrying(['agy', 'gemini']))
  assert.ok(Array.isArray(answer.clients) && answer.clients.length > 0, 'the reply must carry a client axis')
  for (const row of answer.clients) {
    assert.deepEqual(Object.keys(row).sort(), ['client', 'installed', 'provider'],
      'a client row may carry nothing but the two names and one word')
    assert.ok(['yes', 'no', 'unknown'].includes(row.installed), row.installed)
    for (const value of Object.values(row)) {
      assert.equal(typeof value, 'string')
      assert.doesNotMatch(value, /[/\\]/, 'no field crossing to the renderer may carry a path')
    }
  }
})

/* ------------------------------------------------------------------
   THE GATE THE PERSON ACTUALLY SEES.
   Mounted on the same document stand-in tools/test/account-switcher-dom.test.mjs
   uses, with a presence reply whose two clients disagree. A button whose own
   executable is absent must not be offered, and one whose executable is present
   must not be withdrawn because the other client's is missing.
   ------------------------------------------------------------------ */
const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
const { register } = await import('node:module')
register('./css-loader.mjs', import.meta.url)
const dom = installDomStandIn()
const { document } = dom
document.addEventListener = () => {}
document.removeEventListener = () => {}
const { accountSwitcher } = await import('../../src/account-switcher.js')

const drain = async () => { for (let turn = 0; turn < 3; turn += 1) await new Promise(done => setImmediate(done)) }

async function mountWith({ gemini, antigravity }) {
  const bridge = {
    accounts: async () => ({ ok: true, accounts: [{ provider: 'gemini', name: 'Current Gemini CLI', client: null }], policy: {} }),
    presence: async () => ({
      ok: true,
      providers: [
        { id: 'codex', installed: 'yes', signedIn: 'unknown' },
        { id: 'claude', installed: 'yes', signedIn: 'unknown' },
        { id: 'gemini', installed: gemini, signedIn: 'unknown' },
        { id: 'grok', installed: 'yes', signedIn: 'unknown' },
      ],
      clients: [{ provider: 'gemini', client: 'antigravity', installed: antigravity }],
    }),
  }
  const root = accountSwitcher({ scope: { mcProviders: bridge } })
  document.body.appendChild(root)
  await drain()
  // The add buttons are gated when the menu opens, which is when a person can
  // reach them; asserting before that would measure an unpainted control.
  root.querySelector('.acct-trigger').click()
  await drain()
  const buttons = [...root.querySelectorAll('[data-acct="add-provider"]')]
  return {
    destroy: () => { root.__accountSwitcher.destroy(); root.remove() },
    plainGemini: buttons.find(button => button.dataset.provider === 'gemini' && !button.dataset.client),
    antigravity: buttons.find(button => button.dataset.provider === 'gemini' && button.dataset.client === 'antigravity'),
  }
}

test('the plain Gemini add button is withdrawn when only the Antigravity executable is present', async () => {
  const menu = await mountWith({ gemini: 'no', antigravity: 'yes' })
  try {
    assert.equal(menu.plainGemini.hidden, true, 'the Gemini CLI is absent, so its add button must not be offered')
    assert.equal(menu.antigravity.hidden, false, 'Antigravity is installed and must stay offered')
    assert.equal(menu.antigravity.disabled, false)
  } finally { menu.destroy() }
})

test('the Antigravity add button is withdrawn when only the Gemini CLI is present', async () => {
  const menu = await mountWith({ gemini: 'yes', antigravity: 'no' })
  try {
    assert.equal(menu.antigravity.hidden, true, 'the Antigravity executable is absent, so its add button must not be offered')
    assert.equal(menu.plainGemini.hidden, false, 'the Gemini CLI is installed and must stay offered')
    assert.equal(menu.plainGemini.disabled, false)
  } finally { menu.destroy() }
})

test('an unknown client answer withdraws nothing, the same way an unknown provider answer does not', async () => {
  const menu = await mountWith({ gemini: 'unknown', antigravity: 'unknown' })
  try {
    assert.equal(menu.plainGemini.hidden, false, 'unknown is not absent')
    assert.equal(menu.antigravity.hidden, false, 'unknown is not absent')
  } finally { menu.destroy() }
})
