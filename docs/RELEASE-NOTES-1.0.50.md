# ToolsEnabled `1.0.50`

*Released `2026-10-14`*

This release follows Anthropic's and OpenAI's rules for apps that run their agents. Claude Code and Codex run as
they are, under your own sign-in, and ToolsEnabled never reads, copies or stores their sign-ins. It also includes
everything that was planned for 1.0.49: plugins and a video box under each agent's box. The size and SHA-256 of
each download are listed beside it on the download page.

## Highlights

- Your sign-ins stay with each provider's own app. You sign in to Claude Code and Codex through their own sign-in.
  ToolsEnabled starts Claude Code unchanged, with the sign-in methods it offers. Codex agents use the `codex login`
  sign-in in the folder of the account you chose.
- One account per agent. When an account reaches a usage limit, ToolsEnabled tells you instead of moving the agent
  to another account. You choose what happens next.
- Every chat says at its start that you are talking with an AI.
- Plugins: put a plugin folder in place, then choose on the Plugins page what it may do. Adding one allows it nothing.
- Video under an agent's box: in Boxes view, show a window you pick under that agent.
- Type any model name your account offers. Other model… sits under every provider in New agent, the composer and
  Switch model.
- A new look. The app's text is set in Geist, and its themes, buttons, fields and cards match on every page. Home
  shows what your agents are doing and what needs you, without the animated circle.

## Added

- Each chat, new or reopened, and after you switch its agent or model, starts with a line saying you are talking
  with an AI.
- A Plugins page, reached from the Tools page. With no plugin added it says "No plugins added" and names the folder
  to put one in.
- A plugin can add tools, roles, settings of its own and a few colours. Each thing it asks for is a separate tick box,
  and all start unticked.
- Every tick box says what it allows and what it risks. Limits a plugin claims for itself are shown as its own words,
  not as something ToolsEnabled enforces.
- A plugin's tools run as separate programs, each starting in a folder of its own. ToolsEnabled does not pass them
  your provider keys or sign-ins. But a program you allow runs as you. It can read any file you can, including
  sign-in files, and it can use the network even if Reach the network is left unticked.
- Change any file in a plugin's folder and it is treated as a new plugin, with nothing allowed. That includes the
  folders it keeps its dependencies and caches in. You are asked again. Its tools stop running at once, before any
  restart.
- Every file in a plugin's folder counts, including .git and node_modules. So install a plugin from its release
  archive or a shallow copy. A folder with more than 2,000 files or 32 MB is refused.
- Withdraw everything removes a plugin's tools and roles after a restart. The entry stays and says it was withdrawn.
  An agent that held one of its roles works as a Worker, and the Roles panel says so.
- The Plugins page says when a plugin you allowed did not start when ToolsEnabled opened, and why.
- A plugin's roles appear in the role library, named with the plugin they came from. A role you wrote with the same
  name wins, and the Plugins page says so. A plugin's role cannot be edited.
- Other model… under every provider in New agent, the composer and Switch model. Type the exact model name; it is
  shown and sent as you typed it.
- New model rows: GPT-6.1-Sol under Codex, and Sonnet 5.5 and Haiku 5.5 under Claude.
- Video for an agent. Press the mic button on an agent's box: the Video section sits under the Computer control
  card. Video is off for every agent until you turn it on.
- Press Turn on video, then pick one of this computer's windows. A panel as wide as the box appears under it, in
  Boxes view.
- Turn off video forgets that agent's window, and Turn off all video forgets every one.
- After a restart the panel asks you to pick the window again. One press opens the list with the closest title first.
  Nothing plays until you pick.
- To show what a container draws, give it its own small window. The source code, published at
  github.com/ToolsEnabled/toolsenabled-app, explains how in docs/agent-voice-and-screen-controls.md, under
  "A small display for a container".
- Getting started explains how to update: on Windows from inside the app, on Linux by installing the new .deb.

## Changed

