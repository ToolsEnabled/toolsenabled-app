import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, stop } from 'esbuild'
import { chromium, devices } from 'playwright'
import { createServer } from 'vite'
import sterile from '../lib/sterile-launch.cjs'
import { fenceGeometryContext } from '../lib/qa-candidate-browser.mjs'
import processTree from '../process-tree.cjs'

// Source renderer proof only. Actual Computers, buildChat, tree/transcript
// stores, application chrome, fonts and CSS. Only host data/bridges are inert.
// No copied chat markup, viewport-derived rail dimensions or geometry overrides.
const app = fileURLToPath(new URL('../../', import.meta.url))
const origin = 'https://rail-layout.test'
const computerId = 'rail-proof-computer'
const nodeId = 'rail-proof-manager'
const sizes = [[1440, 900], [1280, 800], [1100, 800], [1024, 768], [800, 900]]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// Full application source, actual navigation/collapse/phone controllers and
// built-in labelled example records. No invented native bridge or account proof.
const presentationCells = ['white', 'tan', 'black', 'ember', 'cobalt'].flatMap(theme => [1, 1.5].flatMap(zoom => [
  { width: 1440, height: 900, layout: 'side' },
  { width: 1280, height: 800, layout: 'side' },
  { width: 390, height: 844, layout: 'top' },
  { width: 390, height: 844, layout: 'collapsed-side' },
  { width: 390, height: 844, mobile: true, layout: 'phone' },
].map(cell => ({ ...cell, theme, zoom,
  name: `${theme}-${cell.width}x${cell.height}-z${zoom * 100}-${cell.layout}` }))))

