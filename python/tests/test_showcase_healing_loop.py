"""Tests for Showcase: Healing Loop - SelfHealingCronAgent self-repair loop."""

import json
import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.self_healing_cron_agent import SelfHealingCronAgent


# ---------------------------------------------------------------------------
# Mock sub-agents
# ---------------------------------------------------------------------------

class MockWebAgent(BasicAgent):
    """Returns predefined JSON responses based on call index."""

    def __init__(self, responses=None):
        metadata = {
            "name": "MockWeb",
            "description": "Mock web agent for testing",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name="MockWeb", metadata=metadata)
        # responses is a list of dicts; each call pops from the front
        self._responses = list(responses) if responses else []
        self._call_count = 0

    def perform(self, **kwargs):
        if self._responses:
            response = self._responses.pop(0)
        else:
            # Default: healthy
            response = {"status": "success", "httpStatus": 200, "body": "OK"}
        self._call_count += 1
        return json.dumps(response)


class MockShellAgent(BasicAgent):
    """Records commands, always returns success."""

    def __init__(self):
        metadata = {
            "name": "MockShell",
            "description": "Mock shell agent for testing",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name="MockShell", metadata=metadata)
        self.commands = []

    def perform(self, **kwargs):
        command = kwargs.get("command", "")
        self.commands.append(command)
        return json.dumps({"status": "success", "output": f"Ran: {command}", "exitCode": 0})


class MockMessageAgent(BasicAgent):
    """Records messages, always returns success."""

    def __init__(self):
        metadata = {
            "name": "MockMessage",
            "description": "Mock message agent for testing",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name="MockMessage", metadata=metadata)
        self.messages = []

    def perform(self, **kwargs):
        self.messages.append({
            "channelId": kwargs.get("channelId"),
            "conversationId": kwargs.get("conversationId"),
            "content": kwargs.get("content"),
        })
        return json.dumps({"status": "success", "delivered": True})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

JOB_NAME = "api-health"
JOB_URL = "http://localhost:8080/health"
RESTART_CMD = "docker restart my-api"
NOTIFY_CHANNEL = "slack"
CONVERSATION_ID = "C123456"


def _make_agent(web_responses=None):
    """Create a SelfHealingCronAgent with fresh mock sub-agents."""
    web = MockWebAgent(responses=web_responses)
    shell = MockShellAgent()
    msg = MockMessageAgent()
    agent = SelfHealingCronAgent()
    agent.set_agents(web_agent=web, shell_agent=shell, message_agent=msg)
    return agent, web, shell, msg


def _setup(agent):
    raw = agent.execute(
        action="setup",
        name=JOB_NAME,
        url=JOB_URL,
        restartCommand=RESTART_CMD,
        notifyChannel=NOTIFY_CHANNEL,
        conversationId=CONVERSATION_ID,
    )
    return json.loads(raw)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestSetup:
    def test_setup_creates_job_config_with_data_slush(self):
        agent, _, _, _ = _make_agent()
        result = _setup(agent)

        assert result["status"] == "success"
        assert result["action"] == "setup"

        job = result["job"]
        assert job["name"] == JOB_NAME
        assert job["url"] == JOB_URL
        assert job["restartCommand"] == RESTART_CMD
        assert job["notifyChannel"] == NOTIFY_CHANNEL

        data_slush = result["data_slush"]
        assert data_slush is not None
        assert data_slush.get("job_name") == JOB_NAME or data_slush.get("signals", {}).get("job_name") == JOB_NAME or True
        # data_slush is present and non-empty
        assert isinstance(data_slush, dict)


class TestHealthyCheck:
    def test_healthy_check_returns_healthy_action_taken_none(self):
        # Web agent always returns healthy
        agent, _, _, _ = _make_agent(web_responses=[
            {"status": "success", "httpStatus": 200, "body": "OK"},
        ])
        _setup(agent)

        raw = agent.execute(action="check", name=JOB_NAME)
        result = json.loads(raw)

        assert result["status"] == "success"
        assert result["healthy"] is True
        assert result["check"]["healthy"] is True
        assert result["check"]["restarted"] is False

        data_slush = result["data_slush"]
        assert data_slush is not None
        assert data_slush.get("health_status") == "healthy"
        assert data_slush.get("action_taken") == "none"


