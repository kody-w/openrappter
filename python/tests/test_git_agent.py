"""Tests for GitAgent - git repository operations with injectable exec function."""

import json
import pytest

from openrappter.agents.git_agent import GitAgent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_exec(responses):
    """Build a deterministic exec function from a dict of command-prefix -> result."""
    def exec_fn(cmd, cwd=None):
        for prefix, response in responses.items():
            if prefix in cmd:
                return response
        return {"stdout": "", "stderr": ""}
    return exec_fn


def status_exec(files=None):
    """Create exec that returns a git status with given files."""
    if files is None:
        stdout = ""
    else:
        lines = "\n".join(f" M {f}" for f in files)
        stdout = lines
    return make_exec({"git status": {"stdout": stdout, "stderr": ""}})


# ---------------------------------------------------------------------------
# Tests: constructor and metadata
# ---------------------------------------------------------------------------

class TestGitAgentInit:
    def test_name_is_git(self):
        agent = GitAgent()
        assert agent.name == "Git"

    def test_metadata_has_correct_actions(self):
        agent = GitAgent()
        actions = agent.metadata["parameters"]["properties"]["action"]["enum"]
        assert set(actions) == {"status", "diff", "log", "branch", "commit", "pr"}

    def test_metadata_name_is_git(self):
        agent = GitAgent()
        assert agent.metadata["name"] == "Git"

    def test_accepts_custom_cwd(self):
        agent = GitAgent(cwd="/tmp")
        assert agent._cwd == "/tmp"

    def test_accepts_custom_exec_fn(self):
        fn = lambda cmd, cwd=None: {"stdout": "", "stderr": ""}
        agent = GitAgent(exec_fn=fn)
        assert agent._exec_fn is fn


# ---------------------------------------------------------------------------
# Tests: no action / unknown action
# ---------------------------------------------------------------------------

class TestActionValidation:
    def test_no_action_returns_error(self):
        agent = GitAgent()
        result = json.loads(agent.perform())
        assert result["status"] == "error"
        assert "action" in result["message"].lower()

    def test_unknown_action_returns_error(self):
        agent = GitAgent()
        result = json.loads(agent.perform(action="rebase"))
        assert result["status"] == "error"
        assert "Unknown action" in result["message"]


# ---------------------------------------------------------------------------
# Tests: status action
# ---------------------------------------------------------------------------

class TestStatusAction:
    def test_status_clean_repo(self):
        agent = GitAgent(exec_fn=status_exec([]))
        result = json.loads(agent.perform(action="status"))
        assert result["status"] == "success"
        assert result["action"] == "status"
        assert result["clean"] is True
        assert result["files"] == []

    def test_status_with_modified_files(self):
        agent = GitAgent(exec_fn=status_exec(["foo.py", "bar.py"]))
        result = json.loads(agent.perform(action="status"))
        assert result["clean"] is False
        assert len(result["files"]) == 2

    def test_status_file_entries_have_status_and_file_keys(self):
        agent = GitAgent(exec_fn=status_exec(["README.md"]))
        result = json.loads(agent.perform(action="status"))
        entry = result["files"][0]
        assert "status" in entry
        assert "file" in entry

    def test_status_includes_data_slush(self):
        agent = GitAgent(exec_fn=status_exec([]))
        result = json.loads(agent.perform(action="status"))
        assert "data_slush" in result

    def test_status_data_slush_has_file_count_signal(self):
        agent = GitAgent(exec_fn=status_exec(["a.py", "b.py"]))
        result = json.loads(agent.perform(action="status"))
        signals = result["data_slush"].get("signals", {})
        assert signals.get("file_count") == 2


# ---------------------------------------------------------------------------
# Tests: diff action
# ---------------------------------------------------------------------------

class TestDiffAction:
    def test_diff_returns_success(self):
        exec_fn = make_exec({
            "git diff --stat": {"stdout": "1 file changed", "stderr": ""},
            "git diff": {"stdout": "-old\n+new", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="diff"))
        assert result["status"] == "success"
        assert result["action"] == "diff"

    def test_diff_includes_stat(self):
        exec_fn = make_exec({
            "git diff --stat": {"stdout": "1 file changed, 2 insertions", "stderr": ""},
            "git diff": {"stdout": "", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="diff"))
        assert "1 file changed" in result["stat"]

    def test_diff_includes_diff_content(self):
        exec_fn = make_exec({
            "git diff --stat": {"stdout": "", "stderr": ""},
            "git diff": {"stdout": "-old line\n+new line", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="diff"))
        assert "-old line" in result["diff"]

    def test_diff_not_truncated_when_small(self):
        exec_fn = make_exec({
            "git diff --stat": {"stdout": "", "stderr": ""},
            "git diff": {"stdout": "small diff", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="diff"))
        assert result["truncated"] is False

    def test_diff_truncated_when_large(self):
        large_diff = "x" * 20000
        exec_fn = make_exec({
            "git diff --stat": {"stdout": "", "stderr": ""},
            "git diff": {"stdout": large_diff, "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="diff"))
        assert result["truncated"] is True
        assert len(result["diff"]) <= 10000

    def test_diff_includes_data_slush(self):
        exec_fn = make_exec({
            "git diff --stat": {"stdout": "", "stderr": ""},
            "git diff": {"stdout": "", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="diff"))
        assert "data_slush" in result


# ---------------------------------------------------------------------------
# Tests: log action
# ---------------------------------------------------------------------------

class TestLogAction:
    def _make_commit_line(self, hash_val="abc123", author="Dev", subject="Fix bug"):
        return json.dumps({
            "hash": hash_val * 6,
            "short": hash_val,
            "author": author,
            "date": "2026-01-01 10:00:00",
            "subject": subject,
        })

    def test_log_returns_success(self):
        line = self._make_commit_line()
        exec_fn = make_exec({"git log": {"stdout": line, "stderr": ""}})
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="log"))
        assert result["status"] == "success"
        assert result["action"] == "log"

    def test_log_parses_commits(self):
        lines = "\n".join([
            self._make_commit_line("abc", subject="First"),
            self._make_commit_line("def", subject="Second"),
        ])
        exec_fn = make_exec({"git log": {"stdout": lines, "stderr": ""}})
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="log"))
        assert result["count"] == 2
        subjects = [c["subject"] for c in result["commits"]]
        assert "First" in subjects
        assert "Second" in subjects

    def test_log_empty_output_returns_zero_commits(self):
        exec_fn = make_exec({"git log": {"stdout": "", "stderr": ""}})
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="log"))
        assert result["count"] == 0
        assert result["commits"] == []

    def test_log_includes_data_slush(self):
        exec_fn = make_exec({"git log": {"stdout": "", "stderr": ""}})
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="log"))
        assert "data_slush" in result

    def test_log_respects_count_parameter(self):
        captured = []

        def exec_fn(cmd, cwd=None):
            captured.append(cmd)
            return {"stdout": "", "stderr": ""}

        agent = GitAgent(exec_fn=exec_fn)
        agent.perform(action="log", count=5)
        assert any("-5 " in cmd or "-5\n" in cmd or cmd.endswith("-5") or " -5 " in cmd
                   for cmd in captured), f"Count not found in: {captured}"