async function presentationMatrix(inspect) {
  const profile = await mkdtemp(join(tmpdir(), 'computers-presentation-'))
  const observations = [], blocked = [], errors = []
  const server = await createServer({ root: app, configFile: false, cacheDir: join(profile, 'vite-cache'),
    optimizeDeps: { entries: [join(app, 'index.html')] }, server: { host: '127.0.0.1', port: 0, strictPort: false } })
  let browser
  console.log('COMPUTERS_PRESENTATION_PROFILE', profile)
  try {
    await server.listen()
    const origin = new URL(server.resolvedUrls.local[0]).origin
    browser = await chromium.launch({ headless: true,
      ...(process.env.HOME_PANEL_BROWSER ? { executablePath: process.env.HOME_PANEL_BROWSER } : {}) })
    // Optional targeted mutation invocation declares its subset in the output;
    // an ordinary acceptance run always visits all50 source cells.
    const selected = process.env.COMPUTERS_PRESENTATION_CELL
      ? presentationCells.filter(cell => cell.name === process.env.COMPUTERS_PRESENTATION_CELL) : presentationCells
    assert.ok(selected.length > 0, 'the declared source cell must exist')
    console.log('COMPUTERS_PRESENTATION_BOUND', JSON.stringify({ all: presentationCells.length, selected: selected.length,
      selection: process.env.COMPUTERS_PRESENTATION_CELL || 'all50', desktop: selected.filter(cell => !cell.mobile).length,
      phone: selected.filter(cell => cell.mobile).length }))
    for (const cell of selected) {
      const context = await browser.newContext({ ...(cell.mobile ? devices['iPhone 13'] : { isMobile: false, hasTouch: false }),
        viewport: cell.mobile ? { width: cell.width, height: cell.height } : { width: 1440, height: 900 },
        serviceWorkers: 'block', reducedMotion: 'reduce' })
      const cellErrors = []
      try {
        await context.route('**/*', route => {
          const request = route.request(), url = new URL(request.url())
          if (url.origin !== origin || request.method() !== 'GET') {
            blocked.push({ method: request.method(), origin: url.origin, path: url.pathname }); return route.abort('blockedbyclient')
          }
          return route.continue()
        })
        await context.routeWebSocket(() => true, socket => socket.close())
        await context.addInitScript(cell => {
          localStorage.clear(); localStorage.setItem('mc.example', 'on'); localStorage.setItem('mc.theme', cell.theme)
          localStorage.setItem('mc.text', String(cell.zoom))
          localStorage.setItem('mc.set.feature_guides.v1', JSON.stringify({ version: 1, quiet: true, seen: {} }))
        }, cell)
        const page = await context.newPage()
        page.on('pageerror', error => cellErrors.push(error.message))
        await page.goto(origin + '/#/computers', { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await page.waitForFunction(() => document.body.dataset.route === 'computers'
          && !!document.querySelector('.static-tree-node'), null, { timeout: 25_000 })
        if (!cell.mobile) {
          await page.evaluate(async layout => {
            const { applyTextSize } = await import('/src/text-size.js'); applyTextSize(1)
            const { setNavigationPreview } = await import('/src/navigation-preview.js')
            setNavigationPreview(layout === 'top' ? 'top' : 'side')
          }, cell.layout)
          if (cell.layout === 'collapsed-side' && await page.evaluate(() => document.body.dataset.navigationCollapsed) !== 'true') {
            const collapse = page.locator('[data-navigation-collapse]'); await collapse.focus(); await collapse.press('Enter')
          }
          await page.setViewportSize({ width: cell.width, height: cell.height })
          await page.evaluate(async zoom => { const { applyTextSize } = await import('/src/text-size.js'); applyTextSize(zoom) }, cell.zoom)
        }
        await page.waitForFunction(() => document.querySelectorAll('#stage>.view .computers').length === 1, null, { timeout: 25_000 })
        await page.evaluate(() => document.fonts.ready)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const identity = await page.evaluate(() => ({ phone: document.documentElement.getAttribute('data-phone-canvas'),
          touch: navigator.maxTouchPoints, navigation: document.body.dataset.navigation,
          collapsed: document.body.dataset.navigationCollapsed, theme: document.documentElement.dataset.theme,
          zoom: Number(getComputedStyle(document.documentElement).getPropertyValue('--zoom') || 1), prefs: typeof window.mcPrefs }))
        assert.equal(identity.phone, cell.mobile ? 'on' : null, 'actual source phone decision must match the context')
        assert.equal(identity.touch > 0, Boolean(cell.mobile)); assert.equal(identity.prefs, 'undefined')
        assert.equal(identity.theme, cell.theme); assert.equal(identity.zoom, cell.zoom)
        if (!cell.mobile) assert.equal(identity.navigation, cell.layout === 'top' ? 'top' : 'side')
        if (cell.layout === 'collapsed-side') assert.equal(identity.collapsed, 'true')
        const value = await inspect(page, cell)
        observations.push({ cell, identity, value })
        console.log('COMPUTERS_PRESENTATION_VALUE', JSON.stringify(observations.at(-1)))
        assert.deepEqual(cellErrors, [], cell.name + ': source renderer error')
      } finally { errors.push(...cellErrors); await context.close() }
    }
  } finally {
    await browser?.close(); await server.close()
    await writeFile(join(profile, 'observations.json'), JSON.stringify({ observations, blocked, errors, closed: true }, null, 2) + '\n')
    console.log('COMPUTERS_PRESENTATION_CLOSED', JSON.stringify({ profile, observed: observations.length, closed: true }))
  }
}

async function wheelReach(page, control, label) {
  const inspect = () => control.evaluate(el => {
    const r = el.getBoundingClientRect()
    let left = Math.max(0, r.left), right = Math.min(innerWidth, r.right), top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom)
    let scrollBox
    const clips = []
    const modal = el.closest('dialog:modal')
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const s = getComputedStyle(parent), box = parent.getBoundingClientRect()
      if (s.overflowX !== 'visible') { left = Math.max(left, box.left); right = Math.min(right, box.right) }
      if (s.overflowY !== 'visible') { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom) }
      if (!scrollBox && /auto|scroll/.test(s.overflowY) && parent.scrollHeight > parent.clientHeight) scrollBox = box
      if (s.overflowY !== 'visible') clips.push({ className: parent.className, top: box.top, bottom: box.bottom, overflow: s.overflowY, scrollHeight: parent.scrollHeight, clientHeight: parent.clientHeight })
      // showModal promotes this actual dialog to the top layer; DOM parents
      // above it do not clip it. Its own clip and viewport still apply.
      if (parent === modal) break
    }
    const x = (left + right) / 2, y = (top + bottom) / 2, hit = document.elementFromPoint(x, y)
    return { width: r.width, height: r.height, visibleWidth: Math.max(0, right-left), visibleHeight: Math.max(0, bottom-top),
      hit: hit === el || el.contains(hit), direction: r.top < top ? -1 : 1, clips, nativeModal: Boolean(modal),
      delta: Math.max(8, Math.min(120, (r.top < top ? top-r.top : r.bottom-bottom) / Number(getComputedStyle(document.documentElement).getPropertyValue('--zoom') || 1))),
      pointerX: Math.max(1, Math.min(innerWidth-2, scrollBox ? (scrollBox.left+scrollBox.right)/2 : (el.closest('.computers,dialog')?.getBoundingClientRect().right || innerWidth)-6)),
      pointerY: scrollBox ? Math.max(1, Math.min(innerHeight-2, (Math.max(0,scrollBox.top)+Math.min(innerHeight,scrollBox.bottom))/2)) : r.top < top ? 100 : innerHeight-30 }
  })
  let value = await inspect()
  for (let attempt = 0; attempt < 20 && (!value.hit || value.visibleWidth < value.width-1 || value.visibleHeight < value.height-1); attempt++) {
    await page.mouse.move(value.pointerX, value.pointerY); await page.mouse.wheel(0, value.direction * value.delta)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    value = await inspect()
  }
  console.log('COMPUTERS_CONTROL_REACH_BEFORE_ASSERT', JSON.stringify({ label, value }))
  assert.equal(value.hit, true, label + ': actual control hit point is unreachable through product scrolling')
  assert.ok(value.visibleWidth >= value.width-1 && value.visibleHeight >= value.height-1, label + ': actual control is clipped')
  return value
}

async function paintContrast(locator, property = 'color') {
  return locator.evaluate((node, property) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const rgb = color => { ctx.clearRect(0,0,1,1); ctx.fillStyle = color; ctx.fillRect(0,0,1,1); const value = [...ctx.getImageData(0,0,1,1).data]; return [...value.slice(0,3), value[3]/255] }
    const over = (front, back) => front.slice(0,3).map((v,i) => v*front[3]+back[i]*(1-front[3]))
    const luminance = color => color.slice(0,3).map(v => v/255).map(v => v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0)
    const layers = []; for (let p=node;p;p=p.parentElement) layers.unshift(getComputedStyle(p).backgroundColor)
    const background = layers.reduce((back,color)=>over(rgb(color),back),[255,255,255])
    const style=getComputedStyle(node), foreground=rgb(style[property]), rendered=over(foreground,background)
    const a=luminance(rendered),b=luminance(background), token=rgb(style.getPropertyValue('--ink-3').trim())
    return { property, foreground, background, layers, ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),
      secondaryToken:token, isSecondary:foreground.every((v,i)=>Math.abs(v-token[i])<1), text:node.textContent.trim() }
  },property)
}

