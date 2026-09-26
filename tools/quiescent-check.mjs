#!/usr/bin/env node

/*
 * Answer one deliberately narrow question before a test run: is this checkout
 * quiet enough that its result can be treated as evidence?
 *
 * This is not a cleanliness check. A file may be uncommitted but old and
 * stable. Conversely, a clean-looking file may have been rewritten moments
 * ago while another process is still working. The two disqualifiers here are
 * recent file activity and a live agent-like process that could write again.
 *
 * Inspection failure is its own result. UNKNOWN must never collapse to QUIET:
 * that would recreate the exact false confidence this gate exists to prevent.
 */

import { execFileSync } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const VERDICTS = Object.freeze({ QUIET: 0, MOVING: 1, UNKNOWN: 2 })
const DEFAULT_WINDOW_SECONDS = 60
const INSPECTION_COMMAND_TIMEOUT_MS = 5_000
const INSPECTION_COMMAND_BUFFER_BYTES = 16 * 1024 * 1024
const MAX_REPORTED_PROCESSES = 8

// These are generated or dependency trees, not authored working-tree input.
// Extra top-level directories can be excluded with repeated --exclude flags.
const DEFAULT_EXCLUDED_DIRECTORIES = Object.freeze([
  '.git',
  'node_modules',
  'build',
  'dist',
  'release',
  'release-cut',
  'artifacts',
  'coverage',
  'out',
])

// Match executable/package tokens rather than arbitrary prose containing words
// such as "agent". Every listed program is an autonomous coding agent capable
// of writing a checkout when it is running with ordinary filesystem access.
const AGENT_EXECUTABLE_NAME = /^(?:codex|claude|gemini|aider|cursor-agent|opencode|goose)(?:\.exe|\.cmd|\.js)?$/i
const JAVASCRIPT_RUNTIME_NAME = /^(?:node|nodejs|bun|deno)(?:\.exe)?$/i
const AGENT_PACKAGE_PATTERNS = Object.freeze([
  /@openai[\\/]codex/i,
  /@anthropic-ai[\\/]claude-code/i,
  /@google[\\/]gemini-cli/i,
])

function usageError(message) {
  throw new Error(`${message}\nUsage: node tools/quiescent-check.mjs [--root PATH] [--window-seconds N] [--exclude TOP_LEVEL_DIR]`)
}

function parseArguments(argv) {
  const options = {
    root: process.cwd(),
    windowSeconds: DEFAULT_WINDOW_SECONDS,
    excludedDirectories: new Set(DEFAULT_EXCLUDED_DIRECTORIES),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (argument === '--root') {
      if (!value) usageError('--root requires a path')
      options.root = value
      index += 1
    } else if (argument === '--window-seconds') {
      if (!value) usageError('--window-seconds requires a number')
      const parsed = Number(value)
      if (!Number.isFinite(parsed) || parsed < 0) usageError('--window-seconds must be a non-negative number')
      options.windowSeconds = parsed
      index += 1
    } else if (argument === '--exclude') {
      if (!value) usageError('--exclude requires a top-level directory name')
      const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
      if (!normalized || normalized.includes('/') || normalized === '.' || normalized === '..') {
        usageError('--exclude accepts one top-level directory name per flag')
      }
      options.excludedDirectories.add(normalized)
      index += 1
    } else if (argument === '--help' || argument === '-h') {
      console.log('Usage: node tools/quiescent-check.mjs [--root PATH] [--window-seconds N] [--exclude TOP_LEVEL_DIR]')
      console.log(`Default recent window: ${DEFAULT_WINDOW_SECONDS} seconds.`)
      process.exit(VERDICTS.QUIET)
    } else {
      usageError(`unknown argument: ${argument}`)
    }
  }

  return { ...options, root: path.resolve(options.root) }
}

function gitFileList(root) {
  const output = execFileSync(
    'git',
    ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: INSPECTION_COMMAND_TIMEOUT_MS,
      maxBuffer: INSPECTION_COMMAND_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  return output.split('\0').filter(Boolean)
}

function isExcluded(relativePath, excludedDirectories) {
  const topLevel = relativePath.replaceAll('\\', '/').split('/', 1)[0]
  return excludedDirectories.has(topLevel)
}

async function inspectFiles(root, excludedDirectories) {
  const relativePaths = gitFileList(root).filter(file => !isExcluded(file, excludedDirectories))
  if (relativePaths.length === 0) throw new Error('git found no tracked or untracked files to inspect')

  let newest = null
  const failures = []
  await Promise.all(relativePaths.map(async (relativePath) => {
    try {
      const reading = await stat(path.join(root, relativePath))
      if (!reading.isFile()) return
      if (!newest || reading.mtimeMs > newest.mtimeMs) {
        newest = { relativePath: relativePath.replaceAll('\\', '/'), mtimeMs: reading.mtimeMs }
      }
    } catch (error) {
      failures.push(`${relativePath}: ${error.code || error.message}`)
    }
  }))

  if (failures.length > 0) {
    const shown = failures.slice(0, 3).join('; ')
    const remainder = failures.length > 3 ? `; and ${failures.length - 3} more` : ''
    throw new Error(`could not stat ${failures.length} listed file(s): ${shown}${remainder}`)
  }
  if (!newest) throw new Error('no regular tracked or untracked file could be measured')
  return { ...newest, fileCount: relativePaths.length }
}

function windowsProcesses() {
  const command = [
    'Get-CimInstance Win32_Process',
    'Select-Object ProcessId,Name,ExecutablePath,CommandLine',
    'ConvertTo-Json -Compress',
  ].join(' | ')
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: INSPECTION_COMMAND_TIMEOUT_MS,
    maxBuffer: INSPECTION_COMMAND_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (!output) return []
  const parsed = JSON.parse(output)
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  return entries.map(entry => ({
    pid: Number(entry.ProcessId),
    name: String(entry.Name || ''),
    command: String(entry.CommandLine || entry.ExecutablePath || entry.Name || ''),
  }))
}

function posixProcesses() {
  const output = execFileSync('ps', ['-eo', 'pid=,comm=,args='], {
    encoding: 'utf8',
    timeout: INSPECTION_COMMAND_TIMEOUT_MS,
    maxBuffer: INSPECTION_COMMAND_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/)
    if (!match) throw new Error(`could not parse process-list row: ${line.slice(0, 120)}`)
    return { pid: Number(match[1]), name: match[2], command: match[3] || match[2] }
  })
}

