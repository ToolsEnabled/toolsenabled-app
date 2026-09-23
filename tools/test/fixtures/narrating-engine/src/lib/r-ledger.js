'use strict'

/* THE FIXTURE ENGINE'S ROOT CARRIES THIS MODULE BECAUSE A REAL ENGINE ROOT
 * DOES — and its absence here produced a false defect report.
 *
 * WHAT WAS MEASURED, 2026-08-20. shell/agent-host.cjs loads the standing-
 * request ledger from the ENGINE'S OWN root (`engineRootOf(modulePath)`), so
 * a drive that points MISSION_CONTROL_ENGINE at this fixture gives the host a
 * root with no `src/lib/r-ledger.js` in it. Filing then refuses with
 * AGENT_REQUEST_UNAVAILABLE, the tree chat prints its generic "That rule was
 * not filed", and a driver reading that sentence would report the /Request
 * family as broken on packaged builds. It is not: with the real payload
 * resolved, the same call answers `{ok:true, id:'RT1'}` and reads back
 * through `mc-agent:requests` — proven by tools/standing-request-probe.mjs,
 * which runs both ways for exactly this reason.
 *
 * SO THIS FILE MAKES THE FIXTURE FAITHFUL, and it does it by DELEGATING TO
 * THE REAL MODULE rather than reimplementing it. A hand-written stand-in
 * would be a second implementation of the owner's ledger format, free to
 * drift from the one that ships, and a drive passing against it would prove
 * nothing about the product. What this fixture changes is which ENGINE runs a
 * turn; it has no business changing what a filed rule is.
 *
 * If the payload cannot be found, this exports nothing usable and the host's
 * own shape check (`typeof loaded.fileRequest === 'function'`) rejects it —
 * the same honest refusal as before, rather than a silent half-ledger.
 */

const fs = require('node:fs')
const path = require('node:path')

function payloadRoot() {
  const candidates = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'capability'))
  }
  /* The checkout case, for a driver that runs this fixture outside a packaged
     app: five levels up from here is the repository root. */
  candidates.push(path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'capability'))
  return candidates.find(candidate => fs.existsSync(path.join(candidate, 'src', 'lib', 'r-ledger.js'))) || null
}

const root = payloadRoot()
module.exports = root ? require(path.join(root, 'src', 'lib', 'r-ledger.js')) : {}
