"""iTUI: rapp-bubbles messages as plain iMessage text laid out like a terminal UI.

iOS Messages uses a proportional font in a narrow bubble, and lock-screen previews show
only the first line, so a card is left-aligned (no right borders), keeps its structural
lines within WIDTH characters, and puts the envelope plus live status on line one:

    [RAPP 9c1e] ● Running ~4m
    ▰▰▰▰▱▱▱▱▱▱ est · 6m/~10m
    ──────────────
    summarize report.txt
    ──────────────
    [1] Details
    [2] Stop
    [3] Quiet
    next ~5m · ref 3fa9c1

Cards end with numbered options. A bare digit answers the card directly above it and
RAPP <n> answers the latest open card; an approval card keeps 1 and 2. Options only map to
existing RAPP commands (plus quiet), so a number can never grant anything new. Everything
here is pure: no clock, journal, or I/O.
"""

from __future__ import annotations

import math
import re
import statistics

WIDTH = 28
RULE = "─" * 14
CELLS = 10
# Text-presentation glyphs only (no emoji variants), so light and dark mode match.
GLYPH = {
    "approval": "?", "queued": "○", "running": "●", "cancelling": "■", "succeeded": "✓",
    "completed": "✓", "failed": "✗", "interrupted": "✗", "cancelled": "■", "canceled": "■",
    "expired": "○", "attention": "!", "error": "!", "info": "·",
}
MENUS = {
    "approval": (("Approve", "1"), ("Cancel", "2")),
    "running": (("Details", "status {job}"), ("Stop", "stop {job}"), ("Quiet", "quiet {job}")),
    "quiet": (("Details", "status {job}"), ("Stop", "stop {job}")),
    "cancelling": (("Details", "status {job}"),),
    "final": (("Full result", "result {job}"), ("Recent jobs", "list")),
    "attention": (("Retry failed", "retry {job}"), ("Details", "status {job}")),
    "notice": (("Recent jobs", "list"), ("Help", "help")),
}
# Heartbeats by time since the job started, then every REPEAT seconds, up to MAX_UPDATES.
HEARTBEATS = (120, 300, 600, 1200, 2100, 3600)
REPEAT = 1800
MIN_GAP = 90
MAX_UPDATES = 10
MENU_TTL = 3600
HISTORY = 20
HEX_REF = re.compile(r"#?([0-9a-f]{4,32})", re.IGNORECASE)


def short(job_id: str | None) -> str:
    return (job_id or "")[-4:] or "·"


def clip(text: str, width: int = WIDTH) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= width else text[:width - 1].rstrip() + "…"


def label(prompt: str) -> str:
    return clip(prompt, 24)


def span(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    if seconds < 60:
        return "<1m"
    minutes = math.ceil(seconds / 60)
    if minutes < 60:
        return f"{minutes}m"
    hours, rest = divmod(minutes, 60)
    return f"{hours}h{rest:02d}m"


def bar(fraction: float) -> str:
    filled = max(0, min(CELLS, round(fraction * CELLS)))
    return "▰" * filled + "▱" * (CELLS - filled)


def menu(kind: str, job_id: str | None = None) -> tuple[list[str], list[str]]:
    """Option lines and the RAPP command bodies they stand for, in order."""
    options = MENUS[kind]
    lines = [f"[{index}] {name}" for index, (name, _) in enumerate(options, 1)]
    return lines, [command.format(job=job_id or "").strip() for _, command in options]


def card(header: str, top=(), body=(), options=(), footer: str | None = None) -> str:
    lines = [header, *top]
    if body:
        lines += [RULE, *body]
    if options:
        lines += [RULE, *options]
    if footer:
        lines.append(footer)
    return "\n".join(lines)


def header(tag: str, glyph: str, status: str) -> str:
    start = f"[RAPP {tag}] {glyph} "
    return start + clip(status, max(8, WIDTH - len(start)))


def marker(events) -> dict | None:
    """The latest well-formed worker progress marker ({type: progress, done, total})."""
    found = None
    for event in events if isinstance(events, list) else []:
        if not isinstance(event, dict) or event.get("type") != "progress":
            continue
        done, total = event.get("done"), event.get("total")
        if type(done) is int and type(total) is int and 0 <= done <= total <= 100000 and total > 0:
            found = {"done": done, "total": total, "label": clip(event.get("label") or "", 24)}
    return found


def estimate(elapsed: float, progress: dict | None, history: list[float]) -> dict:
    """An honest ETA: from worker markers, else past runs of this profile, else unknown.

    Never claims completion: the bar stays below full until the job is terminal.
    """
    if progress and progress["done"] > 0 and elapsed >= 30:
        fraction = progress["done"] / progress["total"]
        remaining = elapsed * (1 - fraction) / fraction
        return {
            "basis": "worker", "fraction": min(fraction, 0.95), "remaining": remaining,
            "status": f"~{span(remaining)} left" if remaining >= 60 else "almost done",
            "detail": f"step {progress['done']}/{progress['total']}"
            + (f" · {progress['label']}" if progress.get("label") else ""),
        }
    samples = sorted(value for value in history if value > 0)
    if len(samples) >= 3:
        typical = statistics.median(samples)
        slow = samples[-1] if len(samples) < 5 else statistics.quantiles(samples, n=10)[8]
        if elapsed > max(slow, typical * 1.2):
            return {
                "basis": "history", "fraction": 0.95, "remaining": None,
                "status": f"long · {span(elapsed)}",
                "detail": f"usual ~{span(typical)} ({len(samples)} runs)",
            }
        remaining = max(typical - elapsed, 60)
        return {
            "basis": "history", "fraction": min(elapsed / typical, 0.9), "remaining": remaining,
            "status": f"~{span(remaining)} left",
            "detail": f"{span(elapsed)} of ~{span(typical)} ({len(samples)} runs)",
        }
    return {
        "basis": "none", "fraction": None, "remaining": None,
        "status": f"{span(elapsed)} in",
        "detail": "no ETA yet (learning)",
    }


def due(stream: dict, elapsed: float, now: float, *, milestone: bool = False) -> bool:
    """Whether an automatic update should go out now (heartbeats back off, then repeat)."""
    sent = stream.get("sent", 0)
    if stream.get("quiet") or sent >= MAX_UPDATES or now - stream.get("last_at", 0) < MIN_GAP:
        return False
    if milestone:
        return True
    return elapsed >= next_heartbeat(sent)


def next_heartbeat(sent: int) -> float:
    if sent < len(HEARTBEATS):
        return HEARTBEATS[sent]
    return HEARTBEATS[-1] + REPEAT * (sent - len(HEARTBEATS) + 1)


def remember(history: list, duration: float) -> list:
    return ([*history, round(duration, 1)])[-HISTORY:]


def parse(text: str) -> dict:
    """Machine view of a card, for agents and tests: tag, glyph, status, and options."""
    lines = text.splitlines()
    head = re.match(r"^\[RAPP (\S+)\] (\S) (.*)$", lines[0] if lines else "")
    options = []
    for line in lines:
        choice = re.fullmatch(r"\[(\d)\] (.+)", line)
        if choice:
            options.append({"n": int(choice.group(1)), "label": choice.group(2)})
    return {
        "tag": head.group(1) if head else None, "glyph": head.group(2) if head else None,
        "status": head.group(3) if head else None, "options": options,
    }
