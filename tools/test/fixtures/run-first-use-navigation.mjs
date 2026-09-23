// T1233/T1267: real guidance/navigation modules and CSS, no product page or bridge.
// Run only under the current CPU/slot/browser custody controls. This driver is
// not an admission mechanism. The caller supplies the already served private
// tree as BENCHMARK_TEST_ORIGIN, an unused BENCHMARK_TEST_OUTPUT directory, and
// optionally MC_PLAYWRIGHT_ROOT. No server, live app, or saved profile is opened.
//
// Bounded matrix: six non-Research guided routes, both layouts, three measured
// sizes; twelve guide-less transitions; four resize/layout/zoom journeys;
// two automatic narrow-rail sizes and one manual-collapse/expanded journey.
// Navigation hit-testing samples 20%, 50%, 80% across each control's midline,
// plus rejects any rectangular card/control overlap. Geometry is measured,
// never compared with implementation-chosen card coordinates.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const originText = process.env.BENCHMARK_TEST_ORIGIN
const output = process.env.BENCHMARK_TEST_OUTPUT
if (!originText || !output) throw Error('BENCHMARK_TEST_ORIGIN and BENCHMARK_TEST_OUTPUT are required; no fixture run was started.')
const origin = new URL(originText)
assert.ok(['http:', 'https:'].includes(origin.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname), 'Use an admitted loopback fixture origin')
assert.ok(!origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'Supply an origin without credentials, path, query or fragment')
const outputFile = path.join(output, 'results.json')
assert.ok(!fs.existsSync(outputFile), 'Refusing to overwrite an earlier receipt; supply a new output directory')
const root = fileURLToPath(new URL('../../../', import.meta.url))
const driver = fileURLToPath(import.meta.url)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceFiles = [
  'src/first-use-guidance.js', 'src/first-use-guidance.css', 'src/app-navigation.js',
  'src/app-navigation.css', 'src/feature-guides.js', 'src/styles.css',
  'src/theme-refinements.css', 'src/phone-canvas.css',
  'tools/test/fixtures/first-use-guidance.html',
]
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]))
const results = {
  driver: { file: 'tools/test/fixtures/run-first-use-navigation.mjs', sha256: hash(fs.readFileSync(driver)) },
  platform: process.platform, arch: process.arch, startedAt: new Date().toISOString(),
  origin: origin.origin, sourceHashes, checks: [], errors: [], measurements: [],
  outsideRequests: 0, otherOriginRequests: 0,
  scope: 'Mounted fixture only; not a full app or native Linux/Windows hand check. Research routes excluded.',
}
const routes = ['home', 'computers', 'metrics', 'comms', 'ledger', 'settings']
const sizes = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }]
const { chromium } = require(process.env.MC_PLAYWRIGHT_ROOT || 'playwright')
let browser

async function settled(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(requestAnimationFrame)
    await Promise.all(document.querySelector('header.topbar').getAnimations().map(animation => animation.finished.catch(() => {})))
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
  })
}

// The page loads every file by its root-relative URL, but the pinned Vite 6.4
// answers a root-relative `?raw` request with the plain file, not a module. So
// the exact bytes are read through each file's `/@fs/` URL, which names this
// checkout and which Vite refuses outside its serving allow list. The module
// the page gets from each root-relative JS or CSS URL must then equal the one
// Vite makes for this checkout's file. Vite writes a CSS module's absolute path
// into it and a JS module's imports relative to its own root, so this ties the
// origin's root, and the fixture page served from it, to this checkout rather
// than to a tree the origin merely may read.
const checkoutUrl = file => '/@fs/' + encodeURI(path.join(root, file).split(path.sep).join('/').replace(/^\/+/, ''))

