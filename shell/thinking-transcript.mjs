// Pure shared contract used by the host capture and renderer. The summary
// limit is the existing engine event text limit; tool output has its own cap.
export const THINKING_TEXT_LIMIT = 1_000_000
export const THINKING_TRUNCATED_NOTICE = 'Summary shortened at the transcript size limit.'
export const THINKING_UNAVAILABLE_NOTICE = 'Summary unavailable in this saved conversation.'

export function thinkingTranscriptId(sessionId, turnId, itemId) {
  if (![sessionId, turnId, itemId].every(value => typeof value === 'string' && value && !value.includes('\0'))) return null
  const id = 'thinking:' + JSON.stringify([sessionId, turnId, itemId])
  // The canonical store admits identities up to 512 characters. An unnamed
  // or overlong item stays a separate renderer entry, never a guessed join.
  return id.length <= 512 ? id : null
}

export function thinkingSummary(text, truncated = false) {
  const source = typeof text === 'string' ? text : ''
  return { body: source.slice(0, THINKING_TEXT_LIMIT), truncated: truncated === true || source.length > THINKING_TEXT_LIMIT }
}
