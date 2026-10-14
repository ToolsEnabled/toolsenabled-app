/* A REMEMBERED FAILURE IS A DEAD PAGE UNTIL YOU LEAVE IT.
 *
 * THE OWNER'S REQUIREMENT: page 2 must not "get stuck ... after super long".
 * This is that, in its most literal form.
 *
 * prepareBridgeOnce() memoises an expensive check — bridgeStatus() parses every
 * root's queue and writes durable audit receipts, about twelve seconds — so not
 * running it on every node click is correct and stays. What was wrong is that it
 * remembered WHATEVER came back. The first press deciding "the bridge is
 * unreachable" made that the answer for the whole life of the view: a person who
 * read the refusal, fixed the cause and pressed again got the same stale
 * sentence, with all three start controls saying "checking the audited
 * connection..." while checking nothing. The only way out was leaving the page
 * and returning, and nothing tells anyone to do that.
 *
 * THREE PROPERTIES HAVE TO HOLD AT ONCE, which is why this is not a one-liner:
 *   1. a settled FAILURE is not remembered — the next press tries again;
 *   2. a SUCCESS is remembered — the twelve-second call does not run per click;
 *   3. presses that arrive while one attempt is IN FLIGHT share it, rather than
 *      each starting their own.
 * Dropping the memo entirely satisfies 1 and breaks 2 and 3. Keeping it as it
 * was satisfies 2 and 3 and breaks 1.
 *
 * WHY THE SEMANTICS ARE EXERCISED HERE AND THE FILE IS ONLY READ. views/
 * computers.js imports stylesheets, so `node --test` cannot load it, and
 * prepareBridgeOnce is a closure with no seam. So this suite does both halves
 * and neither alone would be worth much: it RUNS the memo shape to prove the
 * three properties are actually compatible, and it READS the file to prove that
 * is the shape the file uses. A behaviour test over a shape the product does not
 * use is a test of nothing.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VIEW = path.join(HERE, '..', '..', 'src', 'views', 'computers.js')
const SOURCE = readFileSync(VIEW, 'utf8')
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

/** The memo shape the view uses, isolated so its behaviour can be driven. */
function memoUnderTest(answers) {
  let calls = 0
  let memo = null
  return {
    calls: () => calls,
    run() {
      if (!memo) {
        memo = Promise.resolve()
          .then(() => { calls += 1; return answers[Math.min(calls - 1, answers.length - 1)] })
          .then((result) => { if (!result || result.ok !== true) memo = null; return result })
      }
      return memo
    },
  }
}

test('a settled failure is not remembered, so a person who fixes the cause can retry', async () => {
  const memo = memoUnderTest([{ ok: false, reason: 'down' }, { ok: false, reason: 'down' }, { ok: true }])
  assert.equal((await memo.run()).ok, false, 'first press sees the failure')
  assert.equal((await memo.run()).ok, false, 'second press tries again and still fails')
  assert.equal((await memo.run()).ok, true,
    'the third press must see the repaired bridge — a remembered failure would still say down')
  assert.equal(memo.calls(), 3, 'each press after a failure is a real attempt')
})

test('a success IS remembered, so the twelve-second call does not run per click', async () => {
  const memo = memoUnderTest([{ ok: true }])
  await memo.run(); await memo.run(); await memo.run()
  assert.equal(memo.calls(), 1,
    'three presses after a success must cost one call — this is the reason the memo exists')
})

test('presses arriving while an attempt is in flight share it', async () => {
  const memo = memoUnderTest([{ ok: true }])
  const [a, b] = await Promise.all([memo.run(), memo.run()])
  assert.equal(memo.calls(), 1, 'a concurrent press must not start a second attempt')
  assert.deepEqual(a, b)
})

test('and that is the shape the view actually uses', () => {
  /* Without this the three tests above prove something true about a shape
     nobody ships. */
  const at = CODE.indexOf('function prepareBridgeOnce()')
  assert.ok(at > 0, 'prepareBridgeOnce not found — rewrite this guard with it')
  const body = CODE.slice(at, at + 900)

  assert.match(body, /bridgePrep\s*=\s*null/,
    'nothing in prepareBridgeOnce clears the memo, so a failure is remembered for the life of the view')
  assert.match(body, /ok\s*!==\s*true|!\s*result\.ok|result\.ok\s*===\s*false/,
    'the clear must be conditional on the result being a failure')
  assert.match(body, /if\s*\(!bridgePrep\)/,
    'the memo must still short-circuit, or the expensive call runs on every click')
})
