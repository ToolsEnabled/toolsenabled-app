/**
 * Resolve the private engine checkout used by integration fixtures and doctor.
 *
 * This is configuration, never filesystem archaeology. Older versions probed
 * sibling, reorganisation-bucket, and Desktop paths named
 * `toolsenabled-current`. That made a passing integration run depend on which
 * old checkout happened to exist first, and it taught agents to walk outside
 * the working pair looking for a repository. A marker probe does not make that
 * safe: it proves only that a directory resembles an engine, not that it is the
 * engine the owner selected for this build.
 *
 * The supported declarations are, in order:
 *   1. MC_CANONICAL_ROOT (legacy explicit integration-fixture override),
 *   2. TOOLSENABLED_SOURCE (the release automation override),
 *   3. private/capability-source.owner.json (the ignored owner setting).
 *
 * An explicit declaration still wins when stale so doctor can report the
 * exact bad declaration. With no declaration, found:false is returned and no
 * candidate path outside this repository is touched.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readCapabilitySourceSetting } from './lib/capability-source-git.mjs'

const here = fileURLToPath(import.meta.url)
export const PROJECT_ROOT = dirname(dirname(here))

/** The file that makes an explicitly selected directory usable as an engine
 * fixture source. */
export const ENGINE_MARKER = join('src', 'lib', 'agent-org.js')

/** Ordered explicit declarations. `setting` is injectable so the contract can
 * be tested without reading a developer's ignored file. */
export function candidateRoots({ env = process.env, setting } = {}) {
  const canonical = typeof env.MC_CANONICAL_ROOT === 'string' ? env.MC_CANONICAL_ROOT.trim() : ''
  if (canonical) return [{ source: 'env:MC_CANONICAL_ROOT', root: resolve(canonical) }]

  const releaseSource = typeof env.TOOLSENABLED_SOURCE === 'string' ? env.TOOLSENABLED_SOURCE.trim() : ''
  if (releaseSource) return [{ source: 'env:TOOLSENABLED_SOURCE', root: resolve(releaseSource) }]

  const configured = setting === undefined ? readCapabilitySourceSetting(PROJECT_ROOT) : setting
  if (configured && typeof configured.path === 'string' && configured.path.trim()) {
    return [{ source: 'private/capability-source.owner.json', root: resolve(configured.path.trim()) }]
  }
  return []
}

/** Return the selected root and whether it holds the required marker. The
 * marker is checked only inside the one explicitly selected directory. */
export function discoverCanonicalRoot({ env = process.env, probe = existsSync, setting } = {}) {
  const candidates = candidateRoots({ env, setting })
  if (candidates.length === 0) {
    return { root: PROJECT_ROOT, source: 'unconfigured', found: false }
  }
  const chosen = candidates[0]
  return {
    root: chosen.root,
    source: chosen.source,
    found: probe(join(chosen.root, ENGINE_MARKER)),
  }
}

/** Where a suite's own `MC_CANONICAL_ROOT || join(root, 'capability')` fallback
 * lands. canonicalRootForTests() must agree with it or the two conventions
 * disagree about the unconfigured case and only some suites break. */
export const STAGED_ENGINE_ROOT = join(PROJECT_ROOT, 'capability')

let warnedEngineRootOnce = false

/** Test seam: the once-per-process latch is process state, so a suite that wants
 * to exercise the warning twice has to be able to clear it. */
export function resetEngineRootWarning() { warnedEngineRootOnce = false }

/** WARN, DO NOT REFUSE, when the declared engine root is outside this checkout.
 *
 * An earlier version threw here. That was wrong, and the counter-example is
 * capability-index-pack-gate: it needs the engine's BUILD tooling
 * (tools/build-capability-index.js), which the packed capability/ layer
 * deliberately does not ship, so refusing anything but the staged layer made
 * that suite permanently unrunnable. Reachability of a caller is not sufficiency
 * of what the caller receives.
 *
 * Containment also cannot prove what the refusal implied: package name and
 * version are byte-identical across checkouts (both read toolsenabled 1.4.0) and
 * both carry ENGINE_MARKER, so this cannot tell a stale foreign engine from a
 * legitimate one. It reports the fact and lets the caller proceed. */
export function noteEngineRootOutsideCheckout(root, source, { warn = console.error } = {}) {
  if (resolve(root) === resolve(STAGED_ENGINE_ROOT)) return root
  if (warnedEngineRootOnce) return root
  warnedEngineRootOnce = true
  warn(`canonical-root: engine root ${resolve(root)} declared by ${source} is outside app checkout ${PROJECT_ROOT}. Suites loading engine RUNTIME modules may be reading another project's engine; the staged layer for this checkout is ${STAGED_ENGINE_ROOT}. Suites needing the engine's build tooling legitimately point outside.`)
  return root
}

/** What integration suites call. They retain a concrete path for their loud
 * missing-fixture diagnostics, while discoverCanonicalRoot().found remains the
 * authoritative readiness bit for doctor. */
export function canonicalRootForTests(options = {}) {
  const env = options.env || process.env
  const strict = env.TOOLSENABLED_TEST_STRICT === '1'
  if (strict && !(typeof env.MC_CANONICAL_ROOT === 'string' && env.MC_CANONICAL_ROOT.trim())) {
    throw new Error('source qualification requires its measured MC_CANONICAL_ROOT; staged or ambient Engine fallback is refused')
  }
  const chosen = discoverCanonicalRoot(options)
  if ((strict || options.requireConfigured) && chosen.source === 'unconfigured') throw new Error('this integration test requires a configured Engine source')
  if ((strict || options.requireConfigured) && !chosen.found) throw new Error(`selected Engine is missing ${ENGINE_MARKER}: ${chosen.root}`)
  const root = chosen.source === 'unconfigured' ? STAGED_ENGINE_ROOT : chosen.root
  return noteEngineRootOutsideCheckout(root, chosen.source, options)
}
