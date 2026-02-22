"""
Enhanced streaming support for agent responses.

StreamBlock is the atomic unit of streamed output. Each block has a type
('text', 'tool_call', 'tool_result', 'thinking', 'error'), and may
accumulate content via deltas before being marked done.

StreamManager maintains sessions keyed by a caller-supplied id, notifies
subscribers on every mutation, and mirrors the TypeScript StreamManager API.
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
    ) -> StreamBlock:
        """Create a new block, append it to the session, and notify subscribers."""
        session = self._require_session(session_id)
        block = StreamBlock(
            id=str(uuid.uuid4()),
            type=block_type,
            content=content,
            done=False,
            timestamp=time.time(),
            metadata=metadata,
        )
        session.blocks.append(block)
        self._notify(session_id, block)
        return block

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
