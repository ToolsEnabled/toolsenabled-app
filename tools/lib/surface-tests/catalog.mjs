// Explicit fixture-safe selections. Full means this catalog, not every product
// feature or a replacement for the existing release/native qualification gates.
const app = (id, features, smoke, extra = []) => ({ id, surface: 'source', repo: 'app', features,
  smoke: smoke.map(n => `tools/test/${n}.test.mjs`), full: [...smoke, ...extra].map(n => `tools/test/${n}.test.mjs`) })
const engine = (id, features, smoke, extra = []) => ({ id, surface: 'source', repo: 'engine', features,
  smoke: smoke.map(n => `tests/${n}`), full: [...smoke, ...extra].map(n => `tests/${n}`) })
export const GROUPS = Object.freeze([
  app('login', ['sign-in handoff', 'PKCE', 'cancellation', 'account state'], ['hosted-browser-signin', 'hosted-account-store'],
    ['product-account-surface', 'account-browser-wait', 'website-account-route']),
  app('remote-ui', ['remote trees', 'reconnect', 'session nonce', 'device settings'], ['remote-desktop-tree', 'remote-session-reconnect-renderer'],
    ['desktop-session-nonce-roundtrip-renderer', 'hosted-device-settings-access', 'remote-desktop-tree-snapshot']),
  app('agents', ['session controls', 'admission', 'tree lifecycle', 'recovery'], ['session-bridge-control', 'tree-slot-admission'],
    ['agent-session-surface', 'tree-lifecycle-authority', 'session-recovery', 'provider-session-isolation']),
  app('chat', ['send/stop keyboard', 'phone sheet', 'content bounds'], ['chat-enter-repeat', 'chat-preformatted-bounds'],
    ['chat-surface-phone-sheet', 'chat-output-layout', 'chat-attachment-chips', 'chat-approvals-inline', 'chat-search-escape']),
  app('chat-replies', [
    'final reply after tools', 'live rail replay', 'tree chat resume', 'whole-output currentness',
    'empty-turn transcript', 'native reconnect renderer', 'owner/reply ordering', 'session text reconciliation',
    'completed close/reopen, node switch, mid-tools arrival',
  ], [
    'chat-final-after-tools', 'chat-rail-live-replay', 'tree-chat-resume-stream', 'chat-whole-output-currentness',
    'tree-empty-turn-transcript', 'native-session-reconnect-renderer', 'chat-owner-line-precedes-its-reply', 'session-text-reader',
  ], ['chat-reply-user-paths']),
  app('settings', ['quick settings', 'search', 'batched persistence'], ['quick-settings-storage', 'settings-multiword-search'],
    ['product-settings-batch', 'settings-presentation', 'settings-tier-reachability']),
  app('layout', ['320px floor', 'navigation', 'phone ledger', 'metrics layout'], ['mobile-size-floor', 'phone-ledger-sign-in-gate'],
    ['mobile-gap-dead-route-links', 'phone-ledger', 'phone-canvas', 'metrics-layout']),
  app('packaging', ['helper closure', 'current discovery index', 'artifact identity'], ['pack-capability-layer'],
    ['capability-index-pack-gate', 'qa-renderer-dist', 'staged-renderer-guard']),
  engine('fra-identity', ['device claims', 'invalid claims', 'encrypted session'], ['online-fra-device-claim.js', 'online-fra-e2e-session.js'],
    ['online-fra-device-claim-refused.test.js', 'online-fra-device-identity.js', 'online-fra-e2e-session-refusals.test.js']),
  engine('fra-relay', ['relay lifecycle', 'close', 'desktop controller', 'reconnect'], ['online-fra-relay-close.test.js', 'online-fra-desktop-controller.test.js'],
    ['online-fra-relay-client.js', 'online-fra-relay-client.edge.js', 'online-fra-relay-renewal.test.js']),
  engine('fra-authority', ['browser authorization', 'workspace fencing', 'remote tiers'], ['online-fra-browser-authority.test.js', 'fra-workspace-policy.test.js'],
    ['fra-workspace-handles.js', 'fra-workspace-refusals.test.js', 'remote-surface-tier-parity.test.js']),
  engine('fra-bridge', ['local/composite transport', 'web client', 'sealing errors'], ['online-fra-local-bridge.test.js', 'online-fra-composite-bridge.test.js'],
    ['online-fra-web-client.js', 'online-fra-web-client-seal-error-translation.test.js']),
  engine('inspector', ['mobile tool scope', 'safe input', 'owned cleanup'], ['web-inspector.test.js'], ['iphone-handoff-runtime-boundary.test.js']),
  engine('registry', ['shipped inventory', 'confinement', 'MCP boundaries'], ['shipped-registry-boundary.test.js'],
    ['confined-tool-surface.test.js', 'mcp-tool-surface-refusals.test.js', 'mcp-tool-surface-read-failure.test.js']),
].map(Object.freeze))
export const SURFACES = Object.freeze(['source', 'browser', 'mobile', 'hosted', 'packaged', 'phone'])
export const LIMITATIONS = Object.freeze([
  'Source fixtures are not installed-app, physical-phone or authenticated cross-computer proof.',
  'Browser/mobile use real rendered assets in isolated emulated contexts; not physical devices.',
  'Hosted is the existing read-only anonymous sign-in gate, never live account enrollment or provider spend.',
  'Phone readiness is reported separately; disconnected hardware is never a pass.',
  'Research, payments, external providers, account/device deletion and live scheduler mutations are not run.',
  'The existing cut, native acceptance and live FRA qualification gates remain mandatory.',
])
export function selectGroups(profile, only = []) {
  if (!['smoke', 'full'].includes(profile)) throw Error('profile must be smoke or full')
  if (new Set(only).size !== only.length) throw Error('duplicate group')
  const unknown = only.filter(id => !GROUPS.some(g => g.id === id))
  if (unknown.length) throw Error(`unknown group: ${unknown.join(', ')}`)
  return GROUPS.filter(g => !only.length || only.includes(g.id)).map(g => ({ ...g, files: g[profile] }))
}
