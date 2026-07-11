"""SQLite-backed, privacy-preserving state for the iMessage transport."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Mapping, Sequence

from .config import IMessageConfig, normalize_handle


STATE_SCHEMA_VERSION = 2


class StateError(RuntimeError):
    """Raised when durable iMessage state cannot be loaded or stored."""


class IMessageState:
    """Transactional state, HMAC identities, and a cross-process writer lease."""

    def __init__(self, config: IMessageConfig) -> None:
        self.config = config
        self.directory = config.state_dir.expanduser()
        self.database_path = self.directory / "state.sqlite3"
        self.status_path = self.directory / "status.json"
        self.secret_path = self.directory / "identity.key"
        self._lock = threading.RLock()
        self._ensure_directory()
        self._secret = self._load_or_create_secret()
        try:
            self._db = sqlite3.connect(
                self.database_path,
                timeout=10,
                isolation_level=None,
                check_same_thread=False,
            )
            self._db.row_factory = sqlite3.Row
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=FULL")
            self._db.execute("PRAGMA busy_timeout=10000")
            self._migrate()
            os.chmod(self.database_path, 0o600)
        except (sqlite3.Error, OSError) as error:
            raise StateError("unable to initialize iMessage SQLite state") from error

    @contextmanager
    def _transaction(self):
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                yield
            except Exception:
                self._db.execute("ROLLBACK")
                raise
            else:
                self._db.execute("COMMIT")

    @property
    def cursor_rowid(self) -> int | None:
        row = self._db.execute(
            "SELECT value FROM metadata WHERE key='cursor_rowid'"
        ).fetchone()
        if row is None:
            return None
        try:
            value = int(row["value"])
            return value if value >= 0 else None
        except (TypeError, ValueError):
            return None

    @property
    def watch_resume_rowid(self) -> int | None:
        row = self._db.execute(
            "SELECT MIN(rowid_value) AS minimum FROM inbox WHERE processed=0"
        ).fetchone()
        if row and row["minimum"] is not None:
            return int(row["minimum"]) - 1
        return self.cursor_rowid

    @property
    def owner_principal_id(self) -> str:
        return f"principal:{self._digest('owner', self.config.rappter_instance_id)}"

    def principal_id_for_handle(self, handle: str) -> str:
        normalized = normalize_handle(handle)
        if not normalized:
            raise ValueError("a non-empty transport handle is required")
        if normalized in self.config.normalized_owner_handles:
            return self.owner_principal_id
        for principal, handles in self.config.identity_links.items():
            if normalized in {normalize_handle(item) for item in handles}:
                return f"principal:{self._digest('principal-link', principal)}"
        return f"principal:{self._digest('principal-handle', normalized)}"

    def owner_session_key(self) -> str:
        return f"imessage:owner:{self._digest('owner-session', self.config.rappter_instance_id)}"

    def dm_session_key(self, handle: str) -> str:
        principal = self.principal_id_for_handle(handle)
        return f"imessage:dm:{self._digest('dm-session', principal)}"

    def group_session_key(
        self,
        chat_identifier: str | int,
        participant_ids: Sequence[str] | None = None,
    ) -> str:
        raw = str(chat_identifier).strip()
        if not raw:
            raise ValueError("a stable group chat ID or GUID is required")
        if participant_ids:
            roster = ",".join(sorted(str(item) for item in participant_ids if item))
            group_value = raw + "\0roster:" + roster
            return f"imessage:group:{self._digest('group-session', group_value)}"
        binding = self._db.execute(
            "SELECT session_key FROM group_bindings WHERE binding_hash=?",
            (self._digest("group-binding", raw),),
        ).fetchone()
        if binding:
            return str(binding["session_key"])
        return f"imessage:group:{self._digest('group-session', raw)}"

    def bind_group_identifiers(
        self,
        identifiers: Sequence[str | int],
        session_key: str,
    ) -> None:
        with self._transaction():
            for identifier in identifiers:
                raw = str(identifier).strip()
                if raw:
                    self._db.execute(
                        """
                        INSERT INTO group_bindings(binding_hash, session_key, updated_at)
                        VALUES(?,?,?)
                        ON CONFLICT(binding_hash) DO UPDATE SET
                          session_key=excluded.session_key,
                          updated_at=excluded.updated_at
                        """,
                        (self._digest("group-binding", raw), session_key, time.time()),
                    )

    def transport_event_id(self, guid: str) -> str:
        if not guid:
            raise ValueError("message GUID is required")
        return f"event:{self._digest('message-guid', guid)}"

    def named_group_audiences(self) -> dict[str, str]:
        return {
            alias: self.group_session_key(target)
            for alias, target in self.config.group_aliases.items()
        }

    def bind_owner_identifiers(self, identifiers: Sequence[str | int]) -> None:
        with self._transaction():
            for identifier in identifiers:
                raw = str(identifier).strip()
                if raw:
                    self._db.execute(
                        """
                        INSERT OR REPLACE INTO owner_bindings(binding_hash,updated_at)
                        VALUES(?,?)
                        """,
                        (self._digest("owner-binding", raw), time.time()),
                    )

    def is_owner_identifier(self, identifier: str | int) -> bool:
        row = self._db.execute(
            "SELECT 1 FROM owner_bindings WHERE binding_hash=?",
            (self._digest("owner-binding", str(identifier).strip()),),
        ).fetchone()
        return row is not None

    def acquire_lease(self, holder: str, ttl_seconds: float = 20.0) -> bool:
        now = time.time()
        with self._transaction():
            row = self._db.execute(
                "SELECT holder, expires_at FROM leases WHERE name='transport'"
            ).fetchone()
            if row and row["holder"] != holder and float(row["expires_at"]) > now:
                return False
            self._db.execute(
                """
                INSERT INTO leases(name,holder,expires_at) VALUES('transport',?,?)
                ON CONFLICT(name) DO UPDATE SET holder=excluded.holder, expires_at=excluded.expires_at
                """,
                (holder, now + ttl_seconds),
            )
        return True

    def refresh_lease(self, holder: str, ttl_seconds: float = 20.0) -> bool:
        with self._transaction():
            cursor = self._db.execute(
                """
                UPDATE leases SET expires_at=?
                WHERE name='transport' AND holder=?
                """,
                (time.time() + ttl_seconds, holder),
            )
        return cursor.rowcount == 1

    def release_lease(self, holder: str) -> None:
        with self._transaction():
            self._db.execute(
                "DELETE FROM leases WHERE name='transport' AND holder=?",
                (holder,),
            )

    def is_processed(self, guid: str) -> bool:
        row = self._db.execute(
            "SELECT processed FROM inbox WHERE guid_hash=?",
            (self._digest("message-guid", guid),),
        ).fetchone()
        return bool(row and row["processed"])

    def observe(
        self,
        rowid: int | None,
        guid: str,
        message: Mapping[str, Any] | None = None,
    ) -> None:
        if rowid is None or rowid < 0:
            return
        payload = json.dumps(dict(message), separators=(",", ":")) if message else None
        with self._transaction():
            self._db.execute(
                """
                INSERT INTO inbox(
                  guid_hash,rowid_value,event_json,processed,outcome,attempts,next_retry,observed_at
                ) VALUES(?,?,?,0,NULL,0,0,?)
                ON CONFLICT(guid_hash) DO UPDATE SET
                  rowid_value=excluded.rowid_value,
                  event_json=COALESCE(inbox.event_json, excluded.event_json)
                """,
                (
                    self._digest("message-guid", guid),
                    rowid,
                    payload,
                    time.time(),
                ),
            )

    def mark_retryable(self, rowid: int | None, guid: str) -> None:
        self.observe(rowid, guid)
        with self._transaction():
            row = self._db.execute(
                "SELECT attempts FROM inbox WHERE guid_hash=?",
                (self._digest("message-guid", guid),),
            ).fetchone()
            attempts = int(row["attempts"] if row else 0) + 1
            delay = min(60.0, 2.0 ** min(attempts, 6))
            self._db.execute(
                """
                UPDATE inbox SET attempts=?, next_retry=? WHERE guid_hash=?
                """,
                (attempts, time.time() + delay, self._digest("message-guid", guid)),
            )

    def retryable_messages(
        self,
        limit: int = 100,
        *,
        now: float | None = None,
    ) -> list[dict[str, Any]]:
        rows = self._db.execute(
            """
            SELECT event_json FROM inbox
            WHERE processed=0 AND event_json IS NOT NULL AND next_retry<=?
            ORDER BY rowid_value ASC LIMIT ?
            """,
            (time.time() if now is None else now, limit),
        ).fetchall()
        messages = []
        for row in rows:
            try:
                value = json.loads(row["event_json"])
                if isinstance(value, dict):
                    messages.append(value)
            except (TypeError, json.JSONDecodeError):
                continue
        return messages

    def retry_attempts(self, guid: str) -> int:
        row = self._db.execute(
            "SELECT attempts FROM inbox WHERE guid_hash=?",
            (self._digest("message-guid", guid),),
        ).fetchone()
        return int(row["attempts"]) if row else 0

    def mark_decision(self, rowid: int | None, guid: str, outcome: str) -> None:
        guid_hash = self._digest("message-guid", guid)
        with self._transaction():
            self._db.execute(
                """
                UPDATE inbox SET processed=1, outcome=?, processed_at=?
                WHERE guid_hash=?
                """,
                (outcome, time.time(), guid_hash),
            )
            self._advance_cursor_locked()

    def get_history(self, conversation_key: str) -> list[dict[str, str]]:
        rows = self._db.execute(
            """
            SELECT role,content FROM history
            WHERE conversation=? ORDER BY sequence ASC
            """,
            (conversation_key,),
        ).fetchall()
        return [
            {"role": row["role"], "content": row["content"]}
            for row in rows
            if row["role"] in ("user", "assistant")
        ]

    def stage_brainstem_result(
        self,
        guid: str,
        conversation_key: str,
        user_text: str,
        response_text: str,
    ) -> None:
        guid_hash = self._digest("message-guid", guid)
        with self._transaction():
            existing = self._db.execute(
                "SELECT 1 FROM staged WHERE guid_hash=?", (guid_hash,)
            ).fetchone()
            if existing:
                return
            now = time.time()
            self._db.execute(
                "INSERT INTO history(conversation,role,content,created_at) VALUES(?,?,?,?)",
                (conversation_key, "user", user_text, now),
            )
            self._db.execute(
                "INSERT INTO history(conversation,role,content,created_at) VALUES(?,?,?,?)",
                (conversation_key, "assistant", response_text, now),
            )
            excess = self._db.execute(
                "SELECT COUNT(*) AS count FROM history WHERE conversation=?",
                (conversation_key,),
            ).fetchone()["count"] - self.config.history_limit
            if excess > 0:
                self._db.execute(
                    """
                    DELETE FROM history WHERE sequence IN (
                      SELECT sequence FROM history WHERE conversation=?
                      ORDER BY sequence ASC LIMIT ?
                    )
                    """,
                    (conversation_key, excess),
                )
            self._db.execute(
                """
                INSERT INTO staged(guid_hash,conversation,response,created_at,outbound_record)
                VALUES(?,?,?,?,NULL)
                """,
                (guid_hash, conversation_key, response_text, now),
            )

    def staged_dispatch(self, guid: str) -> dict[str, Any] | None:
        row = self._db.execute(
            "SELECT conversation,response,created_at,outbound_record FROM staged WHERE guid_hash=?",
            (self._digest("message-guid", guid),),
        ).fetchone()
        return dict(row) if row else None

    def begin_outbound(self, guid: str, conversation_key: str, text: str) -> str:
        inbound_hash = self._digest("message-guid", guid)
        with self._transaction():
            staged = self._db.execute(
                "SELECT outbound_record FROM staged WHERE guid_hash=?",
                (inbound_hash,),
            ).fetchone()
            if staged and staged["outbound_record"]:
                return str(staged["outbound_record"])
            record_id = uuid.uuid4().hex
            self._db.execute(
                """
                INSERT INTO outbox(
                  record_id,conversation,text_hash,guid_hash,status,created_at,updated_at,consumed_at
                ) VALUES(?,?,?,?,?,?,?,NULL)
                """,
                (
                    record_id,
                    conversation_key,
                    self._digest("outbound-text", f"{conversation_key}\0{text}"),
                    None,
                    "prepared",
                    time.time(),
                    time.time(),
                ),
            )
            self._db.execute(
                "UPDATE staged SET outbound_record=? WHERE guid_hash=?",
                (record_id, inbound_hash),
            )
            return record_id

    def finish_outbound(
        self,
        record_id: str,
        *,
        status: str,
        outbound_guid: str | None = None,
    ) -> None:
        with self._transaction():
            self._db.execute(
                """
                UPDATE outbox SET status=?, guid_hash=COALESCE(?,guid_hash), updated_at=?
                WHERE record_id=?
                """,
                (
                    status,
                    self._digest("message-guid", outbound_guid) if outbound_guid else None,
                    time.time(),
                    record_id,
                ),
            )

    def outbound_record(self, record_id: str) -> dict[str, Any] | None:
        row = self._db.execute(
            "SELECT * FROM outbox WHERE record_id=?", (record_id,)
        ).fetchone()
        return dict(row) if row else None

    def consume_outbound_echo(
        self,
        conversation_key: str,
        *,
        guid: str,
        text: str,
        is_from_me: bool = True,
    ) -> bool:
        if not is_from_me:
            return False
        guid_hash = self._digest("message-guid", guid)
        text_hash = self._digest("outbound-text", f"{conversation_key}\0{text}")
        with self._transaction():
            row = self._db.execute(
                """
                SELECT record_id,guid_hash FROM outbox
                WHERE conversation=?
                  AND status NOT IN ('failed','consumed')
                  AND created_at>=?
                  AND (guid_hash=? OR (guid_hash IS NULL AND text_hash=?))
                ORDER BY created_at ASC LIMIT 1
                """,
                (conversation_key, time.time() - 12 * 60 * 60, guid_hash, text_hash),
            ).fetchone()
            if not row:
                return False
            self._db.execute(
                "UPDATE outbox SET status='consumed', consumed_at=?, updated_at=? WHERE record_id=?",
                (time.time(), time.time(), row["record_id"]),
            )
            return True

    def raw_state_for_tests(self) -> dict[str, Any]:
        pending = [
            {
                "rowid": row["rowid_value"],
                "guid_hash": row["guid_hash"],
            }
            for row in self._db.execute(
                "SELECT rowid_value,guid_hash FROM inbox WHERE processed=0"
            )
        ]
        return {
            "schema_version": STATE_SCHEMA_VERSION,
            "cursor_rowid": self.cursor_rowid,
            "pending_rows": pending,
            "processed_guids": {
                row["guid_hash"]: {"rowid": row["rowid_value"], "outcome": row["outcome"]}
                for row in self._db.execute(
                    "SELECT guid_hash,rowid_value,outcome FROM inbox WHERE processed=1"
                )
            },
            "dispatches": {},
            "staged_dispatches": {
                row["guid_hash"]: dict(row)
                for row in self._db.execute("SELECT * FROM staged")
            },
            "outbound_echoes": {
                row["record_id"]: dict(row)
                for row in self._db.execute("SELECT * FROM outbox")
            },
            "histories": {},
            "group_bindings": {
                row["binding_hash"]: row["session_key"]
                for row in self._db.execute("SELECT * FROM group_bindings")
            },
        }

    def write_status(self, status: Mapping[str, Any]) -> None:
        payload = (json.dumps(dict(status), indent=2, sort_keys=True) + "\n").encode("utf-8")
        self._atomic_bytes(self.status_path, payload, 0o600)

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def _advance_cursor_locked(self) -> None:
        pending = self._db.execute(
            "SELECT MIN(rowid_value) AS minimum FROM inbox WHERE processed=0"
        ).fetchone()["minimum"]
        if pending is None:
            row = self._db.execute(
                "SELECT MAX(rowid_value) AS maximum FROM inbox WHERE processed=1"
            ).fetchone()
        else:
            row = self._db.execute(
                """
                SELECT MAX(rowid_value) AS maximum FROM inbox
                WHERE processed=1 AND rowid_value<?
                """,
                (pending,),
            ).fetchone()
        candidate = row["maximum"] if row else None
        if candidate is None:
            return
        current = self.cursor_rowid
        if current is None or int(candidate) > current:
            self._db.execute(
                """
                INSERT INTO metadata(key,value) VALUES('cursor_rowid',?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value
                """,
                (str(int(candidate)),),
            )

    def _digest(self, purpose: str, value: str) -> str:
        payload = (
            f"{purpose}\0{self.config.rappter_instance_id}\0"
            f"{self.config.account_id}\0{value}"
        ).encode("utf-8")
        return hmac.new(self._secret, payload, hashlib.sha256).hexdigest()[:32]

    def _ensure_directory(self) -> None:
        try:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(self.directory, 0o700)
        except OSError as error:
            raise StateError("unable to create the iMessage state directory") from error

    def _load_or_create_secret(self) -> bytes:
        try:
            raw = self.secret_path.read_text(encoding="ascii").strip()
            secret = bytes.fromhex(raw)
            if len(secret) != 32:
                raise ValueError
            os.chmod(self.secret_path, 0o600)
            return secret
        except FileNotFoundError:
            secret = secrets.token_bytes(32)
            self._atomic_bytes(self.secret_path, secret.hex().encode("ascii") + b"\n", 0o600)
            return secret
        except (OSError, ValueError) as error:
            raise StateError("the iMessage identity secret is invalid") from error

    def _migrate(self) -> None:
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS metadata (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS inbox (
              guid_hash TEXT PRIMARY KEY,
              rowid_value INTEGER NOT NULL,
              event_json TEXT,
              processed INTEGER NOT NULL DEFAULT 0,
              outcome TEXT,
              attempts INTEGER NOT NULL DEFAULT 0,
              next_retry REAL NOT NULL DEFAULT 0,
              observed_at REAL NOT NULL,
              processed_at REAL
            );
            CREATE INDEX IF NOT EXISTS idx_inbox_pending
              ON inbox(processed,next_retry,rowid_value);
            CREATE TABLE IF NOT EXISTS history (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              conversation TEXT NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_history_conversation
              ON history(conversation,sequence);
            CREATE TABLE IF NOT EXISTS staged (
              guid_hash TEXT PRIMARY KEY,
              conversation TEXT NOT NULL,
              response TEXT NOT NULL,
              created_at REAL NOT NULL,
              outbound_record TEXT
            );
            CREATE TABLE IF NOT EXISTS outbox (
              record_id TEXT PRIMARY KEY,
              conversation TEXT NOT NULL,
              text_hash TEXT NOT NULL,
              guid_hash TEXT,
              status TEXT NOT NULL,
              created_at REAL NOT NULL,
              updated_at REAL NOT NULL,
              consumed_at REAL
            );
            CREATE INDEX IF NOT EXISTS idx_outbox_echo
              ON outbox(conversation,guid_hash,text_hash,status,created_at);
            CREATE TABLE IF NOT EXISTS group_bindings (
              binding_hash TEXT PRIMARY KEY,
              session_key TEXT NOT NULL,
              updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS owner_bindings (
              binding_hash TEXT PRIMARY KEY,
              updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS leases (
              name TEXT PRIMARY KEY,
              holder TEXT NOT NULL,
              expires_at REAL NOT NULL
            );
            """
        )
        self._db.execute(
            """
            INSERT INTO metadata(key,value) VALUES('schema_version',?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """,
            (str(STATE_SCHEMA_VERSION),),
        )

    @staticmethod
    def _atomic_bytes(path: Path, payload: bytes, mode: int) -> None:
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            try:
                os.chmod(path, mode)
            except OSError:
                pass
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
