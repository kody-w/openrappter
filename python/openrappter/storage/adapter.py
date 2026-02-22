import time
import uuid
from typing import Any, Optional


class StorageAdapter:
    """In-memory storage adapter for sessions, memory chunks, cron jobs/logs, and config KV."""

    def __init__(self):
        self._sessions = {}       # id -> dict
        self._chunks = {}         # id -> dict
        self._cron_jobs = {}      # id -> dict
        self._cron_logs = {}      # job_id -> [log_dicts]
        self._config = {}         # key -> value
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
        self._cron_jobs[job['id']] = job

    def get_cron_job(self, job_id: str) -> Optional[dict]:
        return self._cron_jobs.get(job_id)

    def delete_cron_job(self, job_id: str) -> bool:
        return self._cron_jobs.pop(job_id, None) is not None

    def list_cron_jobs(self) -> list:
        return list(self._cron_jobs.values())

    # --- Cron Logs ---

    def save_cron_log(self, log: dict) -> None:
        log = dict(log)
        log.setdefault('created_at', time.time())
        job_id = log.get('job_id', 'unknown')
        if job_id not in self._cron_logs:
            self._cron_logs[job_id] = []
        self._cron_logs[job_id].append(log)

    def get_cron_logs(self, job_id: str, limit: Optional[int] = None) -> list:
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


def create_storage_adapter(config: Optional[dict] = None) -> StorageAdapter:
    """Factory function. Config can have type='memory'. Always returns an in-memory adapter."""
    adapter = StorageAdapter()
    adapter.initialize()
    return adapter
