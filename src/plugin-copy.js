/* WHAT EACH CAPABILITY LETS A PLUGIN DO, AND WHAT COULD GO WRONG.
 *
 * WHY TWO SENTENCES AND NOT ONE. config/settings-registry.json in the engine is
 * built on the rule that a setting states its capabilities and its risks
 * SEPARATELY, because one blended sentence makes the reader do the separating and
 * that is the work the product is supposed to have done. A plugin capability is
 * the hardest case for exactly that reason: the person is being asked to consent
 * to something a third party wrote, about which they have no other information.
 *
 * SO A RISK LINE IS ALLOWED TO SAY THERE IS ALMOST NO RISK, and two of these do.
 * An invented hazard attached to a colour token is what teaches somebody to scroll
 * past the line about the network.
 *
 * NO CAPABILITY IS DESCRIBED AS SAFE BECAUSE THE PLUGIN IS TRUSTED. There is no
 * trust here to draw on: the product verifies plugins it recognises, and it
 * recognises none yet. Every sentence below is about what the CAPABILITY permits,
 * on the assumption that the code using it may be wrong or hostile.
 */

export const CAPABILITY_COPY = Object.freeze({
  storage: Object.freeze({
    title: 'Keep its own records',
    grants: 'A folder on this computer set aside for this plugin, which survives closing the app.',
    /* Keyed by the package's content digest (engine plugin-host preparePaths), so
       each version has its own folder and nothing removes one (1.0.50 release
       review F12). The row said it lasted "until you remove the plugin". */
    risk: 'Each version of the plugin gets its own folder, so an update starts empty, and nothing removes the folder when you remove the plugin. The folder is not locked: any program running as you, including another plugin’s, can read it. Nothing is sent anywhere because of this.',
  }),
  secrets: Object.freeze({
    title: 'Read secrets you stored for it',
    /* NOT IN THIS VERSION (1.0.50 release review F10). Nothing stores a secret for a
       plugin and nothing hands one to its programs; the capability only raises the
       effect floor and stops waivers. Said plainly, so ticking it is not mistaken
       for something that works. The same for auditLog below. */
    grants: 'Named secrets filed under this plugin, and nothing else in the vault. Not in this version: there is no way to store a secret for a plugin yet, so ticking this gives it none.',
    risk: 'A plugin that can read a secret can put it anywhere it can write or send. This is the strongest thing on this list. While it holds this, every one of its tools counts as an outward write, and none of them can be set to stop asking you.',
  }),
  /* A PROGRAM YOU ALLOW RUNS AS YOU (1.0.50 release review F1). Nothing confines
     it to its folder: there is no separate account, file fence or network fence.
     What the app does do is start it with an environment it builds itself, so it
     is not HANDED your provider keys or sign-ins -- but it can read any file you
     can. These rows used to say "within that folder" and "No other plugin can read
     it", and a person ticking the box believed both. */
  subprocess: Object.freeze({
    title: 'Run the programs it ships',
    grants: 'The scripts named in its manifest, run as separate programs, one per tool you call. Each one starts in a folder of its own.',
    risk: 'A program you allow runs as you. It can read and change any file you can, including sign-in files and other plugins’ records, and it can use the network. ToolsEnabled does not hand it your provider keys or sign-ins, and a path you pass it has to be inside its own folder. Allow this only for a plugin you would trust as a program you install yourself.',
  }),
  network: Object.freeze({
    title: 'Reach the network',
    grants: 'You accept that its programs make connections, and every one of its tools counts as an outward action.',
    risk: 'This is a DISCLOSURE, not a fence: this box does not control the network. A program you allow to run can connect whether or not you tick it, and ToolsEnabled cannot see or limit where. While it holds this, no tool of its can be set to stop asking you.',
  }),
  auditLog: Object.freeze({
    title: 'Write to the record',
    grants: 'Entries in this computer’s tamper-evident record, under this plugin’s own name. Not in this version: its programs have no way to write to the record yet.',
    risk: 'In this version, nothing: it cannot write an entry yet. When it can, it will add entries and never change or remove one already there.',
  }),
  roles: Object.freeze({
    title: 'Add roles',
    grants: 'Roles you can give an agent, each one three pieces of wording: what it owns, what it must not do, who it hands work to.',
    risk: 'A role is wording an agent is handed, so a role can tell an agent to try something. It cannot grant an agent anything. What an agent may actually reach is decided by this computer’s permission level and your tool answers, never by a role. A plugin’s role can never be named like one of the built-in roles.',
  }),
  settings: Object.freeze({
    title: 'Add settings of its own',
    /* SHOWN, NOT YET SWITCHABLE (1.0.50 release review F7). The rows are read and
       drawn with their defaults, but there is no control to change one, nothing
       stores a value, and the plugin's programs are not told any. The row used to
       promise "Its switches change how the plugin behaves". */
    grants: 'Its own settings, shown in this plugin’s area with their defaults, each stating what it grants and what it risks.',
    risk: 'In this version they are shown only: you cannot change them, and the plugin is not told any value. They cannot appear among this product’s own settings.',
  }),
  skin: Object.freeze({
    title: 'Set a few colours',
    grants: 'A handful of named colours, a corner radius and a short badge word, on this plugin’s own surfaces.',
    risk: 'Almost none. It is a fixed list of values, not a stylesheet. There is nothing for a plugin to write that could hide or move anything, and nothing that could load an image from elsewhere.',
  }),
});

