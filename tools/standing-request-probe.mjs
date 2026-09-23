#!/usr/bin/env node

/* WHY A /RequestTree FILING FAILS ON A PACKAGED BUILD — the raw code, not a
 * plausible story.
 *
 * tools/tree-panel-audit-drive.mjs drove the product's own command and got
 * back its generic sentence ("That rule was not filed"), which is the branch
 * the renderer takes when the bridge throws anything it has no specific
 * sentence for. That observation is consistent with several causes and proves
 * none of them, so this probe asks the bridge directly and prints what it
 * actually says, plus the positive control that the same bridge answers a call
 * that is known to work.
 *
 *   node tools/standing-request-probe.mjs
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertIsolated, delay, openWindow, reap, seedMachineRecord, stage } from './test-account-harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

/* WHICH ENGINE THE HOST RESOLVES DECIDES THIS ANSWER, and that is the whole
 * point of running this probe twice.
 *
 * The host loads the r-ledger module from the engine's OWN root
 * (engineRootOf(modulePath) in shell/agent-host.cjs). Point MISSION_CONTROL_
 * ENGINE at the narrating fixture and that root is the fixture directory,
 * which carries no src/lib/r-ledger.js — so filing refuses with
 * AGENT_REQUEST_UNAVAILABLE, and a drive that read that as a product defect
 * would be reporting its own harness. Leave the variable unset and the host
 * resolves the real payload, whose root does carry the module.
 *
 * Filing needs NO SESSION (shell/main.cjs says so at the handler), so the
 * real-payload run below starts no agent and spends nothing.
 */
const FIXTURE = process.argv.includes('--fixture-engine')

async function main() {
  if (FIXTURE) process.env.MISSION_CONTROL_ENGINE = path.join(REPO, 'tools/test/fixtures/narrating-engine/src/lib/agent-engine/codex-process.js')
  else delete process.env.MISSION_CONTROL_ENGINE
  console.log(FIXTURE ? 'engine: the narrating FIXTURE' : 'engine: the real payload')
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({
    ok: true, tier: 'guided', isolated: false,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' }, env: {},
  })
  const scratch = mkdtempSync(path.join(tmpdir(), 'standing-request-probe-'))
  try {
    const { executable, appRoot } = await stage(scratch)
    const profile = mkdtempSync(path.join(scratch, 'profile-'))
    for (const leaf of ['userdata', 'local', 'home', 'roaming']) mkdirSync(path.join(profile, leaf), { recursive: true })
    seedMachineRecord(profile, appRoot)
    const window = await openWindow(executable, profile)
    try {
      await delay(2500)
      assertIsolated(profile)
      await window.evaluate("location.hash = '#/computers'")
      await delay(900)
      await window.evaluate('location.reload()')
      await delay(3500)

      /* POSITIVE CONTROL FIRST: a call on the same bridge that is known to
         work. If this fails too, the finding is "no bridge", not "requests". */
      const control = await window.evaluate(`(async () => {
        try { return { ok: true, answer: await window.mcAgent.availability() } }
        catch (error) { return { ok: false, message: String(error && error.message).slice(0, 300) } }
      })()`)
      console.log('control  mcAgent.availability() ->', JSON.stringify(control))

      const has = await window.evaluate('typeof window.mcAgent?.request + " / " + typeof window.mcAgent?.requests')
      console.log('bridge   typeof request / requests ->', has)

      const filed = await window.evaluate(`(async () => {
        try { return { threw: false, answer: await window.mcAgent.request({ scope: 'tree', key: 'probe-node', words: 'Never write outside this folder.' }) } }
        catch (error) { return { threw: true, message: String(error && error.message).slice(0, 400) } }
      })()`)
      console.log('write    mcAgent.request(tree) ->', JSON.stringify(filed))

      const read = await window.evaluate(`(async () => {
        try { return { threw: false, answer: await window.mcAgent.requests({ scope: 'tree', key: 'probe-node' }) } }
        catch (error) { return { threw: true, message: String(error && error.message).slice(0, 400) } }
      })()`)
      console.log('read     mcAgent.requests(tree) ->', JSON.stringify(read))

      const global_ = await window.evaluate(`(async () => {
        try { return { threw: false, answer: await window.mcAgent.requests({ scope: 'global' }) } }
        catch (error) { return { threw: true, message: String(error && error.message).slice(0, 400) } }
      })()`)
      console.log('read     mcAgent.requests(global) ->', JSON.stringify(global_))
    } finally {
      try { await window.evaluate('window.close()') } catch { /* already gone */ }
      reap(window.child?.pid)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  }
}

await main()
