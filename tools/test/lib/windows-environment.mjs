// Reading an environment variable out of a PLAIN OBJECT on Windows.
//
// WHY THIS FILE EXISTS: three assertions were red on every run, on every
// machine, regardless of the product's behaviour -- so the regression they were
// written to catch could never have been detected by them.
//
//   tools/test/session-launch-environment.test.mjs  "unrelated inherited
//     variables still pass through at <level>"  (x2, one per level)
//   tools/test/session-tier-binding.test.mjs  "the recorded level reaches the
//     engine as thread options, not as a comment"
//
// All three asserted `call.env.PATH === process.env.PATH`, meaning to catch a
// scrub that strips PATH and breaks the executable resolution that finds codex
// on Windows.
//
// THE MEASUREMENT, taken on this host with node v22:
//
//   Object.keys(process.env).filter(k => k.toLowerCase() === 'path')
//     -> ['path']            under PowerShell / cmd (the real environment)
//     -> ['PATH']            under Git Bash, which normalises it on the way in
//   ({ ...process.env }).PATH === process.env.PATH   -> false
//
// `process.env` is a HOST PROXY whose property lookup is case-insensitive on
// Windows, so `process.env.PATH` returns the string even though the underlying
// key is lowercase `path`. The moment the environment is spread into a plain
// object -- `{ ...baseEnvironment }`, which is exactly what the scrub returns
// and exactly what Node hands the child -- the keys become case-SENSITIVE
// ordinary properties. `copy.PATH` is then `undefined` while
// `process.env.PATH` is a string, so the comparison is false unconditionally.
//
// The product was never at fault: the child really does receive the variable
// (under the key `path`), and Windows resolves the executable from it because
// the real environment block is case-insensitive. Only the test's LOOKUP was
// wrong. A guard that is red no matter what the product does cannot report a
// regression -- its redness carries no information.
//
// So: look the name up the way Windows itself does.

/**
 * Case-insensitive environment lookup, matching Windows' own semantics.
 *
 * Use this for any assertion that reads a variable out of an env object the
 * test captured (a spread copy, a `spawn` options bag) rather than out of the
 * live `process.env` proxy. Reading such an object with `.PATH` is what made
 * three guards permanently red.
 *
 * @param {Record<string, string|undefined>|null|undefined} environment
 * @param {string} name
 * @returns {string|undefined} the value, or undefined if no key matches
 */
export function readEnvironmentVariable(environment, name) {
  if (environment === null || environment === undefined) return undefined
  const wanted = name.toLowerCase()
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === wanted) return environment[key]
  }
  return undefined
}

/**
 * How many keys in `environment` denote `name` under Windows' case-insensitive
 * rules. Exposed so a test can distinguish "absent" (0) from "present" (1) from
 * "the scrub produced a duplicate under a different case" (>1) -- the last is
 * its own bug, because which one the child actually sees is then unspecified.
 *
 * @param {Record<string, string|undefined>|null|undefined} environment
 * @param {string} name
 * @returns {number}
 */
export function countEnvironmentKeys(environment, name) {
  if (environment === null || environment === undefined) return 0
  const wanted = name.toLowerCase()
  return Object.keys(environment).filter((key) => key.toLowerCase() === wanted).length
}