test('Computers actual source toolbar uses one small tier and every visible control stays reachable', { timeout: 900_000 }, async () => {
  await presentationMatrix(async (page, cell) => {
    if (cell.mobile) {
      const row = page.locator('.phone-ledger-press').first()
      await row.waitFor(); await row.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab')
      assert.equal(await row.evaluate(node => document.activeElement === node), true, 'phone row must be keyboard reachable')
      const reach = await wheelReach(page, row, cell.name + ': actual phone agent row')
      return { scope: 'automatic-phone row preservation; desktop toolbar tier is inapplicable', reach }
    }
    const controls = page.locator('.tree-action-bar button,.tree-action-bar select')
    const values = []
    for (let index = 0; index < await controls.count(); index++) {
      const control = controls.nth(index)
      if (!await control.isVisible()) continue
      const value = await control.evaluate(node => {
        const s = getComputedStyle(node), r = node.getBoundingClientRect()
        return { label: node.getAttribute('aria-label') || node.textContent.trim(), tag: node.tagName,
          height: s.height, fontSize: s.fontSize, fontWeight: s.fontWeight,
          paintedHeight: r.height, disabled: node.disabled || node.getAttribute('aria-disabled') === 'true' }
      })
      console.log('COMPUTERS_TOOLBAR_BEFORE_ASSERT', JSON.stringify({ cell, value }))
      assert.equal(value.height, '28px', value.label + ': Computers toolbar must use the small 28px tier')
      assert.ok(Math.abs(value.paintedHeight-28*cell.zoom) < .2, value.label + ': toolbar height must follow actual text zoom')
      assert.equal(value.fontSize, '13.5px', value.label + ': toolbar text must retain the same readable type at narrow widths')
      assert.equal(value.fontWeight, '550')
      value.reach = await wheelReach(page, control, cell.name + ': ' + value.label)
      if (!value.disabled) {
        await control.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab')
        const focus = await control.evaluate(node => ({ active: document.activeElement === node, visible: node.matches(':focus-visible'),
          style: getComputedStyle(node).outlineStyle, width: getComputedStyle(node).outlineWidth, offset: getComputedStyle(node).outlineOffset }))
        assert.equal(focus.active, true, value.label + ': actual Tab must return to the control')
        assert.equal(focus.visible, true); assert.equal(focus.style, 'solid'); assert.equal(focus.width, '2px'); assert.equal(focus.offset, '2px')
        value.focus = focus
      }
      values.push(value)
    }
    assert.equal(values.filter(value => value.tag === 'SELECT').length, 2, 'both actual shape/card-size selects must stay visible')
    assert.ok(values.filter(value => value.tag === 'BUTTON').length >= 5, 'the actual zoom/fleet/link/workspace controls must stay visible')
    assert.equal(new Set(values.map(value => value.paintedHeight)).size, 1, 'all controls in the toolbar share one rendered height')
    return { scope: 'desktop/no-touch actual toolbar', values }
  })
})

