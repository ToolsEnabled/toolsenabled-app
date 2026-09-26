#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { gitEnvironment } from '../lib/capability-source-git.mjs'
import { assertPackageLockParity } from './lib/package-lock-parity.mjs'

const HEX40 = /^[0-9a-f]{40}$/
const SEMVER = /^\d+\.\d+\.\d+$/

function parseArgs(argv) {
  const values = {}
  let allowSameVersion = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--allow-same-version') {
      if (allowSameVersion) throw new Error('--allow-same-version may be supplied only once')
      allowSameVersion = true
      continue
    }
    const value = argv[index + 1]
    if (!['--repo', '--source-ref', '--build-ref', '--version'].includes(flag) || value == null || Object.hasOwn(values, flag)) {
      throw new Error('usage: verify-version-transition.mjs --repo <path> --source-ref <sha> --build-ref <sha> --version <x.y.z>')
    }
    values[flag] = value
    index += 1
  }
  if (Object.keys(values).length !== 4 || !path.isAbsolute(values['--repo']) ||
      !HEX40.test(values['--source-ref']) || !HEX40.test(values['--build-ref']) || !SEMVER.test(values['--version'])) {
    throw new Error('version-transition arguments are incomplete or malformed')
  }
  return {
    repo: path.resolve(values['--repo']),
    sourceRef: values['--source-ref'],
    buildRef: values['--build-ref'],
    version: values['--version'],
    allowSameVersion,
  }
}

function gitBlob(repo, ref, relative) {
  const result = spawnSync('git', [
    '--no-replace-objects', '-c', 'core.hooksPath=NUL', '-c', `safe.directory=${repo.replaceAll('\\', '/')}`,
    '-C', repo, 'cat-file', 'blob', `${ref}:${relative}`,
  ], { encoding: null, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: gitEnvironment(process.env) })
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(`could not read exact ${ref}:${relative} blob (exit ${result.status}): ${result.error?.message ?? result.stderr?.toString('utf8') ?? ''}`)
  }
  return result.stdout
}

function gitText(repo, args, label) {
  const result = spawnSync('git', [
    '--no-replace-objects', '-c', 'core.hooksPath=NUL', '-c', `safe.directory=${repo.replaceAll('\\', '/')}`,
    '-C', repo, ...args,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: gitEnvironment(process.env) })
  if (result.error || result.status !== 0) {
    throw new Error(`${label} (exit ${result.status}): ${result.error?.message ?? result.stderr ?? ''}`)
  }
  return result.stdout.trim()
}

export function verifyVersionTransitionRefs({ repo, sourceRef, buildRef, allowSameVersion = false }) {
  if (!HEX40.test(sourceRef) || !HEX40.test(buildRef)) throw new Error('sourceRef and buildRef must be exact commit ids')
  const sourceCommit = gitText(repo, ['rev-parse', '--verify', `${sourceRef}^{commit}`], 'could not resolve sourceRef')
  const buildCommit = gitText(repo, ['rev-parse', '--verify', `${buildRef}^{commit}`], 'could not resolve buildRef')
  if (sourceCommit !== sourceRef || buildCommit !== buildRef) throw new Error('version-transition refs must resolve to themselves')
  if (sourceCommit === buildCommit) {
    if (!allowSameVersion) throw new Error('an unchanged buildRef requires explicit --allow-same-version')
    return true
  }
  const buildAndParents = gitText(repo, ['rev-list', '--parents', '-n', '1', buildCommit], 'could not inspect buildRef parents')
    .split(/\s+/)
  const parents = buildAndParents.slice(1)
  if (parents.length !== 1 || parents[0] !== sourceCommit) {
    throw new Error('buildRef must be a single-parent commit whose direct parent is sourceRef')
  }
  const changedPaths = gitText(repo, [
    'diff-tree', '--no-commit-id', '--name-only', '-r', '--no-renames', buildCommit,
  ], 'could not inspect buildRef changed paths').split(/\r?\n/).filter(Boolean).sort()
  const expectedPaths = ['package-lock.json', 'package.json']
  if (changedPaths.length !== expectedPaths.length || changedPaths.some((relative, index) => relative !== expectedPaths[index])) {
    throw new Error(`buildRef must change exactly package.json and package-lock.json; changed [${changedPaths.join(', ')}]`)
  }
  return true
}

