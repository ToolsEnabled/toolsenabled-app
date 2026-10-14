#!/usr/bin/env node
/**
 * IS A CONFIRMED PURCHASE DECISION VISIBLE TO ANOTHER ACCOUNT?
 *
 * E2 (reports/lanes/test-account.md) proved a second person cannot see the
 * owner's name, card or identity, and could not answer this one, because
 * pressing Confirm is fenced for an executor. It refused to infer from the
 * selection leak. This driver answers it without pressing Confirm and without
 * spending anything.
 *
 * WHY THAT IS POSSIBLE, read off the shipped source rather than assumed:
 *
 *   src/views/checkout.js  — the Confirm button's ENTIRE click handler is
 *     `store.confirm({ principal: identity.principal })` followed by a repaint.
 *     No network call, no payment, no order, no spend-ledger write.
 *   src/checkout-selection.js — `confirm()` composes a
 *     `recordKind: 'local-decision-note'` and stores it inside the SAME
 *     `mc.checkout.v1` key as the selection, through the same
 *     `safeStorage(localStorage)` face.
 *
 * So a confirmed decision is one call on the store's own API over the product's
 * own storage. THIS DRIVER MAKES THAT CALL, in the running packaged product, on
 * a sterile profile, against a synthetic purchase list of invented vendors —
 * and never touches the shipped Confirm button. Nothing is bought, ordered,
 * reserved or charged, and the operator's own purchase list is never loaded.
 *
 * HOW THE PRODUCT'S OWN CODE IS USED AND NOT A COPY OF IT. The four modules
 * behind the button (`account-state`, `checkout-principal`, `checkout-catalog`,
 * `checkout-selection`) are read from disk verbatim, each wrapped in its own
 * scope with the `export` keyword stripped, and evaluated in the product's own
 * page over the local debugger. The identity comes from the product's real
 * `readApprovalIdentity(window)` gate against the real `window.mcAccount`; the
 * catalogue comes from the product's real `loadCatalog()` against the URL the
 * shell serves; the storage is the product's real account-aware `localStorage`
 * shim. Nothing about the record is written by this file.
 *
 * AND THE RECORD IS THEN HANDED BACK TO THE SHIPPED VIEW. Every claim about
 * what a person SEES is read off the painted checkout screen after navigating to
 * it by clicking the arrow — never off storage alone. If the shipped view
 * renders the "Your decision is saved" step from the record this driver caused,
 * then the record is indistinguishable from a button-written one to the only
 * consumer that exists.
 *
 * FOUR SEPARATE QUESTIONS, because they have different answers:
 *   1. account partition — one account confirms, does another account see it?
 *   2. legacy/device shape — a record written when nobody was signed in (which
 *      is what every install that predates the account partition holds) — who
 *      sees that?
 *   3. the reverse — does the second person's presence destroy the first's?
 *   4. ABSENCE READ AS CONSENT — the store REFUSES to create a record without a
 *      named principal. Does the loader refuse to READ one? A confirmed record
 *      with no approver, planted in the state file, is the codebase's signature
 *      defect shape and is tested explicitly.
 *
 * NOTHING IN THE REPOSITORY IS WRITTEN. Evidence goes under the OS temp dir.
 * Not named for either driver family deliberately: tools/packaged-qa-suite.mjs
 * discovers `-qa` and `-drive` (the second since 2026-08-23), and Wave 2 has
 * live lanes asserting on what it discovers, so this stays out of the shared
 * suite until a coordinator registers it. It is listed in that suite's
 * HELD_OUT_OF_DISCOVERY map so the decision is on the record rather than in
 * a filename.
 */

import path from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import {
  REPO_ROOT, VISIBLE, accountState, assertIsolated, closeDrawer, closeWindow, createAccountOnScreen,
  createLedger, delay, describeTimeline, generatedPassword, gotoHome, openWindow, prefsFileFor, reap,
  releaseDirectory, route, scratchDirectory, seedMachineRecord, signInOnScreen,
  signOutOnScreen, stage, userDataFor, writeEvidence,
} from './test-account-harness.mjs'

