#!/usr/bin/env node

// THE OPEN / PAID BOUNDARY, AS A BUILD GATE RATHER THAN A RULE.
//
// This product is being open-sourced except for a paid part. The decision of
// WHERE that line goes belongs to the owner. This file does not contain the
// decision -- config/payload-boundary.json does. This file is the mechanism
// that makes the decision take effect, and makes getting it wrong loud.
//
// WHY A GATE AND NOT A WRITTEN RULE. "Do not publish the paid part" as prose
// has already failed on this project in the general case: a standing order was
// retired in one tree and changed nothing, because the live hook ran from a
// different tree; three separate lanes independently found the live scheduled
// tasks executing the retired tree. Prose depends on someone remembering, at
// the moment it matters, which tree they are in. A gate does not.
//
// WHAT IS ACTUALLY AT RISK. The installer's capability payload
// (resources/capability/) is 224 PLAIN .js FILES. Not compiled, not minified,
// not obfuscated -- readable source, sitting next to a trivially extractable
// app.asar. Publishing the installer publicly IS publishing that source,
// whether or not a public repository exists. So the payload directory, not the
// repository, is the thing that has to be gated.
//
// THREE RULES GOVERN THIS FILE.
//
//   1. FAIL, DO NOT WARN. A file classified `paid` or `excluded` that is
//      present in the payload exits 1. `npm run dist` stops. There is no flag
//      that turns this into a warning, because a guard that can be downgraded
//      is downgraded on the day it finally catches something real.
//
//   2. UNCLASSIFIED IS A FAILURE, NOT A DEFAULT. Every file in the payload
//      must be named in the manifest. A file that appears tomorrow and matches
//      nothing stops the build until a human classifies it. Defaulting the
//      unknown to `open` would mean the next provider anyone adds ships
//      publicly by silence -- which is the absence-as-emptiness defect this
//      project has now found repeatedly, in its worst possible form: the
//      failure is invisible and the consequence is published source.
//
//      This rule is also what makes a TYPO in the manifest safe. A `paid` entry
//      spelled wrongly matches nothing -- but the real file then matches
//      nothing either, so it lands in unclassified and fails. A misspelled
//      boundary cannot silently ship the thing it was meant to hold back.
//
//   3. ASSERT BY NAMED PATH. NEVER BY COUNT. There is no expected-file-count
//      anywhere in this file, and there must never be one. On this project a
//      "216 -> 221 files" coincidence once nearly produced a false "it shipped"
//      conclusion: two different sets of the same size are indistinguishable by
//      counting, and the one time it matters is the one time they differ in
//      content rather than size. Counts are printed here as information and are
//      never compared against anything.
//
// THE SECOND WAY THE SAME MODULES LEAK: A SOURCE PUBLISH (`--source`).
//
// Everything above guards the installer PAYLOAD. The owner's ruling is that
// people may take either road -- download the installer from the site, or take
// the source from GitHub -- and that only the free part travels either one.
// Guarding one road is not guarding the boundary. `git push` to a public
// remote publishes exactly the modules this file exists to hold back, and it
// never touches resources/capability on the way.
//
// `--source <repo>` asks the publish question about a git repository instead of
// a staged directory: the same manifest, the same classify(), the same
// fail-closed treatment of paid, excluded and unclassified. Three differences
// are deliberate and are argued where they are implemented below:
//
//   * The file set comes from `git ls-files`, NOT from walking the disk. What a
//     publish exposes is what git TRACKS. Untracked build output is not
//     published (walking would wrongly indict it), and a tracked file deleted
//     from the working tree still is (walking would wrongly miss it).
//
//   * `pending` REFUSES here, where the payload mode tolerates it. The payload
//     mode is permissive on purpose so ordinary dev builds stay green; there is
//     no dev build to keep green in a publish question, so source mode is the
//     strict verdict by construction rather than by remembering a flag.
//
//   * HISTORY IS CHECKED, NOT JUST THE TIP. Deleting a paid module from the tip
//     does not delete it from the repository: every clone of a public repo
//     carries every reachable commit, and `git show <old>:<path>` reads the file
//     straight back out. A gate that reads only the working tree while the
//     history still carries the module is theatre -- it reports "clean" about
//     the one copy an attacker would not bother with. Measured on this project,
//     not assumed: all eight paid modules are reachable from refs already pushed
//     to the engine's origin, while its tip-side story looks tidy.
//
// EXIT CODES, mirroring tools/check-no-owner-data.mjs so the two guards are
// read the same way:
//   0  every payload file is classified, and nothing paid or excluded is present
//   1  VIOLATIONS -- the payload carries paid/excluded/unclassified files
//      (--source: the tree or the history carries them)
//   2  guard error -- the manifest is missing, malformed, or self-contradictory
//      (--source: the target is not a git repository, or git is unavailable)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(REPO_ROOT, "config", "payload-boundary.json");
const MANIFEST_RELATIVE = "config/payload-boundary.json";

// The payload roots this guard checks when none is named. Both are the SAME
// payload at different stages: `capability/` is what the packer stages, and
// resources/capability is where electron-builder copied it. Checking whichever
// exists means the guard is useful before a build and after one.
const DEFAULT_ROOTS = ["capability", "release/win-unpacked/resources/capability"];

