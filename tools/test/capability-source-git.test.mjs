import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertCapabilitySourceGitBinding,
  gitEnvironment,
  resolveCapabilitySourceBinding,
} from '../lib/capability-source-git.mjs'

function git(repository, ...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function put(root, relative, contents) {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capability-source-git-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.email', 'fixture@example.test')
  git(root, 'config', 'user.name', 'Capability Source Fixture')
  put(root, 'tools/mission-bridge.js', 'module.exports = true\n')
  put(root, 'src/value.js', 'module.exports = 1\n')
  git(root, 'add', '--', 'tools/mission-bridge.js', 'src/value.js')
  git(root, 'commit', '-m', 'fixture')
  return { root, ref: git(root, 'rev-parse', 'HEAD') }
}

/* The 8.3 short-name spelling of an absolute Windows path, or null when one
 * cannot be produced (not Windows, or the volume has 8.3 name generation
 * disabled -- `fsutil 8dot3name query`). cmd.exe's `%~sI` modifier is the
 * asked-the-OS route to this, the same authority `fs.realpathSync.native`
 * consults in the other direction; there is no Node API that goes long-form
 * to short-form. Built from a path this function did not choose, so the test
 * below does not depend on whichever form os.tmpdir() itself happens to
 * return on the machine running it. */
function shortPathNameOf(longPath) {
  if (process.platform !== 'win32') return null
  const result = spawnSync(
    'cmd.exe',
    ['/d', '/c', 'for', '%I', 'in', `(${longPath})`, 'do', '@echo', '%~sI'],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.error || result.status !== 0) return null
  const short = result.stdout.trim()
  return short && short.toLowerCase() !== path.resolve(longPath).toLowerCase() ? short : null
}

test('an exact clean branch-tip source binding is accepted', (t) => {
  const made = fixture(t)
  const binding = assertCapabilitySourceGitBinding({ source: made.root, expectedRef: made.ref })
  assert.equal(binding.sourceRef, made.ref)
  assert.equal(binding.head, made.ref)
  assert.equal(binding.detached, false)
  assert.equal(binding.branchRef, 'refs/heads/main')
})

test('a source path spelled through its 8.3 short name is accepted, not refused as "not the root"', (t) => {
  /* MEASURED 2026-09-03: `git -C <source> rev-parse --show-toplevel` resolves
   * short-name segments to their long form; `path.resolve(source)` does not.
   * A repository whose given path takes the short spelling failed here with
   * "capability source must be the root of its Git repository" even though it
   * plainly was -- the same directory, spelled two ways. This is why every
   * test above and below builds its fixture straight under os.tmpdir(): that
   * incidentally repros the defect on a machine where TEMP is itself
   * short-named, which this one is, but incidentally is not a pin. This test
   * manufactures the mismatch directly, from a path this suite controls,
   * so it catches a regression regardless of what any particular machine's
   * os.tmpdir() happens to spell like today. */
  const made = fixture(t)
  /* The canonical answer to compare against, independent of which spelling
   * os.tmpdir() handed fixture() in the first place -- on this very machine
   * made.root is ITSELF already short (TOOLSE~2), so comparing against
   * made.root verbatim would repeat the exact mistake this test exists to
   * catch, just inside the assertion instead of inside the code. */
  const canonicalRoot = realpathSync.native(made.root)
  const shortForm = shortPathNameOf(made.root)
  if (shortForm === null) {
    t.skip('could not produce an 8.3 short-name spelling of the fixture root on this machine (not Windows, or 8.3 names are disabled on this volume)')
    return
  }
  assert.notEqual(shortForm.toLowerCase(), canonicalRoot.toLowerCase(),
    'the derived short form must be a different spelling of the same directory, or this test proves nothing')

  const binding = assertCapabilitySourceGitBinding({ source: shortForm, expectedRef: made.ref })
  assert.equal(binding.sourceRef, made.ref)
  assert.equal(binding.detached, false)
  assert.equal(path.resolve(binding.source).toLowerCase(), canonicalRoot.toLowerCase(),
    'the accepted binding must resolve to the same directory the long-form path names')
})

test('an exact clean detached source binding is accepted', (t) => {
  const made = fixture(t)
  git(made.root, 'switch', '--detach', made.ref)
  const binding = assertCapabilitySourceGitBinding({ source: made.root, expectedRef: made.ref })
  assert.equal(binding.detached, true)
  assert.equal(binding.branchRef, null)
})

test('a clean source at a different commit is refused', (t) => {
  const made = fixture(t)
  assert.throws(
    () => assertCapabilitySourceGitBinding({ source: made.root, expectedRef: '0'.repeat(40) }),
    /HEAD .* differs from declared ref/,
  )
})

test('dirty and untracked source bytes are refused', async (t) => {
  await t.test('tracked modification', () => {
    const made = fixture(t)
    put(made.root, 'src/value.js', 'module.exports = 2\n')
    assert.throws(
      () => assertCapabilitySourceGitBinding({ source: made.root, expectedRef: made.ref }),
      /dirty or has untracked files/,
    )
  })
  await t.test('untracked file', () => {
    const made = fixture(t)
    put(made.root, 'src/untracked.js', 'module.exports = false\n')
    assert.throws(
      () => assertCapabilitySourceGitBinding({ source: made.root, expectedRef: made.ref }),
      /dirty or has untracked files/,
    )
  })
})

test('dirty bytes hidden by an index flag are refused', (t) => {
  const made = fixture(t)
  git(made.root, 'update-index', '--assume-unchanged', 'src/value.js')
  put(made.root, 'src/value.js', 'module.exports = 99\n')
  assert.equal(git(made.root, 'status', '--porcelain'), '', 'control: ordinary status should be fooled by the index flag')
  assert.throws(
    () => assertCapabilitySourceGitBinding({ source: made.root, expectedRef: made.ref }),
    /assume-unchanged or skip-worktree/,
  )
})

test('a Git replace ref is refused even when HEAD itself matches', (t) => {
  const made = fixture(t)
  put(made.root, 'src/value.js', 'module.exports = 2\n')
  git(made.root, 'add', '--', 'src/value.js')
  git(made.root, 'commit', '-m', 'replacement target')
  const replacementTarget = git(made.root, 'rev-parse', 'HEAD')
  git(made.root, 'switch', '--detach', made.ref)
  git(made.root, 'replace', made.ref, replacementTarget)
  assert.throws(
    () => assertCapabilitySourceGitBinding({ source: made.root, expectedRef: made.ref }),
    /forbidden Git replace refs/,
  )
})

test('conflicting exact declarations refuse instead of choosing one', (t) => {
  const made = fixture(t)
  const app = mkdtempSync(path.join(os.tmpdir(), 'capability-source-app-'))
  t.after(() => rmSync(app, { recursive: true, force: true }))
  put(app, 'private/capability-source.owner.json', `${JSON.stringify({ path: made.root, ref: made.ref })}\n`)
  assert.throws(
    () => resolveCapabilitySourceBinding({
      repoRoot: app,
      explicitSource: made.root,
      explicitSourceRef: '0'.repeat(40),
      environment: {},
    }),
    /ref declarations disagree/,
  )
})

test('an invalid higher-priority source refuses instead of falling back to a configured checkout', (t) => {
  const configured = fixture(t)
  const app = mkdtempSync(path.join(os.tmpdir(), 'capability-source-app-'))
  const absent = path.join(app, 'mistyped-explicit-source')
  t.after(() => rmSync(app, { recursive: true, force: true }))
  put(app, 'private/capability-source.owner.json', `${JSON.stringify({ path: configured.root, ref: configured.ref })}\n`)
  assert.throws(
    () => resolveCapabilitySourceBinding({
      repoRoot: app,
      explicitSource: absent,
      explicitSourceRef: configured.ref,
      environment: {},
    }),
    /--source selected .* does not contain tools\/mission-bridge\.js; refusing to fall back/,
  )
  assert.throws(
    () => resolveCapabilitySourceBinding({
      repoRoot: app,
      environment: { toolsenabled_source: absent, toolsenabled_source_ref: configured.ref },
    }),
    /TOOLSENABLED_SOURCE selected .* refusing to fall back/,
  )
})

test('Git-control environment names are scrubbed case-insensitively', () => {
  const clean = gitEnvironment({
    Path: 'kept',
    gIt_DiR: 'foreign',
    Git_Work_Tree: 'foreign',
    git_config_count: '1',
    Git_Config_Key_0: 'core.hooksPath',
    git_CONFIG_value_0: 'foreign',
    git_no_replace_objects: '0',
    Git_Optional_Locks: '1',
  })
  const folded = Object.keys(clean).map(name => name.toUpperCase())
  assert.equal(clean.Path, 'kept')
  assert.equal(folded.includes('GIT_DIR'), false)
  assert.equal(folded.includes('GIT_WORK_TREE'), false)
  assert.equal(folded.includes('GIT_CONFIG_COUNT'), false)
  assert.equal(folded.some(name => /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)), false)
  assert.deepEqual(Object.entries(clean).filter(([name]) => name.toUpperCase() === 'GIT_NO_REPLACE_OBJECTS'), [['GIT_NO_REPLACE_OBJECTS', '1']])
  assert.deepEqual(Object.entries(clean).filter(([name]) => name.toUpperCase() === 'GIT_OPTIONAL_LOCKS'), [['GIT_OPTIONAL_LOCKS', '0']])
})

test('a mixed-case Git replacement namespace is refused before Git inspection', (t) => {
  const made = fixture(t)
  assert.throws(
    () => assertCapabilitySourceGitBinding({
      source: made.root,
      expectedRef: made.ref,
      environment: { ...process.env, gIt_RePlAcE_rEf_BaSe: 'refs/hidden/' },
    }),
    /replacement namespaces are forbidden/,
  )
})

test('abbreviated and uppercase refs are not exact declarations', (t) => {
  const made = fixture(t)
  for (const invalid of [made.ref.slice(0, 12), 'A'.repeat(40)]) {
    assert.throws(
      () => assertCapabilitySourceGitBinding({ source: made.root, expectedRef: invalid }),
      /exact 40-character lowercase Git commit id/,
    )
  }
})
