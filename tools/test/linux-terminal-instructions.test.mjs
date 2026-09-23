/* AN INSTRUCTION A LINUX READER CANNOT FOLLOW.
 *
 * Owner-visible defect, measured on a Linux install of this build before this
 * suite existed. Settings, This computer, said "To sign this folder in, paste
 * this line into Windows Terminal:", and the home screen's engine reason said
 * 'Run "winget install OpenAI.Codex" in Windows Terminal'. Windows Terminal and
 * winget both exist only on Windows, so the product told the owner to run two
 * things their computer does not have.
 *
 * WHY A SWEEP AND NOT THREE CASES. src/agent-availability-copy.js already had
 * a correct platform branch, and tools/test/setup-review-readiness.test.mjs
 * already held ONE accessor to it. The defect was in the accessors that suite
 * did not name: local-activity's engine reasons, fleet-tree-copy's start
 * refusal, and account-panel-copy's command lead. Pinning three more cases
 * would leave the FOURTH one to be found by an owner. So this asks the question
 * of every reader-facing accessor that can name a terminal or an installer, and
 * a new one is added to the list below rather than discovered in the wild.
 *
 * IT CHECKS WINDOWS TOO, on purpose. "No Windows Terminal anywhere" is trivially
 * satisfiable by deleting the Windows instruction, which would break the
 * platform this product primarily ships on. Every case therefore asserts that
 * win32 still gets the Windows noun, so the cheap way green is closed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { unavailableReason, codexSetupInstructions } from '../../src/agent-availability-copy.js'
import { engineReason, codexSignedOutFact } from '../../src/local-activity.js'
import { startRefusalSentence } from '../../src/fleet-tree-copy.js'
import { accountPanelCopy } from '../../src/account-panel-copy.js'
import { readerRemedy } from '../../src/refusal-copy.js'
import { terminalName } from '../../src/terminal-name.js'

const WINDOWS_ONLY = /winget|Windows Terminal/

/* The codes whose answer carries setup instructions. Each is a code the engine
   really emits; an invented one would pass this suite by matching no table. */
const SETUP_CODES = [
  'AGENT_CODEX_CLI_NOT_INSTALLED',
  'AGENT_CONFINEMENT_SIGNED_OUT',
  'CODEX_CLI_NOT_FOUND',
  'CODEX_PROTOCOL_VERSION_MISMATCH',
  'CODEX_CLI_INCOMPATIBLE',
]

/* Every reader-facing accessor that can name a terminal or an installer, called
   with a platform. Add to this list when a new one is written. */
const cases = platform => [
  ...SETUP_CODES.map(code => ({ what: `unavailableReason ${code}`, text: unavailableReason(code, { platform }) })),
  { what: 'unavailableReason CODEX_VERSION_DETECTION_FAILED', text: unavailableReason('CODEX_VERSION_DETECTION_FAILED', { platform }) },
  ...SETUP_CODES.map(code => ({ what: `engineReason ${code}`, text: engineReason(code, { platform }) })),
  { what: 'codexSignedOutFact', text: codexSignedOutFact({ platform }) },
  { what: 'startRefusalSentence AGENT_CODEX_CLI_NOT_INSTALLED', text: startRefusalSentence({ ok: false, code: 'AGENT_CODEX_CLI_NOT_INSTALLED' }, { platform }) },
  { what: 'startRefusalSentence CODEX_CLI_NOT_FOUND', text: startRefusalSentence({ ok: false, code: 'CODEX_CLI_NOT_FOUND' }, { platform }) },
  { what: 'codexSetupInstructions signIn', text: codexSetupInstructions({ platform }).signIn },
  { what: 'codexSetupInstructions install', text: codexSetupInstructions({ platform }).install.join(' ') },
  /* The Settings, This computer, accounts panel. Added after a mutation check
     showed the sweep above stayed green while this sentence was hard-coded
     back to Windows Terminal: only the twin test below caught it, and a sweep
     that misses a reader-facing sentence is the gap this file exists to close.
     It takes no platform argument, so it is read through terminalName()'s own
     default, which is why that default has a test of its own. */
  { what: 'ACCOUNT_PANEL.commandLead', text: accountPanelCopy({ viaRelay: false }).commandLead, ambientNoun: true },
  { what: 'ACCOUNT_PANEL.commandLead via relay', text: accountPanelCopy({ viaRelay: true }).commandLead, ambientNoun: true },
]

