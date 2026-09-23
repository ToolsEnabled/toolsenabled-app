#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RETIRED_CROSS_PRODUCT_MARKERS = [
  ["AI", "Cal", "endar"].join(""),
  ["AI", " ", "Calendar"].join(""),
  ["AI", "-", "Calendar"].join(""),
];
const RETIRED_PROVIDER_MARKERS = [
  ["Digital", "Ocean"].join(""),
  ["Digital", " ", "Ocean"].join(""),
  ["Digital", "-", "Ocean"].join(""),
];
const OWNER_MIRROR_DEFAULT_MARKER = ["agent", "_", "mirror"].join("");
const OWNER_GITHUB_HANDLE_MARKER = ["joshua", "pinckard"].join("");

// PATTERNS ARE IN TWO HALVES, AND THE SPLIT IS THE POINT.
//
// This product started as one person's personal tool and is becoming something
// strangers install. Some of what must never ship is true for ANY builder -- a home
// directory path, a credential variable name, the internal name of this repository.
// Those are product facts and belong here, in code.
//
// The rest is WHO THE BUILDER IS: their name, username, account aliases, LAN range.
// That is user data. Hardcoding it protects exactly one person and gives the next one
// nowhere to put their own, so it lives in private/owner-data-patterns.owner.json.
//
// The mechanism is code. The identity is a setting.

// UNTRACKING IS NOT HISTORY REMOVAL. Keeping this profile under private/ prevents
// future commits from carrying it, but values already committed still exist in Git
// history. Publishing this repository publicly therefore requires a fresh repository
// or a history rewrite; untracking alone is not sufficient.

