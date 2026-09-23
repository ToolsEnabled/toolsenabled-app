const path = require('path')

const CRASH_DUMP_DIR_NAME = 'crash-dumps'
const MAX_CRASH_DUMPS = 5

const SECRETS_BEARING = Object.freeze({
  path: CRASH_DUMP_DIR_NAME,
  reason: 'Minidumps are a memory image of renderer pages that have held fleet data, repository paths, and a live bridge bearer token.',
  neverInclude: Object.freeze([
    'support-bundle',
    'log-export',
    'diagnostic-archive',
    'clean-room-export',
    'telemetry',
  ]),
  uploadPermitted: false,
})

function crashReporterOptions() {
  return { uploadToServer: false }
}

function isExcludedFromCollection(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/')).replace(/^\.\/+/, '')
  const dumpDirectory = CRASH_DUMP_DIR_NAME.toLowerCase()
  const candidate = normalized.toLowerCase()
  return candidate === dumpDirectory || candidate.startsWith(`${dumpDirectory}/`)
}

function crashDumpFilesToDelete(files, cap = MAX_CRASH_DUMPS) {
  if (!Array.isArray(files) || files.length === 0) return []
  if (!Number.isInteger(cap) || cap < 0) return []
  if (files.some((file) => (
    file === null || typeof file !== 'object' ||
    typeof file.name !== 'string' || file.name.length === 0 ||
    !Number.isFinite(file.mtimeMs)
  ))) return []

  return [...files]
    .sort((left, right) => (
      left.mtimeMs - right.mtimeMs || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    ))
    .slice(0, Math.max(0, files.length - cap))
    .map(({ name }) => name)
}

module.exports = {
  CRASH_DUMP_DIR_NAME,
  MAX_CRASH_DUMPS,
  SECRETS_BEARING,
  crashReporterOptions,
  isExcludedFromCollection,
  crashDumpFilesToDelete,
}
