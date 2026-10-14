import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Exercise the running hotload with normal input events and fresh browser
// storage. This covers the labelled example; it never sends to a provider.
const output = path.resolve(process.argv[2] || 'home-hotload-qa')
const origin = process.argv[3] || 'http://127.0.0.1:4623'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'QA targets a local hotload')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.env.HOME_QA_BROWSER ? { executablePath: path.resolve(process.env.HOME_QA_BROWSER) } : {}), ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
const records = []

async function geometry(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const el = document.querySelector(selector)
      if (!el || !el.getClientRects().length) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    }
    const home = document.querySelector('.home')
    const pixel = document.createElement('canvas').getContext('2d')
    pixel.canvas.width = pixel.canvas.height = 1
    const rgba = color => {
      pixel.clearRect(0, 0, 1, 1); pixel.fillStyle = color; pixel.fillRect(0, 0, 1, 1)
      return [...pixel.getImageData(0, 0, 1, 1).data]
    }
    const luminance = rgb => rgb.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0)
    const contrast = selector => {
      const el = document.querySelector(selector)
      if (!el || !el.getClientRects().length) return null
      const lineage = []; for (let p = el; p; p = p.parentElement) lineage.unshift(p)
      let background = [255, 255, 255]
      for (const p of lineage) {
        const color = rgba(getComputedStyle(p).backgroundColor), alpha = color[3] / 255
        background = background.map((c, i) => c * (1 - alpha) + color[i] * alpha)
      }
      const foreground = rgba(getComputedStyle(el).color)
      const a = luminance(foreground), b = luminance(background)
      return { selector, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }
    }
    return {
      contrast: ['.home-workspace-link', '.home-stat .tl', '.home-follow-action', '.home-feed-wrap [data-panel-title]',
        '.home .run-agent', '.home .run-asked', '.home .run-action', '.home .run-when', '.home .voice-widget-contact',
        '.home .activity-filters button[aria-pressed="true"]', '.home .home-agent-pick', '.home .home-agent-mode button[aria-pressed="true"]'].map(contrast).filter(Boolean),
      homeOverflowX: home.scrollWidth - home.clientWidth,
      following: rect('[data-home-following]'),
      character: rect('.home-follow-column'), voice: rect('.home-follow-column > .voice-contact'), facts: rect('.home-facts'),
      card: rect('.home-columns > .home-feed-wrap'), composer: rect('.home-agent-chat .chat-compose-surface'),
      log: rect('.home-agent-chat .chat-log'),
      controls: ['.home-agent-pick', '.home-agent-mode', '.session-expand'].map(rect).filter(Boolean),
      working: [document.querySelector('[data-glance="working"]')?.textContent,
        document.querySelector('[data-activity-filter="working"] [data-filter-count]')?.textContent],
    }
  })
}

function checkGeometry(g, chat = false) {
  assert.ok(g.homeOverflowX <= 1, `horizontal page overflow: ${g.homeOverflowX}`)
  for (const color of g.contrast) assert.ok(color.ratio >= 4.5, `${color.selector} text contrast: ${color.ratio.toFixed(2)}`)
  for (const control of g.controls) {
    assert.ok(control.x >= g.card.x && control.right <= g.card.right + 1, 'card controls stay inside the frame')
  }
  for (const child of [g.following, g.voice, g.facts].filter(Boolean)) {
    assert.ok(child.x >= g.character.x && child.right <= g.character.right + 1, 'character content fits horizontally')
    assert.ok(child.y >= g.character.y && child.bottom <= g.character.bottom + 1, 'character panel encloses its content')
  }
  if (g.card.x > g.character.right) {
    assert.ok(Math.abs(g.card.y - g.character.y) <= 1, 'desktop panels align at the top')
  } else {
    assert.ok(g.card.y >= g.character.bottom + 16, 'stacked panels keep a gap without overlap')
  }
  if (chat) {
    assert.ok(g.composer, 'composer is rendered')
    assert.ok(g.composer.bottom <= g.card.bottom + 1, 'composer stays inside card')
    assert.ok(g.log.height >= 64, 'chat retains readable message space')
  }
}

