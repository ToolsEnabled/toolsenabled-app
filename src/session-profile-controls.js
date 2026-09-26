/* THE FOLDER PANEL'S THREE CONTROLS, DECIDED BEFORE ANYTHING IS DRAWN.
 *
 * A pure decision module in the idiom of src/agent-session-controls.js: what
 * the profile panel's list, add and remove controls may do given the agent
 * bridge this window actually has, decided without a DOM so it can be
 * exercised in `node --test` rather than only by looking at a window.
 *
 * WHY IT EXISTS. `window.mcAgent` is not one object. Two hosts publish it and
 * they do not carry the same verbs:
 *
 *   THE INSTALLED APPLICATION  shell/fleet-profile-preload.cjs, over IPC to
 *   the main process. It carries profiles(), profileCreate() and
 *   profileRemove().
 *
 *   A BROWSER DRIVING THE MACHINE  the website's host binding, over the relay
 *   tunnel. profileCreate is ABSENT BY DESIGN and absent at two locks:
 *   shell/agent-facade.cjs lists 'agent:profile-create' in REMOTE_OMITTED so
 *   the route does not exist, and shell/agent-command-surface.cjs marks the
 *   command `dialog: true` so it refuses MC_AGENT_DIALOG_REQUIRES_WINDOW
 *   behind that. The picker opens an OS window on the machine and the window
 *   IS the consent; there is nobody in front of that screen.
 *
 * THE DEFECT THIS REPLACES. The panel gated itself on `profiles` alone, so
 * over the relay it rendered fully -- list, name field, and an enabled "Pick a
 * folder…" -- and the press evaluated `bridge.profileCreate({ name })` on a
 * verb that is undefined. That throws while the call expression is being
 * evaluated, so the `.catch()` written on the very same line never attaches
 * and never runs: the handler's promise rejected, the panel's output line was
 * never written, and the button did nothing at all. Nothing went red anywhere,
 * because nothing was asked.
 *
 * So the three verbs are asked for by name, ONCE, and every control that
 * cannot succeed is disabled carrying the reason it is disabled -- the
 * controlState contract in src/components.js, which refuses a disabled control
 * that has no sentence to show for it.
 */
import { controlState } from './components.js'
import { PROFILE_PANEL } from './fleet-tree-copy.js'

/* The verb behind each control. Named here rather than checked at each site so
   a host that grows or loses one is answered in a single place. */
export const PROFILE_CONTROL_VERBS = Object.freeze({
  list: 'profiles',
  add: 'profileCreate',
  remove: 'profileRemove',
})

/**
 * What this window's agent bridge can really do with session folders.
 *
 * `bridge` is `window.mcAgent` — or null, in a page with no host at all.
 * Returns one controlState per control; `list.disabled` is the whole panel's
 * absent state, and the other two are per-control refusals that leave the
 * panel readable.
 */
export function profileControls(bridge, { readProblem = '' } = {}) {
  const has = verb => Boolean(bridge) && typeof bridge[verb] === 'function'
  const decide = (verb, absentReason) => {
    const enabled = !readProblem && has(verb)
    return controlState({ enabled, why: enabled ? '' : readProblem || absentReason })
  }
  return Object.freeze({
    list: decide(PROFILE_CONTROL_VERBS.list, PROFILE_PANEL.needsApp),
    add: decide(PROFILE_CONTROL_VERBS.add, PROFILE_PANEL.addNeedsMachine),
    remove: decide(PROFILE_CONTROL_VERBS.remove, PROFILE_PANEL.needsApp),
  })
}

/**
 * What one Remove press actually did.
 *
 * The reply from `mcAgent.profileRemove` is `{ ok: true, removed }` — and
 * `removed` is false when the machine no longer had that folder, which is a
 * press that changed nothing. A thrown refusal (web-drive off over the relay
 * is the ordinary one) arrives here as null. Both used to be discarded and the
 * panel redrawn, which is exactly what a person sees when it worked.
 */
export function profileRemoveOutcome(reply) {
  if (!reply || reply.ok !== true || reply.removed === false) {
    return Object.freeze({ ok: false, sentence: PROFILE_PANEL.removeFailed })
  }
  return Object.freeze({ ok: true, sentence: '' })
}

/**
 * ONE REMOVE PRESS, END TO END, WITHOUT A DOM.
 *
 * The whole decision the press makes lives here so it can be exercised by
 * calling it with a value: the view's remaining job is to print the sentence
 * or to redraw, and nothing else. A rejection (the ordinary one is
 * MC_AGENT_PRINCIPAL_READ_ONLY, a browser driving a machine with web-drive
 * off) becomes null and is judged by profileRemoveOutcome with everything
 * else, so no refusal can reach the redraw.
 */
export async function removeProfile(bridge, profileId) {
  if (!bridge || typeof bridge[PROFILE_CONTROL_VERBS.remove] !== 'function') {
    return Object.freeze({ ok: false, sentence: PROFILE_PANEL.needsApp })
  }
  const reply = await Promise.resolve()
    .then(() => bridge.profileRemove({ profileId }))
    .catch(() => null)
  return profileRemoveOutcome(reply)
}
