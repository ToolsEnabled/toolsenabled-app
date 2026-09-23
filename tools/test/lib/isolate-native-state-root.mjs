/* --import SETUP: one fresh, isolated Windows profile per test-FILE process.
 *
 * THE CONFLICT THIS CLOSES. `node --test` spawns one child process per
 * matched file, and every child inherits whatever TOOLSENABLED_STATE_ROOT /
 * TOOLSENABLED_VAULT_PATH the invoking shell happened to have -- on this
 * machine, the owner's own live profile. Two suite families disagreed about
 * what to do with that inherited value:
 *   - assistant-config-runtime.test.mjs / assistant-config-chosen-only.test.mjs
 *     read real settings through it and need SOMETHING valid there (9/14 fail
 *     when it is unset).
 *   - audit-repair-native.test.mjs / audit-identity-native.test.mjs /
 *     agent-org-record.test.mjs already build their OWN isolated root per
 *     file, but a SHARED inherited value let real custody/audit state leak
 *     across suites that never meant to share it (assistant-config-runtime
 *     itself read the owner's actual permission level -- "ToolsEnabled and
 *     native tools" instead of the fixture's "ToolsEnabled only" -- even
 *     though it "passed", which is contamination succeeding quietly rather
 *     than a suite that never needed isolation).
 *
 * A single shared value can never satisfy both: A needs it non-empty, B needs
 * it not to be the SAME value another file is also using. A fresh directory
 * PER FILE PROCESS satisfies both at once -- A gets a real, valid, writable
 * profile; B gets one nobody else's process is touching. Suites that already
 * build their own root (agent-org-record's injected `env` copies, audit-
 * identity-native's own `configure()`) simply overwrite this default with
 * their own value, which was already correct; this only feeds a safe default
 * to whichever files were never isolating themselves at all.
 *
 * Registered via --import, so it runs once per spawned test-file process,
 * before that file's own top-level code -- see package.json's test:data.
 *
 * WORKER THREADS: a Worker started with execArgv left at its default
 * inherits the parent's --import, so this same module runs again inside
 * any worker_threads.Worker a test spawns -- including ones a test hands a
 * deliberately bare `env` to, on purpose, to prove a shipped worker needs
 * nothing else (payload-self-sufficiency.test.mjs's S11). Isolating that
 * bare env by minting TEMP/APPDATA here would defeat the very proof the
 * test is making, and os.tmpdir() can throw outright when the env it was
 * built with has no TEMP/TMP/SystemRoot at all. Only the main thread -- the
 * one --import is actually meant to isolate -- should run this.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isMainThread } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { canonicalRootForTests } from '../../canonical-root.mjs'
import { parseGateFixtureContract, prepareRetainedGateFixture } from './retained-gate-fixture-root.mjs'
import { prepareRetainedSourceFixture } from './source-fixture-root.mjs'

if (isMainThread) {
  const gateContract = parseGateFixtureContract(process.env)
  const strictFixture = process.env.TOOLSENABLED_TEST_STRICT === '1'
    ? gateContract
      ? prepareRetainedGateFixture({ ...gateContract, accountHome: os.userInfo().homedir })
      : prepareRetainedSourceFixture()
    : null
  const root = strictFixture?.root || fs.mkdtempSync(path.join(os.tmpdir(), 'te-test-isolated-root-'))
  if (strictFixture) Object.assign(process.env, strictFixture.environment)
  const localAppData = path.join(root, 'local-app-data')
  const roamingAppData = path.join(root, 'roaming-app-data')
  const stateRoot = path.join(localAppData, 'ToolsEnabled Isolated Test', 'capability')
  fs.mkdirSync(stateRoot, { recursive: true })

  process.env.LOCALAPPDATA = localAppData
  process.env.APPDATA = roamingAppData
  process.env.TOOLSENABLED_STATE_ROOT = stateRoot
  process.env.TOOLSENABLED_VAULT_PATH = path.join(stateRoot, 'vault', 'secrets.json')
  // The image custody suites require an explicit scratch root, including
  // when discovered through test:data rather than a lane-specific runner.
  const imageTemp = path.join(root, 'image-test-temp')
  fs.mkdirSync(imageTemp)
  process.env.IMAGE_TEST_TEMP = imageTemp
  process.env.T489_TEST_TEMP = imageTemp
  process.env.T545_REVIEW_TEMP = imageTemp
  process.env.IMAGE_APP_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
  const engineRoot = canonicalRootForTests({ warn: () => {} })
  process.env.IMAGE_ENGINE_ROOT = engineRoot
  process.env.T545_ENGINE_ROOT = engineRoot
  const pngs = [
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==',
  ]
  const images = pngs.map((png, index) => {
    const file = path.join(imageTemp, `image-${index}.png`)
    fs.writeFileSync(file, Buffer.from(png, 'base64'))
    return { path: file }
  })
  const manifest = path.join(imageTemp, 'images.json')
  fs.writeFileSync(manifest, JSON.stringify({ images }))
  process.env.T489_PNG_MANIFEST = manifest

  if (strictFixture) {
    const signal = strictFixture.ownership
      ? { ...strictFixture.ownership, appRoot: process.env.IMAGE_APP_ROOT,
        canonicalRoot: engineRoot, node: process.execPath }
      : { root, environment: strictFixture.environment,
        appRoot: process.env.IMAGE_APP_ROOT, canonicalRoot: engineRoot, node: process.execPath }
    console.log('RETAINED_SOURCE_FIXTURE ' + JSON.stringify(signal))
  } else {
    process.once('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best-effort scratch cleanup */ } })
  }
}
