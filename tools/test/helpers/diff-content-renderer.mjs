import '../../../src/styles.css'
import '../../../src/diff-editor.css'
import { createDiffEditor } from '../../../src/diff-editor.js'

const patch = '@@ -3,5 +3,6 @@ export function eligible(account) {\n export function eligible(account) {\n   if (!account) return false;\n-  const reserve = 0.05;\n+  const remaining = account.remaining;\n+  const reserve = 0.15;\n-  return account.remaining > reserve;\n+  return remaining > reserve;\n }\n@@ -10 +11 @@ clearCachedReading()\n-  return null;\n+  return [];\n'
const current = 'import { readAccount } from "./accounts.js";\n\nexport function eligible(account) {\n  if (!account) return false;\n  const remaining = account.remaining;\n  const reserve = 0.15;\n  return remaining > reserve;\n}\n\nexport function clearCachedReading() {\n  return [];\n}\n'
let editor, host
let reads = 0, writes = 0, picks = 0
const settle = async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await Promise.all((host?.getAnimations({ subtree: true }) || [])
    .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {})))
}

async function open(diff, text, unavailable = false) {
  editor?.close(); host?.remove()
  host = document.createElement('div'); document.body.appendChild(host)
  editor = createDiffEditor({ documentRef: document, prefs: { read: () => null, write: () => { throw Error('No preferences write expected') } },
    files: { readChange: async () => { reads++; return unavailable ? { ok: false, code: 'MC_DIFF_READ_FAILED' }
      : { ok: true, path: '/synthetic/review/accounts.js', text, exists: true } },
      pick: async () => { picks++; throw Error('No picker expected') }, save: async () => { writes++; throw Error('No save expected') } } })
  editor.open(host)
  await editor.loadChange({ path: '/synthetic/review/accounts.js', added: 4, removed: 3, edits: 1,
    complete: true, patches: [{ path: '/synthetic/review/accounts.js', diff }] })
  await settle()
}

window.diffContentFixture = {
  open: () => open(patch, current),
  async measure() {
    host.querySelector('.diff-recorded').open = true
    await settle()
    const dialog = host.querySelector('.diff-dialog'), patch = host.querySelector('[data-recorded-patch]')
    const bounds = patch.getBoundingClientRect()
    const headers = [...host.querySelector('.diff-patch-columns').children].slice(0, 2)
    const lineNumbers = [...patch.querySelector('.diff-line-context').children].slice(0, 2)
    return { reads, writes, picks,
      outerOverflow: dialog.getBoundingClientRect().right > innerWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1,
      ranges: [...host.querySelectorAll('.diff-hunk-range')].map(node => node.textContent),
      contexts: [...host.querySelectorAll('.diff-hunk-context')].map(node => node.textContent),
      numbers: headers.map(node => node.textContent),
      headerClipped: headers.some(node => node.scrollWidth > node.clientWidth + 1),
      guttersAligned: headers.every((node, index) => Math.abs(node.getBoundingClientRect().right - lineNumbers[index].getBoundingClientRect().right) < 1),
      rangeClipped: [...host.querySelectorAll('.diff-hunk-range')].some(node => node.scrollWidth > node.clientWidth + 1
        || node.getBoundingClientRect().right > bounds.right + 1),
      before: host.querySelector('[data-diff-pane="original"]').value,
      after: host.querySelector('[data-diff-pane="proposed"]').value,
      basis: patch.querySelector('.diff-patch-basis').textContent,
      retainedCode: [...patch.querySelectorAll('.diff-line-code')].map(node => node.textContent) }
  },
  async longContext() {
    const context = 'function_' + 'long_scope_'.repeat(80) + '()'
    await open(`@@ -1 +1 @@ ${context}\n-previous\n+current\n`, 'current\n')
    host.querySelector('.diff-recorded').open = true
    await settle()
    const node = host.querySelector('.diff-hunk-context'), patch = host.querySelector('[data-recorded-patch]')
    return { complete: node?.textContent === context, wraps: node.scrollHeight > 30,
      clipped: node.scrollWidth > node.clientWidth + 1 || node.getBoundingClientRect().right > patch.getBoundingClientRect().right + 1 }
  },
  async unavailable() {
    const lines = Array.from({ length: 2100 }, (_, index) => `+recorded ${index + 1}`).join('\n')
    await open(`@@ -0,0 +1,2100 @@\n${lines}\n`, '', true)
    return { beforeDisabled: host.querySelector('[data-diff-pane="original"]').disabled,
      afterDisabled: host.querySelector('[data-diff-pane="proposed"]').disabled,
      notice: host.querySelector('.diff-patch-limit')?.textContent,
      rows: host.querySelectorAll('.diff-line-code').length }
  },
  close() { editor?.close(); host?.remove() },
}