const CLASSES = ["excluded", "paid", "open"];
const STATUS_PROPOSED = "proposed";
const STATUS_RATIFIED = "owner-ratified";

class GuardError extends Error {}

// ---------------------------------------------------------------------------
// Manifest loading and validation.
//
// Everything below throws GuardError, which becomes exit 2. A malformed
// boundary must never be reported as a clean payload, and must never be
// confused with a violation: those are different problems with different fixes,
// and telling them apart is the difference between "fix your manifest" and
// "you are about to publish the paid part".
// ---------------------------------------------------------------------------

// Paths in the manifest are payload-relative and POSIX. Anything else is
// rejected rather than normalised, because a manifest entry that does not
// match the way this guard walks the payload is an entry that silently
// classifies nothing -- and rule 2 is only load-bearing if entries mean what
// they appear to mean.
function assertUsablePath(value, where, { directory = false } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new GuardError(`${MANIFEST_RELATIVE}: ${where} contains an empty or non-string entry.`);
  }
  if (value !== value.trim()) {
    throw new GuardError(`${MANIFEST_RELATIVE}: ${where} entry ${JSON.stringify(value)} has surrounding whitespace.`);
  }
  if (value.includes("\\")) {
    throw new GuardError(
      `${MANIFEST_RELATIVE}: ${where} entry ${JSON.stringify(value)} uses a backslash. ` +
        "Payload paths are POSIX-relative; a backslash entry would match nothing on any platform.",
    );
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new GuardError(
      `${MANIFEST_RELATIVE}: ${where} entry ${JSON.stringify(value)} is absolute. ` +
        "Entries are relative to the payload root so the same manifest checks the staged and the packed copy.",
    );
  }
  if (value.startsWith("./") || value.split("/").includes("..") || value.split("/").includes(".")) {
    throw new GuardError(
      `${MANIFEST_RELATIVE}: ${where} entry ${JSON.stringify(value)} is not in normal form ` +
        '(no "./", no "..", no bare "." segments).',
    );
  }
  if (directory && !value.endsWith("/")) {
    throw new GuardError(
      `${MANIFEST_RELATIVE}: ${where} entry ${JSON.stringify(value)} must end with "/" so it is ` +
        'unambiguously a directory prefix. Without it, "state" would also match "stateful.js".',
    );
  }
  if (!directory && value.endsWith("/")) {
    throw new GuardError(`${MANIFEST_RELATIVE}: ${where} entry ${JSON.stringify(value)} is a file path and must not end with "/".`);
  }
}

