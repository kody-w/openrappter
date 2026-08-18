"""A manifest inside a string is not a manifest.

R2 used to accept any non-Python agent whose file merely *contained* the
substrings ``__manifest__`` and ``rapp-agent/1.0``, and R3 skipped non-Python
agents entirely. Both were true of ``ComputerUseAgent.ts`` while it exported no
manifest at all: a generated block had been inserted at an offset that fell
inside the Python source string the agent passes to ``python3``. Conformance
reported "8 passed, 0 failed" over a file whose manifest the runtime could not
see and whose OCR script was a syntax error.

A manifest block spans lines, and the only JavaScript string that can span
lines is a template literal, so backtick parity is what separates a declaration
from text that resembles one.
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import conformance  # noqa: E402


REAL = """
export class Thing {}

export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/thing',
  version: '1.0.0',
  description: 'A thing.',
  capabilities: ['network', 'filesystem-write'],
} as const;
"""

BURIED = """
export class Thing {
  async run() {
    await exec(`python3 -c "
import sys

export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/thing',
  version: '1.0.0',
  description: 'A thing.',
  capabilities: ['network'],
} as const;
print('hi')
"`);
  }
}
"""


def _write(tmp_path, body):
    p = tmp_path / "Thing.ts"
    p.write_text(body, encoding="utf-8")
    return str(p)


def test_reads_a_real_declaration(tmp_path):
    man = conformance.js_declared_manifest(_write(tmp_path, REAL))
    assert man is not None
    assert man["schema"] == "rapp-agent/1.0"
    assert man["name"] == "@openrappter/thing"
    assert man["capabilities"] == ["network", "filesystem-write"]


def test_ignores_a_manifest_buried_in_a_template_literal(tmp_path):
    # The exact shape that hit ComputerUseAgent.ts. Every substring a text
    # check looks for is present; none of it is a declaration.
    path = _write(tmp_path, BURIED)
    assert "__manifest__" in Path(path).read_text(encoding="utf-8")
    assert "rapp-agent/1.0" in Path(path).read_text(encoding="utf-8")
    assert conformance.js_declared_manifest(path) is None


def test_finds_a_real_declaration_after_a_template_literal(tmp_path):
    # Anti-vacuity: backtick parity must not reject everything that follows a
    # template literal, only what sits inside one.
    man = conformance.js_declared_manifest(_write(tmp_path, BURIED + REAL))
    assert man is not None
    assert man["name"] == "@openrappter/thing"


@pytest.mark.parametrize("check", ["r2_manifest_present", "r3_manifest_complete"])
def test_shipped_agents_satisfy_the_contract(check):
    ok, detail = getattr(conformance, check).__wrapped__() \
        if hasattr(getattr(conformance, check), "__wrapped__") \
        else getattr(conformance, check)()
    assert ok, detail
