// Category names describe the task; old bookmarks still resolve through aliases.
export const SETTINGS_GROUPS = Object.freeze([
  Object.freeze({ id: 'actions', label: 'Agents & tools', detail: 'Tool access, delegation, permissions and research',
    sections: Object.freeze(['Tool use', 'Agents & delegation', 'App permissions', 'Research', 'Local models']) }),
  /* 'This computer' IS FIRST IN THIS GROUP, AND FIRST IS NOT A PREFERENCE.
     It holds the Install and Sign in buttons for the assistant programs, and a
     copy with none of them installed cannot start an agent at all. Everything
     else in this group -- the home screen, the account connection, the
     permission level, the notifications -- is a choice somebody makes about a
     product that already works. This is the section that decides whether it
     does. It arrived on 2026-09-10 with the page it replaced: "What this copy
     needs" was a document at its own address, off the ring, that a person
     reached only by following a refusal. */
  Object.freeze({ id: 'start', label: 'Your workspace', detail: 'Your home screen, connections, setup and notifications',
    sections: Object.freeze(['This computer', 'Home screen', 'Connect this computer', 'Setup', 'Notifications']) }),
  Object.freeze({ id: 'appearance', label: 'Appearance & reading', detail: 'Theme, text, motion and accessibility',
    sections: Object.freeze(['Appearance', 'Text & Reading', 'Motion & Effects', 'Accessibility']) }),
  Object.freeze({ id: 'privacy', label: 'System & data', detail: 'Resource use, approvals, retained data and this installation',
    sections: Object.freeze(['Business controls', 'Resources', 'Rules & approvals', 'Data & Privacy', 'What the screens show', 'System']) }),
])

export const CATEGORY_DETAILS = Object.freeze({
  'This computer': 'What is installed here, your assistant sign-ins and feedback',
  'Business controls': 'Approvals, audit processing and capacity on this installation',
  'Tool use': 'Tool access, confirmation and processing speed',
  'Agents & delegation': 'Subagents, organisation size and shared work',
  'App permissions': 'Actions available from this app',
  Research: 'Research jobs and the work they may run',
  'Local models': 'AI services, default models and local performance',
  'Home screen': 'Conversations and activity on Home',
  'Connect this computer': 'Account connections and remote access',
  Setup: 'Permission level and working folders',
  Notifications: 'When this computer tells you about an agent',
  Appearance: 'Theme, lettering and agent colours',
  'Text & Reading': 'Text size and readability',
  'Motion & Effects': 'Animation, glow and hand controls',
  Accessibility: 'Voice and hands-free controls',
  Resources: 'CPU, memory and the pace of agent starts',
  'Rules & approvals': 'Standing instructions, purchases and the Ledger',
  'Data & Privacy': 'History, archiving and retained data',
  'What the screens show': 'Your activity or the example fleet',
  System: 'This installation, profiles and updates',
})

const CATEGORY_ALIASES = Object.freeze({
  'research-agents': 'Research',
  'things-it-may-do-for-you': 'App permissions',
  ledger: 'Rules & approvals',
})

const GROUP_BY_SECTION = new Map(
  SETTINGS_GROUPS.flatMap(group => group.sections.map(section => [section, group])),
)
const GROUP_IDS = new Set(SETTINGS_GROUPS.map(group => group.id))

export function groupOfSection(section) {
  return GROUP_BY_SECTION.get(section) || null
}

