/* THE FIRST-RUN WALKTHROUGH SHOWS NO NAVIGATION (B14).
 *
 * Found by the rehearsal-8 packaged keyboard drive on 2026-09-25, and confirmed
 * on the sealed build's own screenshot. setup.css says `body.first-run .topbar
 * { display: none }`. The side rail says `body[data-navigation="side"] .topbar
 * { display: flex }`. Both weigh (0,2,1), and app-navigation.css loads after
 * the views that import setup.css (src/main.js), so the rail won. A new person
 * met eight links that all bounced back to the walkthrough, and a keyboard
 * passed twelve dead stops before the first answer.
 *
 * This resolves the cascade the way a browser does for the two elements that
 * matter, the bar and the body's rail width: every rule in both sheets whose
 * selector matches, ranked by specificity and then by load order. Nothing here
 * is a DOM; the matcher reads plain descendant selectors, skips states and
 * pseudo-elements, and refuses a functional selector that names the bar or the
 * body, so a new rule cannot slip past it unread.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const read = name => readFileSync(path.join(SRC, name), 'utf8')

/* Load order, as src/main.js imports them: the setup and settings views (which
   import setup.css) come before './app-navigation.css'. */
const MAIN = read('main.js')
const SHEETS = ['setup.css', 'app-navigation.css']

/* One compound selector: a tag, classes and attributes. */
function compound(text) {
  const match = /^([a-z]+)?((?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]|#[\w-]+)*)$/.exec(text)
  if (!match) return null
  const parts = match[2].match(/\.[\w-]+|\[[^\]]+\]|#[\w-]+/g) || []
  return {
    tag: match[1] || null,
    classes: parts.filter(p => p[0] === '.').map(p => p.slice(1)),
    ids: parts.filter(p => p[0] === '#').map(p => p.slice(1)),
    attrs: parts.filter(p => p[0] === '[').map(p => { const [name, value] = p.slice(1, -1).split('='); return { name, value: value === undefined ? null : JSON.parse(value) } }),
  }
}
const matches = (c, el) => (!c.tag || c.tag === el.tag)
  && c.classes.every(k => el.classes.includes(k))
  && c.ids.every(k => el.id === k)
  && c.attrs.every(a => a.name in el.attrs && (a.value === null || el.attrs[a.name] === a.value))
const weight = parts => parts.reduce((w, c) => [w[0] + c.ids.length, w[1] + c.classes.length + c.attrs.length, w[2] + (c.tag ? 1 : 0)], [0, 0, 0])

/* The winning value of `property` on the last element of `chain` (outermost
   first), at a desktop width. */
function resolve(chain, property) {
  const candidates = []
  let order = 0
  for (const sheet of SHEETS) {
    postcss.parse(read(sheet)).walkRules(rule => {
      order += 1
      const media = rule.parent?.type === 'atrule' ? rule.parent : null
      if (media && media.name === 'media' && !/max-width:\s*(\d+)px/.test(media.params)) return
      if (media && media.name === 'media' && Number(/max-width:\s*(\d+)px/.exec(media.params)[1]) < 1440) return
      const decl = rule.nodes?.findLast?.(n => n.type === 'decl' && n.prop === property)
      if (!decl) return
      for (const selector of rule.selectors) {
        /* Pseudo-elements and states (::before, :hover) are not the resting
           element. A functional selector that names the bar is refused. */
        if (selector.includes('(')) { assert.ok(!/topbar/.test(selector) && !/^(html\S*\s+)?body\S*$/.test(selector.trim()), `${sheet}: a selector this test cannot read names ${property}: ${selector}`); continue }
        if (selector.includes(':')) continue
        const parts = selector.trim().split(/\s+/).map(compound)
        assert.ok(parts.every(Boolean), `${sheet}: a selector this test cannot read names ${property}: ${selector}`)
        /* Descendant combinators only: the last part must be the element, the
           rest must match ancestors in order. */
        if (!matches(parts.at(-1), chain.at(-1))) continue
        let at = chain.length - 2
        const ok = parts.slice(0, -1).reverse().every(part => { while (at >= 0 && !matches(part, chain[at])) at -= 1; return at-- >= 0 })
        if (ok) candidates.push({ value: decl.value, important: decl.important, weight: weight(parts), order, sheet, selector })
      }
    })
  }
  candidates.sort((a, b) => (a.important - b.important) || (a.weight[0] - b.weight[0]) || (a.weight[1] - b.weight[1]) || (a.weight[2] - b.weight[2]) || (a.order - b.order))
  return candidates.at(-1)
}

const html = { tag: 'html', classes: ['in-shell'], attrs: {} }
const body = (...classes) => ({ tag: 'body', classes, attrs: { 'data-navigation': 'side' } })
const topbar = { tag: 'header', classes: ['topbar'], attrs: {} }

test('the sheets load in the order this test assumes', () => {
  const setupView = MAIN.indexOf("from './views/setup.js'")
  const navigation = MAIN.indexOf("import './app-navigation.css'")
  assert.ok(setupView > 0 && navigation > setupView, 'app-navigation.css loads after the view that imports setup.css')
})

test('during the first-run walkthrough the rail is not drawn', () => {
  for (const chain of [[html, body('first-run'), topbar], [body('first-run'), topbar]]) {
    const winner = resolve(chain, 'display')
    assert.equal(winner?.value, 'none', `the bar is drawn by ${winner?.sheet} ${winner?.selector}`)
  }
})

test('during the walkthrough the page does not step past a rail that is not there', () => {
  const winner = resolve([html, body('first-run')], '--navigation-width')
  assert.equal(winner?.value, '0px', `${winner?.sheet} ${winner?.selector}`)
})

test('once a level is recorded, the rail and its width come back', () => {
  assert.equal(resolve([html, body(), topbar], 'display')?.value, 'flex')
  assert.equal(resolve([html, body(), topbar], 'display')?.sheet, 'app-navigation.css')
  assert.equal(resolve([html, body()], '--navigation-width')?.value, '232px')
})

test('the walkthrough rule is keyed to the body class main.js recomputes on every render', () => {
  assert.match(MAIN, /document\.body\.classList\.toggle\('first-run', firstRunPending\(SETUP_RESOLUTION\)\)/)
})