// Built-in: true for anyone who builds this product, regardless of who they are.
const BUILT_IN_PATTERNS = [
  // Home-directory paths. Any absolute user path leaks the builder's account name
  // even when the account name itself is not in the identity profile.
  { label: String.raw`C:\Users`, bytes: Buffer.from(String.raw`C:\Users`), caseInsensitive: true },
  { label: "C:/Users", bytes: Buffer.from("C:/Users"), caseInsensitive: true },
  // THE ESCAPED FORM IS A THIRD ENCODING, AND IT WAS THE ONE THAT SHIPS.
  //
  // The two rules above are byte scans. The first looks for C : \ U s e r s. A JSON
  // file escapes its backslashes, so a path stored in one is C : \ \ U s e r s on
  // disk, and the fourth byte compared is a backslash where the needle wants "U" --
  // no offset can match. MEASURED 2026-09-07, three one-file payloads carrying the
  // same path and nothing else identifying: the plain form was refused, the
  // file:///C:/Users/ form was refused, and {"workingDirectory":"C:\\Users\\..."}
  // produced "Total matches: 0." and EXIT 0.
  //
  // That is the encoding most of the artefact's own metadata is written in -- every
  // JSON record, every lockfile, every serialized config -- so the rule written to
  // keep the builder's home directory out of the bundle was blind precisely where
  // the bundle keeps paths. Same failure as the release seal records, where
  // `Select-String 'C:\Users'` returns nothing over files in which every value is a
  // profile path. A zero is a claim about the instrument first.
  //
  // Kept as a SEPARATE rule rather than widening the literal above to \\{1,2}: an
  // overlapping rule would count the plain form twice, and the "Total matches: N"
  // line is parsed by cut-release-candidate.mjs into the release declaration. This
  // matches only the doubled form, so no existing count changes.
  //
  // Any drive letter, not just C: -- a checkout on D: leaks the same account name --
  // and the same lookbehind the drive-rooted rule below uses, so a URL scheme ending
  // in a letter (https, wss, file) cannot be read as a drive.
  //
  // AND IT MUST BE FOLLOWED BY AN ACCOUNT NAME. This rule was first written as
  // `[A-Za-z]:\\Users` and measured over the real staged payload before being
  // committed. It produced exactly one match, and the match was a FALSE POSITIVE of
  // the same kind this file has already had to correct three times:
  //
  //   capability/src/lib/account-profile-boundary.js
  //     /^([a-z]:\\users\\[^\\]+)(?:\\|$)/i
  //
  // That is the product's OWN profile-boundary regex -- the code that decides
  // whether a path escapes the account it belongs to -- and in JavaScript source a
  // backslash in a regex is written doubled. It contains no account, no machine and
  // no person: `[a-z]:` is a character class, and the rule was reading the `z` in it
  // as a drive letter. Forbidding it would have forbidden the fence's own
  // implementation, which is the "flagged the credential-isolation code as a privacy
  // defect" mistake recorded above, and the consequence is always the same -- the
  // build is passed with --allow-owner-data and then the guard protects nothing.
  //
  // What leaks is not the escaping, it is the ACCOUNT NAME after it. So a literal
  // name character is required after `Users\\`. `C:\\Users\\some-builder` matches;
  // `[a-z]:\\users\\[^\\]+` does not, because the next character is `[`. Measured
  // again after the refinement: 0 matches over the same 388-file payload, and the
  // three-encoding test still fails without this rule.
  { label: String.raw`<drive>:\\Users\\<account> (JSON-escaped)`, regex: /(?<![A-Za-z])[A-Za-z]:\\\\Users\\\\[A-Za-z0-9._-]/gi },
  // AND THE PERCENT-ENCODED FORM, WHICH IS A FOURTH SPELLING OF THE SAME LEAK.
  //
  // `C%3A%5CUsers%5C<account>` is what a Windows path becomes once it has been
  // through encodeURIComponent -- a query string, a saved URL, a webview state
  // blob, a devtools trace, an error object serialized into a log the renderer
  // then persists. None of the three rules above can see it: the colon and the
  // separators are gone, replaced by %3A and %5C, so there is no `C:` and no
  // backslash left to match on.
  //
  // The `file:///C:/Users/` spelling is deliberately NOT handled here -- it is
  // already caught by the `C:/Users` literal above, and adding a second rule for
  // it would double-count the same hit in the "Total matches: N" line that
  // cut-release-candidate.mjs parses into the release declaration. The test
  // asserts that form refuses, so the coverage is pinned even though the rule is
  // not restated.
  //
  // Same account-name requirement as the JSON-escaped rule, for the same reason:
  // what leaks is the account, not the encoding. %2F is included because an
  // encoded path may use either separator. MEASURED over the real 388-file staged
  // payload before adding: zero matches.
  { label: '<drive>%3A%5CUsers%5C<account> (percent-encoded)', regex: /(?<![A-Za-z])[A-Za-z]%3A(?:%5C|%2F|\/)Users(?:%5C|%2F|\/)[A-Za-z0-9._-]/gi },
  // AND EVERY OTHER SEPARATOR COUNT, WHICH IS WHERE THE THREE RULES ABOVE STOP.
  //
  // The rules above cover exactly two separator counts: ONE (the two byte scans,
  // `C:\Users` and `C:/Users`) and TWO BACKSLASHES (the JSON-escaped regex). Nothing
  // covers any other count, and a byte scan cannot stretch: looking for C : \ U s e r s
  // in `C:\\\Users` compares a backslash where the needle wants "U", at every offset,
  // exactly as the JSON-escaped comment above describes for the doubled form.
  //
  // MEASURED 2026-09-10 with one-file payloads carrying only the path, against the
  // guard as it stood, using a neutral account so the identity profile could not
  // catch them instead:
  //
  //   {"cwd":"C:\Users\some-builder\ws"}      -> refused,  Total matches: 1
  //   {"href":"file:///C:/Users/some-builder"} -> refused,  Total matches: 1
  //   {"cwd":"C:\\Users\\some-builder\\ws"}   -> refused,  Total matches: 1
  //   {"cwd":"C:\\\\Users\\\\some-builder"}   -> PASSED,   Total matches: 0
  //   {"cwd":"C:\\\Users\some-builder\ws"}    -> PASSED,   Total matches: 0
  //   {"href":"C://Users/some-builder/ws"}    -> PASSED,   Total matches: 0
  //   {"href":"C:\/Users/some-builder/ws"}    -> PASSED,   Total matches: 0
  //
  // Four spellings of the same leak, through. Double-escaping is not exotic: it is
  // what happens when an already-escaped JSON record is serialised into another JSON
  // record, which is what a log line carrying a state blob is. `C://` is what path
  // joining produces when a root and a relative part both bring their own separator.
  //
  // THIS RULE ADDS COVERAGE AND CHANGES NO EXISTING COUNT, which the comments above
  // establish is the binding constraint here -- "Total matches: N" is parsed by
  // cut-release-candidate.mjs into the release declaration, so a rule that overlaps
  // an existing one corrupts a published number. It cannot overlap, by construction:
  // `[\\/]{2,}` cannot match the single-separator forms the byte scans own, and the
  // negative lookahead hands the exactly-two-backslash form back to the JSON-escaped
  // rule that already owns it. The result is a strict union, not a replacement.
  //
  // The same lookahead also preserves the false-positive correction the JSON-escaped
  // rule was refined for. `capability/src/lib/account-profile-boundary.js` contains
  // the product's own fence regex `/^([a-z]:\\users\\[^\\]+)(?:\\|$)/i` -- a character
  // class, not a drive. Its two backslashes put it inside the lookahead, so this rule
  // never sees it, and the account-name requirement after `Users` would reject it
  // anyway because the next character is `[`.
  { label: String.raw`<drive>:<repeated separators>Users<separator><account>`, regex: /(?<![A-Za-z])[A-Za-z]:(?!\\\\Users)[\\/]{2,}Users[\\/]+[A-Za-z0-9._-]/gi },
  // CREDENTIALS ARE MATCHED BY VALUE SHAPE, NOT BY VARIABLE NAME.
  //
  // This rule used to be the literals ANTHROPIC_API_KEY and OPENAI_API_KEY, on the
  // reasoning that a shipped file naming a secret env var teaches an attacker what to
  // look for. That reasoning does not survive contact with the payload. Those variable
  // names are public, documented by their own vendors; knowing one reveals nothing. And
  // of the ten matches the name rule actually produced, the load-bearing one was in
  // src/lib/providers/cli-provider-gateway.js -- the code that DELETES those variables
  // from bounded child environments so a spawned CLI cannot inherit the operator's
  // credentials. The rest were provider-specific vault KEY NAMES, which are
  // identifiers for a lookup, not secrets.
  //
  // So the old rule flagged the credential-isolation code as a privacy defect. That is
  // worse than useless: the only way to ship with it was --allow-owner-data, and a guard
  // that must be overridden to pass is a guard that is overridden the day a REAL leak is
  // behind it too. Naming a variable is not a leak; carrying its value is.
  //
  // The replacement matches issued key material by its provider prefix and length, which
  // is the thing that must never ship and which the name rule never caught. Coverage
  // goes up, not down: a hardcoded sk-ant-... string was invisible to the old rule and
  // fails this one. Verified by planting one; see the guard-plant note in the P3.4 record.
  { label: "provider API key value (sk-...)", regex: /\bsk-[A-Za-z0-9_-]{20,}/g },
  // Retired cross-product and provider namespaces must not return in shipped
  // bytes. Keep these builder-independent: relying on one operator's private
  // identity profile would make the next builder blind to the same leak.
  ...RETIRED_CROSS_PRODUCT_MARKERS.map((value) => ({ label: "retired cross-product metadata", bytes: Buffer.from(value), caseInsensitive: true })),
  ...RETIRED_PROVIDER_MARKERS.map((value) => ({ label: "retired provider metadata", bytes: Buffer.from(value), caseInsensitive: true })),
  { label: "owner mirror default", bytes: Buffer.from(OWNER_MIRROR_DEFAULT_MARKER), caseInsensitive: true },
  { label: "owner GitHub handle", bytes: Buffer.from(OWNER_GITHUB_HANDLE_MARKER), caseInsensitive: true },
  // Internal repository and tree names are forbidden. The product's OWN public
  // identity is not, and must not be caught by the same rule -- those are two
  // different things that happen to share a word.
  //
  // toolsenabled-current names the private working layout this product is
  // built from, and appeared in shipped failure text rendered into the DOM.
  // That is unambiguously a tree-name leak and stays matched exactly as
  // written.
  //
  // A bare, unanchored "ToolsEnabled" used to sit here too, and it was wrong.
  // It was written when "ToolsEnabled" was only ever an internal name, before
  // this product had a public identity of its own -- so at the time, every
  // occurrence really was a leak. That stopped being true the day the product
  // got a real publisher: "ToolsEnabled, Inc." is now the required
  // CompanyName/Publisher (Machine B's acceptance matrix), and the appId is
  // com.toolsenabled.desktop. Since the 2026-08-11 product rename the word is
  // also the ProductName, the FileDescription and the window title, so the
  // reasons not to forbid it have only multiplied. Case-insensitive and
  // unanchored, the bare word matched every one of those, which means it did
  // not just block one manifest field -- it forbade the
  // product's own identity namespace in every future build, forever. The
  // actual owner-data leak in the old rejected build was an identifier of the
  // form com.<owner-username>.missioncontrol, which carries the username; that is
  // caught below, by the identity profile, not by this rule, and remains
  // caught.
  //
  // THE PATH-SEPARATOR REFINEMENT WAS THE SAME MISTAKE ONE STEP SMALLER, and
  // this is the second correction. Matching the word next to a separator was
  // meant to mean "this is a filesystem path". It does not. Measured over the
  // real staged payload it produced 36 matches and every single one was the
  // product's own identity, because a separator next to the product name is
  // what the product's own namespace LOOKS LIKE:
  //
  //   'user-agent': 'ToolsEnabled/1.4'          five providers
  //   \ToolsEnabled-<name>                      Windows scheduled task names,
  //                                             asserted by exact equality in
  //                                             scheduler-adapter.js and
  //                                             state-store.js
  //   \\.\pipe\ToolsEnabled.UacDelegation.V1    the UAC delegation pipe
  //   toolsenabled/agent-playwright-sandbox     the sandbox docker image tag
  //   /opt/toolsenabled/bounded-exec.js         paths INSIDE that image
  //   /toolsenabled/cws/oauth2/callback         our own loopback OAuth route
  //   ToolsEnabled/FRA/workspace-policy/v1      sha256/HMAC domain separators
  //   config/toolsenabled.policy.json           product files, repo-relative
  //
  // The domain separators are the load-bearing case and the reason this rule
  // could never be satisfied by purging: they are hashed into digests and FRA
  // runtime-integrity anchors that already exist, so changing the string
  // invalidates signatures on disk. A rule with zero true positives that is
  // also impossible to satisfy does not get fixed -- it gets overridden, and
  // then it is not protecting anything at all.
  //
  // What the rule was always trying to catch is narrower and has a shape: the
  // tree name as a DIRECTORY COMPONENT OF AN ABSOLUTE PATH ON A REAL MACHINE.
  // That shape needs a drive root, so that is what is matched. None of the
  // product surfaces above have one; a checkout path always does, whether or
  // not it lives under C:\Users -- "D:\dev\ToolsEnabled\src" is caught here
  // and by nothing else in this list.
  //
  // THE DRIVE LETTER MUST NOT BE THE TAIL OF A URL SCHEME, and that is this
  // rule's third correction -- the same over-match one step smaller again.
  // Unanchored, `[A-Za-z]:[\\/]` matches the `s:/` inside `https://`, so
  // `https://toolsenabled.com` parsed as drive `s`, root `/`, zero intervening
  // characters, then `/toolsenabled`. The guard would therefore have refused
  // the product's own website the moment the real URL appeared in any shipped
  // file -- a page footer, a support link, an about box. Nothing shipped that
  // URL yet, which is the only reason this had not fired: it was a trap armed
  // for whoever added the link, and it would have read as "the payload leaks
  // owner data" rather than "the regex is wrong".
  //
  // A drive letter is one letter, so the character before it is never a
  // letter; every scheme that ends in one (https, wss, ws, file) is excluded
  // by that alone. The lookbehind is deliberately `[A-Za-z]` and not `\b`:
  // `\b` would additionally require the preceding character not be a digit or
  // underscore, which would make the guard MISS `9C:\x\toolsenabled`. A leak
  // guard must err towards catching, so this rejects only what a URL scheme
  // can produce and keeps every real-path case `\b` would have kept.
  // tools/test/check-no-owner-data.test.mjs pins both directions.
  { label: "toolsenabled-current", bytes: Buffer.from("toolsenabled-current"), caseInsensitive: true },
  { label: "builder checkout path (<drive>:\\...\\ToolsEnabled)", regex: /(?<![A-Za-z])[A-Za-z]:[\\/][^\r\n]{0,160}?[\\/]toolsenabled/gi },
  // "agent-coord" was here, as an "internal coordination surface". It is not
  // internal. It is the durable memory namespace this product's own shipped
  // tool descriptions instruct agents to use -- memory.set names it as the
  // inter-agent coordination board, and it is the documented agent-to-agent
  // channel. Removing the string from the payload would mean renaming a live
  // namespace that existing durable rows, every running agent and CLAUDE.md
  // all refer to. It also identifies nobody: it is a fixed product string with
  // no builder, machine or account in it. It was 26 of the 113 original
  // matches and not one of them was owner data.
];

