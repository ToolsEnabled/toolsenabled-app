import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createDesktopTreeViewStore } from '../../../src/desktop-tree-authority.js'
import { createSavedSessionRefusals } from '../../../src/saved-session-refusals.js'

const view = readFileSync(new URL('../../../src/views/computers.js', import.meta.url), 'utf8')
const reason = view.match(/^  const nativeTreeReadOnlyReason = (.+)\r?$/m)
if (!reason) throw new Error('Computers native-tree refusal binding was not found')
const nativeTreeReadOnlyReason = vm.runInNewContext(reason[1])

// A newly mounted view has no native authority snapshot. Keep this state in
// extracting fixtures too; a fixture that exercises native authority replaces
// the nulls explicitly and still uses the real immutable snapshot store.
export function computersViewAuthorityBindings() {
  return {
    authoritativeTreeSnapshot: null,
    authoritativeTreeComputer: null,
    createDesktopTreeViewStore,
    nativeTreeReadOnlyReason,
    /* The view's module-level memory of what the host already refused, which
       the saved-session sweeps hand to reconnectRemoteSessions. A fresh one
       per fixture, built by the real factory, so an extracted sweep behaves
       as the mounted one does on a first mount. */
    SAVED_SESSION_REFUSALS: createSavedSessionRefusals(),
  }
}
