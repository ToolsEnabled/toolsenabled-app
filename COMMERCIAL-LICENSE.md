# What is paid for

ToolsEnabled was founded and created by Joshua Pinckard. The original platform was
developed by directing autonomous AI-agent fleets through the system's own evolving
coordination architecture.

Copyright (c) 2026 Joshua Pinckard. Published by ToolsEnabled, Inc. (in formation).

---

## Nobody needs to buy a licence

This file used to describe one. Until 2026-08-12 ToolsEnabled was AGPL-3.0-or-later
and sold a commercial licence to anyone who could not accept copyleft terms.
**That product no longer exists, because under the MIT License there is nothing left
to sell you.**

MIT already lets you run this software, modify it, redistribute it, embed it in a
closed-source product and sell that product, without asking anyone and without
owing anyone anything. The one condition is that the copyright notice and the
permission notice travel with the copies you hand on. The grant is made by
[`LICENSE`](LICENSE), and that file controls: if any sentence here appears to
narrow, condition or add a requirement to the rights it gives you, that file wins
and this one is wrong.

So if you are here because you assumed a project like this must have a catch for
commercial use — there isn't one. Use it.

## What is actually sold

**Operating a server.** Not code, not a feature unlock, not a licence key.

The software you install reaches your machines when it is on the same network as
them. Reaching them when you are somewhere else needs a server sitting in the
middle, and someone has to run that server, keep it up, and answer for it when it
breaks. That is the paid product, and it is called **ToolsEnabled Anywhere**:

- managed connectivity and the relay we host and run;
- the secure phone path, and mobile access through the website to your own agent
  systems;
- the hosted vault storage service;
- the account, billing and entitlement services.

Three things about it are worth stating plainly, because paid tiers built alongside
open-source projects are routinely suspected of the opposite:

- **It is a service, not a feature unlock.** Nothing in this repository is disabled,
  crippled or time-limited in order to sell it.
- **The free product is complete for anyone who can reach their own machines.**
  Local operation and your own LAN are fully supported and require no account with
  us. **Connect your own server and you pay nothing, forever** — that is the
  standing commitment, and self-hosting is not available yet (below).
- **The server-side implementation is not in this repository yet.** Running your
  own server instead of ours is planned, and when the relay source publishes it
  will be under the same MIT license — a supported, first-class way to use this
  software rather than a workaround. Until then it is a commitment, not a
  capability, and this document would rather say so than let the distinction
  blur.

The service is provided to subscribers under its own service terms, which accompany
the service and are not reproduced in this file. Those terms govern the service.
They do not, and cannot, take anything away from the MIT grant on the software.

## Governance of the official build

The official project lives under the ToolsEnabled GitHub organization.
ToolsEnabled, Inc. controls:

- the **official repository** and what is merged into it;
- the **official releases** and the **signed installers** published under its name;
- the **project's names and marks**, including "ToolsEnabled".

Anyone may fork this project and propose changes. **Only company-approved code
enters the official build.** Proposals are accepted or refused at the company's
discretion, and no contribution carries a right to be merged. Contributions are
accepted under the Developer Certificate of Origin; see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

### What that does and does not restrict

This distinction matters, so it is drawn explicitly rather than left to be inferred:

- **Your rights in the code are MIT's, in full.** You may fork, modify, run,
  distribute, sell and offer over a network. The company's control over the
  official build is not a restriction on your copy and cannot be used as one.
- **What is reserved is identity, not code.** A fork is yours; it is not the
  official product. It must not present itself as the official build, as published
  or endorsed by ToolsEnabled, Inc., or under the project's names and marks in a way
  that would mislead someone about where it came from. The MIT License grants
  copyright permissions and says nothing about trademarks, so this limit rests on
  trademark law and takes nothing from the licence.
- **Renaming a fork is always sufficient.** Distributing your fork under its own
  name satisfies everything asked of you here.

Cloud infrastructure, billing, provisioning, security operations and internal
development tooling are developed separately and are not intended to be part of this
repository. What the official build actually redistributes is not left to that
sentence to enforce: it is declared in `config/payload-boundary.json` and checked by
a gate on every release build.

## Third-party components

ToolsEnabled bundles third-party open-source components, each under its own license.
Those licenses are unaffected by anything in this document. Their notices and full
texts are in [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md).

## Legal status

Stated plainly, because a public repository is a dated, permanent record:

- **ToolsEnabled, Inc. does not exist yet.** Incorporation has not been filed. It is
  named as the intended publisher and marked *(in formation)*. Copyright is held
  personally by Joshua Pinckard until the entity exists and the rights are assigned
  to it.
- **No trademark application has been filed** for "ToolsEnabled". The name is not
  claimed here as a registered mark. The trademark limit described above rests on
  unregistered rights, which are narrower than registered ones.
- **None of this has been reviewed by a lawyer.** It is a statement of intent
  written to be honest about what has and has not been decided.

---

*ToolsEnabled — created by Joshua Pinckard, sole founder.
Published by ToolsEnabled, Inc. (in formation). Copyright (c) 2026 Joshua Pinckard.*