test('Computers actual source conversation keeps painted title clear of Back to trees and keyboard return works', { timeout: 900_000 }, async () => {
  await presentationMatrix(async (page, cell) => {
    let chat, header
    if (cell.mobile) {
      const row = page.locator('.phone-ledger-press').first(); await row.waitFor()
      await row.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab')
      assert.equal(await row.evaluate(node => document.activeElement === node), true, 'phone conversation opener must be keyboard reachable')
      await wheelReach(page, row, cell.name + ': phone conversation opener'); await row.press('Enter')
      await page.locator('.phone-sheet.is-up').waitFor()
      chat = page.locator('.phone-sheet .chat[data-chat-panel]')
      await chat.waitFor()
      header = { scope: 'automatic-phone sheet; desktop Back to trees is not this surface' }
    } else {
      // Use the production existing-agent chooser: no New-agent/Start action,
      // fake graph/controller object, attribute state or forced node click.
      const add = page.locator('.tree-chat-add').first()
      await wheelReach(page, add, cell.name + ': existing-agent chooser opener'); await add.focus(); await add.press('Enter')
      const option = page.locator('.tree-chat-chooser:not([hidden]) .tree-chat-options button').first()
      await option.waitFor(); await option.focus(); await option.press('Enter')
      await page.locator('.tree-workspace-chat:not([hidden])').waitFor()
      const back = page.locator('.tree-workspace-chat:not([hidden]) .tree-preview-close')
      await wheelReach(page, back, cell.name + ': Back to trees')
      header = await page.locator('.tree-workspace-chat:not([hidden]) .tree-workspace-chat-header').evaluate(head => {
        const box = r => ({ left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height })
        const title = head.querySelector('.tree-chat-heading'), back = head.querySelector('.tree-preview-close')
        const range = document.createRange(); range.selectNodeContents(title)
        const words = [...range.getClientRects()].filter(r => r.width>0 && r.height>0).map(box)
        const b = back.getBoundingClientRect(), h = head.getBoundingClientRect()
        const area = a => Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top))
        return { title:title.textContent, paintedTitle:words, back:box(b), head:box(h), paintedIntersection:words.reduce((sum,r)=>sum+area(r),0) }
      })
      console.log('COMPUTERS_CHAT_HEADER_BEFORE_ASSERT', JSON.stringify({ cell, header }))
      assert.ok(header.title.length>0 && header.paintedTitle.length>0, 'the actual chosen agent must remain named')
      assert.equal(header.paintedIntersection, 0, 'painted conversation title intersects Back to trees')
      for(const rect of header.paintedTitle) assert.ok(rect.left>=header.head.left-1 && rect.right<=header.head.right+1, 'painted conversation title is clipped')
      chat = page.locator('.tree-workspace-chat:not([hidden]) .chat[data-chat-panel]')
      await chat.waitFor()
    }
    const disclosure = await chat.locator('.chat-ai-disclosure').evaluate(node => {
      const r=node.getBoundingClientRect(),log=node.closest('.chat').querySelector('.chat-log')
      return { text:node.textContent, visible:r.width>0&&r.height>0, beforeTranscript:Boolean(node.compareDocumentPosition(log)&Node.DOCUMENT_POSITION_FOLLOWING) }
    })
    assert.equal(disclosure.visible,true); assert.equal(disclosure.beforeTranscript,true); assert.ok(disclosure.text.includes('AI'))
    disclosure.paint = await paintContrast(chat.locator('.chat-ai-disclosure'))
    assert.equal(disclosure.paint.isSecondary, true, 'the real AI disclosure must use the actual secondary token')
    assert.ok(disclosure.paint.ratio >= 4.6, 'the real AI disclosure must stay readable on its actual surface')
    const presentation = await chat.evaluate(node => {
      const style = selector => { const el=node.querySelector(selector); if(!el)return null; const s=getComputedStyle(el);return {fontSize:s.fontSize,borderRadius:s.borderRadius,borderColor:s.borderTopColor,textAlign:s.textAlign,height:s.height,disabled:el.disabled} }
      return { disclosure:style('.chat-ai-disclosure'), composer:style('.chat-compose-surface'), input:style('.chat-input textarea'), message:style('.msg.them'), send:style('.chat-send') }
    })
    console.log('COMPUTERS_CHAT_PRESENTATION_BEFORE_ASSERT',JSON.stringify({cell,presentation,paint:disclosure.paint}))
    assert.equal(presentation.disclosure.textAlign,'center')
    assert.equal(presentation.composer?.borderRadius,'3px','actual chat composer keeps the owner\'s corners')
    assert.equal(presentation.input?.fontSize,'14.5px','actual composer retains readable body type')
    if(presentation.message) assert.equal(presentation.message.fontSize,'14.5px','actual agent output retains readable body type')
    const composerEdge = await paintContrast(chat.locator('.chat-compose-surface'),'borderTopColor')
    assert.ok(composerEdge.ratio>=3,'the actual composer field edge must be identifiable')
    if (cell.mobile) {
      await page.keyboard.press('Escape'); await page.locator('.phone-sheet.is-up').waitFor({state:'hidden'})
      assert.equal(await page.locator('.phone-ledger-press').first().evaluate(node => document.activeElement===node),true,'phone sheet must return keyboard focus to the real opener')
    } else {
      const back=page.locator('.tree-workspace-chat:not([hidden]) .tree-preview-close')
      await back.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab')
      const focus=await back.evaluate(node=>({active:document.activeElement===node,visible:node.matches(':focus-visible'),
        width:getComputedStyle(node).outlineWidth,style:getComputedStyle(node).outlineStyle,offset:getComputedStyle(node).outlineOffset}))
      assert.equal(focus.active,true);assert.equal(focus.visible,true);assert.equal(focus.width,'2px');assert.equal(focus.style,'solid');assert.equal(focus.offset,'2px')
      header.focus=focus
      await page.keyboard.press('Enter');await page.locator('.tree-workspace-chat:not([hidden])').waitFor({state:'hidden'})
      assert.equal(await page.locator('.tree-home-tab').first().getAttribute('aria-selected'),'true','real Back to trees must return to the existing tree tab')
    }
    return {header,disclosure,presentation,composerEdge}
  })
})

test('Computers actual source cards retain identity and keyboard centring reaches painted name and controls', { timeout: 900_000 }, async () => {
  await presentationMatrix(async (page,cell) => {
    if(cell.mobile) return {scope:'automatic-phone list; desktop card shape and keyboard canvas are inapplicable'}
    const shape=page.locator('.tree-shape-select'), size=page.locator('.tree-card-size-select')
    await shape.selectOption('boxes'); await size.selectOption('medium')
    const node=page.locator('.static-tree-graph[data-node-style="boxes"] .tree-agent-box').first()
    await node.waitFor(); const identity=await node.getAttribute('data-agent-id')
    await node.focus();await page.keyboard.press('f')
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    const card=await node.evaluate(el=>{
      const s=getComputedStyle(el.querySelector('.node-glass')),name=el.querySelector('.node-name .nn-t'),role=el.querySelector('.node-role'),context=el.querySelector('.tree-box-context p')
      const scale=Number(getComputedStyle(el).getPropertyValue('--tree-box-text-scale')||1),range=document.createRange();range.selectNodeContents(name)
      const host=el.closest('.static-tree-host').getBoundingClientRect(),painted=[...range.getClientRects()].filter(r=>r.width&&r.height).map(r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom}))
      const buttons=[...el.querySelectorAll('.tree-box-actions button')].filter(b=>b.getBoundingClientRect().width).map(b=>({label:b.getAttribute('aria-label')||b.title,width:getComputedStyle(b).width,height:getComputedStyle(b).height}))
      return {id:el.dataset.agentId,name:name.textContent,status:el.dataset.status,scale,border:s.borderLeftWidth,top:s.borderTopWidth,radius:s.borderRadius,backgroundImage:s.backgroundImage,
        nameFont:getComputedStyle(name).fontSize,roleText:role.textContent,roleTransform:getComputedStyle(role).textTransform,contextFont:context?getComputedStyle(context).fontSize:null,buttons,painted,
        host:{left:host.left,right:host.right,top:host.top,bottom:host.bottom}}
    })
    console.log('COMPUTERS_CARD_BEFORE_ASSERT',JSON.stringify({cell,card}))
    assert.equal(card.id,identity);assert.ok(card.name&&card.roleText);assert.ok(card.painted.length)
    // Chromium resolves fractional zoomed borders to whole physical pixels.
    // Preserve the 1px/3px authored tiers, including their actual raster floor.
    assert.ok(Math.abs(parseFloat(card.border)-Math.floor(cell.zoom)/cell.zoom)<.0001)
    assert.ok(Math.abs(parseFloat(card.top)-Math.floor(3*cell.zoom)/cell.zoom)<.0001)
    assert.equal(card.radius,'10px');assert.equal(card.backgroundImage,'none')
    assert.ok(Math.abs(parseFloat(card.nameFont)-14*card.scale)<.05);assert.equal(card.roleTransform,'none')
    if(card.contextFont) assert.ok(Math.abs(parseFloat(card.contextFont)-13.5*card.scale)<.05)
    for(const button of card.buttons){assert.equal(button.width,'28px');assert.equal(button.height,'28px')}
    for(const rect of card.painted) assert.ok(rect.left>=Math.max(0,card.host.left)-1&&rect.right<=Math.min(cell.width,card.host.right)+1&&rect.top>=Math.max(0,card.host.top)-1&&rect.bottom<=Math.min(cell.height,card.host.bottom)+1,'actual F keyboard centring must expose painted agent name')
    const rolePaint=await paintContrast(node.locator('.node-role'));assert.ok(rolePaint.ratio>=4.5,'actual node role text must be readable')
    await node.press('Shift+Enter');await page.locator('.ctl-page.is-active').waitFor()
    const chatTab=page.locator('.ctl-page.is-active [data-rail-tab="chat"]')
    await chatTab.focus();await chatTab.press('Enter')
    const railChat=page.locator('.ctl-page.is-active [data-rail-chat-host] .chat[data-chat-panel]')
    await railChat.waitFor();assert.ok(await railChat.locator('.chat-ai-disclosure').isVisible(),'the real Chat tab retains its AI disclosure')
    // This tree-node rail does not offer the old registry-agent Full chat
    // button or a buildChat onExpand callback. The actual node Enter opens it.
    await node.focus();await node.press('Enter');await page.locator('.tree-workspace-chat:not([hidden])').waitFor()
    return {scope:'actual Boxes/medium card, F centre, ShiftEnter details, real rail Chat tab and node Enter full conversation',card,rolePaint}
  })
})

