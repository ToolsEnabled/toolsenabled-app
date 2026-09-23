#!/usr/bin/env python
"""Read-only acceptance test for the intended 17-slide final deck.

The test never renders or writes presentation data. Point it at a copied,
flat fixture directory containing model.json, render-state.json, and
presentation.pptx.
"""

import argparse
import hashlib
import json
import math
import re
import sys
import unittest
import zipfile
from dataclasses import dataclass
from pathlib import Path

sys.dont_write_bytecode = True

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.oxml.ns import qn


EXPECTED_ORDER = [
    "s1",
    "s15",
    "s2",
    "s3",
    "s4",
    "s5",
    "s6",
    "s7",
    "s8",
    "s9",
    "s10",
    "s12",
    "s13",
    "s11",
    "s14",
    "s16",
    "sef432705",
]

TIMELINE_STATES = [
    ("s1", "spawn"),
    ("s15", "hook"),
    ("s2", "quest"),
    ("s3", "baseline"),
    ("s4", "crash"),
    ("s5", "specify"),
    ("s6", "build"),
    ("s7", "verify"),
    ("s8", "peak"),
    ("s9", "trap"),
    ("s10", "power-up"),
    ("s12", "gate"),
    ("s13", "audit"),
    ("s11", "boss"),
    ("s14", "exit"),
    ("s16", "credits"),
    ("sef432705", "flag"),
]

EXPECTED_TIMELINES = {
    slide_id: (
        "assets/timeline/generated-17/"
        f"timeline-{position:02d}-{state}.png"
    )
    for position, (slide_id, state) in enumerate(TIMELINE_STATES, start=1)
}

SUPPORTED_EFFECTS = {"appear", "fade", "wipe", "rise-up"}
SUPPORTED_TRIGGERS = {"click", "with-previous", "after-previous"}
FOOTER_TOP = 0.80
EPSILON = 0.00001


@dataclass(frozen=True)
class FixturePaths:
    root: Path
    model: Path
    render_state: Path
    pptx: Path

    @classmethod
    def from_root(cls, root):
        root = Path(root).resolve()
        return cls(
            root=root,
            model=root / "model.json",
            render_state=root / "render-state.json",
            pptx=root / "presentation.pptx",
        )

    def missing(self):
        return [
            path for path in (self.model, self.render_state, self.pptx)
            if not path.is_file()
        ]


