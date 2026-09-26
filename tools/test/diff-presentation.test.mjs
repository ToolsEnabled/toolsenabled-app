import test from 'node:test'
import assert from 'node:assert/strict'
import { mountRecordedPatch, recordedPatchRows } from '../../src/diff-presentation.js'
import { compareVersionLines, mountLiveComparison } from '../../src/diff-live.js'

test('live comparison preserves both versions, line numbers, repeated lines and final newlines', () => {
  const pairs = [['', 'new\n'], ['removed\n', ''], ['same\n', 'same'],
    ['a\na\nb\n', 'a\nb\na\n'], ['<script>\nold\n', '<img>\nnew\n'],
    [Array(800).fill('before\n').join(''), Array(800).fill('after\n').join('')]]
  for (const [before, after] of pairs) {
    const result = compareVersionLines(before, after)
    for (const [side, excluded, text] of [['before', 'added', before], ['after', 'removed', after]]) {
      const rows = result.rows.filter(row => row.kind !== excluded)
      assert.equal(rows.map(row => row.text + (row.newline ? '\n' : '')).join(''), text)
      assert.deepEqual(rows.map(row => row[side]), rows.map((_, i) => i + 1))
    }
  }
  assert.equal(compareVersionLines(pairs.at(-1)[0], pairs.at(-1)[1]).block, true)
  const diff = compareVersionLines('first\nold\nlast\n', 'first\nnew\nlast\n')
  assert.deepEqual([diff.added, diff.removed], [1, 1])
})

test('live comparison inserts source as literal text and links changed lines to the correct editor', () => {
  const nodes = [], doc = {createElement(tag) {
    const node = {tag, attributes:{}, children:[], setAttribute(k,v){this.attributes[k]=v}, appendChild(n){this.children.push(n)}}
    Object.defineProperty(node,'innerHTML',{set(){assert.fail('Source entered HTML parser')}})
    nodes.push(node); return node
  }}
  const host=doc.createElement('div')
  mountLiveComparison(host, 'old\n', '<script>bad()</script>\n', doc)
  assert.equal(nodes.find(n=>n.tag==='code'&&n.textContent.includes('<script>')).textContent,'<script>bad()</script>')
  assert.deepEqual(nodes.filter(n=>n.tag==='button').map(n=>[n.attributes['data-diff-side'],n.attributes['data-diff-line']]),[['original','1'],['proposed','1']])
})

test('recorded patch numbers stay aligned through additions, deletions and separate hunks', () => {
  const { rows, limited } = recordedPatchRows([{ diff: '--- a/a.js\n+++ b/a.js\n@@ -10,3 +10,4 @@ heading\n same\n-old\n+new\n+extra\n tail\n@@ -30 +31 @@\n-before\n+after\n' }])
  assert.equal(limited, false)
  assert.deepEqual(rows.filter(row => ['added', 'removed', 'context'].includes(row.kind)).map(({ kind, text, before, after }) => [kind, text, before, after]), [
    ['context', 'same', 10, 10], ['removed', 'old', 11, null], ['added', 'new', null, 11], ['added', 'extra', null, 12], ['context', 'tail', 12, 13],
    ['removed', 'before', 30, null], ['added', 'after', null, 31],
  ])
  assert.equal(rows.filter(row => row.kind === 'hunk').length, 2)
})

test('file creation, deletion and newline metadata do not invent source line numbers', () => {
  const created = recordedPatchRows([{ diff: '@@ -0,0 +1,2 @@\n+first\n+last\n\\ No newline at end of file\n' }]).rows
  assert.deepEqual(created.filter(row => row.kind === 'added').map(row => [row.before, row.after]), [[null, 1], [null, 2]])
  assert.equal(created.at(-1).kind, 'note')
  const removed = recordedPatchRows([{ diff: '@@ -1,2 +0,0 @@\n-first\n-last\n' }]).rows
  assert.deepEqual(removed.filter(row => row.kind === 'removed').map(row => [row.before, row.after]), [[1, null], [2, null]])
  assert.deepEqual(recordedPatchRows([{ diff: '--- a/file\n+++ b/file\n+metadata\n' }]).rows, [{ kind: 'note', text: '+metadata' }])
})

test('preview limits are truthful at an exact boundary and apply across recorded edits', () => {
  const first = { diff: '@@ -1 +1 @@\n-old\n+new\n' }
  assert.equal(recordedPatchRows([first], 3).limited, false)
  assert.equal(recordedPatchRows([first], 2).limited, true)
  const multiple = recordedPatchRows([first, { diff: '@@ -1 +1 @@\n-new\n+last\n' }], 4)
  assert.equal(multiple.limited, true)
  assert.equal(multiple.rows.filter(row => row.kind === 'record').length, 2)
  assert.equal(multiple.rows.at(-1).kind, 'hunk')
})

test('patch code is inserted as literal text and additions are announced independently of color', () => {
  const nodes = []
  const doc = { createElement(tag) {
    const node = { tag, attributes: {}, children: [], setAttribute(key, value) { this.attributes[key] = value }, appendChild(child) { this.children.push(child) } }
    Object.defineProperty(node, 'innerHTML', { set() { assert.fail('patch text entered the HTML parser') } })
    nodes.push(node)
    return node
  } }
  const host = doc.createElement('div')
  const code = '<img src=x onerror=alert(1)>'
  mountRecordedPatch(host, [{ diff: `@@ -0,0 +1 @@\n+${code}\n` }], doc)
  assert.equal(nodes.find(node => node.tag === 'code').textContent, code)
  assert.ok(nodes.some(node => node.attributes['aria-label'] === `Added, line 1: ${code}`))
  assert.equal(nodes.some(node => node.tag === 'img'), false)
})
