/* previewWithoutHost() AND exampleWasChosen() -- THE DISCRIMINATION BETWEEN
 * "the example is a choice this person made" and "the example is the only
 * thing this page could draw" -- had zero test coverage anywhere in this
 * suite before this file, and zero callers of exampleWasChosen() anywhere in
 * src/.
 *
 * src/views/settings.js's "Show the example fleet" row read isExampleMode()
 * alone and never asked previewWithoutHost(), so a person with no computer
 * connected at all -- a signed-out visitor, or someone whose desktop copy is
 * not this page -- saw a switch reading OFF beside "Turn it off to see your
 * own records again," while every screen kept showing the example regardless
 * of which way the switch was set. That promise cannot be kept in either
 * position: there is no host for the switch to hand real records back from.
 * Fixed in src/views/settings.js (exampleModeControlState(), and the row's
 * description) by asking previewWithoutHost() and disabling the row with the
 * reason written beside it, the house rule for a control that cannot succeed.
 *
 * This file drives the two functions the fix depends on WITH VALUES, not by
 * reading their source -- a fresh module import per test, because `resolved`
 * is a module-level cache data-source.js deliberately keeps for the life of
 * a page (see its own comment), and a shared instance across cases would let
 * one test's verdict leak into the next one's assertion. */

import assert from 'node:assert/strict'
import { test } from 'node:test'

let seq = 0
async function freshDataSource() {
  seq += 1
  return import(new URL(`../../src/data-source.js?case=${seq}`, import.meta.url).href)
}

function withLocalStorage(exampleOn) {
  const store = new Map()
  if (exampleOn) store.set('mc.example', 'on')
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  }
  return store
}

test('unreadable source inputs are could-not-tell, are not cached, and a real verdict still is cached', async () => {
  const {
    currentDataSource,
    DATA_SOURCE_READ_UNAVAILABLE,
    hostFallbackCode,
    hostFallbackSentence,
    resolveDataSource,
    setExampleMode,
  } = await freshDataSource()
  const ioError = Object.assign(new Error('the machine is busy'), { code: 'EIO' })
  let reads = 0
  globalThis.localStorage = {
    getItem: () => {
      reads += 1
      if (reads === 1) throw ioError
      return null
    },
  }
  globalThis.window = { mcShell: { getBridgeProof() {} } }

  await assert.rejects(resolveDataSource(), error => {
    assert.equal(error.code, DATA_SOURCE_READ_UNAVAILABLE, 'could-not-tell has its own machine-readable code')
    assert.match(error.message, /not a claim that it is absent/, 'the sentence must not turn the read failure into absence')
    assert.equal(error.cause, ioError, 'the EIO remains available to diagnostics')
    return true
  })
  assert.equal(currentDataSource(), null, 'a failed read must not cache or latch a source verdict')

  assert.equal(await resolveDataSource(), 'local', 'the same module retries after the transient read failure')
  assert.equal(reads, 2, 'the recovery came from a real second read, not a default substituted for EIO')
  assert.equal(currentDataSource(), 'local', 'CONTROL: a legitimate verdict is still cached for synchronous callers')

  const busy = Object.assign(new Error('busy'), { code: 'EBUSY' })
  globalThis.localStorage.removeItem = () => { throw busy }
  assert.throws(() => setExampleMode(false), error => (
    error.code === DATA_SOURCE_READ_UNAVAILABLE
    && /not a claim that it is absent/.test(error.message)
  ), 'a failed preference write must not be returned as a successfully applied value')

  /* THE HOST-FALLBACK READERS ARE DELIBERATELY EXEMPT, and this is where the
     exemption is recorded rather than left to look like an oversight.
     A loop here once required hostFallbackCode and hostFallbackSentence to THROW
     on an unreadable getter, by the same could-not-look rule the storage reads
     above correctly enforce. It was retired 2026-08-27 for three reasons, each
     checked in the tree rather than argued:
       1. null is not a claim about the world here. This channel carries
          pre-rendered WORDS, and null means "no better words than the ones you
          already have" -- every caller draws its own sentence. The storage reads
          are different: there, null really does assert "nothing is stored".
       2. Nobody can catch it. All three callers are synchronous and on the
          render path -- views/computers.js:581, :1597, :4260 -- and their results
          are interpolated straight into slot.innerHTML. A throwing getter aborts
          the markup expression, so the rail is never written: the wrong words
          become no page.
       3. The module's own contract prose says the opposite, unedited, directly
          above both functions: "A MISSING OR MALFORMED REASON IS NOT AN ERROR"
          and "an absent or malformed code is null, never an error". The tree was
          disagreeing with itself in writing.
     The storage assertions above are untouched: that is where the rule belongs. */
  delete globalThis.window
})

