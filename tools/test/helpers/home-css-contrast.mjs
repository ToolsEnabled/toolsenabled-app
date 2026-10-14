import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build, stop } from 'esbuild'
import { chromium } from 'playwright'

// Actual production CSS cascade on inert Home/Full view markup. No app
// controller, native bridge, account storage or network request is exercised.
export async function measureHomePlate(theme) {
  const app = fileURLToPath(new URL('../../../', import.meta.url))
  const main = await readFile(path.join(app, 'src/main.js'), 'utf8')
  const home = await readFile(path.join(app, 'src/views/home.js'), 'utf8')
  const imports = source => [...source.matchAll(/^import\s+['"]([^'"]+)['"]\s*;?\s*$/gm)].map(match => match[1]).filter(name => name.endsWith('.css') || name.startsWith('@fontsource'))
  const globals = imports(main), split = globals.indexOf('./morphs.css')
  if (split < 0) throw new Error('Home plate cannot locate the production stylesheet boundary')
  const relative = name => name.startsWith('.') ? './src/' + name.slice(2) : name
  const names = [...globals.slice(0, split).map(relative), ...imports(home).map(name => './src/' + name.slice(3)), ...globals.slice(split).map(relative)]
  let stylesheet
  try {
    const result = await build({ stdin: { contents: names.map(name => 'import ' + JSON.stringify(name)).join('\n'), resolveDir: app }, bundle: true, write: false, outdir: path.join(process.env.TMPDIR || app, 'home-plate-memory-bundle'), loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, logLevel: 'silent' })
    stylesheet = result.outputFiles.find(file => file.path.endsWith('.css'))?.text
    if (!stylesheet) throw new Error('Home plate stylesheet was not built')
  } finally { stop() }
  const executable = process.env.HOME_PANEL_BROWSER || process.env.HOME_QA_BROWSER
  const browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    await context.route('**/*', route => route.abort('blockedbyclient'))
    const page = await context.newPage()
    await page.setContent('<!doctype html><html><body><div class="home"><div class="home-columns"><div></div><div class="home-feed-wrap"><section class="home-feed"><div class="session-head"><span data-panel-title>Activity</span></div></section></div></div><div class="home-takeover"><div class="home-takeover-stage"><div class="home-chat-pane-body"><p class="home-scope-empty" data-plate-secondary>No matching runs</p><div class="home-agent-chat" data-home-chat><div class="chat" data-chat-panel><div class="chat-head"><span class="role-dot"></span><div><div class="t">Fixture agent</div><div class="s" data-chat-subtitle>Chat subtitle</div></div><span class="spacer"></span></div></div></div></div></div></div></div></body></html>')
    await page.addStyleTag({ content: stylesheet })
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    const records = []
    // chat-presentation.css overrides the older styles.css ink-25 subtitle
    // rule with ink-3 on the real data-chat-panel ancestry.
    for (const [selector, token] of [['[data-panel-title]', '--ink-3'], ['[data-plate-secondary]', '--ink-3'], ['.chat[data-chat-panel] .chat-head div.s[data-chat-subtitle]', '--ink-3']]) {
      records.push(await page.locator(selector).evaluate((el, token) => {
        const parse = value => {
          let match = value.match(/^rgba?\(([^)]+)\)$/)
          if (match) { const n = match[1].split(/[, /]+/).map(Number); return [...n.slice(0, 3), n[3] ?? 1] }
          match = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/)
          if (match) return [Number(match[1]) * 255, Number(match[2]) * 255, Number(match[3]) * 255, Number(match[4] ?? 1)]
          throw new Error('Unsupported Home plate computed color: ' + value)
        }
        const luminance = rgb => rgb.slice(0, 3).map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4 }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
        const chain = []; for (let parent = el; parent; parent = parent.parentElement) chain.unshift({ name: parent.className || parent.tagName, background: getComputedStyle(parent).backgroundColor })
        let background = [255, 255, 255]
        for (const parent of chain) { const color = parse(parent.background); background = background.map((value, index) => color[index] * color[3] + value * (1 - color[3])) }
        const color = getComputedStyle(el).color, foreground = parse(color), a = luminance(foreground), b = luminance(background)
        const reference = document.createElement('span')
        reference.style.color = `var(${token})`; el.parentElement.append(reference)
        const expectedSecondary = getComputedStyle(reference).color; reference.remove()
        return { text: el.textContent, token, expectedSecondary, color, background, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), chain }
      }, token))
    }
    return records
  } finally { await context.close(); await browser.close() }
}
