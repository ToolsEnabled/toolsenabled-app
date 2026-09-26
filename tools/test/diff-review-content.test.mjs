import test from 'node:test'
import assert from 'node:assert/strict'
import { mountRecordedPatch, recordedPatchRows } from '../../src/diff-presentation.js'

function view(patches) {
  const nodes = []
  const document = { createElement(tag) {
    const node = { tag, attributes: {}, children: [], textContent: '',
      setAttribute(name, value) { this.attributes[name] = String(value) },
      appendChild(child) { this.children.push(child); return child } }
    Object.defineProperty(node, 'innerHTML', { set() { assert.fail('Recorded source must remain literal text') } })
    nodes.push(node)
    return node
  } }
  const root = document.createElement('div')
  mountRecordedPatch(root, patches, document)
  return { root, nodes, withClass: name => nodes.filter(node => (node.attributes.class || '').split(' ').includes(name)),
    text: () => nodes.map(node => node.textContent).join('\n') }
}

test('recorded hunks explain both line ranges and preserve the supplied function context', () => {
  const rendered = view([{ diff: '@@ -10,3 +10,4 @@ function allow(account) {\n same\n-old\n+new\n+extra\n tail\n@@ -30 +31 @@ nextStep()\n-before\n+after\n' }])
  assert.deepEqual(rendered.withClass('diff-hunk-range').map(node => node.textContent), [
    'Before lines 10–12 → After lines 10–13', 'Before line 30 → After line 31',
  ])
  assert.deepEqual(rendered.withClass('diff-hunk-context').map(node => node.textContent), ['function allow(account) {', 'nextStep()'])
  assert.match(rendered.text(), /Other file sections are omitted/)
  assert.deepEqual(rendered.withClass('diff-line-code').map(node => node.textContent), ['same', 'old', 'new', 'extra', 'tail', 'before', 'after'])
})

test('zero-length hunk ranges describe insertion/deletion anchors without inventing line zero', () => {
  const created = view([{ diff: '@@ -0,0 +1,2 @@\n+first\n+second\n' }])
  assert.equal(created.withClass('diff-hunk-range')[0]?.textContent, 'Before: start of file → After lines 1–2')
  const inserted = view([{ diff: '@@ -40,0 +41 @@\n+inserted\n' }])
  assert.equal(inserted.withClass('diff-hunk-range')[0]?.textContent, 'Before: after line 40 → After line 41')
  const removed = view([{ diff: '@@ -41 +40,0 @@\n-removed\n' }])
  assert.equal(removed.withClass('diff-hunk-range')[0]?.textContent, 'Before line 41 → After: after line 40')
})

test('sequential recorded edits keep their own Before/After basis instead of implying current-file coordinates', () => {
  const rendered = view([{ diff: '@@ -1 +1 @@\n-old\n+middle\n' }, { diff: '@@ -1 +1 @@\n-middle\n+new\n' }])
  assert.deepEqual(rendered.withClass('diff-line-record').flatMap(node => node.children.map(child => child.textContent)), [
    'Recorded edit 1 of 2', 'Recorded edit 2 of 2',
  ])
  assert.match(rendered.text(), /Before and After refer to each recorded edit, not the current file/)
  assert.deepEqual(rendered.withClass('diff-line-code').map(node => node.textContent), ['old', 'middle', 'middle', 'new'])
})

test('inconsistent hunk counts retain the patch as text without inventing numbered source rows', () => {
  const diff = '@@ -4,2 +4,1 @@\n-first\n+new\n+unexpected extra line\n-last\n'
  const result = recordedPatchRows([{ diff }])
  assert.equal(result.rows.some(row => ['added', 'removed', 'context'].includes(row.kind)), false)
  for (const line of diff.trimEnd().split('\n')) assert.ok(result.rows.some(row => row.text === line))
  const rendered = view([{ diff }])
  assert.match(rendered.text(), /Line numbers are unavailable/)
  assert.match(rendered.text(), /unexpected extra line/)
})

test('a bounded recorded preview never promises unavailable reconstructed or current file versions', () => {
  const source = Array.from({ length: 2100 }, (_, index) => `+line ${index + 1}`).join('\n')
  const rendered = view([{ diff: `@@ -0,0 +1,2100 @@\n${source}\n` }])
  const notice = rendered.withClass('diff-patch-limit')[0]?.textContent
  assert.match(notice || '', /first 2,000 patch lines/)
  assert.match(notice, /Remaining patch lines are not shown/)
  assert.doesNotMatch(notice, /full file|versions below|remain available/)
  assert.equal(rendered.withClass('diff-line-code').length, 1999)
})

test('an empty retained patch says that source lines are absent without claiming an empty file', () => {
  const rendered = view([{ diff: '' }])
  assert.match(rendered.text(), /No source lines were retained in this patch/)
  assert.equal(rendered.withClass('diff-line-code').length, 0)
  assert.doesNotMatch(rendered.text(), /file is empty|no changes/i)
})
