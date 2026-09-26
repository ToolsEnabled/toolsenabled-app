import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { machineRecordProductDirectory, userDataFor } from '../test-account-harness.mjs'

const readTool = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const codeOnly = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

test('window drivers seed the machine record under the identity of their explicit userData', () => {
  const profile = path.resolve('scratch', 'qa-profile')
  assert.equal(machineRecordProductDirectory(profile), path.basename(userDataFor(profile)))
  assert.throws(() => machineRecordProductDirectory(path.join('scratch', 'qa-profile')), /must be an absolute path/)

  for (const name of ['agent-start-flow-qa.mjs', 'agent-subpage-qa.mjs']) {
    const source = codeOnly(readTool(name))
    assert.match(source, /machineRecordProductDirectory\(profile\)/, `${name} must derive the product directory from userDataFor(profile)`)
    assert.match(source, /path\.join\(profile, 'local', productDirectory\)/, `${name} must seed LOCALAPPDATA under the derived identity`)
    assert.match(source, /`--user-data-dir=\$\{userData\}`/, `${name} must launch with the same named userData value`)
    assert.doesNotMatch(source, /path\.join\(profile, 'local', 'ToolsEnabled'\)/, `${name} restored the stale literal product identity`)
  }
})

test('agent subpage uses the shared bounded debugger transport', () => {
  const source = codeOnly(readTool('agent-subpage-qa.mjs'))
  assert.match(source,
    /import \{[^}]*\bcreateSession\b[^}]*\} from '\.\/test-account-harness\.mjs'/s,
    'the driver must use the behavior-tested debugger transport')
  assert.match(source, /createSession\(port, child, \{\}\)/,
    'the shared transport requires a writable per-window timeline')
  assert.doesNotMatch(source, /function\s+createSession\s*\(/,
    'an unbounded local debugger transport must not shadow the shared one')
  assert.match(source, /location\.hash = '#\/agent\/c1\/codex'/,
    'hash navigation must remount the agent view after the example-data setting changes')
  assert.doesNotMatch(source, /location\.reload\(\)|Page\.reload/,
    'a full reload can leave the packaged Electron CDP target open but permanently mute')
})

test('agent start flow canonicalizes its newly created trusted-alias profile before recording any workspace path', () => {
  const source = codeOnly(readTool('agent-start-flow-qa.mjs'))
  const createdAt = source.indexOf("mkdirSync(profileEntry, { recursive: true })")
  const canonicalAt = source.indexOf('const profile = canonicalizeCreatedQaProfile(profileEntry, {')
  const trustedAliasAt = source.indexOf('trustedProfileAliasRoot: trustedProfileShortAliasRoot(accountHome)', canonicalAt)
  const seededAt = source.indexOf('seedMachineRecord(profile,', canonicalAt)

  assert.ok(createdAt >= 0 && canonicalAt > createdAt,
    'the driver must only resolve the QA profile directory it just created')
  assert.ok(trustedAliasAt > canonicalAt && seededAt > trustedAliasAt,
    'machine-record paths must use the canonical profile after the independently trusted alias gate')
})

