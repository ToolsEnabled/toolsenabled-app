// LOADING THE EXAMPLE LIBRARY WHEN SOMETHING WANTS IT, NOT WHEN THE APP STARTS.
//
// src/research-examples.mjs is about 400 KB of the owner's donor material --
// prompts, variants, extracted programs and instruments. It is content for one
// tab of one page. It used to be reached by a static import in
// research-benchmark.js, and the chain main.js -> views/research.js ->
// research-benchmark.js is static all the way down, so every one of those bytes
// was fetched and parsed at app startup whether or not anybody opened Research.
//
// This module is the seam. It holds no bundle data of its own, so importing it
// costs nothing, and it resolves the library exactly once however many callers
// ask for it.
let library = null
let arriving = null

// The library, loaded on first use. Concurrent callers share one import rather
// than racing two of them.
export function loadExampleSnippets() {
  if (library) return Promise.resolve(library)
  arriving ||= import('./research-examples.mjs').then(module => { library = module; arriving = null; return module })
  return arriving
}

// True once the library is in memory. Exported so a caller that must answer
// synchronously can tell "no examples" from "cannot tell yet" instead of
// merging the two.
export const exampleSnippetsLoaded = () => library !== null

// The same exact check research-examples.mjs exports -- a bundle it shipped
// that nobody has edited since -- callable from a synchronous render.
//
// Before the library has loaded this answers false. That is not a weakened
// check: it is the honest answer to "is this one of the shipped examples" when
// the shipped examples are not in memory. Projects start without loading them. Callers
// that need to distinguish "not an example" from "could not tell" have
// exampleSnippetsLoaded() for exactly that.
export const isExampleSnippet = bundle => library ? library.isExampleSnippet(bundle) : false

// Full experiment examples retain their tasks, attachments and editor state.
// Each load gets an independent draft; edits never mutate the bundled data.
export const exampleExperimentDrafts = Object.freeze([
  Object.freeze({
    id: 'lean-bench-snippets-and-compositions',
    label: 'Lean Bench: ETF and options snippets and compositions',
    load: async () => structuredClone((await import('./research-lean-example.mjs')).default),
  }),
])
