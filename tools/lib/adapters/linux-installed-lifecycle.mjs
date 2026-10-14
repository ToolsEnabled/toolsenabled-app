import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestRecord, measureFile } from './artifact-files.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const LINUX_INSTALLED_LIFECYCLE_PROFILES = Object.freeze(['linux-x64-standard', 'linux-x64-install-authorized']);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const LINUX_INSTALLED_LIFECYCLE_REQUIREMENTS = freeze({
  'fresh-install': { scope: 'exact-installer-lifecycle', assertions: [
    'exact-installer-executed', 'shortcut-starts-installed-product', 'first-run-completes'] },
  'durable-critical-journey': { scope: 'exact-installed-desktop', assertions: [
    'installed-ui-starts-shipped-engine', 'supported-provider-start-response-stop', 'result-persists-after-full-relaunch'] },
  upgrade: { scope: 'exact-installer-lifecycle', assertions: [
    'supported-upgrade-source-installed', 'exact-candidate-upgrade-executed', 'user-data-survives', 'upgraded-product-relaunches'] },
  'uninstall-reinstall': { scope: 'exact-installer-lifecycle', assertions: [
    'installed-product-uninstalled', 'documented-data-policy-preserved', 'exact-candidate-reinstalled', 'reinstalled-product-relaunches'] },
  'privilege-isolation-recovery': { scope: 'exact-installed-desktop', assertions: [
    'chosen-privilege-observed', 'profile-boundary-enforced', 'failure-is-observable', 'recovery-preserves-user-data'] },
  'advertised-integrations': { scope: 'exact-installed-desktop', assertions: [
    'supported-provider-matrix-complete', 'supported-multi-machine-path-complete', 'payments-remain-inert'] },
  'update-delivery': { scope: 'exact-installer-lifecycle', assertions: [
    'actual-update-delivery-path', 'exact-candidate-selected', 'interrupted-update-recovers'] },
});
const COMPONENTS = Object.freeze([
  'adapters/linux-installed-lifecycle.mjs', 'adapters/artifact-files.mjs',
  'guest/linux-installed-state.mjs', 'drivers/linux-lifecycle-evidence.mjs',
]);
export function linuxInstalledLifecycleImplementationIdentity() {
  return digestRecord(Object.fromEntries(COMPONENTS.map(name => [name, measureFile(path.join(ROOT, name))])));
}
const LOADED_IDENTITY = linuxInstalledLifecycleImplementationIdentity();
const refusal = id => ({
  reason: `No attested Linux guest transport executes and authenticates the ${id} scenario. Filesystem measurements and raw-report integrity checks do not prove installation, native runtime, assertions or owned cleanup.`,
  remedy: 'Provide the reviewed disposable Linux guest/configuration/attestation and real scenario driver; register only after native execution and independent evidence verification exist.',
});
export function linuxInstalledLifecycleScenarioCensus() {
  return Object.entries(LINUX_INSTALLED_LIFECYCLE_REQUIREMENTS).map(([id, definition]) => ({
    id, adapterId: `linux:${id}:v1`, scope: definition.scope, driver: null,
    executableScenario: false, refusal: refusal(id),
  }));
}
function block(message, reason = 'LINUX_GUEST_UNAVAILABLE') {
  const error = new Error(`Linux installed lifecycle qualification blocked: ${message}`);
  error.code = 'LINUX_INSTALLED_LIFECYCLE_BLOCKED'; error.reason = reason;
  error.cleanupUnconfirmed = false; throw error;
}
async function execute(id, input) {
  const definition = LINUX_INSTALLED_LIFECYCLE_REQUIREMENTS[id];
  if (linuxInstalledLifecycleImplementationIdentity() !== LOADED_IDENTITY) block('implementation changed after load', 'IMPLEMENTATION_CHANGED');
  if (input?.required?.id !== id || input.required.scope !== definition.scope ||
      !LINUX_INSTALLED_LIFECYCLE_PROFILES.includes(input.profile) ||
      !Array.isArray(input.required.assertions) ||
      digestRecord([...input.required.assertions].sort()) !== digestRecord([...definition.assertions].sort()) ||
      input.required.adapter?.id !== `linux:${id}:v1` || input.required.adapter.sha256 !== LOADED_IDENTITY) block('wrong Linux adapter invocation', 'CONTRACT_MISMATCH');
  if (input.subject?.product !== 'toolsenabled' || input.subject.target?.platform !== 'linux' ||
      input.subject.target.arch !== 'x64' || input.subjectSha256 !== digestRecord(input.subject)) block('wrong measured Linux subject', 'SUBJECT_MISMATCH');
  // Deliberately no fallback to host commands, caller-provided guest objects,
  // Windows drivers or JSON pass flags. Registration is owned by the caller.
  block(refusal(id).reason);
}
const ADAPTERS = new Map(Object.entries(LINUX_INSTALLED_LIFECYCLE_REQUIREMENTS).map(([id, definition]) => [id, Object.freeze({
  id: `linux:${id}:v1`, sha256: LOADED_IDENTITY, proofScope: definition.scope, execution: 'real',
  supportedProfiles: LINUX_INSTALLED_LIFECYCLE_PROFILES, executableScenario: false,
  execute: input => execute(id, input),
  // No native trust root exists yet. Even a structurally valid raw report must
  // fail acceptance; readLinuxLifecycleEvidence explicitly has a narrower scope.
  verifyExecutionEvidence: async (_observation, _subject, _options = {}) => false,
})]));
export function getLinuxInstalledLifecycleAdapter(id) {
  if (!ADAPTERS.has(id)) block('unknown Linux installed lifecycle requirement', 'UNKNOWN_REQUIREMENT');
  return ADAPTERS.get(id);
}
