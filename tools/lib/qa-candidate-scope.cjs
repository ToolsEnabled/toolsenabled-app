'use strict'

const { releaseArgument, selectRendererDist } = require('./qa-renderer-dist.cjs')

// A source fixture or hosted website cannot establish a selected installer's
// behavior. Bind and disclose the requested bytes, then stop before the legacy
// source/server/profile path runs. This is a release-blocking missing proof,
// never an exclusion, zero-check pass, or fallback to a different build.
function refuseUnsupportedCandidate({ argv = process.argv, repoRoot, driver, reason,
  write = value => process.stderr.write(value), exit = code => process.exit(code) } = {}) {
  if (releaseArgument(argv) === null) return false
  const renderer = selectRendererDist({ argv, repoRoot })
  renderer.assertUnchanged()
  write(`candidate subject: ${JSON.stringify(renderer.provenance)}\n`)
  write(`CANNOT MEASURE ON THIS COMPUTER: ${driver}: ${reason}\n`)
  exit(3)
  return true
}

module.exports = { refuseUnsupportedCandidate }
