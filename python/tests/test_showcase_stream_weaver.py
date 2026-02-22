"""Tests for Showcase: Stream Weaver - StreamManager sessions, blocks, deltas."""

import time
import uuid

import pytest

from openrappter.gateway.streaming import StreamBlock, StreamManager, StreamSession


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------

class TestCreateSession:
    def test_create_active_session_with_uuid(self):
        manager = StreamManager()
        session_id = str(uuid.uuid4())
        session = manager.create_session(session_id)

        assert session.id == session_id
        assert session.status == "active"
        assert session.blocks == []
        assert session.created_at > 0


class TestCompleteSession:
    def test_complete_marks_session_lifecycle(self):
        manager = StreamManager()
        manager.create_session("sess_1")

        completed = manager.complete("sess_1")

        assert completed is not None
        assert completed.status == "complete"
        assert completed.completed_at is not None
        assert completed.completed_at > 0


class TestErrorSession:
    def test_error_marks_session_lifecycle(self):
        manager = StreamManager()
        manager.create_session("sess_1")

        errored = manager.error("sess_1")

        assert errored is not None
        assert errored.status == "error"
        assert errored.completed_at is not None
        assert errored.completed_at > 0


# ---------------------------------------------------------------------------
# Push blocks
# ---------------------------------------------------------------------------

class TestPushTextBlock:
    def test_push_text_block_has_id_content_type(self):
        manager = StreamManager()
        manager.create_session("sess_1")

        block = manager.push_block("sess_1", "text", "Hello world")

        assert block.id  # truthy UUID string
        assert block.type == "text"
        assert block.content == "Hello world"
        assert block.done is False

        session = manager.get_session("sess_1")
        assert session is not None
        assert len(session.blocks) == 1


class TestPushMultipleBlockTypes:
    def test_push_multiple_block_types(self):
        manager = StreamManager()
        manager.create_session("sess_1")

        manager.push_block("sess_1", "text", "Thinking...")
        manager.push_block("sess_1", "tool_call", '{"name":"bash"}')
        manager.push_block("sess_1", "thinking", "Processing...")

        session = manager.get_session("sess_1")
        assert session is not None
        assert len(session.blocks) == 3

        types = [b.type for b in session.blocks]
        assert "text" in types
        assert "tool_call" in types
        assert "thinking" in types


# ---------------------------------------------------------------------------
# Delta accumulation
# ---------------------------------------------------------------------------

class TestDeltaAccumulation:
    def test_push_delta_builds_content_incrementally(self):
        manager = StreamManager()
        manager.create_session("sess_1")

        manager.push_delta("sess_1", "block_1", "Hello")
        manager.push_delta("sess_1", "block_1", " world")
        block = manager.push_delta("sess_1", "block_1", "!")

        assert block.content == "Hello world!"
        assert block.delta == "!"  # most recent delta only

        session = manager.get_session("sess_1")
        assert session is not None
        assert len(session.blocks) == 1


# ---------------------------------------------------------------------------
# Subscribers
# ---------------------------------------------------------------------------

class TestSubscriberNotification:
    def test_on_block_callback_fires_on_push_block(self):
        manager = StreamManager()
        manager.create_session("sess_1")

        received: list[StreamBlock] = []

        manager.on_block("sess_1", lambda block, _session: received.append(block))

        manager.push_block("sess_1", "text", "Hello")
        manager.push_block("sess_1", "text", "World")

        assert len(received) == 2
        assert received[0].content == "Hello"
        assert received[1].content == "World"


class TestUnsubscribeCleanup:
    def test_unsubscribe_stops_callback_from_firing(self):
        manager = StreamManager()
        manager.create_session("sess_1")

        received: list[StreamBlock] = []
        unsub = manager.on_block("sess_1", lambda block, _session: received.append(block))

        manager.push_block("sess_1", "text", "First")
        unsub()
        manager.push_block("sess_1", "text", "Second")

        assert len(received) == 1
        assert received[0].content == "First"


# ---------------------------------------------------------------------------
# Active sessions count
# ---------------------------------------------------------------------------

class TestActiveSessionsCount:
    def test_active_sessions_tracks_active_vs_complete(self):
        manager = StreamManager()
        manager.create_session("sess_1")
        manager.create_session("sess_2")
        manager.create_session("sess_3")

        assert manager.active_sessions == 3

        manager.complete("sess_1")
        manager.error("sess_2")

        assert manager.active_sessions == 1
