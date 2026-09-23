'use strict'

const fs = require('node:fs')
const path = require('node:path')

// A dependency which never ran is not a passing check. Keep that distinction
// in the durable report and in the process exit code.
class NativeAuditReport {
  constructor(directory, metadata = {}) {
    this.directory = directory
    this.metadata = metadata
    this.results = []
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  event(event) {
    fs.appendFileSync(path.join(this.directory, 'actions.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n')
  }
  notRun(scenario, reason) {
    const row = { id: scenario.id, title: scenario.title, controls: scenario.controls || [], status: 'not-run', reason, finishedAt: new Date().toISOString() }
    this.results.push(row)
    this.event({ kind: 'case-result', ...row })
  }
  async run(scenario, context) {
    const missing = (scenario.requires || []).filter(id => !this.results.some(row => row.id === id && row.status === 'passed'))
    const row = { id: scenario.id, title: scenario.title, controls: scenario.controls || [], startedAt: new Date().toISOString(), status: 'running' }
    this.results.push(row)
    if (missing.length) {
      row.status = 'not-run'
      row.reason = `Required checks did not pass: ${missing.join(', ')}`
    } else {
      try {
        this.event({ kind: 'case-start', id: row.id })
        await scenario.run(context)
        row.status = 'passed'
      } catch (error) {
        row.status = error.code === 'NATIVE_AUDIT_UNAVAILABLE' ? 'unavailable' : 'failed'
        row.reason = String(error.message || error)
        row.stack = error.stack
        await context.capture?.(`${row.id}-failure`).catch(cause => { row.captureError = cause.message })
      }
    }
    row.finishedAt = new Date().toISOString()
    this.event({ kind: 'case-result', ...row })
    this.save()
    process.stdout.write(`${row.status.toUpperCase()} ${row.id}: ${row.title}${row.reason ? ` — ${row.reason}` : ''}\n`)
    return row
  }
  save() {
    fs.writeFileSync(path.join(this.directory, 'report.json'), JSON.stringify({
      schemaVersion: 1,
      scope: 'The individually listed native scenarios; unlisted controls are not covered by this run.',
      ...this.metadata,
      results: this.results,
      counts: Object.fromEntries(['passed', 'failed', 'unavailable', 'not-run', 'running'].map(status => [status, this.results.filter(row => row.status === status).length])),
    }, null, 2) + '\n')
  }
  exitCode() {
    if (this.results.some(row => row.status === 'failed')) return 1
    return this.results.length && this.results.every(row => row.status === 'passed') ? 0 : 2
  }
}

function selectScenarios(scenarios, requested = []) {
  const byId = new Map(scenarios.map(item => [item.id, item]))
  if (byId.size !== scenarios.length) throw new Error('Native audit case IDs must be unique')
  const selected = new Set()
  const visiting = new Set()
  const ordered = []
  function visit(id) {
    if (selected.has(id)) return
    const item = byId.get(id)
    if (!item) throw new Error(`Unknown native audit case: ${id}`)
    if (visiting.has(id)) throw new Error(`Cyclic native audit dependency: ${id}`)
    visiting.add(id)
    for (const dependency of item.requires || []) visit(dependency)
    visiting.delete(id)
    selected.add(id)
    ordered.push(item)
  }
  for (const id of requested.length ? requested : byId.keys()) visit(id)
  return ordered
}

function unavailable(message) {
  const error = new Error(message)
  error.code = 'NATIVE_AUDIT_UNAVAILABLE'
  throw error
}

module.exports = { NativeAuditReport, selectScenarios, unavailable }