// PUBLISHED ATTRIBUTION IS NOT A LEAK, AND THIS IS THE THIRD TIME THIS FILE HAS
// HAD TO SAY SO.
//
// The bare word "ToolsEnabled" was removed from the built-in list because the
// product's own public identity is not owner data, and the path-separator
// refinement was the same mistake one step smaller. The comment above already
// states the principle: "the product's OWN public identity is not [forbidden],
// and must not be caught by the same rule -- those are two different things
// that happen to share a word."
//
// The creator's name is now exactly that case. The identity profile matches the
// surname, and it must keep doing so, because the surname really does appear in
// things that must never ship: account aliases, a hardcoded mail address, a home
// directory. But this product's declared attribution -- decided by the owner and
// required on the binary, in the README, in NOTICE, on the site and in the
// academic citation form -- is the full name "Joshua Pinckard", published on
// purpose. A guard that forbids it does not protect anyone: it forbids the
// product from ever stating who wrote it, which is the one identity fact the
// owner has instructed must be everywhere.
//
// The alternative was to drop the surname from the identity profile. That is the
// dangerous fix, and it is the one this file's own history argues against: it
// would silently stop catching a personal address of the form
// <surname><digits>@<provider> -- and every future incidental occurrence -- and
// the loss would be invisible: the guard would go on reporting clean while
// looking for less than it used to. Absence-as-emptiness again.
//
// (The worked examples below use pinckard99@example.com, a reserved
// documentation address. An earlier version of this comment used a REAL personal
// address to make the same point, which meant the file that exists to stop
// personal data from publishing was itself carrying some. The example has to be
// structurally identical to be worth anything; it does not have to be real.)
//
// So the string stays matched and the ATTRIBUTION is excused, narrowly:
//
//   - Only identity-profile patterns can be excused. The built-in rules above are
//     never excusable, so C:\Users, a drive-rooted checkout path, toolsenabled-current
//     and an sk- key still fail even inside an attribution line. A leak cannot be
//     laundered by putting the creator's name next to it.
//   - A match is excused only when it lies WHOLLY INSIDE an occurrence of one of the
//     exact strings below, in the same file. "Pinckard" inside "Joshua Pinckard" is
//     excused. "Pinckard" inside "pinckard99@example.com" is not, because the
//     attribution string does not occur there. "Josh Pinckard" is not a substring of
//     "Joshua Pinckard", so the informal-name pattern keeps catching what it caught.
//   - Excused matches are COUNTED AND PRINTED, never silently dropped. An excusal
//     that cannot be seen in the output is a bypass wearing a comment.
const PUBLISHED_ATTRIBUTION = [
  // The sole founder and creator, as published. This is the only personal name the
  // product is permitted to carry, and it is required to carry it.
  "Joshua Pinckard",
];

const ATTRIBUTION_PATTERNS = PUBLISHED_ATTRIBUTION.map((value) => ({
  label: value,
  bytes: Buffer.from(value),
  caseInsensitive: true,
}));

// DOCUMENTATION EXAMPLES ARE PRODUCT TEXT -- BUT ONLY THE EXACT SENTENCE IS.
//
// The capability layer ships setup help (config/settings-registry.json, direct-cable
// networking) whose example addresses are 192.168.50.1 and 192.168.50.2. A builder whose
// own LAN uses that prefix is right to list it in the identity profile, and the guard then
// refused the payload over the product's own instructions, telling them the build carried
// their network when it carried only help text (measured 2026-09-10, INVENTORY B1-03).
//
// Excused the same way as published attribution above, and just as narrowly:
//
//   - Only identity-profile patterns can be excused. Built-in rules never are.
//   - A match is excused only when it lies WHOLLY INSIDE an occurrence of one of the
//     exact sentences below, byte for byte and case-sensitive. The same prefix anywhere
//     else in the same file -- a stored address, a log line, the sentence with one
//     address changed -- still fails.
//   - Excused matches are counted and printed on their own line, including the zero.
//
// Editing a sentence here without the shipped text excuses nothing, and editing the
// shipped text without this list makes the guard refuse again, visibly. Both directions
// fail closed; neither can quietly widen what passes.
const PUBLISHED_DOCUMENTATION_EXAMPLES = [
  // config/settings-registry.json: direct-cable network setup, example address pair.
  "192.168.50.1 and 192.168.50.2 with subnet mask 255.255.255.0 work; so does any other pair you prefer.",
];

const DOCUMENTATION_EXAMPLE_PATTERNS = PUBLISHED_DOCUMENTATION_EXAMPLES.map((value) => ({
  label: value,
  bytes: Buffer.from(value),
  caseInsensitive: false,
}));

// Spans of the buffer that published attribution occupies. Computed lazily, and only
// for a file that already produced an identity hit, so a clean scan pays nothing.
function attributionSpans(buffer) {
  const spans = [];
  for (const pattern of ATTRIBUTION_PATTERNS) {
    for (const hit of findMatches(buffer, pattern)) {
      spans.push({ start: hit.offset, end: hit.offset + hit.length });
    }
  }
  return spans;
}

// Spans the exact published documentation sentences occupy. Same laziness as above.
function documentationExampleSpans(buffer) {
  const spans = [];
  for (const pattern of DOCUMENTATION_EXAMPLE_PATTERNS) {
    for (const hit of findMatches(buffer, pattern)) {
      spans.push({ start: hit.offset, end: hit.offset + hit.length });
    }
  }
  return spans;
}

