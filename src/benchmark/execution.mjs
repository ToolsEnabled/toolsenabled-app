// Portable private-ownership and broker-event reconciliation. This module
// does not select trading predicates, race winners, gates or fill chronology.
// Callers declare intents and supply actual events; fills never come from an
// admission decision. All money and quantity arithmetic is exact.
import { canonical, invariant, object } from './prompts.mjs'

export const EXECUTION_VERSION = 1
export const TICKET_TERMINAL = ['filled', 'cancelled', 'rejected', 'expired']
const identifier = value => typeof value === 'string' && !!value.trim() && value.length <= 240
const integer = (value, positive = false) => Number.isSafeInteger(value) && value >= (positive ? 1 : 0)
const exact = value => { invariant(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), 'Execution arithmetic exceeds the nonnegative safe-integer range.'); return Number(value) }
const copy = value => JSON.parse(canonical(value))
const fields = (value, names, label) => invariant(object(value) && Object.keys(value).every(name => names.includes(name)), `${label} has unsupported fields.`)
const terminal = ticket => TICKET_TERMINAL.includes(ticket.status)

export function validateExecutionConfig(config) {
  fields(config, ['version', 'cashCents', 'currency', 'assets', 'owners', 'limits'], 'Execution configuration')
  invariant(config.version === EXECUTION_VERSION && integer(config.cashCents) && identifier(config.currency), 'Declare version 1, initial integer cash cents and its currency.')
  invariant(Array.isArray(config.assets) && config.assets.length > 0 && config.assets.length <= 4096, 'Declare a bounded asset registry.')
  invariant(new Set(config.assets.map(asset => asset.id)).size === config.assets.length, 'Asset identifiers must be unique.')
  for (const asset of config.assets) {
    fields(asset, ['id', 'multiplier', 'quantityStep'], 'Asset')
    invariant(identifier(asset.id) && integer(asset.multiplier, true) && integer(asset.quantityStep, true), 'Every asset needs its identifier, positive integer cash multiplier and quantity step.')
  }
  invariant(Array.isArray(config.owners) && config.owners.length > 0 && config.owners.length <= 4096 && config.owners.every(identifier) && new Set(config.owners).size === config.owners.length, 'Declare distinct private ownership namespaces.')
  fields(config.limits, ['intents', 'events'], 'Execution limits')
  invariant(integer(config.limits.intents, true) && config.limits.intents <= 100000 && integer(config.limits.events, true) && config.limits.events <= 1000000, 'Declare bounded intent and event budgets before execution.')
  canonical(config)
  return config
}

