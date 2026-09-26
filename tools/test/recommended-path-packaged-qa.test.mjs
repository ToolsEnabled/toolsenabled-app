import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const source = readFileSync(new URL('../recommended-path-packaged-qa.mjs', import.meta.url), 'utf8')
const expression = source.match(/const READ_AGENT_PAGE = `([\s\S]*?)`\n\nasync function withApp/)?.[1]

assert.ok(expression, 'READ_AGENT_PAGE expression is present in the packaged QA command')

function readPage(getItem) {
  return vm.runInNewContext(expression, {
    document: { querySelector: () => null },
    localStorage: { getItem },
  })
}

test('setup-profile read failure is not reported as an absent autonomy answer', () => {
  const result = readPage(key => {
    if (key === 'mc.setup.profile') throw Object.assign(new Error('machine is busy'), { code: 'EBUSY' })
    return null
  })

  assert.deepEqual({ ...result.autonomy }, {
    code: 'COULD_NOT_READ_SETUP_PROFILE',
    causeCode: 'EBUSY',
    message: 'Could not read the setup profile; this does not claim that the profile or autonomy answer is absent.',
  })
})

test('a code-less non-Error throw remains could-not-tell', () => {
  const result = readPage(key => {
    if (key === 'mc.setup.profile') throw 'temporarily unavailable'
    return null
  })

  assert.equal(result.autonomy.code, 'COULD_NOT_READ_SETUP_PROFILE')
  assert.equal(result.autonomy.causeCode, 'NO_ERROR_CODE')
})

test('CONTROL: a genuinely absent setup profile keeps the absent answer', () => {
  let reads = 0
  const absent = () => { reads += 1; return null }

  assert.equal(readPage(absent).autonomy, null)
  assert.equal(readPage(absent).autonomy, null)
  assert.equal(reads, 4, 'each page read probes both keys again rather than latching a result')
})
