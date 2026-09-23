import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ARGUMENT_CODE, electronNodeHandoff } = require('../../shell/electron-node-handoff.cjs')
const resourcesPath = path.resolve('C:\\Users\\ToolsEnabled-Dev\\AppData\\Local\\Programs\\toolsenabled\\resources')
const script = path.join(resourcesPath, 'capability', 'src', 'mcp-server.js')

test('legacy handoff accepts only a shipped script as the first forwarded argument', () => {
  const result = electronNodeHandoff({
    environment: {},
    resourcesPath,
    argv: ['ToolsEnabled.exe', script, '--inspect=127.0.0.1:0', '--stdio'],
  })
  assert.equal(result.ok, true)
  assert.deepEqual([...result.forwarded], [script, '--inspect=127.0.0.1:0', '--stdio'])
})

test('Windows drive and directory casing do not turn a shipped legacy command into a GUI launch', {
  skip: process.platform !== 'win32',
}, () => {
  const caseVariant = script
    .replace(/^C:/, 'c:')
    .replace('Users', 'USERS')
    .replace('ToolsEnabled-Dev', 'TOOLSENABLED-DEV')
  const accepted = electronNodeHandoff({
    environment: {},
    resourcesPath,
    argv: ['ToolsEnabled.exe', caseVariant, '--stdio'],
  })
  assert.equal(accepted.ok, true)
  assert.deepEqual([...accepted.forwarded], [caseVariant, '--stdio'])

  const refused = electronNodeHandoff({
    environment: {},
    resourcesPath,
    argv: ['ToolsEnabled.exe', '--inspect=127.0.0.1:0', caseVariant],
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, ARGUMENT_CODE)
})

test('legacy handoff refuses every prefix before the shipped script', () => {
  for (const prefix of [
    '--inspect=127.0.0.1:0',
    '--inspect-brk=127.0.0.1:0',
    '--require=ambient-loader.cjs',
    '--trace-warnings',
    'unrecognized-prefix',
  ]) {
    const result = electronNodeHandoff({
      environment: {},
      resourcesPath,
      argv: ['ToolsEnabled.exe', prefix, script, '--stdio'],
    })
    assert.equal(result.ok, false, prefix)
    assert.equal(result.code, ARGUMENT_CODE, prefix)
    assert.equal('forwarded' in result, false, prefix)
  }
})

test('ordinary GUI launches, escaped scripts and an existing RunAsNode child are not handoffs', () => {
  assert.equal(electronNodeHandoff({ environment: {}, resourcesPath, argv: ['ToolsEnabled.exe', '--updated'] }), null)
  assert.equal(electronNodeHandoff({
    environment: {},
    resourcesPath,
    argv: ['ToolsEnabled.exe', path.join(resourcesPath, '..', 'outside.js')],
  }), null)
  assert.equal(electronNodeHandoff({
    environment: { ELECTRON_RUN_AS_NODE: '1' },
    resourcesPath,
    argv: ['ToolsEnabled.exe', script],
  }), null)
})
