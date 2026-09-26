'use strict'

/* THE DEVELOPER PATH IS A DEVELOPER PATH ONLY WHILE THERE IS A DEVELOPER.
 *
 * MC_BRIDGE_PROOF_FILE names a bootstrap proof file for a bridge that was
 * started outside this app. shell/main.cjs honours it above the supervised
 * layer, and shell/main.cjs's own comment calls that "the developer's explicit
 * opt-in and not a customer's exposure". The first half is true. The second
 * half assumes only a developer can set the variable, and on Windows that is
 * not so.
 *
 * MEASURED on this machine, 2026-08-11, from an unelevated shell:
 *
 *     Set-ItemProperty -Path 'HKCU:\Environment' -Name <n> -Value <v>   -> OK
 *     IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)  -> False
 *
 * HKCU\Environment is writable by the user with no elevation and no consent
 * prompt, it survives reboots, and every process that user launches afterwards
 * inherits it. So same-user code can set MC_BRIDGE_PROOF_FILE once and change
 * how every future launch of the installed product resolves its bridge.
 *
 * WHAT THAT BUYS AN ATTACKER, precisely. With the variable set the shell
 * reports source 'env' and no baseUrl, because a proof file names no port. The
 * renderer (src/mission-bridge.js, configuredBaseUrl) then falls through to
 * scanWellKnownBridges() and trusts the first structurally-valid /v1/runtime
 * responder on 127.0.0.1:4610-4619 -- the discovery-by-guess the supervised
 * pin was built to end. A process that squatted a low port in that range
 * answers first, receives this boot's bootstrap proof, and replays it to the
 * genuine layer for a bearer and full dispatch, which includes host_exec.
 *
 * The proof file is owner-ACL'd so that only the owner can read it. Handing it
 * to whoever answers a guessed port gives away exactly what that ACL protects.
 *
 * SO THE DISCRIMINATOR IS PACKAGED, NOT PRESENT. In a packaged build there is
 * no legitimate user for this path: nobody is debugging an externally started
 * bridge inside a customer's install. Unpackaged, the path is genuinely useful
 * and removing it would push developers toward worse workarounds. Electron
 * exposes the exact distinction as app.isPackaged, and that is the whole of the
 * change.
 *
 * IT IS FENCED WHERE THE PROOF IS READ, NOT AT THE TWO READERS. main.cjs had
 * three ways for an env proof to reach a caller: the first branch of
 * currentBridgeProof(), the first branch of currentBridgeEndpoint(), and -- the
 * one easy to miss -- currentBridgeProof()'s tail, `capabilityLayerStatus.ok ?
 * bridgeProof : ...`, which hands back the same env-derived value. Fencing the
 * single place the value is produced closes all three and cannot drift out of
 * step with a fourth reader added later.
 *
 * IT IGNORES, IT DOES NOT REFUSE TO START, AND THAT IS A SECURITY JUDGEMENT.
 * Refusing to launch would turn one unprivileged registry write into a
 * permanent denial of service against the installed product: the same attacker
 * who cannot escalate any more could still brick every future launch, and the
 * customer's own data would be behind an app that will not open. Ignoring the
 * variable keeps the supervised path working exactly as it does on a clean
 * machine, so the tampering costs the attacker their persistence and costs the
 * customer nothing.
 *
 * IT IS NOT SILENT. A compromised launch must not look identical to a normal
 * one, so a refusal writes a durable record next to the user's data. It is a
 * file rather than a console line for the reason given at the top of
 * shell/main.cjs: shell build diagnostics are stripped from the shipped app, so
 * a console line is not a diagnostic a customer or support could ever read.
 * The record is also reported through the bridge IPC results, so any surface
 * that wants to show it can, without this module owning any UI.
 */

const REFUSAL_RECORD_NAME = '.bridge-env-refusal.json'
const PROOF_ENV = 'MC_BRIDGE_PROOF_FILE'

const REFUSAL_REASON = `${PROOF_ENV} is set, but this is a packaged build, where that variable is not honoured. `
  + 'It selects a bridge that was started outside this app, which a packaged install has no legitimate use for. '
  + 'The app is using its own supervised capability layer instead. '
  + 'If you did not set this variable, another program running as your Windows user set it, and you should treat this machine as tampered with.'

/* Whether the variable is set at all, kept separate from whether it is usable
   so a refusal can say the variable was present without reading the file it
   points at. Nothing here touches the filesystem. */
function envProofRequested({ env = process.env } = {}) {
  const value = env?.[PROOF_ENV]
  return typeof value === 'string' && value.trim() !== ''
}

/* The one decision, and the one place an env-derived proof can be produced.
 *
 * Returns a value shaped exactly like readBridgeProof's, so every existing
 * caller in main.cjs keeps working unchanged, plus the two facts a diagnostic
 * needs: whether the variable was set, and whether it was refused for being
 * set in a packaged build.
 *
 * isPackaged is required rather than defaulted. A default would silently pick
 * a side for a caller that forgot to pass it, and the safe side and the
 * convenient side are opposites here: defaulting to false re-opens the hole for
 * anyone who mis-wires it. An absent or non-boolean value is treated as
 * packaged -- fail closed -- because "I could not tell" must not grant the
 * developer path. */
function resolveEnvBridgeProof({ env = process.env, isPackaged, readBridgeProof, readFileSync } = {}) {
  const requested = envProofRequested({ env })
  const packaged = isPackaged !== false

  if (requested && packaged) {
    return { ok: false, reason: REFUSAL_REASON, envProofRequested: true, envProofRefused: true }
  }

  const resolved = typeof readBridgeProof === 'function'
    ? readBridgeProof({ env, readFileSync })
    : { ok: false, reason: `${PROOF_ENV} could not be read: no reader was provided.` }

  return { ...resolved, envProofRequested: requested, envProofRefused: false }
}

/* The durable half of "not silent".
 *
 * Written before anything depends on it and never thrown from: a diagnostic
 * that can crash the boot it is diagnosing is worse than no diagnostic. A
 * launch that is NOT refused clears any previous record, so the file's presence
 * always describes the most recent launch rather than accumulating a claim that
 * has since stopped being true. */
function recordEnvProofRefusal({ directory, refused, fs, path, now = () => new Date().toISOString() } = {}) {
  if (!directory || !fs || !path) return { written: false, cleared: false }
  let file
  try {
    file = path.join(directory, REFUSAL_RECORD_NAME)
  } catch {
    return { written: false, cleared: false }
  }

  if (!refused) {
    try {
      fs.rmSync(file, { force: true })
      return { written: false, cleared: true, file }
    } catch {
      return { written: false, cleared: false, file }
    }
  }

  try {
    fs.writeFileSync(file, `${JSON.stringify({
      status: 'refused',
      variable: PROOF_ENV,
      reason: REFUSAL_REASON,
      at: now(),
    }, null, 2)}\n`)
    return { written: true, cleared: false, file }
  } catch {
    return { written: false, cleared: false, file }
  }
}

module.exports = {
  PROOF_ENV,
  REFUSAL_REASON,
  REFUSAL_RECORD_NAME,
  envProofRequested,
  resolveEnvBridgeProof,
  recordEnvProofRefusal,
}
