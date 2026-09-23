#!/usr/bin/env bash
# T378 -- "Default account rule" is a DEFAULT, not an override. RED/GREEN.
#
# WHAT THIS GATES. Commit 3a6a7526 added a block to the UNSCOPED branch of
# setPolicy in shell/account-registry.cjs which deleted selectionMode from
# EVERY entry of selectionByProvider whenever a whole-computer mode was
# written. That silently destroyed a per-program choice the owner had made,
# for programs they were not even looking at, from a control the Accounts page
# labels "Default account rule" and beside which every program is offered
# "Use default". This lane reverted it. The gate is the pair of tests that
# fail while that block is present.
#
# The mutant is not synthesised text: it is that commit's own file, taken from
# the object store by sha, so the RED shown here is exactly the code that was
# on the branch.
#
#   RED   = shell/account-registry.cjs as of MUTANT_SHA (clearing block present)
#   GREEN = shell/account-registry.cjs as it stands (block reverted)
#
# Usage:  bash tools/repro/t378-default-is-not-an-override.sh
#         NODE_BIN=/path/to/node bash tools/repro/...   (to name the runtime)
set -u

APP="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
OUT="$(mktemp -d)"

SUBJECT=shell/account-registry.cjs
MUTANT_SHA=3a6a7526
CLEARING_MARK='THE NEWEST CHOICE WINS'

# The guard this lane adds, and the pre-existing guarantee 3a6a7526 broke.
GATE1_FILE=tools/test/account-registry.test.mjs
GATE1_NAME="a mode chosen for the whole computer is the DEFAULT"
GATE2_FILE=tools/test/page2-native-provider-account.test.mjs
GATE2_NAME="the visible setup may mirror a global policy"

cd "$APP"

# THE RUNTIME IS NAMED, NOT ASSUMED. These suites are refused by anything but
# 22.19.0, and a wrong runtime reads as a product red.
version="$("$NODE_BIN" -v 2>/dev/null || true)"
if [ "$version" != "v22.19.0" ]; then
  echo "REFUSED - these suites need node v22.19.0; \$NODE_BIN reports '${version:-nothing}'."
  echo "          Set NODE_BIN to a v22.19.0 binary and run again."
  exit 2
fi

BACKUP="$(mktemp)"
cp "$SUBJECT" "$BACKUP"
restore() { cp "$BACKUP" "$SUBJECT"; }
trap 'restore; rm -f "$BACKUP"' EXIT

# A MUTATION ASSERTS ITS OWN EDIT. A search that matches nothing reports
# "still green" while nothing was mutated, which is a green proving nothing.
marks() { grep -c "$CLEARING_MARK" "$SUBJECT" || true; }

run_gate() {
  local label="$1" file="$2" name="$3" out="$4"
  # Redirected to a file, never piped: a pipe discards the exit code, and a
  # run with failures has been measured here reporting exit 0. The count is
  # read back from the file's own "# fail" line.
  "$NODE_BIN" --test --test-reporter=tap --test-name-pattern="$name" "$file" > "$out" 2>&1
  local code=$? fail
  fail="$(grep -E '^# fail ' "$out" | awk '{print $3}')"
  echo "   [$label] exit=$code  # fail ${fail:-UNREAD}"
  grep -E '^(not )?ok [0-9]' "$out" | sed 's/^/     /'
  [ "${fail:-1}" = "0" ]
}

phase() {
  local label="$1" tag="$2" a b
  echo "== $label"
  run_gate "$label gate1" "$GATE1_FILE" "$GATE1_NAME" "$OUT/$tag-gate1.tap"; a=$?
  run_gate "$label gate2" "$GATE2_FILE" "$GATE2_NAME" "$OUT/$tag-gate2.tap"; b=$?
  if [ $a -eq 0 ] && [ $b -eq 0 ]; then echo "   => $label VERDICT: GREEN"; return 0; fi
  echo "   => $label VERDICT: RED"; return 1
}

echo "node      $version"
echo "subject   $APP/$SUBJECT"
echo "mutant    $SUBJECT @ $MUTANT_SHA (the clearing block, as committed)"
echo "tap files $OUT"
echo

# --- RED: the clearing block exactly as it was committed --------------------
git show "$MUTANT_SHA:$SUBJECT" > "$SUBJECT"
echo "   mutant applied: $CLEARING_MARK match count $(marks)"
if [ "$(marks)" -eq 0 ]; then
  echo "FAIL - the mutant source does not carry the clearing block; this run would prove nothing"
  exit 2
fi
phase "mutant (clearing block present)" mutant; MUTANT_GREEN=$?

# --- GREEN: the block reverted ----------------------------------------------
restore
echo
echo "   restored:       $CLEARING_MARK match count $(marks)"
if [ "$(marks)" -ne 0 ]; then
  echo "FAIL - restore did not remove the clearing block"
  exit 2
fi
phase "tip (block reverted)" tip; TIP_GREEN=$?

echo
if [ $MUTANT_GREEN -ne 0 ] && [ $TIP_GREEN -eq 0 ]; then
  echo "PASS - mutant RED, tip GREEN (expected RED, GREEN)"; exit 0
fi
echo "FAIL - expected mutant RED and tip GREEN"; exit 1
