/* Codex Cloud, from inside the product: the two places it appears.
 *
 * THE GAP THIS CLOSES. The owner's ruling is blunt and was repeated: "codex
 * cloud launch is literally a product feature it should work from the
 * software." The capability was finished and proven against the real provider
 * -- cloud.task_launch / task_status / task_list are in the shipped registry,
 * permission-gated, audited, and real cloud tasks ran to completion through
 * them. The INTERFACE had nothing. A grep for "cloud" across every renderer
 * source file returned one hit, in an unrelated account module, and the built
 * bundle contained zero. So the product carried a working remote-agent
 * capability that no user could reach, which from inside the app is
 * indistinguishable from not having built it.
 *
 * AND THE HALF THAT WAS STILL MISSING AFTER THAT. The first version of this
 * surface asked the person to TYPE a 32-character environment id. That is not a
 * launcher, it is a form for someone who already has the answer: the id appears
 * only in a web URL, `codex cloud list --json` reports `environment_id: null`
 * for every task it lists, and codex-cli 0.146.0 has no environment subcommand
 * at all (all three measured 2026-08-11). Machine B's offload report named the
 * same wall from the other side. So this surface now CHOOSES from the
 * environments the configured accounts are authorized for, SHOWS the source
 * repository each one is bound to, DECLARES that repository with the launch,
 * keeps the submission receipt on the glass, and follows the task's status by
 * itself.
 *
 * WHERE IT LIVES, AND WHY NOT ON A PAGE OF ITS OWN. A cloud task is an agent
 * that runs somewhere else. It belongs where the local agents already are: the
 * agent page (`mountCloudTaskSurface`, beside the local session surface) and the
 * fleet board's control rail (`cloudControlsBox`, beside Launch, Team and Loop).
 * A separate "Cloud" route would have made the same claim the product keeps
 * making by accident -- that remote work is a different kind of thing -- and
 * would have needed its own navigation entry, its own empty state, and its own
 * answer to "where did my agents go".
 *
 * WHAT IT DOES NOT DO, stated because the spec is explicit that pretending
 * otherwise costs real time (docs/CODEX-CLOUD-INTERFACE.md):
 *   - There is no cancel. Once the provider accepts a task it runs. No control
 *     here offers one, and the confirm step says so before the launch.
 *   - It does not apply diffs. A finished task's changes can now be FETCHED
 *     here -- that was the whole point of paying for the task -- but fetching is
 *     a read. Nothing on this surface applies, stages or commits anything, and
 *     no control offers to: putting remotely-produced changes into a tree is a
 *     separate reviewed act, and keeping the two apart means retrieval can never
 *     be the step that damages a tree.
 *   - It returns a diff and nothing else. No artifacts, no agent prose, no logs:
 *     the provider CLI exposes none of those, so nothing here is labelled
 *     "results" or "output".
 *   - Silence is not success. A task absent from the searched window is
 *     reported unknown, never finished, and never quietly dropped from the list.
 *
 * The rules live in ./cloud-tasks-controller.js, which has no DOM and no
 * stylesheet so that a plain `node --test` run can exercise them. This file is
 * markup and wiring.
 */
import { el } from './components.js'
import { currentDataSource } from './data-source.js'
import { readerRemedy } from './refusal-copy.js'
import { setWriteEnabled } from './write-flags.js'
import { postBridgeAction } from './mission-bridge.js'
import {
  bindingText,
  cloudAvailability,
  cloudStateView,
  createCloudTaskController,
  environmentSummary,
  findEnvironment,
  offersDiff,
  readRemembered,
} from './cloud-tasks-controller.js'
import './cloud.css'

export {
  CLOUD_STATES,
  TERMINAL_CLOUD_STATES,
  accountSummary,
  cloudAvailability,
  cloudStateView,
  createCloudTaskController,
  diffAnswer,
  diffRefusalMessage,
  environmentSummary,
  environmentsMessage,
  offersDiff,
} from './cloud-tasks-controller.js'

/* The one control that gets a finished task's work back, and the label it wears
   while it is doing it. "Get the work" is what the person came for; every
   sentence the answer produces then says diff, because a diff is what exists. */
const GET_WORK_LABEL = 'Get the work'
const GET_WORK_BUSY_LABEL = 'Reading…'

/* Refusals are composed in the controller, but this file owns who is reading
   them.  A relayed browser is driving another computer, so re-read desk-bound
   remedies at the last possible moment rather than changing the stored copy. */
