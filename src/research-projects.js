// Projects: the layer that groups experiments, runs, findings and sessions
// under one named effort. The durable record lives behind the action bridge;
// this module is the page's client for it plus one piece of local state — which
// project the person is currently looking at (localStorage, this browser).
//
// THE ENVELOPE SURVIVES. Every read here returns the bridge's own
// {ok:false, reason, code} verbatim when it fails. A page that turns "the
// bridge is down" into an empty project list has invented data; the render
// layer gets the refusal and says the sentence instead.

import { postBridgeAction, researchSnapshot } from './mission-bridge.js'

export const PROJECT_SELECTION_KEY = 'mc.research.project'
/** The two non-project faces of the selector. */
export const PROJECT_ALL = 'all'
export const PROJECT_UNFILED = 'unfiled'

function safeStorage(storage) {
  return {
    get() {
      try {
        return storage?.getItem(PROJECT_SELECTION_KEY) ?? null
      } catch (cause) {
        const error = new Error('The remembered research project could not be read; this is not a claim that no selection exists.', { cause })
        error.code = 'RESEARCH_PROJECT_SELECTION_UNAVAILABLE'
        throw error
      }
    },
    set(value) {
      try {
        if (value === null) storage?.removeItem(PROJECT_SELECTION_KEY)
        else storage?.setItem(PROJECT_SELECTION_KEY, value)
      } catch {}
    },
  }
}

/** The remembered selection: 'all', 'unfiled', or a projectId. Absence is 'all'. */
export function readProjectSelection(storage) {
  const raw = safeStorage(storage).get()
  if (raw === PROJECT_UNFILED || raw === PROJECT_ALL) return raw
  if (typeof raw === 'string' && /^rp-[0-9a-f]{4,36}$/.test(raw)) return raw
  return PROJECT_ALL
}

export function writeProjectSelection(storage, selection) {
  const store = safeStorage(storage)
  if (selection === PROJECT_ALL) store.set(null)
  else store.set(selection)
}

/**
 * The page-open read. On success: { ok:true, projects, experiments,
 * assignments, settings, lifecycle }. On failure the bridge envelope comes
 * back untouched.
 */
export async function readResearchSnapshot({ snapshot = researchSnapshot } = {}) {
  const result = await snapshot()
  if (result?.ok !== true) return result ?? { ok: false, reason: 'the research service did not answer', code: 'BRIDGE_UNREACHABLE' }
  const receipt = result.receipt
  if (!receipt || typeof receipt !== 'object' || !Array.isArray(receipt.projects)) {
    return { ok: false, reason: 'the research service answered with an unreadable snapshot', code: 'RESEARCH_SNAPSHOT_INVALID' }
  }
  return {
    ok: true,
    projects: receipt.projects,
    experiments: receipt.experiments && typeof receipt.experiments === 'object' ? receipt.experiments : {},
    assignments: Array.isArray(receipt.assignments) ? receipt.assignments : [],
    settings: receipt.settings && typeof receipt.settings === 'object' ? receipt.settings : null,
    lifecycle: receipt.lifecycle && typeof receipt.lifecycle === 'object' ? receipt.lifecycle : null,
  }
}

/** Create or update a project. Update carries projectId; enabled/status flow through. */
export async function saveProject(body, { postAction = postBridgeAction } = {}) {
  const result = await postAction('research-project-save', body)
  if (result?.ok !== true) return result ?? { ok: false, reason: 'the save did not reach the research service' }
  const project = result.receipt?.project
  if (!project || typeof project.projectId !== 'string') {
    return { ok: false, reason: 'the research service saved without returning the project', code: 'RESEARCH_PROJECT_RECEIPT_INVALID' }
  }
  return { ok: true, project }
}

/**
 * Reserved for a future project-archive control. The current research page can
 * create and select projects but offers no archive action. If that control is
 * built, archive remains an update with status and never deletes the record.
 */
export function archiveProject(projectId, options) {
  return saveProject({ projectId, status: 'archived' }, options)
}

/**
 * Which selector face a thing files under. Experiments carry a projectId when
 * they were registered durably; local-only specs have none and are 'unfiled'.
 */
export function filesUnder(selection, projectId) {
  if (selection === PROJECT_ALL) return true
  if (selection === PROJECT_UNFILED) return projectId === null || projectId === undefined
  return projectId === selection
}
