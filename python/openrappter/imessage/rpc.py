"""Supervised newline-delimited JSON-RPC client for ``imsg rpc`` v0.12.3."""

from __future__ import annotations

import json
import subprocess
import threading
import time
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol


class ImsgRpcError(RuntimeError):
    """Base error for the imsg stdio transport."""


class ImsgRpcTimeout(ImsgRpcError):
    """A request timed out; callers must decide whether the action was ambiguous."""


class ImsgRpcNotSent(ImsgRpcError):
    """A request definitely did not reach the child."""


class ImsgRpcAmbiguous(ImsgRpcError):
    """A mutating request was flushed but its outcome is unknown."""


class ImsgRpcClosed(ImsgRpcError):
    """The child exited or its stdio became unusable."""


class ImsgRpcProtocolError(ImsgRpcError):
    """The child emitted malformed JSON-RPC on stdout."""


class ImsgRpcRemoteError(ImsgRpcError):
    """A structured JSON-RPC error returned by imsg."""

    def __init__(self, message: str, *, code: int | None, data: object, method: str):
        super().__init__(message)
        self.code = code
        self.data = data
        self.method = method


NotificationHandler = Callable[[str, object], None]
DiagnosticHandler = Callable[[str], None]


class RpcClientLike(Protocol):
    def start(self) -> None: ...

    def stop(self) -> None: ...

    def request(
        self, method: str, params: Mapping[str, object] | None = None, timeout: float | None = None
    ) -> object: ...

    def wait_closed(self, timeout: float | None = None) -> BaseException | None: ...


@dataclass
class _Pending:
    method: str
    future: Future[object]
    written: bool = False


