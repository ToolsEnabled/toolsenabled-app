/* A LINK THAT LANDS BACK INSIDE THE OWNED PROFILE ESCAPES NOTHING.
 *
 * THE DEFECT. assertBootstrapAccountPath (shell/agent-host.cjs) fences the
 * engine before it is required: it refuses sibling-account paths lexically,
 * then walks the path segment by segment inside the owned profile and refuses
 * on the FIRST reparse point it meets, whatever that reparse point points at:
 *
 *   if (stats.isSymbolicLink()) fail('AGENT_CONFINEMENT_PROFILE_REPARSE_REFUSED', ...)
 *
 * The danger a reparse point carries is that a lexical check can be defeated
 * by one: C:\Users\Owner\x can be a junction to C:\Users\Other\y, and the
 * lexical answer ("inside the owned profile") is then a lie. That is the only
 * danger it carries. A junction whose target is ALSO inside the owned profile
 * moves nothing across the boundary this function exists to hold -- the
 * lexical answer and the real answer agree -- and refusing it buys no safety.
 *
 * It costs a great deal. This repository's own parallel-work layout gives
 * every git worktree a junctioned `node_modules` (pointing at a shared real
 * directory a few folders up, inside the same profile), and twenty-three test
 * files put their scratch workdir under `<repo>/node_modules/.toolsenabled-*`
 * by convention. Every one of those tests therefore hands the host a cwd
 * whose second segment is a link and is refused before it starts -- so the
 * agent-host suite is unrunnable in the exact layout the project requires for
 * parallel work, and passes only in a checkout where node_modules happens to
 * be a real directory. MEASURED 2026-09-04 in
 * .../wt-codex-chat-controls: tree-handoff-transient-refusal 0/2,
 * first-turn-notes-survive-refusal 0/1, streaming-turn-delivery 1/4, all with
 * AGENT_CONFINEMENT_PROFILE_REPARSE_REFUSED raised from normalizeCwd.
 *
 * THE RULE PINNED HERE. A reparse point met inside the owned profile is
 * RESOLVED and judged by where it actually lands, with the same rule the
 * lexical pass used: still inside the owned profile, the walk continues from
 * the resolved location (so a link nested behind it is judged too); anywhere
 * else -- a sibling account, another tree on the same drive, a device or
 * volume-GUID spelling with no comparable account boundary, or a link that
 * cannot be resolved at all -- keeps the refusal it already had, with the
 * same code. Strictly stronger than the lexical pass alone, strictly narrower
 * than refusing every link.
 *
 * Driven against the real exported fence with real junctions, not a mock: the
 * whole question is what the filesystem says, so a fake filesystem would pin
 * nothing. */

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { assertBootstrapAccountPath } from '../../shell/agent-host.cjs'

const WINDOWS_ONLY = { skip: process.platform !== 'win32' ? 'Windows reparse points only' : false }

/* Real directories and real junctions, under this account's own temp root
   (never an inherited TEMP destination outside it): the fence answers a
   question about the filesystem, so the fixture has to be one. Each case
   declares its OWN profile root, which the fence accepts as the trusted
   installation profile, so nothing here depends on where the repository or
   the running account actually live. */
function fixture(name) {
  const root = path.join(os.tmpdir(), `toolsenabled-fence-${name}-${process.pid}`)
  rmSync(root, { recursive: true, force: true })
  const profileRoot = path.join(root, 'users', 'owner')
  mkdirSync(profileRoot, { recursive: true })
  return { root, profileRoot }
}

test('a junction inside the owned profile, landing inside that same profile, is admitted', WINDOWS_ONLY, () => {
  const { root, profileRoot } = fixture('inside')
  try {
    /* The repository layout, in miniature: a shared real dependency tree a
       few folders up, and a worktree whose node_modules is a junction to it. */
    const shared = path.join(profileRoot, 'deps', 'app-node_modules')
    const workdir = path.join(shared, '.toolsenabled-scratch')
    mkdirSync(workdir, { recursive: true })
    const worktree = path.join(profileRoot, 'worktree')
    mkdirSync(worktree, { recursive: true })
    symlinkSync(shared, path.join(worktree, 'node_modules'), 'junction')

    const asked = path.join(worktree, 'node_modules', '.toolsenabled-scratch')
    assert.equal(
      assertBootstrapAccountPath(asked, { field: 'agent cwd', profileRoot }),
      path.win32.normalize(asked),
      'a link whose target is inside the same owned profile crosses no account boundary and must be admitted',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a junction inside the owned profile that lands OUTSIDE it is still refused', WINDOWS_ONLY, () => {
  const { root, profileRoot } = fixture('outside')
  try {
    const elsewhere = path.join(root, 'elsewhere', 'payload')
    mkdirSync(elsewhere, { recursive: true })
    symlinkSync(path.join(root, 'elsewhere'), path.join(profileRoot, 'escape'), 'junction')

    assert.throws(
      () => assertBootstrapAccountPath(path.join(profileRoot, 'escape', 'payload'), { field: 'agent cwd', profileRoot }),
      error => error?.code === 'AGENT_CONFINEMENT_PROFILE_REPARSE_REFUSED',
      'a link that leaves the owned profile is the whole reason this walk exists and must keep its refusal',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a junction inside the owned profile that lands in a SIBLING account is still refused', WINDOWS_ONLY, () => {
  const { root, profileRoot } = fixture('sibling')
  try {
    /* The attack the lexical pass cannot see on its own: an owned-looking
       path that is really a doorway into the account next door. */
    const sibling = path.join(root, 'users', 'other', 'secrets')
    mkdirSync(sibling, { recursive: true })
    symlinkSync(path.join(root, 'users', 'other'), path.join(profileRoot, 'neighbour'), 'junction')

    assert.throws(
      () => assertBootstrapAccountPath(path.join(profileRoot, 'neighbour', 'secrets'), { field: 'agent cwd', profileRoot }),
      error => error?.code === 'AGENT_CONFINEMENT_PROFILE_REPARSE_REFUSED',
      'a link into a sibling account must be refused by where it lands, not admitted by how it is spelled',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a link nested behind an admitted link is judged too', WINDOWS_ONLY, () => {
  const { root, profileRoot } = fixture('nested')
  try {
    const shared = path.join(profileRoot, 'deps')
    mkdirSync(shared, { recursive: true })
    const elsewhere = path.join(root, 'elsewhere', 'payload')
    mkdirSync(elsewhere, { recursive: true })
    /* First hop stays inside the profile and is admitted; the second hop,
       reached only THROUGH the first, leaves it. Walking from the resolved
       location is what makes the second hop visible at all. */
    symlinkSync(path.join(root, 'elsewhere'), path.join(shared, 'onward'), 'junction')
    const worktree = path.join(profileRoot, 'worktree')
    mkdirSync(worktree, { recursive: true })
    symlinkSync(shared, path.join(worktree, 'node_modules'), 'junction')

    assert.throws(
      () => assertBootstrapAccountPath(
        path.join(worktree, 'node_modules', 'onward', 'payload'),
        { field: 'agent cwd', profileRoot },
      ),
      error => error?.code === 'AGENT_CONFINEMENT_PROFILE_REPARSE_REFUSED',
      'admitting a link must not blind the walk to the links that only exist behind it',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
