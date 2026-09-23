"""A bounded tick called by the existing watcher, not a second responder daemon."""

from __future__ import annotations

import hashlib
import shutil
import json
import sqlite3
import math
import mimetypes
import os
import re
import time
from datetime import datetime
from pathlib import Path

from . import feed, itui
from .clients import RuntimeClient, NativeClient, NotSubmitted, SubmissionUnknown
from .config import Config, PortalError, normalized, roster_digest
from .files import copy_reference, filename, regular_file, room_for
from .outbox import Outbox, token
from .source import SQLiteSource
from .state import JournalWriteError, Store, strict


ADDRESS = re.compile(r"^\s*rapp(?:\s*:\s*|\s+|$)", re.IGNORECASE)
DISK_ENTER = (("critical", 2, 2), ("low", 10, 5))  # below either GiB or percent enters the level
DISK_MARGIN = (2, 1)  # a level is left only with this much headroom above its entry line
DISK_HOLD = 600
DISK_REALERT = 6 * 3600
DISK_RANK = {"ok": 0, "low": 1, "critical": 2}
DISK_FLAPS = 6  # the improvement hold doubles per re-worsening within DISK_REALERT, up to 6 h
RACE_SECONDS = 3
POLL_BACKOFF_MAX = 600  # a failing job poll backs off from 5 s, doubling, to at most this
RESULT_ATTEMPTS = 2  # a finished job whose result cannot be rendered gets a text-only final then
LOST_ATTEMPTS = 5  # not_found polls (about 5 minutes of backoff) before a lost job is no longer followed
INTERNAL_ATTEMPTS = 3  # internal errors before a job is no longer followed
# Known failures keep their handling and transient ones (a locked chat.db) fail the tick to be
# retried; only unexpected errors are ever set aside.
UNCONTAINED = (JournalWriteError, PortalError, sqlite3.Error)
DEGRADED_AFTER = 60  # a stage failing this long, tick after tick, gets one card
FLAKY_RUNS = 3  # so do this many separate runs of failures, each within STAGE_HOLD of the last
STAGE_HOLD = 900  # and counts as back only after this long without failing, so failing now and then is one incident
STAGE_LAST_EVERY = 300  # while it fails, the time of its latest failure is saved at most this often
FAILURE_MERGE = 600  # failed-tick records gather this long before a good tick saves them
TICKS_RETOLD = (6 * 3600, 24 * 3600)  # a ticks-failing incident is told again after these waits
LAPSE_SHADOW = 120  # an approval that lapsed this recently may still be what an unswiped Stop meant
COPY_WINDOW = 30  # an update closing sooner than this is not shown again to be answered
STAGES = {  # stage: (lock-screen label, what the owner loses while it fails)
    "disk": ("Disk", "disk checks fail, so new tasks are refused"),
    "recover": ("Recovery", "restart recovery is paused"),
    "receipts": ("Receipts", "delivery checks are paused"),
    "feed": ("Feed", "agent updates may not open"),
    "poll": ("Updates", "task updates and results are paused"),
    "send": ("Sending", "cards may not go out"),
    "outage": ("Outage", "outage reports are paused"),
    "attention": ("Alerts", "delivery alerts are paused"),
    "compact": ("Cleanup", "journal cleanup is paused"),
}
APPLE_EPOCH = 978307200
RACE_NOTE = "Your reply landed as this card arrived, so nothing ran."
UNCONFIRMED_NOTE = "Not confirmed on your phone, so nothing ran."
FOREIGN_NOTE = "Another message came after the card, so nothing ran. Swipe-reply your number on this one."
THREAD_NOTE = "Someone else replied under the card, so nothing ran. Swipe-reply your number on this one."
PIECE_NOTE = "That bubble is not the one with the options, so nothing ran. Swipe-reply your number on this one."
# Why a pick was refused, by the read rule's note: one name each for cards and the tick alike.
READ_REASONS = {UNCONFIRMED_NOTE: "unconfirmed", FOREIGN_NOTE: "foreign", THREAD_NOTE: "foreign",
                RACE_NOTE: "race"}
JOB_ID = re.compile(r"[0-9]{8}-[0-9]{6}-[0-9a-f]{32}")
TERMINAL = {"succeeded", "completed", "failed", "cancelled", "canceled", "interrupted", "expired"}
OUTPUT_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp",
    ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".m4a", ".mp3", ".wav", ".aiff", ".caf",
    ".aac", ".flac", ".ogg", ".opus", ".txt", ".md", ".csv", ".json", ".pdf", ".rtf",
    ".docx", ".xlsx", ".pptx", ".zip",
}
HELP = (
    "RAPP <task> — prepare a task; it runs only after your approval.\n"
    "RAPP file report.txt | <task> — explicitly request one output file. "
    "Ordinary tasks require no output files. A filename does not grant new permissions.\n"
    "RAPP attach — arm a bounded file-only upload window (10 minutes by default). "
    "Then send photos, video, audio, or files and request a task. "
    "A message with RAPP + files also works. Files are never executed by receiving them.\n"
    "This route transfers media files; it does not automatically transcribe voice, analyze video, "
    "or provide a continuous livestream. Content processing needs an approved task and suitable configured tools.\n"
    "RAPP status / list / result / stop / resume [job-id]\n"
    "RAPP retry <job-id> — retry only confirmed failed output parts.\n"
    "RAPP resend <part-id> — deliberately resend one uncertain part after checking your phone.\n"
    "RAPP clear files — discard the pending input selection.\n"
    "Loop updates: a bare reply right after an update answers it (numbers pick its options). "
    "RAPP reply <text> answers the latest open update even after your other messages.\n"
    "Cards end with [n] options: reply the digit right under a card (or swipe-reply to it), "
    "or RAPP <n> for the newest card after your other messages (after another AI's message, "
    "the card comes again: swipe-reply your number on it). On a live approval card, 1 approves "
    "and 2 cancels that task only; RAPP approve <job-id> always works. "
    "Running tasks keep sending ETA updates.\n"
    "RAPP quiet [job] stops a task's automatic updates; its result still comes.\n"
    "Short refs work as job ids: the 4 characters in [RAPP 9c1e].\n"
    "Other conversation belongs to other AIs. Unprefixed wake/restart/shutdown remains Claude's."
)


class AwaitingInputs(Exception):
    pass


def addressed(text: str) -> bool:
    return bool(ADDRESS.match(text))


def disk_level(free_gib: float, percent: float, margin: tuple = (0, 0)) -> str:
    for level, gib, pct in DISK_ENTER:
        if free_gib < gib + margin[0] or percent < pct + margin[1]:
            return level
    return "ok"


def timestamp(value) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0


def response_job(response: dict) -> tuple[str, str, dict]:
    job = response.get("job")
    if not isinstance(job, dict):
        raise PortalError("runtime_protocol", "The local job adapter omitted its job envelope.")
    identity = job.get("job_id")
    state = job.get("status")
    if not isinstance(identity, str) or not JOB_ID.fullmatch(identity):
        raise PortalError("runtime_protocol", "The local job adapter returned an invalid job id.")
    if not isinstance(state, str) or not state:
        raise PortalError("runtime_protocol", "The local job adapter omitted the worker state.")
    return identity, state, job


def output_text(response: dict, key: str) -> str:
    value = response.get(key, "")
    if isinstance(value, dict):
        value = value.get("text", "")
    return value if isinstance(value, str) else ""


def recorded_number(value, fallback: float) -> float:
    """A time or count from a record another process wrote: a finite number, else the fallback."""
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return fallback
    return number if math.isfinite(number) else fallback


def read_tick_failure(state_dir: Path) -> dict | None:
    """The cause the CLI recorded for ticks that failed as a whole (they save nothing), with
    every field made safe to use: a damaged record must never be what stops each tick."""
    path = state_dir / "tick-failure.json"
    try:
        modified = path.stat().st_mtime
    except FileNotFoundError:
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    raw = raw if isinstance(raw, dict) else {}
    recorded = recorded_number(raw.get("last"), 0)
    last = max(recorded, modified)
    errno = raw.get("errno")
    return {
        "code": raw["code"] if isinstance(raw.get("code"), str) and raw["code"] else "unknown",
        "kind": raw["kind"] if isinstance(raw.get("kind"), str) else None,
        "errno": errno if type(errno) is int else None,
        "first": min(recorded_number(raw.get("first"), last), last), "last": last,
        "count": max(1, int(recorded_number(raw.get("count"), 1))),
        # A later failure that could not be written (a full disk) only moved the file's time.
        "more": raw.get("more") is True or modified > recorded + 1,
    }


