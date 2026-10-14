/* Real-Electron proof for ONE question: when a decision the owner submitted on
   #/approvals comes back REFUSED after he has already navigated off that screen,
   does the product tell him?

   It used to not. src/ledger-prompt-queue.js submit() awaited the audited bridge and
   then read `if (destroyed) return` BEFORE reading `result.ok`, so the refusal --
   the message whose only job is to say nothing was recorded and nothing was
   approved -- was dropped. Dropped, it is indistinguishable from a success, on
   the surface where consent is the product.

   THE WINDOW IS NOT NARROW AND IS NOT SIMULATED HERE. src/main.js retires the
   outgoing view at the view-transition swap (`snapshotted === true` -> immediate
   `old.view.destroy()`), and the decision call has a 30s budget. So this harness
   does what a person does: presses the submit button, then presses the arrow.
   No clock is stubbed and no internal is reached into; the only thing the
   fixture controls is how long the BRIDGE takes to answer, which is a property
   of the bridge, not of the test.

   RUN IT WITH ELECTRON_RUN_AS_NODE UNSET. With that variable set -- and it IS
   set in some agent sessions on this machine -- `electron` starts as plain Node,
   `require('electron').app` is undefined, and this dies in under a second on
   app.whenReady(). That is not a product failure and must never be read as one.

   Usage:
     electron tools/approvals-decision-outcome-qa.cjs --app <built-app-dir>
       [--mode both|refuse|accept] [--out <screenshot-dir>] [--theme-name tan]
     electron tools/approvals-decision-outcome-qa.cjs --release <unpacked-candidate>
       [--mode both|refuse|accept] [--out <screenshot-dir>] [--theme-name tan]
   Candidate mode reads its packed renderer and capability theme, with a
   fixture bridge in host Electron; it is not native installer qualification.

   Both modes run by default. --mode accept drives the identical journey with a
   bridge that ACCEPTS the decision, and fails if any "not recorded" wording
   appears anywhere afterwards. A notice that cannot tell a refusal from a
   success is the same defect this file exists to catch, pointing the other way,
   and this codebase's signature bug is exactly that: absence read as consent.

   NO CREDENTIAL, VAULT VALUE OR OWNER DATA ENTERS THIS HARNESS. The queue it
   serves is three invented lines from invented merchants.
*/

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { selectRendererDist, rendererRequestPath } = require('./lib/qa-renderer-dist.cjs')

const ROOT = path.join(__dirname, '..')
const RENDERER = selectRendererDist({ argv: process.argv, repoRoot: ROOT })
const PROOF = 'approvals-outcome-qa-bootstrap-proof'.padEnd(43, '0')
const TOKEN = 'approvals-outcome-qa-bearer'

