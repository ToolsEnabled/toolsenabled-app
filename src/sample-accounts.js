/* THE EXAMPLE FLEET'S ACCOUNTS, WITH SOMETHING TO SHOW.
 *
 * The accounts menu on the example used to say only "Example, not your
 * accounts" and point at Sign in -- true, and it showed nothing of what the
 * menu does. This is the example's own account list: the sign-ins the working
 * tree (src/sample-simulation.js) spends -- two Codex accounts (the Work one it
 * runs out of and the Personal one Keep trying accounts moves to), a Claude
 * account with a week for all models and one for Opus, the Antigravity Gemini
 * sign-in with its weekly buckets per model, and a Grok sign-in whose program
 * does not report an allowance, drawn in the menu's own honest words for that.
 *
 * BUILT AS THE SHELL'S RAW REPLY AND READ BY THE MENU'S OWN PARSER
 * (readAccountList, which reads the usage cache with readUsageReply), never
 * hand-assembled in the parsed shape -- the same rule src/sample-usage.js keeps
 * for the metrics page -- so a change to what the menu accepts reaches the
 * example on the same render.
 *
 * NOTHING HERE IS ANYONE'S. No real names, addresses, folders or figures:
 * directories are example:// paths no program can open, and no row carries a
 * signed-in address. Deterministic from `nowMs`, so a screenshot is stable.
 */
import { readAccountList } from './account-switcher-state.js'

const H = 3600e3
const iso = ms => new Date(ms).toISOString()
// Fictional bindings obey the same list/cache identity contract as native
// replies. They are never derived from a real account or directory.
const bindings = new Map(['codex:Work', 'codex:Personal', 'claude:Work', 'gemini:Antigravity', 'grok:Grok']
  .map((key, index) => [key, (index + 1).toString(16).repeat(64)]))

/** The example's raw account-list reply, as the shell would answer it. */
export function sampleAccountsRaw(nowMs = Date.now()) {
  const inHours = hours => iso(nowMs + hours * H)
  const monday = (() => {
    const date = new Date(nowMs)
    const days = (8 - date.getUTCDay()) % 7 || 7
    return iso(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days, 7))
  })()
  const generation = (provider, name) => ({ kind: 'file', token: bindings.get(`${provider}:${name}`) })
  const account = (provider, name, extra = {}) => ({ provider, name, allowanceBinding: bindings.get(`${provider}:${name}`), authGeneration: generation(provider, name), directory: `example://${provider}/${name.toLowerCase()}`, signedIn: 'yes', ...extra })
  return {
    ok: true,
    accounts: [
      account('codex', 'Work', { priority: 1 }),
      account('codex', 'Personal', { priority: 2 }),
      account('claude', 'Work', { priority: 1 }),
      account('gemini', 'Antigravity', { client: 'antigravity', priority: 1 }),
      account('grok', 'Grok', { priority: 1 }),
    ],
    active: { name: 'Personal', provider: 'codex', at: iso(nowMs - 6 * 60e3),
      chosenByProvider: { codex: 'Work', claude: 'Work', gemini: 'Antigravity', grok: 'Grok' },
      movedOffByProvider: { codex: { chosen: 'Work', using: 'Personal', at: iso(nowMs - 6 * 60e3), reason: 'Work reached its usage limit.' } } },
    activeByProvider: { codex: 'Personal', claude: 'Work', gemini: 'Antigravity', grok: 'Grok' },
    lastSwitch: { at: iso(nowMs - 6 * 60e3), from: 'Work', to: 'Personal', provider: 'codex', automatic: true, reason: 'Work reached its usage limit.' },
    policy: { recorded: true, selectionMode: 'most-available', reservePercent: 10, autoRecoverOnLimit: true },
    usageCache: {
      ok: true,
      readAt: iso(nowMs - 90e3),
      accounts: [
        { provider: 'codex', name: 'Work', status: 'exhausted', canServe: false, usedPercent: 100, planType: 'Pro',
          windows: { hourly: { usedPercent: 100, resetsAt: inHours(0.7) }, weekly: { usedPercent: 64, resetsAt: monday } },
          resetsAt: inHours(0.7), reason: 'The 5-hour window is used up.' },
        { provider: 'codex', name: 'Personal', status: 'ok', canServe: true, usedPercent: 22, planType: 'Plus',
          windows: { hourly: { usedPercent: 22, resetsAt: inHours(3.2) }, weekly: { usedPercent: 31, resetsAt: monday } } },
        { provider: 'claude', name: 'Work', status: 'ok', canServe: true, usedPercent: 41, planType: 'Max',
          windows: { hourly: { usedPercent: 41, resetsAt: inHours(2.1) }, weekly: { usedPercent: 55, resetsAt: monday },
            weeklyWindows: [{ usedPercent: 55, resetsAt: monday }, { usedPercent: 30, resetsAt: monday, model: 'Opus' }] } },
        { provider: 'gemini', name: 'Antigravity', status: 'ok', canServe: true, usedPercent: 38,
          windows: { weekly: { usedPercent: 38, resetsAt: monday },
            weeklyWindows: [{ usedPercent: 38, resetsAt: monday, model: 'Gemini 3.1 Pro' }, { usedPercent: 12, resetsAt: monday, model: 'Gemini 3.8 Flash' }] } },
        { provider: 'grok', name: 'Grok', status: 'ok', canServe: true },
      ].map(row => ({ ...row, allowanceBinding: bindings.get(`${row.provider}:${row.name}`), authGeneration: generation(row.provider, row.name) })),
      orders: [{ provider: 'codex', names: ['Personal', 'Work'], why: 'Personal has the most left; Work is out until its 5-hour window resets.' }],
    },
  }
}

/** The example's accounts, read by the menu's own parser: `{ listing, usage }`. */
export function sampleAccountListing(nowMs = Date.now()) {
  const listing = readAccountList(sampleAccountsRaw(nowMs))
  return { listing, usage: listing.cachedUsage }
}
