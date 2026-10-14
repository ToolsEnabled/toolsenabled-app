'use strict'
/* ONE START OF THE OWNER HOST, IN A FRESH PROCESS, THE WAY shell/main.cjs DOES IT.
 *
 * Driven by tools/test/owner-host-start-order.test.mjs, which says why. A fresh
 * process per start is the point: plugin activation and the tool registry are
 * both once per process, so a second start in the same process would prove
 * nothing about the first.
 *
 *   node owner-host-start-order.cjs grant <state root> <package name> <capabilities as JSON>
 *     Grants through shell/plugin-catalogue.cjs -- what Save on #/plugins calls.
 *   node owner-host-start-order.cjs start <state root> <steps as JSON>
 *     Runs the steps in the order given ('plugins', 'org', 'ownerHost'), then
 *     reports what the in-process MCP server offers and what roles the
 *     organisation record lists.
 *
 * The answer is one JSON line on stdout, prefixed so that nothing else a payload
 * module prints can be mistaken for it. */
const path = require('node:path')

const MARK = 'OWNER-HOST-START-ORDER '
const [mode, stateRoot, first, second] = process.argv.slice(2)
if (!stateRoot || !path.isAbsolute(stateRoot)) throw new Error('An absolute state root is required.')

// main.cjs, in its own order: scrub the capability path overrides, then publish
// the state root and the vault path, before any capability code is loaded.
require('../../../shell/capability-path-environment.cjs').scrubCapabilityPathOverrides(process.env)
process.env.TOOLSENABLED_STATE_ROOT = stateRoot
process.env.TOOLSENABLED_VAULT_PATH = path.join(stateRoot, 'vault', 'secrets.json')

const layer = require('../../../shell/capability-layer.cjs')

function report(value) {
  process.stdout.write(`${MARK}${JSON.stringify(value)}\n`)
}

async function grant() {
  const { createPluginCatalogue, makeLoader } = require('../../../shell/plugin-catalogue.cjs')
  const catalogue = createPluginCatalogue({ load: makeLoader({ capabilityRoot: layer.resolveCapabilityRoot, stateRoot }) })
  const listed = catalogue.list()
  if (!listed.ok) return { listed: { ok: false, code: listed.code } }
  const entry = listed.packages.find(candidate => candidate.name === first)
  const granted = entry ? catalogue.grant({ sha256: entry.sha256, capabilities: JSON.parse(second) }) : null
  return {
    listed: { ok: true, names: listed.packages.map(candidate => candidate.name), refused: listed.refused.map(item => item.code) },
    granted: granted && { ok: granted.ok, code: granted.code || null, capabilities: granted.capabilities || null },
  }
}

async function start() {
  const root = layer.resolveCapabilityRoot()
  const steps = JSON.parse(first)
  const out = { root: Boolean(root), steps }
  let org = null
  let host = null
  for (const step of steps) {
    if (step === 'plugins') {
      const brought = layer.activatePayloadPlugins({ root })
      out.plugins = brought.ok
        ? { ok: true, activated: brought.status.activated.map(entry => entry.name), refused: brought.status.refused.map(entry => entry.code) }
        : { ok: false, code: brought.code }
    } else if (step === 'org') {
      org = require('../../../shell/agent-org-record.cjs').createAgentOrgRecord()
    } else if (step === 'ownerHost') {
      const started = await layer.startAppOwnedOwnerHost({ root })
      out.ownerHost = { ok: started.ok === true, code: started.code || null }
      if (started.ok) host = started.host
    } else {
      throw new Error(`Unknown step ${step}.`)
    }
  }
  if (host) {
    // The broker the owner host itself loaded: owner-host.js requires it, so it is
    // already in require.cache, and this is the same module and the same registry.
    const brokerFile = require.resolve(path.join(root, 'src', 'mcp-server.js'))
    out.brokerLoadedByOwnerHost = Boolean(require.cache[brokerFile])
    const listed = await require(brokerFile).dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, {})
    out.mcpTools = listed.tools.map(tool => tool.name).sort()
  }
  if (org) {
    const read = org.read()
    out.org = read.ok ? { ok: true, roles: read.roles.map(role => role.id) } : { ok: false, code: read.code }
  }
  if (host) await layer.stopAppOwnedOwnerHost(host)
  return out
}

;(mode === 'grant' ? grant() : mode === 'start' ? start() : Promise.reject(new Error(`Unknown mode ${mode}.`)))
  .then((value) => { report(value); process.exit(0) })
  .catch((error) => { report({ error: String(error && error.stack || error) }); process.exit(1) })
