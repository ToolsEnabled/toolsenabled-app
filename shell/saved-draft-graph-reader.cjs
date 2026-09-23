'use strict'

// MAIN passes the canonical src/fleet-trees.js exports after loading them.
// Do not replace this with a subset parser: a valid-looking draft inside a
// malformed forest is not a node the application can actually restore.
function createSavedDraftGraphReader({ readRecord, parseFleetTrees, fleetTreesStorageKey } = {}) {
  if ([readRecord, parseFleetTrees, fleetTreesStorageKey].some(fn => typeof fn !== 'function')) {
    throw new TypeError('Saved draft graph reader requires canonical fleet parser and storage key')
  }
  function readSavedDraftGraph(computerId) {
    const fail = () => { throw Object.assign(new Error('The saved tree cannot be verified. Reopen the saved computer before attaching images.'),
      { code: 'IMAGE_DRAFT_GRAPH_UNAVAILABLE' }) }
    if (typeof computerId !== 'string' || !computerId) fail()
    let parsed
    try {
      const raw = readRecord(fleetTreesStorageKey(computerId))
      // The reader is synchronous authority after loading; promises cannot
      // stand in for a current saved snapshot.
      if (raw && typeof raw.then === 'function') fail()
      parsed = parseFleetTrees(raw, { computerId })
    } catch { fail() }
    if (!parsed || parsed.computerId !== computerId || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.trees)) fail()
    return parsed
  }
  // Native write admission uses exactly the same complete forest parser.
  readSavedDraftGraph.parseRecord = parseFleetTrees
  return Object.freeze(readSavedDraftGraph)
}

// Optional bootstrap for an environment packaging the canonical source module.
// Await once before installing the synchronous MAIN callback. Failure propagates;
// no raw JSON fallback or writable empty-forest substitution is authorized.
async function loadSavedDraftGraphReader({ readRecord, packaged = false } = {}) {
  const canonical = packaged ? require('../dist/main/fleet-trees.cjs') : await import('../src/fleet-trees.js')
  return createSavedDraftGraphReader({ readRecord, parseFleetTrees: canonical.parseFleetTrees,
    fleetTreesStorageKey: canonical.fleetTreesStorageKey })
}
module.exports = { createSavedDraftGraphReader, loadSavedDraftGraphReader }
