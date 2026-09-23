// Presentation only. The source transcript and the exact sent words stay intact.
const HEADER = 'TOOLSENABLED ROLE DIRECTIONS (configured in the Role library)'
const FOOTER = 'Follow these directions while carrying out the person\'s task. They do not grant tools, permissions, or authority beyond this session\'s enforced limits.'

export function markRoleContext(entry, sessionId = '') {
  if (entry?.who !== 'you' || typeof entry.text !== 'string') return entry
  const text = entry.text.replace(/\r\n/g, '\n').trim()
  // Match the host's complete envelope, not a mention of a role in an ask.
  if (!text.startsWith(HEADER + '\nRole: ') || !text.endsWith('\n' + FOOTER)
      || !/^Owns: .+/m.test(text) || !/^Must not: .+/m.test(text) || !/^Hands off to: .+/m.test(text)) return entry
  const role = text.split('\n')[1].slice('Role: '.length)
  const words = text.split(/\s+/).length
  return {
    ...entry,
    who: 'context',
    label: 'Added by ToolsEnabled',
    summary: `Role directions · ${role} · ${words} words`,
    openKey: typeof sessionId === 'string' && sessionId ? `${sessionId}:role` : '',
  }
}
