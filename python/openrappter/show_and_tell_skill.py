"""Bundle -> reviewable plan: what was recorded, and what would be built.

Mirrors ``typescript/src/show-and-tell/bundle.ts`` and
``typescript/src/show-and-tell/plan.ts``.

A demonstration is not a clean list of steps. People switch apps, answer a
message, come back, capture a frame they never explain, and work in silence.
Segmenting first -- and counting what the recording could *not* account for --
keeps that visible instead of letting a confident-sounding step list imply the
recording explained everything.

The analysis answers "what happened". The plan answers "what would be built,
and on what terms": which literals from the single demonstration are editable
inputs rather than universal truths, which steps refuse to run unattended, and
which parts of the recording nothing explained. A plan is a proposal; nothing
is built from it until someone approves it, and approval is a separate turn.

Everything here is a pure function of its inputs: no clock reads, no
randomness, no model. The same events always produce the same bundle and the
same plan, in Python and in TypeScript, which is what
``contracts/show-and-tell-scenarios-v1.json`` holds both runtimes to.
"""

from __future__ import annotations

import json
import re
from typing import Any, Iterable, Optional, Sequence
from urllib.parse import urlsplit

from openrappter.show_and_tell import (
    SHOW_AND_TELL_BUNDLE_SCHEMA,
    SHOW_AND_TELL_PLAN_SCHEMA,
    SENSITIVE_MASK,
    _safe_text,
    has_secret_findings,
    mask_sensitive_payload,
    mask_sensitive_text,
    privacy_reduced_path,
    privacy_reduced_url,
    scan_sensitive_payload,
)

#: Collector bookkeeping. Real, but not evidence of what the user did.
LIFECYCLE_TYPES = frozenset(
    {
        "session.started",
        "session.stopped",
        "session.stop.requested",
        "collector.started",
        "collector.heartbeat",
        "collector.stopped",
        "collector.error",
    }
)
NARRATION_TYPES = frozenset({"session.note", "narration.transcribed"})
ACTION_TYPES = frozenset({"computer.action", "manual.observation"})

#: A pause longer than this starts a new segment.
SEGMENT_GAP_MS = 30_000
#: An unexplained context-only hop shorter than this reads as a detour.
DETOUR_MAX_MS = 15_000


def _host(url: str) -> str:
    if not url:
        return ""
    try:
        parts = urlsplit(url)
    except ValueError:
        return ""
    if not parts.hostname:
        return ""
    return f"{parts.hostname}:{parts.port}" if parts.port else parts.hostname


def _event_elapsed(event: dict[str, Any], session: dict[str, Any]) -> tuple[int, bool]:
    elapsed = event.get("elapsedMs")
    if isinstance(elapsed, (int, float)) and not isinstance(elapsed, bool):
        return max(0, int(elapsed)), False
    started = int(session.get("startedAt") or 0)
    return max(0, int(event.get("timestamp") or 0) - started), True


def _event_field(event: dict[str, Any], key: str, max_length: int) -> str:
    data = event.get("data")
    return _safe_text((data or {}).get(key), max_length) if isinstance(data, dict) else ""


def _is_unexplained_frame(frame: dict[str, Any], segment: dict[str, Any]) -> bool:
    label = _event_field(frame, "label", 160)
    return not label and not segment["narrated"] and not segment["observed"]


def _classify(segments: list[dict[str, Any]]) -> list[tuple[dict[str, Any], str, str]]:
    """A detour is a stretch the user did not explain and did not act in.

    Two shapes count. The first is leaving an app and coming back to it -- the
    message answered mid-task. The second is a short unexplained hop with
    nothing in it but context changes. Anything else stays ``work``, because
    silence alone is not proof that a step was irrelevant.
    """
    classified: list[tuple[dict[str, Any], str, str]] = []
    for index, segment in enumerate(segments):
        explained = segment["narrated"] or segment["observed"]
        acted = segment["actions"] > 0 or bool(segment["frames"])
        if explained or acted:
            classified.append(
                (
                    segment,
                    "work",
                    "Narrated or explicitly observed."
                    if explained
                    else "Contains recorded actions or explicit frames.",
                )
            )
            continue
        previous = segments[index - 1] if index > 0 else None
        following = segments[index + 1] if index + 1 < len(segments) else None
        if (
            previous is not None
            and following is not None
            and previous["app"]
            and previous["app"] == following["app"]
            and previous["app"] != segment["app"]
        ):
            classified.append(
                (
                    segment,
                    "detour",
                    f"Left {previous['app']} for {segment['app'] or 'another app'} "
                    "and returned without explaining it.",
                )
            )
            continue
        if segment["endElapsedMs"] - segment["startElapsedMs"] <= DETOUR_MAX_MS:
            classified.append(
                (segment, "detour", "Short unexplained context change with no recorded action.")
            )
            continue
        classified.append(
            (segment, "work", "Unexplained, but too long to dismiss as a detour.")
        )
    return classified


