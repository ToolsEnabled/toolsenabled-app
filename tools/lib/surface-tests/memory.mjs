// The six reviewed smoke leaves use injected network/vault/clock boundaries
// and no physical fixtures. Keep their exact selection in plan.mjs. Execute
// individually: Node 22 aggregate TAP can misnumber mixed legacy/test leaves.
export async function runMemoryFixtures(job, { runChild, validateCompletion, executable, env, timeout, now = Date.now }) {
  const start = now(), files = []; let stdout = '', stderr = '', cleanupConfirmed = true
  for (const file of job.files) {
    if (!cleanupConfirmed || now() - start >= timeout) {
      files.push({ file, status: 'not-run', exitCode: null }); continue
    }
    const result = await runChild(executable, [file], { cwd: job.root, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'],
      timeout: Math.max(1, timeout - (now() - start)), maxBuffer: 4 * 1024 * 1024 })
    stdout += result.stdout || ''; stderr += result.stderr || ''
    cleanupConfirmed = result.cleanupConfirmed === true
    let evidence, evidenceError
    try { evidence = validateCompletion(result) } catch (error) { evidenceError = error.message }
    const pass = cleanupConfirmed && result.status === 0 && !result.error && !result.signal && !evidenceError && !evidence?.unexecuted
    files.push({ file, status: pass ? 'pass' : 'fail', exitCode: result.status, evidence, evidenceError,
      process: { exitCode: result.status, signal: result.signal || null, error: result.error?.code || null, custody: result.custody } })
  }
  return { result: { status: files.every(f => f.status === 'pass') ? 0 : 1, stdout, stderr, cleanupConfirmed },
    summary: { requested: job.files.length, files }, commands: job.files.map(file => [executable, file]) }
}