function insideAttribution(spans, hit) {
  const start = hit.offset;
  const end = hit.offset + hit.length;
  return spans.some((span) => start >= span.start && end <= span.end);
}

// THE IDENTITY PROFILE IS REQUIRED, AND A MISSING ONE IS AN ERROR.
//
// Every identity pattern now lives in config. That makes absence dangerous in a way it
// was not when these values were literals: with no profile, this guard still reports a
// clean scan while looking for nothing that identifies anybody. A privacy control that
// passes because it was given nothing to find is the absence-as-emptiness defect this
// project has now found seven times, and it would be at its worst here -- the failure
// is invisible and the consequence ships.
//
// So: missing file, unreadable file, wrong shape, or empty list are all hard errors
// naming the example template. Getting a build to pass must require saying who you are.
// A single named, greppable code for the "file is absent" refusal. It is
// deliberately its own constant (not just prose) so a caller such as
// tools/pack-capability-layer.mjs -- or a human reading a CI log -- can match
// on OWNER_DATA_PATTERNS_MISSING without parsing English, the same way this
// file's exit codes (0/1/2) are a contract callers already match on.
const OWNER_DATA_PATTERNS_MISSING_CODE = "OWNER_DATA_PATTERNS_MISSING";

function loadIdentityPatterns(root) {
  const file = path.join(root, "private", "owner-data-patterns.owner.json");
  const relative = "private/owner-data-patterns.owner.json";

  if (!existsSync(file)) {
    throw new Error(
      `${OWNER_DATA_PATTERNS_MISSING_CODE}: ${relative} is missing.\n` +
        `Expected path (relative to the repository root): ${relative}\n` +
        "This file is owner-provided data, and it must be copied in from wherever the owner " +
        "keeps their filled-in profile for this machine before building; it is not something " +
        "this tool can generate. " +
        "If you are the owner setting up a new checkout for the first time, start from " +
        "config/owner-data-patterns.example.json and fill in your own values instead.\n" +
        "This guard has no identity to look for without it, so it would pass any bundle " +
        "containing your name, username or account aliases.",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${relative} is present but unreadable: ${error.message}`);
  }

  const list = parsed && Array.isArray(parsed.patterns) ? parsed.patterns : null;
  if (!list) throw new Error(`${relative} must contain a "patterns" array.`);
  if (list.length === 0) {
    throw new Error(`${relative} declares no patterns. An empty identity profile protects nobody.`);
  }

  return list.map((entry, index) => {
    const value = typeof entry === "string" ? entry : entry && entry.value;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${relative} entry ${index} has no usable string value.`);
    }
    return {
      label: value,
      bytes: Buffer.from(value),
      caseInsensitive: !(entry && entry.caseSensitive === true),
    };
  });
}

// A PROFILE THAT EXISTS IS NOT YET A PROFILE THAT IS YOURS.
//
// The owner's filled-in profile stays local on purpose: it is their data, and their
// working build on this machine must retain it. A profile can still be copied from a
// different account, restored from an unsafe cache, or supplied incorrectly on a shared
// build machine. The guard above would find that file, scan all 366 MB, and report clean
// while looking for someone else's name, username and aliases. The builder's own identity
// would walk into the installer untouched. Same shape as the empty-profile hole this file
// already closes: the check passes because of what it was not given, the failure is
// invisible, and the consequence ships.
//
// Requiring a profile to EXIST therefore proves nothing about WHOSE it is. So the guard
// also asks whether anything in the profile relates to the account running the build.
//
// The relation test is deliberately loose -- case-insensitive substring in either
// direction -- because the account "builder", the pattern "builder" and a longer alias
// containing it are all the same person, and a stricter rule would reject legitimate
// profiles and get deleted. Loose is enough: the case that must never pass is a profile
// with NOTHING in it relating to the current account, which is exactly what a stranger
// inherits. Built-in patterns are excluded from this test on purpose; they belong to the
// product, not to a person, and letting `C:\Users` vouch for an account named "user"
// would hand back the hole.
const ACCOUNT_OVERRIDE_VARIABLE = "MC_IDENTITY_PROFILE_ACCOUNT";

function detectBuildAccount() {
  const override = process.env[ACCOUNT_OVERRIDE_VARIABLE];

  if (override !== undefined) {
    // The escape hatch exists for CI and shared build machines, whose account name is
    // legitimately not the profile owner's. It renames the account being checked; it
    // never means "skip the check". A blank value is refused rather than ignored,
    // because the empty string is a substring of every pattern -- accepting it would
    // turn this variable into an off switch, which is the hole with extra steps.
    if (!override.trim()) {
      throw new Error(
        `${ACCOUNT_OVERRIDE_VARIABLE} is set but empty. It overrides the account name this ` +
          "guard checks the identity profile against; it cannot switch the check off. Set it to " +
          "the account name private/owner-data-patterns.owner.json describes, or unset it.",
      );
    }
    return { name: override.trim(), source: ACCOUNT_OVERRIDE_VARIABLE };
  }

  let username;
  try {
    username = os.userInfo().username;
  } catch (error) {
    throw new Error(
      `cannot determine which account is building this (${error.message}), so it cannot be ` +
        `checked against private/owner-data-patterns.owner.json. Set ${ACCOUNT_OVERRIDE_VARIABLE} to the ` +
        "account name that profile describes.",
    );
  }

  if (typeof username !== "string" || !username.trim()) {
    throw new Error(
      "the operating system reported an empty account name, so the identity profile cannot be " +
        `checked against it. Set ${ACCOUNT_OVERRIDE_VARIABLE} to the account name ` +
        "private/owner-data-patterns.owner.json describes.",
    );
  }

  return { name: username.trim(), source: "os.userInfo().username" };
}

function relatesToAccount(value, accountName) {
  const pattern = value.trim().toLowerCase();
  const account = accountName.toLowerCase();
  if (!pattern || !account) return false;
  return pattern.includes(account) || account.includes(pattern);
}

function assertProfileBelongsToBuilder(identityPatterns, account) {
  if (identityPatterns.some((pattern) => relatesToAccount(pattern.label, account.name))) return;

  throw new Error(
    "private/owner-data-patterns.owner.json is somebody else's identity profile (it does not mention " +
      `the account building this: ${account.name}). Copy config/owner-data-patterns.example.json ` +
      "to private/owner-data-patterns.owner.json and fill in your own values, or add your own entries. " +
      `[account name from ${account.source}; a build machine whose account legitimately differs ` +
      `can set ${ACCOUNT_OVERRIDE_VARIABLE} to the account the profile describes]`,
  );
}