/* SCOPE NOTE, added when the signed-out simulation default landed: the two
   functions agree HERE because no window is installed in this case, so the
   default can never seed and a stored preference is the only way into the
   example. They are NOT interchangeable in general any more -- a signed-out
   visitor has isExampleMode() true and exampleWasChosen() false, which is the
   discrimination the front-door copy depends on and which the signed-out cases
   at the end of this file cover. Left as a scoped assertion rather than
   deleted: the mirror really is the contract when a choice is the only door. */
test('exampleWasChosen mirrors isExampleMode when a stored preference is the only way in', async () => {
  const { exampleWasChosen, isExampleMode } = await freshDataSource()

  withLocalStorage(false)
  assert.equal(exampleWasChosen(), false, 'nothing stored means the example was not chosen')
  assert.equal(exampleWasChosen(), isExampleMode(), 'the two must never be able to disagree')

  withLocalStorage(true)
  assert.equal(exampleWasChosen(), true, 'the stored preference means the example WAS chosen')
  assert.equal(exampleWasChosen(), isExampleMode(), 'the two must never be able to disagree')
})

test('previewWithoutHost is true only for a mock the person did not choose', async () => {
  const { previewWithoutHost } = await freshDataSource()
  withLocalStorage(false)

  assert.equal(previewWithoutHost('mock'), true, 'mock with nothing chosen is the forced case -- no host exists to hand real records back from')
  assert.equal(previewWithoutHost('local'), false, 'a real local host is never a forced preview, whatever the toggle reads')
  assert.equal(previewWithoutHost('relay'), false, 'a real relay host is never a forced preview, whatever the toggle reads')
  assert.equal(previewWithoutHost(null), false, 'not yet resolved is not yet a verdict, and must not read as forced')

  withLocalStorage(true)
  assert.equal(previewWithoutHost('mock'), false, 'mock with the toggle explicitly on is a CHOICE, not a forced preview')
})

test('previewWithoutHost, called with no argument, reads resolveDataSource\'s own settled verdict', async () => {
  const { previewWithoutHost, resolveDataSource } = await freshDataSource()
  withLocalStorage(false)

  /* No window at all: onDesktop() is false (mcShell is absent) and the bridge
     ask mission-bridge.js makes guards a missing window itself, so this is the
     stranger who followed the website's link with no host anywhere -- the
     case the failing row was actually measured against. */
  const settled = await resolveDataSource()
  assert.equal(settled, 'mock', 'no desktop and no relay transport settles on mock')
  assert.equal(previewWithoutHost(), true, 'with no argument it reads the verdict resolveDataSource just cached -- forced, not chosen')
})

test('a successful example write announces its current desktop verdict, while a failed write changes neither', async () => {
  const source = await freshDataSource()
  const store = withLocalStorage(true)
  const heard = []
  globalThis.window = {
    mcShell: { getBridgeProof() {} },
    dispatchEvent: event => {
      if (event.type === source.DATA_SOURCE_EVENT) heard.push({ source: source.currentDataSource(), preview: source.previewWithoutHost() })
      return true
    },
  }
  try {
    await source.resolveDataSource()
    assert.equal(source.currentDataSource(), 'mock')
    const remove = localStorage.removeItem
    localStorage.removeItem = () => { throw new Error('fixture preference locked') }
    assert.throws(() => source.setExampleMode(false), error => error.code === source.DATA_SOURCE_READ_UNAVAILABLE)
    assert.equal(source.currentDataSource(), 'mock')
    assert.equal(store.get('mc.example'), 'on')
    assert.deepEqual(heard, [])

    localStorage.removeItem = remove
    source.setExampleMode(false)
    assert.deepEqual(heard, [{ source: 'local', preview: false }], 'synchronous event readers must not see the previous example as an absent desktop')
    source.setExampleMode(true)
    assert.deepEqual(heard.at(-1), { source: 'mock', preview: false })
  } finally { delete globalThis.window }
})

test('turning the example off on a public page invalidates its old verdict until the host is asked', async () => {
  const source = await freshDataSource()
  withLocalStorage(true)
  delete globalThis.window
  await source.resolveDataSource()
  source.setExampleMode(false)
  assert.equal(source.currentDataSource(), null, 'the prior chosen example is not evidence about a public host')
  assert.equal(source.previewWithoutHost(), false, 'unknown is not an absence verdict')
  assert.equal(await source.resolveDataSource({ reask: true }), 'mock')
  assert.equal(source.previewWithoutHost(), true, 'a genuine no-host answer still disables the impossible choice')
})

