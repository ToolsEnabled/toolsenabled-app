/* THE COORDINATOR COMPOSER'S DRAFT, HELD ACROSS A SUBJECT-SWITCH REBUILD.
 *
 * Owner, verbatim: "theres occassionally really annoying UI redraws and they
 * erase my typing." MEASURED (2026-09-07): src/home-chat-takeover.js's
 * mountChatTakeover tears its whole stage down and rebuilds it from scratch
 * on every subject switch -- its own `show(nextId)` closure, exposed as the
 * mounted surface's `.show` method and called by the subject picker's
 * 'change' listener in src/views/home.js. The coordinator subject's own
 * composer is buildChat's fresh DOM (src/components.js), built new on every
 * `show()` call; nothing carried the words in the box across that teardown,
 * so switching subjects and back -- or the picker firing twice -- silently
 * dropped whatever the person had typed. No `.value = ''` anywhere caused
 * this: the whole element holding the value was discarded and replaced.
 *
 * THE SAME RULE composer-queue-recall.js ALREADY KEEPS for the up-arrow
 * walk (see that file's own header: "the box wins, and leaving never
 * discards"), applied here to a subject switch instead of an arrow key:
 * whatever is in the composer when the subject changes becomes that
 * subject's held draft, and it comes back exactly as typed the next time
 * that subject's composer is built.
 *
 * Home holds this in-memory store across full-view opens. Subject IDs keep
 * each conversation's text, attachments, and selection independent. Queued
 * message edits stay owned by the shared queue, whose export returns null.
 * The basic store remains mount-local. The identified Home handoff below
 * carries existing conversations across routes, but never across app restart.
 */

export function createComposerDraftStore() {
  const drafts = new Map()
  return Object.freeze({
    readDraft(id) {
      const value = drafts.get(id)
      return value ? { ...value, attachments: value.attachments?.slice() || [] } : null
    },
    writeDraft(id, draft) {
      if (!id || !draft) return
      if (!draft.text && !draft.attachments?.length) { drafts.delete(id); return }
      drafts.set(id, { ...draft, attachments: draft.attachments?.slice() || [] })
    },
    /** The held draft for a subject id, or '' when there is none. */
    read(id) {
      const key = typeof id === 'string' ? id : ''
      const value = key ? drafts.get(key) : undefined
      return typeof value?.text === 'string' ? value.text : ''
    },
    /** Hold `text` for a subject id. An empty box clears the held draft
     *  rather than remembering an empty string forever -- there is nothing
     *  there to restore, and a Map that only ever grows is its own defect.
     *
     *  TEXT ONLY. A subject whose draft was saved through writeDraft is still
     *  holding attachments and a selection; a plain composer input knows about
     *  neither, so they are carried across unchanged instead of being replaced
     *  away. Clearing the line therefore drops the record only when nothing
     *  else is left -- writeDraft's own rule -- so unsent attachments are not
     *  deleted by a redraw that happens to save an empty box. */
    write(id, text) {
      const key = typeof id === 'string' ? id : ''
      if (!key) return
      const value = typeof text === 'string' ? text : ''
      const held = drafts.get(key)
      if (value === '' && !held?.attachments?.length) { drafts.delete(key); return }
      drafts.set(key, { ...held, text: value, attachments: held?.attachments?.slice() || [] })
    },
  })
}

// Kept only for this renderer and this account bridge. Account/session identity
// comes from mcAccount.current(), never a pane label or a provider selection.
const homeDraftScopes = new WeakMap()
const identityText = value => typeof value === 'string' && value.length > 0 ? value : null

function scopeFor(account) {
  let scope = homeDraftScopes.get(account)
  if (scope) return scope
  scope = { key: null, state: null, revision: 0 }
  scope.invalidate = () => {
    scope.revision++
    if (scope.state) {
      scope.state.valid = false
      scope.state.drafts.clear()
      scope.state.owners.clear()
      scope.state.workspaces.clear()
      scope.state.workspaceOwners.clear()
    }
    scope.key = null
    scope.state = null
  }
  // The native account bridge has renderer lifetime and no product-account
  // change event. Merely opening Account or Setup is not an identity change,
  // so it keeps the drafts, as Settings does. A sign-out/in round trip made
  // there is caught by the next Home read: it derives the key from
  // account.current() and retires the prior generation whenever the account
  // or its session changed.
  homeDraftScopes.set(account, scope)
  return scope
}