// THE PATTERN LIST IS DERIVED FROM THE MACHINE, NOT ONLY FROM A HAND-WRITTEN FILE.
//
// T334 (1.0.45 cut): a prose comment in the engine's browser helper named the
// owner's workspace directory -- the folder the live installation sits in -- in
// the spelling the folder actually has on disk. It was staged into the capability
// payload and this guard PASSED it, because the identity profile carried the
// owner's name in other spellings and nobody had written that one down. The same
// list then ran again over the built tree, so the second stage could not catch
// what the first had waved through: one list, checked twice, is one check.
//
// A hand-written list can only ever contain what somebody thought to write. What
// actually leaks is the shape of the machine: the account the build runs as, the
// directory that account lives in, and the directories between that home and the
// checkout or the product's own state roots. Those are all readable here, so they
// are read here, and every spelling a directory name takes in practice -- the
// separator swapped for space, hyphen, underscore or the percent-encoded space, an
// apostrophe dropped -- is generated from each rather than remembered.
//
// SOURCES, each named in the output so a miss can be traced to what was read:
//   - the account this build runs as (os.userInfo().username, or the
//     MC_IDENTITY_PROFILE_ACCOUNT override that renames it);
//   - the home directory's own last segment (os.homedir()), which is the account
//     segment that appears in every absolute profile path and can differ from the
//     login name;
//   - every directory between the home directory and this repository (the
//     workspace the checkout sits in);
//   - every directory between the home directory and each product state root that
//     is set in the environment (the OWNED names tools/lib/scratch-fence.mjs fences:
//     the live installation's state, vault and provider homes). Inside a release
//     cut these are re-pointed into scratch by the fence, so there they name the
//     scratch layout; in the shell that stages the payload they name the live
//     workspace, which is the stage that let the T334 comment through;
//   - MC_IDENTITY_WORKSPACE_SEGMENTS, a path.delimiter-separated list of bare
//     directory NAMES (never paths) that tools/release-packager/
//     cut-release-candidate.mjs buildDistChainEnvironment derives from the LIVE
//     state roots before it re-points them, so the dist-stage scan inside the
//     cut covers the same workspace the pack stage did. Names, not paths, so no
//     variable in the fenced environment resolves to the live installation.
//
// WHAT IS NOT A PATTERN. Two kinds of segment are skipped by rule, and the rule
// is a product fact, not an identity: the operating system's own folder names
// (Desktop, AppData, .config ...) identify nobody and appear in every payload
// that mentions a path; and the product's OWN segments -- the bare product name
// and the live installation segment, exactly -- belong to the product, so
// derivation stops at the first one: the owner's workspace is what sits BETWEEN
// the home directory and the product. A folder the owner named with the product
// name plus their own words (a version, "WorkingFolder") is theirs, and is
// derived like any other. A value
// shorter than DERIVED_MINIMUM_LENGTH (a one-letter account, "app") is skipped
// BY NAME in the output rather than used: as a bare substring it would match
// nearly every file and the guard would be overridden, which is the same
// outcome as not having it.
//
// A pattern set that cannot be shown to hit its own inputs is a refusal, not a
// pass: before the walk, each derived spelling and each identity value is planted
// in a scratch buffer and the assembled pattern set must find it there (see
// assertPatternCoverage). On a miss the guard exits 2 with a named code instead
// of scanning with an instrument it has just proved blind.
export const DERIVED_MINIMUM_LENGTH = 4;
const OWNER_DATA_COVERAGE_SELFCHECK_CODE = "OWNER_DATA_COVERAGE_SELFCHECK_FAILED";
const OWNER_DATA_DERIVATION_UNAVAILABLE_CODE = "OWNER_DATA_DERIVATION_UNAVAILABLE";
export const WORKSPACE_SEGMENTS_UNRESOLVED_CODE = "OWNER_DATA_WORKSPACE_SEGMENTS_UNRESOLVED";
// THE ONE LIST of environment names that point at the owner's live state roots.
// tools/lib/scratch-fence.mjs imports this as its OWNED_NAMES (the names it
// re-points into scratch during a cut), so the fence and this derivation can
// never disagree about which variables name the installation. This file stays
// single-file with no local imports because its test copies it alone into a
// fixture root; the dependency therefore runs the other way.
export const OWNED_STATE_ROOT_NAMES = Object.freeze([
  "TOOLSENABLED_STATE_ROOT",
  "MC_TEST_STATE_ROOT",
  "TOOLSENABLED_STATE_PATH",
  "TOOLSENABLED_VAULT_PATH",
  "APPDATA",
  "LOCALAPPDATA",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "GEMINI_DIR",
]);
const STATE_ROOT_VARIABLES = OWNED_STATE_ROOT_NAMES;
// Operating-system folder names, case-folded. Product facts: true on every
// machine, name nobody.
export const WELL_KNOWN_DIRECTORY_SEGMENTS = new Set([
  "desktop", "documents", "downloads", "pictures", "videos", "music", "public",
  "appdata", "local", "locallow", "roaming", "temp", "tmp", "programdata",
  ".config", ".local", ".cache", "share", "state", "home", "users", "usr", "opt",
  "var", "mnt", "media", "srv", "private",
]);
// The product's own segments, case-folded: the bare product name and the live
// installation segment (LIVE_INSTALLATION_SEGMENT in tools/lib/scratch-fence.mjs).
export const PRODUCT_OWN_SEGMENTS = new Set(["toolsenabled", "toolsenabled-live"]);
// The cutter's hand-over: a JSON array of bare directory NAMES. JSON, not a
// delimiter-joined string, because a directory name may contain ';' or ':'
// and a split on either would turn one name into two that the self-check
// would then happily find.
export const WORKSPACE_SEGMENTS_VARIABLE = "MC_IDENTITY_WORKSPACE_SEGMENTS";
// Set by the release cutters. Inside a cut the hand-over is not optional: a cut
// that cannot say which workspace it is protecting refuses rather than scanning
// with a set it cannot show covers the owner's folder.
export const CUT_CONTEXT_VARIABLE = "MC_OWNER_DATA_CUT_CONTEXT";

/* Is this bare directory name one the guard would use as a pattern? Shared
 * with the cutter so "produced none" means the same thing on both sides:
 * well-known operating-system folders and names below the length floor do
 * not count as a workspace. */
export function isUsableWorkspaceSegment(segment) {
  const trimmed = typeof segment === "string" ? segment.trim() : "";
  if (!trimmed) return false;
  if (WELL_KNOWN_DIRECTORY_SEGMENTS.has(trimmed.toLowerCase())) return false;
  return trimmed.length >= DERIVED_MINIMUM_LENGTH;
}

/* Parse the hand-over. Refuses by name on anything but a JSON array of bare
 * names: a non-JSON value (including the old delimiter-joined form), a
 * non-array, a non-string entry, or a name carrying a path separator. */
export function parseWorkspaceSegments(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${OWNER_DATA_DERIVATION_UNAVAILABLE_CODE}: ${WORKSPACE_SEGMENTS_VARIABLE} is not a JSON array of directory names.`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${OWNER_DATA_DERIVATION_UNAVAILABLE_CODE}: ${WORKSPACE_SEGMENTS_VARIABLE} must be a JSON array of directory names, not ${typeof parsed}.`,
    );
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(
        `${OWNER_DATA_DERIVATION_UNAVAILABLE_CODE}: ${WORKSPACE_SEGMENTS_VARIABLE}[${index}] is not a non-empty string.`,
      );
    }
    if (/[\\/]/.test(entry)) {
      throw new Error(
        `${OWNER_DATA_DERIVATION_UNAVAILABLE_CODE}: ${WORKSPACE_SEGMENTS_VARIABLE}[${index}] carries a path separator; it must ` +
          "list bare directory names, never paths.",
      );
    }
    return entry;
  });
}

