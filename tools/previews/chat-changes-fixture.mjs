const samples = [
  ['src/chat-session-changes.js',
    'export function sessionChanges(session) {\n  return session.files;\n}\n',
    'const MAX_FILES = 100;\n\nexport function sessionChanges(session) {\n  return session.files\n    .filter(file => file.changed)\n    .slice(0, MAX_FILES);\n}\n'],
  ['src/components.js',
    'export function buildChat(session) {\n  const chat = createChat(session);\n  return chat;\n}\n',
    'export function buildChat(session) {\n  const chat = createChat(session);\n  const changes = createChangesDrawer(session);\n\n  chat.append(changes);\n  return chat;\n}\n'],
  ['src/diff-editor.js',
    'export function openDiff() {\n  return editor.open();\n}\n',
    'export async function openDiff(file) {\n  const versions = await readVersions(file);\n  const window = editor.open();\n\n  window.load(versions.original, versions.current);\n  return window;\n}\n'],
  ['src/navigation.css',
    '.navigation {\n  display: flex;\n  height: 44px;\n}\n',
    '.navigation {\n  display: flex;\n  flex-direction: column;\n  width: 184px;\n  height: 100%;\n}\n'],
  ['src/chat-session-changes.css',
    '',
    '.session-changes {\n  position: absolute;\n  bottom: 100%;\n  max-height: 300px;\n  overflow-y: auto;\n}\n'],
  ['src/agent-session-events.js',
    'function onFileChange(event) {\n  chat.addAction(event);\n}\n',
    'function onFileChange(event) {\n  chat.addAction(event);\n  chat.addDiff(event.changes);\n}\n'],
  ['src/views/computers.js',
    'const history = session.messages;\n',
    'const history = session.messages;\nconst changes = session.fileChanges;\n\nchat.restoreChanges(changes);\n'],
  ['src/chat-copy.js',
    'export const CHANGE_TITLE = "Files";\n',
    'export const CHANGE_TITLE = "Session changes";\nexport const CHANGE_HINT = "Select a file to compare and edit";\n'],
  ['src/session-change-patches.js', '', 'export const MAX_PATCH_LINES = 2000;\n\nexport function isPatchComplete(patch) {\n  return patch.lines.length <= MAX_PATCH_LINES;\n}\n'],
]

function patch(before, after, path) {
  const old = before ? before.trimEnd().split('\n') : []
  const next = after ? after.trimEnd().split('\n') : []
  let prefix = 0, suffix = 0
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${old.length ? 1 : 0},${old.length} +${next.length ? 1 : 0},${next.length} @@`,
    ...old.slice(0, prefix).map(line => ` ${line}`),
    ...old.slice(prefix, old.length - suffix).map(line => `-${line}`),
    ...next.slice(prefix, next.length - suffix).map(line => `+${line}`),
    ...(suffix ? old.slice(-suffix).map(line => ` ${line}`) : []), '',
  ].join('\n')
}

export const previewFiles = samples.map(([path, before, after]) => ({ path, before, after, diff: patch(before, after, path), kind: { type: before ? 'update' : 'add' } }))
