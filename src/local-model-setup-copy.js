/* THE WORDS AROUND A MODEL ON THE PERSON'S OWN COMPUTER.
 *
 * WHY THIS IS ITS OWN FILE AND NOT MORE LINES IN account-panel-copy.js. That
 * file is titled for what it is -- the account panel's warnings and the two
 * sign-in buttons every CLI program shares. A local runtime shares neither:
 * it has no account and no sign-in (local-node-runtime.js's own header:
 * "NO CREDENTIAL, ANYWHERE ON THIS PATH"), so folding its copy into that file
 * would either stretch a name that is accurate today into one that is not, or
 * bury an unrelated vocabulary inside a file a reader opens expecting
 * sign-ins. src/first-run-needs.js's own rule stands regardless of which file
 * holds the sentence: src/views/guide.js is a renderer, and copy inside a
 * render function is copy the plain-language gate and the suites cannot walk.
 *
 * WHAT THIS FILE MAY NOT CLAIM. Provider-neutral production (owner ruling):
 * local is never described as lesser than a hosted provider, and nothing here
 * may suggest a hosted program is the default or the "real" choice. Bring-
 * your-own (owner ruling): every sentence about downloading weights says a
 * runtime the person already has does the downloading -- this product ships
 * none of it.
 */

export const LOCAL_MODEL_SETUP = Object.freeze({
  heading: 'A model on this computer',

  /* THE FOUR READINESS STATES, in the same three-plus-one shape presence
     sentences already use elsewhere on this page: a definite yes, a definite
     "not yet" with the fix named, and "could not check" held apart from both
     so it is never read as either verdict. */
  ready: (selected) => `${selected && selected.displayName ? selected.displayName : 'A runtime'} is running on this computer and already holding a model. The Launch controls and Team panels on the computers page can send it work now.`,
  notReady: 'Nothing on this computer is currently serving a local model.',
  unknown: 'This copy could not check whether a local model runtime is running here. This does not mean one is absent; try again in a moment.',

  /* THE TWO BUTTONS. "Always offered, never disabled by a guess" is the same
     rule signInSlotMarkup already follows for the three CLI programs -- the
     shell answers the specific refusal when a press cannot work, rather than
     this page predicting one. */
  installButton: 'Install Ollama',
  installLead: 'One press downloads Ollama from its own maker\'s channel and installs it for you. ToolsEnabled does not ship it or change it.',
  installRunning: 'The installer is running. What it prints appears below, and it can take a few minutes.',
  installDoneFail: 'The install stopped without finishing. Its own words are above; press the button to try again.',
  installUnavailable: 'Install is unavailable because the copy installed on this computer has no local-model install action. Update ToolsEnabled, then try again.',

  downloadButton: 'Download',
  downloadLead: (label) => `One press downloads ${label}'s weights through Ollama. Nothing is sent anywhere else; the download runs on this computer.`,
  downloadRunning: 'The download is running. What it prints appears below, and a large model can take a long time.',
  downloadDoneFail: 'The download stopped without finishing. Its own words are above; press the button to try again.',
  pullUnavailable: 'Download is unavailable because the copy installed on this computer has no local-model download action. Update ToolsEnabled, then try again.',

  stopButton: 'Stop',
  stopped: 'That was stopped. Press the button to start it again.',
  stopUnavailable: 'Stop is unavailable because the copy installed on this computer has no stop action for local models. Update ToolsEnabled before starting one.',

  refused: 'That could not be started. Press the button again in a moment.',

  /* THE FIT SENTENCE, PER CURATED MODEL. `minFreeVramBytes` rides straight
     off local-node-runtime.js's own CURATED_MODELS table -- this file adds
     only the words, never the number. A model with no known figure gets the
     honest "not known" answer rather than an invented one; LOCAL-MODELS.md
     names this explicitly for community/unknown models, and the same rule
     holds even inside the curated four in case the table ever carries one
     without a measured figure. */
  vramNeeded: (giB) => `needs at least ${giB} GiB free VRAM`,
  vramUnknown: 'the free VRAM this needs is not known',

  /* WHAT THE PAGE SAYS WHILE NOTHING HAS ANSWERED YET, mirroring
     providerMarkup's own rule for the sign-in slots: never "checking…", never
     a guess, an empty slot until the real answer arrives or stays hidden for
     good. This file's own value is never painted alone; guide.js reads it
     only through the note above. */
})

/* THE "Set up local models" POPUP (src/local-setup-popup.js).
 *
 * The popup draws only what this computer still lacks before a Local agent
 * can start. So every step below is said only when the computer still needs
 * it, and every refusal names the next thing to press. The machine half
 * (shell/local-model-setup.cjs) answers in codes and numbers; the words are
 * all here, where the plain-language gate reads them. */
