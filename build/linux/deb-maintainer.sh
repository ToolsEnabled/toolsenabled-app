#!/bin/bash
# Configure BOTH deb.afterInstall and deb.afterRemove to this self-contained
# template. Never source installed app code: postrm runs after payload removal.
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022
fail() { echo "ToolsEnabled installation refused: $*" >&2; exit 1; }
TASK_ROOT=
OWNER_UID=0
OWNER_GID=0
PARSER=/usr/sbin/apparmor_parser
TEST_MODE=0
if [ -n "${TOOLSENABLED_DEB_TEST_ROOT-}" ]; then
  # No root execution of a user-selected tree or test executable, ever.
  [ "$EUID" -ne 0 ] || fail 'test seam forbidden for root'
  TASK_ROOT=$TOOLSENABLED_DEB_TEST_ROOT
  [ "$TASK_ROOT" != / ] && [ "$TASK_ROOT" = "$(realpath -e -- "$TASK_ROOT")" ] || fail 'test root must be canonical'
  [ ! -L "$TASK_ROOT" ] && [ -d "$TASK_ROOT" ] || fail 'invalid test root'
  [ "$(stat -c %u -- "$TASK_ROOT")" = "$EUID" ] && [ "$(stat -c %a -- "$TASK_ROOT")" = 700 ] || fail 'test root must be private and owned'
  OWNER_UID=$EUID
  OWNER_GID=$(id -g)
  PARSER=$TASK_ROOT/bin/apparmor_parser
  TEST_MODE=1
else
  [ "$EUID" -eq 0 ] || fail 'package manager root required'
fi
[ "${DPKG_MAINTSCRIPT_PACKAGE-}" = toolsenabled ] || fail 'unexpected package identity'
ACTION=${DPKG_MAINTSCRIPT_NAME-}
case "$ACTION:$*" in
  postinst:configure|postinst:configure\ *) ;;
  postrm:remove|postrm:purge) ;;
  postrm:upgrade\ *|postrm:failed-upgrade\ *|postrm:abort-install*|postrm:abort-upgrade*|postrm:disappear*) exit 0 ;;
  # Error unwind (Debian Policy 6.5): postrm upgrade changed nothing, so there is
  # nothing to restore. Refusing left the package unconfigured (platform L2).
  postinst:abort-upgrade\ *|postinst:abort-remove|postinst:abort-remove\ *|postinst:abort-deconfigure\ *) exit 0 ;;
  *) fail 'unsupported maintainer action' ;;