class ImsgRpcClient:
    """One long-lived ``imsg rpc --json`` child.

    Requests are line framed, correlated by monotonically increasing IDs, and
    failed immediately when the child exits. A malformed stdout line is a
    terminal protocol error so a supervisor can replace the child.
    """

    def __init__(
        self,
        imsg_path: str = "imsg",
        *,
        on_notification: NotificationHandler | None = None,
        on_diagnostic: DiagnosticHandler | None = None,
        default_timeout: float = 30.0,
        popen_factory: Callable[..., subprocess.Popen[str]] = subprocess.Popen,
    ) -> None:
        self.imsg_path = imsg_path
        self.on_notification = on_notification
        self.on_diagnostic = on_diagnostic
        self.default_timeout = default_timeout
        self._popen_factory = popen_factory
        self._process: subprocess.Popen[str] | None = None
        self._pending: dict[str, _Pending] = {}
        self._next_id = 1
        self._lock = threading.RLock()
        self._write_lock = threading.Lock()
        self._closed = threading.Event()
        self._stopping = False
        self._close_error: BaseException | None = None
        self._reader: threading.Thread | None = None
        self._stderr_reader: threading.Thread | None = None

    @property
    def is_running(self) -> bool:
        with self._lock:
            return (
                self._process is not None
                and self._process.poll() is None
                and not self._closed.is_set()
            )

    @property
    def close_error(self) -> BaseException | None:
        return self._close_error

    def start(self) -> None:
        with self._lock:
            if self.is_running:
                return
            if self._process is not None or self._closed.is_set():
                raise ImsgRpcClosed("an imsg RPC client instance cannot be restarted")
            try:
                process = self._popen_factory(
                    [self.imsg_path, "rpc", "--json"],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="strict",
                    bufsize=1,
                )
            except (OSError, ValueError) as error:
                raise ImsgRpcClosed("unable to start imsg rpc") from error
            if process.stdin is None or process.stdout is None or process.stderr is None:
                try:
                    process.terminate()
                except OSError:
                    pass
                raise ImsgRpcClosed("imsg rpc stdio pipes are unavailable")
            self._process = process
            self._reader = threading.Thread(
                target=self._read_stdout,
                name="openrappter-imsg-stdout",
                daemon=True,
            )
            self._stderr_reader = threading.Thread(
                target=self._read_stderr,
                name="openrappter-imsg-stderr",
                daemon=True,
            )
            self._reader.start()
            self._stderr_reader.start()

    def request(
        self,
        method: str,
        params: Mapping[str, object] | None = None,
        timeout: float | None = None,
    ) -> object:
        if not method:
            raise ValueError("JSON-RPC method is required")
        with self._lock:
            process = self._process
            if (
                process is None
                or process.stdin is None
                or process.poll() is not None
                or self._closed.is_set()
            ):
                raise ImsgRpcNotSent("imsg rpc is not running")
            request_id = self._next_id
            self._next_id += 1
            key = str(request_id)
            future: Future[object] = Future()
            self._pending[key] = _Pending(method=method, future=future)

        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": dict(params or {}),
        }
        line = json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n"
        try:
            with self._write_lock:
                process.stdin.write(line)
                process.stdin.flush()
                pending = self._pending.get(key)
                if pending is not None:
                    pending.written = True
        except (BrokenPipeError, OSError, ValueError) as error:
            self._remove_pending(key)
            closed = ImsgRpcAmbiguous("imsg rpc stdin failed")
            future.set_exception(closed)
            self._finish(closed)
            self._terminate_process()
            raise closed from error

        wait_timeout = self.default_timeout if timeout is None else timeout
        try:
            return future.result(timeout=wait_timeout)
        except FutureTimeoutError as error:
            pending = self._remove_pending(key)
            if pending is not None and not pending.future.done():
                pending.future.cancel()
            if method == "send":
                self._terminate_process()
                raise ImsgRpcAmbiguous(f"imsg rpc outcome unknown ({method})") from error
            self._terminate_process()
            raise ImsgRpcTimeout(f"imsg rpc timeout ({method})") from error

    def wait_closed(self, timeout: float | None = None) -> BaseException | None:
        if not self._closed.wait(timeout):
            return None
        return self._close_error

    def stop(self) -> None:
        with self._lock:
            if self._stopping:
                return
            self._stopping = True
            process = self._process
        if process is None:
            self._finish(ImsgRpcClosed("imsg rpc stopped"))
            return
        try:
            if process.stdin is not None:
                process.stdin.close()
        except OSError:
            pass
        try:
            process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            try:
                process.terminate()
                process.wait(timeout=0.5)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    process.kill()
                except OSError:
                    pass
        self._finish(ImsgRpcClosed("imsg rpc stopped"))

    def _read_stdout(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            while True:
                line = process.stdout.readline()
                if line == "":
                    break
                if line.strip():
                    self._handle_line(line)
                if self._closed.is_set():
                    return
        except (OSError, UnicodeError, ValueError) as error:
            protocol_error = ImsgRpcProtocolError("imsg rpc stdout framing failed")
            self._finish(protocol_error)
            self._terminate_process()
            if self.on_diagnostic:
                self.on_diagnostic(type(error).__name__)
            return

        try:
            code = process.wait()
        except (OSError, ValueError):
            code = None
        if self._stopping:
            self._finish(ImsgRpcClosed("imsg rpc stopped"))
        elif code in (0, None):
            self._finish(ImsgRpcClosed("imsg rpc closed"))
        else:
            self._finish(ImsgRpcClosed(f"imsg rpc exited (code {code})"))

    def _read_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        try:
            for line in process.stderr:
                if line.strip() and self.on_diagnostic:
                    # Never surface raw stderr: it can contain transport data.
                    self.on_diagnostic("imsg rpc diagnostic")
        except (OSError, UnicodeError, ValueError):
            if self.on_diagnostic:
                self.on_diagnostic("imsg rpc stderr unavailable")

    def _handle_line(self, line: str) -> None:
        try:
            message = json.loads(line)
        except json.JSONDecodeError as error:
            self._protocol_failure("imsg rpc emitted malformed JSON", error)
            return
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            self._protocol_failure("imsg rpc emitted an invalid JSON-RPC envelope")
            return

        if "id" in message and message["id"] is not None:
            key = str(message["id"])
            pending = self._remove_pending(key)
            if pending is None:
                return
            error_value = message.get("error")
            if error_value is not None:
                if isinstance(error_value, Mapping):
                    text = str(error_value.get("message") or "imsg rpc error")
                    code = error_value.get("code")
                    if isinstance(code, int):
                        text = f"{text} (code {code})"
                    else:
                        code = None
                    data = error_value.get("data")
                else:
                    text = "imsg rpc error"
                    code = None
                    data = None
                pending.future.set_exception(
                    ImsgRpcRemoteError(
                        text,
                        code=code,
                        data=data,
                        method=pending.method,
                    )
                )
            elif "result" not in message:
                pending.future.set_exception(
                    ImsgRpcProtocolError("imsg rpc response has no result")
                )
            else:
                pending.future.set_result(message["result"])
            return

        method = message.get("method")
        if not isinstance(method, str) or not method:
            self._protocol_failure("imsg rpc notification has no method")
            return
        if self.on_notification:
            try:
                self.on_notification(method, message.get("params"))
            except Exception:
                if self.on_diagnostic:
                    self.on_diagnostic("imsg notification handler failed")

    def _protocol_failure(self, message: str, cause: BaseException | None = None) -> None:
        error = ImsgRpcProtocolError(message)
        if cause is not None:
            error.__cause__ = cause
        self._finish(error)
        self._terminate_process()

    def _remove_pending(self, key: str) -> _Pending | None:
        with self._lock:
            return self._pending.pop(key, None)

    def _finish(self, error: BaseException) -> None:
        with self._lock:
            if self._closed.is_set():
                return
            self._close_error = error
            pending = list(self._pending.values())
            self._pending.clear()
            self._closed.set()
        for item in pending:
            if not item.future.done():
                if item.method == "send" and item.written:
                    item.future.set_exception(
                        ImsgRpcAmbiguous("imsg rpc closed after send was flushed")
                    )
                else:
                    item.future.set_exception(error)

    def _terminate_process(self) -> None:
        with self._lock:
            process = self._process
        if process is not None and process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass


class ImsgRpcSupervisor:
    """Own exactly one RPC child at a time and restart it with bounded backoff."""

    def __init__(
        self,
        client_factory: Callable[[NotificationHandler], RpcClientLike],
        *,
        on_notification: NotificationHandler,
        on_ready: Callable[[RpcClientLike], None] | None = None,
        restart_initial: float = 0.25,
        restart_max: float = 8.0,
        stable_reset_seconds: float = 30.0,
    ) -> None:
        self._client_factory = client_factory
        self._on_notification = on_notification
        self._on_ready = on_ready
        self._restart_initial = restart_initial
        self._restart_max = restart_max
        self._stable_reset_seconds = stable_reset_seconds
        self._stop_event = threading.Event()
        self._ready_event = threading.Event()
        self._lock = threading.RLock()
        self._client: RpcClientLike | None = None
        self._thread: threading.Thread | None = None
        self._last_error: str | None = None
        self._restart_count = 0

    @property
    def is_ready(self) -> bool:
        return self._ready_event.is_set()

    @property
    def restart_count(self) -> int:
        with self._lock:
            return self._restart_count

    @property
    def last_error(self) -> str | None:
        with self._lock:
            return self._last_error

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._run,
                name="openrappter-imsg-supervisor",
                daemon=True,
            )
            self._thread.start()

    def request(
        self,
        method: str,
        params: Mapping[str, object] | None = None,
        timeout: float | None = None,
    ) -> object:
        ready_timeout = 30.0 if timeout is None else timeout
        if not self._ready_event.wait(ready_timeout):
            raise ImsgRpcNotSent("imsg rpc transport is not ready")
        with self._lock:
            client = self._client
        if client is None:
            raise ImsgRpcClosed("imsg rpc transport is not ready")
        # Never retry here. A mutating request may have reached Messages.
        return client.request(method, params, timeout)

    def stop(self) -> None:
        self._stop_event.set()
        self._ready_event.clear()
        with self._lock:
            client = self._client
            thread = self._thread
        if client is not None:
            client.stop()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    def restart(self) -> None:
        """Terminate the active child so the supervisor creates a fresh watch."""
        self._ready_event.clear()
        with self._lock:
            client = self._client
        if client is not None:
            client.stop()

    def _run(self) -> None:
        backoff = self._restart_initial
        while not self._stop_event.is_set():
            started_at = time.monotonic()
            client: RpcClientLike | None = None
            try:
                client = self._client_factory(self._deliver_notification)
                client.start()
                if self._on_ready:
                    self._on_ready(client)
                with self._lock:
                    self._client = client
                    self._last_error = None
                self._ready_event.set()
                close_error = client.wait_closed()
                if close_error is None and not self._stop_event.is_set():
                    close_error = ImsgRpcClosed("imsg rpc closed")
                if close_error is not None:
                    raise close_error
            except BaseException as error:
                if self._stop_event.is_set():
                    break
                with self._lock:
                    self._last_error = type(error).__name__
                    self._restart_count += 1
            finally:
                self._ready_event.clear()
                with self._lock:
                    if self._client is client:
                        self._client = None
                if client is not None:
                    try:
                        client.stop()
                    except Exception:
                        pass

            if self._stop_event.is_set():
                break
            lifetime = time.monotonic() - started_at
            if lifetime >= self._stable_reset_seconds:
                backoff = self._restart_initial
            if self._stop_event.wait(backoff):
                break
            backoff = min(self._restart_max, max(self._restart_initial, backoff * 2))

    def _deliver_notification(self, method: str, params: object) -> None:
        self._on_notification(method, params)
