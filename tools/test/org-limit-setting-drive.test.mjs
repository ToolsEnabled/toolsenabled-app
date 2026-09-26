import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const engineRoot = process.env.TOOLSENABLED_TEST_ENGINE_ROOT || path.join(appRoot, 'capability')
const shell = require('../../shell/product-settings.cjs')

test('Save settings changes real org admission, validates values, and persists into a fresh process', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'org-limit-setting-drive-'))
  const settingsPath = path.join(directory, 'settings.json')
  const previousPath = process.env.TOOLSENABLED_SETTINGS_PATH
  const previousMaximum = process.env.MC_MAX_AGENTS
  process.env.TOOLSENABLED_SETTINGS_PATH = settingsPath
  delete process.env.MC_MAX_AGENTS
  try {
    const registryModule = require(path.join(engineRoot, 'src/lib/settings-registry.js'))
    const settingsModule = require(path.join(engineRoot, 'src/lib/settings.js'))
    const full = registryModule.loadRegistry()
    const entries = full.entries.filter(entry => ['fleet.max_declared_agents', 'fleet.concurrency_limits'].includes(entry.id))
    assert.equal(entries.length, 2, 'the tested payload must declare both organisation rows')
    const registry = { ...full, entries, byId: new Map(entries.map(entry => [entry.id, entry])) }
    const options = { root: engineRoot, load: file => file.endsWith('settings-registry.js') ? { loadRegistry: () => registry } : require(file) }
    const { createAgentOrgStore } = require(path.join(engineRoot, 'src/lib/agent-org-store.js'))
    const baseline = { revision: 1, agents: [{ id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true }], relationships: [] }
    const baselineFile = path.join(directory, 'org-baseline.json'), overlayFile = path.join(directory, 'org-overlay.json')
    writeFileSync(baselineFile, JSON.stringify(baseline))
    const store = createAgentOrgStore({ baselineFile, overlayFile })
    const large = structuredClone(baseline)
    for (let i = 1; i < 65; i++) {
      large.agents.push({ id: `worker-${i}`, displayName: `Worker ${i}`, role: 'worker', provider: 'none', enabled: true })
      large.relationships.push({ from: 'controller', to: `worker-${i}`, type: 'manages' })
    }
    assert.throws(() => store.write(large), error => error.code === 'AGENT_ORG_INVALID')
    const saved = shell.setProductSetting({ id: 'fleet.max_declared_agents', value: 65 }, options)
    assert.equal(saved.ok, true, saved.reason)
    assert.equal(store.write(large).org.agents.length, 65)
    const rows = shell.readProductSettings(options).rows
    assert.equal(rows.find(row => row.id === 'fleet.max_declared_agents').value, 65)
    const readback = rows.find(row => row.id === 'fleet.concurrency_limits')
    assert.equal(readback.control, 'readback')
    assert.match(readback.value, /not measured/)
    assert.equal(shell.setProductSetting({ id: readback.id, value: 'higher' }, options).ok, false)
    const before = readFileSync(settingsPath, 'utf8')
    for (const value of [-1, 1.5, '65']) assert.equal(shell.setProductSetting({ id: 'fleet.max_declared_agents', value }, options).ok, false)
    assert.equal(readFileSync(settingsPath, 'utf8'), before, 'invalid saves must restore the previous bytes')
    const script = `const org=require(${JSON.stringify(path.join(engineRoot, 'src/lib/agent-org.js'))});console.log(org.resolveMaxAgents());`
    assert.equal(execFileSync(process.execPath, ['-e', script], { env: process.env, encoding: 'utf8' }).trim(), '65')
    assert.equal(shell.setProductSetting({ id: 'fleet.max_declared_agents', value: 1 }, options).ok, true)
    assert.equal(store.read().org.agents.length, 65)
    assert.equal(shell.setProductSetting({ id: 'fleet.max_declared_agents', value: 0 }, options).ok, true)
    assert.equal(store.ensureSeat({ id: 'worker-65', role: 'worker', provider: 'none' }).org.agents.length, 66)
    assert.equal(settingsModule.loadSettings({ registry }).values['fleet.max_declared_agents'], 0)
  } finally {
    if (previousPath === undefined) delete process.env.TOOLSENABLED_SETTINGS_PATH
    else process.env.TOOLSENABLED_SETTINGS_PATH = previousPath
    if (previousMaximum === undefined) delete process.env.MC_MAX_AGENTS
    else process.env.MC_MAX_AGENTS = previousMaximum
  }
})