esac
APP=$TASK_ROOT/opt/ToolsEnabled
PROFILE=$TASK_ROOT/etc/apparmor.d/toolsenabled-customer
RECEIPT_DIR=$TASK_ROOT/var/lib/toolsenabled-installer
RECEIPT=$RECEIPT_DIR/profile.sha256
ADMISSION=$RECEIPT_DIR/admission.state
# Keep this identity identical to the source-controlled policy. Admission is
# package-owned state, never a caller's grant or arbitrary policy digest.
EXPECTED=$(printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' '' 'profile toolsenabled-customer "/opt/ToolsEnabled/toolsenabled" flags=(unconfined) {' '  userns,' '}' | sha256sum | cut -d ' ' -f 1)
safe() {
  local item=$1 mode
  [ ! -L "$item" ] && { [ -f "$item" ] || [ -d "$item" ]; } || fail 'nonregular managed path'
  [ "$(stat -c %u -- "$item")" = "$OWNER_UID" ] || fail 'foreign managed path owner'
  [ "$(stat -c %g -- "$item")" = "$OWNER_GID" ] || fail 'foreign managed path group'
  mode=$(stat -c %a -- "$item")
  [ "$((8#$mode & 06022))" -eq 0 ] || fail 'unsafe managed path mode'
  if [ -f "$item" ]; then [ "$(stat -c %h -- "$item")" = 1 ] || fail 'hardlinked managed file'; fi
}
digest() { sha256sum -- "$1" | cut -d ' ' -f 1; }
admission_bytes() {
  local reason=none
  [ "$1" != deferred-legacy-policy ] || reason=apparmor-3.0.8-without-abi-4.0
  printf 'toolsenabled-linux-admission-v1\npolicy-sha256=%s\nstate=%s\nreason=%s\n' "$EXPECTED" "$1" "$reason"
}
read_admission() {
  OLD_ADMISSION=
  if [ -e "$ADMISSION" ] || [ -L "$ADMISSION" ]; then
    safe "$ADMISSION"
    [ "$(stat -c %a -- "$ADMISSION")" = 644 ] || fail 'unexpected admission record mode'
    [ -f "$ADMISSION" ] && [ "$(stat -c %s -- "$ADMISSION")" -le 512 ] || fail 'invalid admission record size'
    local candidate
    for candidate in configuring deferred-legacy-policy no-policy-required profile-prepared; do
      if cmp -s -- "$ADMISSION" <(admission_bytes "$candidate"); then OLD_ADMISSION=$candidate; break; fi
    done
    [ -n "$OLD_ADMISSION" ] || fail 'malformed or foreign admission record'
  fi
}
TEMP_ADMISSION= TEMP_VERSION= TEMP_PROFILE= TEMP_RECEIPT=
cleanup_temps() {
  local item
  for item in "$TEMP_ADMISSION" "$TEMP_VERSION" "$TEMP_PROFILE" "$TEMP_RECEIPT"; do
    [ -z "$item" ] || rm -f -- "$item"
  done
}
write_admission() {
  safe "$RECEIPT_DIR"
  read_admission
  TEMP_ADMISSION=$(mktemp "$RECEIPT_DIR/.admission.XXXXXX")
  admission_bytes "$1" > "$TEMP_ADMISSION"
  chmod 0644 -- "$TEMP_ADMISSION"
  mv -f -- "$TEMP_ADMISSION" "$ADMISSION"
  TEMP_ADMISSION=
}
# All traversed mutable parents must be protected before accessing children.
#
# GUARD WHAT THIS RUN ACTUALLY TRAVERSES, NOT A FIXED LIST (T-DEB-REMOVE).
# /opt is the application's parent and is read only by the postinst branch
# below. postrm never looks inside it -- it touches /etc/apparmor.d and
# /var/lib/toolsenabled-installer and nothing else. Guarding /opt on BOTH
# actions meant postrm demanded a directory that dpkg had already removed,
# because the package owned ./opt/ itself: `safe` saw no directory, failed
# 'nonregular managed path', postrm exited non-zero, and `apt remove` and
# `apt purge` then failed FOREVER on that machine -- dpkg refuses to move past
# a package whose postrm errors, so every later apt operation is wedged too.
# MEASURED 2026-09-24 in a clean ubuntu:24.04 container: remove and purge both
# dead, dpkg unusable. This loop no longer asks postrm about a path it does
# not use, which is what makes removal finish.
#
# The package ships the shared ./opt/ directory record (platform review L1):
# without it dpkg cannot unpack ./opt/ToolsEnabled/ wherever /opt is missing,
# for example right after removing the last other package in /opt. Because
# dpkg may then remove an empty /opt with the package, this postrm guard must
# stay independent of /opt.
PARENTS=("$TASK_ROOT/etc" "$TASK_ROOT/var" "$TASK_ROOT/var/lib")
if [ "$ACTION" = postinst ]; then PARENTS=("$TASK_ROOT/opt" "${PARENTS[@]}"); fi
for item in "${PARENTS[@]}"; do
  safe "$item"; [ -d "$item" ] || fail 'parent is not directory'
done
if [ -e "$TASK_ROOT/etc/apparmor.d" ] || [ -L "$TASK_ROOT/etc/apparmor.d" ]; then
  safe "$TASK_ROOT/etc/apparmor.d"; [ -d "$TASK_ROOT/etc/apparmor.d" ] || fail 'profile parent is not directory'
fi
if [ -e "$RECEIPT_DIR" ] || [ -L "$RECEIPT_DIR" ]; then
  safe "$RECEIPT_DIR"; [ -d "$RECEIPT_DIR" ] || fail 'receipt parent is not directory'
fi
read_admission
PRIOR_ADMISSION=$OLD_ADMISSION
OLD_HASH=
if [ -e "$RECEIPT" ] || [ -L "$RECEIPT" ]; then
  safe "$RECEIPT"
  OLD_HASH=$(cat -- "$RECEIPT")
  [[ "$OLD_HASH" =~ ^[a-f0-9]{64}$ ]] || fail 'malformed installation receipt'
fi
if [ -e "$PROFILE" ] || [ -L "$PROFILE" ]; then
  safe "$PROFILE"
  [ -n "$OLD_HASH" ] && [ "$(digest "$PROFILE")" = "$OLD_HASH" ] || fail 'preserving unowned or administrator-modified profile'
fi
ENABLED=0
if [ -r "$TASK_ROOT/sys/module/apparmor/parameters/enabled" ]; then
  case "$(cat "$TASK_ROOT/sys/module/apparmor/parameters/enabled")" in Y|y|1) ENABLED=1 ;; N|n|0) ;; *) fail 'unknown AppArmor state' ;; esac
