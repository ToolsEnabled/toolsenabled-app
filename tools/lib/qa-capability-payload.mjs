/* WHERE THE VAULT-PROGRAM DRIVERS FIND THE REAL CAPABILITY PAYLOAD.
 *
 * vault-fence-purity-qa, vault-names-live-qa, vault-removal-approval-qa and
 * vault-removal-end-to-end-qa each require real product modules (secrets.ps1,
 * approvals.js, policy.js, tool-registry.js, the path-override enumeration
 * vault-scratch-fence.mjs reads) from a capability payload that is derived
 * output and gitignored in this checkout. Before this file existed the only
 * way to name one was MC_TEST_CAPABILITY_PAYLOAD, so tools/packaged-qa-suite.mjs
 * passing --release to every driver left these four either measuring whatever
 * the env var happened to name -- not the requested candidate -- or refusing
 * outright, which is exactly the "silently measure their default build"
 * defect tools/test/packaged-qa-suite.test.mjs's exact-default routing test
 * exists to catch.
 *
 * <release>/resources/capability is not invented here: it is what
 * agent-tool-sweep-qa.mjs and agent-tools-matrix-qa.mjs already resolve as
 * their own STAGED payload, so this names the same directory the same way.
 * MC_TEST_CAPABILITY_PAYLOAD remains the fallback for a direct, manual
 * invocation with no candidate tree at hand -- an explicit --release always
 * wins, so a release run can never silently fall back to a stale env var.
 */
import path from 'node:path'

/**
 * @param {object} [options]
 * @param {string[]} [options.argv] defaults to process.argv
 * @param {NodeJS.ProcessEnv} [options.env] defaults to process.env
 * @returns {string|null} the capability payload to load real product modules
 *   from, or null when neither --release nor MC_TEST_CAPABILITY_PAYLOAD names
 *   one.
 */
export function qaCapabilityPayload({ argv = process.argv, env = process.env } = {}) {
  const index = argv.indexOf('--release')
  const release = index > -1 ? argv[index + 1] : null
  if (typeof release === 'string' && release.length > 0) {
    return path.join(path.resolve(release), 'resources', 'capability')
  }
  const explicit = env.MC_TEST_CAPABILITY_PAYLOAD
  return typeof explicit === 'string' && explicit.length > 0 ? explicit : null
}