for (const platform of ['linux', 'darwin']) {
  test(`no instruction on ${platform} names Windows Terminal or winget`, () => {
    for (const { what, text } of cases(platform)) {
      assert.ok(typeof text === 'string' && text.length > 0, `${what} said nothing on ${platform}`)
      assert.doesNotMatch(text, WINDOWS_ONLY,
        `${what} on ${platform} tells the reader to use something their computer does not have: ${text}`)
    }
  })
}

test('windows still gets the Windows instruction, so deleting it is not a way to pass', () => {
  /* The ambient-noun entries read terminalName()'s default rather than a
     platform argument, so under node they are neutral on every platform and
     cannot contribute here. Counting them would make this bound unmeetable. */
  const windows = cases('win32').filter(one => !one.ambientNoun)
  const naming = windows.filter(one => WINDOWS_ONLY.test(one.text))
  assert.ok(naming.length >= 8,
    `only ${naming.length} of ${windows.length} win32 instructions still name Windows Terminal or winget; the Windows copy has been removed rather than made conditional`)
})

test('the terminal noun is one decision, and its default is the neutral one', () => {
  assert.equal(terminalName('win32'), 'Windows Terminal')
  assert.equal(terminalName('linux'), 'a terminal')
  assert.equal(terminalName('darwin'), 'a terminal')
  /* A caller that cannot say what platform it is on must not make a specific
     claim that is wrong on two of three platforms. */
  assert.equal(terminalName(undefined), 'a terminal')
})

test('the command-lead sentence still finds its remote twin after the noun moved', () => {
  /* readerRemedy() looks the twin up by EXACT string. The desk sentence and its
     twin key are both built from terminalName(), so they move together; if one
     is ever hard-coded again this returns the desk sentence unchanged and a
     browser reader is told to use the terminal in front of them. */
  const desk = accountPanelCopy({ viaRelay: false }).commandLead
  const twin = readerRemedy(desk, { viaRelay: true })
  assert.notEqual(twin, desk, `no remote twin matched "${desk}"`)
  assert.match(twin, /that computer/)
})

/* AN INCOMPATIBLE CODEX IS TOLD THE ONE COMMAND THAT FIXES IT, ON EVERY PLATFORM.
   The engine refuses a start only for a real incompatibility and says so as
   CODEX_CLI_INCOMPATIBLE (no version is pinned). "codex update" is Codex's own
   updater: it updates the copy that is installed, however it was installed,
   rather than adding a second one. The sentence must not blame "the agent
   connection", which is what this failure used to be called. */
test('an incompatible Codex is told to run codex update, in the terminal the reader has', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const [what, text] of [
      ['unavailableReason', unavailableReason('CODEX_CLI_INCOMPATIBLE', { platform })],
      ['engineReason', engineReason('CODEX_CLI_INCOMPATIBLE', { platform })],
    ]) {
      assert.match(text, /"codex update"/, `${what} on ${platform} does not name the update command: ${text}`)
      assert.match(text, /cannot run a (ToolsEnabled )?session/, `${what} on ${platform} does not say Codex cannot run the session: ${text}`)
      assert.doesNotMatch(text, /agent connection|could not work out why/, `${what} on ${platform} blames the wrong thing: ${text}`)
    }
  }
  assert.match(unavailableReason('CODEX_CLI_INCOMPATIBLE', { platform: 'win32' }), /Windows Terminal/)
})