function arg(name, fallback = '') {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`))
  if (hit) return hit.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function selectedAppDirectory() {
  const hasAppArgument = process.argv.some(value => value === '--app' || value.startsWith('--app='))
  if (RENDERER.release && hasAppArgument) throw new Error('--app cannot override an explicitly selected --release renderer')
  return RENDERER.release ? RENDERER.dist : path.resolve(arg('app', RENDERER.dist))
}

function serveApp(appDir) {
  const mime = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff',
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const requested = rendererRequestPath(appDir, request.url)
      if (!requested) { response.writeHead(403); response.end(); return }
      fs.readFile(requested, (error, data) => {
        if (!error) {
          response.writeHead(200, { 'content-type': mime[path.extname(requested)] || 'application/octet-stream' })
          response.end(data)
          return
        }
        fs.readFile(path.join(appDir, 'index.html'), (fallbackError, html) => {
          if (fallbackError) { response.writeHead(404); response.end(); return }
          response.writeHead(200, { 'content-type': 'text/html' })
          response.end(html)
        })
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function publicPrompt(now = Date.now()) {
  return {
    id: 'approvals-outcome-qa-shopping-list',
    kind: 'purchase_batch',
    title: 'Review this shopping list',
    message: 'Approve only the exact lines you want purchased.',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
    state: 'pending',
    defaultDecision: 'deny',
    items: [
      { id: 'line-license', description: 'Developer tool license', amountCents: 973, currency: 'USD', merchant: 'Example Tools', purpose: 'Build verification' },
      { id: 'line-dataset', description: 'Test dataset', amountCents: 425, currency: 'USD', merchant: 'Example Data', purpose: 'Regression coverage' },
      { id: 'line-hosting', description: 'Preview hosting', amountCents: 1200, currency: 'USD', merchant: 'Example Hosting', purpose: 'Owner review environment' },
    ],
    totalCents: 2598,
    currency: 'USD',
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null) }
      catch (error) { reject(error) }
    })
    request.on('error', reject)
  })
}

/* The refusal wording is the bridge's own, and it is deliberately NOT a timeout:
   a refusal is the case where "nothing was recorded" is flatly true, which is
   what makes the screen's claim checkable rather than merely plausible. */
const REFUSAL = Object.freeze({
  code: 'OWNER_PROMPT_DECISION_UNWRITABLE',
  message: 'The decision record could not be written.',
})

function serveFixture(theme, { mode, decisionDelayMs }) {
  const state = {
    enabled: false,
    prompt: publicPrompt(),
    decided: false,
    presentations: 0,
    decisionRequests: [],
    decisionAnswers: 0,
    decisionAnsweredAt: null,
    snapshotReads: 0,
  }
  const serverPromise = new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      const origin = request.headers.origin || '*'
      const headers = {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'content-type': 'application/json',
      }
      if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return }
      const url = new URL(request.url, 'http://127.0.0.1')
      const reply = (status, body) => { response.writeHead(status, headers); response.end(JSON.stringify(body)) }
      if (request.method === 'GET' && url.pathname === '/v1/bootstrap' && url.searchParams.get('proof') === PROOF) {
        reply(200, { ok: true, token: TOKEN }); return
      }
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        reply(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'unauthorized' } }); return
      }
      if (request.method === 'GET' && url.pathname === '/v1/owner-prompts') {
        state.snapshotReads += 1
        reply(200, {
          ok: true, schemaVersion: 1, generatedAt: new Date().toISOString(), theme,
          /* A REFUSED decision leaves the request pending, which is the engine's
             own corroboration of "nothing was approved". An ACCEPTED one takes it
             out of the queue. Nothing here fakes either. */
          prompts: state.enabled && !state.decided ? [state.prompt] : [],
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/actions/owner-prompt-presented') {
        await readJsonBody(request)
        state.presentations += 1
        state.prompt.state = 'presented'
        reply(200, { ok: true, receipt: { promptId: state.prompt.id, state: 'presented', presentedAt: new Date().toISOString() } })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/actions/owner-prompt-decision') {
        const body = await readJsonBody(request)
        state.decisionRequests.push(body)
        // The whole point: the answer arrives AFTER the owner has left the screen.
        await new Promise(done => setTimeout(done, decisionDelayMs))
        state.decisionAnswers += 1
        state.decisionAnsweredAt = Date.now()
        if (mode === 'accept') {
          state.decided = true
          reply(200, {
            ok: true,
            receipt: {
              promptId: body.promptId, state: 'decided', resolvedAt: new Date().toISOString(),
              decision: 'submit', timedOut: false,
              itemDecisions: state.prompt.items.map(item => ({ itemId: item.id, decision: 'deny', defaulted: true })),
            },
          })
          return
        }
        reply(503, { ok: false, error: REFUSAL })
        return
      }
      reply(404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  return { state, serverPromise }
}

async function waitFor(webContents, expression, timeoutMs = 15_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${expression}`)
}

/* Reached the same way a person reaches it: the arrows are the only navigation
   this product has, so pressing them is the only claim worth making. */
