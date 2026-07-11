"""
SqliteStorageAdapter behavioral tests: restart persistence, memory-mode
isolation, filtering/CRUD compatibility with the in-memory adapter, corrupt
/ invalid input handling, and factory selection.
"""

import json
import sqlite3
import stat
import sys

import pytest

from openrappter.storage import adapter as adapter_module
from openrappter.storage.adapter import (
    InMemoryStorageAdapter,
    SqliteStorageAdapter,
    StorageAdapter,
    create_storage_adapter,
)


@pytest.fixture(autouse=True)
def _isolated_default_db_path(tmp_path, monkeypatch):
    """Keep the factory's implicit default path off the real home directory."""
    monkeypatch.setattr(adapter_module, 'DEFAULT_DB_PATH', tmp_path / 'default' / 'storage.db')


# --- Factory selection ---

def test_factory_defaults_to_sqlite(tmp_path):
    db_path = tmp_path / "db1.sqlite3"
    result = create_storage_adapter({'path': str(db_path)})
    try:
        assert isinstance(result, SqliteStorageAdapter)
        assert isinstance(result, StorageAdapter)
        assert db_path.exists()
    finally:
        result.close()


def test_factory_explicit_memory_type_returns_in_memory_adapter():
    result = create_storage_adapter({'type': 'memory'})
    assert isinstance(result, InMemoryStorageAdapter)
    assert isinstance(result, StorageAdapter)


def test_factory_honors_explicit_sqlite_type_and_path(tmp_path):
    db_path = tmp_path / "explicit.sqlite3"
    result = create_storage_adapter({'type': 'sqlite', 'path': str(db_path)})
    try:
        assert isinstance(result, SqliteStorageAdapter)
        assert result.path == str(db_path)
        assert db_path.exists()
    finally:
        result.close()


def test_factory_rejects_unknown_type():
    with pytest.raises(ValueError, match="Unknown storage type"):
        create_storage_adapter({'type': 'postgres'})


def test_factory_no_args_uses_persistent_default(tmp_path, monkeypatch):
    monkeypatch.setattr(adapter_module, 'DEFAULT_DB_PATH', tmp_path / 'nested' / 'storage.db')
    result = create_storage_adapter()
    try:
        assert isinstance(result, SqliteStorageAdapter)
        assert (tmp_path / 'nested' / 'storage.db').exists()
    finally:
        result.close()


# --- Restart persistence (the core new behavior) ---

def test_sqlite_adapter_persists_sessions_across_restart(tmp_path):
    db_path = tmp_path / "restart.sqlite3"

    adapter1 = create_storage_adapter({'type': 'sqlite', 'path': str(db_path)})
    adapter1.save_session({'id': 'sess-1', 'channel_id': 'slack', 'payload': {'a': 1}})
    adapter1.save_memory_chunk({'id': 'chunk-1', 'content': 'hello world', 'embedding': [0.1, 0.2]})
    adapter1.save_cron_job({'id': 'job-1', 'name': 'nightly', 'enabled': True})
    adapter1.save_cron_log({'job_id': 'job-1', 'status': 'ok'})
    adapter1.set_config('theme', 'dark')
    adapter1.close()

    # Simulate an application restart: brand new adapter instance, same path.
    adapter2 = create_storage_adapter({'type': 'sqlite', 'path': str(db_path)})
    try:
        session = adapter2.get_session('sess-1')
        assert session is not None
        assert session['channel_id'] == 'slack'
        assert session['payload'] == {'a': 1}

        chunk = adapter2.get_memory_chunk('chunk-1')
        assert chunk is not None
        assert chunk['content'] == 'hello world'
        assert chunk['embedding'] == [0.1, 0.2]

        job = adapter2.get_cron_job('job-1')
        assert job is not None
        assert job['name'] == 'nightly'
        assert job['enabled'] is True

        logs = adapter2.get_cron_logs('job-1')
        assert len(logs) == 1
        assert logs[0]['status'] == 'ok'

        assert adapter2.get_config('theme') == 'dark'
    finally:
        adapter2.close()


def test_sqlite_adapter_survives_multiple_restarts_with_updates(tmp_path):
    db_path = tmp_path / "multi_restart.sqlite3"

    a1 = create_storage_adapter({'type': 'sqlite', 'path': str(db_path)})
    a1.save_session({'id': 's1', 'channel_id': 'slack', 'v': 1})
    a1.close()

    a2 = create_storage_adapter({'type': 'sqlite', 'path': str(db_path)})
    assert a2.get_session('s1')['v'] == 1
    a2.save_session({'id': 's1', 'channel_id': 'slack', 'v': 2})
    a2.close()

    a3 = create_storage_adapter({'type': 'sqlite', 'path': str(db_path)})
    try:
        assert a3.get_session('s1')['v'] == 2
    finally:
        a3.close()