// Terminal cancellation acknowledges only the still-unfilled remainder.
// Filled inventory keeps its original lot and owner until an exit fills.
export function createExecutionLedger(config) {
  validateExecutionConfig(config)
  config = copy(config)
  const assets = new Map(config.assets.map(asset => [asset.id, asset])), owners = new Set(config.owners)
  const tickets = new Map(), lots = new Map(), journal = [], intentIds = new Set(), eventIds = new Map(), brokerIds = new Map()
  const pendingLots = new Map(), pendingOwners = new Map(), activeOwners = new Map(), sellReservations = new Map(), positions = new Map()
  let cash = config.cashCents, reservedCash = 0, eventCount = 0, lastTime = -1
  const availableCash = () => exact(BigInt(cash) - BigInt(reservedCash))
  const pendingFor = lotId => pendingLots.get(lotId)?.size || 0
  const lotReserved = lotId => sellReservations.get(lotId) || 0
  const addIndex = (map, key, id) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(id) }
  const removeIndex = (map, key, id) => { map.get(key)?.delete(id); if (!map.get(key)?.size) map.delete(key) }
  const nextSequence = () => journal.length + 1
  const eventBudget = () => invariant(eventCount < config.limits.events, 'The declared execution event budget is exhausted.')
  const assetCost = (asset, quantity, price) => BigInt(quantity) * BigInt(price) * BigInt(asset.multiplier)
  const knownTicket = id => { const ticket = tickets.get(id); invariant(ticket, `Unknown intent ${id}.`); return ticket }
  const checkTime = time => invariant(integer(time) && time >= lastTime, 'Execution events need nondecreasing integer timestamps.')
  const snapshot = () => {
    return copy({ version: EXECUTION_VERSION, config, cashCents: cash, reservedCashCents: reservedCash, availableCashCents: availableCash(),
      tickets: [...tickets.values()], lots: [...lots.values()].map(lot => ({ ...lot, reservedQuantity: lotReserved(lot.id), pending: pendingFor(lot.id) > 0,
        roundTripComplete: lot.boughtQuantity > 0 && lot.quantity === 0 && pendingFor(lot.id) === 0 })),
      positions: config.assets.map(asset => ({ asset: asset.id, quantity: positions.get(asset.id) || 0 })), journal,
      decisions: journal.filter(row => row.kind === 'intent').map(row => row.decision), events: journal.filter(row => row.kind !== 'intent').map(row => row.event) })
  }
  return {
    // Admission is a deterministic scheduler decision, not a broker receipt.
    // The explicit cap includes every fill and fee for this purchase; neither
    // future prices nor purchasing power are guessed by the ledger.
    admit(intent) {
      fields(intent, ['id', 'owner', 'lotId', 'asset', 'side', 'quantity', 'cashCapCents', 'reason', 'time'], 'Order intent')
      invariant(identifier(intent.id) && !intentIds.has(intent.id), 'Intent identifiers cannot be reused, including rejected proposals.')
      invariant(intentIds.size < config.limits.intents, 'The declared execution intent budget is exhausted.')
      invariant(owners.has(intent.owner) && identifier(intent.lotId) && identifier(intent.reason), 'An intent needs a declared owner, private lot and reason.')
      const asset = assets.get(intent.asset)
      invariant(asset && ['buy', 'sell'].includes(intent.side) && integer(intent.quantity, true) && intent.quantity % asset.quantityStep === 0, 'An intent needs a known asset, side and quantity aligned to its step.')
      invariant(integer(intent.cashCapCents) && (intent.side === 'buy' ? intent.cashCapCents > 0 : intent.cashCapCents === 0), 'A buy declares its complete cash cap; a sell declares zero cash reservation.')
      checkTime(intent.time); intent = copy(intent)
      const lot = lots.get(intent.lotId)
      if (intent.side === 'buy') invariant(!lot, 'A purchase opens a new immutable private lot; lot identifiers cannot be reused.')
      else invariant(lot && lot.owner === intent.owner && lot.asset === intent.asset, 'A sale can address only the same owner’s private lot and asset.')
      const reason = intent.side === 'buy' && intent.cashCapCents > availableCash() ? 'insufficient-unreserved-cash'
        : intent.side === 'sell' && intent.quantity > lot.quantity - lotReserved(lot.id) ? 'insufficient-unreserved-private-quantity' : null
      const decision = { sequence: nextSequence(), intent, admitted: reason === null, reason }
      journal.push({ kind: 'intent', decision }); intentIds.add(intent.id); lastTime = intent.time
      if (reason) return copy(decision)
      tickets.set(intent.id, { ...intent, status: 'admitted', brokerOrderId: null, filledQuantity: 0, cashReservedCents: intent.cashCapCents,
        grossCents: 0, feesCents: 0, cancellationRequested: false, lastEventTime: null })
      if (intent.side === 'buy') lots.set(intent.lotId, { id: intent.lotId, owner: intent.owner, asset: intent.asset, entryIntentId: intent.id,
        quantity: 0, boughtQuantity: 0, soldQuantity: 0, firstFillTime: null, lastFillTime: null })
      reservedCash += intent.cashCapCents
      if (intent.side === 'sell') sellReservations.set(intent.lotId, lotReserved(intent.lotId) + intent.quantity)
      addIndex(pendingLots, intent.lotId, intent.id); addIndex(pendingOwners, intent.owner, intent.id)
      return copy(decision)
    },
    requestCancel(id, time) {
      const ticket = knownTicket(id); checkTime(time)
      invariant(!terminal(ticket), 'A terminal ticket cannot request cancellation.')
      if (ticket.cancellationRequested) return false
      eventBudget()
      ticket.cancellationRequested = true; lastTime = time
      journal.push({ kind: 'cancel-request', event: { sequence: nextSequence(), kind: 'cancel-request', intentId: id, time } }); eventCount++
      return true
    },
    reconcile(event) {
      // Validate on copies and commit only after every ownership/arithmetic
      // check succeeds. The caller retains a rejected event as raw evidence.
      fields(event, ['id', 'intentId', 'brokerOrderId', 'kind', 'time', 'quantity', 'priceCents', 'feeCents'], 'Broker event')
      invariant(identifier(event.id) && identifier(event.brokerOrderId), 'Broker events need distinct event IDs and an order identifier.')
      const bytes = canonical(event), seen = eventIds.get(event.id)
      if (seen !== undefined) { invariant(seen === bytes, 'A duplicate broker event changed its contents.'); return { applied: false, duplicate: true } }
      eventBudget()
      checkTime(event.time)
      invariant(['accepted', 'fill', 'cancelled', 'rejected', 'expired'].includes(event.kind), 'Unknown broker event kind.')
      const prior = knownTicket(event.intentId), ticket = copy(prior), asset = assets.get(ticket.asset), lot = copy(lots.get(ticket.lotId))
      invariant(event.time >= ticket.time, 'A broker event cannot precede its intent.')
      invariant(!brokerIds.has(event.brokerOrderId) || brokerIds.get(event.brokerOrderId) === event.intentId, 'A broker order cannot move between private intents.')
      invariant(ticket.brokerOrderId === null || ticket.brokerOrderId === event.brokerOrderId, 'A private intent cannot change its broker order.')
      invariant(!terminal(ticket) || event.kind === 'accepted' && ticket.brokerOrderId === event.brokerOrderId, 'A terminal ticket cannot receive new fills or terminal transitions.')
      ticket.brokerOrderId = event.brokerOrderId; ticket.lastEventTime = event.time
      let nextCash = cash
      if (event.kind === 'fill') {
        invariant(integer(event.quantity, true) && event.quantity % asset.quantityStep === 0 && integer(event.priceCents, true) && integer(event.feeCents), 'Fills need positive step-aligned quantities/prices and an explicit nonnegative fee.')
        invariant(ticket.filledQuantity + event.quantity <= ticket.quantity, 'A broker fill exceeds its admitted quantity.')
        const gross = assetCost(asset, event.quantity, event.priceCents), fee = BigInt(event.feeCents)
        ticket.grossCents = exact(BigInt(ticket.grossCents) + gross); ticket.feesCents = exact(BigInt(ticket.feesCents) + fee)
        if (ticket.side === 'buy') {
          const spent = exact(gross + fee)
          invariant(spent <= ticket.cashReservedCents, 'A buy fill exceeds its explicit reserved cash cap.')
          ticket.cashReservedCents -= spent; nextCash = exact(BigInt(cash) - BigInt(spent))
          lot.quantity = exact(BigInt(lot.quantity) + BigInt(event.quantity)); lot.boughtQuantity = exact(BigInt(lot.boughtQuantity) + BigInt(event.quantity))
          lot.firstFillTime ??= event.time
        } else {
          invariant(event.quantity <= lot.quantity, 'A fill cannot sell another owner’s inventory.')
          nextCash = exact(BigInt(cash) + gross - fee)
          invariant(nextCash >= reservedCash, 'Exit fees cannot consume other tickets’ reserved cash.')
          lot.quantity -= event.quantity; lot.soldQuantity = exact(BigInt(lot.soldQuantity) + BigInt(event.quantity))
        }
        lot.lastFillTime = event.time; ticket.filledQuantity += event.quantity
        ticket.status = ticket.filledQuantity === ticket.quantity ? 'filled' : 'partially-filled'
        if (terminal(ticket)) ticket.cashReservedCents = 0
      } else {
        invariant(event.quantity === undefined && event.priceCents === undefined && event.feeCents === undefined, 'Non-fill events cannot silently carry fill values.')
        if (event.kind === 'accepted') { if (ticket.status === 'admitted') ticket.status = 'accepted' }
        else { ticket.status = event.kind; ticket.cashReservedCents = 0 }
      }
      const nextReserved = reservedCash - prior.cashReservedCents + ticket.cashReservedCents
      const priorSellReserved = ticket.side === 'sell' && !terminal(prior) ? prior.quantity - prior.filledQuantity : 0
      const nextSellReserved = ticket.side === 'sell' && !terminal(ticket) ? ticket.quantity - ticket.filledQuantity : 0
      const lotReservation = lotReserved(lot.id) - priorSellReserved + nextSellReserved
      const position = exact(BigInt(positions.get(lot.asset) || 0) + BigInt(lot.quantity) - BigInt(lots.get(lot.id).quantity))
      invariant(nextReserved >= 0 && nextCash >= nextReserved && lotReservation >= 0 && lot.quantity >= lotReservation, 'The event violates reconciled cash or private-quantity reservations.')
      cash = nextCash; reservedCash = nextReserved; sellReservations.set(lot.id, lotReservation)
      positions.set(lot.asset, position)
      tickets.set(ticket.id, ticket); lots.set(lot.id, lot)
      if (terminal(ticket)) { removeIndex(pendingLots, lot.id, ticket.id); removeIndex(pendingOwners, ticket.owner, ticket.id) }
      if (lot.quantity > 0) addIndex(activeOwners, lot.owner, lot.id); else removeIndex(activeOwners, lot.owner, lot.id)
      brokerIds.set(event.brokerOrderId, event.intentId); eventIds.set(event.id, bytes); lastTime = event.time
      journal.push({ kind: 'broker-event', event: { ...copy(event), sequence: nextSequence() } }); eventCount++
      return { applied: true, duplicate: false }
    },
    status(ownerPaths) {
      invariant(Array.isArray(ownerPaths) && ownerPaths.every(owner => owners.has(owner)), 'Subtree status uses declared ownership namespaces.')
      const active = ownerPaths.some(owner => activeOwners.has(owner)), pending = ownerPaths.some(owner => pendingOwners.has(owner))
      return { active, pending, resettable: !active && !pending }
    },
    resources: () => ({ cashCents: cash, reservedCashCents: reservedCash, availableCashCents: availableCash() }),
    ticket: id => tickets.has(id) ? copy(tickets.get(id)) : null,
    lot: id => lots.has(id) ? copy({ ...lots.get(id), reservedQuantity: lotReserved(id), pending: pendingFor(id) > 0,
      roundTripComplete: lots.get(id).boughtQuantity > 0 && lots.get(id).quantity === 0 && pendingFor(id) === 0 }) : null,
    snapshot,
  }
}

export function replayExecutionLedger(config, journal) {
  invariant(Array.isArray(journal), 'An execution journal must be an ordered array.')
  const ledger = createExecutionLedger(config)
  for (const [index, row] of journal.entries()) {
    invariant(row?.kind === 'intent' || row?.kind === 'broker-event' || row?.kind === 'cancel-request', 'Unknown execution journal entry.')
    if (row.kind === 'intent') {
      invariant(row.decision?.sequence === index + 1, 'Execution journal sequence changed.')
      invariant(canonical(ledger.admit(row.decision.intent)) === canonical(row.decision), 'A retained admission decision disagrees with reconciled resources.')
    } else {
      const { sequence, ...event } = row.event || {}
      invariant(sequence === index + 1, 'Execution journal sequence changed.')
      if (row.kind === 'broker-event') invariant(ledger.reconcile(event).applied, 'The execution journal contains a duplicate event.')
      else { invariant(event.kind === 'cancel-request', 'Invalid cancellation request.'); invariant(ledger.requestCancel(event.intentId, event.time), 'The execution journal contains a duplicate cancellation request.') }
    }
  }
  invariant(canonical(ledger.snapshot().journal) === canonical(journal), 'The execution journal changed its canonical event content.')
  return ledger
}
