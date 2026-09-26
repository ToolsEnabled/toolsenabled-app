import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const {
  boundedEngineExit,
  narrowTurnOptions,
  observeEngineExit,
} = require_(path.join(ROOT, 'shell', 'agent-host.cjs'))

const START_TIERS = Object.freeze({
  luna: Object.freeze({ provider: 'codex', model: 'gpt-5.1-codex-mini' }),
  atlas: Object.freeze({ provider: 'codex', model: 'gpt-5.1-codex-max' }),
  sonnet: Object.freeze({ provider: 'claude', model: 'claude-sonnet-4-5' }),
})

test('turn options preserve the plan ceiling while accepting a caller-selected Codex model', () => {
  const result = narrowTurnOptions(
    { approvalPolicy: 'on-request' },
    { model: 'gpt-5.1-codex-max' },
    START_TIERS,
  )

  assert.deepEqual(result, {
    model: 'gpt-5.1-codex-max',
    approvalPolicy: 'on-request',
  }, 'the accepted model must not discard the plan-owned approval policy')
  assert.equal(narrowTurnOptions({ approvalPolicy: 'never' }, null, START_TIERS), null,
    'a turn with no requested options must remain an absence, not invented overrides')
})

test('renderer-selected models enforce the host length bound without rejecting its boundary', () => {
  const boundaryModel = 'm'.repeat(128)
  const tiersAtBoundary = Object.freeze({
    boundary: Object.freeze({ provider: 'codex', model: boundaryModel }),
  })

  assert.deepEqual(
    narrowTurnOptions({}, { model: boundaryModel }, tiersAtBoundary),
    { model: boundaryModel },
    'a legitimate 128-character model must be accepted at the documented boundary',
  )

  const overlongModel = 'm'.repeat(129)
  assert.throws(
    () => narrowTurnOptions({}, { model: overlongModel }, {
      overlong: { provider: 'codex', model: overlongModel },
    }),
    error => error?.code === 'AGENT_HOST_INVALID_ARGUMENT'
      && /model/.test(error.message)
      && /at most 128 characters/.test(error.message),
    'a renderer-supplied model beyond 128 characters must carry the host argument refusal',
  )
})

test('renderer-selected models reject non-string values rather than coercing them', () => {
  const boundaryModel = 'm'.repeat(128)
  const tiersAtBoundary = Object.freeze({
    boundary: Object.freeze({ provider: 'codex', model: boundaryModel }),
  })
  assert.throws(
    () => narrowTurnOptions({}, { model: { toString: () => boundaryModel } }, tiersAtBoundary),
    error => error?.code === 'AGENT_HOST_INVALID_ARGUMENT'
      && /model/.test(error.message)
      && /string/.test(error.message),
    'a coercible renderer-supplied model must carry the host argument refusal rather than being stringified',
  )
})

test('turn option refusals identify both the forbidden choice and why it was refused', () => {
  assert.throws(
    () => narrowTurnOptions({}, { approvalPolicy: 'never' }, START_TIERS),
    error => error?.code === 'AGENT_TURN_OPTION_FORBIDDEN'
      && /approvalPolicy/.test(error.message)
      && /not a renderer choice/i.test(error.message),
    'a renderer-owned approval policy must be refused with a useful reason',
  )
  assert.throws(
    () => narrowTurnOptions({}, { model: 'codex-model-not-in-start-tiers' }, START_TIERS),
    error => error?.code === 'AGENT_TIER_UNKNOWN'
      && /codex-model-not-in-start-tiers/.test(error.message)
      && /unknown model/i.test(error.message),
    'an unknown model must be refused by name and distinguished from an unavailable launcher',
  )
  assert.throws(
    () => narrowTurnOptions({}, { model: 'claude-sonnet-4-5' }, START_TIERS),
    error => error?.code === 'AGENT_TIER_NO_LAUNCHER'
      && /sonnet/i.test(error.message)
      && /no launcher/i.test(error.message),
    'a known model without this launcher must be distinguished from an unknown model',
  )
})

test('exit observation reports supported evidence once and stays unknown when evidence cannot be read', () => {
  let listener
  const exits = []
  const started = {
    adapter: {
      transport: {
        child: {
          exitCode: null,
          signalCode: null,
          once(event, callback) {
            assert.equal(event, 'exit')
            listener = callback
          },
        },
      },
    },
  }

  assert.equal(observeEngineExit(started, exit => exits.push(exit)), 'child',
    'a child exit source should be identified as attached')
  listener(17, 'SIGTERM')
  listener(0, null)
  assert.deepEqual(exits, [{ code: 17, signal: 'SIGTERM' }],
    'one observed exit must retain its evidence and must not be overwritten')

  let uncertainReports = 0
  const unreadable = {}
  Object.defineProperty(unreadable, 'adapter', {
    configurable: true,
    get() { throw new Error('adapter read failed') },
  })
  assert.equal(observeEngineExit(unreadable, () => { uncertainReports += 1 }), null,
    'an unreadable transport must remain unknown rather than becoming a definite exit')
  assert.equal(uncertainReports, 0,
    'failure to read exit evidence must not synthesize an exit report')
})

test('host-bounded exit evidence rejects hostile codes and signal strings', () => {
  assert.deepEqual(boundedEngineExit({ code: -2_147_483_648, signal: 'SIGBREAK' }), {
    code: -2_147_483_648,
    signal: 'SIGBREAK',
  })
  assert.deepEqual(boundedEngineExit({ code: 2_147_483_647, signal: 'CTRL_C_EVENT' }), {
    code: 2_147_483_647,
    signal: 'CTRL_C_EVENT',
  })
  for (const [hostile, expected] of [
    [{ code: 2_147_483_648, signal: 'SIGTERM' }, { code: null, signal: 'SIGTERM' }],
    [{ code: 1.5, signal: 'SIGTERM\nforged' }, { code: null, signal: null }],
    [{ code: Number.NaN, signal: 'C:\\private\\signal' }, { code: null, signal: null }],
    [{ code: '0', signal: 'sigterm' }, { code: null, signal: null }],
    [{ code: 0, signal: 'A'.repeat(33) }, { code: 0, signal: null }],
    [Object.create({ code: 7, signal: 'SIGTERM' }), { code: null, signal: null }],
  ]) {
    const bounded = boundedEngineExit(hostile)
    assert.deepEqual(bounded, expected)
    assert.equal(Object.isFrozen(bounded), true)
  }
})
