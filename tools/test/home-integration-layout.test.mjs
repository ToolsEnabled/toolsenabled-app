import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, devices } from 'playwright'

// Actual index/Main/Home/CSS and automatic phone decision, inert example data.
// Six Home hint cells, five phone preservation cells and eight explicit narrow
// navigation/theme/zoom cells. Each group declares its own bounded matrix.
// Browser emulation is not physical-phone or native-account acceptance.
const app = fileURLToPath(new URL('../../', import.meta.url))
const hint = 'Turn this off in Settings to see your own computer'

async function headerControlValues(page, zoom) {
  await page.locator('.home-overview-actions').scrollIntoViewIfNeeded()
  const controls = await page.locator('.home-overview-actions').evaluate(parent => {
    const box = rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height })
    return [...parent.querySelectorAll('a,button')].map(node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect()
      const range = document.createRange(); range.selectNodeContents(node)
      return { text: node.textContent.trim(), height: style.height, minHeight: style.minHeight,
        fontSize: style.fontSize, fontWeight: style.fontWeight, rect: box(rect), textRect: box(range.getBoundingClientRect()) }
    })
  })
  console.log('HOME_HEADER_CONTROL_BEFORE_ASSERT', JSON.stringify({ zoom, controls }))
  assert.deepEqual(controls.map(control => control.text), ['Open computers', 'New agent'])
  for (const control of controls) {
    assert.equal(control.height, '32px', control.text + ': Home header control must use the default 32px height')
    assert.equal(control.minHeight, '32px'); assert.equal(control.fontSize, '13.5px'); assert.equal(control.fontWeight, '550')
    assert.ok(control.rect.width > 0 && control.rect.height > 0, control.text + ': header control must be visible')
    assert.ok(Math.abs(control.rect.height - 32 * zoom) < .2, control.text + ': rendered height must follow actual text zoom')
    const middle = rect => (rect.top + rect.bottom) / 2
    assert.ok(Math.abs(middle(control.rect) - middle(control.textRect)) < 1.1, control.text + ': control text must remain vertically centered')
  }
  assert.equal(controls[0].rect.height, controls[1].rect.height, 'both Home header controls must have equal rendered height')
  return controls
}

