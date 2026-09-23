// Findings: the durable claims a researcher files under a project when a
// results table showed something worth keeping. The record lives behind the
// action bridge (research-finding-save / research-findings); this module is
// the page's pure client for it — no DOM, no storage.
//
// THE ENVELOPE SURVIVES. Every bridge read here returns the bridge's own
// {ok:false, reason, code} verbatim when it fails. A page that turns "the
// bridge is down" into an empty findings list has invented data; the render
// layer gets the refusal and says the sentence instead.

import { postBridgeAction } from './mission-bridge.js'

export const FINDING_CLAIM_MAX = 500

const FINDING_STATE_WORD = Object.freeze({
  open: 'open',
  confirmed: 'confirmed',
  refuted: 'refuted',
  superseded: 'superseded',
})

/** The plain word for a finding's state; an unknown state renders as itself. */
export function findingStateWord(status) {
  return FINDING_STATE_WORD[status] || String(status || 'unrecorded')
}

function recordedText(value) {
  return typeof value === 'string' && value.trim() ? value : 'Not recorded.'
}

function recordedJson(value, absent) {
  if (value === undefined || value === null) return absent
  try {
    return JSON.stringify(value, null, 2) ?? 'This recorded value could not be displayed.'
  } catch {
    return 'This recorded value could not be displayed.'
  }
}

function recordedTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not recorded.'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Not recorded.' : date.toISOString()
}

/** Stored context, not a verification verdict. Empty and false JSON values
 * remain visible; a missing field must not become evidence of absence. */
export function findingDetailsModel(finding) {
  return {
    reviewNote: 'Independent review is not tracked by this service.',
    fields: [
      { label: 'Evidence', text: recordedJson(finding?.evidence, 'No evidence recorded.'), structured: true },
      { label: 'Method', text: recordedText(finding?.method) },
      { label: 'Recorded confidence', text: recordedText(finding?.confidence) },
      { label: 'What would disprove this claim', text: recordedText(finding?.falsifier) },
      { label: 'Dissent', text: Array.isArray(finding?.dissents) && finding.dissents.length === 0
        ? 'No dissent recorded.' : recordedJson(finding?.dissents, 'Dissent was not recorded.'), structured: true },
      { label: 'Supersedes finding', text: recordedText(finding?.supersedes) },
      { label: 'Created (UTC)', text: recordedTime(finding?.createdAtMs) },
      { label: 'Updated (UTC)', text: recordedTime(finding?.updatedAtMs) },
    ],
  }
}

/**
 * Validate and shape one finding before it travels. Local refusals speak the
 * workbench's {ok:false, sentence} shape; nothing is posted for them.
 */
export function buildFindingSave({ projectId, claim, status = 'open' } = {}) {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return { ok: false, sentence: 'Findings are filed under a project — pick one above, then save it again.' }
  }
  const cleaned = typeof claim === 'string' ? claim.trim() : ''
  if (cleaned.length === 0) {
    return { ok: false, sentence: 'Write the claim first — one sentence saying what the results showed.' }
  }
  if (cleaned.length > FINDING_CLAIM_MAX) {
    return { ok: false, sentence: `A claim fits in ${FINDING_CLAIM_MAX} characters. Shorten it, then save it again.` }
  }
  return { ok: true, body: { projectId, claim: cleaned, status } }
}

/** Save one finding. Bridge refusals pass through verbatim; a receipt without
 *  the finding's name is itself a refusal, never a silent success. */
export async function saveFinding(input, { postAction = postBridgeAction } = {}) {
  const built = buildFindingSave(input)
  if (!built.ok) return built
  const result = await postAction('research-finding-save', built.body)
  if (result?.ok !== true) return result ?? { ok: false, reason: 'the save did not reach the research service' }
  const findingId = result.receipt?.findingId
  if (typeof findingId !== 'string' || findingId.length === 0) {
    return { ok: false, reason: 'the research service saved without returning the finding', code: 'RESEARCH_FINDING_RECEIPT_INVALID' }
  }
  return { ok: true, findingId }
}

/** List one project's findings. Envelope survives on failure. */
export async function readFindings(projectId, { postAction = postBridgeAction } = {}) {
  const result = await postAction('research-findings', { projectId })
  if (result?.ok !== true) return result ?? { ok: false, reason: 'the research service did not answer' }
  const findings = result.receipt?.findings
  if (!Array.isArray(findings)) {
    return { ok: false, reason: 'the research service answered without a findings list', code: 'RESEARCH_FINDINGS_INVALID' }
  }
  return { ok: true, findings }
}
