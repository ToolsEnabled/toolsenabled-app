#!/usr/bin/env python
"""Startup migration helper for server.js.

model.json's overlay decor[] entries predate shape-id tracking, so they
carry {kind, box, fill} but no way to find the real shape again at render
time. This walks base.pptx with the EXACT same shape filter import_pptx.py
used to build each slide's decor[] list, in the same order, and prints the
resulting shape id per decor slot (null for "pic" entries, which import_pptx
never made colorable) so server.js can zip it back onto decor[].sid.

    python tools_decor_sids.py <base.pptx>

Prints {"<base slide index>": [sid|null, ...], ...} as JSON on stdout.
"""
import json
import sys

from pptx import Presentation
from import_pptx import derive_slide, load_theme_colors


def main(base_path):
    prs = Presentation(base_path)
    theme = load_theme_colors(prs)
    out = {}
    for si in range(len(prs.slides)):
        # One canonical classifier, shared with new imports. In particular,
        # theme-color solid fills must occupy the same slot here as they do in
        # import_pptx.py or every later SID shifts/migration is skipped.
        decor = derive_slide(prs, si, theme)["decor"]
        out[si] = [d.get("sid") if d.get("kind") == "shape" else None for d in decor]
    print(json.dumps(out))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python tools_decor_sids.py <base.pptx>", file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1])
