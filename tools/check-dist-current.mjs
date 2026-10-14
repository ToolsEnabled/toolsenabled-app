#!/usr/bin/env node

/* Refuse a dist/ that was not built from the source it is about to ship.
 *
 * THE GAP THIS CLOSES, measured 2026-09-07. An artefact was packaged from a
 * dist/ built at 05:58 on a base that was rebased at 10:44, so the bundle
 * predated two commits it claimed to contain. It passed EVERY dist gate --
 * check-renderer-payload, check-payload-current, check-payload-boundary,
 * check-artifact-private, check-no-owner-data -- and sealed cleanly, because
 * every one of them asks whether the bytes are consistent with THEMSELVES, and
 * none asks whether the bundle is consistent with the SOURCE. It was caught by a
 * person reading two timestamps.
 *
 * The judge harness already refuses this ("dist/ is OLDER than the source it is
 * built from ... A verdict about a stale bundle is worse than no verdict"). This
 * is the same guard on the ship path, before pack.
 *
 * CONTENT, NOT MTIMES, IS THE PRIMARY CHECK -- mtimes lie. They survive a copy,
 * a restore, a worktree add and a touch, and the failure this exists to catch is
 * precisely one where the mtime looked plausible. So the build records WHAT it
 * was built from and this compares that recording against the source now.
 *
 * The mtime path is kept only as a fallback for a dist/ built before this marker
 * existed, and it SAYS SO in its output: a weaker check that reports itself is
 * usable, a weaker check that looks like the strong one is not.
 *
 * DIRECTION OF ERROR, chosen deliberately: the input set is a superset of what
 * vite consumes (HTML, renderer modules, public files, config and manifests), so an
 * unrelated tracked change can make this say "rebuild". That costs one rebuild.
 * The opposite error ships a stale bundle to customers. The asymmetry is the
 * whole reason to over-include.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MARKER = '.dist-source.json'
/* Public files are copied unchanged by Vite, including durable-storage.js,
 * which index.html runs before the renderer. Omitting them let a clean public
 * repair qualify an older copied runtime. Include every supported default
 * config filename too: config can change emitted code without touching src/.
 * Git's listing detects edits, additions, removals and renames alike. */
const SOURCE_PATHS = [
  'index.html', 'src', 'public', 'package.json', 'package-lock.json',
  'vite.config.js', 'vite.config.mjs', 'vite.config.ts',
  'vite.config.cjs', 'vite.config.mts', 'vite.config.cts',
]