export const LOCAL_SETUP_POPUP = Object.freeze({
  title: 'Set up local models',
  openButton: 'Set up local models',
  entryLead: 'Get Ollama, start it and download a model. Only the steps this computer still needs are shown.',
  checking: 'Checking this computer…',
  unreadable: 'This window could not check this computer. Press Check again in a moment.',
  noBridge: 'Open the ToolsEnabled desktop app to set up local models.',
  close: 'Close',
  done: 'Done',
  checkAgain: 'Check again',
  cancel: 'Cancel',
  background: 'Closing this window does not stop a download. Open Set up local models again to see it.',
  stepNames: Object.freeze({ install: 'Get Ollama', start: 'Start Ollama', choose: 'Choose a model', finish: 'Ready' }),
  stepOf: (index, count) => `Step ${index} of ${count}`,
  stepDone: 'done',

  installLead: 'Ollama runs AI models on this computer. It is free and comes from its makers’ own release page.',
  installHow: Object.freeze({
    linux: 'ToolsEnabled downloads it, checks it against the checksum its makers publish, and keeps it in its own folder. No administrator password is needed.',
    win32: 'ToolsEnabled downloads Ollama’s installer and checks it against the checksum its makers publish. Then you run it. It installs for your account only.',
    darwin: 'ToolsEnabled downloads the Ollama app, checks it against the checksum its makers publish, and keeps it in its own folder.',
  }),
  installButton: 'Download Ollama',
  release: 'Finding the newest Ollama release…',
  downloading: (done, total) => (total ? `Downloading Ollama: ${done} of ${total}.` : `Downloading Ollama: ${done} so far.`),
  verifying: 'Checking the download against the published checksum…',
  unpacking: 'Unpacking Ollama into the ToolsEnabled folder…',
  installed: version => `Ollama ${version} is installed.`,
  installerReady: 'The installer is downloaded and checked. Press Run the installer and follow its steps.',
  runInstaller: 'Run the installer',
  installerRunning: 'The installer is open. Finish it there; this window carries on by itself.',
  installUnsupported: 'ToolsEnabled has no Ollama download for this computer. Install Ollama from ollama.com, then press Check again.',

  startLead: address => `Ollama is installed but is not answering at ${address}.`,
  startButton: 'Start Ollama',
  starting: 'Starting Ollama…',
  startedHere: 'ToolsEnabled started Ollama and stops it when ToolsEnabled closes.',
  /* Ollama keeps running when its log cannot be written; only the log stops. */
  logUnsaved: Object.freeze({
    LOCAL_SETUP_LOG_DISK_FULL: 'Ollama is running, but its log is not being saved because the disk is full. Free some space to keep a record of what it prints.',
    LOCAL_SETUP_LOG_WRITE_FAILED: 'Ollama is running, but its log is not being saved because ToolsEnabled could not write the log file.',
  }),
  remote: address => `The Local models address points to another computer: ${address}. Start Ollama there, then press Check again.`,
  unusable: address => `The saved Local models address cannot be used: ${address}. Open Settings, Local models, and enter an address such as http://127.0.0.1:11434.`,

  chooseLead: 'Pick a model. Models that fit your graphics card answer fastest.',
  machine: ({ ram, gpu, vram }) => (gpu
    ? `This computer has ${ram} of memory and ${gpu} with ${vram}.`
    : `This computer has ${ram} of memory. No graphics card memory could be read.`),
  heldHeading: 'Already on this computer',
  offeredHeading: 'Ready to download',
  downloaded: 'Already downloaded',
  size: size => `${size} download`,
  heldSize: size => `${size} on disk`,
  recommended: 'Suggested',
  fit: Object.freeze({
    gpu: 'Fits your graphics card',
    cpu: 'Runs partly on the processor, so replies are slower',
    'too-big': 'Too large for this computer',
    unknown: 'How well it fits is not known',
  }),
  tight: 'Little memory is free right now. Close other programs before using it, or pick a smaller model.',
  useButton: 'Use this model',
  downloadButton: 'Download and use',
  pickFirst: 'Pick a model first.',
  pulling: (label, done, total) => (total ? `Downloading ${label}: ${done} of ${total}.` : `Downloading ${label}…`),
  pullDone: label => `${label} is downloaded.`,
  summaries: Object.freeze({
    'qwen2.5:0.5b-instruct': 'Smallest and quickest. Good for a first try; its answers stay simple.',
    'qwen2.5:3b-instruct': 'Small and fast. Fine for short, everyday tasks.',
    'qwen2.5:7b-instruct': 'Balanced. Good general answers, and it can use tools.',
    'qwen2.5-coder:7b': 'Made for code. Writes and explains programs.',
    'llama3.1:8b': 'Strong general writing, and it can use tools.',
  }),
  genericSummary: 'A model from the Ollama library.',

  finishLead: 'Last step: save where Ollama answers and which model new Local agents use.',
  finishButton: 'Finish setup',
  saving: 'Saving the address and the default model…',
  checkingReady: 'Checking that a Local agent can start…',
  cpuPolicy: 'This model runs partly on the processor. Finishing allows that for local models, so replies can be slower.',
  replaces: (provider, address) => `This replaces your current AI service setting: ${provider} at ${address}.`,
  ready: (model, address) => `Ready to use. New Local agents use ${model} at ${address}.`,
  alreadyReady: (model, address) => `Local models are ready. New Local agents use ${model} at ${address}.`,
  another: 'Choose another model',
  saveRefused: 'The settings were not saved. Press Finish setup to try again, or open Settings, Local models.',
  notReadyYet: 'A Local agent still cannot start. Press Check again, or pick another model.',

  /* One sentence per code the machine half answers with. A code with no
     sentence here gets `fallback`, which still says what to do. */
  refusals: Object.freeze({
    LOCAL_SETUP_NETWORK: 'The download could not reach Ollama’s release page. Check the internet connection, then try again.',
    LOCAL_SETUP_SOURCE_REFUSED: 'The download was sent somewhere other than Ollama’s official release page, so it was stopped. Try again later.',
    LOCAL_SETUP_RELEASE_UNKNOWN: 'The newest Ollama release could not be found. Try again in a few minutes.',
    LOCAL_SETUP_CHECKSUM_UNPUBLISHED: 'Ollama’s release page lists no checksum for this download, so it was not used. Try again later.',
    LOCAL_SETUP_CHECKSUM_MISMATCH: 'The download did not match the checksum Ollama publishes, so it was deleted. Press Download Ollama to try again.',
    LOCAL_SETUP_ARCHIVE_INVALID: 'The Ollama download could not be unpacked, so nothing was kept. Press Download Ollama to try again.',
    LOCAL_SETUP_WRITE_FAILED: 'The Ollama download could not be saved on this computer, so nothing was kept. Check that the disk has free space and ToolsEnabled can write to its folder, then press Download Ollama.',
    LOCAL_SETUP_CANCELLED: 'Stopped. Nothing was kept from that download; press the button to start again.',
    LOCAL_SETUP_BUSY: 'That is already running. Wait for it to finish, or press Cancel.',
    LOCAL_SETUP_PLATFORM_UNSUPPORTED: 'ToolsEnabled has no Ollama download for this computer. Install Ollama from ollama.com, then press Check again.',
    LOCAL_SETUP_INSTALLER_MISSING: 'The checked installer is no longer there. Press Download Ollama to get it again.',
    LOCAL_SETUP_INSTALLER_FAILED: 'The installer did not finish. Press Run the installer to try again.',
    LOCAL_SETUP_NOT_INSTALLED: 'Ollama is not on this computer yet. Press Download Ollama first.',
    LOCAL_SETUP_NOT_RUNNING: 'Ollama is not answering. Press Start Ollama, then try again.',
    LOCAL_SETUP_START_FAILED: 'Ollama did not start. Press Start Ollama to try again, or restart this computer if it keeps stopping.',
    LOCAL_SETUP_PORT_IN_USE: 'Another program is using that address. Close it, or change the address in Settings, Local models.',
    LOCAL_SETUP_ADDRESS_REMOTE: 'The Local models address points to another computer. Start Ollama there, then press Check again.',
    LOCAL_SETUP_ADDRESS_UNUSABLE: 'The saved Local models address cannot be used. Correct it in Settings, Local models, then press Check again.',
    LOCAL_SETUP_ISOLATED: 'This test copy only uses the Ollama it downloads itself. Press Download Ollama to get one.',
    LOCAL_SETUP_ENGINE_UNAVAILABLE: 'This copy of ToolsEnabled cannot do this step. Update ToolsEnabled, then try again.',
    LOCAL_SETUP_MODEL_INVALID: 'That model name cannot be used. Pick a model from the list.',
    LOCAL_SETUP_PULL_UNKNOWN_MODEL: 'Ollama does not know that model. Pick another model from the list.',
    LOCAL_SETUP_PULL_NETWORK: 'The model download stopped because the connection dropped. Press Download and use to carry on where it stopped.',
    LOCAL_SETUP_PULL_FAILED: 'Ollama could not finish the download. Press Download and use to try again.',
    LOCAL_SETUP_PULL_DISK_FULL: 'The disk filled up during the download. Free some space, then press Download and use to carry on.',
    LOCAL_NODE_RUNTIME_UNAVAILABLE: 'Ollama is not answering at the saved address. Press Check again, or start Ollama first.',
    LOCAL_NODE_MODEL_NOT_INSTALLED: 'The saved model is not downloaded. Pick a model to download it.',
    LOCAL_NODE_SETTINGS_INVALID: 'A Local models setting cannot be read. Open Settings, Local models, and check the values.',
  }),
  diskFull: (need, free) => `There is not enough free space: this needs ${need} and ${free} is free. Free some space, then try again.`,
  ollamaSaid: words => `Ollama said: ${words}`,
  fallback: 'That did not work. Press Check again, or close this window and try again later.',
})
