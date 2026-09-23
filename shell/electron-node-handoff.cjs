'use strict'

const path = require('node:path')

const ARGUMENT_CODE = 'ELECTRON_NODE_HANDOFF_ARGUMENT_REFUSED'

/* Compatibility for MCP documents written by an older build. The only valid
 * grammar is:
 *
 *   ToolsEnabled.exe <shipped-resource-script> [script arguments...]
 *
 * In ELECTRON_RUN_AS_NODE mode Electron 43 still accepts Node's --inspect
 * family even when EnableNodeCliInspectArguments is fused off. Therefore no
 * argument may precede the selected script. Arguments after it belong to the
 * script and Node does not parse them as runtime switches. This parser runs in
 * the GUI parent; the unsafe argv is never forwarded to the Node-mode child. */
function electronNodeHandoff({
  environment = process.env,
  resourcesPath = process.resourcesPath,
  argv = process.argv,
} = {}) {
  if (environment && environment.ELECTRON_RUN_AS_NODE === '1') return null
  if (typeof resourcesPath !== 'string' || resourcesPath === '') return null
  const root = path.resolve(resourcesPath)
  const forwarded = Array.isArray(argv) ? argv.slice(1) : []
  const scriptIndex = forwarded.findIndex((argument) => {
    if (typeof argument !== 'string' || !/\.[cm]?js$/i.test(argument)) return false
    const resolved = path.resolve(argument)
    /* Windows path identity is case-insensitive. A literal startsWith() made a
       legacy document written as `c:\...` miss the handoff when Electron
       reported `C:\...`, opening the GUI instead of the requested server. The
       platform path implementation's relative() applies the host filesystem's
       drive/case rules while the explicit dot-dot checks preserve the escape
       and prefix-collision fence. */
    const relative = path.relative(root, resolved)
    return Boolean(relative)
      && !path.isAbsolute(relative)
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
  })
  if (scriptIndex < 0) return null
  if (scriptIndex !== 0) {
    return Object.freeze({
      ok: false,
      code: ARGUMENT_CODE,
      message: 'ToolsEnabled refused an obsolete agent-server command because a runtime option appeared before its shipped script.',
    })
  }
  return Object.freeze({ ok: true, forwarded: Object.freeze([...forwarded]) })
}

module.exports = Object.freeze({ ARGUMENT_CODE, electronNodeHandoff })
