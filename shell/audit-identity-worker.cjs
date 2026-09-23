'use strict'
const path = require('node:path')
const { parentPort, workerData } = require('node:worker_threads')
if (!parentPort || !workerData?.payloadRoot || !workerData?.stateRoot) throw new Error('Audit identity worker requires an installation context.')
process.env.TOOLSENABLED_STATE_ROOT = workerData.stateRoot
process.env.TOOLSENABLED_VAULT_PATH = path.join(workerData.stateRoot, 'vault', 'secrets.json')
const maintenance = require(path.join(workerData.payloadRoot, 'src/lib/audit-identity-maintenance.js'))
const audit = require(path.join(workerData.payloadRoot, 'src/lib/audit.js'))
async function run() {
  let result
  try {
    const options = { stateRoot: workerData.stateRoot }
    if (workerData.operation === 'probe') result = maintenance.probe(options)
    else if (workerData.operation === 'rotate') result = maintenance.rotate({ ...options, fingerprint: workerData.fingerprint })
    else if (workerData.operation === 'repair') result = maintenance.repair({ ...options, fingerprint: workerData.fingerprint, quiesced: workerData.quiesced === true })
    else if (workerData.operation === 'recover') result = maintenance.recover({ ...options, quiesced: workerData.quiesced === true })
    else if (workerData.operation === 'reveal') result = { ok: true, archivePath: maintenance.revealArchive(workerData.archivePath, options) }
    else throw Object.assign(new Error('Unsupported audit identity operation.'), { code: 'AUDIT_REKEY_INPUT_INVALID' })
  } catch (error) {
    result = { ok: false, code: error.code || 'AUDIT_REKEY_UNAVAILABLE', reason: error.code ? error.message : 'The audit identity operation could not be completed.' }
  } finally {
    try { await audit.close() } catch { result = { ...result, cleanup: 'The audit vault helper did not confirm shutdown. Restart the app.', restartRequired: true } }
  }
  parentPort.postMessage(result)
}
void run()
