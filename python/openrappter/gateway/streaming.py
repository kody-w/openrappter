"""
Enhanced streaming support for agent responses.

StreamBlock is the atomic unit of streamed output. Each block has a type
('text', 'tool_call', 'tool_result', 'thinking', 'error'), and may
accumulate content via deltas before being marked done.

StreamManager maintains sessions keyed by a caller-supplied id, notifies
subscribers on every mutation, and mirrors the TypeScript StreamManager API
with one known exception: the TS class also accepts a GatewayBroadcaster
(constructor arg + setGateway) to push blocks over WebSocket. That transport
hook is not ported here, so callers must drive delivery via on_block.

Sessions are retained after complete()/error() so the finished transcript
stays readable; call delete_session() to reclaim them.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Literal, Optional

# ── Types ─────────────────────────────────────────────────────────────────

BlockType = Literal["text", "tool_call", "tool_result", "thinking", "error"]
SessionStatus = Literal["active", "complete", "error"]

BlockCallback = Callable[["StreamBlock", "StreamSession"], None]


@dataclass
class StreamBlock:
    id: str
    type: BlockType
    content: str
    done: bool
    timestamp: float
    delta: Optional[str] = None
    metadata: Optional[Dict] = None


@dataclass
class StreamSession:
    id: str
    blocks: List[StreamBlock]
    status: SessionStatus
    created_at: float
    completed_at: Optional[float] = None


# ── StreamManager ─────────────────────────────────────────────────────────

class StreamManager:
    """Manages streaming sessions, blocks, deltas, and subscriber callbacks."""

    def __init__(self) -> None:
        self._sessions: Dict[str, StreamSession] = {}
        self._subscribers: Dict[str, List[BlockCallback]] = {}

    # ── Session lifecycle ──────────────────────────────────────────────────

    def create_session(self, session_id: Optional[str] = None) -> StreamSession:
        """Start a new streaming session. Generates a UUID if no id supplied."""
        sid = session_id if session_id is not None else str(uuid.uuid4())
        session = StreamSession(
            id=sid,
            blocks=[],
            status="active",
            created_at=time.time(),
        )
        self._sessions[sid] = session
        return session

    def complete(self, session_id: str) -> Optional[StreamSession]:
        """Mark a session as complete with a completion timestamp."""
        session = self._sessions.get(session_id)
        if session is None:
            return None
        session.status = "complete"
        session.completed_at = time.time()
        return session

    def error(self, session_id: str) -> Optional[StreamSession]:
        """Mark a session as errored with a completion timestamp."""
        session = self._sessions.get(session_id)
        if session is None:
            return None
        session.status = "error"
        session.completed_at = time.time()
        return session

    def get_session(self, session_id: str) -> Optional[StreamSession]:
        """Return the current session snapshot or None if not found."""
        return self._sessions.get(session_id)

    # ── Block operations ───────────────────────────────────────────────────

    def push_block(
        self,
        session_id: str,
        block_type: BlockType,
        content: str,
        metadata: Optional[Dict] = None,
        *,
        done: bool = False,
        block_id: Optional[str] = None,
        delta: Optional[str] = None,
    ) -> StreamBlock:
        """Upsert a block into the session and notify subscribers.

        Mirrors the TypeScript ``pushBlock``, which takes the whole block as an
        object and so lets the caller set ``id``, ``done`` and ``delta``. The
        signature here stays flat and positional rather than copying that
        object shape, but the capabilities have to match: ``done`` is the
        documented completion signal for a block, and a caller that supplies
        ``block_id`` is updating a block it already pushed.

        A block whose id already exists in the session is *replaced*, not
        appended, so repeatedly pushing the same id revises one block instead
        of growing the transcript. Without a caller-supplied ``block_id`` every
        block gets a fresh UUID and therefore always appends.
        """
        session = self._require_session(session_id)
        resolved = StreamBlock(
            id=block_id if block_id is not None else str(uuid.uuid4()),
            type=block_type,
            content=content,
            done=done,
            timestamp=time.time(),
            delta=delta,
            metadata=metadata,
        )
        existing = next(
            (i for i, b in enumerate(session.blocks) if b.id == resolved.id), None
        )
        if existing is not None:
            session.blocks[existing] = resolved
        else:
            session.blocks.append(resolved)
        self._notify(session_id, resolved)
        return resolved

    def push_delta(self, session_id: str, block_id: str, delta: str) -> StreamBlock:
        """Append a delta to an existing block's content.

        If no block with block_id exists in the session, a new 'text' block is
        created and the delta becomes its initial content.
        """
        session = self._require_session(session_id)
        block = next((b for b in session.blocks if b.id == block_id), None)
        if block is None:
            block = StreamBlock(
                id=block_id,
                type="text",
                content="",
                done=False,
                timestamp=time.time(),
            )
            session.blocks.append(block)
        block.content += delta
        block.delta = delta
        block.timestamp = time.time()
        self._notify(session_id, block)
        return block

    # ── Subscriptions ──────────────────────────────────────────────────────

    def on_block(self, session_id: str, callback: BlockCallback) -> Callable[[], None]:
        """Register a callback invoked on every pushBlock / pushDelta call.

        Returns an unsubscribe function that removes the callback.
        """
        if session_id not in self._subscribers:
            self._subscribers[session_id] = []
        self._subscribers[session_id].append(callback)

        def unsubscribe() -> None:
            subs = self._subscribers.get(session_id)
            if subs is not None and callback in subs:
                subs.remove(callback)
                if not subs:
                    del self._subscribers[session_id]

        return unsubscribe

    # ── Cleanup ────────────────────────────────────────────────────────────

    def delete_session(self, session_id: str) -> None:
        """Remove a session and its subscribers from memory.

        Sessions are retained after ``complete()``/``error()`` so callers can
        still read the finished transcript via ``get_session()``. That means
        nothing is reclaimed until this is called: without it a long-lived
        manager grows without bound, because every session holds its full
        ``blocks`` content.

        Deleting an unknown session id is a no-op, mirroring the TypeScript
        ``deleteSession``. Returns None (not a bool) to match that signature.
        """
        self._sessions.pop(session_id, None)
        self._subscribers.pop(session_id, None)

    # ── Computed properties ────────────────────────────────────────────────

    @property
    def active_sessions(self) -> int:
        """Return the count of sessions with status 'active'."""
        return sum(1 for s in self._sessions.values() if s.status == "active")

    # ── Private ────────────────────────────────────────────────────────────

    def _require_session(self, session_id: str) -> StreamSession:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"StreamSession '{session_id}' not found")
        return session

    def _notify(self, session_id: str, block: StreamBlock) -> None:
        session = self._sessions.get(session_id)
        if session is None:
            return
        for cb in list(self._subscribers.get(session_id, [])):
            try:
                cb(block, session)
            except Exception:
                pass  # isolate subscriber errors


# Module-level singleton for convenience
stream_manager = StreamManager()
