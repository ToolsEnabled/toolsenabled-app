#!/usr/bin/env node

/* THE TWO PANELS THE OWNER COULD NOT READ, ON REAL GLASS, IN EVERY STATE THAT
 * MATTERS, REACHED BY CLICKING.
 *
 * His findings, verbatim: the Codex Cloud panel is "almost impossible for a
 * human to make any meaning of" (item 8), and the R-ledger panel "is a mess
 * (not human friendly)" (item 11).
 *
 * WHAT THIS ANSWERS THAT A SOURCE SUITE CANNOT. Both defects are properties of
 * the COMPOSED screen -- the same refusal in two adjacent boxes, an empty-state
 * paragraph inside failure-state chrome, a field describing itself in terms of
 * a list that is not there. tools/check-composed-output.mjs measures that from
 * the modules, which is the right gate and is still a model of the screen. This
 * reads the SCREEN: the packaged application, its own bundle, its own
 * stylesheet, a sterile profile, and text read back out of the DOM after real
 * clicks and real keystrokes.
 *
 * NO STATE HERE IS FAKED, and that is the rule this file is built around.
 *   - "no account signed in" is a profile with no account registry in it.
 *   - "the account registry cannot be read" is a registry file that genuinely
 *     is not JSON. The sentence on the glass is the one the engine's own reader
 *     produced, scrubbed of the file path, not a string this harness supplied.
 *   - "the request list cannot be read" is the projection file genuinely absent
 *     from the build, answered 404 by the application's own server.
 *   - "the request list has rows in it" is a valid projection the application
 *     validates against its own schema before drawing.
 * Nothing here writes a sentence into the page and then reads it back.
 *
 * IT SPENDS NOTHING. The accounts in the populated reading point at directories
 * that exist and hold no credential, so the provider probe answers "signed
 * out" -- an account ROW with a reason on it, which is the state a person on a
 * fresh machine is actually in. No cloud task is launched and no provider
 * budget is touched.
 *
 * NAVIGATION IS BY CLICKING. This product's navigation is two arrows, a gear
 * and the links on the pages; auditSelf() below fails the run if this file ever
 * reaches a page by assigning location.hash, because a harness that jumps
 * passes in full on a build where nothing routes there.
 *
 * Run: node tools/panel-readability-qa.mjs [--visible] [--release <dir>]
 */

import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REPO_ROOT,
  assertIsolated,
  closeDrawer,
  closeWindow,
  createLedger,
  delay,
  describeTimeline,
  gotoHome,
  gotoSettings,
  openDrawer,
  openWindow,
  releaseDirectory,
  route,
  scratchDirectory,
  seedMachineRecord,
  stage,
  writeEvidence,
} from './test-account-harness.mjs'
/* THE GUARD EVERY dist/-STAGING HARNESS IN THIS REPOSITORY SHARES, and it is
 * not a formality here -- it is the exact failure this file hit.
 *
 * An early version of restageArchive() produced a torn renderer, and the
 * symptom was not an exception: the window painted a title, a settings drawer,
 * an empty stage, and never wrote a route. Three runs of this harness reported
 * "the ledger is unreachable" and "Settings is unreachable" about a product
 * that was fine. tools/lib/staged-renderer.mjs names that exact symptom in its
 * own header, which is why tools/test/staged-renderer-guard.test.mjs requires
 * every harness that stages dist/ to call it rather than reimplement it. */
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'

const require_ = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)

function auditSelf() {
  return readFileSync(SELF, 'utf8')
    .split('\n')
    .map((line, at) => ({ line, at: at + 1 }))
    .filter(({ line }) => /location\.hash\s*=[^=]/.test(line))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
}

/* ------------------------------------------------------------- fixtures -- */

/* A projection with rows in it, in the exact envelope the application
   validates against dist/data/schema/ledger.schema.json before it will draw
   anything. A payload this harness invented that did NOT validate would be
   drawn as "could not be read", and the run would then have proved the failure
   path while reporting the populated one. */
function populatedLedger() {
  const at = new Date().toISOString()
  return {
    schemaVersion: 1,
    domain: 'ledger',
    generatedAt: at,
    ok: true,
    reason: null,
    sources: [{ id: 'harness', kind: 'file', path: 'panel-readability-qa', ok: true, observedAt: at, reason: null }],
    data: {
      requests: [
        { id: 'R1152', status: 'open', gateCount: 3, unmetGateCount: 1 },
        { id: 'R1161', status: 'in-progress', gateCount: 2, unmetGateCount: 0 },
        { id: 'R1186', status: 'gated', gateCount: 4, unmetGateCount: 4 },
      ],
      questions: { ok: true, reason: null, observedAt: at, value: [] },
    },
  }
}

