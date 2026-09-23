import { describeLocalMetrics, runRows, usageByAccount, usageByModel } from './local-metrics.js'
import { runsInWindow, turnsInWindow } from './metrics-live-charts.js'
import { sessionTurnSucceeded } from './agent-session-events.js'

export function metricsPeriod(records, window) {
  const runs = runsInWindow(records.sessions.runs, window)
  const turns = turnsInWindow(records.usage.turns, window)
  const sessions = { ...records.sessions, runs, total: runs.length,
    started: runs.filter(run => run.result === 'started').length,
    refused: runs.filter(run => run.result === 'refused').length }
  const usage = { ...records.usage, turns, total: turns.length }
  const local = describeLocalMetrics(sessions, { nowMs: window.endMs - 1, conversations: records.conversations, usage })
  const known = turns.filter(turn => Number.isSafeInteger(turn.totalTokens) && turn.totalTokens >= 0)
  const total = known.reduce((sum, turn) => sum + turn.totalTokens, 0)
  const succeeded = turns.filter(turn => sessionTurnSucceeded(turn.status)).length
  const failed = turns.filter(turn => ['error', 'failed', 'failure', 'cancelled', 'canceled', 'interrupted', 'aborted'].includes(turn.status)).length
  // Group individual turns: one session can change model or provider sign-in.
  // Session-total records have already been excluded by turnsInWindow.
  const perTurn = { ...usage, turns: turns.map((turn, index) => ({ ...turn, sessionId: `turn-${index}` })) }
  return {
    local: { ...local, runs: runRows(sessions, { nowMs: window.endMs - 1, conversations: records.conversations, limit: runs.length }),
      usage: { ...local.usage, byAccount: usageByAccount(perTurn), byModel: usageByModel(perTurn) } },
    runs, turns, tokens: known.length ? total : null, unknown: turns.length - known.length,
    succeeded, failed, unrecorded: turns.length - succeeded - failed,
    average: known.length ? Math.round(total / known.length) : null,
    cumulative: records.usage.turns.filter(turn => turn.basis === 'session-total' && turn.atMs >= window.startMs && turn.atMs < window.endMs).length,
  }
}