- Automatic account switching is removed. An agent runs only on the account you chose for it. When that account
  reaches a limit, the agent stops and says so. Wait for the limit to reset, or choose another of your accounts
  for that agent yourself. Other agents cannot move it to another account or provider. "Keep trying accounts",
  the switching rules and the "move agents off an account" levels are gone from Accounts, setup and Computers.
  Settings saved by an earlier version for them are ignored.
- Each agent shows the account it runs on, in its Details, in its chat and card headers, and in a New agent tab's
  header.
- Claude Code starts with the sign-in you set up in your own Claude Code settings. That includes an API key, a cloud
  provider or a key helper. ToolsEnabled no longer removes those settings before starting it, and no longer
  moves Claude sign-in files between folders. Accounts shows a Claude account with no saved sign-in as such, not as signed out.
- On Windows, the Claude Code folder set with `CLAUDE_CONFIG_DIR` is used wherever it is on this computer, including
  the top of a drive such as E:\. A folder in another Windows account is not used, and a Claude agent that needs it
  says so.
- 1.0.48 kept copies and links of your Claude, Codex and Gemini sign-ins in ToolsEnabled's own agent folders.
  When you update, ToolsEnabled deletes them. Your sign-ins in each provider's own folder stay where they are. The
  diagnostics keep a record of how many were removed.
- Codex agents run on the Codex sign-in folder of the account you chose. A Codex folder or API key set in your
  environment is not used. ToolsEnabled no longer copies or links
  that sign-in into a folder of its own. The limits ToolsEnabled sets for an agent are passed to Codex when it
  starts. MCP servers you added to Codex yourself are turned off for those agents.
- Codex Cloud: you type the ID of the environment to use. ToolsEnabled starts the task through the official codex
  command on the account you pick. ToolsEnabled no longer reads your Codex sign-in to list environments. An
  environment you typed is shown as entered by you, not as confirmed by OpenAI.
- Gemini: ToolsEnabled no longer reads the Gemini CLI's sign-in to measure your allowance, and no longer asks
  Google for it directly. Gemini agents still run in the Gemini CLI under your own sign-in. Accounts shows a Gemini
  allowance as unknown.
- Research studies: a Claude, Codex or Gemini command-line draw uses that provider's API key, set in the run's
  environment. The exported study's README names each one. Sign-ins are no longer copied into the study's room. A
  draw without its key stops and names what to set.
- Any model name you type or pick is kept and sent exactly as written, including names with slashes. A model your
  account cannot run is refused by the provider at your first message. Claude and Codex show the provider's own
  reason; Gemini and Grok say only that the provider refused the model.
- The mic button's panel is now called "Voice, screen & video", and the button's own name says so too.
- Plugin changes take effect the next time you open ToolsEnabled.
- The video is shown only on your screen. ToolsEnabled does not record it or send it to the agent. An agent you
  allow to take screenshots, for example with Computer control, can see a video panel like anything else on your
  screen. The window's title is kept on this computer until you turn video off.
- Agent app control cannot press the Video section, the list of windows or a video panel.
- The Windows in-app update now runs a downloaded installer only if it is signed by ToolsEnabled, Inc. It no longer
  asks you to check the publisher yourself.
- After you press Check now, ToolsEnabled tells you when you already have the newest version, or that it could not
  tell. Checks it makes on its own stay silent.
- Installers left by earlier in-app updates are removed the next time ToolsEnabled opens on Windows.
- Settings → Data & Privacy now says that the uninstall choice is used by the Windows uninstaller. Removing the
  Linux package always keeps your data.
- The Linux package now has a one-line summary, the devel section and ToolsEnabled, Inc. as its vendor.
- Links in a chat, and other links to pages outside ToolsEnabled, now open in your web browser instead of a window inside
  the app. The subscribe page's checkout and manage links also open there, and the app stays where it was. A link that
  holds a user name and password, or is not a web address, does nothing. A link to a page inside ToolsEnabled still
  opens in the app. Opening one in a new window, as with Ctrl+click or a middle click, does nothing.