test('state-root drivers ask their measured payload where its machine record belongs', () => {
  for (const [name, expectedUses] of [
    ['agent-tool-sweep-qa.mjs', 1],
    ['agent-tools-matrix-qa.mjs', 3],
  ]) {
    const source = codeOnly(readTool(name))
    const createdAt = source.indexOf('SCRATCH_ENTRY = mkdtempSync(')
    const canonicalAt = source.indexOf('SCRATCH = canonicalizeCreatedQaProfile(SCRATCH_ENTRY, {', createdAt)
    const trustedAliasAt = source.indexOf('trustedProfileAliasRoot: trustedProfileShortAliasRoot(accountHome)', canonicalAt)
    const stateRootAt = source.indexOf('process.env.TOOLSENABLED_STATE_ROOT =')
    const payloadAt = source.indexOf("machineRecord = require_(path.join(PAYLOAD, 'src/lib/setup/machine-record.js'))")
    const mainTryAt = source.indexOf('try {', source.indexOf('async function main()'))
    const cleanupFinallyAt = source.lastIndexOf('} finally {')
    const ownedRemovalAt = source.indexOf('rmSync(ownedEntry, { recursive: true, force: true, maxRetries: 5 })', cleanupFinallyAt)
    const uses = source.match(/machineRecord\.resolveServicesRoot\(\{\}\)/g) ?? []

    assert.ok(createdAt >= 0 && canonicalAt > createdAt,
      `${name} must only canonicalize the scratch directory it just created`)
    assert.ok(trustedAliasAt > canonicalAt && stateRootAt > trustedAliasAt && payloadAt > stateRootAt,
      `${name} must trust-gate the account alias, establish canonical state paths, and only then load the payload resolver`)
    assert.ok(mainTryAt >= 0 && createdAt > mainTryAt && cleanupFinallyAt > payloadAt && ownedRemovalAt > cleanupFinallyAt,
      `${name} must own cleanup before creating scratch so initialization failures cannot leak a profile`)
    assert.equal(uses.length, expectedUses, `${name} must resolve every seeded machine-record root through the payload`)
    assert.doesNotMatch(source, /path\.join\(process\.env\.LOCALAPPDATA, 'ToolsEnabled'\)/, `${name} restored the stale literal product identity`)
  }
})

