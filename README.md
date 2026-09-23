# ToolsEnabled

## Attribution

**ToolsEnabled was founded and created by Joshua Pinckard. The original platform was
developed by directing autonomous AI-agent fleets through the system's own evolving
coordination architecture.**

| | |
| --- | --- |
| Company / copyright holder | ToolsEnabled, Inc. *(in formation — see [Legal status](#legal-status))* |
| Sole founder and creator | Joshua Pinckard |
| Official product | ToolsEnabled |
| Official publisher | ToolsEnabled, Inc. *(in formation)* |

Outside developers are listed in [`CONTRIBUTORS.md`](CONTRIBUTORS.md) as contributors and
maintainers. Contributors are never founders; the founder credit above is not shared.

---

## What this is

**ToolsEnabled** is a capability layer that gives an AI agent a governed set of real
tools — a policy kernel that decides what is allowed, a tamper-evident audit ledger that
records what happened, and a provider surface that performs the work.

It ships with a reference interface of the same name: the fleet, the agents, the
approvals, the spend ledger and the audit trail in one place. The interface does not have
a separate name, because it is not a separate product — it is what ToolsEnabled looks
like.

It is one free product, licensed under the MIT license. You can run it two ways today:

- **Locally**, on one machine.
- **Over your own LAN**, from one machine to another you already control.

Neither requires an account with us, and neither is time-limited or feature-gated. The
free product is the whole product for anyone who can reach their own machines.

**Self-hosting** — running the relay yourself, on infrastructure you operate, so that
machines on *different* networks reach each other without us — is planned and is not
available yet. The relay's source publishes under the same MIT license when it lands. We
would rather tell you it is coming than imply it is here.

## The paid product

**ToolsEnabled Anywhere** is a separate, optional, paid service for the one problem the
free product deliberately does not solve: reaching your machines when you are *not* on the
same network. It provides managed non-LAN connectivity, device enrollment, the relay,
monitoring, recovery and support. Planned pricing is $19/month, or $190/year.

Anywhere is a hosted service, not a feature unlock. Nothing in this repository is disabled
to sell it. The free product launches first; Anywhere follows as an invite-only beta.

## Governance

The official project will live under the ToolsEnabled GitHub organization, which today
holds only the organization's profile page — no product repository, no releases, no issue
tracker. ToolsEnabled, Inc. controls the official repository, the releases, the project's
names and marks, and the signed installers.

Anyone may fork this project and propose changes. Only approved code enters the official
build. A fork is your own; it is not the official product and must not present itself as
the official build or as published by ToolsEnabled, Inc.

That last limit is a trademark one, not a restriction on the code: your rights in the code
are MIT's in full, and renaming a fork is always enough to satisfy it. The distinction
is drawn out in [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md), which also covers what
is actually paid for — which is us operating a server, not any licence to the code.

Cloud infrastructure, billing, provisioning, security operations and internal development
tooling are developed separately and are not intended to be part of this repository.

What the official build actually redistributes is not left to that sentence to enforce.
It is declared in `config/payload-boundary.json` and checked by a gate on every release
build, which fails rather than warns. That file is the current answer; prose in a README
is not.

One distinction in that file is easy to read the wrong way, so it is worth stating here.
A path marked `excluded` or `paid` is one the build measurably no longer ships, and the
gate fails if it reappears. A path marked `pending` is one where the decision has been
made but the file **still ships today**. The gate's "clean" verdict is only about the
first kind. To know what is actually in a build, read the `pending` list, not the last
line of the output.

## Legal status

Stated plainly, because a public repository is a dated, permanent record:

- **ToolsEnabled, Inc. does not exist yet.** Incorporation has not been filed. The company
  is named here as the intended publisher, marked *(in formation)*, and copyright is held
  personally by Joshua Pinckard until the entity exists and the rights are assigned to it.
  At that point the copyright holder line changes and the *(in formation)* qualifier is
  removed.
- **No trademark application has been filed** for "ToolsEnabled", and it is not claimed
  here as a registered mark.
- **The interface was previously called "Mission Control", and that name has been
  dropped.** A USPTO search returned 17 live marks for it in the relevant classes,
  including one held by Apple Inc. (Reg. 4240125, IC 009, covering graphical user
  interface software) and one held by BMC Software. "ToolsEnabled" returned no hits, live
  or dead. The name was changed before launch rather than after, because once a name is
  in forks, package registries and third-party redistributions it cannot be recalled.
- **The license is in force.** This, the free product, is released under the **MIT
  License**. The grant is made by [`LICENSE`](LICENSE); if anything here disagrees with
  that file, that file controls. You may use, modify, redistribute and sell it, including
  inside a closed-source product, provided the copyright and permission notices travel
  with the copies you hand on. What is paid for is us *operating a server* — the hosted
  relay, the secure phone path, the hosted vault — and connecting to your own server
  instead costs nothing. The governance of the official build is in
  [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md).
- **Bundled third-party components keep their own licenses.** Their notices and full texts
  are reproduced in [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md), which ships with
  the installer because the SIL Open Font, Apache-2.0 and BSD-3-Clause terms require the
  notices to travel with the binary rather than merely be listed in a manifest.

  Outside contributions are open, under the Developer Certificate of Origin: sign off each
  commit with `git commit -s` and your change is contributed under the same MIT terms.
  There is no copyright assignment and nothing to sign. Why a DCO rather than a CLA — and
  what a DCO does *not* give the project — is set out in
  [`CONTRIBUTING.md`](CONTRIBUTING.md). See also [`LICENSING.md`](LICENSING.md) for why the
  project moved from AGPL to MIT, and [`CONTRIBUTORS.md`](CONTRIBUTORS.md).

  None of this has been reviewed by a lawyer.

## Status

Pre-release. This repository is not yet public.

---

*ToolsEnabled — created by Joshua Pinckard, sole founder.
Published by ToolsEnabled, Inc. (in formation). Copyright © 2026 Joshua Pinckard.*
