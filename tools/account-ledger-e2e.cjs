'use strict'

/* PROOF, BY DOING IT, that customer-facing actions reach the signed ledger.
 *
 * The product claims a tamper-evident ledger records what happened. Measured on
 * 2026-08-12 that was false for everything this window does: creating an
 * account, signing in and failing a sign-in wrote ZERO rows. This harness is
 * the standing check that it is no longer false, and it is deliberately built
 * so that reading the CODE cannot make it pass -- it boots the REAL
 * shell/main.cjs, drives the REAL contextBridge surface the way a person would,
 * and then reads the ledger back through the payload's own reader.
 *
 * WHAT IT ASSERTS, IN ORDER:
 *   1. the ledger's height BEFORE the actions
 *   2. a real account creation, a real successful sign-in, a real FAILED
 *      sign-in, all through window.mcAccount
 *   3. those actions are present in the chain afterwards, by action name
 *   4. audit.verify() still returns valid -- writing must not cost integrity
 *   5. no password, verifier or raw username appears anywhere in the new rows
 *
 * Step 5 exists because the cheapest way to make steps 3 and 4 pass is to write
 * the whole request into the ledger, and a ledger that is impossible to edit is
 * the worst possible place to have put somebody's password.
 *
 * Verified by exit code. Any failed step exits non-zero.
 */

const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { reapDescendants } = require('./process-tree.cjs')

const APP_ROOT = process.env.MC_APP_ROOT || path.resolve(__dirname, '..')
const TIMEOUT_MS = 240_000

/* The credentials this harness uses. The password is a throwaway that exists
   for the length of one process and is never recorded anywhere by design --
   step 5 fails the run if it turns up in the ledger. The username is marked so
   that a human reading the account list later knows what made it. */
const PROOF_USERNAME = `ledger-proof-${Date.now().toString(36)}`
const PROOF_PASSWORD = 'correct horse battery staple 9174'
const WRONG_PASSWORD = 'this is not the password 4471'