async function sourceIdentity(page) {
  const served = await page.evaluate(async files => {
    const text = async url => {
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) throw Error(url + ' answered HTTP ' + response.status)
      return response.text()
    }
    return Promise.all(files.map(async ([file, own]) => {
      const bytes = await import(own + '?raw&t=' + Date.now()).then(module => module.default,
        error => { throw Error('The origin will not serve this checkout\'s ' + file + ': ' + error.message) })
      return [file, bytes, /\.(js|css)$/.test(file) ? await text('/' + file) === await text(own) : true]
    }))
  }, sourceFiles.map(file => [file, checkoutUrl(file)]))
  for (const [file, bytes, sameTree] of served) {
    assert.equal(hash(bytes), sourceHashes[file], 'Served source differs from this checkout: ' + file)
    assert.equal(sameTree, true, 'The origin serves ' + file + ' from a different tree than this checkout')
  }
}

async function fixture(name, layout, size, route, fn) {
  results.checks.push(name)
  let context
  try {
    context = await browser.newContext({ viewport: size, serviceWorkers: 'block' })
    await context.route('**/*', request => {
      const url = new URL(request.request().url())
      if (url.origin === origin.origin || ['data:', 'blob:'].includes(url.protocol)) return request.continue()
      results.otherOriginRequests++
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) results.outsideRequests++
      return request.abort()
    })
    const page = await context.newPage()
    page.on('pageerror', error => results.errors.push(name + ': browser error: ' + error.message))
    const url = new URL('/tools/test/fixtures/first-use-guidance.html', origin)
    url.searchParams.set('layout', layout)
    url.searchParams.set('route', route)
    await page.goto(url.href, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => typeof window.visit === 'function' && window.fixtureNavigation)
    await settled(page)
    await sourceIdentity(page)
    await fn(page, name)
    await sourceIdentity(page)
  } catch (error) {
    results.errors.push(name + ': ' + error.message)
  } finally {
    await context?.close()
  }
}

async function reachable(page, name, includePageControls = true) {
  await settled(page)
  const measurement = await page.evaluate(includePageControls => {
    const rect = element => {
      const r = element.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    }
    const card = document.querySelector('.first-use-card')
    const layer = document.querySelector('.first-use-layer')
    const cardBox = rect(card)
    const controlSelectors = 'header.topbar a, header.topbar button' + (includePageControls ? ', .fixture-computers button' : '')
    const controls = [...document.querySelectorAll(controlSelectors)]
      .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
      .map(element => {
        const box = rect(element)
        const overlaps = box.left < cardBox.right && box.right > cardBox.left && box.top < cardBox.bottom && box.bottom > cardBox.top
        const hits = [0.2, 0.5, 0.8].map(fraction => {
          const hit = document.elementFromPoint(box.left + box.width * fraction, box.top + box.height / 2)
          return hit === element || element.contains(hit)
        })
        return { id: element.id || element.dataset.route || element.getAttribute('aria-label') || element.textContent.trim(), box, overlaps, hits }
      })
    return { route: document.body.dataset.currentRoute, layout: document.body.dataset.navigation, cardBox, visible: !layer.hidden && cardBox.width > 0 && cardBox.height > 0, controls, focus: document.activeElement.id }
  }, includePageControls)
  results.measurements.push({ name, ...measurement })
  assert.equal(measurement.visible, true, 'The automatic tip must remain visible')
  for (const id of ['home', 'computers', 'metrics', 'research', 'comms', 'ledger', 'vault', 'settings', 'page-guide', 'open-settings', 'nav-back', 'nav-next']) {
    assert.ok(measurement.controls.some(control => control.id === id), 'Missing rendered navigation control: ' + id)
  }
  if (includePageControls && measurement.route === 'computers') {
    for (const id of ['Create a tree', 'Choose a tree', 'Agents', 'Computers']) assert.ok(measurement.controls.some(control => control.id === id), 'Missing Computers keep-clear control: ' + id)
  }
  assert.deepEqual(measurement.controls.filter(control => control.overlaps || control.hits.some(hit => !hit)), [], 'Navigation or Computers controls are covered')
  return measurement
}

