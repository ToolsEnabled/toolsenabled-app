# Qualification guest egress policy — **DECLARATION ONLY; SWITCH ENFORCEMENT REQUIRED**

The transport validates an allow-list declaration plus a dedicated-switch naming convention.
It does not create or configure the switch, and the endpoint list does not constrain packets at
runtime. Until switch enforcement exists, the guest **can still reach the internet**. A run now
refuses when restrictive switch/firewall state cannot be shown; a reassuring switch name is not
accepted as proof.

## What the transport actually does today (read from the code, not from intent)

`tools/lib/transport/QualificationVm.psm1`:

- `Assert-QualificationVmConfig` whitelists the configuration fields:
  `allowedEndpoints` is a declaration; it is not packet enforcement. `Get-VMSwitch` and the
  `ToolsEnabled-Qualification-Egress` outbound block rule must be inspectable or the run refuses
  with `QUALIFICATION_EGRESS_UNPROVEN`.
- IP literals and punycode are accepted endpoint names. Wildcards, CIDR and malformed schemes
  are refused. The shared vectors are `qualification-egress-host-vectors.json`.

The endpoint list is not a qualification result by itself: the first guarded Windows run must
capture DNS/proxy observations and compare them to the configured list.

## The remedy, exactly

A reviewed change to `QualificationVm.psm1`:

1. create/configure the dedicated switch and its restrictive firewall/NAT policy;
2. inspect that policy and prove each allowed endpoint is the only permitted egress;
3. keep `offline` the default, so a configuration that says nothing stays offline;
4. retain refusal tests for malformed endpoints, unshown restriction, offline endpoints/switch,
   and connected baselines.

Sized for the owner's ask at **3–4 hours including Builder 4's security review** (~1 hour of that
is the review, which is the part that cannot be compressed). Security reviewer: Builder 4.

## The hosts — a STARTING SET, and every line of it is unverified

**These are a hypothesis, not a measurement, and they must not be pasted into an allowlist as
they stand.** Stated plainly because a wrong allowlist fails in two directions: too narrow and the
turn dies with a confusing error, too wide and the guest reaches the internet.

| provider | starting hypothesis | how it was arrived at |
| --- | --- | --- |
| Claude CLI | the vendor's API endpoint for the signed-in session | **not measurable statically** — `@anthropic-ai/claude-code` ships a native `claude.exe`, so its endpoints are compiled in |
| Codex CLI | the vendor's API and auth endpoints | same: a packaged binary, not greppable text |
| Gemini CLI | `oauth2.googleapis.com`, `www.googleapis.com` and the generative endpoint | the package's JavaScript mentions Google hosts, but the count is dominated by documentation URLs (`github.com`, `fetch.spec.whatwg.org`), so the set is not trustworthy |

**Why no exact list is offered.** I tried to derive one by inspection and the attempt failed
honestly: two of the three CLIs ship compiled binaries, and the third's source mentions more
documentation hosts than API hosts. An allowlist derived from `grep` would look authoritative and
be wrong.

**How the real list must be produced**, and it is cheap once egress exists at all: run one guarded
turn with the switch attached and a DNS or proxy log on, and take the allowlist from **what the
turn actually resolved**. The first run is therefore a measurement run, not a qualification run,
and its output is the policy's evidence.

## What the guest must never reach, whatever the list says

The owner's own machine and network: no host on the LAN, no file share, no `toolsenabled.ai`
update path (an update check inside a qualification guest would measure the wrong build), and
nothing that could write to the owner's account. The guest is deleted after the run; the
allowlist exists to let one turn happen, not to give the guest a working internet.

## Cleanup and limits

Unchanged from the fresh-install runbook: the VM is deleted after the receipt is copied out, the
login state staged into the guest is removed with it, the receipt names the credential route by
name only and never a value, and no LIVE session is touched.