const steps = []
function step(name, ok, detail) {
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`)
}

let finishing = false
function finish(code) {
  if (finishing) return
  finishing = true
  const reaped = reapDescendants(process.pid)
  if (reaped > 0) console.log(`[ledger-e2e] reaped ${reaped} descendant process(es) before exit`)
  app.exit(code)
}

function fatal(message) {
  console.error('LEDGER E2E FATAL: ' + message)
  finish(20)
}

// Boot the real application.
require(path.join(APP_ROOT, 'shell', 'main.cjs'))

async function windowReady() {
  const deadline = Date.now() + 60_000
  for (;;) {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
    if (win) {
      if (win.webContents.isLoading()) {
        await new Promise(resolve => win.webContents.once('did-finish-load', resolve))
      }
      return win
    }
    if (Date.now() > deadline) throw new Error('no BrowserWindow appeared within 60s')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/* THE READER IS THE PAYLOAD'S OWN, not a re-implementation. A harness that
   parsed the SQLite file itself could agree with a writer that both had wrong;
   this asks the same module the product asks. The state root is resolved the
   same way shell/main.cjs resolves it, for the same reason. */
function ledgerReader() {
  const stateRoot = path.join(app.getPath('userData'), 'capability')
  process.env.TOOLSENABLED_STATE_ROOT = stateRoot
  const { resolveCapabilityRoot } = require(path.join(APP_ROOT, 'shell', 'capability-layer.cjs'))
  const root = resolveCapabilityRoot()
  if (!root) throw new Error('no capability payload is present, so there is no ledger to read')
  return { audit: require(path.join(root, 'src', 'lib', 'audit.js')), stateRoot }
}

async function run() {
  const { audit, stateRoot } = ledgerReader()
  console.log(`[ledger-e2e] state root: ${stateRoot}`)

  /* headSequence, and ONLY headSequence. An earlier version of this harness
     guessed at `entries ?? count ?? sequence`, all three of which are absent,
     so it compared undefined-coerced-to-0 against itself and reported "the
     ledger grew: added=0" while the four rows it was looking for were sitting
     in the chain two steps below. A fallback chain across names that do not
     exist is not defensive, it is a step that cannot pass. */
  const before = audit.status()
  const beforeCount = before.headSequence
  step('the ledger was readable before the actions', Number.isInteger(beforeCount), `headSequence=${beforeCount}`)

  const win = await windowReady()
  const js = (code) => win.webContents.executeJavaScript(code, true)
  step('the real app window loaded', true, await js('document.title'))

  const surface = await js('JSON.stringify(Object.keys(window.mcAccount || {}).sort())')
  step('window.mcAccount is exposed', JSON.parse(surface).includes('create'), surface)

  /* The three actions, driven from inside the page. */
  const t0 = Date.now()
  const raw = await js(`(async () => {
    const created = await window.mcAccount.create({
      username: ${JSON.stringify(PROOF_USERNAME)},
      displayName: 'Ledger Proof',
      password: ${JSON.stringify(PROOF_PASSWORD)},
    })
    const signedIn = await window.mcAccount.signIn({
      username: ${JSON.stringify(PROOF_USERNAME)},
      password: ${JSON.stringify(PROOF_PASSWORD)},
    })
    const refused = await window.mcAccount.signIn({
      username: ${JSON.stringify(PROOF_USERNAME)},
      password: ${JSON.stringify(WRONG_PASSWORD)},
    })
    return JSON.stringify({
      created: { ok: created.ok === true, code: created.code || null },
      signedIn: { ok: signedIn.ok === true, code: signedIn.code || null },
      refused: { ok: refused.ok === true, code: refused.code || null },
    })
  })()`)
  const actions = JSON.parse(raw)
  const elapsed = Date.now() - t0
  console.log(`[ledger-e2e] three account actions took ${elapsed} ms end to end`)

  step('a real account was created through the UI surface', actions.created.ok === true, JSON.stringify(actions.created))
  step('a real sign-in succeeded through the UI surface', actions.signedIn.ok === true, JSON.stringify(actions.signedIn))
  step('a wrong password was refused', actions.refused.ok === false, JSON.stringify(actions.refused))

  /* ---- now read the chain, which is the only thing that settles it ---- */
  const after = audit.status()
  const afterCount = after.headSequence
  /* SIX, exactly: an intent and an outcome for the creation, and for each of
     the two sign-in attempts. Asserting the number rather than "more than
     before" is what catches the half-wired case where intents are recorded and
     outcomes silently are not. */
  step('the ledger grew by exactly the six records these three actions owe',
    afterCount - beforeCount === 6,
    `before=${beforeCount} after=${afterCount} added=${afterCount - beforeCount}`)

  const expected = [
    'account.create.intent', 'account.create',
    'account.sign_in.intent', 'account.sign_in',
  ]
  const tail = audit.tail({ limit: 40 })
  const rows = Array.isArray(tail) ? tail : (tail.events || tail.entries || [])
  /* Only rows appended by the actions above can prove that those actions were
     recorded. Looking for action names across the unfiltered tail lets rows
     from an earlier run satisfy this run when the six new rows contain the
     wrong actions. Sequence bounds also make a malformed or truncated tail
     fail rather than borrowing evidence from history. */
  const newRows = rows.filter(row => Number.isSafeInteger(row.sequence) &&
    row.sequence > beforeCount && row.sequence <= afterCount)
  step('the tail contains all six newly appended records', newRows.length === 6,
    `new sequences=${JSON.stringify(newRows.map(row => row.sequence))}`)
  const seen = new Set(newRows.map(row => (row.action || row.event?.action)))
  for (const action of expected) {
    step(`the chain holds ${action}`, seen.has(action), `seen=${[...seen].join(',')}`)
  }

  /* The refused sign-in must be there AND must be marked refused -- a ledger
     that records only the successes is the failure mode this whole change is
     about. */
  const signInRows = newRows.filter(row => (row.action || row.event?.action) === 'account.sign_in')
  const outcomes = signInRows.map(row => (row.details || row.event?.details || {}).outcome)
  step('a REFUSED sign-in is in the chain, marked refused',
    outcomes.includes('refused') && outcomes.includes('ok'),
    `outcomes=${JSON.stringify(outcomes)}`)

  /* Nothing secret went in. */
  const blob = JSON.stringify(newRows)
  step('no password reached the ledger', !blob.includes(PROOF_PASSWORD) && !blob.includes(WRONG_PASSWORD))
  step('no raw username reached the ledger', !blob.includes(PROOF_USERNAME))

  /* Integrity, last, because it is the claim that must survive everything
     above. */
  const v0 = Date.now()
  const verified = audit.verify()
  step('audit.verify() still returns valid', verified.valid === true,
    `valid=${verified.valid} errors=${JSON.stringify((verified.errors || []).slice(0, 3))} in ${Date.now() - v0} ms`)
}

app.whenReady().then(() => {
  const guard = setTimeout(() => fatal(`timed out after ${TIMEOUT_MS} ms`), TIMEOUT_MS)
  guard.unref?.()
  run()
    .then(() => {
      const failed = steps.filter(s => !s.ok)
      console.log(`\n${steps.length - failed.length}/${steps.length} steps passed`)
      finish(failed.length === 0 ? 0 : 1)
    })
    .catch(error => fatal(error && error.stack ? error.stack : String(error)))
}).catch(error => fatal(String(error)))