def build_session_bundle(
    session: dict[str, Any], events: Sequence[dict[str, Any]]
) -> dict[str, Any]:
    """Deterministic segmentation of a recorded session."""
    ordered = sorted(events, key=lambda event: event.get("sequence", 0))
    segments: list[dict[str, Any]] = []
    current: Optional[dict[str, Any]] = None
    previous_elapsed: Optional[int] = None
    estimated_elapsed_events = 0
    meaningful_event_count = 0
    longest_gap_ms = 0
    duration_ms = 0

    for event in ordered:
        elapsed_ms, estimated = _event_elapsed(event, session)
        if estimated:
            estimated_elapsed_events += 1
        duration_ms = max(duration_ms, elapsed_ms)
        if event.get("type") in LIFECYCLE_TYPES:
            continue
        meaningful_event_count += 1

        app = _event_field(event, "app", 160)
        url = _event_field(event, "url", 1000)
        gap_ms = 0 if previous_elapsed is None else max(0, elapsed_ms - previous_elapsed)
        longest_gap_ms = max(longest_gap_ms, gap_ms)
        previous_elapsed = elapsed_ms

        reason = ""
        carried_app = current["app"] if current else ""
        if current is None:
            reason = "First recorded activity."
        elif gap_ms >= SEGMENT_GAP_MS:
            reason = f"Resumed after a {int(gap_ms / 1000)}s pause."
        elif event.get("type") == "app.activate" and app and app != current["app"]:
            reason = f"Focus moved to {app}."
        elif url and _host(url) and _host(url) != _host(current["url"]):
            reason = f"Destination changed to {_host(url)}."

        if current is None or reason:
            current = {
                "index": len(segments),
                "app": app or carried_app,
                "url": url,
                "startSequence": event.get("sequence", 0),
                "endSequence": event.get("sequence", 0),
                "startElapsedMs": elapsed_ms,
                "endElapsedMs": elapsed_ms,
                "events": [],
                "narrated": False,
                "observed": False,
                "frames": [],
                "actions": 0,
                "reason": reason,
            }
            segments.append(current)

        current["endSequence"] = event.get("sequence", 0)
        current["endElapsedMs"] = elapsed_ms
        current["events"].append(event)
        if app and not current["app"]:
            current["app"] = app
        if url:
            current["url"] = url
        if event.get("type") in NARRATION_TYPES:
            current["narrated"] = True
        if event.get("type") == "manual.observation":
            current["observed"] = True
        if event.get("type") in ACTION_TYPES:
            current["actions"] += 1
        if event.get("type") == "frame.captured":
            current["frames"].append(event)

    classified = _classify(segments)
    silent_events = 0
    unexplained_frames = 0
    narrated_segments = 0
    detour_segments = 0
    explained_events = 0
    rendered: list[dict[str, Any]] = []

    for segment, kind, reason in classified:
        explained = segment["narrated"] or segment["observed"]
        segment_unexplained = sum(
            1 for frame in segment["frames"] if _is_unexplained_frame(frame, segment)
        )
        segment_silent = 0 if explained else len(segment["events"])
        if explained:
            narrated_segments += 1
            explained_events += len(segment["events"])
        if kind == "detour":
            detour_segments += 1
        silent_events += segment_silent
        unexplained_frames += segment_unexplained
        rendered.append(
            {
                "index": segment["index"],
                "kind": kind,
                "app": segment["app"],
                "url": segment["url"],
                "startSequence": segment["startSequence"],
                "endSequence": segment["endSequence"],
                "startElapsedMs": segment["startElapsedMs"],
                "endElapsedMs": segment["endElapsedMs"],
                "eventCount": len(segment["events"]),
                "narrated": segment["narrated"],
                "observed": segment["observed"],
                "frameCount": len(segment["frames"]),
                "unexplainedFrames": segment_unexplained,
                "silentEvents": segment_silent,
                "evidence": [
                    f"event:{item.get('sequence')}:{item.get('type')}"
                    for item in segment["events"]
                ],
                "reason": segment["reason"] or reason,
            }
        )

    stats = {
        "eventCount": len(ordered),
        "meaningfulEventCount": meaningful_event_count,
        "segmentCount": len(rendered),
        "narratedSegments": narrated_segments,
        "silentSegments": len(rendered) - narrated_segments,
        "detourSegments": detour_segments,
        "silentEvents": silent_events,
        "unexplainedFrames": unexplained_frames,
        "estimatedElapsedEvents": estimated_elapsed_events,
        "longestGapMs": longest_gap_ms,
        "durationMs": duration_ms,
        "explainedRatioMilli": (
            0
            if meaningful_event_count == 0
            else (explained_events * 1000) // meaningful_event_count
        ),
    }

    warnings: list[str] = []
    if meaningful_event_count == 0:
        warnings.append("The recording contains no events describing the workflow.")
    if silent_events > 0:
        warnings.append(
            f"{silent_events} recorded event(s) have no narration or explicit "
            "observation in their segment."
        )
    if unexplained_frames > 0:
        warnings.append(
            f"{unexplained_frames} explicit frame(s) carry no label and no narration."
        )
    if detour_segments > 0:
        warnings.append(
            f"{detour_segments} segment(s) read as detours and are excluded from the "
            "proposed steps."
        )
    if estimated_elapsed_events > 0:
        warnings.append(
            f"{estimated_elapsed_events} event(s) predate monotonic timing, so their "
            "elapsed time is estimated from wall-clock timestamps."
        )
    if longest_gap_ms >= SEGMENT_GAP_MS:
        warnings.append(
            f"The longest unrecorded pause is {int(longest_gap_ms / 1000)}s."
        )

    return {
        "schema": SHOW_AND_TELL_BUNDLE_SCHEMA,
        "sessionId": session.get("id"),
        "segments": rendered,
        "stats": stats,
        "warnings": warnings,
    }