test('tool matrix observes broker exits, clears RPC deadlines, and awaits each shutdown', () => {
  const source = codeOnly(readTool('agent-tools-matrix-qa.mjs'))
  assert.match(source,
    /machineRecord\.writeMcpConfig\(assistantConfigRecord\(record\), \{[\s\S]*?targetDirectory: dispatchRoot,[\s\S]*?stateRoot: process\.env\.TOOLSENABLED_STATE_ROOT/,
    'the Claude document must stamp the same disposable state root as the measured Codex document')
  assert.match(source, /child\.on\('error', markProcessError\)/,
    'process errors must stay observed across graceful and forced kill attempts')
  assert.match(source, /child\.once\('exit',/)
  assert.match(source, /child\.once\('close',/)
  assert.match(source, /child\.stdin\.on\('error', markTransportError\)/,
    'stdin EPIPE must reject pending calls instead of becoming an uncaught stream error')
  assert.match(source, /if \(timer !== null\) clearTimeout\(timer\)/,
    'successful and rejected JSON-RPC calls must disarm their deadlines')
  assert.match(source, /child\.stdin\.write\([\s\S]*?error => \{/,
    'a failed stdin write must reject its own call instead of waiting for the deadline')
  assert.ok((source.match(/await server\.stop\(\)/g) ?? []).length >= 3,
    'every matrix broker lifecycle must await shutdown before the next broker starts')
  const reapAt = source.indexOf('reapDescendants(child.pid)')
  const endAt = source.indexOf('child.stdin.end()', reapAt)
  const killAt = source.indexOf('child.kill()', endAt)
  assert.ok(reapAt >= 0 && endAt > reapAt && killAt > endAt,
    'descendants must be reaped before EOF or an explicit kill can sever their parent links')
  assert.match(source, /timeoutMs: 15_000/,
    'the expected optional Playwright refusal must not consume a full broker deadline')
  assert.match(source,
    /child\.kill\('SIGKILL'\)[\s\S]*?if \(await awaitClose\(1_500\)\) \{ assertReaped\(\); return \}[\s\S]*?destroyPipes\(\)/,
    'a forced root exit without close must release every local pipe handle')
  assert.match(source, /let reapError = null[\s\S]*?assertReaped\(\)/,
    'a process-snapshot failure must propagate after local root and pipe cleanup')
  assert.doesNotMatch(source, /try \{ reapDescendants\(child\.pid\) \} catch \{[^}]*\}/,
    'PROCESS_SNAPSHOT_UNAVAILABLE must never be swallowed as proof of an empty tree')
  assert.match(source,
    /if \(rootExited\(\)\)[\s\S]*?Number\.isSafeInteger\(child\.pid\)[\s\S]*?exited before shutdown could verify and reap/,
    'an already-exited broker with a real pid has an unprovable descendant state and must fail closed')
  assert.doesNotMatch(source, /markTerminal\('failed to start'/,
    'a ChildProcess error does not prove that a real-pid process exited')
  assert.match(source, /if \(!rootExited\(\) && Number\.isSafeInteger\(child\.pid\)\)/,
    'a process-error event must not bypass the final live-root failure')
  assert.match(source,
    /const provenPreSpawnRefusal = allowProvenPreSpawnRefusal[\s\S]*?closeArrived[\s\S]*?responseCount === 0[\s\S]*?child\.exitCode === 2[\s\S]*?stderr === `\$\{PLAYWRIGHT_NO_OWNER_MESSAGE\}\\n`/,
    'the sole preterminal exception must be a closed, response-free, exact Playwright pre-spawn refusal')
  assert.match(source,
    /const attachAt = startBody\.indexOf\('const ownerSession = owner\.attach\(\)'\)[\s\S]*?const upstreamSpawnAt = startBody\.indexOf\('const upstream = spawn\('[\s\S]*?upstreamSpawnAt > attachAt[\s\S]*?!startBody\.slice\(0, attachAt\)\.includes\('spawn\('\)/,
    'the exception must be disabled unless the staged gateway proves owner attachment precedes its first upstream spawn')
  assert.match(source,
    /browserOwner\.attach\(\)[\s\S]*?error\?\.code === 'BROWSER_OWNER_REQUIRED'[\s\S]*?error\?\.message === PLAYWRIGHT_NO_OWNER_MESSAGE/,
    'the scratch payload itself must reproduce the exact no-owner precondition before the exception is armed')
  const finallyAt = source.indexOf('} finally {', source.indexOf('async function main()'))
  const scratchRemovalAt = source.indexOf('rmSync(ownedEntry, { recursive: true, force: true, maxRetries: 5 })', finallyAt)
  assert.ok(finallyAt >= 0 && scratchRemovalAt > finallyAt,
    'the matrix must remove its canonical disposable profile after success or failure')
})

test('tool sweep distinguishes deadlines from broker failure and reaps every server lifecycle', () => {
  const source = codeOnly(readTool('agent-tool-sweep-qa.mjs'))
  assert.match(source, /child\.on\('error', markProcessError\)/,
    'process errors must remain observed during every shutdown attempt')
  assert.match(source, /child\.once\('exit',/)
  assert.match(source, /child\.once\('close',/)
  assert.match(source, /child\.stdin\.on\('error', markTransportError\)/,
    'stdin EPIPE must become a FAILED transport observation rather than an uncaught error')
  assert.match(source, /if \(timer !== null\) clearTimeout\(timer\)/,
    'every completed sweep RPC must disarm its deadline')
  assert.match(source,
    /if \(answer && answer\.__timeout\)[\s\S]*?verdict: 'HUNG'[\s\S]*?if \(answer && answer\.__transportError\)[\s\S]*?verdict: 'FAILED'/,
    'only a real deadline may be classified HUNG; broker and pipe failures are FAILED')
  assert.match(source,
    /if \(rootExited\(\)\)[\s\S]*?Number\.isSafeInteger\(child\.pid\)[\s\S]*?exited before shutdown could verify and reap/,
    'an already-exited broker with a real pid must not certify an unknowable descendant state')
  assert.doesNotMatch(source, /markTerminal\('failed to start'/,
    'a process-error event is a FAILED transport, not proof that the root exited')
  assert.match(source, /if \(!rootExited\(\) && Number\.isSafeInteger\(child\.pid\)\)/,
    'a process error must not suppress the final live-root failure')
  assert.ok((source.match(/await server\.stop\(\)/g) ?? []).length >= 3,
    'restart, normal close, and exceptional close must all await server shutdown')
  const reapAt = source.indexOf('reapDescendants(child.pid)')
  const endAt = source.indexOf('child.stdin.end()', reapAt)
  const killAt = source.indexOf('child.kill()', endAt)
  assert.ok(reapAt >= 0 && endAt > reapAt && killAt > endAt,
    'prompt helpers must be reaped before EOF or kill severs their parent links')
  const finallyAt = source.indexOf('} finally {', source.indexOf('async function main()'))
  const scratchRemovalAt = source.indexOf('rmSync(ownedEntry, { recursive: true, force: true, maxRetries: 5 })', finallyAt)
  assert.ok(finallyAt >= 0 && scratchRemovalAt > finallyAt,
    'the canonical disposable profile must be removed after success or failure')
})
