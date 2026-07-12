"""Strictly bounded daemon workers for synchronous extension code.

Python cannot safely stop a running thread.  This executor therefore keeps
the number of accepted calls bounded and uses daemon threads so a broken
third-party agent, provider, or channel cannot block interpreter shutdown.
The same executor can be reused across transport restarts: hung calls retain
their permits, preventing reconnect cycles from creating unbounded work.
"""

from __future__ import annotations

import asyncio
import queue
import threading
from concurrent.futures import Future
from dataclasses import dataclass
from typing import Any, Callable, Dict, Tuple


class WorkerCapacityError(RuntimeError):
    """Raised when every bounded worker permit is already in use."""


@dataclass
class _WorkItem:
    future: Future[Any]
    function: Callable[..., Any]
    args: Tuple[Any, ...]
    kwargs: Dict[str, Any]


class BoundedDaemonExecutor:
    """A reusable executor with no unbounded queue and daemon-only workers."""

    def __init__(
        self,
        max_workers: int,
        thread_name_prefix: str,
        idle_timeout: float = 0.25,
    ) -> None:
        if max_workers < 1:
            raise ValueError("max_workers must be at least 1")
        self.max_workers = max_workers
        self.thread_name_prefix = thread_name_prefix
        self.idle_timeout = idle_timeout
        self._permits = threading.BoundedSemaphore(max_workers)
        self._queue: "queue.Queue[_WorkItem]" = queue.Queue()
        self._lock = threading.Lock()
        self._threads: set[threading.Thread] = set()
        self._in_flight = 0
        self._thread_sequence = 0

    def submit(
        self,
        function: Callable[..., Any],
        /,
        *args: Any,
        **kwargs: Any,
    ) -> Future[Any]:
        """Accept work only when one of the fixed permits is available."""
        if not self._permits.acquire(blocking=False):
            raise WorkerCapacityError("bounded worker capacity is exhausted")

        future: Future[Any] = Future()
        item = _WorkItem(future, function, args, kwargs)
        try:
            with self._lock:
                self._in_flight += 1
                if len(self._threads) < self.max_workers:
                    self._thread_sequence += 1
                    worker = threading.Thread(
                        target=self._worker,
                        name=f"{self.thread_name_prefix}-{self._thread_sequence}",
                        daemon=True,
                    )
                    self._threads.add(worker)
                    try:
                        worker.start()
                    except BaseException:
                        self._threads.discard(worker)
                        raise
                self._queue.put_nowait(item)
        except BaseException:
            with self._lock:
                self._in_flight = max(0, self._in_flight - 1)
            self._permits.release()
            future.cancel()
            raise
        return future

    def cancel_pending(self) -> int:
        """Cancel accepted calls that have not started; running calls remain."""
        cancelled = 0
        while True:
            try:
                item = self._queue.get_nowait()
            except queue.Empty:
                break
            try:
                if item.future.cancel():
                    cancelled += 1
            finally:
                self._release_permit()
                self._queue.task_done()
        return cancelled

    @property
    def in_flight(self) -> int:
        with self._lock:
            return self._in_flight

    @property
    def threads(self) -> Tuple[threading.Thread, ...]:
        with self._lock:
            return tuple(self._threads)

    def _release_permit(self) -> None:
        with self._lock:
            self._in_flight = max(0, self._in_flight - 1)
        self._permits.release()

    def _worker(self) -> None:
        current = threading.current_thread()
        try:
            while True:
                try:
                    item = self._queue.get(timeout=self.idle_timeout)
                except queue.Empty:
                    with self._lock:
                        if self._queue.empty():
                            self._threads.discard(current)
                            return
                    continue

                try:
                    if item.future.set_running_or_notify_cancel():
                        try:
                            result = item.function(*item.args, **item.kwargs)
                        except BaseException as exc:  # propagate extension failures
                            if isinstance(exc, Exception):
                                item.future.set_exception(exc)
                            else:
                                item.future.set_exception(
                                    RuntimeError(
                                        f"worker aborted with {exc.__class__.__name__}"
                                    )
                                )
                        else:
                            item.future.set_result(result)
                finally:
                    self._release_permit()
                    self._queue.task_done()
        finally:
            with self._lock:
                self._threads.discard(current)


async def wait_for_worker(
    future: Future[Any],
    poll_interval: float = 0.005,
) -> Any:
    """Await a concurrent future without retaining a closed event loop.

    Polling is intentional: a truly hung future must not keep an asyncio
    callback (and its loop/server graph) alive forever after a timeout.
    """
    while not future.done():
        await asyncio.sleep(poll_interval)
    return future.result()
