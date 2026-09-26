/* Gate half B: the remaining 54 registrations from the unchanged T542 suite. */
process.env.T542_PART = 'b'
await import('./t542-pending-model-choice.test.mjs')
