// The simulated request/question register. The records stay fixed; only their
// displayed ages advance from the moment this module is loaded.
//
// WHAT is in the register is site data, so it comes from the fleet profile
// (src/fleet-profile.js). The thirty entries that used to be literals here
// were one fleet's actual open work — its host cutover, its port checks, its
// month-end retirement of a mirror — and the ship gate cannot see any of that,
// because none of it is a name or a path. It is the work itself that
// identifies. The shipped profile's register is instead about connecting THIS
// install, which is both generic and the thing a first run actually needs.

import { FLEET } from './fleet-profile.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const LEDGER_STARTED_AT = Date.now()

/* Profiles carry ages in hours because a profile is a document, not a module,
   and cannot do arithmetic — but a profile written out from a running build
   carries the milliseconds it already had, so both are accepted. A record with
   no usable age gets one minute rather than zero: an item stamped "0m" reads
   as having just been filed, which is a claim a seeded record cannot support. */
const withAge = (item) => {
  const fromHours = Number(item.ageHours) * HOUR
  const ms = Number.isFinite(fromHours) ? fromHours : Number(item.ageMs)
  return { ...item, ageMs: Math.max(MINUTE, Number.isFinite(ms) ? ms : 0) }
}

export const R_ITEMS = FLEET.ledger.requests.map(withAge)
export const Q_ITEMS = FLEET.ledger.questions.map(withAge)

export function liveAgeMs(item, now = Date.now()) {
  return item.ageMs + Math.max(0, now - LEDGER_STARTED_AT)
}

export function formatLedgerAge(ms) {
  const minutes = Math.max(1, Math.floor(ms / MINUTE))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}
