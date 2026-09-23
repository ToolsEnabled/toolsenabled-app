/* The website owns hosted account management at /account/. Its bridge exposes
   machine selection; the native account bridge and standalone preview do not.
   Keep the native local-account forms out of the website's internal route. */
export function websiteAccountHref(scope = globalThis) {
  if (!['http:', 'https:'].includes(scope?.location?.protocol)) return null
  if (typeof scope?.mcShell?.getBridgeProof === 'function') return null
  const account = scope?.mcAccount
  if (typeof account?.current !== 'function' || typeof account?.signIn !== 'function'
    || typeof account?.machines !== 'function' || typeof account?.machineInUse !== 'function') return null
  return '/account/'
}