function pressUntil(webContents, button, targetHash, presses = 12) {
  return webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const seen = [];
    for (let press = 0; press < ${presses}; press += 1) {
      if (location.hash === ${JSON.stringify(targetHash)}) return { seen, arrived: true };
      document.getElementById(${JSON.stringify(button)}).click();
      await wait(520);
      seen.push(location.hash || '#/');
    }
    return { seen, arrived: location.hash === ${JSON.stringify(targetHash)} };
  })()`)
}

/* The shipped palette, read from the capability layer this product ships rather
   than restated here. Fails loud: a harness that invents a theme would go green
   over a product whose theme had gone missing. */
function shippedThemeManifest() {
  const capability = RENDERER.release ? path.join(RENDERER.release, 'resources', 'capability') : path.join(ROOT, 'capability')
  const modulePath = path.join(capability, 'src', 'lib', 'owner-prompt-theme.js')
  if (!fs.existsSync(modulePath)) throw new Error(`the shipped theme manifest is not in this tree at ${modulePath}`)
  // eslint-disable-next-line global-require
  const shipped = require(modulePath)
  if (!shipped || typeof shipped.themeManifest !== 'function') throw new Error(`${modulePath} no longer exports themeManifest()`)
  const manifest = shipped.themeManifest()
  const missing = ['white', 'tan', 'black'].filter(name => !manifest?.themes?.[name])
  if (missing.length > 0) throw new Error(`the shipped manifest is unusable (missing themes: ${missing.join(', ')})`)
  return manifest
}

const NOT_RECORDED = /not recorded|could not be recorded|nothing was approved/i

// The main Ledger and the nested approvals queue both have count lines.
// Read only the actual approvals surface, including whether its warning paints.
function readApprovalsView() {
  const queue = document.querySelector('.ledger-prompt-queue')
  const status = queue?.querySelector('.owner-popup-status')
  const card = queue?.querySelector('.approvals-card')
  const primary = queue?.querySelector('.owner-popup-primary')
  const count = queue?.querySelector('[data-visible-count]')
  const box = count?.getBoundingClientRect()
  const style = count ? getComputedStyle(count) : null
  return {
    queuePresent: Boolean(queue),
    cards: queue?.querySelectorAll('.approvals-card').length ?? 0,
    status: status?.textContent ?? null,
    statusRole: status?.getAttribute('role') ?? null,
    statusLive: status?.getAttribute('aria-live') ?? null,
    statusState: status?.dataset.state ?? null,
    cardFlag: card?.dataset.decisionUndelivered ?? null,
    countNote: count?.textContent ?? null,
    countNoteVisible: Boolean(box && box.width > 0 && box.height > 0 && style.display !== 'none'
      && style.visibility === 'visible' && Number(style.opacity) > 0),
    canRetry: primary ? !primary.disabled : null,
    emptyState: queue?.querySelector('.projection-state strong')?.textContent ?? null,
  }
}

/* packaged-qa-suite cross-examines a driver's exit code against a closing
   result. JSON is evidence, but an arbitrary JSON object is deliberately not a
   verdict, so close this one end-to-end journey with the suite's counted
   vocabulary after writing the full evidence object. */
function emitObserved(observed) {
  const passed = observed.ok === true ? 1 : 0
  process.stdout.write(`${JSON.stringify(observed, null, 2)}\n${passed}/1 checks passed (approvals decision outcome)\n`)
}

async function run(mode) {
  const appDir = selectedAppDirectory()
  if (!fs.existsSync(path.join(appDir, 'index.html'))) throw new Error(`--app ${appDir} has no index.html`)
  /* Long enough that the outgoing view is measurably destroyed before the answer
     lands, and nothing like the 30s the real call is allowed to take. */
  const decisionDelayMs = Number(arg('delay', '2500'))
  if (!Number.isFinite(decisionDelayMs) || decisionDelayMs < 0) throw new Error('--delay must be a number of milliseconds')
  const theme = shippedThemeManifest()
  const selectedTheme = arg('theme-name', theme.defaultTheme)
  if (!['white', 'tan', 'black'].includes(selectedTheme)) throw new Error('--theme-name must be white, tan, or black')
  const outputDir = path.resolve(arg('out', path.join(ROOT, 'artifacts', 'approvals-outcome')))
  fs.mkdirSync(outputDir, { recursive: true })

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-approvals-outcome-qa-'))
  const preload = path.join(temporary, 'preload.cjs')
  /* mcAgent is here because WITHOUT IT home renders its browser fallback ("this
     page is running in a browser, not the installed app"), which states one
     fact and none of the others -- so the approvals readout, the thing being
     proved, is not on the screen at all. This stub reports the plainest true
     shape of an ordinary install: the engine answers, and nothing has run here
     yet. It fabricates no runs and no fleet. */
  fs.writeFileSync(preload, [
    `const { contextBridge } = require('electron');`,
    `contextBridge.exposeInMainWorld('mcShell', { getBridgeProof: async () => ({ ok: true, proof: ${JSON.stringify(PROOF)} }) });`,
    `contextBridge.exposeInMainWorld('mcAgent', {`,
    `  availability: async () => ({ ok: true }),`,
    `  history: async () => ({ ok: true, entries: [], outcomes: { starts: 0 } }),`,
    `});`,
    '',
  ].join('\n'), 'utf8')
  app.setPath('userData', path.join(temporary, 'profile'))
  app.commandLine.appendSwitch('disable-gpu')
  app.once('quit', () => {
    const resolved = path.resolve(temporary)
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) return
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 }) } catch { /* the OS reclaims it */ }
  })

  const appServer = await serveApp(appDir)
  const fixture = serveFixture(theme, { mode, decisionDelayMs })
  const bridgeServer = await fixture.serverPromise
  const appOrigin = `http://127.0.0.1:${appServer.address().port}`
  const bridgeOrigin = `http://127.0.0.1:${bridgeServer.address().port}`

  const browser = new BrowserWindow({
    width: 1440, height: 960,
    // shown INACTIVE: a window that never composites never paints, and a
    // screenshot of a page that never painted is a harness passing on nothing.
    show: false, useContentSize: true,
    backgroundColor: theme.themes[selectedTheme].bg,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload, backgroundThrottling: false },
  })
  /* WHERE, NOT ONLY WHAT. A renderer error reported as a bare sentence sends the
     next reader grepping for a DOM message that half a dozen call sites can
     throw; the source and line are already on the event and cost nothing. */
  const rendererErrors = []
  browser.webContents.on('console-message', event => {
    if (event?.level !== 'error') return
    const where = event.sourceId ? ` [${event.sourceId}:${event.lineNumber}]` : ''
    rendererErrors.push(`${String(event.message || 'unknown renderer error')}${where}`)
  })

  const observed = { mode, appDir, renderer: { ...RENDERER.provenance, dist: appDir }, decisionDelayMs, notes: [] }

  /* CAPTURE, WITH THE COMPOSITOR GIVEN A CHANCE. capturePage() on a window
     that has not composited a frame yet rejects with UnknownVizError -- the
     class tools/ring-capture-main.cjs documents as "too early", not a fault.
     On the 2026-08-19 final confirming suite that single rejection, thrown at
     the HOME screenshot, aborted this run: toldOnApprovals, the queue count
     line, the bridge counters and the whole assertion block were destroyed
     for a picture no assertion reads. The screenshots are documentation; the
     DOM reads are the measurement. So a shot retries with an invalidate
     between attempts, and one that still cannot be taken is written down as a
     note and skipped -- it is never allowed to cost the verdict. Every
     product assertion below this helper is byte-identical to before it. */
  const shoot = async (webContents, file) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        fs.writeFileSync(file, (await webContents.capturePage()).toPNG())
        return
      } catch (error) {
        if (attempt === 3) {
          observed.notes.push(`screenshot skipped (${path.basename(file)}): ${error?.message || error}`)
          return
        }
        try { webContents.invalidate() } catch { /* retry regardless */ }
        await new Promise(resolve => setTimeout(resolve, 400))
      }
    }
  }
  try {
    await browser.loadURL(`${appOrigin}/?bridge=${encodeURIComponent(bridgeOrigin)}`)
    await browser.webContents.executeJavaScript(`localStorage.setItem('mc.theme', ${JSON.stringify(selectedTheme)})`)
    fixture.state.enabled = true
    await browser.reload()
    browser.showInactive()
    await waitFor(browser.webContents, `document.getElementById('nav-next')`)

    const toApprovals = await pressUntil(browser.webContents, 'nav-next', '#/ledger')
    if (!toApprovals.arrived) throw new Error(`the forward arrow never reached #/approvals: ${JSON.stringify(toApprovals.seen)}`)
    await waitFor(browser.webContents, `document.querySelector('[data-mode="p"]')`)
    await browser.webContents.executeJavaScript(`document.querySelector('[data-mode="p"]').click()`)
    await waitFor(browser.webContents, `document.querySelectorAll('.owner-popup-item').length === 3`)
    await waitFor(browser.webContents, `document.querySelector('.owner-popup-primary:not([disabled])')`)

    /* Decide a line, submit, and LEAVE -- one arrow press, which is all it takes
       for the router to destroy the instance holding the in-flight call. */
    await browser.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.owner-popup-item')[0].querySelector('.owner-popup-approve').click();
    })()`)
    const submittedAt = Date.now()
    await browser.webContents.executeJavaScript(`document.querySelector('.owner-popup-primary').click()`)
    await new Promise(resolve => setTimeout(resolve, 120))
    observed.statusWhileInFlight = await browser.webContents.executeJavaScript(
      `document.querySelector('.owner-popup-status')?.textContent || null`)
    await browser.webContents.executeJavaScript(`document.getElementById('nav-next').click()`)
    /* The router keeps the outgoing view on screen for its exit transition and
       destroys it at the end of that (src/main.js, 420ms), or immediately when a
       view transition captured the frame. Either way the instance is gone well
       before the bridge answers -- but it has to be MEASURED gone, because
       "answered while the screen was still up" would be a different journey than
       the one this file claims to drive. */
    const goneBy = Date.now() + 2_000
    let viewGoneAt = null
    while (Date.now() < goneBy) {
      const still = await browser.webContents.executeJavaScript(`Boolean(document.querySelector('.ledger-prompt-queue'))`)
      if (!still) { viewGoneAt = Date.now(); break }
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    observed.viewGoneAfterMs = viewGoneAt === null ? null : viewGoneAt - submittedAt
    observed.leftFor = await browser.webContents.executeJavaScript(`location.hash || '#/'`)
    observed.approvalsStillMounted = await browser.webContents.executeJavaScript(
      `Boolean(document.querySelector('.ledger-prompt-queue'))`)

    // Wait for the bridge to actually answer, so nothing below is a guess.
    const deadline = Date.now() + decisionDelayMs + 10_000
    while (fixture.state.decisionAnswers === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
    if (fixture.state.decisionAnswers !== 1) throw new Error('the bridge never answered the decision')
    observed.answerArrivedAfterMs = fixture.state.decisionAnsweredAt - submittedAt
    observed.answeredWhileOffScreen = viewGoneAt !== null && fixture.state.decisionAnsweredAt > viewGoneAt
    await new Promise(resolve => setTimeout(resolve, 600))

    /* 1. HOME -- the screen he lands on, and the one this design nominated as
          its only signal channel. */
    const toHome = await pressUntil(browser.webContents, 'nav-next', '#/')
    if (!toHome.arrived) throw new Error(`the forward arrow never reached home: ${JSON.stringify(toHome.seen)}`)
    await waitFor(browser.webContents, `document.querySelectorAll('.home-fact').length > 0`)
    await new Promise(resolve => setTimeout(resolve, 500))
    observed.homeFacts = await browser.webContents.executeJavaScript(
      `[...document.querySelectorAll('.home-fact span')].map(node => node.textContent)`)
    observed.toldOnHome = observed.homeFacts.some(text => NOT_RECORDED.test(text))
    await shoot(browser.webContents, path.join(outputDir, `home-${mode}-${selectedTheme}.png`))

    /* 2. BACK ON THE APPROVALS SCREEN -- where the decision lives. */
    const backToApprovals = await pressUntil(browser.webContents, 'nav-back', '#/ledger')
    if (!backToApprovals.arrived) throw new Error(`the back arrow never returned to #/approvals: ${JSON.stringify(backToApprovals.seen)}`)
    await waitFor(browser.webContents, `document.querySelector('[data-mode="p"]')`)
    await browser.webContents.executeJavaScript(`document.querySelector('[data-mode="p"]').click()`)
    await waitFor(browser.webContents, `document.querySelector('.ledger-prompt-queue')`)
    await new Promise(resolve => setTimeout(resolve, 1_200))
    observed.approvals = await browser.webContents.executeJavaScript(`(${readApprovalsView.toString()})()`)
    observed.toldOnApprovals = NOT_RECORDED.test(observed.approvals.status || '')
    observed.pageText = await browser.webContents.executeJavaScript(`document.body.innerText`)
    await shoot(browser.webContents, path.join(outputDir, `approvals-${mode}-${selectedTheme}.png`))

    observed.bridge = {
      decisionRequests: fixture.state.decisionRequests.length,
      decisionAnswers: fixture.state.decisionAnswers,
      presentations: fixture.state.presentations,
      recordedByEngine: fixture.state.decided,
    }

    const failures = []
    if (!observed.approvals.queuePresent) failures.push('the returned approvals surface is absent')
    if (observed.approvalsStillMounted) {
      failures.push('the approvals view was still mounted when the answer came back, so this run never exercised the dropped-outcome path')
    }
    if (!observed.answeredWhileOffScreen) {
      failures.push('the bridge answered before the approvals view was gone, so this run never exercised the dropped-outcome path')
    }
    if (mode === 'refuse') {
      if (fixture.state.decided) failures.push('the fixture recorded a decision it was told to refuse')
      if (!observed.toldOnApprovals) failures.push('back on #/approvals the person is NOT told the decision was not recorded')
      if (observed.approvals.statusRole !== 'alert') failures.push(`the notice is not announced as an alert (role=${observed.approvals.statusRole})`)
      if (observed.approvals.statusLive !== 'assertive') failures.push(`the alert is still queued politely (aria-live=${observed.approvals.statusLive}), which outranks role=alert`)
      if (observed.approvals.cardFlag !== 'true') failures.push('the card carries no undelivered-decision marking')
      if (observed.approvals.canRetry !== true) failures.push('the person cannot try the decision again')
      if (!NOT_RECORDED.test(observed.approvals.countNote || '')) failures.push('the queue count line does not mention the decision that was not recorded')
      if (!observed.approvals.countNoteVisible) failures.push('the approvals queue count warning is not visibly rendered')
      if (!observed.toldOnHome) failures.push('home does NOT state that a decision he made was not recorded')
    } else {
      if (!fixture.state.decided) failures.push('the fixture was told to accept and did not record a decision')
      if (observed.approvals.cards !== 0) failures.push('the decided request is still on the approvals screen')
      if (NOT_RECORDED.test(observed.pageText)) failures.push('a "not recorded" notice appeared after a decision that WAS recorded')
      if (observed.homeFacts.some(text => NOT_RECORDED.test(text))) failures.push('home claims a failure after a decision that succeeded')
    }
    if (rendererErrors.length > 0) failures.push(`renderer errors: ${JSON.stringify(rendererErrors)}`)

    observed.failures = failures
    observed.ok = failures.length === 0
    RENDERER.assertUnchanged()
    emitObserved(observed)
    if (!observed.ok) process.exitCode = 1
  } catch (error) {
    observed.ok = false
    observed.failures = [`harness error: ${error?.message || error}`]
    emitObserved(observed)
    process.exitCode = 1
  } finally {
    browser.destroy()
    appServer.close()
    bridgeServer.close()
  }
  return observed
}

async function runSelectedModes() {
  const selected = arg('mode', 'both')
  if (!['both', 'refuse', 'accept'].includes(selected)) throw new Error('--mode must be both, refuse or accept')
  const modes = selected === 'both' ? ['refuse', 'accept'] : [selected]
  const observations = []
  // Separate app/bridge origins per case, within this run's disposable
  // Electron session. A refusal cannot prevent the accepted-outcome check.
  for (const mode of modes) observations.push(await run(mode))
  const passed = observations.filter(observed => observed.ok === true).length
  process.stdout.write(`${passed}/${observations.length} checks passed (complete approvals outcome modes)\n`)
  return passed === observations.length
}

/* app.exit(code), not app.quit(). quit() tears the app down and exits 0
   regardless of process.exitCode, which would make this harness a gate that can
   report a red run and still hand its caller a green exit status. */
// Closing the first case must not start Electron's automatic last-window
// shutdown while the second case is mounting. Only the final verdict exits.
app.on('window-all-closed', () => {})
app.whenReady().then(runSelectedModes).then(ok => app.exit(ok ? 0 : 1), error => {
  process.stderr.write(`${error?.stack || error}\n`)
  app.exit(1)
})
