import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const source = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const declaration = declaredFunctionSource(source, 'resolveSessionAccount')
function resolver(engine) {
  return new Function('loadRotation', 'resolveServicesRootForAccounts',
    'ACCOUNT_HOME_DIR', 'PROVIDER_ISOLATION_REQUESTED', 'ACCOUNT_REGISTRY_FILE',
    declaration + '; return resolveSessionAccount;')(
      () => engine, () => 'synthetic-services', 'synthetic-home', false, 'synthetic-registry')
}
function compliantEngine(override = {}) {
  return {  ACCOUNT_REQUEST_SELECTION_VERSION: 1,
     ACCOUNT_CLIENT_CONTRACT_VERSION: 1,
    ACCOUNT_MODEL_SCOPE_CONTRACT_VERSION: 1, ...override }
}
test('fresh starts and resumes forward the chosen account using manual selection', async () => {
  const requests = []
  const select = resolver(compliantEngine({ resolveAccountForSession: async value => {
    requests.push(value); return { account: { name: value.preferred } }
  } }))
  for (const exact of [false, true]) {
    const result = await select({ provider: 'codex', preferred: 'chosen', exact, persistSelection: false })
    assert.equal(result.account.name, 'chosen')
    assert.equal(requests.at(-1).preferred, 'chosen')
    assert.equal(requests.at(-1).providerLimitsOnly, true)
    assert.equal(requests.at(-1).persistSelection, false)
  }
})

test('an ordinary start does not manufacture an account selection', async () => {
  let request
  const select = resolver(compliantEngine({ resolveAccountForSession: async value => { request = value; return {} } }))
  await select({ provider: 'codex' })
  assert.equal(request.preferred, undefined)
  assert.equal(request.persistSelection, undefined)
})
test('provider errors are contained and cancellation prevents an account lookup', async () => {
  const secret = 'runtime-' + Math.random().toString(36).slice(2)
  const select = resolver(compliantEngine({ resolveAccountForSession: async () => { throw new Error(secret) } }))
  const error = await select({ provider: 'codex', preferred: 'chosen' }).then(() => null, value => value)
  assert.equal(error.code, 'AGENT_ACCOUNT_UNAVAILABLE')
  assert.equal(String(error).includes(secret), false)
  let calls = 0
  const cancelled = resolver(compliantEngine({ resolveAccountForSession: async () => { calls++; return {} } }))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(cancelled({ provider: 'codex', preferred: 'chosen' }, { signal: controller.signal }),
    { name: 'AbortError' })
  assert.equal(calls, 0)
})

test('a resumed explicit account cannot be replaced by the engine result', async () => {
  const select = resolver(compliantEngine({ resolveAccountForSession: async () => ({ account: { name: 'other' } }) }));
  await assert.rejects(select({ provider: 'codex', preferred: 'chosen', exact: true }),
    { code: 'AGENT_ACCOUNT_UNAVAILABLE' });
});

