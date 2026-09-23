/* CAN AN AGENT ACTUALLY START WHEN THIS PERSON PRESSES FINISH.
 *
 * THE SENTENCE THIS EXISTS TO STOP THE PRODUCT SAYING. The last screen of setup
 * read "Codex is installed on this computer and signed in, so an agent can start
 * when you finish here" on a machine with no Codex on PATH and nobody signed in
 * to it (measured on the packaged build 2026-08-16). It was not a typo: the
 * screen branched on mcAgent.availability(), which answers "can this
 * installation start ANY agent", and rendered that answer as a fact about one
 * named program. With Claude installed and Codex absent, availability says yes
 * -- correctly, deliberately (d1eb2a5) -- and the sentence flipped on whether
 * CLAUDE was there.
 *
 * The cost was not only a false sentence. It made the not-installed branch --
 * the one carrying the line a person can paste into a terminal -- unreachable
 * for precisely the people who needed it, which is every stranger this product
 * is meant for.
 *
 * TWO SOURCES, TWO QUESTIONS, AND NEITHER SPEAKS FOR THE OTHER:
 *   engine  mcAgent.availability()      can this installation start anything
 *   codex   mcProviders.presence()      is the Codex program here, and signed in
 *
 * The engine's verdict goes first and only when it is BOTH known and negative
 * for a reason that is not about Codex itself -- a build with no engine payload
 * refuses whatever is installed, and that is worth saying. Its two Codex-shaped
 * codes are deliberately left to the provider branches, which say the same
 * thing in the program's own terms and hand over the command that fixes it.
 *
 * 'unknown' IS A REAL ANSWER AND IS NEVER ROUNDED UP. Both sources can answer
 * "I could not tell", and this says so rather than printing a tick. A green
 * claim that turns out to be false is the one failure this whole screen is
 * about.
 *
 * It builds no markup and touches no DOM, so the suite drives the real decision
 * instead of matching the source of it.
 */

import { CODEX_SETUP_COMMANDS, codexSetupInstructions, unavailableReason } from './agent-availability-copy.js'
import { currentDataSource } from './data-source.js'

export const READINESS_HEADING = 'Before an agent can run'

const CODEX_CODES = new Set(['AGENT_CODEX_CLI_NOT_INSTALLED', 'AGENT_CONFINEMENT_SIGNED_OUT'])

const FINISH_LATER = 'You can finish setup first and do this afterwards. Everything you chose is still saved.'

/**
 * What the review says about starting an agent.
 *
 * @param engine  `{ known, ok, code }` from mcAgent.availability(), or null
 *                while it has not answered yet.
 * @param codex   `{ known, installed, signedIn }` from mcProviders.presence()
 *                for the codex row, or null while it has not answered yet.
 * @returns `{ tone, heading, lines }` — tone is the status block's modifier,
 *          '' for a plain statement and 'is-warn' for something left to do.
 */