/* THE SIGNED-OUT SIMULATION DEFAULT (owner ruling 2026-08-26).
 *
 * The property under test is NOT "a stranger sees mock data" -- they always
 * did, because no transport answers them. It is that the example becomes a
 * DELIBERATE simulation rather than a degraded fallback, which is what decides
 * the sentence they read, and that it can only happen when the host says in as
 * many words that nobody is signed in.
 *
 * Every case below drives the functions with values through a fresh module
 * instance. The signed-out default is module state on purpose (so it cannot
 * outlive the visit), and freshDataSource() is what keeps one case's state out
 * of the next one's assertion. */

function withAccount(current) {
  globalThis.window = current === undefined ? {} : { mcAccount: { current } }
  return globalThis.window
}

test('a signed-out visitor lands in the simulation, and it reads as a default rather than a choice', async () => {
  const { resolveDataSource, isExampleMode, exampleIsSignedOutDefault, exampleWasChosen, previewWithoutHost } = await freshDataSource()
  const store = withLocalStorage(false)
  withAccount(async () => ({ signedIn: false }))

  assert.equal(await resolveDataSource(), 'mock', 'a signed-out browser settles on the example')
  assert.equal(isExampleMode(), true, 'the simulation is ON for them, so the toggle and every badge agree')
  assert.equal(exampleIsSignedOutDefault(), true, 'and it is the default, which is what the copy keys on')
  assert.equal(exampleWasChosen(), false, 'they chose nothing -- calling this a choice would send them to a switch')
  assert.equal(previewWithoutHost(), false, 'nor is it a forced preview: the install sentence is not their next step')
  assert.equal(store.has('mc.example'), false, 'THE DEFAULT IS NEVER STORED -- it must not survive into a later signed-in visit')
})

test('a signed-in visitor keeps the real remote source when its transport is unavailable', async () => {
  const { resolveDataSource, isExampleMode, exampleIsSignedOutDefault, previewWithoutHost } = await freshDataSource()
  withLocalStorage(false)
  withAccount(async () => ({ signedIn: true, account: { id: 'a1' } }))

  assert.equal(await resolveDataSource(), 'relay', 'a failed transport is not permission to substitute example agents')
  assert.equal(isExampleMode(), false, 'but the simulation is NOT switched on underneath a signed-in person')
  assert.equal(exampleIsSignedOutDefault(), false, 'so nothing claims they chose a demo')
  assert.equal(previewWithoutHost(), false, 'the real source exposes its own unavailable/retry surface')
})

test('could-not-tell never reads as signed-out -- three ways of not knowing, none of them seeds the default', async () => {
  for (const [label, current] of [
    ['the account read throws', async () => { throw new Error('the account service could not be asked') }],
    ['the bridge is absent entirely', undefined],
    ['the answer omits signedIn', async () => ({})],
  ]) {
    const { resolveDataSource, exampleIsSignedOutDefault, isExampleMode } = await freshDataSource()
    withLocalStorage(false)
    withAccount(current)

    await resolveDataSource()
    assert.equal(exampleIsSignedOutDefault(), false, `${label}: not knowing must not be read as nobody being signed in`)
    assert.equal(isExampleMode(), false, `${label}: and the simulation must not switch itself on`)
  }
})

test('turning the switch off declines the default for the visit, and it does not re-assert', async () => {
  const { resolveDataSource, setExampleMode, isExampleMode, exampleIsSignedOutDefault } = await freshDataSource()
  const store = withLocalStorage(false)
  withAccount(async () => ({ signedIn: false }))

  await resolveDataSource()
  assert.equal(isExampleMode(), true, 'it starts on for them')

  setExampleMode(false)
  assert.equal(isExampleMode(), false, 'the switch actually works -- a control that cannot be turned off is decorative')

  await resolveDataSource()
  assert.equal(isExampleMode(), false, 'and a later resolve does not quietly turn it back on under them')
  assert.equal(exampleIsSignedOutDefault(), false, 'the decline holds for the rest of the visit')
  assert.equal(store.has('mc.example'), false, 'the decline is not stored either: the next VISIT starts on again, as ruled')
})

