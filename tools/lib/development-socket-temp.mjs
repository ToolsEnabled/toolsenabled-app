import fs from 'node:fs'
import path from 'node:path'
import { ordinaryPath } from './development-session.mjs'

// Chromium appends scoped_dir*/SingletonSocket to TMPDIR. A deeply nested
// workspace exceeds Linux's sockaddr_un limit even when every file is private.
// Keep only transient GUI files in this short, independently owned directory.
function location(session) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(session.id)) throw Error('Invalid session identity for native socket storage')
  ordinaryPath('/tmp')
  const parent = fs.lstatSync('/tmp')
  if (parent.uid !== 0 || !(parent.mode & 0o1000) || process.getuid() <= 0) throw Error('Native socket storage requires the ordinary root-owned sticky temporary directory')
  return '/tmp/te-dev-' + session.id
}

function operation(session) {
  const file = ordinaryPath(path.join(session.paths.root, 'operation.json'), { directory: false })
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (record.sessionId !== session.id || record.operation !== 'open') throw Error('Native socket storage requires this session\'s open admission')
  return record.id
}

export function prepareDevelopmentSocketTemp(session) {
  if (process.platform !== 'linux') return null
  const directory = location(session), operationId = operation(session)
  // EEXIST is a refusal, including after unknown cleanup. Never adopt or sweep
  // a directory just because its UUID looks like an earlier operation.
  fs.mkdirSync(directory, { mode: 0o700 })
  try {
    const stat = fs.lstatSync(directory)
    const record = { schema: 'toolsenabled.development-socket-temp', directory,
      sessionId: session.id, sessionRoot: session.paths.root, operationId,
      dev: stat.dev, ino: stat.ino, uid: stat.uid }
    fs.writeFileSync(path.join(directory, 'session-owner.json'), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 })
    return readDevelopmentSocketTemp(session)
  } catch (error) {
    error.cleanupConfirmed = false
    throw error
  }
}

export function readDevelopmentSocketTemp(session) {
  if (process.platform !== 'linux') return null
  const directory = ordinaryPath(location(session)), stat = fs.lstatSync(directory)
  const file = ordinaryPath(path.join(directory, 'session-owner.json'), { directory: false })
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700
      || record.schema !== 'toolsenabled.development-socket-temp' || record.directory !== directory
      || record.sessionId !== session.id || record.sessionRoot !== session.paths.root
      || record.operationId !== operation(session) || record.dev !== stat.dev || record.ino !== stat.ino || record.uid !== stat.uid) {
    throw Error('Native socket temporary directory ownership changed')
  }
  return record
}

export function removeDevelopmentSocketTemp(session, expected, { cleanupConfirmed = false } = {}) {
  if (!expected) return
  if (cleanupConfirmed !== true) throw Error('Native socket files remain until process cleanup is confirmed')
  const actual = readDevelopmentSocketTemp(session)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Native socket temporary directory no longer matches its retained receipt')
  fs.rmSync(actual.directory, { recursive: true })
}
