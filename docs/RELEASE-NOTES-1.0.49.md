# ToolsEnabled `1.0.49`

*Planned `2026-09-26`*

This release adds plugins and a video box under each agent's box. Both are new, and both are off until you turn them
on. Both platform artifacts and their measurements are pending until the hand test of the installed build is complete.

## Highlights

- Plugins: put a plugin folder in place, then choose on the Plugins page what it may do. Adding one allows it nothing.
- Video under an agent's box: in Boxes view, show a window you pick under that agent. Use it to watch what an agent
  is doing, such as a robot program running in a container.

## Added

- A Plugins page, reached from the Tools page. With no plugin added it says "No plugins added" and names the folder
  to put one in.
- A plugin can add tools, roles, settings of its own and a few colours. Each thing it asks for is a separate tick box,
  and all start unticked.
- Every tick box says what it allows and what it risks. Limits a plugin claims for itself are shown as its own words,
  not as something ToolsEnabled enforces.
- A plugin's tools run as separate programs in their own folder. They get none of your provider keys or sign-ins.
- Change any file in a plugin and it is treated as a new plugin, with nothing allowed. You are asked again. Its
  tools stop running at once, before any restart.
- Withdraw everything removes a plugin's tools and roles after a restart. The entry stays and says it was withdrawn.
  An agent that held one of its roles works as a Worker, and the Roles panel says so.
- A plugin's roles appear in the role library, named with the plugin they came from. A role you wrote with the same
  name wins, and the Plugins page says so. A plugin's role cannot be edited.
- Video for an agent. Press the mic button on an agent's box: the Video section sits under the Computer control
  card. Video is off for every agent until you turn it on.
- Press Turn on video, then pick one of this computer's windows. A panel as wide as the box appears under it, in
  Boxes view.
- Turn off video forgets that agent's window, and Turn off all video forgets every one.
- After a restart the panel asks you to pick the window again. One press opens the list with the closest title first.
  Nothing plays until you pick.
- The guide explains how to give a container its own small window to show under an agent.

## Changed

- The mic button's panel is now called "Voice, screen & video".
- Plugin changes take effect the next time you open ToolsEnabled.
- The video is only on your screen. ToolsEnabled does not send it to the agent, and nothing is recorded.
- Agent app control cannot press the Video section, the list of windows or a video panel.

## Fixed

- At your desk, the screen that removes this program's data now says "this computer", not "the computer you are
  driving".
- An agent that starts helpers and quotes the reply it expects as its reason, even a single word such as KIWI, is
  no longer refused.

## Known issues

- Plugins and the video box have not yet been tried by hand in an installed build. That hand test comes before
  release.
- At the Guided permission level, a plugin's tools are listed as not allowed, even after you allow them. Tools that
  run programs need a level that allows writing files.
- There is no way to add, update or remove a plugin from inside the app yet. You move its folder yourself.
- Video works only in Boxes view. There are no panels in Circles, in edit mode, on group boxes, or in the paired
  window.
- Video needs Windows or a Linux desktop that uses X11. It does not work on a Linux Wayland desktop, in a browser or
  on the phone.
- Video has been tried on Linux only. It has not been checked on Windows yet.
- Up to 6 videos can play at once, each at most 854 × 480 and 10 frames a second. Six at once can use up to about a sixth of
  one processor core.
- A video that is not shown anywhere for 10 minutes stops. Press Click to resume to start it again.
- The window list's thumbnails can show a window that covers the one you want. The video shows only the window you
  picked.
- The video box has one known gap. For a few seconds after a click in ToolsEnabled, a fault inside the app's own
  page could start one short screen capture. ToolsEnabled then reloads its window within about a second, which ends it.
- Tabs lost when 1.0.47 or earlier closed are not recovered.
- A model your account cannot run is refused at your first message, with the provider's own reason.
- Automatic account rotation cannot tell which account may run which model. Choose the account for an agent that
  needs a specific model.
- Adding a reopened New agent tab to a tree carries at most its newest 2,000 messages. The rest stay saved.
- Gemini models that need an Antigravity account are offered before an account is set up. The first message then
  asks you to add one in Accounts.
- If a delete at exit is interrupted, Settings says so, and task filing can stay paused until a later release.
- The Research designer lists most models as not yet startable from a tree.
- Changing your display name or payment method still stops open New agent tabs from sending. Close the tab and
  open it again.
- A message sent while another agent's message is being saved waits up to 30 seconds. If saving is still busy,
  it is not sent and your draft is kept.
- FRA is **not independently tested yet** and is **only for testing purposes**.

## Install

These are planned filenames. No 1.0.49 byte count or digest is claimed here.
Each platform requires its own measured record before publication.

### Windows installer

| Item | Value |
| --- | --- |
| Package | ToolsEnabled-Setup-1.0.49.exe |
| Platform | Windows |
| Bytes | pending |
| SHA-256 | pending |
| Signed | pending |

### Linux package

| Item | Value |
| --- | --- |
| Package | toolsenabled_1.0.49_amd64.deb |
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