test('a stored choice stays a choice, even for a signed-out visitor', async () => {
  const { resolveDataSource, exampleIsSignedOutDefault, exampleWasChosen } = await freshDataSource()
  withLocalStorage(true)
  withAccount(async () => ({ signedIn: false }))

  await resolveDataSource()
  assert.equal(exampleWasChosen(), true, 'they turned it on themselves at some point')
  assert.equal(exampleIsSignedOutDefault(), false, 'so they get the switch sentence, not the sign-in one')
})

test('seeding the signed-out default ANNOUNCES it, so a surface that already painted corrects itself', async () => {
  /* THE DEFECT THIS PINS, measured on the live site: the seed is decided after
     an await (the host must be asked who is signed in), so every surface that
     painted in the meantime had read isExampleMode() as false. The
     quick-settings toggle drew unchecked and nothing ever told it otherwise --
     the simulation was on by every internal measure while the switch a person
     looks at said OFF. setExampleMode() had always announced; the seed did not,
     and that asymmetry was the entire bug. */
  const { resolveDataSource, isExampleMode, DATA_SOURCE_EVENT } = await freshDataSource()
  withLocalStorage(false)

  const heard = []
  const listener = (event) => { heard.push(event?.detail?.why ?? '(no why)') }
  globalThis.window = {
    mcAccount: { current: async () => ({ signedIn: false }) },
    addEventListener: (name, fn) => { if (name === DATA_SOURCE_EVENT) globalThis.__dsl = fn },
    dispatchEvent: (event) => { if (event?.type === DATA_SOURCE_EVENT) listener(event); return true },
  }

  await resolveDataSource()
  assert.equal(isExampleMode(), true, 'the simulation really is on')
  assert.equal(heard.length, 1, 'and exactly one change was announced, so painted surfaces can correct themselves')

  /* A second resolve must NOT announce again: it short-circuits on
     isExampleMode() before reaching the seed. An event per resolve would
     repaint the world on every navigation. */
  await resolveDataSource()
  assert.equal(heard.length, 1, 'a later resolve short-circuits and stays quiet')
})

test('concurrent signed-out resolutions announce one transition without suppressing later account changes', async () => {
  const { resolveDataSource, isExampleMode, DATA_SOURCE_EVENT } = await freshDataSource()
  withLocalStorage(false)

  const pending = []
  const heard = []
  globalThis.window = {
    mcAccount: { current: () => new Promise(resolve => pending.push(resolve)) },
    dispatchEvent: (event) => {
      if (event.type === DATA_SOURCE_EVENT) {
        heard.push({ why: event.detail.why, example: isExampleMode() })
      }
      return true
    },
  }

  // Both readers must be awaiting the account before either one can seed it.
  const first = resolveDataSource()
  const second = resolveDataSource()
  assert.equal(pending.length, 2, 'the account reads overlap')
  assert.equal(heard.length, 0, 'no default is announced before an explicit answer')

  pending[0]({ signedIn: false })
  assert.equal(await first, 'mock')
  assert.deepEqual(heard, [{ why: 'signed-out-default', example: true }],
    'the first completed read announces the new default to painted surfaces')

  pending[1]({ signedIn: false })
  assert.equal(await second, 'mock')
  assert.equal(heard.length, 1,
    'the later concurrent answer must not remount surfaces for an unchanged default')

  window.mcAccount.current = async () => ({ signedIn: true })
  await resolveDataSource({ reask: true })
  assert.equal(isExampleMode(), false, 'a positive sign-in still clears the seed')
  assert.deepEqual(heard.at(-1), { why: 'signed-in', example: false })

  window.mcAccount.current = async () => ({ signedIn: false })
  assert.equal(await resolveDataSource(), 'mock')
  assert.deepEqual(heard, [
    { why: 'signed-out-default', example: true },
    { why: 'signed-in', example: false },
    { why: 'signed-out-default', example: true },
  ], 'a later real signed-out transition still announces and badges the example')
})