const readerSentence = sentence => {
  const viaRelay = currentDataSource() === 'relay'
  const reread = readerRemedy(sentence, { viaRelay })
  if (!viaRelay || typeof reread !== 'string') return reread
  /* This account fact can be embedded after the list/environment lede, so it
     is not necessarily a whole refusal sentence for readerRemedy to match. */
  return reread.replace(
    'this computer has no list of Codex Cloud accounts',
    'the computer you are driving has no list of Codex Cloud accounts',
  )
}

/* [B6] `code` is the identifier that used to lead each of these lines. It is
   still reported, on the element rather than in the sentence, so a support
   conversation can name the exact refusal a customer hit. It is REMOVED rather
   than blanked when there is none: `data-refusal-code=""` reads as "there is a
   code and it is empty" to anything testing for presence. */
function stateNode(node, tone, text, code = null) {
  if (!node) return
  node.dataset.state = tone
  node.textContent = text
  /* A SLOT WITH NOTHING TO SAY IS NOT DRAWN. The controller blanks a line when
     another line has already stated the condition -- one condition, one
     paragraph -- and an empty <output> that still takes its row leaves a gap
     where a person looks for a sentence. */
  node.toggleAttribute('hidden', String(text || '').trim().length === 0)
  if (typeof code === 'string' && code.length > 0) node.setAttribute('data-refusal-code', code)
  else node.removeAttribute('data-refusal-code')
}

/* THE ROW, AND THE ONE CONTROL ON IT.
 *
 * The control is offered on FINISHED rows only, and that is a rule rather than a
 * tidiness preference: a queued or running task has produced nothing to fetch,
 * and a button that reliably answers "there is nothing there" teaches people to
 * ignore the one that matters. `offersDiff` decides, in the controller, so the
 * rule can be tested without a browser.
 *
 * It is a control on the row rather than one control with a task picker, because
 * the person's question is about THIS task -- the one they are looking at -- and
 * a picker would ask them to retype an identifier that is already on screen. */
function taskRow(task, { state = null, onGetWork = null } = {}) {
  const view = cloudStateView(task.state)
  const row = el(`<li class="cloud-task">
    <span class="cloud-task-state" data-tone=""></span>
    <span class="cloud-task-title"></span>
    <span class="cloud-task-meta"></span>
  </li>`)
  const pill = row.querySelector('.cloud-task-state')
  pill.dataset.tone = view.tone
  pill.textContent = view.label
  row.querySelector('.cloud-task-title').textContent = task.title || task.taskId
  /* The provider's own word is shown beside ours, always. Our six-value
     vocabulary is a translation, and a translation that hides the original is
     how a person loses the ability to check it against the provider's site. */
  const meta = [task.taskId]
  if (task.providerStatus && task.providerStatus !== view.label) meta.push(task.providerStatus)
  if (task.environmentLabel) meta.push(task.environmentLabel)
  if (task.updatedAt) meta.push(task.updatedAt)
  row.querySelector('.cloud-task-meta').textContent = meta.join(' · ')
  if (offersDiff(task) && typeof onGetWork === 'function') {
    const button = el('<button type="button" class="cloud-get" data-cloud-get></button>')
    const reading = state?.diffPhase === 'reading'
    button.textContent = reading && state?.diffTaskId === task.taskId ? GET_WORK_BUSY_LABEL : GET_WORK_LABEL
    /* The row's own words, so a screen reader hears WHICH task this fetches
       rather than the twentieth "Get the work" on the page. */
    button.setAttribute('aria-label', `${GET_WORK_LABEL} from ${task.title || task.taskId}`)
    button.disabled = reading
    button.addEventListener('click', () => { onGetWork(task) })
    row.append(button)
  }
  return row
}

/* WHAT CAME BACK, RENDERED WHOLE OR NOT AT ALL.
 *
 * The sentence is written by the controller -- one rule, one wording, both
 * mounts -- and this only decides where it sits and whether a diff sits under
 * it. The diff itself goes in a <pre> with its own scroll: a diff reflowed to
 * the width of a panel is not a diff any more, and the one thing a person does
 * with this text is read it line by line or copy it out.
 *
 * THE SPOKEN HALF IS THE SENTENCE, NOT THE DIFF. `role="status"` sits on the one
 * line that says what happened, and the three elements are built with the panel
 * rather than rebuilt on every answer. Announcing the region as a whole would
 * read two megabytes of unified diff aloud to somebody who asked what changed.
 *
 * `data-refusal-code` is stamped on the region for the same reason every other
 * state node in this file carries one -- a support conversation can name the
 * exact refusal -- and REMOVED when there is none. */
