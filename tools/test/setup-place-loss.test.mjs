/* THE WALKTHROUGH MUST NOT LOSE A PERSON'S PLACE MID-WALK.
 *
 * THE DEFECT, MEASURED ON THE PACKAGED BUILD (fresh profile, machine under
 * load, 2026-08-19, two independent traces in the setup-placeloss lane
 * report): the review drew and was then replaced by the permission question,
 * with no gesture, no hashchange and no reload. Finish never existed.
 *
 * THE TRIGGER, from the trace rather than from a suspect list. Boot render
 * redirects '' -> '#/setup' and returns; the hashchange it fires is a QUEUED
 * task. The checkout-surface probe settled inside that gap (94ms and 96ms in
 * the two traces), and its listener re-entered render() with the hash already
 * naming the walkthrough: setup copy #1 mounted from the probe's event, the
 * queued hashchange then mounted copy #2, and the router's 420ms retirement
 * timer tore copy #1 down. The person's whole walk had happened on copy #1;
 * the glass fell back to copy #2, still sitting on question 1 -- because
 * copy #2 had computed its resume from state that predated every answer.
 *
 * TWO GUARDS, BOTH PINNED HERE BECAUSE NEITHER FILE CAN BE IMPORTED WITHOUT A
 * DOM (the same reason first-run-tier-screen.test.mjs reads source):
 *
 *   1. src/main.js: the checkout settle event must not re-enter render()
 *      while the walkthrough holds the route. It repaints ring surfaces, the
 *      walkthrough shows none, and the re-render is a re-mount.
 *   2. src/views/setup.js: a re-mount inside one page adopts the walk in
 *      progress (`liveWalk`) instead of recomputing from disk state and the
 *      recorded tier -- both of which lag the person mid-walk. Every durable
 *      in-progress write records the live walk in the same breath; finishing
 *      or skipping clears it, so the NEXT launch still resumes from disk.
 *
 * These are deliberately the same kind of assertion the first-run gate uses:
 * a source match cannot prove behaviour, but it can refuse the two exact
 * regressions -- the bare `() => render()` listener and a mount that ignores
 * the live walk -- and the packaged drivers (tools/stranger-onboarding-qa.mjs,
 * tools/first-run-recovery-qa.mjs) prove the behaviour on the real window. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(REPO_ROOT, relative), 'utf8')

const ROUTER = read('src/main.js')
const VIEW = read('src/views/setup.js')

test('the checkout settle event does not re-enter render() over the walkthrough', () => {
  const listener = ROUTER.match(/window\.addEventListener\(CHECKOUT_SURFACE_EVENT,[\s\S]*?\n\}\)/)
  assert.ok(listener, 'src/main.js no longer wires the checkout-surface listener at all')
  assert.match(
    listener[0],
    /if \(resolve\(parse\(\)\)\.name === 'setup'\) return/,
    'the checkout-surface listener re-enters render() while the walkthrough holds the route; '
    + 'that re-render mounts a second copy of setup and retires the one the person is walking (measured 2026-08-19)',
  )
})

test('a re-mount adopts the walk in progress instead of recomputing backwards', () => {
  assert.match(VIEW, /let liveWalk = null/, 'src/views/setup.js dropped the live-walk record')
  assert.match(
    VIEW,
    /resumeStep\(stored, \{ tierRecorded: state\.configured, steps: STEPS \}\)\s*\n\s*if \(liveWalk && STEPS\.includes\(liveWalk\.step\)\) \{\s*\n\s*step = liveWalk\.step\s*\n\s*answers = liveWalk\.answers/,
    'the mount no longer adopts the live walk over the recomputed resume; a late tier record or lagging stored profile can yank the person backwards again',
  )
  assert.match(VIEW, /function holdWalk\(\) \{\s*\n\s*liveWalk = \{ step, answers, initiallyConfigured \}/, 'holdWalk must retain the walk and whether it began on an existing configuration')
  const inProgressWrites = VIEW.match(/writeStoredProfile\(\{ status: 'in-progress', step, answers \}\)\s*\n\s*holdWalk\(\)/g) || []
  /* WAS 4 UNTIL T299 (8b4bc2a9, 2026-09-17), which added confirmWizardFolder --
     the wizard's "accept the suggested folder" action -- following exactly
     this same rule on its own, without this count being told. Pinned AT the
     total rather than below it, for the reason this file's own header names:
     a floor that drifts under the truth is how a dropped write stops being
     detectable. */
  assert.equal(
    inProgressWrites.length,
    5,
    'every in-progress durable write must record the live walk in the same breath (goTo, pickWorkspace, removeRoot, setAnswer, confirmWizardFolder); '
    + `found ${inProgressWrites.length} of 5`,
  )
})