function spellingVariants(value) {
  const bases = new Set([value]);
  if (value.includes("'")) bases.add(value.replace(/'/g, ""));
  const variants = new Set();
  for (const base of bases) {
    const tokens = base.split(/%20|[ \-_]+/).filter(Boolean);
    if (tokens.length < 2) {
      variants.add(base);
      continue;
    }
    for (const separator of [" ", "-", "_", "%20"]) variants.add(tokens.join(separator));
  }
  return [...variants];
}

// Segments of `target` strictly below `home`, stopping before the first
// product-named segment; [] when the target is not under the home directory.
// Exported so the cutter derives with the same rule it is later checked by.
export function segmentsBelowHome(target, home, { platform = process.platform } = {}) {
  const fold = (value) => (platform === "win32" ? value.toLowerCase() : value);
  const resolvedHome = path.resolve(home);
  const resolvedTarget = path.resolve(target);
  const prefix = resolvedHome.endsWith(path.sep) ? resolvedHome : resolvedHome + path.sep;
  if (!fold(resolvedTarget).startsWith(fold(prefix))) return [];
  const segments = [];
  for (const segment of resolvedTarget.slice(prefix.length).split(/[\\/]+/)) {
    if (!segment) continue;
    if (PRODUCT_OWN_SEGMENTS.has(segment.toLowerCase())) break;
    segments.push(segment);
  }
  return segments;
}

// Returns { patterns, skipped, sources }. Values never leave this process except
// as pattern labels, exactly as the identity profile's values already do.
function deriveIdentityPatterns({ account, repoRoot, env = process.env, homedir = () => os.homedir() }) {
  const candidates = [];
  const skipped = [];
  const sources = [];
  const add = (value, source) => candidates.push({ value, source });

  add(account.name, account.source);
  sources.push(account.source);

  let home;
  try {
    home = homedir();
  } catch (error) {
    throw new Error(
      `${OWNER_DATA_DERIVATION_UNAVAILABLE_CODE}: os.homedir() failed (${error.message}), so the account ` +
        "segment of the builder's profile path cannot be derived.",
    );
  }
  if (typeof home !== "string" || !home.trim()) {
    throw new Error(
      `${OWNER_DATA_DERIVATION_UNAVAILABLE_CODE}: os.homedir() returned nothing, so the account segment ` +
        "of the builder's profile path cannot be derived.",
    );
  }
  add(path.basename(path.resolve(home)), "os.homedir()");
  sources.push("os.homedir()");

  for (const segment of segmentsBelowHome(path.dirname(repoRoot), home)) {
    add(segment, "repository ancestors below os.homedir()");
  }
  sources.push("repository ancestors below os.homedir()");

  for (const name of STATE_ROOT_VARIABLES) {
    const raw = typeof env[name] === "string" ? env[name].trim() : "";
    if (!raw) continue;
    for (const segment of segmentsBelowHome(raw, home)) add(segment, `env:${name}`);
    sources.push(`env:${name}`);
  }

  const handedOver = parseWorkspaceSegments(env[WORKSPACE_SEGMENTS_VARIABLE]);
  if (handedOver.length) {
    for (const segment of handedOver) add(segment, `env:${WORKSPACE_SEGMENTS_VARIABLE}`);
    sources.push(`env:${WORKSPACE_SEGMENTS_VARIABLE}`);
  }
  // Inside a cut the hand-over is required. The cutter derives the workspace
  // names from what it knows and sets both variables together; a cut-context
  // run that arrives without the names is a cut whose scan cannot be shown to
  // cover the owner's folder, and it refuses here by name instead of passing.
  if (String(env[CUT_CONTEXT_VARIABLE] ?? "").trim() === "1" && handedOver.length === 0) {
    throw new Error(
      `${WORKSPACE_SEGMENTS_UNRESOLVED_CODE}: ${CUT_CONTEXT_VARIABLE}=1 but ${WORKSPACE_SEGMENTS_VARIABLE} names no ` +
        "workspace directory. Inside a release cut the cutter must hand the owner's workspace names across; a scan " +
        "without them cannot be shown to cover the owner's folder, so it is refused rather than reported clean.",
    );
  }

  // Which sources actually contributed a WORKSPACE name (a segment that will
  // become a pattern), as opposed to the account and home segment that every
  // run has. Standalone runs print this so a reader can see when the owner's
  // workspace spelling was not derived at all.
  const workspaceSources = [...new Set(
    candidates
      .filter(({ source }) => source !== account.source && source !== "os.homedir()")
      .filter(({ value }) => isUsableWorkspaceSegment(value))
      .map(({ source }) => source),
  )];

  const seen = new Set();
  const patterns = [];
  for (const { value, source } of candidates) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (WELL_KNOWN_DIRECTORY_SEGMENTS.has(trimmed.toLowerCase())) continue;
    if (trimmed.length < DERIVED_MINIMUM_LENGTH) {
      skipped.push(
        `${source}: value is ${trimmed.length} character(s), below the ${DERIVED_MINIMUM_LENGTH}-character ` +
          "floor for a bare substring",
      );
      continue;
    }
    for (const variant of spellingVariants(trimmed)) {
      const key = variant.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // wordBounded: T369 finding 2. A derived spelling is a machine value, not
      // a hand-authored secret, and its separator variants ("ToolsEnabled Dev"
      // from the account "ToolsEnabled-Dev") can be an accidental substring of
      // ordinary shipped copy -- "ToolsEnabled development" false-flagged the
      // product's own fenced-profile message. So a derived value counts only as
      // a whole word: the byte on each side of the match must be a non-word byte
      // (or start/end). The product token is NOT stripped -- an account literally
      // written "ToolsEnabled Dev" as its own word is still caught.
      patterns.push({ label: variant, bytes: Buffer.from(variant), caseInsensitive: true, derivedFrom: source, wordBounded: true });
    }
  }
  return { patterns, skipped, sources, workspaceSources };
}

// Plant each value the guard claims to cover in a scratch buffer and require the
// assembled set to find it. Identity values are checked too: a profile entry the
// scanner cannot see (an empty string slipped through, an encoding surprise) is
// the same blindness with a different cause.
function assertPatternCoverage(activePatterns, expectations) {
  const misses = [];
  for (const { value, source } of expectations) {
    const planted = Buffer.from(`scratch/${value}/planted.json`);
    const hit = activePatterns.some((pattern) => findMatches(planted, pattern).length > 0);
    if (!hit) misses.push(source);
  }
  if (misses.length === 0) return;
  throw new Error(
    `${OWNER_DATA_COVERAGE_SELFCHECK_CODE}: the assembled pattern set does not match ${misses.length} ` +
      `value(s) it is required to cover (from: ${[...new Set(misses)].join(", ")}). The scan was not ` +
      "started, because a zero from an instrument that cannot see its own inputs is not a measurement.",
  );
}

// Resolved at the START of main, not at module load. Both matter:
//
// - Not at module load, because a throw there escapes main()'s catch, exits 1 -- the
//   code that means MATCHES WERE FOUND -- and prints a Node stack trace. A setup
//   problem must not be indistinguishable from a leak, and the person most likely to
//   see it is a new user who needs one sentence, not a traceback.
// - Still before the walk, so a broken profile fails in milliseconds rather than
//   part-way through 366 MB.
let ACTIVE_PATTERNS = [];

function asciiLower(byte) {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

// ONE-BYTE-PER-CHARACTER WAS AN ASSUMPTION, AND THE BINARY BROKE IT.
//
// Every pattern here used to be matched only as single-byte text. That is right for
// the .js, .json and .asar content this guard was written against, and it is WRONG for
// the one file in the bundle that matters most: the .exe itself.
//
// Windows stores a PE file's VersionInfo -- CompanyName, LegalCopyright, ProductName --
// as UTF-16LE. "Pinckard" in that block is P\0i\0n\0c\0k\0a\0r\0d\0, which shares no
// byte sequence with the ASCII form, so the single-byte scan cannot see it at any
// offset. Measured, not reasoned: with the copyright line reading the creator's name in
// both executables, a full scan of release/win-unpacked reported "Pinckard"=0 and
// "Excused as published attribution: 0". The guard walked 372 MB, read the name twice,
// and reported that it had found nothing.
//
// That is the failure mode this file already names in three other places: the check
// passes because of what it could not see, and the consequence ships. It is at its worst
// here, because VersionInfo is precisely where publisher identity lives, so it is exactly
// where a builder's real name or company would end up by accident.
//
// So literals are searched in both encodings, and the regex rules are run over both
// decodings. Cost of adding it, measured over the same build: one new occurrence, which
// is the intended attribution and is excused. It surfaced no other match, so this widens
// what the guard can see without widening what it complains about.
//
// Returns {offset, length} rather than a bare offset because a pattern may be a regex,
// whose match length varies per hit, and because a UTF-16 hit is twice the byte length
// of the same text -- both are what the excerpt window has to be centred on.
function wideBytes(pattern) {
  // Memoised on the pattern object. For every non-regex rule the label IS the literal
  // being searched for, which is what makes this derivable rather than hand-maintained:
  // a rule added later cannot forget to declare its UTF-16 form.
  if (pattern.wide === undefined) pattern.wide = Buffer.from(pattern.label, "utf16le");
  return pattern.wide;
}

// A word byte for boundary purposes: ASCII letter, digit or underscore. Any
// other byte -- space, punctuation, control, a high byte -- is a boundary.
function isWordByte(byte) {
  return (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || byte === 95;
}

// Is the character adjacent to a match a word character, given the encoding
// stride? For the narrow (1-byte) scan the adjacent byte is the character. For
// the wide (UTF-16LE, 2-byte) scan the adjacent character is a code unit whose
// low byte carries the ASCII value only when its high byte is zero; a non-zero
// high byte is a non-ASCII character, which is a boundary.
function adjacentIsWord(buffer, position, stride, direction) {
  if (direction < 0) {
    const low = position - stride;
    if (low < 0) return false;
    return stride === 1 ? isWordByte(buffer[low]) : (buffer[low + 1] === 0 && isWordByte(buffer[low]));
  }
  if (position + stride > buffer.length) return false;
  return stride === 1 ? isWordByte(buffer[position]) : (buffer[position + 1] === 0 && isWordByte(buffer[position]));
}

function scanBytes(buffer, needle, caseInsensitive, { wordBounded = false, stride = 1 } = {}) {
  const found = [];
  if (needle.length === 0) return found;
  const lastStart = buffer.length - needle.length;

  for (let start = 0; start <= lastStart; start += 1) {
    let matched = true;
    for (let index = 0; index < needle.length; index += 1) {
      const actual = buffer[start + index];
      const expected = needle[index];
      if (caseInsensitive ? asciiLower(actual) !== asciiLower(expected) : actual !== expected) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const end = start + needle.length;
    // A word-bounded (derived) needle counts only as a whole word: reject a hit
    // whose neighbouring character on either side is itself a word character.
    if (wordBounded && (adjacentIsWord(buffer, start, stride, -1) || adjacentIsWord(buffer, end, stride, 1))) continue;
    found.push({ offset: start, length: needle.length });
  }

  return found;
}

function findMatches(buffer, pattern) {
  if (pattern.regex) {
    const found = [];

    // latin1 maps one byte to one character with no multi-byte collapsing, so
    // string indices ARE byte offsets. Decoding as utf8 here would silently
    // shift every reported offset in any file containing a non-ASCII byte, and
    // would drop bytes that are not valid utf8 -- which is exactly where
    // something could hide from this scan.
    const runOver = (text, byteScale) => {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(text)) !== null) {
        found.push({ offset: match.index * byteScale, length: match[0].length * byteScale });
        if (match[0].length === 0) pattern.regex.lastIndex += 1;
      }
    };

    runOver(buffer.toString("latin1"), 1);
    // Each UTF-16 code unit is exactly two bytes, so a string index in this decoding
    // maps to a byte offset by doubling. Even alignment only, which is what the PE
    // resource sections and every real UTF-16 payload use.
    runOver(buffer.toString("utf16le"), 2);

    return found;
  }

  const wordBounded = pattern.wordBounded === true;
  return [
    ...scanBytes(buffer, pattern.bytes, pattern.caseInsensitive, { wordBounded, stride: 1 }),
    ...scanBytes(buffer, wideBytes(pattern), pattern.caseInsensitive, { wordBounded, stride: 2 }),
  ];
}

function excerpt(buffer, offset, matchLength) {
  const maximumLength = 120;
  const context = Math.floor((maximumLength - matchLength) / 2);
  const start = Math.max(0, offset - context);
  const end = Math.min(buffer.length, offset + matchLength + context);
  const printable = Array.from(buffer.subarray(start, end), (byte) =>
    byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".",
  ).join("");

  return `${start > 0 ? "..." : ""}${printable}${end < buffer.length ? "..." : ""}`;
}

async function walk(directory, visitFile) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;

    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(entryPath, visitFile);
    } else if (entry.isFile()) {
      await visitFile(entryPath);
    }
  }
}

