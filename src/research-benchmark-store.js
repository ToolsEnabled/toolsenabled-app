import { canonical, invariant, sha256 } from './benchmark/prompts.mjs'

// Two banks keep the last saved draft readable until the new header commits.
// Settings already belong to the signed-in account; no drafts enter localStorage.
const CHUNK = 60000, MAX_CHUNKS = 32
function keyFor(project) {
  invariant(typeof project === 'string' && /^(unfiled|rp-[a-f0-9]{4,36})$/.test(project), 'Choose a research project or Unfiled. All projects is an overview.')
  return `research_benchmark_${project}`
}
function refusal(result) { return result?.error?.message || result?.reason || 'The account store did not accept the draft.' }
export function createBenchmarkStore(account) {
  async function readValue(key) {
    invariant(account?.getSetting, 'Sign in to save drafts to your account, or export a draft file.')
    const result = await account.getSetting(key)
    invariant(result?.ok === true, refusal(result))
    return result.value ?? null
  }
  async function read(project) {
    const key = keyFor(project), raw = await readValue(key)
    if (raw === null || raw === '') return null
    const header = JSON.parse(raw)
    invariant(header.version === 1 && [0, 1].includes(header.bank) && Number.isInteger(header.chunks) && header.chunks > 0 && header.chunks <= MAX_CHUNKS, 'The saved draft header is damaged. Export current edits before repairing it.')
    const parts = await Promise.all(Array.from({ length: header.chunks }, (_, i) => readValue(`${key}_${header.bank}_${i}`)))
    invariant(parts.every(part => typeof part === 'string'), 'A saved draft chunk is missing.')
    const text = parts.join('')
    invariant(await sha256(text) === header.sha256, 'The saved draft changed or is incomplete. Current edits have been retained.')
    return JSON.parse(text)
  }
  async function save(project, value) {
    const key = keyFor(project)
    invariant(account?.putSetting, 'Sign in to save drafts to your account, or export a draft file.')
    const text = canonical(value), count = Math.ceil(text.length / CHUNK)
    invariant(count <= MAX_CHUNKS, 'This draft exceeds the account draft limit. Export it to a file to preserve the complete project.')
    const current = await readValue(key)
    let header = null
    if (current) { await read(project); header = JSON.parse(current) }
    const bank = header?.bank === 0 ? 1 : 0
    for (let i = 0; i < count; i++) {
      const result = await account.putSetting(`${key}_${bank}_${i}`, text.slice(i * CHUNK, (i + 1) * CHUNK))
      invariant(result?.ok === true, refusal(result))
    }
    const digest = await sha256(text)
    const result = await account.putSetting(key, canonical({ version: 1, bank, chunks: count, sha256: digest }))
    invariant(result?.ok === true, refusal(result))
    invariant(canonical(await read(project)) === text, 'The draft changed during save; current edits have been retained.')
    return { sha256: digest }
  }
  return { read, save: (project, value) => globalThis.navigator?.locks?.request
    ? navigator.locks.request(keyFor(project), () => save(project, value)) : save(project, value) }
}
