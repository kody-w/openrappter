"""A bounded tick called by the existing watcher, not a second responder daemon."""

from __future__ import annotations

import hashlib
import shutil
import json
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
from .files import copy_reference, filename, regular_file
from .outbox import Outbox, token
from .source import SQLiteSource
from .state import Store


ADDRESS = re.compile(r"^\s*rapp(?:\s*:\s*|\s+|$)", re.IGNORECASE)
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
    "1. Approve the single pending task\n2. Cancel it\n"
    "Numbers work only for the same sender/thread and unexpired approval. "
    "After an intervening message, explicitly use RAPP 1 / RAPP 2 or RAPP approve <job-id>. "
    "With multiple pending tasks, use RAPP approve <job-id>.\n"
    "RAPP status / list / result / stop / resume [job-id]\n"
    "RAPP retry <job-id> — retry only confirmed failed output parts.\n"
    "RAPP resend <part-id> — deliberately resend one uncertain part after checking your phone.\n"
    "RAPP clear files — discard the pending input selection.\n"
    "Loop updates: a bare reply right after an update answers it (numbers pick its options). "
    "RAPP reply <text> answers the latest open update even after other messages.\n"
    "Cards end with [n] options: reply the digit right under a card, or RAPP <n> after other "
    "messages (an open approval card keeps 1/2). Running tasks keep sending ETA updates.\n"
    "RAPP quiet [job] stops a task's automatic updates; its result still comes.\n"
    "Short refs work as job ids: the 4 characters in [RAPP 9c1e].\n"
    "Other conversation belongs to other AIs. Unprefixed wake/restart/shutdown remains Claude's."
)


class AwaitingInputs(Exception):
    pass


def addressed(text: str) -> bool:
    return bool(ADDRESS.match(text))


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


