const MAX_FILES = 32
const MAX_BYTES = 512 * 1024

const bad = sentence => ({ ok: false, sentence })
const plain = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

export const AGENT_SETUP_MAX_FILES = MAX_FILES
export const AGENT_SETUP_MAX_BYTES = MAX_BYTES

export function portableAgentInputPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240
      || value.includes(':')
      || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return false
  return value.split('/').every(part => {
    const lower = part.toLowerCase()
    const device = /^(con|prn|aux|nul)(?:[.].*)?$/.test(lower)
      || /^(com|lpt)[1-9](?:[.].*)?$/.test(lower)
    return part && !part.includes(String.fromCharCode(92))
      && part !== '.' && part !== '..' && !part.startsWith('.')
      && !part.endsWith('.') && !part.endsWith(' ') && !device
  })
}

export function parseResearchAgentSetup(value) {
  if (value === undefined || value === null) return { ok: true, agentSetup: null }
  if (!plain(value)) return bad('Agent setup must be an object or omitted.')
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => !['mode', 'access', 'files'].includes(key))) {
    return bad('Agent setup contains an unsupported field.')
  }
  if (value.mode !== 'clean-room'
      || !['read-only', 'read-write'].includes(value.access)
      || !Array.isArray(value.files)
      || value.files.length > MAX_FILES
      || Reflect.ownKeys(value.files).length !== value.files.length + 1
      || Array.from({ length: value.files.length }, (_, index) => !Object.hasOwn(value.files, index)).some(Boolean)) {
    return bad('Clean-room agent setup needs access and at most 32 explicit files.')
  }
  const seen = new Set()
  let bytes = 0
  const files = []
  for (const file of value.files) {
    if (!plain(file) || Reflect.ownKeys(file).length !== 2
        || !Object.hasOwn(file, 'path') || !Object.hasOwn(file, 'content')
        || !portableAgentInputPath(file.path)
        || typeof file.content !== 'string' || file.content.includes(String.fromCharCode(0))) {
      return bad('Every clean-room input needs a portable relative path and UTF-8 text.')
    }
    const key = file.path.toLowerCase()
    if (seen.has(key) || [...seen].some(name => name.startsWith(key + '/') || key.startsWith(name + '/'))) {
      return bad('Clean-room input paths must be distinct.')
    }
    seen.add(key)
    bytes += new TextEncoder().encode(file.content).byteLength
    if (bytes > MAX_BYTES) return bad('Clean-room inputs exceed the 512 KiB UTF-8 budget.')
    files.push(Object.freeze({ path: file.path, content: file.content }))
  }
  const agentSetup = Object.freeze({ mode: 'clean-room', access: value.access, files: Object.freeze(files) })
  return { ok: true, agentSetup }
}

export function researchSetupForRunner(agentSetup, runner, cellCount) {
  if (!agentSetup) return { ok: true }
  if (runner?.kind !== 'agent' || cellCount > 8) {
    return bad('Clean-room agent setup is supported only for agent runs with at most 8 local cells.')
  }
  return { ok: true }
}
