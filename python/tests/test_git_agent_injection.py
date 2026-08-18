"""Caller-supplied values reach ``git`` as arguments, never as shell syntax.

``GitAgent._default_exec`` ran ``subprocess.run(cmd, shell=True)`` and every
caller built ``cmd`` with an f-string. Confirmed against the agent::

    perform(action='log', count='1 ; touch /tmp/openrappter-py-injection-proof')
    -> the file was created

``count`` was not special. ``name`` (branch), ``file_list`` (add), ``message``
(commit) and the ``gh pr create`` title, body and base were interpolated the
same way -- five reachable sites.

This is the Python half of the same defect fixed in the TypeScript agent in
#263. The two are transliterations, so the flaw came across with the code, and
finding it in one runtime meant it was worth looking in the other.

The fix is structural rather than per-field: the exec seam takes a binary and a
list, and ``subprocess.run`` is called without ``shell=True``. There is no shell
left to escape into, so no escaping rule has to be got right.

These tests assert on the argv the agent builds. Nothing here runs git.
"""

from __future__ import annotations

import pytest

from openrappter.agents.git_agent import GitAgent

PAYLOAD = "1 ; touch /tmp/openrappter-py-injection-proof"


@pytest.fixture
def calls():
    return []


@pytest.fixture
def agent(calls):
    def exec_fn(binary, args, cwd=None):
        calls.append((binary, list(args)))
        return {"stdout": "", "stderr": ""}

    return GitAgent(cwd=".", exec_fn=exec_fn)


def test_an_injected_count_stays_one_argument(agent, calls):
    agent.perform(action="log", count=PAYLOAD)
    log = next(c for c in calls if c[1][0] == "log")
    # The payload may appear -- as a single argv entry. What must not happen is
    # it being split into further arguments, which is what a shell did.
    suspicious = [a for a in log[1] if "touch" in a]
    assert suspicious == [f"-{PAYLOAD}"]


def test_an_injected_branch_name_stays_one_argument(agent, calls):
    agent.perform(action="branch", create=True, name="feature; rm -rf /tmp/x")
    checkout = next(c for c in calls if c[1][0] == "checkout")
    assert checkout == ("git", ["checkout", "-b", "feature; rm -rf /tmp/x"])


def test_an_injected_commit_message_stays_one_argument(agent, calls):
    agent.perform(action="commit", files=["a.py"], message='msg" ; touch /tmp/x ; echo "')
    commit = next(c for c in calls if c[1][0] == "commit")
    assert commit == ("git", ["commit", "-m", 'msg" ; touch /tmp/x ; echo "'])


def test_the_agent_never_builds_shell_metacharacters(agent, calls):
    # The property that makes the class impossible rather than handled: any
    # metacharacter present is one the caller put inside a single value.
    agent.perform(action="status")
    agent.perform(action="diff")
    for binary, args in calls:
        assert binary in {"git", "gh"}
        for arg in args:
            assert not any(ch in arg for ch in ";&|"), f"{binary} {args}"


def test_it_still_issues_the_command(agent, calls):
    # Anti-vacuity: assertions about argv prove nothing if the agent stopped
    # running commands at all.
    agent.perform(action="status")
    assert calls == [("git", ["status", "--porcelain"])]


def test_the_default_exec_does_not_use_a_shell():
    # The seam is what made every call site dangerous, so it is pinned directly
    # rather than only through the call sites above.
    import ast
    import inspect
    import textwrap

    # Parse rather than grep: the docstring explaining this fix mentions
    # `shell=True`, so a substring check on the source fails on the very
    # sentence describing the repair.
    tree = ast.parse(textwrap.dedent(inspect.getsource(GitAgent._default_exec)))
    shell_kwargs = [
        keyword
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        for keyword in node.keywords
        if keyword.arg == "shell"
    ]
    assert shell_kwargs == [], "subprocess must not be given shell="
