/* PROMPT B. Drives a real page into the state the indicator exists for.
 *
 * The point of this file is that the guard can be SEEN failing. It takes a
 * healthy page, checks the indicator is absent, cuts the page's network so the
 * dev-server socket really closes, checks the indicator is on the glass and
 * inside the viewport, then restores the network and checks it goes away. Every
 * check is on rendered state; nothing here reads the module's own variables.
 *
 *   node tools/hotload-status-qa.mjs
 *   RESEARCH_QA_URL=http://127.0.0.1:4623 node tools/hotload-status-qa.mjs
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const origin = process.env.RESEARCH_QA_URL || 'http://127.0.0.1:4623'
const out = process.env.RESEARCH_QA_TEMP || process.env.TMP || '.'
const checks = []
const record = note => { checks.push(note); console.log('· ' + note) }
const BANNER = '#dev-hotload-status'

const settle = (page, ms) => page.waitForTimeout(ms)

/* THE DROP HAS TO BE REAL, AND IT MUST NOT TOUCH ANYONE ELSE'S SERVER. The page
   is served through a plain TCP forwarder on a spare port; cutting it destroys
   this page's own connections, including the HMR socket, and leaves the dev
   server and every other window on it untouched. Playwright's offline emulation
   was tried first and does not close an already-open websocket, so the client
   never reported anything and the drop could not be observed at all. */
function forwarder(upstreamPort) {
  const live = new Set()
  let refusing = false
  const server = net.createServer(downstream => {
    if (refusing) { downstream.destroy(); return }
    const upstream = net.connect(upstreamPort, '127.0.0.1')
    const pair = [downstream, upstream]
    for (const socket of pair) {
      live.add(socket)
      socket.on('error', () => socket.destroy())
      socket.on('close', () => { live.delete(socket); for (const other of pair) other.destroy() })
    }
    downstream.pipe(upstream)
    upstream.pipe(downstream)
  })
  return {
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    cut() { refusing = true; for (const socket of [...live]) socket.destroy() },
    restore() { refusing = false },
    close: () => new Promise(resolve => { refusing = true; for (const socket of [...live]) socket.destroy(); server.close(resolve) }),
  }
}
async function visible(page) {
  const node = page.locator(BANNER)
  if (await node.count() === 0) return false
  return node.isVisible()
}

const upstream = Number(new URL(origin).port || 80)
const proxy = forwarder(upstream)
const port = await proxy.listen()
const served = `http://127.0.0.1:${port}`

let browser
try {
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))

  // Both lanes, because the indicator lives in the shell and has to cover the
  // route the owner happens to be on.
  for (const route of ['#/', '#/research']) {
    await page.goto(served + '/' + route, { waitUntil: 'domcontentloaded', timeout: 60000 })
    const dismiss = page.getByRole('button', { name: 'Not now', exact: true })
    await dismiss.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
    if (await dismiss.isVisible()) await dismiss.click()
    await settle(page, 2500)
    assert.equal(await page.locator(BANNER).count(), 1, `the indicator is mounted on ${route}`)
    assert.equal(await visible(page), false, `a healthy page shows nothing on ${route}`)
  }
  record('healthy page on both routes: indicator mounted, nothing on the glass')

  // A real socket close, not a simulated event: this page's own connections are
  // destroyed under it and Vite's client reports the channel gone.
  proxy.cut()
  await page.waitForFunction(selector => {
    const node = document.querySelector(selector)
    return Boolean(node) && node.hidden === false
  }, BANNER, { timeout: 30000 })
  assert.equal(await visible(page), true, 'the indicator is on the glass after the socket closed')
  const box = await page.locator(BANNER).boundingBox()
  assert.ok(box && box.y >= 0 && box.y < 900 && box.width > 400, `it is inside the viewport: ${JSON.stringify(box)}`)
  const said = (await page.locator(BANNER).innerText()).replace(/\s+/g, ' ').trim()
  assert.match(said, /stale/i, 'it says the page is stale')
  assert.match(said, /reload/i, 'and names the way out')
  assert.equal(await page.locator(`${BANNER} [data-dev-hotload-reload]`).isVisible(), true, 'and offers the reload itself')
  assert.equal(await page.locator(BANNER).getAttribute('data-dev-hotload-status'), 'down')
  /* A client that cannot reach the server retries, and each failure reports the
     same disconnect. The banner has to survive the repeats rather than flicker
     between them -- which is also the mechanism that covers a page whose
     channel never opened at all. */
  await settle(page, 6000)
  assert.equal(await visible(page), true, 'it stays up across the client retry loop')
  record('stayed up across the retry loop while the channel remained down')
  record(`socket dropped: indicator visible at y=${Math.round(box.y)} saying "${said}"`)
  await page.screenshot({ path: path.join(out, 'hotload-status-dropped.png'), fullPage: false })

  // And it has to let go again, or it becomes the next thing nobody believes.
  proxy.restore()
  await page.waitForFunction(selector => {
    const node = document.querySelector(selector)
    return !node || node.hidden === true
  }, BANNER, { timeout: 60000 })
  assert.equal(await visible(page), false, 'the indicator clears once the channel is back')
  record('network restored: indicator cleared')
  await page.screenshot({ path: path.join(out, 'hotload-status-cleared.png'), fullPage: false })

  const mine = errors.filter(message => /hotload/i.test(message))
  assert.deepEqual(mine, [], 'the indicator itself raised nothing')
  const report = { ok: true, origin, servedThrough: served, out, checks, pageErrors: errors }
  await writeFile(path.join(out, 'hotload-status-qa.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await browser?.close(); await proxy.close() }
