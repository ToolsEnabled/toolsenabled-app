import { execFile as execFileCallback } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
export const CAPABILITY_INDEX_FILE = 'config/capability-index.json'

function regularSourceFile(source, relative) {
  let cursor = source
  const parts = relative.split('/')
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) cursor = path.join(cursor, parts[index])
    let stat
    try { stat = lstatSync(cursor) } catch (error) {
      throw new Error(`capability index check cannot read ${relative}: ${error.code || error.message}`)
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`capability index check requires a regular source path: ${relative}`)
    }
  }
  return cursor
}

/** Compare the derived index with the exact engine's current catalogue and
 * vocabulary. Byte equality with source alone can faithfully pack a stale
 * index. The engine owns this comparison; the app does not reimplement it. */
export async function checkCapabilityIndex({ source, environment = process.env, timeoutMs = 30000 }) {
  const root = path.resolve(source)
  const builder = regularSourceFile(root, 'tools/build-capability-index.js')
  const artifact = regularSourceFile(root, CAPABILITY_INDEX_FILE)
  const { canonicalizeCreatedQaProfile, prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } =
    await import('./sterile-launch.cjs')
  const accountHome = os.userInfo().homedir
  // Validate the existing temp parent before creating anything. An inherited
  // temp path in another Windows account must never choose the destination.
  const temporaryRoot = canonicalizeCreatedQaProfile(os.tmpdir(), { accountHome })
  const scratch = mkdtempSync(path.join(temporaryRoot, 'capability-index-check-'))
  let exited = true
  try {
    const profile = prepareSterileProfile(sterileProfileDirectories(scratch))
    const env = sterileLaunchEnvironment(profile, environment, { accountHome })
    // This is a build-only registry read. Neither application state overrides,
    // an alternate source, nor Node/Git preload configuration may choose the
    // catalogue or turn the checker into a read of the builder's installation.
    for (const name of Object.keys(env)) {
      if (/^(?:TOOLSENABLED_|MC_|GIT_)/i.test(name) || /^(?:NODE_OPTIONS|NODE_PATH)$/i.test(name)) delete env[name]
    }
    Object.assign(env, {
      TOOLSENABLED_STATE_ROOT: path.join(profile.localAppData, 'ToolsEnabled Build Check', 'capability'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    })
    exited = false
    const { stdout } = await execFile(process.execPath, [builder, '--engine-root', root, '--out', artifact, '--check'], {
      cwd: root, env, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024,
    })
    exited = true
    const prefix = `CURRENT -- ${artifact} matches the `
    const line = stdout.split(/\r?\n/).find(value => value.startsWith(prefix))
    const count = line?.slice(prefix.length).match(/^([1-9]\d*)-tool registry\.$/)
    if (!count) throw new Error('the engine checker exited without a CURRENT registry comparison')
    const toolCount = Number(count[1])
    const index = JSON.parse(readFileSync(regularSourceFile(root, CAPABILITY_INDEX_FILE), 'utf8'))
    if (!Number.isSafeInteger(toolCount) || index.N !== toolCount) {
      throw new Error('the checked registry count differs from the source index')
    }
    return { toolCount }
  } catch (error) {
    if (Number.isInteger(error.code) && !error.signal && !error.killed) exited = true
    const detail = String(error.stderr || error.stdout || error.message).trim().slice(0, 6000)
    const retained = exited ? '' : `; checker completion was not confirmed, scratch retained at ${scratch}`
    throw new Error(`capability index check REFUSED: ${detail}${retained}`, { cause: error })
  } finally {
    // A timed-out child may still have descendants. Keep its scratch available
    // for the owning build runner's cleanup rather than deleting live state.
    if (exited) rmSync(canonicalizeCreatedQaProfile(scratch, { accountHome }), { recursive: true, force: true })
  }
}
