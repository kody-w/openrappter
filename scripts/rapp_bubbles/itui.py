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
import unicodedata

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
    "system": (("Health", "health"), ("Recent jobs", "list")),
    "check": (("Details", "status {job}"), ("Recent jobs", "list")),
}
# Heartbeats by time since the job started, then every REPEAT seconds, up to MAX_UPDATES.
HEARTBEATS = (120, 300, 600, 1200, 2100, 3600)
REPEAT = 1800
MIN_GAP = 90
MAX_UPDATES = 10
# Milestones may not spend the last few updates, so heartbeats never run dry.
RESERVED_HEARTBEATS = 3
STALL_SECONDS = 600
MENU_TTL = 3600
HISTORY = 20
HEX_REF = re.compile(r"#?([0-9a-f]{4,32})", re.IGNORECASE)


# Letters that show as nothing: a line's scan skips them like format characters.
FILLERS = frozenset("\u115f\u1160\u3164\uffa0")
# Controls that reorder a line as shown, so its first character stored need not be the first seen.
BIDI = frozenset("\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")


def _numeral(ch: str) -> str:
    """A character read for the number it shows: a numeral sign stays a sign ("№2" is "#2",
    not the word "No2" NFKC makes of it), and a number drawn as letters (Roman Ⅱ) is its digit."""
    if ch == "\u2116":
        return "#"
    value = unicodedata.numeric(ch, 0) if unicodedata.category(ch) == "Nl" else 0
    return str(int(value)) if value in range(1, 10) else ch


def _shown(line: str) -> tuple[str, bool]:
    """A line as the phone draws its characters (NFKC, without format characters or fillers),
    and whether it may be drawn in another order than stored (a bidi control or a
    right-to-left letter on it)."""
    line = unicodedata.normalize("NFKC", "".join(map(_numeral, line)))
    clean = "".join(ch for ch in line if unicodedata.category(ch) != "Cf" and ch not in FILLERS)
    return clean, any(ch in BIDI for ch in line) or any(unicodedata.bidirectional(ch) in ("R", "AL") for ch in clean)


def _digit(ch: str) -> bool:
    return unicodedata.digit(ch, 0) in range(1, 10)


def _leads(word: str) -> bool:
    """Whether a word shows a number 1-9 first, zero-padded or not ("2", "02", "10", "1st")."""
    for ch in word:
        value = unicodedata.digit(ch, None)
        if value != 0:
            return value in range(1, 10)
    return False


def draws_numbers(text: str) -> bool:
    """Whether text draws numbered choices in any form a phone shows as one: a line whose
    first word, after any marks (brackets, bullets, markdown), starts with a digit 1-9 (after
    any leading zeros: "01."). Fullwidth, keycap, circled, Roman, and other-script digits
    count (NFKC, then the digit value);
    format characters and invisible fillers are skipped, and a line that may be drawn in
    another order (bidi controls, right-to-left text) counts when any digit 1-9 is on it.
    Deny by default: a line that merely starts with a count counts too."""
    for raw in text.splitlines():
        line, reordered = _shown(raw)
        if reordered:
            if any(_digit(ch) for ch in line):
                return True
            continue
        found = re.match(r"[\W_]*(\w+)", line.strip())
        if found and _leads(found.group(1)):
            return True
    return False


def names_numbers(text: str) -> bool:
    """Whether text shows a number 1-9 that starts a word of its own anywhere ("Reply 1 or
    2", "2️⃣", "5/8", "1st", "_2_", "02", "№2", "Ⅱ"), not only at the start of a line: how
    another author's words are read, deny by default, since any of them may be what the
    owner's number answers. A digit inside a word or a longer number ("R8", "42", "v10")
    does not count."""
    for raw in text.splitlines():
        line, reordered = _shown(raw)
        if reordered and any(_digit(ch) for ch in line):
            return True
        index = 0
        while index < len(line):
            if unicodedata.digit(line[index], None) is None:
                index += 1
                continue
            end = index
            while end < len(line) and unicodedata.digit(line[end], None) is not None:
                end += 1
            run = [unicodedata.digit(ch) for ch in line[index:end]]
            while len(run) > 1 and run[0] == 0:
                run.pop(0)  # zero-padded: "02" shows a 2
            if not line[index - 1:index].isalnum() and len(run) == 1 and run[0] in range(1, 10):
                return True
            index = end
    return False


def short(job_id: str | None) -> str:
    return (job_id or "")[-4:] or "·"


def clip(text: str, width: int = WIDTH) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= width else text[:width - 1].rstrip() + "…"


def label(prompt: str) -> str:
    return clip(prompt, 24)


def span(seconds: float, *, floor: bool = False) -> str:
    """A short duration, rounded up to the minute (down with ``floor``, for a lower bound)."""
    seconds = max(0.0, float(seconds))
    if seconds < 60:
        return "<1m"
    minutes = math.floor(seconds / 60) if floor else math.ceil(seconds / 60)
    if minutes < 60:
        return f"{minutes}m"
    hours, rest = divmod(minutes, 60)
    return f"{hours}h{rest:02d}m"


def bar(fraction: float, *, done: bool = False) -> str:
    # Only a finished task earns the last cell; a running bar never looks complete.
    filled = max(0, min(CELLS if done else CELLS - 1, round(fraction * CELLS)))
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


def estimate(elapsed: float, progress: dict | None, history: list[float], *,
             idle: float | None = None, active: bool | None = None) -> dict:
    """An honest ETA: from worker markers, else past runs of this profile, else unknown.

    Never claims completion: the bar stays below full until the job is terminal. A worker
    that went inactive, or produced no output for a long while, is reported as stalled
    rather than given a confident countdown.
    """
    typical_runs = sorted(value for value in history if value > 0)
    typical = statistics.median(typical_runs) if len(typical_runs) >= 3 else 0
    if idle is not None and (active is False or idle > max(STALL_SECONDS, 0.5 * typical)):
        return {
            "basis": "stall", "fraction": None, "remaining": None,
            "status": f"stalled · {span(idle)}",
            "detail": "worker inactive" if active is False else f"no output for {span(idle)}",
        }
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


def quarter(progress: dict | None) -> int:
    """How many quarters of a worker's declared steps are done; only a new quarter is news."""
    return int(4 * progress["done"] / progress["total"]) if progress and progress.get("total") else 0


def due(stream: dict, elapsed: float, now: float, *, milestone: bool = False) -> bool:
    """Whether an automatic update should go out now.

    Heartbeats are scheduled by time slot, not by how many were sent, so a gap (an outage,
    a pause) yields one catch-up card instead of a burst, and milestones never shift the
    schedule or spend the last RESERVED_HEARTBEATS updates.
    """
    sent = stream.get("sent", 0)
    if stream.get("quiet") or sent >= MAX_UPDATES or now - stream.get("last_at", 0) < MIN_GAP:
        return False
    if elapsed >= threshold(stream.get("slot", 0)):
        return True
    return milestone and sent < MAX_UPDATES - RESERVED_HEARTBEATS


def threshold(slot: int) -> float:
    if slot < len(HEARTBEATS):
        return HEARTBEATS[slot]
    return HEARTBEATS[-1] + REPEAT * (slot - len(HEARTBEATS) + 1)


def next_slot(elapsed: float) -> int:
    """The first heartbeat slot still in the future: missed slots collapse into one."""
    slot = 0
    while threshold(slot) <= elapsed:
        slot += 1
    return slot


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
