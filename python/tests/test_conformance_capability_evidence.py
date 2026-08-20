"""The capability detector had a key in its table that nothing read.

``CAPABILITY_EVIDENCE["credential-access"]`` carried ``"attrs": {"environ"}``.
``observed_capabilities`` read ``modules``, ``calls`` and ``builtins`` — never
``attrs``. So the one entry written specifically to catch environment reads was
inert, and every non-call form of reaching the environment was invisible:

    os.environ["OPENAI_API_KEY"]     a subscript, not a call
    dict(os.environ)                 an argument, not a call
    os.environ.copy()                a call the table does not name
    from os import environ           binds a bare name with no receiver at all

Ten of ten realistic forms escaped; only ``os.getenv`` and ``os.environ.get``
were caught, so an agent passed or failed on which spelling its author
happened to prefer. Nothing failed when the key went dead, because
``observed_capabilities`` — the function that decides whether an agent secretly
reaches a capability — had no tests at all.

The first test below is the one that matters: it fails if any key in the table
is not read by the walker, so this cannot recur silently for a future key.
"""

import ast
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import conformance  # noqa: E402


def _write(tmp_path, body):
    p = tmp_path / "sample_agent.py"
    p.write_text("import os\n" + body + "\n", encoding="utf-8")
    return str(p)


def _keys_the_walker_reads():
    """Key names ``observed_capabilities`` actually looks up, from its source.

    Read out of the syntax tree rather than hard-coded, so this stays true when
    the walker is edited.
    """
    tree = ast.parse(Path(conformance.__file__).read_text(encoding="utf-8"))
    fn = next(n for n in ast.walk(tree)
              if isinstance(n, ast.FunctionDef)
              and n.name == "observed_capabilities")
    keys = set()
    for node in ast.walk(fn):
        if (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "get"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "spec"
                and node.args
                and isinstance(node.args[0], ast.Constant)):
            keys.add(node.args[0].value)
    return keys


def test_no_key_in_the_evidence_table_is_dead():
    """A key nothing reads is a control that silently does nothing."""
    declared = {k for spec in conformance.CAPABILITY_EVIDENCE.values()
                for k in spec}
    read = _keys_the_walker_reads()
    assert declared <= read, (
        f"evidence keys never read by observed_capabilities: "
        f"{sorted(declared - read)}")


def test_the_walker_reads_something():
    """Guards the test above against passing because it found nothing."""
    assert _keys_the_walker_reads() >= {"modules", "calls", "attrs"}


ENV_FORMS = [
    ("subscript", 'os.environ["OPENAI_API_KEY"]'),
    ("subscript, single quotes", "os.environ['TOKEN']"),
    ("bound to a local first", "env = os.environ\nvalue = env['SECRET']"),
    ("copied wholesale", "leaked = os.environ.copy()"),
    ("materialised as a dict", "leaked = dict(os.environ)"),
    ("bytes environment", "os.environb[b'TOKEN']"),
    ("from-import", "from os import environ\nvalue = environ['K']"),
    ("setdefault", "os.environ.setdefault('A', 'b')"),
    ("iterated", "[k for k in os.environ.items()]"),
    ("names enumerated", "names = list(os.environ.keys())"),
    ("passed to a callee", "send(os.environ)"),
]


@pytest.mark.parametrize("label,body", ENV_FORMS, ids=[f[0] for f in ENV_FORMS])
def test_reaching_the_environment_is_credential_access(tmp_path, label, body):
    found, _ = conformance.observed_capabilities(_write(tmp_path, body))
    assert "credential-access" in found, f"{label} went unseen: {body!r}"


@pytest.mark.parametrize("body", [
    "os.getenv('TOKEN')",
    "os.environ.get('TOKEN')",
    "import getpass\ngetpass.getpass()",
])
def test_the_forms_that_already_worked_still_work(tmp_path, body):
    found, _ = conformance.observed_capabilities(_write(tmp_path, body))
    assert "credential-access" in found


@pytest.mark.parametrize("body", [
    # An attribute rule matching too broadly would fire on all of these.
    "config = load()\nprint(config.environment)",
    "import json\njson.loads('{}')",
    "row = table['environ']",
    "environment = 'staging'",
    "# read os.environ later, maybe",
    "'''docstring mentioning os.environ'''",
])
def test_it_stays_quiet_on_code_that_reads_no_secrets(tmp_path, body):
    found, _ = conformance.observed_capabilities(_write(tmp_path, body))
    assert "credential-access" not in found, f"false positive on {body!r}"


@pytest.mark.parametrize("cap", sorted(conformance.CAPABILITY_EVIDENCE))
def test_every_capability_in_the_table_can_be_detected(cap):
    """Anti-vacuity: a capability whose evidence is all unreachable keys would
    otherwise sit in the table looking like protection."""
    spec = conformance.CAPABILITY_EVIDENCE[cap]
    assert any(spec.get(k) for k in _keys_the_walker_reads()), \
        f"{cap} has no evidence the walker can act on"
