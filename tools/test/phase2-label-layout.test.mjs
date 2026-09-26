/* PAGE 2 LABEL LAYOUT — re-pointed at the surface page 2 actually renders.
 *
 * WHAT THIS FILE USED TO DO, because the failure is worth keeping written down.
 * It read src/graph.css and src/graph.js and asserted
 * `.graph-canvas .node .node-role`. `.graph-canvas` is FleetGraph's container.
 * Page 2 renders `.static-tree-node` against src/tree-graph.css and has done
 * since the page-2 redesign, so this file was named for page-2 label layout,
 * counted as page-2 coverage in the suite listing, passed on every run, and
 * asserted nothing whatsoever about page 2.
 *
 * It got worse than wrong. The agent drill-in was the last importer of
 * graph.js; when that import went, graph.css left the bundle, and the exact
 * rule asserted below the old line 15 — src/graph.css:935 — now returns
 * nothing from dist/assets/*.css. So it was matching source text in a
 * stylesheet no browser loads. It was only found because a deletion of those
 * files threw ENOENT here at module load.
 *
 * WHAT IT DOES NOW. The same three claims, against the live tree:
 *   1. the label stack is bounded by the per-node pitch budget,
 *   2. the name and role rows cannot exceed that stack, and
 *   3. the node keeps an accessible identity naming both.
 *
 * THIS IS A SOURCE CONTRACT AND SAYS SO. Source text cannot see whether a rule
 * is loaded, applied, or overridden — that is exactly how the old version
 * survived. The behavioural half lives in tools/page2-qa.cjs, which measures
 * the rendered boxes in a real window ("role sublabels stay inside the node
 * label budget"), and the two are meant to be read together: this file pins
 * the intent, that one proves it reaches glass.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = join(import.meta.dirname, '..', '..')
const treeCss = readFileSync(join(root, 'src', 'tree-graph.css'), 'utf8')
const treeJs = readFileSync(join(root, 'src', 'tree-graph.js'), 'utf8')

test('the label stack is bounded by the per-node pitch budget', () => {
  const stackRule = treeCss.match(/\.static-tree-graph \.node \.node-labels\s*\{[^}]+\}/)?.[0]
  assert.ok(stackRule, 'the .node-labels stack rule is gone — this test is checking air')
  assert.match(
    stackRule,
    /width:\s*min\(calc\(var\(--d\) \+ 118px\), var\(--nn-max, 9999px\)\)/,
    'the label stack must consume the per-node pitch budget, clamped by the measured --nn-max',
  )
})

test('the name and role rows cannot exceed the stack that bounds them', () => {
  /* Without this, a long role string widens the stack past the budget and the
     labels of adjacent nodes collide — the defect the budget exists to stop. */
  const rowRule = treeCss.match(/\.static-tree-graph \.node \.node-name,\s*\.static-tree-graph \.node \.node-role\s*\{[^}]+\}/)?.[0]
  assert.ok(rowRule, 'the shared name/role row rule is gone — this test is checking air')
  assert.match(rowRule, /max-width:\s*100%/, 'a label row must not be able to exceed its own stack')
})

test('the measured budget is written to the node that owns it', () => {
  /* THE GUARD IS PART OF THE CONTRACT, not scenery. The first version of this
     assertion matched only the setProperty call, so a mutant that changed the
     condition to `if (false)` — leaving the call present and unreachable —
     SURVIVED it. Dead code matches a text search exactly as well as live code
     does, which is the same defect this whole file was rewritten to escape.
     Anchoring the condition and the call together is what closes it. */
  assert.match(
    treeJs,
    /if \(label\?\.maxWidth\) record\.el\.style\.setProperty\('--nn-max', `\$\{label\.maxWidth\}px`\)/,
    'the layout no longer writes the measured budget, so --nn-max falls back to 9999px and the clamp is inert',
  )
  assert.match(
    treeJs,
    /record\.el\.style\.removeProperty\('--nn-max'\)/,
    'a node with no measured budget must clear the previous one rather than inherit it',
  )
})

test('a node keeps an accessible identity naming both its name and its role', () => {
  assert.match(treeJs, /<span class="node-role">\$\{escapeMarkup\(role\.label\)\}<\/span>/,
    'the role sublabel is no longer rendered')
  assert.match(
    treeJs,
    /setAttribute\('aria-label', `\$\{agent\.name\} — \$\{role\.label\}/,
    'the node lost the accessible identity that carries the role for anyone not reading the sublabel',
  )
})

test('this suite does not read the retired FleetGraph sources', () => {
  /* The whole reason this file was rewritten. Re-pointing it at the live tree
     while still reading graph.css/graph.js would keep those 3,083 lines alive
     as fixtures for a test that no longer asserts anything about them. */
  const self = readFileSync(new URL(import.meta.url), 'utf8')
  const reads = self.match(/readFileSync\(join\(root[^)]*\)/g) || []
  assert.ok(reads.length > 0, 'no source reads found — this test is checking air')
  for (const read of reads) {
    assert.ok(!/'graph\.css'|'graph\.js'/.test(read), `this suite still reads a retired FleetGraph source: ${read}`)
  }
})
