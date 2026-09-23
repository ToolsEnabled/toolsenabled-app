// Human-executable, source-backed journeys. These descriptors do not execute
// login, claims, providers, paid sends, or cleanup and are not evidence.
const s = (id, action, expected) => Object.freeze({ id, action, expected })
const SAFARI_WINDOW_BOUNDARY = 'Keep one Safari/desktop UI window at a time; close and confirm the prior window before another opens. If closure is uncertain, preserve the existing Safari hold and mark BLOCKED/NOT_RUN.'
const HOSTED_FIXTURE_BOUNDARY = 'If the physical phone or approved hosted endpoint is unavailable or held, mark BLOCKED/NOT_RUN; do not substitute a fixture.'
const DESKTOP_FIXTURE_BOUNDARY = 'If the physical phone, owned Linux/Windows desktop endpoint, desktop native bridge, or approved hosted endpoint is unavailable or held, mark BLOCKED/NOT_RUN; do not substitute a fixture.'
const HOSTED_SURFACE_BOUNDARY = 'Hosted sign-in uses the known /signin/ route, the first visible form (form.first()), and same-origin /v1/account; authenticated/logout selectors are unknown from this source snapshot.'
const HOSTED_SELECTOR_UNKNOWN = 'Hosted authenticated/session-control selector unknown from this source snapshot; only a fresh visible user control counts.'
const SURFACE_SWITCH_BOUNDARY = 'Before switching between Safari and desktop, close and confirm the current UI. The supported endpoint/bridge must remain alive with its UI closed; if closing the UI stops it or closure is uncertain, mark BLOCKED/NOT_RUN.'
export const MANUAL_PATHS = Object.freeze([
  Object.freeze({
    id: 'mobile-account-login-logout', title: 'Manual mobile hosted account login and logout',
    surfaces: Object.freeze(['mobile', 'hosted']),
    evidence: 'manual hosted/mobile observation',
    scope: 'Manual hosted account session on a mobile browser at /signin/; not the local desktop account profile, scripted browser runner, or FRA enrollment.',
    prerequisites: Object.freeze([
      'Dedicated isolated test account without production data, payment, or provider credentials',
      'Approved hosted endpoint and fresh mobile profile; retain endpoint identity in the evidence',
      HOSTED_SURFACE_BOUNDARY,
      SAFARI_WINDOW_BOUNDARY,
      HOSTED_FIXTURE_BOUNDARY,
    ]),
    steps: Object.freeze([
      s('open-hosted-signin', 'On the physical phone or mobile browser, open the hosted /signin/ route.', 'The first visible hosted sign-in form (form.first()) and its user-visible submit control are present, or an explicit unavailable/refusal state is observed. ' + HOSTED_SELECTOR_UNKNOWN),
      s('login', 'Use the supported hosted controls in the first visible form (form.first()) and submit it.', 'A fresh same-origin /v1/account read confirms authenticated state and a visible hosted session/account control; its selector is unknown, and fixture or stale state is not accepted.'),
      s('logout', 'Use the fresh visible hosted session/logout control (selector unknown) once and wait for the hosted view to refresh.', 'Same-origin /v1/account returns anonymous and /signin/ form.first() is visible; refusal or uncertainty remains BLOCKED/NOT_RUN.'),
      s('close-window', 'Close and confirm the mobile/Safari window before another UI window opens.', 'The existing Safari hold is released only after closure is confirmed; uncertain closure remains BLOCKED/NOT_RUN.'),
    ]),
  }),
  Object.freeze({
    id: 'phone-account-login-logout', title: 'Manual physical-phone Safari account login and logout',
    surfaces: Object.freeze(['mobile', 'phone', 'hosted']),
    evidence: 'manual physical-Safari observation',
    scope: 'Manual physical-phone Safari session against hosted /signin/; no native ToolsEnabled phone build is assumed.',
    prerequisites: Object.freeze([
      'Owned physical phone with Safari and a fresh isolated browsing state',
      'Approved hosted account endpoint and isolated test account without production data, payment, or provider credentials',
      HOSTED_SURFACE_BOUNDARY,
      SAFARI_WINDOW_BOUNDARY,
      HOSTED_FIXTURE_BOUNDARY,
    ]),
    steps: Object.freeze([
      s('open-safari-signin', 'In Safari on the physical phone, open the hosted /signin/ route.', 'The first visible hosted sign-in form (form.first()) and its user-visible submit control are present, or an explicit unavailable/refusal state is visible. ' + HOSTED_SELECTOR_UNKNOWN),
      s('login-safari', 'Use the supported Safari controls in the first visible form (form.first()) and submit it.', 'A fresh same-origin /v1/account read confirms authenticated state and a visible hosted session/account control; its selector is unknown, and emulated or fixture state does not count.'),
      s('logout-safari', 'Use the fresh visible hosted session/logout control (selector unknown) and wait for the hosted view to refresh.', 'Same-origin /v1/account returns anonymous and /signin/ form.first() is visible; an uncertain hosted result remains BLOCKED/NOT_RUN.'),
      s('close-safari', 'Close and confirm the Safari window before another UI window opens.', 'The existing Safari hold is released only after closure is confirmed; uncertain closure remains BLOCKED/NOT_RUN.'),
    ]),
  }),
  Object.freeze({
    id: 'phone-fra-claim', title: 'Manual physical-phone Safari and desktop FRA claim',
    surfaces: Object.freeze(['mobile', 'phone', 'hosted', 'packaged']),
    evidence: 'manual physical-Safari + desktop observation',
    scope: 'Manual physical-phone Safari hosted account confirmation plus separately identified owned Linux/Windows desktop Connect this computer controls; authenticated FRA is excluded from the scripted browser matrix.',
    prerequisites: Object.freeze([
      'Dedicated isolated test account without production data, payment, or provider credentials',
      'Owned physical phone with Safari for hosted /signin/ and /account/ account/machine pages',
      'Owned Linux/Windows desktop endpoint with the qualified app and desktop native bridge; Connect this computer is desktop-only',
      HOSTED_SURFACE_BOUNDARY,
      SAFARI_WINDOW_BOUNDARY,
      DESKTOP_FIXTURE_BOUNDARY,
      SURFACE_SWITCH_BOUNDARY,
    ]),
    steps: Object.freeze([
      s('safari-login', 'In Safari on the physical phone, open hosted /signin/ and use the first visible form (form.first()) when signed out.', 'A fresh same-origin /v1/account read confirms authenticated state; open hosted /account/ and use its visible account/machine control when present. Its selector is unknown; refusal remains BLOCKED/NOT_RUN.'),
      s('close-safari-before-desktop', 'Close and confirm Safari before switching to the owned desktop UI.', 'The supported hosted endpoint remains alive with Safari UI closed; if it stops or closure is uncertain, mark BLOCKED/NOT_RUN.'),
      s('open-desktop-connect', 'On the owned Linux/Windows desktop, open Settings > Connect this computer and inspect [data-connect-status].', '[data-connect-status] explicitly reports absent, connected, or unknown; unknown or refusal blocks and is not treated as absent.'),
      s('name-desktop', 'On that desktop, enter a non-sensitive device label in [data-connect-field="name"].', 'The bounded label remains visible in the desktop field; no credential is entered into the device-name control.'),
      s('request-desktop-code', 'On that desktop, press [data-connect-action="begin"] once.', '[data-connect-code] shows a bounded TC-... code and [data-connect-remaining] reports expiry; a second live claim is not started.'),
      s('close-desktop-before-safari', 'Close and confirm the desktop UI before switching back to Safari.', 'The supported desktop endpoint and native bridge remain alive with desktop UI closed; if closing UI stops polling or closure is uncertain, mark BLOCKED/NOT_RUN.'),
      s('confirm-safari-account', 'In Safari on the physical phone, open hosted /account/ and use its visible account/machine join control for the desktop code.', 'The visible hosted account/machine control reports pending or connected state; its selector is unknown and no desktop selector is asserted on Safari.'),
      s('close-safari-after-confirm', 'Close and confirm Safari before switching back to the desktop UI.', 'The supported hosted endpoint remains alive with Safari UI closed; if it stops or closure is uncertain, mark BLOCKED/NOT_RUN.'),
      s('verify-desktop-status', 'On the owned desktop, reopen Connect this computer and read [data-connect-status].', '[data-connect-status] confirms the same named endpoint, or explicit refusal/timeout remains BLOCKED/FAIL; no fixture is a pass.'),
      s('close-desktop', 'Close and confirm the desktop UI after the status read.', 'The supported desktop endpoint and native bridge remain alive with UI closed; otherwise mark BLOCKED/NOT_RUN.'),
    ]),
  }),
  Object.freeze({
    id: 'phone-fra-reconnect-disconnect', title: 'Manual physical-phone Safari and desktop FRA reconnect/disconnect recovery',
    surfaces: Object.freeze(['mobile', 'phone', 'hosted', 'packaged']),
    evidence: 'manual physical-Safari + desktop observation',
    scope: 'Manual physical-phone Safari hosted account listing plus separately identified owned Linux/Windows desktop reconnect/disconnect controls; no scripted or authenticated browser evidence.',
    prerequisites: Object.freeze([
      'Completed manual FRA claim for the same isolated test account, physical phone, and owned desktop endpoint',
      'Known hosted /signin/ and /account/ routes; authenticated/session selectors are unknown from this source snapshot',
      'Safari can open the hosted account listing; Connect this computer and its desktop native bridge remain available',
      'Retain the isolated desktop profile from the preceding claim; do not infer cleanup from a prior session or fixture',
      SAFARI_WINDOW_BOUNDARY,
      DESKTOP_FIXTURE_BOUNDARY,
      SURFACE_SWITCH_BOUNDARY,
    ]),
    steps: Object.freeze([
      s('inspect-safari-account', 'In Safari on the physical phone, open hosted /account/ and read its visible computer listing.', 'The visible hosted account/machine state is current; its selector is unknown and unavailable/refusal is BLOCKED/NOT_RUN.'),
      s('close-safari-before-desktop', 'Close and confirm Safari before switching to the owned desktop UI.', 'The supported hosted endpoint remains alive with Safari UI closed; if it stops or closure is uncertain, mark BLOCKED/NOT_RUN.'),
      s('inspect-desktop-connected', 'On the owned Linux/Windows desktop, reopen Connect this computer and read [data-connect-status], [data-connect-field="web-drive"], and [data-connect-disconnect-facts] when present.', 'Connected, unknown, refusal, and browser-drive consent are explicit; unknown or refusal blocks cleanup.'),
      s('disconnect-arm-desktop', 'On that desktop, press [data-connect-action="disconnect"] once and read [data-connect-disconnect-hint] before confirming.', 'The hint names connection-credential and remote-stop effects; the first press alone never claims disconnect.'),
      s('disconnect-confirm-desktop', 'Press [data-connect-action="disconnect"] again and wait for desktop [data-connect-status] or [data-connect-disconnect-facts].', 'Desktop status confirms credential/process cleanup or explicit disconnect-review/refusal; uncertainty is BLOCKED/NOT_RUN, not pass.'),
      s('reconnect-desktop', 'After positive cleanup only, press desktop [data-connect-action="begin"] once and wait for a new code.', 'A new desktop [data-connect-code] is observed and the old connection is not assumed cleared from the hosted listing.'),
      s('verify-desktop-reconnect', 'On the owned desktop, read [data-connect-status] and the new [data-connect-code] before leaving this UI.', 'Desktop status is explicitly connected/waiting for hosted confirmation; unknown or refusal is BLOCKED/NOT_RUN.'),
      s('close-desktop-before-safari', 'Close and confirm the desktop UI before switching back to Safari.', 'The supported desktop endpoint and native bridge remain alive with desktop UI closed; if closing UI stops polling or closure is uncertain, mark BLOCKED/NOT_RUN.'),
      s('confirm-safari-reconnect', 'In Safari on the physical phone, open hosted /account/ and use its visible computer-join control for the new code.', 'The visible hosted listing confirms the newly connected endpoint; its selector is unknown and refusal or timeout remains BLOCKED/FAIL.'),
      s('close-safari', 'Close and confirm Safari after the hosted confirmation and before reopening the desktop UI.', 'The supported hosted endpoint remains alive with Safari UI closed; if it stops or closure is uncertain, mark BLOCKED/NOT_RUN.'),
      s('verify-desktop-reconnected', 'On the same owned desktop, reopen Connect this computer and read [data-connect-status].', '[data-connect-status] confirms the same named endpoint is connected; the hosted listing alone is not end-to-end reconnect proof.'),
      s('close-desktop-after-reconnect', 'Close and confirm the desktop UI after verifying reconnect.', 'The supported desktop endpoint and native bridge remain alive with UI closed; otherwise mark BLOCKED/NOT_RUN.'),
    ]),
  }),
  Object.freeze({
    id: 'account-to-connected-desktop', title: 'Account sign-in to connected desktop',
    surfaces: Object.freeze(['hosted', 'packaged']),
    scope: 'authenticated account/device registration; stop before provider work',
    prerequisites: Object.freeze(['Dedicated test account without production data/payment', 'Named desktop with isolated profile and matching engine', 'One owned UI window at a time; if the flow cannot close and confirm one window before another opens, stop BLOCKED']),
    steps: Object.freeze([
      s('open-account', 'Open the account page from signed-in account navigation.', 'The account page is visible and shows the account/computer area.'),
      s('open-connect', 'In desktop Settings choose Connect this computer to your account.', 'connect_computer renders data-connect-settings and data-connect-action="begin".'),
      s('name-device', 'Enter a non-sensitive name in data-connect-field="name".', 'Bounded device name is shown as pending identity.'),
      s('request-code', 'Press data-connect-action="begin" once.', 'Phase becomes starting/waiting and bounded data-connect-code appears; no password crosses this window.'),
      s('enter-code', 'Type the displayed code into the account page join form.', 'Account page reports pending computer; desktop connects only after service confirmation.'),
      s('verify-connected', 'Return to connect settings and wait for status.', 'data-connect-status names the joined computer and account machines lists it.'),
    ]),
  }),
  Object.freeze({
    id: 'connected-desktop-to-tree-chat', title: 'Connected desktop to remote computer, tree, and chat',
    surfaces: Object.freeze(['packaged', 'browser']),
    scope: 'Navigation plus one separately approved agent turn; no paid send by default',
    prerequisites: Object.freeze(['Completed device connection', 'Online remote computer owned by test account', 'Approved local/no-op task or provider budget', 'Unique journey/run identity and attested installed subject']),
    steps: Object.freeze([
      s('open-computers', 'Open Computers and locate the connected computer.', 'Computer row and tree/chat controls are reachable.'),
      s('open-tree-chat', 'Select tree chat (.tree-box-chat; .tree-conversation[data-agent-id]).', 'Selected conversation opens without changing another context.'),
      s('inspect-status', 'Read data-chat-header-status and existing result before sending.', 'Current state is recorded; opening chat does not imply send.'),
      s('start-approved-task', 'If approved, use .tree-chat-add, .tree-new-tree, choose data-compose-field="tier", enter a non-sensitive request, press data-compose-action="start".', 'Owned .static-tree-node[data-agent-id] appears and conversation reports running/accepted.'),
      s('observe-finish', 'Wait for the owned conversation to finish and inspect its result.', 'Result remains tied to that agent id; record raw evidence, not a guessed pass.'),
      s('stop-if-needed', 'For a running task press data-chat-chip="halt" and wait for settlement.', 'Owned task reports stopped/interrupted; unrelated contexts remain untouched and cleanup is confirmed.'),
    ]),
  }),
  Object.freeze({
    id: 'desktop-reconnect-settings', title: 'Desktop relaunch, reconnect, and connection settings',
    surfaces: Object.freeze(['packaged', 'browser']),
    scope: 'Native lifecycle and connection custody; no account removal/provider action',
    prerequisites: Object.freeze(['Previously connected test desktop and retained isolated profile', 'Permission to close/relaunch only owned process', 'Cleanup owner able to retry uncertain disconnect/session cleanup']),
    steps: Object.freeze([
      s('relaunch', 'Close and relaunch installed desktop non-elevated.', 'Matching engine starts and restores only owned account/device state.'),
      s('recheck-connection', 'Open connect_computer and press data-connect-action="check-status".', 'Connected, absent, or unknown is shown; unknown is never treated as disconnected.'),
      s('toggle-web-drive', 'Inspect data-connect-field="web-drive"; change only with approval.', 'Browser-drive policy is explicit; browser cannot silently enable it.'),
      s('reconnect-tree', 'Return to Computers and open existing tree/chat context.', 'Same owned session identity is selected or a clear refusal is reported.'),
      s('custody-stop', 'If stopping, retain inspector/device ownership whenever close is uncertain.', 'Positive cleanup requires child quiescence, remote stop, and local credential/transport confirmation.'),
    ]),
  }),
  Object.freeze({
    id: 'native-install-launch-settings', title: 'Native install, launch, and first settings inspection',
    surfaces: Object.freeze(['packaged']),
    scope: 'Fresh-install smoke path; inspect only, with no account/claim/provider/deletion action',
    prerequisites: Object.freeze(['Verified release artifact and matching engine manifest', 'Fresh disposable/sterile profile with no customer credentials', 'Native runtime prerequisites and exact installed subject attestation', 'Explicit owner for sterile-profile retention/removal']),
    steps: Object.freeze([
      s('install', 'Install verified artifact through approved platform installer.', 'Non-elevated installation records exact artifact identity.'),
      s('launch', 'Launch ToolsEnabled once and wait for Home/Computers.', 'Renderer has no page errors and engine identity matches manifest.'),
      s('inspect-settings', 'Open Settings and inspect account/connect rows without mutating controls.', 'Expected controls and unavailable/unknown bridge states are clearly labeled.'),
      s('inspect-computers', 'Open Computers and compare empty/demo/connected state to sterile baseline.', 'Observed state matches baseline; no remote/provider action occurs.'),
      s('record-boundary', 'Record version, route, status, refusal text, then stop through cleanup owner.', 'Evidence identifies artifact/profile and cleanup outcome without claiming login/enrollment.'),
    ]),
  }),
])
