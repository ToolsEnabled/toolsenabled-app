#!/usr/bin/env node
/* HAS ANYBODY ACTUALLY LOOKED AT THIS PRODUCT LATELY?
 *
 * Owner directive, 2026-08-17: "can we have a more intense and thorough walker
 * every 2-3 cuts".
 *
 * The reason this is a file and not a habit: fourteen release candidates were
 * cut between 1.0.7 and 1.0.21, and the thing that found the real defects each
 * time was a person opening the build and using it. Every automated gate stayed
 * green throughout -- including through a period when three of them were
 * reporting a working product as broken and the installer's worst known defect
 * had never once been executed. A cadence that lives in someone's memory is the
 * first thing dropped on the week of a launch, which is exactly the week it
 * matters.
 *
 * So the record is a file, the arithmetic is mechanical, and the answer is a
 * sentence rather than a number.
 *
 *   node tools/check-deep-walk-due.mjs            says whether a walk is due
 *   node tools/check-deep-walk-due.mjs --record   records that one just ran
 *   node tools/check-deep-walk-due.mjs --strict   exit 1 when overdue (for a gate)
 *
 * DEFAULT IS ADVISORY. A walk being due must never block a cut on its own --
 * that is how a useful check gets deleted in a hurry. `--strict` exists for
 * whoever decides it should be blocking.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RECORD = path.join(REPO_ROOT, 'state', 'deep-walk.json')

/* Two to three cuts was the ask. Three is the outer edge of it, so three cuts
   without a walk is the first moment the directive is not being met. */
export const CUTS_BETWEEN_WALKS = 3

export function versionOf(root = REPO_ROOT) {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
}

/* 1.0.18 -> 1018, so "how many cuts ago" is subtraction rather than string
   comparison. Anything unparseable returns null and the caller says it cannot
   tell, which is not the same as saying a walk is not needed. */
export function cutNumber(version) {
  const parts = String(version || '').split('.').map(Number)
  if (parts.length < 3 || parts.some(n => !Number.isFinite(n))) return null
  return parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2]
}

export function walkStatus(current, record) {
  const now = cutNumber(current)
  const then = record && cutNumber(record.version)
  if (now === null) return { due: true, reason: `this tree's version (${current}) cannot be read, so nobody can say when it was last walked` }
  if (!record || then === null) {
    return { due: true, cutsSince: null, reason: `no deep walk has ever been recorded, so one is due before ${current} ships` }
  }
  const cutsSince = now - then
  if (cutsSince < 0) return { due: true, cutsSince, reason: `the last walk was recorded against ${record.version}, which is NEWER than this tree (${current}) -- the record is from another branch and cannot be trusted` }
  return {
    due: cutsSince >= CUTS_BETWEEN_WALKS,
    cutsSince,
    reason: cutsSince >= CUTS_BETWEEN_WALKS
      ? `${cutsSince} cut(s) have gone by since ${record.version} was walked on ${record.at} -- the agreed cadence is every ${CUTS_BETWEEN_WALKS}`
      : `${record.version} was walked on ${record.at}; ${CUTS_BETWEEN_WALKS - cutsSince} more cut(s) before the next one is due`,
  }
}

function readRecord() {
  if (!existsSync(RECORD)) return null
  try { return JSON.parse(readFileSync(RECORD, 'utf8')) } catch { return null }
}

const isMain = process.argv[1]
  ? realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))
  : false

if (isMain) {
  const version = versionOf()
  if (process.argv.includes('--record')) {
    mkdirSync(path.dirname(RECORD), { recursive: true })
    const at = new Date().toISOString().slice(0, 10)
    writeFileSync(RECORD, JSON.stringify({ version, at, note: 'written by tools/check-deep-walk-due.mjs --record after tools/walk-and-look.mjs' }, null, 1))
    console.log(`recorded: ${version} walked on ${at}`)
  } else {
    const status = walkStatus(version, readRecord())
    console.log(status.due
      ? `A DEEP WALK IS DUE. ${status.reason}\n  Run: node tools/walk-and-look.mjs --release <win-unpacked> --out <dir>\n  Then read FINDINGS.txt and the screens, and record it with --record.`
      : `No deep walk needed yet. ${status.reason}`)
    if (status.due && process.argv.includes('--strict')) process.exitCode = 1
  }
}