class Portal:
    def __init__(self, config: Config, *, source=None, runtime=None, native=None, clock=time.time):
        self.config = config
        self.source = source
        self.runtime = runtime or RuntimeClient(config)
        self.native = native or NativeClient(config)
        self.clock = clock
        self.store: Store
        self.outbox: Outbox
        self._quarantined: list[dict] = []
        self._set_aside: set[str] = set()
        self._failing: set[str] = set()
        self._runtime_called = False

    def authorize(self, event: dict) -> dict | None:
        if (
            normalized(str(event.get("service") or "")) != "imessage"
            or type(event.get("is_from_me")) is not bool
            or type(event.get("is_group")) is not bool
            or type(event.get("chat_id")) is not int or event["chat_id"] < 1
            or event.get("chat_style", 43 if event["is_group"] else 45) not in (43, 45)
        ):
            return None
        chat = event.get("chat_guid")
        if (
            not isinstance(chat, str)
            or (";+;" in chat) != event["is_group"]
            or event.get("chat_style", 43 if event["is_group"] else 45) != (43 if event["is_group"] else 45)
        ):
            return None
        sender = normalized(str(event.get("sender") or ""))
        participants = event.get("participants")
        if not isinstance(participants, list) or any(not isinstance(p, str) for p in participants):
            return None
        roster = {normalized(p) for p in participants}
        for route in self.config.routes:
            if route.chat != chat:
                continue
            candidate = sender
            if not candidate and event["is_from_me"] and route.allow_from_me:
                if not event["is_group"] and roster == {route.sender}:
                    candidate = route.sender
            if candidate != route.sender:
                continue
            if event["is_group"] and (not route.allow_group or candidate not in roster):
                continue
            if event["is_from_me"] and (
                not route.allow_from_me or event["is_group"] or roster != {route.sender}
            ):
                continue
            return {"sender": candidate, "chat": route.chat}
        return None

    @staticmethod
    def _conversation_key(actor: dict, target: dict) -> str:
        return token(actor["sender"] + "\0" + actor["chat"] + "\0" + target.get("roster_hash", ""))

    def _conversation(self, actor: dict, target: dict) -> dict:
        key = self._conversation_key(actor, target)
        conversation = self.store.data["conversations"].setdefault(key, {
            "actor": dict(actor), "target": dict(target), "uploads": [],
            "capture_until": 0, "capture_generation": 0, "approvals": {}, "latest_job": None,
        })
        conversation.setdefault("capture_generation", 0)
        if "uploads" not in conversation:
            legacy_paths = {item["path"] for item in conversation.get("files", [])}
            conversation["uploads"] = []
            for identity, upload in self.store.data["inbox"].items():
                if (
                    upload["actor"] != actor or not upload.get("capture")
                    or upload["target"].get("roster_hash") != target.get("roster_hash")
                ):
                    continue
                if upload["state"] in ("receiving", "ready") or any(
                    item["path"] in legacy_paths for item in upload["staged"].values()
                ):
                    conversation["uploads"].append(identity)
                    upload.setdefault(
                        "upload_expires",
                        conversation.get("files_expire") or upload["first_seen"] + self.config.attachment_window_seconds,
                    )
            conversation.pop("files", None)
            conversation.pop("files_expire", None)
        return conversation

    def _input_snapshot(self, conversation: dict, event: dict) -> list[str]:
        inbox = self.store.data["inbox"]
        return sorted({
            identity for identity in conversation["uploads"]
            if identity in inbox and inbox[identity]["event"]["id"] < event["id"]
            and inbox[identity]["state"] not in ("failed", "cancelled", "ignored")
            and not inbox[identity].get("selected_by")
            and inbox[identity].get("upload_expires", 0) >= self.clock()
        }, key=lambda identity: (inbox[identity]["event"]["id"], identity))

    @staticmethod
    def _task_command(body: str) -> bool:
        words = body.split(maxsplit=1)
        command = words[0].casefold() if words else "help"
        if re.fullmatch(r"[1-9]", command):
            return len(words) > 1
        if command == "health":
            return len(words) > 1
        if command == "quiet":
            # "RAPP quiet the fans" is still a task; only "quiet" or "quiet <job ref>" is a command.
            return len(words) > 1 and not (
                itui.HEX_REF.fullmatch(words[1].strip()) or JOB_ID.fullmatch(words[1].strip())
            )
        return body.casefold() != "clear files" and command not in {
            "help", "?", "attach", "1", "2", "approve", "files", "list", "resume", "recover", "health",
            "status", "result", "stop", "cancel", "retry", "resend",
        }

    def _freeze_inputs(self, identity: str, record: dict, conversation: dict, snapshot: list[str]) -> None:
        record["selected_inputs"] = list(snapshot)
        for selected in snapshot:
            upload = self.store.data["inbox"].get(selected)
            if not upload or upload.get("selected_by") not in (None, identity):
                record["input_selection_error"] = "input_already_selected"
                continue
            upload["selected_by"] = identity
        conversation["uploads"] = [selected for selected in conversation["uploads"] if selected not in snapshot]

    def _release_inputs(self, identity: str, record: dict) -> None:
        if record.get("job_id"):
            return
        conversation = self._conversation(record["actor"], record["target"])
        for selected in record.get("selected_inputs", []):
            upload = self.store.data["inbox"].get(selected)
            if not upload or upload.get("selected_by") != identity:
                continue
            upload.pop("selected_by")
            if (
                upload["state"] not in ("failed", "cancelled", "ignored")
                and upload.get("upload_expires", 0) >= self.clock()
                and selected not in conversation["uploads"]
            ):
                conversation["uploads"].append(selected)

    def _notice(
        self, key: str, actor: dict, target: dict, text: str, job_id=None, *,
        title: str | None = None, glyph: str | None = None, menu: str | None = "notice",
    ) -> None:
        commands = None
        if not text.startswith("[RAPP "):
            ref = token(f"{key}:0")[:6]
            lines = text.splitlines() or [""]
            head = itui.header(itui.short(job_id) if job_id else ref, glyph or itui.GLYPH["info"], title or lines[0])
            if not title and itui.clip(lines[0]) in head:
                lines = lines[1:]
            options, commands = itui.menu(menu, job_id) if menu else ([], None)
            text = itui.card(head, body=lines, options=options, footer=f"ref {ref}" if job_id else None)
        self.outbox.enqueue(key, actor, target, text, job_id=job_id, menu=commands, menu_kind=menu)

    def _job_card(self, key: str, job_id: str, job: dict, *, update: bool = False, advance: bool = False,
                  note: str | None = None, status: str | None = None, told_approvals: tuple = ()) -> None:
        """A running task's live card: status and ETA on line one (or ``status``, for a card
        shown again for a pick that did not run), then its options. ``told_approvals`` names the
        approvals its note told of, so the same number sent again under it is read with them in
        mind."""
        now = self.clock()
        stream = job.setdefault("stream", {"sent": 0, "last_at": 0, "quiet": False})
        started = job.setdefault("started_at", now)
        estimate = self._estimate(job, now)
        state = job["state"]
        status = status or {"queued": "Queued", "cancelling": "Stopping"}.get(state, estimate["status"])
        top = []
        if estimate["fraction"] is not None:
            top.append(itui.bar(estimate["fraction"]) + (" est" if estimate["basis"] == "history" else ""))
        top.append(estimate["detail"])
        if note:
            top.insert(0, note)
        kind = "cancelling" if state == "cancelling" else "quiet" if stream.get("quiet") else "running"
        options, commands = itui.menu(kind, job_id)
        # The footer promises exactly what the schedule will do next.
        if stream.get("quiet"):
            upcoming = "result only"
        elif self._updates_paused(now):
            upcoming = "updates paused"
        elif stream["sent"] + update >= itui.MAX_UPDATES:
            upcoming = "result next"
        else:
            slot = itui.next_slot(now - started) if advance else stream.get("slot", 0)
            upcoming = "next ~" + itui.span(max(itui.MIN_GAP, started + itui.threshold(slot) - now))
        text = itui.card(
            itui.header(itui.short(job_id), itui.GLYPH.get(state, "●"), status), top=top,
            body=[job.get("label") or f"Task {job_id}"], options=options,
            footer=f"{upcoming} · ref {token(f'{key}:0')[:6]}",
        )
        if estimate["remaining"] and not stream.get("first_eta"):
            stream["first_eta"] = now + estimate["remaining"]
        # What the owner has now been shown; the stream's milestones are measured against it.
        told = self._told(job)
        stream["told"] = {
            "state": state, "stalled": estimate["basis"] == "stall",
            "overrun": told["overrun"] or (estimate["basis"] == "history" and estimate["remaining"] is None),
            "quarter": max(told["quarter"], itui.quarter(job.get("progress"))),
        }
        if update:
            self.outbox.supersede(job_id)
        self.outbox.enqueue(key, job["actor"], job["target"], text, job_id=job_id, menu=commands,
                            card="progress" if update else None, menu_kind=kind,
                            marks={"told_approvals": list(told_approvals)} if told_approvals else None)

    def _owner_route(self) -> tuple[dict, dict] | None:
        """The first authorized direct thread, for system cards nobody asked for yet."""
        lookup = getattr(self.source, "direct_target", None)
        for route in self.config.routes:
            if ";+;" in route.chat or not callable(lookup):
                continue
            target = lookup(route.chat)
            if target:
                return {"sender": route.sender, "chat": route.chat}, target
        return None

    def _system_card(self, key: str, glyph: str, status: str, lines: list[str]) -> None:
        route = self._owner_route()
        if route is None:
            return
        options, commands = itui.menu("system")
        text = itui.card(itui.header("sys", glyph, status), top=lines, options=options,
                         footer=f"ref {token(f'{key}:0')[:6]}")
        self.outbox.enqueue(key, *route, text, menu=commands, menu_kind="system")

    def _resources(self) -> None:
        """Free-space preflight with hysteresis.

        A worse level alerts at once. A better one takes effect only after it has held with
        headroom for DISK_HOLD, doubled each time the disk worsened again within 6 h of a
        resolve card, so a flapping disk sends fewer and fewer cards. The same level is
        re-announced at most every 6 h, and every alert ends with one resolve card. Refusing
        tasks and pausing updates follow the disk right now; only the cards wait.
        """
        usage = shutil.disk_usage(self.config.state_dir)
        free_gib, percent = usage.free / 2**30, 100 * usage.free / max(usage.total, 1)
        info = self.store.data.setdefault("resources", {})
        now = self.clock()
        # Measurements refresh in memory only; the journal is written on transitions alone.
        info["free_gib"], info["free_pct"] = round(free_gib, 1), round(percent, 1)
        raw, settled = disk_level(free_gib, percent), disk_level(free_gib, percent, DISK_MARGIN)
        info["now"] = raw
        level = info.get("level", "ok")
        if level != "ok" and "level_at" not in info:
            info["level_at"] = info.pop("alerted_at", now)
        if DISK_RANK[raw] > DISK_RANK[level]:
            flapped = now - info.get("resolved_at", now - DISK_REALERT) < DISK_REALERT
            info["flaps"] = min(info.get("flaps", 0) + 1, DISK_FLAPS) if flapped else 0
            info.pop("better_since", None)
            self._disk_card(info, raw, free_gib, percent, now)
        elif DISK_RANK[settled] < DISK_RANK[level]:
            # Dipping back between the two lines keeps the hold running, so a disk hovering at
            # the exit line writes the start of the hold and nothing more.
            started = "better_since" not in info
            held = now - info.setdefault("better_since", now)
            if not started and held < min(DISK_HOLD << info.get("flaps", 0), DISK_REALERT):
                return
            if not started:
                del info["better_since"]
                info["resolved_at"] = now
                self._disk_card(info, settled, free_gib, percent, now)
        elif DISK_RANK[raw] == DISK_RANK[level] and "better_since" in info:
            del info["better_since"]  # back below the entry line: the hold starts over
        elif level != "ok" and DISK_RANK[raw] == DISK_RANK[level] and now - info["level_at"] >= DISK_REALERT:
            self._disk_card(info, level, free_gib, percent, now)
        else:
            return
        self.store.save()

    def _disk_card(self, info: dict, level: str, free_gib: float, percent: float, now: float) -> None:
        """Move to a disk level and tell the owner: an alert when it is worse (or still bad
        after 6 h), one resolve card when it is better."""
        before = info.get("level", "ok")
        info["level"] = level
        if level == "ok":
            info.pop("level_at", None)
        else:
            info["level_at"] = now
        space = f"{free_gib:.1f} GB free ({percent:.0f}%)"
        if DISK_RANK[level] < DISK_RANK[before]:
            resumed = "tasks resume" if before == "critical" else "space recovered"
            self._system_card(
                f"sys:disk:{level}:resolved:{int(now)}",
                itui.GLYPH["succeeded"] if level == "ok" else itui.GLYPH["attention"], f"Disk {level}",
                [space, resumed + ("; free space soon" if level == "low" else "")],
            )
        elif level == "critical" and (self._last_heartbeat() or now) <= now - 300:
            # Ticks stopped for a while (a full disk stops them): this tick's gap card says the
            # disk is full and new tasks wait, so the owner gets that news once.
            return
        else:
            self._system_card(
                f"sys:disk:{level}:{int(now)}", itui.GLYPH["attention"], f"Disk {level}",
                [space, "new tasks paused until space frees" if level == "critical" else "free space soon"],
            )

    def _disk_now(self) -> str:
        """The disk level right now, which (not the last card) decides refusal and pausing."""
        resources = self.store.data.get("resources", {})
        return resources.get("now") or resources.get("level", "ok")

    def _outage_report(self) -> None:
        outage = self.store.data.get("imessage_health", {}).get("outage")
        if not outage or outage.get("reported"):
            return
        outage["reported"] = True
        held = sum(part["state"] == "queued" for part in self.store.data["outbox"])
        self._system_card(
            f"sys:outage:{int(outage['start'])}", itui.GLYPH["succeeded"], "iMessage back",
            [f"down {itui.span(outage['end'] - outage['start'])}", str(outage.get("code") or "unknown")[:28],
             f"{held} queued part(s) sending"],
        )
        self.store.save()

    @staticmethod
    def _failure_cause(failure: dict) -> str:
        code = str(failure.get("code") or "unknown")
        if failure.get("errno") == 28:
            return "disk full"
        return "chat.db busy" if code.startswith(("sqlite_busy", "sqlite_locked")) else code

    @staticmethod
    def _failed_ticks(failure: dict) -> str:
        count = max(1, int(recorded_number(failure.get("count"), 1)))
        # A later failure that could not be written (a full disk) only moved the file's time.
        return f"{count}{'+' if failure.get('more') else ''} tick{'' if count == 1 and not failure.get('more') else 's'} failed"

    def _read_tick_failure(self) -> dict | None:
        return read_tick_failure(self.config.state_dir)

    def _last_heartbeat(self) -> float | None:
        try:
            return (self.config.state_dir / "heartbeat").stat().st_mtime
        except FileNotFoundError:
            return None

    def _heartbeat(self) -> None:
        """Touch a tiny file per successful tick; a long gap means ticks failed or stopped.
        Ticks that fail now and then gather in the CLI's record, which a good tick saves at most
        every FAILURE_MERGE (or with the gap card), removing it only once that save succeeded;
        each save adds them to that cause's incident, which ends once none has failed for
        STAGE_HOLD."""
        path = self.config.state_dir / "heartbeat"
        now = self.clock()
        last = self._last_heartbeat()
        gap = last is not None and now - last >= 300
        pending = self._read_tick_failure()
        failure = pending if pending and (gap or now - pending["first"] >= FAILURE_MERGE) else None
        changed = False
        if failure:
            self.store.data["last_tick_failure"] = failure
            changed = True
        if gap:
            cause = (f"{self._failed_ticks(failure)} · {self._failure_cause(failure)}"
                     if failure else "check RAPP health")
            # Back, but not all clear while the disk still blocks new tasks (and this card says
            # so for the disk check, which held its own alert for it this tick).
            critical = self._disk_now() == "critical"
            free = self.store.data.get("resources", {}).get("free_gib")
            self._system_card(f"sys:gap:{int(last)}", itui.GLYPH["attention" if critical else "succeeded"],
                              "Back, disk full" if critical else "Back online",
                              [f"no ticks for {itui.span(now - last)}", cause,
                               *([(f"{free} GB free · " if free is not None else "")
                                  + "new tasks paused until space frees"] if critical else [])])
            if failure:
                # Told by this card, but an incident of the same cause goes on through the gap.
                self._ticks_failing(failure, now, tell=False)
            changed = True
        elif failure:
            self._ticks_failing(failure, now)
        if pending is None:
            # No tick has failed since the last save: an incident quiet for long enough ends.
            changed = self._ticks_quiet(now) or changed
        if changed:
            self.store.save()
        if failure:
            (self.config.state_dir / "tick-failure.json").unlink(missing_ok=True)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        os.utime(path, (now, now))

    def _ticks_failing(self, failure: dict, now: float, *, tell: bool = True) -> None:
        """Whole ticks failing between good ones leave no gap to report. They are one incident
        per cause: told once three or more have failed, then again only after TICKS_RETOLD
        waits, with every failure since it began counted once (a record read again, because
        the save before could not remove it, adds only what is new in it). Without ``tell``
        (a gap card told of them) only an incident already open is extended."""
        alerts = self.store.data.get("tick_alerts") or {}
        cause = self._failure_cause(failure)
        incident = alerts.get(cause)
        if not isinstance(incident, dict):
            if not tell:
                return
            # A journal from before incidents kept only the time of the last card.
            told = recorded_number(incident, 0) if incident is not None else 0
            incident = {"since": failure["first"], "last": failure["last"], "count": 0, "more": False,
                        "told_at": told, "every": 3600 if told else 0}
        merged = incident.get("merged") or {}
        fresh = failure["count"] - merged["count"] if merged.get("first") == failure["first"] else failure["count"]
        incident["merged"] = {"first": failure["first"], "count": failure["count"]}
        if fresh > 0:
            incident.update(count=int(incident["count"]) + fresh, last=max(incident["last"], failure["last"]),
                            more=bool(incident["more"] or failure["more"]))
        self.store.data["tick_alerts"] = {**alerts, cause: incident}
        if not tell or incident["count"] < 3 or (incident["told_at"] and now - incident["told_at"] < incident["every"]):
            return
        retold = [wait for wait in TICKS_RETOLD if wait > incident["every"]]
        incident.update(told_at=now, every=retold[0] if retold else TICKS_RETOLD[-1])
        self._system_card(f"sys:ticks:{int(incident['since'])}:{int(now)}", itui.GLYPH["attention"], "Ticks failing",
                          [f"{self._failed_ticks(incident)} in {itui.span(incident['last'] - incident['since'])}", cause])

    def _ticks_quiet(self, now: float) -> bool:
        """End each ticks-failing incident that has had no failure for STAGE_HOLD; one the owner
        was told of gets one back card."""
        alerts = self.store.data.get("tick_alerts")
        changed = False
        for cause, incident in list((alerts or {}).items()):
            if isinstance(incident, dict) and now - incident["last"] < STAGE_HOLD:
                continue
            alerts.pop(cause)
            changed = True
            if isinstance(incident, dict) and incident["told_at"]:
                self._system_card(f"sys:ticks-back:{int(incident['since'])}", itui.GLYPH["succeeded"], "Ticks back",
                                  [f"{self._failed_ticks(incident)} over "
                                   f"{itui.span(incident['last'] - incident['since'])}", cause])
        return changed

    def _compact(self) -> bool | None:
        """Hourly: drop settled records that are old and past the reader's late window. False
        when it is not due (it did nothing, so it proves nothing about the stage)."""
        data, now = self.store.data, self.clock()
        if now - data.get("compacted_at", 0) < 3600:
            return False
        data["compacted_at"] = now
        horizon = (data["cursor"] or 0) - 256
        keep = []
        for part in data["outbox"]:
            settled = part["state"] in ("sent", "delivered") or (part["state"] == "failed" and not part.get("retryable"))
            if settled and now - part.get("created_at", now) > 14 * 86400 and part.get("send_after_rowid", 0) < horizon:
                if "file" in part:
                    Path(part["file"]["path"]).unlink(missing_ok=True)
                continue
            keep.append(part)
        data["outbox"] = keep
        for conversation in data["conversations"].values():
            approvals = conversation.get("approvals", {})
            for job_id in [key for key, value in approvals.items() if value["expires_at"] < now - 3600]:
                approvals.pop(job_id)
        uploads = {
            identity for conversation in data["conversations"].values() for identity in conversation.get("uploads", [])
        }
        for identity, record in list(data["inbox"].items()):
            if (
                record["state"] in ("done", "failed", "ignored", "cancelled") and identity not in uploads
                and now - record.get("first_seen", now) > 14 * 86400 and record["event"]["id"] < horizon
            ):
                del data["inbox"][identity]
        referenced = {
            job_id for conversation in data["conversations"].values()
            for job_id in [conversation.get("latest_job"), *conversation.get("approvals", {})]
        } | {part.get("job_id") for part in data["outbox"]}
        for job_id, job in list(data["jobs"].items()):
            ended = job.get("finished_at") or job.get("last_poll", now)
            if job["state"] in TERMINAL and job.get("final_queued") and job_id not in referenced and now - ended > 30 * 86400:
                del data["jobs"][job_id]
        self.store.save()

    def _health_card(self, key: str, actor: dict, target: dict) -> None:
        data = self.store.data
        health = data.get("imessage_health", {})
        resources = data.get("resources", {})
        states: dict[str, int] = {}
        for part in data["outbox"]:
            states[part["state"]] = states.get(part["state"], 0) + 1
        try:
            journal = (self.config.state_dir / "transport.json").stat().st_size
        except OSError:
            journal = 0
        lines = [
            f"iMessage: {health.get('code', 'not checked')}",
            f"Disk: {resources.get('free_gib', '?')} GB free · {self._disk_now()}"
            + (f" · easing from {resources['level']}"
               if DISK_RANK.get(self._disk_now(), 0) < DISK_RANK.get(resources.get("level", "ok"), 0) else ""),
            f"Journal: {journal // 1024} KB",
            *([f"Last error: {data['errors'][-1]['code']} ×{data['errors'][-1].get('count', 1)}"]
              if data.get("errors") else []),
            *(f"{'Flaky' if stage.get('kind') == 'flaky' else 'Stuck'}: {STAGES.get(name, (name,))[0].lower()} "
              f"for {itui.span(self.clock() - stage['since'])}" if stage.get("told")
              else f"Failed lately: {STAGES.get(name, (name,))[0].lower()} ×{stage.get('runs', 1)}"
              for name, stage in data.get("stages", {}).items()),
            *(f"Ticks failing: {self._failed_ticks(incident)} in {itui.span(incident['last'] - incident['since'])} · {cause}"
              for cause, incident in data.get("tick_alerts", {}).items() if isinstance(incident, dict)),
            *(f"Last failed: {self._failed_ticks(failure)} · {self._failure_cause(failure)} · "
              f"{itui.span(self.clock() - recorded_number(failure.get('last'), self.clock()))} ago"
              for failure in [self._read_tick_failure() or data.get("last_tick_failure")] if failure),
            "Outbox: " + (", ".join(f"{count} {state}" for state, count in sorted(states.items())) or "empty"),
        ]
        if health.get("hint"):
            lines.append(health["hint"])
        options, commands = itui.menu("system")
        text = itui.card(itui.header("sys", itui.GLYPH["info"], "Health"), body=lines, options=options,
                         footer=f"ref {token(f'{key}:0')[:6]}")
        self.outbox.enqueue(key, actor, target, text, menu=commands, menu_kind="system")

    def _live_approvals(self, conversation: dict | None) -> dict:
        """The one rule for whether an approval can still be answered."""
        now = self.clock()
        return {key: value for key, value in (conversation or {}).get("approvals", {}).items()
                if value["expires_at"] > now}

    def _part_conversation(self, part: dict) -> dict | None:
        """The conversation a sent card belongs to, looked up without creating state."""
        return self.store.data["conversations"].get(self._conversation_key(part["actor"], part["target"]))

    def _card_approval(self, part: dict) -> dict | None:
        """The live approval an approval card offers."""
        if part.get("menu_kind") != "approval":
            return None
        return self._live_approvals(self._part_conversation(part)).get(part.get("job_id") or "")

    @staticmethod
    def _consequential(part: dict, command: str) -> bool:
        """Approve, Cancel and Stop act on a task; the other options only show things."""
        return part.get("menu_kind") == "approval" or command.startswith("stop ")

    def _landed(self, part: dict) -> float:
        """When a bubble left the Mac: when its send returned, or the chat.db row it was later
        found in. A send that never returned may have taken its whole timeout."""
        submitted = part.get("submitted_at") or 0
        sent = part.get("sent_at")
        if sent is None and submitted:
            sent = submitted + self.config.native_timeout
        return max(submitted, sent or 0)

    def _meaning(self, part: dict, n: int | None):
        """What number n picks on a card; the same meaning on two cards is the same choice."""
        if n is None:
            return None
        if part.get("menu"):
            if n > len(part["menu"]):
                return None
            if part.get("menu_kind") == "approval":
                return ("approval", part.get("job_id"), n)
            return ("menu", part["menu"][n - 1])
        post = feed.post_for_group(self.store, part["group"]) if part["group"].startswith("feed:") else None
        return ("post", post["id"], n) if post and post["options"] and n <= post["options"] else None

    def _seen(self, actor: dict, until: float, exclude: str) -> dict | None:
        """The newest card with options that may have been on the owner's phone by ``until``."""
        best = None
        for part in self.store.data["outbox"]:
            if (
                part["actor"] != actor or part["group"] == exclude
                or part["state"] not in ("submitted", "sent", "delivered", "unknown")
                or self._landed(part) > until
            ):
                continue
            post = feed.post_for_group(self.store, part["group"]) if part["group"].startswith("feed:") else None
            if (part.get("menu") or (post and post["options"])) and (
                best is None or self._landed(part) >= self._landed(best)
            ):
                best = part
        return best

    def _unread(self, parts: list[dict], event: dict, n: int | None, *, quoted: bool,
                delivery: bool = True, explicit: bool = False) -> str | None:
        """Why the owner cannot have meant this pick for this card, or None when it may run.

        The one rule for Approve, Cancel, Stop, and answers to agent posts. A swipe-reply names
        a card the owner has seen, unless another author replied in that card's thread (iOS
        names the thread, not the bubble swiped). Otherwise the card must be confirmed on the
        phone (sent or delivered), and the reply typed at least RACE_SECONDS after its last
        bubble left the Mac. A sooner reply still runs when the card the owner could read by then offered the
        same thing under that number (a heartbeat or a re-offer of the same task), so fast
        repliers are never refused forever: only when that card is confirmed on the phone and
        nothing but our bubbles and the owner's messages came after it, up to the reply (a
        newer card goes out a bubble at a time, so another AI's question may land among its
        bubbles and be what the number answers). A row without a chat.db date (read as the
        Apple epoch) is judged by position alone.
        """
        if not parts:
            return None
        if quoted:
            return THREAD_NOTE if self._thread_interrupted(parts[0], event) else None
        texts = [part for part in parts if "text" in part] or parts
        if delivery and any(part["state"] not in ("sent", "delivered") for part in texts):
            return UNCONFIRMED_NOTE
        if explicit and not self._uninterrupted(texts[-1], event):
            # RAPP <n> finds our newest card, but another author's bubble after it (an AI's
            # look-alike card, a group member) may be what the owner was answering.
            return FOREIGN_NOTE
        typed = timestamp(event.get("created_at"))
        if typed <= APPLE_EPOCH + 86400 or typed - max(map(self._landed, texts)) >= RACE_SECONDS:
            return None
        seen = self._seen(texts[-1]["actor"], typed - RACE_SECONDS, texts[-1]["group"])
        meaning = self._meaning(texts[-1], n)
        if (
            meaning is not None and seen is not None and seen["state"] in ("sent", "delivered")
            and self._meaning(seen, n) == meaning
            and self._uninterrupted(seen, event)
        ):
            return None
        return RACE_NOTE

    def _harmless(self, row: dict, event: dict, card: dict) -> bool:
        """A row after a card that leaves the owner's view on it: his own message (any inbound
        row in a one-to-one chat; in a group, one from his handle), or one of our bubbles. An
        agent's post of another update is ours but written by an agent, and is read deny by
        default: a number anywhere in its words, or a picture, may be what a number answers."""
        part = self.outbox.part_for_guid(row["guid"])
        if part is not None:
            post = feed.post_for_group(self.store, part["group"]) if part["group"].startswith("feed:") else None
            if post is None:
                return True
            mine = feed.post_for_group(self.store, card["group"]) if card["group"].startswith("feed:") else None
            if mine is not None and mine["id"] == post["id"]:
                return True
            if any("file" in item for item in feed._bubbles(self.store, post)):
                return False
            return not itui.names_numbers(self._authored(post, part.get("text") or part.get("caption") or ""))
        if row["is_from_me"]:
            return False
        return not event.get("is_group") or normalized(str(row.get("sender") or "")) == normalized(
            str(event.get("sender") or ""))

    @staticmethod
    def _authored(post: dict, text: str) -> str:
        """An agent post's own words in one of its bubbles, without the framing we put on it:
        the [RAPP <channel>] envelope, and a long copy's piece lines."""
        lines = text.split("\n")
        envelope = f"[RAPP {post['channel']}] "
        if lines and re.fullmatch(r"\[RAPP [0-9a-f]{6}\] ⋯ \d+/\d+", lines[0]):
            lines = lines[1:]
        elif lines and lines[0].startswith(envelope):
            lines[0] = lines[0][len(envelope):]
            if lines[0] == "Not answered" or lines[0].startswith("Not answered · "):
                lines[0] = lines[0][len("Not answered · "):]
        return "\n".join(line for line in lines if not re.fullmatch(r"⋯ \d+/\d+ · ref [0-9a-f]{6}", line))

    def _uninterrupted(self, card: dict, event: dict) -> bool:
        """Nothing but the owner's messages and our own bubbles sits after a card, up to the
        reply."""
        between = getattr(self.source, "between", None)
        guids = [part.get("guid") or part.get("caption_guid") for part in self.outbox.parts(card["group"])]
        guids = [guid for guid in guids if guid]
        end = event.get("guid")
        if not callable(between) or not guids or not isinstance(end, str) or not end:
            return False
        rows = between(event["chat_guid"], guids[-1], end)
        return rows is not None and all(self._harmless(row, event, card) for row in rows)

    def _thread_interrupted(self, card: dict, event: dict) -> bool:
        """Whether another author replied in the thread a swipe-reply names, so the owner may
        have swiped on that reply rather than on our card."""
        rows_in = getattr(self.source, "thread_rows", None)
        if not callable(rows_in) or not isinstance(event.get("reply_to"), str):
            return False
        rows = rows_in(event["chat_guid"], event["reply_to"], event)
        return rows is None or not all(self._harmless(row, event, card) for row in rows)

    def _readable(self, identity: str, record: dict, card: dict, n: int, quoted, command: str | None = None) -> bool:
        """False, after re-offering the card as the newest one, when RAPP <n> cannot have been
        meant for it."""
        parts = self.outbox.parts(card["group"])
        swiped = self.outbox.part_for_guid(quoted) if quoted else None
        pick = self._pick_note(card["group"], n, command, record["event"], bubble=swiped, quoted=bool(quoted),
                               explicit=True)
        if pick is None:
            return True
        part = next((item for item in parts if "text" in item), parts[0])
        self._reoffer(identity, record["actor"], record["target"], part, note=pick["note"],
                      told=pick.get("waiting", ()), refused=command)
        return False

    def _post_guard(self, event: dict, text: str, refused: list, *, explicit: bool):
        """A feed.capture guard: an answer typed as its post landed, or (for RAPP <n> and RAPP
        reply) after another author's bubble, is not recorded."""
        digit = re.fullmatch(r"[1-9]", text.strip())

        def guard(item: dict) -> bool:
            bubbles = feed._bubbles(self.store, item)
            quoted = bool(event.get("reply_to")) and event["reply_to"] in {
                value for part in bubbles for value in (part.get("guid"), part.get("caption_guid")) if value
            }
            # The newest showing of the post that left the Mac (its copy after a refusal, once
            # sent) is the one being answered.
            groups = list(dict.fromkeys(part["group"] for part in bubbles))
            shown = [group for group in groups if any(
                part.get("guid") or part.get("caption_guid") for part in self.outbox.parts(group))]
            parts = self.outbox.parts((shown or groups or [item["group"]])[-1])
            note = self._unread(parts, event, int(digit.group()) if digit else None,
                                quoted=quoted, delivery=False, explicit=explicit)
            if note:
                refused.append((item["id"], note, bool(digit)))
            return note is None
        return guard

    def _post_refusal(self, identity: str, actor: dict, target: dict, refusal: tuple) -> bool:
        """An answer an update could not take: the update comes again as the newest bubble,
        with its own options last and why nothing was answered right under its first line, so
        the number sent again (or swiped on it) answers it. One copy waits to go at a time.
        False when the update is closed (or closes now) instead, and the owner is told so."""
        post_id, note, *kind = refusal
        number = kind[0] if kind else True
        item = self.store.data.get("feed", {}).get(post_id)
        now = self.clock()
        if not item or not feed.is_open(item, actor, now):
            self._notice(f"input:{identity}:post-closed", actor, target, "That update is no longer open.",
                         title="Not answered")
            return False
        envelope = f"[RAPP {item['channel']}] "
        original = next((part.get("text") or part.get("caption") or "" for part in self.outbox.parts(item["group"])), "")
        body = original[len(envelope):] if original.startswith(envelope) else original
        head, _, rest = body.partition("\n")
        if itui.draws_numbers(head):
            # The post starts with an option: line one keeps to the channel, the menu stays whole.
            head, rest = "", body
        why, advice = {
            FOREIGN_NOTE: ("foreign", "Another message came after it"),
            THREAD_NOTE: ("thread", "Someone else replied under it"),
        }.get(note, ("race", "Your reply landed as it arrived"))
        what = "number" if number else "answer"
        tail = f"Send the {what} again." if why == "race" else f"Swipe-reply your {what} on this one."
        group = f"feed:{post_id}:again:{identity[:8]}"
        aliases = item.setdefault("aliases", [])
        # An older copy that has not left the Mac is replaced, never queued behind this one.
        feed.drop_queued_copies(self.store, item)
        if item["state"] == "open":
            # The copy is answerable for a reply window of its own, up to twice the first.
            opened = item.get("delivered_at") or item.get("created_at") or now
            until = max(item.get("open_until", 0), min(now + item["ttl"], opened + 2 * item["ttl"]))
            if until - now < min(COPY_WINDOW, item["ttl"]):
                # That cap leaves too little time to answer a copy: close the update now and
                # say so, rather than inviting an answer it could not take.
                item.update(state="expired", open_until=now)
                item["refusals"] = [*item.get("refusals", []), {"at": now, "why": why, "copy": None}][-3:]
                self._notice(f"input:{identity}:post-closed", actor, target, "That update is no longer open.",
                             title="Not answered")
                return False
            item["open_until"] = until
        if group not in aliases:
            aliases.append(group)
        item["refusals"] = [*item.get("refusals", []), {"at": now, "why": why, "copy": token(f"{group}:0")[:6]}][-3:]
        self.outbox.enqueue(group, actor, target, "\n".join(
            [f"{envelope}Not answered" + (f" · {head}" if head else ""), f"{advice}, so nothing was answered. {tail}",
             *([rest] if rest else [])]))
        return True

    def _menu_open(self, part: dict, now: float) -> bool:
        """A task's live menu stays open while it runs, an approval card while its approval is
        live, and other menus for an hour after sending."""
        if not part.get("menu"):
            return False
        if part.get("menu_kind") == "approval":
            return self._card_approval(part) is not None
        job = self.store.data["jobs"].get(part.get("job_id") or "")
        if part.get("menu_kind") in ("running", "quiet", "cancelling") and job is not None:
            # A task no longer followed (lost, or its result could not be shown) is closed too.
            return self._following(job)
        sent = part.get("submitted_at") or part.get("created_at") or now
        return now <= sent + itui.MENU_TTL

    def _latest_card(self, actor: dict, before_rowid: int) -> dict | None:
        """The newest card with options sent before the owner's message, open or not.

        A closed newest card must stop RAPP <n> right there: moving on to an older card
        that is still open would run an option the owner never looked at (such as Stop).
        """
        now, best = self.clock(), None
        # Attachment bubbles carry their card's menu for bare replies, but a card with text is
        # judged by its text; an image post is a single attachment bubble and is its own card.
        texted = {part["group"] for part in self.store.data["outbox"] if "text" in part}
        for part in self.store.data["outbox"]:
            # An attempted card whose receipt is unknown may be on the phone, so it still counts
            # as the newest card (a closed one) and blocks any fallback.
            if (
                part["actor"] != actor or part["state"] not in ("submitted", "sent", "delivered", "unknown")
                or part.get("send_after_rowid", -1) >= before_rowid
                or ("file" in part and part["group"] in texted)
            ):
                continue
            card = self._card(part, actor, now)
            if card and (best is None or part.get("submitted_at", 0) >= best[0]):
                best = (part.get("submitted_at", 0), card)
        return best[1] if best else None

    def _card(self, part: dict, actor: dict, now: float) -> dict | None:
        """A sent part as a card RAPP <n> can answer, or None when it offers no options."""
        post = feed.post_for_group(self.store, part["group"]) if part["group"].startswith("feed:") else None
        confirmed = part["state"] != "unknown"
        if part.get("menu"):
            return {"group": part["group"], "menu": part["menu"], "options": len(part["menu"]),
                    "post": None, "open": confirmed and self._menu_open(part, now), "confirmed": confirmed,
                    "approval": part.get("menu_kind") == "approval", "submitted_at": part.get("submitted_at")}
        if post and post["options"] and post["actor"] == actor:
            return {"group": part["group"], "menu": None, "options": post["options"], "approval": False,
                    "post": post["id"], "open": confirmed and feed.is_open(post, actor, now),
                    "confirmed": confirmed, "submitted_at": part.get("submitted_at")}
        return None

    def _closed_card(self, identity: str, event: dict, actor: dict, target: dict, part: dict,
                     *, note: str | None = None, told: tuple = (), refused: str | None = None) -> None:
        """A digit under one of our cards that no longer offers it (or that it may not have been
        meant for): run nothing and show what is live instead."""
        self._remember_reply(identity, event, actor, target, "closed_menu")
        self._reoffer(identity, actor, target, part, note=note, told=told, refused=refused)

    @staticmethod
    def _following(job: dict | None) -> bool:
        """A task whose live card we keep: started, not ended, and not given up on."""
        return bool(job and job["state"] in ("queued", "running", "cancelling") and job.get("started_at")
                    and not job.get("final_queued"))

    def _shows_again(self, part: dict, target: dict) -> bool:
        """Whether _reoffer sends this card itself again, carrying its note (a live approval, a
        running task's card), rather than a closed or expired notice."""
        if self._card_approval(part):
            return part["target"].get("roster_hash") == target.get("roster_hash")
        return self._following(self.store.data["jobs"].get(part.get("job_id") or ""))

    def _shadowing(self, conversation: dict | None) -> list[str]:
        """The approvals an unswiped Stop may have meant as that card's Cancel: live ones, and
        any that lapsed within LAPSE_SHADOW (the owner may have typed before it did)."""
        now = self.clock()
        return sorted((key for key, value in (conversation or {}).get("approvals", {}).items()
                       if value["expires_at"] > now - LAPSE_SHADOW),
                      key=lambda key: conversation["approvals"][key]["expires_at"])

    def _stop_shadowed(self, command: str, card: dict, quoted, event: dict) -> list[str]:
        """The approvals that shadow this pick, or [] when it may be read as a Stop. A swipe-reply
        names its card, so it is not ambiguous; nor is a number sent again under a card that
        was shown again saying those approvals were waiting, once it could have been read: a
        reply typed within RACE_SECONDS of that card landing was typed before it was (a row
        without a chat.db time is judged by position alone)."""
        if not command.startswith("stop ") or quoted:
            return []
        waiting = self._shadowing(self._part_conversation(card))
        told = set(card.get("told_approvals", ()))
        if told:
            typed = timestamp(event.get("created_at"))
            parts = self.outbox.parts(card["group"])
            texts = [part for part in parts if "text" in part] or parts
            if typed > APPLE_EPOCH + 86400 and typed - max(map(self._landed, texts)) < RACE_SECONDS:
                told = set()
        return waiting if set(waiting) - told else []

    def _shadow_note(self, waiting: list[str], card: dict, n: int) -> str:
        approvals = (self._part_conversation(card) or {}).get("approvals", {})
        refs = " and ".join(itui.short(key) for key in waiting)
        lapsed = all(approvals.get(key, {}).get("expires_at", 0) <= self.clock() for key in waiting)
        if len(waiting) == 1:
            what = f"Task {refs}'s approval {'just lapsed' if lapsed else 'is waiting'}"
        else:
            what = f"Approvals for {refs} {'just lapsed' if lapsed else 'are waiting'}"
        cancel = "" if lapsed else f"; to cancel {refs}, swipe-reply 2 on {'its card' if len(waiting) == 1 else 'their cards'}"
        return f"{what}, so nothing stopped. Send {n} again to stop {itui.short(card.get('job_id'))}{cancel}."

    def _pick_note(self, group: str, n: int, command: str | None, event: dict, *, bubble: dict | None = None,
                   quoted: bool = False, explicit: bool = False, delivery: bool = True) -> dict | None:
        """Why a number cannot be read as this pick of this card ({reason, note}), or None when
        it may run. One rule, in one order, for bare digits, RAPP <n>, and cards: lasting
        reasons first (the bubble it sits under does not show the options; another task's
        approval may be what it meant), then passing ones (not confirmed on the phone yet,
        another author after the card, a race), so a wait is never promised where a lasting
        reason refuses anyway."""
        parts = self.outbox.parts(group)
        if not parts:
            return None
        if bubble is not None and self._off_options(bubble, quoted):
            return {"reason": "piece", "note": PIECE_NOTE}
        card = next((item for item in parts if "text" in item), parts[0])
        waiting = self._stop_shadowed(command, card, quoted, event) if command else []
        if waiting:
            return {"reason": "approval", "note": self._shadow_note(waiting, card, n), "waiting": waiting}
        note = self._unread(parts, event, n, quoted=quoted, delivery=delivery, explicit=explicit)
        return {"reason": READ_REASONS.get(note, "race"), "note": note} if note else None

    def _off_options(self, part: dict, quoted: bool) -> bool:
        """Whether a number on this bubble cannot be read as an answer to its card's options.
        They are shown on the card's last text bubble: an earlier piece of a card that carries
        worker output (which may draw options of its own) is not it, and neither is an
        attachment a swipe-reply names. An approval card is ours and the owner's prompt, so
        any of its bubbles answers it."""
        texts = [item for item in self.outbox.parts(part["group"]) if "text" in item]
        if part.get("menu_kind") == "approval" or not texts or part.get("id") == texts[-1].get("id"):
            return False
        return bool(quoted) or "text" in part

    def _reoffer(self, identity: str, actor: dict, target: dict, part: dict, *, note: str | None = None,
                 told: tuple = (), refused: str | None = None) -> None:
        """Show what a card's options lead to now, instead of running one (``refused``: the
        command it did not run, which a running card's lock-screen line names when it is Stop)."""
        job = self.store.data["jobs"].get(part.get("job_id") or "")
        approval = self._card_approval(part)
        if approval and part["target"].get("roster_hash") != target.get("roster_hash"):
            # Never echo a task to a group whose members changed since it was prepared.
            self._notice(f"input:{identity}:closed", actor, target,
                         "This group changed since that task was prepared, so its card cannot be "
                         "answered here.\nPrepare the task again.", title="Card closed")
        elif approval:
            # A fresh approval card for the same job, token, and expiry, so the next digit sits
            # right under a card the owner has seen.
            group = f"job:{part['job_id']}:approval:{identity[:8]}"
            options, commands = itui.menu("approval", part["job_id"])
            text = itui.card(
                itui.header(itui.short(part["job_id"]), itui.GLYPH["approval"], "Approve task?"),
                top=[note or "Task prepared; NOT running.",
                     f"Expires in {itui.span(approval['expires_at'] - self.clock())}"],
                body=[f"› {(job or {}).get('label') or part['job_id']}",
                      f"Profile: {(job or {}).get('profile') or self.config.profile}",
                      "Details are on the first approval card.",
                      f"Or send RAPP approve {itui.short(part['job_id'])}."],
                options=options, footer=f"ref {token(f'{group}:0')[:6]}",
            )
            self.outbox.enqueue(group, actor, target, text, job_id=part["job_id"], menu=commands,
                                menu_kind="approval")
        elif self._following(job):
            self._job_card(f"input:{identity}:closed", part["job_id"], job, note=note, told_approvals=tuple(told),
                           status="Not stopped" if (refused or "").startswith("stop ") else None)
        elif part.get("menu_kind") == "approval" and part.get("job_id") in (
            self._part_conversation(part) or {}
        ).get("approvals", {}):
            # Still on record but past its expiry: it lapsed unanswered (answered ones are removed).
            self._notice(f"input:{identity}:closed", actor, target,
                         "That approval expired, so nothing ran.\nSend the task again, or use RAPP status.",
                         part.get("job_id"), title="Expired", glyph=itui.GLYPH["expired"])
        else:
            self._notice(f"input:{identity}:closed", actor, target,
                         "That card's options have closed.\nPick from a newer card, or use RAPP status.",
                         part.get("job_id"), title="Card closed")

    def _history(self, job: dict) -> list:
        return self.store.data.get("eta_history", {}).get(job.get("profile") or self.config.profile, [])

    def _remember_reply(self, identity: str, event: dict, actor: dict, target: dict, kind: str) -> None:
        # Record handled replies so the reader's late-row window never dispatches them twice.
        self.store.data["inbox"][identity] = {
            "event": dict(event), "actor": actor, "target": target, "state": "done", "body": "",
            "capture": False, "staged": {}, "has_files": False, "first_seen": self.clock(), "reply": kind,
        }
        self.store.save()

    def _request(self, request: dict) -> dict:
        if request.get("op") in ("submit", "approve", "cancel"):
            # From here the runtime may act: an interruption is reconciled, never "nothing ran".
            self._runtime_called = True
        response = self.runtime.request(request)
        if not isinstance(response, dict) or response.get("ok") is not True:
            error = response.get("error") if isinstance(response, dict) else None
            code = error.get("code") if isinstance(error, dict) else "runtime_rejected"
            raise PortalError(str(code or "runtime_rejected"), "The local task adapter rejected this action.")
        return response

    def tick(self) -> dict:
        own_source = self.source is None
        if own_source:
            self.source = SQLiteSource(self.config)
        try:
            with Store(self.config.state_dir) as store:
                self.store = store
                self.outbox = Outbox(
                    self.config, store, self.native, self.clock, self.source.target_matches,
                    self.source.tail,
                )
                if store.data["cursor"] is None:
                    store.data["cursor"] = store.data["floor"] = self.source.tail()
                    store.save()
                self._quarantined, self._set_aside, self._failing = [], set(), set()
                self._step("disk", self._resources)
                self._step("recover", self._recover_jobs)
                self._step("receipts", lambda: self.outbox.pump(reconcile_only=True))
                self._step("feed", lambda: feed.refresh(store, self.clock()))
                approvals = [
                    (identity, record) for identity, record in store.data["inbox"].items()
                    if record["state"] == "runtime_pending" and record.get("approval_attempt")
                ]
                for identity, record in approvals[:self.config.events_per_tick]:
                    self._contain(identity, lambda: self._advance(identity, record), record=record)
                events = self.source.poll(store.data["cursor"], store.data["floor"])
                for event in events:
                    before = store.data["cursor"]
                    routed: list = []

                    def ingest(event=event, routed=routed) -> None:
                        routed.append(self._ingest(event))
                        if routed[0] is not None:
                            self._advance(routed[0], store.data["inbox"][routed[0]])

                    self._contain(f"row:{event.get('id')}", ingest, event=event)
                    identity = routed[0] if routed else None
                    # A message that broke its own handling is set aside; the cursor moves on.
                    store.data["cursor"] = max(before, event["id"])
                    # Re-read late-window rows that changed nothing must not rewrite the journal.
                    if store.data["cursor"] != before or identity is not None:
                        store.save()
                pending = [
                    (identity, record) for identity, record in store.data["inbox"].items()
                    if record["state"] in ("decoding", "receiving", "ready", "runtime_pending")
                ]
                for identity, record in pending[:self.config.events_per_tick]:
                    # One set aside this tick is looked at again next tick, not straight away.
                    if identity in self._set_aside:
                        continue
                    if record["state"] in ("decoding", "receiving", "ready", "runtime_pending"):
                        self._contain(identity, lambda: self._advance(identity, record), record=record)
                # Each stage runs even when an earlier one broke: a poison job or record never
                # stops sends, heartbeats, or compaction.
                self._step("poll", self._poll_jobs)
                self._step("send", self.outbox.pump)
                self._step("feed", lambda: feed.refresh(store, self.clock()))
                self._step("outage", self._outage_report)
                self._step("attention", self._delivery_attention)
                self._step("compact", self._compact)
                self._heartbeat()
                failures = sum(
                    p["state"] in ("failed", "unknown") for p in store.data["outbox"]
                )
                return {
                    # ok means the tick completed; stuck parts are reported, not a tick failure.
                    "ok": True, "events_observed": len(events),
                    "pending_inputs": sum(
                        r["state"] in ("decoding", "receiving", "ready", "runtime_pending")
                        for r in store.data["inbox"].values()
                    ),
                    "delivery_attention": failures,
                    "jobs": len(store.data["jobs"]),
                    "quarantined": list(self._quarantined),
                }
        finally:
            if own_source:
                self.source.close()
                self.source = None

    def _step(self, name: str, action) -> None:
        """One tick stage. An unexpected error there is recorded and the tick goes on; known
        failures (PortalError) still fail the tick as before, and so does the journal. A stage
        that returns False did no work this tick, which says nothing about whether it works."""
        try:
            ran = action()
        except UNCONTAINED:
            raise
        except Exception as error:
            if strict():
                raise
            code = f"internal:{name}:{type(error).__name__}"
            self._failing.add(name)
            self._quarantined.append({"kind": "stage", "ref": name, "code": code})
            self._stage_failed(name, code)
            return
        if ran is not False:
            self._stage_ok(name)

    def _stage_failed(self, name: str, code: str) -> None:
        """A stage's failures are one incident until it has held for STAGE_HOLD, and it is told
        once: after failing tick after tick for DEGRADED_AFTER (stuck), or on its FLAKY_RUNS-th
        separate run of failures (flaky). A failure or two on their own tell nothing. The
        journal is written only when something new is known (another run, a new kind of error,
        the card), and once told at most every STAGE_LAST_EVERY (to keep the time of the latest
        failure, which decides when it is back); the heartbeat is still touched, so this card,
        not the gap card, is what says so."""
        stages = self.store.data.setdefault("stages", {})
        now, stage = self.clock(), stages.get(name)
        if (
            stage is not None and not stage["told"] and stage.get("broken")
            and now - stage.get("last", stage["since"]) >= STAGE_HOLD
        ):
            stage = None  # it worked, then held (with no tick to end it): this is a new incident
        if stage is None:
            stages[name] = {"code": code, "codes": [code], "since": now, "told": False, "last": now,
                            "runs": 1, "run_since": now}
            self.store.error(code, now)
            return
        # One incident per stage, whatever the error: a new kind is recorded once, and the latest
        # kind rides along with the next write.
        codes = stage.setdefault("codes", [stage["code"]])
        stage["code"] = code
        if code not in codes:
            stage["codes"] = [*codes, code][-5:]
            self.store.error(code, now)
        stage["last"] = now
        changed = False
        if not stage["told"]:
            if stage.pop("broken", False):
                # It worked in between: this failure starts another run of them.
                stage["runs"], stage["run_since"], changed = stage.get("runs", 1) + 1, now, True
            stuck = now - stage.get("run_since", stage["since"]) >= DEGRADED_AFTER
            if stuck or stage.get("runs", 1) >= FLAKY_RUNS:
                stage.update(told=True, mark=now, kind="stuck" if stuck else "flaky")
                changed = True
                label, effect = STAGES.get(name, (name.capitalize(), "part of each tick is failing"))
                if name != "send" or not stuck:
                    # A stuck sender cannot send its own card; its back card says how long instead.
                    # A flaky one sends between its failures, so it can.
                    stage["card"] = f"sys:stuck:{name}:{int(stage['since'])}"
                    kind = code.rsplit(":", 1)[-1]
                    if stuck:
                        self._stage_card(stage["card"], itui.GLYPH["attention"], f"{label} stuck", [
                            effect, f"failing {itui.span(now - stage.get('run_since', stage['since']))} · {kind}"])
                    else:
                        self._stage_card(stage["card"], itui.GLYPH["attention"], f"{label} flaky", [
                            f"now and then, {effect}",
                            f"failed {stage['runs']} times in {itui.span(now - stage['since'])} · {kind}"])
        elif now - stage.get("mark", stage["since"]) >= STAGE_LAST_EVERY:
            # The latest failure rides along with any save; one is forced at most every few minutes.
            stage["mark"], changed = now, True
        if changed:
            self.store.save()

    def _stage_ok(self, name: str) -> None:
        """A stage is back once it has not failed for STAGE_HOLD, so a flapping stage stays one
        incident. One nobody was told of ends quietly then; until then its first good run is
        written down, so a failure after it counts as another run. A stuck card that never left
        the Mac (the stuck stage was sending) is dropped instead of arriving together with its
        back card."""
        stages = self.store.data.get("stages")
        stage = stages.get(name) if stages else None
        if stage is None:
            return
        quiet = self.clock() - stage.get("last", stage["since"])
        if not stage["told"]:
            if quiet >= STAGE_HOLD:
                stages.pop(name)
            elif stage.get("broken"):
                return
            else:
                stage["broken"] = True
            self.store.save()
            return
        # The saved time of the latest failure may be up to STAGE_LAST_EVERY behind the real one
        # (each tick is a new process), so the hold counts from the latest it could have been.
        if quiet < STAGE_HOLD + STAGE_LAST_EVERY:
            return
        stages.pop(name)
        unsent = [part for part in self.outbox.parts(stage.get("card") or "") if part["state"] == "queued"]
        if unsent:
            self.store.data["outbox"] = [part for part in self.store.data["outbox"] if part not in unsent]
        elif stage.get("told"):
            label, _ = STAGES.get(name, (name.capitalize(), ""))
            # For the same reason, how long it failed is known to within STAGE_LAST_EVERY.
            low = stage.get("last", stage["since"]) - stage["since"]
            high = itui.span(low + STAGE_LAST_EVERY)
            spell = f"under {high}" if low < 60 else f"{itui.span(low, floor=True)}–{high}"
            self._stage_card(f"sys:back:{name}:{int(stage['since'])}", itui.GLYPH["succeeded"], f"{label} back",
                             [f"it failed for {spell}"])
        self.store.save()

    def _stage_card(self, key: str, glyph: str, status: str, lines: list[str]) -> None:
        """A stuck or back card never takes the tick down with it."""
        try:
            self._system_card(key, glyph, status, lines)
        except UNCONTAINED:
            raise
        except Exception:
            if strict():
                raise

    def _contain(self, ref: str, action, *, event: dict | None = None, record: dict | None = None) -> bool:
        """Run one message's step. An unexpected error sets that message aside only: it is
        marked failed (nothing runs), the tick goes on, and the owner hears about it once.
        Known failures (PortalError) keep their existing handling; journal failures are never
        contained."""
        # A record already past the runtime (an interrupted approve, a re-check) may have acted.
        self._runtime_called = record is not None and (
            record.get("state") == "runtime_pending" or bool(record.get("approval_attempt"))
            or bool(record.get("internal_attempts")))
        try:
            action()
            return True
        except UNCONTAINED:
            raise
        except Exception as error:
            if strict():
                raise
            code = f"internal:{type(error).__name__}"
            identity = ref
            if record is None and event is not None:
                identity, record = self._tombstone(event, code)
            elif record is not None:
                # Handling may have replaced the record (a decoded message is routed afresh).
                record = self.store.data["inbox"].get(identity, record)
            key, title = f"sys:skipped:{token(ref)[:12]}", "Skipped"
            text = [f"One message was set aside after an internal error ({type(error).__name__}),",
                    "so nothing ran. Send it again if it mattered."]
            job_id, menu = None, "notice"
            if identity:
                self._set_aside.add(identity)
            if record is not None and self._runtime_called:
                # The task runtime was already called, so something may have started or stopped:
                # look again (once) instead of claiming nothing ran.
                attempts = record["internal_attempts"] = record.get("internal_attempts", 0) + 1
                record.update(state="runtime_pending" if attempts < 2 else "failed", error=code)
                job_id = self._record_job(record)
                menu = "check" if job_id else "notice"
                key, title = f"{key}:{attempts}", "Checking" if attempts < 2 else "May have run"
                text = (["Interrupted after the task runtime was called, so it may have started.",
                         "Checking again; RAPP status shows it."] if attempts < 2 else
                        ["Interrupted twice after the task runtime was called, so it may have run.",
                         "[1] Details shows what it did." if job_id else "Check it with RAPP status."])
            elif record is not None:
                record.update(state="failed", error=code)
                try:
                    self._release_inputs(identity, record)
                except Exception:  # noqa: BLE001 - releasing is best effort for a broken record
                    pass
                pick = record.get("menu_pick")
                parts = self.outbox.parts(pick["group"]) if pick else []
                card = next((part for part in parts if "text" in part), parts[0]) if parts else None
                if card and record.get("actor") and record.get("target") and self._shows_again(card, record["target"]):
                    # A number that broke before anything ran: its card comes again, so the
                    # number resent answers it.
                    commands = card.get("menu") or []
                    try:
                        self._reoffer(identity, record["actor"], record["target"], card,
                                      note="An internal error stopped it, so nothing ran.",
                                      refused=commands[pick["n"] - 1] if 0 < pick["n"] <= len(commands) else None)
                        text = None
                    except Exception:  # noqa: BLE001 - the Skipped card below still tells the owner
                        pass
            self._quarantined.append({"kind": "message", "ref": ref[:16], "code": code})
            # The card is queued (saving the tombstone with it) before anything else: if queueing
            # fails, nothing was saved and the message is handled afresh next tick.
            if text and record is not None and record.get("actor") and record.get("target"):
                self._notice(key, record["actor"], record["target"], "\n".join(text), job_id,
                             title=title, glyph=itui.GLYPH["error"], menu=menu)
            elif text:
                self._system_card(key, itui.GLYPH["error"], title, text)
            self.store.error(code, self.clock())
            return False

    def _record_job(self, record: dict) -> str | None:
        """The job a message acted on, when it is known."""
        pick = record.get("menu_pick")
        parts = self.outbox.parts(pick["group"]) if pick else []
        job_id = (record.get("job_id") or (record.get("approval_attempt") or {}).get("job_id")
                  or (parts[0].get("job_id") if parts else None))
        return job_id if job_id in self.store.data["jobs"] else None

    def _tombstone(self, event: dict, code: str) -> tuple[str | None, dict | None]:
        """The inbox record that keeps a set-aside row from being handled again."""
        guid = event.get("guid")
        if not isinstance(guid, str) or not guid:
            return None, None
        identity = hashlib.sha256(guid.encode()).hexdigest()
        record = self.store.data["inbox"].get(identity)
        if record is None:
            record = self.store.data["inbox"][identity] = {
                "event": {"id": event["id"] if type(event.get("id")) is int else 0, "guid": guid},
                "actor": {}, "target": {}, "state": "failed", "error": code, "body": "",
                "capture": False, "staged": {}, "has_files": False, "first_seen": self.clock(),
            }
        return identity, record

    def _ingest(self, event: dict) -> str | None:
        guid = event.get("guid")
        # A row already handled (or set aside) is skipped before anything can fail on it again.
        if isinstance(guid, str) and guid and hashlib.sha256(guid.encode()).hexdigest() in self.store.data["inbox"]:
            return None
        actor = self.authorize(event)
        if actor is None:
            return
        target = {
            "chat_id": event["chat_id"], "chat_guid": event["chat_guid"],
            "is_group": event["is_group"],
        }
        if event["is_group"]:
            target["roster_hash"] = roster_digest(event["participants"])
        guid = event.get("guid")
        if not isinstance(guid, str) or not guid:
            self._notice(
                f"identity-error:{event['id']}:{token(actor['chat'])}", actor, target,
                "Messages has not supplied a stable message id. No task was run; resend with RAPP.",
            )
            return
        identity = hashlib.sha256(guid.encode()).hexdigest()
        if identity in self.store.data["inbox"]:
            return
        if self.outbox.is_echo(event):
            return
        if event.get("needs_native_text"):
            conversation = self._conversation(actor, target)
            capture_candidate = bool(event.get("has_attachments")) and conversation["capture_until"] >= self.clock()
            self.store.data["inbox"][identity] = {
                "event": dict(event), "actor": actor, "target": target, "state": "decoding",
                "body": "", "capture": False, "first_seen": self.clock(),
                "deadline": self.clock() + self.config.readiness_seconds,
                "observations": {}, "staged": {}, "has_files": bool(event.get("has_attachments")),
                "input_snapshot": self._input_snapshot(conversation, event),
                "upload_expires": self.clock() + self.config.attachment_window_seconds,
                "capture_eligible": capture_candidate,
                "capture_generation": conversation["capture_generation"],
            }
            if capture_candidate:
                conversation["uploads"].append(identity)
            self.store.save()
            return identity
        return self._route_event(identity, event, actor, target)

    def _route_event(self, identity: str, event: dict, actor: dict, target: dict) -> str | None:
        if self.outbox.parts(f"input:{identity}:post-closed"):
            # Already told its update is closed; a crash came before the reply was recorded.
            self._remember_reply(identity, event, actor, target, "feed_race")
            return None
        # Messages may represent an attachment-only body with U+FFFC.
        text = str(event.get("text") or "").replace("\ufffc", "")
        conversation = self._conversation(actor, target)
        previous = self.store.data["inbox"].get(identity, {})
        match = ADDRESS.match(text)
        body = text[match.end():].strip() if match else ""
        has_files = event.get("has_attachments") is True or bool(event.get("attachments"))
        if previous:
            if (
                has_files and not text.strip() and "capture_eligible" not in previous
                and (previous.get("selected_by") or identity in conversation["uploads"])
            ):
                raise PortalError(
                    "intake_context_unknown",
                    "This older pending upload lacks durable intake authorization. Rearm and resend it.",
                )
            capture_eligible = (
                previous.get("capture_eligible") is True
                and previous.get("capture_generation") == conversation["capture_generation"]
            )
        else:
            capture_eligible = has_files and conversation["capture_until"] >= self.clock()
        capture = not text.strip() and has_files and capture_eligible
        if match and re.match(r"reply(\s|$)", body, re.IGNORECASE):
            refused = []
            answer = body[5:].strip()
            # A swipe-reply on an update answers that update, not the newest one.
            swiped = self.outbox.part_for_guid(event.get("reply_to"))
            post = feed.post_for_group(self.store, swiped["group"]) if (
                swiped and swiped["actor"] == actor and swiped["group"].startswith("feed:")
            ) else None
            answered = feed.capture(self.store, event, actor, answer, self.clock(), explicit=True,
                                    post_id=post["id"] if post else None,
                                    guard=self._post_guard(event, answer, refused, explicit=True))
            if refused:
                self._post_refusal(identity, actor, target, refused[0])
            else:
                self._notice(f"feed-reply:{identity}", actor, target,
                             "Got it." if answered else "There is no open update to answer right now.")
            self._remember_reply(identity, event, actor, target, "feed_reply")
            return
        menu_pick = None
        if not match and not capture:
            # One digit rule for a thread shared with other AIs: a bare reply belongs to
            # rapp-bubbles only when it sits directly under one of our messages. Anything else,
            # including a 1 or 2 while an approval waits, is left alone without a reply.
            prior = []

            def before():
                # A swipe-reply names the bubble it answers; otherwise the row directly above.
                if not prior:
                    prior.append(event.get("reply_to") or self.source.latest_prior_guid(event))
                return prior[0]

            refused = []
            if feed.capture(self.store, event, actor, text, self.clock(), prior=before,
                            guard=self._post_guard(event, text, refused, explicit=False)):
                self._remember_reply(identity, event, actor, target, "feed_reply")
                return
            digit = re.fullmatch(r"[1-9]", text.strip())
            if refused:
                # Typed as the update landed, so meant for something else: a number gets the
                # update again (so resending it answers); other text is left to the conversation.
                if digit:
                    self._post_refusal(identity, actor, target, refused[0])
                    self._remember_reply(identity, event, actor, target, "feed_race")
                return
            if not digit:
                return
            part = self.outbox.part_for_guid(before())
            if part is None or part["actor"] != actor:
                return
            n = int(digit.group())
            if self._menu_open(part, self.clock()) and n <= len(part["menu"]):
                command, quoted = part["menu"][n - 1], bool(event.get("reply_to"))
                pick = self._pick_note(part["group"], n, command, event, bubble=part,
                                       quoted=quoted) if self._consequential(part, command) else None
                if pick:
                    self._closed_card(identity, event, actor, target, part, note=pick["note"],
                                      told=tuple(pick.get("waiting", ())), refused=command)
                    return
                menu_pick = {"group": part["group"], "n": n}
            else:
                self._closed_card(identity, event, actor, target, part)
                return
        if len(text) > 65536:
            self._notice(f"input:{identity}:large", actor, target, "RAPP message exceeds the 64 KiB limit.")
            return
        if menu_pick:
            body = self.outbox.parts(menu_pick["group"])[0]["menu"][menu_pick["n"] - 1]
        record = {
            "event": dict(event), "actor": actor, "target": target, "body": body,
            "state": "receiving" if has_files else "ready",
            "capture": capture or (has_files and body.casefold() in ("", "attach")),
            "explicit_address": match is not None,
            "first_seen": self.clock(), "deadline": self.clock() + self.config.readiness_seconds,
            "observations": {}, "staged": {}, "has_files": has_files,
            "upload_expires": previous.get("upload_expires", self.clock() + self.config.attachment_window_seconds),
            "capture_eligible": capture_eligible,
            "capture_generation": previous.get("capture_generation", conversation["capture_generation"]),
        }
        if previous.get("selected_by"):
            record["selected_by"] = previous["selected_by"]
        if menu_pick:
            record["menu_pick"] = menu_pick
        self.store.data["inbox"][identity] = record
        if record["capture"]:
            if identity not in conversation["uploads"] and not record.get("selected_by"):
                conversation["uploads"].append(identity)
        elif self._task_command(body):
            snapshot = previous.get("input_snapshot")
            if snapshot is None:
                snapshot = self._input_snapshot(conversation, event)
            self._freeze_inputs(identity, record, conversation, snapshot)
        self.store.save()
        return identity

    def _advance(self, identity: str, record: dict) -> None:
        try:
            if self.authorize(record["event"]) != record["actor"]:
                record.update(state="failed", error="authorization_changed")
                self.store.save()
                return
            if record["state"] == "decoding":
                if self.clock() > record["deadline"]:
                    raise PortalError(
                        "text_decode_timeout",
                        "Native text decoding did not become available. No task was run; resend as a plain RAPP text.",
                    )
                if self.clock() < record.get("next_decode", 0):
                    return
                try:
                    text = self.native.decode_text(record["event"], record["actor"])
                except PortalError as error:
                    record.update(decode_error=error.code, next_decode=self.clock() + 5)
                    self.store.save()
                    return
                event = {**record["event"], "text": text, "needs_native_text": False}
                routed = self._route_event(identity, event, record["actor"], record["target"])
                if routed is None:
                    record["state"] = "ignored"
                    self.store.save()
                else:
                    self._advance(identity, self.store.data["inbox"][identity])
                return
            if record.get("approval_attempt") and record["state"] == "runtime_pending":
                attempt = record["approval_attempt"]
                response = self._request({
                    "op": "status", "actor": record["actor"], "job_id": attempt["job_id"],
                })
                job_id, state, metadata = response_job(response)
                if job_id != attempt["job_id"]:
                    raise PortalError("runtime_protocol", "Approval reconciliation returned the wrong job.")
                self.store.data["jobs"][job_id].update(state=state, metadata=metadata)
                if state in ("awaiting_approval", "pending_approval", "approval_required"):
                    capability = attempt.get("capability")
                    if capability and capability["expires_at"] > self.clock():
                        conversation = self._conversation(record["actor"], record["target"])
                        conversation["approvals"][job_id] = capability
                self._notice(
                    f"input:{identity}:reconciled", record["actor"], record["target"],
                    f"Task {job_id}: {state}. The interrupted approval was not automatically replayed.", job_id,
                )
                record["state"] = "done"
                self.store.save()
                return
            if record["state"] == "receiving":
                if not self._receive(identity, record):
                    return
            if record["capture"]:
                conversation = self._conversation(record["actor"], record["target"])
                references = [record["staged"][key] for key in sorted(record["staged"], key=int)]
                queued_files = sum(
                    len(self.store.data["inbox"][key]["staged"]) for key in conversation["uploads"]
                    if self.store.data["inbox"][key].get("upload_expires", 0) >= self.clock()
                )
                if queued_files > self.config.max_files:
                    raise PortalError("too_many_files", "Too many pending files; use RAPP clear files.")
                record["upload_expires"] = self.clock() + self.config.attachment_window_seconds
                if not record.get("selected_by"):
                    conversation["capture_until"] = record["upload_expires"]
                # The notice commit includes the completed source event and its
                # staged ordinals. A restart cannot append the same upload again.
                record["state"] = "done"
                self._notice(
                    f"input:{identity}:saved", record["actor"], record["target"],
                    f"Saved {len(references)} attachment(s) for your next RAPP task. "
                    "Nothing was executed. Send RAPP followed by what you want done.",
                )
            else:
                self._command(identity, record)
            record["state"] = "done"
            self.store.save()
        except AwaitingInputs:
            record["state"] = "ready"
            self.store.save()
        except SubmissionUnknown as error:
            record["state"] = "runtime_pending"
            record["error"] = error.code
            self.store.error(error.code, self.clock())
            self._notice(
                f"input:{identity}:runtime-unknown", record["actor"], record["target"],
                "The local task adapter's response was interrupted. No approval will be blindly retried. "
                "Use RAPP status or RAPP resume to reconcile durable job state.",
            )
        except PortalError as error:
            record.update(state="failed", error=error.code)
            self._release_inputs(identity, record)
            self.store.error(error.code, self.clock())
            self._notice(
                f"input:{identity}:error", record["actor"], record["target"],
                f"RAPP could not complete this request ({error.code}): {error}. "
                "Use RAPP status to check any existing job. For failed intake, fix the cause and resend the task.",
                title="Could not do that", glyph=itui.GLYPH["error"],
            )

    def _receive(self, identity: str, record: dict) -> bool:
        if self.clock() > record["deadline"]:
            if record.get("staging_error") == "disk_full":
                raise PortalError("disk_full", "The disk stayed full, so the attachment was not saved; free space and send it again.")
            raise PortalError("attachment_timeout", "An attachment did not finish downloading; send it again after download.")
        attachments = self.source.attachments(record["event"])
        if not isinstance(attachments, list) or len(attachments) > self.config.max_files:
            raise PortalError("too_many_files", "Attachment count exceeds the configured limit.")
        for attachment in attachments:
            if not isinstance(attachment, dict):
                raise PortalError("attachment_metadata", "Invalid native attachment metadata.")
            for key, limit in (
                ("original_path", 4096), ("filename", 4096), ("transfer_name", 1024),
                ("mime_type", 128), ("uti", 256),
            ):
                value = attachment.get(key)
                if value is not None and (
                    not isinstance(value, str) or len(value) > limit or "\0" in value
                ):
                    raise PortalError("attachment_metadata", "Native attachment path/type metadata is malformed.")
        if self.outbox.is_echo(record["event"], attachments):
            record["state"] = "done"
            self.store.save()
            return False
        signature = token(json.dumps(attachments, sort_keys=True, ensure_ascii=False))
        if signature != record.get("metadata_signature"):
            record.update(
                metadata_signature=signature, metadata_since=self.clock(),
                staged={}, observations={},
            )
            self.store.save()
        waiting = not attachments or self.clock() - record["metadata_since"] < self.config.stable_seconds
        for index, attachment in enumerate(attachments):
            if not isinstance(attachment, dict):
                raise PortalError("attachment_metadata", "Invalid native attachment metadata.")
            size = attachment.get("total_bytes", 0)
            if type(size) is not int or size < 0:
                raise PortalError("attachment_metadata", "Invalid attachment byte count.")
            if size > self.config.max_file_bytes:
                raise PortalError("file_too_large", "Attachment exceeds the 100 MiB/file safety limit.")
            key = str(index)
            if key in record["staged"]:
                continue
            original = attachment.get("original_path") or attachment.get("filename")
            if not original:
                waiting = True
                continue
            try:
                with regular_file(
                    Path(original).expanduser(), self.config.incoming_roots, self.config.max_file_bytes,
                ) as (_, info):
                    mime = str(attachment.get("mime_type") or "")
                    if info.st_size == 0 and mime.startswith(("image/", "audio/", "video/")):
                        waiting = True
                        continue
                    observed = [str(original), info.st_size, info.st_mtime_ns]
                    previous = record["observations"].get(key, {})
                    if previous.get("value") != observed:
                        record["observations"][key] = {"value": observed, "since": self.clock()}
                        waiting = True
                        continue
                    if self.clock() - previous["since"] < self.config.stable_seconds or (size and info.st_size != size):
                        waiting = True
                        continue
                name = filename(attachment.get("transfer_name") or Path(original).name)
                if not room_for(self.config.state_dir, max(size, record["observations"][key]["value"][1])):
                    # Never copy into a full disk; wait for space until the upload's deadline.
                    record["staging_error"] = "disk_full"
                    waiting = True
                    continue
                destination = self.config.state_dir / "inbox" / identity / f"{index}-{name}"
                reference = copy_reference(
                    original, self.config.incoming_roots, destination, self.config.max_file_bytes,
                    expected_size=size if size else None,
                )
                reference.update(name=name, mime=str(attachment.get("mime_type") or "application/octet-stream"))
                record["staged"][key] = reference
            except FileNotFoundError:
                waiting = True
            except PortalError as error:
                if error.code == "file_changed":
                    record["observations"].pop(key, None)
                    waiting = True
                elif error.code == "disk_full":
                    # Wait for space until the upload's deadline rather than failing at once.
                    record["staging_error"] = "disk_full"
                    waiting = True
                else:
                    raise
        self.store.save()
        if waiting or len(record["staged"]) != len(attachments):
            self._notice(
                f"input:{identity}:receiving", record["actor"], record["target"],
                "RAPP received attachment metadata and is waiting for complete local files. "
                "No task has run; you will get a saved-file or explicit failure notice.",
            )
            return False
        record["state"] = "ready"
        self.store.save()
        return True

    def _job_for_actor(self, identity: str | None, actor: dict, conversation: dict) -> tuple[str, dict]:
        identity = self._job_ref(identity, actor) or conversation.get("latest_job")
        job = self.store.data["jobs"].get(identity)
        if not job or job["actor"] != actor:
            raise PortalError("job_not_in_thread", "No matching RAPP job belongs to this sender and thread.")
        if job["target"].get("roster_hash") != conversation["target"].get("roster_hash"):
            raise PortalError("job_audience_changed", "This job belongs to an earlier group roster. Prepare a new task for this group.")
        return identity, job

    def _job_ref(self, value: str | None, actor: dict, candidates=None) -> str | None:
        """Resolve a full job id or a unique short ref (the 4+ characters shown in [RAPP 9c1e])."""
        if not value:
            return value
        jobs = self.store.data["jobs"] if candidates is None else candidates
        if value in jobs:
            return value
        short = itui.HEX_REF.fullmatch(value.strip())
        if not short:
            return value
        suffix = short.group(1).casefold()
        matches = [
            job_id for job_id in jobs
            if job_id.casefold().endswith(suffix) and (candidates is not None or jobs[job_id]["actor"] == actor)
        ]
        if len(matches) > 1:
            raise PortalError("job_ref_ambiguous", "That short job ref matches several jobs; use more characters.")
        return matches[0] if matches else value

    def _command(self, identity: str, record: dict) -> None:
        if self.outbox.parts(f"input:{identity}:post-closed"):
            return  # already told its update is closed, before a crash kept it from being done
        actor, target, body = record["actor"], record["target"], record["body"]
        conversation = self._conversation(actor, target)
        words = body.split(maxsplit=1)
        command = words[0].casefold() if words else "help"
        argument = words[1].strip() if len(words) > 1 else ""
        if command in ("help", "?"):
            self._notice(f"input:{identity}:help", actor, target, HELP)
            return
        if command == "attach":
            self._clear_capture(record["actor"])
            conversation.update(
                uploads=[],
                capture_until=self.clock() + self.config.attachment_window_seconds,
                capture_generation=conversation["capture_generation"] + 1,
            )
            self._notice(f"input:{identity}:attach", actor, target,
                         "RAPP file intake is armed for this sender/thread. Send files, then RAPP <task>. "
                         "File receipt alone never executes anything.")
            return
        if body.casefold() == "clear files":
            self._clear_capture(record["actor"])
            conversation.update(
                uploads=[], capture_until=0, capture_generation=conversation["capture_generation"] + 1,
            )
            self._notice(f"input:{identity}:cleared", actor, target, "Pending RAPP file selection cleared.")
            return
        if record.get("explicit_address") and re.fullmatch(r"[1-9]", command) and not argument:
            # RAPP <n>: the card a swipe-reply quotes, else the newest card the owner could have
            # seen before typing, agent posts included; never an older card. 1/2 approve or
            # cancel only when that card is a live approval card, and then only its job.
            quoted = record["event"].get("reply_to")
            if quoted:
                part = self.outbox.part_for_guid(quoted)
                card = self._card(part, actor, self.clock()) if part and part["actor"] == actor else None
                if card is None:
                    raise PortalError("no_open_menu", "That swipe-reply is not on one of our cards with "
                                      "options, so nothing ran. Swipe-reply on the card you mean.")
            else:
                card = self._latest_card(actor, record["event"]["id"])
            if card and card["approval"] and command in ("1", "2"):
                if self._readable(identity, record, card, int(command), quoted):
                    self._approve_or_cancel(identity, record, conversation, command, "", card=card["group"])
                return
            if card and not card["confirmed"]:
                raise PortalError("no_open_menu", "The newest card may not have reached your phone, so its "
                                  "numbers are closed. Check your phone, then use RAPP status.")
            if not card or not card["open"] or int(command) > card["options"]:
                raise PortalError("no_open_menu", "No open card offers that number. Use RAPP status or RAPP list.")
            record["menu_pick"] = {"group": card["group"], "n": int(command)}
            if card["post"]:
                refused = []
                answered = feed.capture(self.store, record["event"], actor, command, self.clock(),
                                        explicit=True, post_id=card["post"],
                                        guard=self._post_guard(record["event"], command, refused, explicit=True))
                if refused:
                    self._post_refusal(identity, actor, target, refused[0])
                else:
                    self._notice(f"input:{identity}:reply", actor, target,
                                 "Got it." if answered else "That update is no longer open.")
                return
            chosen = card["menu"][int(command) - 1]
            if chosen.startswith("stop ") and not self._readable(identity, record, card, int(command), quoted, chosen):
                return
            record["body"] = chosen
            self._command(identity, record)
            return
        if command in ("1", "2"):
            # A number answers one card: the bubble it sits under (or quotes), or with RAPP the
            # newest card. There is no thread-wide "the only pending task" guess.
            pick = record.get("menu_pick")
            if record.get("explicit_address") or not pick:
                waiting = ", ".join(itui.short(job) for job in self._live_approvals(conversation))
                raise PortalError(
                    "rapp_number_alone",
                    f"RAPP {command} takes no other words, so nothing ran. Swipe-reply {command} on the "
                    f"approval card, or send RAPP {'approve' if command == '1' else 'cancel'} <ref>"
                    + (f" (waiting: {waiting})" if waiting else "") + ".",
                )
            self._approve_or_cancel(identity, record, conversation, command, "", card=pick["group"])
            return
        if command == "approve":
            self._approve_or_cancel(identity, record, conversation, command, argument)
            return
        if command == "health" and not argument:
            self._health_card(f"input:{identity}:health", actor, target)
            return
        if command == "quiet" and (not argument or itui.HEX_REF.fullmatch(argument) or JOB_ID.fullmatch(argument)):
            job_id, job = self._job_for_actor(argument or None, actor, conversation)
            job.setdefault("stream", {"sent": 0, "last_at": 0, "quiet": False})["quiet"] = True
            self._notice(f"input:{identity}:quiet", actor, target,
                         "No more automatic updates for this task.\nIts result still comes when it ends.",
                         job_id, title="Quiet", menu="quiet")
            return
        if command == "files":
            raise PortalError("output_name_invalid", "This route accepts one output: RAPP file report.txt | task.")
        if command == "file":
            names_text, separator, prompt = argument.partition("|")
            name = names_text.strip()
            if (
                not separator or not prompt.strip()
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._ -]{0,119}", name)
                or ".." in name or Path(name).suffix.casefold() not in OUTPUT_EXTENSIONS
            ):
                raise PortalError(
                    "output_name_invalid",
                    "Use RAPP file report.txt | task, with a bounded passive media/document basename, not a path or flag.",
                )
            record["requested_artifacts"] = [name]
            self.store.save()
            self._submit(identity, record, conversation, prompt.strip())
            return
        if command == "list":
            response = self._request({
                "op": "list", "actor": actor, "limit": 15,
                **({"before": argument} if argument else {}),
            })
            jobs = response.get("jobs", [])
            lines = [
                f"{job.get('job_id')}: {job.get('status')}"
                for job in jobs[:15] if isinstance(job, dict)
            ]
            listing = "\n".join(lines) or "No RAPP jobs in this thread."
            if response.get("next_before"):
                listing += f"\nMore: RAPP list {response['next_before']}"
            self._notice(f"input:{identity}:list", actor, target, listing)
            return
        if command in ("resume", "recover"):
            if argument:
                argument, _ = self._job_for_actor(argument, actor, conversation)
            response = self._request({"op": "recover", "actor": actor, **({"job_id": argument} if argument else {})})
            self._notice(f"input:{identity}:recover", actor, target,
                         "Reconciled this thread's durable jobs. Recovery does not grant new permissions. "
                         "Use RAPP status/list; interrupted tasks require a new approved submission.")
            return
        if command in ("status", "result", "stop", "cancel", "retry"):
            job_id, job = self._job_for_actor(argument or None, actor, conversation)
            if command == "retry":
                count = self.outbox.retry(actor, job_id)
                self._notice(f"input:{identity}:retry", actor, target,
                             f"Queued {count} confirmed failed output part(s); successful/uncertain parts were not retried.",
                             job_id)
            elif command == "result":
                self._result(job_id, job, group=f"job:{job_id}:requested:{identity}")
            else:
                operation = "cancel" if command in ("stop", "cancel") else "status"
                response = self._request({"op": operation, "actor": actor, "job_id": job_id})
                returned, state, _ = response_job(response)
                if returned != job_id:
                    raise PortalError("runtime_protocol", "Job response did not match this thread's request.")
                job["state"] = state
                if operation == "cancel":
                    conversation["approvals"].pop(job_id, None)
                if self._following(job):
                    self._job_card(f"input:{identity}:{operation}", job_id, job)
                else:
                    self._notice(f"input:{identity}:{operation}", actor, target,
                                 f"Task {job_id}: {state}. Native output: {self.outbox.summary(job_id)}.", job_id,
                                 title=state.capitalize(), glyph=itui.GLYPH.get(state, "·"),
                                 menu="final" if state in TERMINAL else "notice")
            return
        if command == "resend":
            matches = [
                p for p in self.store.data["outbox"]
                if p["actor"] == actor and len(argument) >= 6 and p["id"].startswith(argument)
            ]
            part = matches[0] if len({p["id"] for p in matches}) == 1 else None
            if not part or not part.get("job_id"):
                raise PortalError("part_not_in_thread", "No uncertain result part belongs to this thread.")
            count = self.outbox.retry(actor, part["job_id"], uncertain_part=part["id"])
            self._notice(f"input:{identity}:resend", actor, target,
                         f"Your explicit request queued {count} uncertain part(s). A previous attempt may still arrive.",
                         part["job_id"])
            return
        prompt = argument if command in ("run", "task", "do") else body
        if not prompt:
            raise PortalError("empty_task", "Use RAPP followed by the task you want prepared.")
        self._submit(identity, record, conversation, prompt)

    def _clear_capture(self, actor: dict) -> None:
        for other in self.store.data["inbox"].values():
            if other["actor"] == actor and other["capture"] and other["state"] == "receiving":
                other.update(state="cancelled", error="upload_selection_cleared")

    def _submit(self, identity: str, record: dict, conversation: dict, prompt: str) -> None:
        if "submission" not in record:
            if "selected_inputs" not in record:
                self._freeze_inputs(identity, record, conversation, self._input_snapshot(conversation, record["event"]))
                self.store.save()
            if record.get("input_selection_error"):
                raise PortalError("input_already_selected", "A frozen input was already selected by another task.")
            selected = [self.store.data["inbox"].get(key) for key in record["selected_inputs"]]
            if any(
                upload is None or upload["actor"] != record["actor"]
                or upload["target"].get("roster_hash") != record["target"].get("roster_hash")
                or upload["event"]["id"] >= record["event"]["id"]
                or upload["state"] in ("failed", "cancelled", "ignored")
                or upload.get("selected_by") != identity
                for upload in selected
            ):
                raise PortalError("attachment_failed", "A selected upload failed or was cleared. Resend the file and task.")
            if any(upload["state"] != "done" for upload in selected):
                self._notice(
                    f"input:{identity}:waiting-inputs", record["actor"], record["target"],
                    "Your RAPP task is waiting for the preceding selected uploads. It has not run.",
                )
                raise AwaitingInputs
            if any(not upload["capture"] for upload in selected):
                raise PortalError("attachment_failed", "A selected source message was not an authorized file-only upload.")
            sources = sorted([*selected, record], key=lambda upload: upload["event"]["id"])
            references = [
                dict(upload["staged"][key])
                for upload in sources for key in sorted(upload["staged"], key=int)
            ]
            if len(references) > self.config.max_files:
                raise PortalError("too_many_files", "Too many selected files; use RAPP clear files.")
            record["submission"] = {
                "op": "submit", "actor": record["actor"], "request_id": f"imessage-{identity}",
                "prompt": prompt, "profile": self.config.profile,
                "attachments": references,
                "artifact_paths": record.get("requested_artifacts", []),
            }
            self.store.save()
        # Refusal follows the disk right now: freeing space works at once, without the hold.
        if self._disk_now() == "critical":
            raise PortalError("disk_low", "Disk space is critically low; free space before new tasks. Status and stop still work.")
        if "disk" in self._failing:
            # Fail closed: a disk that cannot be checked this tick is not assumed to have room.
            raise PortalError("disk_unknown", "The disk check is failing, so new tasks wait until it works again.")
        policy = self.runtime.profile_policy(record["submission"]["profile"])
        if "policy_snapshot" not in record:
            record["policy_snapshot"] = policy
            self.store.save()
        if policy != record["policy_snapshot"]:
            raise PortalError("policy_changed", "The local capability profile changed; prepare a new task for fresh approval.")
        response = self._request(record["submission"])
        if self.runtime.profile_policy(record["submission"]["profile"]) != record["policy_snapshot"]:
            raise PortalError("policy_changed", "The local capability profile changed during preparation.")
        job_id, state, metadata = response_job(response)
        if (
            metadata.get("request_id") != record["submission"]["request_id"]
            or metadata.get("artifact_paths") != record["submission"]["artifact_paths"]
            or metadata.get("profile") != record["submission"]["profile"]
            or metadata.get("model") != "gpt-6-astra"
        ):
            raise PortalError("runtime_protocol", "The prepared job does not match the requested task binding.")
        existing = self.store.data["jobs"].get(job_id)
        if existing and existing["actor"] != record["actor"]:
            raise PortalError("runtime_protocol", "Job identity crossed a thread boundary.")
        job = self.store.data["jobs"].setdefault(job_id, {
            "actor": record["actor"], "target": record["target"], "request_id": record["submission"]["request_id"],
            "state": state, "declared": list(record["submission"]["artifact_paths"]), "metadata": metadata,
            "last_poll": 0, "last_notice": 0, "final_queued": False,
            "stdout_offset": 0, "stderr_offset": 0, "event_offset": 0,
            "label": itui.label(prompt), "profile": record["submission"]["profile"],
        })
        record["job_id"] = job_id
        conversation["latest_job"] = job_id
        if not conversation["uploads"]:
            conversation["capture_until"] = 0
        approval = response.get("approval")
        if isinstance(approval, dict) and approval.get("token"):
            expiry = timestamp(approval.get("expires_at"))
            if not math.isfinite(expiry) or expiry <= self.clock():
                raise PortalError("approval_expired", "The task approval has already expired.")
            group = f"job:{job_id}:approval"
            conversation["approvals"][job_id] = {
                "token": str(approval["token"]), "expires_at": expiry, "notice_group": group,
            }
            options, commands = itui.menu("approval", job_id)
            card = itui.card(
                itui.header(itui.short(job_id), itui.GLYPH["approval"], "Approve task?"),
                top=["Task prepared; NOT running.", f"Expires in {itui.span(expiry - self.clock())}"],
                body=[
                    *(f"› {line}" for line in prompt[:700].splitlines()),
                    f"Profile: {record['submission']['profile']}; model: gpt-6-astra",
                    f"Available tools: {', '.join(policy['available_tools']) or 'none'}",
                    f"Allow grants: {', '.join(policy.get('allow_tools', [])) or 'none'}",
                    f"Deny grants: {', '.join(policy.get('deny_tools', [])) or 'runtime deny-by-default'}",
                    f"Extra directories: {', '.join(policy.get('add_dirs', [])) or 'isolated job workspace only'}",
                    f"URL grants: {', '.join(policy.get('allow_urls', [])) or 'none'}",
                    f"Inputs: {len(record['submission']['attachments'])}; "
                    f"declared outputs: {', '.join(record['submission']['artifact_paths']) or 'text only'}.",
                    "Numbers apply only right under this card.",
                    f"Otherwise: RAPP approve {itui.short(job_id)}.",
                ],
                options=options, footer=f"ref {token(f'{group}:0')[:6]}",
            )
            self.outbox.enqueue(group, record["actor"], record["target"], card, job_id=job_id, menu=commands,
                                menu_kind="approval")
        else:
            self._notice(f"job:{job_id}:submitted", record["actor"], record["target"],
                         f"Task {job_id}: {state}. No new execution was authorized by this receipt.", job_id)
        self.store.save()

    def _approve_or_cancel(self, identity, record, conversation, command, argument, card=None) -> None:
        valid = self._live_approvals(conversation)
        if command in ("1", "2"):
            # Numbers approve or cancel exactly the job of the approval card they answer.
            notices = self.outbox.parts(card) if card else []
            job_id = notices[0].get("job_id") if notices and notices[0].get("menu_kind") == "approval" else None
            approval = valid.get(job_id or "")
            if not approval or notices[0]["actor"] != record["actor"]:
                raise PortalError("approval_expired",
                                  "That approval card is no longer live, so this reply did nothing. Use RAPP status.")
            explicit = f"RAPP {'approve' if command == '1' else 'cancel'} {itui.short(job_id)}"
            if (
                not notices or not notices[-1].get("guid")
                or not all(p["state"] in ("sent", "delivered") for p in notices)
            ):
                raise PortalError("approval_notice_unconfirmed", "The approval card's delivery is not "
                                  f"confirmed yet, so nothing ran. Check your phone, then send {explicit}.")
            # A swipe-reply may quote any bubble of the card; adjacency needs its last bubble,
            # the one with the options, directly above.
            quoted = record["event"].get("reply_to")
            if not record.get("explicit_address") and not (
                quoted in {part.get("guid") for part in notices} if quoted
                else self.source.latest_prior_guid(record["event"]) == notices[-1].get("guid")
            ):
                raise PortalError(
                    "approval_context_changed",
                    "Another message came between the approval card and your reply, so nothing ran. "
                    f"Swipe-reply on the card, or send {explicit}.",
                )
        else:
            job_id = self._job_ref(argument, record["actor"], valid)
            approval = valid.get(job_id)
            if not approval:
                raise PortalError("approval_expired", "No unexpired task-bound approval exists in this thread.")
        _, job = self._job_for_actor(job_id, record["actor"], conversation)
        request = {
            "op": "cancel" if command == "2" else "approve", "actor": record["actor"], "job_id": job_id,
        }
        if command != "2":
            request["approval_token"] = approval["token"]
        # Remove the bare-number capability before invoking a mutating adapter.
        # An interrupted approve is reconciled through status, never replayed.
        conversation["approvals"].pop(job_id, None)
        record["approval_attempt"] = {
            "job_id": job_id, "op": request["op"], "capability": dict(approval),
        }
        record["state"] = "runtime_pending"
        self.store.save()
        try:
            response = self._request(request)
        except NotSubmitted:
            conversation["approvals"][job_id] = approval
            record.pop("approval_attempt", None)
            self.store.save()
            raise
        returned, state, metadata = response_job(response)
        if returned != job_id:
            raise PortalError("runtime_protocol", "Approval response did not match the requested job.")
        job.update(state=state, metadata=metadata)
        if request["op"] == "cancel":
            self._notice(f"input:{identity}:approved", record["actor"], record["target"],
                         f"Task {job_id}: {state}.", job_id, title="Cancelled", glyph=itui.GLYPH["cancelled"])
        else:
            # Waiting for approval is not worker idleness: liveness starts fresh at approval.
            job.update(started_at=self.clock(), output_at=self.clock(), worker_active=None)
            job.setdefault("stream", {"sent": 0, "last_at": 0, "quiet": False})["last_at"] = self.clock()
            self._job_card(f"input:{identity}:approved", job_id, job)

    def _recover_jobs(self) -> None:
        instance = os.environ.get("RAPP_PORTAL_WATCHER_INSTANCE", "manual")
        changed = self.store.data.get("watcher_instance") != instance
        self.store.data["watcher_instance"] = instance
        budget = 4
        jobs = sorted(
            self.store.data["jobs"].items(),
            key=lambda item: (item[1].get("last_recovery", 0), item[0]),
        )
        for job_id, job in jobs:
            if budget == 0:
                break
            # Every status poll already reconciles its job runtime-side, so recovery runs once
            # per watcher instance (after a restart), not on a timer that spawns and writes.
            if job["state"] in TERMINAL or job.get("final_queued") or job.get("recovery_instance") == instance:
                continue
            budget -= 1
            try:
                self._request({"op": "recover", "actor": job["actor"], "job_id": job_id})
            except PortalError as error:
                job["recovery_error"] = error.code
                self.store.error(error.code, self.clock())
                self._notice(
                    f"job:{job_id}:recovery:{error.code}", job["actor"], job["target"],
                    f"Task {job_id}: recovery is unavailable ({error.code}); no execution was replayed.", job_id,
                )
            job["last_recovery"] = self.clock()
            job["recovery_instance"] = instance
            changed = True
        if changed:
            self.store.save()

    def _poll_jobs(self) -> None:
        budget = 4
        jobs = sorted(
            self.store.data["jobs"].items(),
            key=lambda item: (item[1].get("last_poll", 0), item[0]),
        )
        crowded = sum(not job["final_queued"] for _, job in jobs) > budget
        for job_id, job in jobs:
            if budget == 0:
                break
            if job["final_queued"] or self.clock() - job["last_poll"] < 5 or self.clock() < job.get("next_poll", 0):
                continue
            budget -= 1
            before = self._job_fingerprint(job)
            try:
                response = self._request({
                    "op": "status", "actor": job["actor"], "job_id": job_id,
                    **{key: job[key] for key in ("stdout_offset", "stderr_offset", "event_offset")},
                    "limit": 4096,
                })
                returned, state, metadata = response_job(response)
                if returned != job_id:
                    raise PortalError("runtime_protocol", "Status response crossed a job boundary.")
                job.update(
                    state=state, metadata=metadata, last_poll=self.clock(),
                    worker_active=response.get("worker_active"),
                )
                old_cursors = tuple(job[key] for key in ("stdout_offset", "stderr_offset", "event_offset"))
                for key in ("stdout_offset", "stderr_offset", "event_offset"):
                    if key == "event_offset":
                        value = response.get("next_event_offset")
                    else:
                        stream = response.get(key.removesuffix("_offset"), {})
                        value = stream.get("next_offset") if isinstance(stream, dict) else None
                    if type(value) is int and value >= job[key]:
                        job[key] = value
                cursors = tuple(job[key] for key in ("stdout_offset", "stderr_offset", "event_offset"))
                if cursors != old_cursors:
                    job["output_at"] = self.clock()
                if state in TERMINAL:
                    self.outbox.supersede(job_id)
                    self._finish_timing(job, state)
                    try:
                        self._result(job_id, job, group=f"job:{job_id}:final")
                    except PortalError as error:
                        # Transient failures (a timeout, a full disk) back off with the files kept;
                        # only a result that can never render gets its text alone.
                        if not (error.code.startswith("artifact_") or error.code in ("too_many_files", "runtime_protocol")):
                            raise
                        counts = job.setdefault("fail_counts", {})
                        counts["result"] = counts.get("result", 0) + 1
                        if counts["result"] < RESULT_ATTEMPTS:
                            raise
                        self._unrenderable(job_id, job, error.code)
                    job["final_queued"] = True
                    conversation = self._conversation(job["actor"], job["target"])
                    conversation["approvals"].pop(job_id, None)
                elif state in ("queued", "running", "cancelling"):
                    self._stream(job_id, job, response)
                for key in ("fail_streak", "next_poll", "fail_counts"):
                    job.pop(key, None)
                # A poll that learned nothing new does not rewrite the journal (poll order only
                # matters for fairness when more jobs are waiting than one tick polls).
                if crowded or self._job_fingerprint(job) != before:
                    self.store.save()
            except (JournalWriteError, sqlite3.Error):
                raise
            except PortalError as error:
                self._job_failure(job_id, job, error.code)
            except Exception as error:
                if strict():
                    raise
                code = f"internal:{type(error).__name__}"
                self._quarantined.append({"kind": "job", "ref": itui.short(job_id), "code": code})
                self._job_failure(job_id, job, code)

    def _job_failure(self, job_id: str, job: dict, code: str) -> None:
        """A failed poll backs off (5 s, doubling, to POLL_BACKOFF_MAX), so a broken job cannot
        cost a spawn and a journal write every tick; a job the runtime lost, or one that keeps
        failing internally, is no longer followed."""
        now = self.clock()
        streak = job["fail_streak"] = job.get("fail_streak", 0) + 1
        job.update(last_poll=now, error=code, next_poll=now + min(5 * 2 ** min(streak, 10), POLL_BACKOFF_MAX))
        # Each kind counts on its own: a timeout or two must not make one not_found "lost".
        counts = job.setdefault("fail_counts", {})
        kind = "not_found" if code == "not_found" else "internal" if code.startswith("internal:") else None
        if kind:
            counts[kind] = counts.get(kind, 0) + 1
        self.store.error(code, now)
        if kind == "not_found" and counts[kind] >= LOST_ATTEMPTS:
            self._stop_following(job_id, job, "Its record is gone from the task runtime, so it is no longer followed.",
                                 title="Lost")
        elif kind == "internal" and counts[kind] >= INTERNAL_ATTEMPTS:
            self._stop_following(job_id, job, f"Repeated internal errors ({code[9:]}) stopped updates for this task. "
                                 "Its record is intact; use RAPP status.", title="Not followed")
        else:
            self._notice(f"job:{job_id}:error:{code}", job["actor"], job["target"],
                         f"Task {job_id}: status/result unavailable ({code}). "
                         "Its durable record remains intact; use RAPP status/resume.", job_id)

    def _stop_following(self, job_id: str, job: dict, text: str, *, title: str) -> None:
        job["final_queued"] = True
        self.outbox.supersede(job_id)
        self._conversation(job["actor"], job["target"])["approvals"].pop(job_id, None)
        self._notice(f"job:{job_id}:stopped", job["actor"], job["target"], text, job_id,
                     title=title, glyph=itui.GLYPH["error"])

    def _unrenderable(self, job_id: str, job: dict, code: str) -> None:
        """A finished task whose result cannot be rendered in full gets its text alone, or one
        card saying so, instead of being retried forever."""
        group = f"job:{job_id}:final"
        try:
            self._result(job_id, job, group=group, files=False,
                         note=f"Output files unavailable ({code}); the text follows.")
        except PortalError:
            self._notice(group, job["actor"], job["target"],
                         f"Task {job_id}: {job['state']}. Its result could not be shown here ({code}); "
                         "it remains in the local job record.", job_id,
                         title="No result", glyph=itui.GLYPH.get(job["state"], "·"))
        self.store.error(f"result_unrenderable:{code}", self.clock())

    @staticmethod
    def _job_fingerprint(job: dict) -> str:
        return json.dumps({key: job.get(key) for key in (
            "state", "stdout_offset", "stderr_offset", "event_offset", "stream", "progress",
            "started_at", "finished_at", "final_queued", "error", "worker_active", "fail_streak",
            "fail_counts",
        )}, sort_keys=True, default=str)

    def _estimate(self, job: dict, now: float) -> dict:
        started = job.get("started_at") or now
        # Only a running job can stall; a queued one is simply waiting its turn.
        running = job.get("state") == "running"
        return itui.estimate(now - started, job.get("progress"), self._history(job),
                             idle=now - (job.get("output_at") or started) if running else None,
                             active=job.get("worker_active") if running else None)

    def _updates_paused(self, now: float) -> bool:
        """A critical disk right now, or a fresh verdict that iMessage cannot deliver."""
        health = self.store.data.get("imessage_health", {})
        blocked = health.get("ok") is False and now - health.get("checked_at", 0) < 300
        return blocked or self._disk_now() == "critical"

    @staticmethod
    def _told(job: dict) -> dict:
        stream = job.get("stream") or {}
        # Jobs streamed before "told" existed start from their old flags: no false news.
        return stream.get("told") or {
            "state": job["state"], "stalled": bool(stream.get("stalled")),
            "overrun": bool(stream.get("overrun")), "quarter": itui.quarter(job.get("progress")),
        }

    def _stream(self, job_id: str, job: dict, response: dict) -> None:
        """Keep a running task's owner informed until it ends: milestones plus slot heartbeats."""
        now = self.clock()
        job.setdefault("started_at", now)
        stream = job.setdefault("stream", {"sent": 0, "last_at": 0, "quiet": False})
        elapsed = now - job["started_at"]
        progress = itui.marker(response.get("events"))
        if progress:
            job["progress"] = {**progress, "at": now}
        estimate = self._estimate(job, now)
        # A milestone is what is true now but not yet on the owner's phone, so one held back by
        # spacing or a pause is still news on the next poll. Only forward progress counts, so
        # an oscillating worker cannot drain the budget.
        told = self._told(job)
        milestone = (
            (job["state"] in ("running", "cancelling") and job["state"] != told["state"])
            or (estimate["basis"] == "stall") != told["stalled"]
            or (estimate["basis"] == "history" and estimate["remaining"] is None and not told["overrun"])
            or itui.quarter(job.get("progress")) > told["quarter"]
        )
        if self._updates_paused(now):
            # Nothing is spent while cards could not reach the phone; the next slot catches up.
            return
        if itui.due(stream, elapsed, now, milestone=milestone):
            heartbeat = elapsed >= itui.threshold(stream.get("slot", 0))
            self._job_card(f"job:{job_id}:update:{stream['sent']}", job_id, job, update=True, advance=heartbeat)
            stream["sent"] += 1
            stream["last_at"] = now
            if heartbeat:
                stream["slot"] = itui.next_slot(elapsed)

    def _finish_timing(self, job: dict, state: str) -> None:
        if job.get("finished_at"):
            return
        now = self.clock()
        started = job.get("started_at")
        job["finished_at"] = now
        if not started or state not in ("succeeded", "completed"):
            return
        duration = now - started
        history = self.store.data.setdefault("eta_history", {})
        profile = job.get("profile") or self.config.profile
        history[profile] = itui.remember(history.get(profile, []), duration)
        first = (job.get("stream") or {}).get("first_eta")
        if first:
            job["eta_error"] = round(abs(now - first) / max(duration, 1), 3)

    def _result(self, job_id: str, job: dict, *, group: str, files: bool = True, note: str | None = None) -> None:
        if self.outbox.parts(group):
            return
        response = self._request({
            "op": "result", "actor": job["actor"], "job_id": job_id,
            "stdout_offset": 0, "stderr_offset": 0, "event_offset": 0, "limit": 8192,
        })
        returned, state, metadata = response_job(response)
        if returned != job_id:
            raise PortalError("runtime_protocol", "Result response crossed a job boundary.")
        result = response.get("result")
        if state in TERMINAL and not isinstance(result, dict):
            raise PortalError("runtime_protocol", "A terminal job is missing its durable result.")
        if result is not None and not isinstance(result, dict):
            raise PortalError("runtime_protocol", "The durable result envelope is malformed.")
        result = result or {}
        if state == "succeeded" and result.get("exit_code") != 0:
            raise PortalError("runtime_protocol", "A successful task did not report a zero worker exit.")
        if state in TERMINAL:
            canonical = f"job:{job_id}:final"
            if self.outbox.parts(canonical):
                if group != canonical:
                    self._notice(
                        group, job["actor"], job["target"],
                        f"Task {job_id}: {state}.\n{output_text(response, 'stdout')[:8000]}\n"
                        f"Native output: {self.outbox.summary(job_id)}. "
                        "Existing file parts were not duplicated. Use RAPP retry for confirmed failures.",
                        job_id,
                    )
                return
            group = canonical
        exit_code = result.get("exit_code")
        text = f"{note}\n" if note else ""
        output = result.get("response") or output_text(response, "stdout")
        if not isinstance(output, str):
            raise PortalError("runtime_protocol", "The durable response must be text.")
        text += output[:8000] or "(No worker output yet.)"
        if len(output) > 8000:
            text += "\nOutput truncated here; the complete result remains in the local job record."
        if state in ("failed", "interrupted"):
            text += "\n" + output_text(response, "stderr")[:1000]
        error = result.get("error") or metadata.get("error")
        if isinstance(error, dict):
            text += f"\nTask error: {str(error.get('code') or 'unknown')[:80]}: {str(error.get('message') or '')[:300]}"
        if result.get("execution_may_continue") or metadata.get("execution_may_continue"):
            text += "\nWorker cleanup is unconfirmed; execution may continue. Local inspection is required; do not retry automatically."
        artifacts = result.get("artifacts", []) if state in TERMINAL and files else []
        if not isinstance(artifacts, list):
            raise PortalError("artifact_manifest", "The runtime artifact manifest was invalid.")
        if len(artifacts) > self.config.max_files:
            raise PortalError("too_many_files", "The job produced too many declared output files.")
        export_root = self.config.artifact_root / job_id / "artifacts"
        granted = []
        used_ids = set()
        remaining_indices = set(range(len(job["declared"])))
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                raise PortalError("artifact_manifest", "The runtime returned an invalid artifact record.")
            artifact_id = artifact.get("id")
            name = artifact.get("name")
            path_value = artifact.get("path")
            identity_match = (
                re.fullmatch(re.escape(job_id) + r":artifact:(0|[1-9][0-9]*)", artifact_id)
                if isinstance(artifact_id, str) else None
            )
            if (
                identity_match is None or len(artifact_id) > 128 or artifact_id in used_ids
                or not isinstance(name, str) or len(name) > 180 or Path(name).name != name
                or not isinstance(path_value, str)
            ):
                raise PortalError("artifact_undeclared", "An emitted artifact does not match a declared output.")
            index = int(identity_match[1])
            if index not in remaining_indices or name != Path(job["declared"][index]).name:
                raise PortalError("artifact_undeclared", "Artifact index/name does not match its approved declaration.")
            path = Path(path_value)
            expected = export_root / f"{job_id}-{index:02d}-{name}"
            if path != expected or ".." in path.parts:
                raise PortalError("artifact_unconfined", "Artifact is not an intentional snapshot in this job's export directory.")
            used_ids.add(artifact_id)
            remaining_indices.remove(index)
            granted.append({
                **artifact, "relative_path": path.name,
                "mime": artifact.get("mime") or mimetypes.guess_type(name)[0] or "application/octet-stream",
            })
        if files and (artifacts or state == "succeeded") and remaining_indices:
            raise PortalError("artifact_missing", "The runtime did not publish the complete declared artifact batch.")
        took = job.get("finished_at", self.clock()) - job["started_at"] if job.get("started_at") else None
        title = {
            "succeeded": "Done", "completed": "Done", "failed": "Failed", "cancelled": "Stopped",
            "canceled": "Stopped", "interrupted": "Interrupted", "expired": "Expired",
        }.get(state, "Output so far")
        if took is not None and state in TERMINAL:
            title += f" · {itui.span(took)}"
        options, commands = itui.menu("final" if state in TERMINAL else "running", job_id)
        files = f" · {len(granted)} file(s) follow" if granted else ""
        card = itui.card(
            itui.header(itui.short(job_id), itui.GLYPH.get(state, "·"), title),
            top=[f"worker exit {exit_code if exit_code is not None else 'unknown'}", *([files[3:]] if files else [])],
            body=[job.get("label") or f"Task {job_id}", *text.splitlines()],
            options=options, footer=f"not a receipt · ref {token(f'{group}:0')[:6]}",
        )
        self.outbox.enqueue(
            group, job["actor"], job["target"], card, artifacts=granted,
            workspace=export_root, declared=tuple(item["relative_path"] for item in granted), job_id=job_id,
            menu=commands, menu_kind="final" if state in TERMINAL else "running",
        )

    def _delivery_attention(self) -> None:
        for part in list(self.store.data["outbox"]):
            if (
                part["state"] not in ("failed", "unknown") or not part.get("job_id")
                or part["group"].startswith("transport-attention:") or part.get("card") == "progress"
            ):
                continue
            if (
                part["state"] == "unknown"
                and self.clock() - part["submitted_at"] < self.config.receipt_seconds
            ):
                continue
            if part["state"] == "unknown":
                action = (
                    "Do not assume receipt. Check your phone first; "
                    f"RAPP resend {part['id']} explicitly risks a duplicate of this part only."
                )
            elif part.get("retryable"):
                action = f"Use RAPP retry {part['job_id']}; successful parts will not be repeated."
            else:
                action = "The file or route failed validation. Use RAPP status; repair the local cause before a new request."
            self._notice(
                f"transport-attention:{part['id']}:{part['attempt']}", part["actor"], part["target"],
                f"Task {part['job_id']}: output part {part['id']} is {part['state']} "
                f"({part.get('error', 'unconfirmed')}). {action}", part["job_id"],
            )