async function sourceCases(cases, inspect) {
  const profile = await mkdtemp(join(tmpdir(), 'home-integration-layout-'))
  console.log('HOME_INTEGRATION_PROFILE', profile)
  const server = await createServer({ root: app, configFile: false,
    cacheDir: join(profile, 'vite-cache'), optimizeDeps: { entries: [join(app, 'index.html')] },
    server: { host: '127.0.0.1', port: 0, strictPort: false } })
  const measurements = []
  let browser
  try {
    await server.listen()
    const origin = new URL(server.resolvedUrls.local[0]).origin
    browser = await chromium.launch({ headless: true,
      ...(process.env.HOME_PANEL_BROWSER ? { executablePath: process.env.HOME_PANEL_BROWSER } : {}) })
    for (const { name, width, height, mobile = false, zoom = 1, theme = 'white', layout = null } of cases) {
      const context = await browser.newContext({ ...(mobile ? devices['iPhone 13'] : {}),
        viewport: layout ? { width: 1440, height: 900 } : { width, height },
        ...(layout ? { reducedMotion: 'reduce' } : {}), serviceWorkers: 'block' })
      const errors = []
      try {
        await context.route('**/*', route => {
          if (new URL(route.request().url()).origin !== origin || route.request().method() !== 'GET') return route.abort('blockedbyclient')
          return route.continue()
        })
        await context.routeWebSocket(() => true, socket => socket.close())
        await context.addInitScript(({ zoom, theme }) => {
          localStorage.clear()
          localStorage.setItem('mc.example', 'on')
          localStorage.setItem('mc.theme', theme)
          localStorage.setItem('mc.text', String(zoom))
          localStorage.setItem('mc.set.feature_guides.v1', JSON.stringify({ version: 1, quiet: true, seen: {} }))
        }, { zoom, theme })
        const page = await context.newPage()
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(origin + '/#/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await page.waitForFunction(() => document.body.dataset.route === 'home'
          && document.querySelector('.home')?.dataset.mode === 'sample', null, { timeout: 20_000 })
        if (layout) {
          // Match the capture driver: use the real preview and collapse key,
          // then resize and apply the actual text-size setting. No body flags.
          await page.evaluate(async layout => {
            const { applyTextSize } = await import('/src/text-size.js'); applyTextSize(1)
            const { setNavigationPreview } = await import('/src/navigation-preview.js')
            setNavigationPreview(layout === 'top' ? 'top' : 'side')
          }, layout)
          if (layout === 'collapsed-side' && await page.evaluate(() => document.body.dataset.navigationCollapsed) !== 'true') {
            const collapse = page.locator('[data-navigation-collapse]')
            await collapse.focus(); await collapse.press('Enter')
          }
          await page.setViewportSize({ width, height })
          await page.evaluate(async zoom => { const { applyTextSize } = await import('/src/text-size.js'); applyTextSize(zoom) }, zoom)
          await page.waitForFunction(() => {
            const homes = document.querySelectorAll('#stage > .view .home')
            return homes.length === 1 && homes[0].dataset.mode === 'sample'
          }, null, { timeout: 20_000 })
        }
        await page.evaluate(() => document.fonts.ready)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        assert.equal(await page.evaluate(() => typeof window.mcPrefs), 'undefined', 'source fixture must not use a native prefs bridge')
        const result = await inspect(page, { name, theme, zoom, layout, mobile })
        measurements.push({ name, width, height, mobileEmulation: mobile, zoom, theme, layout, result })
        console.log('HOME_INTEGRATION_VALUE', JSON.stringify(measurements.at(-1)))
        assert.deepEqual(errors, [], name + ': actual source renderer raised an error')
      } finally { await context.close() }
    }
  } finally {
    await browser?.close()
    await server.close()
    await writeFile(join(profile, 'measurements.json'), JSON.stringify(measurements, null, 2) + '\n')
    console.log('HOME_INTEGRATION_CLOSED', profile)
  }
}

test('the example hint belongs to its real Activity header at three sizes and two text zooms', { timeout: 180_000 }, async () => {
  const cells = [[1280, 800], [1440, 900], [390, 844]].flatMap(([width, height]) => [1, 1.5]
    .map(zoom => ({ name: `${width}x${height}-z${zoom}`, width, height, mobile: width === 390, zoom })))
  await sourceCases(cells, async (page, requested) => {
    // The original two phone cells keep their separate 44px touch-floor rules.
    // Default desktop sizing is checked at 1280/1440 and in the eight cells below.
    const controls = requested.mobile ? { observed: false, reason: 'phone touch-floor sizing is outside the desktop default-control gate' }
      : await headerControlValues(page, requested.zoom)
    await page.getByText(hint, { exact: true }).scrollIntoViewIfNeeded()
    const result = await page.evaluate(hint => {
      const box = node => {
        const r = node.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
      }
      const notes = [...document.querySelectorAll('.home-fact')].filter(node => node.textContent === hint)
      const node = notes[0], header = node?.closest('.session-head')
      const badge = header?.querySelector('[data-panel-badge]')
      return { count: notes.length, inHeader: Boolean(header), sameHeader: badge?.closest('.session-head') === header,
        node: node ? box(node) : null, header: header ? box(header) : null,
        badge: badge ? box(badge) : null, href: node?.getAttribute('href'),
        zoom: getComputedStyle(document.documentElement).getPropertyValue('--zoom') }
    }, hint)
    assert.equal(result.count, 1, 'the literal example hint must be rendered once')
    assert.equal(result.inHeader, true, 'the example hint must remain attached to the real Activity header')
    assert.equal(result.sameHeader, true, 'example badge and instruction must share the header')
    assert.equal(result.href, null, 'the existing sample fact has no link')
    assert.ok(result.node.width > 0 && result.node.height > 0 && result.badge.width > 0, 'hint and existing example badge must be visible')
    for (const edge of ['left', 'top']) assert.ok(result.node[edge] >= result.header[edge] - 1, edge + ': hint escaped its header')
    for (const edge of ['right', 'bottom']) assert.ok(result.node[edge] <= result.header[edge] + 1, edge + ': hint escaped its header')
    return { ...result, controls }
  })
})

