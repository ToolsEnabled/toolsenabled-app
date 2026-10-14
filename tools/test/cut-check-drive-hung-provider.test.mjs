/* THE LAST GATE BEFORE A CUT MUST NOT BLAME THE PRODUCT FOR A CLI THAT HUNG.
 *
 * Run: node --test tools/test/cut-check-drive-hung-provider.test.mjs
 *
 * tools/cut-check-drive.mjs presses Start on the tree, waits for the product's
 * own record to hold a terminal node, and judges what it finds. It used to read
 * anything that was not `finished` as one thing, so an agent whose provider CLI
 * was spawned and never answered inside the budget -- the node still running
 * when the clock ran out -- was reported as a FAILING CHECK and blocked the cut.
 *
 * Nothing was measured in that case. R1228: a gate that invents a verdict it did
 * not take is the defect. These cases pin the three-way split: ended failed is a
 * product failure, never ended is could-not-measure and names itself, ended
 * finished is a pass. The drive is imported with its own test guard set, so
 * nothing here launches Electron or spends provider budget.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'

process.env.CUT_CHECK_DRIVE_TEST = '1'
const { terminalVerdict } = await import('../cut-check-drive.mjs')

const node = status => ({ id: 'n1', status, reply: '', tier: 'claude-sonnet' })

test('a node that never reached a terminal state is could-not-measure, not a failure', () => {
  const outcome = terminalVerdict({ mine: node('running'), terminal: false, waitedMs: 240_000, budgetMs: 240_000 })
  assert.equal(outcome.verdict, 'could-not-measure')
  assert.match(outcome.why, /provider CLI never answered/)
  assert.match(outcome.why, /still running/)
  assert.match(outcome.why, /not a product failure/)
})

test('a node the product ended as failed is still a product failure', () => {
  const outcome = terminalVerdict({ mine: node('failed'), terminal: true, waitedMs: 3_000, budgetMs: 240_000 })
  assert.equal(outcome.verdict, 'failed')
  assert.match(outcome.why, /ended failed/)
})

test('a finished node is a pass, so the split cannot be satisfied by refusing everything', () => {
  assert.equal(terminalVerdict({ mine: node('finished'), terminal: true }).verdict, 'finished')
})

test('no node at all keeps its own answer: Start was pressed and nothing was recorded', () => {
  assert.equal(terminalVerdict({ mine: null, terminal: false }).verdict, 'no-node')
})

test('a queued node that never moved reads the same way as a running one', () => {
  /* The status a hang leaves behind depends on where the CLI stopped. Any
     non-terminal status means the same thing: no reading was taken. */
  for (const status of ['queued', 'starting', 'running', 'waiting']) {
    const outcome = terminalVerdict({ mine: node(status), terminal: false, waitedMs: 180_000, budgetMs: 240_000 })
    assert.equal(outcome.verdict, 'could-not-measure', `${status} must not be read as a product failure`)
  }
})

