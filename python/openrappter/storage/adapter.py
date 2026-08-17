"""
StorageAdapter implementations for openrappter.

Provides an abstract ``StorageAdapter`` contract plus two concrete
implementations:

- ``InMemoryStorageAdapter`` — ephemeral, process-local storage. Useful for
  tests and explicit ``type='memory'`` configuration.
- ``SqliteStorageAdapter`` — production-quality, persistent storage backed by
  the stdlib ``sqlite3`` module. Data survives process restarts.

``create_storage_adapter(config)`` is the public factory. It honors the
supplied configuration rather than silently defaulting to memory-only
behavior: unless ``type='memory'`` is explicitly requested, a persistent
SQLite-backed adapter is returned.
"""

import abc
import contextlib
import json
import os
import sqlite3
import stat
import threading
import time
from pathlib import Path
from typing import Any, Iterator, Optional

DEFAULT_DB_PATH = Path.home() / ".openrappter" / "storage.db"

# Bump when the schema changes. Each entry is (version, sql_statements).
_MIGRATIONS = [
    (
        1,
        (
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                channel_id TEXT,
                data TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_sessions_channel_id ON sessions(channel_id)",
            """
            CREATE TABLE IF NOT EXISTS memory_chunks (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                created_at REAL NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS cron_jobs (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS cron_logs (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at REAL NOT NULL
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_cron_logs_job_id ON cron_logs(job_id, seq)",
            """
            CREATE TABLE IF NOT EXISTS config_kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """,
        ),
    ),
    (
        2,
        (
            "CREATE TEMP TABLE cron_logs_old_sequence (seq INTEGER NOT NULL)",
            """
            INSERT INTO cron_logs_old_sequence (seq)
            SELECT COALESCE(
                (SELECT seq FROM sqlite_sequence WHERE name = 'cron_logs'),
                0
            )
            """,
            """
            CREATE TABLE cron_logs_with_parent (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at REAL NOT NULL,
                FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
            )
            """,
            """
            INSERT INTO cron_logs_with_parent (seq, job_id, data, created_at)
            SELECT seq, job_id, data, created_at
            FROM cron_logs
            WHERE job_id IN (SELECT id FROM cron_jobs)
            """,
            "DROP TABLE cron_logs",
            "ALTER TABLE cron_logs_with_parent RENAME TO cron_logs",
            "DELETE FROM sqlite_sequence WHERE name = 'cron_logs'",
            """
            INSERT INTO sqlite_sequence (name, seq)
            SELECT 'cron_logs', seq FROM cron_logs_old_sequence
            """,
            "DROP TABLE cron_logs_old_sequence",
            "CREATE INDEX idx_cron_logs_job_id ON cron_logs(job_id, seq)",
        ),
    ),
]


def _require_cron_log_job_id(log: dict) -> str:
    job_id = log.get('job_id')
    if not isinstance(job_id, str) or not job_id.strip():
        raise ValueError("cron log requires an existing cron job id")
    return job_id


def _execute_with_busy_retry(
    conn: sqlite3.Connection,
    statement: str,
    timeout: float,
) -> sqlite3.Cursor:
    deadline = time.monotonic() + max(timeout, 0)
    while True:
        try:
            return conn.execute(statement)
        except sqlite3.OperationalError as error:
            if "locked" not in str(error).lower() or time.monotonic() >= deadline:
                raise
            time.sleep(min(0.05, max(deadline - time.monotonic(), 0)))


class StorageAdapter(abc.ABC):
    """
    Abstract storage contract for sessions, memory chunks, cron jobs/logs,
    and config KV. Mirrors ``typescript/src/storage/types.ts``'s
    ``StorageAdapter`` interface (subset relevant to the Python runtime).
    """

    @abc.abstractmethod
    def initialize(self) -> None:
        """Open/prepare the underlying storage (create schema, etc.)."""

    @abc.abstractmethod
    def close(self) -> None:
        """Release all resources held by the adapter."""

    # --- Sessions ---

    @abc.abstractmethod
    def save_session(self, session: dict) -> None: ...

    @abc.abstractmethod
    def get_session(self, session_id: str) -> Optional[dict]: ...

    @abc.abstractmethod
    def delete_session(self, session_id: str) -> bool: ...

    @abc.abstractmethod
    def list_sessions(self, filter_opts: Optional[dict] = None) -> list: ...

    # --- Memory Chunks ---

    @abc.abstractmethod
    def save_memory_chunk(self, chunk: dict) -> None: ...

    @abc.abstractmethod
    def get_memory_chunk(self, chunk_id: str) -> Optional[dict]: ...

    @abc.abstractmethod
    def delete_memory_chunk(self, chunk_id: str) -> bool: ...

    @abc.abstractmethod
    def list_memory_chunks(self) -> list: ...

    # --- Cron Jobs ---

    @abc.abstractmethod
    def save_cron_job(self, job: dict) -> None: ...

    @abc.abstractmethod
    def get_cron_job(self, job_id: str) -> Optional[dict]: ...

    @abc.abstractmethod
    def delete_cron_job(self, job_id: str) -> bool: ...

    @abc.abstractmethod
    def list_cron_jobs(self) -> list: ...

    # --- Cron Logs ---

    @abc.abstractmethod
    def save_cron_log(self, log: dict) -> None: ...

    @abc.abstractmethod
    def get_cron_logs(self, job_id: str, limit: Optional[int] = None) -> list: ...

    # --- Config KV ---

    @abc.abstractmethod
    def set_config(self, key: str, value: Any) -> None: ...

    @abc.abstractmethod
    def get_config(self, key: str) -> Any: ...

    @abc.abstractmethod
    def get_all_config(self) -> dict: ...

    @abc.abstractmethod
    def delete_config(self, key: str) -> bool: ...


class InMemoryStorageAdapter(StorageAdapter):
    """In-process, non-persistent storage adapter. Data is lost on close()."""

    def __init__(self):
        self._sessions = {}       # id -> dict
        self._chunks = {}         # id -> dict
        self._cron_jobs = {}      # id -> dict
        self._cron_logs = {}      # job_id -> [log_dicts]
        self._config = {}         # key -> value
        self._lock = threading.RLock()
        self._initialized = False

    def initialize(self):
        self._initialized = True

    def close(self):
        self._sessions.clear()
        self._chunks.clear()
        self._cron_jobs.clear()
        self._cron_logs.clear()
        self._config.clear()
        self._initialized = False

    # --- Sessions ---

    def save_session(self, session: dict) -> None:
        """Save a session dict. Must have 'id'. Adds timestamps."""
        session = dict(session)
        session.setdefault('created_at', time.time())
        session['updated_at'] = time.time()
        self._sessions[session['id']] = session

    def get_session(self, session_id: str) -> Optional[dict]:
        return self._sessions.get(session_id)

    def delete_session(self, session_id: str) -> bool:
        return self._sessions.pop(session_id, None) is not None

    def list_sessions(self, filter_opts: Optional[dict] = None) -> list:
        results = list(self._sessions.values())
        if filter_opts:
            if 'channel_id' in filter_opts:
                results = [s for s in results if s.get('channel_id') == filter_opts['channel_id']]
        return results

    # --- Memory Chunks ---

    def save_memory_chunk(self, chunk: dict) -> None:
        chunk = dict(chunk)
        chunk.setdefault('created_at', time.time())
        self._chunks[chunk['id']] = chunk

    def get_memory_chunk(self, chunk_id: str) -> Optional[dict]:
        return self._chunks.get(chunk_id)

    def delete_memory_chunk(self, chunk_id: str) -> bool:
        return self._chunks.pop(chunk_id, None) is not None

    def list_memory_chunks(self) -> list:
        return list(self._chunks.values())

    # --- Cron Jobs ---

    def save_cron_job(self, job: dict) -> None:
        job = dict(job)
        job.setdefault('created_at', time.time())
        job['updated_at'] = time.time()
        with self._lock:
            self._cron_jobs[job['id']] = job

    def get_cron_job(self, job_id: str) -> Optional[dict]:
        with self._lock:
            return self._cron_jobs.get(job_id)

    def delete_cron_job(self, job_id: str) -> bool:
        with self._lock:
            deleted = self._cron_jobs.pop(job_id, None) is not None
            if deleted:
                self._cron_logs.pop(job_id, None)
            return deleted

    def list_cron_jobs(self) -> list:
        with self._lock:
            return list(self._cron_jobs.values())

    # --- Cron Logs ---

    def save_cron_log(self, log: dict) -> None:
        log = dict(log)
        log.setdefault('created_at', time.time())
        job_id = _require_cron_log_job_id(log)
        with self._lock:
            if job_id not in self._cron_jobs:
                raise ValueError(f"cron job does not exist: {job_id}")
            if job_id not in self._cron_logs:
                self._cron_logs[job_id] = []
            self._cron_logs[job_id].append(log)

    def get_cron_logs(self, job_id: str, limit: Optional[int] = None) -> list:
        with self._lock:
            logs = self._cron_logs.get(job_id, [])
            if limit is not None:
                return list(logs[-limit:])
            return list(logs)

    # --- Config KV ---

    def set_config(self, key: str, value: Any) -> None:
        self._config[key] = value

    def get_config(self, key: str) -> Any:
        return self._config.get(key)

    def get_all_config(self) -> dict:
        return dict(self._config)

    def delete_config(self, key: str) -> bool:
        return self._config.pop(key, None) is not None


class SqliteStorageAdapter(StorageAdapter):
    """
    Persistent storage adapter backed by the stdlib ``sqlite3`` module.

    Records are stored as JSON blobs (round-tripping arbitrary
    JSON-serializable Python values) alongside a handful of indexed columns
    used for filtering. Every mutation runs inside a transaction so writes
    are atomic; failures are never swallowed.

    **Thread safety.** The adapter owns exactly one ``sqlite3.Connection``,
    opened with ``check_same_thread=False`` so it may be used from any thread
    (a ``ThreadPoolExecutor``, the gateway's executor, a cron worker, ...).
    That flag on its own would only trade an exception for a data race, so it
    is paired with a hard invariant: **the connection — and every cursor
    derived from it — is only ever touched while ``self._lock`` is held.**
    ``_connection()`` is the single door through which that happens; no method
    reaches ``self._conn`` directly, and every result set is materialized
    (``fetchone``/``fetchall``) before the lock is released, so no lazy cursor
    can be stepped while another thread is mid-statement.

    One shared, fully serialized connection is deliberate rather than a
    connection-per-thread pool: ``:memory:`` databases are private to their
    connection, so per-thread connections would silently give each thread its
    own empty database — writes would appear to succeed and then vanish, which
    is far worse than the ``ProgrammingError`` this replaces. It also keeps
    ``close()`` meaningful from any thread. WAL mode (already enabled) still
    provides concurrency across *processes*; within the process, correctness
    is bought at the cost of read parallelism, which is the right trade for a
    local-first runtime whose storage calls are sub-millisecond.
    """

    def __init__(self, path: Optional[Any] = None, timeout: float = 5.0):
        self._path = str(path) if path else str(DEFAULT_DB_PATH)
        self._timeout = timeout
        self._conn: Optional[sqlite3.Connection] = None
        self._lock = threading.RLock()
        self._initialized = False

    @property
    def path(self) -> str:
        return self._path

    def initialize(self) -> None:
        with self._lock:
            if self._initialized:
                return

            if sqlite3.threadsafety == 0:
                # SQLITE_THREADSAFE=0: the library keeps unprotected global
                # state, so no amount of Python-level locking can make a
                # connection safe to share across threads. Fail loudly rather
                # than hand back an adapter that silently corrupts data.
                raise RuntimeError(
                    "sqlite3 was built without thread safety "
                    "(sqlite3.threadsafety == 0); SqliteStorageAdapter cannot "
                    "guarantee its cross-thread contract on this interpreter."
                )

            if self._path != ":memory:":
                db_path = Path(self._path)
                db_path.parent.mkdir(parents=True, exist_ok=True)
                try:
                    os.chmod(db_path.parent, stat.S_IRWXU)  # 0o700, owner-only
                except OSError:
                    # Not all filesystems/platforms support chmod (e.g. some
                    # network shares). Directory creation already succeeded,
                    # so proceed rather than failing initialization.
                    pass

            conn = sqlite3.connect(
                self._path,
                timeout=self._timeout,
                isolation_level=None,
                check_same_thread=False,
            )
            conn.execute(f"PRAGMA busy_timeout={max(int(self._timeout * 1000), 0)}")
            _execute_with_busy_retry(conn, "PRAGMA journal_mode=WAL", self._timeout)
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA synchronous=NORMAL")
            self._conn = conn

            self._run_migrations()

            if self._path != ":memory:":
                try:
                    os.chmod(self._path, stat.S_IRUSR | stat.S_IWUSR)  # 0o600
                except OSError:
                    pass

            self._initialized = True

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None
            self._initialized = False

    def _ensure_open(self) -> sqlite3.Connection:
        if self._conn is None:
            raise RuntimeError(
                "SqliteStorageAdapter is not initialized. Call initialize() first."
            )
        return self._conn

    @contextlib.contextmanager
    def _connection(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        """
        The only sanctioned way to reach the shared connection.

        Holds ``self._lock`` for the whole body, so the openness check, the
        statement, and the materialization of its results are one atomic unit
        with respect to other threads (including a concurrent ``close()``).
        With ``write=True`` the body additionally runs inside the connection's
        transaction context manager, committing on success and rolling back on
        error before the lock is released.
        """
        with self._lock:
            conn = self._ensure_open()
            if write:
                with conn:
                    yield conn
            else:
                yield conn

    def _run_migrations(self) -> None:
        with self._connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at REAL NOT NULL
                )
                """
            )
            for version, statements in _MIGRATIONS:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    applied = conn.execute(
                        "SELECT 1 FROM schema_migrations WHERE version = ?",
                        (version,),
                    ).fetchone()
                    if applied:
                        conn.commit()
                        continue
                    for statement in statements:
                        conn.execute(statement)
                    conn.execute(
                        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                        (version, time.time()),
                    )
                    conn.commit()
                except Exception:
                    conn.rollback()
                    raise

    # --- Sessions ---

    def save_session(self, session: dict) -> None:
        session = dict(session)
        session.setdefault('created_at', time.time())
        session['updated_at'] = time.time()
        with self._connection(write=True) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO sessions (id, channel_id, data, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    session['id'],
                    session.get('channel_id'),
                    json.dumps(session),
                    session['created_at'],
                    session['updated_at'],
                ),
            )

    def get_session(self, session_id: str) -> Optional[dict]:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT data FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def delete_session(self, session_id: str) -> bool:
        with self._connection(write=True) as conn:
            cur = conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            return cur.rowcount > 0

    def list_sessions(self, filter_opts: Optional[dict] = None) -> list:
        sql = "SELECT data FROM sessions"
        params: list = []
        if filter_opts and 'channel_id' in filter_opts:
            sql += " WHERE channel_id = ?"
            params.append(filter_opts['channel_id'])
        with self._connection() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [json.loads(row[0]) for row in rows]

    # --- Memory Chunks ---

    def save_memory_chunk(self, chunk: dict) -> None:
        chunk = dict(chunk)
        chunk.setdefault('created_at', time.time())
        with self._connection(write=True) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO memory_chunks (id, data, created_at) VALUES (?, ?, ?)",
                (chunk['id'], json.dumps(chunk), chunk['created_at']),
            )

    def get_memory_chunk(self, chunk_id: str) -> Optional[dict]:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT data FROM memory_chunks WHERE id = ?", (chunk_id,)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def delete_memory_chunk(self, chunk_id: str) -> bool:
        with self._connection(write=True) as conn:
            cur = conn.execute("DELETE FROM memory_chunks WHERE id = ?", (chunk_id,))
            return cur.rowcount > 0

    def list_memory_chunks(self) -> list:
        with self._connection() as conn:
            rows = conn.execute("SELECT data FROM memory_chunks").fetchall()
        return [json.loads(row[0]) for row in rows]

    # --- Cron Jobs ---

    def save_cron_job(self, job: dict) -> None:
        job = dict(job)
        job.setdefault('created_at', time.time())
        job['updated_at'] = time.time()
        with self._connection(write=True) as conn:
            conn.execute(
                """
                INSERT INTO cron_jobs (id, data, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    data = excluded.data,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at
                """,
                (job['id'], json.dumps(job), job['created_at'], job['updated_at']),
            )

    def get_cron_job(self, job_id: str) -> Optional[dict]:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT data FROM cron_jobs WHERE id = ?", (job_id,)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def delete_cron_job(self, job_id: str) -> bool:
        with self._connection(write=True) as conn:
            cur = conn.execute("DELETE FROM cron_jobs WHERE id = ?", (job_id,))
            return cur.rowcount > 0

    def list_cron_jobs(self) -> list:
        with self._connection() as conn:
            rows = conn.execute("SELECT data FROM cron_jobs").fetchall()
        return [json.loads(row[0]) for row in rows]

    # --- Cron Logs ---

    def save_cron_log(self, log: dict) -> None:
        log = dict(log)
        log.setdefault('created_at', time.time())
        job_id = _require_cron_log_job_id(log)
        with self._connection(write=True) as conn:
            try:
                conn.execute(
                    "INSERT INTO cron_logs (job_id, data, created_at) VALUES (?, ?, ?)",
                    (job_id, json.dumps(log), log['created_at']),
                )
            except sqlite3.IntegrityError as error:
                if "FOREIGN KEY" in str(error).upper():
                    raise ValueError(f"cron job does not exist: {job_id}") from error
                raise

    def get_cron_logs(self, job_id: str, limit: Optional[int] = None) -> list:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT data FROM cron_logs WHERE job_id = ? ORDER BY seq ASC",
                (job_id,),
            ).fetchall()
        logs = [json.loads(row[0]) for row in rows]
        if limit is not None:
            return logs[-limit:]
        return logs

    # --- Config KV ---

    def set_config(self, key: str, value: Any) -> None:
        with self._connection(write=True) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO config_kv (key, value) VALUES (?, ?)",
                (key, json.dumps(value)),
            )

    def get_config(self, key: str) -> Any:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT value FROM config_kv WHERE key = ?", (key,)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def get_all_config(self) -> dict:
        with self._connection() as conn:
            rows = conn.execute("SELECT key, value FROM config_kv").fetchall()
        return {key: json.loads(value) for key, value in rows}

    def delete_config(self, key: str) -> bool:
        with self._connection(write=True) as conn:
            cur = conn.execute("DELETE FROM config_kv WHERE key = ?", (key,))
            return cur.rowcount > 0


def create_storage_adapter(config: Optional[dict] = None) -> StorageAdapter:
    """
    Factory function.

    ``config`` supports:
      - ``type``: ``'memory'`` for an ephemeral :class:`InMemoryStorageAdapter`,
        or ``'sqlite'`` (default) for a persistent :class:`SqliteStorageAdapter`.
      - ``path``: optional filesystem path for the sqlite database. Defaults
        to ``~/.openrappter/storage.db``.
      - ``in_memory``: when true with ``type='sqlite'``, uses SQLite's
        ``:memory:`` database (non-persistent but still exercises the SQL
        code path).

    Unknown ``type`` values raise ``ValueError`` — configuration is always
    honored, never silently ignored.
    """
    config = config or {}
    storage_type = config.get('type', 'sqlite')

    if storage_type == 'memory':
        adapter: StorageAdapter = InMemoryStorageAdapter()
    elif storage_type == 'sqlite':
        if config.get('in_memory'):
            path = ':memory:'
        else:
            path = config.get('path') or DEFAULT_DB_PATH
        adapter = SqliteStorageAdapter(path)
    else:
        raise ValueError(f"Unknown storage type: {storage_type!r}")

    adapter.initialize()
    return adapter
