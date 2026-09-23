/* HOW LONG ONE QUEUED MESSAGE COSTS WHEN THE STORE IS FULL.
 *
 * The outbox saves on every change, and the save has to fit the storage's own
 * per-value ceiling (shell/renderer-prefs.cjs MAX_VALUE_LENGTH). This measures
 * the worst realistic case -- twelve sessions at twelve messages of the store's
 * own 4,000-character cap, well past that ceiling, so the trim runs on every
 * single enqueue. Run it before and after a change to the trim.
 *
 *   node tools/outbox-persist-cost.mjs
 */
const values = new Map()
globalThis.localStorage = {
  getItem: key => (values.has(key) ? values.get(key) : null),
  setItem: (key, value) => { values.set(key, String(value)) },
  removeItem: key => { values.delete(key) },
}

const { enqueue, persistence } = await import('../src/session-outbox.js')

const long = 'x'.repeat(4000)
const started = process.hrtime.bigint()
let queued = 0
for (let session = 0; session < 12; session += 1) {
  for (let index = 0; index < 12; index += 1) {
    if (enqueue(`bulk-${session}`, `${long}${session}-${index}`).ok) queued += 1
  }
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

const state = persistence()
process.stdout.write([
  `queued            ${queued}`,
  `total ms          ${elapsedMs.toFixed(1)}`,
  `ms per enqueue    ${(elapsedMs / queued).toFixed(2)}`,
  `saved chars       ${(values.get('mc.session-outbox.v1') || '').length}`,
  `state             ${state.state} (notSaved ${state.notSaved})`,
  '',
].join('\n'))
