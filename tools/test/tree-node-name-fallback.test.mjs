import assert from 'node:assert/strict'
import test from 'node:test'

import { layoutTree } from '../../src/tree-layout.js'

// F10 / R13 / OD14 / N7: "readable circle names (name and role visible, id
// only in details)". A circle whose agent record carries no `name` fell all
// the way through to its raw internal id -- e.g.
// "node-2-4f48943d-2226-49a8-9e81-ede569f6c999" painted whole, as the entire
// visible label AND the hover title, on a lone record (no siblings, so
// labelFor()'s pitch-budget truncation never even runs). That is the opposite
// of readable: the one piece of text on the circle identifies nothing a
// person recognises. This is a renderer fallback fix only -- it invents no
// name; a node that already carries a name is untouched.
test('a node with no name falls back to something a person can read, never its raw id', () => {
  const id = 'node-2-4f48943d-2226-49a8-9e81-ede569f6c999'
  const result = layoutTree({ nodes: [{ id, role: 'coordinator', parentId: null }], W: 800, H: 600 })
  const label = result.labels.get(id)
  assert.ok(label, 'the lone node must still receive a label')
  assert.notEqual(label.text, id, 'the circle must not show its own internal id as its name')
  assert.match(label.text, /coordinator/i, 'the fallback must still say what kind of agent this is')
})

test('a multi-word declared role still reads as words, not a hyphenated key', () => {
  const id = 'node-3-declared-role-node'
  const result = layoutTree({ nodes: [{ id, role: 'shadow-manager', parentId: null }], W: 800, H: 600 })
  const label = result.labels.get(id)
  assert.doesNotMatch(label.text, /-/, 'a role key\'s hyphen must not leak into the displayed name')
}
)

test('a node that already carries a name is never overridden by the fallback', () => {
  const id = 'child-1'
  const result = layoutTree({
    nodes: [
      { id: 'root', role: 'coordinator', parentId: null },
      { id, role: 'worker', parentId: 'root', name: 'Worker 5' },
    ],
    W: 800,
    H: 600,
  })
  assert.equal(result.labels.get(id).text, 'Worker 5')
})