/* Two accounts a person really could have declared, pointing at directories
   that exist and are empty. The provider probe reads them and answers "signed
   out", which is a ROW WITH A REASON -- the populated-but-not-usable reading,
   and the one that costs nothing to produce. */
function accountRegistry(home) {
  return {
    schemaVersion: 1,
    exhaustedAtPercent: 95,
    accounts: [
      /* `profileDir`, not `home`. The first attempt wrote `home` and the panel
         answered "Account entry 0 is a codex account, so it is missing a
         profileDir" -- which is the repaired refusal pipeline doing its job on
         this harness's own mistake, and is the reason that sentence is quoted
         in the report rather than hidden. */
      { name: 'work', role: 'builder', priority: 1, provider: 'codex', profileDir: path.join(home, '.codex-work') },
      { name: 'personal', role: 'reviewer', priority: 2, provider: 'codex', profileDir: path.join(home, '.codex-personal') },
    ],
  }
}

/* --------------------------------------------------------------- staging -- */

/* The application serves /data/*.json out of its own bundle, so a state that is
   ABOUT that file is produced by changing that file -- inside the real archive,
   in the staged copy, never in this repository. `mutate` receives the extracted
   tree and does whatever the state requires; absent, the build is left exactly
   as staged. */
async function restageArchive(scratch, appRoot, mutate) {
  const asar = require_(path.join(REPO_ROOT, 'node_modules', '@electron', 'asar'))
  const work = path.join(scratch, `asar-${Math.random().toString(16).slice(2, 8)}`)
  rmSync(work, { recursive: true, force: true })
  /* FROM THE ORIGINAL ARCHIVE EVERY TIME, NEVER FROM THE ONE THIS FUNCTION LAST
     WROTE.
   *
   * The first version extracted the STAGED archive and repacked it, and the
   * application then never booted: no route was ever written to the page, and
   * the run reported that Settings was unreachable. A second extract-and-repack
   * round trip does not survive. Going back to the release's own archive and
   * redoing exactly what stage() does -- extract, overlay this tree's dist/ and
   * shell/, copy package.json -- makes every phase identical to a fresh stage
   * plus one file, which is the only difference this harness is entitled to
   * introduce. */
  assertRendererMeasurable({ repoRoot: REPO_ROOT, sourceDist: path.join(REPO_ROOT, 'dist') })
  asar.extractAll(path.join(releaseDirectory(), 'resources', 'app.asar'), work)
  for (const directory of ['dist', 'shell']) {
    rmSync(path.join(work, directory), { recursive: true, force: true })
    cpSync(path.join(REPO_ROOT, directory), path.join(work, directory), { recursive: true })
  }
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(work, 'package.json'))
  /* Checked BEFORE the mutation, because a phase that deliberately removes a
     projection file would otherwise trip a guard about a difference it asked
     for. What has to be whole is the renderer, and it is whole at this line. */
  assertStagedRendererConsistent({
    stagedDist: path.join(work, 'dist'),
    sourceDist: path.join(REPO_ROOT, 'dist'),
  })
  mutate(work)
  /* AWAITED, and the first run of this harness is why it says so. createPackage
     returns a promise; without the await the application was started against an
     archive that was still being written, and every phase died with "no
     debuggable page appeared" -- a failure that reads like a broken product and
     was a broken harness. */
  await asar.createPackage(work, path.join(appRoot, 'resources', 'app.asar'))
  rmSync(work, { recursive: true, force: true })
}

/* ------------------------------------------------------------- reading ---- */

/* Everything the ledger panel puts on the screen at once, read out of the DOM
   rather than out of the modules that produced it. */