function readList(container, key, where) {
  const value = container[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new GuardError(`${MANIFEST_RELATIVE}: ${where}.${key} must be an array.`);
  return value;
}

// ---------------------------------------------------------------------------
// ONE PARSER, RUN ONCE PER NAMESPACE.
//
// The payload question and the source question classify paths in DIFFERENT
// COORDINATE SYSTEMS -- payload-relative (inside the staged capability/ tree)
// versus repo-relative (what `git ls-files` prints) -- and one array cannot
// answer both. Before this existed, --source asked the payload arrays about
// repo paths and got "591 of 592 unclassified", which reads as an unclassified
// repository and is really a manifest without the vocabulary for the question.
//
// WORSE THAN THE COUNT: THE ONE FILE IT DID MATCH, IT MATCHED BY ACCIDENT.
// `package.json` exists in both namespaces and means different files in each --
// the Electron application at the repo root, the neutral default staged into the
// payload. The guard reported it `open` under a rule written about the other one.
// A collision does not announce itself: it classifies the wrong file, silently,
// under a rule that reads perfectly sensible beside it. config/, tools/, src/ and
// tests/ all exist in both trees under similar names, so this was the first of a
// family, not a one-off.
//
// WHY A SECTION AND NOT A SECOND FILE. main() already argues it: "a source gate
// with its own copy of the boundary is a second boundary, and two boundaries
// disagree the first time only one of them is edited." That reasoning is about
// the FILE, and it still holds. What it did not anticipate is that one file can
// still need two namespaces. So: one file, one edit surface, one parser, two
// vocabularies -- and the validation below is literally the same code for both,
// rather than a copy that drifts.
function parseNamespace(parsed, label) {
    const rules = { excluded: { paths: [], prefixes: [] }, paid: { paths: [], prefixes: [] }, open: { paths: [] } };

    for (const name of CLASSES) {
      const section = parsed[name];
      if (section === undefined) continue;
      if (!section || typeof section !== "object" || Array.isArray(section)) {
        throw new GuardError(`${MANIFEST_RELATIVE}${label}: "${name}" must be an object.`);
      }
      for (const entry of readList(section, "paths", name)) {
        assertUsablePath(entry, `${name}.paths`);
        rules[name].paths.push(entry);
      }
      // PREFIXES ARE ALLOWED ONLY IN THE DIRECTION THAT FAILS THE BUILD.
      //
      // A too-broad `paid` or `excluded` prefix over-matches, which stops a build
      // and gets noticed and corrected in minutes. A too-broad `open` prefix
      // under-matches nothing and over-permits everything beneath it -- so the
      // next paid file dropped into that directory would be classified open by a
      // rule written before it existed, and would ship. `open` is therefore exact
      // paths only: every openly-published file is named by a human, once.
      if (name === "open") {
        if (section.prefixes !== undefined) {
          throw new GuardError(
            `${MANIFEST_RELATIVE}${label}: "open" may not use prefixes. An open prefix would classify files ` +
              "that do not exist yet, so a paid module added under it later would ship by silence. " +
              "List open files by exact path.",
          );
        }
        continue;
      }
      for (const entry of readList(section, "prefixes", name)) {
        assertUsablePath(entry, `${name}.prefixes`, { directory: true });
        rules[name].prefixes.push(entry);
      }
    }

    // `pending` is the honest state for "this lane proposes moving it out, the
    // owner has not ruled, and it is still in the payload today". It reports
    // loudly on every build and does not fail. Without it, a proposal could only
    // be expressed by failing the build over a decision nobody has made yet --
    // and a gate that is red before anyone has done anything wrong is a gate that
    // gets commented out in week one.
    const pending = new Map();
    if (parsed.pending !== undefined) {
      if (!parsed.pending || typeof parsed.pending !== "object" || Array.isArray(parsed.pending)) {
        throw new GuardError(`${MANIFEST_RELATIVE}${label}: "pending" must be an object of path -> reason.`);
      }
      for (const [entry, reason] of Object.entries(parsed.pending)) {
        assertUsablePath(entry, "pending");
        if (typeof reason !== "string" || !reason.trim()) {
          throw new GuardError(
            `${MANIFEST_RELATIVE}${label}: pending entry ${JSON.stringify(entry)} has no reason. ` +
              "A pending item without a stated reason is an unexplained exception, which is how a " +
              "temporary list becomes permanent.",
          );
        }
        pending.set(entry, reason.trim());
      }
    }

    // RATIFICATION MUST FORCE A DECISION ON EVERY PENDING ITEM.
    //
    // "The owner has decided" and "these items are undecided" cannot both be
    // true. Making that contradiction a hard error is the mechanism that turns
    // his decision into enforcement: flipping status to owner-ratified is
    // impossible until every pending path has been moved into open, paid or
    // excluded. Nothing can be ratified by being overlooked.
    if (parsed.status === STATUS_RATIFIED && pending.size > 0) {
      throw new GuardError(
        `${MANIFEST_RELATIVE}${label}: status is ${JSON.stringify(STATUS_RATIFIED)} but ${pending.size} path(s) ` +
          `are still "pending": ${[...pending.keys()].join(", ")}. A ratified boundary cannot contain ` +
          "undecided items. Move each into open, paid or excluded.",
      );
    }

    // A path in two classes is an ambiguous decision in the one file whose whole
    // job is to be unambiguous. Precedence would resolve it safely, but silently,
    // and a boundary that is silently resolved is a boundary nobody can read.
    const owner = new Map();
    const claim = (entry, label) => {
      const previous = owner.get(entry);
      if (previous && previous !== label) {
        throw new GuardError(
          `${MANIFEST_RELATIVE}${label}: ${JSON.stringify(entry)} is declared in both "${previous}" and "${label}". ` +
            "One path, one class.",
        );
      }
      if (previous === label) {
        throw new GuardError(`${MANIFEST_RELATIVE}${label}: ${JSON.stringify(entry)} is listed twice in "${label}".`);
      }
      owner.set(entry, label);
    };
    for (const name of CLASSES) for (const entry of rules[name].paths) claim(entry, name);
    for (const entry of pending.keys()) claim(entry, "pending");

  return { rules, pending };
}

function loadManifest(file) {
  if (!existsSync(file)) {
    throw new GuardError(
      `${MANIFEST_RELATIVE} is missing. This guard holds the open/paid boundary and has been given ` +
        "no boundary to hold, so it would pass a payload containing anything at all.",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new GuardError(`${MANIFEST_RELATIVE} is present but unreadable: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GuardError(`${MANIFEST_RELATIVE} must be a JSON object.`);
  }
  if (parsed.schemaVersion !== 1) {
    throw new GuardError(`${MANIFEST_RELATIVE}: schemaVersion must be 1, found ${JSON.stringify(parsed.schemaVersion)}.`);
  }
  if (parsed.status !== STATUS_PROPOSED && parsed.status !== STATUS_RATIFIED) {
    throw new GuardError(
      `${MANIFEST_RELATIVE}: status must be ${JSON.stringify(STATUS_PROPOSED)} or ` +
        `${JSON.stringify(STATUS_RATIFIED)}, found ${JSON.stringify(parsed.status)}.`,
    );
  }

  const { rules, pending } = parseNamespace(parsed, "");

  // THE SOURCE NAMESPACE. Optional in the file, REQUIRED by --source.
  //
  // Absent is not empty and must never resolve to "nothing is classified".
  // runSourceMode() refuses outright when this is missing, because the
  // alternative -- classifying every tracked file against payload rules -- is
  // exactly the misleading answer this section exists to remove.
  let source = null;
  if (parsed.source !== undefined) {
    if (!parsed.source || typeof parsed.source !== "object" || Array.isArray(parsed.source)) {
      throw new GuardError(`${MANIFEST_RELATIVE}: "source" must be an object.`);
    }
    source = parseNamespace(parsed.source, ' "source"');
  }

  return { status: parsed.status, rules, pending, source };
}

// ---------------------------------------------------------------------------
// Classification.
//
// Precedence is fixed and runs strictest-first: excluded, paid, pending, open.
// A path that is somehow reachable by both a restrictive prefix and an open
// exact path resolves to the restrictive one, so a mistake in the open list can
// never unblock something held back. (The duplicate check above already refuses
// the literal case; this ordering covers a prefix overlapping an exact entry,
// which is legitimate -- excluding a whole directory while a file inside it was
// individually listed open is a real editing state, and it must resolve closed.)
// ---------------------------------------------------------------------------

function classify(relativePath, { rules, pending }) {
  for (const name of ["excluded", "paid"]) {
    const exact = rules[name].paths.find((entry) => entry === relativePath);
    if (exact) return { klass: name, rule: `${name}.paths: ${exact}` };
    const prefix = rules[name].prefixes.find((entry) => relativePath.startsWith(entry));
    if (prefix) return { klass: name, rule: `${name}.prefixes: ${prefix}` };
  }
  if (pending.has(relativePath)) return { klass: "pending", rule: pending.get(relativePath) };
  if (rules.open.paths.includes(relativePath)) return { klass: "open", rule: `open.paths: ${relativePath}` };
  return { klass: "unclassified", rule: null };
}

// ---------------------------------------------------------------------------
// Payload walk.
// ---------------------------------------------------------------------------

async function walk(directory, root, visit) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const entryPath = path.join(directory, entry.name);
    // A symlink in a payload is a file whose real content this guard cannot
    // classify from its name. Refusing is the only fail-closed answer: following
    // it would classify the link path while shipping the target's bytes.
    if (entry.isSymbolicLink()) {
      throw new GuardError(`refusing to classify a symlink in the payload: ${path.relative(root, entryPath)}`);
    }
    if (entry.isDirectory()) await walk(entryPath, root, visit);
    else if (entry.isFile()) visit(path.relative(root, entryPath).split(path.sep).join("/"));
  }
}

async function chooseRoots(requested) {
  if (requested.length > 0) return requested;
  const found = [];
  for (const candidate of DEFAULT_ROOTS) {
    if (!existsSync(candidate)) continue;
    if ((await stat(candidate)).isDirectory()) found.push(candidate);
  }
  if (found.length === 0) {
    throw new GuardError(
      `nothing to check: pass a payload directory, or build one (tried ${DEFAULT_ROOTS.join(", ")}).`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// SOURCE PUBLISH MODE.
//
// Answers "is this git repository safe to publish as source?" using the same
// manifest and the same classify() as the payload mode above. See the header
// for why this exists at all: the payload is one of two roads to the public,
// and this is the other one.
// ---------------------------------------------------------------------------

// Where the capability-layer source lives is builder-specific and is
// deliberately NOT in git -- an absolute path names the builder and their
// machine layout. tools/pack-capability-layer.mjs already established the three
// places it may be configured, so this mirrors them rather than inventing a
// fourth: a second convention for the same fact is a second thing to get wrong.
const SOURCE_SETTING_FILE = path.join(REPO_ROOT, "private", "capability-source.owner.json");
const SOURCE_MARKER = path.join("tools", "mission-bridge.js");

// How many unclassified paths to NAME before switching to a per-directory
// rollup. This is a READING aid and nothing else -- the verdict below is taken
// over the whole set, never over the printed excerpt (rule 3). The cap exists
// because the honest answer for a whole repository is thousands of paths, and a
// gate that answers with an unreadable wall gets skimmed instead of read.
const UNCLASSIFIED_PRINT_LIMIT = 60;

function git(repository, args, what) {
  try {
    return execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      // History enumeration on this project's engine repo is ~1.2MB today and
      // only grows. A truncated stdout would silently shorten the set this
      // guard reasons over, which is the one failure mode it cannot have.
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new GuardError("git is not on PATH, so the source publish question cannot be answered at all.");
    }
    const detail = `${error?.stderr || ""}`.trim() || error?.message || "unknown git failure";
    throw new GuardError(`${what} failed in ${repository}: ${detail}`);
  }
}

// Resolution differs by HOW the path arrived, and that asymmetry is on purpose.
// An explicit --source <path> is a direct instruction and is taken at its word:
// asking whether the APP repo is publishable is a legitimate question, and the
// app repo does not contain the engine's marker file. A path that came from
// stored configuration is checked against that marker, because stale config is
// how a guard ends up confidently scanning a directory nobody is publishing.
function resolveSourceRepository(explicit) {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!existsSync(resolved)) throw new GuardError(`nothing to check: --source path does not exist: ${resolved}`);
    return resolved;
  }

  const candidates = [];
  if (process.env.TOOLSENABLED_SOURCE) candidates.push(process.env.TOOLSENABLED_SOURCE);
  if (existsSync(SOURCE_SETTING_FILE)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(SOURCE_SETTING_FILE, "utf8"));
    } catch (error) {
      throw new GuardError(`private/capability-source.owner.json is present but unreadable: ${error.message}`);
    }
    if (typeof parsed?.path === "string" && parsed.path.trim()) candidates.push(parsed.path.trim());
  }

  const tried = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    tried.push(resolved);
    if (existsSync(path.join(resolved, SOURCE_MARKER))) return resolved;
  }

  throw new GuardError(
    "nothing to check: --source was given no path and none is configured. Set it one of three ways:\n" +
      "  --source <path>\n" +
      "  TOOLSENABLED_SOURCE=<path>\n" +
      '  private/capability-source.owner.json  ->  { "path": "<path>" }\n' +
      (tried.length
        ? `Tried, and none contained ${SOURCE_MARKER.split(path.sep).join("/")}:\n  ${tried.join("\n  ")}`
        : "None of the three was set."),
  );
}

// THE PUBLISH SET IS WHAT GIT TRACKS, NOT WHAT IS ON DISK.
//
// -z because git QUOTES paths containing spaces or non-ASCII bytes in its
// default output. A quoted path is a different string from the real one, so it
// would match no manifest entry -- and under rule 2 that lands in
// `unclassified` and fails, which is at least the safe direction, but it fails
// for a reason the operator cannot act on. -s carries the mode alongside, which
// is the only way to tell a symlink from a regular file here.
function trackedFiles(repository) {
  const raw = git(repository, ["ls-files", "-s", "-z"], "git ls-files");
  const files = [];
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) throw new GuardError(`git ls-files produced an unparseable record: ${JSON.stringify(record)}`);
    const mode = record.slice(0, record.indexOf(" "));
    const file = record.slice(tab + 1);
    // Same reasoning as the payload walk: a symlink is a file whose real
    // content this guard cannot classify from its name, and a repository
    // publishes the link, so following it would classify one path while
    // exposing another's bytes. Refusing is the only fail-closed answer.
    if (mode === "120000") throw new GuardError(`refusing to classify a symlink in the source tree: ${file}`);
    files.push(file);
  }
  return files;
}

// EVERY PATH IN EVERY REACHABLE COMMIT, which is precisely what a clone of a
// published repository hands over.
//
// `rev-list --all --objects` rather than `log --name-only`: it enumerates the
// trees themselves rather than per-commit diffs, so it cannot miss a path that
// only ever existed on one side of a merge, and it is faster besides (measured
// on the engine repo: 0.6s against 2.2s). --all covers refs/heads, refs/tags
// AND refs/remotes -- deliberately wider than "what is pushed today", because a
// local branch is one command away from being pushed and remote-tracking refs
// show what already is.
//
// WHAT THIS CANNOT SEE, stated so nobody reads more into a green history line
// than it earns: the check is by PATH. A paid module that lived in history
// under a name the manifest does not classify, or whose body was pasted into
// some other file, is invisible to it. It answers "were these modules ever
// here", not "was this secret ever here".
function historicalPaths(repository) {
  const raw = git(repository, ["rev-list", "--all", "--objects"], "git rev-list");
  const versions = new Map();
  for (const line of raw.split("\n")) {
    const space = line.indexOf(" ");
    // A line with no space is a commit or a root tree: an object with no path.
    if (space === -1) continue;
    const file = line.slice(space + 1);
    if (!file) continue;
    versions.set(file, (versions.get(file) ?? 0) + 1);
  }
  return versions;
}

function rollupByDirectory(paths) {
  const counts = new Map();
  for (const file of paths) {
    const slash = file.indexOf("/");
    const bucket = slash === -1 ? "(repository root)" : file.slice(0, file.indexOf("/", slash + 1) + 1 || slash + 1);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function runSourceMode(boundary, options) {
  const repository = resolveSourceRepository(options.source);
  // Confirm it is a git repository BEFORE anything else. A plain directory
  // would otherwise produce an empty history and a confident, wrong "no paid
  // module is in history" -- the absence-as-emptiness defect this project keeps
  // finding, in the place it would cost the most.
  const inside = git(repository, ["rev-parse", "--is-inside-work-tree"], "git rev-parse").trim();
  if (inside !== "true") throw new GuardError(`nothing to check: not a git work tree: ${repository}`);

  const tracked = trackedFiles(repository);
  if (tracked.length === 0) {
    throw new GuardError(`nothing to check: git tracks 0 files in ${repository}`);
  }

  // REFUSE RATHER THAN ANSWER IN THE WRONG VOCABULARY.
  //
  // Without a "source" section this guard used to classify repo paths against
  // the PAYLOAD arrays and report a number. The number was meaningless and did
  // not look meaningless, which is the worst combination a gate can produce:
  // it was quoted as a backlog for weeks. Exit 2 is a guard error, not a
  // verdict, and that is the honest shape here -- the guard cannot answer.
  if (!boundary.source) {
    throw new GuardError(
      `${MANIFEST_RELATIVE} has no "source" section, so the publish question cannot be answered ` +
        "for this repository. The classes at the top level classify PAYLOAD-relative paths " +
        "(inside the staged capability tree); --source asks about REPO-relative paths from " +
        "`git ls-files`. Those are different vocabularies and one cannot stand in for the " +
        "other: a payload rule that happens to match a repo path classifies the wrong file. " +
        "Add a \"source\" section with its own open/paid/excluded/pending, then re-run.",
    );
  }
  const namespace = boundary.source;

  const found = { excluded: [], paid: [], unclassified: [], pending: [], open: [] };
  for (const file of tracked) found[classify(file, namespace).klass].push(file);

  // History is asked only about the RESTRICTIVE classes. Requiring every path
  // that ever existed to be classified would be unmeetable -- history holds
  // every scratch file and every renamed-away path this repo ever had -- and an
  // unmeetable gate is a disabled gate. Unclassified fails at the tip, where it
  // is both actionable and the thing that actually ships.
  const history = historicalPaths(repository);
  const historyHits = [];
  for (const file of [...history.keys()].sort()) {
    const verdict = classify(file, namespace);
    if (verdict.klass !== "paid" && verdict.klass !== "excluded") continue;
    historyHits.push({ path: file, klass: verdict.klass, rule: verdict.rule, versions: history.get(file) });
  }
  // A path still at the tip is already reported below; naming it twice reads as
  // two problems. What matters here is the path that is GONE from the tip and
  // still in history, because that is the one a working-tree-only gate misses.
  const trackedSet = new Set(tracked);
  const historyOnly = historyHits.filter((hit) => !trackedSet.has(hit.path));

  console.log(`Source publish boundary: ${MANIFEST_RELATIVE} (status: ${boundary.status})`);
  console.log(`Repository: ${repository}`);
  console.log(
    `Tracked files: ${tracked.length} (informational -- this guard asserts on named paths, never on a count).`,
  );
  console.log(
    `Classified: open=${found.open.length} pending=${found.pending.length} ` +
      `paid=${found.paid.length} excluded=${found.excluded.length} unclassified=${found.unclassified.length}`,
  );
  console.log(`History: ${history.size} distinct path(s) across all reachable refs.`);

  const violations = found.paid.length + found.excluded.length + found.unclassified.length + found.pending.length;
  if (violations === 0 && historyHits.length === 0) {
    console.log("\nSource publish boundary: clean. Every tracked file is open, and no paid or excluded module is in history.");
    return;
  }

  console.error(`\nSOURCE PUBLISH REFUSED -- ${repository}`);

  for (const [label, heading] of [
    ["excluded", "MUST NOT BE PUBLISHED AT ALL (excluded)"],
    ["paid", "PAID -- publishing the source publishes these (paid)"],
    [
      "pending",
      'PENDING -- decided, not yet removed. The payload gate tolerates these so dev builds stay green; ' +
        "a publish cannot, because publishing is the thing they are still waiting to be removed before",
    ],
  ]) {
    if (found[label].length === 0) continue;
    console.error(`\n${heading}:`);
    for (const file of found[label]) console.error(`  ${file}`);
  }

  if (found.unclassified.length > 0) {
    console.error(
      `\nUNCLASSIFIED -- ${found.unclassified.length} tracked file(s) are named nowhere in ` +
        `${MANIFEST_RELATIVE}. This is a failure by design: an unknown file is not assumed open, ` +
        "so a repository whose publishable set has never been classified cannot be published by silence.",
    );
    const named = found.unclassified.slice(0, UNCLASSIFIED_PRINT_LIMIT);
    for (const file of named) console.error(`  ${file}`);
    if (found.unclassified.length > named.length) {
      console.error(
        `  ... and ${found.unclassified.length - named.length} more. The list above is TRUNCATED FOR ` +
          "READING ONLY -- the verdict is taken over every one of them. Where the work is:",
      );
      for (const [bucket, count] of rollupByDirectory(found.unclassified)) {
        console.error(`    ${count}\t${bucket}`);
      }
    }
  }

  if (historyHits.length > 0) {
    console.error(
      `\nGIT HISTORY -- ${historyHits.length} paid/excluded path(s) are reachable from this repository's refs. ` +
        "Publishing the repository publishes these regardless of what the tip looks like: a clone carries " +
        "every reachable commit, and `git show <commit>:<path>` reads the file straight back out.",
    );
    for (const hit of historyHits) {
      const where = trackedSet.has(hit.path) ? "at the tip and in history" : "HISTORY ONLY -- gone from the tip";
      console.error(`  ${hit.path}   [${hit.klass}; ${hit.versions} version(s); ${where}]`);
    }
    if (historyOnly.length > 0) {
      console.error(
        `\n${historyOnly.length} of those are the dangerous kind: absent from the working tree, so every ` +
          "tip-only check reports them clean. Deleting a file in a new commit does not remove it from " +
          "the repository -- only rewriting history does, and that is a decision, not a fix this guard makes.",
      );
    }
  }

  console.error(
    "\nThis verdict is about a SOURCE PUBLISH and says nothing about the installer payload; run this " +
      "guard without --source for that. A red result here is fixed by classifying the tree and removing " +
      "what must not be published -- never by widening a rule to make the colour change.",
  );

  process.exitCode = 1;
}

function parseArguments(argv) {
  const roots = [];
  let manifest = DEFAULT_MANIFEST;
  let ship = false;
  let source = null;
  let sourceRequested = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--manifest") {
      manifest = argv[index + 1];
      if (!manifest) throw new GuardError("--manifest needs a path.");
      index += 1;
      continue;
    }
    if (argv[index] === "--ship") {
      ship = true;
      continue;
    }
    if (argv[index] === "--source") {
      sourceRequested = true;
      // The path is optional, so a following flag must not be eaten as its
      // value: `--source --manifest x` would otherwise scan a directory named
      // "--manifest" and report on nothing.
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        source = next;
        index += 1;
      }
      continue;
    }
    if (argv[index].startsWith("--")) throw new GuardError(`unknown flag ${argv[index]}`);
    roots.push(argv[index]);
  }

  // The two modes answer different questions about different things, and a run
  // that appears to ask both would silently answer only one. Refusing is not
  // pedantry: the wrong half of that pair is exactly the half someone believed
  // they had checked.
  if (sourceRequested && roots.length > 0) {
    throw new GuardError(
      `--source checks a git repository; the payload roots (${roots.join(", ")}) belong to a separate run without --source.`,
    );
  }
  if (sourceRequested && ship) {
    throw new GuardError(
      "--ship is meaningless with --source. --ship upgrades the PAYLOAD run from the build verdict to the " +
        "publish verdict; --source is already the publish verdict and refuses pending unconditionally. " +
        "Accepting it silently would let someone believe a flag turned on a check that was never off.",
    );
  }

  return { roots, manifest: path.resolve(manifest), ship, source, sourceRequested };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const boundary = loadManifest(options.manifest);

  // Both modes load the SAME manifest before branching. That is the whole point
  // of adding a mode here rather than writing a second guard: a source gate with
  // its own copy of the boundary is a second boundary, and two boundaries
  // disagree the first time only one of them is edited.
  if (options.sourceRequested) return runSourceMode(boundary, options);

  const roots = await chooseRoots(options.roots);

  // Findings are keyed by class and always carry the path. Nothing in this
  // function compares a total against an expectation (rule 3).
  const found = { excluded: [], paid: [], unclassified: [], pending: [], open: [] };
  const matchedRules = new Set();
  let filesSeen = 0;

  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    let rootStat;
    try {
      rootStat = await lstat(resolvedRoot);
    } catch (error) {
      if (error?.code === "ENOENT") throw new GuardError(`nothing to check: directory does not exist: ${root}`);
      throw error;
    }
    if (rootStat.isSymbolicLink()) throw new GuardError(`nothing to check: refusing to follow symlink: ${root}`);
    if (!rootStat.isDirectory()) throw new GuardError(`nothing to check: not a directory: ${root}`);

    await walk(resolvedRoot, resolvedRoot, (relativePath) => {
      filesSeen += 1;
      const verdict = classify(relativePath, boundary);
      if (verdict.rule) matchedRules.add(verdict.rule);
      found[verdict.klass].push({ root, path: relativePath, rule: verdict.rule });
    });
  }

  // Scanning nothing is an error, not a pass. Same rule as the owner-data
  // guard: a clean report produced by looking at zero files is the most
  // dangerous output this program could print.
  if (filesSeen === 0) {
    throw new GuardError(`nothing to check: scanned 0 files under ${roots.join(", ")}`);
  }

  console.log(`Payload boundary: ${MANIFEST_RELATIVE} (status: ${boundary.status})`);
  console.log(`Roots checked: ${roots.join(", ")}`);
  console.log(
    `Files seen: ${filesSeen} (informational -- this guard asserts on named paths, never on a count).`,
  );
  // COUNT DISTINCT PATHS, NOT FINDINGS.
  //
  // By default two roots are scanned -- the staged payload and the copy already
  // inside release/win-unpacked -- so every finding is counted once per root and
  // the raw totals come out doubled. Six files reported as twelve is not a
  // rounding annoyance: a reader who goes to config/payload-boundary.json to see
  // the twelve finds six, and a gate whose number disagrees with the file it
  // reads is a gate people learn to argue with. Worse, the --ship refusal below
  // already deduplicates, so the same run printed "pending=12" and "NOT
  // PUBLISHABLE -- 6 file(s)" a few lines apart and contradicted itself.
  //
  // Both roots are still scanned and every finding is still reported below with
  // its own root; only the headline totals are per-path. The root count is
  // printed alongside so the difference is visible rather than surprising.
  const distinct = (klass) => new Set(found[klass].map((item) => item.path)).size;
  console.log(
    `Classified (distinct paths across ${roots.length} root(s)): ` +
      `open=${distinct("open")} pending=${distinct("pending")} ` +
      `paid=${distinct("paid")} excluded=${distinct("excluded")} unclassified=${distinct("unclassified")}`,
  );

  if (boundary.status === STATUS_PROPOSED) {
    // WHAT THIS STATUS DOES AND DOES NOT MEAN.
    //
    // This note used to read "has not been ratified by the owner ... once the
    // owner has ruled". That was false and it was expensive: the owner ruled on
    // every open question, and twenty-three of those decisions have been
    // executed. A reader hitting that sentence goes looking for a decision that
    // was already made, while the actual blocker is that six files still ship.
    //
    // The status is still "proposed" for a mechanical reason, not a human one:
    // loadManifest() REFUSES to accept the ratified status while any path is
    // pending, so ratification is a consequence of finishing the removal work,
    // never a signature that can be applied to unfinished work. Saying so is the
    // whole point -- a status that can be granted by asking someone is a status
    // that gets granted at 2am to unblock a build.
    console.log(
      "\nNOTE: this boundary is enforced exactly as written, and the \"pending\" paths named below " +
        "are still shipping. The status is not waiting on a decision -- the owner has ruled on " +
        `every entry. It becomes ${JSON.stringify(STATUS_RATIFIED)} when nothing is pending, and this ` +
        "guard refuses that status while anything still is. So the way to change this line is to " +
        "stop shipping the files, not to ask anyone.",
    );
  }

  if (found.pending.length > 0) {
    console.log(`\n${found.pending.length} file(s) PROPOSED for removal, still in the payload (not a failure):`);
    for (const item of found.pending) console.log(`  ${item.path}  --  ${item.rule}`);
  }

  const violations = [...found.excluded, ...found.paid, ...found.unclassified];
  const pendingPaths = new Set(found.pending.map((item) => item.path));

  // WHY THERE ARE TWO VERDICTS, AND WHY BOTH ALWAYS PRINT.
  //
  // The default verdict deliberately tolerates `pending`, and that is correct.
  // pending means "a lane proposes removing this, the owner has ruled, and it
  // still ships today". Failing every build until that work lands would make this
  // guard an obstacle to ordinary development, and a guard that blocks every build
  // gets switched off. So a dev build stays green while the report says plainly,
  // in prose, that pending items are still shipping.
  //
  // But prose is not what a build chain consumes -- it consumes the exit code.
  // Three separate lanes read "exit 0" as "safe to publish" while the commercial
  // tier table with real prices sat in the payload, because the honest sentence
  // and the exit code disagreed and only one of the two is machine-readable. That
  // is the same defect as a permissive destructured default: the absence of a
  // complaint read as consent. --ship closes it without breaking development.
  //
  // ORDER IS LOAD-BEARING, and this is the second version. The first returned
  // early on pending, which silently suppressed the violation report: a --ship run
  // with an unclassified file present exited 1 and never named that file. Right
  // exit code, wrong reason, and the operator would have gone hunting for a
  // pending file that was not the problem. A mutation -- planting an unclassified
  // file and checking that --ship still NAMES it -- is what caught that, and it is
  // why the counts below are deduplicated by path too: the default roots include
  // both the staged payload and the copy already in release/win-unpacked, so a raw
  // finding count says "12 files" where the manifest names 6, and a gate whose
  // number disagrees with the file it reads is one people learn to argue with.
  const shipRefusal = options.ship && pendingPaths.size > 0;

  if (violations.length === 0 && !shipRefusal) {
    console.log("\nPayload boundary: clean. Nothing paid, excluded or unclassified is present.");
    return;
  }

  if (violations.length > 0) {
    console.error(`\nPAYLOAD BOUNDARY VIOLATION -- ${violations.length} file(s). This build must not ship.`);

    for (const [label, heading] of [
      ["excluded", "MUST NOT SHIP AT ALL (excluded)"],
      ["paid", "PAID -- not for public release (paid)"],
      [
        "unclassified",
        "UNCLASSIFIED -- present in the payload and named nowhere in the boundary manifest. " +
          "This is a failure by design: an unknown file is not assumed open",
      ],
    ]) {
      if (found[label].length === 0) continue;
      console.error(`\n${heading}:`);
      for (const item of found[label]) {
        console.error(`  ${item.path}${item.rule ? `   [${item.rule}]` : ""}`);
      }
    }

    console.error(
      `\nFix by either removing these files from the payload, or -- if a file is genuinely open -- ` +
        `adding its exact path to "open".paths in ${MANIFEST_RELATIVE}. Do not add a prefix; do not ` +
        "widen a rule to make a red build green without reading what the file is.",
    );
  }

  if (shipRefusal) {
    console.error(
      `\nNOT PUBLISHABLE -- ${pendingPaths.size} file(s) are still "pending" and still ship:`,
    );
    for (const entry of [...pendingPaths].sort()) console.error(`  ${entry}`);
    console.error(
      '\n--ship requires pending=0. Without --ship, exit 0 means "nothing unclassified, paid or ' +
        'excluded is present" -- it has never meant "safe to publish", and the files above are ' +
        'precisely what that difference is about.',
    );
  }

  process.exitCode = 1;
}

main().catch((error) => {
  if (error instanceof GuardError) {
    console.error(`Payload boundary guard error: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  console.error(`Payload boundary guard error: ${error.stack || error.message}`);
  process.exitCode = 2;
});
