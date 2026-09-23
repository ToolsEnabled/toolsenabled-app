// BEFORE ANOTHER ASSISTANT IS STARTED, WHETHER THIS COMPUTER HAS ROOM FOR ONE.
//
// THE INCIDENT. On 2026-09-03 the owner's app resumed nine assistants between
// 21:15:50 and 21:24:31 local and died at 21:26:20 with the CPU pegged. Nothing
// in the product had ever measured what one assistant costs, and nothing asked
// the machine whether it could hold another.
//
// WHAT ONE COSTS, MEASURED (raw output in REPORT-crash-20260903/evidence/C/):
//   claude.exe             540-623 MB private   claude-cli-and-os-memory.txt
//   toolsenabled server     65 MB private        measure-toolsenabled-calls.json
//   toolsenabled-readonly   60 MB private        measure-toolsenabled-readonly-calls.json
//   -> 665-748 MB per assistant. The gate uses 768 MB and keeps 2 GB in reserve.
//
// THE OWNER'S RULE THIS SUITE ENFORCES: never gate the person silently, and at
// most one warning. So the refusal carries the numbers it refused on, and a
// second press with acknowledgeLowMemory starts the assistant anyway.

import assert from 'node:assert/strict'
import test from 'node:test'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

import { START_REFUSAL_CODES, memoryAdmission } from '../../shell/agent-host.cjs'

const GB = 1024 * 1024 * 1024

test('a computer with room admits the start', () => {
  const admission = memoryAdmission({ freeBytes: 9 * GB })
  assert.equal(admission.ok, true)
  assert.equal(admission.measured, true)
})

test('a computer without room refuses, and says so in numbers a person can check', () => {
  const admission = memoryAdmission({ freeBytes: 1.5 * GB })
  assert.equal(admission.ok, false)
  assert.equal(admission.code, 'AGENT_MEMORY_LOW')
  // The sentence has to be readable on its own, name both numbers, and contain
  // no jargon beyond the code the IPC boundary needs to recover.
  assert.match(admission.message, /This computer has 1\.5 GB of memory left/)
  assert.match(admission.message, /starting another assistant needs about 0\.8 GB/)
  assert.match(admission.message, /2\.0 GB is kept free for everything else/)
})

test('the person can override it, which is the whole difference between a warning and a wall', () => {
  const refused = memoryAdmission({ freeBytes: 0.2 * GB })
  assert.equal(refused.ok, false)
  const acknowledged = memoryAdmission({ freeBytes: 0.2 * GB, acknowledged: true })
  assert.equal(acknowledged.ok, true, 'a person who pressed start again must get their assistant')
})

test('the boundary is the measured cost plus the stated reserve, not a round guess', () => {
  const needed = 768 * 1024 * 1024 + 2 * GB
  assert.equal(memoryAdmission({ freeBytes: needed }).ok, true)
  assert.equal(memoryAdmission({ freeBytes: needed - 1 }).ok, false)
  // And both halves are callable, so a machine with a different profile can be
  // measured rather than argued about.
  assert.equal(memoryAdmission({ freeBytes: 1 * GB, circleBytes: 100, reserveBytes: 100 }).ok, true)
})

test('an unreadable free-memory figure admits the start rather than stopping the product', () => {
  // A gate that refuses because it could not measure turns one failed reading
  // into a computer that starts no assistants at all.
  for (const value of [undefined, null, NaN, Infinity, -1, 'lots']) {
    const admission = memoryAdmission({ freeBytes: value })
    assert.equal(admission.ok, true, `a freeBytes of ${String(value)} must not refuse the start`)
    assert.equal(admission.measured, false)
  }
})

test('the refusal is in the start vocabulary, so the person sees a sentence and not a bare code', () => {
  assert.ok(START_REFUSAL_CODES.includes('AGENT_MEMORY_LOW'))
})

test('the host reads free memory at every start, through an injectable seam', async () => {
  // The rule above is pure; this is the wiring. Asserted against the source
  // because constructing a real host needs an engine payload, and the property
  // under test is "startSession asks before it spawns", which is a property of
  // the order of the lines.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../../shell/agent-host.cjs', import.meta.url), 'utf8')
  const wrapper = declaredFunctionSource(source, 'startSession')
  assert.match(wrapper, /startSessionInner\(request(?:,\s*[^)]*)?\)/, 'the public start must invoke the measured admission path')
  const body = declaredFunctionSource(source, 'startSessionInner')
  const admissionAt = body.indexOf('memoryAdmission({')
  const planAt = body.indexOf('planConfinement({')
  assert.ok(admissionAt > 0, 'startSession no longer asks whether this computer has room')
  assert.ok(admissionAt < planAt || planAt === -1,
    'the memory question must be asked before the session is planned, not after')
  assert.match(body, /acknowledgeLowMemory/, 'the person has no way to override the refusal')
  assert.match(source, /freeMemory = os\.freemem/,
    'the free-memory reading is no longer injectable, so this rule can only be tested by filling a real machine')
})
