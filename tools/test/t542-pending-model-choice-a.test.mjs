/* Gate half A: the first 55 registrations from the unchanged T542 suite. */
process.env.T542_PART = 'a'
await import('./t542-pending-model-choice.test.mjs')
