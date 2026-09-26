#!/usr/bin/env bash
# ToolsEnabled Linux package-signing key: OWNER-RUN ONLY.
#
# This script is for the owner to run, by hand, on a machine they trust. No
# agent or build runs it. It creates:
#   - an OFFLINE primary key (certify only) -- the long-term identity customers
#     pin in apt's Signed-By; it never touches a build machine;
#   - a SIGNING subkey with a shorter expiry -- the only secret the build
#     machine ever holds, replaceable without customers changing anything;
#   - the public key (binary .pgp for apt, armored .asc for people), a
#     revocation certificate, a full secret backup, and a subkey-only export.
#
# Usage:
#   tools/code-signing/linux-signing-key-owner.sh --gnupghome <new empty dir> [--uid "<name> <email>"]
#       [--primary-expiry 5y] [--subkey-expiry 2y] [--algorithm ed25519|rsa4096] [--print-plan]
#
# Choose --gnupghome on storage you control and can take offline (for example
# an encrypted USB drive). GnuPG asks for a passphrase through pinentry; use a
# strong one and store it separately from the drive. --print-plan prints every
# command and creates nothing.
set -euo pipefail

home=''
uid='ToolsEnabled Package Signing <support@toolsenabled.ai>'
primary_expiry='5y'
subkey_expiry='2y'
algorithm='ed25519'
plan_only=0

die() { printf 'linux-signing-key-owner: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --gnupghome) [ $# -ge 2 ] || die '--gnupghome needs a directory'; home="$2"; shift 2 ;;
    --uid) [ $# -ge 2 ] || die '--uid needs a value'; uid="$2"; shift 2 ;;
    --primary-expiry) [ $# -ge 2 ] || die '--primary-expiry needs a value'; primary_expiry="$2"; shift 2 ;;
    --subkey-expiry) [ $# -ge 2 ] || die '--subkey-expiry needs a value'; subkey_expiry="$2"; shift 2 ;;
    --algorithm) [ $# -ge 2 ] || die '--algorithm needs a value'; algorithm="$2"; shift 2 ;;
    --print-plan) plan_only=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$home" ] || die '--gnupghome <new empty directory> is required: decide where the offline key lives before it exists'
case "$home" in /*) ;; *) die '--gnupghome must be an absolute path' ;; esac
case "$algorithm" in ed25519|rsa4096) ;; *) die '--algorithm must be ed25519 or rsa4096' ;; esac
case "$primary_expiry$subkey_expiry" in *[!0-9ymwd]*) die 'expiry values look like 5y, 2y, 18m' ;; esac
if [ -e "$home" ] && [ -n "$(ls -A "$home" 2>/dev/null)" ]; then
  die "$home is not empty; this script only creates a key in a new, empty GnuPG home"
fi

run() {
  if [ "$plan_only" -eq 1 ]; then printf '  %s\n' "$*"; else "$@"; fi
}

if [ "$plan_only" -eq 1 ]; then
  printf 'PLAN (nothing is created):\n'
fi
run install -d -m 0700 "$home" "$home/export"
export GNUPGHOME="$home"
run gpg --quick-generate-key "$uid" "$algorithm" cert "$primary_expiry"

if [ "$plan_only" -eq 1 ]; then
  primary='<PRIMARY-FINGERPRINT>'
  subkey='<SUBKEY-FINGERPRINT>'
else
  primary="$(gpg --batch --with-colons --list-secret-keys "$uid" | awk -F: '/^fpr:/ { print $10; exit }')"
  [ -n "$primary" ] || die 'the primary key was not created'
fi
run gpg --quick-add-key "$primary" "$algorithm" sign "$subkey_expiry"
if [ "$plan_only" -eq 0 ]; then
  subkey="$(gpg --batch --with-colons --fingerprint --fingerprint --list-secret-keys "$primary" \
    | awk -F: '/^ssb:/ { want = ($12 ~ /s/) } want && /^fpr:/ { print $10; exit }')"
  [ -n "$subkey" ] || die 'the signing subkey was not created'
fi

out="$home/export"
if [ "$plan_only" -eq 1 ]; then
  run "gpg --export $primary > $out/toolsenabled-archive-keyring.pgp"
  run "gpg --armor --export $primary > $out/toolsenabled-archive-keyring.asc"
  run "gpg --armor --export-secret-keys $primary > $out/PRIMARY-SECRET-BACKUP.asc"
  run "gpg --armor --export-secret-subkeys $subkey! > $out/signing-subkey-only.asc"
  run "cp $home/openpgp-revocs.d/$primary.rev $out/REVOCATION-CERTIFICATE.rev"
else
  gpg --export "$primary" > "$out/toolsenabled-archive-keyring.pgp"
  gpg --armor --export "$primary" > "$out/toolsenabled-archive-keyring.asc"
  gpg --armor --export-secret-keys "$primary" > "$out/PRIMARY-SECRET-BACKUP.asc"
  gpg --armor --export-secret-subkeys "$subkey!" > "$out/signing-subkey-only.asc"
  cp "$home/openpgp-revocs.d/$primary.rev" "$out/REVOCATION-CERTIFICATE.rev"
  chmod 0600 "$out/PRIMARY-SECRET-BACKUP.asc" "$out/signing-subkey-only.asc" "$out/REVOCATION-CERTIFICATE.rev"
fi

cat <<EOF

Primary (offline) fingerprint: $primary
Signing subkey fingerprint:    $subkey

Next steps (see tools/code-signing/README.md, "Linux"):
  1. Keep $home and export/PRIMARY-SECRET-BACKUP.asc + export/REVOCATION-CERTIFICATE.rev
     OFFLINE, in two places. Anyone holding the revocation certificate can revoke the key.
  2. On the Linux build machine ONLY:  gpg --import signing-subkey-only.asc
     then set TOOLSENABLED_LINUX_SIGNING_KEY=$subkey
  3. Publish export/toolsenabled-archive-keyring.pgp (and .asc) over HTTPS, and publish
     the primary fingerprint on the website so customers can check it.
  4. Before the subkey expires ($subkey_expiry), bring the offline home back, extend or
     add a new signing subkey, and re-publish the public key. Customers keep the same pin.
EOF
