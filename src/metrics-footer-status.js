/* THE METRICS FOOTER VERDICT (BUG08, root review 2026-09-21), in its own
 * module so it is the ACTUAL footer expression, unit-tested by value rather
 * than by a source pattern, without pulling the whole Metrics view (and its
 * CSS/chart imports) into a test.
 *
 * Activity auditing off is the person's own setting. The host answers a
 * history or usage read with { ok:false, code:'AUDIT_NOT_ENABLED' }, which the
 * readers carry as `disabled:true, readable:false` on that side (BUG08). That
 * is off, NOT a read failure: a page where one stream is off and the other
 * read fine, or where both are off, must not say records "could not be read".
 * A side is a genuine failure only when it is not readable AND not disabled;
 * off beside a genuinely broken side stays an error, because that side really
 * failed. A timeout is always an error.
 *
 * The off wording is scoped to NEW operations. Work already admitted to the
 * audit before the toggle may still finish recording, so the sentence claims
 * neither that nothing at all is written nor any machine/data-health
 * guarantee; it says auditing is off for new operations, and points at the
 * setting. */
export const METRICS_AUDIT_OFF_STATUS =
  'Activity auditing is off for new operations, so new runs are not recorded here. Turn it on under Advanced settings.'

export function metricsFooterStatus({ needsUpdate, sessions = {}, usage = {}, readErrors, updatedLabel } = {}) {
  if (needsUpdate) return 'App update needed'
  if (Object.values(readErrors || {}).includes('METRICS_READ_TIMEOUT')) return 'Some records took too long to load. Try Refresh data.'
  const genuinelyUnreadable = side => Boolean(side) && side.readable === false && side.disabled !== true
  if (genuinelyUnreadable(sessions) || genuinelyUnreadable(usage)) {
    // One side readable, the other genuinely failed -> partial; neither
    // readable (a genuine failure with an off or broken partner) -> total.
    return (sessions.readable || usage.readable) ? 'Some records could not be read. Try Refresh data.' : 'Could not read records. Try Refresh data.'
  }
  if (sessions.disabled || usage.disabled) return METRICS_AUDIT_OFF_STATUS
  if (sessions.readable || usage.readable) return updatedLabel
  return 'Could not read records. Try Refresh data.'
}