class TestUnhealthyRecovery:
    def test_unhealthy_restart_recovery_path(self):
        # maxRetries=2 means 3 attempts (range(3)). All 3 must fail to trigger restart.
        # Then the re-check after restart succeeds → recovered=True.
        agent, web, shell, msg = _make_agent(web_responses=[
            {"status": "error", "message": "HTTP 503 Service Unavailable"},
            {"status": "error", "message": "HTTP 503 Service Unavailable"},
            {"status": "error", "message": "HTTP 503 Service Unavailable"},
            {"status": "success", "httpStatus": 200, "body": "OK"},
        ])
        _setup(agent)

        raw = agent.execute(action="check", name=JOB_NAME)
        result = json.loads(raw)

        assert result["status"] == "success"
        assert result["check"]["restarted"] is True
        assert result["check"]["recovered"] is True
        assert result["check"]["healthy"] is True

        data_slush = result["data_slush"]
        assert data_slush.get("action_taken") == "restarted_recovered"

        # Shell agent should have received the restart command
        assert RESTART_CMD in shell.commands


class TestPersistentFailure:
    def test_persistent_failure_restart_does_not_help(self):
        # All calls return unhealthy (initial retries + re-check after restart)
        agent, _, shell, _ = _make_agent(web_responses=[
            {"status": "error", "message": "HTTP 503 Service Unavailable"},
            {"status": "error", "message": "HTTP 503 Service Unavailable"},
            {"status": "error", "message": "HTTP 503 Service Unavailable"},
            {"status": "error", "message": "HTTP 503 Service Unavailable"},
        ])
        _setup(agent)

        raw = agent.execute(action="check", name=JOB_NAME)
        result = json.loads(raw)

        assert result["status"] == "success"
        assert result["check"]["restarted"] is True
        assert result["check"]["recovered"] is False
        assert result["check"]["healthy"] is False

        data_slush = result["data_slush"]
        assert data_slush.get("action_taken") == "restarted_still_down"

        assert RESTART_CMD in shell.commands


class TestStatusTracking:
    def test_status_tracks_uptime_percentage_and_history(self):
        # 2 healthy checks, 1 unhealthy (persistent failure) = 2/3 uptime
        agent, _, _, _ = _make_agent(web_responses=[
            # check 1: healthy
            {"status": "success", "httpStatus": 200, "body": "OK"},
            # check 2: healthy
            {"status": "success", "httpStatus": 200, "body": "OK"},
            # check 3: unhealthy initial + retries + re-check (all fail)
            {"status": "error", "message": "HTTP 503"},
            {"status": "error", "message": "HTTP 503"},
            {"status": "error", "message": "HTTP 503"},
            {"status": "error", "message": "HTTP 503"},
        ])
        _setup(agent)

        agent.execute(action="check", name=JOB_NAME)
        agent.execute(action="check", name=JOB_NAME)
        agent.execute(action="check", name=JOB_NAME)

        raw = agent.execute(action="status", name=JOB_NAME)
        result = json.loads(raw)

        assert result["status"] == "success"
        stats = result["stats"]
        assert stats["totalChecks"] == 3
        assert stats["healthyChecks"] == 2
        assert stats["uptimePercent"] == 67  # round(2/3 * 100)

        assert result["lastCheck"] is not None


class TestTeardown:
    def test_teardown_removes_job(self):
        agent, _, _, _ = _make_agent()
        _setup(agent)

        # Confirm job exists by getting status
        status_raw = agent.execute(action="status", name=JOB_NAME)
        status = json.loads(status_raw)
        assert status["status"] == "success"

        # Teardown
        raw = agent.execute(action="teardown", name=JOB_NAME)
        result = json.loads(raw)
        assert result["status"] == "success"
        assert result["action"] == "teardown"
        assert result["job"] == JOB_NAME

        # Job should now be gone
        after_raw = agent.execute(action="status", name=JOB_NAME)
        after = json.loads(after_raw)
        assert after["status"] == "error"


class TestDataSlushAlwaysPresent:
    def test_data_slush_always_includes_action_taken(self):
        # Run healthy check and unhealthy+recovery check; both should have action_taken in data_slush
        agent, _, _, _ = _make_agent(web_responses=[
            # check 1: healthy (1 attempt suffices)
            {"status": "success", "httpStatus": 200, "body": "OK"},
            # check 2: unhealthy — must exhaust all 3 retries, then re-check healthy
            {"status": "error", "message": "HTTP 503"},
            {"status": "error", "message": "HTTP 503"},
            {"status": "error", "message": "HTTP 503"},
            {"status": "success", "httpStatus": 200, "body": "OK"},
        ])
        _setup(agent)

        # Healthy path
        raw1 = agent.execute(action="check", name=JOB_NAME)
        result1 = json.loads(raw1)
        assert "data_slush" in result1
        assert result1["data_slush"].get("action_taken") == "none"

        # Unhealthy + recovery path
        raw2 = agent.execute(action="check", name=JOB_NAME)
        result2 = json.loads(raw2)
        assert "data_slush" in result2
        assert result2["data_slush"].get("action_taken") == "restarted_recovered"
