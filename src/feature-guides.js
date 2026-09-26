// Short introductions to the controls a person can actually see. This catalogue
// contains no actions: advancing a guide never sends a message or changes policy.
export const FEATURE_GUIDES = Object.freeze({
  home: {
    name: 'Home', title: 'A comfortable place to begin',
    intro: 'Home brings your assistants’ progress together. An assistant is a program that works with you on a task. You can review its work and choose what happens next.',
    steps: [
      { title: 'What an assistant is', text: 'An assistant is a program that reads a task you give it, works on that task, and reports back. It is not a person and it does not act unless you or a routine gives it something to do.', selectors: ['[data-home-agents]', '[data-activity-overview]', '.home-feed .session-head'] },
      { title: 'What a computer is here', text: 'In this app, a computer is one machine that can run one or more assistants. Work you see on Home may come from this computer or, once you add others, from any computer you have connected.', selectors: ['.home-feed .session-head'] },
      { title: 'What a fleet is', text: 'A fleet is simply a group of assistants working on related tasks together. Reviewing them together shows one picture instead of many separate ones. Home is where that shared picture appears first.', selectors: ['[data-activity-overview]', '.home-feed .session-head'] },
      { title: 'What a tree is', text: 'A tree is how a fleet’s assistants are arranged: one assistant coordinates, and others sit below it doing pieces of the work. You will see trees drawn out on Computers; Home shows their combined activity.', selectors: ['[data-home-agents]', '[data-activity-overview]', '.home-feed .session-head'] },
      { title: 'Keep an eye on the work', text: 'The activity panel shows recent work and replies. Look for anything that needs your attention, and read the result before deciding what happens next.', selectors: ['[data-activity-overview]', '.home-feed .session-head'] },
      { title: 'Tell one assistant from another', text: 'Each entry in the feed names the assistant and, where relevant, the computer it ran on. Checking this before you read a reply keeps you from mixing up two pieces of work.', selectors: ['.home-feed .session-head'] },
      { title: 'Give the conversation more room', text: 'Full view opens a larger conversation. You can focus on your coordinator, the assistant helping organize the work, or follow more of the activity. Close full view to return here.', selectors: ['[data-chat-expand]'] },
      { title: 'Meet your coordinator', text: 'A coordinator is the assistant that organizes a fleet’s work and reports the overall result to you. Full view is a good place to read what your coordinator currently understands.', selectors: ['[data-chat-expand]', '.home-chat-pane-tabs'] },
      { title: 'Start with a small request', text: 'Use everyday words. For example: “Help me plan my week.” Include what a useful result would look like. Sending a message asks the selected assistant to act.', selectors: ['.chat-input', '[data-compose-field="message"]', '.home-chat-pane-tabs'], unavailable: 'The message box appears once a conversation is open in this pane. Choose an assistant here, or open one on Computers to continue its conversation. Example data does not accept messages.' },
      { title: 'Read a reply before replying again', text: 'After you send a request, the assistant’s reply appears in the same conversation. Read it fully, since it may ask a question or explain a limit, before you write your next message.', selectors: ['.chat-input', '[data-compose-field="message"]', '.home-chat-pane-tabs'], unavailable: 'A reply appears once a conversation is open and the assistant has answered. There is nothing to read yet on example data.' },
      { title: 'Talk when you are ready', text: 'Choose a running assistant before starting voice. Read the speech connection details and the microphone request. Mute mic pauses listening; Stop reply silences the reply. Typed chat is available when you prefer it.', selectors: ['[data-voice-target]', '.voice-widget-heading'], unavailable: 'Voice needs a running assistant and an available speech connection. Read the voice status on this page before starting.' },
      { title: 'Decide what happens next', text: 'Reviewing work is not the same as approving it. Home only shows you progress; deciding what an assistant should do next always stays with you.', selectors: ['[data-home-agents]', '[data-activity-overview]', '.home-feed .session-head'] },
    ],
  },
  computers: {
    name: 'Computers', title: 'See where your work happens',
    intro: 'A computer can have several assistants working on related tasks. This page helps you see who is doing what.',
    /* WHAT THE INTRO CARD MUST LEAVE REACHABLE (ledger T143). Owner request
       T62 moved tree creation into the workspace header plus, straight under
       the intro card's home at the top-left; the acceptance judge measured a
       fresh profile's first click landing on the card (run #310, 2026-09-16).
       The card takes the first corner that keeps these controls clear. */
    keepClear: ['.tree-chat-add', '.tree-chat-chooser', '.comp-topbar .tabs'],
    steps: [
      { title: 'What a computer is', text: 'Here, a computer is one physical or virtual machine that can run assistants for you. This page lists every computer you have connected and what is currently happening on each one.', selectors: ['.comp-topbar .tabs'] },
      { title: 'Choose a computer', text: 'The computer names at the top choose which machine you are viewing. Check the selected name before starting work or changing a setting.', selectors: ['[data-machine-tab]', '.comp-topbar .tabs'] },
      { title: 'What an assistant is', text: 'An assistant is a single program working on a task. On this page, each circle or row you see stands for one assistant and shows whether it is working, waiting, or finished.', selectors: ['.graph-wrap'] },
      { title: 'What a fleet is', text: 'A fleet is a group of assistants working on related pieces of the same goal. A computer can run one fleet or several; the map on this page draws each fleet as its own shape.', selectors: ['.graph-wrap'] },
      { title: 'What a tree is', text: 'A tree is the shape a fleet is drawn in. One assistant sits at the top and coordinates the others. Those other assistants, called branches, carry out smaller pieces of the task.', selectors: ['.graph-wrap'] },
      { title: 'Meet your assistants', text: 'The map groups related assistants into a tree. Select an assistant to read its conversation and see its current task.', selectors: ['.graph-wrap'] },
      { title: 'Follow a branch downward', text: 'Following the lines from the top assistant down to the others shows you who was asked to do what. A branch with no assistants below it is doing its own piece directly.', selectors: ['.graph-wrap'] },
      { title: 'Start a new tree', text: 'Adding a tree begins a new fleet on this computer, separate from any existing ones. Use this when the next piece of work is not related to what is already running.', selectors: ['.tree-chat-add', '.comp-topbar'] },
      { title: 'Choose which tree you are adding to', text: 'When more than one tree is running, the chooser confirms which one a new assistant or message belongs to before you continue.', selectors: ['.tree-chat-chooser'], unavailable: 'The chooser appears when more than one tree is running on this computer. With one tree, new work goes to that tree.' },
      { title: 'Switch between the map and a summary', text: 'Fleet overview, above the map, opens a simpler summary of the trees on this computer, which is useful on a smaller screen. Choose a tree there to go back to its map.', selectors: ['.graph-open-btn'], unavailable: 'Fleet overview appears above the map once this computer is showing its trees.' },
      { title: 'Check what needs you', text: 'The overview brings together work in progress, finished turns, and requests for your attention. A finished turn is a good moment to review the result.', selectors: ['[data-fleet-review]', '[data-fleet-summary]'], unavailable: 'These totals fill in once this computer has assistants that have run. Choose a computer above, then open its overview. A phone shows the map and the overview separately.' },
      { title: 'Read a summary before opening a tree', text: 'The overview’s totals let you decide, before opening the map, whether a tree needs a closer look right now or can wait.', selectors: ['[data-fleet-review]', '[data-fleet-summary]'], unavailable: 'These totals fill in once this computer has assistants that have run. Choose a computer above, then open its overview.' },
      { title: 'Return to one assistant', text: 'Once you find the assistant you are looking for on the map, you can select it. Selecting it opens the same kind of conversation view you would see for it elsewhere in the app.', selectors: ['.graph-wrap'] },
    ],
  },
  agent: {
    name: 'Assistant', title: 'Work with one assistant',
    intro: 'An assistant follows a task and reports back here. You can read its progress, ask a follow-up, and review what it produces.',
    steps: [
      { title: 'What an assistant is', text: 'An assistant is a program that works on the task it was given and reports the result. This page is one assistant’s own conversation, separate from every other assistant’s.', selectors: ['.chat-log', '.chat'] },
      { title: 'Where this assistant fits in', text: 'An assistant can work alone, or as part of a fleet. A fleet is a group of assistants sharing related work, arranged as a tree with a coordinator above it. Computers shows that bigger picture.', selectors: ['.chat-log', '.chat'] },
      { title: 'Read the conversation', text: 'Read the latest reply before giving the next instruction. If something is unclear, ask the assistant to explain it in simpler words.', selectors: ['.chat-log', '.chat'] },
      { title: 'Scroll back for earlier context', text: 'Earlier messages in the same conversation explain why the assistant is doing what it is doing now. Scrolling up before asking a new question avoids repeating instructions it already has.', selectors: ['.chat-log'] },
      { title: 'Notice a question in a reply', text: 'A reply that ends with a question is usually waiting on you. Answer it before sending an unrelated request, so the assistant is not working from a guess.', selectors: ['.chat-log', '.chat'] },
      { title: 'Give a clear next step', text: 'Say what you want to happen next and any limits the assistant should follow. Check the selected assistant before sending.', selectors: ['.chat-input', '[data-compose-field="message"]'], unavailable: 'Messaging becomes available when this assistant has a conversation you can write to. The page explains any setup or permission it still needs.' },
      { title: 'Say what a good result looks like', text: 'A next step is clearer when it names what you want to see when the assistant is done, not only what to start doing.', selectors: ['.chat-input', '[data-compose-field="message"]'], unavailable: 'Messaging becomes available when this assistant has a conversation you can write to. The page explains any setup or permission it still needs.' },
      { title: 'Ask before assuming', text: 'If a reply is missing something you expected, ask directly rather than guessing why. Assistants can only act on what was actually said to them.', selectors: ['.chat-input', '[data-compose-field="message"]'], unavailable: 'Messaging becomes available when this assistant has a conversation you can write to. The page explains any setup or permission it still needs.' },
      { title: 'Review what it produces', text: 'Treat a finished reply as a result to check, not an instruction to trust automatically. Read it the way you would review anyone else’s work before relying on it.', selectors: ['.chat-log', '.chat'] },
      { title: 'When this assistant reports up', text: 'If this assistant is part of a fleet, its finished result may also be summarized to its coordinator. You can still read the full conversation here at any time.', selectors: ['.chat-log', '.chat'] },
    ],
  },
  research: {
    name: 'Research', title: 'Try an idea, one step at a time',
    intro: 'Research helps you compare ways of asking assistants to do a task. Start with one small question and decide what a useful answer should contain.',
    steps: [
      { title: 'Start with one small question', text: 'A research project works best when it compares one clear question. For example, you might ask which of two instructions gets a better answer, rather than many questions at once.', selectors: ['[data-research-area="design"]'] },
      { title: 'Begin with the task', text: 'In Prompt design, Composition is where you describe the work you want to compare. Build task set selects the prompts for your benchmark. A prompt is simply the instruction you give an assistant.', selectors: ['[data-bench-tab="compose"]', '[data-research-area="design"]'] },
      { title: 'Decide what a useful answer contains', text: 'Before you write the tasks, note what you expect a good answer to include. You will use this the same way when you look at results later.', selectors: ['[data-bench-tab="compose"]'] },
      { title: 'Keep the comparison fair', text: 'Give each version of the task the same information and the same limits. Change only the one thing you are testing, so any difference in the results is easier to explain.', selectors: ['[data-bench-tab="compose"]', '[data-research-area="design"]'] },
      { title: 'Review before running', text: 'Run & export brings together the prepared project. Freezing a project saves the exact plan for comparison. Review its tasks and limits before you choose to run it.', selectors: ['[data-bench-tab="run"]'], unavailable: 'The project builder must be available before you can review a prepared run. Follow the availability message on this page.' },
      { title: 'Understand freezing a project', text: 'Freezing keeps the exact wording and settings you reviewed. A later run can then be compared fairly with this one, instead of silently using different tasks.', selectors: ['[data-bench-tab="run"]'], unavailable: 'The project builder must be available before you can review a prepared run. Follow the availability message on this page.' },
      { title: 'Look at what happened', text: 'Runs shows progress. Evidence brings together results and findings. Check the actual answers as well as the numbers before deciding what worked.', selectors: ['[data-research-area="run"]', '#research-runboard-title'] },
      { title: 'Read the evidence, not only the score', text: 'A summary number can hide a wrong or unclear answer. Open the underlying evidence before deciding one version of a task performed better than another.', selectors: ['[data-research-area="run"]'] },
      { title: 'Decide what to try next', text: 'Use what you learned from one small comparison to shape the next question, rather than trying to answer everything in a single project.', selectors: ['#research-runboard-title'] },
    ],
  },
  metrics: {
    name: 'Metrics', title: 'Understand your activity',
    intro: 'Metrics brings together recorded activity and usage. You can start with the overview and explore the details when they are useful.',
    steps: [
      { title: 'Start with the overview', text: 'The page opens on a summary so you can get a sense of recent activity before deciding whether any number is worth a closer look.', selectors: ['#m-filter'] },
      { title: 'Choose what to compare', text: 'Choose a period and a computer so the numbers answer the question you have in mind.', selectors: ['#m-filter'] },
      { title: 'Compare one computer at a time', text: 'If you have more than one computer, filtering to one at a time keeps its numbers from being blended with another computer’s activity.', selectors: ['#m-filter'] },
      { title: 'Read the numbers in context', text: 'About these numbers explains what is included. Missing or incomplete information needs that context before you compare it.', selectors: ['#m-about-numbers'] },
      { title: 'Notice what is not counted', text: 'A number that looks low may simply exclude something you expected it to include. Check About these numbers before concluding activity has actually dropped.', selectors: ['#m-about-numbers'] },
      { title: 'Make the page useful to you', text: 'Edit layout lets you choose the metrics you want to see. Start with a few you understand and add more as you need them.', selectors: ['#m-edit'] },
      { title: 'Remove a metric you do not use', text: 'A page with fewer, well-understood metrics is easier to read than one with everything turned on. Edit layout lets you take one away as easily as adding it.', selectors: ['#m-edit'] },
      { title: 'Revisit your choices later', text: 'As you get more comfortable, return to Edit layout. Add a metric you skipped the first time, now that you know what the simpler view already told you.', selectors: ['#m-edit'] },
    ],
  },
  comms: {
    name: 'Messages', title: 'Follow the conversation',
    intro: 'Messages helps you follow conversations between assistants and services. Choose a conversation to understand what is happening.',
    steps: [
      { title: 'What a channel is', text: 'A channel is one ongoing conversation about a particular piece of work, such as one assistant’s messages with another assistant or an outside service.', selectors: ['.comms-head'] },
      { title: 'Start at the channel list', text: 'The rail on the left lists the channels on this computer. A channel is one conversation about a particular piece of work. Selecting a channel opens its messages beside the list.', selectors: ['.ch-rail', '.ch-list', '.comms-head'] },
      { title: 'Scan the list before opening one', text: 'The channel list is a quick way to see how many conversations exist and roughly what they cover. Scan it before you commit to reading any single one in detail.', selectors: ['.ch-rail', '.ch-list'] },
      { title: 'Find the right conversation', text: 'In the channels view, choose a channel from the list. Check its name and read the recent messages before replying.', selectors: ['.ch-list', '.ch-rail'], unavailable: 'Choose the channels view to see the conversation list. Some views show activity cards instead.' },
      { title: 'Check who the conversation is between', text: 'A channel’s name usually names the two sides of the conversation. Confirming this before reading helps you follow who said what to whom.', selectors: ['.ch-list', '.ch-rail'], unavailable: 'Choose the channels view to see the conversation list. Some views show activity cards instead.' },
      { title: 'Read recent messages in order', text: 'Messages in a channel build on each other. Reading from the oldest visible message forward gives a clearer picture than jumping straight to the latest one.', selectors: ['.ch-list', '.comms-head'] },
      { title: 'Notice a conversation that has gone quiet', text: 'A channel with no recent messages may mean that piece of work has finished, paused, or is waiting on something outside this view.', selectors: ['.ch-rail', '.ch-list'] },
      { title: 'Move between channels', text: 'Selecting a different channel in the rail swaps the messages shown beside it. This lets you compare two conversations without losing your place in the list.', selectors: ['.ch-rail', '.ch-list', '.comms-head'] },
    ],
  },
  ledger: {
    name: 'Ledger', title: 'Keep track of requests and decisions',
    /* The kind tabs, the reach filter and Show removed sit where the intro
       card opens; a first click must land on them, not on the card (T1261). */
    keepClear: ['.ledger-toolbar'],
    intro: 'The ledger is a record you can return to. It brings together requests, decisions, and their current state.',
    steps: [
      { title: 'What the ledger is for', text: 'The ledger keeps a written record of requests and decisions. You, or an assistant, can check what was agreed before, instead of relying on memory.', selectors: ['.ledger-summary'] },
      { title: 'Start with the overview', text: 'The totals show how much work is in each state. They help you find items that need a closer look.', selectors: ['.ledger-summary'] },
      { title: 'Understand a record’s state', text: 'A record’s state shows whether it is still open, answered, or resolved. Checking the state first tells you whether it needs a decision from you right now.', selectors: ['.ledger-summary'] },
      { title: 'Narrow the list', text: 'Choose the kind of record and its scope. Scope describes which part of your work the record applies to.', selectors: ['.ledger-toolbar'] },
      { title: 'Choose a kind of record', text: 'Rules are standing instructions, Tasks are work to finish, Asks are questions from your agents, and Purchases wait for your approval. All shows them together.', selectors: ['.ledger-toolbar'] },
      { title: 'Read before changing a record', text: 'Each row shows its words, its state, who it is for and when it was filed. Read them before you use the buttons under it.', selectors: ['.ledger-record', '.ledger-empty', '.ledger-summary'], unavailable: 'Records appear here as work is recorded. There is nothing to create just to finish this guide.' },
      { title: 'Look for supporting detail', text: 'Under a row you can find an answer you gave, why a rule was resolved, or what a task is waiting on. Show removed brings back deleted and declined records.', selectors: ['.ledger-record', '.ledger-empty'], unavailable: 'Records appear here as work is recorded. There is nothing to create just to finish this guide.' },
      { title: 'Return to check on a decision', text: 'The ledger stays available after a record is resolved, so you can come back later and confirm what was decided and why.', selectors: ['.ledger-summary', '.ledger-record'], unavailable: 'Records appear here as work is recorded. There is nothing to create just to finish this guide.' },
    ],
  },
  settings: {
    name: 'Settings', title: 'Make yourself comfortable',
    intro: 'Start with the everyday controls. You can explore more detail at your own pace, and read what each choice changes before saving it.',
    steps: [
      { title: 'Choose how much detail to see', text: 'Basic keeps the everyday controls in view. Advanced and the other views reveal more detail. Changing the view keeps your saved choices in effect.', selectors: ['.settings-mode-picker'] },
      { title: 'Start with Basic if you are new here', text: 'If you are not sure what a setting does yet, start with Basic. It hides the less common controls, so the page is easier to read while you get comfortable.', selectors: ['.settings-mode-picker'] },
      { title: 'Choose a starting point', text: 'Use the slider or named buttons to prepare a set of working choices, from most to least supervised: Locked, Careful, Balanced, Independent, Autonomous, Autonomous+. Review the listed changes before saving. Changing a setting by hand afterwards keeps the profile name and counts the change. Your permission level and separate access choices still apply.', selectors: ['[data-working-profile] .working-profile-picker', '[data-working-profile]'], unavailable: 'If working profiles are unavailable here, follow the message on this page. You can still review individual settings.' },
      { title: 'Understand what a working profile changes', text: 'A working profile is a named set of choices about how much an assistant can do before checking with you. Moving from Locked toward Autonomous+ hands over more without asking.', selectors: ['[data-working-profile]'], unavailable: 'If working profiles are unavailable here, follow the message on this page. You can still review individual settings.' },
      { title: 'Know when a profile reads Custom', text: 'Changing one setting by hand after choosing a profile keeps its name and adds how many settings differ, for example “Careful · 1 changed”. Custom appears only when no profile was applied and your settings match none of them.', selectors: ['[data-working-profile] .working-profile-picker'], unavailable: 'If working profiles are unavailable here, follow the message on this page. You can still review individual settings.' },
      { title: 'Find the choice you need', text: 'Search for a word such as “text”, “approvals”, or “resources”. Read the description beside each control.', selectors: ['.settings-search'] },
      { title: 'Read a control’s description first', text: 'Each setting has a short description beside it. Reading it before changing the value avoids turning on something you did not mean to.', selectors: ['.settings-search'] },
      { title: 'Review and save', text: 'Review your changes, then choose Save settings. Wait for the saved message. If saving fails, the page explains what still needs attention.', selectors: ['.settings-save-bar'] },
      { title: 'Confirm a save actually happened', text: 'Watch for the saved message after choosing Save settings. Closing the page before it appears risks losing the change you just made.', selectors: ['.settings-save-bar'] },
    ],
  },
  tools: {
    name: 'Tools', title: 'Choose what assistants can use',
    intro: 'Tools give an assistant abilities such as reading information or working with files. You decide which available tools it may use.',
    steps: [
      { title: 'What a tool is', text: 'A tool is one specific ability, such as reading a file or searching the web. An assistant can use it only if you have allowed it. An assistant cannot invent new abilities on its own.', selectors: ['.settings-search'] },
      { title: 'Find a tool', text: 'Search by name, then read the tool’s description so you understand what it does.', selectors: ['.settings-search'] },
      { title: 'Read what a tool actually does', text: 'A tool’s name is often short. Reading its full description before deciding avoids allowing something broader, or narrower, than you intended.', selectors: ['.settings-search'] },
      { title: 'Choose the permission carefully', text: 'Each available tool can be enabled, set to ask first, or disabled. Ask first is useful when you want to review an action. These changes apply to assistants started afterwards.', selectors: ['[data-tool-rows] .settings-row', '[data-tool-count]'], unavailable: 'The tool list must be available before you can change it. Check the message on this page for the next step.' },
      { title: 'Start with ask first', text: 'If you are unsure about a tool, set it to ask first. This lets you see what an assistant wants to do before it happens, rather than allowing or blocking it outright.', selectors: ['[data-tool-rows] .settings-row', '[data-tool-count]'], unavailable: 'The tool list must be available before you can change it. Check the message on this page for the next step.' },
      { title: 'Know this applies going forward', text: 'A permission change takes effect for assistants started after you save it. An assistant already running keeps the permissions it started with.', selectors: ['[data-tool-count]'], unavailable: 'The tool list must be available before you can change it. Check the message on this page for the next step.' },
      { title: 'Review the full list occasionally', text: 'The count of available tools grows over time. Returning here occasionally to review what is enabled keeps the list matching what you actually intend.', selectors: ['[data-tool-count]', '[data-tool-rows] .settings-row'], unavailable: 'The tool list must be available before you can change it. Check the message on this page for the next step.' },
      { title: 'Match tools to the task at hand', text: 'An assistant only needs the tools its current task calls for. Leaving unrelated ones disabled or set to ask first is a simple way to limit what could go wrong.', selectors: ['[data-tool-rows] .settings-row', '[data-tool-count]'], unavailable: 'The tool list must be available before you can change it. Check the message on this page for the next step.' },
    ],
  },
  /* Vault was the one page in the navigation with no guide and no first-visit
     tip (T1566), and it is where a first-time reader most needs one: what the
     vault holds, and who may read each credential. Every sentence here is the
     page's own behaviour, in the words the page itself uses. */
  vault: {
    name: 'Vault', title: 'Keep credentials safe',
    intro: 'The vault holds the credentials your assistants may use, such as keys and sign-in details. Their values stay in the encrypted vault; this page shows their names and who may read them.',
    steps: [
      { title: 'What a credential is', text: 'A credential is a secret an assistant needs to reach another service, such as a key or a password. The vault on this computer keeps each one encrypted.', selectors: ['[data-vault-rows]', '.vault-header'] },
      { title: 'Read the list', text: 'Each row is one saved credential, shown by its name or by a private nickname. The value itself stays in the encrypted vault.', selectors: ['[data-vault-rows]'], unavailable: 'The list appears once the vault on this computer has been read. The message on this page says what to do if it could not be read.' },
      { title: 'Find a credential', text: 'Search by the name shown, or use Show to list only credentials with access restrictions or with private nicknames.', selectors: ['[data-vault-search]', '.vault-toolbar'] },
      { title: 'Choose who may read it', text: 'Open a credential to see which roles may read it. May read lets that role use the credential; Refused keeps it out of reach.', selectors: ['[data-vault-rows]'], unavailable: 'Roles can be chosen once a credential is listed here.' },
      { title: 'A change is saved when you make it', text: 'Each access change is saved as soon as you choose it. The page says which role may read the credential and which cannot.', selectors: ['[data-vault-rows]'], unavailable: 'Roles can be chosen once a credential is listed here.' },
      { title: 'Give it a private nickname', text: 'A nickname replaces the real name of the record for assistants and on this screen, so the real name stays private. Clear it to show the real name again.', selectors: ['[data-vault-rows]'], unavailable: 'A nickname can be set once a credential is listed here.' },
      { title: 'Add or remove a credential', text: 'Add credential, at the top of the page, saves a new one. Add or remove credentials, under the list, is where one is deleted.', selectors: ['[data-vault-open-add]', '[data-vault-manage]'] },
      { title: 'Read it again after changes elsewhere', text: 'If the vault was changed in another window, press Refresh to read it again before you decide anything here.', selectors: ['[data-vault-refresh]', '.vault-toolbar'] },
    ],
  },
  account: {
    name: 'Account', title: 'Your account, at your pace',
    intro: 'Your account page shows the sign-in options and account actions available here. Follow the instructions for the option you choose.',
    steps: [
      { title: 'Check your sign-in state', text: 'Read the account name or the sign-in instructions before continuing. Enter passwords only in the sign-in form; keep them out of conversations with assistants.', selectors: ['[data-account-section]'], unavailable: 'The website may open its account page separately. Continue with the sign-in instructions there.' },
      { title: 'Why passwords stay out of chat', text: 'A conversation with an assistant is not the sign-in form. Typing a password there could save it somewhere it should not be, so this page keeps the two separate.', selectors: ['[data-account-section]'], unavailable: 'The website may open its account page separately. Continue with the sign-in instructions there.' },
      { title: 'Confirm which account is active', text: 'If you use more than one account, checking the account name here before continuing avoids acting under the wrong one.', selectors: ['[data-account-section]'], unavailable: 'The website may open its account page separately. Continue with the sign-in instructions there.' },
      { title: 'Take your time with account changes', text: 'Read the explanation beside an account action before you confirm it. When you finish on a shared computer, use the account’s sign-out control.', selectors: ['[data-account-section]'] },
      { title: 'Understand what an action affects', text: 'Some account actions, such as changing a plan or removing access, affect every assistant tied to this account. Reading the explanation first tells you the scope.', selectors: ['[data-account-section]'] },
      { title: 'Sign out on a shared computer', text: 'On a shared computer, sign out when you finish. This prevents the next person from acting or having work recorded under your name. Signing out does not hide your agents or their conversations: they belong to this computer, and anyone using it can open them.', selectors: ['[data-account-section]'] },
      { title: 'Know where to come back', text: 'This page is the place to return to whenever you want to check your sign-in state or review an account action. Come back here rather than searching through settings.', selectors: ['[data-account-section]'], unavailable: 'The website may open its account page separately. Continue with the sign-in instructions there.' },
      { title: 'Ask before assuming an action is reversible', text: 'Not every account action can be undone. If the explanation beside it does not say, treat it as permanent until you have confirmed otherwise.', selectors: ['[data-account-section]'] },
    ],
  },
})