def load_json(path):
    with Path(path).open("r", encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError(f"{Path(path).name} must contain a JSON object")
    return value


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_text(value):
    return re.sub(
        r"\s+",
        " ",
        str(value or "")
        .replace("\u2018", "'")
        .replace("\u2019", "'"),
    ).strip()


def element_values(element):
    values = []
    if element.get("text") is not None:
        values.append(str(element.get("text") or ""))
    values.extend(str(item) for item in element.get("items", []))
    return values


def element_text(element):
    return normalize_text(" ".join(element_values(element)))


def slide_text(slide):
    return normalize_text(
        " ".join(
            value
            for element in slide.get("elements", [])
            for value in element_values(element)
        )
    )


def object_map(slide):
    result = {}
    for item in slide.get("elements", []):
        result[item["id"]] = ("element", item)
    for item in slide.get("decor", []):
        result[item["id"]] = ("decor", item)
    return result


def timeline_decor(slide):
    return [
        item for item in slide.get("decor", [])
        if item.get("kind") == "pic"
        and "/timeline/" in str(item.get("source", "")).replace("\\", "/")
    ]


def is_digits_only(values):
    nonblank = [normalize_text(value) for value in values if normalize_text(value)]
    return bool(nonblank) and all(
        re.fullmatch(r"\d{1,2}", value) for value in nonblank
    )


def is_hidden_model_page_number(element):
    box = element.get("box")
    ref = element.get("ref")
    return (
        isinstance(box, dict)
        and isinstance(ref, dict)
        and isinstance(ref.get("sid"), int)
        and float(box.get("y", 0)) > 0.90
        and is_digits_only(element_values(element))
    )


def hidden_page_shape_ids(slide):
    return {
        element["ref"]["sid"]
        for element in slide.get("elements", [])
        if is_hidden_model_page_number(element)
    }


def _latin_typeface(parent):
    if parent is None:
        return None
    latin = parent.find(qn("a:latin"))
    if latin is None:
        return None
    value = latin.get("typeface")
    return value.strip() if value and value.strip() else None


def _font_size(parent):
    if parent is None:
        return None
    value = parent.get("sz")
    if value is None:
        return None
    try:
        return int(value) / 100
    except (TypeError, ValueError):
        return None


def _paragraph_defaults(para):
    defaults = []
    ppr = para._p.find(qn("a:pPr"))
    if ppr is not None:
        defaults.append(ppr.find(qn("a:defRPr")))

    txbody = para._p.getparent()
    if txbody is not None:
        list_style = txbody.find(qn("a:lstStyle"))
        if list_style is not None:
            level = getattr(para, "level", 0) + 1
            level_ppr = list_style.find(qn(f"a:lvl{level}pPr"))
            if level_ppr is not None:
                defaults.append(level_ppr.find(qn("a:defRPr")))

    defaults.append(para._p.find(qn("a:endParaRPr")))
    return [item for item in defaults if item is not None]


def effective_font_name(run, para):
    name = run.font.name
    if name:
        return name

    direct = run._r.find(qn("a:rPr"))
    name = _latin_typeface(direct)
    if name:
        return name

    for default in _paragraph_defaults(para):
        name = _latin_typeface(default)
        if name:
            return name
    return None


def effective_font_size(run, para):
    size = run.font.size
    if size is not None:
        return size.pt

    direct = run._r.find(qn("a:rPr"))
    size = _font_size(direct)
    if size is not None:
        return size

    for default in _paragraph_defaults(para):
        size = _font_size(default)
        if size is not None:
            return size
    return None


def iter_text_frames(shapes):
    for shape in shapes:
        try:
            if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
                yield from iter_text_frames(shape.shapes)
                continue
        except Exception:
            pass

        if getattr(shape, "has_text_frame", False):
            yield shape, shape.text_frame, None

        if getattr(shape, "has_table", False):
            for row_index, row in enumerate(shape.table.rows, start=1):
                for col_index, cell in enumerate(row.cells, start=1):
                    yield shape, cell.text_frame, (
                        f"table cell {row_index},{col_index}"
                    )


def text_frame_text(text_frame):
    return normalize_text(
        " ".join(para.text for para in text_frame.paragraphs)
    )


def shape_label(shape, model_slide, suffix=None):
    imported = {
        element.get("ref", {}).get("sid"): element["id"]
        for element in model_slide.get("elements", [])
        if isinstance(element.get("ref"), dict)
    }
    name = str(getattr(shape, "name", "") or "")
    if name.startswith("Suite element "):
        label = name.removeprefix("Suite element ")
    elif shape.shape_id in imported:
        label = imported[shape.shape_id]
    else:
        label = f"shape {shape.shape_id}"
    return f"{label} {suffix}" if suffix else label


def shape_geometry(shape, presentation):
    return {
        "x": shape.left / presentation.slide_width,
        "y": shape.top / presentation.slide_height,
        "w": shape.width / presentation.slide_width,
        "h": shape.height / presentation.slide_height,
    }


def format_problems(problems, limit=40):
    if not problems:
        return ""
    shown = problems[:limit]
    if len(problems) > limit:
        shown.append(f"... {len(problems) - limit} more")
    return "\n" + "\n".join(f"  - {item}" for item in shown)


class FinalDeckAcceptanceTests(unittest.TestCase):
    paths = None

    @classmethod
    def setUpClass(cls):
        if cls.paths is None:
            raise RuntimeError("fixture paths were not configured")
        cls.model = load_json(cls.paths.model)
        cls.marker = load_json(cls.paths.render_state)
        cls.presentation = Presentation(str(cls.paths.pptx))
        cls.slides = cls.model.get("slides", [])
        cls.by_id = {
            slide.get("id"): slide for slide in cls.slides
            if isinstance(slide, dict) and isinstance(slide.get("id"), str)
        }

    def require_slide(self, slide_id):
        self.assertIn(
            slide_id,
            self.by_id,
            f"model is missing required stable slide {slide_id}",
        )
        return self.by_id[slide_id]

    def require_element(self, slide_id, element_id):
        slide = self.require_slide(slide_id)
        elements = {
            element.get("id"): element
            for element in slide.get("elements", [])
        }
        self.assertIn(
            element_id,
            elements,
            f"{slide_id} is missing required element {element_id}",
        )
        return elements[element_id]

    def assert_no_problems(self, label, problems):
        if problems:
            self.fail(label + format_problems(problems))

    def test_exact_stable_order_and_slide_count(self):
        actual = [slide.get("id") for slide in self.slides]
        self.assertEqual(
            actual,
            EXPECTED_ORDER,
            "final stable slide order does not match the intended 17-slide talk",
        )
        self.assertEqual(len(set(actual)), 17, "stable slide IDs are not unique")
        self.assertEqual(
            len(self.presentation.slides),
            17,
            "published PPTX must contain exactly 17 slides",
        )

    def test_water_hook_has_required_wording_and_honest_nuance(self):
        expected = {
            "e14_4": "WHY THE MEASUREMENT MATTERS",
            "e14_5": (
                "Check what you are measuring before running a larger "
                "experiment."
            ),
        }
        for element_id, required in expected.items():
            actual = element_text(self.require_element("s15", element_id))
            self.assertEqual(
                actual,
                required,
                f"s15/{element_id} water-hook wording drifted",
            )

        answer = self.require_element("s15", "e14_6")
        items = [
            normalize_text(value)
            for value in answer.get("items", [])
            if normalize_text(value)
        ]
        self.assertEqual(
            items,
            [
                "Every model run uses energy and water.",
                "A measurement you cannot trust wastes both.",
                "No savings are claimed here.",
            ],
            "s15/e14_6 must preserve the concise resource-measurement caveat",
        )

        slide = self.require_slide("s15")
        # The human's direct final pass supplied the closing art from the
        # Desktop (slide2image.jpg) and retired every generated candidate.
        resource_visual_source = "assets/slide2/slide2image.jpg"
        hook_art = [
            item for item in slide.get("decor", [])
            if item.get("kind") == "pic"
            and item.get("source") == resource_visual_source
        ]
        self.assertEqual(
            len(hook_art),
            1,
            "s15 must contain exactly one human-approved measurement visual",
        )
        self.assertIs(
            hook_art[0].get("generated"),
            True,
            "s15 resource visual must remain a generated picture",
        )
        self.assertEqual(
            hook_art[0].get("box"),
            {"x": 0.652, "y": 0.21, "w": 0.23625, "h": 0.42},
            "s15 measurement visual geometry drifted",
        )
        rejected_resource_art = [
            item.get("source")
            for item in slide.get("decor", [])
            if item.get("kind") == "pic"
            and item.get("source") != resource_visual_source
            and (
                "/s15-resource-link-" in str(item.get("source", "")).casefold()
                or re.search(
                    r"(?:magnifier|lens|target|globe|earth)",
                    str(item.get("source", "")),
                    re.IGNORECASE,
                )
            )
        ]
        self.assertEqual(
            rejected_resource_art,
            [],
            "s15 must not retain the retired or magnifier/lens/target/globe resource art",
        )
        builds = slide.get("animations", [])
        self.assertEqual(
            [
                (
                    build.get("targetId"),
                    build.get("effect"),
                    build.get("trigger"),
                    build.get("duration"),
                )
                for build in builds
            ],
            [
                ("d674b404b", "fade", "click", 0.4),
                ("da01cd07a", "fade", "with-previous", 0.4),
                ("d86aded16", "fade", "with-previous", 0.4),
                (hook_art[0]["id"], "fade", "with-previous", 0.4),
                ("e14_6", "fade", "with-previous", 0.4),
            ],
            "s15 frame panel, rules, art, and caveat build order drifted",
        )

        hook = slide_text(slide).casefold()
        unsupported = [
            r"\buses less water\b",
            r"\bsaves? water\b",
            r"\breduces? water\b",
            r"\bnet water savings?\b",
            r"\b\d+(?:\.\d+)?\s*%\b",
            r"\b(?:gallons?|liters?|litres?|milliliters?|ml)\b",
        ]
        for pattern in unsupported:
            self.assertNotRegex(
                hook,
                pattern,
                f"water hook contains unsupported quantified or net-savings claim: {pattern}",
            )

    def test_s10_uses_two_alternative_one_sentence_disclosures(self):
        exact = {
            "e9_6": (
                "Same task and model. Four separate prompt versions, "
                "10 tries each."
            ),
            "e9_7": "Claude Haiku 4.5: 10 tries per separate condition",
            "e9_11": "1/10 passed",
            "e9_12": "Mechanic hidden",
            "e9_14": "6/10 passed",
            "e9_15": "Required behavior stated",
            "e9_17": "9/10 passed",
            "e9_18": "Platform mechanic named",
            "e9_20": "7/10 passed",
            "e9_21": "7-word guard deleted",
            "e9_28": (
                "Separate alternatives, not steps. Frontier-tier pilot: "
                "hidden was already 10/10."
            ),
        }
        for element_id, required in exact.items():
            actual = element_text(self.require_element("s10", element_id))
            self.assertEqual(
                actual,
                required,
                f"s10/{element_id} does not match the alternative-disclosure framing",
            )

        text = slide_text(self.require_slide("s10"))
        accepted_negative = exact["e9_28"]
        scan = text.replace(accepted_negative, "")
        forbidden = [
            r"\bPrompt only\b",
            r"\bPrompt \+ 1 fact\b",
            r"\bPrompt \+ 2 facts\b",
            r"\bAdd one hidden platform fact per condition\b",
            r"\bcumulative\b",
            r"\bdosing\b",
            r"\bdose ladder\b",
        ]
        for pattern in forbidden:
            self.assertNotRegex(
                scan,
                re.compile(pattern, re.IGNORECASE),
                f"s10 still describes a cumulative dose ladder: {pattern}",
            )

    def test_li_2023_citation_is_on_sources_slide(self):
        source_slide = self.require_slide("s16")
        values = [
            normalize_text(value)
            for element in source_slide.get("elements", [])
            for value in element_values(element)
            if normalize_text(value)
        ]
        citations = [
            value for value in values
            if re.search(r"\bLi\b", value, re.IGNORECASE)
            and "(2023)" in value
        ]
        self.assertEqual(
            len(citations),
            1,
            "s16 must contain exactly one Li et al. (2023) citation, "
            f"found: {citations}",
        )
        citation = citations[0]
        self.assertRegex(
            citation,
            re.compile(
                r"\b(?:"
                r"Li(?:,\s*P\.)?,?\s+et al\."
                r"|"
                r"Li,\s*P\.,\s*Yang,\s*J\.,\s*Islam,\s*M\.\s*A\.,"
                r"\s*&\s*Ren,\s*S\."
                r")\s*\(2023\)",
                re.IGNORECASE,
            ),
        )
        self.assertRegex(
            citation,
            re.compile(r"Making AI Less [\"'\u201c\u201d]?Thirsty", re.IGNORECASE),
        )
        self.assertIn(
            "2304.03271",
            citation,
            "Li et al. citation must include arXiv:2304.03271",
        )

    def test_every_slide_has_the_correct_generated_17_timeline(self):
        problems = []
        for slide_id in EXPECTED_ORDER:
            slide = self.require_slide(slide_id)
            expected = EXPECTED_TIMELINES[slide_id]
            timelines = timeline_decor(slide)
            if len(timelines) != 1:
                problems.append(
                    f"{slide_id}: expected one timeline, found "
                    f"{len(timelines)} sources "
                    f"{[item.get('source') for item in timelines]}"
                )
                continue
            timeline = timelines[0]
            if timeline.get("source") != expected:
                problems.append(
                    f"{slide_id}: source/counter/state expected {expected}, "
                    f"found {timeline.get('source')}"
                )
            if timeline.get("generated") is not True:
                problems.append(
                    f"{slide_id}/{timeline.get('id')}: timeline is not generated"
                )
            if timeline.get("box") != {"x": 0, "y": 0, "w": 1, "h": 1}:
                problems.append(
                    f"{slide_id}/{timeline.get('id')}: timeline box is "
                    f"{timeline.get('box')}, expected full slide"
                )
        self.assert_no_problems("generated-17 timeline contract failed", problems)

    def test_animation_targets_and_timing_are_structurally_valid(self):
        problems = []
        for slide in self.slides:
            slide_id = slide.get("id")
            objects = object_map(slide)
            media_ids = {
                item["id"] for item in slide.get("decor", [])
                if item.get("kind") == "media"
            }
            timeline_ids = {
                item["id"] for item in timeline_decor(slide)
                if isinstance(item.get("id"), str)
            }
            animations = slide.get("animations", [])
            if not isinstance(animations, list):
                problems.append(f"{slide_id}: animations must be an array")
                continue
            targets = []
            for index, animation in enumerate(animations):
                target = animation.get("targetId")
                targets.append(target)
                prefix = f"{slide_id} animation {index} target {target}"
                if target not in objects:
                    problems.append(f"{prefix}: target does not exist")
                if target in media_ids:
                    problems.append(f"{prefix}: media cannot be object-animated")
                if target in timeline_ids:
                    problems.append(f"{prefix}: timeline decor must not animate")
                if animation.get("effect") not in SUPPORTED_EFFECTS:
                    problems.append(
                        f"{prefix}: unsupported effect {animation.get('effect')}"
                    )
                if animation.get("trigger") not in SUPPORTED_TRIGGERS:
                    problems.append(
                        f"{prefix}: unsupported trigger {animation.get('trigger')}"
                    )
                duration = animation.get("duration")
                delay = animation.get("delay")
                if (
                    not isinstance(duration, (int, float))
                    or isinstance(duration, bool)
                    or not math.isfinite(duration)
                    or duration <= 0
                ):
                    problems.append(f"{prefix}: invalid duration {duration}")
                if (
                    not isinstance(delay, (int, float))
                    or isinstance(delay, bool)
                    or not math.isfinite(delay)
                    or delay < 0
                ):
                    problems.append(f"{prefix}: invalid delay {delay}")
            if len(targets) != len(set(targets)):
                problems.append(f"{slide_id}: animation targets are duplicated")
            if animations and animations[0].get("trigger") != "click":
                problems.append(
                    f"{slide_id}: first build must start on click, found "
                    f"{animations[0].get('trigger')}"
                )
        self.assert_no_problems("animation contract failed", problems)

    def test_kaiju_static_fallback_and_non_loop_defeat_video_are_preserved(self):
        slide = self.require_slide("s8")
        kaiju = [
            item for item in slide.get("decor", [])
            if item.get("kind") == "pic"
            and item.get("source")
            == "assets/kaiju-motion/kaiju-defeat-giant-poster.png"
        ]
        self.assertEqual(len(kaiju), 1, "s8 must contain exactly one kaiju picture")
        self.assertEqual(
            kaiju[0].get("id"),
            "d217c568a",
            "s8 kaiju stable target ID changed",
        )
        self.assertIs(
            kaiju[0].get("generated"),
            True,
            "s8 kaiju fallback must remain a generated local picture",
        )

        videos = [
            item for item in slide.get("decor", [])
            if item.get("kind") == "media"
            and re.fullmatch(
                r"assets/kaiju-motion/[^/]*(?:defeat|mini|shrink)[^/]*\.mp4",
                str(item.get("source", "")).replace("\\", "/"),
                re.IGNORECASE,
            )
        ]
        self.assertEqual(
            len(videos),
            1,
            "s8 must contain exactly one local shrink-to-mini defeat MP4",
        )
        video = videos[0]
        self.assertIs(
            video.get("generated"),
            True,
            "s8 defeat MP4 must be embedded as generated media",
        )
        self.assertIs(
            video.get("autoplay"),
            False,
            "s8 defeat MP4 must wait for an explicit presenter click, never autoplay",
        )
        self.assertIs(
            video.get("loop"),
            False,
            "s8 defeat MP4 must play its short defeat narrative once per click",
        )
        self.assertEqual(
            video.get("box"),
            kaiju[0].get("box"),
            "s8 defeat MP4 and static fallback poster must share one box",
        )

        builds = [
            animation for animation in slide.get("animations", [])
            if animation.get("targetId") == kaiju[0]["id"]
        ]
        self.assertEqual(
            builds,
            [],
            "the static kaiju is a fallback poster and must not click-build "
            "over the click-to-play defeat video",
        )

    def test_visible_rendered_text_is_segoe_ui_at_least_20pt(self):
        problems = []
        for slide_index, (model_slide, rendered_slide) in enumerate(
            zip(self.slides, self.presentation.slides),
            start=1,
        ):
            hidden_sids = hidden_page_shape_ids(model_slide)
            for shape, text_frame, suffix in iter_text_frames(
                rendered_slide.shapes
            ):
                text = text_frame_text(text_frame)
                if not text:
                    continue
                if (
                    shape.shape_id in hidden_sids
                    and re.fullmatch(r"\d{1,2}", text)
                ):
                    continue
                label = shape_label(shape, model_slide, suffix)
                nonblank_runs = 0
                for para in text_frame.paragraphs:
                    for run in para.runs:
                        run_text = normalize_text(run.text)
                        if not run_text:
                            continue
                        nonblank_runs += 1
                        font = effective_font_name(run, para)
                        size = effective_font_size(run, para)
                        if font != "Segoe UI":
                            problems.append(
                                f"slide {slide_index} {model_slide.get('id')}/"
                                f"{label}: font {font!r} for {run_text[:60]!r}"
                            )
                        if size is None or size < 20 - EPSILON:
                            problems.append(
                                f"slide {slide_index} {model_slide.get('id')}/"
                                f"{label}: size {size!r} for {run_text[:60]!r}"
                            )
                if nonblank_runs == 0:
                    problems.append(
                        f"slide {slide_index} {model_slide.get('id')}/{label}: "
                        f"visible text has no resolvable runs: {text[:60]!r}"
                    )
        self.assert_no_problems("visible typography contract failed", problems)

    def test_no_text_crosses_into_the_footer(self):
        problems = []
        for slide in self.slides:
            slide_id = slide.get("id")
            for element in slide.get("elements", []):
                values = element_values(element)
                if not any(normalize_text(value) for value in values):
                    continue
                if is_hidden_model_page_number(element):
                    continue
                box = element.get("box")
                if not isinstance(box, dict):
                    continue
                bottom = float(box.get("y", 0)) + float(box.get("h", 0))
                if bottom > FOOTER_TOP + EPSILON:
                    problems.append(
                        f"model {slide_id}/{element.get('id')}: bottom "
                        f"{bottom:.5f} exceeds {FOOTER_TOP:.2f}, text "
                        f"{element_text(element)[:80]!r}"
                    )

        for slide_index, (model_slide, rendered_slide) in enumerate(
            zip(self.slides, self.presentation.slides),
            start=1,
        ):
            hidden_sids = hidden_page_shape_ids(model_slide)
            for shape, text_frame, suffix in iter_text_frames(
                rendered_slide.shapes
            ):
                text = text_frame_text(text_frame)
                if not text:
                    continue
                if (
                    shape.shape_id in hidden_sids
                    and re.fullmatch(r"\d{1,2}", text)
                ):
                    continue
                box = shape_geometry(shape, self.presentation)
                bottom = box["y"] + box["h"]
                if bottom > FOOTER_TOP + EPSILON:
                    label = shape_label(shape, model_slide, suffix)
                    problems.append(
                        f"PPTX slide {slide_index} {model_slide.get('id')}/"
                        f"{label}: bottom {bottom:.5f} exceeds "
                        f"{FOOTER_TOP:.2f}, text {text[:80]!r}"
                    )
        self.assert_no_problems("footer-clearance contract failed", problems)

    def test_sources_immediately_precede_the_final_qa(self):
        ids = [slide.get("id") for slide in self.slides]
        self.assertEqual(
            ids[-2:],
            ["s16", "sef432705"],
            "sources must be immediately before the final Q&A",
        )
        self.assertRegex(
            slide_text(self.require_slide("s16")),
            re.compile(r"\b(?:SOURCES|References)\b", re.IGNORECASE),
        )
        self.assertRegex(
            slide_text(self.require_slide("sef432705")),
            re.compile(r"\bQ\s*&\s*A\b", re.IGNORECASE),
        )

    def test_render_marker_matches_the_published_pptx(self):
        model_rev = self.model.get("rev")
        self.assertIsInstance(model_rev, int, "model rev must be an integer")
        self.assertEqual(
            self.marker.get("rev"),
            model_rev,
            "render-state rev does not match model rev",
        )
        stat = self.paths.pptx.stat()
        self.assertEqual(
            self.marker.get("size"),
            stat.st_size,
            "render-state size does not match presentation.pptx",
        )
        self.assertEqual(
            str(self.marker.get("sha256", "")).casefold(),
            sha256_file(self.paths.pptx),
            "render-state SHA-256 does not match presentation.pptx",
        )

        with zipfile.ZipFile(self.paths.pptx) as package:
            self.assertIsNone(
                package.testzip(),
                "presentation.pptx contains a corrupt ZIP member",
            )
            names = set(package.namelist())
            self.assertIn("[Content_Types].xml", names)
            self.assertIn("ppt/presentation.xml", names)


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description=(
            "Validate a copied final-deck fixture without rendering or writing."
        )
    )
    parser.add_argument(
        "--fixture-root",
        required=True,
        help=(
            "Directory containing model.json, render-state.json, and "
            "presentation.pptx"
        ),
    )
    return parser.parse_known_args(argv)


def main(argv=None):
    args, unittest_args = parse_args(
        sys.argv[1:] if argv is None else argv
    )
    paths = FixturePaths.from_root(args.fixture_root)
    missing = paths.missing()
    if missing:
        print(
            "FIXTURE ERROR: missing required files: "
            + ", ".join(str(path) for path in missing),
            file=sys.stderr,
        )
        return 2

    FinalDeckAcceptanceTests.paths = paths
    program = unittest.main(
        module=__name__,
        argv=[sys.argv[0], *unittest_args],
        exit=False,
        verbosity=2,
    )
    return 0 if program.result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
