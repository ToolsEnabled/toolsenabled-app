// Bind recorded paths while the owning session's working folder is known.
// This supplies identity only; every later read/save still uses the diff fence.
function bindSessionChangePaths(packet, cwd, path) {
  const event = packet?.event
  if (!event || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return packet
  const resolve = value => typeof value === 'string' && value.trim() && !value.includes('\0')
    ? path.resolve(cwd, value) : value
  if (event.type === 'tool_call' && ['Write', 'Edit'].includes(event.tool)
      && typeof event.payload?.file_path === 'string') {
    return { ...packet, event: { ...event, payload: { ...event.payload, file_path: resolve(event.payload.file_path) } } }
  }
  if (event.tool !== 'fileChange' || !Array.isArray(event.payload?.changes)) return packet
  const changes = event.payload.changes.slice(0, 101).map(change => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) return change
    const bound = { ...change, path: resolve(change.path) }
    if (change.kind && typeof change.kind === 'object') {
      bound.kind = { ...change.kind }
      for (const key of ['move_path', 'movePath']) {
        if (typeof bound.kind[key] === 'string') bound.kind[key] = resolve(bound.kind[key])
      }
    }
    return bound
  })
  return { ...packet, event: { ...event, payload: { ...event.payload, changes } } }
}

module.exports = { bindSessionChangePaths }
