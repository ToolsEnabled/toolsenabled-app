import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { artifactProofCounts, discoverDrivers, planFor, releaseArgumentsFor } from '../packaged-qa-suite.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const toolSource = name => readFileSync(path.join(HERE, '..', name), 'utf8')

test('credential waiting proof plants the queue in the shell userData capability root', () => {
  const source = toolSource('credential-waiting-visible-qa.mjs')
  assert.match(source, /path\.join\(userDataFor\(profile\), 'capability'\)/)
  assert.doesNotMatch(source, /path\.join\(profile, 'roaming', 'ToolsEnabled', 'capability'\)/)
})

test('packaged compose drivers press the current Start control', () => {
  for (const name of ['context-window-drive.mjs', 'four-defects-drive.mjs']) {
    const source = toolSource(name)
    assert.match(source, /data-compose-action=[\\"']start[\\"']/,
      `${name} must exercise the Start half of Set/Start`)
    assert.doesNotMatch(source, /data-compose-action=[\\"']submit[\\"']/,
      `${name} must not wait for the removed submit control`)
  }
})

test('compose layout consumes requested candidate CSS without claiming exact-candidate UI evidence', () => {
  const entry = planFor(discoverDrivers()).find(candidate => candidate.name === 'compose-start-layout-qa.cjs')
  assert.ok(entry)
  assert.equal(entry.runner, 'electron')
  assert.equal(entry.artifactProof, 'instrumented-copy',
    'candidate CSS in handmade panel HTML is a layout fixture, not the packaged UI')
  assert.deepEqual(artifactProofCounts([{ ...entry, verdict: 'PASS' }]),
    { exact: 0, instrumented: 1, unclassified: 0 },
    'a passing layout fixture must never contribute exact-artifact evidence')
  const source = toolSource(entry.name)
  assert.deepEqual(releaseArgumentsFor(source, 'C:\\candidate'), ['--release', 'C:\\candidate'])
  assert.deepEqual(releaseArgumentsFor(source, null), [],
    'without an explicit release the fixture is not bound to a candidate')
  assert.match(source, /readComposeLayoutCss\(\{ argv: process\.argv, repoRoot: ROOT \}\)/)
  assert.doesNotMatch(source, /path\.join\(ROOT, 'dist'\)/,
    'the driver must not ignore a requested release and read only checkout dist')
})

test('every discovered packaged driver and the shared fleet helper reject the removed submit action', () => {
  const candidates = [
    ...planFor(discoverDrivers()).map(entry => entry.file),
    path.join(HERE, '..', 'lib', 'fleet-node.mjs'),
  ]
  const staleSelector = /data-compose-action\s*=\s*\\?["']submit\\?["']/
  const stale = candidates.filter(file => staleSelector.test(readFileSync(file, 'utf8')))
  assert.deepEqual(stale, [], `removed executable submit selector remains in: ${stale.join(', ')}`)

  for (const name of [
    'agent-start-flow-qa.mjs',
    'compose-start-layout-qa.cjs',
    'cut-check-drive.mjs',
    'inside-agents-drive.mjs',
    'order-variation-drive.mjs',
    'owner-walkthrough-drive.mjs',
    'tree-panel-audit-drive.mjs',
  ]) {
    assert.match(toolSource(name), /data-compose-action=[\\"']start[\\"']/,
      `${name} lost its semantic Start target while the stale selector was removed`)
  }
  assert.match(readFileSync(path.join(HERE, '..', 'lib', 'fleet-node.mjs'), 'utf8'),
    /data-compose-action=[\\"']start[\\"']/)
})

test('loop and four-defects derive the machine-record directory from userData identity', () => {
  const loop = toolSource('loop-packaged-qa.mjs')
  const defects = toolSource('four-defects-drive.mjs')
  for (const [name, source] of [['loop-packaged-qa.mjs', loop], ['four-defects-drive.mjs', defects]]) {
    assert.match(source, /machineRecordProductDirectory\(profile\)/,
      `${name} must share the harness product-directory rule`)
    assert.doesNotMatch(source, /path\.join\(profile, 'local', 'ToolsEnabled'/,
      `${name} must not seed the obsolete literal product directory`)
  }
})

test('agent start flow delegates active navigation and consumes every route rebuild result', () => {
  const source = toolSource('agent-start-flow-qa.mjs')
  assert.match(source, /import \{ activeRouteDescendantExpression, activeRouteExpression \} from '\.\/lib\/active-route-navigation\.mjs'/,
    'the driver must use the behavior-tested active-route predicates')
  assert.match(source, /const goToFleet = async \(\) =>/,
    'Fleet navigation must not expose a route parameter with hardcoded Fleet arrival criteria')
  assert.match(source, /const leftFleet = await until\(HOME_ACTIVE_EXPRESSION, VIEW_BUDGET_MS\)[\s\S]*?if \(!leftFleet\) return false[\s\S]*?if \(!await evaluate\(HOME_ACTIVE_EXPRESSION\)\) return false/,
    'a rebuild must arrive at Home and remain there after settling before returning to Fleet')
  assert.equal([...source.matchAll(/if \(!await app\.goToFleet\(\)\)/g)].length, 1,
    'the initial Fleet arrival result must be consumed exactly once')
  assert.equal([...source.matchAll(/if \(!await app\.renavigateFleet\(\)\)/g)].length, 1,
    'the shared control rebuild must consume navigation failure; providerless QA has no fake attachment pass')
  assert.equal([...source.matchAll(/await runControl\(app, CONTROL_/g)].length, 3,
    'all three self-audit controls must still rebuild through the checked navigation helper')
  assert.doesNotMatch(source, /stubStartScript|ATTACH_CHECKS|__qaRealAgent/,
    'the removed second rebuild must not return as a fake contextBridge attachment pass')
  assert.match(source, /all\(root, '\[data-compose-unavailable-action="panel"\]'\)\.find\(shown\)/,
    'the switch press must skip retiring matches and stay inside the active Fleet root')
  assert.match(source, /fleetPanelExpression\(\{ switchedOn: true \}\)/,
    'the post-switch wait must require the active panel\'s semantic transition')
})

test('dirty release drivers require an explicit Playwright kit and carry no owner or stale provenance fallback', () => {
  for (const name of ['owner-walkthrough-drive.mjs', 'cut-check-drive.mjs']) {
    const source = toolSource(name)
    assert.match(source, /MC_PLAYWRIGHT_ROOT must name the authorized Playwright test kit/,
      `${name} must fail closed when the test kit is not explicitly authorized`)
    assert.doesNotMatch(source, /C:[\\/]+Users[\\/]+[^'"`\s]+[\\/]+AppData[\\/]+Local[\\/]+Temp[\\/]+pw-browsers/i,
      `${name} embeds an executable owner-profile fallback`)
  }

  const phone = toolSource('phone-sheet-geometry-qa.mjs')
  assert.match(phone, /TESTKIT_PLAYWRIGHT_ROOT must name the authorized Playwright test kit/)
  assert.doesNotMatch(phone, /C:[\\/]+Users[\\/]+/i,
    'phone-sheet geometry QA embeds an owner-profile Playwright fallback')

  const claude = toolSource('claude-tree-start-proof.mjs')
  assert.doesNotMatch(claude, /ENGINE_SOURCE|C:[\\/]+Users[\\/]+/i,
    'Claude tree proof borrows engine code from an owner-profile checkout')
  assert.match(claude, /the staged candidate is missing its Claude engine module\(s\)/,
    'Claude tree proof must fail closed when the candidate lacks its own engine')

  for (const name of [
    'owner-walkthrough-drive.mjs',
    'cut-check-drive.mjs',
    'recommended-path-packaged-qa.mjs',
  ]) {
    const source = toolSource(name)
    assert.doesNotMatch(source, /MEASURED on the installed|STANDING-ORDERS/i,
      `${name} contains stale release provenance or coordination text`)
  }
})
