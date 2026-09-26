import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { runDevelopmentProcess } from '../lib/development-process.mjs'
import { developmentSessionEnvironment, sessionPaths } from '../lib/development-session.mjs'

const root = path.resolve(import.meta.dirname, '../..')
function selectedEngine() {
  if (process.env.TOOLSENABLED_SOURCE) return path.resolve(process.env.TOOLSENABLED_SOURCE)
  return JSON.parse(fs.readFileSync(path.join(root, 'private/capability-source.owner.json'), 'utf8')).path
}
const worker = `
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const file = process.argv[1], identity = process.argv[2];
fs.writeFileSync(path.join(process.env.APPDATA, 'session-value.txt'), identity);
const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
orphan.unref();
const server = http.createServer((req,res) => {
 res.end(fs.readFileSync(path.join(process.env.APPDATA, 'session-value.txt')));
 if (req.url === '/close') server.close(() => process.exit(0));
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(file, JSON.stringify({ port: server.address().port, identity })));
`
function get(port, route = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 2000 }, response => {
      let body = ''; response.on('data', data => { body += data }); response.on('end', () => resolve(body))
    })
    req.on('error', reject); req.on('timeout', () => req.destroy(Error('test request timed out')))
  })
}
async function waitFile(file, completion) {
  const deadline = Date.now() + 45_000
  let ended = false
  completion.then(() => { ended = true }, () => { ended = true })
  while (!fs.existsSync(file)) {
    if (ended) throw Error('Native session exited before its HTTP listener opened')
    if (Date.now() > deadline) throw Error('Native session listener deadline expired')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('two real DEV scopes and CUT coexist; closing one reaps its detached descendant while peers keep their state and listeners', { timeout: 120_000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-scopes-'))
  const engine = selectedEngine(), operations = [], controllers = [], sessions = []
  let cleanupKnown = false
  t.after(async () => {
    for (const controller of controllers) controller.abort()
    const settled = await Promise.allSettled(operations)
    cleanupKnown = settled.every(result => result.status === 'fulfilled' && result.value.cleanupConfirmed)
    // Never delete an uncertain native scope merely because a test finished.
    if (cleanupKnown) fs.rmSync(scratch, { recursive: true, force: true })
  })
  for (const name of ['dev-one', 'dev-two', 'cut']) {
    const paths = sessionPaths(path.join(scratch, name))
    for (const dir of [paths.root, paths.app, paths.evidence, paths.cache]) fs.mkdirSync(dir, { recursive: true })
    const session = { id: randomUUID(), paths: { ...paths, engine, controlEngine: engine },
      sources: { app: { origin: root, ref: 'a'.repeat(40) }, engine: { origin: engine, ref: 'b'.repeat(40) } } }
    const controller = new AbortController(), file = path.join(paths.evidence, 'listener.json')
    const completion = runDevelopmentProcess(session, process.execPath, ['-e', worker, file, name], {
      env: developmentSessionEnvironment(session), signal: controller.signal, timeoutMs: 90_000,
    })
    controllers.push(controller); operations.push(completion)
    const listener = await waitFile(file, completion)
    sessions.push({ name, paths, listener, completion })
  }
  assert.equal(new Set(sessions.map(row => row.listener.port)).size, 3)
  for (const session of sessions) assert.equal(await get(session.listener.port), session.name)
  assert.equal(await get(sessions[0].listener.port, '/close'), 'dev-one')
  const first = await sessions[0].completion
  assert.equal(first.code, 0)
  assert.equal(first.cleanupConfirmed, true, JSON.stringify(first))
  assert.equal(first.outcome.activeProcesses, 0)
  assert.equal(first.wrapperClosed, true)
  for (const session of sessions.slice(1)) {
    assert.equal(await get(session.listener.port), session.name)
    assert.equal(fs.readFileSync(path.join(developmentSessionEnvironment({ ...sessions[0], paths: session.paths,
      sources: { app: { origin: root, ref: 'a'.repeat(40) }, engine: { origin: engine, ref: 'b'.repeat(40) } } }).APPDATA, 'session-value.txt'), 'utf8'), session.name)
  }
  for (const session of sessions.slice(1)) await get(session.listener.port, '/close')
  for (const result of await Promise.all(operations)) {
    assert.equal(result.code, 0)
    assert.equal(result.cleanupConfirmed, true, JSON.stringify(result))
    assert.equal(result.outcome.activeProcesses, 0)
  }
})