const READ_LEDGER = `(() => {
  const page = document.querySelector('.ledger-page')
  if (!page) return { present: false, route: location.hash }
  const register = page.querySelector('.ledger-register')
  const surface = page.querySelector('.ledger-write-surface')
  const decision = surface?.querySelector('[data-decision-form]')
  const queue = surface?.querySelector('[data-queue-form]')
  const target = decision?.elements?.target
  const text = node => (node?.textContent || '').replace(/\\s+/g, ' ').trim()
  return {
    present: true,
    route: location.hash,
    projectionState: page.dataset.projectionState || null,
    liveMode: page.dataset.liveMode || null,
    registerParagraph: text(register?.querySelector('.ledger-empty')),
    registerParagraphClass: register?.querySelector('.ledger-empty')?.className || null,
    registerLabel: register?.getAttribute('aria-label') || null,
    registerReason: register?.dataset?.registerReason || null,
    counter: text(page.querySelector('[data-visible-count]')),
    totals: [...page.querySelectorAll('[data-summary]')].map(node => node.textContent),
    rows: page.querySelectorAll('.ledger-record').length,
    /* THE × ON EVERY ROW (plan P-O6), measured rather than assumed: one per
       row, never a button inside a button (the Q row is itself a button, so
       the × must be its sibling), and the first and last ×'s hit box must be
       inside the viewport at every width this harness drives -- at 390px the
       control sits at about x=380. hiddenNote is the toolbar sentence after
       a hide. */
    xCount: page.querySelectorAll('.ledger-hide').length,
    nestedButtons: page.querySelectorAll('button button').length,
    xHit: [...page.querySelectorAll('.ledger-hide')].filter((node, index, all) => index === 0 || index === all.length - 1)
      .map(node => {
        const box = node.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return Boolean(hit && (hit === node || node.contains(hit)))
      }),
    xInView: [...page.querySelectorAll('.ledger-hide')].filter((node, index, all) => index === 0 || index === all.length - 1)
      .map(node => {
        const box = node.getBoundingClientRect()
        return box.width >= 20 && box.height >= 20 && box.left >= 0 && box.right <= window.innerWidth
      }),
    hiddenNote: text(page.querySelector('[data-hidden-note]')),
    door: text(register?.querySelector('.host-absent-action')),
    surface: {
      present: Boolean(surface),
      registerState: surface?.dataset?.registerState || null,
      bridgeState: surface?.dataset?.bridgeState || null,
      status: text(surface?.querySelector('[data-write-status]')),
      decisionHint: text(decision?.querySelector('[data-decision-hint]')),
      decisionHintState: decision?.querySelector('[data-decision-hint]')?.dataset?.state || null,
      targetKind: target ? target.tagName.toLowerCase() : null,
      targetOptions: target && target.tagName === 'SELECT' ? [...target.options].map(o => o.textContent) : null,
      approveDisabled: decision?.querySelector('[data-decision="approve"]')?.disabled ?? null,
      decisionOutput: text(decision?.querySelector('[data-action-output]')),
      /* MEASURED, NOT ASKED. hidden is an attribute, and the form's own rule
         sets display:grid, which beats the user-agent rule -- so the form was
         on the screen while every probe that read the attribute said it was
         not. What counts is whether it is painted. */
      queueHidden: queue ? (getComputedStyle(queue).display === 'none' || queue.getBoundingClientRect().height < 1) : null,
      queueHiddenAttribute: queue ? queue.hasAttribute('hidden') : null,
      queueRevealLabel: text(surface?.querySelector('[data-queue-reveal]')),
      queueLine: text(queue?.querySelector('[data-action-output]')),
      hashFieldVisible: queue ? [...queue.querySelectorAll('input')].some(i => i.name === 'expectedHash' && i.type !== 'hidden') : null,
    },
    /* Every paragraph on the panel, so a duplicate cannot hide behind a
       selector this harness forgot to name. */
    everySentence: [...page.querySelectorAll('.ledger-empty, .write-form-hint, [data-action-output], [data-write-status]')]
      .map(node => (node.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean),
  }
})()`

const READ_CLOUD = `(() => {
  const surface = document.querySelector('.cloud-surface') || document.querySelector('.board-cloud-box')
  if (!surface) return { present: false, route: location.hash }
  const text = node => (node?.textContent || '').replace(/\\s+/g, ' ').trim()
  const slot = selector => {
    const node = surface.querySelector(selector)
    if (!node) return null
    return { text: text(node), state: node.dataset?.state || null, hidden: node.hasAttribute('hidden'), code: node.getAttribute('data-refusal-code') }
  }
  const accounts = surface.querySelector('select[name="account"]')
  const environments = surface.querySelector('select[name="environment"]')
  return {
    present: true,
    route: location.hash,
    kind: surface.className,
    off: surface.hasAttribute('data-cloud-off'),
    status: text(surface.querySelector('[data-cloud-status]')),
    offReason: text(surface.querySelector('[data-cloud-off-reason]')),
    list: slot('[data-cloud-list-output], [data-cloud="list-out"]'),
    environments: slot('[data-cloud-environments-output], [data-cloud="environments-out"]'),
    launch: slot('[data-cloud-launch-output], [data-cloud="out"]'),
    watch: slot('[data-cloud-watch], [data-cloud="watch"]'),
    binding: slot('[data-cloud-binding]'),
    accountOptions: accounts ? [...accounts.options].map(o => o.textContent) : null,
    environmentOptions: environments ? [...environments.options].map(o => o.textContent) : null,
    /* THE MEASUREMENT THE OWNER'S FINDING IS ACTUALLY ABOUT: every paragraph
       this panel is showing right now, in order, so two of them saying the same
       thing is visible as a fact rather than inferred. */
    everySentence: [...surface.querySelectorAll('output')]
      .filter(node => !node.hasAttribute('hidden'))
      .map(node => (node.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean),
  }
})()`

