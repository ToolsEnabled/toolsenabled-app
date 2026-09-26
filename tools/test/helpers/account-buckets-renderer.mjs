import '../../../src/styles.css'
import { accountSwitcher } from '../../../src/account-switcher.js'
import allowance from '../../../capability/src/lib/usage/allowance-buckets.js'

window.mcShell = { getBridgeProof() {} }
const observedAt = new Date().toISOString()
const amount = '9007199254740993123456789.125'
const generation = token => ({ kind: 'file', token: token.repeat(64) })
let account = { name: 'Research account · synthetic', provider: 'gemini', signedIn: 'yes', allowanceBinding: 'a'.repeat(64), authGeneration: generation('b') }
const buckets = allowance.normalizeAllowanceBuckets({ provider: 'gemini', source: 'gemini-cli-core/retrieveUserQuota', sourceVersion: '0.58.0', observedAt,
  buckets: [
    { modelId: 'gemini-pro', tokenType: 'REQUESTS', remainingFraction: 0.375, remainingAmount: amount, resetsAt: new Date(Date.now() + 3 * 3600000).toISOString() },
    { modelId: 'gemini-pro', tokenType: 'TOKENS', remainingFraction: 0, remainingAmount: '0' },
    { modelId: 'gemini-flash', tokenType: 'TOKENS', remainingAmount: '9'.repeat(110) + '.125' },
    { remainingFraction: 0.6 },
    { modelId: 'gemini-lite', tokenType: 'REQUESTS', remainingFraction: 'invalid', remainingAmount: '42' },
  ] })
const reading = { ...account, status: 'healthy', canServe: true, usageStatus: 'measured', readAt: observedAt,
  allowanceBuckets: buckets, windows: { hourly: null, weekly: null, weeklyWindows: [] } }
const cache = { ok: true, readAt: observedAt, accounts: [reading], orders: [] }
let probeCount = 0, policyCount = 0
const scope = { mcProviders: {
  accounts: async () => ({ ok: true, accounts: [account], usageCache: cache,
    activeByProvider: { gemini: account.name }, chosenByProvider: { gemini: account.name },
    policy: { selectionMode: 'priority', recorded: true, reservePercent: 25 } }),
  presence: async () => ({ ok: true, providers: [] }),
  accountUsage: async () => { probeCount++; return { ok: true, readAt: new Date().toISOString(),
    accounts: [{ ...reading, allowanceBuckets: null, usageStatus: 'unavailable', usageReason: 'Synthetic allowance service unavailable.' }], orders: [] } },
  accountPolicy: async () => { policyCount++; throw Error('No policy action expected') },
  onAccountSignInChanged: () => () => {},
} }
let root
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
async function until(predicate) {
  const deadline = performance.now() + 3000
  while (!predicate()) { if (performance.now() > deadline) throw Error('Synthetic Accounts state timed out'); await settle() }
  await settle()
}
window.accountBucketsFixture = {
  async open() {
    root = accountSwitcher({ scope })
    document.body.appendChild(root)
    await until(() => root.querySelector('.acct-row'))
    root.querySelector('.acct-trigger').click()
    await until(() => root.querySelector('dialog[open] .acct-bucket'))
  },
  async measure() {
    await settle()
    const dialog = root.querySelector('dialog')
    const cards = [...root.querySelectorAll('.acct-bucket')]
    root.querySelector('.acct-row')?.scrollIntoView({ block: 'start' })
    await settle()
    return { open: dialog.open, probeCount, policyCount,
      overflow: [dialog, ...cards, ...cards.flatMap(card => [...card.children])].some(node => node.scrollWidth > node.clientWidth + 1),
      cards: cards.map(card => ({ label: card.querySelector('.acct-bar-label').textContent,
        width: card.getBoundingClientRect().width,
        token: card.querySelector('.acct-bucket-scope').textContent,
        amount: card.querySelector('.acct-bucket-amount')?.textContent || null,
        meter: card.querySelector('[role="meter"]')?.getAttribute('aria-valuenow') ?? null,
        accessible: !card.querySelector('[role="meter"]') || Boolean(card.querySelector('[role="meter"]').getAttribute('aria-label')),
        text: card.textContent })),
      periodBars: [...root.querySelectorAll('.acct-bars > :not(.acct-bucket)')].length,
      allowance: root.querySelector('.acct-allowance').textContent }
  },
  async failThenRebind() {
    root.querySelector('[data-acct="refresh"]').click()
    await until(() => root.querySelector('.acct-row')?.dataset.allowanceState === 'failed')
    const failed = root.querySelector('.acct-allowance').textContent
    account = { ...account, authGeneration: generation('c') }
    root.querySelector('[data-acct="refresh-list"]').click()
    await until(() => root.querySelectorAll('.acct-bucket').length === 0)
    return { failed, remainingBuckets: root.querySelectorAll('.acct-bucket').length, probeCount, policyCount }
  },
  dispose() { root.__accountSwitcher.destroy(); root.remove() },
}