- At the Guided and Standard permission levels, Claude Code no longer loads the project folder's own Claude settings.
  That includes their hooks and the tools they allow. It also no longer loads that folder's CLAUDE.md, skills, agents and
  commands. Your own Claude Code settings and sign-in still load. Unrestricted is unchanged.
- A Guided or Standard agent is no longer given ToolsEnabled's own program folder as an extra folder it can edit. Only
  an Unrestricted agent still gets it, so project skills keep working there.
- A Claude agent started with Dispatch now always gets the tool list that ToolsEnabled writes for it. A tool list file in
  the folder it works in is no longer used.
- The app has a new look. Text is set in Geist, and code, names and times in Geist Mono. Buttons, fields, menus,
  sliders and cards share one size and shape on every page.
- The five themes keep their names, and a theme you chose before stays chosen. White and Tan are light. Black,
  Ember and Cobalt are dark. Ember and Cobalt are now plain red and blue tints, without the glow they had.
- Geist is now the default font and the first in the list. If you chose a font before, your choice is kept.
- Home no longer shows the animated circle or the clock inside it. It shows a header with New agent and Open
  computers, then four tiles: Working now, Need you, Ledger and Runs recorded. The counts and their meanings are
  the ones Home already had. Need you lists those agents when you press it. The Ledger tile says whether items
  are blocked or waiting for your review, or that nothing is waiting, and opens the Ledger. It also says when the
  Ledger is still being checked or could not be read.
- Under the tiles, a Following card shows the agent you follow: its name, status, latest activity line, Open chat
  and Change. With no agent followed it offers Choose an agent. The Voice card keeps the voice controls, and the
  Activity list keeps its filters, search, rows, Chat and Details actions and Full view.
- Four settings are gone: Home circle, Home circle motion, Clock in the circle and Glow intensity. They are no
  longer in Settings or Quick settings, and values saved for them by an earlier version are ignored. Reduce
  motion stays.
- The three Home colour choices are kept under new names: "Home: nothing waiting", "Ledger: owner requests" and
  "Ledger: blocked". A colour you set still applies. A colour left on automatic now matches your theme.

## Fixed

- A Claude model name that contains a slash, such as a cloud inference profile, is no longer shortened before it is
  sent.
- After you press Reject or Confirm in a confirmation panel, the keyboard focus stays on a usable control.
- Sign-in problems, setup errors and diagnostics no longer include secret values.
- A Codex agent's private session value is no longer on its command line, where other programs on the computer
  could read it.
- After you stop an agent, your next message continues the same conversation on the same account. Before, it could
  start a new conversation that had lost what was said.
- When a saved conversation cannot be resumed, the message now says why and what to do, instead of a general
  failure.
- Chats saved by 1.0.48, including New agent tabs, continue their own conversations after the update.
- A model name your Codex account cannot run is refused with Codex's own reason.
- On Windows, Codex agents at the Standard level now start when Codex was installed with npm through nvm-windows,
  scoop or another npm folder. Before, they stopped and said the command line was too long.
- A provider's refusal is shown as a refusal, and no queued or helper message is sent after it automatically.
  After the provider refuses an agent's model, they wait until a message you send to it is answered. A New agent tab
  keeps its model, so its held messages say to Unqueue them, choose another model and press Stop.
- Metrics lists turns on a model name you typed under that name, not under the provider's default model. A typed
  name that contains \, / or :, or is longer than 64 characters, shows as "Other model".
- In a New agent tab, queued messages no longer go to an account that has reached its usage limit. They wait,
  say why, and go after your next message is answered.
- When an agent in a tree reaches its account's usage limit, the tree stops giving it work and tells its manager once.
  Before, work could keep going to that account.
- The usage-limit line in a chat now says to use Switch and continue to move that agent, not the Accounts menu.
  A New agent tab is added to a tree first.
- Removing an account whose folder Accounts made now warns that its saved sign-in is deleted too, and says so
  afterwards. Before, the screen said the sign-in stays.
- Three messages that said only that something was unavailable now also say what to do next.
- At your desk, the Account page now says "this computer" where you sign out, change your password or remove this
  program's data. It no longer says "the computer you are driving" there.
