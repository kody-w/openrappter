"""
Threaded persistence contract for :mod:`openrappter.storage`.

A ``StorageAdapter`` is guarded by an ``RLock``, which is a promise: the
adapter may be driven from more than one thread. These tests hold every
implementation to that promise.

Determinism note: nothing here sleeps or races on wall-clock timing.
Contention is *constructed* with ``threading.Barrier`` — every worker is
released at the same instant and, before any worker is allowed to call into
the adapter, all of them have already registered as "in flight". A
concurrency probe records the peak number of simultaneous in-flight adapter
calls, and the tests assert that peak equals the full worker count. A
concurrency test that never actually overlaps would fail that assertion.
"""

import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from openrappter.storage.adapter import (
    InMemoryStorageAdapter,
    SqliteStorageAdapter,
)

# Barrier waits are bounded so a genuine deadlock or a crashed worker surfaces
# as a test failure instead of hanging the suite forever.
BARRIER_TIMEOUT = 30.0

WRITERS = 8
READERS = 2
ROUNDS = 25


@pytest.fixture(params=['sqlite-file', 'sqlite-memory', 'in-memory'])
def adapter(request, tmp_path):
    """Every storage implementation must satisfy the same threaded contract."""
    if request.param == 'sqlite-file':
        instance = SqliteStorageAdapter(str(tmp_path / 'threaded.db'))
    elif request.param == 'sqlite-memory':
        instance = SqliteStorageAdapter(':memory:')
    else:
        instance = InMemoryStorageAdapter()
    instance.initialize()
    try:
        yield instance
    finally:
        instance.close()


class ConcurrencyProbe:
    """
    Proves that workers genuinely overlap inside adapter calls.

    ``round_gate`` releases all workers at once. ``entry_gate`` is crossed
    *after* a worker has marked itself in flight but *before* it calls the
    adapter, so once any worker is executing, all of them are provably inside
    the probed region. Both gates live outside the adapter's own lock, so they
    cannot deadlock against it.
    """

    def __init__(self, parties: int):
        self.parties = parties
        self.round_gate = threading.Barrier(parties)
        self.entry_gate = threading.Barrier(parties)
        self._mutex = threading.Lock()
        self._in_flight = 0
        self.peak_in_flight = 0
        self.errors: list[BaseException] = []

    def __enter__(self):
        with self._mutex:
            self._in_flight += 1
            self.peak_in_flight = max(self.peak_in_flight, self._in_flight)
        self.entry_gate.wait(timeout=BARRIER_TIMEOUT)
        return self

    def __exit__(self, exc_type, exc, tb):
        with self._mutex:
            self._in_flight -= 1
        return False

    def abort(self, error: BaseException) -> None:
        with self._mutex:
            self.errors.append(error)
        self.round_gate.abort()
        self.entry_gate.abort()


