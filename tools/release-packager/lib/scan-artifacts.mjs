/* Find other "ToolsEnabled Setup *.exe" files so the declaration can name
 * them as NOT the candidate, instead of leaving a same-named file for the
 * verifier to mistake for the real thing.
 *
 * This is the mechanised version of a section the hand-written declaration
 * had to compose by hand: "Artifacts that are NOT this candidate." Built by
 * scanning, not by a maintained list, because a maintained list goes stale
 * the moment nobody remembers to update it -- and a stale "not the
 * candidate" list is worse than none, because it reads as complete.
 */
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { measureFile } from './hash.mjs'

const CANDIDATE_NAME_PATTERN = /^ToolsEnabled Setup .+\.exe$/i

export async function findOtherCandidates(searchRoots, excludePath) {
  const excludeResolved = path.resolve(excludePath)
  const found = []
  const seen = new Set([excludeResolved])

  async function addCandidate(candidatePath) {
    const resolved = path.resolve(candidatePath)
    if (seen.has(resolved)) return
    seen.add(resolved)
    found.push(await describe(candidatePath))
  }

  for (const root of searchRoots) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }

    for (const entry of entries) {
      const entryPath = path.join(root, entry.name)

      if (entry.isDirectory()) {
        // One level deep only -- staging directories are namespaced by
        // version (release/<version>/...), not arbitrarily nested, and an
        // unbounded recursive scan of e.g. the whole Desktop is both slow
        // and liable to wander into unrelated worktrees.
        let nested
        try {
          nested = await readdir(entryPath, { withFileTypes: true })
        } catch {
          continue
        }
        for (const nestedEntry of nested) {
          if (nestedEntry.isFile() && CANDIDATE_NAME_PATTERN.test(nestedEntry.name)) {
            const nestedPath = path.join(entryPath, nestedEntry.name)
            await addCandidate(nestedPath)
          }
        }
        continue
      }

      if (entry.isFile() && CANDIDATE_NAME_PATTERN.test(entry.name)) {
        await addCandidate(entryPath)
      }
    }
  }

  return found
}

async function describe(filePath) {
  const measured = await measureFile(filePath)
  const stats = await stat(filePath)
  return { ...measured, mtime: stats.mtime.toISOString() }
}
