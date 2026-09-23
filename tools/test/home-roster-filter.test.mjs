import test from 'node:test'
import assert from 'node:assert/strict'
import { filterRosterGroups } from '../../src/home-roster-filter.js'

const groups = [{ key: 'tree-a', lines: [
  { key: 'writer', name: 'Writer', state: 'working', task: 'Update guide', detail: 'using Bash' },
  { key: 'review', name: 'Review', state: 'attention', task: 'Check guide', waiting: 'Approve wording' },
], rest: [{ key: 'idle', name: 'Idle', state: 'idle', history: ['Read the old guide'] }] }]

test('search combines words across task and live tool, case insensitively', () => {
  const result = filterRosterGroups(groups, { query: '  GUIDE bash ' })
  assert.deepEqual(result.groups[0].lines.map(line => line.key), ['writer'])
  assert.equal(result.count, 1)
  assert.equal(result.active, true)
})
test('status and search intersect; unmatched groups disappear', () => {
  assert.equal(filterRosterGroups(groups, { query: 'approve', status: 'attention' }).count, 1)
  assert.deepEqual(filterRosterGroups(groups, { query: 'approve', status: 'working' }).groups, [])
})
test('resting agents are searchable and clearing restores all scoped agents without mutation', () => {
  assert.equal(filterRosterGroups(groups, { query: 'old guide' }).groups[0].rest[0].key, 'idle')
  assert.equal(groups[0].rest.length, 1)
  const reset = filterRosterGroups(groups)
  assert.equal(reset.count, 3)
  assert.equal(reset.active, false)
  assert.deepEqual(reset.groups[0].lines, groups[0].lines)
})