def _run_contended(adapter, writers=WRITERS, readers=READERS, rounds=ROUNDS):
    """
    Drive ``adapter`` from ``writers`` writer threads and ``readers`` reader
    threads, all contending in lockstep rounds. Returns the probe plus the
    reader observations.
    """
    probe = ConcurrencyProbe(writers + readers)
    submitted: set[str] = set()
    submitted_mutex = threading.Lock()
    observed_counts: list[list[int]] = [[] for _ in range(readers)]
    observed_ids: set[str] = set()
    observed_mutex = threading.Lock()

    def writer(worker: int):
        for round_index in range(rounds):
            probe.round_gate.wait(timeout=BARRIER_TIMEOUT)
            session_id = f"w{worker}-r{round_index}"
            with submitted_mutex:
                submitted.add(session_id)
            with probe:
                adapter.save_session({
                    'id': session_id,
                    'channel_id': f"chan-{worker % 3}",
                    'worker': worker,
                    'round': round_index,
                    'payload': 'x' * 64,
                })

    def reader(index: int):
        for _ in range(rounds):
            probe.round_gate.wait(timeout=BARRIER_TIMEOUT)
            with probe:
                rows = adapter.list_sessions()
            observed_counts[index].append(len(rows))
            ids = set()
            for row in rows:
                # A torn or half-written record would show up here.
                assert isinstance(row['id'], str)
                assert row['payload'] == 'x' * 64
                assert row['worker'] == int(row['id'].split('-')[0][1:])
                ids.add(row['id'])
            with observed_mutex:
                observed_ids.update(ids)

    def guarded(fn, arg):
        try:
            fn(arg)
        except BaseException as error:  # noqa: BLE001 - re-raised by the caller
            probe.abort(error)
            raise

    with ThreadPoolExecutor(max_workers=writers + readers) as pool:
        futures = [pool.submit(guarded, writer, i) for i in range(writers)]
        futures += [pool.submit(guarded, reader, i) for i in range(readers)]
        failures = [f.exception() for f in futures]

    real_failures = [f for f in failures if f is not None]
    if real_failures:
        # Surface the original storage error, not the barrier abort fallout.
        primary = next(
            (f for f in real_failures if not isinstance(f, threading.BrokenBarrierError)),
            real_failures[0],
        )
        raise AssertionError(
            f"{len(real_failures)}/{len(futures)} threads failed; first real error: "
            f"{type(primary).__name__}: {primary}"
        ) from primary

    return probe, submitted, observed_counts, observed_ids


def test_concurrent_writes_and_reads_do_not_raise_or_lose_data(adapter):
    """The core contract: no exceptions, no lost writes, consistent final state."""
    probe, submitted, observed_counts, observed_ids = _run_contended(adapter)

    # Contention actually happened — every worker was inside an adapter call
    # simultaneously, by construction of the entry gate.
    assert probe.peak_in_flight == WRITERS + READERS

    # No lost writes: every submitted id landed, exactly once, and nothing else did.
    stored = adapter.list_sessions()
    stored_ids = [session['id'] for session in stored]
    assert len(stored_ids) == len(set(stored_ids)), "duplicate rows written"
    assert set(stored_ids) == submitted
    assert len(stored_ids) == WRITERS * ROUNDS

    # Consistent final state: every record round-trips intact.
    for session in stored:
        worker, round_index = session['id'][1:].split('-r')
        assert session['worker'] == int(worker)
        assert session['round'] == int(round_index)
        assert session['payload'] == 'x' * 64
        assert session['channel_id'] == f"chan-{int(worker) % 3}"
        assert session['created_at'] <= session['updated_at']

    # Readers only ever saw records that had genuinely been submitted, and the
    # visible row count never went backwards (a lost or rolled-back write would
    # show up as a decrease).
    assert observed_ids <= submitted
    for counts in observed_counts:
        assert counts == sorted(counts), f"row count regressed mid-run: {counts}"
        assert counts[-1] <= WRITERS * ROUNDS


def test_concurrent_config_writes_are_all_durable(adapter):
    """Config KV is a distinct code path; hold it to the same contract."""
    probe = ConcurrencyProbe(WRITERS)

    def writer(worker: int):
        try:
            for round_index in range(ROUNDS):
                probe.round_gate.wait(timeout=BARRIER_TIMEOUT)
                with probe:
                    adapter.set_config(f"k{worker}-{round_index}", {'w': worker, 'r': round_index})
        except BaseException as error:  # noqa: BLE001
            probe.abort(error)
            raise

    with ThreadPoolExecutor(max_workers=WRITERS) as pool:
        futures = [pool.submit(writer, i) for i in range(WRITERS)]
        errors = [f.exception() for f in futures if f.exception() is not None]
    assert not errors, f"config writers failed: {errors[0]!r}"

    assert probe.peak_in_flight == WRITERS
    config = adapter.get_all_config()
    assert len(config) == WRITERS * ROUNDS
    for worker in range(WRITERS):
        for round_index in range(ROUNDS):
            assert config[f"k{worker}-{round_index}"] == {'w': worker, 'r': round_index}


