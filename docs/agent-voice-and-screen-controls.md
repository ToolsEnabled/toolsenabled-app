# Agent voice, browser, screen and video controls

On the Computers page (Page 2), press the microphone icon on an agent bubble to select its running session. The Voice, screen & video panel opens with that contact selected. Start voice begins the microphone connection; selecting another contact during a call switches that connection. Voice continues when you move between pages.

Open **Settings → App permissions → Computer control**, or use the same control on Page 2. Choose **All running agents** to include every eligible agent currently running in this local window, or **Only selected agents** to search and choose specific agents. Press **Enable computer control** (or **Update allowed agents**). Editing the choice alone does not grant access. Updating replaces the allowed set; new agents started afterward need another update.

Choose **Temporary** (the default) or **Until I turn it off** before enabling access. Temporary access ends with the session or app. The remembered choice applies only to those exact saved tree circles, including after a resumed session or app restart. It does not include new circles, other agents sharing a role, or remote agents. Standalone sessions can use temporary access. Switching to Temporary and updating removes the saved choice.

Only one agent holds the computer at a time, including between related screenshots, clicks and typing. Other allowed agents wait for that turn to end. A turn ends when the controlling agent releases it or after one minute without an action. Remembered access still requires a current eligible session, Unrestricted permissions, a working indicator and an armed stop shortcut. An unavailable prerequisite suspends access while keeping your saved choice. A changed role needs a new choice. Old sessions and queued actions cannot inherit a new grant.

Marked bubbles show which agents have access. The compact floating bar names the controlling agent and its current activity. A colored pointer badge follows beside the mouse target, with click feedback and a consistent color for that agent. The indicator respects reduced motion and leaves the target and Stop all button clickable.

Use **Stop selected**, **Stop all**, the floating **Stop all** button, or the displayed emergency shortcut to revoke access. Stop selected forgets the selected agents' saved choices; Stop all and the emergency shortcut forget all saved choices. Stop also cancels queued actions and releases native input before another action starts. If saving the change fails, access stops in this app and a warning asks you to check the saved choice before reopening. An interrupted click or keypress may already have had an effect; inspect before repeating it.

Only one ToolsEnabled app on a desktop can hold screen access at a time. The first grant reserves the OS stop shortcut. The reservation ends after the last grant and all pending actions finish cleaning up, so another app can then acquire it. Closing the app waits for this cleanup as well. If cleanup cannot be confirmed, grants stop and the app retains the reservation and refuses to quit. A fallback that releases buttons and modifiers does not prove that an interrupted typing operation restored its keyboard state.

Shared DEV sessions refuse screen takeover and capture before reserving the shortcut or starting native input. A private app profile does not separate a desktop's mouse, keyboard or screen. Desktop testing needs an actually separate test desktop; the shared DEV launcher does not currently provide that capability. Force-killing an app externally bypasses its quit guard and ends its OS shortcut registration; that is not confirmation of native input cleanup.

Only one ToolsEnabled app on a desktop can hold screen access at a time. The first grant reserves the OS stop shortcut. The reservation ends after the last grant and all pending actions finish cleaning up, so another app can then acquire it. Closing the app waits for this cleanup as well. If cleanup cannot be confirmed, grants stop and the app retains the reservation and refuses to quit. A fallback that releases buttons and modifiers does not prove that an interrupted typing operation restored its keyboard state.

Shared DEV sessions refuse screen takeover and capture before reserving the shortcut or starting native input. A private app profile does not separate a desktop's mouse, keyboard or screen. Desktop testing needs an actually separate test desktop; the shared DEV launcher does not currently provide that capability. Force-killing an app externally bypasses its quit guard and ends its OS shortcut registration; that is not confirmation of native input cleanup.

Screen takeover requires the Unrestricted permission level and a role that includes `screen.status` and `screen.control` (roles using the normal installed tool set already include them). A custom role that excludes these functions must be updated and its agent restarted. Other role, session and installation policies still apply. Choices come from the local desktop window. Remembered access is checked again before a new session receives a grant. It does not grant remote agents control through a relay.