def test_sqlite_adapter_creates_parent_directories(tmp_path):
    db_path = tmp_path / "nested" / "dirs" / "storage.db"
    assert not db_path.parent.exists()

    result = create_storage_adapter({'type': 'sqlite', 'path': str(db_path)})
    try:
        assert db_path.parent.exists()
        assert db_path.exists()
    finally:
        result.close()


@pytest.mark.skipif(sys.platform.startswith('win'), reason="POSIX file permissions only")
def test_sqlite_adapter_restricts_file_permissions(tmp_path):
    db_path = tmp_path / "perm.sqlite3"
    result = create_storage_adapter({'type': 'sqlite', 'path': str(db_path)})
    try:
        mode = stat.S_IMODE(db_path.stat().st_mode)
        assert mode == stat.S_IRUSR | stat.S_IWUSR  # 0o600
        dir_mode = stat.S_IMODE(db_path.parent.stat().st_mode)
        assert dir_mode == stat.S_IRWXU  # 0o700
    finally:
        result.close()


# --- Memory-mode isolation ---

def test_memory_adapters_are_isolated_from_each_other():
    a1 = create_storage_adapter({'type': 'memory'})
    a2 = create_storage_adapter({'type': 'memory'})

    a1.save_session({'id': 'sess-only-in-a1', 'channel_id': 'x'})
    assert a2.get_session('sess-only-in-a1') is None


def test_memory_adapter_never_touches_disk(tmp_path, monkeypatch):
    # Even if DEFAULT_DB_PATH pointed somewhere, memory mode must not create files.
    monkeypatch.setattr(adapter_module, 'DEFAULT_DB_PATH', tmp_path / 'unused' / 'storage.db')
    a = create_storage_adapter({'type': 'memory'})
    a.save_session({'id': 's', 'channel_id': 'c'})
    assert not (tmp_path / 'unused').exists()


# --- Filtering / CRUD parity with the in-memory adapter ---

@pytest.fixture(params=['memory', 'sqlite'])
def any_adapter(request, tmp_path):
    if request.param == 'memory':
        result = create_storage_adapter({'type': 'memory'})
    else:
        result = create_storage_adapter({'type': 'sqlite', 'path': str(tmp_path / 'crud.sqlite3')})
    yield result
    result.close()


def test_session_crud_parity(any_adapter):
    any_adapter.save_session({'id': 's1', 'channel_id': 'slack', 'note': 'a'})
    any_adapter.save_session({'id': 's2', 'channel_id': 'discord', 'note': 'b'})

    assert any_adapter.get_session('s1')['note'] == 'a'
    assert len(any_adapter.list_sessions()) == 2

    slack_only = any_adapter.list_sessions({'channel_id': 'slack'})
    assert len(slack_only) == 1
    assert slack_only[0]['id'] == 's1'

    assert any_adapter.delete_session('s1') is True
    assert any_adapter.get_session('s1') is None
    assert any_adapter.delete_session('s1') is False


def test_memory_chunk_crud_parity(any_adapter):
    any_adapter.save_memory_chunk({'id': 'c1', 'content': 'foo', 'embedding': [1.0, 2.0]})
    any_adapter.save_memory_chunk({'id': 'c2', 'content': 'bar'})

    assert len(any_adapter.list_memory_chunks()) == 2
    assert any_adapter.get_memory_chunk('c1')['embedding'] == [1.0, 2.0]
    assert any_adapter.delete_memory_chunk('c2') is True
    assert len(any_adapter.list_memory_chunks()) == 1


def test_cron_job_and_log_crud_parity(any_adapter):
    any_adapter.save_cron_job({'id': 'j1', 'name': 'Job One', 'enabled': True})
    any_adapter.save_cron_log({'job_id': 'j1', 'status': 'ok', 'n': 1})
    any_adapter.save_cron_log({'job_id': 'j1', 'status': 'ok', 'n': 2})
    any_adapter.save_cron_log({'job_id': 'j1', 'status': 'ok', 'n': 3})

    logs = any_adapter.get_cron_logs('j1')
    assert [log['n'] for log in logs] == [1, 2, 3]

    limited = any_adapter.get_cron_logs('j1', limit=2)
    assert [log['n'] for log in limited] == [2, 3]

    assert any_adapter.get_cron_logs('unknown-job') == []
    assert any_adapter.delete_cron_job('j1') is True
    assert any_adapter.list_cron_jobs() == []


