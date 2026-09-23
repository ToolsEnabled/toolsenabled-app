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
  *) fail 'unsupported maintainer action' ;;
esac
APP=$TASK_ROOT/opt/ToolsEnabled
PROFILE=$TASK_ROOT/etc/apparmor.d/toolsenabled-customer
RECEIPT_DIR=$TASK_ROOT/var/lib/toolsenabled-installer
RECEIPT=$RECEIPT_DIR/profile.sha256
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
# All traversed mutable parents must be protected before accessing children.
for item in "$TASK_ROOT/opt" "$TASK_ROOT/etc" "$TASK_ROOT/var" "$TASK_ROOT/var/lib"; do
  safe "$item"; [ -d "$item" ] || fail 'parent is not directory'
done
if [ -e "$TASK_ROOT/etc/apparmor.d" ] || [ -L "$TASK_ROOT/etc/apparmor.d" ]; then
  safe "$TASK_ROOT/etc/apparmor.d"; [ -d "$TASK_ROOT/etc/apparmor.d" ] || fail 'profile parent is not directory'
fi
if [ -e "$RECEIPT_DIR" ] || [ -L "$RECEIPT_DIR" ]; then safe "$RECEIPT_DIR"; fi
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
      [ -r "$TASK_ROOT/sys/kernel/security/apparmor/profiles" ] || fail 'cannot inspect loaded AppArmor names'
      while IFS= read -r line; do
        case "$line" in
          'toolsenabled-customer ('*')') LOADED=1 ;;
          toolsenabled-customer*) fail 'ambiguous loaded profile name' ;;
        esac
      done < "$TASK_ROOT/sys/kernel/security/apparmor/profiles"
      if [ "$LOADED" = 1 ]; then
        [ -x "$PARSER" ] || fail 'cannot unload profile: parser missing'
        "$PARSER" --remove "$PROFILE" || fail 'profile unload failed; profile preserved'
      fi
    fi
    rm -- "$PROFILE"
  fi
  if [ -e "$RECEIPT" ]; then rm -- "$RECEIPT"; fi
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
EXPECTED=$(printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' '' 'profile toolsenabled-customer "/opt/ToolsEnabled/toolsenabled" flags=(unconfined) {' '  userns,' '}' | sha256sum | cut -d ' ' -f 1)
[ "$(digest "$APP/resources/apparmor-profile")" = "$EXPECTED" ] || fail 'unexpected packaged profile bytes'
if [ "$RESTRICTED" = 0 ] && [ "$OFFLINE" = 0 ]; then
  echo 'ToolsEnabled userns profile not required by this kernel; no sandbox bypass installed.'
  exit 0
fi
[ "$ENABLED" = 1 ] || [ "$OFFLINE" = 1 ] || fail 'restriction active but AppArmor state unavailable'
[ -d "$TASK_ROOT/etc/apparmor.d" ] || fail 'AppArmor profile directory required'
[ -x "$PARSER" ] || fail 'AppArmor parser required'
"$PARSER" --skip-kernel-load --skip-read-cache "$APP/resources/apparmor-profile" || fail 'AppArmor profile compilation failed'
if [ ! -e "$RECEIPT_DIR" ]; then mkdir -m 0755 -- "$RECEIPT_DIR"; fi
# mktemp creates new files exclusively in protected package-managed directories.
TEMP_PROFILE=$(mktemp "$TASK_ROOT/etc/apparmor.d/.toolsenabled-customer.XXXXXX")
TEMP_RECEIPT=$(mktemp "$RECEIPT_DIR/.profile.XXXXXX")
trap 'rm -f -- "$TEMP_PROFILE" "$TEMP_RECEIPT"' EXIT
install -m 0644 -- "$APP/resources/apparmor-profile" "$TEMP_PROFILE"
printf '%s\n' "$EXPECTED" > "$TEMP_RECEIPT"
chmod 0644 -- "$TEMP_RECEIPT"
# Receipt first: any interrupted operation remains fail-closed on next configure.
mv -f -- "$TEMP_RECEIPT" "$RECEIPT"
mv -f -- "$TEMP_PROFILE" "$PROFILE"
if [ "$OFFLINE" = 1 ]; then
  echo 'ToolsEnabled profile installed for next boot; live activation deferred (offline image).'
else
  "$PARSER" --replace --write-cache --skip-read-cache "$PROFILE" || fail 'AppArmor activation failed; retry package configuration'
  echo 'ToolsEnabled fixed-path userns profile activated; application sandbox remains enabled.'
fi
