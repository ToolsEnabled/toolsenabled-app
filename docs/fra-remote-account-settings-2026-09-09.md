# Remote Tools and Research account settings

The public binding lacked `mcAccount.getSetting(key)` and
`putSetting(key, value)`. Authenticated Tools and Research therefore refused
their account-backed controls even when the remote tool list and agent ran.

The new facade controller exposes only `agent_tool_states`,
`agent_tools_disabled`, `research_queue`, and `research_experiments`. It uses
the existing native account store and its string/null contract. It does not
expose arbitrary settings, payment/vault data, full working profiles, or
Research benchmark chunk keys.

The relay's machine identity alone is insufficient to authorize account data.
For every operation, the native controller verifies the existing device/pair
against the existing hosted desktop session through
`GET /v1/desktop/device-settings-access`. The account service resolves the
desktop cookie itself and returns only its account ID/email and the matched
device/pair. No browser-supplied account identity is accepted.

The native controller checks the current local hosted account before and after
verification, including its local session ID. Connection generation and relay
owner are checked after both asynchronous steps; writes also recheck the
native Drive switch. The final store operation is synchronous. Account erase
tracks these pending operations and closes admission before its cleanup.
These are request-time checks, not an atomic transaction across the separate
account service, relay and native processes.

Reads use `GET /v1/agent/account-setting?key=...`; writes use
`POST /v1/agent/account-setting-put` with `{key,value}`. Existing facade Origin,
bearer, request-size and response-size gates apply. The native 65,536-character
limit remains, while the existing 64 KiB HTTP request bound can reject smaller
multi-byte or escaped values. No truncation or automatic overwrite is added.

Tools disables mutations and labels defaults when saved choices cannot be
verified. Research keeps its forms closed and displays the actual account
connection refusal. Failed writes keep the existing native return code and a
bounded explanation; they do not become a generic sign-in instruction.

Validation includes actual isolated hosted account partitions, real loopback
account-service HTTP/password sessions and device registry, facade HTTP gates,
browser binding contracts, and mounted view behavior. The source stage does
not claim deployed authenticated UI or physical microphone acceptance. Those
remain in the ongoing FRA campaign after promoter-owned integration of the
server, app and website dependencies.
