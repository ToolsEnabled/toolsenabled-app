/* Small git helpers shared by the release-packager tools.
 *
 * Deliberately thin: this repo already has a hard-won lesson wired into
 * tools/require-clean-tree.mjs about what "clean" means and why it matters.
 * This file does not reimplement that gate -- it gives the packager the same
 * primitives (status, rev-parse, worktree add/remove) so the packager can
 * build in an ISOLATED checkout and let require-clean-tree.mjs do its real
 * job there, undisturbed, exactly as `npm run dist` already does.
 */
import { spawnSync } from 'node:child_process'

export class GitError extends Error {}

export function git(args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.error) throw new GitError(`git ${args.join(' ')} could not start: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    throw new GitError(`git ${args.join(' ')} failed (exit ${result.status}) in ${cwd}:\n${result.stderr || result.stdout}`)
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

export function porcelainStatus(cwd) {
  const { stdout } = git(['status', '--porcelain'], { cwd })
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
}

export function isClean(cwd) {
  return porcelainStatus(cwd).length === 0
}

export function revParse(cwd, ref = 'HEAD') {
  return git(['rev-parse', ref], { cwd }).stdout.trim()
}

export function showFile(cwd, ref, relativePath) {
  const { status, stdout, stderr } = git(['show', `${ref}:${relativePath}`], { cwd, allowFailure: true })
  if (status !== 0) throw new GitError(`git show ${ref}:${relativePath} failed: ${stderr}`)
  return stdout
}

export function currentBranch(cwd) {
  const { stdout } = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, allowFailure: true })
  return stdout.trim()
}

/** True only if `descendant` can be reached from `ancestor` -- i.e. building
 * `descendant` did not require abandoning any history `ancestor` already had. */
export function isAncestor(cwd, ancestor, descendant) {
  return git(['merge-base', '--is-ancestor', ancestor, descendant], { cwd, allowFailure: true }).status === 0
}

export function worktreeAddDetached(cwd, worktreePath, ref) {
  git(['worktree', 'add', '--detach', worktreePath, ref], { cwd })
}

export function worktreeRemove(cwd, worktreePath, { force = true } = {}) {
  git(['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], { cwd })
}

/* KEEP THE BUILD REF REACHABLE. The bump commit is made inside a throwaway
   worktree and the worktree is removed on success, so the commit every
   DECLARATION names as its "build ref" is unreferenced the moment the cut
   works -- garbage a `git gc` is entitled to delete. Measured 2026-08-17:
   EIGHT candidates' build refs were in that state, 1.0.4 through 1.0.23,
   including the build then installed on the owner's machine. A declaration
   whose build ref no longer resolves is a provenance claim that cannot be
   checked, which is worse than no claim. The candidate tag is immutable: an
   existing name may be reused only when it already resolves to the same
   commit. Force-moving it would rewrite the provenance of bytes already in
   somebody else's hands. */
export function tagCommit(cwd, tag, commit) {
  const ref = `refs/tags/${tag}^{commit}`
  const existing = git(['rev-parse', '--verify', ref], { cwd, allowFailure: true })
  if (existing.status === 0) {
    const resolved = existing.stdout.trim()
    const requested = revParse(cwd, `${commit}^{commit}`)
    if (resolved !== requested) {
      throw new GitError(
        `refusing to move immutable candidate tag ${tag}: it already resolves to ${resolved}, requested ${requested}`,
      )
    }
    return { created: false, tag, commit: requested }
  }
  git(['tag', tag, commit], { cwd })
  return { created: true, tag, commit: revParse(cwd, `${commit}^{commit}`) }
}

export function worktreeList(cwd) {
  return git(['worktree', 'list', '--porcelain'], { cwd }).stdout
}

/** Files already committed under `pathspec` at the checked-out ref. Used to
 * tell a genuinely untracked, per-builder local input (copy it in) apart
 * from a file that is already committed with its own reviewed content
 * (leave it alone -- overwriting it with whatever is on this one machine
 * right now would silently replace known-good content AND dirty an
 * otherwise-clean isolated worktree, defeating the point of building there). */
export function listTrackedFiles(cwd, pathspec) {
  return git(['ls-files', '--', pathspec], { cwd })
    .stdout.split(/\r?\n/)
    .filter((line) => line.length > 0)
}

/** Commit an explicit, named set of paths -- never `-A`, never a bare dot.
 * message is passed on stdin so multi-line trailers survive shell quoting.
 *
 * Callers which create a commit on somebody's behalf may pin that validated
 * identity as both author and committer. `--signoff` then uses that exact
 * committer identity, so the DCO trailer cannot silently name the machine's
 * unrelated default git.config identity. Existing callers which omit options
 * retain the original behaviour. */
export function commitPaths(cwd, paths, message, { identity, signoff = false } = {}) {
  let env
  if (identity != null) {
    const name = typeof identity.name === 'string' ? identity.name.trim() : ''
    const email = typeof identity.email === 'string' ? identity.email.trim() : ''
    if (!name || !email || /[\r\n\0]/.test(name) || /[\r\n\0]/.test(email)) {
      throw new GitError('commit identity requires non-empty, single-line name and email values')
    }
    env = {
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    }
  }

  git(['add', '--', ...paths], { cwd })
  const result = spawnSync('git', ['commit', ...(signoff ? ['--signoff'] : []), '-F', '-', '--', ...paths], {
    cwd,
    input: message,
    encoding: 'utf8',
    windowsHide: true,
    ...(env ? { env } : {}),
  })
  if (result.status !== 0) {
    throw new GitError(`git commit failed (exit ${result.status}):\n${result.stderr || result.stdout}`)
  }
  return revParse(cwd)
}

/** Fast-forward-only branch move. Refuses (rather than force-moves) unless
 * newRef is a descendant of the branch's current tip, so this can never
 * discard history other lanes might be relying on.
 *
 * `git branch -f` CANNOT MOVE A BRANCH THAT IS CHECKED OUT IN A WORKTREE, and
 * that is the normal case here, not the exotic one: the packager is run from a
 * worktree that has the source branch checked out, so `--advance-branch` used
 * to fail 100% of the time with
 *
 *   fatal: cannot force update the branch 'X' used by worktree at '...'
 *
 * It was measured failing on the 1.0.3 cut after a fully successful build.
 * `git branch -f` is also the wrong tool there even if git allowed it: it moves
 * the ref while leaving HEAD's index and working tree behind, so the checkout
 * would instantly report every file changed by the bump as locally modified.
 *
 * So: if the branch is checked out HERE, advance it the way a person would --
 * `git merge --ff-only`, which moves ref, index and working tree together. If
 * it is checked out in a DIFFERENT worktree, refuse: moving a branch out from
 * under another lane's checkout is how a lane loses work it never touched.
 * Only a branch nobody has checked out gets the plain `git branch -f`. */
export function fastForwardBranch(cwd, branchName, newRef) {
  const currentTip = revParse(cwd, branchName)
  if (!isAncestor(cwd, currentTip, newRef)) {
    throw new GitError(
      `refusing to move ${branchName}: ${newRef} is not a descendant of its current tip ${currentTip}. ` +
        'This would not be a fast-forward.',
    )
  }

  if (currentBranch(cwd) === branchName) {
    git(['merge', '--ff-only', newRef], { cwd })
    return
  }

  const holder = worktreeHoldingBranch(cwd, branchName)
  if (holder) {
    throw new GitError(
      `refusing to move ${branchName}: it is checked out in another worktree (${holder}). ` +
        'Moving it from here would leave that checkout\'s index and working tree describing a commit ' +
        'it is no longer on. Run the packager from that worktree, or advance the branch there.',
    )
  }

  git(['branch', '-f', branchName, newRef], { cwd })
}

/** Absolute path of the worktree that has `branchName` checked out, or null.
 * Parses `git worktree list --porcelain`, whose records are blank-line
 * separated with `worktree <path>` and `branch refs/heads/<name>` lines. */
export function worktreeHoldingBranch(cwd, branchName) {
  const { stdout } = git(['worktree', 'list', '--porcelain'], { cwd, allowFailure: true })
  let path = null
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
    else if (line.startsWith('branch ') && line.slice('branch '.length).trim() === `refs/heads/${branchName}`) {
      return path
    }
  }
  return null
}
