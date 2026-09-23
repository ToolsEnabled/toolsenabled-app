import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'

/* AN INSTALL THAT CANNOT SUCCEED SHOULD NOT START.
 *
 * npm removes before it adds, and clears node_modules/.bin before rewriting it.
 * This checkout's electron is what the MCP servers run, and Windows will not let
 * npm relocate a running binary -- so an install here fails EBUSY partway and
 * leaves a tree that is populated but incomplete.
 *
 * Measured 2026-08-27: three diagnosis rounds in one day from that single cause.
 * Absent rollup and echarts, and the build died at vite with MODULE_NOT_FOUND.
 * Absent app-builder-lib and its siblings, and the ratchet reported eleven
 * regressions blocking the ship path. Absent fonts and d3, and the license gate
 * failed six dependencies it "cannot verify". Finally an emptied .bin, and
 * "'vite' is not recognized". Every symptom named a missing module or an
 * unrecognised command. None of them named the interrupted install.
 *
 * This pins the three answers the guard must keep apart: a holder inside THIS
 * checkout, a holder somewhere else, and not being able to ask at all.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
// tools/test/ -- two levels up is the repo root, not one.
const REPO = path.dirname(path.dirname(HERE))
const GUARD = path.join(REPO, 'tools', 'refuse-install-while-electron-runs.mjs')
const mod = await import(pathToFileURL(GUARD).href)
const OURS = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')

test('an Electron running from THIS node_modules is a holder', () => {
  const answer = mod.runningFromThisCheckout({ platform: 'win32', list: () => [OURS] })
  assert.equal(answer.asked, true)
  assert.equal(answer.holders.length, 1,
    'the process that guarantees this install fails EBUSY was not counted, so the install would proceed')
})

test('an Electron running from somewhere else is not our business', () => {
  /* THE CONTROL. Without it, a guard that flagged every electron.exe on the
     machine would block installs over an unrelated project's dev launch, get
     switched off by the next person, and guard nothing. */
  const elsewhere = path.join('C:', 'other-project', 'node_modules', 'electron', 'dist', 'electron.exe')
  const answer = mod.runningFromThisCheckout({ platform: 'win32', list: () => [elsewhere] })
  assert.equal(answer.holders.length, 0,
    'an unrelated Electron was treated as a holder; this guard would cry wolf and be disabled')
})

test('a sibling with the same directory prefix cannot block this checkout', () => {
  const sibling = path.join(REPO, 'node_modules', 'electron-shadow', 'dist', 'electron.exe')
  const answer = mod.runningFromThisCheckout({ platform: 'win32', list: () => [sibling, OURS] })
  assert.deepEqual(answer.holders, [OURS])
})

test('a linked dependency directory recognizes its real executable target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-holder-'))
  try {
    const target = path.join(root, 'shared', 'electron')
    fs.mkdirSync(path.join(target, 'dist'), { recursive: true })
    const executable = path.join(target, 'dist', 'electron.exe')
    fs.writeFileSync(executable, 'fixture; never executed')
    const linked = path.join(root, 'linked-electron')
    fs.symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const answer = mod.runningFromThisCheckout({ platform: 'win32', electronDirectory: linked,
      list: () => [executable, path.join(root, 'shared', 'electron-shadow', 'dist', 'electron.exe')] })
    assert.equal(answer.asked, true)
    assert.deepEqual(answer.holders, [executable])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a platform that cannot be asked reports asked:false, never an empty answer', () => {
  /* could-not-look is not nothing-running, and the caller must be able to tell.
     The hook proceeds when it cannot ask -- blocking on its own blindness would
     be worse than the defect -- so collapsing the two states would silently make
     this guard either permanent or useless. */
  const answer = mod.runningFromThisCheckout({ platform: 'unsupported-fixture-platform' })
  assert.equal(answer.asked, false,
    'an unaskable platform reported a definite answer about what is running')
  assert.equal(answer.holders.length, 0)
})

test('Linux observes a real executable holder and ignores a same-prefix sibling', { skip: process.platform !== 'linux' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-electron-holder-'))
  const directory = path.join(root, 'node_modules', 'electron'), sibling = path.join(root, 'node_modules', 'electron-shadow')
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(sibling)
  const guard = path.join(root, 'tools', 'refuse-install-while-electron-runs.mjs')
  fs.mkdirSync(path.dirname(guard)); fs.copyFileSync(GUARD, guard)
  const own = path.join(directory, 'native-holder'), other = path.join(sibling, 'native-holder')
  for (const file of [own, other]) { fs.copyFileSync('/bin/sleep', file); fs.chmodSync(file, 0o700) }
  const children = [spawn(own, ['30'], { stdio: 'ignore' }), spawn(other, ['30'], { stdio: 'ignore' })]
  const exits = children.map(child => once(child, 'exit'))
  try {
    await Promise.all(children.map(child => once(child, 'spawn')))
    const answer = mod.runningFromThisCheckout({ electronDirectory: directory })
    assert.deepEqual(answer.holders, [own])
    // Other protected processes may make the complete inventory unavailable.
    // The known holder still has to refuse the real preinstall entry point.
    const refusal = spawnSync(process.execPath, [guard], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, TE_ALLOW_INSTALL_WITH_ELECTRON_RUNNING: '' } })
    assert.equal(refusal.status, 1, refusal.stderr)
    assert.match(refusal.stderr, /REFUSING THE INSTALL/)
  } finally {
    for (const child of children) child.kill('SIGTERM')
    await Promise.all(exits)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