function git(args, { cwd = REPO_ROOT } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

/* `git ls-files -s` yields mode + BLOB SHA + stage + path for every tracked
 * input. Hashing that listing identifies the source CONTENT without reading a
 * single file, and it changes the moment any tracked input's content changes.
 * It reflects the index, so an unstaged edit is invisible here -- which is why
 * require-clean-tree runs in the same chain and refuses a dirty tree. Stated
 * rather than left as a silent assumption. */
function sourceIdentity(root = REPO_ROOT) {
  const listing = git(['ls-files', '-s', '--', ...SOURCE_PATHS], { cwd: root })
  return {
    sourceHash: createHash('sha256').update(listing).digest('hex'),
    appHead: git(['rev-parse', 'HEAD'], { cwd: root }),
    trackedInputs: listing ? listing.split('\n').length : 0,
  }
}

function newestMtime(directory) {
  let newest = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  walk(directory)
  return newest
}

/* WAS THE WORKING TREE CLEAN WHEN THIS WAS RECORDED?
 *
 * sourceIdentity() reads the INDEX (`git ls-files -s`), so an unstaged edit is
 * invisible to it -- the note above says so, and leans on require-clean-tree
 * running later in the same chain to refuse a dirty tree. That is true of
 * `dist` and `dist:linux`. It is NOT true of `dist:test`, which has no
 * require-clean-tree anywhere in it.
 *
 * So on a test build the recorded appHead could name a commit the artifact was
 * not actually built from, and a reader has no way to tell. That is the same
 * defect the record exists to close, moved one step along: a claim wearing the
 * shape of a readback. One boolean makes it honest -- a dirty test build still
 * gets a record, and the record says it is dirty.
 *
 * Scoped to SOURCE_PATHS rather than the whole repo: an edit under docs/ or
 * tools/ does not change what Vite emits, and a flag that goes false for
 * unrelated work is a flag people learn to ignore. Untracked files count as
 * dirty -- git status skips ignored paths, so what is left is a file that could
 * be imported by the build and is in nobody's history. */
function workingTreeClean(root = REPO_ROOT) {
  return git(['status', '--porcelain', '--', ...SOURCE_PATHS], { cwd: root }).length === 0
}

export function recordDistSource(distDirectory, { root = REPO_ROOT } = {}) {
  const identity = sourceIdentity(root)
  const record = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    ...identity,
    treeClean: workingTreeClean(root),
  }
  writeFileSync(path.join(distDirectory, MARKER), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

export function checkDistCurrent(distDirectory, { root = REPO_ROOT } = {}) {
  const directory = path.resolve(distDirectory)
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`[check-dist-current] REFUSING: no built renderer at ${directory}`)
  }

  const markerFile = path.join(directory, MARKER)
  const current = sourceIdentity(root)

  if (!existsSync(markerFile)) {
    /* FALLBACK, and it announces itself. */
    const distNewest = newestMtime(directory)
    const sourceNewest = Math.max(
      ...SOURCE_PATHS
        .map((relative) => path.join(root, relative))
        .filter((full) => existsSync(full))
        .map((full) => (statSync(full).isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)),
    )
    if (distNewest < sourceNewest) {
      throw new Error(
        '[check-dist-current] REFUSING: dist/ is OLDER than the source it is built from.\n'
        + `  newest dist file:   ${new Date(distNewest).toISOString()}\n`
        + `  newest source file: ${new Date(sourceNewest).toISOString()}\n`
        + '  A verdict about a stale bundle is worse than no verdict. Rebuild the renderer.',
      )
    }
    return { method: 'mtime-fallback', distNewest, sourceNewest, ...current }
  }

  let recorded
  try {
    recorded = JSON.parse(readFileSync(markerFile, 'utf8'))
  } catch (error) {
    throw new Error(`[check-dist-current] REFUSING: ${MARKER} is present but unreadable: ${error.message}`)
  }

  if (recorded?.sourceHash !== current.sourceHash) {
    throw new Error(
      '[check-dist-current] REFUSING: dist/ was built from different source than the tree it would ship with.\n'
      + `  dist was built from: ${recorded?.appHead ?? '(no head recorded)'}  sourceHash ${String(recorded?.sourceHash).slice(0, 16)}…\n`
      + `  tree is now at:      ${current.appHead}  sourceHash ${current.sourceHash.slice(0, 16)}…\n`
      + `  built at ${recorded?.builtAt ?? '(unknown)'}. Rebuild the renderer before packing.`,
    )
  }
  return { method: 'content-marker', ...current, builtAt: recorded.builtAt }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  try {
    const target = process.argv.find((value, index) => index > 1 && !value.startsWith('--')) || 'dist'
    if (process.argv.includes('--record')) {
      const record = recordDistSource(path.resolve(target))
      // The dirty case is said out loud, not left for a reader to notice in the
      // JSON: a test build recorded against an edited tree is the case where the
      // head alone would mislead, so it is the case the line has to name.
      console.log(`[check-dist-current] recorded: ${record.trackedInputs} tracked inputs, head ${record.appHead.slice(0, 8)}, sourceHash ${record.sourceHash.slice(0, 16)}…`
        + (record.treeClean ? ', working tree clean' : ', WORKING TREE DIRTY — the recorded head does not fully describe this build'))
    } else {
      const result = checkDistCurrent(path.resolve(target))
      console.log(
        result.method === 'content-marker'
          ? `[check-dist-current] dist is current: built from ${result.appHead.slice(0, 8)} at ${result.builtAt}, ${result.trackedInputs} tracked inputs match (content marker).`
          : `[check-dist-current] dist is newer than its source, but NO CONTENT MARKER was present — this is the WEAKER mtime fallback, not a content check. Rebuild with --record to get the strong check.`,
      )
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