// Exercise the actual completion functions: their awaited writes and refusal
// branches cannot be verified by requiring two statements to be adjacent.
function completionFixture(action, { intentFailure = false, profileFailure = false, ...overrides } = {}) {
  const begin = VIEW.indexOf(`  async function ${action}()`)
  const end = action === 'finish' ? VIEW.indexOf('  async function skip()', begin)
    : VIEW.indexOf('  /* ---------- wiring ---------- */', begin)
  assert.ok(begin >= 0 && end > begin)
  let release
  const pending = new Promise(resolve => { release = resolve })
  const writes = [], navigations = []
  const liveWalk = { step: 'review', answers: { autonomy: 'assisted' } }
  const context = {
    liveWalk, answers: liveWalk.answers, busy: false, refusal: null,
    initiallyConfigured: false, skipArmed: false, destroyed: false,
    assistantConfigFailure: null, undoUnavailable: null,
    SAFE_ANSWERS: { autonomy: 'observe' }, workspace: {},
    workspaceRoots: () => [], derived: () => ({ intent: {} }),
    paint() {}, applyDerived() {},
    async applySetupIntentChanges() {
      await pending
      if (intentFailure) throw new Error('The intent could not be saved.')
      return { deferred: [] }
    },
    writeStoredProfile(record) { writes.push(record); return profileFailure ? null : record },
    navigate(destination) { navigations.push(destination) },
    ...overrides,
  }
  vm.runInNewContext(VIEW.slice(begin, end), context)
  return { context, liveWalk, writes, navigations, release, run: () => context[action]() }
}

for (const action of ['finish', 'skip']) {
  test(`${action} retains the live walk while writes are pending and closes it only after durable completion`, async () => {
    const f = completionFixture(action)
    const completion = f.run()
    assert.equal(f.context.busy, true)
    assert.equal(f.context.liveWalk, f.liveWalk)
    assert.equal(f.writes.length, 0)
    assert.deepEqual(f.navigations, [])
    f.release()
    await completion
    assert.equal(f.writes.length, 1)
    assert.equal(f.writes[0].status, action === 'finish' ? 'complete' : 'skipped')
    assert.equal(f.context.liveWalk, null)
    assert.equal(f.context.busy, false)
    assert.deepEqual(f.navigations, ['#/'])
  })
  for (const failure of ['intentFailure', 'profileFailure']) {
    test(`${action} retains the live walk and refuses navigation after ${failure}`, async () => {
      const f = completionFixture(action, { [failure]: true })
      const completion = f.run()
      f.release()
      await completion
      assert.equal(f.context.liveWalk, f.liveWalk)
      assert.equal(f.context.busy, false)
      assert.equal(f.context.refusal.code, 'MC_SETUP_INTENTS_FAILED')
      assert.equal(f.writes.length, failure === 'intentFailure' ? 0 : 1)
      assert.deepEqual(f.navigations, [])
    })
  }
}

