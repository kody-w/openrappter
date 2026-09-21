"""A bounded tick called by the existing watcher, not a second responder daemon."""

from __future__ import annotations

import hashlib
import json
import math
import mimetypes
import os
import re
import time
from datetime import datetime
from pathlib import Path

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
    "RAPP files image.png,clip.mp4 | <task> requests several. Filenames do not grant new permissions.\n"
    "RAPP attach — arm a bounded file-only upload window (10 minutes by default). "
    "Then send photos, video, audio, or files and request a task. "
    "A message with RAPP + files also works. Files are never executed by receiving them.\n"
    "This route transfers media files; it does not automatically transcribe voice, analyze video, "
    "or provide a continuous livestream. Content processing needs an approved task and suitable configured tools.\n"
    "1. Approve the single pending task\n2. Cancel it\n"
    "Numbers work only for the same sender/thread and unexpired approval. "
    "An intervening message requires RAPP approve <job-id> instead. "
    "With multiple pending tasks, use RAPP approve <job-id>.\n"
    "RAPP status / list / result / stop / resume [job-id]\n"
    "RAPP retry <job-id> — retry only confirmed failed output parts.\n"
    "RAPP resend <part-id> — deliberately resend one uncertain part after checking your phone.\n"
    "RAPP clear files — discard the pending input selection.\n"
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
        return self.store.data["conversations"].setdefault(key, {
            "actor": dict(actor), "target": dict(target), "files": [], "files_expire": 0,
            "capture_until": 0, "approvals": {}, "latest_job": None,
        })

    def _notice(self, key: str, actor: dict, target: dict, text: str, job_id=None) -> None:
        self.outbox.enqueue(key, actor, target, text, job_id=job_id)

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
                self._recover_jobs()
                self.outbox.pump(reconcile_only=True)
                approvals = [
                    (identity, record) for identity, record in store.data["inbox"].items()
                    if record["state"] == "runtime_pending" and record.get("approval_attempt")
                ]
                for identity, record in approvals[:self.config.events_per_tick]:
                    self._advance(identity, record)
                events = self.source.poll(store.data["cursor"], store.data["floor"])
                for event in events:
                    identity = self._ingest(event)
                    if identity is not None:
                        self._advance(identity, store.data["inbox"][identity])
                    store.data["cursor"] = max(store.data["cursor"], event["id"])
                    store.save()
                pending = [
                    (identity, record) for identity, record in store.data["inbox"].items()
                    if record["state"] in ("receiving", "ready", "runtime_pending")
                ]
                for identity, record in pending[:self.config.events_per_tick]:
                    if record["state"] in ("receiving", "ready", "runtime_pending"):
                        self._advance(identity, record)
                self._poll_jobs()
                self.outbox.pump()
                self._delivery_attention()
                failures = sum(
                    p["state"] in ("failed", "unknown") for p in store.data["outbox"]
                )
                return {
                    "ok": failures == 0, "events_observed": len(events),
                    "pending_inputs": sum(
                        r["state"] in ("receiving", "ready", "runtime_pending")
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
        # Messages may represent an attachment-only body with U+FFFC.
        text = str(event.get("text") or "").replace("\ufffc", "")
        conversation = self._conversation(actor, target)
        match = ADDRESS.match(text)
        body = text[match.end():].strip() if match else ""
        has_files = event.get("has_attachments") is True or bool(event.get("attachments"))
        numeric = text.strip() in ("1", "2") and bool(conversation["approvals"])
        capture = not text.strip() and has_files and conversation["capture_until"] >= self.clock()
        if not match and not numeric and not capture:
            return
        if len(text) > 65536:
            self._notice(f"input:{identity}:large", actor, target, "RAPP message exceeds the 64 KiB limit.")
            return
        if numeric:
            body = text.strip()
        record = {
            "event": dict(event), "actor": actor, "target": target, "body": body,
            "state": "receiving" if has_files else "ready",
            "capture": capture or (has_files and body.casefold() in ("", "attach")),
            "first_seen": self.clock(), "deadline": self.clock() + self.config.readiness_seconds,
            "observations": {}, "staged": {}, "has_files": has_files,
        }
        self.store.data["inbox"][identity] = record
        self.store.save()
        return identity

    def _advance(self, identity: str, record: dict) -> None:
        try:
            if self.authorize(record["event"]) != record["actor"]:
                record.update(state="failed", error="authorization_changed")
                self.store.save()
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
                if len(conversation["files"]) + len(references) > self.config.max_files:
                    raise PortalError("too_many_files", "Too many pending files; use RAPP clear files.")
                conversation["files"].extend(references)
                conversation["files_expire"] = self.clock() + self.config.attachment_window_seconds
                conversation["capture_until"] = conversation["files_expire"]
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
            self.store.error(error.code, self.clock())
            self._notice(
                f"input:{identity}:error", record["actor"], record["target"],
                f"RAPP could not complete this request ({error.code}): {error}. "
                "Use RAPP status to check any existing job. For failed intake, fix the cause and resend the task.",
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
        identity = identity or conversation.get("latest_job")
        job = self.store.data["jobs"].get(identity)
        if not job or job["actor"] != actor:
            raise PortalError("job_not_in_thread", "No matching RAPP job belongs to this sender and thread.")
        if job["target"].get("roster_hash") != conversation["target"].get("roster_hash"):
            raise PortalError("job_audience_changed", "This job belongs to an earlier group roster. Prepare a new task for this group.")
        return identity, job

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
                files=[], files_expire=0,
                capture_until=self.clock() + self.config.attachment_window_seconds,
            )
            self._notice(f"input:{identity}:attach", actor, target,
                         "RAPP file intake is armed for this sender/thread. Send files, then RAPP <task>. "
                         "File receipt alone never executes anything.")
            return
        if body.casefold() == "clear files":
            self._clear_capture(record["actor"])
            conversation.update(files=[], files_expire=0, capture_until=0)
            self._notice(f"input:{identity}:cleared", actor, target, "Pending RAPP file selection cleared.")
            return
        if command in ("1", "2", "approve"):
            self._approve_or_cancel(identity, record, conversation, command, argument)
            return
        if command in ("file", "files"):
            names_text, separator, prompt = argument.partition("|")
            names = [name.strip() for name in names_text.split(",")]
            if (
                not separator or not prompt.strip() or not names
                or len(names) > min(16, self.config.max_files)
                or (command == "file" and len(names) != 1) or len(set(names)) != len(names)
                or any(
                    not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._ -]{0,119}", name)
                    or ".." in name or Path(name).suffix.casefold() not in OUTPUT_EXTENSIONS
                    for name in names
                )
            ):
                raise PortalError(
                    "output_name_invalid",
                    "Use RAPP file report.txt | task, with a bounded passive media/document basename, not a path or flag.",
                )
            record["requested_artifacts"] = names
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
                self._job_for_actor(argument, actor, conversation)
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
                self._notice(f"input:{identity}:{operation}", actor, target,
                             f"Task {job_id}: {state}. Native output: {self.outbox.summary(job_id)}.", job_id)
            return
        if command == "resend":
            part = next(
                (p for p in self.store.data["outbox"] if p["id"] == argument and p["actor"] == actor),
                None,
            )
            if not part or not part.get("job_id"):
                raise PortalError("part_not_in_thread", "No uncertain result part belongs to this thread.")
            count = self.outbox.retry(actor, part["job_id"], uncertain_part=argument)
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
            waiting = record.setdefault("waiting_inputs", [
                key for key, other in self.store.data["inbox"].items()
                if other["actor"] == record["actor"] and other["capture"]
                and other["event"]["id"] < record["event"]["id"] and other["state"] == "receiving"
            ])
            if any(self.store.data["inbox"][key]["state"] in ("failed", "cancelled") for key in waiting):
                raise PortalError("attachment_failed", "A selected upload failed or was cleared. Resend the file and task.")
            if any(self.store.data["inbox"][key]["state"] != "done" for key in waiting):
                self._notice(
                    f"input:{identity}:waiting-inputs", record["actor"], record["target"],
                    "Your RAPP task is waiting for the preceding selected uploads. It has not run.",
                )
                raise AwaitingInputs
            references = [
                record["staged"][key] for key in sorted(record["staged"], key=int)
            ]
            if conversation["files_expire"] >= self.clock():
                references = [*conversation["files"], *references]
            if len(references) > self.config.max_files:
                raise PortalError("too_many_files", "Too many selected files; use RAPP clear files.")
            record["submission"] = {
                "op": "submit", "actor": record["actor"], "request_id": f"imessage-{identity}",
                "prompt": prompt, "profile": self.config.profile,
                "attachments": references,
                "artifact_paths": record.get("requested_artifacts", list(self.config.artifact_paths)),
            }
            self.store.save()
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
        })
        conversation.update(latest_job=job_id, files=[], files_expire=0, capture_until=0)
        approval = response.get("approval")
        if isinstance(approval, dict) and approval.get("token"):
            expiry = timestamp(approval.get("expires_at"))
            if not math.isfinite(expiry) or expiry <= self.clock():
                raise PortalError("approval_expired", "The task approval has already expired.")
            group = f"job:{job_id}:approval"
            conversation["approvals"][job_id] = {
                "token": str(approval["token"]), "expires_at": expiry, "notice_group": group,
            }
            self._notice(
                group, record["actor"], record["target"],
                f"Task {job_id} prepared; NOT running.\nProfile: {record['submission']['profile']}; model: gpt-6-astra\n"
                f"Available tools: {', '.join(policy['available_tools']) or 'none'}\n"
                f"Allow grants: {', '.join(policy.get('allow_tools', [])) or 'none'}\n"
                f"Deny grants: {', '.join(policy.get('deny_tools', [])) or 'runtime deny-by-default'}\n"
                f"Extra directories: {', '.join(policy.get('add_dirs', [])) or 'isolated job workspace only'}\n"
                f"URL grants: {', '.join(policy.get('allow_urls', [])) or 'none'}\n"
                f"{prompt[:700]}\nInputs: {len(record['submission']['attachments'])}; "
                f"declared outputs: {', '.join(record['submission']['artifact_paths']) or 'text only'}.\n"
                "1. Approve\n2. Cancel\n"
                "Numbers apply only when this thread has one unexpired pending task. "
                f"Otherwise: RAPP approve {job_id}. Approval expires in {max(0, int(expiry-self.clock()))}s.",
                job_id,
            )
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
            if self.source.latest_prior_guid(record["event"]) != notices[-1].get("guid"):
                raise PortalError(
                    "approval_context_changed",
                    "Another message intervened after the approval card. Use RAPP approve <job-id> to select it explicitly.",
                )
        else:
            job_id = argument
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
        self._notice(f"input:{identity}:approved", record["actor"], record["target"],
                     f"Task {job_id}: {state}. Use RAPP status / stop / result.", job_id)

    def _recover_jobs(self) -> None:
        instance = os.environ.get("RAPP_PORTAL_WATCHER_INSTANCE", "manual")
        changed = instance != self.store.data.get("watcher_instance")
        self.store.data["watcher_instance"] = instance
        budget = 4
        for job_id, job in self.store.data["jobs"].items():
            if budget == 0:
                break
            if job["state"] in TERMINAL or (
                not changed and self.clock() - job.get("last_recovery", 0) < 60
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
        self.store.save()

    def _poll_jobs(self) -> None:
        budget = 4
        for job_id, job in self.store.data["jobs"].items():
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
                if state in TERMINAL:
                    self._result(job_id, job, group=f"job:{job_id}:final")
                    job["final_queued"] = True
                    conversation = self._conversation(job["actor"], job["target"])
                    conversation["approvals"].pop(job_id, None)
                elif (
                    state in ("queued", "running", "cancelling")
                    and (changed or cursors != old_cursors)
                    and self.clock() - job["last_notice"] >= self.config.progress_seconds
                ):
                    self._notice(
                        f"job:{job_id}:progress:{state}:{cursors}", job["actor"], job["target"],
                        f"Task {job_id}: {state}; retained stdout {job['stdout_offset']} bytes, "
                        f"stderr {job['stderr_offset']} bytes, event cursor {job['event_offset']}. "
                        "Use RAPP result for bounded output.", job_id,
                    )
                    job["last_notice"] = self.clock()
                self.store.save()
            except PortalError as error:
                job["last_poll"] = self.clock()
                job["error"] = error.code
                self.store.error(error.code, self.clock())
                self._notice(f"job:{job_id}:error:{error.code}", job["actor"], job["target"],
                             f"Task {job_id}: status/result unavailable ({error.code}). "
                             "Its durable record remains intact; use RAPP status/resume.", job_id)

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
        text = (
            f"Task {job_id}: {state}; worker exit {exit_code if exit_code is not None else 'unknown'}. "
            "This is worker state, not a delivery receipt.\n"
        )
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
        self.outbox.enqueue(
            group, job["actor"], job["target"], text, artifacts=granted,
            workspace=export_root, declared=tuple(item["relative_path"] for item in granted), job_id=job_id,
        )

    def _delivery_attention(self) -> None:
        for part in list(self.store.data["outbox"]):
            if (
                part["state"] not in ("failed", "unknown") or not part.get("job_id")
                or part["group"].startswith("transport-attention:")
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