export function codexReadiness({ engine = null, codex = null, platform = globalThis.mcSetup?.platform, viaRelay = currentDataSource() === 'relay' } = {}) {
  const codexRefused = engine?.known === true && CODEX_CODES.has(engine.codexCode)
  const optional = engine?.known === true && engine.ok === true
    && (codexRefused || !(codex?.known === true && codex.installed === 'yes' && codex.signedIn === 'yes'))
  const block = (tone, lines) => Object.freeze({ tone: optional ? '' : tone,
    heading: optional ? 'Codex setup (optional)' : READINESS_HEADING, lines: Object.freeze(lines) })
  const instructions = codexSetupInstructions({ platform, viaRelay })

  if (engine && engine.known === true && engine.ok === false && !CODEX_CODES.has(engine.code)) {
    if (viaRelay) {
      return block('is-warn', ['An agent cannot start on the computer you are driving yet. ToolsEnabled on that computer reported a problem that must be resolved there before an agent can start.'])
    }
    return block('is-warn', [`An agent cannot start on this computer yet: ${unavailableReason(engine.code, { platform })}.`])
  }
  if (codex === null) {
    return block('', [viaRelay
      ? 'Checking whether Codex is installed and signed in on the computer you are driving.'
      : 'Checking whether Codex is installed and signed in on this computer.'])
  }
  /* THE UNCERTAIN STATE MAY NOT CARRY AN INSTALL COMMAND, AND IT USED TO.
   *
   * THE REPORT THIS CLOSES, from the owner's own second machine: "i have claude
   * and codex downloaded and installed and signed it but when i try to launch
   * agents it says nothing was started and to run winget install openAI". He had
   * done exactly what the product told him to do, and the product told him to do
   * it again. The probe's half of that is fixed in
   * shell/machine-search-path.cjs; this is the other half, and it is the half
   * his report is actually about -- an install command in front of a person who
   * has already installed the thing is what makes a product look broken.
   *
   * "WE COULD NOT FIND IT" IS NOT "YOU HAVE NOT INSTALLED IT", and these two
   * branches are the states where only the first is true. The command is not
   * withheld to be coy: printing it here is a specific, checkable claim about
   * this person's computer that this block cannot support, and a person who
   * reads a false claim about their own machine stops believing the true ones.
   *
   * SO IT SAYS WHAT IS ACTUALLY KNOWN, and gives them something to do that is
   * not an accusation. Reopening the application is a real remedy for the real
   * cause -- Windows publishes an install by writing the registry, and a running
   * program keeps the environment it started with -- and it costs a person
   * nothing to try. */
  if (codex.known !== true) {
    return block('is-warn', [
      viaRelay
        ? 'This browser could not ask the computer you are driving what is installed on it, so it will not tell you either way.'
        : 'This copy could not ask this computer what is installed on it, so it will not tell you either way.',
      'Nothing you chose here depends on that. Finish setup; the first page reports what it finds when you get there.',
    ])
  }
  if (codex.installed === 'unknown') {
    return block('is-warn', [
      viaRelay
        ? 'We could not find Codex on the computer you are driving. That is not the same as it not being there.'
        : 'We could not find Codex on this computer. That is not the same as it not being here.',
      viaRelay
        ? 'A program installed since ToolsEnabled opened on that computer is one it cannot see. So is one installed somewhere that computer does not list.'
        : 'A program installed since this window opened is one we cannot see. So is one installed somewhere this computer does not list.',
      'If you have already installed it, nothing is wrong. Finish setup and start an agent.',
      viaRelay
        ? 'If it will not start, close ToolsEnabled on that computer and open it again there. That is enough for it to notice anything added since.'
        : 'If it will not start, close ToolsEnabled and open it again. That is enough for it to notice anything added since.',
    ])
  }
  if (codex.installed !== 'yes') {
    return block('is-warn', [
      viaRelay
        ? 'Codex is not installed on the computer you are driving. It is a separate free program from OpenAI, and it is one of the assistant programs ToolsEnabled can run.'
        : 'Codex is not installed on this computer. It is a separate free program from OpenAI, and it is one of the assistant programs ToolsEnabled can run.',
      ...instructions.install,
      /* A NEW window, or the sign-in lands in the one the install ran in,
         which cannot see the new program yet -- the first external user's
         exact dead end; src/first-run-needs.js carries the full account. */
      viaRelay
        ? `Then sign in to it in a new terminal window on that computer: ${CODEX_SETUP_COMMANDS.signIn}`
        : `Then sign in to it, in a new terminal window: ${CODEX_SETUP_COMMANDS.signIn}`,
      FINISH_LATER,
    ])
  }
  if (codex.signedIn === 'no') {
    return block('is-warn', [
      viaRelay
        ? 'Codex is installed on the computer you are driving, but nobody is signed in to it. The permission level you chose builds each session from that sign-in.'
        : 'Codex is installed on this computer, but nobody is signed in to it. The permission level you chose builds each session from that sign-in.',
      instructions.signIn,
      FINISH_LATER,
    ])
  }
  if (codex.signedIn !== 'yes') {
    return block('is-warn', [
      viaRelay
        ? 'Codex is installed on the computer you are driving. This browser could not tell whether anybody is signed in to it, so it will not say either way.'
        : 'Codex is installed on this computer. This copy could not tell whether anybody is signed in to it, so it will not say either way.',
      viaRelay
        ? `If a Codex agent will not start, open ${instructions.terminal} on that computer and run: ${CODEX_SETUP_COMMANDS.signIn}`
        : `If a Codex agent will not start, open ${instructions.terminal} and run: ${CODEX_SETUP_COMMANDS.signIn}`,
    ])
  }
  if (codexRefused) {
    return block('is-warn', [
      engine.codexCode === 'AGENT_CODEX_CLI_NOT_INSTALLED'
        ? 'The latest launch check says Codex is not installed, despite the earlier presence reading.'
        : 'The latest launch check says Codex is not signed in, despite the earlier presence reading.',
      'Choose Check again before starting a Codex agent.',
    ])
  }
  if (engine?.known !== true) {
    return block('', [
      viaRelay ? 'Codex is installed on the computer you are driving and signed in.' : 'Codex is installed on this computer and signed in.',
      'Agent readiness is still unverified. Choose Check again to check whether an agent can start.',
    ])
  }
  if (engine.ok !== true) {
    return block('is-warn', [
      viaRelay ? 'Codex is installed on the computer you are driving and signed in.' : 'Codex is installed on this computer and signed in.',
      'ToolsEnabled still reports that an agent cannot start. Choose Check again to refresh the checks before starting an agent.',
    ])
  }
  return block('', [viaRelay
    ? 'Codex is installed on the computer you are driving and signed in, so an agent can start when you finish here.'
    : 'Codex is installed on this computer and signed in, so an agent can start when you finish here.'])
}

