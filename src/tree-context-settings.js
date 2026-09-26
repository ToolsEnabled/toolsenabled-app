import { TREE_CONTEXT_CARDS_KEY, TREE_CONTEXT_BOX_SIZE_KEY, TREE_CONTEXT_CARDS_EVENT, TREE_CONTEXT_SIZES, readTreeContextCards, updateTreeContextCards } from './tree-context-cards.js'
import { matchesSettingQuery } from './product-settings-layout.js'
const KEY = 'tree:context-cards'
export function createTreeContextSettings({ draft = null, stageWrite = null, storage = () => globalThis.localStorage, eventTarget = globalThis.window } = {}) {
  let root = null, panel = null, saved = null, localChange = null
  const stage = stageWrite || (draft ? (...args) => draft.stage(...args) : null)
  const pending = () => draft ? draft.value(KEY, null) : localChange
  const availableStorage = () => { try { return storage() } catch { return null } }
  function notice(text) { const node = panel?.querySelector('[data-tree-context-notice]'); if (node) node.textContent = text }
  function paint() {
    if (!panel) return
    const read = readTreeContextCards(availableStorage())
    if (read.ok) saved = read.record
    panel.querySelector('[data-tree-context-fields]').disabled = !read.ok || draft?.saving === true
    const change = pending()
    panel.querySelector('[data-tree-context-size]').value = change?.defaultSize ?? saved?.defaultSize ?? 'medium'
    const count = change?.resetTrees ? 0 : Object.keys(saved?.trees || {}).length
    panel.querySelector('[data-tree-context-overrides]').textContent = count ? `${count} tree${count === 1 ? ' has' : 's have'} a size chosen on the tree page.` : 'All trees use this default unless you choose a size on the tree page.'
    panel.querySelector('[data-tree-context-reset]').disabled = count === 0
    if (!read.ok) notice(read.reason)
  }
  function write(change) {
    const result = updateTreeContextCards(change, { storage: availableStorage(), eventTarget })
    if (result.ok) { saved = result.record; localChange = null; notice('Context-card settings saved.') } else notice(result.reason)
    return result
  }
  function change(event) {
    if (!event.target.matches?.('[data-tree-context-size]') || draft?.saving) return
    const next = { ...pending(), defaultSize: event.target.value }
    localChange = next
    if (draft?.unstage && next.defaultSize === saved?.defaultSize && !next.resetTrees) { draft.unstage(KEY); localChange = null; notice('Context-card settings match the saved choice.') }
    else if (stage) {
      stage(KEY, next, write)
      const valid = TREE_CONTEXT_SIZES.some(row => row.value === next.defaultSize)
      draft?.setError?.(KEY, valid ? '' : 'Choose Small, Medium, Large, or Off for tree context cards.')
      notice(valid ? 'Context-card changes are pending. Save settings to apply them.' : 'Choose Small, Medium, Large, or Off.')
    }
    else write(next)
    paint()
  }
  function click(event) {
    if (!event.target.closest?.('[data-tree-context-reset]') || draft?.saving) return
    const next = { ...pending(), resetTrees: true }
    localChange = next
    if (stage) { stage(KEY, next, write); notice('Tree overrides will be cleared when you save settings.') }
    else write(next)
    paint()
  }
  function stored(event) { if (event.key == null || event.key === TREE_CONTEXT_CARDS_KEY || event.key === TREE_CONTEXT_BOX_SIZE_KEY) paint() }
  return {
    markup: () => `<section class="settings-section" data-settings-section="Appearance" data-tree-context-settings><h2 class="settings-section-title">Tree context cards</h2><p class="settings-desc">Choose how much context appears in agent boxes and beside circles. Small shows the current task and a line or two of conversation; larger cards show more of both. Circle card sizes do not change the tree layout.</p><fieldset class="tree-context-fields" data-tree-context-fields><legend class="sr-only">Tree context cards</legend><label class="settings-row"><span class="settings-label">Default card size</span><select data-tree-context-size>${TREE_CONTEXT_SIZES.map(row => `<option value="${row.value}">${row.label}</option>`).join('')}</select></label><p class="settings-desc" data-tree-context-overrides></p><button type="button" class="ctl-btn" data-tree-context-reset>Use this default for every tree</button></fieldset><p class="settings-desc">Off hides detached circle cards and keeps the last chosen box size; agent boxes and conversations remain available. Saved tree-specific sizes apply to circle cards. The tree toolbar changes the shared box size and the circle cards in view; other saved tree choices stay in place.</p><p class="settings-desc" data-tree-context-notice role="status" aria-live="polite"></p></section>`,
    matches: query => matchesSettingQuery(query, 'tree context cards small medium large off preview size branches boxes'),
    bind(target) { root = target; root.addEventListener('change', change); root.addEventListener('click', click); eventTarget?.addEventListener?.(TREE_CONTEXT_CARDS_EVENT, paint); eventTarget?.addEventListener?.('storage', stored) },
    afterRender(target) { panel = target.querySelector('[data-tree-context-settings]'); paint() },
    refreshSaved: paint,
    destroy() { root?.removeEventListener('change', change); root?.removeEventListener('click', click); eventTarget?.removeEventListener?.(TREE_CONTEXT_CARDS_EVENT, paint); eventTarget?.removeEventListener?.('storage', stored); root = null; panel = null },
  }
}