def test_adapter_is_usable_from_a_thread_that_did_not_create_it(adapter):
    """
    The narrowest form of the bug: hand the adapter to one other thread and
    use it there. No concurrency required — this fails outright when the
    connection is pinned to its creating thread.
    """
    adapter.save_session({'id': 'from-main', 'channel_id': 'cli'})

    with ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(adapter.save_session, {'id': 'from-worker', 'channel_id': 'cli'}).result()
        seen = pool.submit(adapter.list_sessions).result()
        deleted = pool.submit(adapter.delete_session, 'from-main').result()

    assert deleted is True
    assert {s['id'] for s in seen} == {'from-main', 'from-worker'}
    assert {s['id'] for s in adapter.list_sessions()} == {'from-worker'}


def test_cron_job_and_log_writes_are_thread_safe(adapter):
    """Cron logs carry a foreign key to their job; concurrency must not break it."""
    for worker in range(WRITERS):
        adapter.save_cron_job({'id': f"job-{worker}", 'schedule': '* * * * *'})

    probe = ConcurrencyProbe(WRITERS)

    def writer(worker: int):
        try:
            for round_index in range(ROUNDS):
                probe.round_gate.wait(timeout=BARRIER_TIMEOUT)
                with probe:
                    adapter.save_cron_log({
                        'job_id': f"job-{worker}",
                        'status': 'ok',
                        'round': round_index,
                    })
        except BaseException as error:  # noqa: BLE001
            probe.abort(error)
            raise

    with ThreadPoolExecutor(max_workers=WRITERS) as pool:
        futures = [pool.submit(writer, i) for i in range(WRITERS)]
        errors = [f.exception() for f in futures if f.exception() is not None]
    assert not errors, f"cron log writers failed: {errors[0]!r}"

    assert probe.peak_in_flight == WRITERS
    for worker in range(WRITERS):
        logs = adapter.get_cron_logs(f"job-{worker}")
        assert len(logs) == ROUNDS
        assert sorted(log['round'] for log in logs) == list(range(ROUNDS))
        # Per-job ordering is preserved despite interleaving from other jobs.
        assert [log['round'] for log in logs] == list(range(ROUNDS))


def test_sqlite_adapter_refuses_to_initialize_without_a_threadsafe_sqlite(tmp_path, monkeypatch):
    """
    ``check_same_thread=False`` is only sound because the underlying library is
    at least multi-thread capable. If it is not, fail loudly rather than hand
    back an adapter that would corrupt data silently.
    """
    monkeypatch.setattr(sqlite3, 'threadsafety', 0)
    instance = SqliteStorageAdapter(str(tmp_path / 'unsafe.db'))
    with pytest.raises(RuntimeError, match='thread safety'):
        instance.initialize()


