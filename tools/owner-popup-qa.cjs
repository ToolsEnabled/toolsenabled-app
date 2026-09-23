/* Real-Electron owner-approval QA. It serves the production build, supplies the
   desktop bootstrap proof through an os.tmpdir() preload, and drives a local
   public-prompt fixture. No credential field or value enters this harness.

   Usage:
     electron tools/owner-popup-qa.cjs [--theme <canonical-theme.json>]
       [--out <screenshot-directory>] [--theme-name tan]

   RUN IT WITH ELECTRON_RUN_AS_NODE UNSET. With that variable in the environment
   -- and it IS set in some agent sessions on this machine -- `electron` starts
   as plain Node, `require('electron').app` is undefined, and this file dies in
   0.6s on `app.whenReady()`. That is not a product failure and must never be
   read as one.

   WHICH SURFACE THIS DRIVES, AND WHY IT CHANGED.

   It used to load the page and wait for `.owner-popup-item` to appear on its
   own. That could never happen and had nothing to do with the product being
   broken: the owner REPLACED the modal with a screen -- "instead of a popup
   maybe the purchase list is just a screen and the user navigates to that
   screen on their own time and approves whatevers in que" -- so
   src/owner-popup.js deliberately no longer self-mounts, index.html carries no
   popup root, and tools/test/approvals-screen.test.mjs FAILS if either is
   restored. The harness was waiting for an interruption the owner had removed
   on purpose, timing out after 8.9s, and reporting the product red.

   So it now drives #/ledger, which is where the owner actually approves
   purchases. Same fixture, same bridge endpoints, same renderer
   (renderOwnerPrompt with surface:'screen'), same three lines.

   AND IT REACHES THAT SCREEN BY CLICKING THE ARROW, not by assigning
   location.hash. A sibling harness reached its page by assigning the hash and
   passed in full on a build where nothing routed to the page; the arrows are
   the only navigation this product has, so clicking them is the only claim
   worth making about reachability.

   The absence case is asserted FIRST and explicitly: before navigating, there
   must be NO dialog anywhere on the page. A queue that mounts itself over
   whatever the owner is doing is the exact design he rejected, and "no popup
   appeared" has to be a measured pass here rather than the silence it was.

   WHY --theme IS NOW OPTIONAL, AND WHAT REPLACED IT.

   It was mandatory and pointed at a file that does not exist anywhere in this
   repository, so this harness could not be invoked by any automated path at
   all: every run died on `--theme must point to the canonical owner-popup theme
   JSON`. Measured, not argued -- `electron tools/owner-popup-qa.cjs` with no
   arguments exited non-zero on that line before this change.

   The manifest is NOT invented here. It is read from the capability layer this
   product ships, capability/src/lib/owner-prompt-theme.js -- the same module the
   engine serves to the real popup -- so the harness asserts against the shipped
   palette rather than against a fixture that could drift away from it. An
   explicit --theme still wins, for pinning an older manifest.

   ABSENCE IS STILL FAIL-CLOSED. If neither a --theme file nor that module is
   present or well-formed, this throws. It never falls back to a made-up palette:
   a harness that invents its own colours would go green over a product whose
   theme had gone missing, which is the failure this file exists to catch.
*/

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { selectRendererDist, rendererRequestPath } = require('./lib/qa-renderer-dist.cjs')

const ROOT = path.join(__dirname, '..')
// --release selects the candidate renderer and its own capability theme below.
const RENDERER = selectRendererDist({ argv: process.argv, repoRoot: ROOT })
const DIST = RENDERER.dist
const PROOF = 'owner-popup-qa-bootstrap-proof'.padEnd(43, '0')
const TOKEN = 'owner-popup-qa-bearer'