- An agent that starts helpers and quotes the reply it expects as its reason is no longer refused. That includes a
  single word, such as KIWI, or "pong" after a word like answers or replies.
- Getting started now gives the support address, support@toolsenabled.ai, and says where the source code is
  published on GitHub.
- Getting started now says what uninstalling does with your data: Windows asks unless Settings already has your
  answer, and Linux keeps everything.
- Pages opened from links no longer get permissions inside the app. Only ToolsEnabled's own page can use the microphone,
  the camera, screen sharing or notifications.
- Full Remote Access: when this computer renews its connection to the relay, it now signs only a fresh random code, and
  only once each time. Before, the relay could get it to sign other data with this computer's key.
- The tool that saves a Google Cloud service account key now saves it only under its own name. Before, an agent could use
  it to replace other secrets you saved. Checking a Stripe webhook now reads only the saved Stripe webhook secret.
- On Windows, the commands a program uses to save a secret can no longer replace your saved payment card or legal identity.
- On Windows, ToolsEnabled no longer runs a git.exe that sits in a project folder. That includes the folder you pick
  for a workspace, a project an agent works in and an agent's own folder. It uses the Git installed on the computer. A
  Git found only through a relative folder in PATH is now shown as not installed.
- On Windows, a command an agent runs with the cmd shell now runs as written when it contains double quotes. A program
  path with spaces is one example. Before, cmd reported a wrong file name or printed extra backslashes.
- On Windows, ToolsEnabled now opens when your home drive is a network drive or another folder, as on many work and
  school computers. It also opens when `HOME` is outside your user folder, as with MSYS2 or Cygwin, or a Java setting
  names your user folder. Before, it refused to start. A path in another Windows account is still refused. That
  includes a user folder with your name on another drive, such as D:\Users\<your name>: only the user folder you
  signed in to is yours.
- On Linux, if a later update fails while it installs, ToolsEnabled stays set up. Before, it was left half set up
  until you ran sudo dpkg --configure -a.
- On Windows, an in-app update now starts the installer only after ToolsEnabled has closed. Before, the installer
  could end ToolsEnabled while it was still closing, and an unsaved Settings change could be lost. If you keep
  ToolsEnabled open instead, the update does not start.
- If you start an agent while an in-app update downloads, ToolsEnabled now asks again before it closes for the update.
  Keep working keeps the download for next time.
- The Windows in-app update now works on computers where an App Control or AppLocker policy limits PowerShell. Before,
  every update there was refused as not signed.
- When ToolsEnabled runs as administrator, the update check now names a new version and says to open ToolsEnabled
  normally to install it. It says this once for each new version. Before, ToolsEnabled closed and setup then refused
  to run.
- The Windows in-app update now works when the name of your user folder has a curly apostrophe, as in D’Angelo.
  Before, every update was refused as not matching.
- On Windows, uninstalling from Settings > Apps now asks whether to remove your saved data when you have not chosen in
  ToolsEnabled's Settings. Before, it kept the data without asking and left a note saying nobody could be asked.

## Known issues

- At the Guided permission level, a plugin's tools are listed as not allowed, even after you allow them. Tools that
  run programs need a level that allows writing files.
- There is no way to add, update or remove a plugin from inside the app yet. You move its folder yourself. If two plugins
  you allow have the same name, only the one whose folder name comes first gets its tools. The other's card says why.
  Withdraw the old version when you update.
- A plugin's own settings are shown with their defaults, but they cannot be changed yet, and the plugin is not told
  their values.
- A plugin cannot be given secrets or write to the record yet. Those two tick boxes say so.
- Each version of a plugin keeps its records in a folder of its own, so an update starts with none. Removing a
  plugin does not remove its records.
- In the role workspace, a plugin's role is labelled Custom and offers Save, which is then refused. Its wording
  cannot be edited there. Use Duplicate to make a role of your own from it.
- The limits a plugin claims for itself, and its own settings, are shown only after you allow Add settings of its
  own.