def detour_evidence(bundle: dict[str, Any]) -> set[str]:
    """Evidence references that fall inside a detour segment."""
    references: set[str] = set()
    for segment in bundle.get("segments", []):
        if segment.get("kind") != "detour":
            continue
        references.update(segment.get("evidence", []))
    return references


#: Ordered most specific first so a URL is lifted as a URL before the number
#: rule can claim the port out of it.
VALUE_RULES: tuple[tuple[str, "re.Pattern[str]"], ...] = (
    ("url", re.compile(r"https?://[^\s\"'<>)\]]+")),
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b")),
    ("path", re.compile(r"(?:[A-Za-z]:\\|~/|/)[A-Za-z0-9._~\-/\\]{2,}")),
    (
        "date",
        re.compile(
            r"\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4}|(?:January|February|"
            r"March|April|May|June|July|August|September|October|November|December)"
            r"\s+\d{1,2},?\s+\d{4})\b"
        ),
    ),
    (
        "amount",
        re.compile(
            r"(?:[$\u00a3\u20ac]\s?\d[\d,]*(?:\.\d{1,2})?|"
            r"\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP)\b)"
        ),
    ),
    ("identifier", re.compile(r"(?:\b[A-Z][A-Z0-9]*[-_]\d{2,}\b|#\d{2,}\b)")),
    ("text", re.compile(r"\"[^\"\n]{1,80}\"")),
    ("number", re.compile(r"\b\d[\d,]*(?:\.\d+)?\b")),
)