fi
RESTRICTED=0
if [ -r "$TASK_ROOT/proc/sys/kernel/apparmor_restrict_unprivileged_userns" ]; then
  case "$(cat "$TASK_ROOT/proc/sys/kernel/apparmor_restrict_unprivileged_userns")" in 1) RESTRICTED=1 ;; 0) ;; *) fail 'unknown user namespace restriction' ;; esac
fi
OFFLINE=0
if [ "$TEST_MODE" = 1 ]; then
  if [ -e "$TASK_ROOT/offline" ]; then OFFLINE=1; fi
elif [ -x /usr/bin/ischroot ]; then
  status=0; /usr/bin/ischroot || status=$?
  case "$status" in 0) OFFLINE=1 ;; 1) ;; *) fail 'cannot determine chroot state' ;; esac
else fail 'cannot determine chroot state'; fi
if [ "$ACTION" = postrm ]; then
  if [ -e "$PROFILE" ]; then
    if [ "$ENABLED" = 1 ] && [ "$OFFLINE" = 0 ]; then
      # A failed configure can leave valid managed policy on disk but no loaded
      # name. Observe exact kernel state; never interpret parser errors as absence.
      LOADED=0
      # REMOVAL MUST ALWAYS BE ABLE TO FINISH (T-DEB-REMOVE-2). Refusing here is
      # fail-closed in the wrong direction. Configuration may refuse -- an
      # install that cannot establish its sandbox should not pretend it did --
      # but a REMOVAL that refuses leaves dpkg unable to move past this package,
      # and every later apt operation on the machine fails with it. MEASURED
      # 2026-09-24 in ubuntu:24.04: /sys/kernel/security/apparmor/profiles is
      # not readable in an ordinary container, so remove and purge both died
      # here and `apt install` of anything else then failed too.
      #
      # Not being able to READ the kernel's list is not evidence the profile is
      # absent, so nothing is guessed: the unload is skipped, the managed file
      # is still removed, and the person is told plainly that a loaded profile
      # may remain until reboot. An unloaded-but-unused profile is inert; an
      # unusable package manager is not.
      INSPECTABLE=1
      [ -r "$TASK_ROOT/sys/kernel/security/apparmor/profiles" ] || INSPECTABLE=0
      if [ "$INSPECTABLE" = 1 ]; then
        while IFS= read -r line; do
          case "$line" in
            'toolsenabled-customer ('*')') LOADED=1 ;;
            toolsenabled-customer*) echo 'ToolsEnabled: an unexpected profile name matched; leaving it loaded.' >&2 ;;
          esac
        done < "$TASK_ROOT/sys/kernel/security/apparmor/profiles"
      else
        echo 'ToolsEnabled: the kernel profile list could not be read, so the profile was not unloaded. It is inert once the program is gone, and clears on reboot.' >&2
      fi
      if [ "$LOADED" = 1 ]; then
        if [ -x "$PARSER" ]; then
          "$PARSER" --remove "$PROFILE" || echo 'ToolsEnabled: the profile could not be unloaded; it clears on reboot.' >&2
        else
          echo 'ToolsEnabled: no AppArmor parser is present, so the profile was not unloaded; it clears on reboot.' >&2
        fi
      fi
    fi
    rm -- "$PROFILE"
  fi
  if [ -e "$RECEIPT" ]; then rm -- "$RECEIPT"; fi
  if [ -e "$ADMISSION" ]; then rm -- "$ADMISSION"; fi
  if [ -d "$RECEIPT_DIR" ]; then rmdir -- "$RECEIPT_DIR" || fail 'unexpected installer receipt contents'; fi
  exit 0