// A GREEN THAT DOES NOT SAY WHAT IT SCANNED IS NOT A MEASUREMENT.
//
// The fallback below is useful and stays. What was dangerous was that it was
// SILENT. Measured on 2026-08-11: with release/ deleted, a bare
// `node tools/check-no-owner-data.mjs` scanned dist/ -- 36 files, 1.8 MB -- and
// printed "Total matches: 0." The shipping payload it was believed to have
// cleared is 330 files and 473 MB. Nothing in the output distinguished those two
// runs, so a reader had no way to tell a cleared installer from a cleared
// renderer bundle.
//
// That is this file's own recurring defect wearing a new hat: the check passes
// because of what it was not given, and the failure is invisible. Compare
// tools/test/license-trust-anchor-payload.test.mjs, which hit the same missing
// directory in the same tree on the same day and failed LOUDLY, naming the path
// it could not find. The test was honest and the guard was not.
//
// So the choice is now reported, and an IMPLICIT choice says so. This changes no
// exit code and no scan behaviour -- every caller in `npm run dist` passes its
// directory explicitly and is unaffected -- it only makes the bare run state
// which artifact it actually read.
function chooseRoots(arguments_) {
  if (arguments_.length > 0) return { roots: arguments_, implicit: false };
  if (existsSync("release")) return { roots: ["release"], implicit: true };
  if (existsSync("dist")) return { roots: ["dist"], implicit: true, fellBackFrom: "release" };
  throw new Error('nothing to check: pass a directory, or create "release" or "dist"');
}

