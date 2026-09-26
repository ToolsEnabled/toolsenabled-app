# ToolsEnabled `1.0.48`

*Planned `2026-09-26`*

This release lets you pick the exact model for an agent and brings back New agent tabs after a restart. It also
fixes problems found since 1.0.47. Both platform artifacts and their measurements are pending until the hand test of
the installed build is complete.

## Highlights

- Choose a provider, then one of its models, wherever you start or switch an agent. Claude offers Opus 5.5, Opus 5,
  Sonnet 5 and more.
- Tabs opened with New agent come back after you quit and reopen ToolsEnabled, with their conversation.

## Added

- Provider, then model. Codex, Claude, Gemini, Grok and Local each list their own models.
- Claude lists Opus 5.5, Opus 5, Sonnet 5, Fable 5.1, Fable 5, Haiku 4.5, and Opus 4.8, 4.7 and 4.6 and Sonnet 4.6.
- Codex adds GPT-6-Sol and GPT-6-Luna for agents in a tree. Gemini adds 3.1 Flash Lite.
- New agent tabs are kept when you quit. They reopen with their conversation and do not run until you send.
  Your first message continues the conversation.

## Changed

- "Opus", "Sonnet" and "Fable" are now "Opus (latest)", "Sonnet (latest)" and "Fable (latest)". They still follow the
  newest model of that name.
- Luna, Terra and Sol are now called GPT-5.6-Luna, GPT-5.6-Terra and GPT-5.6-Sol.
- The effort list shows only the depths the chosen model takes. A model with no fixed depth uses its own default
  unless you choose one.
- When an agent runs out of account limits, a model you picked is kept. It is never moved to another model without you.
- Messages shown while you sign in with a school or work account now use general wording.

## Fixed

- With Send now, the reply to your new message now appears in the tab.
- Halting a Claude agent now shows "turn interrupted", not "turn error".
- The Actions menu of a New agent tab now tells the truth about a running agent, and its Stop and Interrupt work.
- After a paused account recovery, a picture the new session refused is no longer sent anyway.
- Saving a conversation no longer misses the newest lines still being written.
- A renamed install now carries your saved conversations.
- Metrics says when a computer cannot record, instead of asking you to start an agent.
- The first-run walkthrough no longer shows the side navigation, whose links all led back to it.
- Settings in Basic view shows "Who is using this copy" and its sign-in button again.
- An agent refused a file outside your profile folder is told why, not "internal error".
- Firebase tools without the Firebase program installed now say what to install.
- Gemini and Grok "Automatic" agents are no longer sent a depth they refuse.
- The in-app help now says the Windows installer is code-signed by ToolsEnabled, Inc.
- "Delete agent nodes when the app exits" now deletes them. Before, it deleted nothing, and the next launch could
  refuse to start.
- A failed Erase no longer stops ToolsEnabled from opening, and Erase can be retried.
- Launch, Team and Loop now confirm the work they start. Team members start, and a Loop keeps running.
- After you switch an agent to another model, Launch, Team and Loop can hand it work again.
- A reply to an agent that was brought back now appears in the chat you have open.
- A Claude reply that came after the model's thinking is no longer saved and shown twice.
- A New agent tab's model button and Switch model open the model chooser. Your choice shows on the tab as next
  and is used the next time that agent starts.
- Rows of a New agent tab's Actions menu that need a tree say so.
- At your desk the app says "This computer", and Home names a New agent tab instead of showing a code.
- Switch and continue opened by hand no longer says the agent failed.
- Metrics says "1 turn", not "1 turns".
- Team members, and agents a Controller starts at the same time, each get their brief. Before, one could start
  without it while another agent's message was being saved.
- Changing a setting, such as Boxes or Circles, card size, theme or a tool, no longer stops open New agent tabs
  from sending.
- Halt or Stop while your message waits for another agent's message to be saved cancels it, and your draft
  comes back.
- Stop on a Launch, Team or Loop box closes work that has not taken its brief yet.
- Quitting just after you send a first message now waits until the message is saved, then finishes. This covers
  closing the window, shutting down or logging out, and restarting for an update. Before, a message sent less than
  about a second before the quit was often lost without a word. ToolsEnabled could also keep running with no window,
  or wait on a "Conversation has not been saved" notice until the computer closed it.
- Shutting down or logging out while a "Conversation has not been saved" notice is open now finishes once saving
  works again.
- Closing the window while a message is still being saved no longer asks you to free disk space. The window closes
  once the message is saved.
- "Delete agent nodes when the app exits" now finishes after a normal quit. Before, about 1 quit in 30 left it
  unfinished, and task filing then stayed paused.
- A New agent tab that comes back after a restart now hands its agent the conversation from the start, up to the
  usual length. Before, a long tab handed over only its newest part, and the agent could not see your first request.
- When an earlier delete at exit is still unfinished after a later close deleted your agents, Settings now says that
  filing tasks stays paused. Before, it said the last close did not finish.
- An agent that starts helpers and quotes your request as the reason is no longer refused.

## Known issues

- Tabs lost when 1.0.47 or earlier closed are not recovered.
- A model your account cannot run is refused at your first message, with the provider's own reason.
- Automatic account rotation cannot tell which account may run which model. Choose the account for an agent that
  needs a specific model.
- Adding a reopened New agent tab to a tree carries at most its newest 2,000 messages. The rest stay saved.
- Gemini models that need an Antigravity account are offered before an account is set up. The first message then
  asks you to add one in Accounts.
- If a delete at exit is interrupted, Settings says so, and task filing can stay paused until a later release. The
  note stays after later quits for as long as that delete is unfinished.
- The Research designer lists most models as not yet startable from a tree.
- Changing your display name or payment method still stops open New agent tabs from sending. Close the tab and
  open it again.
- A message sent while another agent's message is being saved waits up to 30 seconds. If saving is still busy,
  it is not sent and your draft is kept.
- A quit less than half a second after you send a first message can still lose that message when ToolsEnabled is
  busy. Wait a moment before you quit.
- FRA is **not independently tested yet** and is **only for testing purposes**.

## Install

These are planned filenames. No 1.0.48 byte count or digest is claimed here.
Each platform requires its own measured record before publication.

### Windows installer

| Item | Value |
| --- | --- |
| Package | ToolsEnabled-Setup-1.0.48.exe |
| Platform | Windows |
| Bytes | pending |
| SHA-256 | pending |
| Signed | pending |

### Linux package

| Item | Value |
| --- | --- |
| Package | toolsenabled_1.0.48_amd64.deb |
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