export const GUIDE_STORAGE_KEY = 'mc.set.feature_guides.v1'

// This is a UI preference, routed through the same durable account-aware store
// as appearance. A refusal must not prevent dismissal in this session.
export function createGuidePreferences(storage) {
  const sessionSeen = new Set()
  let quietThisSession = null
  function read() {
    try {
      const value = JSON.parse(storage?.getItem(GUIDE_STORAGE_KEY) || 'null')
      if (value?.version === 1 && typeof value.seen === 'object' && value.seen !== null && !Array.isArray(value.seen)) {
        return { version: 1, quiet: value.quiet === true, seen: Object.fromEntries(Object.keys(FEATURE_GUIDES).filter(key => Object.hasOwn(value.seen, key) && value.seen[key] === true).map(key => [key, true])) }
      }
    } catch { /* unavailable or malformed preferences: use this session */ }
    return { version: 1, quiet: false, seen: {} }
  }
  function write(value) {
    try {
      if (!storage) return false
      storage.setItem(GUIDE_STORAGE_KEY, JSON.stringify(value))
      return true
    } catch { return false }
  }
  const isQuiet = () => quietThisSession ?? (read().quiet === true)
  return {
    isQuiet,
    shouldOffer(name) { const value = read(); return Object.hasOwn(FEATURE_GUIDES, name) && !isQuiet() && !sessionSeen.has(name) && !Object.hasOwn(value.seen, name) },
    seen(name) {
      if (!Object.hasOwn(FEATURE_GUIDES, name)) return false
      sessionSeen.add(name)
      const value = read()
      // Retain only known guide IDs. No arbitrary object keys or unbounded log.
      const seen = Object.fromEntries(Object.keys(FEATURE_GUIDES).filter(key => Object.hasOwn(value.seen, key) || key === name).map(key => [key, true]))
      return write({ version: 1, quiet: value.quiet === true, seen })
    },
    quiet(value) {
      const quiet = value === true, saved = write({ ...read(), quiet })
      // Successful writes are reread, including changes from another window.
      // A refused write keeps the promised preference for this visit instead.
      quietThisSession = saved ? null : quiet
      return saved
    },
    resetSession() { sessionSeen.clear(); quietThisSession = null },
  }
}
