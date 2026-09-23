'use strict'

/* ADDING A CODEX CLOUD ACCOUNT. ONE ACTION, ONE THING TO TYPE: A NAME.
 *
 * THE DEFECT THIS CLOSES, walked rather than inferred. Launching a task on
 * Codex Cloud works -- two real tasks were launched on this machine on
 * 2026-08-23 and ran. Getting to the point where it could work took four manual
 * steps, three of which are ours and none of which a customer can perform:
 *
 *   1. The account registry the cloud lane reads was HAND-AUTHORED in an
 *      editor. Nothing in the product wrote it, and the product's own refusal
 *      told the reader to "create it" and named a JSON file.
 *   2. The home directory each account keeps its sign-in in was created by
 *      hand. Nothing made them, and two Codex accounts that share one directory
 *      overwrite each other's sign-in -- so somebody who gets this wrong has
 *      ONE account while believing they have two.
 *   3. The sign-in had to be run with CODEX_HOME set, in the right shell.
 *      Nothing in the product said so. The owner was handed the PowerShell
 *      form, was in cmd.exe, and it failed four times in a row with "The
 *      filename, directory name, or volume label syntax is incorrect." A
 *      customer has nobody to correct them.
 *
 * (The fourth step, creating the Cloud environment, genuinely lives on the
 * provider's side and is not ours to do.)
 *
 * WHAT ONE PRESS DOES NOW: the engine's writer creates the directory and
 * records the entry, and this product opens the person's own terminal with that
 * account's home already set in it. They type a name. They are never told a
 * path, a filename or the name of an environment variable.
 *
 * IT COMPOSES; IT IMPLEMENTS NOTHING. Both halves already exist and both are
 * held by tests of their own:
 *
 *   addAccount    capability/src/lib/multi-account/registry-write.js -- the
 *                 only writer of that registry, which validates a candidate by
 *                 handing it to the READERS' own parser, so a duplicate name or
 *                 a shared directory is refused by the one implementation of
 *                 those rules rather than by a second copy of them.
 *   providerLogin ./provider-login.cjs -- the one place this product opens a
 *                 sign-in. It is not a second login path and must never become
 *                 one: the same call, with a home named.
 *
 * THE ORDER IS PART OF THE DESIGN. Whether the program is even on this computer
 * is asked BEFORE anything is created, because a recorded account that cannot
 * be signed in is worse than a refusal -- the person cannot add it again (the
 * name is taken) and has nothing to press.
 *
 * NO PATH CROSSES BACK, and no credential can. What this module returns is a
 * name, a yes/no and a sentence. The directory it had the engine create is
 * where the provider's CLI will later put a sign-in; nothing here ever looks
 * inside it, and the only thing that learns the path is the terminal window,
 * which is the person's own and is read by nobody.
 */

const PROVIDER = 'codex'

/* WHY THE ENGINE'S SENTENCES ARE NOT FORWARDED. Every refusal the writer raises
   names the registry's absolute path, because it is talking to a developer with
   a file in front of them. A path in a sentence goes straight to the glass --
   the engine's own src/lib/mission-bridge/errors.js exists to strip them for
   exactly this reason -- so this table answers by CODE and writes its own
   sentence. An unmapped code gets a true sentence with no detail in it rather
   than a stranger's file path. */
const REFUSALS = Object.freeze({
  ACCOUNTS_ENTRY_INVALID: 'That name cannot be used. Use letters, numbers, spaces, dots, dashes or underscores, starting with a letter or a number.',
  ACCOUNTS_NAME_DUPLICATE: 'You already have a Codex account with that name on this computer. Pick another name.',
  ACCOUNTS_PROFILE_DIR_SHARED: 'Another Codex account on this computer already keeps its sign-in in that folder, and two accounts cannot share one. Pick another name.',
  ACCOUNTS_ROLE_DUPLICATE: 'Another Codex account on this computer already has that role. Nothing was changed.',
  ACCOUNTS_PROVIDER_UNSUPPORTED: 'That kind of account cannot be added here.',
  ACCOUNTS_REGISTRY_UNREADABLE: 'The list of accounts on this computer could not be read, so nothing was changed.',
  ACCOUNTS_REGISTRY_UNPARSABLE: 'The list of accounts on this computer could not be read, so nothing was changed.',
  ACCOUNTS_REGISTRY_INVALID: 'The list of accounts on this computer could not be read, so nothing was changed.',
  ACCOUNTS_HOME_NOT_CREATED: 'The folder for this account could not be created, so nothing was changed.',
  ACCOUNTS_REGISTRY_WRITE_FAILED: 'The list of accounts could not be saved, so nothing was changed.',
})

const UNMAPPED = 'The account could not be added, and nothing was changed.'