test('Computers actual source account menu stays inside viewport and closes with keyboard focus restored', { timeout: 900_000 }, async () => {
  await presentationMatrix(async(page,cell)=>{
    const trigger=page.locator('.computers .acct-trigger')
    if(!await trigger.isVisible()) return {scope:'actual account trigger hidden in this source controller state; menu unobserved'}
    await wheelReach(page,trigger,cell.name+': Accounts opener');await trigger.focus();await trigger.press('Enter')
    const menu=page.locator('dialog.acct-menu[open]');await menu.waitFor()
    assert.equal(await menu.evaluate(el=>el.open && el.matches(':modal')),true,'the real Accounts trigger must use native showModal')
    const value=await menu.evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,radius:s.borderRadius,title:el.querySelector('h3').textContent,route:document.body.dataset.route}})
    console.log('COMPUTERS_ACCOUNTS_BEFORE_ASSERT',JSON.stringify({cell,value}))
    assert.equal(value.route,'computers');assert.ok(value.title)
    assert.ok(value.left>=-1&&value.right<=cell.width+1&&value.top>=-1&&value.bottom<=cell.height+1,'actual reachable Accounts dialog must stay in the viewport')
    assert.equal(value.radius,'14px')
    const close=menu.locator('[data-acct="close"]');await wheelReach(page,close,cell.name+': Accounts Close')
    await close.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab')
    assert.equal(await close.evaluate(el=>document.activeElement===el),true,'actual Tab must return to Accounts Close')
    const focus=await close.evaluate(el=>{const s=getComputedStyle(el);return {width:s.outlineWidth,style:s.outlineStyle,offset:s.outlineOffset}})
    assert.deepEqual(focus,{width:'2px',style:'solid',offset:'2px'})
    const titlePaint=await paintContrast(menu.locator('h3'));assert.ok(titlePaint.ratio>=4.5)
    const backdrop=await menu.evaluate(el=>{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1
      const ctx=canvas.getContext('2d',{willReadFrequently:true})
      const rgba=value=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]}
      const rootToken=getComputedStyle(document.documentElement).getPropertyValue('--bg-backdrop').trim()
      const computed=getComputedStyle(el,'::backdrop').backgroundColor
      return {rootToken,rootRGBA:rgba(rootToken),computed,backdropRGBA:rgba(computed)}
    })
    console.log('COMPUTERS_ACCOUNTS_BACKDROP_BEFORE_ASSERT',JSON.stringify({cell,backdrop}))
    if(process.env.COMPUTERS_PRESENTATION_CAPTURE) await page.screenshot({path:process.env.COMPUTERS_PRESENTATION_CAPTURE,animations:'disabled'})
    assert.deepEqual(backdrop.backdropRGBA,backdrop.rootRGBA,cell.name+': actual Accounts backdrop must match the resolved root token')
    await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'})
    assert.equal(await trigger.evaluate(el=>document.activeElement===el),true,'actual Accounts Escape must restore the real opener')
    return {scope:'built-in labelled source Accounts menu; native sign-in/allowance read/write inapplicable',value,focus,titlePaint,backdrop}
  })
})

