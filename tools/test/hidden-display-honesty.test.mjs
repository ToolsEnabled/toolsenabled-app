/* Author display rules override the browser's hidden default. This static
 * ratchet checks literal subject classes on shipped hidden elements. A rule
 * for a descendant or pseudo-element does not style its hidden ancestor.
 *
 * Direct class[hidden] guards retain the existing convention. A simple
 * `.scope [hidden]` guard also proves a single-class display rule safe when
 * every observed instance is inside that literal scope. Positive functional
 * unions accept only standalone class alternatives; intersections such as
 * `.a.b` or `.a:is(.b)`, and constrained :not/:has branches, remain
 * unproven and intentionally report. More complex cascade cases require their
 * own browser proof; this is not a complete CSS engine.
 */
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseAst } from 'rollup/parseAst'
import { cssRules, cssSelectors, selectorSubject } from './lib/css-rule-source.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
function walk(dir, keep, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, keep, found)
    else if (keep.test(entry.name)) found.push(full)
  }
  return found
}

// The grouped Home guard was introduced by abf7196c7. A pure :is/:where
// union has the same subject classes as its alternatives; intersections,
// descendant requirements, attributes and other pseudo-classes do not.
function positiveSubjectParts(subject) {
  const cls = /^\.([A-Za-z0-9_-]+)$/.exec(subject)
  if (cls) return { classes: [cls[1]], specificity: 1 }
  const functional = /^:(?:is|where)\(/.exec(subject)
  if (!functional) return null
  let depth = 1
  for (let i = functional[0].length; i < subject.length; i++) {
    if (subject[i] === '(') depth++
    else if (subject[i] === ')' && --depth === 0) {
      if (i !== subject.length - 1) return null
      const alternatives = cssSelectors(subject.slice(functional[0].length, i))
        .map(positiveSubjectParts)
      if (!alternatives.length || !alternatives.every(Boolean)) return null
      return {
        classes: alternatives.flatMap(part => part.classes),
        specificity: subject.startsWith(':where(') ? 0 : Math.max(...alternatives.map(part => part.specificity)),
      }
    }
  }
  return null
}

function subjectParts(subject) {
  const classes = []
  let depth = 0, quote = null, hidden = false, pseudoElement = false
  for (let i = 0; i < subject.length; i++) {
    const character = subject[i]
    if (character === '\\') { i++; continue }
    if (quote) { if (character === quote) quote = null; continue }
    if (character === '"' || character === "'") { quote = character; continue }
    if (!depth) {
      if (subject.startsWith('[hidden]', i)) hidden = true
      if (subject.startsWith('::', i)) pseudoElement = true
      const cls = character === '.' && /^\.([A-Za-z0-9_-]+)/.exec(subject.slice(i))
      if (cls) { classes.push(cls[1]); i += cls[0].length - 1; continue }
    }
    if (character === '(' || character === '[') depth++
    else if (character === ')' || character === ']') depth--
  }
  // Extend the existing direct-class convention only to an unconstrained
  // positive union. Keep the original scan for outer classes in constrained
  // subjects such as .control:is(.busy, .ready).
  const positive = positiveSubjectParts(subject.replace(/\[hidden\]$/, '').trim())
  for (const cls of positive?.classes || []) if (!classes.includes(cls)) classes.push(cls)
  return { classes, hidden, pseudoElement, specificity: positive?.specificity }
}

function hiddenMarkup(source) {
  const rows = []
  const interpolations = []
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
  const attributesOf = tag => [...tag.matchAll(/\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)]
  const bareHidden = attributes => attributes.some(attribute => attribute[1] === 'hidden' && attribute.slice(2).every(value => value === undefined))
  function fragment(text, offset = null) {
    const stack = []
    const markup = text.replace(/<!--[\s\S]*?-->/g, comment => comment.replace(/[^\n]/g, ' '))
    for (const match of markup.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b[^<>]*>/gi)) {
      const [tag, closing, name] = match
      if (closing) {
        const at = stack.findLastIndex(parent => parent.name === name.toLowerCase())
        if (at >= 0) stack.splice(at)
        continue
      }
      const attributes = attributesOf(tag)
      const classAttribute = attributes.find(attribute => attribute[1] === 'class')
      const classes = (classAttribute?.[2] || classAttribute?.[3] || classAttribute?.[4] || '')
        .split(/\s+/).filter(value => /^[A-Za-z0-9_-]+$/.test(value))
      if (bareHidden(attributes)) {
        rows.push({ classes, ancestors: new Set(stack.flatMap(parent => parent.classes)), at: offset === null ? null : offset + match.index })
      }
      if (!voidTags.has(name.toLowerCase()) && !/\/>$/.test(tag)) stack.push({ name: name.toLowerCase(), classes })
    }
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Literal' && typeof node.value === 'string') fragment(node.value)
    if (node.type === 'TemplateElement') fragment(source.slice(node.start, node.end), node.start)
    if (node.type === 'TemplateLiteral') node.expressions.forEach((expression, index) => {
      interpolations.push({ start: node.quasis[index].end, end: node.quasis[index + 1].start, expression })
    })
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseAst(source))
  // Preserve potential literal attributes from conditional templates without
  // mistaking an identifier such as `hidden` for an emitted HTML attribute.
  // This is conservative presence analysis, not execution of the expression.
  function possibleText(node) {
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value
    if (node.type === 'TemplateLiteral') return node.quasis.map((quasi, index) =>
      (quasi.value.cooked ?? quasi.value.raw) + (node.expressions[index] ? possibleText(node.expressions[index]) : '')).join('')
    if (node.type === 'ConditionalExpression') return `${possibleText(node.consequent)} ${possibleText(node.alternate)}`
    if (node.type === 'LogicalExpression') return `${possibleText(node.left)} ${possibleText(node.right)}`
    if (node.type === 'BinaryExpression' && node.operator === '+') return possibleText(node.left) + possibleText(node.right)
    return ''
  }
  function projectedTag(match) {
    let text = '', cursor = match.index
    const end = match.index + match[0].length
    for (const interpolation of interpolations.filter(part => part.start >= cursor && part.end <= end)
      .sort((left, right) => left.start - right.start || right.end - left.end)) {
      if (interpolation.start < cursor) continue
      text += source.slice(cursor, interpolation.start) + possibleText(interpolation.expression)
      cursor = interpolation.end
    }
    return text + source.slice(cursor, end)
  }
  // Keep the original unscoped coverage for tags crossing interpolations.
  // Their ancestry is not proven by a single literal fragment, so they cannot
  // claim a scoped guard merely because another instance has that ancestor.
  for (const match of source.matchAll(/<[a-z][a-z0-9-]*\b[^<>]*?\bclass="([^"]+)"[^<>]*?(?<![-\w])hidden(?![-\w=])[^<>]*>/g)) {
    if (!bareHidden(attributesOf(projectedTag(match)))) continue
    if (rows.some(row => row.at === match.index)) continue
    const classes = match[1].split(/\s+/).filter(value => /^[A-Za-z0-9_-]+$/.test(value))
    rows.push({ classes, ancestors: new Set(), at: match.index })
  }
  return rows
}