test('signing in clears the simulation seed that being signed out created', async () => {
  /* A SEED DERIVED FROM BEING SIGNED OUT MUST NOT OUTLIVE SIGNING IN.
   *
   * `signedOutDefault` was set once, on the first resolve with nobody signed in,
   * and never cleared. isExampleMode() reads it, and resolveDataSource() returns
   * 'mock' on that check before anything re-asks. So a visitor could sign in
   * successfully and stay on the example fleet -- their real machines and every
   * real action hidden behind a badge -- with no way back except turning the
   * simulation off by hand or reloading the page.
   *
   * The simulation-on-for-signed-out visitors is deliberate and the owner asked
   * for it. Staying there after signing in is the defect.
   *
   * `reask` already existed for this exact moment; its own doc says "sign-in just
   * happened". It reached only the transport probe, forty lines past a
   * short-circuit it could never get to.
   *
   * DRIVEN as a person walks it: arrive signed out, sign in, resolve again.
   */
  const { resolveDataSource, isExampleMode } = await freshDataSource()
  withLocalStorage(false)

  let signedIn = false
  let asked = 0
  withAccount(async () => { asked += 1; return { signedIn } })

  await resolveDataSource()
  assert.equal(isExampleMode(), true,
    'a signed-out visitor no longer gets the simulation, which is the behaviour the owner asked for')
  const askedWhileSignedOut = asked

  signedIn = true
  await resolveDataSource({ reask: true })

  assert.equal(isExampleMode(), false,
    'signing in left the visitor on the example fleet: their real machines and actions stay hidden, and the '
    + 'only ways out are turning the simulation off by hand or reloading')
  assert.ok(asked > askedWhileSignedOut,
    'the account was never asked again, so the seed could not have been cleared by anything it learned')
})

test('a plain resolve does not spend a round trip re-asking who is signed in', async () => {
  /* THE CONTROL ON COST. Clearing the seed on EVERY resolve would put an account
     round trip on a path that runs on every view change. `reask` is the opt-in,
     and this pins that the ordinary path stays cheap. */
  const { resolveDataSource, isExampleMode } = await freshDataSource()
  withLocalStorage(false)

  let signedIn = false
  let asked = 0
  withAccount(async () => { asked += 1; return { signedIn } })

  await resolveDataSource()
  const after = asked
  signedIn = true
  await resolveDataSource()

  assert.equal(asked, after,
    'an ordinary resolve now asks the account service again, putting a round trip on every view change')
  assert.equal(isExampleMode(), true,
    'the seed cleared without anybody asking for a re-ask, which is the cost this control exists to prevent')
})

test('a stored example choice outranks a sign-in, and a decline is not undone', async () => {
  /* TWO CONTROLS, both on the same clearing branch. A person who CHOSE the
     example must keep it after signing in -- their choice outranks a seed -- and
     somebody who turned the simulation off must not have that decision reversed. */
  const chosen = await freshDataSource()
  withLocalStorage(true)
  withAccount(async () => ({ signedIn: true }))
  await chosen.resolveDataSource({ reask: true })
  assert.equal(chosen.isExampleMode(), true,
    'signing in threw away an example the person had deliberately chosen')

  const declined = await freshDataSource()
  withLocalStorage(false)
  let signedIn = false
  withAccount(async () => ({ signedIn }))
  await declined.resolveDataSource()
  declined.setExampleMode(false)
  signedIn = true
  await declined.resolveDataSource({ reask: true })
  assert.equal(declined.isExampleMode(), false,
    'the simulation came back after the person switched it off')
})

test('an unreachable account service does not clear the simulation seed', async () => {
  /* THIS IS WHY somebodyIsSignedIn() EXISTS RATHER THAN !nobodyIsSignedIn().
   *
   * nobodyIsSignedIn() answers FALSE for three different situations: somebody is
   * signed in, the bridge is absent, and the call threw. That is correct where it
   * is used -- it seeds the simulation only on an explicit signed-out answer.
   * Negating it reads all three as "somebody is signed in", so an account service
   * that is merely unreachable would clear the seed on the strength of an error,
   * and a signed-out visitor would be pulled out of the simulation by a failure.
   *
   * A mutation proved this test was owed: swapping the positive check for the
   * negated one left every other assertion in this file GREEN, because none of
   * them ever made the bridge fail.
   */
  for (const [label, bridge] of [
    ['the call throws', async () => { throw new Error('the account service is unreachable') }],
    ['the bridge is absent', undefined],
  ]) {
    const { resolveDataSource, isExampleMode } = await freshDataSource()
    withLocalStorage(false)

    let signedIn = false
    withAccount(async () => ({ signedIn }))
    await resolveDataSource()
    assert.equal(isExampleMode(), true, `${label}: the signed-out visitor did not get the simulation to begin with`)

    /* Now the account service stops answering, and a re-ask happens. */
    withAccount(bridge)
    await resolveDataSource({ reask: true })

    assert.equal(isExampleMode(), true,
      `${label}: an unreachable account service cleared the simulation seed, so a failure to ask was read `
      + 'as an answer that somebody is signed in')
  }
})