test('Computers actual source new-agent panel retains provider model refusals and reachable Cancel', { timeout: 900_000 }, async () => {
  await presentationMatrix(async(page,cell)=>{
    let opener
    if(cell.mobile){
      opener=page.locator('.phone-ledger-add').first();await opener.waitFor()
      await opener.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab')
    } else {
      await page.locator('.tree-shape-select').selectOption('boxes')
      const node=page.locator('.static-tree-graph[data-node-style="boxes"] .tree-agent-box').first()
      await node.focus();await node.press('f')
      opener=node.locator('.tree-box-add-agent');await opener.focus()
    }
    await opener.press('Enter')
    const panel=page.locator('.agent-compose[data-agent-compose="open"]');await panel.waitFor()
    const fields=await panel.locator('[data-compose-field]').evaluateAll(nodes=>nodes.filter(el=>el.getBoundingClientRect().width).map(el=>({
      key:el.getAttribute('data-compose-field'),disabled:el.disabled,value:el.value,
      options:el.tagName==='SELECT'?[...el.options].map(o=>({value:o.value,label:o.textContent,disabled:o.disabled})):undefined,
      font:getComputedStyle(el).fontSize,height:getComputedStyle(el).height,border:getComputedStyle(el).borderTopColor })))
    const keys=fields.map(f=>f.key)
    assert.ok(keys.includes('role')&&keys.includes('provider')&&keys.includes('tier')&&keys.includes('effort'),'the actual provider/model/role/effort controls must remain')
    const notice=await panel.locator('.agent-compose-notice:not([hidden])').textContent()
    assert.ok(notice.trim(),'the labelled example must retain its real start refusal')
    assert.ok(fields.every(field=>field.disabled),'example fields must not become live start controls')
    const fieldPaint=await paintContrast(panel.locator('[data-compose-field="provider"]'),'borderTopColor')
    assert.ok(fieldPaint.ratio>=3,'actual new-agent field edge must remain identifiable')
    const cancel=panel.locator('[data-compose-action="cancel"]')
    await cancel.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab')
    assert.equal(await cancel.evaluate(el=>document.activeElement===el),true,'Cancel must remain keyboard reachable in the refused source example')
    const reach=await wheelReach(page,cancel,cell.name+': New-agent Cancel')
    const focus=await cancel.evaluate(el=>{const s=getComputedStyle(el);return {width:s.outlineWidth,style:s.outlineStyle,offset:s.outlineOffset}})
    assert.deepEqual(focus,{width:'2px',style:'solid',offset:'2px'})
    await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'})
    return {scope:'actual labelled example New-agent panel; live/native Start deliberately refused',fields,notice,fieldPaint,reach,focus}
  })
})
const entry = `
import { computersView } from './src/views/computers.js'
import { fleetTreesStorageKey } from './src/fleet-trees.js'
import { createTranscriptStore } from './src/session-transcript-store.js'
import { mountAppNavigation } from './src/app-navigation.js'
const computerId = ${JSON.stringify(computerId)}, nodeId = ${JSON.stringify(nodeId)}
const stamp = new Date().toISOString()
window.proofUnexpectedWrites = []
const refuseWrite = name => async () => {
  window.proofUnexpectedWrites.push(name)
  return { ok: false, code: 'RAIL_PROOF_HOST_WRITE_REFUSED', message: 'This source fixture starts and sends nothing.' }
}
window.mcShell = { getBridgeProof: async () => ({ ok: true, proof: 'fixture' }), getBridgeTransport: async () => null }
window.mcAgent = {
  sessionPresence: async () => ({ ok: true, sessionIds: [] }),
  start: refuseWrite('start'), send: refuseWrite('send'), close: refuseWrite('close'),
}
localStorage.setItem(fleetTreesStorageKey(computerId), JSON.stringify({
  version: 1, computerId,
  trees: [{ id: 'rail-proof-tree', name: 'Rail proof', createdAt: stamp, updatedAt: stamp, profileId: null }],
  nodes: [{ id: nodeId, treeId: 'rail-proof-tree', status: 'finished', createdAt: stamp, updatedAt: stamp,
    role: 'manager', name: 'Manager', message: 'Review the saved conversation.', statusNote: '',
    sessionId: 'rail-proof-ended-session', parentId: null }],
}))
const transcripts = createTranscriptStore({ computerId, storage: {
  read: key => localStorage.getItem(key),
  write: (key, value) => { localStorage.setItem(key, JSON.stringify(value)); return true },
}})
const lines = Array.from({ length: 6 }, (_, i) => ({ who: i % 2 ? 'agent' : 'you',
  text: 'Saved message ' + (i + 1) + ': this conversation remains readable after the session has finished.',
  at: Date.now() + i }))
if (!transcripts.save(nodeId, { lines })) throw new Error('Rail fixture transcript was not saved')
document.documentElement.dataset.theme = 'white'
const navigation = mountAppNavigation()
const view = computersView({ initialComputer: computerId, navigate() {} })
const wrap = document.createElement('div')
wrap.className = 'view'
wrap.append(view.el)
document.querySelector('#stage').append(wrap)
window.closeRailProof = () => { view.destroy?.(); navigation.destroy(); wrap.remove() }
`

