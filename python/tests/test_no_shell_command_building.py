"""No agent may build a shell command out of caller data.

`GitAgent` did, in both runtimes, at five sites each. The Python half ran
``subprocess.run(cmd, shell=True)`` with ``cmd`` assembled by f-string, and
``count='1 ; touch /tmp/x'`` created the file. The TypeScript half was the same
code, transliterated, with the same flaw (#263, #265).

Finding it twice is why this exists. Both were fixed by passing an argument
vector instead, but nothing stopped the shape returning -- and it is a shape
that reads as ordinary code.

What this refuses:

* ``shell=True`` where the command is anything other than a literal constant.
  A constant pipeline is fine: it is what the author wrote, and no caller can
  reach into it.
* ``os.system`` and ``os.popen`` at all. Both always use a shell and neither
  takes an argument vector, so there is no safe form to allow.

The scan is an AST walk rather than a grep, because a comment explaining a past
fix mentions ``shell=True`` -- a substring check flags the sentence describing
the repair, which is exactly how the first version of a related test failed.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

AGENTS_DIR = Path(__file__).resolve().parents[1] / "openrappter" / "agents"

# `shell=True` over a constant the author wrote is not the defect. Each entry is
# a promise that no caller-supplied value reaches that command.
# The one agent whose purpose is running shell commands. Exempt only while it
# still routes through ExecSafety, which is asserted below rather than assumed:
# injection patterns and dual-use binaries are refused there, and it fails
# closed when the safety module cannot be imported. Verified live --
# `ls; echo X` and `curl ...` are both blocked, `echo hello` is not.
GATED_BY_EXEC_SAFETY = "shell_agent.py"

CONSTANT_PIPELINES = {
    ("computer_use_agent.py", "system_profiler SPDisplaysDataType | grep Resolution | head -1"),
}


def agent_files() -> list[Path]:
    return sorted(p for p in AGENTS_DIR.glob("*.py") if p.name != "__init__.py")


def _is_literal(node: ast.AST) -> bool:
    return isinstance(node, ast.Constant) and isinstance(node.value, str)


def shell_offenders(path: Path) -> list[str]:
    """Calls in `path` that hand a non-literal command to a shell."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    offenders: list[str] = []

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue

        target = ast.unparse(node.func)

        if target in {"os.system", "os.popen"}:
            offenders.append(f"{path.name}:{node.lineno} {target}")
            continue

        uses_shell = any(
            keyword.arg == "shell"
            and isinstance(keyword.value, ast.Constant)
            and keyword.value.value is True
            for keyword in node.keywords
        )
        if not uses_shell or not node.args:
            continue

        command = node.args[0]
        if _is_literal(command):
            if (path.name, command.value) in CONSTANT_PIPELINES:
                continue
            offenders.append(f"{path.name}:{node.lineno} undeclared constant pipeline")
            continue

        offenders.append(f"{path.name}:{node.lineno} shell=True over {type(command).__name__}")

    return offenders


def test_the_scan_finds_agents_to_check():
    # Anti-vacuity: an empty file list would make every assertion below pass.
    assert len(agent_files()) > 15


def test_the_scan_can_parse_every_agent():
    for path in agent_files():
        ast.parse(path.read_text(encoding="utf-8"))


def checked_files() -> list[Path]:
    """Every agent except the one that runs shell commands by design.

    Filtered rather than skipped. The acceptance gate refuses a suite with any
    skip in it -- "exit=0, skipped checks present" -- which is the right policy
    and caught the first version of this file. A skip would also have made the
    exemption invisible in the run output, where it is easiest to stop noticing.
    """
    return [p for p in agent_files() if p.name != GATED_BY_EXEC_SAFETY]


@pytest.mark.parametrize("path", checked_files(), ids=lambda p: p.name)
def test_no_agent_builds_a_shell_command_from_data(path: Path):
    assert shell_offenders(path) == []


def test_exactly_one_agent_is_exempt():
    # The exemption list is one name. If it grows, that should be a visible
    # decision rather than a quiet one.
    exempt = {p.name for p in agent_files()} - {p.name for p in checked_files()}
    assert exempt == {GATED_BY_EXEC_SAFETY}


def test_the_exempt_agent_is_still_gated():
    """The exemption is conditional, so the condition is checked.

    If ShellAgent ever stops consulting ExecSafety, the skip above would hide a
    shell that takes arbitrary input -- the worst possible thing for this file
    to be quiet about.
    """
    source = (AGENTS_DIR / GATED_BY_EXEC_SAFETY).read_text(encoding="utf-8")
    assert "ExecSafety" in source
    assert "check_command" in source
    # Fails closed: no safety engine means no execution, not unchecked
    # execution.
    assert "Shell execution is unavailable" in source


def test_the_detector_actually_detects(tmp_path):
    # Control: the rule is worth nothing if the walk cannot see the shape it
    # exists to refuse.
    sample = tmp_path / "bad_agent.py"
    sample.write_text(
        "import subprocess\n"
        "def run(name):\n"
        "    subprocess.run(f'git checkout -b {name}', shell=True)\n"
        "    os.system('ls')\n",
        encoding="utf-8",
    )
    found = shell_offenders(sample)
    assert any("JoinedStr" in f for f in found), found
    assert any("os.system" in f for f in found), found


def test_a_declared_constant_pipeline_is_allowed(tmp_path):
    # The exemption has to work, or the rule forces every author to abandon
    # pipelines they wrote themselves.
    sample = tmp_path / "computer_use_agent.py"
    sample.write_text(
        "import subprocess\n"
        "subprocess.check_output("
        "'system_profiler SPDisplaysDataType | grep Resolution | head -1', shell=True)\n",
        encoding="utf-8",
    )
    assert shell_offenders(sample) == []
