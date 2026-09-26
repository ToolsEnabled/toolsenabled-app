import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readSource = relative => readFileSync(new URL(`../../src/${relative}`, import.meta.url), 'utf8')
const styles = readSource('styles.css')
const treeGraph = readSource('tree-graph.css')
const ledger = readSource('ledger.css')

function ruleBody(css, selector) {
  const match = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 's'))
  assert.ok(match, `missing CSS rule for ${selector}`)
  return match[1]
}

function assertDefined(...tokens) {
  for (const token of tokens) {
    assert.match(styles, new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`), `${token} must remain a defined theme token`)
  }
}

test('tree-strip scroll controls use defined surface, radius, ink, and hover tokens', () => {
  const base = ruleBody(treeGraph, '.computers .graph-bar-trees > .graph-tree-scroll')
  const hover = ruleBody(treeGraph, '.computers .graph-bar-trees > .graph-tree-scroll:hover:not(:disabled)')

  assert.match(base, /border-radius:\s*var\(--r-sm\)\s*;/)
  assert.match(base, /background:\s*var\(--sheet\)\s*;/)
  assert.match(hover, /color:\s*var\(--ink\)\s*;/)
  assert.match(hover, /border-color:\s*var\(--ink-3\)\s*;/)
  assert.doesNotMatch(`${base}\n${hover}`, /var\(--(?:r1|surface-1|ink-1|line-1)\)/)
  assertDefined('--r-sm', '--sheet', '--ink', '--ink-3')
})

test('chat diff counters use the shipped semantic status colors', () => {
  const additions = ruleBody(styles, '[data-chat-diff-card] [data-chat-diff-additions]')
  const deletions = ruleBody(styles, '[data-chat-diff-card] [data-chat-diff-deletions]')

  assert.match(additions, /color:\s*var\(--s-good\)\s*;/)
  assert.match(deletions, /color:\s*var\(--s-serious\)\s*;/)
  assertDefined('--s-good', '--s-serious')
})

test('projection service chips fall back to their inherited projection color', () => {
  const chip = ruleBody(styles, '.task-chip')
  const dot = ruleBody(styles, '.task-chip i')

  assert.match(chip, /border:\s*1px solid color-mix\(in oklab, var\(--tc, var\(--rc\)\) 38%, white\)\s*;/)
  assert.match(dot, /background:\s*var\(--tc, var\(--rc\)\)\s*;/)
})

test('top-level ledger questions keep the base id inset when depth is absent', () => {
  const idCell = ruleBody(ledger, '.ledger-id-cell')

  assert.match(idCell, /padding-left:\s*calc\(22px \+ var\(--depth, 0\) \* 20px\)\s*;/)
})
