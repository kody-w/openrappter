"""Tests for ShellAgent - bash, read, write, list actions and NL parsing."""

import json
import os
import pytest
from pathlib import Path

from openrappter.agents.shell_agent import ShellAgent
from openrappter.result_status import agent_result_is_error


@pytest.fixture
def agent():
    return ShellAgent()


# --- Metadata ---

class TestShellMetadata:
    def test_name(self, agent):
        assert agent.name == "Shell"

    def test_actions_enum(self, agent):
        actions = agent.metadata["parameters"]["properties"]["action"]["enum"]
        assert set(actions) == {"bash", "read", "write", "list"}


# --- Bash execution ---

class TestBashAction:
    def test_echo_command(self, agent):
        result = json.loads(agent.perform(action="bash", command="echo hello"))
        assert result["status"] == "success"
        assert "hello" in result["output"]
        assert result["return_code"] == 0

    def test_failed_command(self, agent):
        result_json = agent.perform(action="bash", command="false")
        result = json.loads(result_json)
        assert result["status"] == "error"
        assert result["return_code"] != 0
        assert agent_result_is_error(result_json) is True

    def test_no_command_error(self, agent):
        result = json.loads(agent.perform(action="bash", command=""))
        assert result["status"] == "error"

    def test_output_truncation(self, agent):
        result = json.loads(agent.perform(action="bash", command="seq 1 10000"))
        assert len(result["output"]) <= 2000


# --- File read ---

class TestReadAction:
    def test_read_file(self, agent, tmp_path):
        f = tmp_path / "test.txt"
        f.write_text("hello world")
        result = json.loads(agent.perform(action="read", path=str(f)))
        assert result["status"] == "success"
        assert result["content"] == "hello world"
        assert result["truncated"] is False

    def test_read_nonexistent(self, agent):
        result = json.loads(agent.perform(action="read", path="/nonexistent/file.txt"))
        assert result["status"] == "error"
        assert "not found" in result["message"].lower()

    def test_read_no_path(self, agent):
        result = json.loads(agent.perform(action="read", path=""))
        assert result["status"] == "error"

    def test_read_truncates_large_file(self, agent, tmp_path):
        f = tmp_path / "big.txt"
        f.write_text("x" * 10000)
        result = json.loads(agent.perform(action="read", path=str(f)))
        assert result["truncated"] is True
        assert len(result["content"]) == 5000

    def test_read_directory_falls_back_to_list(self, agent, tmp_path):
        (tmp_path / "child.txt").write_text("data")
        result = json.loads(agent.perform(action="read", path=str(tmp_path)))
        assert result["status"] == "success"
        assert "items" in result


# --- File write ---

class TestWriteAction:
    def test_write_file(self, agent, tmp_path):
        target = tmp_path / "out.txt"
        result = json.loads(agent.perform(action="write", path=str(target), content="hello"))
        assert result["status"] == "success"
        assert result["bytes_written"] == 5
        assert target.read_text() == "hello"

    def test_write_creates_parents(self, agent, tmp_path):
        target = tmp_path / "deep" / "nested" / "file.txt"
        result = json.loads(agent.perform(action="write", path=str(target), content="data"))
        assert result["status"] == "success"
        assert target.exists()

    def test_write_no_path(self, agent):
        result = json.loads(agent.perform(action="write", path="", content="hello"))
        assert result["status"] == "error"

    def test_write_no_content(self, agent):
        result = json.loads(agent.perform(action="write", path="/tmp/test.txt", content=""))
        assert result["status"] == "error"


# --- Directory listing ---

class TestListAction:
    def test_list_directory(self, agent, tmp_path):
        (tmp_path / "a.txt").write_text("a")
        (tmp_path / "b.txt").write_text("b")
        (tmp_path / "subdir").mkdir()
        result = json.loads(agent.perform(action="list", path=str(tmp_path)))
        assert result["status"] == "success"
        assert result["count"] == 3
        names = [i["name"] for i in result["items"]]
        assert "a.txt" in names
        assert "subdir" in names

    def test_list_includes_type(self, agent, tmp_path):
        (tmp_path / "file.txt").write_text("x")
        (tmp_path / "dir").mkdir()
        result = json.loads(agent.perform(action="list", path=str(tmp_path)))
        types = {i["name"]: i["type"] for i in result["items"]}
        assert types["file.txt"] == "file"
        assert types["dir"] == "directory"

    def test_list_nonexistent_dir(self, agent):
        result = json.loads(agent.perform(action="list", path="/nonexistent/dir"))
        assert result["status"] == "error"

    def test_list_file_falls_back_to_read(self, agent, tmp_path):
        f = tmp_path / "single.txt"
        f.write_text("content")
        result = json.loads(agent.perform(action="list", path=str(f)))
        assert result["status"] == "success"
        assert "content" in result


