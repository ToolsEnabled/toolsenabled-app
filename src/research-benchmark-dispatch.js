import { invariant, sha256 } from './benchmark/prompts.mjs'
import { parseRunner } from './research-grid.js'

const SERVICE_TIMEOUT_MS = 3600000
const SERVICE_FINALIZATION_MS = 30000
const REQUIRED_PINS = ['manifest.json', 'project.json', 'cli.mjs', 'prompts.mjs', 'study.mjs', 'runner.mjs', 'module-host.mjs']

export async function exportedBenchmarkExperiment({ project, directory, command, files, projectId }) {
  invariant(projectId, 'Choose a saved research project above before submitting to the run board.')
  invariant(typeof directory === 'string' && (/^\/(?!\/)/.test(directory) || /^[a-z]:[\\/]/i.test(directory)), 'Enter the full path of the extracted project on the run computer.')
  invariant(!/[{}\0]/.test(directory) && !directory.split(/[\\/]/).some(part => part === '.' || part === '..'), 'Use a literal project directory without parent shortcuts or substitution tokens.')
  const durationMs = project.spec.protocol.maxDurationMs
  invariant(Number.isSafeInteger(durationMs) && durationMs > 0, 'The frozen project needs a positive study time budget.')
  const timeoutMs = durationMs + SERVICE_FINALIZATION_MS
  invariant(timeoutMs <= SERVICE_TIMEOUT_MS, 'The run service has a one-hour limit, including 30 seconds for startup and saving results. Reduce the study time budget to 59 minutes 30 seconds or less and export again, or run the exported CLI independently.')
  const adapters = project.spec.conditions.map(condition => condition.adapter)
  invariant(!adapters.some(adapter => adapter.credentialEnv), 'The run service does not forward credential environment variables. Run the exported CLI independently with its required variables set on that computer.')
  const envKeys = [...new Set(adapters.flatMap(adapter => adapter.env || []))].sort()
  invariant(envKeys.length <= 16, 'The run service supports at most 16 additional environment variables. Reduce the adapter environment lists or run the exported CLI independently.')
  invariant(envKeys.every(key => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/(?:KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|AUTH)/i.test(key)), 'The run service cannot forward credential environment variables. Remove those names from the adapter environment lists or run the exported CLI independently.')
  const separator = /^[a-z]:/i.test(directory) ? '\\' : '/'
  const join = file => directory.replace(/[\\/]$/, '') + separator + file.replace(/\//g, separator)
  // Static imports execute before the CLI checks its manifest. Pin every
  // exported runtime module as well as the manifest and frozen project.
  const pinNames = [...new Set([...REQUIRED_PINS, ...Object.keys(files).filter(file => /\.(?:mjs|py)$/.test(file)).sort()])]
  invariant(pinNames.length <= 64, `The run service supports at most 64 pinned files; this export needs ${pinNames.length}. Run the exported CLI independently.`)
  const pinnedFiles = await Promise.all(pinNames.map(async file => {
    invariant(typeof files[file] === 'string', `The export is missing ${file}.`)
    return { path: join(file), sha256: await sha256(files[file]) }
  }))
  // The existing process runner sets cwd to this run's artifact directory.
  const runner = { kind: 'process', command, args: [join('cli.mjs'), 'run', '--project', directory, '--output', '.', '--compact'], pinnedFiles,
    ...(envKeys.length ? { envKeys } : {}) }
  const valid = parseRunner(runner)
  invariant(valid.ok, valid.sentence)
  return { name: `${project.spec.name} · ${project.sha256.slice(0, 12)}`.slice(0, 120), projectId,
    axes: [{ id: 'benchmark', values: [project.sha256.slice(0, 12)] }], runner, timeoutMs, runsPerCell: 1,
    resultSchema: { fields: { answer: 'string', completed: 'number', failed: 'number', scheduled: 'number' }, required: ['answer', 'completed', 'failed', 'scheduled'] } }
}
