# Linux platform parity: design and acceptance plan

2026-09-05. Development plan, not a release certificate or a claim that every
feature works on Linux. Baseline inspected: app `387cff94`, engine `8a1392e5`.
Implementation lanes below are being integrated separately from that baseline.

## Product decision

Windows and Linux use one app/engine history and the same public contracts.
Operating-system adapters implement native authority and lifecycle; they do not
fork workflow, approval, entitlement, or audit policy. Development normally runs
from an immutable source generation, without making an installer on every edit.
See [the shared API boundary](linux-development-api-boundary.md).

LIVE startup requests a committed source exchange. Each machine independently
builds and checks that source before selecting a new immutable generation. An
open session keeps its original engine until a controlled restart. Offline
startup uses compatible local and cached Git commits. Dirty work is preserved,
not silently committed, overwritten, or treated as a validated build. Different
native binaries are expected; the app/engine commit pair and API must agree.

The current private workspace has authenticated peer Git transport but no
independent hosted GitHub upstream configured. A public repository's existence
does not authorize publishing private source or copying machine credentials.
SSH source synchronization is development infrastructure, not FRA enrollment.

## Capability and error contract

Extend the authenticated contract in engine
`src/lib/mission-bridge/api-contract.js`; do not maintain a second action list.
Readiness must distinguish at least:

- `available`: native prerequisites are verified; individual actions still need
  their normal permission, scope, and approval checks.
- `needs-owner-action`: a supported adapter needs a local unlock, consent,
  installation, sign-in, or enrollment. No automatic consent or credential import.
- `unsupported`: the installed build has no qualified adapter for this platform.
- `unknown`: a probe failed, timed out, or cannot establish current state.

These are proposed contract states, not fields already negotiated by every
caller. Publish stable feature IDs, platform-adapter versions, bounded reason
codes, and current probe time; never publish owner paths, secret values, session
credentials, or raw child-process diagnostics. A capability listing is neither
authorization nor a promise to retry a write. Breaking schema changes require a
new contract version and cross-platform compatibility tests.

## System-by-system design

Paths in the engine column are relative to the engine repository; `shell/` paths
are relative to the desktop app. "Existing" means source exists, not that native
acceptance is complete. Every row needs both positive and adversarial evidence.

