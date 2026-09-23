import assert from 'node:assert/strict'
import test from 'node:test'

import { lendClaudeSignIn } from '../palette-keyboard-qa.mjs'

function fakeFs(statSync) {
  return {
    statSync,
    mkdirSync() {},
    cpSync() {},
    existsSync() { return false },
    symlinkSync() {},
  }
}

test('credential lookup separates absence from could-not-tell and does not latch either result', () => {
  const previousHome = process.env.USERPROFILE
  process.env.USERPROFILE = '/owner'
  try {
    const absent = Object.assign(new Error('missing'), { code: 'ENOENT' })
    assert.deepEqual(
      lendClaudeSignIn('/scratch', fakeFs(() => { throw absent })),
      { ok: false, code: 'CLAUDE_CREDENTIAL_ABSENT' },
      'CONTROL: the one error that means absent keeps the absent answer',
    )

    for (const thrown of [
      Object.assign(new Error('descriptor table busy'), { code: 'EMFILE' }),
      Object.assign(new Error('try again'), { code: 'EAGAIN' }),
      Object.assign(new Error('input/output failure'), { code: 'EIO' }),
      Object.assign(new Error('resource busy'), { code: 'EBUSY' }),
      'non-Error throw',
    ]) {
      const answer = lendClaudeSignIn('/scratch', fakeFs(() => { throw thrown }))
      assert.equal(answer.ok, false)
      assert.equal(answer.code, 'CLAUDE_CREDENTIAL_CHECK_FAILED')
      assert.match(answer.message, /NOT claiming.*absent/)
    }

    let checks = 0
    const transient = Object.assign(new Error('busy once'), { code: 'EMFILE' })
    const retryingFs = fakeFs(() => {
      checks += 1
      if (checks === 1) throw transient
    })
    assert.equal(lendClaudeSignIn('/scratch', retryingFs).code, 'CLAUDE_CREDENTIAL_CHECK_FAILED')
    assert.equal(lendClaudeSignIn('/scratch', retryingFs).code, 'CLAUDE_CREDENTIAL_LENT')
    assert.equal(checks, 2, 'a could-not-tell result is checked again rather than cached or latched')
  } finally {
    if (previousHome === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousHome
  }
})
