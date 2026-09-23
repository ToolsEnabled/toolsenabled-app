// Actual Computers rail mount/dispose code and actual buildChat, with the
// shared DOM stand-in and an explicit synthetic transport. This is component
// behavior proof, not a browser layout, LIVE route, or provider claim.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parseAst } from 'rollup/parseAst'

export const viewSource = readFileSync(new URL('../../../src/views/computers.js', import.meta.url), 'utf8')
export const functions = new Map()
function visit(node) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'FunctionDeclaration') functions.set(node.id.name, node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') visit(value)
  }
}
visit(parseAst(viewSource))
export const functionSource = name => {
  const node = functions.get(name)
  assert.ok(node, `the actual ${name} function must exist`)
  return viewSource.slice(node.start, node.end)
}
const statements = functions.get('showTreeNodeControls').body.body
const mountAt = statements.findIndex(node => node.type === 'VariableDeclaration'
  && node.declarations.some(declaration => declaration.id.name === 'chatHost'))
assert.ok(mountAt >= 0, 'the actual rail host declaration must exist')
assert.equal(statements[mountAt + 1].type, 'IfStatement')
assert.equal(statements[mountAt + 1].test.name, 'chatHost')
const draftDeclaration = statements.find(node => node.type === 'VariableDeclaration'
  && node.declarations.some(declaration => declaration.id.name === 'draft'))
assert.ok(draftDeclaration, 'the actual same-node draft preservation must be exercised')
const mountSource = viewSource.slice(draftDeclaration.start, draftDeclaration.end) + '\n'
  + viewSource.slice(statements[mountAt].start, statements[mountAt + 1].end)

// The old source has no draft store. Let that source execute unchanged so
// its lost-draft baseline fails on the mounted input, not on a missing import.
const storeModule = new URL('../../../src/tree-chat-drafts.js', import.meta.url)
const draftModule = existsSync(storeModule) ? await import(storeModule.href) : null
export const createDrafts = () => draftModule?.createTreeChatDraftStore()

export function createRailView({ buildChat, drafts, computerId = 'fixture-computer-a', configFor, extra = {} }) {
  const controlsPage = document.createElement('section')
  const host = document.createElement('div')
  host.setAttribute('data-rail-chat-host', '')
  controlsPage.appendChild(host)
  document.body.appendChild(controlsPage)
  const context = vm.createContext({
    controlsPage, treeStoreId: computerId, treeChatDrafts: drafts, chatNodeId: null, chatDraft: null, accountsMenuEl: null,
    transcriptStore: null, mountTranscriptHistory() {},
    sessionTurnText: new Map(), sessionOpenTurns: new Map(),
    standaloneSettledTurns: new Map(), nativeReconcileSessions: new Set(),
    treeChatConfigFor: node => ({ title: node.id, seed: 0, history: [],
      onSend: (_text, handlers) => handlers.reply('Fixture accepted'), ...configFor?.(node) }),
    buildChat(config) {
      const root = buildChat(config)
      const input = root.querySelector('.chat-input input')
      // The stand-in has no browser selection implementation. Represent the
      // standard input API explicitly; product export/import is still actual.
      input.selectionStart = 0; input.selectionEnd = 0
      input.setSelectionRange = (start, end) => { input.selectionStart = start; input.selectionEnd = end }
      return root
    },
    ...extra,
  })
  // The rail lets go of the Keep trying section (in the Accounts menu) when it releases an agent.
  const retrySection = ['accountRetryHost', 'removeAccountRetrySection'].filter(name => functions.has(name)).map(functionSource).join('\n')
  // It also closes a computer conversation opened from a signed-in browser; none is open here.
  const desktopSection = functions.has('disposeDesktopChat') ? `let desktopChat = null, desktopChatNativeTarget = null; const desktopDrafts = new Map();\n${functionSource('disposeDesktopChat')}` : ''
  vm.runInContext(`let railChat = null; ${retrySection}\n${desktopSection}\n${functionSource('disposeRailChat')}
    function mount(node) { ${mountSource}; return railChat?.root }
    function rail() { return railChat }`, context)
  let destroyed = false
  return {
    context, controlsPage, host,
    mount(node, { replace = true } = {}) {
      if (replace) { context.disposeRailChat(); host.replaceChildren() }
      return context.mount(node)
    },
    rail: () => context.rail(),
    destroy() {
      if (destroyed) return
      destroyed = true
      context.disposeRailChat()
      controlsPage.remove()
    },
  }
}