| System and source seams | Linux design | Acceptance required before claiming parity |
| --- | --- | --- |
| Owner authority / private IPC: `src/owner-host.js`, `src/lib/agent-session-credential.js`, `tools/mcp-owner-proxy.js` | Kernel UID identity, non-root owner, private Unix socket and route directory; authenticate peer credentials before exchanging binding/session material. Retain tier, scope, expiration and revocation policy. Linux adapter implementation is the first authority lane. | Real bind, resolve, dispatch and revoke across separate processes. Reject foreign peer, root/effective-UID mismatch, stale PID, missing peer-credential helper, symlink, replaced route, broad permissions and malformed frames. Same-UID compromise is not solved by a UID check; capability secrecy and agent confinement remain separate boundaries. |
| Filesystem / profile / workspace authority: `src/lib/account-profile-boundary.js`, `workspace-boundary.js`, `runtime-state-root.js` | Linux-specific identity based on opened directory/file descriptors, device/inode and UID. Resolve beneath approved roots; reject symlink/magic-link escape, unapproved mount crossing and group/other or named-ACL write access at security roots. Separate mutable state from executable source. | Rename/replacement races, hardlinks, symlinked ancestors, bind mounts, case sensitivity, spaces/Unicode, foreign ownership and writable ancestors. Validate new files through retained parent descriptors. Do not treat Windows profile checks, lexical paths or one `realpath` result as Linux confinement. |
| Secret custody: `src/lib/runtime.js`, `vault-location.js`, `vault-platform.js`, `vault-presence.js`; `shell/vault-presence.cjs` | Separate Linux encrypted vault backed by an explicitly supported persistent Secret Service key store. First implementation targets an encrypted GNOME login collection, not arbitrary Secret Service-compatible daemons. No plaintext fallback, default unlock, Windows DPAPI import, or renderer access to secrets. Shell calls must be asynchronous. | Real encrypted persistence across processes, locked/unavailable keyring refusal, missing/ambiguous backend key refusal, authenticated-ciphertext tamper rejection, private files/locks, denied-record oracle tests and bounded child failure. An unreadable store means unknown, never empty. Disposable private keyring evidence does not mean the owner's keyring is unlocked. |
| Canonical audit / protected checkpoints: `src/lib/audit.js`, `audit-checkpoint.js`, `audit-store.js`; `shell/canonical-audit-worker.cjs` | Keep the existing signature and chain contract; route key custody and monotonic anchors through the Linux backend. Do not reuse an in-memory successful checkpoint after the backend locks or loses its key. | Real signed record verification, concurrent writers, crash/restart, rollback/fork refusal, truncated/tampered log, locked backend after a successful write, fail-closed admission and no secret diagnostics. Encryption alone does not make the ciphertext file rollback-resistant; restore of both vault and independent anchor remains an explicit threat-model limit. |
| Agent permission tiers / account isolation: `src/lib/agent-session-confinement.js`, `agent-engine/*`, `providers/subscription-launch-env.js` | Keep generated per-session account/config homes and scrubbed environments. Use a measured Linux filesystem/network sandbox with the existing owner capability. A requested SDK permission string is not proof of enforcement. | For every supported provider/tier, perform an allowed operation and refuse a forbidden sibling/outside-root write. Exercise child processes, inherited descriptors, ambient credentials, symlink escape, network policy, cancellation and capability revocation. Windows sandbox evidence is not Linux evidence. |
| Owned process trees / cancellation: `src/lib/windows-job-control.js`, `proc/hidden-spawn.js`, `fleet-supervisor/kill-tree.js`; `shell/spawn-record.cjs`, `tools/process-tree.cjs` | Add an explicit Linux process-ownership adapter using per-launch cgroups/user units and stable process handles where available. Preserve stdout/stderr closure, deadline and descendant-termination semantics. Existing non-Windows `spawnInJob` fallback is ordinary spawn, not Job Object parity. | Child/grandchild escape and reparenting, root exits before child, ignored TERM, timeout, PID reuse, wrapper crash, open pipes and exact owned-tree empty proof. Never signal by process name or infer completion from root exit alone. Unsupported ownership must be reported, not relabeled as native containment. |
| Background services / scheduler / keepers: `src/lib/service-control.js`, `scheduler-adapter.js`, `providers/scheduler.js`, `tools/fra-keeper*`, managed-process registrars | Product-owned user services and timers with explicit environment, executable generation, state directory and restart policy. Windows task XML remains a Windows adapter. Existing Linux listener observation is reusable but does not implement service mutation. The private LIVE sync user service is not the product scheduler. | Register/query/start/stop/remove only exact owned units; logout/reboot, timer missed-run/idempotency, locked session, port collision, wrong listener, concurrent starts and source generation replacement. Restart success requires the expected new process identity and service health. |
| Direct FRA root / permission binding: `src/lib/fra-root-access.js`, `fra-transport-binding.js`, `src/lib/providers/fra-workspace-handles.js` | A distinct Linux policy digest binds UID, root descriptor identity and Linux access policy. Keep the existing Windows DACL digest for Windows peers. Version and validate expected peer policy by platform before enrollment/transport admission; do not merely remove `win32` refusal. See the [proposed authority contract](fra-linux-authority-contract.md). | Cross-platform policy negotiation, mismatched digest, replaced/moved root, ACL/mount escape, forbidden workspace handle, expired/revoked scope and denied remote write. Runtime integrity and approved permission manifests must bind the exact native adapter. |
| FRA secure sessions / website / enrollment: `src/lib/online-fra-e2e-session.js`, `fra-secure-session.js`, token enrollment, `tools/online-fra-claim-cli.js`, `tools/relay-shell.js` | Reuse production authenticated encryption and enrollment contracts. Begin with fresh disposable identities over pinned SSH transport; then separately qualify website rendezvous, device claim, relay/direct selection, persisted pairing and revocation. Website account creation does not grant device enrollment. | Actual bidirectional sealed exchange between Linux and Windows, wrong peer/tamper/replay rejection and clean native process termination. Then a verified test account, real claim/consent, reconnect, relay interruption, duplicate remote writes, token rotation/revocation and audit on both sides. SSH-carried E2E proof must not be described as website or direct FRA qualification. |
| FRA firewall / network exposure | Keep the local bridge loopback-only. Default remote access to authenticated outbound relay/tunnel; explicit direct listeners require narrowly scoped Linux firewall policy and enrollment. Preserve Windows firewall rules and unrelated networking. | Confirm actual addresses/interfaces and listeners, unauthorized connection refusal, policy rollback, offline transition and interface changes. No broad firewall disable or unauthenticated LAN HTTP bridge. |
| Owned browser / OAuth / web automation: `src/lib/browser-owner.js`, `agent-browser-*`, `google-oauth.js`; `shell/google-signin.cjs`, `provider-login.cjs` | Reuse existing Linux owned-browser process/listener probes and dedicated profiles; keep ordinary user browsers out of scope. Browser/OAuth state and redirect origins remain bound to one login attempt. Add Linux-native CLI discovery/install decisions rather than Windows command shims. | Actual owned launch, account URL navigation, CDP ownership, close exact tree, profile in use, stale/reused PID and unrelated browser preservation. Real test-account OAuth with state/PKCE where the provider contract requires it, cancellation, callback confusion, token custody and logout; no importing cookies from old Windows profiles. |
| Desktop capture / input / dialogs: `src/lib/desktop.js`, `tools/desktop.ps1`, `providers/duo-desktop*`, owner prompt helpers | Separate X11 and Wayland adapters. Prefer compositor/desktop portal sessions for explicit capture/input permission; expose unavailable operations honestly. Do not translate arbitrary Windows UI automation into root-level Linux input injection. | Consent granted/denied/revoked, multiple monitors and scale factors, focus/window identity, stale screenshot, lock screen, session disconnect and cancellation. X11 success does not qualify Wayland. Interactive approval dialogs must remain owner-controlled. |
| Voice / microphone / clipboard: `shell/voice-host.cjs`, `voice-permissions.cjs`, renderer voice controllers and paste handling | Retain the existing Linux venv path branch; qualify actual audio devices, privacy permissions and owned worker lifetime. Clipboard content comes only from the user's specific paste event, not background OS reads. | Real capture/start/stop, permission denial/revocation, missing model/runtime, unplugged device, worker crash, renderer reload, no recording after cancellation and no unintended clipboard acquisition. Test without sending private audio to a service. |
| Host tools / device integrations / iPhone: `src/lib/providers/host-control.js`, `providers/iphone-handoff.js`, platform-specific Duo, drive and login helpers | Keep portable protocol/HTTP logic shared. Implement native executable discovery and argument-vector launches per OS. Windows USB readiness is not a Linux device adapter or proof of phone pairing. Device/interactive integrations get explicit unavailable states until qualified. | Native dependency absent/wrong version, paths with spaces, shell injection, exact process ownership and permission refusal. Real device tests only with the owner's selected device; no false empty-success adapters. The four currently unconnected iPhone controller modules remain a real Windows release blocker until composed and tested at their actual intended boundary. |
| Install / update / startup / uninstall: `shell/install-profile-guard.cjs`, Windows PE identity tools, payload boundaries, LIVE generation tooling | Linux-native signed/reproducible release artifacts, per-user data/desktop entry, explicit executable dependency closure and rollback-safe immutable updates. Preserve existing Windows installer identity/elevation. Source LIVE needs no installer for routine edits. | Clean-account installation, offline startup, desktop entry launch, app/engine API compatibility, native dependency closure, sandbox/fuses, atomic selection/currentness, open-session lock, failed update recovery and uninstall retention. Windows PE/signature checks are not Linux artifact checks. |
| Cross-platform gates / provider-independent logic | Run shared schema, policy, approvals, registry, state and cryptographic tests on both OSes. Classify native tests explicitly and add real platform tests; do not replace Windows paths indiscriminately or expand orphan/payload exemptions. | Reconcile current pre-existing failures separately from regressions. Every new runtime module has a real production invocation and payload membership; every new test has an executing suite path. Passing a UI smoke proves rendering and its measured contract, not all provider features. |