async function bundleFixture(profile) {
  // Keep all side-effect font/CSS imports in main.js order. Imported view CSS
  // comes from computersView itself; the production sheets resolve cascade.
  const main = await readFile(join(app, 'src/main.js'), 'utf8')
  const imports = [...main.matchAll(/^import\s+['"]([^'"]+)['"]\s*;?\s*$/gm)]
    .map(match => match[1]).filter(name => name.endsWith('.css') || name.startsWith('@fontsource'))
  const beforeViews = imports.findIndex(name => name === './morphs.css')
  assert.ok(beforeViews >= 0, 'could not locate the production post-view stylesheet boundary')
  const asImports = values => values.map(name => `import ${JSON.stringify(name.startsWith('.') ? './src/' + name.slice(2) : name)}`).join('\n')
  const result = await build({ stdin: { contents: asImports(imports.slice(0, beforeViews)) + '\n' + entry + '\n' + asImports(imports.slice(beforeViews)), resolveDir: app, sourcefile: 'rail-proof.js' },
    absWorkingDir: app, bundle: true, write: false, metafile: true, platform: 'browser', format: 'iife', logLevel: 'silent',
    outdir: join(profile, 'bundle'), loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, assetNames: '[name]-[hash]' })
  stop()
  const inputs = {}
  for (const name of Object.keys(result.metafile.inputs)) {
    if (name === 'rail-proof.js') continue
    const file = resolve(app, name)
    inputs[name] = sha(await readFile(file))
  }
  inputs['index.html'] = sha(await readFile(join(app, 'index.html')))
  inputs['tools/test/rail-chat-real-layout.test.mjs'] = sha(await readFile(fileURLToPath(import.meta.url)))
  const assets = new Map()
  for (const output of result.outputFiles) {
    const name = relative(join(profile, 'bundle'), output.path).replaceAll('\\', '/')
    assets.set('/' + name, Buffer.from(output.contents))
  }
  let html = await readFile(join(app, 'index.html'), 'utf8')
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  const script = [...assets.keys()].find(name => name.endsWith('.js'))
  const style = [...assets.keys()].find(name => name.endsWith('.css'))
  assert.ok(script && style, 'renderer bundle must include script and stylesheet')
  html = html.replace('</head>', `<link rel="stylesheet" href="${style}"></head>`)
    .replace('</body>', `<script src="${script}"></script></body>`)
  assets.set('/', Buffer.from(html))
  await writeFile(join(profile, 'inputs.json'), JSON.stringify({ inputs, generatedEntry: sha(entry) }, null, 2))
  return assets
}

