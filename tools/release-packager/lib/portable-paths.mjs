/* AN ABSOLUTE PATH IS OWNER DATA. A ROLE IS NOT.
 *
 * DECLARATION.md is the provenance document that travels WITH a release
 * candidate -- it is the thing a recipient reads to decide whether the bytes
 * they were handed are the bytes that were built. That makes it exactly the
 * wrong place for `C:\Users\<account>\...`, and yet every declaration this
 * packager has produced carried the builder's home directory in it: 11
 * occurrences of the account name across 10 lines of the 1.0.2 and 1.0.4
 * declarations, plus 7 more in each `declaration-facts.json` beside them.
 * Nothing checked, because `check-no-owner-data.mjs` scans the packaged bytes
 * (`release/win-unpacked`) and this markdown is not in them.
 *
 * THE FIX IS NOT VAGUENESS. A declaration a recipient cannot act on has failed
 * at its only job, so "remove the paths" is not the requirement; "say the same
 * thing without saying who built it" is. Three shapes do that, and which one
 * applies is a judgement about what the reader needs:
 *
 *   1. A ROLE, where the reader needs to know WHICH tree, not where it sits:
 *      "the day-to-day worktree", "the isolated build worktree". The role is
 *      the actual information -- the absolute path never told a remote reader
 *      anything they could use, because it names a directory on a machine they
 *      do not have.
 *   2. AN ENVIRONMENT ROOT, where the reader must RUN something or FIND a file:
 *      `%USERPROFILE%\Desktop\...` resolves as written in Explorer, cmd and
 *      PowerShell, so the instruction stays executable while the account name
 *      stays out of the document. This is why a token was chosen over a
 *      placeholder for those paths: `<home>\Desktop\...` would have to be
 *      translated by hand; `%USERPROFILE%\Desktop\...` does not.
 *   3. REPO-RELATIVE, for anything inside the checkout -- `private\`,
 *      `dist/build-info.json`. Already portable; it just has to stop being
 *      written as a suffix of an absolute path.
 *
 * WHY THE SUBSTITUTION IS GLOBAL RATHER THAN A PREFIX TEST: some of these
 * strings are prose or captured git error text with a path embedded mid-
 * sentence (`branchAdvanceError` is the live example). A prefix-only rule
 * passes those through untouched, which is the failure mode where the guard
 * is green and the leak ships anyway.
 */
import os from 'node:os'
import { publicReadinessSummary } from './readiness-handoff.mjs'

export const HOME_PLACEHOLDER = '%USERPROFILE%'

// The two trees this packager talks about. Naming them once, here, is what
// stops a renderer from reaching for `facts.repo` again out of convenience.
export const DAY_TO_DAY_WORKTREE = 'the day-to-day worktree'
export const BUILD_WORKTREE_TOKEN = '<isolated build worktree>'

// Fields that are a builder's local machine layout and nothing else. They are
// DELETED rather than rewritten: `%USERPROFILE%\Desktop\wt-capability` would be
// portable but still pointless to a remote verifier, and keeping a path-shaped
// field invites the next renderer to print it.
const LOCAL_ONLY_FIELDS = {
  root: ['repo', 'readiness'],
  treeState: ['worktreePath'],
  excludedWip: ['sourceWorktree'],
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A home directory of "C:\" (or "" or "/") would turn this into a rule that
// rewrites every drive-rooted path to %USERPROFILE%, which is both wrong and
// silently destructive. Refuse to build a pattern from anything that shallow
// and leave the value alone -- the guard is what catches the consequence.
function homePattern(home) {
  if (typeof home !== 'string') return null
  const normalizedHome = home.replace(/[\\/]+$/, '')
  const segments = normalizedHome.split(/[\\/]/).filter(Boolean)
  if (segments.length < 2) return null
  // Keep the leading separator. Rebuilding the pattern from only non-empty
  // segments turns `/home/account` into `home/account`; replacing that inside
  // `/home/account/project` then leaves `/%USERPROFILE%/project`, which is not
  // the documented environment-root form and misstates the artifact path.
  const source = normalizedHome
    .split(/([\\/]+)/)
    .map((part) => (/^[\\/]+$/.test(part) ? '[\\\\/]+' : escapeRegExp(part)))
    .join('')
  return new RegExp(source, 'gi')
}

/** Rewrite every occurrence of the build account's home directory to %USERPROFILE%. */
export function portablePath(value, { home = os.homedir() } = {}) {
  if (typeof value !== 'string' || value.length === 0) return value
  const pattern = homePattern(home)
  if (!pattern) return value
  return value.replace(pattern, HOME_PLACEHOLDER)
}

/** Deep-map portablePath over every string in a JSON-shaped value. */
export function portableValue(value, options) {
  if (typeof value === 'string') return portablePath(value, options)
  if (Array.isArray(value)) return value.map((entry) => portableValue(entry, options))
  if (value instanceof Date) return value
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, portableValue(entry, options)]))
  }
  return value
}

function omit(source, keys) {
  if (!source || typeof source !== 'object') return source
  const copy = { ...source }
  for (const key of keys) delete copy[key]
  return copy
}

/* The one transform every consumer of `facts` must go through.
 *
 * IT IS APPLIED IN BOTH PLACES ON PURPOSE, and the duplication is the design.
 * cut-release-candidate.mjs applies it before it serialises anything, because
 * `facts` is written to disk as declaration-facts.json as well as rendered --
 * a renderer-only fix leaves the absolute paths sitting in that JSON file in
 * the same directory as the installer. renderDeclaration() applies it again to
 * whatever it is handed, because it is also callable directly and with a facts
 * file written by an older version of this tool, and a document that leaks
 * depending on who called it is not a guarantee. The function is idempotent, so
 * running it twice costs nothing.
 */
export function toDeclarableFacts(facts, options) {
  if (!facts || typeof facts !== 'object') return facts
  const cleaned = omit(facts, LOCAL_ONLY_FIELDS.root)
  // Raw readiness is private, hash-bound execution evidence. Never sanitize it
  // into a different receipt or ship its actual commands with the declaration.
  if (facts.readiness) cleaned.readinessSummary = publicReadinessSummary(facts.readiness)
  if (cleaned.treeState) cleaned.treeState = omit(cleaned.treeState, LOCAL_ONLY_FIELDS.treeState)
  if (cleaned.excludedWip) cleaned.excludedWip = omit(cleaned.excludedWip, LOCAL_ONLY_FIELDS.excludedWip)
  return portableValue(cleaned, options)
}