const NOT_INSTALLED = Object.freeze({
  ok: false,
  code: 'PROVIDER_LOGIN_NOT_INSTALLED',
  /* It names the button that fixes it rather than a command, which is the rule
     ./provider-login.cjs already holds itself to: "not recognized" at somebody
     who has never installed anything is a dead end. */
  reason: 'Codex is not on this computer yet. Install it in Settings, under "This computer", first, then add the account here.',
})

const INSTALL_CHECK_FAILED = Object.freeze({
  ok: false,
  code: 'PROVIDER_LOGIN_INSTALL_CHECK_FAILED',
  reason: 'This computer could not check whether Codex is installed, so nothing was changed. Try again in a moment.',
})

const UNAVAILABLE = Object.freeze({
  ok: false,
  code: 'CLOUD_ACCOUNT_ADD_UNAVAILABLE',
  reason: 'This copy cannot add an account for you. Open Settings, under "This computer", and try again there in a moment.',
})

function refusalFor(error) {
  const code = error && typeof error.code === 'string' ? error.code : null
  return Object.freeze({
    ok: false,
    code: code || 'CLOUD_ACCOUNT_ADD_REFUSED',
    reason: (code && REFUSALS[code]) || UNMAPPED,
  })
}

/**
 * `addAccount` is the engine's writer; `providerLogin` is the shell's own login
 * service. Both are injected so this composition can be measured without a
 * registry, a terminal or a real machine -- and so a payload that predates the
 * writer answers UNAVAILABLE instead of throwing at a person.
 *
 * add({ name }) ->
 *   { ok: true,  name, signInOpened: true,  terminal }
 *   { ok: true,  name, signInOpened: false, code, reason }   the account is
 *       recorded and the window did not open; the fact is reported rather than
 *       rolled back, because the account really does exist now and saying
 *       otherwise would send the person to add it a second time.
 *   { ok: false, code, reason }                              nothing changed.
 */
function createCloudAccountSetup({ addAccount, providerLogin } = {}) {
  const ready = typeof addAccount === 'function'
    && providerLogin
    && typeof providerLogin.start === 'function'
    && typeof providerLogin.installed === 'function'

  return Object.freeze({
    available() { return Boolean(ready) },

    add({ name } = {}) {
      if (!ready) return UNAVAILABLE
      let installed
      try {
        installed = providerLogin.installed(PROVIDER)
      } catch {
        /* A failed presence probe is not proof that Codex is absent. More
           importantly, it must not throw through the IPC handler on an ordinary
           Add account press. Refuse before the writer changes anything and
           distinguish could-not-check from the definite not-installed answer. */
        return INSTALL_CHECK_FAILED
      }
      if (!installed) return NOT_INSTALLED

      let record
      try {
        /* The name is the ONLY thing that crosses. Where the home goes, what
           the provider calls that field and what priority the entry takes are
           all worked out by the writer, because every one of them is a thing a
           person had to know before this existed. */
        record = addAccount({ name, provider: PROVIDER })
      } catch (error) {
        return refusalFor(error)
      }

      /* THE NAME GOES WITH THE HOME, and it is the WRITER's name rather than
         the one that crossed in: the person may have typed nothing, or typed a
         name the writer had to number, and the window has to wear the name the
         new row will carry.

         MEASURED 2026-09-03 FROM THIS SOURCE: every other caller of start()
         that names a home names the account beside it (shell/main.cjs
         mc-accounts:sign-in), and this one did not -- so two cloud accounts
         added one after the other opened two windows BOTH titled "ToolsEnabled
         sign-in: codex" (provider-login.cjs signInWindowTitle falls back to the
         program's own command when no account is named, which is right for the
         Sign in button in Settings and wrong here, where an account exists and has a
         name). Two identical windows running the same command is how somebody
         finishes the sign-in in the wrong one, and a Codex Cloud sign-in
         finished in the wrong home bills the wrong subscription for every task
         launched afterwards. */
      const answer = (signIn) => {
        if (signIn && signIn.ok === true) {
          return Object.freeze({ ok: true, name: record.name, signInOpened: true, terminal: signIn.terminal })
        }
        return Object.freeze({
          ok: true,
          name: record.name,
          signInOpened: false,
          code: (signIn && signIn.code) || 'PROVIDER_LOGIN_SPAWN_FAILED',
          reason: (signIn && signIn.reason)
            || 'The account was added, but the sign-in window could not be opened.',
        })
      }
      try {
        const signIn = providerLogin.start(PROVIDER, { home: record.home, label: record.name })
        return signIn && typeof signIn.then === 'function' ? signIn.then(answer, () => answer(null)) : answer(signIn)
      } catch { return answer(null) }
    },
  })
}

module.exports = { createCloudAccountSetup }
