import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const { createDesktopFileOpener } = createRequire(import.meta.url)('../../shell/desktop-file-opener.cjs')
const neverUseElectron = () => { throw new Error('Linux must not await the broken Electron callback') }

// These tests exercise real child exit/error/timing, with a private Node child
// replacing only the desktop launcher. Actual native viewer proof is separate.
test('Linux confirms the launcher exit and passes the exact path as one argument', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'te-file-opener-'))
  const target = path.join(root, 'café 雪 `literal` $(literal).md')
  const receipt = path.join(root, 'argv.json')
  try {
    const open = createDesktopFileOpener({ platform: 'linux', electronOpenPath: neverUseElectron,
      spawnProcess(command, args, options) {
        assert.equal(command, 'xdg-open')
        assert.deepEqual(args, [target])
        assert.equal(options.shell, false)
        assert.equal(options.cwd, root)
        return spawn(process.execPath, ['-e',
          'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv[1]))',
          args[0], receipt], options)
      },
    })
    assert.equal(await open(target), '')
    assert.equal(JSON.parse(await readFile(receipt, 'utf8')), target)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Linux reports a real failed launcher exit', async () => {
  const open = createDesktopFileOpener({ platform: 'linux', electronOpenPath: neverUseElectron,
    spawnProcess: (_command, _args, options) => spawn(process.execPath, ['-e', 'process.exit(4)'], options),
  })
  assert.equal(await open(path.join(tmpdir(), 'owned.md')), 'The system file opener could not open this file.')
})

test('Linux reports a missing system launcher without losing the reply', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'te-file-opener-missing-'))
  try {
    const open = createDesktopFileOpener({ platform: 'linux', electronOpenPath: neverUseElectron,
      spawnProcess: (_command, args, options) => spawn(path.join(root, 'absent-launcher'), args, options),
    })
    await assert.rejects(open(path.join(root, 'owned.md')), /could not be started/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a slow launcher gets an uncertain reply and is allowed to exit normally', async () => {
  let child, exited
  const open = createDesktopFileOpener({ platform: 'linux', electronOpenPath: neverUseElectron, timeoutMs: 30,
    spawnProcess: (_command, _args, options) => {
      child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 150)'], options)
      exited = once(child, 'exit')
      return child
    },
  })
  await assert.rejects(open(path.join(tmpdir(), 'owned.md')), /Check whether the file opened before trying again/)
  assert.equal(child.killed, false)
  assert.equal(child.exitCode, null)
  child.ref() // Keep this test alive to observe its own fixture's normal exit.
  assert.deepEqual(await exited, [0, null])
})

test('other platforms retain Electron success and error replies without a second launch', async () => {
  for (const platform of ['win32', 'darwin']) {
    const targets = []
    const open = createDesktopFileOpener({ platform,
      electronOpenPath: async target => { targets.push(target); return 'Original OS refusal' },
      spawnProcess: () => { throw new Error('Unexpected second launch') },
    })
    assert.equal(await open('/owned/report.md'), 'Original OS refusal')
    assert.deepEqual(targets, ['/owned/report.md'])
  }
})
