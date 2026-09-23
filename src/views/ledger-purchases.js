// Mount the owner prompt queue inside the Ledger Purchases tab.

import { ledgerPromptQueue } from '../ledger-prompt-queue.js'
import { checkoutSurfaceAvailable } from '../checkout-visibility.js'

function emptyOf(container) {
  if (typeof container.replaceChildren === 'function') container.replaceChildren()
  else while (container.firstChild) container.removeChild(container.firstChild)
}

/**
 * Mount the ledger's P (purchases) tab into `container`.
 *
 * `container` is the slot src/views/ledger.js already owns and shows/hides
 * on tab change; this function mounts into it and does not create, hide or
 * show it. `ctx` is reserved (call with `{}`).
 *
 * @returns {{ destroy(): void }}
 */
export function renderPurchasesTab(container, ctx = {}) {
  void ctx
  const mounted = ledgerPromptQueue()
  const wrap = document.createElement('div')
  wrap.className = 'ledger-purchases-tab'

  if (checkoutSurfaceAvailable() === true) {
    const link = document.createElement('a')
    link.className = 'ledger-purchases-checkout-link'
    link.setAttribute('href', '#/checkout')
    link.textContent = 'Go to checkout'
    wrap.append(link)
  }

  wrap.append(mounted.el)

  emptyOf(container)
  if (typeof container.appendChild === 'function') container.appendChild(wrap)

  return {
    destroy() {
      mounted.destroy()
      emptyOf(container)
    },
  }
}