function renderDiff(node, state) {
  if (!node) return
  const title = node.querySelector('.cloud-diff-title')
  const note = node.querySelector('.cloud-diff-note')
  const body = node.querySelector('.cloud-diff-text')
  if (!state.diffTaskId || state.diffPhase === 'idle') {
    node.hidden = true
    if (title) title.textContent = ''
    if (note) note.textContent = ''
    if (body) { body.textContent = ''; body.hidden = true }
    node.removeAttribute('data-refusal-code')
    return
  }
  node.hidden = false
  node.dataset.state = state.diffTone
  if (state.diffCode) node.setAttribute('data-refusal-code', state.diffCode)
  else node.removeAttribute('data-refusal-code')
  if (title) title.textContent = `What came back · ${state.diffTaskId}`
  if (note) note.textContent = readerSentence(state.diffMessage)
  if (body) {
    body.textContent = state.diffText
    body.hidden = state.diffText.length === 0
  }
}

function accountOptions(select, accounts, defaultAccount) {
  const chosen = select.value
  const options = [el(`<option value="">Automatic${defaultAccount ? ` · ${defaultAccount}` : ''}</option>`)]
  for (const account of accounts) {
    const option = document.createElement('option')
    option.value = account.name
    /* The status is IN the option text rather than only disabling the row. A
       greyed-out account tells a person they cannot pick it and not why; the
       reason ("signed out", "99% used") is the entire actionable content. */
    option.textContent = `${account.name}${account.role ? ` · ${account.role}` : ''} · ${
      account.canServe
        ? (Number.isFinite(account.usedPercent) ? `${Math.round(account.usedPercent)}% used` : 'ready')
        : String(account.status || 'unavailable').replace(/_/g, ' ')
    }`
    options.push(option)
  }
  select.replaceChildren(...options)
  if (chosen && options.some(option => option.value === chosen)) select.value = chosen
}

/* The environment picker. An environment with no single repository is LISTED and
   DISABLED with its reason attached, never hidden: hiding it would leave a
   person searching for an environment they can see on the provider's own site,
   with nothing on this glass to explain why it is not offered. */
function environmentOptions(select, state) {
  const chosen = select.value
  const options = [el(`<option value="">${state.environmentsLoaded ? 'Choose an environment' : 'Not read yet'}</option>`)]
  for (const environment of state.environments) {
    const option = document.createElement('option')
    option.value = environment.environmentId
    option.textContent = environmentSummary(environment)
    if (environment.launchable !== true) option.disabled = true
    if (environment.repository) option.dataset.repository = environment.repository
    options.push(option)
  }
  select.replaceChildren(...options)
  if (chosen && options.some(option => option.value === chosen && !option.disabled)) select.value = chosen
}

/* The receipt, rendered from the frozen record only. Every line is a fact the
   provider acknowledged; nothing here is recomputed from the form. */
function renderReceipt(node, receipt) {
  if (!node) return
  if (!receipt) {
    node.hidden = true
    node.replaceChildren()
    return
  }
  node.hidden = false
  const rows = [
    ['task', receipt.taskId],
    ['state at submission', cloudStateView(receipt.state).label],
    ['environment', `${receipt.environmentLabel ? `${receipt.environmentLabel} · ` : ''}${receipt.environment || 'not reported'}`],
    ['repository', receipt.repository || 'not reported'],
    ['branch', receipt.branch || 'not reported'],
    ['account', receipt.account?.name || 'not reported'],
    ['submitted', receipt.submittedAt || 'not reported'],
    ['binding read', receipt.bindingReadAt || 'not reported'],
  ]
  const list = el('<ul class="cloud-receipt-list"></ul>')
  for (const [key, value] of rows) {
    const row = el('<li><span class="cloud-receipt-k"></span><span class="cloud-receipt-v"></span></li>')
    row.querySelector('.cloud-receipt-k').textContent = key
    row.querySelector('.cloud-receipt-v').textContent = String(value)
    list.append(row)
  }
  const title = el('<span class="cloud-receipt-title">Submitted — this record does not change</span>')
  node.replaceChildren(title, list)
}

/* The one control a switched-off panel needs: the switch. Same durable flag
   Settings writes, so turning it on here is turning it on everywhere. */
