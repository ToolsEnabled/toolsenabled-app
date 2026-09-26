import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { commitPaths } from '../release-packager/lib/git.mjs'
import { cuttingAttribution, cuttingIdentity, cuttingSession } from '../release-packager/generate-declaration.mjs'

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'check-dco.mjs')
const COMMIT_MSG_HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.githooks', 'commit-msg')

function command(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` }
}

function fixture({ signedOff }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'check-dco-'))
  const tools = path.join(root, 'tools')
  mkdirSync(tools)
  copyFileSync(TOOL, path.join(tools, 'check-dco.mjs'))
  assert.equal(command('git', ['init', '--quiet'], root).status, 0)
  assert.equal(command('git', ['config', 'user.name', 'DCO Test'], root).status, 0)
  assert.equal(command('git', ['config', 'user.email', 'dco@example.test'], root).status, 0)
  writeFileSync(path.join(root, 'fixture.txt'), 'fixture\n')
  assert.equal(command('git', ['add', 'fixture.txt'], root).status, 0)
  const args = ['commit', '--quiet', '-m', 'fixture commit']
  if (signedOff) args.push('--signoff')
  const committed = command('git', args, root, {
    GIT_AUTHOR_DATE: '2026-08-14T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-08-14T00:00:00Z',
  })
  assert.equal(committed.status, 0, committed.output)
  return root
}

function run(root, range = 'HEAD') {
  return command(process.execPath, [path.join(root, 'tools', 'check-dco.mjs'), range], root)
}

test('check-dco fails closed when a valid range enumerates no commits', () => {
  const root = fixture({ signedOff: true })
  try {
    const result = run(root, 'HEAD..HEAD')
    assert.equal(result.status, 1, `empty inspection must refuse, got ${result.status}\n${result.output}`)
    assert.match(result.output, /DCO GATE: cannot certify empty git history for range "HEAD\.\.HEAD"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-dco can fail when an inspected commit has no author sign-off', () => {
  const root = fixture({ signedOff: false })
  try {
    const result = run(root)
    assert.equal(result.status, 1, `unsigned commit must refuse, got ${result.status}\n${result.output}`)
    assert.match(result.output, /no Signed-off-by trailer/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-dco still passes a nonempty history signed off by its author', () => {
  const root = fixture({ signedOff: true })
  try {
    const result = run(root)
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /DCO GATE: PASS -- range: HEAD \(1 checked, 0 grandfathered/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release commit uses the validated cutter as author, committer, and DCO signatory', () => {
  const root = fixture({ signedOff: true })
  try {
    // Deliberately leave the repo's configured identity different from the
    // cutter. This catches both accidental reliance on git.config and a
    // sign-off generated for somebody other than the recorded author.
    const environment = {
      TOOLSENABLED_CUT_MODEL: 'Codex gpt-5.6-sol',
      TOOLSENABLED_CUT_EMAIL: 'noreply@openai.com',
      TOOLSENABLED_CUT_SESSION: 'dco-fixture-session',
      TOOLSENABLED_CUT_LANE: 'release-packager-test',
    }
    const identity = cuttingIdentity(environment)
    assert.deepEqual(identity, { name: 'Codex gpt-5.6-sol', email: 'noreply@openai.com' })
    assert.equal(cuttingSession(environment), 'dco-fixture-session')

    const hooks = path.join(root, '.githooks')
    mkdirSync(hooks)
    copyFileSync(COMMIT_MSG_HOOK, path.join(hooks, 'commit-msg'))
    const hookConfigured = command('git', ['config', 'core.hooksPath', '.githooks'], root)
    assert.equal(hookConfigured.status, 0, hookConfigured.output)

    writeFileSync(path.join(root, 'version.txt'), '1.0.40\n')
    commitPaths(
      root,
      ['version.txt'],
      `package files: bump version to 1.0.40 for release candidate\n\n${cuttingAttribution(environment)}\n`,
      { identity, signoff: true },
    )

    const logged = command('git', ['log', '-1', '--format=%an%x1f%ae%x1f%cn%x1f%ce%x1f%B'], root)
    assert.equal(logged.status, 0, logged.output)
    const [authorName, authorEmail, committerName, committerEmail, ...bodyParts] = logged.output.split('\x1f')
    const body = bodyParts.join('\x1f')
    const signoff = /^Signed-off-by:\s*.+?\s*<([^>]+)>\s*$/im.exec(body)
    assert.ok(signoff, `missing Signed-off-by trailer:\n${body}`)
    assert.equal(authorName, 'Codex gpt-5.6-sol')
    assert.equal(authorEmail, 'noreply@openai.com')
    assert.equal(committerName, 'Codex gpt-5.6-sol')
    assert.equal(committerEmail, 'noreply@openai.com')
    assert.equal(signoff[1], authorEmail, 'Git author e-mail must exactly match the DCO sign-off')
    assert.match(body, /^Co-Authored-By: Codex gpt-5\.6-sol <noreply@openai\.com>$/m)
    assert.match(body, /^Lane: release-packager-test \(session dco-fixture-session\)$/m)

    const dco = run(root, 'HEAD^..HEAD')
    assert.equal(dco.status, 0, dco.output)
    assert.match(dco.output, /DCO GATE: PASS -- range: HEAD\^\.\.HEAD \(1 checked, 0 grandfathered/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
