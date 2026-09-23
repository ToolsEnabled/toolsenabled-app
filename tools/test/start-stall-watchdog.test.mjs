/* A START THAT IS LATE HAS TO SAY SO.
 *
 * MEASURED on production on 2026-08-22, driving a real machine from a browser:
 * a start the machine accepted, whose engine then never launched, left
 * "Starting your agent. This takes a few seconds." on screen indefinitely, with
 * the node reading "not started yet". The request does settle eventually -- at
 * the transport's five-minute ceiling -- and for all five of those minutes the
 * screen keeps promising a few seconds.
 *
 * These hold the two things that make the fix honest rather than decorative:
 * it is NOT a failure message (nothing has been refused and it may still
 * arrive), and it names the one action that makes things worse. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { startStallMs, startStalledLine, START_PROGRESS } = await import(
  new URL('../../src/fleet-tree-copy.js', import.meta.url).href
)

test('a relay start is given longer than one on this computer', () => {
  const here = startStallMs({ driving: false })
  const driving = startStallMs({ driving: true })
  assert.ok(driving > here, 'a relay round trip is legitimately slower; crying wolf on every slow network is its own defect')
  assert.ok(here >= 10_000, 'shorter than this and an ordinary start looks broken')
})

test('both budgets are far below the transport ceiling', () => {
  /* The point is to speak BEFORE the five-minute failure, not to duplicate it. */
  for (const driving of [false, true]) {
    assert.ok(startStallMs({ driving }) < 120_000, 'a person will not wait two minutes on "a few seconds"')
  }
})

test('it does not claim a failure, because nothing has been refused yet', () => {
  for (const driving of [false, true]) {
    const said = startStalledLine({ driving })
    assert.ok(!/failed|could not|did not start|refused/i.test(said), said)
    assert.ok(/may still arrive/i.test(said), 'the honest state is late, not dead')
  }
})

test('it names the thing that makes it worse', () => {
  for (const driving of [false, true]) {
    const said = startStalledLine({ driving })
    assert.ok(/press Start again/i.test(said), 'pressing again is how two agents get started for one job')
  }
})

test('driving from a browser is told where to look, since it cannot be here', () => {
  const driving = startStalledLine({ driving: true })
  const here = startStalledLine({ driving: false })
  assert.ok(/on that computer/i.test(driving), driving)
  assert.ok(!/on that computer/i.test(here), 'somebody at their own desk is already there')
})

test('it replaces the promise it is correcting', () => {
  assert.notEqual(startStalledLine({ driving: true }), START_PROGRESS.starting)
})

test('the view arms it and disarms it in a finally', async () => {
  const view = await readFile(path.join(ROOT, 'src', 'views', 'computers.js'), 'utf8')
  const at = view.indexOf('const stallTimer = setTimeout(')
  assert.ok(at > 0, 'the watchdog must be armed around the start')
  const region = view.slice(at, at + 700)
  assert.ok(/finally\s*\{[^}]*clearTimeout\(stallTimer\)/.test(region),
    'a start that THROWS must not leave a timer behind to overwrite its own refusal a minute later')
  assert.ok(/currentDataSource\(\) === 'relay'/.test(view.slice(at - 300, at)),
    'the budget must come from where the machine is')
})