function offSwitch() {
  const button = el('<button type="button" class="cloud-enable" data-cloud-enable>Turn on Codex Cloud launching</button>')
  button.addEventListener('click', () => { setWriteEnabled('cloud-launch', true) })
  return button
}

/* ---------------------------------------------------------------- *
 * WHAT THE AGENT PAGE SHOWS WHILE THE FEATURE IS OFF.
 *
 * THE SAME SHAPE AS ITS NEIGHBOUR, DELIBERATELY. `mountSessionSwitchedOff` in
 * agent-session.js draws the identical statement for the identical situation --
 * a write surface whose flag is off -- and the two panels sit one above the
 * other on this page. A second composition for the second one is a difference
 * with no meaning behind it, so this borrows that one exactly: header, one
 * column, the reason, the switch.
 *
 * WHAT IT DOES NOT DRAW, AND WHY THAT IS THE FIX. It used to draw the whole
 * launcher dead: an environment picker with nothing in it, a branch field, an
 * account picker, an attempts picker, a prompt box, a disabled Launch, and
 * beside them a "Tasks on Codex Cloud" column holding a disabled Refresh and
 * two more copies of the switched-off sentence. Measured on the packaged build
 * at 1440px, that was a 420px panel in which every control was inert and one
 * fact was stated three times. A form nobody can submit is not information
 * about the feature, it is furniture in front of it.
 *
 * WHAT IS UNCHANGED, and this is the half that matters. The panel is still
 * DRAWN rather than removed -- that is the whole point of the flag-off case
 * (see cloudAvailability in cloud-tasks-controller.js: a person cannot turn on
 * a switch they have never been shown). It still names the state in the header,
 * still carries the reason verbatim, still says nothing is contacted, and still
 * offers the switch on the panel itself. Nothing was softened; one fact is
 * simply said once.
 * ---------------------------------------------------------------- */
function mountCloudSwitchedOff(root, anchor, availability) {
  const surface = el(`<section class="write-surface cloud-surface" data-cloud-off aria-label="Codex Cloud">
    <header><strong>Codex Cloud</strong><span data-cloud-status role="status">Off</span></header>
    <div class="write-surface-grid">
      <div class="write-form">
        <span class="write-form-title">Launching cloud tasks is switched off</span>
        <output class="write-wide" data-cloud-off-reason role="status"></output>
      </div>
    </div>
  </section>`)
  /* The reason is the availability note verbatim. It is written by the rule
     that decided the state, so the panel cannot drift into describing a
     situation the gate is not actually in. */
  stateNode(surface.querySelector('[data-cloud-off-reason]'), 'note', readerSentence(availability.note))
  if (availability.code === 'CLOUD_LAUNCH_SWITCHED_OFF') {
    surface.querySelector('.write-form').append(offSwitch())
  }
  root.querySelector(anchor)?.insertAdjacentElement('afterend', surface)
  return () => { surface.remove() }
}

/* ---------------------------------------------------------------- *
 * The agent-page surface. Built from the existing write-surface markup so it
 * reads as one of the audited actions rather than a bolted-on panel.
 * ---------------------------------------------------------------- */
