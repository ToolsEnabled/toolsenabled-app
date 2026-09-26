import { lstatSync, readlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import path from 'node:path'

const ACCOUNT = userInfo().homedir
export function insideDependencyRoot(root, entry) {
  const relative = path.relative(root, entry)
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

// Check the OS owner lexically before inspecting a path or a link target.
// Redirected USERPROFILE/HOME values are not account authority.
export function ownedDependencyPath(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || /[\x00-\x1f]/.test(input)) throw new Error('CUT dependency path must be an ordinary absolute path')
  const resolved = path.resolve(input)
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(input) || input.slice(2).includes(':') ||
      /[. ](?:[\\/]|$)/.test(input) || !insideDependencyRoot(ACCOUNT, resolved))) {
    throw new Error('CUT dependency path leaves the current OS account')
  }
  return resolved
}

export function ordinaryDependencyPath(input, { directory = true, missing = false } = {}) {
  const resolved = ownedDependencyPath(input)
  let cursor = path.parse(resolved).root
  const parts = path.relative(cursor, resolved).split(path.sep).filter(Boolean)
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) cursor = path.join(cursor, parts[index])
    let stat
    try { stat = lstatSync(cursor, { bigint: true }) }
    catch (error) { if (missing && index === parts.length - 1 && error.code === 'ENOENT') return null; throw error }
    if (stat.isSymbolicLink()) throw new Error('CUT dependency input has a linked/reparse-point ancestor or leaf')
    if (index < parts.length - 1 || directory) {
      if (!stat.isDirectory()) throw new Error('CUT dependency input must be an ordinary directory')
    } else if (!stat.isFile() || stat.nlink !== 1n) throw new Error('CUT dependency input must be an ordinary unshared file')
  }
  return resolved
}

// Resolve only bounded internal link chains. realpath on an apparently internal
// link could otherwise traverse a second link into another account before the
// caller notices the escape. No target outside root is inspected here.
export function resolvePrivateDependencyPath(root, input) {
  root = ordinaryDependencyPath(root)
  let pending = ownedDependencyPath(input)
  const seen = new Set()
  for (let hops = 0; hops <= 64; hops++) {
    if (!insideDependencyRoot(root, pending)) throw new Error(`CUT dependency link escapes its private node_modules: ${input}`)
    let cursor = root, redirected = false
    const parts = path.relative(root, pending).split(path.sep).filter(Boolean)
    for (let index = 0; index < parts.length; index++) {
      cursor = path.join(cursor, parts[index])
      const stat = lstatSync(ownedDependencyPath(cursor))
      if (stat.isSymbolicLink()) {
        if (seen.has(cursor)) throw new Error('CUT dependency link chain is cyclic')
        seen.add(cursor)
        pending = ownedDependencyPath(path.resolve(path.dirname(cursor), readlinkSync(cursor), ...parts.slice(index + 1)))
        if (!insideDependencyRoot(root, pending)) throw new Error(`CUT dependency link escapes its private node_modules: ${input}`)
        redirected = true
        break
      }
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('CUT dependency link traverses a non-directory')
    }
    if (!redirected) return pending
  }
  throw new Error('CUT dependency link chain exceeds its bounded hop budget')
}