class Portal:
    def __init__(self, config: Config, *, source=None, runtime=None, native=None, clock=time.time):
        self.config = config
        self.source = source
        self.runtime = runtime or RuntimeClient(config)
        self.native = native or NativeClient(config)
        self.clock = clock
        self.store: Store
        self.outbox: Outbox

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

    def _conversation(self, actor: dict, target: dict) -> dict:
        key = token(actor["sender"] + "\0" + actor["chat"] + "\0" + target.get("roster_hash", ""))
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
        self.outbox.enqueue(key, actor, target, text, job_id=job_id, menu=commands)

    def _job_card(self, key: str, job_id: str, job: dict, *, update: bool = False) -> None:
        """A running task's live card: status and ETA on line one, then its options."""
        now = self.clock()
        stream = job.setdefault("stream", {"sent": 0, "last_at": 0, "quiet": False})
        started = job.setdefault("started_at", now)
        estimate = itui.estimate(now - started, job.get("progress"), self._history(job))
        state = job["state"]
        status = {"queued": "Queued", "cancelling": "Stopping"}.get(state, estimate["status"])
        top = []
        if estimate["fraction"] is not None:
            top.append(itui.bar(estimate["fraction"]) + (" est" if estimate["basis"] == "history" else ""))
        top.append(estimate["detail"])
        kind = "cancelling" if state == "cancelling" else "quiet" if stream.get("quiet") else "running"
        options, commands = itui.menu(kind, job_id)
        if stream.get("quiet"):
            upcoming = "result only"
        elif stream["sent"] >= itui.MAX_UPDATES - 1 and update:
            upcoming = "result next"
        else:
            upcoming = "next ~" + itui.span(max(60, started + itui.next_heartbeat(stream["sent"] + update) - now))
        text = itui.card(
            itui.header(itui.short(job_id), itui.GLYPH.get(state, "●"), status), top=top,
            body=[job.get("label") or f"Task {job_id}"], options=options,
            footer=f"{upcoming} · ref {token(f'{key}:0')[:6]}",
        )
        if estimate["remaining"] and not stream.get("first_eta"):
            stream["first_eta"] = now + estimate["remaining"]
        if update:
            self.outbox.supersede(job_id)
        self.outbox.enqueue(key, job["actor"], job["target"], text, job_id=job_id, menu=commands,
                            card="progress" if update else None)

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
        self.outbox.enqueue(key, *route, text, menu=commands)

    def _resources(self) -> None:
        """Free-space preflight: warn once per level, refuse new tasks when critical."""
        usage = shutil.disk_usage(self.config.state_dir)
        free_gib, percent = usage.free / 2**30, 100 * usage.free / max(usage.total, 1)
        level = "critical" if free_gib < 2 or percent < 2 else "low" if free_gib < 10 or percent < 5 else "ok"
        info = self.store.data.setdefault("resources", {})
        now = self.clock()
        info["free_gib"], info["free_pct"] = round(free_gib, 1), round(percent, 1)
        if level == info.get("level", "ok") and (level == "ok" or now - info.get("alerted_at", 0) < 6 * 3600):
            return
        info["level"] = level
        if level != "ok":
            info["alerted_at"] = now
            self._system_card(
                f"sys:disk:{level}:{int(now)}", itui.GLYPH["attention"], f"Disk {level}",
                [f"{free_gib:.1f} GB free ({percent:.0f}%)",
                 "new tasks paused until space frees" if level == "critical" else "free space soon"],
            )
        self.store.save()

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

    def _heartbeat(self) -> None:
        """Touch a tiny file per successful tick; a long gap means ticks failed or stopped."""
        path = self.config.state_dir / "heartbeat"
        now = self.clock()
        try:
            last = path.stat().st_mtime
        except FileNotFoundError:
            last = None
        if last is not None and now - last >= 300:
            self._system_card(f"sys:gap:{int(last)}", itui.GLYPH["succeeded"], "Back online",
                              [f"no ticks for {itui.span(now - last)}", "check RAPP health"])
            self.store.save()
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        os.utime(path, (now, now))

    def _compact(self) -> None:
        """Hourly: drop settled records that are old and past the reader's late window."""
        data, now = self.store.data, self.clock()
        if now - data.get("compacted_at", 0) < 3600:
            return
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
            f"Disk: {resources.get('free_gib', '?')} GB free · {resources.get('level', 'ok')}",
            f"Journal: {journal // 1024} KB",
            "Outbox: " + (", ".join(f"{count} {state}" for state, count in sorted(states.items())) or "empty"),
        ]
        if health.get("hint"):
            lines.append(health["hint"])
        options, commands = itui.menu("system")
        text = itui.card(itui.header("sys", itui.GLYPH["info"], "Health"), body=lines, options=options,
                         footer=f"ref {token(f'{key}:0')[:6]}")
        self.outbox.enqueue(key, actor, target, text, menu=commands)

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
                self._resources()
                self._recover_jobs()
                self.outbox.pump(reconcile_only=True)
                feed.refresh(store, self.clock())
                approvals = [
                    (identity, record) for identity, record in store.data["inbox"].items()
                    if record["state"] == "runtime_pending" and record.get("approval_attempt")
                ]
                for identity, record in approvals[:self.config.events_per_tick]:
                    self._advance(identity, record)
                events = self.source.poll(store.data["cursor"], store.data["floor"])
                for event in events:
                    before = store.data["cursor"]
                    identity = self._ingest(event)
                    if identity is not None:
                        self._advance(identity, store.data["inbox"][identity])
                    store.data["cursor"] = max(before, event["id"])
                    # Re-read late-window rows that changed nothing must not rewrite the journal.
                    if store.data["cursor"] != before or identity is not None:
                        store.save()
                pending = [
                    (identity, record) for identity, record in store.data["inbox"].items()
                    if record["state"] in ("decoding", "receiving", "ready", "runtime_pending")
                ]
                for identity, record in pending[:self.config.events_per_tick]:
                    if record["state"] in ("decoding", "receiving", "ready", "runtime_pending"):
                        self._advance(identity, record)
                self._poll_jobs()
                self.outbox.pump()
                feed.refresh(store, self.clock())
                self._outage_report()
                self._delivery_attention()
                self._compact()
                self._heartbeat()
                failures = sum(
                    p["state"] in ("failed", "unknown") for p in store.data["outbox"]
                )
                return {
                    "ok": failures == 0, "events_observed": len(events),
                    "pending_inputs": sum(
                        r["state"] in ("decoding", "receiving", "ready", "runtime_pending")
                        for r in store.data["inbox"].values()
                    ),
                    "delivery_attention": failures,
                    "jobs": len(store.data["jobs"]),
                }
        finally:
            if own_source:
                self.source.close()
                self.source = None

    def _ingest(self, event: dict) -> str | None:
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
        # Messages may represent an attachment-only body with U+FFFC.
        text = str(event.get("text") or "").replace("\ufffc", "")
        conversation = self._conversation(actor, target)
        previous = self.store.data["inbox"].get(identity, {})
        match = ADDRESS.match(text)
        body = text[match.end():].strip() if match else ""
        has_files = event.get("has_attachments") is True or bool(event.get("attachments"))
        numeric = text.strip() in ("1", "2") and any(
            value["expires_at"] > self.clock() for value in conversation["approvals"].values()
        )
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
            answered = feed.capture(self.store, event, actor, body[5:].strip(), self.clock(), explicit=True)
            self._remember_reply(identity, event, actor, target, "feed_reply")
            self._notice(
                f"feed-reply:{identity}", actor, target,
                "Got it." if answered else "There is no open update to answer right now.",
            )
            return
        menu_pick = None
        if not match and not capture:
            # Adjacency decides ownership in a thread shared with other AIs: a reply directly
            # under an open card answers it, even a bare number while an approval waits.
            prior = []

            def before():
                if not prior:
                    prior.append(self.source.latest_prior_guid(event))
                return prior[0]

            if feed.capture(self.store, event, actor, text, self.clock(), prior=before):
                self._remember_reply(identity, event, actor, target, "feed_reply")
                return
            digit = re.fullmatch(r"[1-9]", text.strip())
            part = self.outbox.menu_part(before(), actor, self.clock()) if digit else None
            if part and int(digit.group()) <= len(part["menu"]):
                menu_pick = {"group": part["group"], "n": int(digit.group())}
            elif not numeric:
                return
        if len(text) > 65536:
            self._notice(f"input:{identity}:large", actor, target, "RAPP message exceeds the 64 KiB limit.")
            return
        if menu_pick:
            body = self.outbox.parts(menu_pick["group"])[0]["menu"][menu_pick["n"] - 1]
        elif numeric:
            body = text.strip()
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
        if (
            record.get("explicit_address") and re.fullmatch(r"[1-9]", command) and not argument
            and not (command in ("1", "2") and conversation["approvals"])
        ):
            # RAPP <n>: the latest open card's option, after other messages intervened.
            part = self.outbox.latest_menu(actor, self.clock())
            if not part or int(command) > len(part["menu"]):
                raise PortalError("no_open_menu", "No open card offers that number. Use RAPP status or RAPP list.")
            chosen = part["menu"][int(command) - 1]
            record["menu_pick"] = {"group": part["group"], "n": int(command)}
            if chosen in ("1", "2"):
                self._approve_or_cancel(identity, record, conversation, chosen, "")
                return
            record["body"] = chosen
            self._command(identity, record)
            return
        if command in ("1", "2", "approve"):
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
                if state in ("queued", "running", "cancelling") and job.get("started_at"):
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
        if self.store.data.get("resources", {}).get("level") == "critical":
            raise PortalError("disk_low", "Disk space is critically low; free space before new tasks. Status and stop still work.")
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
                    "Numbers apply only right under this card with one pending task.",
                    f"Otherwise: RAPP approve {itui.short(job_id)}.",
                ],
                options=options, footer=f"ref {token(f'{group}:0')[:6]}",
            )
            self.outbox.enqueue(group, record["actor"], record["target"], card, job_id=job_id, menu=commands)
        else:
            self._notice(f"job:{job_id}:submitted", record["actor"], record["target"],
                         f"Task {job_id}: {state}. No new execution was authorized by this receipt.", job_id)
        self.store.save()

    def _approve_or_cancel(self, identity, record, conversation, command, argument) -> None:
        valid = {
            key: value for key, value in conversation["approvals"].items()
            if value["expires_at"] > self.clock()
        }
        if command in ("1", "2"):
            if len(valid) != 1:
                raise PortalError("approval_ambiguous", "Numbers require exactly one unexpired pending task in this thread.")
            job_id, approval = next(iter(valid.items()))
            notices = self.outbox.parts(approval["notice_group"])
            if (
                not notices or not notices[-1].get("guid")
                or not all(p["state"] in ("sent", "delivered") for p in notices)
            ):
                raise PortalError("approval_notice_unconfirmed", "Use RAPP approve <job-id> while the approval notice receipt is unconfirmed.")
            if (
                not record.get("explicit_address")
                and self.source.latest_prior_guid(record["event"]) != notices[-1].get("guid")
            ):
                raise PortalError(
                    "approval_context_changed",
                    "Another message intervened after the approval card. Use RAPP 1 / RAPP 2 or RAPP approve <job-id> explicitly.",
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
            job["started_at"] = self.clock()
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
            if job["state"] in TERMINAL or (
                job.get("recovery_instance") == instance
                and self.clock() - job.get("last_recovery", 0) < 60
            ):
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
        for job_id, job in jobs:
            if budget == 0:
                break
            if job["final_queued"] or self.clock() - job["last_poll"] < 5:
                continue
            budget -= 1
            try:
                response = self._request({
                    "op": "status", "actor": job["actor"], "job_id": job_id,
                    **{key: job[key] for key in ("stdout_offset", "stderr_offset", "event_offset")},
                    "limit": 4096,
                })
                returned, state, metadata = response_job(response)
                if returned != job_id:
                    raise PortalError("runtime_protocol", "Status response crossed a job boundary.")
                changed = state != job["state"]
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
                    self._result(job_id, job, group=f"job:{job_id}:final")
                    job["final_queued"] = True
                    conversation = self._conversation(job["actor"], job["target"])
                    conversation["approvals"].pop(job_id, None)
                elif state in ("queued", "running", "cancelling"):
                    self._stream(job_id, job, changed, response)
                self.store.save()
            except PortalError as error:
                job["last_poll"] = self.clock()
                job["error"] = error.code
                self.store.error(error.code, self.clock())
                self._notice(f"job:{job_id}:error:{error.code}", job["actor"], job["target"],
                             f"Task {job_id}: status/result unavailable ({error.code}). "
                             "Its durable record remains intact; use RAPP status/resume.", job_id)

    def _stream(self, job_id: str, job: dict, changed: bool, response: dict) -> None:
        """Keep a running task's owner informed until it ends: milestones plus backoff heartbeats."""
        now = self.clock()
        job.setdefault("started_at", now)
        stream = job.setdefault("stream", {"sent": 0, "last_at": 0, "quiet": False})
        milestone = changed and job["state"] in ("running", "cancelling")
        progress = itui.marker(response.get("events"))
        if progress:
            before = job.get("progress")
            job["progress"] = {**progress, "at": now}
            quarter = lambda value: int(4 * value["done"] / value["total"])  # noqa: E731
            milestone = milestone or bool(before and quarter(before) != quarter(progress))
        estimate = itui.estimate(now - job["started_at"], job.get("progress"), self._history(job))
        if estimate["basis"] == "history" and estimate["remaining"] is None and not stream.get("overrun"):
            stream["overrun"] = milestone = True
        if self.store.data.get("resources", {}).get("level") == "critical":
            return
        if itui.due(stream, now - job["started_at"], now, milestone=milestone):
            self._job_card(f"job:{job_id}:update:{stream['sent']}", job_id, job, update=True)
            stream["sent"] += 1
            stream["last_at"] = now

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

    def _result(self, job_id: str, job: dict, *, group: str) -> None:
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
        text = ""
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
        artifacts = result.get("artifacts", []) if state in TERMINAL else []
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
        if (artifacts or state == "succeeded") and remaining_indices:
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
            menu=commands,
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