export function mountCloudTaskSurface(root, { live = false, anchor = '.agent-strip', postAction = postBridgeAction } = {}) {
  /* THE SAME FENCE THE LOCAL SESSION SURFACE USES, FOR A STRONGER REASON.
     `live` defaults to false so a caller that never established the page is
     real gets no real control. The demonstration copy of the agent page tells
     the reader that nothing on it is running; a Codex Cloud launcher there
     would start real, billable, uncancellable remote work from a page that has
     just said it is an example. */
  if (live !== true) return () => {}

  const availability = cloudAvailability()
  /* THE GATE IS READ ONCE AND BRANCHES ONCE. Everything below this line is the
     surface for an installation that CAN launch; the other one is its own
     function, so a control that only makes sense when the feature is on cannot
     be reached, disabled, from a state where it is off. */
  if (!availability.ok) return mountCloudSwitchedOff(root, anchor, availability)

  const surface = el(`<section class="write-surface cloud-surface" aria-label="Codex Cloud">
    <header><strong>Codex Cloud</strong><span data-cloud-status role="status">checking…</span></header>
    <div class="write-surface-grid">
      <form class="write-form" data-cloud-form>
        <span class="write-form-title">Launch a cloud task</span>
        <label class="write-wide">Environment<select name="environment" data-cloud-environments aria-label="Codex Cloud environment" required><option value="">Not read yet</option></select></label>
        <output class="cloud-binding write-wide" data-cloud-binding role="status"></output>
        <label>Branch<input name="branch" maxlength="200" placeholder="branch on the remote" required /></label>
        <label>Account<select name="account" aria-label="Codex account to run this task under"><option value="">Automatic</option></select></label>
        <label>Attempts<select name="attempts" aria-label="Assistant attempts">${[1, 2, 3, 4, 5].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
        <label class="write-wide">Prompt<textarea name="prompt" maxlength="16000" rows="3" required></textarea></label>
        <button type="submit" data-cloud-launch>Launch on Codex Cloud</button>
        <button type="button" data-cloud-cancel hidden>Not now</button>
        <output data-cloud-launch-output role="status"></output>
        <div class="cloud-receipt write-wide" data-cloud-receipt hidden></div>
        <output class="cloud-watch write-wide" data-cloud-watch role="status"></output>
      </form>
      <!-- THE READING COLUMN, COMPOSED AS ONE BLOCK. Refresh used to sit on a
           row of its own below the title, in the left half of a two-column
           grid, which is how this column came to read as a heading, a lone
           button and then a lot of nothing. It belongs on the title row: it is
           the verb for the thing the title names. -->
      <div class="write-form cloud-list" data-cloud-list>
        <div class="cloud-list-head">
          <span class="write-form-title">Tasks on Codex Cloud</span>
          <button type="button" data-cloud-refresh>Refresh</button>
        </div>
        <output class="write-wide" data-cloud-list-output role="status"></output>
        <output class="write-wide" data-cloud-environments-output role="status"></output>
        <!-- THE ONE THING A PERSON WITH NO ACCOUNT CAN DO, WHERE THEY MEET THE
             DEAD END. Until this existed, the panel's own empty state told them
             to sign in to Codex Cloud -- which writes a credential and does not
             put an account on this list -- so doing exactly what it said
             returned them to the same sentence. Adding an account is what
             writes the list, and the whole of it is a name: this computer makes
             that account's own folder and opens the sign-in with it already
             selected.

             IT IS ONLY HERE WHEN THERE IS NOTHING TO SHOW. With accounts on the
             list this is a second way to do something the person is not trying
             to do, and it is hidden. -->
        <div class="cloud-add-account write-wide" data-cloud-add-account hidden>
          <label>Name for this account
            <input type="text" data-cloud-account-name maxlength="64" autocomplete="off"
              placeholder="work" aria-label="Name for this Codex Cloud account">
          </label>
          <button type="button" data-cloud-account-add>Add a Codex Cloud account</button>
          <output class="write-wide" data-cloud-account-output role="status"></output>
        </div>
        <ul class="cloud-task-list write-wide" data-cloud-tasks></ul>
        <div class="cloud-diff write-wide" data-cloud-diff hidden><span class="cloud-diff-title"></span><p class="cloud-diff-note" role="status"></p><pre class="cloud-diff-text" tabindex="0" hidden></pre></div>
      </div>
    </div>
  </section>`)

  root.querySelector(anchor)?.insertAdjacentElement('afterend', surface)

  const status = surface.querySelector('[data-cloud-status]')
  const form = surface.querySelector('[data-cloud-form]')
  const launchButton = surface.querySelector('[data-cloud-launch]')
  const cancelButton = surface.querySelector('[data-cloud-cancel]')
  const launchOutput = surface.querySelector('[data-cloud-launch-output]')
  const listOutput = surface.querySelector('[data-cloud-list-output]')
  const environmentsOutput = surface.querySelector('[data-cloud-environments-output]')
  const bindingOutput = surface.querySelector('[data-cloud-binding]')
  const receiptNode = surface.querySelector('[data-cloud-receipt]')
  const watchNode = surface.querySelector('[data-cloud-watch]')
  const refreshButton = surface.querySelector('[data-cloud-refresh]')
  const taskList = surface.querySelector('[data-cloud-tasks]')
  const diffNode = surface.querySelector('[data-cloud-diff]')
  const addAccountBox = surface.querySelector('[data-cloud-add-account]')
  const addAccountName = surface.querySelector('[data-cloud-account-name]')
  const addAccountButton = surface.querySelector('[data-cloud-account-add]')
  const addAccountOutput = surface.querySelector('[data-cloud-account-output]')
  /* THE SAME BUILD SERVES IN A PLAIN BROWSER, where there is no shell to make a
     folder or open a terminal. Asked once, here, so the control is never
     offered in a window that could only refuse it. */
  const addCloudAccount = typeof window.mcProviders?.cloudAccountAdd === 'function'
    ? window.mcProviders.cloudAccountAdd.bind(window.mcProviders)
    : null
  const canAddAccount = Boolean(addCloudAccount)
  const accountSelect = form.elements.account
  const environmentSelect = form.elements.environment

  const remembered = readRemembered()
  form.elements.branch.value = remembered.branch

  /* READ AS THE ACCOUNT THE LIST WAS READ AS. A cloud task is only visible to
     the account that made it, so asking for the diff as a different account
     would manufacture the exact refusal this surface exists to explain. */
  const onGetWork = task => {
    void controller.readDiff(task.taskId, { account: controller.getState().servingAccount?.name || null })
  }

  const controller = createCloudTaskController({
    postAction,
    availability,
    onState: next => {
      stateNode(listOutput, next.listTone, readerSentence(next.listMessage), next.listCode)
      stateNode(environmentsOutput, next.environmentsTone, readerSentence(next.environmentsMessage), next.environmentsCode)
      stateNode(launchOutput, next.launchTone, readerSentence(next.launchMessage), next.launchCode)
      stateNode(watchNode, next.watchTone, readerSentence(next.watchMessage), next.watchCode)
      renderReceipt(receiptNode, next.receipt)
      launchButton.textContent = next.launchLabel
      launchButton.classList.toggle('is-confirming', next.phase === 'armed')
      launchButton.disabled = next.phase === 'launching'
      cancelButton.hidden = next.phase !== 'armed'
      refreshButton.disabled = next.phase === 'launching'
      /* Shown for exactly one state: the read succeeded and there are no
         accounts. Not while the read is refused -- a list that could not be
         read says nothing about whether accounts exist, and offering to add one
         there invites a duplicate. */
      if (addAccountBox) addAccountBox.hidden = !(canAddAccount && next.accountsPhase === 'none')
      accountOptions(accountSelect, next.accounts, next.defaultAccount)
      environmentOptions(environmentSelect, next)
      if (!environmentSelect.value && remembered.environment
          && next.environments.some(environment => environment.environmentId === remembered.environment && environment.launchable === true)) {
        environmentSelect.value = remembered.environment
        applyEnvironment(next)
      }
      /* The whole state, not just the chosen environment: with nothing chosen
         this line has to say WHY, and "not read yet", "could not be read" and
         "read, none chosen" are three different answers. */
      stateNode(bindingOutput, 'note', bindingText(findEnvironment(next, environmentSelect.value), next))
      taskList.replaceChildren(...next.tasks.map(task => taskRow(task, { state: next, onGetWork })))
      renderDiff(diffNode, next)
    },
  })

  /* Choosing an environment fills the branch with THAT environment's default,
     and clears it when the provider states none. The old form defaulted the
     field to "main" for every environment, which is the same defect in miniature
     as the ones this feature guards against: a value nobody established,
     presented as the answer, in a field that decides which code the cloud agent
     reads. */
  function applyEnvironment(state = controller.getState()) {
    const chosen = findEnvironment(state, environmentSelect.value)
    stateNode(bindingOutput, 'note', bindingText(chosen, state))
    form.elements.branch.value = chosen?.defaultBranch || ''
  }

  stateNode(status, 'ready', 'Codex Cloud ready · every launch asks for approval')

  void controller.loadAccounts()

  const onSubmit = event => {
    event.preventDefault()
    if (!controller.isArmed() && !form.reportValidity()) return
    const data = new FormData(form)
    void controller.click({
      environment: data.get('environment'),
      branch: data.get('branch'),
      prompt: data.get('prompt'),
      attempts: Number(data.get('attempts')) || 1,
      account: data.get('account') || null,
    })
  }
  const onCancel = () => { controller.disarm() }
  const onEnvironmentChange = () => { applyEnvironment() }
  /* ONE READ, IN ORDER. These two used to race, and whichever refused second
     painted its own paragraph about the same condition into its own box. See
     refresh() in ./cloud-tasks-controller.js. */
  const onRefresh = () => {
    void controller.refresh({ environment: environmentSelect.value || undefined })
  }
  /* ADDING AN ACCOUNT. One press does three things a person used to do by hand:
     the account's own folder is created, the entry is written to the list this
     panel reads, and their own terminal opens with that account's sign-in
     already running in it. The name is the only thing they type -- they are
     never shown a path, a filename or the name of an environment variable.

     THE LIST IS RE-READ AFTER A SUCCESS AND NOT PATCHED, which is the rule the
     rest of this panel follows: the one honest state after a write is whatever
     the engine says next. The re-read also un-hides the launch form, because
     `accountsPhase` stops being 'none'.

     AN ADD THAT RECORDED THE ACCOUNT BUT COULD NOT OPEN THE WINDOW IS STILL A
     SUCCESS AND IS SAID SO. The account exists; telling them it failed would
     send them to add it again under a name that is now taken. */
  const onAddAccount = async () => {
    if (!addCloudAccount) {
      stateNode(addAccountOutput, 'refused', 'The account could not be added, and nothing was changed.')
      return
    }
    const name = addAccountName?.value?.trim() || ''
    if (!name) {
      stateNode(addAccountOutput, 'note', 'Give the account a name first.')
      return
    }
    if (addAccountButton) addAccountButton.disabled = true
    stateNode(addAccountOutput, 'note', 'Adding…')
    const answer = await addCloudAccount({ name }).catch(() => null)
    if (addAccountButton) addAccountButton.disabled = false
    if (!answer || answer.ok !== true) {
      stateNode(addAccountOutput, 'refused',
        readerSentence(answer?.reason || 'The account could not be added, and nothing was changed.'),
        answer?.code || null)
      return
    }
    if (addAccountName) addAccountName.value = ''
    const signInPlace = currentDataSource() === 'relay' ? ' on the computer you are driving' : ''
    stateNode(addAccountOutput, answer.signInOpened === true ? 'confirmed' : 'note',
      answer.signInOpened === true
        ? `"${answer.name}" was added. Finish signing in in the window that just opened${signInPlace}, then press Refresh.`
        : readerSentence(`"${answer.name}" was added, but the sign-in window did not open. ${answer.reason || ''}`.trim()),
      answer.signInOpened === true ? null : (answer.code || null))
    void controller.loadAccounts()
  }

  form.addEventListener('submit', onSubmit)
  cancelButton.addEventListener('click', onCancel)
  environmentSelect.addEventListener('change', onEnvironmentChange)
  refreshButton.addEventListener('click', onRefresh)
  addAccountButton?.addEventListener('click', onAddAccount)

  return () => {
    form.removeEventListener('submit', onSubmit)
    cancelButton.removeEventListener('click', onCancel)
    environmentSelect.removeEventListener('change', onEnvironmentChange)
    refreshButton.removeEventListener('click', onRefresh)
    addAccountButton?.removeEventListener('click', onAddAccount)
    controller.destroy()
  }
}