try {
  for (const [width, height, theme, zoom = 1] of [[1440, 900, 'white'], [1440, 900, 'black'], [1100, 800, 'white'], [760, 800, 'black'], [390, 844, 'white'], [1440, 900, 'cobalt'], [1440, 900, 'ember'], [1280, 600, 'white'], [1440, 900, 'tan'], [1100, 800, 'white', 1.12], [390, 844, 'white', 1.12]]) {
    const tag = `${width}x${height}-${theme}${zoom === 1 ? '' : `-zoom${zoom}`}`
    if (process.argv[4] && !tag.startsWith(process.argv[4])) continue
    const context = await browser.newContext({ viewport: { width, height } })
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      return url.origin === new URL(origin).origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort('blockedbyclient')
    })
    await context.routeWebSocket(url => url.host === new URL(origin).host && url.searchParams.has('token'), socket => socket.close())
    await context.addInitScript(({ theme, zoom }) => {
      localStorage.clear(); localStorage.setItem('mc.example', 'on')
      localStorage.setItem('mc.set.feature_guides.v1', JSON.stringify({ version: 1, quiet: true, seen: {} }))
      localStorage.setItem('mc.theme', theme)
      localStorage.setItem('mc.text', String(zoom))
    }, { theme, zoom })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const note = { tag, steps: [] }
    try {
      await page.goto(`${origin}/#/`, { waitUntil: 'load', timeout: 60000 })
      await page.locator('[data-home-glance]:not([hidden])').waitFor()
      const tip = page.getByRole('button', { name: 'Not now', exact: true })
      if (await tip.isVisible()) await tip.click()
      await page.waitForTimeout(1800)
      assert.match(await page.locator('.panel-badge').textContent(), /example/i)
      const followed = () => page.evaluate(() => {
        const rows = [...document.querySelectorAll('.home-runs .home-run:not([hidden])')].filter(row => row.querySelector('.run-agent')?.textContent.trim())
        const first = rows.find(row => row.querySelector('.run-action')?.textContent.trim()) || rows.find(row => row.dataset.status === 'attention') || rows[0]
        return { top: first?.querySelector('.run-agent')?.textContent, following: document.querySelector('[data-home-following]')?.dataset.agentName, marked: first?.hasAttribute('data-followed') }
      })
      const initialFollow = await followed()
      assert.equal(initialFollow.following, initialFollow.top, 'All agents follows actual work, then attention, then displayed order')
      assert.equal(initialFollow.marked, true)
      const overview = await geometry(page)
      checkGeometry(overview)
      assert.equal(...overview.working, 'overview and filter agree on current work')
      await page.screenshot({ path: path.join(output, `${tag}-overview.png`) })
      note.steps.push('overview, status totals and Following layout')
      await page.locator('.home-follow-column .voice-widget-toggle').click()
      await page.waitForFunction(() => document.querySelector('.home-follow-column > .voice-contact')?.dataset.expanded === 'true')
      checkGeometry(await geometry(page))
      await page.locator('.home-follow-column .voice-widget-toggle').click()
      note.steps.push('voice controls expand inside the character panel and keep both panels aligned')

      await page.locator('[data-activity-filter="attention"]').click()
      await page.waitForFunction(() => [...document.querySelectorAll('.home-run:not([hidden])')].every(row => row.dataset.status === 'attention'))
      assert.ok(await page.locator('.home-run:not([hidden])').count() > 0)
      const filteredFollow = await followed()
      assert.equal(filteredFollow.following, filteredFollow.top, 'filtering preserves work/attention/display-order priority within the visible scope')
      await page.locator('[data-activity-filter="working"]').click()
      assert.equal(await page.locator('.home-run:not([hidden])').count(), 0)
      assert.ok(await page.locator('.home-scope-empty').isVisible())
      await page.locator('[data-activity-filter="all"]').click()
      assert.ok(await page.locator('.home-run:not([hidden])').count() > 0)
      note.steps.push('Attention and Working filters, empty state, All runs recovery')

      const pick = page.locator('.home-agent-pick')
      const options = await pick.locator('option').evaluateAll(nodes => nodes.map(node => node.value))
      assert.ok(options.length > 1)
      await pick.selectOption(options[1])
      await page.locator('[data-home-mode-choice="chat"]').click()
      const input = page.locator('.home-agent-chat .chat-input textarea, .home-agent-chat .chat-input textarea').first()
      await input.waitFor({ state: 'visible' })
      const draft = 'Keep this draft while I review the activity.'
      await input.fill(draft)
      await page.locator('[data-home-mode-choice="summary"]').click()
      await page.locator('[data-home-mode-choice="chat"]').click()
      assert.equal(await input.inputValue(), draft, 'draft survives Summary and Chat')
      if (options[2]) {
        await pick.selectOption(options[2])
        await pick.selectOption(options[1])
        await page.locator('[data-home-mode-choice="chat"]').click()
        assert.equal(await input.inputValue(), draft, 'draft survives agent switch')
      }
      checkGeometry(await geometry(page), true)
      await page.locator('.home-feed-wrap').scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(output, `${tag}-chat.png`) })
      note.steps.push('agent selection, chat composer, draft retention across modes and agents')

      await page.locator('[data-home-mode-choice="summary"]').click()
      await pick.selectOption('')
      await page.locator('[data-chat-expand]').click()
      assert.ok(await page.locator('.home-takeover').isVisible())
      await page.locator('[data-chat-collapse]').click()
      assert.equal(await page.locator('.home[data-chat-open]').count(), 0)
      const collapse = page.locator('[data-navigation-collapse]')
      if (await collapse.isVisible()) {
        await collapse.click()
        checkGeometry(await geometry(page))
        await collapse.click()
      }
      await page.locator('.home-feed-wrap').scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(output, `${tag}-activity.png`) })
      note.steps.push('Full view and return, navigation collapse, activity scroll')
      assert.deepEqual(errors, [], 'no page exceptions')
      note.passed = true
      note.geometry = overview
      console.log('PASS', tag, note.steps.join('; '))
    } catch (error) {
      note.passed = false
      note.error = error.message
      note.geometry = await geometry(page)
      console.error(JSON.stringify(note.geometry))
      console.error(await page.evaluate(() => ['.home', '.home-feed-wrap', '.home-feed'].map(s => {
        const el = document.querySelector(s), c = getComputedStyle(el)
        return { s, height: c.height, minHeight: c.minHeight, position: c.position, contain: c.contain, containerType: c.containerType, rows: c.gridTemplateRows, align: c.alignSelf }
      })))
      await page.screenshot({ path: path.join(output, `${tag}-failure.png`) })
      console.error('FAIL', tag, error.message)
      throw error
    } finally {
      records.push(note)
      await writeFile(path.join(output, 'results.json'), JSON.stringify(records, null, 2) + '\n')
      await context.close()
    }
  }
} finally {
  await browser.close()
}
