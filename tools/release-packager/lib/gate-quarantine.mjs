import fs from 'node:fs'
import path from 'node:path'
import { userInfo } from 'node:os'
import { randomUUID } from 'node:crypto'

const leases = new WeakSet()
const MARKER = '.gate-execution-in-flight'

function guardedPath(worktreePath) {
  const worktree = path.resolve(worktreePath)
  const fence = process.platform === 'win32' ? userInfo().homedir : worktree
  const relative = path.relative(fence, worktree)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('gate worktree leaves the permitted OS account profile')
  let cursor = fence
  const rootStat = fs.lstatSync(cursor)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('gate worktree profile is a link or non-directory')
  for (const part of [...relative.split(path.sep).filter(Boolean), 'release']) {
    cursor = path.join(cursor, part)
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('gate worktree contains a link or non-directory')
  }
  return { worktree, marker: path.join(worktree, 'release', MARKER) }
}

export function assertGateWorktreeAvailable(worktreePath) {
  const { marker } = guardedPath(worktreePath)
  try { fs.lstatSync(marker) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  throw new Error(`gate worktree has an incomplete or unconfirmed previous execution; inspect owned processes before explicitly clearing release/${MARKER}. An alternate evidence path does not bypass this refusal.`)
}

function begin(worktreePath) {
  assertGateWorktreeAvailable(worktreePath)
  const { worktree, marker } = guardedPath(worktreePath)
  // Even death before owner.json exists leaves a refusal independent of the
  // evidence-out destination or a later diagnostic write.
  fs.mkdirSync(marker)
  const token = randomUUID()
  const fd = fs.openSync(path.join(marker, 'owner.json'), 'wx')
  try { fs.writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token })}\n`); fs.fsyncSync(fd) }
  finally { fs.closeSync(fd) }
  const lease = {
    worktree,
    uncertain: false,
    markUncertain() { lease.uncertain = true },
    release() {
      guardedPath(worktree)
      if (fs.lstatSync(marker).isSymbolicLink()) throw new Error('gate execution marker was replaced with a link')
      const ownerFile = path.join(marker, 'owner.json')
      if (fs.lstatSync(ownerFile).isSymbolicLink()) throw new Error('gate execution owner was replaced with a link')
      const current = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
      if (current.token !== token || current.pid !== process.pid) throw new Error('gate execution ownership changed')
      fs.unlinkSync(ownerFile)
      fs.rmdirSync(marker)
      leases.delete(lease)
    },
  }
  leases.add(lease)
  return lease
}

/** Confirmed ordinary failures may be retried. Uncertain completion or abrupt
 * death retains the worktree guard; nested checks use only our live lease. */
export async function withGateWorktree(worktreePath, action, { lease } = {}) {
  const worktree = path.resolve(worktreePath)
  if (lease && (!leases.has(lease) || lease.worktree !== worktree)) throw new Error('gate worktree lease is invalid')
  const owned = lease || begin(worktree)
  try {
    const result = await action(owned)
    if (result?.terminationConfirmed === false) owned.markUncertain()
    return result
  } catch (error) {
    if (error.terminationConfirmed === false) owned.markUncertain()
    throw error
  } finally {
    if (!lease && !owned.uncertain) owned.release()
  }
}