function arg(name, fallback = '') {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`))
  if (hit) return hit.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function serveDist() {
  const mime = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff',
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const requested = rendererRequestPath(DIST, request.url)
      if (!requested) { response.writeHead(403); response.end(); return }
      fs.readFile(requested, (error, data) => {
        if (!error) {
          response.writeHead(200, { 'content-type': mime[path.extname(requested)] || 'application/octet-stream' })
          response.end(data)
          return
        }
        fs.readFile(path.join(DIST, 'index.html'), (fallbackError, html) => {
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
    id: 'owner-popup-qa-shopping-list',
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

function serveFixture(theme) {
  const state = { enabled: false, prompt: publicPrompt(), presentations: [], presentationReceipts: [], decisions: [], decisionReceipts: [] }
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
        reply(200, { ok: true, token: TOKEN })
        return
      }
      if (request.headers.authorization !== `Bearer ${TOKEN}`) { reply(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'unauthorized' } }); return }
      if (request.method === 'GET' && url.pathname === '/v1/owner-prompts') {
        reply(200, {
          ok: true, schemaVersion: 1, generatedAt: new Date().toISOString(), theme,
          prompts: state.enabled && state.decisions.length === 0 ? [state.prompt] : [],
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/actions/owner-prompt-presented') {
        const body = await readJsonBody(request)
        state.presentations.push(body)
        state.prompt.state = 'presented'
        const receipt = { promptId: body.promptId, state: 'presented', presentedAt: new Date().toISOString() }
        state.presentationReceipts.push(receipt)
        reply(200, { ok: true, receipt })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/actions/owner-prompt-decision') {
        const body = await readJsonBody(request)
        state.decisions.push(body)
        const supplied = new Map(body.itemDecisions.map(entry => [entry.itemId, entry.decision]))
        const receipt = {
          promptId: body.promptId,
          state: 'decided',
          resolvedAt: new Date().toISOString(),
          decision: 'submit',
          timedOut: false,
          itemDecisions: state.prompt.items.map(item => ({
            itemId: item.id,
            decision: supplied.get(item.id) || 'deny',
            defaulted: !supplied.has(item.id),
          })),
        }
        state.decisionReceipts.push(receipt)
        reply(200, { ok: true, receipt })
        return
      }
      reply(404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  return { state, serverPromise }
}

async function waitFor(webContents, expression, timeoutMs = 8_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

/* The shipped manifest, read from the capability layer rather than restated.
 *
 * Every failure below is LOUD. `require` of a missing module throws, a module
 * that no longer exports themeManifest throws here, and a manifest that is not
 * a plain object with the three named themes throws here. None of them degrade
 * into a default: an empty or partial manifest that this function let through
 * would paint the popup with `undefined` and every colour assertion downstream
 * would compare undefined against undefined and pass.
 */
function shippedThemeManifest() {
  const capability = RENDERER.release
    ? path.join(RENDERER.release, 'resources', 'capability')
    : path.join(ROOT, 'capability')
  const modulePath = path.join(capability, 'src', 'lib', 'owner-prompt-theme.js')
  if (!fs.existsSync(modulePath)) {
    throw new Error(`no --theme given and the shipped manifest is not in this tree at ${modulePath}`)
  }
  // eslint-disable-next-line global-require
  const shipped = require(modulePath)
  if (!shipped || typeof shipped.themeManifest !== 'function') {
    throw new Error(`${modulePath} no longer exports themeManifest()`)
  }
  const manifest = shipped.themeManifest()
  const named = manifest && manifest.themes
  const missing = ['white', 'tan', 'black'].filter(name => !named || !named[name])
  if (!manifest || typeof manifest !== 'object' || missing.length > 0) {
    throw new Error(`the shipped manifest is unusable (missing themes: ${missing.join(', ') || 'all'})`)
  }
  return { manifest, source: modulePath }
}

async function run() {
  const themePathArgument = arg('theme')
  if (RENDERER.release && themePathArgument) throw new Error('--theme cannot override the selected release capability theme')
  const derived = themePathArgument ? null : shippedThemeManifest()
  const themePath = themePathArgument ? path.resolve(themePathArgument) : derived.source
  const theme = themePathArgument ? JSON.parse(fs.readFileSync(themePath, 'utf8')) : derived.manifest
  const selectedTheme = arg('theme-name', theme.defaultTheme)
  if (!['white', 'tan', 'black'].includes(selectedTheme)) throw new Error('--theme-name must be white, tan, or black')
  const outputDir = path.resolve(arg('out', path.join(ROOT, 'artifacts', 'owner-popup')))
  fs.mkdirSync(outputDir, { recursive: true })

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-owner-popup-qa-'))
  const preload = path.join(temporary, 'preload.cjs')
  fs.writeFileSync(preload, `const { contextBridge } = require('electron');\ncontextBridge.exposeInMainWorld('mcShell', { getBridgeProof: async () => ({ ok: true, proof: ${JSON.stringify(PROOF)} }) });\n`, 'utf8')
  app.setPath('userData', path.join(temporary, 'profile'))
  app.commandLine.appendSwitch('disable-gpu')
  app.once('quit', () => {
    const resolvedTemporary = path.resolve(temporary)
    if (!resolvedTemporary.startsWith(path.resolve(os.tmpdir()) + path.sep)) return
    try { fs.rmSync(resolvedTemporary, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 }) }
    catch { /* the OS will reclaim an isolated temp harness directory */ }
  })

  const distServer = await serveDist()
  const fixture = serveFixture(theme)
  const bridgeServer = await fixture.serverPromise
  const distOrigin = `http://127.0.0.1:${distServer.address().port}`
  const bridgeOrigin = `http://127.0.0.1:${bridgeServer.address().port}`
  const browser = new BrowserWindow({
    width: 1440,
    height: 960,
    /* Created hidden and then shown INACTIVE, for the reason tools/page2-shoot.cjs
       records: a window that is never shown never composites, so anything that
       fades in stays at opacity 0 and the screenshot this harness writes comes
       back blank -- a harness passing on a page the owner sees differently. It
       was `show: true`, which stole focus from whatever the owner was doing
       every time this ran. showInactive() paints without taking the foreground. */
    show: false,
    useContentSize: true,
    backgroundColor: theme.themes[selectedTheme].bg,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload, backgroundThrottling: false },
  })
  const errors = []
  browser.webContents.on('console-message', event => {
    if (event?.level === 'error') errors.push(String(event.message || 'unknown renderer error'))
  })

  try {
    const url = `${distOrigin}/?bridge=${encodeURIComponent(bridgeOrigin)}`
    await browser.loadURL(url)
    await browser.webContents.executeJavaScript(`localStorage.setItem('mc.theme', ${JSON.stringify(selectedTheme)})`)
    fixture.state.enabled = true
    await browser.reload()
    browser.showInactive()
    browser.focus()
    await waitFor(browser.webContents, `document.getElementById('nav-next')`)

    /* THE ABSENCE CASE, MEASURED BEFORE ANYTHING ELSE.
       A prompt is in the queue right now. Nothing may appear over the screen
       the owner landed on. Held for two poll intervals of the screen's own
       controller (2s each) plus slack, so this is a waited absence and not a
       glance. */
    await new Promise(resolve => setTimeout(resolve, 4_500))
    const uninvited = await browser.webContents.executeJavaScript(`(() => {
      const dialogs = document.querySelectorAll('.owner-popup-dialog, .owner-popup-overlay');
      return { count: dialogs.length, route: location.hash || '#/' };
    })()`)
    if (uninvited.count !== 0) {
      throw new Error(`a prompt mounted itself over ${uninvited.route} without being asked: ${uninvited.count} node(s)`)
    }

    /* REACH THE SCREEN THE WAY A PERSON CAN: the forward arrow, once per stop,
       until the route is approvals. Bounded by the ring length so a router that
       never arrives fails here instead of spinning. */
    const navigation = await browser.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const clicks = [];
      for (let press = 0; press < 12; press += 1) {
        if (location.hash === '#/ledger') return { clicks, arrived: true };
        document.getElementById('nav-next').click();
        await wait(500);
        clicks.push(location.hash);
      }
      return { clicks, arrived: location.hash === '#/ledger' };
    })()`)
    if (!navigation.arrived) {
      throw new Error(`the forward arrow never reached #/ledger: ${JSON.stringify(navigation.clicks)}`)
    }

    await waitFor(browser.webContents, `document.querySelector('[data-mode="p"]')`)
    await browser.webContents.executeJavaScript(`document.querySelector('[data-mode="p"]').click()`)
    await waitFor(browser.webContents, `document.querySelector('.ledger-prompt-queue')`)
    await waitFor(browser.webContents, `document.querySelectorAll('.owner-popup-item').length === 3`, 15_000)
    // The engine refuses a decision on a prompt it was never told was presented,
    // so the controls are disabled until the screen has measured the card as
    // genuinely on the glass and the bridge has accepted that evidence.
    await waitFor(browser.webContents, `document.querySelector('.owner-popup-primary:not([disabled])')`, 15_000)
    await browser.webContents.executeJavaScript(`document.fonts.ready.then(() => true)`)

    await browser.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('.owner-popup-item')];
      rows[0].querySelector('.owner-popup-deny').click();
      rows[2].querySelector('.owner-popup-approve').click();
    })()`)
    await waitFor(browser.webContents, `document.querySelectorAll('.owner-popup-item[data-decision="denied"]').length === 1 && document.querySelectorAll('.owner-popup-item[data-decision="undecided"]').length === 1`)
    await new Promise(resolve => setTimeout(resolve, 300))

    const observation = await browser.webContents.executeJavaScript(`(() => {
      // On the screen the theme is applied to the register the cards live in,
      // which is the element that carries the .owner-popup-root class; there is
      // no element with that ID and asserting one would only re-test the modal.
      const root = document.querySelector('.owner-popup-root');
      const dialog = document.querySelector('.owner-popup-dialog');
      const submit = dialog.querySelector('.owner-popup-primary');
      const submitStyle = getComputedStyle(submit);
      const rgb = value => (value.match(/[0-9.]+/g) || []).slice(0, 3).map(Number);
      const luminance = value => {
        const channels = rgb(value).map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const foregroundLuminance = luminance(submitStyle.color);
      const backgroundLuminance = luminance(submitStyle.backgroundColor);
      const submitContrast = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
      return {
        title: dialog.querySelector('h2').textContent,
        amounts: [...dialog.querySelectorAll('.owner-popup-item-amount')].map(node => node.textContent),
        total: dialog.querySelector('.owner-popup-total strong').textContent,
        decisions: [...dialog.querySelectorAll('.owner-popup-item')].map(node => node.dataset.decision),
        defaultRule: dialog.querySelector('.owner-popup-default-rule').textContent.replace(/\\s+/g, ' ').trim(),
        status: dialog.querySelector('.owner-popup-status').textContent,
        focusedInside: dialog.contains(document.activeElement),
        theme: root.dataset.ownerTheme,
        manifestBackground: root.style.getPropertyValue('--op-bg').trim(),
        manifestAccent: root.style.getPropertyValue('--op-accent').trim(),
        manifestOnAccent: root.style.getPropertyValue('--op-on-accent').trim(),
        submitLabel: submit.textContent,
        submitColor: submitStyle.color,
        submitBackground: submitStyle.backgroundColor,
        submitContrast: Number(submitContrast.toFixed(2)),
      };
    })()`)
    const expectedTheme = theme.themes[selectedTheme]
    if (observation.theme !== selectedTheme
        || observation.manifestBackground !== expectedTheme.bg
        || observation.manifestAccent !== theme.common.accent
        || observation.manifestOnAccent !== theme.common.onAccent) {
      throw new Error(`the selected manifest theme was not applied: ${JSON.stringify({
        expected: {
          theme: selectedTheme,
          manifestBackground: expectedTheme.bg,
          manifestAccent: theme.common.accent,
          manifestOnAccent: theme.common.onAccent,
        },
        observed: {
          theme: observation.theme,
          manifestBackground: observation.manifestBackground,
          manifestAccent: observation.manifestAccent,
          manifestOnAccent: observation.manifestOnAccent,
        },
      })}`)
    }
    if (observation.submitLabel !== 'Submit decisions' || observation.submitContrast < 4.5) {
      throw new Error(`submit label is not visibly rendered at text contrast: ${JSON.stringify(observation)}`)
    }
    const screenshotPath = path.join(outputDir, `shopping-list-${selectedTheme}.png`)
    fs.writeFileSync(screenshotPath, (await browser.webContents.capturePage()).toPNG())

    await browser.webContents.executeJavaScript(`document.querySelector('.owner-popup-primary').click()`)
    const decisionDeadline = Date.now() + 5_000
    while (fixture.state.decisions.length === 0 && Date.now() < decisionDeadline) await new Promise(resolve => setTimeout(resolve, 25))
    if (fixture.state.decisions.length !== 1) throw new Error('the sample decision was not delivered')
    await waitFor(browser.webContents, `!document.querySelector('.owner-popup-dialog')`)

    const submitted = fixture.state.decisions[0]
    const explicit = new Map(submitted.itemDecisions.map(entry => [entry.itemId, entry.decision]))
    const outcomes = fixture.state.decisionReceipts[0].itemDecisions.map(item => ({
      itemId: item.itemId,
      submitted: explicit.get(item.itemId) || 'undecided',
      effective: item.decision === 'approve' ? 'approved' : 'denied',
      defaulted: item.defaulted,
      action: item.decision === 'approve' ? 'eligible' : 'refused',
    }))
    RENDERER.assertUnchanged()
    process.stdout.write(`${JSON.stringify({
      ok: errors.length === 0,
      renderer: RENDERER.provenance,
      screenshotPath,
      canonicalThemePath: themePath,
      presentationRequest: fixture.state.presentations[0],
      presentationReceipt: fixture.state.presentationReceipts[0],
      observation,
      decisionRequest: submitted,
      decisionReceipt: fixture.state.decisionReceipts[0],
      outcomes,
      rendererErrors: errors,
    }, null, 2)}\n`)
    if (errors.length) throw new Error(`renderer errors: ${errors.join(' | ')}`)
  } finally {
    if (!browser.isDestroyed()) browser.destroy()
    await Promise.all([
      new Promise(resolve => distServer.close(resolve)),
      new Promise(resolve => bridgeServer.close(resolve)),
    ])
  }
}

app.whenReady().then(run).then(() => {
  // One complete popup scenario, not an invented count of its inner assertions.
  process.stdout.write('1/1 checks passed (complete owner-popup renderer scenario)\n')
  app.quit()
}).catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`)
  app.exit(1)
})