def test_config_kv_crud_parity(any_adapter):
    any_adapter.set_config('str_key', 'value')
    any_adapter.set_config('int_key', 42)
    any_adapter.set_config('bool_key', False)
    any_adapter.set_config('list_key', [1, 2, 3])
    any_adapter.set_config('dict_key', {'nested': True})

    assert any_adapter.get_config('str_key') == 'value'
    assert any_adapter.get_config('int_key') == 42
    assert any_adapter.get_config('bool_key') is False
    assert any_adapter.get_config('list_key') == [1, 2, 3]
    assert any_adapter.get_config('dict_key') == {'nested': True}
    assert any_adapter.get_config('missing') is None

    all_config = any_adapter.get_all_config()
    assert all_config['int_key'] == 42
    assert all_config['dict_key'] == {'nested': True}

    assert any_adapter.delete_config('int_key') is True
    assert any_adapter.get_config('int_key') is None
    assert any_adapter.delete_config('int_key') is False


def test_json_round_trip_of_nested_values(any_adapter):
    payload = {
        'id': 'complex-1',
        'channel_id': 'slack',
        'nested': {'a': [1, 2, {'b': 'c'}], 'flag': True, 'none': None, 'float': 1.5},
    }
    any_adapter.save_session(payload)
    retrieved = any_adapter.get_session('complex-1')
    assert retrieved['nested'] == payload['nested']


# --- Corrupt / invalid input behavior ---

def test_save_session_without_id_raises():
    result = create_storage_adapter({'type': 'memory'})
    with pytest.raises(KeyError):
        result.save_session({'channel_id': 'slack'})


def test_sqlite_save_session_without_id_raises(tmp_path):
    result = create_storage_adapter({'type': 'sqlite', 'path': str(tmp_path / 'x.sqlite3')})
    try:
        with pytest.raises(KeyError):
            result.save_session({'channel_id': 'slack'})
    finally:
        result.close()


def test_sqlite_adapter_raises_on_corrupt_database_file(tmp_path):
    db_path = tmp_path / "corrupt.sqlite3"
    db_path.write_bytes(b"not a real sqlite database at all, just garbage bytes")

    result = SqliteStorageAdapter(str(db_path))
    with pytest.raises(sqlite3.DatabaseError):
        result.initialize()


def test_sqlite_migration_rolls_back_all_statements_on_failure(tmp_path, monkeypatch):
    db_path = tmp_path / "migration_rollback.sqlite3"
    monkeypatch.setattr(
        adapter_module,
        '_MIGRATIONS',
        [
            (
                99,
                (
                    "CREATE TABLE partial_migration (id INTEGER PRIMARY KEY)",
                    "THIS IS NOT VALID SQL",
                ),
            )
        ],
    )

    result = SqliteStorageAdapter(str(db_path))
    with pytest.raises(sqlite3.OperationalError):
        result.initialize()
    result.close()

    conn = sqlite3.connect(str(db_path))
    try:
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            ('partial_migration',),
        ).fetchone()
        assert table is None
    finally:
        conn.close()


def test_sqlite_adapter_raises_when_used_before_initialize(tmp_path):
    result = SqliteStorageAdapter(str(tmp_path / "uninitialized.sqlite3"))
    with pytest.raises(RuntimeError):
        result.get_session('anything')


def test_sqlite_adapter_raises_when_used_after_close(tmp_path):
    result = create_storage_adapter({'type': 'sqlite', 'path': str(tmp_path / 'closed.sqlite3')})
    result.close()
    with pytest.raises(RuntimeError):
        result.get_config('key')


def test_sqlite_non_serializable_value_is_not_silently_dropped(tmp_path):
    result = create_storage_adapter({'type': 'sqlite', 'path': str(tmp_path / 'y.sqlite3')})
    try:
        with pytest.raises(TypeError):
            result.set_config('bad', object())
    finally:
        result.close()


def test_sqlite_data_stored_as_valid_json_on_disk(tmp_path):
    db_path = tmp_path / "raw.sqlite3"
    result = create_storage_adapter({'type': 'sqlite', 'path': str(db_path)})
    result.save_session({'id': 's1', 'channel_id': 'c'})
    result.close()

    conn = sqlite3.connect(str(db_path))
    try:
        row = conn.execute("SELECT data FROM sessions WHERE id = ?", ('s1',)).fetchone()
        assert row is not None
        parsed = json.loads(row[0])  # must be valid JSON, not swallowed/mangled
        assert parsed['id'] == 's1'
    finally:
        conn.close()


def test_sqlite_in_memory_config_flag_does_not_touch_disk(tmp_path):
    db_path = tmp_path / "should_not_exist.sqlite3"
    result = create_storage_adapter({'type': 'sqlite', 'path': str(db_path), 'in_memory': True})
    try:
        result.save_session({'id': 's1', 'channel_id': 'c'})
        assert result.get_session('s1') is not None
        assert not db_path.exists()
    finally:
        result.close()
