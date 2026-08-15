"""Cross-runtime Show-and-Tell recording, analysis, and artifact building."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import unquote, urlsplit, urlunsplit

from openrappter.flight_recorder import (
    _assert_private_directory,
    _harden_private_path,
    sanitize_flight_value,
)


SHOW_AND_TELL_SCHEMA = "openrappter-show-and-tell/1.0"
SHOW_AND_TELL_ANALYSIS_SCHEMA = "openrappter-show-and-tell-analysis/1.0"
SHOW_AND_TELL_AUTOMATION_SCHEMA = "openrappter-automation/1.0"
DEFAULT_MAX_DURATION_MS = 8 * 60 * 60 * 1000
DEFAULT_POLL_INTERVAL_MS = 2_000
SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
OPAQUE_PATH_SEGMENT = re.compile(
    r"^(?:[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{36,})$",
    re.I,
)
JWT_TOKEN = re.compile(
    r"(?:^|[^A-Za-z0-9_-])"
    r"([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,})"
    r"(?:$|[^A-Za-z0-9_-])"
)
_CONSENT_AUTHORITY = object()
NAMED_KEYS = {
    "return", "enter", "tab", "space", "delete", "escape", "esc",
    "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
    "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
}
PRIVATE_CONTEXT = re.compile(
    r"\b(?:1password|bitwarden|keychain|password|passkey|credential|secret|"
    r"token|private key|security code|sign[ -]?in|log[ -]?in)\b",
    re.I,
)


def show_and_tell_root() -> Path:
    return Path(
        os.environ.get(
            "OPENRAPPTER_SHOW_AND_TELL_DIR",
            str(Path.home() / ".openrappter" / "show-and-tell"),
        )
    ).expanduser().absolute()


def _private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError(f"Show-and-Tell path is not a private directory: {path}")
    _harden_private_path(path, directory=True)
    _assert_private_directory(path)


def _private_file(path: Path) -> None:
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise RuntimeError(f"Show-and-Tell path is not a regular file: {path}")
    _harden_private_path(path)


def _write_private_text(path: Path, content: str) -> None:
    _private_directory(path.parent)
    if path.exists() and (path.is_symlink() or not path.is_file()):
        raise RuntimeError(f"Artifact destination is not a regular file: {path}")
    temporary = path.with_name(
        f"{path.name}.{os.getpid()}.{uuid.uuid4()}.tmp"
    )
    descriptor = None
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = None
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        _harden_private_path(temporary)
        os.replace(temporary, path)
        _harden_private_path(path)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def _safe_text(value: Any, max_length: int = 1000) -> str:
    if not isinstance(value, str):
        return ""
    bounded = "".join(list(value)[:max_length])
    sanitized = sanitize_flight_value(bounded)
    return sanitized if isinstance(sanitized, str) else ""


def privacy_reduced_url(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    try:
        parts = urlsplit(value.strip())
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            return ""
        hostname = parts.hostname
        if parts.port:
            hostname = f"{hostname}:{parts.port}"
        segments = [":id" if _opaque_segment(segment) else segment
                    for segment in parts.path.split("/")]
        reduced = urlunsplit(
            (parts.scheme, hostname, "/".join(segments), "", "")
        )
        return _safe_text(reduced, 1000)
    except (TypeError, ValueError):
        return ""


def _opaque_segment(segment: str) -> bool:
    candidate = unquote(segment)
    if JWT_TOKEN.search(candidate):
        return True
    if OPAQUE_PATH_SEGMENT.fullmatch(candidate):
        return True
    if len(candidate) < 16 or re.fullmatch(r"[A-Za-z0-9_-]+", candidate) is None:
        return False
    counts = {char: candidate.count(char) for char in set(candidate)}
    entropy = -sum(
        (count / len(candidate)) * math.log2(count / len(candidate))
        for count in counts.values()
    )
    return entropy >= 3.5


def is_private_context(app: str, window: str, url: str = "") -> bool:
    return bool(PRIVATE_CONTEXT.search(f"{app} {window} {unquote(url)}"))


def _contains_jwt(value: Any) -> bool:
    if isinstance(value, str):
        return bool(JWT_TOKEN.search(value) or JWT_TOKEN.search(unquote(value)))
    if isinstance(value, list):
        return any(_contains_jwt(item) for item in value)
    if isinstance(value, dict):
        return any(_contains_jwt(item) for item in value.values())
    return False


def artifact_contains_sensitive_text(content: str) -> bool:
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return _contains_jwt(content) or any(
            sanitize_flight_value(line) != line for line in content.splitlines()
        )
    return _contains_jwt(parsed) or sanitize_flight_value(parsed) != parsed


def safe_computer_action_data(
    action: str,
    kwargs: dict[str, Any],
    result: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    data: dict[str, Any] = {"action": action}
    if action == "type":
        text = kwargs.get("text") if isinstance(kwargs.get("text"), str) else ""
        data.update({"textLength": len(text), "textStored": False})
    elif action == "key":
        key = kwargs.get("text") if isinstance(kwargs.get("text"), str) else ""
        parts = [part.strip().lower() for part in key.split("+") if part.strip()]
        modifiers = {"cmd", "command", "ctrl", "control", "alt", "option", "shift"}
        non_text = (
            len(parts) == 1
            and parts[0] in NAMED_KEYS
        ) or (
            len(parts) > 1
            and all(part in modifiers for part in parts[:-1])
            and (parts[-1] in NAMED_KEYS or bool(re.fullmatch(r"[a-z0-9]", parts[-1])))
        )
        if non_text:
            data["key"] = _safe_text(key, 80)
        else:
            data.update({"keyLength": len(key), "keyStored": False})
    elif action in {"open_app", "activate_app"}:
        data["app"] = _safe_text(kwargs.get("text"), 120)
    else:
        for key in ("x", "y", "end_x", "end_y", "direction", "amount"):
            if key in kwargs:
                data[key] = kwargs[key]
    if isinstance(result, dict) and isinstance(result.get("status"), str):
        data["status"] = result["status"]
    sanitized = sanitize_flight_value(data)
    return sanitized if isinstance(sanitized, dict) else {}


class ShowAndTellStore:
    """SQLite session store shared by the TypeScript and Python runtimes."""

    def __init__(self, root: Optional[Path | str] = None):
        self.root = Path(root or show_and_tell_root()).expanduser().absolute()
        self.database_path = self.root / "show-and-tell.db"
        self._connection: Optional[sqlite3.Connection] = None

    def initialize(self) -> None:
        if self._connection is not None:
            return
        _private_directory(self.root)
        if self.database_path.exists() and (
            self.database_path.is_symlink()
            or not self.database_path.is_file()
        ):
            raise RuntimeError(
                "Show-and-Tell database must be a regular file."
            )
        connection = sqlite3.connect(
            self.database_path,
            timeout=5.0,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS show_sessions (
              id TEXT PRIMARY KEY,
              schema_version INTEGER NOT NULL DEFAULT 1,
              state TEXT NOT NULL,
              title TEXT NOT NULL,
              intent_hint TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              started_at INTEGER NOT NULL,
              stopped_at INTEGER,
              updated_at INTEGER NOT NULL,
              collector_runtime TEXT,
              collector_pid INTEGER,
              collector_nonce TEXT,
              collector_started_at INTEGER,
              collector_heartbeat_at INTEGER,
              stop_requested_at INTEGER,
              max_duration_ms INTEGER NOT NULL,
              poll_interval_ms INTEGER NOT NULL,
              last_error TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_show_sessions_state
              ON show_sessions(state, updated_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_show_one_active_session
              ON show_sessions((1))
              WHERE state IN ('recording', 'stopping');
            CREATE TABLE IF NOT EXISTS show_events (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL REFERENCES show_sessions(id) ON DELETE CASCADE,
              sequence INTEGER NOT NULL,
              timestamp INTEGER NOT NULL,
              type TEXT NOT NULL,
              source TEXT NOT NULL,
              data_json TEXT NOT NULL,
              UNIQUE(session_id, sequence)
            );
            CREATE INDEX IF NOT EXISTS idx_show_events_session
              ON show_events(session_id, sequence);
            CREATE TABLE IF NOT EXISTS show_analyses (
              session_id TEXT PRIMARY KEY REFERENCES show_sessions(id) ON DELETE CASCADE,
              revision INTEGER NOT NULL,
              approved INTEGER NOT NULL DEFAULT 0,
              analysis_json TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS show_artifacts (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL REFERENCES show_sessions(id) ON DELETE CASCADE,
              kind TEXT NOT NULL,
              name TEXT NOT NULL,
              path TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS show_consents (
              token_hash TEXT PRIMARY KEY,
              purpose TEXT NOT NULL,
              issued_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL
            );
            """
        )
        self._connection = connection
        _private_file(self.database_path)

    def close(self) -> None:
        if self._connection is not None:
            self._connection.close()
            self._connection = None

    @property
    def connection(self) -> sqlite3.Connection:
        if self._connection is None:
            raise RuntimeError("Show-and-Tell store is not initialized.")
        return self._connection

    def _rollback_quietly(self) -> None:
        try:
            self.connection.execute("ROLLBACK")
        except sqlite3.OperationalError:
            pass

    def session_dir(self, session_id: str) -> Path:
        if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
            raise ValueError(f"Invalid Show-and-Tell session id: {session_id}")
        base = (self.root / "sessions").absolute()
        candidate = (base / session_id).absolute()
        if candidate.parent != base:
            raise ValueError(f"Unsafe Show-and-Tell session id: {session_id}")
        return candidate

    def frames_dir(self, session_id: str) -> Path:
        return self.session_dir(session_id) / "frames"

    def _create_consent(
        self,
        authority: object,
        purpose: str,
        ttl_ms: int = 5 * 60 * 1000,
    ) -> str:
        if authority is not _CONSENT_AUTHORITY:
            raise RuntimeError(
                "Show-and-Tell consent can be issued only by the interactive broker."
            )
        self.initialize()
        token = secrets.token_hex(32)
        now = int(time.time() * 1000)
        self.connection.execute(
            "INSERT INTO show_consents(token_hash, purpose, issued_at, expires_at) "
            "VALUES (?, ?, ?, ?)",
            (hashlib.sha256(token.encode()).hexdigest(), purpose, now, now + ttl_ms),
        )
        return token

    def consume_consent(self, token: Any, purpose: str) -> bool:
        self.initialize()
        if not isinstance(token, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", token):
            return False
        digest = hashlib.sha256(token.encode()).hexdigest()
        try:
            self.connection.execute("BEGIN IMMEDIATE")
            row = self.connection.execute(
                "SELECT purpose, expires_at FROM show_consents WHERE token_hash = ?",
                (digest,),
            ).fetchone()
            self.connection.execute(
                "DELETE FROM show_consents WHERE token_hash = ?", (digest,)
            )
            self.connection.execute("COMMIT")
        except Exception:
            self._rollback_quietly()
            raise
        return bool(
            row
            and row["purpose"] == purpose
            and int(row["expires_at"]) >= int(time.time() * 1000)
        )

    def create_session(
        self,
        title: str = "",
        intent_hint: str = "",
        max_duration_ms: int = DEFAULT_MAX_DURATION_MS,
        poll_interval_ms: int = DEFAULT_POLL_INTERVAL_MS,
    ) -> dict[str, Any]:
        self.initialize()
        now = int(time.time() * 1000)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        session_id = f"{stamp}-{uuid.uuid4().hex[:8]}"
        max_duration_ms = max(60_000, min(int(max_duration_ms), DEFAULT_MAX_DURATION_MS))
        poll_interval_ms = max(500, min(int(poll_interval_ms), 60_000))
        try:
            self.connection.execute("BEGIN IMMEDIATE")
            self._recover_stale_rows(now, 30_000)
            active = self.connection.execute(
                """
                SELECT id, state FROM show_sessions
                WHERE state IN ('recording', 'stopping')
                ORDER BY started_at DESC LIMIT 1
                """
            ).fetchone()
            if active:
                raise RuntimeError(
                    f"Show-and-Tell session {active['id']} is already {active['state']}."
                )
            self.connection.execute(
                """
                INSERT INTO show_sessions(
                  id, state, title, intent_hint, created_at, started_at, stopped_at,
                  updated_at, max_duration_ms, poll_interval_ms
                ) VALUES (?, 'recording', ?, ?, ?, ?, NULL, ?, ?, ?)
                """,
                (
                    session_id,
                    _safe_text(title, 160),
                    _safe_text(intent_hint, 1000),
                    now,
                    now,
                    now,
                    max_duration_ms,
                    poll_interval_ms,
                ),
            )
            self.connection.execute("COMMIT")
        except Exception:
            self._rollback_quietly()
            raise
        try:
            _private_directory(self.session_dir(session_id))
            _private_directory(self.frames_dir(session_id))
        except Exception:
            self.connection.execute(
                "DELETE FROM show_sessions WHERE id = ?", (session_id,)
            )
            raise
        return self.get_session(session_id)

    def recover_stale_sessions(self, stale_after_ms: int = 30_000) -> int:
        self.initialize()
        return self._recover_stale_rows(
            int(time.time() * 1000), stale_after_ms
        )

    def _recover_stale_rows(self, now: int, stale_after_ms: int) -> int:
        cursor = self.connection.execute(
            """
            UPDATE show_sessions
            SET state = 'failed', stopped_at = ?, updated_at = ?,
                last_error = 'Collector heartbeat expired before the session was stopped.',
                collector_pid = NULL, collector_nonce = NULL
            WHERE state IN ('recording', 'stopping')
              AND (
                (collector_started_at IS NULL AND started_at < (
                  ? - CASE
                    WHEN poll_interval_ms * 5 > ? THEN poll_interval_ms * 5
                    ELSE ?
                  END
                ))
                OR (collector_started_at IS NOT NULL
                    AND COALESCE(collector_heartbeat_at, collector_started_at) < (
                      ? - CASE
                        WHEN poll_interval_ms * 5 > ? THEN poll_interval_ms * 5
                        ELSE ?
                      END
                    ))
              )
            """,
            (
                now,
                now,
                now,
                stale_after_ms,
                stale_after_ms,
                now,
                stale_after_ms,
                stale_after_ms,
            ),
        )
        return cursor.rowcount

    def get_session(self, session_id: str) -> Optional[dict[str, Any]]:
        self.initialize()
        if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
            return None
        row = self.connection.execute(
            "SELECT * FROM show_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        return self._session(row) if row else None

    def active_session(self) -> Optional[dict[str, Any]]:
        self.initialize()
        row = self.connection.execute(
            """
            SELECT * FROM show_sessions
            WHERE state IN ('recording', 'stopping')
            ORDER BY started_at DESC LIMIT 1
            """
        ).fetchone()
        return self._session(row) if row else None

    def latest_session(self) -> Optional[dict[str, Any]]:
        self.initialize()
        row = self.connection.execute(
            "SELECT * FROM show_sessions ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        return self._session(row) if row else None

    def list_sessions(self, limit: int = 50) -> list[dict[str, Any]]:
        self.initialize()
        rows = self.connection.execute(
            "SELECT * FROM show_sessions ORDER BY created_at DESC LIMIT ?",
            (max(1, min(int(limit), 500)),),
        ).fetchall()
        return [self._session(row) for row in rows]

    def append_event(
        self,
        session_id: str,
        event_type: str,
        source: str,
        data: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        self.initialize()
        try:
            self.connection.execute("BEGIN IMMEDIATE")
            exists = self.connection.execute(
                "SELECT id FROM show_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if not exists:
                raise RuntimeError(f"Show-and-Tell session not found: {session_id}")
            row = self.connection.execute(
                "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence "
                "FROM show_events WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            now = int(time.time() * 1000)
            sanitized = sanitize_flight_value(data or {})
            if not isinstance(sanitized, dict):
                sanitized = {}
            event = {
                "id": str(uuid.uuid4()),
                "sessionId": session_id,
                "sequence": int(row["sequence"]),
                "timestamp": now,
                "type": str(event_type)[:120],
                "source": str(source)[:120],
                "data": sanitized,
            }
            self.connection.execute(
                """
                INSERT INTO show_events(
                  id, session_id, sequence, timestamp, type, source, data_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event["id"],
                    session_id,
                    event["sequence"],
                    now,
                    event["type"],
                    event["source"],
                    json.dumps(sanitized, ensure_ascii=False),
                ),
            )
            self.connection.execute(
                "UPDATE show_sessions SET updated_at = ? WHERE id = ?",
                (now, session_id),
            )
            self.connection.execute("COMMIT")
            return event
        except Exception:
            self._rollback_quietly()
            raise

    def events(self, session_id: str) -> list[dict[str, Any]]:
        self.initialize()
        rows = self.connection.execute(
            "SELECT * FROM show_events WHERE session_id = ? ORDER BY sequence",
            (session_id,),
        ).fetchall()
        events = []
        for row in rows:
            try:
                data = json.loads(row["data_json"])
            except json.JSONDecodeError:
                data = {}
            events.append(
                {
                    "id": row["id"],
                    "sessionId": row["session_id"],
                    "sequence": row["sequence"],
                    "timestamp": row["timestamp"],
                    "type": row["type"],
                    "source": row["source"],
                    "data": data if isinstance(data, dict) else {},
                }
            )
        return events

    def attach_collector(
        self,
        session_id: str,
        runtime: str,
        pid: int,
        nonce: str,
    ) -> bool:
        self.initialize()
        now = int(time.time() * 1000)
        cursor = self.connection.execute(
            """
            UPDATE show_sessions
            SET collector_runtime = ?, collector_pid = ?, collector_nonce = ?,
                collector_started_at = ?, collector_heartbeat_at = ?, updated_at = ?
            WHERE id = ? AND state = 'recording'
            """,
            (runtime, pid, nonce, now, now, now, session_id),
        )
        return cursor.rowcount == 1

    def heartbeat(self, session_id: str, nonce: str) -> bool:
        self.initialize()
        now = int(time.time() * 1000)
        cursor = self.connection.execute(
            """
            UPDATE show_sessions
            SET collector_heartbeat_at = ?, updated_at = ?
            WHERE id = ? AND collector_nonce = ?
              AND state IN ('recording', 'stopping')
            """,
            (now, now, session_id, nonce),
        )
        return cursor.rowcount == 1

    def request_stop(self, session_id: str) -> dict[str, Any]:
        self.initialize()
        now = int(time.time() * 1000)
        cursor = self.connection.execute(
            """
            UPDATE show_sessions
            SET state = 'stopping', stop_requested_at = ?, updated_at = ?
            WHERE id = ? AND state = 'recording'
            """,
            (now, now, session_id),
        )
        session = self.get_session(session_id)
        if not session:
            raise RuntimeError(f"Show-and-Tell session not found: {session_id}")
        if cursor.rowcount == 0 and session["state"] != "stopping":
            raise RuntimeError(
                f"Show-and-Tell session {session_id} is {session['state']}."
            )
        return session

    def finish_session(
        self,
        session_id: str,
        state: str,
        nonce: Optional[str] = None,
        error: Optional[str] = None,
    ) -> bool:
        self.initialize()
        if state not in {"stopped", "failed"}:
            raise ValueError("Final Show-and-Tell state must be stopped or failed.")
        now = int(time.time() * 1000)
        sql = """
            UPDATE show_sessions
            SET state = ?, stopped_at = ?, updated_at = ?, last_error = ?,
                collector_pid = NULL, collector_nonce = NULL
            WHERE id = ? AND state IN ('recording', 'stopping')
        """
        params: list[Any] = [
            state,
            now,
            now,
            _safe_text(error, 500) if error else None,
            session_id,
        ]
        if nonce:
            sql += " AND collector_nonce = ?"
            params.append(nonce)
        return self.connection.execute(sql, params).rowcount == 1

    def save_analysis(self, analysis: dict[str, Any]) -> None:
        self.initialize()
        if analysis.get("schema") != SHOW_AND_TELL_ANALYSIS_SCHEMA:
            raise ValueError("Invalid Show-and-Tell analysis.")
        sanitized = sanitize_flight_value(analysis)
        if not isinstance(sanitized, dict):
            raise ValueError("Analysis could not be sanitized.")
        self.connection.execute(
            """
            INSERT INTO show_analyses(
              session_id, revision, approved, analysis_json, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              revision = excluded.revision,
              approved = excluded.approved,
              analysis_json = excluded.analysis_json,
              updated_at = excluded.updated_at
            """,
            (
                analysis["sessionId"],
                analysis["revision"],
                1 if analysis.get("approved") else 0,
                json.dumps(sanitized, ensure_ascii=False),
                analysis["updatedAt"],
            ),
        )

    def get_analysis(self, session_id: str) -> Optional[dict[str, Any]]:
        self.initialize()
        row = self.connection.execute(
            "SELECT analysis_json FROM show_analyses WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if not row:
            return None
        try:
            analysis = json.loads(row["analysis_json"])
        except json.JSONDecodeError:
            return None
        return (
            analysis
            if isinstance(analysis, dict)
            and analysis.get("schema") == SHOW_AND_TELL_ANALYSIS_SCHEMA
            else None
        )

    def record_artifact(
        self,
        session_id: str,
        kind: str,
        name: str,
        artifact_path: Path,
        content_hash: str,
    ) -> dict[str, Any]:
        self.initialize()
        artifact = {
            "id": str(uuid.uuid4()),
            "sessionId": session_id,
            "kind": kind,
            "name": name,
            "path": str(artifact_path),
            "contentHash": content_hash,
            "createdAt": int(time.time() * 1000),
        }
        self.connection.execute(
            "DELETE FROM show_artifacts WHERE session_id = ? AND kind = ? AND path = ?",
            (session_id, kind, str(artifact_path)),
        )
        self.connection.execute(
            """
            INSERT INTO show_artifacts(
              id, session_id, kind, name, path, content_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                artifact["id"],
                session_id,
                kind,
                name,
                str(artifact_path),
                content_hash,
                artifact["createdAt"],
            ),
        )
        return artifact

    def artifacts(self, session_id: str) -> list[dict[str, Any]]:
        self.initialize()
        rows = self.connection.execute(
            "SELECT * FROM show_artifacts WHERE session_id = ? ORDER BY created_at",
            (session_id,),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "sessionId": row["session_id"],
                "kind": row["kind"],
                "name": row["name"],
                "path": row["path"],
                "contentHash": row["content_hash"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ]

    def delete_session(self, session_id: str) -> bool:
        self.initialize()
        session = self.get_session(session_id)
        if not session:
            return False
        if session["state"] in {"recording", "stopping"}:
            raise RuntimeError("Stop the Show-and-Tell session before deleting it.")
        directory = self.session_dir(session_id)
        if directory.exists():
            if directory.is_symlink() or not directory.is_dir():
                raise RuntimeError(
                    "Refusing to delete a non-directory Show-and-Tell path."
                )
        if directory.exists():
            shutil.rmtree(directory)
        cursor = self.connection.execute(
            "DELETE FROM show_sessions WHERE id = ?", (session_id,)
        )
        return cursor.rowcount == 1

    @staticmethod
    def _session(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "schema": SHOW_AND_TELL_SCHEMA,
            "id": row["id"],
            "state": row["state"],
            "title": row["title"],
            "intentHint": row["intent_hint"],
            "captureMode": "context",
            "createdAt": row["created_at"],
            "startedAt": row["started_at"],
            "stoppedAt": row["stopped_at"],
            "updatedAt": row["updated_at"],
            "collectorRuntime": row["collector_runtime"],
            "collectorPid": row["collector_pid"],
            "collectorNonce": row["collector_nonce"],
            "collectorStartedAt": row["collector_started_at"],
            "collectorHeartbeatAt": row["collector_heartbeat_at"],
            "stopRequestedAt": row["stop_requested_at"],
            "maxDurationMs": row["max_duration_ms"],
            "pollIntervalMs": row["poll_interval_ms"],
            "lastError": row["last_error"],
        }


def request_interactive_consent(
    store: ShowAndTellStore,
    purpose: str,
    prompt: str,
) -> str:
    """Issue a one-use token only after direct terminal confirmation."""
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise RuntimeError(
            "Show-and-Tell consent requires an interactive local terminal."
        )
    answer = input(f"{prompt}\nType YES to continue: ").strip()
    if answer != "YES":
        raise RuntimeError("Show-and-Tell action cancelled.")
    return store._create_consent(_CONSENT_AUTHORITY, purpose)


def _run(args: list[str], timeout: float = 5.0) -> str:
    return subprocess.check_output(args, text=True, timeout=timeout).strip()


def read_active_context() -> dict[str, Any]:
    if os.environ.get("OPENRAPPTER_SHOW_TEST_MODE") == "1":
        return {
            "app": "ShowAndTellTestApp",
            "window": "Synthetic collector window",
            "url": "https://example.test/workflow",
            "windowId": "show-and-tell-test-window",
            "x": 0,
            "y": 0,
            "width": 800,
            "height": 600,
        }
    if sys.platform == "darwin":
        script = """
tell application "System Events"
  set frontApp to first process whose frontmost is true
  set appName to name of frontApp
  try
    set frontWindow to front window of frontApp
    set winName to name of frontWindow
    set winPosition to position of frontWindow
    set winSize to size of frontWindow
  on error
    set winName to ""
    set winPosition to {0, 0}
    set winSize to {0, 0}
  end try
end tell
return appName & linefeed & winName & linefeed & (item 1 of winPosition) & linefeed & (item 2 of winPosition) & linefeed & (item 1 of winSize) & linefeed & (item 2 of winSize)
"""
        output = _run(["/usr/bin/osascript", "-e", script])
        parts = output.splitlines()
        app = _safe_text(parts[0] if parts else "", 120)
        window = _safe_text(parts[1] if len(parts) > 1 else "", 240)
        x = int(parts[2]) if len(parts) > 2 and parts[2].lstrip("-").isdigit() else 0
        y = int(parts[3]) if len(parts) > 3 and parts[3].lstrip("-").isdigit() else 0
        width = int(parts[4]) if len(parts) > 4 and parts[4].isdigit() else 0
        height = int(parts[5]) if len(parts) > 5 and parts[5].isdigit() else 0
        details = {
            "windowId": f"{app}:{window}:{x}:{y}:{width}:{height}",
            "x": x,
            "y": y,
            "width": width,
            "height": height,
        }
        if is_private_context(app, window):
            return {
                "app": app,
                "window": "[private context]",
                "privateContext": True,
                **details,
            }
        browser_scripts = {
            "Safari": 'tell application "Safari" to return URL of front document',
            "Google Chrome": 'tell application "Google Chrome" to return URL of active tab of front window',
            "Chromium": 'tell application "Chromium" to return URL of active tab of front window',
            "Microsoft Edge": 'tell application "Microsoft Edge" to return URL of active tab of front window',
            "Brave Browser": 'tell application "Brave Browser" to return URL of active tab of front window',
            "Arc": 'tell application "Arc" to return URL of active tab of front window',
        }
        url = ""
        if app in browser_scripts:
            try:
                url = privacy_reduced_url(
                    _run(["/usr/bin/osascript", "-e", browser_scripts[app]], 3.0)
                )
            except (OSError, subprocess.SubprocessError):
                pass
        if is_private_context(app, window, url):
            return {
                "app": app,
                "window": "[private context]",
                "privateContext": True,
                **details,
            }
        return {
            "app": app,
            "window": window,
            **({"url": url} if url else {}),
            **details,
        }

    if os.name == "nt":
        script = r"""
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$handle = [ForegroundWindow]::GetForegroundWindow()
$builder = New-Object System.Text.StringBuilder 1024
[void][ForegroundWindow]::GetWindowText($handle, $builder, $builder.Capacity)
$processId = 0
[void][ForegroundWindow]::GetWindowThreadProcessId($handle, [ref]$processId)
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
$rect = New-Object ForegroundWindow+RECT
[void][ForegroundWindow]::GetWindowRect($handle, [ref]$rect)
@{
  app = $process.ProcessName
  window = $builder.ToString()
  windowId = $handle.ToInt64().ToString()
  x = $rect.Left
  y = $rect.Top
  width = $rect.Right - $rect.Left
  height = $rect.Bottom - $rect.Top
} | ConvertTo-Json -Compress
"""
        parsed = json.loads(
            _run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    script,
                ],
                8.0,
            )
        )
        app = _safe_text(parsed.get("app"), 120)
        window = _safe_text(parsed.get("window"), 240)
        details = {
            "windowId": _safe_text(parsed.get("windowId"), 80),
            "x": int(parsed.get("x") or 0),
            "y": int(parsed.get("y") or 0),
            "width": int(parsed.get("width") or 0),
            "height": int(parsed.get("height") or 0),
        }
        if is_private_context(app, window):
            return {
                "app": app,
                "window": "[private context]",
                "privateContext": True,
                **details,
            }
        return {"app": app, "window": window, **details}

    window_id = _run(["xdotool", "getactivewindow"], 3.0)
    window = _safe_text(_run(["xdotool", "getwindowname", window_id], 3.0), 240)
    pid = _run(["xdotool", "getwindowpid", window_id], 3.0)
    geometry = {}
    for line in _run(
        ["xdotool", "getwindowgeometry", "--shell", window_id], 3.0
    ).splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            geometry[key] = value
    try:
        app = _safe_text(_run(["ps", "-p", pid, "-o", "comm="], 3.0), 120)
    except (OSError, subprocess.SubprocessError):
        app = ""
    details = {
        "windowId": window_id,
        "x": int(geometry.get("X", 0)),
        "y": int(geometry.get("Y", 0)),
        "width": int(geometry.get("WIDTH", 0)),
        "height": int(geometry.get("HEIGHT", 0)),
    }
    if is_private_context(app, window):
        return {
            "app": app,
            "window": "[private context]",
            "privateContext": True,
            **details,
        }
    return {"app": app, "window": window, **details}


def assert_context_capture_available() -> None:
    if os.environ.get("OPENRAPPTER_SHOW_TEST_MODE") == "1":
        return
    if sys.platform == "darwin":
        for executable_path in ("/usr/bin/osascript", "/usr/sbin/screencapture"):
            if not os.access(executable_path, os.X_OK):
                raise RuntimeError(
                    "macOS Show-and-Tell requires osascript and screencapture."
                )
        return
    if os.name == "nt":
        return
    if os.environ.get("WAYLAND_DISPLAY") and not os.environ.get("DISPLAY"):
        raise RuntimeError(
            "Show-and-Tell desktop context capture currently requires an X11 "
            "session; Wayland-only capture is not yet supported."
        )
    if shutil.which("xdotool") is None:
        raise RuntimeError(
            "Show-and-Tell on Linux requires xdotool for active-window context capture."
        )


def capture_explicit_frame(path: Path, context: dict[str, Any]) -> None:
    if sys.platform == "darwin":
        if int(context.get("width") or 0) <= 0 or int(context.get("height") or 0) <= 0:
            raise RuntimeError("The active window bounds are unavailable.")
        subprocess.run(
            [
                "/usr/sbin/screencapture",
                "-x",
                (
                    f"-R{int(context.get('x') or 0)},"
                    f"{int(context.get('y') or 0)},"
                    f"{int(context['width'])},"
                    f"{int(context['height'])}"
                ),
                str(path),
            ],
            check=True,
            timeout=15,
        )
    elif os.name == "nt":
        if int(context.get("width") or 0) <= 0 or int(context.get("height") or 0) <= 0:
            raise RuntimeError("The active window bounds are unavailable.")
        script = r"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$path = $args[0]
$x = [int]$args[1]
$y = [int]$args[2]
$width = [int]$args[3]
$height = [int]$args[4]
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)
$bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
"""
        subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
                str(path),
                str(int(context.get("x") or 0)),
                str(int(context.get("y") or 0)),
                str(int(context.get("width") or 0)),
                str(int(context.get("height") or 0)),
            ],
            check=True,
            timeout=20,
        )
    else:
        try:
            if not context.get("windowId"):
                raise RuntimeError("The active window id is unavailable.")
            subprocess.run(
                ["import", "-window", str(context["windowId"]), str(path)],
                check=True,
                timeout=15,
            )
        except (OSError, subprocess.SubprocessError):
            subprocess.run(
                ["gnome-screenshot", "-w", "-f", str(path)],
                check=True,
                timeout=15,
            )
    if not path.exists():
        raise RuntimeError("The screenshot command did not create a frame.")
    _private_file(path)


def show_capture_notification(message: str) -> None:
    bounded = _safe_text(message, 180)
    try:
        if sys.platform == "darwin":
            subprocess.run(
                [
                    "/usr/bin/osascript",
                    "-e",
                    "on run argv",
                    "-e",
                    'display notification (item 1 of argv) with title "OpenRappter Show-and-Tell"',
                    "-e",
                    "end run",
                    bounded,
                ],
                check=False,
                timeout=5,
            )
        elif sys.platform.startswith("linux"):
            subprocess.run(
                ["notify-send", "OpenRappter Show-and-Tell", bounded],
                check=False,
                timeout=5,
            )
    except (OSError, subprocess.SubprocessError):
        pass


def spawn_collector(root: Path, session_id: str) -> dict[str, Any]:
    nonce = str(uuid.uuid4())
    kwargs: dict[str, Any] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
        "env": {**os.environ, "OPENRAPPTER_SHOW_AND_TELL_DIR": str(root)},
    }
    if os.name == "nt":
        kwargs["creationflags"] = (
            getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
        )
    else:
        kwargs["start_new_session"] = True
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "openrappter.show_and_tell_worker",
            str(root),
            session_id,
            nonce,
        ],
        **kwargs,
    )
    return {"pid": process.pid, "nonce": nonce, "verify": True}


def _retry_collector_write(
    operation: Callable[[], Any],
    attempts: int = 3,
) -> None:
    last_error: Optional[Exception] = None
    for attempt in range(attempts):
        try:
            operation()
            return
        except Exception as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(0.05 * (attempt + 1))
    if last_error is not None:
        raise last_error


def run_collector(root: Path | str, session_id: str, nonce: str) -> None:
    store = ShowAndTellStore(root)
    store.initialize()
    failed: Optional[str] = None
    attached = False
    try:
        attached = store.attach_collector(session_id, "python", os.getpid(), nonce)
        if not attached:
            return
        store.append_event(
            session_id,
            "collector.started",
            "python-collector",
            {"runtime": "python", "pid": os.getpid()},
        )
        show_capture_notification(
            "Recording app and window changes. Screenshots are explicit-only."
        )
        previous: Optional[dict[str, Any]] = None
        last_reminder = int(time.time() * 1000)
        last_heartbeat_event = 0
        consecutive_failures = 0
        while True:
            session = store.get_session(session_id)
            if (
                not session
                or session.get("collectorNonce") != nonce
                or session.get("state") != "recording"
            ):
                break
            now = int(time.time() * 1000)
            if now - int(session["startedAt"]) >= int(session["maxDurationMs"]):
                store.request_stop(session_id)
                break
            try:
                context = read_active_context()
                if not (
                    context.get("app")
                    or context.get("window")
                    or context.get("url")
                ):
                    raise RuntimeError(
                        "Context adapter returned no active application or window."
                    )
                consecutive_failures = 0
                if context != previous:
                    store.append_event(
                        session_id,
                        "app.activate",
                        "context-collector",
                        {
                            "app": context.get("app", ""),
                            "window": context.get("window", ""),
                            "privateContext": context.get("privateContext") is True,
                        },
                    )
                    if context.get("url") and context.get("url") != (
                        previous or {}
                    ).get("url"):
                        store.append_event(
                            session_id,
                            "browser.url",
                            "context-collector",
                            {
                                "app": context.get("app", ""),
                                "url": context["url"],
                            },
                        )
                    previous = context
            except Exception as exc:
                consecutive_failures += 1
                store.append_event(
                    session_id,
                    "collector.error",
                    "context-collector",
                    {"error": str(exc)},
                )
                if consecutive_failures >= 3:
                    raise RuntimeError(
                        "Context collector failed three consecutive samples."
                    )
            if not store.heartbeat(session_id, nonce):
                break
            if now - last_heartbeat_event >= 60_000:
                store.append_event(
                    session_id,
                    "collector.heartbeat",
                    "python-collector",
                    {},
                )
                last_heartbeat_event = now
            if now - last_reminder >= 10 * 60 * 1000:
                show_capture_notification(
                    "Show-and-Tell is still recording app and window changes."
                )
                last_reminder = now
            deadline = time.monotonic() + int(session["pollIntervalMs"]) / 1000
            keep_recording = True
            while time.monotonic() < deadline:
                time.sleep(min(0.25, max(0.001, deadline - time.monotonic())))
                current = store.get_session(session_id)
                if (
                    not current
                    or current.get("collectorNonce") != nonce
                    or current.get("state") != "recording"
                ):
                    keep_recording = False
                    break
            if not keep_recording:
                break
    except Exception as exc:
        failed = str(exc)
        try:
            store.append_event(
                session_id,
                "collector.error",
                "python-collector",
                {"error": failed},
            )
        except Exception:
            pass
    finally:
        if attached:
            finalization_error: Optional[Exception] = None
            try:
                try:
                    _retry_collector_write(
                        lambda: store.append_event(
                            session_id,
                            "collector.stopped",
                            "python-collector",
                            {"failed": bool(failed)},
                        )
                    )
                except Exception:
                    pass
                try:
                    _retry_collector_write(
                        lambda: store.finish_session(
                            session_id,
                            "failed" if failed else "stopped",
                            nonce=nonce,
                            error=failed,
                        )
                    )
                except Exception as exc:
                    finalization_error = exc
                show_capture_notification(
                    "Recording stopped. It is ready to analyze."
                    if not failed
                    else "Recording stopped because the collector failed."
                )
            finally:
                store.close()
            if finalization_error is not None:
                raise finalization_error
        else:
            store.close()
    if failed and not attached:
        raise RuntimeError(failed)


def _tool_for(app: str, url: str, action: str = "") -> str:
    if url:
        return "Browser or Web"
    if re.search(r"\b(?:terminal|iterm|powershell|command prompt|console)\b", app, re.I):
        return "Shell"
    if re.search(r"\b(?:finder|explorer|files)\b", app, re.I):
        return "Shell or filesystem"
    if action in {"read_screen", "screenshot"}:
        return "ComputerUse"
    return "Native app tool, otherwise ComputerUse" if app else "Best available native tool"


def _title_from_intent(intent: str) -> str:
    words = re.sub(r"[^\w\s-]", " ", intent, flags=re.UNICODE).split()
    return " ".join(words[:5]) or "Recorded workflow"


def build_deterministic_analysis(
    session: dict[str, Any],
    events: list[dict[str, Any]],
    previous: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    note = next(
        (
            _safe_text(event.get("data", {}).get("note"), 1000)
            for event in events
            if event.get("type") == "session.note"
            and _safe_text(event.get("data", {}).get("note"), 1000)
        ),
        "",
    )
    intent = _safe_text(session.get("intentHint"), 1200) or note or (
        "Repeat the demonstrated workflow"
    )
    steps: list[dict[str, Any]] = []
    current_app = ""
    for event in events:
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        candidate: Optional[dict[str, Any]] = None
        if event.get("type") == "manual.observation":
            title = _safe_text(data.get("title"), 160) or "Completed a demonstrated step"
            detail = _safe_text(data.get("detail"), 1200) or title
            app = _safe_text(data.get("app"), 160) or current_app
            url = _safe_text(data.get("url"), 1000)
            candidate = {
                "title": title,
                "detail": detail,
                "kind": "action",
                "tool": _tool_for(app, url),
                "app": app,
                "url": url,
                "confidence": "high",
            }
        elif event.get("type") == "computer.action":
            if data.get("status") == "error":
                continue
            action = _safe_text(data.get("action"), 80) or "action"
            app = _safe_text(data.get("app"), 160) or current_app
            label = action.replace("_", " ")
            candidate = {
                "title": label[:1].upper() + label[1:],
                "detail": f"Used {label}{f' in {app}' if app else ''}.",
                "kind": "action",
                "tool": _tool_for(app, "", action),
                "app": app,
                "url": "",
                "confidence": "high",
            }
        elif event.get("type") == "browser.url":
            url = _safe_text(data.get("url"), 1000)
            app = _safe_text(data.get("app"), 160) or current_app
            if url:
                candidate = {
                    "title": "Opened a browser destination",
                    "detail": f"Navigated to {url}.",
                    "kind": "action",
                    "tool": _tool_for(app, url),
                    "app": app,
                    "url": url,
                    "confidence": "high",
                }
        elif event.get("type") == "app.activate":
            app = _safe_text(data.get("app"), 160)
            window = _safe_text(data.get("window"), 240)
            current_app = app or current_app
            if app and not data.get("privateContext"):
                candidate = {
                    "title": f"Worked in {app}",
                    "detail": (
                        f'Opened or focused "{window}" in {app}.'
                        if window
                        else f"Opened or focused {app}."
                    ),
                    "kind": "action",
                    "tool": _tool_for(app, ""),
                    "app": app,
                    "url": "",
                    "confidence": "medium",
                }
        elif event.get("type") == "frame.captured":
            label = _safe_text(data.get("label"), 160)
            if label:
                candidate = {
                    "title": label,
                    "detail": (
                        "Captured an explicit local reference frame for this point "
                        "in the workflow."
                    ),
                    "kind": "action",
                    "tool": _tool_for(current_app, "", "screenshot"),
                    "app": current_app,
                    "url": "",
                    "confidence": "medium",
                }
        elif event.get("type") == "session.note":
            narration = _safe_text(data.get("note"), 1200)
            if narration:
                if steps:
                    steps[-1]["detail"] = _safe_text(
                        f'{steps[-1]["detail"]} Narration: {narration}',
                        1200,
                    )
                    steps[-1]["evidence"].append(
                        f"event:{event.get('sequence', 0)}:{event.get('type', '')}"
                    )
                    if steps[-1]["confidence"] == "low":
                        steps[-1]["confidence"] = "medium"
                    continue
                candidate = {
                    "title": "Follow the narrated instruction",
                    "detail": narration,
                    "kind": "action",
                    "tool": _tool_for(current_app, ""),
                    "app": current_app,
                    "url": "",
                    "confidence": "medium",
                }
        if not candidate:
            continue
        evidence = [f"event:{event.get('sequence', 0)}:{event.get('type', '')}"]
        if (
            steps
            and steps[-1]["title"] == candidate["title"]
            and steps[-1]["app"] == candidate["app"]
            and steps[-1]["url"] == candidate["url"]
        ):
            steps[-1]["evidence"].extend(evidence)
            continue
        candidate.update({"id": f"s{len(steps) + 1}", "evidence": evidence})
        steps.append(candidate)
        if len(steps) >= 60:
            break
    if not steps:
        steps = [
            {
                "id": "s1",
                "title": "Repeat the demonstrated task",
                "detail": (
                    "Use the session notes and explicit observations to reproduce "
                    "the demonstrated outcome."
                ),
                "kind": "action",
                "tool": "Best available native tool",
                "app": "",
                "url": "",
                "evidence": ["event:0:session.started"],
                "confidence": "low",
            }
        ]
    high_evidence = sum(step["confidence"] == "high" for step in steps)
    confidence = "high" if high_evidence >= 2 else ("medium" if len(steps) >= 2 else "low")
    now = int(time.time() * 1000)
    return {
        "schema": SHOW_AND_TELL_ANALYSIS_SCHEMA,
        "sessionId": session["id"],
        "revision": int((previous or {}).get("revision", 0)) + 1,
        "title": _safe_text(session.get("title"), 160) or _title_from_intent(intent),
        "intent": intent,
        "intentRationale": (
            f"Reconstructed from {len(events)} local event(s), including "
            f"{len(steps)} distinct workflow step(s)."
        ),
        "intentConfidence": confidence,
        "steps": steps,
        "feedbackLog": list((previous or {}).get("feedbackLog", [])),
        "approved": False,
        "approvedAt": None,
        "createdAt": int((previous or {}).get("createdAt", now)),
        "updatedAt": now,
    }


def analyze_session(
    store: ShowAndTellStore, session: dict[str, Any]
) -> dict[str, Any]:
    analysis = build_deterministic_analysis(
        session,
        store.events(session["id"]),
        store.get_analysis(session["id"]),
    )
    store.save_analysis(analysis)
    return analysis


def revise_analysis(
    current: dict[str, Any],
    title: Any = None,
    intent: Any = None,
    steps_json: Any = None,
    feedback: Any = None,
    approve: bool = False,
) -> dict[str, Any]:
    steps = current["steps"]
    if isinstance(steps_json, str) and steps_json.strip():
        parsed = json.loads(steps_json)
        if not isinstance(parsed, list) or not parsed or len(parsed) > 60:
            raise ValueError("steps_json must be a non-empty JSON array of at most 60 steps.")
        required = {"id", "title", "detail"}
        if any(not isinstance(step, dict) or not required.issubset(step) for step in parsed):
            raise ValueError("Every edited step requires id, title, and detail.")
        steps = parsed
    note = _safe_text(feedback, 2000)
    now = int(time.time() * 1000)
    revised = {
        **current,
        "revision": int(current["revision"]) + 1,
        "title": _safe_text(title, 160) or current["title"],
        "intent": _safe_text(intent, 1200) or current["intent"],
        "steps": steps,
        "feedbackLog": (
            [*current.get("feedbackLog", []), {"at": now, "feedback": note}]
            if note
            else list(current.get("feedbackLog", []))
        ),
        "approved": bool(approve),
        "approvedAt": now if approve else None,
        "updatedAt": now,
    }
    return revised


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:60].rstrip("-")
    return slug or "recorded-workflow"


def _destination(root: Path, base_name: str, session_id: str, kind: str) -> Path:
    _private_directory(root)
    candidate = root / base_name
    same_session = False
    manifest = candidate / "manifest.json"
    safe_candidate = (
        not candidate.exists()
        or (not candidate.is_symlink() and candidate.is_dir())
    )
    if safe_candidate and kind == "skill" and manifest.exists():
        try:
            same_session = (
                json.loads(manifest.read_text()).get("sourceSessionId") == session_id
            )
        except (OSError, json.JSONDecodeError):
            pass
    if candidate.exists() and (not safe_candidate or not same_session):
        index = 2
        while (root / f"{base_name}-{index}").exists():
            index += 1
        candidate = root / f"{base_name}-{index}"
    _private_directory(candidate)
    return candidate


def _render_skill(analysis: dict[str, Any], name: str) -> str:
    tools = list(dict.fromkeys(step.get("tool", "") for step in analysis["steps"]))
    tools = [tool for tool in tools if tool]
    lines = [
        "---",
        f"name: {name}",
        f"description: {json.dumps(analysis['intent'], ensure_ascii=False)}",
        "metadata:",
        '  source: "openrappter-show-and-tell"',
        f"  session: {json.dumps(analysis['sessionId'])}",
    ]
    if tools:
        lines.append("allowed-tools:")
        lines.extend(f"  - {json.dumps(tool)}" for tool in tools)
    lines.extend(
        [
            "---",
            "",
            f"# {analysis['title']}",
            "",
            "## Goal",
            "",
            analysis["intent"],
            "",
            "## Procedure",
            "",
        ]
    )
    for index, step in enumerate(analysis["steps"], 1):
        line = f"{index}. **{step['title']}** — {step['detail']}"
        if step.get("tool"):
            line += f" Prefer `{step['tool']}`."
        if step.get("url"):
            line += f" Destination: {step['url']}"
        lines.append(line)
    lines.extend(
        [
            "",
            "## Execution rules",
            "",
            "- Prefer a native API, CLI, filesystem, or browser tool over replaying screen coordinates.",
            "- Treat UI automation as a fallback and re-locate controls by meaning, not by recorded pixels.",
            "- Ask before destructive, financial, publishing, or message-sending actions.",
            "- Never request, persist, or echo credentials from the demonstration.",
            "",
        ]
    )
    return "\n".join(lines)


def build_artifacts(
    store: ShowAndTellStore,
    analysis: dict[str, Any],
    target: str = "skill",
) -> list[dict[str, Any]]:
    if not analysis.get("approved"):
        raise RuntimeError(
            "Approve the Show-and-Tell analysis before building artifacts."
        )
    if target not in {"skill", "automation", "all"}:
        target = "skill"
    name = _slugify(analysis.get("title") or analysis["intent"])
    artifacts = []
    if target in {"skill", "all"}:
        root = Path(
            os.environ.get(
                "OPENRAPPTER_SKILLS_DIR",
                str(Path.home() / ".openrappter" / "skills"),
            )
        ).expanduser().absolute()
        directory = _destination(root, name, analysis["sessionId"], "skill")
        markdown = _render_skill(analysis, directory.name)
        manifest = json.dumps(
            {
                "id": f"show-and-tell/{directory.name}",
                "name": directory.name,
                "version": "1.0.0",
                "description": analysis["intent"],
                "tags": ["show-and-tell", "recorded-workflow"],
                "sourceSessionId": analysis["sessionId"],
                "generatedBy": "OpenRappter Show-and-Tell",
            },
            indent=2,
            ensure_ascii=False,
        ) + "\n"
        if artifact_contains_sensitive_text(markdown):
            raise RuntimeError("Privacy scan rejected the generated SKILL.md.")
        if artifact_contains_sensitive_text(manifest):
            raise RuntimeError("Privacy scan rejected the generated skill manifest.")
        skill_path = directory / "SKILL.md"
        _write_private_text(skill_path, markdown)
        manifest_path = directory / "manifest.json"
        _write_private_text(manifest_path, manifest)
        artifacts.append(
            store.record_artifact(
                analysis["sessionId"],
                "skill",
                directory.name,
                skill_path,
                hashlib.sha256(
                    markdown.encode() + b"\0" + manifest.encode()
                ).hexdigest(),
            )
        )
    if target in {"automation", "all"}:
        root = Path(
            os.environ.get(
                "OPENRAPPTER_AUTOMATIONS_DIR",
                str(Path.home() / ".openrappter" / "automations"),
            )
        ).expanduser().absolute()
        directory = _destination(root, name, analysis["sessionId"], "automation")
        content = json.dumps(
            {
                "schema": SHOW_AND_TELL_AUTOMATION_SCHEMA,
                "name": directory.name,
                "description": analysis["intent"],
                "enabled": False,
                "trigger": {"type": "manual"},
                "sourceSessionId": analysis["sessionId"],
                "steps": [
                    {
                        "id": step.get("id", f"s{index}"),
                        "label": step["title"],
                        "prompt": (
                            step["detail"]
                            + (f" Prefer {step['tool']}." if step.get("tool") else "")
                            + (f" Use {step['url']}." if step.get("url") else "")
                        ),
                    }
                    for index, step in enumerate(analysis["steps"], 1)
                ],
            },
            indent=2,
            ensure_ascii=False,
        ) + "\n"
        if artifact_contains_sensitive_text(content):
            raise RuntimeError("Privacy scan rejected the generated automation.")
        automation_path = directory / "automation.json"
        _write_private_text(automation_path, content)
        artifacts.append(
            store.record_artifact(
                analysis["sessionId"],
                "automation",
                directory.name,
                automation_path,
                hashlib.sha256(content.encode()).hexdigest(),
            )
        )
    return artifacts


def test_artifacts(store: ShowAndTellStore, session_id: str) -> dict[str, Any]:
    analysis = store.get_analysis(session_id)
    artifacts = store.artifacts(session_id)
    checks = [
        {
            "name": "analysis-approved",
            "ok": bool(analysis and analysis.get("approved")),
            "detail": (
                "Analysis is approved."
                if analysis and analysis.get("approved")
                else "Analysis is not approved."
            ),
        },
        {
            "name": "artifacts-exist",
            "ok": bool(artifacts),
            "detail": f"{len(artifacts)} artifact(s) recorded.",
        },
    ]
    for artifact in artifacts:
        path = Path(artifact["path"])
        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            checks.append(
                {
                    "name": f"{artifact['kind']}-exists",
                    "ok": False,
                    "detail": f"Missing {path}",
                }
            )
            continue
        checks.append(
            {
                "name": f"{artifact['kind']}-exists",
                "ok": True,
                "detail": str(path),
            }
        )
        digest = hashlib.sha256(content.encode()).hexdigest()
        privacy_safe = not artifact_contains_sensitive_text(content)
        if artifact["kind"] == "skill":
            manifest_path = path.parent / "manifest.json"
            try:
                manifest = manifest_path.read_text(encoding="utf-8")
                parsed_manifest = json.loads(manifest)
                manifest_ok = (
                    parsed_manifest.get("sourceSessionId") == session_id
                    and parsed_manifest.get("name") == artifact["name"]
                    and not artifact_contains_sensitive_text(manifest)
                )
                checks.append(
                    {
                        "name": "skill-manifest",
                        "ok": manifest_ok,
                        "detail": (
                            "Manifest matches the recorded session and skill."
                            if manifest_ok
                            else "Manifest is missing, changed, or belongs to another session."
                        ),
                    }
                )
                privacy_safe = (
                    privacy_safe
                    and not artifact_contains_sensitive_text(manifest)
                )
                digest = hashlib.sha256(
                    content.encode() + b"\0" + manifest.encode()
                ).hexdigest()
            except (OSError, json.JSONDecodeError):
                checks.append(
                    {
                        "name": "skill-manifest",
                        "ok": False,
                        "detail": f"Missing or invalid {manifest_path}",
                    }
                )
        checks.append(
            {
                "name": f"{artifact['kind']}-integrity",
                "ok": digest == artifact["contentHash"],
                "detail": (
                    "Content hash matches."
                    if digest == artifact["contentHash"]
                    else "Content hash changed."
                ),
            }
        )
        checks.append(
            {
                "name": f"{artifact['kind']}-privacy",
                "ok": privacy_safe,
                "detail": "Artifact contains no secret-shaped text.",
            }
        )
        if artifact["kind"] == "automation":
            try:
                parsed = json.loads(content)
                shape_ok = (
                    parsed.get("schema") == SHOW_AND_TELL_AUTOMATION_SCHEMA
                    and parsed.get("enabled") is False
                )
            except json.JSONDecodeError:
                shape_ok = False
            checks.append(
                {
                    "name": "automation-shape",
                    "ok": shape_ok,
                    "detail": "Automation is versioned and disabled by default.",
                }
            )
    return {"ok": all(check["ok"] for check in checks), "checks": checks}


def replay_plan(analysis: dict[str, Any]) -> dict[str, Any]:
    return {
        "mode": "dry-run",
        "intent": _safe_text(analysis.get("intent"), 1200),
        "steps": [
            {
                "number": index,
                "title": step["title"],
                "tool": step.get("tool", ""),
                "action": step["detail"],
            }
            for index, step in enumerate(analysis["steps"], 1)
        ],
        "warning": (
            "Dry run only. Show-and-Tell never blindly replays recorded "
            "coordinates or submits side effects."
        ),
    }


def record_active_computer_action(
    action: str,
    kwargs: dict[str, Any],
    result: Optional[dict[str, Any]] = None,
) -> None:
    store = ShowAndTellStore()
    try:
        store.initialize()
        session = store.active_session()
        if not session or session["state"] != "recording":
            return
        store.append_event(
            session["id"],
            "computer.action",
            "computer-use",
            safe_computer_action_data(action, kwargs, result),
        )
    except Exception:
        pass
    finally:
        store.close()


__all__ = [
    "SHOW_AND_TELL_SCHEMA",
    "SHOW_AND_TELL_ANALYSIS_SCHEMA",
    "SHOW_AND_TELL_AUTOMATION_SCHEMA",
    "ShowAndTellStore",
    "request_interactive_consent",
    "show_and_tell_root",
    "privacy_reduced_url",
    "is_private_context",
    "safe_computer_action_data",
    "read_active_context",
    "assert_context_capture_available",
    "capture_explicit_frame",
    "spawn_collector",
    "run_collector",
    "build_deterministic_analysis",
    "analyze_session",
    "revise_analysis",
    "build_artifacts",
    "test_artifacts",
    "replay_plan",
    "record_active_computer_action",
]
