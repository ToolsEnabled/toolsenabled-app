/* WHAT THE TERMINAL IS CALLED, DECIDED IN ONE PLACE.
 *
 * Two sentences have to agree about this or a relay reader silently loses their
 * translation. src/account-panel-copy.js writes the desk sentence "paste this
 * line into <terminal>:" and src/refusal-copy.js keys that sentence's remote
 * twin on the same words; readerRemedy() looks the twin up by exact string, so
 * a noun that moves in one file and not the other unhooks the twin and hands a
 * browser reader the desk instruction untranslated. That is the defect
 * tools/test/reader-remedy-coverage.test.mjs exists to catch, and the cheapest
 * way not to reintroduce it is to give both files the same function.
 *
 * MEASURED, which is why this exists at all: on this Linux machine Settings,
 * This computer, told the reader to paste a line into Windows Terminal, and the
 * home screen told them to run "winget install OpenAI.Codex" there. Neither
 * exists on Linux.
 *
 * IT IMPORTS NOTHING, on purpose. src/refusal-copy.js is the floor of the
 * refusal vocabulary and src/account-panel-copy.js imported nothing at all
 * before this; a helper either of them can take without acquiring a dependency
 * graph is the only kind that can sit under both.
 *
 * THE DEFAULT IS THE NEUTRAL NOUN, NOT THE WINDOWS ONE. A caller that cannot
 * say what platform it is on gets "a terminal", which is true on every
 * platform, rather than a specific claim that is wrong on two of three. */
export function terminalName(platform = globalThis.mcSetup?.platform) {
  return platform === 'win32' ? 'Windows Terminal' : 'a terminal'
}
