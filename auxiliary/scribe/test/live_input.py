"""Explicit, account-confined inputs for opt-in live Scribe tests."""

import os
from pathlib import Path


def _at_or_below(candidate, root):
    candidate = os.path.normcase(os.path.abspath(candidate))
    root = os.path.normcase(os.path.abspath(root))
    try:
        return os.path.commonpath((candidate, root)) == root
    except ValueError:
        return False


def _assert_account_boundary(candidate, label):
    profile = os.path.abspath(os.environ.get("USERPROFILE") or str(Path.home()))
    profiles_root = os.path.dirname(profile)
    if _at_or_below(candidate, profiles_root) and not _at_or_below(candidate, profile):
        raise RuntimeError("%s points into a different user profile." % label)


def required_live_file(env_name):
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        raise RuntimeError(
            "%s is required; no live test input is selected by default." % env_name
        )
    if os.name == "nt" and raw.startswith(("\\\\", "//")):
        raise RuntimeError("%s must not use a UNC or device namespace." % env_name)
    if not os.path.isabs(raw):
        raise RuntimeError("%s must be an absolute path." % env_name)
    lexical = os.path.abspath(raw)
    _assert_account_boundary(lexical, env_name)
    resolved = os.path.realpath(lexical)
    _assert_account_boundary(resolved, env_name)
    if not os.path.isfile(resolved):
        raise RuntimeError("%s must name a file." % env_name)
    return Path(resolved)