test('narrow Home header actions remain separate and Ledger words stay intact in eight real navigation cells', { timeout: 180_000 }, async () => {
  const cells = ['white', 'black'].flatMap(theme => [1, 1.5].flatMap(zoom => ['top', 'collapsed-side']
    .map(layout => ({ name: `home-${theme}-390x844-z${zoom * 100}-${layout === 'top' ? 'navtop' : 'navcollapsed-side'}`,
      theme, zoom, layout, width: 390, height: 844 }))))
  await sourceCases(cells, async (page, requested) => {
    const controls = await headerControlValues(page, requested.zoom)
    const expand = page.locator('.home .session-head [data-chat-expand]')
    await expand.scrollIntoViewIfNeeded()
    const header = await page.evaluate(async () => {
      const box = node => {
        const r = node.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
      }
      const head = document.querySelector('.home .session-head')
      const button = head.querySelector('[data-chat-expand]'), badge = head.querySelector('[data-panel-badge]')
      const b = button.getBoundingClientRect(), hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
      const nodes = [], walker = document.createTreeWalker(badge, NodeFilter.SHOW_TEXT)
      let next, offset = 0
      while ((next = walker.nextNode())) { nodes.push({ node: next, start: offset }); offset += next.textContent.length }
      const at = index => {
        const item = [...nodes].reverse().find(item => index >= item.start)
        return { node: item.node, offset: index - item.start }
      }
      const badgeWords = [...badge.textContent.matchAll(/[A-Za-z]+/g)].map(match => {
        const range = document.createRange(), start = at(match.index), end = at(match.index + match[0].length)
        range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset)
        return { word: match[0], rects: [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0)
          .map(r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height })) }
      })
      const visible = [...head.querySelectorAll('button,select')].filter(node => {
        const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !node.closest('[hidden]')
      }).map(node => ({ name: node.className, rect: box(node) }))
      const { EXAMPLE_BADGE } = await import('/src/comms-copy.js')
      return { navigation: document.body.dataset.navigation, collapsed: document.body.dataset.navigationCollapsed,
        phoneCanvas: document.documentElement.getAttribute('data-phone-canvas'), touchPoints: navigator.maxTouchPoints,
        theme: document.documentElement.dataset.theme, zoom: getComputedStyle(document.documentElement).getPropertyValue('--zoom').trim(),
        head: box(head), button: box(button), badge: box(badge), badgeWords, visible,
        badgeText: badge.textContent, expectedBadge: EXAMPLE_BADGE,
        buttonHit: hit === button || button.contains(hit),
        optionalControls: { pickerShown: head.querySelector('[data-home-agent]').getBoundingClientRect().width > 0,
          modeShown: head.querySelector('[data-home-mode]').getBoundingClientRect().width > 0 },
        newAgentDisabled: document.querySelector('[data-home-new-agent]').disabled }
    })
    console.log('HOME_NARROW_HEADER_BEFORE_ASSERT', JSON.stringify({ requested, header }))
    assert.equal(header.navigation, requested.layout === 'top' ? 'top' : 'side')
    assert.equal(header.phoneCanvas, null, 'these eight source layout cells must remain desktop-class contexts')
    assert.equal(header.touchPoints, 0, 'these navigation comparisons do not emulate touch or phone mode')
    if (requested.layout === 'collapsed-side') assert.equal(header.collapsed, 'true', 'real collapse action must take effect')
    assert.equal(header.theme, requested.theme); assert.equal(Number(header.zoom || 1), requested.zoom)
    assert.equal(header.newAgentDisabled, true, 'example New-agent refusal must remain')
    assert.equal(header.badgeText, header.expectedBadge)
    assert.ok(header.badge.width > 0 && header.badge.height > 0 && header.button.width > 0 && header.button.height > 0)
    const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    assert.equal(area(header.badge, header.button), 0, 'example badge intersects the Full view action')
    assert.ok(header.badgeWords.length > 0, 'the visible example disclosure must have readable words')
    for (const word of header.badgeWords) {
      assert.equal(word.rects.length, 1, 'example disclosure word is fragmented: ' + word.word)
      const rect = word.rects[0]
      assert.ok(rect.left >= header.badge.left - 1 && rect.right <= header.badge.right + 1
        && rect.top >= header.badge.top - 1 && rect.bottom <= header.badge.bottom + 1, 'example disclosure word is clipped: ' + word.word)
    }
    for (const node of [{ name: 'badge', rect: header.badge }, ...header.visible]) {
      for (const edge of ['left', 'top']) assert.ok(node.rect[edge] >= header.head[edge] - 1, node.name + ': escaped header ' + edge)
      for (const edge of ['right', 'bottom']) assert.ok(node.rect[edge] <= header.head[edge] + 1, node.name + ': escaped header ' + edge)
    }
    for (let i = 0; i < header.visible.length; i++) for (let j = i + 1; j < header.visible.length; j++) {
      assert.equal(area(header.visible[i].rect, header.visible[j].rect), 0, 'visible Activity actions intersect')
    }
    assert.equal(header.buttonHit, true, 'Full view action must own its real hit point')
    await expand.click()
    await page.locator('.home [data-chat-takeover]:not([hidden])').waitFor()
    await page.locator('.home [data-chat-collapse]').click()
    await expand.scrollIntoViewIfNeeded(); await expand.focus()
    await page.keyboard.press('Shift+Tab')
    assert.equal(await expand.evaluate(node => document.activeElement === node), false, 'reverse Tab must leave Full view')
    await page.keyboard.press('Tab')
    assert.equal(await expand.evaluate(node => document.activeElement === node), true, 'real Tab must reach Full view')
    const focus = await expand.evaluate(node => ({ visible: node.matches(':focus-visible'),
      width: getComputedStyle(node).outlineWidth, style: getComputedStyle(node).outlineStyle }))
    assert.equal(focus.visible, true); assert.notEqual(focus.style, 'none'); assert.ok(parseFloat(focus.width) > 0)
    await page.keyboard.press('Enter')
    await page.locator('.home [data-chat-takeover]:not([hidden])').waitFor()
    await page.locator('.home [data-chat-collapse]').click()

    const ledger = page.locator('.home [data-glance-ledger] [data-home-ledger-status]')
    await ledger.scrollIntoViewIfNeeded()
    const reading = await ledger.evaluate(async link => {
      const { homeLedgerStatus, ledgerStatusHref } = await import('/src/home-ledger-status.js')
      const { sampleLedgerData } = await import('/src/sample-ledger.js')
      const { exampleOwnerPrompts } = await import('/src/approvals-example.js')
      const expected = homeLedgerStatus({ ledger: { ok: true, records: sampleLedgerData().requests },
        prompts: { ok: true, prompts: exampleOwnerPrompts() } })
      const span = link.querySelector('span'), text = span.textContent
      const nodes = [], walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
      let next, offset = 0
      while ((next = walker.nextNode())) { nodes.push({ node: next, start: offset }); offset += next.textContent.length }
      const at = index => {
        const item = [...nodes].reverse().find(item => index >= item.start)
        return { node: item.node, offset: index - item.start }
      }
      const words = [...text.matchAll(/[A-Za-z]+/g)].map(match => {
        const range = document.createRange(), start = at(match.index), end = at(match.index + match[0].length)
        range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset)
        return { word: match[0], rects: [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0)
          .map(r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height })) }
      })
      const rect = link.closest('[data-glance-tile]').getBoundingClientRect()
      const dashboard = document.querySelector('.home'), style = getComputedStyle(dashboard)
      return { text, expected: expected.label, href: link.getAttribute('href'), expectedHref: ledgerStatusHref(expected.status),
        status: link.dataset.status, expectedStatus: expected.status, words, tiles: dashboard.querySelectorAll('[data-glance-tile]').length,
        tile: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        usableCssWidth: dashboard.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        columnWidths: getComputedStyle(dashboard.querySelector('.home-glance-strip')).gridTemplateColumns }
    })
    console.log('HOME_NARROW_LEDGER_BEFORE_ASSERT', JSON.stringify({ requested, reading }))
    assert.equal(reading.text, reading.expected, 'Ledger label/count must come from the actual summary')
    assert.equal(reading.href, reading.expectedHref); assert.equal(reading.status, reading.expectedStatus)
    assert.equal(reading.tiles, 4); assert.ok(reading.words.length > 0)
    for (const word of reading.words) {
      assert.equal(word.rects.length, 1, 'Ledger word is fragmented: ' + word.word)
      const rect = word.rects[0]
      assert.ok(rect.left >= reading.tile.left - 1 && rect.right <= reading.tile.right + 1, 'Ledger word escapes its tile: ' + word.word)
    }
    return { controls, header, focus, reading }
  })
})