## Delivery order

1. **Running source LIVE and shared source selection.** Verify actual owner GUI,
   child engine generation, authenticated contract and source request on launch.
   Keep native activation distinct from common-source selection. This foundation
   is running on Linux; Windows promotion is still independently gated.
2. **Owner authority, secure custody and audit.** Integrate the Linux IPC and
   vault lanes, including real-process adversarial tests and asynchronous shell
   reads. Do not expose more actions merely because an adapter loads.
3. **Initial paired FRA proof.** Exercise the real production secure-session
   implementation on both machines with disposable test identities. Record
   transport, source hashes, native terminal outcome and negative controls.
4. **Confinement and lifecycle parity.** These are prerequisites for claiming
   unattended Linux agents, scheduler or direct FRA operation. Qualify native
   ownership and filesystem permission adapters before enabling remote effects.
5. **Enrolled remote workflow and interactive integrations.** Qualify website
   claim/relay and approved remote actions; then browser, desktop, voice and
   device features on their actual native backends.
6. **Native release acceptance.** Package when testing installer/update/shipped
   resource behavior, not on every source edit. Require Windows and Linux native
   evidence for the exact shared source pair; retain last-good selections when
   either platform refuses.

## Evidence and remaining owner actions

Each increment records exact app/engine commits, platform/tool versions, test
command, exit/termination state, positive and negative cases, proof scope and
outstanding failures. Keep generated state, keys and receipts private and out of
the source payload. Never use an older pair's full test run as a newer pair's
native release verdict.

An owner may still need to unlock their local persistent keyring, grant desktop
or microphone permissions, complete website email/OAuth verification, or consent
to device enrollment. Existing authorization to develop and restart Linux LIVE
does not supply a missing credential or substitute for those interactive acts.

## Native API references for the proposed adapters

These references inform the design, not claims that the adapters are complete.
Descriptor-relative Linux path resolution can explicitly constrain symlink,
magic-link and mount traversal; final-component `O_NOFOLLOW` alone is not the
same policy. See the upstream [openat2 manual](https://man7.org/linux/man-pages/man2/openat2.2.html).

The desktop portal RemoteDesktop interface provides a session-based boundary
for choosing devices and requesting remote input access. Its availability and
consent behavior still require native compositor tests. See the
[XDG RemoteDesktop interface](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html).