Desktop input supports Windows and Linux X11. Linux needs Python 3, libX11 and libXtst. Wayland is not supported by this native input implementation. Windows runs input at the app's existing privilege level, so control of a higher-privilege application may be refused. Native typing does not replace the person's clipboard.

## Video under an agent’s box

Video is off for every agent until you turn it on. Press the mic button on the agent’s box, running or not. In the Voice, screen & video panel that opens, the **Video** section sits directly under the Computer control card. It works for agents on this computer’s tree, running or not. It does not work for group boxes, New agent tabs, agents on another computer, or the example tree.

Press **Turn on video…** to see thumbnails of this computer’s windows. ToolsEnabled’s own windows and DevTools are never listed. The list opens, and a video starts, only from your own click. Press a window to show it. A 16:9 panel as wide as the box appears 8 px under that agent’s box, and the tree makes room below that row only. A thumbnail can show pixels of a window covering it; the video itself shows only the window you picked.

Panels appear only in Boxes view. There are none in Circles, in edit mode, on group boxes, in the paired window or on the phone. In Circles the section says: “Switch the tree to Boxes to see this video.” In edit mode it asks you to press **Done**.

- **Change window…** opens the list again for the same agent.
- **Turn off video** removes that agent’s panel and forgets its choice.
- **Turn off all video** removes every panel and forgets every saved choice.
- A closed source window leaves “Window closed” in the panel until you turn that video off.
- A minimized or hidden window keeps its last frame. After a few seconds without a new frame, the panel says the window is minimized or hidden.
- A panel that is not shown anywhere for 10 minutes stops. Press **Click to resume** on the panel, or **Resume** in the section. If that window was renamed, minimized or closed, or another window has its name, the button becomes **Pick the window again**. On Linux, a minimized window is not in the list until you restore it.

The choice is saved for each agent by the window’s title and program name, never by a window id. After a restart the panel reads “Video was on for this agent. Pick the window again.” One press opens the list with the closest title first and focused. Nothing streams until you press a window. Until then the mic button says “video saved”, not “video on”. The saved choices are deleted with the other agent data when the app erases local data or deletes agent nodes on exit.

Up to 6 videos can play at once. Each is at most 854 × 480. The selected or hovered box’s video runs at 10 frames a second, other visible panels at 5, and panels not drawn at 1. A large source window costs more to capture than a small one, so keep source windows near 854 × 480.

ToolsEnabled does not record this video or send it to the agent. An agent you allow to take screenshots, for example with Computer control, can see the video like anything else on your screen. The window’s title is kept on this computer until you turn video off. Agent app control cannot press the Video section, the list of windows or a panel.

Video needs Windows or a Linux desktop that uses X11. It is not available on a Linux Wayland desktop, in a browser or on the phone; the section says so.

### A small display for a container

To watch what a container draws, give it its own small X server window and show that window under the agent’s box:

```sh
Xephyr :11 -screen 854x480 -title "ROS - builder" &
docker run --rm -e DISPLAY=:11 -v /tmp/.X11-unix/X11:/tmp/.X11-unix/X11 <your image> <your command>
```

Then press **Turn on video…** for that agent and pick “ROS - builder”. Give each agent its own display number and title. A second agent could use this, with `/tmp/.X11-unix/X12` in its container:

```sh
Xephyr :12 -screen 854x480 -title "ROS - tester" &
```

After a restart the list puts the window with the saved title first, so two windows with one title can offer the wrong one. Keep titles to plain letters, numbers, spaces and dashes. Xephyr stores its title in a way that garbles other characters in the list of windows.

Never mount the host display’s socket (`/tmp/.X11-unix/X1` for `:1`) into a container: that would let the container read and type into your whole desktop. Mount only the Xephyr display’s socket.

## Agent workflow

For web pages, use `browser.status`, then `browser.start` if needed. Call `browser.playwright_tools` for the installed tool schemas and navigation guide. These functions are available through ToolsEnabled in both Enabled and Only API modes, subject to the role and installation's browser policies.

