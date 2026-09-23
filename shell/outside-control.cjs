'use strict'
/* OUTSIDE CONTROL, THE SHELL'S HALF.
 *
 * The engine decides (src/lib/outside-control.js reads the `app.outside_control`
 * setting under its provenance rule); this file turns that decision into the
 * one thing Electron understands, a command-line switch, and does so exactly
 * once, before the app is ready, because Chromium reads `remote-debugging-port`
 * at browser start and nothing can open it later. That is also why the settings
 * page has to say "from the next time the app starts": the shell reports what it
 * did at THIS start beside the value, and the page draws both.
 *
 * Two rules, both testable without Electron:
 *   - a port already on the command line wins. That is a person or a test
 *     asking for a specific port, and a setting must not fight it; the report
 *     says `why: 'command-line'` so the page can say so too.
 *   - every failure to read is a closed port with a code and a reason, never a
 *     throw at startup. An app that refuses to start because a setting could not
 *     be read would be worse than an app that starts with the port shut.
 *
 * Owner, 2026-09-02: "the version on my computer SHOULD allow you an agent to
 * touch buttons from the outside and this should be a setting not a standard". */
const path = require('node:path')
const { resolveCapabilityRoot } = require('./capability-layer.cjs')

const OUTSIDE_CONTROL_MODULE = 'src/lib/outside-control.js'
const PORT_SWITCH = 'remote-debugging-port'
const ADDRESS_SWITCH = 'remote-debugging-address'

function shut(code, reason, extra = {}) {
  return Object.freeze({ available: false, enabled: false, port: null, address: null, code, reason, ...extra })
}

/**
 * Ask the payload whether outside control is on. Never throws.
 */
function resolveOutsideControl({ root = resolveCapabilityRoot(), load = require } = {}) {
  if (!root) {
    return shut('OUTSIDE_CONTROL_PAYLOAD_ABSENT', 'No capability payload is present, so nothing can read the outside-control setting; the port stays shut.')
  }
  let policy
  try {
    policy = load(path.join(root, OUTSIDE_CONTROL_MODULE))
  } catch (error) {
    return shut('OUTSIDE_CONTROL_MODULE_ABSENT', `The capability payload does not carry ${OUTSIDE_CONTROL_MODULE} (${error.message}); the port stays shut.`)
  }
  if (typeof policy?.outsideControlPolicy !== 'function') {
    return shut('OUTSIDE_CONTROL_MODULE_INVALID', `${OUTSIDE_CONTROL_MODULE} does not export outsideControlPolicy(); the port stays shut.`)
  }
  let decision
  try {
    decision = policy.outsideControlPolicy()
  } catch (error) {
    return shut('OUTSIDE_CONTROL_UNREADABLE', `The outside-control setting could not be read (${error.message}); the port stays shut.`)
  }
  return Object.freeze({
    available: true,
    enabled: decision?.enabled === true,
    port: Number.isInteger(decision?.port) ? decision.port : null,
    address: typeof decision?.address === 'string' && decision.address ? decision.address : '127.0.0.1',
    code: null,
    reason: typeof decision?.reason === 'string' ? decision.reason : null,
    source: typeof decision?.source === 'string' ? decision.source : null,
  })
}

/**
 * Apply a decision to Electron's command line. Returns what happened, for the
 * settings page: `applied` says whether THIS start opened the port from the
 * setting; `why` is 'setting', 'command-line' (a port was already named, and
 * it wins), or 'off'.
 */
function applyOutsideControl(commandLine, decision) {
  if (commandLine.hasSwitch(PORT_SWITCH)) {
    const named = Number.parseInt(commandLine.getSwitchValue(PORT_SWITCH), 10)
    return Object.freeze({ applied: false, why: 'command-line', port: Number.isInteger(named) ? named : null })
  }
  if (!decision || decision.enabled !== true || !Number.isInteger(decision.port)) {
    return Object.freeze({ applied: false, why: 'off', port: null })
  }
  commandLine.appendSwitch(PORT_SWITCH, String(decision.port))
  commandLine.appendSwitch(ADDRESS_SWITCH, decision.address || '127.0.0.1')
  return Object.freeze({ applied: true, why: 'setting', port: decision.port })
}

/**
 * The whole thing, for main.cjs: decide, apply, and return one frozen account
 * of both for the settings page.
 */
function startOutsideControl(commandLine, options = {}) {
  const decision = resolveOutsideControl(options)
  const applied = applyOutsideControl(commandLine, decision)
  return Object.freeze({ ...decision, ...applied })
}

/* The switches applyOutsideControl appends to this process's own command
   line, spelled the way they appear on one. A command helper appends them too
   before it asks for the single-instance lock, and Chromium relays them to the
   primary; shell/tree-node-command.cjs is told to drop exactly these, by name,
   from a relayed argv and nothing else. */
const OUTSIDE_CONTROL_SWITCHES = Object.freeze([`--${PORT_SWITCH}`, `--${ADDRESS_SWITCH}`])

module.exports = {
  OUTSIDE_CONTROL_MODULE,
  OUTSIDE_CONTROL_SWITCHES,
  PORT_SWITCH,
  ADDRESS_SWITCH,
  resolveOutsideControl,
  applyOutsideControl,
  startOutsideControl,
}