function violationsIn(cssSources, jsSources) {
  const displayed = new Map(), reasserted = new Map(), scoped = new Set(), functionalGuards = new Map()
  for (const [file, text] of Object.entries(cssSources)) {
    let order = 0
    for (const { selector, body } of cssRules(text)) {
      order++
      const display = [...body.matchAll(/(?:^|;)\s*display\s*:\s*([a-z-]+)([^;]*)/g)].at(-1)
      if (!display) continue
      for (const part of cssSelectors(selector)) {
        const scope = /^\.([A-Za-z0-9_-]+)\s+\[hidden\]$/.exec(part)
        if (scope && display[1] === 'none') scoped.add(scope[1])
        const subjectText = selectorSubject(part)
        const subject = subjectParts(subjectText)
        if (subject.pseudoElement) continue
        for (const cls of subject.classes) {
          if (subject.hidden && display[1] === 'none') {
            if (/^:(?:is|where)\(/.test(subjectText)) {
              if (!functionalGuards.has(cls)) functionalGuards.set(cls, [])
              functionalGuards.get(cls).push({
                prefix: part.slice(0, -subjectText.length).trim(),
                specificity: subject.specificity + 1, file, order,
                important: display[2].includes('!important'),
              })
            } else reasserted.set(cls, reasserted.get(cls) === true || display[2].includes('!important'))
          }
          else if (!part.includes('[hidden]') && display[1] !== 'none') {
            if (!displayed.has(cls)) displayed.set(cls, [])
            displayed.get(cls).push({ file, order, selector: part, display: display[1], important: display[2].includes('!important') })
          }
        }
      }
    }
  }
  const shipped = new Map()
  for (const [file, text] of Object.entries(jsSources)) for (const row of hiddenMarkup(text)) {
    for (const cls of row.classes) {
      if (!shipped.has(cls)) shipped.set(cls, [])
      shipped.get(cls).push({ file, ...row })
    }
  }
  const violations = []
  for (const [cls, rules] of displayed) {
    if (!shipped.has(cls)) continue
    // Specificity cannot make a normal direct guard beat important display.
    // Preserve whether any direct guard is important across other guards.
    if (reasserted.has(cls) && rules.every(rule => !rule.important || reasserted.get(cls))) continue
    // A new functional guard covers only display rules with the same ancestor
    // selector. A scoped union must never excuse a global display rule. This
    // compares coverage of the CSS rules, without assuming markup ancestry
    // across template interpolations that hiddenMarkup cannot prove.
    if (rules.every(rule => {
      const subject = selectorSubject(rule.selector)
      const positive = positiveSubjectParts(subject)
      if (!positive?.classes.includes(cls)) return false
      const prefix = rule.selector.slice(0, -subject.length).trim()
      return functionalGuards.get(cls)?.some(guard => guard.prefix === prefix
        && (!rule.important || guard.important)
        && ((guard.important && !rule.important) || guard.specificity > positive.specificity
          || (guard.specificity === positive.specificity && guard.file === rule.file && guard.order > rule.order)))
    })) continue
    // The scope plus [hidden] is more specific than .cls. Require the scope
    // for every markup instance, and never let it excuse !important display.
    if (rules.every(rule => rule.selector === `.${cls}` && !rule.important)
      && shipped.get(cls).every(row => [...row.ancestors].some(parent => scoped.has(parent)))) continue
    violations.push(`.${cls} is shipped hidden (${[...new Set(shipped.get(cls).map(row => row.file))].join(', ')}) without a matching display guard: ${rules.map(rule => `${rule.file}: ${rule.selector} -> ${rule.display}`).join(' | ')}`)
  }
  return violations
}

test('displayed subject classes shipped hidden have a direct or proven ancestor guard', () => {
  const sources = extension => Object.fromEntries(walk(path.join(REPO, 'src'), extension)
    .map(file => [path.relative(REPO, file), readFileSync(file, 'utf8')]))
  assert.deepEqual(violationsIn(sources(/\.css$/), sources(/\.js$/)), [])
})

test('direct hidden guards must match important display declarations', () => {
  const markup = { js: 'const markup = `<div class="mode" hidden></div>`' }
  for (const css of [
    '.mode { display: flex !important } .mode[hidden] { display: none }',
    '.mode[hidden] { display: none } .mode { display: flex !important }',
    '.mode { display: flex } .mode { display: grid !important } .mode[hidden] { display: none }',
  ]) assert.equal(violationsIn({ css }, markup).length, 1, css)

  for (const css of [
    '.mode { display: flex } .mode[hidden] { display: none }',
    '.mode { display: flex !important } .mode[hidden] { display: none !important }',
    '.mode[hidden] { display: none !important } .mode { display: flex !important }',
    '.mode[hidden] { display: none !important } .mode[hidden] { display: none } .mode { display: flex !important }',
    '.mode[hidden] { display: none } .mode[hidden] { display: none !important } .mode { display: flex !important }',
  ]) assert.deepEqual(violationsIn({ css }, markup), [], css)
})

test('a descendant or pseudo-element display does not override its hidden ancestor', () => {
  const markup = { 'fixture.js': 'const markup = `<details class="context" hidden><summary>Context</summary></details>`' }
  assert.deepEqual(violationsIn({ css: '.context > summary { display: flex } .context::before { display: block }' }, markup), [])
  assert.equal(violationsIn({ css: '.context { display: flex }' }, markup).length, 1)
})

test('a class or quoted attribute value named hidden is not the hidden attribute', () => {
  const markup = { js: 'const markup = `<button class="jump-chip hidden" title="kept hidden" aria-hidden="true"></button>`' }
  assert.deepEqual(violationsIn({ css: '.jump-chip { display: flex }' }, markup), [])
})

test('positive functional subject guards preserve the hidden subject but reject descendants and hostile functions', () => {
  const markup = { js: 'const markup = `<section class="home"><div class="home-agent-mode" hidden></div><div class="home-agent-chat" hidden></div></section>`' }
  const grouped = {
    css: [
      '.home :is(.home-feed-wrap, .home-chat-pane-body) .home-agent-mode { display: flex }',
      '.home :is(.home-feed-wrap, .home-chat-pane-body) .home-agent-chat { display: flex }',
      '.home :is(.home-feed-wrap, .home-chat-pane-body) :where(.home-agent-mode, .home-agent-chat)[hidden] { display: none }',
    ].join(' '),
  }
  assert.deepEqual(violationsIn(grouped, markup), [])

  const missingDisplay = { css: grouped.css.replace('display: none', 'display: block') }
  assert.equal(violationsIn(missingDisplay, markup).length, 2)

  for (const css of [
    '.mode { display: flex } .scope :is(.mode, .other)[hidden] { display: none }',
    '.scope .mode { display: flex !important } .scope :is(.mode, .other)[hidden] { display: none }',
    ':where(.mode)[hidden] { display: none } .mode { display: flex }',
  ]) assert.equal(violationsIn({ css }, {
    js: 'const markup = `<div class="mode" hidden></div>`',
  }).length, 1)

  const ancestorOnly = {
    css: '.home-agent-mode { display: flex } .home :is(.home-agent-mode .other)[hidden] { display: none }',
  }
  assert.equal(violationsIn(ancestorOnly, { js: 'const markup = `<div class="home-agent-mode" hidden></div>`' }).length, 1)

  const constrainedAlternatives = {
    css: [
      '.mode { display: flex }',
      ':is(.mode.requires, .mode:is(.other))[hidden] { display: none }',
      ':is(.mode, .other).extra[hidden] { display: none }',
      '.extra:is(.mode, .other)[hidden] { display: none }',
      ':is(.mode, .other):hover[hidden] { display: none }',
      ':is(.mode, .other)[data-state="ready"][hidden] { display: none }',
    ].join(' '),
  }
  assert.equal(violationsIn(constrainedAlternatives, {
    js: 'const markup = `<div class="mode" hidden></div>`',
  }).length, 1)

  // Constrained display selectors still carry their original outer class;
  // rejecting their nested classes must not erase that existing coverage.
  assert.equal(violationsIn({ css: '.mode:is(.ready, .busy) { display: flex }' }, {
    js: 'const markup = `<div class="mode busy" hidden></div>`',
  }).length, 1)
  assert.deepEqual(violationsIn({
    css: '.mode { display: flex } :is(:where(.mode, .other), .extra)[hidden] { display: none }',
  }, { js: 'const markup = `<div class="mode" hidden></div>`' }), [])

  for (const selector of [
    ':is(:not(.home-agent-mode), .other)',
    ':is(:has(.home-agent-mode), .other)',
  ]) {
    const hostile = {
      css: `.home-agent-mode { display: flex } .home ${selector}[hidden] { display: none }`,
    }
    assert.equal(violationsIn(hostile, { js: 'const markup = `<div class="home-agent-mode" hidden></div>`' }).length, 1)
  }
})

test('conditional hidden attributes and attributes next to interpolations keep their guard requirement', () => {
  const css = { css: '.control { display: flex }' }
  for (const tag of [
    '<button class="control" ${busy ? \'hidden\' : \'\'}></button>',
    '<button class="control" hidden${busy ? ` disabled title="${reason}"` : \'\'}></button>',
  ]) assert.equal(violationsIn(css, { js: 'const markup = `' + tag + '`' }).length, 1)
  for (const tag of [
    '<button class="control" ${hidden ? \' data-hidden\' : \'\'}></button>',
    '<button class="control" title="${busy ? \'hidden\' : \'\'}"></button>',
  ]) assert.deepEqual(violationsIn(css, { js: 'const markup = `' + tag + '`' }), [])
})

test('a scoped hidden guard covers only actual descendants and cannot beat important display', () => {
  const css = { css: '.scope [hidden] { display: none } .chooser { display: flex }' }
  const inside = { js: 'const markup = `<section class="scope"><div class="chooser" hidden></div></section>`' }
  assert.deepEqual(violationsIn(css, inside), [])
  const outside = { js: 'const markup = `<section class="scope"></section><div class="chooser" hidden></div>`' }
  assert.equal(violationsIn(css, outside).length, 1)
  assert.equal(violationsIn({ css: '.scope [hidden] { display: none } .chooser { display: flex !important }' }, inside).length, 1)
  assert.equal(violationsIn({ css: '.chooser { display: flex }' }, inside).length, 1)
  const dynamicOutside = { js: inside.js + '; const other = `<div class="chooser" data-name="${name}" hidden></div>`' }
  assert.equal(violationsIn(css, dynamicOutside).length, 1, 'an unproven second instance must retain the original guard requirement')
})
