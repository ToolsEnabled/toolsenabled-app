'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

// npm's Arborist retires a package to this deterministic sibling before
// replacing it. A killed install can leave both directories; the next npm
// rename then fails with ENOTEMPTY. Never take a target from an error log.
function quarantineNpmRetirement(rootOutput, packageName) {
  if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(packageName)) throw new Error('NPM_RECOVERY_PACKAGE_INVALID')
  const root = rootOutput.replace(/\r?\n$/, '')
  if (!root || root.length > 8192 || /[\r\n\0]/.test(root) || !path.isAbsolute(root)
      || path.resolve(root) !== root || path.basename(root) !== 'node_modules') throw new Error('NPM_RECOVERY_ROOT_INVALID')
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  const sameEntry = (a, b) => a.dev === b.dev && a.ino === b.ino
  function directory(target) {
    const stat = fs.lstatSync(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || typeof process.getuid === 'function' && stat.uid !== process.getuid()
        || !samePath(fs.realpathSync(target), target)) throw new Error('NPM_RECOVERY_PATH_UNSAFE')
    return stat
  }
  const rootStat = directory(root)
  const installed = path.join(root, ...packageName.split('/'))
  const parent = path.dirname(installed)
  let parentStat
  try { parentStat = directory(parent) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  // Matches npm's @npmcli/arborist/lib/retire-path.js; a future different
  // naming scheme simply has no matching directory and is not guessed at.
  const suffix = createHash('sha1').update(installed).digest('base64').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8)
  const retired = path.join(parent, `.${path.basename(installed)}-${suffix}`)
  let retiredStat
  try { retiredStat = directory(retired) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const holding = fs.mkdtempSync(path.join(parent, '.toolsenabled-npm-recovery-'))
  fs.chmodSync(holding, 0o700)
  const holdingStat = directory(holding)
  const held = path.join(holding, 'interrupted-package')
  function unchangedParents() {
    if (!sameEntry(directory(root), rootStat) || !sameEntry(directory(parent), parentStat)
        || !sameEntry(directory(holding), holdingStat)) throw new Error('NPM_RECOVERY_PATH_CHANGED')
  }
  unchangedParents()
  if (!sameEntry(directory(retired), retiredStat)) throw new Error('NPM_RECOVERY_PATH_CHANGED')
  fs.renameSync(retired, held)
  unchangedParents()
  if (!sameEntry(directory(held), retiredStat)) throw new Error('NPM_RECOVERY_PATH_CHANGED')
  return {
    discard() {
      // Only after the real retry and its process cleanup succeed. Failed or
      // stopped retries retain this backup, outside npm's program paths.
      unchangedParents()
      if (!sameEntry(directory(held), retiredStat)) throw new Error('NPM_RECOVERY_PATH_CHANGED')
      fs.rmSync(holding, { recursive: true })
    },
  }
}

module.exports = { quarantineNpmRetirement }
