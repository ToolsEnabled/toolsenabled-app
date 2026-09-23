/* THE PANEL'S WORDS FOR WHAT BECAME OF A JOB, AND THE LOOP THAT WAITS FOR THEM.
 *
 * SEPARATE FROM write-surfaces.js ON PURPOSE, AND THE REASON IS TESTABILITY, NOT
 * TIDINESS. Both functions below are pure, and both were unreachable from a test
 * while they lived in that file: importing write-surfaces.js pulls in the panel,
 * the audited connection and the write flags, which want a browser and keep
 * timers alive -- `node --test` hung rather than failed. A module with no imports
 * of its own can be driven with a fake clock and a fake connection in
 * milliseconds, so the wording and the give-up rule are actually covered.
 */

/* WHAT THE SCREEN SAYS ABOUT A JOB AFTER IT WAS HANDED OVER.
 *
 * The panel used to say "Handed over ... The assistant is starting on it now."
 * and then say that for ever. It was true for about a second. After that it was
 * the same sentence whether the assistant had finished, stopped without
 * finishing, or never started -- and a person watching it had no way to tell
 * which. Driving the installed 1.0.17 on 2026-08-16: a Claude assistant started,
 * did the work, replied, and this line never moved.
 *
 * Exported and pure so the wording is tested without a browser or a clock.
 *
 * THE TWO "WE DO NOT KNOW" ANSWERS ARE KEPT APART ON PURPOSE. `stale` means the
 * job ran past its own time limit and nothing was written down about how it
 * ended; `unrecorded` means the driven computer has no record of the job at all. Both
 * would be a lie as "it failed", and they send a person to different places, so
 * they get different sentences. */
export function launchOutcomeCopy(receipt) {
  const state = receipt && typeof receipt.state === 'string' ? receipt.state : null
  if (state === 'completed') {
    return { kind: 'confirmed', text: 'Finished. The assistant did the job, and it is written down on the computer you are driving.' }
  }
  if (state === 'failed') {
    return { kind: 'refused', text: 'The assistant stopped without finishing. Read its report, or hand the job over again.' }
  }
  if (state === 'stale') {
    return { kind: 'refused', text: 'Nothing was written down about how this ended. Open the agent list to see whether it is still going.' }
  }
  if (state === 'unrecorded') {
    return { kind: 'refused', text: 'The computer you are driving has no record of that job. Hand it over again.' }
  }
  if (state === 'unavailable' && receipt?.code === 'LAUNCH_STATUS_UNAVAILABLE') {
    return { kind: 'pending', text: 'This screen could not check the job. This does not mean the job or its record is absent; open the agent list to check.' }
  }
  if (state === 'running') {
    return { kind: 'pending', text: 'Handed over, and written down on the computer you are driving. The assistant is working on it now.' }
  }
  /* Anything else is a shape this screen was not taught. Saying so is honest;
     guessing "finished" is the failure this whole change exists to end. */
  return { kind: 'pending', text: 'Handed over. This screen could not tell how the job is going; open the agent list to check.' }
}

/* Ask again until the job stops running. Every value it needs is a parameter so
   a test drives it with a fake clock and a fake connection.
   - It stops on the first answer that is not "running", and never runs longer
     than the job's own time limit plus one interval, so a screen left open does
     not keep asking for ever.
   - A failed ASK is not a failed JOB. The connection dropping says nothing about
     the assistant, so it keeps asking and only gives up at the same ceiling. */
export async function watchLaunchOutcome({
  launchId, ask, onOutcome, sleep, intervalMs = 5_000, capMs = 20 * 60_000, maxMs = null,
}) {
  const ceiling = Number.isFinite(maxMs) ? maxMs : capMs + intervalMs
  let waited = 0
  let lastKnown = null
  let latestCheckFailure = null
  while (waited <= ceiling) {
    await sleep(intervalMs)
    waited += intervalMs
    let result
    try {
      result = await ask(launchId)
    } catch (error) {
      /* A thrown read is not evidence that a launch record is absent. Keep
         polling so a busy machine can recover, but remember why this attempt
         taught us nothing. This value lives only in this watcher and is cleared
         by the next real receipt; it is never cached across calls. */
      latestCheckFailure = error
      continue
    }
    if (result === false) return lastKnown
    if (result && result.ok && result.receipt) {
      latestCheckFailure = null
      lastKnown = result.receipt
      if (result.receipt.state !== 'running') {
        onOutcome(result.receipt)
        return result.receipt
      }
    } else {
      latestCheckFailure = result?.code || 'UNSHAPED_STATUS_RESPONSE'
    }
  }
  if (latestCheckFailure !== null) {
    const causeCode = typeof latestCheckFailure?.code === 'string'
      ? latestCheckFailure.code
      : (typeof latestCheckFailure === 'string' ? latestCheckFailure : null)
    const unavailable = { state: 'unavailable', code: 'LAUNCH_STATUS_UNAVAILABLE', causeCode }
    onOutcome(unavailable)
    return unavailable
  }
  onOutcome(lastKnown || { state: 'stale' })
  return lastKnown
}