Call `browser.playwright_call` with a reviewed tool name and its arguments. Navigate, inspect a snapshot, and then act using a current element reference or a unique selector. The pinned Playwright package uses `target`; older `ref` arguments also work. Use `browser_find` to find relevant nodes in a large snapshot. List tabs before selecting one. Keep dependent actions sequential.

Authenticated agent sessions retain their browser connection, selected tab and references between calls. Connections expire after five idle minutes and close when the agent ends; the owned browser stays open. A subsequent call creates a fresh connection, so take a new snapshot. Native MCP image blocks and browser error flags survive the API facade. Transport loss and uncertain input are not classified for automatic replay.

For ToolsEnabled navigation use `app.context` and `app.navigate`. For other desktop software, check `screen.status`. Its `state` is `off`, `ready`, `controlling` or `busy`, with `nextAction` guidance and a `retryAfterMs` when another agent owns control. If busy, wait before checking again; do not send input or repeat requests in a tight loop.

Call `screen.control` with `action: "screenshot"` to acquire an available turn and inspect the screen in one call. The result includes display bounds and image dimensions. Convert image pixels into desktop coordinates using the returned mapping and round to integers. Use one documented move, click, drag, scroll, type or key action, then capture again to verify its effect. Keep these calls sequential. Finish with `{ "action": "release" }` to hand control back immediately while keeping your access grant. `{ "action": "acquire" }` explicitly reserves a turn if needed; both acquire and release take no other fields.

Take a new screenshot after every handoff or idle expiry; previous screen coordinates may be stale. A `SCREEN_BUSY` response means another agent owns the turn. `SCREEN_CONTROL_CHANGED` means a queued request belonged to a released turn and was not executed. Permission, role and session refusals still stop access. These controls operate through the same authenticated tools in normal and API-only modes.

## Verification

Focused app tests cover voice switching, Page 2 selection/grants, the Video section (`tools/test/agent-video-controls.test.mjs`), the video host, broker and panels (`video-box-host`, `video-box-broker`, `tree-graph`), graph behavior, role/session isolation, cancellation, monitor changes, indicator failure, desktop reservation handoff, shutdown ordering and shared DEV refusal. An opt-in Electron test on a disposable Xvfb desktop exercises real mouse movement, clicks, Unicode typing, shortcuts, screen capture, the moving marker, the Stop all button and the emergency shortcut:

```sh
node --test tools/test/screen-control-host.test.mjs tools/test/screen-control-desktop-custody.test.mjs tools/test/research-shutdown.test.mjs tools/test/voice-ui.test.mjs
MC_SCREEN_CONTROL_NATIVE_TEST=1 xvfb-run -a -s '-screen 0 1280x900x24' node --test tools/test/screen-control-native.test.mjs
```

An opt-in Electron test checks the video capture gate on its own private X server: no list of windows without a click, one capture per pick, and a reload for a capture that bypassed the pick. It needs xvfb-run, xterm, xwininfo and xprop:

```sh
MC_VIDEO_BOX_ELECTRON_TEST=1 node --test tools/test/video-box-electron.test.mjs
```

Engine tests include the audited gateway, retained sessions, API mode enforcement, legacy target compatibility, exact-version npm cache lookup on both platforms, and native MCP output. The opt-in live browser test uses an isolated Chromium profile with the pinned `@playwright/mcp@0.0.78` package; it tests the session transport and actual browser behavior, while separate gateway tests cover audit and ownership refusals.

Earlier retained evidence includes Windows host/adapter tests and PowerShell/C# compilation with the expected 40-byte x64 SendInput structure. The subsequent Settings, exclusive-turn and visual update is checked through host contracts, the actual Electron Settings view, and disposable Linux X11 input. Its Windows interactive and installed-release qualification remains with the promotion owner. This source change is not a published release.

Implementation references: [Playwright MCP](https://github.com/microsoft/playwright-mcp), [Playwright locators](https://playwright.dev/docs/locators), [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc), and [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window).
