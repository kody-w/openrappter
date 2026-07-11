"""iMessage-first OpenRappter service backed by one supervised ``imsg rpc`` child."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import threading
import time
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .config import IMSG_PINNED_VERSION, IMessageConfig, normalize_handle
from .rpc import (
    ImsgRpcAmbiguous,
    ImsgRpcClient,
    ImsgRpcError,
    ImsgRpcNotSent,
    ImsgRpcSupervisor,
)
from .state import IMessageState
from openrappter.agents.context_memory_agent import ContextMemoryAgent


ChatRunner = Callable[
    [str, list[dict[str, str]], str, Mapping[str, Any]],
    Mapping[str, Any],
]


class IMessageServiceError(RuntimeError):
    """Raised when the canonical iMessage service cannot operate safely."""


class IMessageService:
    """Route iMessage events through the Python RAPP-compatible brainstem.

    Transport identifiers are converted to keyed logical identities before
    persistence or model injection. Message bodies are never written to logs.
    """

    def __init__(
        self,
        config: IMessageConfig,
        *,
        state: IMessageState | None = None,
        chat_runner: ChatRunner | None = None,
        supervisor: ImsgRpcSupervisor | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self.config = config
        self.state = state or IMessageState(config)
        self.chat_runner = chat_runner or self._default_chat_runner
        self.log = logger or logging.getLogger("openrappter.imessage")
        self._stop = threading.Event()
        self._conversation_locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._executor = ThreadPoolExecutor(
            max_workers=config.worker_count,
            thread_name_prefix="openrappter-imessage",
        )
        self._subscription: int | None = None
        self._chat_services: dict[str, str] = {}
        self._lease_holder = (
            f"{config.rappter_instance_id}:{os.getpid()}:{id(self)}"
        )
        self._processed_count = 0
        self._dropped_count = 0
        self._failed_count = 0
        self._send_ready: bool | None = None
        self.supervisor = supervisor or ImsgRpcSupervisor(
            lambda callback: ImsgRpcClient(
                os.path.expanduser(config.imsg_path),
                on_notification=callback,
                on_diagnostic=self._diagnostic,
                default_timeout=config.request_timeout_seconds,
            ),
            on_notification=self._on_notification,
            on_ready=self._on_ready,
            restart_initial=config.restart_initial_seconds,
            restart_max=config.restart_max_seconds,
        )

    def preflight(self) -> dict[str, Any]:
        errors = list(self.config.operational_errors())
        version = None
        path = os.path.expanduser(self.config.imsg_path)
        try:
            result = subprocess.run(
                [path, "--version"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            version = result.stdout.strip()
            if result.returncode != 0:
                errors.append("imsg executable failed its version probe")
            elif version != IMSG_PINNED_VERSION:
                errors.append(
                    f"imsg version must be {IMSG_PINNED_VERSION}, found {version or 'unknown'}"
                )
        except (OSError, subprocess.SubprocessError):
            errors.append("imsg executable is unavailable")
        read_ready = False
        if not errors:
            try:
                probe = subprocess.run(
                    [path, "chats", "--limit", "1", "--json"],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                read_ready = probe.returncode == 0
                if not read_ready:
                    errors.append(
                        "imsg cannot read Messages; grant Full Disk Access to the responsible process"
                    )
            except (OSError, subprocess.SubprocessError):
                errors.append("imsg Messages database probe failed")
        context = {
            "ok": not errors,
            "imsg_version": version,
            "errors": errors,
            "read_ready": read_ready,
            "send_ready": None,
            "state_dir": str(self.config.state_dir),
        }
        return context

    def start(self) -> None:
        preflight = self.preflight()
        if not preflight["ok"]:
            raise IMessageServiceError("; ".join(preflight["errors"]))
        if not self.state.acquire_lease(self._lease_holder):
            raise IMessageServiceError("another iMessage transport already owns this state")
        self._stop.clear()
        self._publish_status("starting")
        self.supervisor.start()

    def run_forever(self) -> None:
        self.start()
        try:
            while not self._stop.wait(5.0):
                if not self.state.refresh_lease(self._lease_holder):
                    raise IMessageServiceError("iMessage transport lease was lost")
                self._retry_pending()
                self._publish_status("running" if self.supervisor.is_ready else "starting")
        finally:
            self.stop()

    def stop(self) -> None:
        if self._stop.is_set():
            return
        self._stop.set()
        self.supervisor.stop()
        self._executor.shutdown(wait=True, cancel_futures=False)
        self._publish_status("stopped")
        self.state.release_lease(self._lease_holder)

    def status(self) -> dict[str, Any]:
        raw = self.state.raw_state_for_tests()
        return {
            "ready": self.supervisor.is_ready,
            "subscription": self._subscription,
            "restart_count": self.supervisor.restart_count,
            "last_error": self.supervisor.last_error,
            "read_ready": self.supervisor.is_ready,
            "send_ready": self._send_ready,
            "cursor_rowid": self.state.cursor_rowid,
            "processed": self._processed_count,
            "dropped": self._dropped_count,
            "failed": self._failed_count,
            "pending_rows": len(raw["pending_rows"]),
        }

    def process_message(self, message: Mapping[str, Any]) -> str:
        """Process one synthetic or live imsg message synchronously.

        Returns a content-free outcome string for tests and diagnostics.
        """
        parsed = self._parse_message(message)
        guid = parsed["guid"]
        rowid = parsed["rowid"]
        if self.state.is_processed(guid):
            return "duplicate"

        try:
            conversation = self._conversation(parsed)
        except IMessageServiceError:
            self.state.mark_decision(rowid, guid, "invalid_event")
            self._dropped_count += 1
            return "invalid_event"
        key = conversation["session_key"]
        lock = self._lock_for(key)
        with lock:
            if self.state.is_processed(guid):
                return "duplicate"
            self.state.observe(rowid, guid, parsed)

            if self.state.consume_outbound_echo(
                key,
                guid=guid,
                text=parsed["text"],
                is_from_me=parsed["is_from_me"],
            ):
                self.state.mark_decision(rowid, guid, "outbound_echo")
                self._dropped_count += 1
                return "outbound_echo"

            age = self._message_age_seconds(parsed.get("created_at"))
            if (
                age is not None
                and age > 15 * 60
                and self.state.retry_attempts(guid) == 0
            ):
                self.state.mark_decision(rowid, guid, "stale_backlog")
                self._dropped_count += 1
                return "stale_backlog"

            allowed, reason = self._authorize(parsed, conversation)
            if not allowed:
                self.state.mark_decision(rowid, guid, reason)
                self._dropped_count += 1
                return reason

            if not parsed["text"]:
                self.state.mark_decision(rowid, guid, "unsupported_empty_message")
                self._dropped_count += 1
                return "unsupported_empty_message"

            prompt = self._strip_mention(parsed["text"], conversation)
            if prompt is None:
                self.state.mark_decision(rowid, guid, "mention_required")
                self._dropped_count += 1
                return "mention_required"

            staged = self.state.staged_dispatch(guid)
            if staged:
                response_text = str(staged["response"])
            else:
                history = self.state.get_history(key)
                trust_context = self._trust_context(parsed, conversation)
                try:
                    result = self.chat_runner(prompt, history, key, trust_context)
                except Exception:
                    self.state.mark_retryable(rowid, guid)
                    self._failed_count += 1
                    return "brainstem_failed"
                response_text = str(result.get("response") or "").strip()
                if not response_text:
                    self.state.mark_retryable(rowid, guid)
                    self._failed_count += 1
                    return "empty_response"
                self.state.stage_brainstem_result(guid, key, prompt, response_text)

            outbound = f"{self.config.reply_prefix}{self._text_reply(response_text)}".strip()
            record_id = self.state.begin_outbound(guid, key, outbound)
            target = {"chat_id": parsed["chat_id"]} if parsed["chat_id"] is not None else {
                "chat_guid": parsed["chat_guid"]
            }
            params: dict[str, object] = {
                **target,
                "text": outbound,
                "service": "imessage",
            }
            try:
                send_result = self.supervisor.request(
                    "send",
                    params,
                    timeout=max(180.0, self.config.request_timeout_seconds),
                )
            except ImsgRpcAmbiguous:
                # The Apple Event may have succeeded. Never retry an ambiguous send.
                self.state.finish_outbound(record_id, status="unknown")
                self.state.mark_decision(rowid, guid, "send_unknown")
                self._failed_count += 1
                self._send_ready = None
                return "send_unknown"
            except ImsgRpcNotSent:
                self.state.finish_outbound(record_id, status="not_sent")
                self.state.mark_retryable(rowid, guid)
                self._failed_count += 1
                self._send_ready = False
                return "send_not_sent"
            except ImsgRpcError:
                # Remote errors can occur after Messages accepted a send
                # (for example Tahoe ghost-row verification). Never resend.
                self.state.finish_outbound(record_id, status="unknown")
                self.state.mark_decision(rowid, guid, "send_unknown")
                self._failed_count += 1
                self._send_ready = False
                return "send_unknown"

            result_map = send_result if isinstance(send_result, Mapping) else {}
            if result_map.get("ok") is not True:
                self.state.finish_outbound(record_id, status="unknown")
                self.state.mark_decision(rowid, guid, "send_unknown")
                self._failed_count += 1
                self._send_ready = False
                return "send_unknown"
            outbound_guid = result_map.get("guid")
            self.state.finish_outbound(
                record_id,
                status="submitted",
                outbound_guid=str(outbound_guid) if outbound_guid else None,
            )
            self._send_ready = True
            self.state.mark_decision(rowid, guid, "replied")
            self._processed_count += 1
            return "replied"

    def _on_ready(self, client: Any) -> None:
        self._refresh_chat_catalog(client)
        params: dict[str, object] = {
            "attachments": False,
            "include_reactions": False,
            "debounce_ms": 500,
        }
        if self.state.watch_resume_rowid is not None:
            params["since_rowid"] = self.state.watch_resume_rowid
        result = client.request("watch.subscribe", params, self.config.request_timeout_seconds)
        if not isinstance(result, Mapping) or not isinstance(result.get("subscription"), int):
            raise IMessageServiceError("imsg watch subscription returned an invalid result")
        self._subscription = int(result["subscription"])
        self._publish_status("running")

    def _on_notification(self, method: str, params: object) -> None:
        if method == "error" and isinstance(params, Mapping):
            subscription = params.get("subscription")
            if subscription in (None, self._subscription):
                self._diagnostic("imsg watch failed; restarting transport")
                self.supervisor.restart()
            return
        if method != "message" or not isinstance(params, Mapping):
            return
        message = params.get("message")
        if not isinstance(message, Mapping):
            return
        try:
            guid, rowid = self._event_identity(message)
            self.state.observe(rowid, guid, message)
        except IMessageServiceError:
            return
        self._executor.submit(self._safe_process, message)

    def _safe_process(self, message: Mapping[str, Any]) -> None:
        try:
            self.process_message(message)
        except IMessageServiceError:
            try:
                guid, rowid = self._event_identity(message)
                self.state.mark_decision(rowid, guid, "invalid_event")
            except IMessageServiceError:
                pass
            self._dropped_count += 1
        except Exception:
            self._failed_count += 1
            self._diagnostic("message processing failed")

    def _retry_pending(self) -> None:
        for message in self.state.retryable_messages():
            self._executor.submit(self._safe_process, message)

    def _parse_message(self, raw: Mapping[str, Any]) -> dict[str, Any]:
        guid, rowid = self._event_identity(raw)
        text = str(raw.get("text") or "").strip()
        chat_id_value = raw.get("chat_id")
        chat_id = int(chat_id_value) if isinstance(chat_id_value, (int, str)) and str(
            chat_id_value
        ).isdigit() else None
        chat_guid = str(raw.get("chat_guid") or "").strip()
        if chat_id is None and not chat_guid:
            raise IMessageServiceError("incoming message has no stable chat target")
        raw_participants = raw.get("participants", [])
        if raw_participants is None:
            raw_participants = []
        if not isinstance(raw_participants, (list, tuple)):
            raise IMessageServiceError("incoming participants must be an array")
        participants = tuple(
            normalize_handle(str(item))
            for item in raw_participants
            if isinstance(item, (str, int)) and str(item).strip()
        )
        return {
            "guid": guid,
            "rowid": rowid,
            "text": text,
            "sender": normalize_handle(str(raw.get("sender") or "")),
            "is_from_me": self._strict_bool(raw.get("is_from_me"), "is_from_me"),
            "is_group": self._strict_bool(raw.get("is_group"), "is_group"),
            "service": self._service_for(raw),
            "chat_id": chat_id,
            "chat_guid": chat_guid,
            "chat_identifier": str(raw.get("chat_identifier") or "").strip(),
            "created_at": str(raw.get("created_at") or "").strip(),
            "participants": participants,
        }

    @staticmethod
    def _event_identity(raw: Mapping[str, Any]) -> tuple[str, int]:
        guid = str(raw.get("guid") or "").strip()
        if not guid:
            raise IMessageServiceError("incoming message has no GUID")
        rowid_value = raw.get("id")
        if not (
            isinstance(rowid_value, (int, str))
            and str(rowid_value).isdigit()
        ):
            raise IMessageServiceError("incoming message has no row id")
        return guid, int(rowid_value)

    def _conversation(self, message: Mapping[str, Any]) -> dict[str, Any]:
        targets = {
            str(item)
            for item in (
                message.get("chat_id"),
                message.get("chat_guid"),
                message.get("chat_identifier"),
            )
            if item not in (None, "")
        }
        sender = str(message.get("sender") or "")
        owner_sender = sender in self.config.normalized_owner_handles
        owner_chat = (
            bool(targets & set(self.config.owner_chat_ids))
            or any(self.state.is_owner_identifier(item) for item in targets)
            or (not message["is_group"] and owner_sender)
        )
        if owner_chat:
            owner_handles = self.config.normalized_owner_handles
            participants = set(message["participants"])
            if (
                message["is_group"]
                or not participants
                or not participants.issubset(owner_handles)
                or (not message["is_from_me"] and not owner_sender)
                or (message["is_from_me"] and sender and sender not in owner_handles)
            ):
                raise IMessageServiceError("owner self-chat identity mismatch")
            self.state.bind_owner_identifiers(list(targets))
            return {
                "type": "owner",
                "session_key": self.state.owner_session_key(),
                "audience_id": self.state.owner_session_key(),
            }
        if message["is_group"]:
            if not message["sender"] or not message["participants"]:
                raise IMessageServiceError("group roster is incomplete")
            if message["sender"] not in set(message["participants"]):
                raise IMessageServiceError("group sender is not in the current roster")
            stable = message["chat_guid"] or message["chat_id"]
            participant_ids = sorted(
                {
                    self.state.principal_id_for_handle(handle)
                    for handle in message["participants"]
                }
            )
            key = self.state.group_session_key(stable, participant_ids)
            self.state.bind_group_identifiers(
                [
                    item
                    for item in (
                        message.get("chat_id"),
                        message.get("chat_guid"),
                        message.get("chat_identifier"),
                    )
                    if item not in (None, "")
                ],
                key,
            )
            return {"type": "group", "session_key": key, "audience_id": key}
        handle = message["sender"] or (
            message["participants"][0] if message["participants"] else ""
        )
        if not handle:
            raise IMessageServiceError("direct message has no sender identity")
        key = self.state.dm_session_key(handle)
        return {
            "type": "dm",
            "handle": handle,
            "session_key": key,
            "audience_id": key,
        }

    def _authorize(
        self,
        message: Mapping[str, Any],
        conversation: Mapping[str, Any],
    ) -> tuple[bool, str]:
        if message["service"] != "imessage":
            return False, "non_imessage"
        if message["is_from_me"] and conversation["type"] != "owner":
            return False, "from_me"
        if conversation["type"] == "owner":
            return True, "allowed"
        if conversation["type"] == "dm":
            if conversation["handle"] in self.config.normalized_allowed_dm_handles:
                return True, "allowed"
            return False, "dm_not_allowed"
        targets = {
            str(item)
            for item in (
                message.get("chat_id"),
                message.get("chat_guid"),
                message.get("chat_identifier"),
            )
            if item not in (None, "")
        }
        if targets & set(self.config.allowed_group_chat_ids):
            return True, "allowed"
        return False, "group_not_allowed"

    def _strip_mention(
        self,
        text: str,
        conversation: Mapping[str, Any],
    ) -> str | None:
        if conversation["type"] == "owner":
            return text or None
        matched = False
        cleaned = text
        for token in self.config.mention_tokens:
            pattern = re.compile(re.escape(token), re.IGNORECASE)
            if pattern.search(cleaned):
                matched = True
                cleaned = pattern.sub("", cleaned)
        if self.config.mention_required and not matched:
            return None
        return cleaned.strip() or "Hey"

    def _trust_context(
        self,
        message: Mapping[str, Any],
        conversation: Mapping[str, Any],
    ) -> dict[str, Any]:
        sender = (
            self.state.owner_principal_id
            if conversation["type"] == "owner"
            else self.state.principal_id_for_handle(
                conversation.get("handle") or message.get("sender") or "unknown"
            )
        )
        participants = {
            self.state.principal_id_for_handle(handle)
            for handle in message.get("participants", ())
            if handle
        }
        participants.add(sender)
        consent_action = self._consent_action(str(message.get("text") or ""))
        event_id = self.state.transport_event_id(str(message["guid"]))
        return {
            "trusted": True,
            "channel": "imessage",
            "principal_id": sender,
            "is_owner": conversation["type"] == "owner",
            "audience_id": conversation["audience_id"],
            "conversation_id": conversation["session_key"],
            "conversation_type": conversation["type"],
            "participant_ids": sorted(participants),
            "known_group_audiences": self.state.named_group_audiences(),
            "allowed_share_audiences": sorted(
                set(self.state.named_group_audiences().values())
                | {str(conversation["audience_id"])}
            ),
            "allowed_agents": (
                None
                if conversation["type"] == "owner"
                else ["ManageMemory", "ContextMemory"]
            ),
            "transport_event_id": event_id,
            "consent_action": consent_action,
            "consent_capability": (
                {
                    "action": consent_action,
                    "event_id": event_id,
                    "principal_id": sender,
                    "audience_id": conversation["audience_id"],
                    "utterance": " ".join(
                        str(message.get("text") or "").casefold().split()
                    ),
                    "consumed": False,
                }
                if consent_action
                else None
            ),
        }
        memory_agent = ContextMemoryAgent()
        try:
            recalled = json.loads(
                memory_agent.perform(
                    query=str(message.get("text") or ""),
                    max_messages=10,
                    _trusted_context=context,
                )
            )
        except (TypeError, ValueError, json.JSONDecodeError):
            recalled = {}
        context["authorized_memory_data"] = (
            recalled.get("memories", []) if isinstance(recalled, Mapping) else []
        )
        context["familiarity"] = bool(
            recalled.get("familiar") if isinstance(recalled, Mapping) else False
        )
        return context

    def _lock_for(self, key: str) -> threading.Lock:
        with self._locks_guard:
            return self._conversation_locks.setdefault(key, threading.Lock())

    def _diagnostic(self, message: str) -> None:
        self.log.warning("%s", message)

    @staticmethod
    def _strict_bool(value: object, field: str) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, int) and value in (0, 1):
            return bool(value)
        raise IMessageServiceError(f"incoming {field} must be boolean")

    @staticmethod
    def _message_age_seconds(value: object) -> float | None:
        if not isinstance(value, str) or not value.strip():
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds())

    def _publish_status(self, lifecycle: str) -> None:
        current = self.status()
        self.state.write_status({
            "lifecycle": lifecycle,
            "ready": current["ready"],
            "subscription": current["subscription"],
            "restart_count": current["restart_count"],
            "last_error": current["last_error"],
            "read_ready": current["read_ready"],
            "send_ready": current["send_ready"],
            "cursor_rowid": current["cursor_rowid"],
            "processed": current["processed"],
            "dropped": current["dropped"],
            "failed": current["failed"],
            "pending_rows": current["pending_rows"],
            "pid": os.getpid(),
            "updated_at": time.time(),
            "imsg_version": IMSG_PINNED_VERSION,
        })

    def _service_for(self, raw: Mapping[str, Any]) -> str:
        explicit = str(raw.get("service") or "").casefold()
        if explicit:
            return explicit
        identifiers = [
            str(item)
            for item in (raw.get("chat_id"), raw.get("chat_guid"), raw.get("chat_identifier"))
            if item not in (None, "")
        ]
        for identifier in identifiers:
            service = self._chat_services.get(identifier)
            if service:
                return service
        try:
            result = self.supervisor.request(
                "chats.list",
                {"limit": 1000},
                timeout=self.config.request_timeout_seconds,
            )
            self._update_chat_catalog(result)
        except ImsgRpcError:
            return ""
        for identifier in identifiers:
            service = self._chat_services.get(identifier)
            if service:
                return service
        return ""

    def _refresh_chat_catalog(self, client: Any) -> None:
        result = client.request(
            "chats.list",
            {"limit": 1000},
            self.config.request_timeout_seconds,
        )
        self._update_chat_catalog(result)

    def _update_chat_catalog(self, result: object) -> None:
        if not isinstance(result, Mapping):
            return
        chats = result.get("chats")
        if not isinstance(chats, Sequence):
            return
        for chat in chats:
            if not isinstance(chat, Mapping):
                continue
            service = str(chat.get("service") or "").casefold()
            for identifier in (chat.get("id"), chat.get("guid"), chat.get("identifier")):
                if identifier not in (None, ""):
                    self._chat_services[str(identifier)] = service

    @staticmethod
    def _consent_action(text: str) -> str:
        normalized = " ".join(text.casefold().split())
        if re.search(
            r"\b(revoke|stop sharing|do not share|don't share|can not share|cannot share|"
            r"may not share|must not share|never share|keep that private)\b",
            normalized,
        ):
            return "revoke"
        if re.match(r"^(please )?(forget|delete that memory|erase that memory)\b", normalized):
            return "forget"
        if re.match(
            r"^(please )?(you may|you can|i give (you )?permission to) "
            r"(share|tell|reveal|say)\b",
            normalized,
        ) or re.match(
            r"^(please )?(it is okay|it's okay) (for you )?to "
            r"(share|tell|reveal|say)\b",
            normalized,
        ):
            return "share"
        return ""

    @staticmethod
    def _text_reply(response: str) -> str:
        return response.split("|||VOICE|||", 1)[0].strip()

    @staticmethod
    def _default_chat_runner(
        prompt: str,
        history: list[dict[str, str]],
        session_id: str,
        trust_context: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        from openrappter import brainstem

        return brainstem.run_chat(
            prompt,
            history,
            session_id,
            trusted_context=dict(trust_context),
        )