/* --------------------------------------------------------------- driving -- */

/* A SCREENSHOT FROM A WINDOW THAT IS NOT COMPOSITING.
 *
 * Under MC_SMOKE_HEADLESS the window is created with show:false, and
 * Page.captureScreenshot then WAITS FOR A FRAME THAT WILL NEVER BE PRODUCED --
 * it does not fail, it simply never answers, and the first run of this harness
 * hung on exactly that with the whole phase already measured. Three things are
 * needed and all three were learned the hard way:
 *
 *   Page.enable, because the domain is not on by default over a bare socket;
 *   setWebLifecycleState 'active', which puts the page back in a state that
 *     produces frames;
 *   and a DEADLINE, because a capture that hangs must cost this run a missing
 *     image and nothing else. A screenshot is evidence, not the measurement --
 *     the text read back out of the DOM is the measurement, and it is already
 *     in hand by the time this is called.
 */
async function shot(window, scratch, name) {
  const deadline = new Promise(resolve => setTimeout(() => resolve(null), 25_000))
  const capture = (async () => {
    try { await window.session.send('Page.enable', {}) } catch { /* already on */ }
    try { await window.session.send('Page.setWebLifecycleState', { state: 'active' }) } catch { /* older builds */ }
    /* THE OVERRIDE IS WHAT MAKES A HIDDEN WINDOW PRODUCE A FRAME. With
       show:false the compositor has nothing to hand over and captureScreenshot
       does not fail -- it simply never answers. Emulation.setDeviceMetricsOverride
       gives the page a surface of its own to paint into, which is the same
       mechanism headless capture uses. */
    await window.session.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
    })
    await delay(700)
    const packet = await window.session.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true })
    try { await window.session.send('Emulation.clearDeviceMetricsOverride', {}) } catch { /* nothing to clear */ }
    return packet?.result?.data || null
  })()
  let data = await Promise.race([capture, deadline])
  if (!data) {
    /* ONE RETRY, because the capture is timing-dependent rather than broken: a
       window created with show:false produces a frame when it is asked twice
       often enough that a single miss says nothing. A second miss is reported
       as a missing image and never as a missing measurement -- the text read
       back out of the DOM is the measurement, and it is already in hand. */
    await delay(1500)
    data = await Promise.race([
      (async () => {
        try { await window.session.send('Page.setWebLifecycleState', { state: 'active' }) } catch { /* older builds */ }
        await window.session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
        await delay(1200)
        const again = await window.session.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
        try { await window.session.send('Emulation.clearDeviceMetricsOverride', {}) } catch { /* nothing to clear */ }
        return again?.result?.data || null
      })(),
      new Promise(resolve => setTimeout(() => resolve(null), 25_000)),
    ])
  }
  if (!data) return 'NOT CAPTURED (the hidden window produced no frame in two attempts)'
  const file = path.join(scratch, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

/* THE TWO AUDITED LEDGER ACTIONS, TURNED ON FROM THE SCREEN THAT OWNS THEM.
 *
 * Not by writing the flag. The claim under test is partly that a person can
 * FIND these, and a harness that sets localStorage would pass on a build whose
 * Settings screen had lost the row. The Write category is opened first, then
 * every collapsed tier inside it, because the rows live behind a reveal. */
async function enableWriteActions(window, led) {
  /* THROUGH THE HARNESS'S OWN NAVIGATION, and the first attempt is why.
     Reaching Settings by guessing at a toolbar selector left the drawer open --
     it is `role="dialog" aria-modal="true"` and it parks the stage behind it
     with `inert`, so every later click landed on its backdrop and the run
     reported that the ledger was unreachable. That is a finding about the
     harness wearing the costume of a finding about the product. gotoSettings()
     closes the drawer behind itself; closeDrawer() below is the belt to its
     braces. */
  const opened = await gotoSettings(window)
  led.check('the Settings screen is reachable by clicking, from home, through the drawer',
    opened === 'clicked' || opened === 'already-there', opened)
  await delay(1200)
  /* The rail's groups ship collapsed; open them the way a person does, so the
     category this driver wants is a button on the screen. */
  await window.evaluate(`(() => { for (const head of document.querySelectorAll('.settings-rail [data-rail-group][aria-expanded="false"]')) head.click(); return true })()`)
  await delay(400)
  await window.clickVisible('.settings-rail button[data-category="Things it may do for you"]')
  await delay(1000)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const more = await window.evaluate(`Boolean(document.querySelector('.settings-reveal[data-reveal-section="Things it may do for you"][aria-expanded="false"]'))`)
    if (!more) break
    await window.clickVisible('.settings-reveal[data-reveal-section="Things it may do for you"][aria-expanded="false"]')
    await delay(500)
  }
  for (const id of ['write_decision', 'write_queue']) {
    const before = await window.evaluate(`localStorage.getItem(${JSON.stringify(`mc.write.${id.slice(6)}`)})`)
    const clicked = await window.clickVisible(`[data-setting-id="${id}"] .settings-toggle`)
    await delay(700)
    const after = await window.evaluate(`localStorage.getItem(${JSON.stringify(`mc.write.${id.slice(6)}`)})`)
    led.check(`the ${id.slice(6)} switch is on the Settings screen and answers a real click`,
      clicked === 'clicked' && after === 'enabled', `${clicked} ${String(before)} -> ${String(after)}`)
  }
  await closeDrawer(window)
  const home = await gotoHome(window)
  led.note(`back to home before walking the ring: ${home} (route ${await route(window)})`)
}

