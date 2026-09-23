import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import accounts from '../../../shell/product-account.cjs'
import hostedClient from '../../../shell/hosted-account-client.cjs'
import hostedController from '../../../shell/hosted-account-controller.cjs'

const main = readFileSync(new URL('../../../shell/main.cjs', import.meta.url), 'utf8')
const first = main.indexOf('function stopAccountAdmissionForReset()')
const last = main.indexOf('\napp.whenReady()', first)
assert.ok(first >= 0 && last > first)

// Real account modules, an uncredentialed private store, and the exact main
// cleanup functions. No Session response, account acknowledgment or network
// result is fabricated; a no-session cleanup must never invoke fetch.
export function installAccountResetFixture(scope, directory, options = {}) {
  const client = hostedClient.createHostedAccountClient({
    fetchImpl: async () => assert.fail('uncredentialed reset fixture must not make a network request'),
    ...options,
  })
  const store = accounts.createAccountStore({ directory, hostedAccount: client })
  const controller = hostedController.createHostedAccountController({ client, store })
  Object.assign(scope, {
    accountResetStarted: false, hostedAccountRefreshTimer: null,
    accountMutations: new Set(), googleSignInAttempts: new Set(),
    getAccountStore: () => store, getHostedAccountController: () => controller,
    setTimeout, clearTimeout, clearInterval, performance,
  })
  if (!vm.isContext(scope)) vm.createContext(scope)
  vm.runInContext(main.slice(first, last), scope)
  return { client, store, controller }
}