# --- Natural language query parsing ---

class TestQueryParsing:
    def test_run_prefix(self, agent):
        action, cmd, path, content = agent._parse_query("run ls -la")
        assert action == "bash"
        assert cmd == "ls -la"

    def test_execute_prefix(self, agent):
        action, cmd, path, content = agent._parse_query("execute whoami")
        assert action == "bash"
        assert cmd == "whoami"

    def test_dollar_prefix(self, agent):
        action, cmd, path, content = agent._parse_query("$ pwd")
        assert action == "bash"
        assert cmd == "pwd"

    def test_read_prefix(self, agent):
        action, cmd, path, content = agent._parse_query("read /etc/hosts")
        assert action == "read"
        assert path == "/etc/hosts"

    def test_show_prefix(self, agent):
        action, cmd, path, content = agent._parse_query("show /tmp/file.txt")
        assert action == "read"

    def test_cat_prefix(self, agent):
        action, cmd, path, content = agent._parse_query("cat ~/.bashrc")
        assert action == "read"

    def test_list_prefix(self, agent):
        action, cmd, path, content = agent._parse_query("list ~/projects")
        assert action == "list"
        assert path == "~/projects"

    def test_ls_keyword(self, agent):
        action, cmd, path, content = agent._parse_query("ls")
        assert action == "list"

    def test_default_to_bash(self, agent):
        action, cmd, path, content = agent._parse_query("echo foobar")
        assert action == "bash"


# --- Action inference via perform ---

class TestActionInference:
    def test_no_action_with_query(self, agent):
        result = json.loads(agent.perform(query="echo inferred"))
        assert result["status"] == "success"
        assert "inferred" in result.get("output", "")

    def test_no_action_no_query_error(self, agent):
        result = json.loads(agent.perform())
        assert result["status"] == "error"

    def test_command_without_action(self, agent):
        result = json.loads(agent.perform(command="echo direct"))
        assert result["status"] == "success"
        assert "direct" in result["output"]


class TestNewlineBypass:
    """The exec safety policy checked one string and ran another.

    normalize_command collapses all whitespace, newlines included, so the
    injection rule for newlines never saw one: the policy judged the flattened
    single line safe and subprocess.run then executed the original, newline and
    all — two commands, neither approved.

    This file is also the one exempted from the no-shell-command-building
    guard, on the grounds that exec safety gates it, which only holds while the
    gate cannot be stepped around.
    """

    def test_a_newline_command_is_refused(self):
        agent = ShellAgent()
        result = json.loads(agent.perform(command="ls\ntouch /tmp/exec-safety-bypass-proof"))
        assert result["status"] == "error", result
        assert result.get("blocked") is True, result
        assert "newline-injection" in result["message"], result
        # Not turned into an approval request either: a reviewer would have
        # been shown the flattened line rather than what would run.
        assert "approval_id" not in result, result

    def test_a_carriage_return_is_refused(self):
        agent = ShellAgent()
        result = json.loads(agent.perform(command="ls\rtouch /tmp/x"))
        assert result.get("blocked") is True, result

    def test_the_two_spellings_really_did_disagree(self):
        # Pins the premise. If normalization stops swallowing newlines, this
        # fails and the guard can go.
        from openrappter.security.exec_safety import ExecSafety
        safety = ExecSafety()
        raw = "ls\ntouch /tmp/x"
        assert safety.check_command(raw).safe is False
        assert safety.check_command(safety.normalize_command(raw)).safe is True

    def test_an_ordinary_command_still_runs(self):
        # Anti-vacuity: a guard that blocked everything would pass the above.
        agent = ShellAgent()
        result = json.loads(agent.perform(command="echo hello"))
        assert result["status"] == "success", result
        assert "hello" in result["output"]


class TestSingleAmpersandChain:
    """A single `&` chains commands too.

    The injection patterns covered `&&` and not `&`, so "ls & touch /tmp/x" was
    judged safe and both commands ran. Verified in a real shell:
    `sh -c 'ls / >/dev/null & touch /tmp/marker'` creates the marker.
    """

    def test_a_background_chain_is_blocked(self):
        agent = ShellAgent()
        result = json.loads(agent.perform(command="ls & touch /tmp/amp-bypass-proof"))
        assert result.get("blocked") is True, result
        assert "background-chain" in result["message"], result

    def test_a_trailing_ampersand_is_blocked(self):
        from openrappter.security.exec_safety import ExecSafety
        assert ExecSafety().check_command("ls &").safe is False

    def test_double_ampersand_keeps_its_own_reason(self):
        # The new rule must not swallow the existing one.
        from openrappter.security.exec_safety import ExecSafety
        result = ExecSafety().check_command("ls && touch /tmp/x")
        assert result.safe is False
        assert "and-chain" in result.reason

    def test_ordinary_commands_are_untouched(self):
        from openrappter.security.exec_safety import ExecSafety
        safety = ExecSafety()
        for cmd in ("echo hello", "ls -la", "git status"):
            assert safety.check_command(cmd).safe is True, cmd


