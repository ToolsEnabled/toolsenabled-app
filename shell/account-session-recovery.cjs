'use strict'
const { isProviderSafetyRefusal } = require('./provider-safety.cjs')

// Read only a provider failure, never ordinary assistant prose or tool output.
function limitReason(event, { rateLimitCodeAlone = true } = {}) {
  if (isProviderSafetyRefusal(event)) return null
  if (!event || event.type !== 'turn_completed' || !['failed', 'error'].includes(event.status)) return null
  const code = String(event.code || event.error?.code || event.payload?.code || '').toLowerCase()
  const text = String(event.text || event.error?.message || '').slice(0, 4096).toLowerCase()
  if (/context[_ -]?(window|length|limit)|prompt (?:is )?too long|prompt_too_long|max(?:imum)?[_ -]?context/.test(code + ' ' + text)) return 'context-limit'
  const sentenceSaysLimit =
    /(?:you(?:'ve| have)? (?:hit|reached)|exceeded|reached|exhausted) (?:your |the |this account.s )?(?:usage |token |rate |session |weekly |daily |monthly |message )?(?:limit|quota|allowance)/.test(text)
    || /you(?:'ve| have) reached your [a-z0-9][a-z0-9_.-]{0,63} limit\b/.test(text)
    || /(?:usage|token|session|weekly|daily|monthly) limit (?:reached|exceeded)|out of (?:usage|tokens)|hit your limit/.test(text)
  /* 1.0.50 review of fixes, 3.5. `rate_limit` is the Claude CLI's code for EVERY
     HTTP 429, a transient one included ("API Error: Request rejected (429) · this
     may be a temporary capacity issue"). Where the caller says the code alone is
     not enough, that code counts only with the provider's own limit sentence,
     and never with a sentence that begins "API Error". */
  if (code === 'rate_limit' && !rateLimitCodeAlone && (!sentenceSaysLimit || text.startsWith('api error'))) return null
  if (code === 'rate_limit' || /acp_rate_limited|rate_limit_exceeded|usage_limit_reached|insufficient_quota|quota_exceeded/.test(code)
    || sentenceSaysLimit) return 'account-limit'
  return null
}

/* The verdict for a turn the adapter RESOLVED (a turn_completed it emitted),
   as opposed to a send it rejected. A rejected send carries the code the
   adapter chose for the refusal; a resolved Claude turn carries whatever the
   CLI attached to its last message, so there the generic 429 code is read with
   the sentence (above). */
function resolvedTurnLimitReason(event) {
  return limitReason(event, { rateLimitCodeAlone: false })
}

module.exports = { limitReason, resolvedTurnLimitReason }
