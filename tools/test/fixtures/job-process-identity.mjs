import path from 'node:path'

const samePath = (left, right) => typeof left === 'string' && typeof right === 'string'
  && path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase()
const validPid = pid => Number.isInteger(pid) && pid > 0

// A Windows ParentProcessId survives its parent's death. Walking a global
// process table by PID alone can therefore adopt an unrelated old process
// after PID reuse. Readiness comes from the three actual fixture processes;
// OS metadata must corroborate their executable, per-run script and birth.
export function identifyJobFixtureTree(rootPid, ready, processes, { treePath, executable, startedAtMs }) {
  if (!validPid(rootPid) || !Array.isArray(ready) || ready.length !== 3) return null
  if (!Number.isFinite(startedAtMs)) return null
  const records = [2, 1, 0].map(depth => ready.find(record => record?.depth === depth))
  if (records.some(record => !record || !validPid(record.pid) || !validPid(record.ppid)
      || !Number.isFinite(record.readyAtMs) || !samePath(record.executable, executable))) return null
  if (new Set(records.map(record => record.pid)).size !== 3 || records[0].pid !== rootPid) return null
  if (records[1].ppid !== rootPid || records[2].ppid !== records[1].pid) return null
  const script = treePath.toLowerCase()
  const matched = records.map(record => {
    const row = processes.find(candidate => candidate.pid === record.pid)
    const bornAtMs = Date.parse(row?.createdAt)
    const words = typeof row?.commandLine === 'string'
      ? row.commandLine.match(/"[^"]*"|[^\s]+/g)?.map(word => word.replace(/^"|"$/g, '').toLowerCase()) || []
      : []
    return row && row.ppid === record.ppid && samePath(row.executable, executable)
      && Number.isFinite(bornAtMs) && bornAtMs >= startedAtMs && bornAtMs <= record.readyAtMs
      && words[1] === script && words[2] === String(record.depth)
      ? row : null
  })
  return matched.every(Boolean) ? matched : null
}

export function sameJobFixtureGeneration(expected, observed) {
  return Boolean(expected && observed && validPid(expected.pid) && expected.pid === observed.pid
    && Number.isFinite(Date.parse(expected.createdAt))
    && expected.createdAt === observed.createdAt
    && samePath(expected.executable, observed.executable))
}