def test_sqlite_connection_is_never_touched_outside_the_lock(tmp_path):
    """
    Structural guard for the invariant the fix rests on: with
    ``check_same_thread=False``, the lock is the *only* thing serializing
    access, so any use of the connection while the lock is unheld is a latent
    data race. This wraps the live connection and asserts the lock is held for
    every single call, across every public method.
    """
    instance = SqliteStorageAdapter(str(tmp_path / 'guarded.db'))
    instance.initialize()
    violations: list[str] = []
    lock = instance._lock
    real_conn = instance._conn

    class LockAssertingConnection:
        def __getattr__(self, name):
            attr = getattr(real_conn, name)
            if not callable(attr):
                return attr

            def checked(*args, **kwargs):
                # RLock._is_owned() is true only for the holding thread.
                if not lock._is_owned():
                    violations.append(name)
                result = attr(*args, **kwargs)
                if isinstance(result, sqlite3.Cursor):
                    return LockAssertingCursor(result)
                return result

            return checked

        def __enter__(self):
            if not lock._is_owned():
                violations.append('__enter__')
            return real_conn.__enter__()

        def __exit__(self, *args):
            if not lock._is_owned():
                violations.append('__exit__')
            return real_conn.__exit__(*args)

    class LockAssertingCursor:
        def __init__(self, cursor):
            self._cursor = cursor

        def __getattr__(self, name):
            attr = getattr(self._cursor, name)
            if not callable(attr):
                if not lock._is_owned():
                    violations.append(f"cursor.{name}")
                return attr

            def checked(*args, **kwargs):
                if not lock._is_owned():
                    violations.append(f"cursor.{name}")
                return attr(*args, **kwargs)

            return checked

        def __iter__(self):
            if not lock._is_owned():
                violations.append('cursor.__iter__')
            return iter(self._cursor)

    instance._conn = LockAssertingConnection()
    try:
        instance.save_session({'id': 's1', 'channel_id': 'cli'})
        instance.get_session('s1')
        instance.list_sessions({'channel_id': 'cli'})
        instance.delete_session('s1')
        instance.save_memory_chunk({'id': 'c1', 'text': 'hello'})
        instance.get_memory_chunk('c1')
        instance.list_memory_chunks()
        instance.delete_memory_chunk('c1')
        instance.save_cron_job({'id': 'j1'})
        instance.get_cron_job('j1')
        instance.list_cron_jobs()
        instance.save_cron_log({'job_id': 'j1', 'status': 'ok'})
        instance.get_cron_logs('j1')
        instance.delete_cron_job('j1')
        instance.set_config('k', {'v': 1})
        instance.get_config('k')
        instance.get_all_config()
        instance.delete_config('k')
    finally:
        instance._conn = real_conn
        instance.close()

    assert violations == [], f"connection used without holding the lock: {violations}"


def test_sqlite_connection_allows_cross_thread_use(tmp_path):
    """Pin the concrete fix: the connection is opened with check_same_thread=False."""
    instance = SqliteStorageAdapter(str(tmp_path / 'flag.db'))
    instance.initialize()
    try:
        result: list = []

        def probe():
            # Bypass the adapter entirely: this is the raw sqlite3 behaviour
            # that produced the original ProgrammingError.
            row = instance._conn.execute('SELECT 1').fetchone()
            result.append(row[0])

        thread = threading.Thread(target=probe)
        thread.start()
        thread.join(timeout=BARRIER_TIMEOUT)
        assert result == [1]
    finally:
        instance.close()


def test_stored_json_survives_concurrent_writes_unmangled(tmp_path):
    """
    Interleaved statements on a shared connection would show up as mangled or
    truncated JSON blobs long before they showed up as a missing row.
    """
    instance = SqliteStorageAdapter(str(tmp_path / 'json.db'))
    instance.initialize()
    probe = ConcurrencyProbe(WRITERS)

    def writer(worker: int):
        try:
            for round_index in range(ROUNDS):
                probe.round_gate.wait(timeout=BARRIER_TIMEOUT)
                with probe:
                    instance.save_session({
                        'id': f"w{worker}-r{round_index}",
                        'nested': {'worker': worker, 'items': list(range(round_index + 1))},
                    })
        except BaseException as error:  # noqa: BLE001
            probe.abort(error)
            raise

    try:
        with ThreadPoolExecutor(max_workers=WRITERS) as pool:
            futures = [pool.submit(writer, i) for i in range(WRITERS)]
            errors = [f.exception() for f in futures if f.exception() is not None]
        assert not errors, f"writers failed: {errors[0]!r}"

        rows = instance._conn.execute('SELECT data FROM sessions').fetchall()
        assert len(rows) == WRITERS * ROUNDS
        for (blob,) in rows:
            record = json.loads(blob)  # raises if the blob was mangled
            worker, round_index = record['id'][1:].split('-r')
            assert record['nested'] == {
                'worker': int(worker),
                'items': list(range(int(round_index) + 1)),
            }
    finally:
        instance.close()