test('a setup that could not write the agent settings file says so', () => {
  /* THE PRODUCER'S OWN CONTRACT, FINALLY HONOURED.
   *
   * shell/setup-record.cjs recordWorkspaces answers
   * { ok: true, assistantConfig: { ok: false, code } } when the folders were
   * saved but the agent-client settings file could not be written -- a locked or
   * unwritable .mcp.json. Its comment states why both travel: "NEITHER OUTCOME
   * FAILS THE RECORDING ... Both outcomes are returned alongside, with codes and
   * no paths, SO THE SCREEN CAN SAY WHAT DID AND DID NOT HAPPEN."
   *
   * The screen said nothing. `assistantConfig` appeared ZERO times in all of
   * src/, so first run completed, navigated away and recorded itself complete
   * while the person's agent programs had no ToolsEnabled configuration --
   * permanently, with nothing anywhere mentioning it. An agent opened in that
   * folder simply does not see the product's tools, and the person has no reason
   * to connect that to a setup that told them it was done.
   *
   * NOT A REFUSAL, deliberately: the folders really were saved, and refusing
   * would tell somebody their choice did not take when it did. Stated, carried,
   * non-blocking.
   *
   * Asserted on the SOURCE because this view needs a live DOM to mount; what is
   * checked is that the fact reaches the render and the render is conditional --
   * a panel that always drew would tell every ordinary person their setup was
   * broken, which the second assertion here forbids.
   */
  assert.match(VIEW, /assistantConfigFailure\s*=\s*result\.assistantConfig/,
    'finish() no longer reads the agent-config outcome from recordWorkspaces, so a locked .mcp.json '
    + 'completes setup silently again')

  assert.match(VIEW, /writeStoredProfile\(\{ status: 'complete'[^}]*assistantConfig: assistantConfigFailure/,
    'the failure is no longer written to the stored profile, so it is lost the moment the person navigates away')

  assert.match(VIEW, /let assistantConfigFailure = readStoredProfile\(\)\?\.assistantConfig/,
    'the failure is not read back on mount, so somebody who finishes and returns never meets it')

  assert.match(VIEW, /\$\{assistantConfigFailure \? `<div[^`]*data-setup-assistant-config/,
    'the review step does not render the agent-config failure, so carrying it achieves nothing')

  /* THE CONTROL: the panel must be conditional. An unconditional one would pass
     every assertion above while telling every ordinary person their setup did
     not finish. */
  assert.doesNotMatch(VIEW, /<div class="fleet-profile-status"[^>]*data-setup-assistant-config[^`]*`\s*\}/,
    'the agent-config panel is drawn unconditionally')
})

test('the agent-config failure survives the round trip through the stored profile', async () => {
  /* THE HALF THE SOURCE ASSERTIONS ABOVE CANNOT SEE, and a mutation proved it:
   * deleting the reader's carry in src/setup-profile.js left every assertion in
   * the test above GREEN, because they all read the VIEW. The view can read the
   * field, store the field and render the field perfectly while the store drops
   * it in between -- which is the original defect exactly, one layer down, and
   * is how `revoked` was lost in src/account-state.js.
   *
   * So this drives the real writer and the real reader over a stub scope. */
  const { writeStoredProfile, readStoredProfile } = await import('../../src/setup-profile.js')
  const backing = {}
  const scope = {
    localStorage: {
      setItem: (key, value) => { backing[key] = String(value) },
      getItem: key => (Object.prototype.hasOwnProperty.call(backing, key) ? backing[key] : null),
    },
  }

  writeStoredProfile({
    status: 'complete', step: 'review', answers: {},
    assistantConfig: { ok: false, code: 'EACCES' },
  }, scope)
  const failed = readStoredProfile(scope)
  assert.equal(failed?.assistantConfig?.ok, false,
    'a stated agent-config failure did not survive the stored profile, so the person who finishes setup and '
    + 'returns is told nothing and the fact is lost exactly as it was before')
  assert.equal(failed.assistantConfig.code, 'EACCES',
    'the code was dropped, so the notice cannot say which failure it was')

  /* THE CONTROL. Carrying a success as though it were a failure would light the
     panel for everybody, which is worse than the silence it replaced. */
  writeStoredProfile({
    status: 'complete', step: 'review', answers: {},
    assistantConfig: { ok: true },
  }, scope)
  assert.equal(readStoredProfile(scope)?.assistantConfig, null,
    'a successful agent-config write is being carried as a failure, so every ordinary setup would show the notice')

  writeStoredProfile({ status: 'complete', step: 'review', answers: {} }, scope)
  assert.equal(readStoredProfile(scope)?.assistantConfig, null,
    'a profile that never reported an agent-config outcome is reading as a failure')
})

test('a setup where Undo will not work says so', async () => {
  /* THE SECOND FACT IN THE SAME REPLY, MISSED BY THE COMMIT THAT CARRIED THE
   * FIRST -- mine, an hour earlier, in this same function.
   *
   * recordWorkspaces answers { ok, roots, provisioned, assistantConfig,
   * releasedRoots }. `provisioned` carries per-root undoAvailable and
   * undoUnavailableReason, faithfully, from engine/src/lib/setup/workspace.js,
   * which returns them precisely so a surface can say when "Undo the last thing
   * it did" will not work -- usually because the machine has no git installed.
   *
   * Nothing in src/ read either field. A person finds out at the moment they
   * reach for the undo, which is the worst moment there is.
   *
   * Reading one field of a reply and leaving its neighbour unread is the miss
   * this project has now recorded six times, and this is the first time the
   * missed neighbour was in a reply I had just fixed.
   */
  const { writeStoredProfile, readStoredProfile } = await import('../../src/setup-profile.js')
  const backing = {}
  const scope = {
    localStorage: {
      setItem: (key, value) => { backing[key] = String(value) },
      getItem: key => (Object.prototype.hasOwnProperty.call(backing, key) ? backing[key] : null),
    },
  }

  writeStoredProfile({
    status: 'complete', step: 'review', answers: {},
    undoUnavailable: { reason: 'this computer has no version history tool installed' },
  }, scope)
  assert.match(readStoredProfile(scope)?.undoUnavailable?.reason || '', /no version history tool/,
    'the undo-unavailable reason did not survive the stored profile, so a person who finishes setup and '
    + 'returns is told nothing')

  writeStoredProfile({ status: 'complete', step: 'review', answers: {} }, scope)
  assert.equal(readStoredProfile(scope)?.undoUnavailable, null,
    'a setup that never reported an undo problem is reading as one, so every ordinary person would see the notice')

  const view = readFileSync(new URL('../../src/views/setup.js', import.meta.url), 'utf8')
  assert.match(view, /result\.provisioned/,
    'finish() no longer reads the per-root provisioning outcome, so an unavailable undo is invisible again')
  assert.match(view, /undoUnavailable \? `<div[^`]*data-setup-undo-unavailable/,
    'the review step does not render the unavailable undo, so carrying it achieves nothing')
  assert.match(view, /undoUnavailable\b[^\n]*writeStoredProfile|writeStoredProfile\([^)]*undoUnavailable/,
    'the fact is not written to the stored profile, so it is lost the moment the person navigates away')
})


