# auxiliary

Services the product operates but is not itself. Each one holds its own window,
launched from the Swarm page.

They arrived here from outside the product and are mid-intake. Two things follow
from that and both matter to anyone editing them:

- **They do not yet agree with the product's theme.** Bringing them into it is
  active work, not a nice-to-have.
- **They carry assumptions from where they used to live** — absolute paths, fixed
  ports, and a directory layout that no longer exists. The owner's standing rule
  is that nothing may be specific to one machine: *"You cant hardcode things. You
  need to work with users different machines and setups."*

## What is here

| Folder | What it is |
|---|---|
| `presentation/` | The presentation and PDF editor. Its own server, a document host, and an agent tool surface over slides. |
| `scribe/` | The document editor. Two MCP surfaces, a fail-closed tool allowlist, hash-guarded writes, and one serialized write path shared by human and agent. |

## What is deliberately NOT here

Content. Documents, decks, drafts, corpora, checkpoints, exports, captured
screenshots and run histories stayed where they were — roughly 456 MB of it for
the presentation suite alone. This folder is program code. A document these
services can open is not part of the product.
