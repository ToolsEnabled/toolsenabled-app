// Real browser controls over explicitly fictional service replies. Canonical
// persistence and purchase races run independently in the engine fixtures.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const out = mkdtempSync(path.join(tmpdir(), 'ledger-reset-browser-'))
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile:false, logLevel:'error', cacheDir:path.join(out,'vite-cache'),
  server:{host:'127.0.0.1',port:0,hmr:false,watch:null,fs:{allow:[root,realpathSync(path.join(root,'node_modules'))]}} })
let browser
const errors=[]
try {
 await server.listen()
 const origin=`http://127.0.0.1:${server.httpServer.address().port}`
 browser=await chromium.launch({headless:true})
 const page=await browser.newPage({viewport:{width:1000,height:750}})
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort())
 await page.goto(origin+'/tools/test/fixtures/ledger-reset-controls.html')
 await page.waitForFunction(()=>window.fixture?.controls)
 for (const [kind,name] of [['T','tasks'],['R','rules'],['A','asks'],['P','purchases']]) {
  await page.locator(`[data-reset-kind="${kind}"]`).click()
  await page.locator('dialog[open]').waitFor()
  assert.equal(await page.locator('dialog h2').textContent(),`Reset all ${name}?`)
  assert.match(await page.locator('#ledger-reset-description').textContent(),/42.*every scope and status/)
  assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-reset-cancel')),true)
  const bounds = await page.locator('dialog').boundingBox()
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - 500) < 2 && Math.abs(bounds.y + bounds.height / 2 - 375) < 2, 'warning must be centered')
  await page.screenshot({path:path.join(out,`${kind}-warning.png`)})
  await page.keyboard.press('Escape')
  await page.locator('dialog').waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.resetKind),kind)
 }
 assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.operation==='confirm').length),0)
 await page.evaluate(()=>{fixture.fail=true})
 await page.locator('[data-reset-kind="T"]').click()
 await page.locator('[data-reset-confirm]').click()
 await page.waitForFunction(()=>document.querySelector('.ledger-reset-result')?.textContent.includes('Ledger changed'))
 assert.equal(await page.evaluate(()=>fixture.refreshed.length),0)
 await page.locator('[data-reset-cancel]').click()
 await page.evaluate(()=>{fixture.fail=false;fixture.delay=500})
 await page.locator('[data-reset-kind="R"]').click()
 await page.locator('[data-reset-confirm]').click()
 assert.equal(await page.locator('[data-reset-cancel]').isDisabled(),true)
 assert.equal(await page.locator('[data-reset-confirm]').isDisabled(),true)
 await page.keyboard.press('Escape')
 assert.equal(await page.locator('dialog[open]').count(),1)
 await page.locator('dialog').waitFor({state:'detached'})
 assert.equal(await page.evaluate(()=>fixture.refreshed.length),1)
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.resetKind),'R')
 await page.setViewportSize({width:390,height:700})
 await page.locator('[data-reset-kind="P"]').click()
 await page.screenshot({path:path.join(out,'P-warning-small.png')})
 assert.equal(await page.locator('dialog').evaluate(d=>d.scrollWidth<=d.clientWidth),true)
 await page.keyboard.press('Escape')
 await page.locator('dialog').waitFor({state:'detached'})
 await page.evaluate(()=>{fixture.pending=true;fixture.delay=0})
 await page.locator('[data-reset-kind="P"]').click()
 assert.equal(await page.locator('dialog h2').textContent(),'Finish the previous purchase reset?')
 assert.match(await page.locator('#ledger-reset-description').textContent(),/already confirmed.*Purchases added afterwards will stay/)
 await page.screenshot({path:path.join(out,'P-resume-small.png')})
 await page.keyboard.press('Escape')
 await page.locator('dialog').waitFor({state:'detached'})
 assert.match(await page.locator('[data-ledger-reset-status]').textContent(),/still unfinished/)
 await page.locator('[data-reset-kind="P"]').click()
 await page.locator('[data-reset-confirm]').click()
 await page.locator('dialog').waitFor({state:'detached'})
 assert.equal(await page.evaluate(()=>fixture.refreshed.length),2)
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({ok:true,cases:9,output:out,nativeProfile:false}))
} finally {await browser?.close();await server.close()}
