// Contrast across every Research area, in every theme, measured rather than
// sampled by hand.
//
// The existing research-data-contrast-qa.mjs checks a curated list of selectors
// in the Files & data workspace. That is precise but it only measures what
// someone thought to list, and it covers one of seven areas. This sweeps every
// element that actually renders text, so a surface nobody listed is still
// measured.
//
// Method: composite each ancestor background through the canvas so that
// color(srgb ...), color-mix() and alpha all resolve to real pixels -- a regex
// over computed colour strings gets this wrong, which is how an earlier walk
// produced 33 false contrast flags on a page that was fine.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const ORIGIN = process.env.RESEARCH_QA_URL || 'http://127.0.0.1:4623'
const AREAS = ['data', 'design', 'protocol', 'experiments', 'run', 'library']
const THEMES = ['white', 'tan', 'black', 'ember', 'cobalt']
const temp = await realpath(process.env.RESEARCH_QA_TEMP || os.tmpdir())
const output = await mkdtemp(path.join(temp, 'research-page-contrast-'))

const SWEEP = () => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const rgba = colour => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = colour; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
  const blend = (over, under) => over.slice(0, 3).map((value, i) => value * over[3] / 255 + under[i] * (1 - over[3] / 255))
  const lum = rgb => rgb.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 })
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
  const out = []
  for (const element of document.querySelectorAll('.research-page *')) {
    const own = [...element.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim()
    if (!own) continue
    const box = element.getBoundingClientRect()
    if (!box.width || !box.height) continue
    const style = getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
    let background = [255, 255, 255]
    const chain = []; for (let n = element; n; n = n.parentElement) chain.unshift(n)
    for (const n of chain) background = blend(rgba(getComputedStyle(n).backgroundColor), background)
    const foreground = blend(rgba(style.color), background)
    const a = lum(foreground), b = lum(background)
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
    const size = parseFloat(style.fontSize), weight = Number(style.fontWeight) || 400
    // WCAG AA: 3.0 for large text (>=24px, or >=18.66px bold), else 4.5.
    const large = size >= 24 || (size >= 18.66 && weight >= 700)
    out.push({ ratio: Number(ratio.toFixed(2)), minimum: large ? 3 : 4.5, size, weight,
      tag: element.tagName.toLowerCase(), text: own.slice(0, 60), disabled: element.disabled === true || !!element.closest('[disabled]') })
  }
  return out
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.RESEARCH_QA_CHROMIUM || undefined })
const report = { ok: true, output, areas: [], failures: [] }
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  for (const theme of THEMES) {
    await page.goto(ORIGIN + '/#/research', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.evaluate(t => { document.documentElement.dataset.theme = t }, theme)
    const dismiss = page.getByRole('button', { name: 'Not now', exact: true })
    await dismiss.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    if (await dismiss.isVisible()) await dismiss.click()
    for (const area of AREAS) {
      await page.locator(`button[data-research-area="${area}"]`).click()
      await page.waitForTimeout(700)
      const samples = await page.evaluate(SWEEP)
      assert.ok(samples.length > 5, `${theme}/${area}: swept ${samples.length} text elements, which is too few to be a real measurement`)
      // A disabled control is deliberately dimmed and is not a reading surface.
      const failing = samples.filter(s => !s.disabled && s.ratio < s.minimum)
      const worst = [...samples].sort((a, b) => a.ratio - b.ratio)[0]
      report.areas.push({ theme, area, swept: samples.length, worst: worst.ratio, worstText: worst.text, failing: failing.length })
      for (const item of failing) report.failures.push({ theme, area, ...item })
      if (failing.length) await page.screenshot({ path: path.join(output, `fail-${area}-${theme}.png`), fullPage: true })
    }
  }
  report.pageErrors = errors
  report.sweptTotal = report.areas.reduce((n, a) => n + a.swept, 0)
  report.ok = report.failures.length === 0
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  const byArea = {}
  for (const row of report.areas) byArea[row.area] = Math.min(byArea[row.area] ?? Infinity, row.worst)
  console.log(`swept ${report.sweptTotal} text elements across ${AREAS.length} areas x ${THEMES.length} themes`)
  console.log('worst contrast per area (all themes):')
  for (const [area, worst] of Object.entries(byArea)) console.log(`  ${area.padEnd(12)} ${worst.toFixed(2)}:1`)
  console.log(`failures below WCAG AA: ${report.failures.length}`)
  for (const f of report.failures.slice(0, 25)) console.log(`  ${f.theme}/${f.area} ${f.ratio}:1 (needs ${f.minimum}) ${f.size}px <${f.tag}> "${f.text}"`)
  console.log('output: ' + output)
  assert.equal(report.failures.length, 0, `${report.failures.length} text elements are below WCAG AA contrast`)
} finally { await browser.close() }
