# Native QA provider selection

Use `node tools/page2-native-audit.cjs --real-provider --codex-profile-home PATH`
to select the person's existing Codex home in place. `--codex-home` is an alias.
The official CLI handles sign-in and may refresh its own state normally. The QA
helper does not open, hash, copy, link, write, or remove a provider sign-in file.

Without a home argument, real-provider mode requires `OPENAI_API_KEY` or
`CODEX_API_KEY` in the environment. Provider runs spend provider budget.
Provider-free first-use mode retains its generated empty profile.

The QA registry uses the selected home directly with a manual provider policy.
Verification checks that registry selection and session account receipts remain
bound to recorded successful starts. It cannot establish a provider account
fingerprint from authentication bytes. The former credential fingerprint and
credential retention options have been removed; they are unknown arguments.

Receipts contain QA registry and session metadata only. There is no temporary
sign-in profile, credential custody receipt, or credential cleanup step.
Removing QA scratch must never remove the original selected provider home.