/* Capabilities as the row titles the person ticked, lowercased into a phrase:
   "run the programs it ships and add roles". A status line that said
   "subprocess, roles" (as Save and Withdraw did, found in the real app) names
   something the person was never shown. A name this build has no copy for is
   given as it is, as its row is. */
export function capabilityPhrase(names, conjunction = 'and') {
  const phrases = (names || []).map(name => (CAPABILITY_COPY[name] ? CAPABILITY_COPY[name].title.toLowerCase() : String(name)))
  if (phrases.length <= 1) return phrases.join('')
  return `${phrases.slice(0, -1).join(', ')} ${conjunction} ${phrases[phrases.length - 1]}`
}

/* The one sentence a person needs and cannot get from either list on its own. */
export function withheldSentence(withheld) {
  if (!withheld || !withheld.length) return ''
  return `It asked to ${capabilityPhrase(withheld)}, and you have not allowed that.`
}

/* The note this page files with every withdrawal, for the record. It says nothing
   a person reading the entry does not already know, so the entry leaves it out. */
export const PAGE_WITHDRAW_REASON = 'withdrawn from the plugins page'

export function effectSentence(effect) {
  switch (effect) {
    case 'local-read': return 'reads on this computer'
    case 'local-write': return 'writes inside its own folder'
    case 'external-read': return 'reaches the network'
    case 'external-write': return 'acts outside this computer'
    default: return String(effect || 'unclassified')
  }
}

/* WHY A RAISED EFFECT IS SHOWN AND NOT QUIETLY APPLIED. A plugin declares what
   each of its tools does, and the host raises that to the floor implied by what
   you allowed -- a plugin that may reach the network has no read-only tools. A
   screen that showed only the final answer would hide the disagreement; a screen
   that showed only the plugin's claim would repeat it as though it were checked. */
export function effectRaisedSentence(declared, actual) {
  if (declared === actual) return `Counts as: ${effectSentence(actual)}.`
  return `The plugin calls this "${effectSentence(declared)}". Because of what you have allowed it, `
    + `it counts as ${effectSentence(actual)}.`
}

export const IDENTITY_NOTE = 'A plugin is identified by its contents, not by its name or a version number. '
  + 'Change any file in it and it becomes a different plugin with no permissions, and you will be asked again.'

export const RESTART_NOTE = 'The tools a plugin adds are settled when the app starts, so a change here takes '
  + 'effect the next time you open it.'
