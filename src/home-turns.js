/* TWO DECISIONS THE FIRST PAGE'S TRANSCRIPT MAKES ABOUT A TURN, held where a
 * test can call them with values: WHO SPOKE, and WHETHER IT IS TOO LONG TO SIT
 * ON THE GLASS WHOLE.
 *
 * WHY THIS FILE EXISTS BESIDE src/chat-markdown.js's renderChatVoice(). That
 * one settled the other half of the same question -- which RENDERER a turn's
 * body gets -- by taking the turn's CLASS instead of its speaker id. This one
 * is what decides the class, and it has the same root cause behind it.
 *
 * THE TWO VOCABULARIES. A turn reaches that pane by one of two roads and they
 * do not name a speaker the same way:
 *
 *   the RUN ROWS  -- src/local-activity.js describeRun() emits
 *                    who: 'you' | 'action' | <the agent's role>
 *   the THREAD    -- the coordinator projection emits `sender`, which is a
 *                    bridge actor ('owner' for anything the person sent
 *                    through the composer -- engine
 *                    src/lib/mission-bridge/actions.js, `const actor =
 *                    ownerUi ? 'owner' : ...`), and the fleet profile names
 *                    its own cast (src/fleet-profile.js SAMPLE_SPEAKERS uses
 *                    `owner` and `act`).
 *
 * src/views/home.js resolved the thread's speaker with `SPEAKERS[who] || {
 * cls: 'is-agent', label: who }`, and SPEAKERS is whatever the profile
 * declares. So a profile that names no owner voice left TWO holes that the
 * class-based renderer cannot close on its own, because both of them are
 * upstream of the class:
 *
 *   the person's own line -- including the echo of what they just sent, which
 *     src/views/home.js hands to receiveTurn as OWNER_VOICE, itself falling
 *     back to the id 'owner' -- resolved to `is-agent`, so it was drawn in the
 *     agent's dress AND went through the markdown renderer;
 *   and a turn carrying no sender at all resolved to `label: undefined`, which
 *     the painter reads as "no label", so it was drawn as an unlabelled agent
 *     line and read as more of what the agent above it had said.
 *
 * So the id is resolved against a floor that speaks BOTH vocabularies, and a
 * turn that names nobody says so.
 */

/* WHAT A SPEAKER ID MEANS WHEN THE PROFILE DOES NOT SAY. Both vocabularies are
   in here, because both reach this pane and a profile is under no obligation
   to name either. A profile that DOES name a speaker always wins: a fleet
   names its own cast, and this table is the floor under it, never an
   override. */
const CANONICAL_SPEAKERS = Object.freeze(new Map([
  ['you', { cls: 'is-owner', label: 'You' }],
  ['owner', { cls: 'is-owner', label: 'You' }],
  ['action', { cls: 'is-act', label: '' }],
  ['act', { cls: 'is-act', label: '' }],
]))

/* A turn that names nobody SAYS so. "Could not look" and "not there" are
   different answers, and an unlabelled agent line tells them the same way. */
export const UNNAMED_SENDER = 'unnamed sender'

/**
 * Who spoke, as the class and the label the transcript paints.
 *
 * `speakers` is the fleet profile's own cast (FLEET.speakers). A declared
 * speaker is taken whole, including an empty label -- SAMPLE_SPEAKERS gives
 * `act` one deliberately, because an action line is unlabelled by design.
 */
export function turnSpeaker(who, speakers = null) {
  const id = typeof who === 'string' ? who.trim() : ''
  const declared = id && speakers && typeof speakers === 'object' ? speakers[id] : null
  if (declared && typeof declared === 'object') {
    return {
      cls: typeof declared.cls === 'string' && declared.cls.trim() ? declared.cls.trim() : 'is-agent',
      label: typeof declared.label === 'string' ? declared.label : id,
      hue: typeof declared.hue === 'string' ? declared.hue : '',
      named: true,
    }
  }
  const canonical = CANONICAL_SPEAKERS.get(id)
  if (canonical) return { cls: canonical.cls, label: canonical.label, hue: '', named: true }
  if (!id) return { cls: 'is-agent', label: UNNAMED_SENDER, hue: '', named: false }
  return { cls: 'is-agent', label: id, hue: '', named: true }
}

/* WHEN ONE TURN IS LONG ENOUGH TO BURY THE CONVERSATION.
 *
 * Both numbers, because one alone is blind in the direction the other measures:
 * an agent's file dump is many short lines, and an agent's essay is one very
 * long one, and either fills the pane on its own. Measured against the pane
 * this ships in -- 13.5px mono in a ~600px column is roughly 70 characters to
 * the line -- so 1200 characters is about the same wall as 18 lines. */
export const TURN_FOLD_LINES = 18
export const TURN_FOLD_CHARS = 1200

/**
 * Whether this turn gets a fold, and what the fold's one line says.
 *
 * Null for an ordinary turn, so an ordinary turn keeps exactly the markup it
 * had. NOTHING IS HIDDEN BY DEFAULT: the fold ships open, and it exists so a
 * reader can put a wall away, not so the product can decide they did not want
 * to read it. Owner's rule, and this screen's own: never gate the person.
 */
export function turnFold(text) {
  const source = String(text == null ? '' : text)
  const lines = source.split(/\r?\n/).length
  const characters = source.length
  if (lines <= TURN_FOLD_LINES && characters <= TURN_FOLD_CHARS) return null
  return {
    lines,
    characters,
    label: lines > 1 ? `${lines} lines` : `${characters} characters`,
  }
}
