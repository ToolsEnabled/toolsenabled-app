import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { roleGraphPosture } from '../../src/role-graph-posture.js'

const capabilities = overrides => ({
  orgRoot: false,
  singleSeat: false,
  mayClaimWork: false,
  mayWakeReports: false,
  requiresMutationContext: false,
  ...overrides,
})

test('graph rank, culling, and root dragging follow capabilities plus declared topology', () => {
  const roleCapabilities = new Map([
    ['program-lead', capabilities({ orgRoot: true, singleSeat: true })],
    ['release-captain', capabilities({ mayWakeReports: true })],
    ['controller', capabilities({})],
  ])
  const agents = [
    { id: 'lead', declaredRole: 'program-lead', parentId: null },
    { id: 'release', declaredRole: 'release-captain', parentId: 'lead' },
    { id: 'named-controller', declaredRole: 'controller', parentId: 'release' },
  ]
  for (const agent of agents) agent.orgRoot = roleCapabilities.get(agent.declaredRole).orgRoot === true
  const posture = roleGraphPosture(agents, [
    { from: 'lead', to: 'release', type: 'manages', sourceKind: 'declared' },
    { from: 'release', to: 'named-controller', type: 'manages', sourceKind: 'declared' },
  ])

  assert.equal(posture.get('lead').tierRank, 0, 'a custom root-capable role anchors the graph')
  assert.equal(posture.get('lead').cullable, false)
  assert.equal(posture.get('release').tierRank, 1, 'a custom supervisor is ranked by its declared report')
  assert.equal(posture.get('release').cullable, false)
  assert.equal(posture.get('named-controller').tierRank, 2,
    'the built-in controller name has no root mechanics when its authoritative capability is false')
  assert.equal(posture.get('named-controller').cullable, true)

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const source = fs.readFileSync(path.join(root, 'src', 'views', 'computers.js'), 'utf8')
  assert.match(source, /agent\.orgRoot/, 'dragging consults projected root capability')
  assert.doesNotMatch(source, /const tier\s*=\s*\{[^}]*controller/,
    'rank/culling no longer has a built-in role-id table')
})
