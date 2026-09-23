'use strict'

/* THE PROBE. Runs inside a staged Electron app; launched by
 * tools/metrics-usage-live-qa.mjs, which is where the staging and the fences are
 * documented.
 *
 * It boots the REAL shell/main.cjs of the staged tree, starts one REAL Codex
 * `luna` session from the page through window.mcAgent, sends one real turn, and
 * then asks three questions in order, each of which can fail on its own:
 *
 *   1. Did the engine report usage in the shape this feature reads? (measured,
 *      not assumed -- the shape came off a capture and a capture is a claim.)
 *   2. Did that turn land in the signed record, and does the record verify?
 *   3. Does the metrics page SHOW it?
 *
 * Question 3 is the one the other two exist for. A record nobody can see on the
 * page is the defect this feature repairs, in a new place.
 */

const path = require('node:path')
const { app, BrowserWindow, safeStorage } = require('electron')
const { reapDescendants } = require('./process-tree.cjs')

const APP_ROOT = process.env.MC_APP_ROOT || path.resolve(__dirname, '..')
const TIMEOUT_MS = 330_000

const steps = []
function step(name, ok, detail) {
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`)
}

let finishing = false
function finish(code) {
  if (finishing) return
  finishing = true
  const reaped = reapDescendants(process.pid)
  if (reaped > 0) console.log(`[probe] reaped ${reaped} descendant process(es) before exit`)
  app.exit(code)
}

require(path.join(APP_ROOT, 'shell', 'main.cjs'))

async function windowReady() {
  const deadline = Date.now() + 60_000
  for (;;) {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
    if (win) {
      if (win.webContents.isLoading()) {
        await new Promise(resolve => win.webContents.once('did-finish-load', resolve))
      }
      return win
    }
    if (Date.now() > deadline) throw new Error('no BrowserWindow appeared within 60s')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

async function run() {
  const win = await windowReady()
  const js = (code) => win.webContents.executeJavaScript(code, true)

  step('the staged app window loaded', true, await js('document.title'))

  /* The bridge must carry the new channel, or nothing below can be asked. */
  const keys = JSON.parse(await js('JSON.stringify(Object.keys(window.mcAgent || {}).sort())'))
  step('window.mcAgent carries usage()', keys.includes('usage'), keys.join(','))

  const availability = JSON.parse(await js('window.mcAgent.availability().then(JSON.stringify)'))
  if (availability.ok !== true) {
    step('an engine is configured for this run', false, 'code=' + availability.code)
    return
  }
  step('an engine is configured for this run', true, availability.code)

  /* ONE REAL LUNA TURN, and the raw usage events collected beside it. The raw
     events are what answer question 1: this feature reads codex's `usage` shape
     from a capture, and if the live shape differs, everything downstream is
     confidently wrong rather than absent. */
  const result = await js(`(async () => {
    const id = 'chat-' + crypto.randomUUID()
    let text = ''
    const usageEvents = []
    let done = null
    const finished = new Promise(resolve => { done = resolve })
    const off = window.mcAgent.onEvent(packet => {
      if (!packet || packet.sessionId !== id || !packet.event) return
      const e = packet.event
      if (e.type === 'assistant_text_delta' && typeof e.text === 'string') text += e.text
      if (e.type === 'usage') usageEvents.push({ turnId: e.turnId, usage: e.usage })
      if (e.type === 'turn_completed') done(e.status || 'completed')
    })
    const timer = setTimeout(() => done('timeout'), 240000)
    try {
      const started = await window.mcAgent.start({ sessionId: id, tier: 'luna' })
      await window.mcAgent.send({ sessionId: id, text: 'Reply with exactly the word: PONG' })
      const status = await finished
      /* The record is written when the turn completes, on the main process, and
         the page hears about the completion first. A short settle keeps this
         from racing an fsync that has already been ordered. */
      await new Promise(r => setTimeout(r, 1200))
      const usage = await window.mcAgent.usage({ limit: 200 })
      const stopped = await window.mcAgent.close({ sessionId: id })
      return JSON.stringify({
        sessionId: id, tier: started.tier, account: started.account || null,
        status, reply: text.trim(), closed: stopped.closed === true,
        usageEvents, usage,
      })
    } finally { clearTimeout(timer); off() }
  })()`)

  const session = JSON.parse(result)
  step('a real luna session answered', session.status === 'completed' && session.reply.length > 0,
    `tier=${session.tier} status=${session.status} reply=${JSON.stringify(session.reply.slice(0, 40))}`)

  /* 1. THE ENGINE'S OWN SHAPE. */
  const last = session.usageEvents[session.usageEvents.length - 1]
  step('the engine reported usage on this turn', Boolean(last),
    `${session.usageEvents.length} usage event(s)`)
  if (last) {
    console.log('      the last usage event the engine sent: ' + JSON.stringify(last.usage))
    const { turnUsageFrom } = require(path.join(APP_ROOT, 'shell', 'usage-record.cjs'))
    const reading = turnUsageFrom(last.usage)
    step('this feature can read that shape', Boolean(reading), JSON.stringify(reading))
    step('and reads it as THIS TURN, not as a running total',
      Boolean(reading) && reading.basis === 'turn', `basis=${reading && reading.basis}`)
  }

  /* 2. THE RECORD. */
  const recorded = session.usage
  const rows = (recorded && recorded.entries) || []
  const mine = rows.filter(row => row.sessionId === session.sessionId)
  step('the turn is in the signed usage record', mine.length >= 1,
    `${mine.length} record(s) for this session, ${rows.length} in the window`)
  if (mine.length) {
    console.log('      the record written for it: ' + JSON.stringify(mine[0].usage))
    step('the record names the model row it ran under', mine[0].usage.tier === 'luna',
      `tier=${mine[0].usage.tier}`)
    step('the record carries a token figure the engine reported',
      Number.isSafeInteger(mine[0].usage.totalTokens) || Number.isSafeInteger(mine[0].usage.inputTokens),
      `total=${mine[0].usage.totalTokens} input=${mine[0].usage.inputTokens} output=${mine[0].usage.outputTokens}`)
  }
  step('the usage chain verifies', recorded && recorded.verified === true,
    `verified=${recorded && recorded.verified}`)

  /* Independent verification from outside the code under test, over the same
     directory, re-checking every hash, link and signature. */
  const { createUsageRecorder } = require(path.join(APP_ROOT, 'shell', 'usage-record.cjs'))
  const check = createUsageRecorder({ safeStorage, directory: app.getPath('userData') }).verify()
  step('and verifies again when rebuilt from the bytes on disk',
    check.ok === true && check.count > 0, `count=${check.count}${check.ok ? '' : ' code=' + check.code}`)

  /* 3. THE PAGE. */
  await js("window.location.hash = '#/metrics'")
  await new Promise(resolve => setTimeout(resolve, 4000))
  /* WHAT SCREEN ARE WE ACTUALLY ON. A fresh profile can land on the first-run
     walkthrough, and every selector below then answers null -- which reads
     exactly like "the panels did not render" and is a different fault. */
  const where = JSON.parse(await js(`JSON.stringify({
    metricsMounted: Boolean(document.querySelector('.metrics')),
    liveMode: (document.querySelector('.metrics') || {}).dataset ? document.querySelector('.metrics').dataset.liveMode : null,
    projectionState: (document.querySelector('.metrics') || {}).dataset ? document.querySelector('.metrics').dataset.projectionState : null,
    body: (document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
  })`))
  console.log('      where the page is: ' + JSON.stringify(where))
  step('the metrics view mounted', where.metricsMounted === true, 'metricsMounted=' + where.metricsMounted)
  const page = JSON.parse(await js(`(() => {
    const at = (selector) => {
      const node = document.querySelector(selector)
      return node ? node.textContent.trim() : null
    }
    const routing = document.querySelector('#sankey-chart')
    return JSON.stringify({
      hash: window.location.hash,
      sankeySub: at('#sankey-sub'),
      tokensSub: at('#tokens-sub'),
      tokenFlowState: (document.querySelector('[data-mc="tokenflow"]') || {}).dataset
        ? document.querySelector('[data-mc="tokenflow"]').dataset.panelState : null,
      burnSub: at('#burn-sub'),
      routingText: routing ? routing.textContent.replace(/\\s+/g, ' ').trim().slice(0, 600) : null,
      poolsText: (document.querySelector('#pools') || {}).textContent
        ? document.querySelector('#pools').textContent.replace(/\\s+/g, ' ').trim().slice(0, 400) : null,
      /* The sentence the four panels used to carry, in the product's own voice.
         Its presence anywhere on a page that has just recorded a real turn is
         the defect, restated. */
      stillClaimsNoCount: /never passes through here|no word count to plot|does not count the words/i
        .test(document.body.textContent || ''),
    })
  })()`))
  console.log('      metrics page: ' + JSON.stringify(page))

  const total = mine.length ? (mine[0].usage.totalTokens ?? 0) : 0
  /* The page groups thousands with Intl, so the string to look for is the
     grouped one. An earlier version of this line hand-rolled the separator with
     an escaped regex, produced the UNGROUPED digits, and reported a correct page
     as a failure -- a harness that accuses working code is the worst kind of
     harness, and this one did it on the first green run. */
  const grouped = total.toLocaleString('en-US')
  step('the metrics page is on the metrics route', page.hash === '#/metrics', page.hash)
  step('the token-routing panel reports measured tokens',
    Boolean(page.sankeySub && /tokens recorded here/.test(page.sankeySub)), page.sankeySub)
  step('the token-flow panel reports tokens used',
    page.tokenFlowState === 'reading' && total > 0 && String(page.tokensSub || '').includes(grouped),
    `state=${page.tokenFlowState} looking for ${grouped} in ${JSON.stringify(page.tokensSub)}`)
  step('the page no longer claims this product never sees a token count',
    page.stillClaimsNoCount === false, `stillClaimsNoCount=${page.stillClaimsNoCount}`)
  step("this run's own tokens are on the page",
    total > 0 && String(page.routingText || '').includes(grouped),
    `looking for ${grouped} in the routing panel`)
}

app.whenReady().then(async () => {
  const guard = setTimeout(() => { console.error('PROBE FATAL: exceeded ' + TIMEOUT_MS + 'ms'); finish(20) }, TIMEOUT_MS)
  try {
    await run()
    clearTimeout(guard)
    const failed = steps.filter(s => !s.ok)
    console.log(`\n${steps.length - failed.length}/${steps.length} steps passed`)
    finish(failed.length === 0 ? 0 : 1)
  } catch (error) {
    clearTimeout(guard)
    console.error('PROBE ERROR:', error && error.stack ? error.stack : error)
    finish(21)
  }
})
