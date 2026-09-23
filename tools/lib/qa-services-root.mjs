import path from 'node:path'

/** The explicit Electron userData selected by the shared packaged-QA launch. */
export const userDataFor = profile => path.join(profile, 'userdata')

/** The product-directory identity carried by that selected userData. */
export function machineRecordProductDirectory(profile, {
  selectedUserData = userDataFor(profile),
} = {}) {
  if (typeof selectedUserData !== 'string' || !path.isAbsolute(selectedUserData)) {
    throw new Error('the selected QA userData must be an absolute path')
  }
  const resolvedUserData = path.resolve(selectedUserData)
  const productDirectory = path.basename(resolvedUserData)
  if (!productDirectory || resolvedUserData === path.parse(resolvedUserData).root) {
    throw new Error('the selected QA userData does not name a product directory')
  }
  return productDirectory
}

/** The two declarations the payload uses to resolve an owner-fenced service
 * root for the exact userData selected by a packaged QA launch. Keeping these
 * together prevents a driver from launching one product identity and asking
 * the payload to resolve another one. */
export function machineRecordEnvironmentFor(profile, {
  selectedUserData = userDataFor(profile),
  localAppData = path.join(profile, 'local'),
} = {}) {
  machineRecordProductDirectory(profile, { selectedUserData })
  if (typeof localAppData !== 'string' || !path.isAbsolute(localAppData)) {
    throw new Error('the QA LOCALAPPDATA must be an absolute path')
  }
  return {
    LOCALAPPDATA: path.resolve(localAppData),
    TOOLSENABLED_STATE_ROOT: path.join(path.resolve(selectedUserData), 'capability'),
  }
}

/** A structural oracle only: the payload resolver below remains authoritative.
 * Comparing its answer with this launch-derived expectation makes resolver and
 * launch drift fail loudly instead of writing a machine record nobody reads. */
export function servicesRootForProfile(profile, options = {}) {
  const environment = machineRecordEnvironmentFor(profile, options)
  return path.join(environment.LOCALAPPDATA, machineRecordProductDirectory(profile, options))
}

/** Ask the selected payload for its service root, then verify that its answer
 * belongs to the exact userData identity and LOCALAPPDATA this launch supplies. */
export function resolveMachineServicesRoot(profile, machineRecord, options = {}) {
  if (!machineRecord || typeof machineRecord.resolveServicesRoot !== 'function') {
    throw new Error('the packaged payload does not expose resolveServicesRoot()')
  }
  const environment = machineRecordEnvironmentFor(profile, options)
  const measured = machineRecord.resolveServicesRoot({ env: environment })
  if (typeof measured !== 'string' || !path.isAbsolute(measured)) {
    throw new Error('the packaged payload did not resolve an absolute services root')
  }
  const expected = servicesRootForProfile(profile, options)
  const normalizedMeasured = path.resolve(measured)
  const normalizedExpected = path.resolve(expected)
  const same = (options.platform || process.platform) === 'win32'
    ? normalizedMeasured.toLowerCase() === normalizedExpected.toLowerCase()
    : normalizedMeasured === normalizedExpected
  if (!same) {
    throw new Error(`the packaged payload resolved ${normalizedMeasured}, but this launch selects ${normalizedExpected}`)
  }
  return normalizedMeasured
}