async function noGuide(page, previousName) {
  const state = await page.locator('#page-guide').evaluate(element => ({
    boxCount: element.getClientRects().length, box: { width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height },
    label: element.getAttribute('aria-label') || '', title: element.title,
    expanded: element.getAttribute('aria-expanded'), layerHidden: document.querySelector('.first-use-layer').hidden,
  }))
  assert.equal(state.boxCount, 0, 'A guide-less route renders a Guide control')
  assert.deepEqual(state.box, { width: 0, height: 0 })
  for (const label of [state.label, state.title]) assert.ok(!label.includes(previousName), 'Previous page name remains on a guide-less route: ' + label)
  assert.equal(state.expanded, 'false')
  assert.equal(state.layerHidden, true)
}

async function railUtilities(page, name, compact) {
  await settled(page)
  const state = await page.evaluate(() => {
    const box = element => {
      const r = element.getBoundingClientRect()
      return { width: r.width, height: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    return ['page-guide', 'open-settings'].map(id => {
      const button = document.getElementById(id)
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
      const textRuns = []
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(text)
        const rect = range.getBoundingClientRect()
        textRuns.push({ width: rect.width, height: rect.height })
      }
      const icon = button.querySelector('.app-nav-icon')
      const buttonBox = box(button)
      const hit = document.elementFromPoint(buttonBox.x, buttonBox.y)
      return { id, button: buttonBox, icon: box(icon), footer: box(button.closest('.app-nav-footer')), textRuns,
        label: button.getAttribute('aria-label'), title: button.title, reachable: hit === button || button.contains(hit) }
    })
  })
  results.measurements.push({ name, compact, utilities: state })
  for (const item of state) {
    assert.equal(item.reachable, true, item.id + ' is not pointer-reachable')
    assert.ok(item.icon.width > 0 && item.icon.height > 0, item.id + ' lost its icon')
    const visibleText = item.textRuns.some(run => run.width > 0 && run.height > 0)
    if (compact) {
      assert.ok(Math.abs(item.button.width - 36) < 1 && Math.abs(item.button.height - 36) < 1, item.id + ' must be a 36px square')
      assert.ok(Math.abs(item.button.x - item.footer.x) < 1, item.id + ' is not centered in the footer')
      assert.ok(Math.abs(item.icon.x - item.button.x) < 1 && Math.abs(item.icon.y - item.button.y) < 1, item.id + ' icon is not centered')
      assert.equal(visibleText, false, item.id + ' retains a visible narrow-rail label')
    } else {
      assert.ok(item.button.width > 100, item.id + ' did not return to an expanded row')
      assert.equal(visibleText, true, item.id + ' lost its expanded label')
    }
  }
  assert.equal(state[0].label, 'Guide to Home')
  assert.equal(state[0].title, 'Guide to Home')
  assert.equal(state[1].label, 'Quick settings')
}

try {
  browser = await chromium.launch({ headless: true })
  // The original c01 finder presses Vault's now-hidden Guide before measuring
  // the narrow rail. Measure on Home, and check guide-less hiding separately.
  for (const size of [{ width: 1024, height: 640 }, { width: 640, height: 720 }]) {
    await fixture('narrow utility ' + size.width + 'x' + size.height, 'side', size, 'home', async (page, name) => {
      await railUtilities(page, name, true)
      for (const destination of ['vault', 'subscribe', 'pricing']) {
        await page.evaluate(destination => window.visit(destination), destination)
        await settled(page)
        await noGuide(page, 'Home')
      }
    })
  }
  await fixture('manual collapse and expanded utilities', 'side', sizes[0], 'home', async (page, name) => {
    await railUtilities(page, name + ' expanded', false)
    await page.locator('[data-navigation-collapse]').click()
    await railUtilities(page, name + ' collapsed', true)
    await page.locator('[data-navigation-collapse]').click()
    await railUtilities(page, name + ' restored', false)
  })
  for (const layout of ['side', 'top']) {
    for (const size of sizes) {
      for (const route of routes) {
        await fixture('intro ' + layout + ' ' + size.width + 'x' + size.height + ' ' + route, layout, size, route, async (page, name) => {
          const measured = await reachable(page, name)
          assert.equal(measured.focus, 'draft', 'An automatic tip stole the draft focus')
          // A real click must navigate with the tip open, without forced input.
          await page.locator('[data-route="vault"]').click({ timeout: 3000 })
          assert.equal(await page.evaluate(() => document.body.dataset.currentRoute), 'vault')
          assert.equal(await page.locator('.first-use-layer').isVisible(), false)
        })
      }
    }
    for (const previous of ['home', 'ledger']) {
      for (const destination of ['vault', 'subscribe', 'pricing']) {
        await fixture('route ' + layout + ' ' + previous + ' to ' + destination, layout, sizes[0], previous, async page => {
          const previousName = previous === 'home' ? 'Home' : 'Ledger'
          await page.evaluate(destination => window.visit(destination), destination)
          await settled(page)
          await noGuide(page, previousName)
          await page.locator('[data-route="' + previous + '"]').click()
          const launch = page.locator('#page-guide')
          assert.equal(await launch.isVisible(), true)
          assert.equal(await launch.getAttribute('aria-label'), 'Guide to ' + previousName)
          await launch.focus()
          await page.keyboard.press('Enter')
          assert.equal(await page.locator('.first-use-layer').isVisible(), true)
          assert.equal(await page.evaluate(() => document.querySelector('.first-use-layer').contains(document.activeElement)), true)
          await page.keyboard.press('Escape')
          assert.equal(await page.locator('.first-use-layer').isVisible(), false)
          assert.equal(await page.evaluate(() => document.activeElement.id), 'page-guide')
        })
      }
    }
    for (const route of ['home', 'computers']) {
      await fixture('resize ' + layout + ' ' + route, layout, sizes[0], route, async (page, name) => {
        for (const size of [sizes[2], sizes[1], sizes[0]]) {
          await page.setViewportSize(size)
          await reachable(page, name + ' ' + size.width)
        }
        await page.evaluate(() => window.fixtureNavigation.setLayout('side'))
        await reachable(page, name + ' side')
        await page.locator('[data-navigation-collapse]').click()
        await reachable(page, name + ' collapsed')
        await page.locator('[data-navigation-collapse]').click()
        await reachable(page, name + ' expanded')
        await page.evaluate(() => window.fixtureNavigation.setLayout('top'))
        await reachable(page, name + ' top')
        await page.evaluate(() => {
          document.documentElement.classList.add('in-shell')
          document.body.style.zoom = '1.25'
          window.fixtureNavigation.setLayout('side')
        })
        await reachable(page, name + ' shell inset and text zoom')
        // Exercise a real step target as well as the intro. Home deliberately
        // uses the existing activity-overview fixture; no Home proposal is
        // silently substituted for the pinned catalogue.
        await page.locator('.first-use-next').click()
        await settled(page)
        assert.equal(await page.locator('.first-use-highlight').isVisible(), true, 'A visible first-step target lost its highlight')
        assert.equal(await page.locator('.first-use-availability').isVisible(), false, 'A visible first-step target was reported unavailable')
        // keepClear is an intro contract; steps retain their existing target
        // placement while the rail/header/footer must remain reachable.
        await reachable(page, name + ' first guided step', false)
        assert.equal(await page.locator('#draft').inputValue(), 'A draft to keep')
        assert.equal(await page.evaluate(() => window.sent), 0, 'Reading the guide submitted the draft')
      })
    }
  }
} catch (error) {
  results.errors.push('Driver failed: ' + error.message)
} finally {
  await browser?.close()
  if (results.otherOriginRequests) results.errors.push('Refused ' + results.otherOriginRequests + ' requests outside the supplied fixture origin')
  results.finishedAt = new Date().toISOString()
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2) + '\n', { flag: 'wx' })
}
console.log(JSON.stringify({ checks: results.checks.length, measurements: results.measurements.length, errors: results.errors, outputFile }, null, 2))
if (results.errors.length) process.exitCode = 1
