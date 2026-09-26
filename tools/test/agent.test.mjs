import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

/* The view imports its stylesheet as part of the browser bundle.  The repository's
   test loader makes that one browser-only dependency inert while leaving the
   actual view module, and therefore its exported boundary, under test. */
register('./css-loader.mjs', import.meta.url)

const { agentAccountsFromAnswer, appendAgentRingNode, liveAgentRuntimeSource } = await import('../../src/views/agent.js')

test('agent runtime reports running and stopped records without inventing unreadable telemetry', () => {
  assert.deepEqual(liveAgentRuntimeSource({ bornAt: 2_000 }, 7_000), {
    bornAt: 2_000,
    stoppedAt: null,
    elapsedMs: 5_000,
    running: true,
  }, 'a running record gives the view an advancing runtime')

  assert.deepEqual(liveAgentRuntimeSource({ bornAt: 2_000, stoppedAt: 6_000 }, 90_000), {
    bornAt: 2_000,
    stoppedAt: 6_000,
    elapsedMs: 4_000,
    running: false,
  }, 'a stopped record freezes at its producer-supplied stop epoch')

  assert.equal(
    liveAgentRuntimeSource({ bornAt: 2_000, controlTarget: { status: 'failed' } }, 7_000),
    null,
    'a terminal target whose stop epoch could not be read stays unavailable rather than looking live',
  )
  assert.equal(
    liveAgentRuntimeSource({ bornAt: '2000', stoppedAt: 6_000 }, 7_000),
    null,
    'an unreadable start epoch stays unavailable rather than becoming a definite runtime',
  )
})

test('agent runtime ring attachment reports both usable and unusable control mounts', () => {
  const child = { kind: 'runtime-ring' }
  const children = []
  const mount = { appendChild(node) { children.push(node) } }

  assert.equal(appendAgentRingNode(mount, child), true, 'a usable mount reports that the ring was attached')
  assert.deepEqual(children, [child], 'the successful result corresponds to the child actually reaching the mount')
  assert.equal(
    appendAgentRingNode(null, child),
    false,
    'a missing mount reports refusal instead of success',
  )
  assert.equal(
    appendAgentRingNode({ appendChild() { throw new Error('detached') } }, child),
    false,
    'a mount that cannot accept the ring reports refusal instead of aborting the customer view',
  )
})

test('the spent-account report reaches the cards, and only where it reached a verdict', () => {
  /* THE DEFECT THIS CLOSES. The shell has answered which running agents sit on
     a sign-in that has run out since 2026-09-03 -- the engine's handoverReport()
     rides along on every read of mc-agent:session-accounts -- and the page's
     only caller dropped `report` and `reportReason` on the floor. The work was
     done on every page load and told to nobody, so the one screen that names
     the accounts stayed the one screen that could not say which were spent. */
  const shellAnswer = (extra = {}) => ({
    ok: true,
    sessions: [
      { sessionId: 's1', agentId: 'moved', account: 'work', provider: 'claude' },
      { sessionId: 's2', agentId: 'stuck', account: 'work', provider: 'claude' },
      { sessionId: 's3', agentId: 'fine', account: 'spare', provider: 'claude' },
      { sessionId: 's4', agentId: 'unread', account: 'quiet', provider: 'claude' },
      /* A row naming no agent joins to no card: a session id is opaque and this
         page refuses to derive an agent from one. */
      { sessionId: 's5', agentId: null, account: 'work', provider: 'codex' },
    ],
    report: null,
    reportReason: null,
    ...extra,
  })
  const REPORT = {
    ok: true,
    code: null,
    moves: [{ sessionId: 's1', agentId: 'moved', from: 'work', to: 'spare', why: 'HANDOVER_MOVED' }],
    /* HELD IS ALSO ON A SPENT ACCOUNT. The two lists differ by whether there is
       anywhere for the work to go next, not by whether anything is wrong --
       marking only `moves` leaves the worst case, every account at its limit,
       as the one drawn as healthy. */
    held: [{ sessionId: 's2', agentId: 'stuck', from: 'work', why: 'HANDOVER_HELD_NO_TARGET' }],
    /* AND UNKNOWN IS NEITHER. "Nobody read this account" is not "it is fine"
       and not "it is spent"; the engine keeps a third list so a reader cannot
       fold it into one of the first two, and this reader does not. */
    unknown: [{ sessionId: 's4', agentId: 'unread', from: 'quiet', why: 'HANDOVER_UNKNOWN_ACCOUNT_NOT_READ' }],
  }

  const read = agentAccountsFromAnswer(shellAnswer({ report: REPORT }))
  assert.equal(read.ok, true)
  assert.equal(read.reportReason, null)
  assert.deepEqual(read.byAgent.get('moved'), { account: 'work', provider: 'claude', spent: true, to: 'spare', why: 'HANDOVER_MOVED' })
  assert.deepEqual(read.byAgent.get('stuck'), { account: 'work', provider: 'claude', spent: true, to: null, why: 'HANDOVER_HELD_NO_TARGET' })
  assert.deepEqual(read.byAgent.get('fine'), { account: 'spare', provider: 'claude' })
  assert.deepEqual(read.byAgent.get('unread'), { account: 'quiet', provider: 'claude' })
  assert.deepEqual([...read.byAgent.keys()], ['moved', 'stuck', 'fine', 'unread'])

  /* A REPORT THAT REACHED NO VERDICT MARKS NOTHING, and the account each agent
     is on is still answered: which sign-in an agent is spending does not depend
     on the allowance check having run. A build that could not read the plan
     answers null; a computer that has never run the check answers ok:false with
     every session named. Both are "nobody looked", and drawing either as
     "nothing is spent" is the merge this report exists to prevent. */
  for (const nothing of [null, undefined, {}, { ok: false, moves: [{ agentId: 'moved', from: 'work' }], held: [] }]) {
    const quiet = agentAccountsFromAnswer(shellAnswer({ report: nothing }))
    assert.equal(quiet.byAgent.size, 4, 'the account list was lost with the report')
    assert.deepEqual([...quiet.byAgent.values()].filter(entry => entry.spent), [])
  }

  /* THE REASON TRAVELS with it, so the page can say why the second question has
     no answer instead of drawing a quiet fleet. */
  assert.equal(agentAccountsFromAnswer(shellAnswer({ reportReason: 'this build cannot work out which accounts have run out' })).reportReason,
    'this build cannot work out which accounts have run out')

  /* THE ROW MUST BE TALKING ABOUT THE ACCOUNT THE CARD SHOWS. The report is
     built from the last allowance check and the live session list; if the two
     disagree about which account this agent is on, the mark is withheld rather
     than pinned to whichever name arrived second. */
  const stale = agentAccountsFromAnswer(shellAnswer({
    report: { ok: true, moves: [{ agentId: 'fine', from: 'work', to: 'spare', why: 'HANDOVER_MOVED' }], held: [] },
  }))
  assert.deepEqual(stale.byAgent.get('fine'), { account: 'spare', provider: 'claude' },
    'a report about a different account marked this one')

  /* A SHELL THAT COULD NOT BE ASKED IS NOT A QUIET FLEET. */
  for (const broken of [null, undefined, { ok: false }, { ok: true }, { ok: true, sessions: 'none' }]) {
    assert.deepEqual(agentAccountsFromAnswer(broken), { ok: false, byAgent: new Map(), reportReason: null })
  }
})