/* ---------------------------------------------------------------- *
 * The fleet-board box. Same controller, the board's own markup, and the same
 * position in the rail as Launch / Team / Loop -- a cloud task is one more way
 * to start an agent from this computer, so it sits with the others.
 * ---------------------------------------------------------------- */
export function cloudControlsBox({ postAction = postBridgeAction } = {}) {
  const availability = cloudAvailability()
  const remembered = readRemembered()
  const box = el(`
    <div class="board-box board-cloud-box">
      <div class="board-box-h"><span class="bh-t">Codex Cloud</span></div>
      <div class="board-cap">an agent that runs on Codex Cloud instead of ${currentDataSource() === 'relay' ? 'the computer you are driving' : 'this computer'}</div>
      <label class="ctl-field"><span class="cl">Environment</span>
        <select class="ctl-select cloud-env" data-cloud="environment" aria-label="Codex Cloud environment"><option value="">Not read yet</option></select>
      </label>
      <div class="rail-sub cloud-binding" data-cloud="binding"></div>
      <label class="ctl-field"><span class="cl">Branch</span>
        <input class="ctl-num cloud-env" type="text" data-cloud="branch" maxlength="200" placeholder="branch on the remote" aria-label="Branch the cloud task runs against"/>
      </label>
      <label class="ctl-field"><span class="cl">Account</span>
        <select class="ctl-select" data-cloud="account" aria-label="Codex account"><option value="">Automatic</option></select>
      </label>
      <label class="ctl-field ctl-cloud-prompt"><span class="cl">Task</span>
        <textarea class="ctl-textarea" data-cloud="prompt" maxlength="16000" rows="2" aria-label="Cloud task prompt"></textarea>
      </label>
      <div class="rail-sub" data-cloud="note"></div>
      <div class="ctl-dispatch">
        <button class="ctl-btn" type="button" data-cloud="go">Launch on Codex Cloud</button>
        <button class="ctl-btn" type="button" data-cloud="cancel" hidden>Not now</button>
        <output class="ctl-out" data-cloud="out" role="status"></output>
      </div>
      <div class="cloud-receipt" data-cloud="receipt" hidden></div>
      <output class="ctl-out cloud-watch" data-cloud="watch" role="status"></output>
      <div class="ctl-dispatch">
        <button class="ctl-btn" type="button" data-cloud="refresh">Refresh tasks</button>
        <output class="ctl-out" data-cloud="list-out" role="status"></output>
      </div>
      <output class="ctl-out" data-cloud="environments-out" role="status"></output>
      <ul class="cloud-task-list" data-cloud="tasks"></ul>
      <div class="cloud-diff" data-cloud="diff" hidden><span class="cloud-diff-title"></span><p class="cloud-diff-note" role="status"></p><pre class="cloud-diff-text" tabindex="0" hidden></pre></div>
    </div>`)

  const field = name => box.querySelector(`[data-cloud="${name}"]`)
  const goButton = field('go')
  const cancelButton = field('cancel')
  const refreshButton = field('refresh')
  const out = field('out')
  const listOut = field('list-out')
  const environmentsOut = field('environments-out')
  const bindingOut = field('binding')
  const receiptNode = field('receipt')
  const watchNode = field('watch')
  const taskList = field('tasks')
  const diffNode = field('diff')
  const accountSelect = field('account')
  const environmentSelect = field('environment')

  const onGetWork = task => {
    void controller.readDiff(task.taskId, { account: controller.getState().servingAccount?.name || null })
  }

  field('branch').value = remembered.branch
  field('note').textContent = availability.ok
    ? 'A cloud task cannot be cancelled once Codex Cloud accepts it. Each launch asks for approval before anything is sent.'
    : readerSentence(availability.note)

  const controller = createCloudTaskController({
    postAction,
    availability,
    onState: next => {
      stateNode(out, next.launchTone, readerSentence(next.launchMessage), next.launchCode)
      stateNode(listOut, next.listTone, readerSentence(next.listMessage), next.listCode)
      stateNode(environmentsOut, next.environmentsTone, readerSentence(next.environmentsMessage), next.environmentsCode)
      stateNode(watchNode, next.watchTone, readerSentence(next.watchMessage), next.watchCode)
      renderReceipt(receiptNode, next.receipt)
      goButton.textContent = next.launchLabel
      goButton.disabled = next.phase === 'launching' || !availability.ok
      cancelButton.hidden = next.phase !== 'armed'
      refreshButton.disabled = next.phase === 'launching' || !availability.ok
      accountOptions(accountSelect, next.accounts, next.defaultAccount)
      environmentOptions(environmentSelect, next)
      if (!environmentSelect.value && remembered.environment
          && next.environments.some(environment => environment.environmentId === remembered.environment && environment.launchable === true)) {
        environmentSelect.value = remembered.environment
        applyEnvironment(next)
      }
      bindingOut.textContent = bindingText(findEnvironment(next, environmentSelect.value), next)
      taskList.replaceChildren(...next.tasks.map(task => taskRow(task, { state: next, onGetWork })))
      renderDiff(diffNode, next)
    },
  })

  function applyEnvironment(state = controller.getState()) {
    const chosen = findEnvironment(state, environmentSelect.value)
    bindingOut.textContent = bindingText(chosen, state)
    field('branch').value = chosen?.defaultBranch || ''
  }

  if (!availability.ok) {
    for (const control of box.querySelectorAll('input, select, textarea, button')) control.disabled = true
    if (availability.code === 'CLOUD_LAUNCH_SWITCHED_OFF') box.querySelector('.board-box-h').append(offSwitch())
  } else {
    void controller.loadAccounts()
    goButton.addEventListener('click', () => {
      void controller.click({
        environment: environmentSelect.value,
        branch: field('branch').value,
        prompt: field('prompt').value,
        attempts: 1,
        account: accountSelect.value || null,
      })
    })
    cancelButton.addEventListener('click', () => { controller.disarm() })
    environmentSelect.addEventListener('change', () => { applyEnvironment() })
    refreshButton.addEventListener('click', () => {
      void controller.refresh({ environment: environmentSelect.value || undefined })
    })
  }

  box.__cloudController = controller
  return box
}
