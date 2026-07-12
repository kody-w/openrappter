"""
WebhookChannel — a concrete, local/offline-friendly channel.

Runs a small aiohttp HTTP server on its own dedicated background thread
(with its own private asyncio event loop), so the public ``BaseChannel``
contract (``connect``/``disconnect``/``send``) stays fully synchronous —
matching every other channel in this package and the existing
``ChannelRegistry``/showcase tests — while the network listener itself is
async under the hood.

Request/response model: a caller POSTs ``{"content": "...", "conversation_id"?,
"sender_id"?}`` to the configured path. The channel turns that into an
``IncomingMessage`` and emits it to registered handlers (e.g. a
``ProviderChannelBridge``). Once a handler calls ``send()`` for the same
``conversation_id``, the HTTP response resolves with the outgoing message —
so a single POST is a full synchronous request/response round trip, with no
separate callback URL required. If no handler ever responds, the request
times out with a bounded, explicit error rather than hanging forever.
"""

from __future__ import annotations

import asyncio
import threading
import uuid
from concurrent.futures import Future as ConcurrentFuture
from dataclasses import dataclass
from typing import Dict, Optional, Set

from aiohttp import web

from openrappter._bounded_workers import (
    BoundedDaemonExecutor,
    WorkerCapacityError,
    wait_for_worker,
)
from openrappter.channels.base import BaseChannel, IncomingMessage, OutgoingMessage

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PATH = "/inbound"
DEFAULT_REQUEST_TIMEOUT = 30.0
DEFAULT_START_TIMEOUT = 10.0
DEFAULT_STOP_TIMEOUT = 2.0
DEFAULT_MAX_HANDLER_WORKERS = 4


class ChannelConnectionError(Exception):
    """Raised when the channel's local listener fails to start or stop cleanly."""


@dataclass
class _PendingReply:
    generation: str
    future: "asyncio.Future[OutgoingMessage]"
    worker: Optional[ConcurrentFuture[None]] = None


