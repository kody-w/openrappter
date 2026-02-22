"""
Showcase: Persistence Vault — In-Memory StorageAdapter tests.

Mirrors TypeScript showcase-persistence-vault.test.ts (8 tests).
"""

import pytest
from openrappter.storage.adapter import create_storage_adapter, StorageAdapter


@pytest.fixture
def adapter():
    """Fresh in-memory storage adapter for each test."""
    return create_storage_adapter({'type': 'memory'})


# 1. Session lifecycle: save, get, delete
def test_session_lifecycle(adapter):
    session = {'id': 'sess-001', 'channel_id': 'slack', 'data': 'hello'}
    adapter.save_session(session)

    retrieved = adapter.get_session('sess-001')
    assert retrieved is not None
    assert retrieved['id'] == 'sess-001'
    assert retrieved['channel_id'] == 'slack'
    assert retrieved['data'] == 'hello'
    assert 'created_at' in retrieved
    assert 'updated_at' in retrieved

    deleted = adapter.delete_session('sess-001')
    assert deleted is True

    assert adapter.get_session('sess-001') is None


# 2. Session filtering by channel_id
def test_session_filter_by_channel_id(adapter):
    adapter.save_session({'id': 'sess-slack-1', 'channel_id': 'slack', 'user': 'alice'})
    adapter.save_session({'id': 'sess-slack-2', 'channel_id': 'slack', 'user': 'bob'})
    adapter.save_session({'id': 'sess-discord-1', 'channel_id': 'discord', 'user': 'carol'})

    slack_sessions = adapter.list_sessions({'channel_id': 'slack'})
    assert len(slack_sessions) == 2
    ids = {s['id'] for s in slack_sessions}
    assert 'sess-slack-1' in ids
    assert 'sess-slack-2' in ids
    assert 'sess-discord-1' not in ids

    discord_sessions = adapter.list_sessions({'channel_id': 'discord'})
    assert len(discord_sessions) == 1
    assert discord_sessions[0]['id'] == 'sess-discord-1'


# 3. Memory chunks: save and retrieve by id
def test_memory_chunk_save_and_get(adapter):
    chunk = {
        'id': 'chunk-abc',
        'content': 'The quick brown fox jumps over the lazy dog.',
        'embedding': [0.1, 0.2, 0.3],
        'source': 'doc-001',
    }
    adapter.save_memory_chunk(chunk)

    retrieved = adapter.get_memory_chunk('chunk-abc')
    assert retrieved is not None
    assert retrieved['id'] == 'chunk-abc'
    assert retrieved['content'] == chunk['content']
    assert retrieved['embedding'] == [0.1, 0.2, 0.3]
    assert retrieved['source'] == 'doc-001'
    assert 'created_at' in retrieved

    # Non-existent chunk returns None
    assert adapter.get_memory_chunk('chunk-nonexistent') is None


# 4. Cron jobs and logs: save job, get job, save log, get logs
def test_cron_jobs_and_logs(adapter):
    job = {
        'id': 'job-health-check',
        'name': 'Health Check',
        'schedule': '*/5 * * * *',
        'enabled': True,
    }
    adapter.save_cron_job(job)

    retrieved_job = adapter.get_cron_job('job-health-check')
    assert retrieved_job is not None
    assert retrieved_job['id'] == 'job-health-check'
    assert retrieved_job['name'] == 'Health Check'
    assert retrieved_job['enabled'] is True
    assert 'created_at' in retrieved_job
    assert 'updated_at' in retrieved_job

    # Save cron logs for the job
    adapter.save_cron_log({'job_id': 'job-health-check', 'status': 'ok', 'message': 'healthy'})
    adapter.save_cron_log({'job_id': 'job-health-check', 'status': 'ok', 'message': 'healthy again'})

    logs = adapter.get_cron_logs('job-health-check')
    assert len(logs) == 2
    assert logs[0]['status'] == 'ok'
    assert logs[0]['message'] == 'healthy'
    assert logs[1]['message'] == 'healthy again'
    assert all('created_at' in log for log in logs)

    # Logs for unknown job_id return empty list
    assert adapter.get_cron_logs('job-nonexistent') == []


# 5. Config KV: set, get, get_all
def test_config_kv(adapter):
    adapter.set_config('theme', 'dark')
    adapter.set_config('max_retries', 3)
    adapter.set_config('debug', True)

    assert adapter.get_config('theme') == 'dark'
    assert adapter.get_config('max_retries') == 3
    assert adapter.get_config('debug') is True

    all_config = adapter.get_all_config()
    assert all_config == {'theme': 'dark', 'max_retries': 3, 'debug': True}

    # Missing key returns None
    assert adapter.get_config('nonexistent') is None


# 6. Sequential multi-operation: set → get → delete → get returns None
def test_config_sequential_operations(adapter):
    adapter.set_config('api_key', 'secret-abc-123')
    assert adapter.get_config('api_key') == 'secret-abc-123'

    deleted = adapter.delete_config('api_key')
    assert deleted is True

    assert adapter.get_config('api_key') is None

    # Deleting again returns False
    assert adapter.delete_config('api_key') is False


# 7. In-memory initialization: create_storage_adapter works without file path
def test_in_memory_initialization():
    # No file path required — factory works with no args or with type='memory'
    adapter_no_args = create_storage_adapter()
    assert adapter_no_args is not None
    assert isinstance(adapter_no_args, StorageAdapter)

    adapter_with_type = create_storage_adapter({'type': 'memory'})
    assert adapter_with_type is not None
    assert isinstance(adapter_with_type, StorageAdapter)

    # Verify the adapters are functional
    adapter_no_args.set_config('key', 'value')
    assert adapter_no_args.get_config('key') == 'value'

    adapter_with_type.save_session({'id': 'test-sess', 'channel_id': 'test'})
    assert adapter_with_type.get_session('test-sess') is not None


# 8. Close/reinitialize: close() clears data; new adapter is isolated
def test_close_and_reinitialize():
    adapter1 = create_storage_adapter({'type': 'memory'})
    adapter1.save_session({'id': 'sess-x', 'channel_id': 'ch'})
    adapter1.set_config('foo', 'bar')
    adapter1.save_memory_chunk({'id': 'chunk-x', 'content': 'data'})

    # Verify data exists before close
    assert adapter1.get_session('sess-x') is not None
    assert adapter1.get_config('foo') == 'bar'
    assert adapter1.get_memory_chunk('chunk-x') is not None

    adapter1.close()

    # After close, data is gone
    assert adapter1.get_session('sess-x') is None
    assert adapter1.get_config('foo') is None
    assert adapter1.get_memory_chunk('chunk-x') is None

    # New adapter is completely isolated — no shared state
    adapter2 = create_storage_adapter({'type': 'memory'})
    assert adapter2.get_session('sess-x') is None
    assert adapter2.get_config('foo') is None

    adapter2.set_config('new_key', 'new_value')
    assert adapter2.get_config('new_key') == 'new_value'
