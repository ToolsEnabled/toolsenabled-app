import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const TOOLS_DIRECTORY = path.resolve(TEST_DIRECTORY, '..')

const DIRECT_RESOLVER_DRIVERS = Object.freeze([
  'agent-route-reachability.mjs',
  'cloud-launch-packaged-qa.mjs',
  'org-persistence-proof.mjs',
  'performance-budget-qa.mjs',
  'recommended-path-packaged-qa.mjs',
  'setup-walkthrough-qa.mjs',
  'spine-defects-drive.mjs',
  'team-panel-packaged-qa.mjs',
  'unrestricted-consent-qa.mjs',
])

const CHANGED_DRIVERS = Object.freeze([
  ...DIRECT_RESOLVER_DRIVERS,
  'uninstall-reset-packaged-qa.mjs',
])

function executableCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('packaged QA drivers do not restore the shipping-name service-root literal', async () => {
  for (const name of CHANGED_DRIVERS) {
    const source = executableCode(await readFile(path.join(TOOLS_DIRECTORY, name), 'utf8'))
    assert.doesNotMatch(
      source,
      /path\.join\([^\n;]{0,120}(?:'|")local(?:'|")[^\n;]{0,120}(?:'|")ToolsEnabled(?:'|")/,
      `${name} still selects a service root by the shipping product name`,
    )
    assert.doesNotMatch(
      source,
      /path\.join\([^\n;]{0,120}localAppData[^\n;]{0,120}(?:'|")ToolsEnabled(?:'|")/,
      `${name} still selects a LOCALAPPDATA service root by the shipping product name`,
    )
  }
})

test('each direct reader/writer asks the selected payload resolver', async () => {
  for (const name of DIRECT_RESOLVER_DRIVERS) {
    const source = executableCode(await readFile(path.join(TOOLS_DIRECTORY, name), 'utf8'))
    assert.match(source, /resolveMachineServicesRoot\s*\(/, `${name} does not use the shared measured resolver seam`)
  }

  const uninstall = executableCode(await readFile(path.join(TOOLS_DIRECTORY, 'uninstall-reset-packaged-qa.mjs'), 'utf8'))
  assert.match(
    uninstall,
    /const\s+servicesRoot\s*=\s*seedMachineRecord\s*\(/,
    'the reset drive must retain the exact service root returned by the shared payload-backed seed',
  )
})

test('the Node-mode persistence proof explicitly declares the selected userData state root', async () => {
  const source = executableCode(await readFile(path.join(TOOLS_DIRECTORY, 'org-persistence-proof.mjs'), 'utf8'))
  assert.match(source, /TOOLSENABLED_STATE_ROOT:\s*path\.join\(profile\.userData,\s*'capability'\)/)
  assert.match(source, /selectedUserData:\s*profile\.userData/)
  assert.match(source, /localAppData:\s*profile\.localAppData/)
})

test('changed drivers parse without launching providers, installers, windows, or reset controls', () => {
  for (const name of CHANGED_DRIVERS) {
    const file = path.join(TOOLS_DIRECTORY, name)
    const checked = spawnSync(process.execPath, ['--check', file], {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        ELECTRON_NO_ATTACH_CONSOLE: undefined,
      },
    })
    assert.equal(checked.status, 0, `${name} did not parse:\n${checked.stderr || checked.stdout}`)
  }
})
