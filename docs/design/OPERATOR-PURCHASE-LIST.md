# The purchase list is the operator's, not the product's

## What happened

`public/data/purchase-catalog.json` was the author's own shopping list for launching this
product: 37 items, what each one costs, what breaks without it, and — in his own words,
addressed to himself in the second person — why he wanted it.

vite copies `public/**` into `dist/` verbatim. `package.json` `build.files` ships
`dist/**` into `app.asar`. `#/checkout` was an unconditional stop on the navigation ring.
So every installer carried that file, and on a stranger's fresh install one click back
from home opened it. Read off the packaged window on 2026-08-11, before the fix:

- `spend cap $100.00 per day from config/toolsenabled.policy.json limits.defaultDailySpendUsd, converted to the ledger daily limit by src/lib/providers/pay.js` — internal file paths, on screen
- `WHY YOU WANTED IT — You asked the price directly, R1203: …` — an internal request id, and the operator addressed in the second person
- `Everyone who downloads the installer gets the full-screen blue panel with NO publisher name, and must find and click More info then Run anyway` — a written admission that the installer is unsigned, shipped inside the unsigned installer

Nobody decided to ship it. Nothing in the window half of this product asks whose a file
is, so the question was never put and the file travelled. That is the same
absence-read-as-consent shape this project keeps finding, one layer up: the engine
payload already fails the build on a file classified nowhere at all
(`config/payload-boundary.json`), and the renderer payload had no equivalent.

## What it is now

| Copy | Where | Who sees it |
| --- | --- | --- |
| The one you edit | `private/purchase-catalog.owner.json` | you; `/private/` keeps git out |
| The one the app reads | `<userData>/purchase-catalog.json` | you |
| The one in the installer | *there isn't one* | — |

`<userData>` is `%APPDATA%\ToolsEnabled` on Windows for an ordinary install, and whatever
`--user-data-dir` names for a copy launched with that switch.

The shell serves `/data/purchase-catalog.json` from that file and from nowhere else
(`shell/main.cjs`), behind the same per-window capability header the projection route
uses, so another page or process reaching this origin cannot read it. A missing file is a
`404` with a JSON body — never the app shell, which used to make "not there" look like a
`200` to anything checking `response.ok`.

`src/checkout-visibility.js` probes that URL once at startup and the checkout exists only
if a list was really served. It fails closed: no answer, an error, a timeout, a non-200 or
a non-JSON body all leave the surface off. With it off, `#/checkout` is not a route, the
stop is not on the ring, and typing the address lands on home.

## Turning it on for your own copy

```
node tools/install-operator-purchase-list.mjs        # or: npm run purchase-list:install
```

It validates `private/purchase-catalog.owner.json` against
`public/data/schema/purchase-catalog.schema.json` first — an unreadable list installed
anyway becomes an error on screen at the moment you open the shop, which is the worst
moment to find out — then copies it into `<userData>`. Restart the app; the checkout is
one step back from home.

`--remove` deletes the installed copy and the screen goes away again. `--userData <dir>`
targets a copy launched with `--user-data-dir`.

## What stops it coming back

| Guard | When | What it refuses |
| --- | --- | --- |
| `tools/check-renderer-payload.mjs` | `npm run dist`, `npm run release:cut`, `npm test` | a file under `public/` classified nowhere in `config/renderer-payload-boundary.json`; an `operator` file present in `public/`, in `dist/`, or inside a packaged `app.asar` |
| `tools/test/checkout-privacy.test.mjs` | `npm test` | the leaked strings anywhere in the authored or built payload; a checkout surface that turns on for anything other than a served catalogue |
| `tools/checkout-privacy-packaged-qa.mjs` | `npm run qa:checkout-privacy` | on the packaged window: a ring walk that reaches the checkout, a typed `#/checkout` that opens it, a `/data/purchase-catalog.json` that answers — **and**, in the other direction, a copy with a list installed that fails to show the screen |
| `tools/check-data-schemas.mjs` | `npm run dist` | an operator catalogue that is present and does not match the schema |

The last row of the third guard is the one to keep. Deleting the screen would have made
every absence assertion green while taking away a surface the owner asked for by name, so
the packaged run installs a list and requires the checkout to come back and work.