export function createHomeComposerDraftStore({ account = globalThis.mcAccount, sample = false } = {}) {
  const local = createComposerDraftStore()
  const routeState = { drafts: new Map(), owners: new Map(), workspaces: new Map(), workspaceOwners: new Map() }
  let retained = null
  const ready = (async () => {
    if (sample || typeof account?.current !== 'function') return
    const scope = scopeFor(account)
    const revision = ++scope.revision
    let current
    let timer
    try {
      current = await Promise.race([
        Promise.resolve().then(() => account.current()).catch(() => null),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 750) }),
      ])
    } finally { clearTimeout(timer) }
    // A later route owns this lookup now. A timeout also ends the lookup;
    // its eventual network response cannot recover a discarded identity.
    if (revision !== scope.revision) return
    const accountId = identityText(current?.account?.id)
    const localProfile = current?.signedIn === false
      && current?.principal === 'unauthenticated' && current?.account === null
    const key = current?.ok === false ? null
      : localProfile ? JSON.stringify(['local-profile'])
      : current?.signedIn === true && accountId
        ? JSON.stringify(['account', accountId, current.session?.issuedAtMs ?? null])
        : null
    if (!key) { scope.invalidate(); return }
    if (scope.key !== key) {
      scope.invalidate()
      scope.key = key
      scope.state = { valid: true, drafts: new Map(), owners: new Map(), workspaces: new Map(), workspaceOwners: new Map() }
    }
    retained = scope.state
  })()
  return {
    ...local,
    ready,
    forWorkspace({ source } = {}) {
      const state = retained && !sample && ['local', 'relay'].includes(source) ? retained : routeState
      const key = typeof source === 'string' ? source : 'unknown'
      let owner = null
      return {
        read() {
          if (state.valid === false) return null
          owner = {}
          state.workspaceOwners.set(key, owner)
          const value = state.workspaces.get(key)
          state.workspaces.delete(key)
          return copyHomeWorkspace(value)
        },
        write(value) {
          if (state.valid === false || !owner || state.workspaceOwners.get(key) !== owner) return
          state.workspaces.set(key, copyHomeWorkspace(value))
        },
      }
    },
    forConversation({ computerId, agentId } = {}) {
      const computer = identityText(computerId), node = identityText(agentId)
      // Unknown account/identity keeps the old route-local behavior. Never
      // place unscoped work in the renderer-wide handoff.
      const scratch = { drafts: new Map(), owners: new Map() }
      // The store is chosen at the first read, not when the conversation is
      // asked for: Home's panel asks while Home is still being built, before
      // the account lookup has answered, and a store fixed then was the
      // route-local one, so the panel's first chat never saw the kept draft
      // and its typing was lost at the next switch (T1497). A conversation
      // that must know the account first waits for `ready`.
      let chosen = null
      const current = () => chosen ||= computer && node ? retained || routeState : scratch
      const key = JSON.stringify([computer, node])
      let owner = null
      return {
        ready,
        readDraft() {
          const state = current()
          if (state.valid === false) return null
          owner = {}
          state.owners.set(key, owner)
          const draft = state.drafts.get(key)
          // Consume the saved handoff: a later cleared box or queue edit must
          // not reveal an older ordinary draft.
          state.drafts.delete(key)
          return draft ? { ...draft, attachments: draft.attachments?.slice() || [] } : null
        },
        writeDraft(_subjectId, draft) {
          const state = current()
          if (state.valid === false) return
          if (!owner || state.owners.get(key) !== owner) return
          state.owners.delete(key)
          state.drafts.delete(key)
          if (draft && (draft.text || draft.attachments?.length)) {
            state.drafts.set(key, { ...draft, attachments: draft.attachments?.slice() || [] })
          }
        },
      }
    },
  }
}

// Layout and unsent New chat forms are renderer-session state, scoped by the
// same verified account generation as conversation drafts and by data source.
function copyHomeWorkspace(value) {
  if (!value || typeof value !== 'object') return null
  const layout = value.layout || {}
  return {
    lastSubjectId: value.lastSubjectId || null,
    layout: { ...layout, visible: layout.visible?.slice(),
      windows: layout.windows?.map(item => ({ ...item, rect: { ...item.rect } })),
      extras: layout.extras?.map(item => ({ ...item })) },
    newChats: new Map([...(value.newChats instanceof Map ? value.newChats : [])]
      .map(([key, draft]) => [key, draft ? { ...draft } : null])),
  }
}
