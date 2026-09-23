// Keep the large draft lazy while letting Vite transform its static JSON import.
// A dynamic JSON import with type: 'json' survives the dev transform, but Vite
// serves JavaScript for it, which browsers correctly reject as the wrong type.
import draft from './data/lean-bench-example-draft.json' with { type: 'json' }

export default draft