RISK_RULES: tuple[tuple[str, "re.Pattern[str]"], ...] = (
    (
        "destructive",
        re.compile(
            r"\b(?:delete|deletes|deleted|remove|removes|removed|drop|erase|wipe|"
            r"truncate|revoke|terminate|uninstall|rm\s+-rf)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "financial",
        re.compile(
            r"\b(?:pay|pays|paid|payment|refund|refunds|invoice|charge|charges|"
            r"purchase|checkout|transfer|wire|billing|payroll|reimburse)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "publishing",
        re.compile(
            r"\b(?:publish|publishes|deploy|deploys|release|releases|merge|merges|"
            r"ship|tag\s+the\s+release|force[-\s]push)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "messaging",
        re.compile(
            r"\b(?:send|sends|sent|email|emails|message|messages|post|posts|reply|"
            r"replies|notify|broadcast|share\s+with)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "credential",
        re.compile(
            r"\b(?:password|passphrase|token|secret|credential|api\s+key|"
            r"sign[-\s]?in|log[-\s]?in|two[-\s]factor|mfa|otp)\b",
            re.IGNORECASE,
        ),
    ),
)

VALUE_LABELS = {
    "url": "Destination",
    "email": "Email address",
    "path": "File or folder path",
    "date": "Date",
    "amount": "Amount",
    "identifier": "Record identifier",
    "text": "Quoted text",
    "number": "Number",
}

MAX_VALUES = 40

_PLACEHOLDER = re.compile(r"\{\{([a-z][a-z0-9_]*)\}\}")


def _merge_findings(
    left: Iterable[dict[str, Any]], right: Iterable[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Union of two finding lists, summed per path and kind, deterministically."""
    merged: dict[tuple[str, str], dict[str, Any]] = {}
    for finding in [*left, *right]:
        key = (finding["path"], finding["kind"])
        existing = merged.get(key)
        if existing:
            existing["count"] += finding["count"]
        else:
            merged[key] = dict(finding)
    return [merged[key] for key in sorted(merged)]


class _ValueTable:
    """Literals the demonstration happened to use, lifted out of the steps."""

    def __init__(self) -> None:
        self._by_literal: dict[tuple[str, str], dict[str, Any]] = {}
        self._counters: dict[str, int] = {}

    def reference(self, literal: str, kind: str, occurrence: str) -> Optional[str]:
        key = (kind, literal)
        existing = self._by_literal.get(key)
        if existing:
            if occurrence not in existing["occurrences"]:
                existing["occurrences"].append(occurrence)
            return existing["id"]
        if len(self._by_literal) >= MAX_VALUES:
            return None
        following = self._counters.get(kind, 0) + 1
        self._counters[kind] = following
        identifier = f"{kind}_{following}"
        # The text reaching here is already masked, so an example can only
        # carry a mask marker, never the value behind it.
        if kind == "url":
            example = privacy_reduced_url(literal) or literal
        elif kind == "path":
            example = privacy_reduced_path(literal) or "<local-path>"
        else:
            example = literal
        self._by_literal[key] = {
            "id": identifier,
            "kind": kind,
            "label": f"{VALUE_LABELS[kind]} {following}",
            "example": example,
            "exampleMasked": SENSITIVE_MASK in example,
            "required": True,
            "occurrences": [occurrence],
        }
        return identifier

    def list(self) -> list[dict[str, Any]]:
        return list(self._by_literal.values())


def _template_text(
    text: str, table: _ValueTable, occurrence: str, used: set[str]
) -> str:
    output = text
    for kind, pattern in VALUE_RULES:

        def replace(match: "re.Match[str]", kind: str = kind) -> str:
            identifier = table.reference(match.group(0), kind, occurrence)
            if not identifier:
                return match.group(0)
            used.add(identifier)
            return f"{{{{{identifier}}}}}"

        output = pattern.sub(replace, output)
    return output


def risk_categories(text: str) -> list[str]:
    return sorted(category for category, pattern in RISK_RULES if pattern.search(text))


def _lower_first(value: str) -> str:
    return value[:1].lower() + value[1:]


def _plan_steps(steps: Sequence[dict[str, Any]], table: _ValueTable) -> list[dict[str, Any]]:
    planned: list[dict[str, Any]] = []
    for index, step in enumerate(steps):
        identifier = step.get("id") or f"s{index + 1}"
        used: set[str] = set()
        # Masking runs before extraction on purpose. Extracting first would
        # slice a card number into four editable "number" values and leave
        # nothing for the scanner to recognise.
        title = _template_text(
            mask_sensitive_text(_safe_text(step.get("title"), 160)),
            table,
            f"step:{identifier}:title",
            used,
        )
        detail = _template_text(
            mask_sensitive_text(_safe_text(step.get("detail"), 1200)),
            table,
            f"step:{identifier}:detail",
            used,
        )
        reduced_url = privacy_reduced_url(step.get("url"))
        url = (
            _template_text(
                mask_sensitive_text(reduced_url), table, f"step:{identifier}:url", used
            )
            if reduced_url
            else ""
        )
        categories = risk_categories(f"{step.get('title', '')} {step.get('detail', '')}")
        planned.append(
            {
                "id": identifier,
                "title": title,
                "detail": detail,
                "kind": "calculation" if step.get("kind") == "calculation" else "action",
                "tool": _safe_text(step.get("tool"), 120),
                "app": _safe_text(step.get("app"), 160),
                "url": url,
                "evidence": list(step.get("evidence", [])),
                "confidence": step.get("confidence", "medium"),
                "values": sorted(used),
                "requiresConfirmation": bool(categories),
                "riskCategories": categories,
            }
        )
    return planned


def _unique(values: Iterable[str]) -> list[str]:
    seen: dict[str, None] = {}
    for value in values:
        if value:
            seen.setdefault(value, None)
    return list(seen)


def _metadata_for(
    intent: str, steps: Sequence[dict[str, Any]], values: Sequence[dict[str, Any]]
) -> dict[str, list[str]]:
    apps = _unique(step["app"] for step in steps)[:3]
    hosts = _unique(_host(step["url"]) for step in steps)[:3]
    use_when = [
        f"The user asks to {_lower_first(intent)}",
        *[f"The work happens in {app}." for app in apps],
        *[f"The workflow targets {host}." for host in hosts],
    ]
    use_for = _unique(step["title"] for step in steps)[:6]
    risky = sorted({category for step in steps for category in step["riskCategories"]})
    do_not_use_when = [
        "Credentials, one-time codes, or sign-in material from the demonstration "
        "would be needed.",
        "Replaying recorded screen coordinates is the only way to complete the task.",
    ]
    if values:
        placeholders = ", ".join(f"{{{{{value['id']}}}}}" for value in values)
        do_not_use_when.append(
            f"The recorded inputs ({placeholders}) do not apply and no replacement "
            "is supplied."
        )
    if risky:
        do_not_use_when.append(
            f"Unattended execution is expected: {', '.join(risky)} steps stop for "
            "confirmation."
        )
    return {"useWhen": use_when, "useFor": use_for, "doNotUseWhen": do_not_use_when}


def build_skill_plan(
    analysis: dict[str, Any],
    bundle: dict[str, Any],
    previous: Optional[dict[str, Any]] = None,
    now: int = 0,
) -> dict[str, Any]:
    """The reviewable proposal between an analysis and a built artifact."""
    detours = detour_evidence(bundle)
    open_questions: list[str] = list(bundle.get("warnings", []))

    analysis_steps = list(analysis.get("steps", []))
    kept = [
        step
        for step in analysis_steps
        if not step.get("evidence")
        or not all(reference in detours for reference in step["evidence"])
    ]
    considered: Sequence[dict[str, Any]] = kept
    if not kept:
        considered = analysis_steps
        if analysis_steps:
            open_questions.append(
                "Every reconstructed step sits inside a detour segment, so none were "
                "dropped. Review the order before approving."
            )
    elif len(kept) < len(analysis_steps):
        open_questions.append(
            f"{len(analysis_steps) - len(kept)} step(s) were dropped because their "
            "only evidence was in a detour."
        )

    table = _ValueTable()
    # What the recording carried, recorded as paths and kinds before any of it
    # is masked away, so the plan can say what it removed and from where.
    input_findings = _merge_findings(
        scan_sensitive_payload(list(considered), "$.steps"),
        scan_sensitive_payload(
            {"title": analysis.get("title"), "intent": analysis.get("intent")}, "$"
        ),
    )
    steps = _plan_steps(considered, table)
    values = table.list()
    intent = (
        mask_sensitive_text(_safe_text(analysis.get("intent"), 1200))
        or "Repeat the demonstrated workflow"
    )
    metadata = _metadata_for(intent, steps, values)

    low_confidence = sum(1 for step in steps if step["confidence"] == "low")
    if low_confidence > 0:
        open_questions.append(
            f"{low_confidence} step(s) are low confidence and were reconstructed from "
            "weak evidence."
        )
    single_use = [value for value in values if len(value["occurrences"]) == 1]
    if single_use:
        open_questions.append(
            f"{len(single_use)} value(s) were seen once in one demonstration; confirm "
            "each is an input and not a constant."
        )
    confirmations = sum(1 for step in steps if step["requiresConfirmation"])
    if confirmations > 0:
        open_questions.append(
            f"{confirmations} step(s) have side effects and will ask before running."
        )

    draft = {
        "schema": SHOW_AND_TELL_PLAN_SCHEMA,
        "sessionId": analysis.get("sessionId"),
        "analysisRevision": analysis.get("revision", 1),
        "revision": ((previous or {}).get("revision") or 0) + 1,
        "title": mask_sensitive_text(_safe_text(analysis.get("title"), 160))
        or "Recorded workflow",
        "intent": intent,
        **metadata,
        "steps": steps,
        "values": values,
        "evidenceStats": bundle.get("stats", {}),
        "openQuestions": open_questions,
    }
    masked, scanned_findings = mask_sensitive_payload(
        {
            "title": draft["title"],
            "intent": draft["intent"],
            "useWhen": draft["useWhen"],
            "useFor": draft["useFor"],
            "doNotUseWhen": draft["doNotUseWhen"],
            "steps": draft["steps"],
            "values": draft["values"],
            "openQuestions": draft["openQuestions"],
        }
    )
    findings = _merge_findings(input_findings, scanned_findings)
    return {
        **draft,
        **masked,
        "privacy": {
            "findings": findings,
            "masked": bool(findings),
            # OpenRappter never sends raw frames to a model. This records that.
            "rawFramesShared": False,
        },
        "feedbackLog": list((previous or {}).get("feedbackLog") or []),
        "approved": False,
        "approvedAt": None,
        "createdAt": (previous or {}).get("createdAt") or now,
        "updatedAt": now,
    }


def _parsed_array(raw: Any, label: str) -> list[Any]:
    if not isinstance(raw, str) or not raw.strip():
        return []
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise ValueError(f"{label} must be a JSON array.")
    return parsed


def revise_plan(
    current: dict[str, Any],
    title: Any = None,
    intent: Any = None,
    values_json: Any = None,
    steps_json: Any = None,
    feedback: Any = None,
    approve: bool = False,
    now: int = 0,
) -> dict[str, Any]:
    """Apply reviewer edits.

    Editing any generated or trigger-bearing text resets approval: approving a
    plan approves the text that was read, not a later version of it.
    """
    steps = current["steps"]
    raw_steps = _parsed_array(steps_json, "steps_json")
    if raw_steps:
        if len(raw_steps) > 60:
            raise ValueError("steps_json may not contain more than 60 steps.")
        edited_steps = []
        for index, entry in enumerate(raw_steps):
            if not isinstance(entry, dict):
                raise ValueError("Every edited step must be a JSON object.")
            step_title = mask_sensitive_text(_safe_text(entry.get("title"), 160))
            step_detail = mask_sensitive_text(_safe_text(entry.get("detail"), 1200))
            if not step_title or not step_detail:
                raise ValueError("Every edited step requires a title and a detail.")
            previous_step = current["steps"][index] if index < len(current["steps"]) else {}
            categories = risk_categories(f"{step_title} {step_detail}")
            edited_steps.append(
                {
                    "id": _safe_text(entry.get("id"), 32)
                    or previous_step.get("id")
                    or f"s{index + 1}",
                    "title": step_title,
                    "detail": step_detail,
                    "kind": "calculation"
                    if entry.get("kind") == "calculation"
                    else "action",
                    "tool": _safe_text(entry.get("tool"), 120)
                    or previous_step.get("tool", ""),
                    "app": _safe_text(entry.get("app"), 160)
                    or previous_step.get("app", ""),
                    "url": mask_sensitive_text(privacy_reduced_url(entry.get("url")))
                    or previous_step.get("url", ""),
                    "evidence": list(previous_step.get("evidence", [])),
                    "confidence": previous_step.get("confidence", "medium"),
                    "values": sorted(
                        {
                            match.group(1)
                            for match in _PLACEHOLDER.finditer(
                                f"{step_title} {step_detail}"
                            )
                        }
                    ),
                    "requiresConfirmation": bool(categories),
                    "riskCategories": categories,
                }
            )
        steps = edited_steps

    values = current["values"]
    raw_values = _parsed_array(values_json, "values_json")
    if raw_values:
        known = {value["id"]: value for value in current["values"]}
        edited_values = []
        for entry in raw_values:
            if not isinstance(entry, dict):
                raise ValueError("Every edited value must be a JSON object.")
            identifier = _safe_text(entry.get("id"), 32)
            existing = known.get(identifier)
            if not existing:
                raise ValueError(
                    f"Unknown Show-and-Tell value id: {identifier or '(missing)'}"
                )
            requested = _safe_text(entry.get("example"), 240) or existing["example"]
            example = mask_sensitive_text(requested)
            edited_values.append(
                {
                    **existing,
                    "label": _safe_text(entry.get("label"), 120) or existing["label"],
                    "example": example,
                    "exampleMasked": SENSITIVE_MASK in example,
                    "required": False
                    if entry.get("required") is False
                    else existing["required"],
                }
            )
        values = edited_values

    feedback_text = mask_sensitive_text(_safe_text(feedback, 2000))
    edited = bool(
        raw_steps
        or raw_values
        or (isinstance(title, str) and title.strip())
        or (isinstance(intent, str) and intent.strip())
    )
    if approve and edited:
        # Approving text nobody has re-read is not approval. Edits land first,
        # the reviewer reads the revised plan, then approves it in its own turn.
        raise ValueError(
            "Show-and-Tell edits and approval must be separate turns. Apply the "
            "edits, re-read the plan, then approve it."
        )

    draft = {
        **current,
        "title": mask_sensitive_text(_safe_text(title, 160)) or current["title"],
        "intent": mask_sensitive_text(_safe_text(intent, 1200)) or current["intent"],
        "steps": steps,
        "values": values,
    }
    # What the reviewer's own edit carried, before masking removed it, stays on
    # the record next to what the recording carried.
    edit_findings = scan_sensitive_payload(
        {
            "steps": raw_steps,
            "values": raw_values,
            "title": title,
            "intent": intent,
        },
        "$.edit",
    )
    masked, scanned_findings = mask_sensitive_payload(
        {
            "title": draft["title"],
            "intent": draft["intent"],
            "useWhen": draft["useWhen"],
            "useFor": draft["useFor"],
            "doNotUseWhen": draft["doNotUseWhen"],
            "steps": draft["steps"],
            "values": draft["values"],
            "openQuestions": draft["openQuestions"],
        }
    )
    findings = _merge_findings(edit_findings, scanned_findings)
    return {
        **draft,
        **masked,
        "revision": current["revision"] + 1,
        "privacy": {
            "findings": findings,
            "masked": bool(findings),
            "rawFramesShared": False,
        },
        "feedbackLog": (
            [*current["feedbackLog"], {"at": now, "feedback": feedback_text}]
            if feedback_text
            else list(current["feedbackLog"])
        ),
        "approved": approve is True,
        "approvedAt": now if approve is True else None,
        "updatedAt": now,
    }


def plan_secret_findings(plan: dict[str, Any]) -> list[dict[str, Any]]:
    """Secret-class findings that must block a build outright."""
    return [
        finding
        for finding in plan.get("privacy", {}).get("findings", [])
        if has_secret_findings([finding])
    ]


__all__ = [
    "ACTION_TYPES",
    "DETOUR_MAX_MS",
    "LIFECYCLE_TYPES",
    "MAX_VALUES",
    "NARRATION_TYPES",
    "RISK_RULES",
    "SEGMENT_GAP_MS",
    "VALUE_LABELS",
    "VALUE_RULES",
    "build_session_bundle",
    "build_skill_plan",
    "detour_evidence",
    "plan_secret_findings",
    "revise_plan",
    "risk_categories",
]
