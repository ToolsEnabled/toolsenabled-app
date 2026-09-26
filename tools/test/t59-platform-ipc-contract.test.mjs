import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '../..')
function parserFrom(source) {
  const start = source.indexOf('function parseAgentStart(value) {')
  const end = source.indexOf('\n}', start)
  assert.ok(start >= 0 && end > start, 'the real start parser must be present')
  const agentPayload = (value, allowed) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value))
    assert.deepEqual(Object.keys(value).filter(key => !allowed.includes(key)), [])
    return value
  }
  const bounded = (value, name, max) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > max) {
      const error = new Error('MC_AGENT_INVALID_PAYLOAD')
      error.code = 'MC_AGENT_INVALID_PAYLOAD'
      throw error
    }
    return value
  }
  const ipcError = (code, message) => {
    const error = new Error(message)
    error.code = code
    throw error
  }
  return new Function('agentPayload', 'boundedAgentString', 'agentIpcError', 'AGENT_EFFORT_VALUES',
    'MAX_SESSION_ID_LENGTH', 'MAX_CWD_LENGTH', 'MAX_SURFACE_LENGTH', 'MAX_ACCOUNT_NAME_LENGTH',
    `${source.slice(start, end + 2)}; return parseAgentStart;`)(
    agentPayload, bounded, ipcError, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    128, 32768, 128, 64)
}

const identity = { treeIdentity: { selfName: 'Worker', managerName: 'Controller' },
  requestKeys: { treeAnchors: ['root', 'worker'], threadId: 'worker' } }

const parse = parserFrom(readFileSync(path.join(APP, 'shell/main.cjs'), 'utf8'))

test('the real start IPC parser admits exact resume replacement grammar', () => {
  const result = parse({ sessionId: 'new', surface: 'fleet-tree', resumeThreadId: 'thread-1',
    resumeAccount: 'saved-account', replacesSessionId: 'old', ...identity })
  assert.equal(result.resumeThreadId, 'thread-1')
  assert.equal(result.resumeAccount, 'saved-account')
  assert.equal(result.replacesSessionId, 'old')
  assert.deepEqual(result.treeIdentity, identity.treeIdentity)
})

test('replacement safety remains closed at the real parser boundary', () => {
  assert.throws(() => parse({ sessionId: 'same', resumeThreadId: 'thread-1', replacesSessionId: 'same', ...identity }),
    error => error.code === 'MC_AGENT_INVALID_PAYLOAD')
  assert.throws(() => parse({ sessionId: 'new', resumeThreadId: 'thread-1', replacesSessionId: 'old' }),
    error => error.code === 'MC_AGENT_INVALID_PAYLOAD')
})


test('the real start parser retains bounded history separately from a submitted message', () => {
  const historyHandoff = 'Saved earlier speech, not a new user turn.'
  assert.equal(parse({ sessionId: 'new', historyHandoff }).historyHandoff, historyHandoff)
  for (const value of ['', null, {}, 'x'.repeat(160001)]) {
    assert.throws(() => parse({ sessionId: 'new', historyHandoff: value }), error => error.code === 'MC_AGENT_INVALID_PAYLOAD')
  }
})
