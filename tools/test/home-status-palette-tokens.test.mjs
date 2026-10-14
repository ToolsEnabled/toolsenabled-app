import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { defaultHomeStatusColors } from '../../src/home-status-colors.js'

// Bound: the four unconditional root-token sheets in actual main import order.
// This value gate does not model page overrides or prove rendered contrast.
function tokensFor(theme) {
  const tokens = new Map(), priority = new Map()
  for (const name of ['styles.css', 'theme-refinements.css', 'foundation.css', 'tokens.css']) {
    const css = postcss.parse(readFileSync(new URL(`../../src/${name}`, import.meta.url), 'utf8'))
    css.walkRules(rule => {
      if (rule.parent.type !== 'root') return
      const matches = rule.selectors.filter(selector => selector === ':root'
        || selector === `:root[data-theme="${theme}"]`
        || (selector.startsWith(':root:is(') && selector.endsWith(')') && selector.includes(`[data-theme="${theme}"]`)))
      if (!matches.length) return
      const specificity = matches.some(selector => selector !== ':root') ? 2 : 1
      rule.walkDecls(declaration => {
        if (!declaration.prop.startsWith('--') || specificity < (priority.get(declaration.prop) || 0)) return
        priority.set(declaration.prop, specificity); tokens.set(declaration.prop, declaration.value.trim())
      })
    })
  }
  const resolve = (name, seen = new Set()) => {
    assert.ok(!seen.has(name), `token cycle: ${name}`)
    assert.ok(tokens.has(name), `unread token: ${name}`)
    const value = tokens.get(name), match = value.match(/^var\((--[\w-]+)\)$/)
    return match ? resolve(match[1], new Set([...seen, name])) : value.toLowerCase()
  }
  return resolve
}

test('all fifteen automatic Home/Ledger colors equal the live theme status tokens', () => {
  for (const theme of ['white', 'tan', 'black', 'ember', 'cobalt']) {
    const resolve = tokensFor(theme), colors = defaultHomeStatusColors(theme)
    assert.equal(colors.clear, resolve('--status-idle'), `${theme}: clear`)
    assert.equal(colors.attention, resolve('--status-mark-needs-you'), `${theme}: attention mark`)
    assert.equal(colors.blocked, resolve('--status-error'), `${theme}: blocked`)
  }
})