/* T299: THE FRESH-INSTALL DEAD END, AND WHY NOTHING SAID A WORD.
 *
 * Measured on screen by Worker 82: the wizard's Folder step completes with a
 * tick, Finish reports success and enters the product, and the first agent the
 * person starts refuses with "No working folder has been confirmed" -- while
 * Settings reads "Nobody has been asked about this yet", so the tick recorded
 * nothing.
 *
 * The tick was never a claim. The header draws it from `position < index`, so
 * a step is ticked for having been walked past. The recording is a separate
 * fact, and the only thing that ever establishes it is recordWorkspaces, which
 * stamps workspaceChosen; shell/agent-command-surface.cjs mints
 * AGENT_START_WORKSPACE_UNCONFIRMED from that flag being false.
 *
 * loadWorkspace() is FIRED, not awaited, when the person reaches the Folder
 * step, and it is the only thing that sets `workspace`. Finish landing before
 * it answers saw workspace === null, so workspaceRoots() returned [] -- empty
 * for anyone who accepted the suggested default without pressing anything,
 * which is the ordinary fresh install -- and the old guard read that as "there
 * is no folder to record". These drive the real finish() body with values. */

test('finish waits for the working-folder answer instead of reading its absence as "no folder"', async () => {
  const recorded = []
  let workspace = null
  const f = completionFixture('finish', {
    workspace: null,
    /* The read the wizard fires on the Folder step, still in flight when
       Finish is pressed. It is what supplies the suggested default. */
    async loadWorkspace() {
      workspace = { available: true, configured: true, roots: [], suggested: 'C:\People\Work', chosen: false }
      f.context.workspace = workspace
    },
    workspaceRoots: () => (workspace?.roots?.length ? workspace.roots
      : workspace?.suggested ? [workspace.suggested] : []),
    mcSetup: { async recordWorkspaces(roots) { recorded.push(roots); return { ok: true, roots } } },
    setupRefusalDetail: result => result?.reason || 'no reason given',
  })
  const completion = f.run()
  f.release()
  await completion
  assert.deepEqual(recorded, [['C:\People\Work']],
    'the suggested folder a fresh install accepts without pressing anything must still be recorded, or the first agent refuses')
  assert.equal(f.context.refusal, null)
  assert.deepEqual(f.navigations, ['#/'])
})

test('finish refuses by name when the working-folder check is unavailable, instead of completing silently', async () => {
  const recorded = []
  const f = completionFixture('finish', {
    workspace: { available: false, reason: 'The working folder check could not be reached.' },
    workspaceRoots: () => ['C:\People\Work'],
    mcSetup: { async recordWorkspaces(roots) { recorded.push(roots); return { ok: true, roots } } },
    setupRefusalDetail: result => result?.reason || 'no reason given',
  })
  const completion = f.run()
  f.release()
  await completion
  assert.deepEqual(recorded, [], 'nothing can be recorded through a check that is unavailable')
  assert.equal(f.context.refusal?.code, 'MC_SETUP_WORKSPACE_UNAVAILABLE',
    'a folder that could not be saved is a refusal the person can act on, not a silent completion')
  assert.match(f.context.refusal.reason, /could not be reached/, 'and it carries the reason the subsystem gave')
  assert.deepEqual(f.navigations, [], 'setup does not enter the product over an unrecorded folder')
})

/* The read is finished ONCE. An answer already in hand is not re-asked, or
   every Finish would spend a round trip it does not need. */
test('finish does not re-read the working folder when it already has the answer', async () => {
  let reads = 0
  const f = completionFixture('finish', {
    workspace: { available: true, roots: ['C:\People\Already'], suggested: null, chosen: true },
    async loadWorkspace() { reads += 1 },
    workspaceRoots: () => ['C:\People\Already'],
    mcSetup: { async recordWorkspaces(roots) { return { ok: true, roots } } },
    setupRefusalDetail: result => result?.reason || 'no reason given',
  })
  const completion = f.run()
  f.release()
  await completion
  assert.equal(reads, 0, 'a workspace answer already held is not asked for again')
  assert.deepEqual(f.navigations, ['#/'])
})
