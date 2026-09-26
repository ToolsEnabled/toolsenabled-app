// B5 (found by hand on the installed 1.0.46, 2026-09-25): a start the host refused before its
// renderer-safe rethrow reached the window as a sentence with no code, so refusalCode() fell to
// AGENT_SESSION_FAILED and the person was told to reinstall ToolsEnabled -- for a stale role
// binding whose real remedy is "reload the page". These pin the whole path: main converts at the
// window's boundary, and the code that crosses becomes the host's own advice on the page.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { refusalCode, unavailableReason } from '../../src/agent-availability-copy.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const main = readFileSync(root + 'shell/main.cjs', 'utf8')

function handlerBody(channel) {
  const start = main.indexOf(`ipcMain.handle('${channel}'`)
  assert.ok(start >= 0, `${channel} handler exists`)
  const end = main.indexOf('\n})', start)
  assert.ok(end > start, `${channel} handler closes`)
  return main.slice(start, end)
}

function declaration(name) {
  const start = main.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} is declared in main.cjs`)
  const end = main.indexOf('\n}\n', start)
  return main.slice(start, end + 2)
}

test('mc-agent:start rethrows every refusal through rendererSafeAgentError, after the sender check', () => {
  const body = handlerBody('mc-agent:start')
  assert.match(body, /^ipcMain\.handle\('mc-agent:start'[^\n]*\n\s*assertTrustedAgentSender\(event\)\n\s*try \{/)
  assert.match(body, /catch \(error\) \{\n\s*throw rendererSafeAgentError\(error\)\n\s*\}/)
  for (const call of [/return await runEndedRecoveryStart\(/, /return await runImageDraftStart\(/, /return await getAgentCommandSurface\(\)\.run\('agent:start'/]) {
    assert.match(body, call, `${call} is awaited inside the try, so its rejection is converted too`)
  }
})

test('a role-binding refusal leaves main carrying its code as the message', () => {
  const sandbox = {}
  vm.runInNewContext(
    ['AGENT_REFUSAL_ATTRIBUTION_TOKENS', 'rendererSafeAgentError', 'agentIpcError']
      .map(name => name === 'AGENT_REFUSAL_ATTRIBUTION_TOKENS'
        ? main.slice(main.indexOf('const AGENT_REFUSAL_ATTRIBUTION_TOKENS'), main.indexOf('})', main.indexOf('const AGENT_REFUSAL_ATTRIBUTION_TOKENS')) + 2)
        : declaration(name))
      .join('\n') + '\nthis.safe = rendererSafeAgentError; this.fail = agentIpcError',
    sandbox,
  )
  let thrown
  try { sandbox.fail('MC_AGENT_ROLE_STALE', 'The organisation changed after this role was selected. Read the Role library again, then retry the start.') }
  catch (error) { thrown = error }
  const safe = sandbox.safe(thrown)
  assert.equal(safe.message, 'MC_AGENT_ROLE_STALE', 'only the code crosses; the host sentence stays in main')
  assert.equal(sandbox.safe(safe).message, 'MC_AGENT_ROLE_STALE', 'converting twice changes nothing')
})

test('on the page, the code that crossed becomes the host advice, not "reinstall"', () => {
  // What ipcRenderer.invoke rebuilds on the window side: the message, and no own properties.
  const crossed = new Error("Error invoking remote method 'mc-agent:start': Error: MC_AGENT_ROLE_STALE")
  assert.equal(refusalCode(crossed), 'MC_AGENT_ROLE_STALE')
  const sentence = unavailableReason('MC_AGENT_ROLE_STALE', { platform: 'linux' })
  assert.match(sentence, /Reload the page/)
  assert.doesNotMatch(sentence, /reinstall/i)
  // The defect, for contrast: the sentence with no code resolves to the reinstall fallback.
  const before = new Error("Error invoking remote method 'mc-agent:start': Error: The organisation changed after this role was selected. Read the Role library again, then retry the start.")
  assert.equal(refusalCode(before), 'AGENT_SESSION_FAILED')
  assert.match(unavailableReason('AGENT_SESSION_FAILED', { platform: 'linux' }), /reinstall/i)
})
