import path from 'node:path'
import { SURFACES, selectGroups } from './catalog.mjs'
export function parseOptions(argv) {
  const [command = 'help', ...rest] = argv
  if (!['help', 'list', 'paths', 'run'].includes(command)) throw Error('use help, list, paths or run')
  const o = { command, profile: 'smoke', surfaces: ['source'], only: [], jobs: 1, budgetMs: 300000, timeoutMs: 60000 }
  const values = new Set(['engine', 'out', 'profile', 'surface', 'only', 'jobs', 'budget-ms', 'timeout-ms', 'release', 'expect-app', 'expect-engine', 'origin', 'mount', 'playwright-root', 'browsers-path', 'fixture-cleanup'])
  const seen = new Set()
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, ''), value = rest[i + 1]
    if (!rest[i].startsWith('--') || !values.has(key) || seen.has(key) || !value || value.startsWith('--')) throw Error(`invalid or duplicate option: ${rest[i]}`)
    seen.add(key); o[key] = value
  }
  o.surfaces = o.surface === 'all' ? [...SURFACES] : o.surface?.split(',') || o.surfaces
  if (new Set(o.surfaces).size !== o.surfaces.length || o.surfaces.some(s => !SURFACES.includes(s))) throw Error('unknown or duplicate surface')
  o.only = typeof o.only === 'string' ? o.only.split(',') : o.only
  selectGroups(o.profile, o.only)
  for (const [key, name, min, max] of [['jobs', 'jobs', 1, 2], ['budget-ms', 'budgetMs', 1000, 7200000], ['timeout-ms', 'timeoutMs', 1000, 900000]]) {
    if (o[key] !== undefined) o[name] = Number(o[key])
    if (!Number.isSafeInteger(o[name]) || o[name] < min || o[name] > max) throw Error(`invalid --${key}`)
  }
  for (const key of ['engine', 'out', 'release', 'playwright-root', 'browsers-path']) if (o[key] && !path.isAbsolute(o[key])) throw Error(`--${key} must be absolute`)
  for (const key of ['expect-app', 'expect-engine']) if (o[key] && !/^[a-f0-9]{40}$/.test(o[key])) throw Error(`--${key} must be a full commit`)
  if (command === 'run' && (!o.engine || !o.out)) throw Error('run requires --engine and a fresh absolute --out')
  if (o.release && o.origin) throw Error('--release and --origin cannot be mixed')
  o['fixture-cleanup'] ||= 'refuse'
  if (!['refuse', 'approved'].includes(o['fixture-cleanup'])) throw Error('--fixture-cleanup must be refuse or approved')
  if (o.origin) {
    const url = new URL(o.origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('origin must be a credential-free HTTP(S) origin')
    o.origin = url.origin
  }
  o.mount ||= '/app/'
  if (!/^\/(?:[a-z0-9_-]+\/)*$/i.test(o.mount)) throw Error('mount must be an absolute slash-terminated URL path')
  return o
}