function inspectAgentProcesses() {
  const processes = process.platform === 'win32' ? windowsProcesses() : posixProcesses()
  return processes.filter((entry) => {
    if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0) return false
    const executableName = path.basename(entry.name)
    return AGENT_EXECUTABLE_NAME.test(executableName) ||
      (JAVASCRIPT_RUNTIME_NAME.test(executableName) && AGENT_PACKAGE_PATTERNS.some(pattern => pattern.test(entry.command)))
  })
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, milliseconds / 1_000)
  if (seconds < 1) return `${Math.round(seconds * 1_000)}ms`
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)}m`
  const hours = minutes / 60
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`
  return `${(hours / 24).toFixed(1)}d`
}

function conciseCommand(entry) {
  const collapsed = entry.command.replace(/\s+/g, ' ').trim()
  const limit = 180
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 3)}...` : collapsed
}

async function inspect(options) {
  const errors = []
  let files = null
  let agents = null

  try {
    files = await inspectFiles(options.root, options.excludedDirectories)
  } catch (error) {
    errors.push(`file inspection failed: ${error.message}`)
  }

  try {
    agents = inspectAgentProcesses()
  } catch (error) {
    errors.push(`process inspection failed: ${error.message}`)
  }

  const checkedAtMs = Date.now()
  const unchangedMs = files ? Math.max(0, checkedAtMs - files.mtimeMs) : null
  const recent = files ? unchangedMs <= options.windowSeconds * 1_000 : null
  // A positive disqualifier is enough to answer MOVING even if the other
  // observation failed. UNKNOWN is for the narrower case where nothing proved
  // movement and the observations were incomplete; it can still never become
  // QUIET.
  const moving = recent === true || (agents?.length || 0) > 0
  const verdict = moving ? 'MOVING' : errors.length > 0 ? 'UNKNOWN' : 'QUIET'

  return { verdict, checkedAtMs, unchangedMs, recent, files, agents, errors }
}

function report(options, result) {
  console.log(`[quiescent-check] ${result.verdict}`)
  console.log(`root: ${options.root}`)
  console.log(`recent window: ${formatDuration(options.windowSeconds * 1_000)}`)

  if (result.files) {
    console.log(`newest file: ${result.files.relativePath}`)
    console.log(`newest change: ${result.files.relativePath} changed ${formatDuration(result.unchangedMs)} ago`)
    console.log(`newest mtime: ${new Date(result.files.mtimeMs).toISOString()}`)
    console.log(`tree unchanged for: ${formatDuration(result.unchangedMs)}`)
    console.log(`recent file activity: ${result.recent ? 'YES' : 'no'} (${result.files.fileCount} files inspected)`)
  } else {
    console.log('newest file: UNKNOWN')
    console.log('tree unchanged for: UNKNOWN')
    console.log('recent file activity: UNKNOWN')
  }

  if (result.agents) {
    console.log(`agent-like writers: ${result.agents.length === 0 ? 'none found' : `${result.agents.length} running`}`)
    for (const entry of result.agents.slice(0, MAX_REPORTED_PROCESSES)) {
      console.log(`  pid ${entry.pid}: ${conciseCommand(entry)}`)
    }
    if (result.agents.length > MAX_REPORTED_PROCESSES) {
      console.log(`  ... and ${result.agents.length - MAX_REPORTED_PROCESSES} more`)
    }
  } else {
    console.log('agent-like writers: UNKNOWN')
  }

  for (const error of result.errors) console.error(`inspection error: ${error}`)
  if (result.verdict === 'QUIET') {
    console.log('reason: no included file changed inside the recent window, and no agent-like writer was found')
  } else if (result.verdict === 'MOVING') {
    const reasons = []
    if (result.recent) reasons.push(`${result.files.relativePath} changed ${formatDuration(result.unchangedMs)} ago`)
    if (result.agents?.length > 0) reasons.push(`${result.agents.length} agent-like writer(s) are running`)
    console.log(`reason: ${reasons.join('; ')}`)
  } else {
    console.log('reason: the required observations did not all succeed, so this tree cannot be called safe')
  }
}

async function main() {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
    const result = await inspect(options)
    report(options, result)
    process.exitCode = VERDICTS[result.verdict]
  } catch (error) {
    console.error('[quiescent-check] UNKNOWN')
    console.error(`reason: ${error.message}`)
    process.exitCode = VERDICTS.UNKNOWN
  }
}

await main()
