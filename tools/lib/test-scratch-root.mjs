// WHERE A SUITE'S SCRATCH DIRECTORY GOES, IN ONE PLACE.
//
// THE DEFECT THIS ENDS, measured 2026-09-07 at app 4ba0ceac. Twenty-three
// suite files built their scratch path as `<repo>/node_modules/.toolsenabled-*`
// by convention. Every worktree's `node_modules` is a JUNCTION into one shared
// dependency store -- the layout this repository requires for parallel work --
// so that scratch was never written in the worktree at all. It was written
// inside the shared store, in a namespace every junctioned worktree shares.
//
// What that cost, measured on the same commit within five minutes:
//
//   * eight failures in one run, every one
//     `EPERM: operation not permitted, rmdir '<repo>\node_modules\.toolsenabled-*'`
//     and not one of them an assertion. An EPERM in a teardown hook lands as
//     `failureType: 'hookFailed'` against whichever test finished last, so it
//     reads as a product defect;
//   * residue that outlives the run that made it -- four such directories were
//     sitting in the store, the oldest three days old -- which two lanes
//     running the same suite file then collide over;
//   * a moving count: the resolved-`node_modules` entry count that a strict
//     run prints as its reproduction key read 252 in one run and 251 minutes
//     later, because the scratch directories come and go inside it.
//
// So the same commit scored differently depending on what else had run on the
// machine, and nothing in `# tests / # pass / # fail` said which situation you
// were in.
//
// THE PINNED TEMP IS THE RIGHT HOME. tools/test-strict.mjs already points
// TEMP/TMP at a per-run scratch directory, so a release measurement gets a
// private one for free, and `os.tmpdir()` reads that pinned value. The account
// fence is satisfied for the same reason it was before: the fence refuses paths
// that leave the owned profile, and the temp root is inside it -- see
// tools/test/bootstrap-fence-link-inside-the-profile.test.mjs, which is where
// the junction/fence interaction is pinned.
//
// KNOWN LIMIT, stated rather than implied: two whole-suite runs sharing ONE
// TEMP still share these names. That is a real narrowing and not a cure -- the
// cure is the per-run TEMP the strict command already pins. The leaf names are
// deliberately unchanged from the ones the suites used before, so anything that
// greps for a scratch directory by name still finds it.

import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// THE TEMP ROOT IS RESOLVED TO ITS REAL, LONG NAME FIRST.
//
// Not decoration. tools/test/tree-address-saved-tree-wins.test.mjs had already
// met this and wrote it down: a TEMP handed down as an 8.3 short name
// (`C:\Users\TOOLSE~2\...`) does not start with the long profile root, and the
// host's cwd confinement then refuses it as ANOTHER ACCOUNT's folder. A scratch
// root that is correct on one machine and refused on the next is the same class
// of problem this file exists to remove, so the resolution happens here, once,
// rather than in each caller that remembers to.
//
// If the temp root cannot be resolved -- it does not exist yet, typically --
// the unresolved value is used: inventing a different directory would be worse
// than letting the caller's own mkdir report the real problem.
function resolvedTemporaryRoot(tmpdir) {
  try {
    return realpathSync.native(tmpdir);
  } catch {
    return tmpdir;
  }
}

// Named so a caller cannot pass a path fragment by accident and quietly
// recreate the defect: the leaf is a NAME, and this is the only thing that
// decides which directory it lives in.
export function testScratchRoot(leaf, { tmpdir = os.tmpdir() } = {}) {
  if (typeof leaf !== "string" || !leaf) throw new TypeError("testScratchRoot needs a directory name");
  if (leaf.includes("/") || leaf.includes("\\")) {
    throw new TypeError(`testScratchRoot takes a name, not a path: ${JSON.stringify(leaf)}`);
  }
  return path.join(resolvedTemporaryRoot(tmpdir), leaf);
}
