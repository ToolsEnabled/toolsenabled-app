import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const stylesPath = path.join(root, 'src/styles.css')

/* These are the rectangular, structural pieces of buildChat. Transcript
 * marks, dots, and the deliberately pill-shaped "new below" notification are
 * not panel geometry and therefore are not members of this sizing ratchet. */
const structuralChatSelectors = new Set([
  '.chat-head',
  '.chat-search-toggle',
  '.chat-search',
  '.chat-search input',
  '.chat-context-head',
  '.chat-context-body',
  '.chat-input',
  '.chat-input input',
  '.chat-send',
  '.chat-composer-control',
  '.chat-nosend',
])

const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '')

function rules(css) {
  const found = []
  const source = stripComments(css)
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g
  for (const match of source.matchAll(rulePattern)) {
    const selector = match[1].trim()
    if (selector.startsWith('@')) continue
    const declarations = new Map()
    for (const declaration of match[2].split(';')) {
      const colon = declaration.indexOf(':')
      if (colon < 0) continue
      declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim())
    }
    found.push({ selector, declarations })
  }
  return found
}

function conditionalChatViolations(css) {
  const source = stripComments(css)
  const violations = []
  const conditional = /@(media|container)\b[^\{]*\{/g
  for (const match of source.matchAll(conditional)) {
    let depth = 1
    let end = match.index + match[0].length
    while (depth && end < source.length) {
      if (source[end] === '{') depth += 1
      if (source[end] === '}') depth -= 1
      end += 1
    }
    const body = source.slice(match.index + match[0].length, end - 1)
    for (const rule of rules(body)) {
      if (!/(^|[\s,>+~])\.chat[\w-]*/.test(rule.selector)) continue
      for (const property of rule.declarations.keys()) {
        if (/^(padding(?:-.+)?|font|font-size|border(?:-.+)?|border-radius)$/.test(property)) {
          violations.push(`${match[1]}: ${rule.selector} changes ${property}`)
        }
      }
    }
  }
  return violations
}

test('structural .chat rules spend spacing tokens and the 3px radius', async () => {
  const cssRules = rules(await readFile(stylesPath, 'utf8'))
  const governed = cssRules.filter(rule => structuralChatSelectors.has(rule.selector))
  assert.equal(governed.length, structuralChatSelectors.size, 'a governed chat selector moved or disappeared')

  for (const { selector, declarations } of governed) {
    for (const property of ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap']) {
      const value = declarations.get(property)
      if (value === undefined) continue
      assert.match(value, /var\(--s\d+\)/, `${selector} ${property} must spend a --s token`)
      assert.doesNotMatch(value, /(^|\s)\d+(?:\.\d+)?px(?:\s|$)/, `${selector} ${property} must not add raw pixels`)
    }
    if (declarations.has('border-radius')) {
      assert.equal(declarations.get('border-radius'), '3px', `${selector} must keep the Dense 3px radius`)
    }
  }
})

test('width conditions never restyle chat padding, type, radius, or borders', async () => {
  const css = await readFile(stylesPath, 'utf8')
  assert.deepEqual(conditionalChatViolations(css), [])
})

test('the ratchet rejects a width-conditional padding mutation in a scratch copy', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'chat-token-ratchet-'))
  const scratchStyles = path.join(scratch, 'styles.css')
  try {
    const css = await readFile(stylesPath, 'utf8')
    await writeFile(scratchStyles, `${css}\n@media (max-width: 640px) { .chat-log { padding: 2px; } }\n`)
    const mutated = await readFile(scratchStyles, 'utf8')
    assert.deepEqual(conditionalChatViolations(mutated), ['media: .chat-log changes padding'])
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
