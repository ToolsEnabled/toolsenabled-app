/* THE EXAMPLE'S OWN TREES, IN A STORE THAT WRITES NOTHING DOWN.
 *
 * WHAT WENT WRONG WITHOUT THIS. The one-render cutover fed the example into
 * `mountProjection` -- the fleet-record surface -- and released the tree store
 * while it did so. That is the wrong surface: the projection face is what a
 * machine with no fleet host falls back to, and the tree face is the product a
 * person actually works in. With no store, `treeStore.listTrees()` is empty so
 * the tree chip row deletes itself, no node is a tree node so every path to
 * `showTreeNodeControls` is unreachable, and `treeChatConfigFor` never runs --
 * which is where the actions palette and the attachment and mention pickers
 * live. The owner's words for the result: "where are my agent actions and such
 * and the file upload?" They were never removed. They were unreachable, because
 * the example had been pointed at the wrong half of the page.
 *
 * SO THE EXAMPLE GETS TREES, NOT A DIFFERENT RAIL. Seeded here, the example's
 * agents ARE tree nodes, and every surface his own tree code builds runs
 * unmodified over them. Nothing about the rail is reimplemented; there is
 * nothing left to reimplement.
 *
 * SEEDED THROUGH THE STORE'S OWN API, never by handing it a record. createTree
 * and addNode validate ids, stamps, names, roles and messages and mint what
 * they need; a hand-authored snapshot would be my guess at that shape, and the
 * first time the shape changed the example would carry a record the real store
 * would refuse. Going through the API means the example is built by exactly the
 * code that builds a person's own trees.
 *
 * THE BACKING IS MEMORY, AND THAT IS THE WHOLE OF THE PERSISTENCE STORY. The
 * store demands a seam with getItem/setItem (safeTreeStorage wraps it); this
 * one is a Map that dies with the page. So the example can be dragged, renamed
 * and rearranged like the real thing -- the store is real -- and none of it
 * survives a reload, touches localStorage, or reaches the durable settings file
 * on a desktop where the example toggle is on. An example that wrote itself
 * into a person's own saved trees would be the worst version of this defect.
 */
import { createFleetTreeStore, safeTreeStorage } from './fleet-trees.js'
import { seedSampleSimTree } from './sample-simulation.js'

/* Which stores hold the working tree, and the ids it was seeded with. A
   WeakMap rather than a field on the store, because the store is frozen and
   is the real store: it gains nothing an ordinary tree store would not have. */
const SIMULATED = new WeakMap()

/** The working tree's seed (tree id and node ids by script key), or null. */
export function sampleSimulationSeed(store) {
  return (store && SIMULATED.get(store)) || null
}

/* The computer these trees belong to. Matches sample-fleet.js's first computer
 * so the tree page and the fleet card describe one world. */
export const SAMPLE_TREE_COMPUTER_ID = 'sample-computer-1'

/* WHAT THE EXAMPLE WAS ASKED, in the voice of things a person actually types.
 * A tree's displayed name comes from the first message typed into it when no
 * name was set (see treeLabel/displayName in fleet-trees.js), so these read as
 * the chip row he knows: short, lowercase, a real request.
 *
 * Roles are the declared vocabulary the tree panel offers; statuses are drawn
 * from NODE_STATUSES so the circles show the states his own page shows --
 * something finished, something running, something that failed, and a draft
 * that was never started. A demonstration where everything succeeded would be
 * the least useful one to look at. */
