// Reviewed App selections use source reads and in-memory DOM/storage doubles.
// Strict preload retains their fresh per-file profile. Files not in this set
// keep the ordinary fixture-cleanup prerequisite, including settings batch.
// Re-review this policy when these suites acquire filesystem side effects.
const retainedFiles = new Set([
  'session-bridge-control', 'tree-slot-admission',
  'chat-enter-repeat', 'chat-preformatted-bounds', 'chat-surface-phone-sheet',
  'chat-output-layout', 'chat-attachment-chips', 'chat-approvals-inline', 'chat-search-escape',
  'chat-final-after-tools', 'chat-rail-live-replay', 'tree-chat-resume-stream', 'chat-whole-output-currentness',
  'tree-empty-turn-transcript', 'native-session-reconnect-renderer', 'chat-owner-line-precedes-its-reply', 'session-text-reader',
  'chat-reply-user-paths',
  'mobile-size-floor', 'phone-ledger-sign-in-gate', 'mobile-gap-dead-route-links',
  'phone-ledger', 'phone-canvas', 'metrics-layout',
  'quick-settings-storage', 'settings-multiword-search',
].map(name => 'tools/test/' + name + '.test.mjs'))
export function retainedAppSelection(repo, files) {
  return repo === 'app' && Array.isArray(files) && files.length > 0 && files.every(file => retainedFiles.has(file))
}
