# Licensing

ToolsEnabled was founded and created by Joshua Pinckard. The original platform was
developed by directing autonomous AI-agent fleets through the system's own evolving
coordination architecture.

Copyright (c) 2026 Joshua Pinckard. Published by ToolsEnabled, Inc. (in formation).

## The short version

**ToolsEnabled is free software under the MIT License.** The full and controlling
text is in [`LICENSE`](LICENSE). If anything on this page disagrees with that file,
that file wins.

You may use, modify, redistribute and sell this software, including inside a
closed-source product, without asking anyone. The one condition is that the
copyright notice and the permission notice travel with the copies you hand on.

## Why MIT

This project was AGPL-3.0-or-later until 2026-08-12. The change was deliberate and
it followed from getting the business model straight rather than from a change of
heart about open source.

The AGPL was chosen for its section 13: modify the software, run it as a network
service, and you owe your users the modified source. The reasoning was that the
commercial threat is someone running a modified copy as a hosted service without
publishing their changes.

That reasoning was answering the wrong question. **The client is not what is
sold.** What ToolsEnabled sells is *operating a server* — the managed connectivity
service and the relay, the secure phone path, mobile access to your own agent
systems, the hosted vault, and the account and billing services. A competitor
running their own relay is not taking revenue that a copyleft clause could have
protected, because the revenue was never in the code. It is in running the thing,
answering for it when it breaks, and keeping it up.

So section 13 was buying nothing, and it was being paid for:

- Some organisations refuse copyleft software by policy, at the procurement stage,
  before anyone technical sees it. That is a straight subtraction from the set of
  people who can adopt this.
- The AGPL puts an obligation on the customer — the person who installs the
  software on their own machines and connects it to their own server, who is
  exactly the person this project promises will never owe it anything.

MIT removes both. The half you install is free, permissively, permanently, and the
paid product is the server we run, **ToolsEnabled Anywhere**.

**What MIT does not include, stated plainly:** it has no express patent grant.
Apache-2.0 is MIT-shaped and adds one. That trade-off is recorded here so it is a
known position rather than an oversight; MIT was chosen.

## There is no dual licensing any more

There used to be. Under the AGPL this project offered separate commercial terms to
anyone who wanted to build on it without copyleft obligations, and that arrangement
depended on one person holding all the copyright.

Under MIT nobody needs to buy that permission, because MIT already grants it. See
[`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md) for what the paid product actually
is, which is a service and not a licence.

The consequence for contributions is a good one: because the business no longer
depends on holding all the copyright, outside contributions no longer have to be
turned away. They are accepted under the Developer Certificate of Origin — a
sign-off on each commit, no assignment, no agreement to sign. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CONTRIBUTORS.md`](CONTRIBUTORS.md).

## What this file is not

This is an explanation, not legal advice, and none of it has been reviewed by a
lawyer. Two things in particular are recorded here as decisions rather than as
settled facts:

- **ToolsEnabled, Inc. does not exist yet.** It is described as "in formation"
  everywhere it appears, and copyright is held by Joshua Pinckard personally. When
  the entity is formed, whether and how copyright is assigned to it is a separate
  decision with tax and liability consequences.
- **The trademark position is unresolved.** Do not treat the product name as
  cleared.

## Third-party components

Components bundled with this software carry their own licenses, which are
unaffected by the terms above. See [`NOTICE`](NOTICE).
