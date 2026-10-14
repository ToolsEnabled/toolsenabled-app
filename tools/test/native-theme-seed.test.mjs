import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { themeSeed } from '../../shell/theme-seed.cjs'

const THEMES = ['white', 'tan', 'black', 'ember', 'cobalt']

// The seed is compared to the renderer's own `--bg` / `--ink`, resolved per
// theme from the four unconditional root-token sheets in actual main import
// order (the same bound tools/test/home-status-palette-tokens.test.mjs uses),
// not to a copied table: a retuned theme would otherwise desync the native
// window's first frame and the static refusal page without any test noticing.
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

const expected = Object.fromEntries(THEMES.map(theme => {
  const resolve = tokensFor(theme)
  return [theme, { bg: resolve('--bg'), ink: resolve('--ink') }]
}))

for (const theme of THEMES) {
  test(`${theme} starts with its persisted renderer palette`, () => {
    assert.match(expected[theme].bg, /^#[0-9a-f]{6}$/, `${theme}: --bg must resolve to an opaque hex colour`)
    assert.match(expected[theme].ink, /^#[0-9a-f]{6}$/, `${theme}: --ink must resolve to an opaque hex colour`)
    assert.deepEqual(themeSeed(theme), expected[theme])
  })
}

test('missing and unrecognized theme choices use the opaque White palette', () => {
  for (const value of [undefined, null, '', 'unknown', 'constructor', '__proto__', 'toString']) {
    assert.deepEqual(themeSeed(value), expected.white)
  }
})
