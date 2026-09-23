#!/usr/bin/env bash
# T378 -- adversarial mutation checks for the Accounts-page notice and its one
# action ("Apply the default to these programs").
#
# EVERY MUTATION COUNTS ITS OWN MATCHES AND FAILS AT ZERO. A mutation whose
# search string matches nothing reports "still green" while nothing was
# mutated. CRLF against LF is how that happens, so each literal below is a
# SINGLE line with no trailing newline: it matches the bytes on disk whichever
# line ending this checkout uses.
#
# Three ways the notice could be wrong and still look right:
#   M1  the write is not gated on the person's click -> drawing must write
#   M2  only the FIRST named program is dropped      -> the two-instance bug
#   M3  programs named by raw provider key           -> copy-table breakage
#
# Usage:  bash tools/repro/t378-notice-mutations.sh
#         NODE_BIN=/path/to/node bash tools/repro/...
set -u

APP="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
OUT="$(mktemp -d)"

SUITE=tools/test/account-switcher-dom.test.mjs
PATTERN=T378
SUBJECT=src/account-switcher.js

cd "$APP"

version="$("$NODE_BIN" -v 2>/dev/null || true)"
if [ "$version" != "v22.19.0" ]; then
  echo "REFUSED - this suite needs node v22.19.0; \$NODE_BIN reports '${version:-nothing}'."
  echo "          Set NODE_BIN to a v22.19.0 binary and run again."
  exit 2
fi

BACKUP="$(mktemp)"
cp "$SUBJECT" "$BACKUP"
restore() { cp "$BACKUP" "$SUBJECT"; }
trap 'restore; rm -f "$BACKUP"' EXIT

# Literal (not regex) replace that PRINTS ITS MATCH COUNT and refuses at zero.
mutate() {
  FROM="$1" TO="$2" FILE="$3" "$NODE_BIN" -e '
    const fs = require("fs");
    const { FILE: f, FROM: from, TO: to } = process.env;
    const src = fs.readFileSync(f, "utf8");
    const count = src.split(from).length - 1;
    console.log("     match count: " + count);
    if (count === 0) { console.error("     MUTATION MATCHED NOTHING - refusing to report a verdict"); process.exit(3); }
    fs.writeFileSync(f, src.split(from).join(to));
  '
}

run() {
  local out="$1"
  "$NODE_BIN" --test --test-reporter=tap --test-name-pattern="$PATTERN" "$SUITE" > "$out" 2>&1
  local code=$? pass fail
  pass="$(grep -E '^# pass ' "$out" | awk '{print $3}')"
  fail="$(grep -E '^# fail ' "$out" | awk '{print $3}')"
  echo "     exit=$code  # pass ${pass:-UNREAD}  # fail ${fail:-UNREAD}"
  grep '^not ok' "$out" | sed 's/^/       /'
  [ "${fail:-1}" = "0" ]
}

echo "node      $version"
echo "subject   $APP/$SUBJECT"
echo "gate      $SUITE  (--test-name-pattern $PATTERN)"
echo "tap files $OUT"
echo

echo "== GREEN: the tree as it stands"
run "$OUT/green.tap" && GREEN=0 || GREEN=1
[ $GREEN -eq 0 ] && echo "   => GREEN" || echo "   => RED (expected GREEN)"

missed=0
check_mutant() {
  local label="$1" from="$2" to="$3" log="$4"
  echo
  echo "== MUTANT $label"
  restore
  mutate "$from" "$to" "$SUBJECT" || exit 2
  if run "$log"; then
    echo "   => GREEN (expected RED - the gate did NOT catch this)"; missed=1
  else
    echo "   => RED (the gate caught it)"
  fi
}

# M1 -- the write stops being the person's click: painting performs it. A gate
# that only ever pressed the button would never notice.
check_mutant "M1 write not gated on the click" \
  '    paintOverrideNotice(policy)' \
  '    paintOverrideNotice(policy); onApplyDefaultToOverriding()' \
  "$OUT/m1.tap"

# M2 -- only the first named program is dropped. Invisible to any check that
# lists a single program.
check_mutant "M2 only the first named program dropped" \
  '    for (const provider of programs) {' \
  '    for (const provider of programs.slice(0, 1)) {' \
  "$OUT/m2.tap"

# M3 -- programs named by raw provider key instead of the copy table.
check_mutant "M3 raw provider key on the screen" \
  '      programs.map(providerLabel).join('"'"' and '"'"')' \
  '      programs.join('"'"' and '"'"')' \
  "$OUT/m3.tap"

restore
echo
if [ $GREEN -eq 0 ] && [ $missed -eq 0 ]; then
  echo "PASS - tree GREEN and every mutant RED"; exit 0
fi
echo "FAIL - expected a green tree and every mutant caught"; exit 1