/* The route as the application itself names it, rather than as a hash string:
   home is the empty hash, so a harness that compared hashes reported "" and
   read as a page that had not loaded. */
/* WAIT FOR THE APPLICATION TO SAY WHERE IT IS.
 *
 * openWindow returns as soon as a debuggable page answers, which is before the
 * router has written body[data-route]. A run that started clicking then found
 * no route, walked the ring looking for one, found no arrows either, and
 * reported that Settings was unreachable -- a finding about a harness that did
 * not wait. */
async function waitForRoute(window, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const here = await route(window)
    if (typeof here === 'string' && here.length > 0) return here
    if (Date.now() >= until) return here || '(never named a route)'
    await delay(400)
  }
}

async function walkTo(window, want, steps = 14) {
  await closeDrawer(window)
  let here = await route(window)
  for (let step = 0; step < steps && here !== want; step += 1) {
    const clicked = await window.clickVisible('#nav-next')
    if (clicked !== 'clicked') return { route: here, clicked }
    await delay(700)
    here = await route(window)
  }
  return { route: here, clicked: 'clicked' }
}

async function main() {
  const offenders = auditSelf()
  if (offenders.length > 0) {
    for (const { line, at } of offenders) console.error(`  self-audit: line ${at} navigates by assigning the hash: ${line.trim()}`)
    process.exitCode = 2
    return
  }

  const led = createLedger()
  const scratch = scratchDirectory('panel-readability')
  console.log(`scratch: ${scratch}`)
  const evidence = {}
  let staged = null

  const shipped = readFileSync(path.join(REPO_ROOT, 'dist', 'data', 'ledger.json'), 'utf8')

  /* Each state gets its own profile and its own launch. Sharing one would make
     "no account signed in" depend on what an earlier phase left behind, which
     is exactly the kind of inherited state a first-run finding must not be
     measured through. */
  const phases = [
    {
      id: 'ledger-empty',
      why: 'the state a stranger meets: this copy keeps no request register',
      archive: null,
      panel: 'ledger',
    },
    {
      id: 'ledger-unreadable',
      why: 'the request list genuinely cannot be read -- the file is not in this build, and the application answers its own 404',
      archive: tree => rmSync(path.join(tree, 'dist', 'data', 'ledger.json'), { force: true }),
      panel: 'ledger',
    },
    {
      id: 'ledger-populated',
      why: 'a copy that really does keep a register, with rows the form can act on',
      archive: tree => writeFileSync(path.join(tree, 'dist', 'data', 'ledger.json'), `${JSON.stringify(populatedLedger(), null, 2)}\n`),
      panel: 'ledger',
      approve: true,
    },
  ]

  try {
    staged = await stage(scratch)
    console.log(`staged: ${staged.appRoot}`)

    /* --cloud-only re-runs the Codex Cloud half without repeating three ledger
       phases that are already recorded. It is a convenience for iterating on
       ONE panel; the default is the whole matrix, and a report that quotes a
       --cloud-only run must say so. */
    const only = process.argv.includes('--cloud-only') ? [] : phases
    for (const phase of only) {
      console.log(`\n--- ${phase.id} — ${phase.why}`)
      await restageArchive(scratch, staged.appRoot, tree => {
        writeFileSync(path.join(tree, 'dist', 'data', 'ledger.json'), shipped)
        if (phase.archive) phase.archive(tree)
      })
      const profile = path.join(scratch, `profile-${phase.id}`)
      mkdirSync(profile, { recursive: true })
      seedMachineRecord(profile, staged.appRoot, 'standard')
      const window = await openWindow(staged.executable, profile)
      try {
        led.note(`${phase.id}: the application opened on ${await waitForRoute(window)}`)
        await delay(1200)
        /* THE PANEL SHIPS OFF, and a panel nobody can reach is not a panel this
           run can report on. Both switches are turned on the way a person turns
           them on: the Settings screen, reached with the gear, one hit-tested
           click per row. */
        await enableWriteActions(window, led)
        const walked = await walkTo(window, 'ledger')
        led.check(`${phase.id}: the ledger is reachable by clicking the route arrows`, walked.route === 'ledger', JSON.stringify(walked))
        await delay(2600)
        const reading = await window.evaluate(READ_LEDGER)
        evidence[phase.id] = reading
        console.log(JSON.stringify(reading, null, 2))
        console.log(`  screenshot: ${await shot(window, scratch, phase.id)}`)

        led.check(`${phase.id}: the panel is on the glass`, reading?.present === true, JSON.stringify(reading).slice(0, 160))
        if (reading?.present) {
          const says = reading.everySentence.join(' || ')
          const failure = /could not be read|unavailable|refused/i
          const empty = /nothing here to show|there is nothing|there are none/i
          if (phase.id === 'ledger-empty') {
            led.check('ledger-empty: the page calls it empty, not unreadable', reading.projectionState === 'empty', String(reading.projectionState))
            led.check('ledger-empty: nothing on the panel says the requests could not be read',
              !failure.test(`${reading.registerParagraph} ${reading.registerLabel} ${reading.counter}`),
              `${reading.registerLabel} | ${reading.counter}`)
            led.check('ledger-empty: Approve is off, and the reason is on the screen beside it',
              reading.surface.approveDisabled === true && empty.test(reading.surface.decisionHint),
              reading.surface.decisionHint)
          }
          if (phase.id === 'ledger-unreadable') {
            led.check('ledger-unreadable: the page calls it unreadable', reading.projectionState === 'unreadable', String(reading.projectionState))
            led.check('ledger-unreadable: and nothing on it also claims there is simply nothing here',
              !empty.test(`${reading.registerParagraph} ${reading.registerLabel} ${reading.counter}`), says.slice(0, 200))
            led.check('ledger-unreadable: the underlying reason travels as data, not as a sentence',
              typeof reading.registerReason === 'string' && reading.registerReason.length > 0
              && !reading.registerParagraph.includes(reading.registerReason),
              String(reading.registerReason))
          }
          if (phase.id === 'ledger-populated') {
            led.check('ledger-populated: the register draws its rows', reading.rows >= 3, String(reading.rows))
            led.check('ledger-populated: the “Which request” field is a picker filled from those rows',
              reading.surface.targetKind === 'select' && (reading.surface.targetOptions || []).length >= 3,
              JSON.stringify(reading.surface.targetOptions))
          }
          led.check(`${phase.id}: the hash box is not a field a person is asked to read`,
            reading.surface.hashFieldVisible === false, String(reading.surface.hashFieldVisible))
          led.check(`${phase.id}: the queued-work form opens behind one button rather than on arrival`,
            reading.surface.queueHidden === true, String(reading.surface.queueHidden))
          const duplicates = reading.everySentence.filter((value, index, all) => all.indexOf(value) !== index)
          led.check(`${phase.id}: no sentence is on this panel twice`, duplicates.length === 0, duplicates.join(' || '))
        }

        if (phase.approve && reading?.surface?.targetKind === 'select') {
          const revealed = await window.clickVisible('[data-queue-reveal]')
          led.note(`the queued-work reveal button: ${revealed}`)
          const typed = await window.typeInto('[data-decision-form] input[name="reason"]', 'Read the panel end to end.')
          led.note(`typed a reason into the decision form: ${typed}`)
          const pressed = await window.clickVisible('[data-decision="approve"]')
          led.note(`pressed Approve: ${pressed}`)
          await delay(3500)
          const after = await window.evaluate(READ_LEDGER)
          evidence['ledger-populated-after-approve'] = after
          console.log('  after Approve:', JSON.stringify({
            output: after.surface.decisionOutput,
            queueHidden: after.surface.queueHidden,
            reveal: after.surface.queueRevealLabel,
          }, null, 2))
          console.log(`  screenshot: ${await shot(window, scratch, 'ledger-populated-after-approve')}`)
          led.check('ledger-populated: pressing Approve answers with a whole sentence',
            typeof after.surface.decisionOutput === 'string' && after.surface.decisionOutput.length > 40,
            after.surface.decisionOutput)
          led.check('ledger-populated: and that answer carries no machine identifier',
            !/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(after.surface.decisionOutput || ''),
            after.surface.decisionOutput)
          led.check('ledger-populated: the queued-work form really does open when its button is pressed',
            after.surface.queueHidden === false, String(after.surface.queueHidden))
        }
        assertIsolated(profile)
      } finally {
        led.note(describeTimeline(await closeWindow(window)))
      }
    }

    /* ----------------------------------------------------------- cloud --- */

    await restageArchive(scratch, staged.appRoot, tree => {
      writeFileSync(path.join(tree, 'dist', 'data', 'ledger.json'), shipped)
    })
    const profile = path.join(scratch, 'profile-cloud')
    mkdirSync(profile, { recursive: true })
    seedMachineRecord(profile, staged.appRoot, 'standard')
    const home = path.join(profile, 'home')
    for (const name of ['.codex-work', '.codex-personal']) mkdirSync(path.join(home, name), { recursive: true })
    const registryFile = path.join(profile, 'userdata', 'capability', 'config', 'accounts.json')
    mkdirSync(path.dirname(registryFile), { recursive: true })
    rmSync(registryFile, { force: true })

    const window = await openWindow(staged.executable, profile)
    try {
      led.note(`cloud: the application opened on ${await waitForRoute(window)}`)
      await delay(1200)
      const walked = await walkTo(window, 'computers')
      led.check('cloud: Computers is reachable by clicking the route arrows', walked.route === 'computers', JSON.stringify(walked))
      await delay(2500)
      let onGlass = await window.evaluate('Boolean(document.querySelector(".cloud-surface") || document.querySelector(".board-cloud-box"))')
      /* THE PANEL LIVES ON AN AGENT PAGE, AND A FRESH PROFILE HAS NO AGENTS.
       *
       * That is a product fact rather than an obstacle: the Codex Cloud panel is
       * fenced to a LIVE agent page, because a launch from it starts real,
       * billable, uncancellable remote work, and "Open agent detail" is ABSENT
       * (not merely disabled) when there is nobody to open. So the way to reach
       * it on a machine where nothing has been started is the one the product
       * itself offers: turn this page's Live data switch off in the drawer,
       * which draws the labelled demonstration fleet, and open an agent from
       * there. The AGENT page keeps its own Live data flag, so the page that
       * opens is a real one carrying the real panel. */
      if (!onGlass) {
        const opened = await openDrawer(window)
        led.note(`cloud: opened the drawer to reach this page's own switches: ${opened}`)
        const toggled = await window.clickVisible('#drawer input[data-quick-live="fleet"], #drawer [data-quick-live="fleet"]')
        led.note(`cloud: turned this page's Live data switch off, so it draws the demonstration fleet: ${toggled}`)
        await delay(1200)
        await closeDrawer(window)
        await delay(1500)
        onGlass = await window.evaluate('Boolean(document.querySelector(".cloud-surface") || document.querySelector(".board-cloud-box"))')
      }
      if (!onGlass) {
        /* "Open agent detail" is the button this page really offers when the
           graph has nothing running in it, and it is the only door to the
           Codex Cloud panel: that panel is fenced to a LIVE agent page, because
           a launch from it starts real, billable, uncancellable remote work.
           The rest are older shapes, kept as fallbacks and reported by name. */
        for (const selector of ['.graph-open-btn', '[data-a="open"]', '.gnode', '.node', '[data-node]', '.ar-card']) {
          const clicked = await window.clickVisible(selector, { timeoutMs: 3500 })
          led.note(`looking for the Codex Cloud panel, clicked ${selector}: ${clicked}`)
          await delay(2200)
          onGlass = await window.evaluate('Boolean(document.querySelector(".cloud-surface") || document.querySelector(".board-cloud-box"))')
          if (onGlass) break
        }
      }
      led.check('cloud: the Codex Cloud panel is on the glass after clicking there', onGlass === true, await window.evaluate('location.hash'))

      const shippedOff = await window.evaluate(READ_CLOUD)
      evidence['cloud-switched-off'] = shippedOff
      console.log('\n--- cloud-switched-off — the panel as it ships, drawn rather than hidden')
      console.log(JSON.stringify(shippedOff, null, 2))
      console.log(`  screenshot: ${await shot(window, scratch, 'cloud-switched-off')}`)

      /* Turned on by pressing the switch the panel itself offers. */
      const enabled = await window.clickVisible('[data-cloud-enable]')
      led.check('cloud: the panel offers its own switch, and it responds to a real click', enabled === 'clicked', enabled)
      await delay(2500)

      const states = [
        {
          id: 'cloud-no-account',
          why: 'a fresh profile: nobody has signed in to Codex Cloud on this computer',
          write: () => rmSync(registryFile, { force: true }),
        },
        {
          id: 'cloud-unreadable',
          why: 'an account registry that genuinely is not JSON',
          write: () => writeFileSync(registryFile, '{ this is not json\n'),
        },
        {
          id: 'cloud-populated',
          why: 'two declared accounts, neither signed in, so every row carries a reason and nothing is spent',
          write: () => writeFileSync(registryFile, `${JSON.stringify(accountRegistry(home), null, 2)}\n`),
        },
      ]

      for (const state of states) {
        console.log(`\n--- ${state.id} — ${state.why}`)
        state.write()
        const refreshed = await window.clickVisible('[data-cloud-refresh], [data-cloud="refresh"]')
        led.note(`${state.id}: pressed Refresh: ${refreshed}`)
        await delay(6000)
        const reading = await window.evaluate(READ_CLOUD)
        evidence[state.id] = reading
        console.log(JSON.stringify(reading, null, 2))
        console.log(`  screenshot: ${await shot(window, scratch, state.id)}`)

        const duplicates = reading.everySentence.filter((value, index, all) => all.indexOf(value) !== index)
        led.check(`${state.id}: no sentence is on this panel twice`, duplicates.length === 0, duplicates.join(' || '))
        /* THE OWNER'S FINDING, MEASURED. Two 47-word paragraphs saying the same
           thing are not byte-identical -- they were "Accounts unavailable · X"
           and "Environments unavailable · X" -- so this measures the SHARED
           SENTENCE rather than the whole string. */
        const sentences = reading.everySentence.flatMap(value => value.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.split(/\s+/).length >= 6))
        const shared = sentences.filter((value, index, all) => all.indexOf(value) !== index)
        led.check(`${state.id}: and no sentence of six words or more appears in two of its boxes`,
          shared.length === 0, shared.join(' || '))
        for (const [name, box] of Object.entries(reading)) {
          if (!box || typeof box !== 'object' || typeof box.text !== 'string' || !box.text) continue
          led.check(`${state.id}: the ${name} line carries no machine identifier`,
            !/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(box.text), box.text.slice(0, 120))
        }
        if (state.id === 'cloud-no-account') {
          led.check('cloud-no-account: the panel says nobody is signed in, and says it once',
            /signed in on this computer/i.test(reading.environments?.text || ''), reading.environments?.text)
          led.check('cloud-no-account: it is not painted as a failure',
            reading.environments?.state === 'note', String(reading.environments?.state))
          led.check('cloud-no-account: and it names one thing to do',
            /Sign in to Codex Cloud/i.test(reading.environments?.text || ''), reading.environments?.text)
        }
        if (state.id === 'cloud-unreadable') {
          led.check('cloud-unreadable: the panel says the accounts could not be read',
            /could not be read/i.test(reading.environments?.text || ''), reading.environments?.text)
          led.check('cloud-unreadable: and it carries the REAL reason rather than the old constant',
            !/The audited dependency refused the action/i.test(reading.environments?.text || ''),
            reading.environments?.text)
          led.check('cloud-unreadable: no file path reached the glass',
            !/[A-Za-z]:[\\/]/.test(reading.everySentence.join(' ')), reading.everySentence.join(' ').slice(0, 200))
        }
        if (state.id === 'cloud-populated') {
          led.check('cloud-populated: the account picker fills itself from the registry',
            (reading.accountOptions || []).length >= 2, JSON.stringify(reading.accountOptions))
        }
      }
      assertIsolated(profile)
    } finally {
      led.note(describeTimeline(await closeWindow(window)))
    }
  } catch (error) {
    console.error(error)
    led.check('the run completed', false, String(error?.message || error))
  } finally {
    console.log(`\nevidence: ${writeEvidence(scratch, 'panel-readability.json', evidence)}`)
    led.finish('panel readability')
  }
}

await main()
