/* The release packager and the shipped updater must read PE identity through
 * one implementation. The CommonJS source lives under shell/ because it ships
 * in app.asar; this ESM wrapper preserves the packager's import surface. */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const identity = require('../../../shell/installer-pe-identity.cjs')

export const readExeVersionInfo = identity.readExeVersionInfo
export const WINDOWS_POWERSHELL = identity.WINDOWS_POWERSHELL

/** Refuse a built PE before it receives a candidate tag. The manifest records
 * the measured version strings exactly, but they must first identify the
 * release being cut and ProductName must still agree with the reviewed build
 * configuration. Otherwise a wrong-but-readable PE could acquire the immutable
 * tag and only be rejected later while rendering download.json. */
export function assertCandidatePeIdentity({ version, productName, measured }) {
  const expected = {
    version,
    productName,
    fileVersion: measured?.fileVersion,
    productVersion: measured?.productVersion,
  }
  const verdict = identity.comparePeIdentity(expected, measured)
  if (!verdict.ok) {
    const mismatchDetail = verdict.mismatches
      .map(({ field, expected: wanted, actual }) => `${field}: expected ${JSON.stringify(wanted)}, measured ${JSON.stringify(actual)}`)
      .join('; ')
    throw new Error(
      `candidate PE identity does not match release ${version}: ${mismatchDetail || verdict.reason}`,
    )
  }
  return verdict.identity
}