const SAMPLE_TREES = Object.freeze([
  {
    name: 'say hey',
    nodes: [
      { key: 'a', role: 'coordinator', message: 'say hey to the other lanes and report who answers', status: 'finished',
        reply: 'both lanes answered; evidence is in the status probe' },
      { key: 'b', parent: 'a', role: 'manager', message: 'collect the acknowledgements and post one summary', status: 'finished',
        reply: 'three acks, one lane silent -- named in the summary' },
    ],
  },
  {
    name: 'what tools do you have access to',
    nodes: [
      { key: 'a', role: 'default', message: 'what tools do you have access to on the computer you are driving', status: 'running' },
      { key: 'b', parent: 'a', role: 'default', message: 'list only the ones that can write, and say what each may touch', status: 'draft' },
    ],
  },
  {
    name: 'can you open chrome',
    nodes: [
      { key: 'a', role: 'default', message: 'can you open chrome and take a screenshot of the dashboard', status: 'failed',
        note: 'launching applications is blocked by the current environment policy' },
    ],
  },
])

/** An in-memory seam. The store only ever calls getItem/setItem on it. */
function memoryBacking() {
  const cells = new Map()
  return {
    getItem: (key) => (cells.has(key) ? cells.get(key) : null),
    setItem: (key, value) => { cells.set(key, String(value)) },
  }
}

/**
 * A live fleet-tree store holding the example's trees, backed by memory.
 * Same object shape the real store returns, because it IS the real store --
 * the caller cannot tell, and nothing in the view needs to.
 *
 * @param {(current:object)=>void} onChange forwarded to the store, so the page
 *        repaints on an example edit exactly as it does on a real one.
 * @param {boolean} simulation seed the working tree that
 *        src/sample-simulation.js plays (the tree page asks for it) first, so
 *        it is the first tree a person sees, with the refused-start example
 *        beside it.
 */
export function createSampleTreeStore({ onChange = () => {}, simulation = false } = {}) {
  const store = createFleetTreeStore({
    computerId: SAMPLE_TREE_COMPUTER_ID,
    storage: safeTreeStorage(memoryBacking()),
    onChange,
  })

  if (simulation) {
    const seeded = seedSampleSimTree(store)
    if (seeded) SIMULATED.set(store, seeded)
  }

  /* BESIDE THE WORKING TREE, ONLY THE START THAT WAS REFUSED. The working tree
     already shows finished, running and stopped agents; the refused start is
     the one state it does not, and the other two frozen trees only repeated
     states the working tree now plays -- while their Manager and Default
     circles took the same names as its own, which the page then had to tell
     apart with id suffixes. */
  const trees = simulation ? SAMPLE_TREES.filter(tree => tree.name === 'can you open chrome') : SAMPLE_TREES
  for (const tree of trees) {
    /* createTree takes the name; the nodes carry the messages. A refusal here
       would be a defect in this file's own data rather than anything a person
       did, so it is left to surface loudly in a test rather than swallowed. */
    const made = store.createTree({ name: tree.name })
    const treeId = made?.tree?.id ?? made?.id ?? null
    if (!treeId) continue
    const minted = new Map()
    for (const node of tree.nodes) {
      const parentId = node.parent ? minted.get(node.parent) ?? null : null
      const added = store.addNode({
        treeId,
        parentId,
        role: node.role,
        message: node.message,
      })
      const nodeId = added?.node?.id ?? added?.id ?? null
      if (!nodeId) continue
      minted.set(node.key, nodeId)
      /* RUNNING MEANS A SESSION IS ATTACHED, and the store enforces it:
         "Attach the session before marking this agent as running." Measured --
         the first seed asked for running without one and silently got a draft
         back, so the example would have shown no running agent at all. The
         example's session ids are its own and reach nothing; attaching one is
         what makes the state legible, and the rail's own refusal copy still
         governs what a person can do with it. */
      if (node.status === 'running') store.attachSession(nodeId, `sample-session-${nodeId.slice(-8)}`)
      /* A draft is the status a fresh node already has, so setting it again
         would be a write with nothing behind it. */
      if (node.status && node.status !== 'draft') {
        store.setNodeStatus(nodeId, node.status, { note: node.note || '' })
      }
      if (node.reply) store.setNodeReply(nodeId, node.reply)
    }
  }

  return store
}