/* A MODEL ON THIS COMPUTER'S OWN HARDWARE, the same shape as codexReadiness()
 * above and DELIBERATELY A DIFFERENT TONE. Codex's absence is `is-warn`
 * because nothing else in setup guarantees an agent CAN start without it;
 * local's absence is plain by design (owner ruling, "provider-neutral
 * production": local is a first-class peer, never demoted, but it is also
 * never required -- "enable depth, don't require it"). A person who never
 * touches this is not missing a step.
 *
 * READ-ONLY, LIKE THE REST OF THIS SCREEN. Setup does not install anything
 * and does not gate Finish on the answer (same rule setup.js states for
 * codexReadinessMarkup() at its own call site) -- Settings, under "This
 * computer", is where the actual install/download actions live (owner ruling
 * via fleet-B: extending PROVIDER_SETUP, never a second install path in setup
 * or anywhere else).
 */
export const LOCAL_MODEL_READINESS_HEADING = 'A model on this computer'

/**
 * @param local  `{ known, ready, selected }` derived from mcProviders.
 *               detectLocal(), or null while it has not answered yet.
 */
export function localModelReadiness({ local = null, viaRelay = currentDataSource() === 'relay' } = {}) {
  const block = (tone, lines) => Object.freeze({ tone, heading: LOCAL_MODEL_READINESS_HEADING, lines: Object.freeze(lines) })

  if (local === null) {
    return block('', [viaRelay
      ? 'Checking whether a local model runtime is running on the computer you are driving.'
      : 'Checking whether a local model runtime is running on this computer.'])
  }
  if (local.known !== true) {
    return block('is-warn', [
      viaRelay
        ? 'This browser could not ask the computer you are driving whether a local model runtime is running, so it will not tell you either way.'
        : 'This copy could not ask this computer whether a local model runtime is running, so it will not tell you either way.',
      'Nothing you chose here depends on that. Finish setup; Settings, under "This computer", explains how to add one, whenever you want.',
    ])
  }
  if (local.ready === true) {
    const named = local.selected && typeof local.selected.displayName === 'string' ? local.selected.displayName : 'A runtime'
    return block('', [viaRelay
      ? `${named} is already running on the computer you are driving, ready to take work from the Launch controls and Team panels on the computers page.`
      : `${named} is already running on this computer, ready to take work from the Launch controls and Team panels on the computers page.`])
  }
  return block('', [
    viaRelay
      ? 'No local model runtime is currently running on the computer you are driving. This is entirely optional.'
      : 'No local model runtime is currently running on this computer. This is entirely optional.',
    'Settings, under "This computer", can help install one and download a model to it, whenever you want.',
  ])
}