/* Two invented people. Neither marker is a name, a word from the owner's life,
   or anything that could be mistaken for one on a screenshot. */
const FIRST = Object.freeze({
  username: 'd6-first-person-not-a-real-user',
  displayName: 'D6MARK First Decider — not a real user',
  marker: 'D6MARK First Decider',
})
const SECOND = Object.freeze({
  username: 'd6-second-person-not-a-real-user',
  displayName: 'D6MARK Second Person — not a real user',
  marker: 'D6MARK Second Person',
})

/* A purchase list that is nobody's: invented vendors, invented reasons, two
   lines. The operator's own list (private/purchase-catalog.owner.json) is
   deliberately NOT loaded. */
function syntheticCatalog() {
  const item = (id, name, usd) => ({
    id, name,
    vendor: 'Example Vendor D6MARK-CATALOGUE',
    category: 'required-to-ship',
    cadence: 'annual',
    firstYearUsd: usd,
    renewalUsd: null,
    priceVerified: false,
    priceVerifiedDate: null,
    quantityMax: 1,
    defaultSelected: false,
    whatItIs: 'An invented line item that exists only so this screen has something on it.',
    whatBreaksWithout: 'Nothing. This list is synthetic and belongs to no one.',
    whyHeWantedIt: 'It was written by a test so a decision path could be driven.',
    sourceUrl: null,
    warning: null,
    blockers: [],
    notes: null,
  })
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    currency: 'USD',
    spendPolicy: { dailyLimitUsd: 100, source: 'a synthetic test policy', readAt: new Date().toISOString() },
    categories: [{
      id: 'required-to-ship',
      label: 'Synthetic group',
      blurb: 'Invented lines, present so the purchase screen can be driven by a test.',
    }],
    items: [item('d6-line-one', 'Synthetic line one', 12), item('d6-line-two', 'Synthetic line two', 34)],
  }
}

/* ------------------------------------------------- the product's own code -- */

/* Read verbatim, `export` stripped, each module in its own scope so two modules
   that happen to name a private helper the same thing cannot collide. The one
   `import` in the tree (checkout-principal -> account-state) is satisfied by
   passing the real function in, not by reimplementing it. */
function sourceOf(relative) {
  const text = readFileSync(path.join(REPO_ROOT, relative), 'utf8')
  return text.replace(/^export (?=(const|let|var|function|async|class))/gm, '')
}

function productModulesExpression() {
  const accountState_ = sourceOf('src/account-state.js')
  const principal = sourceOf('src/checkout-principal.js').replace(/^import[^\n]*\n/m, '')
  const catalog = sourceOf('src/checkout-catalog.js')
  const selection = sourceOf('src/checkout-selection.js')
  return `(() => {
    const A = (() => { ${accountState_}
      return { readAccountState } })()
    const P = (() => { const readAccountState = A.readAccountState; ${principal}
      return { readApprovalIdentity, approvalIdentityFrom } })()
    const C = (() => { ${catalog}
      return { loadCatalog, normalizeCatalog } })()
    const S = (() => { ${selection}
      return { createSelectionStore, safeStorage, SELECTION_STORAGE_KEY } })()
    return Object.assign({}, A, P, C, S)
  })()`
}

async function installProductModules(window) {
  const ok = await window.evaluate(
    `(() => { try { window.__d6 = ${productModulesExpression()}; return Object.keys(window.__d6).sort().join(',') } catch (error) { return 'THREW:' + String(error && error.message) } })()`)
  return typeof ok === 'string' ? ok : `unexpected:${JSON.stringify(ok)}`
}

/* ------------------------------------------------------- driving the app -- */

/** Reach the purchase screen the only way this product offers: the arrow.
 *
 * VIA HOME, ALWAYS. The account screen is not on the ring and has no forward
 * arrow, so a walk started from there clicks nothing and reports "the purchase
 * screen is not reachable" — a finding about the harness. gotoHome knows the
 * account screen's own way back. */
