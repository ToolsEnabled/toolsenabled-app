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