test('the drive routes could-not-measure to NOT EXERCISED and failed to a failing check', async () => {
  /* The split above is only worth having if the two answers reach different
     places: pending() counts as unexercised and leaves the drive at exit 3,
     check(false) fails the drive at exit 1. */
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const source = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cut-check-drive.mjs'), 'utf8')
  assert.match(source, /if \(outcome\.verdict === 'could-not-measure'\) \{\s*\n\s*pending\(/)
  assert.match(source, /if \(outcome\.verdict === 'failed'\) \{\s*\n\s*check\(/)
  assert.doesNotMatch(source, /if \(mine\.status !== 'finished'\) \{\s*\n\s*check\(/,
    'the old one-answer read must be gone, not merely shadowed')
})

/* THE CALLER HALF, AND IT IS THE HALF THAT WAS MISSING.
 *
 * tools/packaged-qa-suite.mjs is cut-check-drive.mjs's only non-test caller: it
 * is registered there costly, and it is what a cut actually runs. Its verdict
 * step read `if (code !== 0) return 'FAIL'`, so the exit 3 this drive now
 * returns for a provider CLI that never answered was turned straight back into
 * a failing check. The discrimination existed inside the script and nothing
 * downstream consulted it -- a decision computed on a path no caller reads.
 *
 * These cases run a fixture driver THROUGH the real runner (runDriver, with the
 * real child-process helper), not against the script, because judging the
 * script alone is exactly what would have passed while the runner collapsed it.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { runDriver, verdictFor } from '../packaged-qa-suite.mjs'

/* What tools/cut-check-drive.mjs report() actually prints when one check could
   not be exercised and nothing failed. Kept in the drive's own wording rather
   than paraphrased: the runner reads this text. */
const HUNG_PROVIDER_OUTPUT = [
  '  ok    the window mounts a view',
  '  ....  Claude-signed-in machine: a Claude agent starts from the tree  -- NOT EXERCISED: the provider CLI never answered',
  '',
  '1/2 checks passed in 265.0s',
  '  NOT EXERCISED: Claude-signed-in machine: a Claude agent starts from the tree  -- the agent was started and the provider CLI never answered',
].join('\n')

async function runFixtureDriver(t, body) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qa-runner-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'fixture-drive.mjs')
  await writeFile(file, body)
  const entry = { key: 'fixture-drive', file, needs: [], source: '', runner: 'node', timeoutMs: 120_000 }
  return runDriver(entry, { ...process.env }, { logDirectory: path.join(root, 'logs') })
}

const fixtureBody = (output, code) =>
  `process.stdout.write(${JSON.stringify(`${output}\n`)})\nprocess.exitCode = ${code}\n`

test('THROUGH THE RUNNER: a drive that could not measure is not recorded as a product failure', async t => {
  const result = await runFixtureDriver(t, fixtureBody(HUNG_PROVIDER_OUTPUT, 3))
  assert.equal(result.exitCode, 3)
  assert.notEqual(result.verdict, 'FAIL', 'the runner must not turn could-not-measure back into a failing check')
  assert.equal(result.verdict, 'INCONCLUSIVE')
})

test('THROUGH THE RUNNER: could-not-measure is still not a pass, so a cut cannot proceed on it', async t => {
  const result = await runFixtureDriver(t, fixtureBody(HUNG_PROVIDER_OUTPUT, 3))
  assert.notEqual(result.verdict, 'PASS',
    'the suite counts every non-PASS as a failure and exits non-zero; an unexercised check must stay in that count')
})

test('THROUGH THE RUNNER: a drive that failed a check is still a product failure', async t => {
  const failed = [
    '  FAIL  the answer came back  -- the node ended failed',
    '',
    '0/1 checks passed in 12.0s',
    '  FAILED:        the answer came back  -- the node ended failed',
  ].join('\n')
  const result = await runFixtureDriver(t, fixtureBody(failed, 1))
  assert.equal(result.verdict, 'FAIL')
})

test('exit 3 alongside a failed check is a failure, so the declaration cannot launder one', () => {
  const mixed = [
    '  FAIL  a real defect  -- measured',
    '  NOT EXERCISED: something else  -- could not be reached',
    '',
    '0/2 checks passed in 12.0s',
  ].join('\n')
  assert.equal(verdictFor({ timedOut: false, code: 3, output: mixed }), 'FAIL')
})

test('THROUGH THE RUNNER: a declared could-not-measure survives a summary the parser cannot total', async t => {
  /* THE LOAD-BEARING CASE, and it is why the driver's own exit code has to be
     read rather than inferred.

     The runner could already recover could-not-measure from the TEXT -- NOT
     EXERCISED lines plus a ratio whose arithmetic closes -- and for today's
     cut-check-drive output that path happens to reach the right answer. It is
     the wording that carries it, not the declaration: a drive that stops before
     it can total its ledger, or one whose summary is phrased differently, has
     the same nothing-was-measured result and used to fall through to
     `if (code !== 0) return 'FAIL'`. A gate whose verdict depends on the
     spelling of a summary line is one rewording away from blaming the product
     for a provider that never answered. */
  const noTotal = [
    '  ok    the window mounts a view',
    '  ....  a Claude agent starts from the tree  -- NOT EXERCISED: the provider CLI never answered',
    '',
    '  NOT EXERCISED: a Claude agent starts from the tree  -- the provider CLI never answered',
    'the run stopped before it could total its ledger',
  ].join('\n')
  const result = await runFixtureDriver(t, fixtureBody(noTotal, 3))
  assert.equal(result.exitCode, 3)
  assert.equal(result.verdict, 'INCONCLUSIVE',
    'an exit 3 with no totalled summary is still could-not-measure, not a product failure')
})

test('a start the box never admitted is named as such, not blamed on the provider', () => {
  /* Lane A measured this on a loaded box: at 100% CPU the product queues the
     start -- "New starts pause at 97% CPU... This agent is queued" -- and it
     never leaves the queue. Nothing was asked of any provider, so a refusal
     naming the provider would be false. */
  for (const status of ['queued', 'pending', 'admitting', 'awaiting-resources']) {
    const outcome = terminalVerdict({ mine: node(status), terminal: false, waitedMs: 240_000, budgetMs: 240_000 })
    assert.equal(outcome.verdict, 'could-not-measure')
    assert.equal(outcome.cause, 'never-admitted', `${status} is the admission queue, not the provider`)
    assert.match(outcome.why, /never ADMITTED/)
    assert.doesNotMatch(outcome.why, /provider CLI never answered/)
  }
  const silent = terminalVerdict({ mine: node('running'), terminal: false, waitedMs: 240_000, budgetMs: 240_000 })
  assert.equal(silent.cause, 'provider-never-answered')
})

test('the refusal says the budget was one overall deadline, and carries the machine reading', () => {
  /* Lane A also measured the opposite shape: a synchronous retry ladder
     multiplying a per-probe timeout into a 485-second freeze where the old code
     failed in 5s. Spending our own deadline retrying looks exactly like a hung
     provider from outside, so the refusal states which budget it spent. */
  const outcome = terminalVerdict({
    mine: node('running'), terminal: false, waitedMs: 240_000, budgetMs: 240_000,
    machine: 'This computer is steady enough to measure.',
  })
  assert.match(outcome.why, /one overall deadline; nothing was retried and nothing held/)
  assert.match(outcome.why, /This computer, measured while waiting: This computer is steady enough to measure\./)
})

test('waitForTerminal spends one budget and never multiplies it across retries', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const source = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cut-check-drive.mjs'), 'utf8')
  const waiter = source.match(/async function waitForTerminal\([\s\S]*?\n}/)?.[0] ?? ''
  /* The body only: the declaration line carries the function's own name and
     would satisfy the self-call check below. */
  const body = waiter.slice(waiter.indexOf('\n'))
  assert.match(body, /const until = Date\.now\(\) \+ budgetMs/, 'one deadline, computed once')
  assert.doesNotMatch(body, /waitForTerminal\(/, 'it must not call itself: a retry ladder multiplies the budget')
  assert.doesNotMatch(body, /for \(let attempt/, 'no per-attempt timeout inside the budget')
})
