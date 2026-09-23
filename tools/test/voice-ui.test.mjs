import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../lib/sterile-launch.cjs')

test('hidden Electron voice panel: opt-in mic, one contact, switching and complete teardown', { timeout: 30000 }, async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'toolsenabled-voice-ui-'))
  const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(dataRoot)))
  const { stdout } = await promisify(execFile)(require('electron'), [path.join(root, 'tools/test/helpers/voice-ui-electron.cjs'), dataRoot], {
    cwd: root, env, windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024,
  })
  const result = stdout.split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => value?.ok === true)
  assert.ok(result, 'the actual renderer must report its checked result')
  if (process.env.MC_VOICE_UI_EVIDENCE_DIR) {
    const target = path.resolve(process.env.MC_VOICE_UI_EVIDENCE_DIR)
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'voice-ui.json'), JSON.stringify(result, null, 2) + '\n')
  }
})
