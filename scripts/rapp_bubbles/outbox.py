"""Per-part durable submission and exact-chat receipt correlation."""

from __future__ import annotations

import hashlib
import re
from datetime import datetime
from pathlib import Path
from typing import Callable

from .clients import NotSubmitted, SubmissionUnknown
from .config import Config, PortalError, normalized
from . import itui
import sqlite3

from .state import JournalWriteError, strict
from .files import copy_reference, filename
from .state import Store


ACCEPTED = {"submitted", "sent", "delivered"}


STALE_RECEIPT_SECONDS = 86400


def token(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:24]


class Outbox:
    def __init__(
        self, config: Config, store: Store, native, clock: Callable[[], float],
        target_matches: Callable[[dict], bool], watermark: Callable[[], int] | None = None,
    ):
        self.config, self.store, self.native = config, store, native
        self.clock, self.target_matches = clock, target_matches
        self.watermark = watermark or (lambda: 0)

    def parts(self, group: str) -> list[dict]:
        return [part for part in self.store.data["outbox"] if part["group"] == group]

    def enqueue(
        self, group: str, actor: dict, target: dict, text: str, *,
        artifacts: list[dict] | None = None, workspace: Path | None = None,
        declared: tuple[str, ...] = (), job_id: str | None = None,
        menu: list[str] | None = None, card: str | None = None, menu_kind: str | None = None,
    ) -> None:
        if self.parts(group):
            return
        pieces = [text[i:i + 2400] for i in range(0, len(text), 2400)]
        # iTUI cards arrive already framed with their "[RAPP …] status" first line.
        framed = text.startswith("[RAPP ")
        extra = {"card": card} if card else {}
        if menu:
            # Every part of the group carries the menu, so a reply under any bubble resolves.
            extra.update(menu=list(menu), menu_kind=menu_kind or "notice")
        if framed and len(pieces) > 1:
            # Piece one needs its own unique line too: exact-text receipts must never collide.
            head, _, rest = pieces[0].partition("\n")
            pieces[0] = f"{head}\n⋯ 1/{len(pieces)} · ref {token(f'{group}:0')[:6]}" + (f"\n{rest}" if rest else "")
        prepared = []
        staged = []
        try:
            for index, body in enumerate(pieces):
                identity = token(f"{group}:{index}")
                if not framed:
                    body = f"[RAPP {identity}]\n{body}"
                elif index:
                    body = f"[RAPP {identity[:6]}] ⋯ {index + 1}/{len(pieces)}\n{body}"
                prepared.append(self._part(group, index, identity, actor, target, job_id, text=body, **extra))
            for artifact in artifacts or []:
                if (
                    not isinstance(artifact, dict)
                    or not isinstance(artifact.get("path"), str)
                    or not isinstance(artifact.get("relative_path"), str)
                ):
                    raise PortalError("artifact_manifest", "Artifact path metadata is invalid.")
                if workspace is None:
                    raise PortalError("artifact_unconfined", "No approved job workspace was supplied.")
                try:
                    workspace_relative = workspace.relative_to(self.config.artifact_root)
                except ValueError as error:
                    raise PortalError("artifact_unconfined", "Job workspace is outside the local job store.") from error
                if workspace == self.config.artifact_root:
                    raise PortalError("artifact_unconfined", "A job-specific workspace is required.")
                if not job_id or workspace_relative.parts[0] != job_id:
                    raise PortalError("artifact_unconfined", "Artifact workspace belongs to a different job.")
                relative = Path(artifact["relative_path"])
                if relative.is_absolute() or ".." in relative.parts or relative.as_posix() not in declared:
                    raise PortalError("artifact_undeclared", "Job output was not deliberately declared for delivery.")
                source = workspace / relative
                if Path(artifact["path"]) != source:
                    raise PortalError("artifact_unconfined", "Artifact path does not match its approved workspace.")
                checksum = artifact.get("sha256", "")
                size = artifact.get("size_bytes")
                if (
                    not isinstance(checksum, str) or not re.fullmatch(r"[a-f0-9]{64}", checksum)
                    or type(size) is not int or size < 0
                ):
                    raise PortalError("artifact_manifest", "Artifact lacks a validated size or SHA-256.")
                index = len(prepared)
                identity = token(f"{group}:{index}")
                display_name = filename(artifact.get("name") or relative.name)
                if Path(display_name).suffix.casefold() != relative.suffix.casefold():
                    display_name = filename(relative.name)
                destination = (
                    self.config.state_dir / "outbox" / identity
                    / f"rapp-{identity}-{display_name}"
                )
                try:
                    reference = copy_reference(
                        source, (workspace,), destination, self.config.max_file_bytes,
                        expected_sha256=checksum, expected_size=size,
                    )
                except FileNotFoundError as error:
                    raise PortalError("artifact_missing", "A declared output file is gone from the job's export.") from error
                staged.append(destination)
                prepared.append(self._part(
                    group, index, identity, actor, target, job_id,
                    file=reference, mime=str(artifact.get("mime") or "application/octet-stream"),
                    caption=f"[RAPP artifact {identity}]\n{display_name}", **extra,
                ))
            self.store.data["outbox"].extend(prepared)
            self.store.save()
        except Exception:
            for path in staged:
                path.unlink(missing_ok=True)
            raise

    def _part(self, group, index, identity, actor, target, job_id, **content) -> dict:
        return {
            "id": identity, "group": group, "index": index, "actor": dict(actor),
            "target": dict(target), "job_id": job_id, "state": "queued",
            "created_at": self.clock(), "attempt": 0, "attempts": [], **content,
        }

    def _allowed(self, part: dict) -> bool:
        actor = part["actor"]
        return (
            actor["chat"] == part["target"]["chat_guid"]
            and any(r.sender == normalized(actor["sender"]) and r.chat == actor["chat"] for r in self.config.routes)
            and self.target_matches(part["target"])
        )

    @staticmethod
    def _matches(part: dict, message: dict) -> bool:
        if (
            message.get("is_from_me") is not True
            or message.get("chat_id") != part["target"]["chat_id"]
            or message.get("chat_guid") != part["target"]["chat_guid"]
            or not message.get("guid")
            or type(message.get("id")) is not int
            or message["id"] <= part.get("send_after_rowid", 0)
        ):
            return False
        try:
            created = datetime.fromisoformat(message["created_at"].replace("Z", "+00:00")).timestamp()
            if not part["receipt_created_after"] <= created < part["receipt_created_before"]:
                return False
        except (KeyError, TypeError, ValueError, AttributeError):
            return False
        if "file" not in part:
            return message.get("text") == part["text"]
        expected = Path(part["file"]["path"]).name
        return any(
            any(Path(str(att.get(key) or "")).name == expected for key in (
                "transfer_name", "filename", "original_path"
            ))
            for att in message.get("attachments", [])
            if isinstance(att, dict)
        )

    def reconcile(self, part: dict) -> None:
        if not self._allowed(part):
            raise PortalError("route_changed", "The original authorized chat is no longer available.")
        if "receipt_created_after" not in part or "receipt_created_before" not in part:
            part.setdefault("receipt_created_after", part["submitted_at"] - 2)
            part.setdefault("receipt_created_before", part["submitted_at"] + self.config.receipt_seconds)
            self.store.save()
        if not part.get("guid"):
            matches = [
                message for message in self.native.history(
                    part["target"]["chat_id"], part["receipt_created_after"], part["receipt_created_before"],
                )
                if self._matches(part, message)
            ]
            guids = {message["guid"] for message in matches}
            if len(guids) > 1:
                part.update(state="unknown", error="ambiguous_receipt")
            elif len(guids) == 1:
                part["guid"] = guids.pop()
        if part.get("guid"):
            result = self.native.status(part["guid"])
            fields = result.get("status_fields") or {}
            if not isinstance(fields, dict):
                raise PortalError("native_protocol", "Native receipt status fields were malformed.")
            status = result.get("send_state")
            if result.get("guid") != part["guid"]:
                raise PortalError("native_protocol", "Receipt GUID did not match the outgoing part.")
            service = str(result.get("service") or "").casefold()
            if service and service != "imessage" or fields.get("was_downgraded") is True:
                part.update(state="failed", error="unexpected_service", retryable=False)
            elif status in ("sent", "delivered", "failed"):
                part["state"] = status
                part["retryable"] = status == "failed"
                part["receipt"] = {
                    "state": status, "error": fields.get("error"),
                    "checked_at": self.clock(),
                }
                if status == "failed":
                    part["error"] = "messages_transfer_failed"
                else:
                    part.pop("error", None)
            elif status != "pending":
                raise PortalError("native_protocol", "Native send state was invalid.")
        if (
            part["state"] in ("submitted", "unknown")
            and self.clock() - part["submitted_at"] >= self.config.receipt_seconds
        ):
            part.update(state="unknown", error=part.get("error", "receipt_unconfirmed"))
        part["last_checked"] = self.clock()
        # Only a check that completed counts as the part's look; failures keep backing off.
        part["receipt_looked_at"] = part["last_checked"]
        self.store.save()

    def pump(self, *, reconcile_only: bool = False) -> None:
        now = self.clock()
        receipt_budget = self.config.parts_per_tick * 2
        for part in sorted(self.store.data["outbox"], key=lambda p: p.get("last_checked", 0)):
            if part["state"] == "submitting":
                part.update(state="unknown", error="interrupted_submission")
                self.store.save()
            if part["state"] in ("submitted", "sent", "unknown"):
                age = now - part.get("submitted_at", now)
                checked = part.get("last_checked", 0)
                looked = part.get("receipt_looked_at", 0)
                # Back off with age: fresh parts every 5 s, then a tenth of their age, at most
                # hourly. A day-old part already checked after its receipt window retires (only
                # an explicit RAPP resend/retry reconciles it), so one uncertain part can never
                # cost an imsg spawn and a journal fsync every tick. A part that was never
                # checked (the bridge was down) still gets its one look.
                if receipt_budget == 0 or (
                    age > STALE_RECEIPT_SECONDS
                    and looked >= part.get("submitted_at", 0) + self.config.receipt_seconds
                ):
                    continue
                if now - checked < min(max(5, age / 10), 3600):
                    continue
                receipt_budget -= 1
                try:
                    self.reconcile(part)
                except (JournalWriteError, sqlite3.Error):
                    raise
                except PortalError as error:
                    part["receipt_error"] = error.code
                    part["last_checked"] = now
                    if (
                        part["state"] == "submitted"
                        and now - part["submitted_at"] >= self.config.receipt_seconds
                    ):
                        part.update(state="unknown", error="receipt_unavailable")
                    self.store.save()
                except Exception as error:
                    # One part that breaks its receipt check keeps backing off like any other.
                    if strict():
                        raise
                    part.update(receipt_error=f"internal:{type(error).__name__}", last_checked=now)
                    self.store.save()
        if reconcile_only:
            return
        if not any(part["state"] == "queued" for part in self.store.data["outbox"]):
            return
        health = getattr(self.native, "health", None)
        if callable(health):
            state = self.store.data.setdefault("imessage_health", {})
            before = dict(state)
            healthy = health(state, now)
            if state != before:
                self.store.save()
            if not healthy:
                return
            if (state.get("outage") or {}).get("reported") is False:
                # Hold one tick so the portal's "iMessage back" card leads the backlog.
                return
        budget = self.config.parts_per_tick
        # System cards (disk, outage, back online) go first: they explain the backlog behind them.
        for part in sorted(self.store.data["outbox"], key=lambda item: not item["group"].startswith("sys:")):
            if budget == 0:
                break
            if part["state"] != "queued":
                continue
            previous = [p for p in self.parts(part["group"]) if p["index"] < part["index"]]
            if any(
                p["state"] not in ({"sent", "delivered"} if "file" in p else ACCEPTED)
                for p in previous
            ):
                continue
            # A transient chat.db error here fails the tick with the part still queued.
            allowed = self._allowed(part)
            try:
                if not allowed:
                    raise NotSubmitted("route_changed", "The original authorized chat is no longer available.")
                if "file" in part:
                    reference = part["file"]
                    verified = copy_reference(
                        reference["path"], (self.config.state_dir / "outbox",),
                        Path(reference["path"]), self.config.max_file_bytes,
                        expected_sha256=reference["sha256"], expected_size=reference["size_bytes"],
                    )
                    part["file"] = verified
                try:
                    rowid = self.watermark()
                except PortalError as error:
                    raise NotSubmitted("receipt_baseline", "Cannot establish a safe pre-send watermark.") from error
                if type(rowid) is not int or rowid < 0:
                    raise NotSubmitted("receipt_baseline", "The pre-send watermark was invalid.")
                submitted_at = self.clock()
                part.update(
                    state="submitting", submitted_at=submitted_at, send_after_rowid=rowid, retryable=False,
                    receipt_created_after=submitted_at - 2,
                    receipt_created_before=submitted_at + self.config.receipt_seconds,
                )
                self.store.save()
                result = self.native.send(
                    part["target"]["chat_id"], text=part.get("caption", part.get("text", "")),
                    file=part.get("file", {}).get("path", ""),
                )
                if result.get("ok") is not True:
                    raise SubmissionUnknown("native_send_unknown", "Native send did not acknowledge submission.")
                # When the bubble really left the Mac: a slow send must not use up the read guard.
                part["sent_at"] = self.clock()
                # File GUIDs must be found by exact attachment correlation; a text
                # caption's GUID is not an attachment receipt.
                if "file" not in part and result.get("guid"):
                    part["guid"] = str(result["guid"])
                elif "file" in part and result.get("guid"):
                    part["caption_guid"] = str(result["guid"])
                part["state"] = "submitted"
            except (JournalWriteError, sqlite3.Error):
                raise
            except NotSubmitted as error:
                part.update(state="failed", error=error.code, retryable=True)
            except SubmissionUnknown as error:
                part.update(state="unknown", error=error.code, retryable=False)
            except (PortalError, OSError) as error:
                part.update(
                    state="unknown" if part["state"] == "submitting" else "failed",
                    error=getattr(error, "code", "outbox_file_missing"),
                    retryable=False,
                )
            except Exception as error:
                # A part that breaks the pump is set aside; the parts behind it still go out.
                if strict():
                    raise
                attempted = part["state"] == "submitting"
                # Only a part whose send may have happened is uncertain; one never attempted
                # stays retryable (RAPP retry).
                part.update(
                    state="unknown" if attempted else "failed",
                    error=f"internal:{type(error).__name__}", retryable=not attempted,
                )
            self.store.save()
            budget -= 1

    def retry(self, actor: dict, job_id: str, *, uncertain_part: str | None = None) -> int:
        changed = 0
        for part in self.store.data["outbox"]:
            if part["actor"] != actor or part.get("job_id") != job_id:
                continue
            if uncertain_part is not None:
                if part["id"] != uncertain_part or part["state"] != "unknown":
                    continue
            elif part["state"] != "failed" or not part.get("retryable") or part.get("card") == "progress":
                continue
            if part.get("guid") or uncertain_part is not None:
                # An explicit resend first looks again, so a late arrival is never duplicated.
                self.reconcile(part)
                if part["state"] in ("sent", "delivered"):
                    continue
            part["attempts"].append({
                key: part[key] for key in (
                    "state", "submitted_at", "send_after_rowid", "guid", "caption_guid", "error",
                    "receipt_created_after", "receipt_created_before",
                ) if key in part
            })
            part["attempt"] += 1
            attempt_token = token(f"{part['id']}:{part['attempt']}")
            if "file" in part:
                old = part["file"]
                destination = Path(old["path"]).with_name(
                    f"rapp-{attempt_token}-{filename(Path(old['path']).name)}"
                )
                part["file"] = copy_reference(
                    old["path"], (self.config.state_dir / "outbox",), destination,
                    self.config.max_file_bytes, expected_sha256=old["sha256"],
                    expected_size=old["size_bytes"],
                )
                part["caption"] = f"[RAPP artifact retry {attempt_token}]\n{filename(destination.name)}"
            else:
                part["text"] = f"[RAPP retry {attempt_token}]\n{part['text']}"
            for field in (
                "guid", "caption_guid", "error", "last_checked", "receipt", "submitted_at", "send_after_rowid",
                "receipt_created_after", "receipt_created_before",
            ):
                part.pop(field, None)
            part["state"] = "queued"
            changed += 1
        self.store.save()
        return changed

    def is_echo(self, event: dict, attachments: list[dict] | None = None) -> bool:
        if event.get("is_from_me") is not True and not any(
            route.allow_from_me and route.chat == event.get("chat_guid")
            and route.sender == normalized(event.get("sender") or "")
            for route in self.config.routes
        ):
            return False
        for part in self.store.data["outbox"]:
            if part["target"]["chat_guid"] != event.get("chat_guid"):
                continue
            if part.get("guid") and part["guid"] == event.get("guid"):
                return True
            if part.get("caption_guid") and part["caption_guid"] == event.get("guid"):
                return True
            if part["state"] not in {"submitting", "submitted", "sent", "delivered", "unknown"}:
                continue
            if "file" not in part and event.get("text") == part["text"]:
                return True
            if part.get("caption") and event.get("text") == part["caption"]:
                return True
            if attachments and "file" in part:
                name = Path(part["file"]["path"]).name
                if any(
                    any(Path(str(att.get(key) or "")).name == name for key in (
                        "transfer_name", "filename", "original_path"
                    ))
                    for att in attachments if isinstance(att, dict)
                ):
                    return True
        return False

    def part_for_guid(self, guid: str | None) -> dict | None:
        """Our outbox part behind a chat.db message GUID, whether or not it offers a menu."""
        if not guid:
            return None
        for part in reversed(self.store.data["outbox"]):
            if guid in (part.get("guid"), part.get("caption_guid")):
                return part
        return None

    def supersede(self, job_id: str, card: str = "progress") -> int:
        """Drop never-attempted parts of an older card, so outages never release a backlog."""
        stale = [
            part for part in self.store.data["outbox"]
            if part.get("job_id") == job_id and part.get("card") == card and part["state"] == "queued"
        ]
        if stale:
            self.store.data["outbox"] = [part for part in self.store.data["outbox"] if part not in stale]
        return len(stale)

    def summary(self, job_id: str) -> str:
        parts = [p for p in self.store.data["outbox"] if p.get("job_id") == job_id]
        counts: dict[str, int] = {}
        for part in parts:
            counts[part["state"]] = counts.get(part["state"], 0) + 1
        return ", ".join(f"{count} {state}" for state, count in sorted(counts.items())) or "no queued output"