async function main() {
  // Load, then prove ownership, then walk. Both checks are cheap and both run before a
  // single file is read, so a setup problem costs milliseconds instead of surfacing
  // part-way through 366 MB -- and both throw inside main(), so they exit 2 with one
  // sentence rather than 1 with a stack trace.
  const identityPatterns = loadIdentityPatterns(REPO_ROOT);
  const account = detectBuildAccount();
  assertProfileBelongsToBuilder(identityPatterns, account);
  // T334: spellings derived from the machine join the hand-written profile. A
  // derived value that duplicates a profile entry (same bytes, any case) is
  // dropped so no literal is counted twice in "Total matches: N".
  const identityKeys = new Set(identityPatterns.map((pattern) => pattern.label.toLowerCase()));
  const derived = deriveIdentityPatterns({ account, repoRoot: REPO_ROOT });
  const derivedPatterns = derived.patterns.filter((pattern) => !identityKeys.has(pattern.label.toLowerCase()));
  // builtIn is set here rather than on each literal above so the marker cannot be
  // forgotten on a rule added later. Built-in rules are the ones attribution may
  // never excuse.
  // Every pattern gets an ID that is safe to print. Built-in rules are product
  // facts and keep their label; a profile entry or a derived spelling IS the
  // owner's value, so it is referred to by class and index only. The per-hit
  // excerpt lines are the one place a value appears, and there it is the file's
  // own bytes, which the reader needs in order to fix the file.
  ACTIVE_PATTERNS = [
    ...BUILT_IN_PATTERNS.map((pattern, index) => ({ ...pattern, builtIn: true, id: `builtin#${index + 1}(${pattern.label})` })),
    ...identityPatterns.map((pattern, index) => ({ ...pattern, id: `profile#${index + 1}` })),
    ...derivedPatterns.map((pattern, index) => ({ ...pattern, id: `derived#${index + 1}(${pattern.derivedFrom})` })),
  ];
  // Printed before the walk and before the self-check, values withheld: the
  // sources and the count are what a reader needs to know whether the machine
  // was read; the values are the owner's.
  console.log(
    `Derived identity spellings: ${derivedPatterns.length} active (from ${derived.sources.join(", ")}); ` +
      `${derived.patterns.length - derivedPatterns.length} duplicate(s) of profile entries dropped.`,
  );
  for (const reason of derived.skipped) console.log(`Derived identity spelling skipped: ${reason}`);
  // One line that says whether the owner's WORKSPACE (not just the account) is
  // covered by derivation, and from where. Inside a cut the absence is a
  // refusal (see deriveIdentityPatterns); standalone it is a warning, because a
  // developer scanning a scratch directory from a lane worktree has no live
  // roots in the shell and should know the scan is narrower for it.
  if (derived.workspaceSources.length) {
    console.log(`Workspace directory names derived from: ${derived.workspaceSources.join(", ")}.`);
  } else {
    console.log(
      "WARNING: no source yielded a workspace directory name (checked: repository ancestors below os.homedir(), " +
        `${STATE_ROOT_VARIABLES.join(", ")}, ${WORKSPACE_SEGMENTS_VARIABLE}); the owner's workspace spelling is NOT ` +
        "covered by derivation in this run, only the account and home segments are.",
    );
  }
  assertPatternCoverage(ACTIVE_PATTERNS, [
    ...identityPatterns.map((pattern) => ({ value: pattern.label, source: "private/owner-data-patterns.owner.json" })),
    ...derived.patterns.map((pattern) => ({ value: pattern.label, source: pattern.derivedFrom })),
  ]);
  const rootChoice = chooseRoots(process.argv.slice(2));
  const roots = rootChoice.roots;
  // Printed BEFORE the walk, so a run that is about to scan the wrong thing says
  // so even if it is later killed, and so the line sits above the matches rather
  // than after a screen of them.
  if (rootChoice.fellBackFrom) {
    console.log(
      `NOTE: no "${rootChoice.fellBackFrom}" directory here, so this scanned ${JSON.stringify(roots)} instead. ` +
        `That is NOT the packaged installer. To clear the shipping payload, build it and scan it by name ` +
        `(this is what "npm run dist" does: check-no-owner-data.mjs release/win-unpacked).`,
    );
  } else if (rootChoice.implicit) {
    console.log(`Scanning ${JSON.stringify(roots)} (chosen by default; no directory was named on the command line).`);
  } else {
    console.log(`Scanning ${JSON.stringify(roots)} (named on the command line).`);
  }
  let filesScanned = 0;
  let bytesScanned = 0;
  let totalMatches = 0;
  let attributionExcused = 0;
  let documentationExcused = 0;
  const perPattern = new Map(ACTIVE_PATTERNS.map(({ id }) => [id, 0]));

  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    let rootStat;
    try {
      rootStat = await lstat(resolvedRoot);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`nothing to check: directory does not exist: ${root}`);
      }
      throw error;
    }

    if (rootStat.isSymbolicLink()) {
      throw new Error(`nothing to check: refusing to follow symlink: ${root}`);
    }
    if (!rootStat.isDirectory()) {
      throw new Error(`nothing to check: not a directory: ${root}`);
    }

    await walk(resolvedRoot, async (filePath) => {
      const buffer = await readFile(filePath);
      filesScanned += 1;
      bytesScanned += buffer.length;

      let spans = null;
      let exampleSpans = null;

      for (const pattern of ACTIVE_PATTERNS) {
        const hits = findMatches(buffer, pattern);
        if (hits.length === 0) continue;

        // Built-in rules are product facts, never excusable. Only the identity
        // profile can be satisfied by published attribution.
        let reportable = hits;
        if (!pattern.builtIn) {
          if (spans === null) spans = attributionSpans(buffer);
          if (spans.length > 0) {
            reportable = hits.filter((hit) => !insideAttribution(spans, hit));
            attributionExcused += hits.length - reportable.length;
          }
          if (exampleSpans === null) exampleSpans = documentationExampleSpans(buffer);
          if (exampleSpans.length > 0) {
            const before = reportable.length;
            reportable = reportable.filter((hit) => !insideAttribution(exampleSpans, hit));
            documentationExcused += before - reportable.length;
          }
        }

        if (reportable.length === 0) continue;

        totalMatches += reportable.length;
        perPattern.set(pattern.id, perPattern.get(pattern.id) + reportable.length);
        // The pattern is named by class and index, never by its value: this line
        // and the closing summary are what a cutter writes into its step log.
        console.log(`${filePath} | pattern=${pattern.id} | matches=${reportable.length}`);
        for (const hit of reportable) {
          console.log(`  offset=${hit.offset} | excerpt=${JSON.stringify(excerpt(buffer, hit.offset, hit.length))}`);
        }
      }
    });
  }

  if (filesScanned === 0) {
    throw new Error(`nothing to check: scanned 0 files in ${roots.length} director${roots.length === 1 ? "y" : "ies"}`);
  }

  // DO NOT REWORD THIS LINE. tools/release-packager/cut-release-candidate.mjs parses it
  // with /Scanned (\d+) files \((\d+) bytes\)\. Total matches: (\d+)\./ to put the
  // owner-data evidence into the release declaration, and a miss there is SILENT --
  // extractPipelineFacts just records null and the declaration ships without the number.
  // Adding ", single-byte and UTF-16LE" mid-sentence broke exactly that, which is why the
  // encoding note is its own line below instead.
  console.log(`Scanned ${filesScanned} files (${bytesScanned} bytes). Total matches: ${totalMatches}.`);
  console.log("Encodings scanned: single-byte and UTF-16LE.");
  console.log(
    `Per-pattern matches: ${ACTIVE_PATTERNS.map(({ id }) => `${id}=${perPattern.get(id)}`).join(", ")}`,
  );
  // Printed unconditionally, including the zero. A number that only appears when it is
  // non-zero teaches nobody that the mechanism exists, and the first time it is non-zero
  // it looks like a new thing rather than a working one.
  console.log(
    `Excused as published attribution: ${attributionExcused} ` +
      `(permitted strings: ${PUBLISHED_ATTRIBUTION.map((value) => JSON.stringify(value)).join(", ")}; ` +
      "built-in rules are never excused).",
  );
  console.log(
    `Excused as published documentation example: ${documentationExcused} ` +
      `(permitted exact sentences: ${PUBLISHED_DOCUMENTATION_EXAMPLES.map((value) => JSON.stringify(value)).join(", ")}; ` +
      "built-in rules are never excused).",
  );

  if (totalMatches > 0) process.exitCode = 1;
}

// Runs only as the entry point. tools/lib/scratch-fence.mjs and the release
// packager import the exported names above (the owned state-root list, the
// segment rules) so the two sides cannot drift; an import must never start a
// scan. Compared by filesystem identity, not argv spelling, the same way
// tools/check-unbound-identifiers.mjs does, so a junction spelling on Windows
// still counts as the entry point.
if (process.argv[1]
  && realpathSync.native(path.resolve(process.argv[1])) === realpathSync.native(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`Owner-data guard error: ${error.message}`);
    process.exitCode = 2;
  });
}