class TestGitIsDualUse:
    """git runs whatever its configuration tells it to.

    `git -c alias.x='!cmd' x` executes `cmd`; there is no separator and no
    substitution, so nothing in the injection patterns can see it, and git was
    on the safe list. Verified against a real repository: the alias form
    creates the marker file.
    """

    def test_git_is_classified_dual_use(self):
        from openrappter.security.exec_safety import ExecSafety, DUAL_USE_BINS
        assert "git" in DUAL_USE_BINS
        result = ExecSafety().check_command("git -c alias.x=!touch /tmp/x x")
        assert result.safe is True            # still on the safe list
        assert result.requires_approval is True  # but a human has to look

    def test_ordinary_read_only_binaries_are_still_not_dual_use(self):
        from openrappter.security.exec_safety import ExecSafety
        safety = ExecSafety()
        for cmd in ("ls -la", "cat f", "grep x f", "echo hi"):
            result = safety.check_command(cmd)
            assert result.safe is True, cmd
            assert not result.requires_approval, cmd


class TestReachingASafeNameByAnotherRoute:
    """_parse_binary skips leading VAR=value assignments and takes the
    basename. Both are right for classifying the command and neither was
    evaluated as a risk, so two shapes ran ungated:

      LD_PRELOAD=/tmp/x.so ls   the loader reads the assignment after exec;
                                the `env LD_PRELOAD=...` spelling already
                                required approval because env is dual-use
      ./ls                      judged as the system ls by basename
    """

    def _safety(self):
        from openrappter.security.exec_safety import ExecSafety
        return ExecSafety()

    def test_environment_assignment_is_gated(self):
        safety = self._safety()
        for cmd in ("LD_PRELOAD=/tmp/evil.so ls",
                    "DYLD_INSERT_LIBRARIES=/tmp/evil.dylib ls"):
            result = safety.check_command(cmd)
            assert result.requires_approval is True, cmd
            assert "Environment assignment" in result.reason, cmd

    def test_a_plantable_path_is_gated(self):
        safety = self._safety()
        for cmd in ("./ls", "/tmp/ls"):
            result = safety.check_command(cmd)
            assert result.requires_approval is True, cmd

    def test_system_directories_stay_ungated(self):
        # Over-gating has a cost: every gated command needs a human.
        safety = self._safety()
        for cmd in ("/bin/ls -la", "/usr/bin/grep x f"):
            assert not safety.check_command(cmd).requires_approval, cmd

    def test_ordinary_commands_stay_ungated(self):
        safety = self._safety()
        for cmd in ("ls -la", "cat f", "echo hi"):
            assert not safety.check_command(cmd).requires_approval, cmd

    def test_an_unknown_path_binary_is_blocked_not_gated(self):
        result = self._safety().check_command("scripts/build.sh")
        assert result.safe is False
        assert "not in the safe list" in result.reason


class TestTheApprovalQueueTellsTheReviewerWhy:
    """check_command works out precisely why a command needs a person, and that
    explanation went to the caller in the agent's error message. The approval
    queue recorded 'Approval token issued for: <cmd>', so the human deciding
    saw the command restated back at them.

    Gating a command only helps if the person approving it can judge it.
    """

    def _pending_for(self, command):
        from openrappter.security.exec_safety import ExecSafety
        safety = ExecSafety()
        ShellAgent(exec_safety=safety).perform(command=command)
        return safety.list_pending_approvals()[0]

    def test_names_the_environment_assignment(self):
        pending = self._pending_for("LD_PRELOAD=/tmp/evil.so ls")
        assert "Environment assignment" in pending["reason"], pending
        assert "LD_PRELOAD" in pending["cmd"]

    def test_names_the_plantable_path(self):
        pending = self._pending_for("./ls")
        assert "not necessarily the system tool" in pending["reason"], pending

    def test_names_the_dual_use_binary(self):
        pending = self._pending_for("curl https://example.com")
        assert "Dual-use binary" in pending["reason"], pending

    def test_does_not_restate_the_command_as_its_own_justification(self):
        pending = self._pending_for("LD_PRELOAD=/tmp/evil.so ls")
        assert not pending["reason"].startswith("Approval token issued for:"), pending