async function walkToCheckout(window) {
  await closeDrawer(window)
  if ((await route(window)) !== 'checkout') {
    const home = await gotoHome(window)
    if (home !== 'clicked' && home !== 'already-there') return false
  }
  for (let step = 0; step < 14; step += 1) {
    if ((await route(window)) === 'checkout') return true
    if ((await window.clickVisible('#nav-next')) !== 'clicked') return false
    await delay(420)
  }
  return (await route(window)) === 'checkout'
}

/** Leave the checkout and come back, so the view is torn down and re-mounted
    and re-reads storage exactly as it does on a fresh visit. */
async function remountCheckout(window) {
  await window.clickVisible('#nav-next')
  await delay(500)
  return walkToCheckout(window)
}

/** What the checkout screen IS SHOWING. Read off the painted document. */
async function checkoutScreen(window) {
  return window.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.checkout-item')]
    const title = (document.querySelector('.checkout-step-title')?.textContent || '').trim()
    const stamp = (document.querySelector('.checkout-record-stamp')?.textContent || '').trim()
    const recordLines = [...document.querySelectorAll('.checkout-record .checkout-line-name')]
      .map(node => node.textContent.trim())
    const totals = [...document.querySelectorAll('.checkout-record .checkout-totals div')]
      .map(node => node.textContent.trim())
    return {
      route: document.body.dataset.route || null,
      title,
      stamp,
      hasRecord: Boolean(document.querySelector('.checkout-record')),
      recordLines,
      totals,
      rows: rows.length,
      selected: rows.filter(row => row.dataset.selected === 'true').map(row => row.dataset.itemId),
      unavailable: (document.querySelector('.checkout-unavailable, [data-checkout-unavailable]')?.textContent || '').trim(),
      text: document.body.innerText || '',
    }
  })()`)
}

/** Tick a line. Ticking is not buying and never was. */
async function tickLine(window, itemId) {
  const clicked = await window.clickVisible(`[data-item-id="${itemId}"] .checkout-pick`)
  await delay(500)
  return clicked
}

/** Whatever is under mc.checkout.v1 for whoever is signed in right now. */
async function readSelectionKey(window) {
  return window.evaluate(`(() => { try { return localStorage.getItem('mc.checkout.v1') } catch (error) { return 'THREW:' + String(error && error.message) } })()`)
}

/** Write a value under mc.checkout.v1 through the product's own storage shim,
    which routes it to the account partition or the device record depending on
    who is signed in — the same routing every real write takes. */
async function plantSelectionKey(window, json) {
  return window.evaluate(`(() => { try { localStorage.setItem('mc.checkout.v1', ${JSON.stringify(json)}); return 'written' } catch (error) { return 'THREW:' + String(error && error.message) } })()`)
}

/* --------------------------------------------------------------- the run -- */

async function main() {
  const ledger = createLedger()
  const scratch = scratchDirectory('decision-record-crossaccount')
  const profile = path.join(scratch, 'one-windows-login')
  const started = Date.now()
  let window = null

  console.log(`release  : ${releaseDirectory()}`)
  console.log(`scratch  : ${scratch}`)
  console.log(`mode     : ${VISIBLE ? 'VISIBLE (control run)' : 'headless'}`)

  try {
    const { executable, appRoot } = await stage(scratch)
    seedMachineRecord(profile, appRoot, 'standard')
    mkdirSync(userDataFor(profile), { recursive: true })
    writeFileSync(
      path.join(userDataFor(profile), 'purchase-catalog.json'),
      `${JSON.stringify(syntheticCatalog(), null, 2)}\n`, 'utf8')

    const firstPassword = generatedPassword()
    const secondPassword = generatedPassword()
    let confirmedRecordJson = null
    let firstAccountId = null

    /* ============ 1. THE FIRST PERSON DECIDES (without the button) ========= */
    window = await openWindow(executable, profile)
    ledger.check('the packaged application opens on a sterile profile holding a synthetic purchase list',
      window.timeline.windowAt !== null, describeTimeline(window.timeline))
    assertIsolated(profile)

    const created = await createAccountOnScreen(window, FIRST, firstPassword)
    ledger.check('the first person creates an account and is signed in', created === 'submitted', created)
    const asFirst = await accountState(window)
    firstAccountId = asFirst?.current?.account?.id || null
    ledger.check('the first person is signed in under the display name they chose',
      asFirst?.current?.account?.displayName === FIRST.displayName,
      String(asFirst?.current?.account?.displayName))

    const atCheckout = await walkToCheckout(window)
    ledger.check('the purchase screen is a stop on the ring for the first person', atCheckout,
      `route=${await route(window)}`)
    const ticked = await tickLine(window, 'd6-line-one')
    const afterTick = await checkoutScreen(window)
    ledger.check('the first person ticks a line, and the shop step is what is showing',
      ticked === 'clicked' && afterTick.selected.includes('d6-line-one') && afterTick.hasRecord === false,
      `${ticked} selected=${afterTick.selected.join(',')} record=${afterTick.hasRecord}`)

    const installed = await installProductModules(window)
    ledger.check('the product\'s own checkout modules load in the product\'s own page',
      installed.includes('createSelectionStore') && installed.includes('readApprovalIdentity'), installed)

    /* THE DECISION. The store's own confirm(), the product's own identity gate,
       the product's own catalogue, the product's own storage. The shipped
       Confirm button is never pressed. */
    const decision = await window.evaluate(`(async () => {
      const M = window.__d6
      const identity = await M.readApprovalIdentity(window)
      if (identity.ok !== true) return { ok: false, code: identity.code, reason: identity.reason }
      const catalog = await M.loadCatalog()
      const store = M.createSelectionStore({ catalog, storage: M.safeStorage(localStorage) })
      const before = store.summary()
      store.confirm({ principal: identity.principal })
      const after = store.summary()
      return {
        ok: true,
        principalId: identity.principal.id,
        principalDisplayName: identity.principal.displayName,
        vaultVerified: identity.principal.vault.verified,
        vaultCode: identity.principal.vault.code,
        selectedBefore: before.lines.map(line => line.id),
        confirmedNull: after.confirmed === null,
        recordKind: after.confirmed ? after.confirmed.recordKind : null,
        approvedBy: after.confirmed ? after.confirmed.approvedBy : null,
        recordLines: after.confirmed ? after.confirmed.lines.map(line => line.id) : [],
        cashTodayCents: after.confirmed ? after.confirmed.cashTodayCents : null,
        stored: localStorage.getItem('mc.checkout.v1'),
      }
    })()`)
    writeEvidence(scratch, 'decision-as-made.json', decision)
    ledger.check('the product\'s own identity gate names the first person as the approver',
      decision?.ok === true && decision.approvedBy?.id === firstAccountId
      && decision.approvedBy?.displayName === FIRST.displayName,
      decision?.ok === true ? `approvedBy=${decision.approvedBy?.displayName}` : `refused:${decision?.code}`)
    ledger.check('a confirmed decision record now exists, written by the store\'s own confirm()',
      decision?.confirmedNull === false && decision?.recordKind === 'local-decision-note'
      && decision.recordLines.includes('d6-line-one'),
      `kind=${decision?.recordKind} lines=${decision?.recordLines?.join(',')} cashToday=${decision?.cashTodayCents}`)
    ledger.note('the shipped Confirm button was NOT pressed; nothing was bought, ordered or charged')
    confirmedRecordJson = typeof decision?.stored === 'string' ? decision.stored : null

    /* THE SHIPPED VIEW IS THE JUDGE. If it paints the confirmed step from this
       record, the record is what the button would have made as far as the only
       thing that reads it is concerned. */
    const backAtCheckout = await remountCheckout(window)
    const firstSees = await checkoutScreen(window)
    writeEvidence(scratch, 'screen-first-person-after-decision.txt', firstSees.text)
    ledger.check('the SHIPPED checkout screen shows the first person their saved decision',
      backAtCheckout && firstSees.hasRecord === true && /decision is saved/i.test(firstSees.title),
      `title=${JSON.stringify(firstSees.title)} record=${firstSees.hasRecord}`)
    ledger.check('and the screen names the person who decided',
      firstSees.stamp.includes(FIRST.marker), `stamp=${JSON.stringify(firstSees.stamp)}`)

    const firstKey = await readSelectionKey(window)
    ledger.check('the record the first person is being shown is the one that was just written',
      typeof firstKey === 'string' && firstKey === confirmedRecordJson,
      `${typeof firstKey === 'string' ? firstKey.length : 'null'} bytes`)

    /* ============ 2. THE SECOND PERSON ===================================== */
    const signedOut = await signOutOnScreen(window)
    ledger.check('the first person signs out', signedOut === 'clicked', signedOut)
    const secondCreated = await createAccountOnScreen(window, SECOND, secondPassword)
    ledger.check('a second person creates their own account on the same Windows login',
      secondCreated === 'submitted', secondCreated)
    const asSecond = await accountState(window)
    ledger.check('the second person is signed in as themselves',
      asSecond?.current?.account?.displayName === SECOND.displayName,
      String(asSecond?.current?.account?.displayName))

    const secondAtCheckout = await walkToCheckout(window)
    const secondSees = await checkoutScreen(window)
    writeEvidence(scratch, 'screen-second-person.txt', secondSees.text)
    ledger.check('the second person reaches the purchase screen', secondAtCheckout,
      `route=${secondSees.route}`)

    /* ---- THE ANSWER D6 EXISTS FOR ---- */
    ledger.check('THE CONFIRMED DECISION IS NOT SHOWN TO THE SECOND PERSON',
      secondSees.hasRecord === false && !/decision is saved/i.test(secondSees.title),
      `title=${JSON.stringify(secondSees.title)} record=${secondSees.hasRecord}`)
    ledger.check('the first person\'s NAME is nowhere on the second person\'s purchase screen',
      !secondSees.text.includes(FIRST.marker),
      secondSees.text.split('\n').filter(line => line.includes('D6MARK First')).slice(0, 2).join(' / ') || 'absent')
    ledger.check('the second person\'s basket is empty — the first person\'s ticked line is not carried over',
      secondSees.selected.length === 0, `selected=${secondSees.selected.join(',') || 'none'}`)
    const secondKey = await readSelectionKey(window)
    ledger.check('and mc.checkout.v1 reads ABSENT for the second person, not the other account\'s value',
      secondKey === null, secondKey === null ? 'null' : `${String(secondKey).length} bytes`)

    /* ---- and the reverse: the second person's arrival destroys nothing ---- */
    const secondTicked = await tickLine(window, 'd6-line-two')
    const secondPicked = await checkoutScreen(window)
    ledger.check('the second person can make their own selection',
      secondTicked === 'clicked' && secondPicked.selected.includes('d6-line-two'),
      `selected=${secondPicked.selected.join(',')}`)

    /* ---- HOW FAR THE PARTITION ACTUALLY GOES ----------------------------- *
     * The screens are one question and the STORE is another, and a report that
     * only measured the screens would be refuted by the first person to open a
     * console. The partition works by namespacing the key inside the one
     * settings file (`acct:<id>:mc.checkout.v1`); `isAccountScoped` does not
     * match that namespaced form, so it falls through to the device cache. This
     * asks the shim, from the second person's own signed-in page, for the first
     * person's key by name — and enumerates what `length`/`key()` will hand
     * over. Whatever the answer, it is reported as what it is: a statement
     * about scripts running in the page, not about clicking. */
    const boundary = await window.evaluate(`(() => {
      const direct = localStorage.getItem(${JSON.stringify(`acct:${firstAccountId}:mc.checkout.v1`)})
      const names = []
      for (let index = 0; index < localStorage.length; index += 1) names.push(localStorage.key(index))
      return {
        directBytes: typeof direct === 'string' ? direct.length : null,
        directNamesSomeone: typeof direct === 'string' && direct.includes('D6MARK First Decider'),
        enumerated: names.filter(name => typeof name === 'string' && name.indexOf('acct:') === 0),
        total: localStorage.length,
      }
    })()`)
    writeEvidence(scratch, 'store-boundary-from-second-person.json', boundary)
    ledger.check('the STORE, not just the screen, refuses the second person the first person\'s record by its namespaced key',
      boundary?.directBytes === null,
      `getItem("acct:<first>:mc.checkout.v1") returned ${boundary?.directBytes === null ? 'null' : `${boundary?.directBytes} bytes`}; names the first person = ${boundary?.directNamesSomeone}`)
    ledger.check('and the second person cannot enumerate the other account\'s keys out of the shared settings file',
      Array.isArray(boundary?.enumerated) && boundary.enumerated.length === 0,
      `${boundary?.enumerated?.length ?? '?'} acct: keys visible of ${boundary?.total} total`)

    await signOutOnScreen(window)
    const backIn = await signInOnScreen(window, FIRST, firstPassword)
    ledger.check('the first person signs back in', backIn === 'submitted', backIn)
    await walkToCheckout(window)
    const firstAgain = await checkoutScreen(window)
    writeEvidence(scratch, 'screen-first-person-on-return.txt', firstAgain.text)
    ledger.check('the first person\'s saved decision is still there when they come back',
      firstAgain.hasRecord === true && firstAgain.stamp.includes(FIRST.marker),
      `record=${firstAgain.hasRecord} stamp=${JSON.stringify(firstAgain.stamp)}`)
    ledger.check('and the second person\'s line did not join the first person\'s record',
      !firstAgain.recordLines.some(name => /line two/i.test(name)),
      `record lines=${firstAgain.recordLines.join(' | ') || 'none'}`)

    /* ============ 3. THE LEGACY / DEVICE-LEVEL SHAPE ====================== *
     * Every install made before the account partition landed holds its
     * mc.checkout.v1 at the DEVICE level, and so does any copy used while
     * nobody was signed in. That record is planted here through the product's
     * own storage shim while signed out, which is exactly where such a record
     * lives, and then looked for from each vantage point. */
    await signOutOnScreen(window)
    const outState = await accountState(window)
    ledger.check('nobody is signed in for the device-level part of this run',
      outState?.current?.signedIn === false, String(outState?.current?.signedIn))
    const planted = await plantSelectionKey(window, confirmedRecordJson)
    ledger.check('a confirmed decision is planted at the DEVICE level, the shape a pre-partition install holds',
      planted === 'written', planted)
    await walkToCheckout(window)
    const strangerSees = await checkoutScreen(window)
    writeEvidence(scratch, 'screen-signed-out-with-device-record.txt', strangerSees.text)
    ledger.check('DEVICE-LEVEL: a person who is not signed in DOES see a decision record left at the device level',
      strangerSees.hasRecord === true, `record=${strangerSees.hasRecord} title=${JSON.stringify(strangerSees.title)}`)
    ledger.check('DEVICE-LEVEL: and that screen prints the name of the person who decided',
      strangerSees.stamp.includes(FIRST.marker), `stamp=${JSON.stringify(strangerSees.stamp)}`)

    const secondBack = await signInOnScreen(window, SECOND, secondPassword)
    ledger.check('the second person signs in while that device-level record is on disk',
      secondBack === 'submitted', secondBack)
    await walkToCheckout(window)
    const secondWithDevice = await checkoutScreen(window)
    writeEvidence(scratch, 'screen-second-person-with-device-record.txt', secondWithDevice.text)
    ledger.check('a signed-in second person does NOT inherit the device-level decision record',
      secondWithDevice.hasRecord === false && !secondWithDevice.text.includes(FIRST.marker),
      `record=${secondWithDevice.hasRecord} title=${JSON.stringify(secondWithDevice.title)}`)

    await closeWindow(window)
    ledger.check('the window closed on its own', window.timeline.exitCode === 0, describeTimeline(window.timeline))

    /* ============ 4. THE SAME QUESTION ACROSS A RELAUNCH =================== *
     * The overlay that hides the device record is hydrated ASYNCHRONOUSLY at
     * boot (public/durable-storage.js starts signed out and is told who is
     * signed in by refreshAccount()). A relaunch that comes up already signed
     * in is where that race would show, so it is measured rather than reasoned
     * about — including the earliest instant this rig can read the page. */
    window = await openWindow(executable, profile)
    const earliest = await window.evaluate(`(() => ({
      msSinceLoad: Math.round(performance.now()),
      value: (() => { try { return localStorage.getItem('mc.checkout.v1') } catch (error) { return 'THREW' } })(),
    }))()`)
    const bootState = await accountState(window)
    ledger.check('the relaunch comes up with the second person still signed in',
      bootState?.current?.signedIn === true
      && bootState?.current?.account?.displayName === SECOND.displayName,
      `signedIn=${bootState?.current?.signedIn} as=${bootState?.current?.account?.displayName}`)
    /* EXPECTATION CORRECTED AFTER THE FIRST RUN, and the correction is the
       point. This first asserted the value was null, and it came back 137 bytes
       — which read as a boot race exposing the other account's record. It was
       not: the second person had ticked a line of their own, so 137 bytes is
       THEIR record. Asserting null could only ever have been right for an
       account that had never chosen anything, and would have gone green on a
       build that had wiped their selection. So what is asserted is the thing
       that actually matters: the value belongs to them and carries none of the
       first person's decision. */
    let earliestParsed = null
    try { earliestParsed = JSON.parse(earliest?.value) } catch { earliestParsed = null }
    const earliestLines = (earliestParsed?.selections || []).map(entry => entry.id).join(',')
    ledger.check('at the earliest instant this rig can read the page, mc.checkout.v1 holds THEIR record and no confirmed decision',
      earliest?.value === null
      || (earliestParsed !== null && !earliestParsed.confirmed && !earliestLines.includes('d6-line-one')),
      `read at ${earliest?.msSinceLoad}ms after load: ${earliest?.value === null ? 'null' : `${String(earliest?.value).length} bytes`} selections=${earliestLines || 'none'} confirmed=${Boolean(earliestParsed?.confirmed)}`)
    await walkToCheckout(window)
    const afterRelaunch = await checkoutScreen(window)
    writeEvidence(scratch, 'screen-second-person-after-relaunch.txt', afterRelaunch.text)
    ledger.check('after a full relaunch the second person still sees no decision belonging to the first',
      afterRelaunch.hasRecord === false && !afterRelaunch.text.includes(FIRST.marker),
      `record=${afterRelaunch.hasRecord} title=${JSON.stringify(afterRelaunch.title)}`)

    /* ============ 5. ABSENCE READ AS CONSENT =============================== *
     * confirm() REFUSES to create a record without a named principal. The
     * question this codebase's history demands is whether the READ side refuses
     * too. Three damaged shapes, planted at the device level while signed out
     * and handed to the shipped view. */
    await signOutOnScreen(window)
    await installProductModules(window)

    const base = JSON.parse(confirmedRecordJson)
    const shapes = [
      {
        id: 'no-approver-field',
        note: 'a confirmed record with NO approvedBy at all',
        value: (() => { const copy = structuredClone(base); delete copy.confirmed.approvedBy; return copy })(),
      },
      {
        id: 'empty-approver',
        note: 'a confirmed record whose approver has an empty id and an empty name',
        value: (() => { const copy = structuredClone(base); copy.confirmed.approvedBy = { id: '', displayName: '' }; return copy })(),
      },
      {
        id: 'empty-confirmed-object',
        note: 'a confirmed record that is an empty object',
        value: (() => { const copy = structuredClone(base); copy.confirmed = {}; return copy })(),
      },
    ]

    const absence = []
    for (const shape of shapes) {
      await plantSelectionKey(window, JSON.stringify(shape.value))
      /* The store's own loader, asked directly: does it accept this as a
         confirmed decision? */
      const loaded = await window.evaluate(`(async () => {
        const M = window.__d6
        const catalog = await M.loadCatalog()
        const store = M.createSelectionStore({ catalog, storage: M.safeStorage(localStorage) })
        const summary = store.summary()
        return { confirmed: summary.confirmed !== null, approvedBy: summary.confirmed ? summary.confirmed.approvedBy || null : null }
      })()`)
      /* NOTE: constructing the store above may itself re-persist, so the value
         is planted again before the screen is asked. */
      await plantSelectionKey(window, JSON.stringify(shape.value))
      await remountCheckout(window)
      const screen = await checkoutScreen(window)
      absence.push({ ...shape, value: undefined, loaded, screen: { title: screen.title, stamp: screen.stamp, hasRecord: screen.hasRecord, route: screen.route, rows: screen.rows } })
      writeEvidence(scratch, `screen-absence-${shape.id}.txt`, screen.text)
      ledger.note(`${shape.note}: store accepts it as confirmed = ${loaded?.confirmed}; screen shows record = ${screen.hasRecord}; title = ${JSON.stringify(screen.title)}; stamp = ${JSON.stringify(screen.stamp)}`)
    }
    writeEvidence(scratch, 'absence-shapes.json', absence)

    const unattributed = absence.find(entry => entry.id === 'no-approver-field')
    ledger.check('ABSENCE: a confirmed record with NO approver is refused rather than shown as a saved decision',
      unattributed?.loaded?.confirmed === false || unattributed?.screen?.hasRecord === false,
      `store accepted=${unattributed?.loaded?.confirmed} screen shows it=${unattributed?.screen?.hasRecord} stamp=${JSON.stringify(unattributed?.screen?.stamp)}`)
    const emptyApprover = absence.find(entry => entry.id === 'empty-approver')
    ledger.check('ABSENCE: a confirmed record whose approver is an empty name is refused rather than shown',
      emptyApprover?.loaded?.confirmed === false || emptyApprover?.screen?.hasRecord === false,
      `store accepted=${emptyApprover?.loaded?.confirmed} screen shows it=${emptyApprover?.screen?.hasRecord} stamp=${JSON.stringify(emptyApprover?.screen?.stamp)}`)
    const emptyObject = absence.find(entry => entry.id === 'empty-confirmed-object')
    ledger.check('ABSENCE: an empty confirmed object leaves a usable purchase screen rather than a broken one',
      emptyObject?.screen?.route === 'checkout' && emptyObject?.screen?.rows > 0,
      `route=${emptyObject?.screen?.route} rows=${emptyObject?.screen?.rows} title=${JSON.stringify(emptyObject?.screen?.title)}`)

    /* And the create side, for contrast: the store must still refuse to MAKE a
       record for a nameless principal. */
    const createSide = await window.evaluate(`(async () => {
      const M = window.__d6
      const catalog = await M.loadCatalog()
      const store = M.createSelectionStore({ catalog, storage: { read: () => null, write: () => true } })
      store.setSelected('d6-line-one', true)
      const results = {}
      for (const [label, principal] of [
        ['no principal', null],
        ['empty id', { id: '', displayName: 'Nobody' }],
        ['whitespace id', { id: '   ', displayName: 'Nobody' }],
        ['missing id', { displayName: 'Nobody' }],
      ]) {
        store.confirm(principal === null ? {} : { principal })
        results[label] = store.summary().confirmed !== null
      }
      return results
    })()`)
    ledger.check('the CREATE side still refuses every nameless principal',
      createSide && Object.values(createSide).every(value => value === false),
      JSON.stringify(createSide))

    await closeWindow(window)
    window = null
  } catch (error) {
    ledger.check('the run completed without the harness throwing', false, String(error?.stack || error))
  } finally {
    if (window) { await closeWindow(window).catch(() => {}); reap(window.timeline?.pid) }
  }

  console.log(`\nprefs file : ${prefsFileFor(profile)}`)
  console.log(`evidence   : ${scratch}`)
  console.log(`elapsed    : ${((Date.now() - started) / 1000).toFixed(1)}s`)
  ledger.finish('decision-record-crossaccount')
}

await main()
