/* An element hidden from script needs the same guard as one shipped hidden.
 *
 * hidden-display-honesty.test.mjs reads the hidden attribute where markup ships it. A field built in script and hidden
 * later (`field.hidden = ...`) never appears there, so a class display rule on it silently beats the browser's hidden
 * default: the typed model name showed beside every catalogue model, and the research folder and project fields
 * showed together. This reads each script-built element that is hidden from script and requires a
 * `.class[hidden] { display: none }` guard for every class whose own rule sets a display.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cssRules, cssSelectors, selectorSubject } from './lib/css-rule-source.mjs'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
function walk(dir, keep, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, keep, found)
    else if (keep.test(entry.name)) found.push(full)
  }
  return found
}

function cssFacts(texts) {
  const displayed = new Set(), guarded = new Set()
  for (const text of texts) {
    for (const { selector, body } of cssRules(text)) {
      const display = [...body.matchAll(/(?:^|;)\s*display\s*:\s*([a-z-]+)/g)].at(-1)?.[1]
      if (!display) continue
      for (const part of cssSelectors(selector)) {
        const subject = selectorSubject(part)
        const own = /^\.([A-Za-z0-9_-]+)$/.exec(subject)
        const hidden = /^\.([A-Za-z0-9_-]+)\[hidden\]$/.exec(subject)
        if (own && display !== 'none') displayed.add(own[1])
        if (hidden && display === 'none') guarded.add(hidden[1])
      }
    }
  }
  return { displayed, guarded }
}

// One class per script-built element: `name.className = 'cls'`, then `name.hidden = ...` before `name` is declared
// again (so two elements that share a variable name in different functions are not paired).
// createModelNameField's caller-chosen class is hidden by every caller until Other model… is chosen.
export function scriptHiddenClasses(sources) {
  const found = new Map()
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\.className\s*=\s*'([A-Za-z0-9_-]+)'/g)) {
      const name = m[1].replace(/\$/g, '\\$')
      const declaration = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`, 'g')
      declaration.lastIndex = m.index + m[0].length
      const end = declaration.exec(text)?.index ?? text.length
      const scope = text.slice(m.index + m[0].length, end)
      if (new RegExp(`\\b${name}\\.hidden\\s*=(?!=)`).test(scope)) found.set(m[2], `${file}: ${m[1]}`)
    }
    for (const m of text.matchAll(/createModelNameField\([^)]*?className:\s*'([A-Za-z0-9_-]+)'/g)) {
      found.set(m[1], `${file}: createModelNameField`)
    }
  }
  return found
}

export function unguarded(cssTexts, jsSources) {
  const { displayed, guarded } = cssFacts(cssTexts)
  return [...scriptHiddenClasses(jsSources)]
    .filter(([cls]) => displayed.has(cls) && !guarded.has(cls))
    .map(([cls, where]) => `.${cls} (${where})`)
}

test('a class display rule on a script-hidden element has its [hidden] guard', () => {
  const css = walk(SRC, /\.css$/).map(file => readFileSync(file, 'utf8'))
  const js = Object.fromEntries(walk(SRC, /\.(?:js|mjs)$/).map(file => [path.relative(SRC, file), readFileSync(file, 'utf8')]))
  assert.deepEqual(unguarded(css, js), [])
})

test('the check reports a displayed script-hidden class and accepts its guard', () => {
  const js = { 'form.js': "const f = doc.createElement('label'); f.className = 'pane-field'; f.hidden = true" }
  assert.deepEqual(unguarded(['.pane-field { display: grid; }'], js), ['.pane-field (form.js: f)'])
  assert.deepEqual(unguarded(['.pane-field { display: grid; }', '.pane-field[hidden] { display: none; }'], js), [])
  // Another element that reuses the variable name later is not this one.
  const reused = { 'two.js': "const f = make(); f.className = 'pane-field'\nfunction g() { const f = make(); f.hidden = true }" }
  assert.deepEqual(unguarded(['.pane-field { display: grid; }'], reused), [])
  // A class with no display rule of its own keeps the browser's hidden default.
  assert.deepEqual(unguarded(['.pane-field span { display: block; }'], js), [])
  // The model name field takes its class from the caller.
  const picker = { 'p.js': "createModelNameField(doc, { attribute: 'data-x', className: 'pane-field' })" }
  assert.deepEqual(unguarded(['.pane-field { display: flex; }'], picker), ['.pane-field (p.js: createModelNameField)'])
})
