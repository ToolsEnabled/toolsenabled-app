# Final deck acceptance test

`final_deck_acceptance.test.py` is a read-only, standalone check for the
intended 17-slide final deck. It does not render, start the suite, or write to
the fixture.

From `Presentation\suite`, create a flat copied fixture and run:

```powershell
$fixture = Join-Path $env:TEMP "lean-bench-final-acceptance"
New-Item -ItemType Directory -Force -Path $fixture | Out-Null
Copy-Item -LiteralPath ".\data\model.json" -Destination "$fixture\model.json"
Copy-Item -LiteralPath ".\data\render-state.json" -Destination "$fixture\render-state.json"
Copy-Item -LiteralPath "..\presentation.pptx" -Destination "$fixture\presentation.pptx"
python ".\final_deck_acceptance.test.py" --fixture-root $fixture
```

For a suite-only snapshot, `data\thumbs-src.pptx` may be copied as
`presentation.pptx` after confirming that its size and SHA-256 match
`data\render-state.json`.

Exit code `0` means every final-deck contract passed. Exit code `1` means one
or more acceptance assertions failed. Exit code `2` means the copied fixture
is incomplete.

The acceptance contract is intentionally strict. It checks the exact
17-slide speaking order, the nuanced water-measurement hook, the two
alternative disclosure conditions, the Li et al. water-footprint citation,
all 17 generated timeline states, valid object-animation targets, Segoe UI at
20pt or larger, footer clearance, sources immediately before Q&A, and an
up-to-date render-state hash.

Slide `s8` must retain the approved static kaiju as a fallback poster and add
one embedded `assets/kaiju-motion` MP4 whose filename identifies the
defeat/shrink/mini narrative. That video must wait for an explicit presenter
click (`autoplay=false`) and play once (`loop=false`) in the same box as the
poster. The poster must not also click-build over the click-to-play video. The
current release implements that media contract and carries the final 17/17
timeline through Q&A; any future failure is a real regression.