export function categorySlug(section) {
  return String(section).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function sectionFromSlug(slug) {
  if (typeof slug !== 'string') return null
  const wanted = slug.trim().toLowerCase()
  if (!wanted) return null
  if (CATEGORY_ALIASES[wanted]) return CATEGORY_ALIASES[wanted]
  for (const group of SETTINGS_GROUPS) {
    for (const section of group.sections) {
      if (categorySlug(section) === wanted) return section
    }
  }
  return null
}

export const OPEN_GROUPS_KEY = 'mc.settings.open-groups'

export function readOpenGroups(storage) {
  try {
    const raw = storage?.getItem?.(OPEN_GROUPS_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter(id => GROUP_IDS.has(id)))
  } catch {
    return new Set()
  }
}

export function writeOpenGroups(openIds, storage) {
  try {
    const kept = [...openIds].filter(id => GROUP_IDS.has(id))
    if (kept.length === 0) storage?.removeItem?.(OPEN_GROUPS_KEY)
    else storage?.setItem?.(OPEN_GROUPS_KEY, JSON.stringify(kept))
  } catch {  }
}

/* THE SECTION A BRAND-NEW PERSON IS SHOWN, AND WHY IT MOVED.
 *
 * It was 'Tool use'. The rule exists because of a measured defect: on a sterile
 * profile every group rendered collapsed, and the only persistent door to
 * `#/account` in this product measured 0x0 inside one of them. So the arrival
 * rule opens the group holding the thing a person with nothing set up needs
 * first.
 *
 * That thing is no longer a tool switch. 'This computer' now holds the Install
 * and Sign in buttons for Codex, Claude and Gemini, and a copy with none of
 * them cannot start an agent whatever the tool switches say. It is in the same
 * group as 'Connect this computer', so the door the original measurement was
 * about is still opened by this rule; the section shown on top of it is now the
 * one that answers the first question. */
export const FIRST_VISIT_SECTION = 'This computer'

export function groupsOpenOnArrival(storage, landingSection = null) {
  const open = readOpenGroups(storage)
  const landingGroup = landingSection ? groupOfSection(landingSection) : null
  if (landingGroup) open.add(landingGroup.id)
  if (open.size > 0) return open
  const arrival = groupOfSection(FIRST_VISIT_SECTION)
  if (arrival) open.add(arrival.id)
  return open
}

export function toggleStateSentence({ value, def = false, acts = false }) {
  const truth = value ? 'On.' : 'Off.'
  if (acts) {
    return value
      ? 'On. This ships switched off; it was turned on on the computer you are driving.'
      : 'Off. This ships switched off; nothing acts until you turn it on.'
  }
  if (Boolean(value) === Boolean(def)) return truth
  return value ? 'On. Ships off.' : 'Off. Ships on.'
}

const MACHINE_PATH = /^machines\[(\d+)\]\.(\w+)$/
const TRANSPORT_PATH = /^transports\[(\d+)\]\.(\w+)$/

function fieldNote(path) {
  return ` (the ${path} field)`
}

export function humanizeProfileError(error) {
  const rawPath = typeof error?.path === 'string' ? error.path : '$'
  const message = typeof error?.message === 'string'
    ? error.message
    : 'needs a different value; edit it and save again'

  const machine = MACHINE_PATH.exec(rawPath)
  if (machine) {
    const nth = Number(machine[1]) + 1
    if (machine[2] === 'ip' || machine[2] === 'address') {
      /* Each validator reason stays distinct (T1586): a typed address that is
         not valid, or that carries a login, is not reported as missing. */
      if (/credentials/.test(message)) return `Machine ${nth}'s address must not contain a user name or password${fieldNote(rawPath)}.`
      if (/not a valid/.test(message)) return `Machine ${nth}'s address is not a valid host, IP address or URL${fieldNote(rawPath)}.`
      if (!/required/.test(message)) return `Machine ${nth}'s address ${message}${fieldNote(rawPath)}.`
      return `Machine ${nth} needs an address — host:port, a URL, an IP, or a hostname${fieldNote(rawPath)}.`
    }
    if (machine[2] === 'name') {
      return `Machine ${nth} needs a name${fieldNote(rawPath)}.`
    }
    return `Machine ${nth}: its ${machine[2]} ${message}${fieldNote(rawPath)}.`
  }

  const transport = TRANSPORT_PATH.exec(rawPath)
  if (transport) {
    const nth = Number(transport[1]) + 1
    if (transport[2] === 'port') {
      return `Connection ${nth}'s port must be a number from 1 through 65535, or left empty${fieldNote(rawPath)}.`
    }
    if (transport[2] === 'endpoint') {
      if (/credentials/.test(message)) return `Connection ${nth}'s address must not contain a user name or password${fieldNote(rawPath)}.`
      if (/not a valid/.test(message)) return `Connection ${nth}'s address is not a valid URL or host:port${fieldNote(rawPath)}.`
      if (!/must be text/.test(message)) return `Connection ${nth}'s address ${message}${fieldNote(rawPath)}.`
      return `Connection ${nth}'s address must be written as text — a URL or host:port${fieldNote(rawPath)}.`
    }
    return `Connection ${nth}: its ${transport[2]} ${message}${fieldNote(rawPath)}.`
  }

  /* The roster and lane lists themselves (T1427): a one-computer install read the
     raw 'machines must contain at least one machine' when it saved a name. */
  if (rawPath === 'machines' && /at least one/.test(message)) {
    return 'Add a machine to the Machine roster first. The System profile is saved only with at least one machine in it.'
  }
  if (rawPath === 'transports' && /at least one/.test(message)) {
    return 'Add a connection lane first. The System profile is saved only with at least one lane in it.'
  }
  if (rawPath === 'label' || rawPath === '$.label') {
    return `The profile needs a name — any label you will recognize${fieldNote(rawPath)}.`
  }
  if (rawPath === 'dataSource.path') {
    return `The data folder needs a real folder path${fieldNote(rawPath)}.`
  }

  return `${rawPath} ${message}`
}

export function humanizeProfileErrors(errors, { limit = 5 } = {}) {
  return (errors || []).slice(0, limit).map(humanizeProfileError).join(' ')
}