test('actual automatic phone mode preserves compact clearance and wordmark while desktop narrow clearance remains', { timeout: 180_000 }, async () => {
  const cells = [
    { name: 'desktop-narrow', width: 500, height: 800 },
    { name: 'desktop-wide', width: 760, height: 800 },
    { name: 'phone-portrait', width: 390, height: 844, mobile: true },
    { name: 'phone-portrait-enlarged', width: 390, height: 844, mobile: true, zoom: 1.5 },
    { name: 'phone-landscape', width: 844, height: 390, mobile: true },
  ]
  await sourceCases(cells, async page => {
    await page.evaluate(async () => { const { setNavigationPreview } = await import('/src/navigation-preview.js'); setNavigationPreview('top') })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const mobile = await page.evaluate(() => document.documentElement.getAttribute('data-phone-canvas') === 'on')
    if (mobile) { await page.locator('.phone-home-link').focus(); await page.keyboard.press('Shift') }
    const result = await page.evaluate(() => {
      const wordmark = document.querySelector('.phone-home-link'), c = getComputedStyle(wordmark)
      const r = wordmark.getBoundingClientRect()
      return { width: innerWidth, phone: document.documentElement.getAttribute('data-phone-canvas'),
        mobileClass: navigator.maxTouchPoints > 0, stage: getComputedStyle(document.querySelector('#stage')).paddingTop,
        view: getComputedStyle(document.querySelector('#stage>.view')).top,
        cover: getComputedStyle(document.querySelector('.topbar'), '::before').height,
        grid: getComputedStyle(document.querySelector('.topbar')).gridTemplateColumns,
        visible: r.width > 0 && r.height > 0, whiteSpace: c.whiteSpace, overflowWrap: c.overflowWrap,
        maxWidth: c.maxWidth, textAlign: c.textAlign, outlineWidth: c.outlineWidth,
        outlineStyle: c.outlineStyle, outlineColor: c.outlineColor, ink: c.color,
        outlineOffset: c.outlineOffset, focusVisible: wordmark.matches(':focus-visible') }
    })
    assert.equal(result.phone, result.mobileClass ? 'on' : null, 'only the real source phone decision may select this mode')
    const clearance = result.phone === 'on' || result.width > 720 ? '82px' : '172px'
    assert.equal(result.stage, clearance, 'stage clearance changed')
    assert.equal(result.view, clearance, 'view clearance changed')
    assert.equal(result.cover, result.phone === 'on' || result.width > 720 ? '58px' : '172px', 'top backing height changed')
    assert.equal(result.visible, result.phone === 'on', 'phone wordmark visibility changed')
    if (result.phone === 'on') {
      assert.equal(result.whiteSpace, 'normal'); assert.equal(result.overflowWrap, 'anywhere')
      assert.equal(result.maxWidth, '100%'); assert.equal(result.textAlign, 'center')
      assert.equal(result.outlineWidth, '2px'); assert.equal(result.outlineStyle, 'solid')
      assert.equal(result.outlineColor, result.ink); assert.equal(result.outlineOffset, '2px')
      assert.equal(result.focusVisible, true)
    }
    return result
  })
})
