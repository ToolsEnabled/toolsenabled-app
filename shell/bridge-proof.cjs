const fs = require('node:fs')

const PROOF_ENV = 'MC_BRIDGE_PROOF_FILE'
const PROOF_RE = /^[A-Za-z0-9_-]{43}$/

function failure(reason) {
  return { ok: false, reason }
}

function readBridgeProof({ env = process.env, readFileSync = fs.readFileSync } = {}) {
  const proofFile = env?.[PROOF_ENV]
  if (typeof proofFile !== 'string' || proofFile.trim() === '') {
    return failure(`${PROOF_ENV} is not set. Set it to the bridge bootstrap proof JSON file created for this ToolsEnabled boot.`)
  }

  let contents
  try {
    contents = readFileSync(proofFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return failure(`The bridge proof file configured by ${PROOF_ENV} was not found.`)
    }
    return failure(`The bridge proof file configured by ${PROOF_ENV} could not be read.`)
  }

  let record
  try {
    record = JSON.parse(contents)
  } catch {
    return failure('The bridge proof file is malformed JSON.')
  }

  if (!record || typeof record !== 'object' || Array.isArray(record)
      || typeof record.token !== 'string' || !PROOF_RE.test(record.token)) {
    return failure('The bridge proof file is malformed; it must contain a valid 43-character base64url token.')
  }

  return { ok: true, proof: record.token }
}

module.exports = { readBridgeProof }
