import { DEFAULT_TREE_IDENTITY_ROLE } from './tree-node-identity.js'

const refused = sentence => ({ ok: false, sentence })
const reason = (result, fallback) => result?.problems?.[0] || result?.sentence || fallback

// The store reserves the actual node before crossing IPC. An attached starting
// session cannot be removed as a draft while its host identity is being assigned.
// The tab remains the session owner until the host acknowledges that assignment.
export async function adoptStandaloneIntoTree({ store, session, parentId = null, bridge, identityFor, bindSession, reveal, withReservation = (_node, work) => work() }) {
  const held = session.beginPlacement()
  if (!held?.ok) return refused(held?.sentence || 'Wait for this agent to finish starting, then try again.')
  const snapshot = held.snapshot
  let node = null, acknowledged = false, committed = false
  try {
    if (snapshot.sessionId && typeof bridge?.adoptTreeAddress !== 'function') {
      return refused('Reopen the current app to add this running agent to a tree.')
    }
    /* THE TAB'S OWN ROLE, AND ONLY WHAT WAS SENT. The tab declared its seat
       as the Worker identity role and runs as it, so the circle takes that
       role (and its name) rather than the internal 'default' label (T1397).
       Its brief is the prompt the person actually sent: words still sitting
       unsent in the composer stay a draft there and never become a task that
       Start tree would send (T1491). */
    const sent = typeof snapshot.sentPrompt === 'string' ? snapshot.sentPrompt
      : snapshot.phase === 'draft' ? '' : snapshot.prompt || ''
    const added = store.addNode({ parentId, role: DEFAULT_TREE_IDENTITY_ROLE, message: sent })
    if (!added.ok) return refused(reason(added, 'This agent could not be added here.'))
    node = added.node
    if (added.snapshot?.persistenceFailed) return refused('Save this tree successfully before adding the agent. Its chat is still open.')
    return await withReservation(node, async () => {
      if (snapshot.sessionId) {
        const attached = store.attachSession(node.id, snapshot.sessionId)
        if (!attached.ok) return refused(reason(attached, 'This session could not be attached.'))
        node = attached.node
        if (attached.snapshot?.persistenceFailed) return refused('The tree could not be saved. Its agent chat is still open.')
        const address = identityFor(node)
        /* THE SEAT LETS GO BEFORE THE TREE TAKES HOLD. An unplaced + agent
           binds its own turns to its seat so they are written down at all
           (T300); the capture then refuses to repoint that live binding to a
           node, because silently moving a conversation is how one gets split
           without anyone deciding to. Releasing here flushes what was said
           under the seat and frees the session, so the tree's own binding --
           recorded by adoptTreeAddress below, exactly as for any node -- is
           accepted rather than thrown away inside a catch. Awaited, not fired
           off, because the tree binds on the very next line. */
        await session.releaseTranscript?.(snapshot.sessionId)
        const result = await bridge.adoptTreeAddress({ sessionId: snapshot.sessionId, ...address })
        if (result?.ok !== true) return refused(reason(result, 'The agent could not join this tree. Its chat is still open.'))
        if (result.sessionId !== snapshot.sessionId || result.nodeId !== node.id || result.treeKey !== address.treeKey) {
          return refused('The app could not confirm this agent’s tree address. Its original chat is still open.')
        }
        acknowledged = true
        // From here the tree owns the acknowledged session. Even navigation or a
        // late storage failure cannot turn the tab's teardown into a Stop request.
        session.commitPlacement({ nodeId: node.id })
        session.commitPlacement({ nodeId: node.id, ...bindSession(node, result, session.snapshot()) })
      } else {
        session.commitPlacement({ nodeId: node.id, ...bindSession(node, null, snapshot) })
      }
      committed = true
      reveal?.(node)
      return { ok: true, nodeId: node.id, sentence: parentId ? 'Agent added to the tree.' : 'Agent added as its own tree.' }
    })
  } catch {
    if (acknowledged) {
      // Keep the real node and its acknowledged session address visible for
      // recovery. Rolling back a completed host assignment would orphan it.
      return { ok: true, nodeId: node.id, sentence: 'Agent added. Reopen its tree chat if the view has changed.' }
    }
    return refused('The agent could not join this tree. Its chat is still open; try again.')
  } finally {
    if (!committed && !acknowledged) {
      if (node && store.getNode(node.id)) {
        const current = store.getNode(node.id)
        // Remove only our reservation, never a replacement session or a branch
        // another action attached in the meantime.
        if (current.sessionId === snapshot.sessionId || current.sessionId === null) {
          if (current.sessionId) store.detachSession(node.id)
          store.removeNode(node.id)
        }
      }
      session.cancelPlacement()
    }
  }
}