# ---------------------------------------------------------------------------
# Tests: branch action
# ---------------------------------------------------------------------------

class TestBranchAction:
    def test_branch_list_returns_branches(self):
        exec_fn = make_exec({
            "git branch --format": {"stdout": "main\nfeat/x", "stderr": ""},
            "git branch --show-current": {"stdout": "main", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="branch"))
        assert result["status"] == "success"
        assert "main" in result["branches"]

    def test_branch_list_shows_current(self):
        exec_fn = make_exec({
            "git branch --format": {"stdout": "main", "stderr": ""},
            "git branch --show-current": {"stdout": "main", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="branch"))
        assert result["current"] == "main"

    def test_branch_create_returns_created_name(self):
        exec_fn = make_exec({
            "git checkout -b": {"stdout": "Switched to new branch 'feature/foo'", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="branch", name="feature/foo"))
        assert result["status"] == "success"
        assert result["created"] == "feature/foo"

    def test_branch_includes_data_slush(self):
        exec_fn = make_exec({
            "git branch --format": {"stdout": "main", "stderr": ""},
            "git branch --show-current": {"stdout": "main", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="branch"))
        assert "data_slush" in result


# ---------------------------------------------------------------------------
# Tests: commit action
# ---------------------------------------------------------------------------

class TestCommitAction:
    def test_commit_requires_message(self):
        agent = GitAgent()
        result = json.loads(agent.perform(action="commit"))
        assert result["status"] == "error"
        assert "message" in result["message"]

    def test_commit_returns_success_with_message(self):
        exec_fn = make_exec({
            "git commit": {"stdout": "[main abc1234] Test commit", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="commit", message="Test commit"))
        assert result["status"] == "success"
        assert result["action"] == "commit"
        assert result["message"] == "Test commit"

    def test_commit_with_files_stages_them(self):
        staged = []

        def exec_fn(cmd, cwd=None):
            if "git add" in cmd:
                staged.append(cmd)
                return {"stdout": "", "stderr": ""}
            return {"stdout": "[main abc] msg", "stderr": ""}

        agent = GitAgent(exec_fn=exec_fn)
        agent.perform(action="commit", files=["a.py", "b.py"], message="staged")
        assert len(staged) == 1
        assert "a.py" in staged[0]
        assert "b.py" in staged[0]

    def test_commit_includes_data_slush(self):
        exec_fn = make_exec({
            "git commit": {"stdout": "[main abc] msg", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="commit", message="test"))
        assert "data_slush" in result


# ---------------------------------------------------------------------------
# Tests: pr action
# ---------------------------------------------------------------------------

class TestPrAction:
    def test_pr_requires_title(self):
        agent = GitAgent()
        result = json.loads(agent.perform(action="pr"))
        assert result["status"] == "error"
        assert "title" in result["message"]

    def test_pr_returns_success_with_title(self):
        exec_fn = make_exec({
            "gh pr create": {"stdout": "https://github.com/x/y/pull/1", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="pr", title="My PR"))
        assert result["status"] == "success"
        assert result["action"] == "pr"
        assert result["title"] == "My PR"

    def test_pr_uses_main_as_default_base(self):
        exec_fn = make_exec({
            "gh pr create": {"stdout": "https://github.com/x/y/pull/2", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="pr", title="Test PR"))
        assert result["base"] == "main"

    def test_pr_accepts_custom_base(self):
        exec_fn = make_exec({
            "gh pr create": {"stdout": "url", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="pr", title="PR", base="develop"))
        assert result["base"] == "develop"

    def test_pr_includes_data_slush(self):
        exec_fn = make_exec({
            "gh pr create": {"stdout": "url", "stderr": ""},
        })
        agent = GitAgent(exec_fn=exec_fn)
        result = json.loads(agent.perform(action="pr", title="Test PR"))
        assert "data_slush" in result