fi
safe "$APP"; [ -d "$APP" ] || fail 'missing application directory'
while IFS= read -r -d '' item; do safe "$item"; done < <(find "$APP" -xdev -print0)
wait "$!" || fail 'installed tree inventory failed'
for item in toolsenabled resources/app.asar resources/capability/PAYLOAD.json resources/apparmor-profile; do
  [ -f "$APP/$item" ] || fail 'missing installed payload marker'
done
[ -x "$APP/toolsenabled" ] || fail 'installed executable lacks execute mode'
# Verify the exact source-controlled policy, not arbitrary packaged policy text.
[ "$(digest "$APP/resources/apparmor-profile")" = "$EXPECTED" ] || fail 'unexpected packaged profile bytes'
if [ ! -e "$RECEIPT_DIR" ]; then mkdir -m 0755 -- "$RECEIPT_DIR"; fi
trap cleanup_temps EXIT
write_admission configuring
if [ "$RESTRICTED" = 0 ] && [ "$OFFLINE" = 0 ]; then
  if [ "$PRIOR_ADMISSION" = deferred-legacy-policy ]; then write_admission deferred-legacy-policy
  else write_admission no-policy-required; fi
  echo 'ToolsEnabled userns profile not required by this kernel; no sandbox bypass installed.'
  exit 0
fi
[ "$ENABLED" = 1 ] || [ "$OFFLINE" = 1 ] || fail 'restriction active but AppArmor state unavailable'
[ -d "$TASK_ROOT/etc/apparmor.d" ] || fail 'AppArmor profile directory required'
[ -x "$PARSER" ] || fail 'AppArmor parser required'
# A narrowly identified legacy target may configure while application launch
# remains held. This is selected BEFORE compilation, never after any failure.
# No legacy policy is installed and no missing feature becomes a permission.
if [ ! -e "$PROFILE" ] && [ ! -e "$RECEIPT" ] && [ "$PRIOR_ADMISSION" != profile-prepared ] &&
   [ -d "$TASK_ROOT/etc/apparmor.d/abi" ]; then
  safe "$TASK_ROOT/etc/apparmor.d/abi"
  # A false shell existence test alone could also mean a lookup error. Require
  # a successful protected-parent enumeration with no such directory entry.
  ABI_FOUR_ENTRY=$(find "$TASK_ROOT/etc/apparmor.d/abi" -mindepth 1 -maxdepth 1 -name 4.0 -print) || fail 'cannot inspect AppArmor ABI directory'
  if [ -z "$ABI_FOUR_ENTRY" ] && [ ! -e "$TASK_ROOT/etc/apparmor.d/abi/4.0" ] && [ ! -L "$TASK_ROOT/etc/apparmor.d/abi/4.0" ]; then
    if [ "$TEST_MODE" = 1 ]; then
      safe "$TASK_ROOT/bin"; safe "$PARSER"
    else
      PARSER_CANONICAL=$(realpath -e -- "$PARSER") || fail 'cannot establish parser identity'
      case "$PARSER_CANONICAL" in /usr/sbin/apparmor_parser|/sbin/apparmor_parser) ;; *) fail 'unreviewed parser location' ;; esac
      safe "$PARSER_CANONICAL"
      PARSER_PARENT=$(dirname -- "$PARSER_CANONICAL")
      while [ "$PARSER_PARENT" != / ]; do safe "$PARSER_PARENT"; PARSER_PARENT=$(dirname -- "$PARSER_PARENT"); done
    fi
    TEMP_VERSION=$(mktemp "$RECEIPT_DIR/.parser-version.XXXXXX")
    # Bound both elapsed time and bytes even if a damaged parser prints forever.
    if ! (ulimit -c 0; ulimit -f 4; export LC_ALL=C; /usr/bin/timeout --kill-after=1s 2s "$PARSER" --version) > "$TEMP_VERSION" 2>&1; then
      fail 'cannot establish bounded AppArmor parser version for deferred admission'
    fi
    [ "$(stat -c %s -- "$TEMP_VERSION")" -le 2048 ] || fail 'AppArmor parser version output exceeds its bound'
    if cmp -s -- "$TEMP_VERSION" <(printf '%s\n' 'AppArmor parser version 3.0.8' 'Copyright (C) 1999-2008 Novell Inc.' 'Copyright 2009-2018 Canonical Ltd.'); then
      write_admission deferred-legacy-policy
      echo 'ToolsEnabled package configured with deferred sandbox admission. Application launch is blocked while this kernel requires unavailable AppArmor policy. After providing ABI 4.0 and userns parser support, an administrator can run: dpkg-reconfigure toolsenabled'
      exit 0
    fi
  fi
