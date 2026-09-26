/* Optional owner setup, not a system-package installer or an auth action.
 * There is no approved generic external-link opener.
 * Keep the official addresses selectable, not navigable: opening instructions
 * must never become an unapproved navigation or an automatic package install.
 */
export function dockerSetupMarkup({ preparationSupported = typeof window !== 'undefined' && window.mcSetup?.sandboxPreparationSupported === true } = {}) {
  return `<section aria-label="Optional Docker setup" data-setup-sandbox>
    <h2 class="setup-subtitle">Optional: run tests in a sandbox</h2>
    <p class="settings-desc">Docker is not required for normal Claude or Codex agents, tree delegation, or editing work. It is required for ToolsEnabled sandbox execution, where agents run JavaScript tests in a separate container.</p>
    <p class="settings-desc" data-sandbox-status role="status">Docker status is unverified. Check readiness below. Installing Docker alone does not establish sandbox readiness.</p>
    <button type="button" data-sandbox-action="check">Check sandbox readiness</button>
    <button type="button" data-sandbox-action="prepare"${preparationSupported ? '' : ' disabled'}>Prepare sandbox image…</button>
    ${preparationSupported ? '' : '<p class="settings-desc">Automatic image preparation is unavailable on this platform or build. Sandbox readiness checks and normal agents remain available.</p>'}
    <p class="settings-desc">Preparing uses your existing Docker engine and may download and build the fixed image after a native confirmation. No system packages or Docker permissions are changed. Interactive cancellation is not supported; you can finish normal setup without this step.</p>
    <details class="setup-docker-guidance">
      <summary>Set up Docker (optional)</summary>
      <p class="settings-desc">You can finish setup now and return later. Expanding these instructions installs nothing and changes no permissions.</p>
      <p class="settings-desc">On Linux, use Docker's official rootless installation instructions. Keep the application running as your normal user. On Windows, use Docker Desktop with Linux containers. The sandbox requires a compatible Linux/amd64 engine, Docker 28 or newer, and working memory and process limits.</p>
      <p class="settings-desc">Linux sandbox file sharing also requires Python 3 and the ACL utilities (setfacl and getfacl). These are used only to verify the local daemon and grant access to the sandbox's disposable workspace.</p>
      <p class="settings-desc">Copy the appropriate official address into your browser.</p>
      <dl class="setup-docker-addresses">
        <dt>Linux: rootless Docker</dt>
        <dd><code>https://docs.docker.com/engine/security/rootless/</code></dd>
        <dt>Windows: Docker Desktop</dt>
        <dd><code>https://docs.docker.com/desktop/setup/install/windows-install/</code></dd>
      </dl>
      <p class="settings-desc">The sandbox also needs the pinned ToolsEnabled image and a successful sandbox readiness check. It receives a separate disposable workspace, not your whole project or home folder. Sandbox failures do not fall back to running commands on your computer without isolation.</p>
    </details>
  </section>`
}

export async function runDockerSetupAction(section, action, bridge) {
  const status = section.querySelector('[data-sandbox-status]')
  if (!status || !['check', 'prepare'].includes(action)) return
  const method = action === 'check' ? 'sandboxStatus' : 'prepareSandbox'
  if (action === 'prepare' && bridge?.sandboxPreparationSupported !== true) { status.textContent = 'Automatic image preparation is unavailable on this platform or build. Sandbox readiness checks remain available.'; return }
  if (typeof bridge?.[method] !== 'function') { status.textContent = 'Sandbox setup is unavailable in this build. Docker remains optional for normal agents.'; return }
  const buttons = [...section.querySelectorAll('[data-sandbox-action]')]
  if (section.sandboxActionPending) return
  section.sandboxActionPending = true
  const originalDisabled = buttons.map(button => button.disabled)
  buttons.forEach(button => { button.disabled = true })
  status.textContent = action === 'check' ? 'Checking sandbox readiness…' : 'Waiting for confirmation or preparing the image. This may take several minutes…'
  try {
    const answer = await bridge[method]()
    status.textContent = answer?.ok === true && answer.ready === true && answer.status === 'ready'
      ? 'Sandbox image and Docker readiness verified. Normal agents remain independent of Docker.'
      : answer?.code === 'SANDBOX_SETUP_DECLINED' ? 'Preparation canceled before starting. Docker remains optional.'
        : answer?.code === 'SANDBOX_SETUP_BUSY' ? 'Another sandbox operation is still finishing. Try checking again later.'
          : answer?.code === 'SANDBOX_SETUP_TIMEOUT' ? 'The setup deadline elapsed. Docker work may still be finishing; no cancellation or readiness is claimed.'
            : answer?.code === 'SANDBOX_SETUP_RECOVERY_REQUIRED'
              ? 'An earlier image preparation may still be running. If it finishes successfully, retry. If it was interrupted, restart this Linux computer before preparing again; restarting only ToolsEnabled does not prove Docker stopped.'
              : answer?.code === 'SANDBOX_SETUP_JOURNAL_UNREADABLE'
                ? 'The sandbox preparation record is incomplete or unreadable. It needs support review; rebooting is not a guaranteed repair. No record was automatically removed and no new build was started.'
              : answer?.code === 'SANDBOX_SETUP_COORDINATION_UNSUPPORTED'
                ? 'Automatic image preparation is not yet supported safely on this platform. Normal agents and sandbox readiness checks remain available.'
            : answer?.code === 'SANDBOX_IMAGE_NOT_PROVISIONED' || answer?.code === 'SANDBOX_IMAGE_BUILD_REQUIRED'
              ? 'Docker was checked, but this profile has no prepared sandbox image. Choose Prepare sandbox image to verify an existing image or approve a fixed image build.'
              : answer?.code === 'SANDBOX_DOCKER_UNAVAILABLE'
                ? 'Docker is unavailable or not running. Follow the optional Docker instructions below, start your Docker engine, then check again.'
                : answer?.code === 'SANDBOX_LINUX_WORKSPACE_REFUSED'
                  ? 'Linux sandbox prerequisites could not be verified. Check your local rootless Docker engine, Python 3, and the setfacl/getfacl utilities using the instructions below.'
                  : answer?.code === 'SANDBOX_DOCKER_INCOMPATIBLE'
                    ? 'Docker does not meet the sandbox requirements: Linux/amd64, Docker 28 or newer, and working memory and process limits.'
                    : ['SANDBOX_IMAGE_LOCK_STALE', 'SANDBOX_IMAGE_LOCK_INVALID', 'SANDBOX_IMAGE_UNTRUSTED'].includes(answer?.code)
                      ? 'The sandbox image or its lock could not be verified. Review the fixed image requirements below and use Prepare sandbox image; an untrusted image will not be silently replaced.'
            : 'Sandbox readiness has not been established. Check the Docker, Python 3, ACL utilities and pinned image requirements below, then try again.'
  } catch { status.textContent = 'Sandbox setup could not be completed. No readiness was established.' }
  finally { section.sandboxActionPending = false; buttons.forEach((button, index) => { button.disabled = originalDisabled[index] }) }
}