function strictUtf8Json(bytes, label) {
  if (bytes.length === 0 || (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) || bytes.includes(0)) {
    throw new Error(`${label} is empty, BOM-prefixed, or contains NUL`)
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return { text, value: JSON.parse(text) }
}

function expectedBytes(sourceBytes, relative, version) {
  const { text, value } = strictUtf8Json(sourceBytes, `source ${relative}`)
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.version !== 'string') {
    throw new Error(`source ${relative} has no root version string`)
  }
  value.version = version
  if (relative === 'package-lock.json') {
    if (!value.packages || typeof value.packages !== 'object' || Array.isArray(value.packages) ||
        !value.packages[''] || typeof value.packages[''] !== 'object' || Array.isArray(value.packages['']) ||
        typeof value.packages[''].version !== 'string') {
      throw new Error('source package-lock.json has no packages[""].version string')
    }
    value.packages[''].version = version
  }
  return Buffer.from(`${JSON.stringify(value, null, 2)}${text.endsWith('\n') ? '\n' : ''}`, 'utf8')
}

export function verifyVersionTransition({ sourcePackage, buildPackage, sourceLock, buildLock, version }) {
  const expectedPackage = expectedBytes(sourcePackage, 'package.json', version)
  const expectedLock = expectedBytes(sourceLock, 'package-lock.json', version)
  if (!expectedPackage.equals(buildPackage)) throw new Error('buildRef package.json differs from the exact version-only rewrite')
  if (!expectedLock.equals(buildLock)) throw new Error('buildRef package-lock.json differs from the exact root-version-only rewrite')
  return true
}

// No version commit exists in the explicit unchanged-source case. Read and
// verify the actual committed package graph instead of manufacturing an empty
// commit or silently skipping the independent pre-build proof.
export function verifyUnchangedVersion({ sourcePackage, sourceLock, version }) {
  const pkg = strictUtf8Json(sourcePackage, 'source package.json').value
  const lock = strictUtf8Json(sourceLock, 'source package-lock.json').value
  if (pkg?.version !== version || lock?.version !== version || lock?.packages?.['']?.version !== version) {
    throw new Error('unchanged source must already carry the requested version in all three package fields')
  }
  assertPackageLockParity(pkg, lock)
  return true
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  verifyVersionTransitionRefs(args)
  if (args.sourceRef === args.buildRef) {
    verifyUnchangedVersion({
      sourcePackage: gitBlob(args.repo, args.sourceRef, 'package.json'),
      sourceLock: gitBlob(args.repo, args.sourceRef, 'package-lock.json'),
      version: args.version,
    })
  } else verifyVersionTransition({
    sourcePackage: gitBlob(args.repo, args.sourceRef, 'package.json'),
    buildPackage: gitBlob(args.repo, args.buildRef, 'package.json'),
    sourceLock: gitBlob(args.repo, args.sourceRef, 'package-lock.json'),
    buildLock: gitBlob(args.repo, args.buildRef, 'package-lock.json'),
    version: args.version,
  })
  process.stdout.write(`VERSION TRANSITION: PASS -- ${args.sourceRef}..${args.buildRef} -> ${args.version} (${args.sourceRef === args.buildRef ? 'explicit unchanged source; committed package/lock parity verified' : 'package.json, package-lock.json only'})\n`)
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href

if (invokedDirectly) {
  try { main() } catch (error) {
    process.stderr.write(`VERSION TRANSITION: FAIL -- ${error.message}\n`)
    process.exitCode = 1
  }
}