fi
"$PARSER" --skip-kernel-load --skip-read-cache "$APP/resources/apparmor-profile" || fail 'AppArmor profile compilation failed: the target parser and policy files must support ABI 4.0 and the userns rule. See the parser error above; configuration remains incomplete, including for an offline image.'
# mktemp creates new files exclusively in protected package-managed directories.
TEMP_PROFILE=$(mktemp "$TASK_ROOT/etc/apparmor.d/.toolsenabled-customer.XXXXXX")
TEMP_RECEIPT=$(mktemp "$RECEIPT_DIR/.profile.XXXXXX")
install -m 0644 -- "$APP/resources/apparmor-profile" "$TEMP_PROFILE"
printf '%s\n' "$EXPECTED" > "$TEMP_RECEIPT"
chmod 0644 -- "$TEMP_RECEIPT"
# Receipt first: any interrupted operation remains fail-closed on next configure.
mv -f -- "$TEMP_RECEIPT" "$RECEIPT"
mv -f -- "$TEMP_PROFILE" "$PROFILE"
if [ "$OFFLINE" = 1 ]; then
  echo 'ToolsEnabled profile installed for next boot; live activation deferred (offline image).'
else
  # NAME THE SITUATION, BECAUSE "retry" IS ADVICE THAT CANNOT WORK. Activation
  # needs the AppArmor filesystem mounted, and in an ordinary container it is
  # not -- the parser says "unable to find a suitable fs in /proc/mounts" and
  # no number of retries changes that. MEASURED 2026-09-24 in ubuntu:24.04.
  # This still refuses rather than installing anyway: this kernel restricts
  # unprivileged user namespaces, the profile is what lets the sandbox start,
  # and a package that configures "successfully" into an application that
  # cannot run has only moved the failure somewhere harder to read.
  if ! "$PARSER" --replace --write-cache --skip-read-cache "$PROFILE"; then
    if [ ! -d "$TASK_ROOT/sys/kernel/security/apparmor" ]; then
      fail 'this system restricts unprivileged user namespaces but cannot load AppArmor policy (its filesystem is not mounted -- usual inside a container). ToolsEnabled needs that policy to start its sandbox. Run it on a host with AppArmor available, or remove the package with: apt purge toolsenabled'
    fi
    fail 'the AppArmor policy could not be activated. The profile is valid and installed at /etc/apparmor.d/toolsenabled-customer; run "apparmor_parser --replace /etc/apparmor.d/toolsenabled-customer" to see the parser error, then "dpkg --configure toolsenabled"'
  fi
  echo 'ToolsEnabled fixed-path userns profile activated; application sandbox remains enabled.'
fi
write_admission profile-prepared
