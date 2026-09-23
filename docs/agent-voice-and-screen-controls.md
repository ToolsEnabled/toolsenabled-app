# Agent voice, browser and screen controls

On the Computers page (Page 2), press the microphone icon on an agent bubble to select its running session. The Voice & screen access panel opens with that contact selected. Start voice begins the microphone connection; selecting another contact during a call switches that connection. Voice continues when you move between pages.

Open **Settings → App permissions → Computer control**, or use the same control on Page 2. Choose **All running agents** to include every eligible agent currently running in this local window, or **Only selected agents** to search and choose specific agents. Press **Enable computer control** (or **Update allowed agents**). Editing the choice alone does not grant access. Updating replaces the allowed set; new agents started afterward need another update.

Only one agent holds the computer at a time, including between related screenshots, clicks and typing. Other allowed agents wait for that turn to end. A turn ends when the controlling agent releases it or after one minute without an action. The access grant lasts until you stop it, the agent ends, the role changes, the window reloads/closes, or the app exits. The choices and grants are temporary and are never silently restored after restart.

Marked bubbles show which agents have access. The compact floating bar names the controlling agent and its current activity. A colored pointer badge follows beside the mouse target, with click feedback and a consistent color for that agent. The indicator respects reduced motion and leaves the target and Stop all button clickable.

Use **Stop selected**, **Stop all**, the floating **Stop all** button, or **Ctrl+Alt+Escape** to revoke access. Stop also cancels queued actions and releases native input before another action starts. An interrupted click or keypress may already have had an effect; inspect before repeating it.

Only one ToolsEnabled app on a desktop can hold screen access at a time. The first grant reserves the OS stop shortcut. The reservation ends after the last grant and all pending actions finish cleaning up, so another app can then acquire it. Closing the app waits for this cleanup as well. If cleanup cannot be confirmed, grants stop and the app retains the reservation and refuses to quit. A fallback that releases buttons and modifiers does not prove that an interrupted typing operation restored its keyboard state.

Shared DEV sessions refuse screen takeover and capture before reserving the shortcut or starting native input. A private app profile does not separate a desktop's mouse, keyboard or screen. Desktop testing needs an actually separate test desktop; the shared DEV launcher does not currently provide that capability. Force-killing an app externally bypasses its quit guard and ends its OS shortcut registration; that is not confirmation of native input cleanup.

Only one ToolsEnabled app on a desktop can hold screen access at a time. The first grant reserves the OS stop shortcut. The reservation ends after the last grant and all pending actions finish cleaning up, so another app can then acquire it. Closing the app waits for this cleanup as well. If cleanup cannot be confirmed, grants stop and the app retains the reservation and refuses to quit. A fallback that releases buttons and modifiers does not prove that an interrupted typing operation restored its keyboard state.

Shared DEV sessions refuse screen takeover and capture before reserving the shortcut or starting native input. A private app profile does not separate a desktop's mouse, keyboard or screen. Desktop testing needs an actually separate test desktop; the shared DEV launcher does not currently provide that capability. Force-killing an app externally bypasses its quit guard and ends its OS shortcut registration; that is not confirmation of native input cleanup.

Screen takeover requires the Unrestricted permission level and a role that includes `screen.status` and `screen.control` (roles using the normal installed tool set already include them). A custom role that excludes these functions must be updated and its agent restarted. Other role, session and installation policies still apply. Grants come from the local desktop window and are not restored after restart. They do not grant remote agents control through a relay.

Desktop input supports Windows and Linux X11. Linux needs Python 3, libX11 and libXtst. Wayland is not supported by this native input implementation. Windows runs input at the app's existing privilege level, so control of a higher-privilege application may be refused. Native typing does not replace the person's clipboard.

## Agent workflow

For web pages, use `browser.status`, then `browser.start` if needed. Call `browser.playwright_tools` for the installed tool schemas and navigation guide. These functions are available through ToolsEnabled in both Enabled and Only API modes, subject to the role and installation's browser policies.

Call `browser.playwright_call` with a reviewed tool name and its arguments. Navigate, inspect a snapshot, and then act using a current element reference or a unique selector. The pinned Playwright package uses `target`; older `ref` arguments also work. Use `browser_find` to find relevant nodes in a large snapshot. List tabs before selecting one. Keep dependent actions sequential.

Authenticated agent sessions retain their browser connection, selected tab and references between calls. Connections expire after five idle minutes and close when the agent ends; the owned browser stays open. A subsequent call creates a fresh connection, so take a new snapshot. Native MCP image blocks and browser error flags survive the API facade. Transport loss and uncertain input are not classified for automatic replay.

For ToolsEnabled navigation use `app.context` and `app.navigate`. For other desktop software, check `screen.status`. Its `state` is `off`, `ready`, `controlling` or `busy`, with `nextAction` guidance and a `retryAfterMs` when another agent owns control. If busy, wait before checking again; do not send input or repeat requests in a tight loop.

Call `screen.control` with `action: "screenshot"` to acquire an available turn and inspect the screen in one call. The result includes display bounds and image dimensions. Convert image pixels into desktop coordinates using the returned mapping and round to integers. Use one documented move, click, drag, scroll, type or key action, then capture again to verify its effect. Keep these calls sequential. Finish with `{ "action": "release" }` to hand control back immediately while keeping your access grant. `{ "action": "acquire" }` explicitly reserves a turn if needed; both acquire and release take no other fields.

Take a new screenshot after every handoff or idle expiry; previous screen coordinates may be stale. A `SCREEN_BUSY` response means another agent owns the turn. `SCREEN_CONTROL_CHANGED` means a queued request belonged to a released turn and was not executed. Permission, role and session refusals still stop access. These controls operate through the same authenticated tools in normal and API-only modes.

## Verification

Focused app tests cover voice switching, Page 2 selection/grants, graph behavior, role/session isolation, cancellation, monitor changes, indicator failure, desktop reservation handoff, shutdown ordering and shared DEV refusal. An opt-in Electron test on a disposable Xvfb desktop exercises real mouse movement, clicks, Unicode typing, shortcuts, screen capture, the moving marker, the Stop all button and the emergency shortcut:

```sh
node --test tools/test/screen-control-host.test.mjs tools/test/screen-control-desktop-custody.test.mjs tools/test/research-shutdown.test.mjs tools/test/voice-ui.test.mjs
MC_SCREEN_CONTROL_NATIVE_TEST=1 xvfb-run -a -s '-screen 0 1280x900x24' node --test tools/test/screen-control-native.test.mjs
```

Engine tests include the audited gateway, retained sessions, API mode enforcement, legacy target compatibility, exact-version npm cache lookup on both platforms, and native MCP output. The opt-in live browser test uses an isolated Chromium profile with the pinned `@playwright/mcp@0.0.78` package; it tests the session transport and actual browser behavior, while separate gateway tests cover audit and ownership refusals.

Earlier retained evidence includes Windows host/adapter tests and PowerShell/C# compilation with the expected 40-byte x64 SendInput structure. The subsequent Settings, exclusive-turn and visual update is checked through host contracts, the actual Electron Settings view, and disposable Linux X11 input. Its Windows interactive and installed-release qualification remains with the promotion owner. This source change is not a published release.

Implementation references: [Playwright MCP](https://github.com/microsoft/playwright-mcp), [Playwright locators](https://playwright.dev/docs/locators), [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc), and [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window).
