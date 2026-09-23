#!/usr/bin/env node

/* Coordinator-only writer for shell/tree-node-command.cjs.
 *
 * It publishes one exact, bounded JSON request atomically and prints the opaque
 * switch the coordinator may hand to the installed executable. It never starts
 * ToolsEnabled. A clean start accepts no text. A follow-up send reads its
 * bounded message only from stdin, so message content never enters argv.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { createTreeNodeCommandRequest } = require('../shell/tree-node-command.cjs')

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

function parse(argv) {
  const allowed = new Set([
    'user-data-root', 'action', 'computer-id', 'tree-id', 'node-id',
    'expected-session-id', 'lifetime-minutes',
  ])
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) fail('Unexpected positional argument.')
    const key = token.slice(2)
    if (!allowed.has(key) || Object.prototype.hasOwnProperty.call(values, key)) fail('Unsupported or repeated option.')
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`Option --${key} needs one value.`)
    values[key] = value
    index += 1
  }
  for (const key of ['user-data-root', 'action', 'computer-id', 'tree-id', 'node-id']) {
    if (!values[key]) fail(`Missing required option: --${key}`)
  }
  if (!['fresh-start-existing-node', 'send-to-bound-node'].includes(values.action)) {
    fail('--action must be fresh-start-existing-node or send-to-bound-node.')
  }
  if (values.action === 'send-to-bound-node' && !values['expected-session-id']) {
    fail('--expected-session-id is required for send-to-bound-node.')
  }
  const lifetimeMinutes = values['lifetime-minutes'] === undefined ? 30 : Number(values['lifetime-minutes'])
  if (!Number.isFinite(lifetimeMinutes) || lifetimeMinutes <= 0 || lifetimeMinutes > 1440) {
    fail('--lifetime-minutes must be greater than 0 and no more than 1440.')
  }
  return {
    userDataRoot: values['user-data-root'],
    action: values.action,
    computerId: values['computer-id'],
    treeId: values['tree-id'],
    nodeId: values['node-id'],
    expectedSessionId: values['expected-session-id'] || null,
    lifetimeMs: Math.round(lifetimeMinutes * 60 * 1000),
  }
}

try {
  const request = parse(process.argv.slice(2))
  if (request.action === 'send-to-bound-node') request.message = readFileSync(0, 'utf8')
  const result = createTreeNodeCommandRequest(request)
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || 'MC_TREE_COMMAND_WRITE_FAILED' })}\n`)
  process.exit(1)
}