class WebhookChannel(BaseChannel):
    """A local HTTP webhook channel suitable for offline development and tests.

    Binds to ``127.0.0.1`` (or an explicit ``host``) on ``port`` (0 = OS
    assigns a free ephemeral port, resolved into ``self.port`` once
    connected).
    """

    def __init__(
        self,
        name: str = "webhook",
        host: str = DEFAULT_HOST,
        port: int = 0,
        path: str = DEFAULT_PATH,
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
        max_handler_workers: int = DEFAULT_MAX_HANDLER_WORKERS,
    ) -> None:
        if request_timeout <= 0:
            raise ValueError("request_timeout must be positive")
        if max_handler_workers < 1:
            raise ValueError("max_handler_workers must be at least 1")

        super().__init__(name, channel_type="webhook")
        self.host = host
        self.port = port
        self._bind_port = port
        self.path = path
        self.request_timeout = request_timeout
        self.max_handler_workers = max_handler_workers

        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._runner: Optional[web.AppRunner] = None
        self._site: Optional[web.TCPSite] = None
        self._handler_pool = BoundedDaemonExecutor(
            max_workers=self.max_handler_workers,
            thread_name_prefix=f"webhook-handler-{self.name}",
        )
        self._handler_executor: Optional[BoundedDaemonExecutor] = None
        self._ready = threading.Event()
        self._lifecycle_lock = threading.RLock()
        self._start_error: Optional[BaseException] = None
        self._pending: Dict[str, _PendingReply] = {}
        self._pending_lock = threading.Lock()
        self._request_tasks: Set["asyncio.Task[object]"] = set()
        self._handler_tasks: Set["asyncio.Task[None]"] = set()
        self._worker_futures: Dict[ConcurrentFuture[None], tuple[str, str]] = {}
        self._worker_futures_lock = threading.Lock()
        self._worker_context = threading.local()
        self._stopping = False

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}{self.path}"

    # ── BaseChannel contract ────────────────────────────────────────────

    def connect(self) -> None:
        """Start the local HTTP listener. Idempotent — calling connect() on
        an already-connected channel is a no-op."""
        with self._lifecycle_lock:
            if self.connected:
                return
            if self._thread is not None and self._thread.is_alive():
                raise ChannelConnectionError(
                    f"Webhook channel '{self.name}' still has a previous listener"
                )

            self._ready.clear()
            self._start_error = None
            self._stopping = False
            self._thread = threading.Thread(
                target=self._run_loop, name=f"webhook-channel-{self.name}", daemon=True
            )
            self._thread.start()

            if not self._ready.wait(timeout=DEFAULT_START_TIMEOUT):
                raise ChannelConnectionError(
                    f"Webhook channel '{self.name}' failed to start in time"
                )
            if self._start_error is not None:
                error = self._start_error
                self._start_error = None
                self._thread.join(timeout=DEFAULT_START_TIMEOUT)
                self._thread = None
                self._loop = None
                raise ChannelConnectionError(
                    f"Webhook channel '{self.name}' failed to start: {error}"
                )

            self.connected = True

    def disconnect(self) -> None:
        """Stop the listener without waiting for untrusted synchronous work.

        Message subscriptions intentionally survive transport reconnects;
        callers that own a subscription (such as ``ProviderChannelBridge``)
        remove it explicitly when they stop.
        """
        with self._lifecycle_lock:
            if not self.connected and self._thread is None:
                return

            self.connected = False
            loop = self._loop
            shutdown_error: Optional[BaseException] = None
            if loop is not None and loop.is_running():
                future = asyncio.run_coroutine_threadsafe(self._stop_server(), loop)
                try:
                    future.result(timeout=DEFAULT_STOP_TIMEOUT)
                except BaseException as exc:  # noqa: BLE001
                    shutdown_error = exc
                    future.cancel()
                finally:
                    if loop.is_running():
                        loop.call_soon_threadsafe(loop.stop)

            thread = self._thread
            if thread is not None:
                thread.join(timeout=DEFAULT_STOP_TIMEOUT)
                if thread.is_alive() and shutdown_error is None:
                    shutdown_error = TimeoutError("webhook event loop did not stop in time")

            listener_stopped = thread is None or not thread.is_alive()
            if listener_stopped:
                self._loop = None
                self._thread = None
                self._runner = None
                self._site = None
            self._handler_executor = None
            self._stopping = not listener_stopped

            self._request_tasks.clear()
            self._handler_tasks.clear()

            if shutdown_error is not None:
                raise ChannelConnectionError(
                    f"Webhook channel '{self.name}' failed to stop: {shutdown_error}"
                ) from shutdown_error

    def send(self, conversation_id: str, message: OutgoingMessage) -> None:
        """Resolve the pending HTTP request for ``conversation_id``, if any.

        If no request is currently waiting (e.g. a proactive/out-of-band
        send with no inbound webhook call), the message is counted but
        otherwise dropped — there is no open HTTP connection to deliver it
        to.
        """
        self.message_count += 1
        generation = message.request_generation
        worker_key = getattr(self._worker_context, "request_key", None)
        if not generation and worker_key and worker_key[0] == conversation_id:
            generation = worker_key[1]
        if not generation:
            return
        with self._pending_lock:
            pending = self._pending.get(conversation_id)
            if pending is None or generation != pending.generation:
                return
            future = pending.future
        loop = future.get_loop()
        if loop is None or loop.is_closed():
            return

        def _resolve() -> None:
            if not future.done():
                future.set_result(message)

        try:
            loop.call_soon_threadsafe(_resolve)
        except RuntimeError:
            # Shutdown owns all pending work, but this final guard keeps a
            # late third-party handler callback from touching a closed loop.
            return

    # ── Private: dedicated event loop thread ────────────────────────────

    def _run_loop(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        try:
            loop.run_until_complete(self._start_server())
        except BaseException as exc:  # noqa: BLE001 — surfaced to connect()
            self._start_error = exc
            loop.run_until_complete(self._cleanup_failed_start())
        finally:
            self._ready.set()
        try:
            if self._start_error is None:
                loop.run_forever()
        finally:
            remaining = asyncio.all_tasks(loop)
            for task in remaining:
                task.cancel()
            if remaining:
                loop.run_until_complete(
                    asyncio.gather(*remaining, return_exceptions=True)
                )
            loop.run_until_complete(loop.shutdown_asyncgens())
            asyncio.set_event_loop(None)
            loop.close()

    async def _start_server(self) -> None:
        self._handler_executor = self._handler_pool
        app = web.Application()
        app.router.add_post(self.path, self._handle_post)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self.host, self._bind_port)
        await self._site.start()
        if self._bind_port == 0:
            addresses = self._runner.addresses
            if addresses:
                self.port = addresses[0][1]

    async def _stop_server(self) -> None:
        self._stopping = True
        if self._site is not None:
            await self._site.stop()
            self._site = None

        with self._pending_lock:
            response_futures = tuple(item.future for item in self._pending.values())
        for future in response_futures:
            if not future.done():
                future.cancel()

        pending_tasks = tuple(self._request_tasks | self._handler_tasks)
        for task in pending_tasks:
            if not task.done():
                task.cancel()
        if pending_tasks:
            await asyncio.gather(*pending_tasks, return_exceptions=True)

        self._handler_pool.cancel_pending()

        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None

        self._handler_executor = None

    async def _cleanup_failed_start(self) -> None:
        if self._site is not None:
            try:
                await self._site.stop()
            except Exception:  # noqa: BLE001 — preserve the original start failure
                pass
            self._site = None
        if self._runner is not None:
            try:
                await self._runner.cleanup()
            except Exception:  # noqa: BLE001 — preserve the original start failure
                pass
            self._runner = None
        self._handler_pool.cancel_pending()
        self._handler_executor = None

    def _release_reservation(self, conversation_id: str, generation: str) -> None:
        with self._pending_lock:
            pending = self._pending.get(conversation_id)
            if pending is not None and pending.generation == generation:
                self._pending.pop(conversation_id, None)

    def _emit_for_generation(
        self,
        incoming: IncomingMessage,
        generation: str,
    ) -> None:
        self._worker_context.request_key = (incoming.conversation_id, generation)
        try:
            self.emit_message(incoming)
        finally:
            self._worker_context.request_key = None

    def _worker_finished(
        self,
        future: ConcurrentFuture[None],
        conversation_id: str,
        generation: str,
    ) -> None:
        self._release_reservation(conversation_id, generation)
        with self._worker_futures_lock:
            self._worker_futures.pop(future, None)

    async def _run_handlers(
        self,
        incoming: IncomingMessage,
        generation: str,
    ) -> None:
        executor = self._handler_executor
        if executor is None or self._stopping:
            raise ChannelConnectionError("channel is disconnecting")

        concurrent_future: Optional[ConcurrentFuture[None]] = None
        while concurrent_future is None:
            if self._stopping or self._handler_executor is not executor:
                self._release_reservation(incoming.conversation_id, generation)
                raise ChannelConnectionError("channel is disconnecting")
            try:
                concurrent_future = executor.submit(
                    self._emit_for_generation,
                    incoming,
                    generation,
                )
            except WorkerCapacityError:
                await asyncio.sleep(0.005)

        with self._pending_lock:
            pending = self._pending.get(incoming.conversation_id)
            if pending is not None and pending.generation == generation:
                pending.worker = concurrent_future
        with self._worker_futures_lock:
            self._worker_futures[concurrent_future] = (
                incoming.conversation_id,
                generation,
            )

        concurrent_future.add_done_callback(
            lambda future: self._worker_finished(
                future,
                incoming.conversation_id,
                generation,
            )
        )
        await wait_for_worker(concurrent_future)

    @staticmethod
    async def _wait_for_response(
        handler_task: "asyncio.Task[None]",
        response_future: "asyncio.Future[OutgoingMessage]",
    ) -> OutgoingMessage:
        await handler_task
        return await response_future

    async def _handle_post(self, request: web.Request) -> web.Response:
        request_task = asyncio.current_task()
        if request_task is not None:
            self._request_tasks.add(request_task)
        try:
            return await self._handle_post_inner(request)
        finally:
            if request_task is not None:
                self._request_tasks.discard(request_task)

    async def _handle_post_inner(self, request: web.Request) -> web.Response:
        if self._stopping:
            return web.json_response({"error": "channel disconnected"}, status=503)

        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON body"}, status=400)

        if not isinstance(body, dict):
            return web.json_response({"error": "body must be a JSON object"}, status=400)

        content = body.get("content")
        if not isinstance(content, str) or not content:
            return web.json_response({"error": "'content' is required"}, status=400)

        conversation_id = body.get("conversation_id") or uuid.uuid4().hex
        sender_id = body.get("sender_id", "") or ""

        incoming = IncomingMessage(
            channel_id=self.name,
            conversation_id=conversation_id,
            content=content,
            sender_id=sender_id,
            request_generation=uuid.uuid4().hex,
        )

        loop = asyncio.get_running_loop()
        future: "asyncio.Future[OutgoingMessage]" = loop.create_future()
        generation = incoming.request_generation
        with self._pending_lock:
            if conversation_id in self._pending:
                return web.json_response(
                    {"error": "conversation already has a pending request"},
                    status=409,
                )
            self._pending[conversation_id] = _PendingReply(generation, future)

        handler_task: "asyncio.Task[None]" = loop.create_task(
            self._run_handlers(incoming, generation)
        )
        self._handler_tasks.add(handler_task)
        handler_task.add_done_callback(self._handler_tasks.discard)

        try:
            outgoing = await asyncio.wait_for(
                self._wait_for_response(handler_task, future),
                timeout=self.request_timeout,
            )
        except asyncio.TimeoutError:
            return web.json_response(
                {"error": "timed out waiting for a response"}, status=504
            )
        except asyncio.CancelledError:
            return web.json_response({"error": "channel disconnected"}, status=503)
        except Exception as exc:  # noqa: BLE001 — bounded transport error
            return web.json_response({"error": str(exc)}, status=502)
        finally:
            if not handler_task.done():
                handler_task.cancel()
            await asyncio.gather(handler_task, return_exceptions=True)
            if not future.done():
                future.cancel()
            with self._pending_lock:
                pending = self._pending.get(conversation_id)
                if (
                    pending is not None
                    and pending.generation == generation
                    and pending.worker is None
                ):
                    self._pending.pop(conversation_id, None)

        return web.json_response(
            {
                "conversation_id": outgoing.conversation_id,
                "content": outgoing.content,
                "role": outgoing.role,
            }
        )