- Video works only in Boxes view. There are no panels in Circles, in edit mode, on group boxes, or in the paired
  window.
- Video needs Windows or a Linux desktop that uses X11. It does not work on a Linux Wayland desktop, in a browser or
  on the phone.
- Up to 6 videos can play at once, each at most 854 × 480 and 10 frames a second. The cost depends mostly on the
  size of the windows you show. In our test, six 640 × 360 windows used up to about a sixth of one processor core.
  Six 1280 × 720 windows used up to about two fifths of a core, and larger windows cost more.
- A video that is not shown anywhere for 10 minutes stops. Press Click to resume to start it again. If that
  window was renamed, minimized or closed, pick it again from the list. On Linux, a minimized window is not in
  the list until you restore it.
- The list of windows shows at most 40 windows. When there are more, it says so.
- The window list's thumbnails can show a window that covers the one you want. The video shows only the window you
  picked.
- The video box has one known gap. For a few seconds after a click in ToolsEnabled, a fault inside the app's own
  page could start one short screen capture. ToolsEnabled then reloads its window within about a second, which ends it.
- Tabs lost when 1.0.47 or earlier closed are not recovered.
- A model your account cannot run is refused only at your first message, not when you type its name. Gemini and
  Grok then say only that the provider refused the model, not why.
- Adding a reopened New agent tab to a tree carries at most its newest 2,000 messages. The rest stay saved.
- Gemini models that need an Antigravity account are offered before an account is set up. The first message then
  asks you to add one in Accounts.
- If a delete at exit is interrupted, Settings says so, and task filing can stay paused until a later release.
- The Research designer lists most models as not yet startable from a tree.
- After updating from 1.0.48, Accounts can show an account switch that 1.0.48 made on its own, and mark that
  account as in use. Choose your account in Accounts to correct it.
- Changing your display name or payment method still stops open New agent tabs from sending. Close the tab and
  open it again.
- A message sent while another agent's message is being saved waits up to 30 seconds. If saving is still busy,
  it is not sent and your draft is kept.
- Full Remote Access (FRA) is **not independently tested yet** and is **only for testing purposes**. It lets you
  reach a computer from another device through your ToolsEnabled account.
- Some provider programs on Windows start through a .cmd or .bat file. Such a program does not start if a value passed
  to it contains &, |, <, >, ^ or %. The same holds when the folder the file is in contains one of them. A folder
  named Tom & Jerry, or a Windows account named R&D, is one example. It says so instead. Claude Code and Codex
  installed with npm are started without that file.
- The Windows update check does not use Windows proxy settings or certificates added to Windows. On a network that
  needs them, the check cannot reach toolsenabled.ai. Get the new version from toolsenabled.ai/download.
- On a Linux computer without Git, Finish setup stops on its last step with a notice that changes cannot be
  undone automatically. Everything else in setup took effect. Press Continue to the app, or install Git first.
- After Send now replaces a turn that is still running, the replaced turn is marked as stopped only after
  ToolsEnabled restarts. The new reply is not affected.
- On Linux, apt purge leaves an unused copy of the AppArmor profile's cache in /var/cache/apparmor. It is not
  loaded, and you can delete it.

## Install

These are planned filenames. No 1.0.50 byte count or digest is claimed here.
Each platform requires its own measured record before publication.

### Windows installer

| Item | Value |
| --- | --- |
| Package | ToolsEnabled-Setup-1.0.50.exe |
| Platform | Windows |
| Bytes | pending |
| SHA-256 | pending |
| Signed | pending |

### Linux package

| Item | Value |
| --- | --- |
| Package | toolsenabled_1.0.50_amd64.deb |
| Platform | Linux |
| Bytes | pending |
| SHA-256 | pending |
| Signed | pending |

## Publisher and copyright

Published by ToolsEnabled, Inc.

Copyright © 2026 Joshua Pinckard

ToolsEnabled was founded and created by Joshua Pinckard. The original platform was
developed by directing autonomous AI-agent fleets through the system's own evolving
coordination architecture.

Contributors and maintainers are never founders.
