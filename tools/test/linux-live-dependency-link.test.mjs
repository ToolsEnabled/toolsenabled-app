import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('a LIVE dependency link is ignored without hiding adjacent source', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'live-dependency-link-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const app = path.join(root, 'app')
  const dependencies = path.join(root, 'dependencies')
  mkdirSync(app)
  mkdirSync(dependencies)
  copyFileSync(fileURLToPath(new URL('../../.gitignore', import.meta.url)), path.join(app, '.gitignore'))
  const git = (...args) => execFileSync('git', args, { cwd: app, encoding: 'utf8', windowsHide: true }).trim()
  git('init', '--initial-branch=main')
  symlinkSync(dependencies, path.join(app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(path.join(app, 'new-source.js'), '// must remain visible\n')
  writeFileSync(path.join(dependencies, 'package.json'), '{}\n')
  assert.equal(git('check-ignore', 'node_modules'), 'node_modules')
  const status = git('status', '--porcelain', '--untracked-files=all')
  assert.match(status, /\?\? new-source\.js/)
  assert.doesNotMatch(status, /node_modules|package\.json/)
})
