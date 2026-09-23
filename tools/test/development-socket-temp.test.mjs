import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import test from 'node:test'
import { acquireDevelopmentSession, sessionPaths } from '../lib/development-session.mjs'
import { prepareDevelopmentSocketTemp, readDevelopmentSocketTemp, removeDevelopmentSocketTemp } from '../lib/development-socket-temp.mjs'

test('deep Linux DEV workspaces bind real short private sockets; cleanup requires custody and leaves the peer alive', {
  skip: process.platform !== 'linux' ? 'Linux Unix socket path limit and temporary-directory custody' : false,
  timeout: 10_000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-socket-test-')), rows = []
  t.after(async () => {
    const errors = []
    for (const row of rows) {
      try {
        if (row.server.listening) { const closed = once(row.server, 'close'); row.server.close(); await closed }
        if (!row.removed) removeDevelopmentSocketTemp(row.session, row.temp, { cleanupConfirmed: true })
        if (!row.finished) row.lease.finish({ cleanupConfirmed: true, result: 'test-cleanup' })
      } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Socket fixture cleanup failed; records retained')
    fs.rmSync(root, { recursive: true })
  })
  for (const name of ['one', 'two']) {
    const directory = path.join(root, 'nested-'.repeat(24), name)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const session = { id: randomUUID(), paths: sessionPaths(directory) }
    fs.mkdirSync(session.paths.evidence, { mode: 0o700 })
    const lease = acquireDevelopmentSession(session, 'open'), temp = prepareDevelopmentSocketTemp(session)
    const socket = path.join(temp.directory, 'scoped_dir123456', 'SingletonSocket')
    fs.mkdirSync(path.dirname(socket), { mode: 0o700 })
    const server = net.createServer(client => client.end(name))
    const row = { session, lease, temp, socket, server }; rows.push(row)
    const listening = once(server, 'listening'); server.listen(socket); await listening
    assert.ok(Buffer.byteLength(path.join(directory, 'profiles/runtime/temp/scoped_dir123456/SingletonSocket')) > 107)
    assert.ok(Buffer.byteLength(socket) <= 107)
    assert.equal(fs.statSync(temp.directory).mode & 0o777, 0o700)
    assert.deepEqual(readDevelopmentSocketTemp(session), temp)
    assert.throws(() => prepareDevelopmentSocketTemp(session), /EEXIST/)
    assert.throws(() => removeDevelopmentSocketTemp(session, temp), /cleanup is confirmed/)
  }
  const request = socket => new Promise((resolve, reject) => {
    const connection = net.connect(socket); let body = ''
    connection.on('data', chunk => { body += chunk }); connection.on('end', () => resolve(body)); connection.on('error', reject)
  })
  assert.notEqual(rows[0].temp.directory, rows[1].temp.directory)
  assert.equal(await request(rows[0].socket), 'one'); assert.equal(await request(rows[1].socket), 'two')
  const first = rows[0], closed = once(first.server, 'close'); first.server.close(); await closed
  removeDevelopmentSocketTemp(first.session, first.temp, { cleanupConfirmed: true }); first.removed = true
  first.lease.finish({ cleanupConfirmed: true, result: 'passed' }); first.finished = true
  assert.equal(fs.existsSync(first.temp.directory), false)
  assert.equal(await request(rows[1].socket), 'two')
})