test('Computers saved rail keeps a readable conversation and reachable controls at five laptop sizes', { timeout: 45_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'rail-real-layout-'))
  console.log('RETAINED_RAIL_LAYOUT_PROFILE ' + profile)
  let context, contextClosed = false, watch
  const observed = new Set(), errors = [], measurements = []
  const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
  try {
    const assets = await bundleFixture(profile)
    const stamp = new Date().toISOString()
    const fleet = { schemaVersion: 1, domain: 'fleet', generatedAt: stamp, ok: true, reason: null, sources: [], data: {
      computers: [{ id: computerId, label: 'This computer', sourceKind: 'observed', observedAt: stamp, activeSessions: 0, services: [] }],
      graph: { revision: 1, contentHash: '0'.repeat(64), nodes: [{ id: 'fixture-seat', label: 'Seat', role: 'builder', provider: 'claude', enabled: true }], edges: [] },
    } }
    assets.set('/data/fleet.json', Buffer.from(JSON.stringify(fleet)))
    assets.set('/data/schema/fleet.schema.json', await readFile(join(app, 'public/data/schema/fleet.schema.json')))
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|OS|DISPLAY|XAUTHORITY|LANG|LC_ALL)$/i.test(key)))
    const env = sterile.sterileLaunchEnvironment(sterile.prepareSterileProfile(sterile.sterileProfileDirectories(profile)), base)
    if (process.platform === 'linux') {
      env.XDG_RUNTIME_DIR = join(profile, 'runtime'); await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 })
      env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=' + join(profile, 'absent-session-bus')
      env.DBUS_SYSTEM_BUS_ADDRESS = 'unix:path=' + join(profile, 'absent-system-bus')
    }
    context = await chromium.launchPersistentContext(join(profile, 'browser'), { headless: true, chromiumSandbox: true,
      ...(process.env.HOME_PANEL_BROWSER ? { executablePath: process.env.HOME_PANEL_BROWSER } : {}),
      env, serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, timeout: 12_000 })
    context.on('close', () => { contextClosed = true })
    const snapshot = () => { for (const pid of processTree.descendantPids(process.pid)) observed.add(pid) }
    snapshot()
    watch = setInterval(() => { try { snapshot() } catch (error) { errors.push(error.message) } }, 1000)
    await fenceGeometryContext(context, { origin, staticPath: () => false })
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin !== origin || request.method() !== 'GET') return route.abort('blockedbyclient')
      const bytes = assets.get(url.pathname)
      if (!bytes) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Absent from isolated source fixture.' })
      const contentType = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css'
        : url.pathname.endsWith('.json') ? 'application/json' : /\.woff2?$/.test(url.pathname) ? 'font/woff2' : 'text/html'
      console.log('RAIL_FIXTURE_RESPONSE ' + JSON.stringify({ path: url.pathname, bytes: bytes.length, contentType }))
      return route.fulfill({ contentType, body: bytes })
    })
    const page = context.pages()[0]
    assert.equal(context.pages().length, 1, 'one browser page only')
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(5000)
    await page.goto(origin + '/#/computers/' + computerId, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => document.fonts.ready)
    const node = page.locator('.static-tree-node[data-agent-id="' + nodeId + '"]')
    await node.waitFor({ state: 'visible' })
    await node.focus()
    await node.press('Shift+Enter')
    const host = page.locator('.ctl-page.board-page .rail-chat-host')
    await host.locator('.chat-log').waitFor({ state: 'visible' })
    assert.equal(await host.locator('.msg').count(), 6, 'fixture must show the six retained messages')
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const row = await host.evaluate(host => {
        const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
        const rail = host.closest('.rail'), log = host.querySelector('.chat-log')
        const chips = [...host.querySelectorAll('.chat-chips button, .chat-chips select, [data-chat-chip]')]
          .filter(el => el.getBoundingClientRect().width && !el.closest('[hidden]'))
        const h = host.getBoundingClientRect()
        return { viewport: [innerWidth, innerHeight], log: rect(log), rail: rect(rail),
          header: rect(host.querySelector('.chat-head')), chips: chips.map(el => ({ text: el.textContent.trim(), ...rect(el) })),
          chipOverflow: chips.some(el => { const b = el.getBoundingClientRect(); return b.left < h.left - 1 || b.right > h.right + 1 }) }
      })
      assert.ok(row.chips.length >= 3, 'the real chip row must be present before measuring overflow')
      // Scroll through product ancestors; an offscreen bounding box alone
      // does not establish that a person can reach the conversation/composer.
      const controls = [host.locator('.chat-log'), host.locator('.chat-input input, .chat-input textarea').first()]
      const chips = host.locator('.chat-chips button, .chat-chips select, [data-chat-chip]')
      for (let i = 0; i < await chips.count(); i++) if (await chips.nth(i).isVisible()) controls.push(chips.nth(i))
      row.reachability = []
      for (const control of controls) {
        const inspect = () => control.evaluate(el => {
          const r = el.getBoundingClientRect()
          let top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom)
          for (let parent = el.parentElement; parent; parent = parent.parentElement) {
            if (getComputedStyle(parent).overflowY !== 'visible') {
              const box = parent.getBoundingClientRect()
              top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom)
            }
          }
          const x = r.left + r.width / 2, y = (top + bottom) / 2
          const hit = document.elementFromPoint(x, y)
          const body = el.closest('.rail-chat-body'), host = body.getBoundingClientRect(), rail = body.closest('.rail').getBoundingClientRect()
          const direction = r.top < top ? -1 : 1
          /* Where a person would put the wheel. While the page itself can still
             carry the control into the window (the rail stacks under the canvas
             on a narrow window), the rail's edge scrolls the page. Once the page
             is at its end, only the chat body's own scroll is left, and that
             takes the pointer over the chat. */
          let pageRoom = false
          for (let parent = body.closest('.rail')?.parentElement; parent; parent = parent.parentElement) {
            if (!/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) continue
            pageRoom = direction > 0 ? parent.scrollTop < parent.scrollHeight - parent.clientHeight - 1 : parent.scrollTop > 0
            if (pageRoom) break
          }
          const viewportClipped = (r.top < 0 || r.bottom > innerHeight) && pageRoom
          return { name: el.className, height: r.height, visibleHeight: Math.max(0, bottom - top),
            direction,
            pointerX: Math.max(1, Math.min(innerWidth - 2, viewportClipped ? rail.left + 2 : host.right - 12)),
            bodyScrollTop: body.scrollTop, bodyClientHeight: body.clientHeight, bodyScrollHeight: body.scrollHeight,
            pointerY: viewportClipped ? Math.max(80, Math.min(innerHeight - 20, r.top < 0 ? 80 : innerHeight - 20))
              : Math.max(1, Math.min(innerHeight - 2, r.top < top ? Math.max(0, host.top) + 3 : Math.min(innerHeight, host.bottom) - 3)),
            reachable: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && (hit === el || el.contains(hit)) }
        })
        let visible = await inspect()
        const required = value => value.name.split(' ').includes('chat-log') ? Math.min(150, value.height) : value.height
        // Use user wheel input. scrollIntoView can programmatically scroll
        // overflow:hidden ancestors that a person cannot scroll.
        for (let attempt = 0; attempt < 16 && (!visible.reachable || visible.visibleHeight < required(visible) - 1); attempt++) {
          await page.mouse.move(visible.pointerX, visible.pointerY)
          await page.mouse.wheel(0, visible.direction * 180)
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          visible = await inspect()
        }
        row.reachability.push(visible)
        if (!visible.reachable || visible.visibleHeight < required(visible) - 1) console.log('RAIL_UNREACHABLE_CONTROL ' + JSON.stringify({ viewport: [width, height], ...visible }))
        assert.equal(visible.reachable, true, `${width}x${height}: ${visible.name} cannot be reached through product scrolling`)
        if (visible.name.split(' ').includes('chat-log')) {
          assert.ok(visible.visibleHeight >= Math.min(150, visible.height) - 1,
            `${width}x${height}: the reading window is clipped by a scroll ancestor`)
        } else assert.ok(visible.visibleHeight >= visible.height - 1, `${width}x${height}: composer control is clipped`)
      }
      measurements.push(row)
      console.log('RAIL_REAL_GEOMETRY ' + JSON.stringify(row))
    }
    assert.deepEqual(await page.evaluate(() => window.proofUnexpectedWrites), [], 'view must not start/send/close an agent')
    assert.deepEqual(errors, [], 'real mounted view raised a page error')
    assert.deepEqual(measurements.filter(row => row.log.height < 150 || row.chipOverflow), [], 'conversation must be at least 150px high without clipped chips')
    await page.evaluate(() => window.closeRailProof())
  } finally {
    stop()
    if (watch) clearInterval(watch)
    for (const pid of processTree.descendantPids(process.pid)) observed.add(pid)
    try { await context?.close() } finally {
      let remaining = [...observed].filter(alive)
      for (let attempt = 0; remaining.length && attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50)); remaining = [...observed].filter(alive)
      }
      const closure = { profile, contextCreated: Boolean(context), contextClosed, observed: [...observed], remaining }
      await writeFile(join(profile, 'closure.json'), JSON.stringify(closure, null, 2))
      await writeFile(join(profile, 'measurements.json'), JSON.stringify(measurements, null, 2))
      console.log('RAIL_REAL_BROWSER_CLOSURE ' + JSON.stringify(closure))
      console.log('RAIL_SOURCE_PAGE_ERRORS ' + JSON.stringify(errors))
      if (context) assert.equal(contextClosed, true, 'browser context did not close')
      assert.deepEqual(remaining, [], 'owned descendants remain after browser close')
    }
  }
})
