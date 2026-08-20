"""Knowing a capability's name is not the same as being able to detect it.

Two different tables carry the word "capability", and only one of them was
guarded.

`agent-capability-vocabulary.test.ts` already reads `CAPABILITY_EVIDENCE` out
of `conformance.py` and rejects any TypeScript agent that *declares* a word not
in it. That check is sound, it has anti-vacuity guards, and it caught
`PhoneAgent` declaring `network-access`. Nothing here duplicates it.

What it cannot see is the other table. `capability-reachability.test.ts` holds
the regexes that decide whether an agent *reaches* a capability, and that is
what detects a declaration which is missing. Its own comment introduces it as
"mirroring CAPABILITY_EVIDENCE" — and nothing checked that mirror. Python
listed five capabilities; the evidence table listed three.

So an agent could pass the vocabulary check with flying colours while reaching
a capability no pattern could see. `credential-access` and `dynamic-code` could not be reported for a
TypeScript agent in either direction — not as under-declared, not as
over-declared — while R4's passing message asserted that
"TypeScript is covered by capability-reachability.test.ts".

That is not hypothetical. `PythonAgent.ts` was wrong both ways at once:

* it reads `process.env.OPENRAPPTER_PYTHON` and declared no
  `credential-access`, while `pokemon_agent.py` declares exactly that
  capability for `os.environ.get("OPENRAPPTER_POKEMON_ROM")` — a ROM path. The
  same code got two verdicts depending on the language it was written in.
* it declares `dynamic-code`, correctly, because the runner it spawns loads an
  arbitrary `.py` file by path. Nothing in its own source shows that, so
  extending the table naively reported a *true* declaration as over-declared —
  which would have pushed someone to delete it. Hence `NO_ABSENCE_PROOF`:
  evidence proves reach, absence of evidence does not prove its opposite.

Both tables have now been found defective on their own, in separate rounds,
for the same underlying reason — they are maintained separately. These tests
make the vocabularies unable to diverge again without something going red.

They deliberately compare *vocabulary*, not patterns. The two runtimes look for
genuinely different things (`import subprocess` versus
`from 'child_process'`), so demanding identical regexes would be a false
equivalence. What must match is which capabilities each side is able to speak
about at all.
"""

import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import conformance  # noqa: E402

TS_TEST = ROOT / "typescript" / "src" / "agents" / "__tests__" / \
    "capability-reachability.test.ts"


def _ts_source():
    if not TS_TEST.exists():  # pragma: no cover - the file is committed
        pytest.fail(f"{TS_TEST} is missing; R4 names it as TypeScript's cover")
    return TS_TEST.read_text(encoding="utf-8")


def _ts_object_keys(source, header):
    """Quoted keys declared at the top level of the object opened by `header`.

    A line-oriented read on purpose. The block holds regex literals containing
    quotes and braces, which no brace counter parses correctly, so this looks
    only at what a key declaration looks like: two spaces, a quoted name, a
    colon. If that formatting ever changes this fails loudly, which is the
    right outcome for a test whose whole subject is that file.
    """
    start = source.index(header) + len(header)
    end = source.index("\n};", start)
    return {m.group(1) for m in
            re.finditer(r"(?m)^  '([a-z][a-z-]*)':", source[start:end])}


def _ts_set_members(source, name):
    m = re.search(r"const %s = new Set\(\[(.*?)\]\)" % re.escape(name),
                  source, re.S)
    if m is None:
        pytest.fail(f"{name} is not declared in {TS_TEST.name}")
    return set(re.findall(r"'([a-z][a-z-]*)'", m.group(1)))


EVIDENCE_HEADER = "const EVIDENCE: Record<string, RegExp> = {"


def test_the_typescript_table_is_still_where_r4_says_it_is():
    # Anti-vacuity: every assertion below reads this file.
    assert EVIDENCE_HEADER in _ts_source()


def test_python_knows_more_than_zero_capabilities():
    assert len(conformance.CAPABILITY_EVIDENCE) >= 5


def test_both_runtimes_speak_the_same_capability_vocabulary():
    """The drift this file exists to prevent.

    Before this test, Python had five entries and TypeScript three.
    """
    python_caps = set(conformance.CAPABILITY_EVIDENCE)
    ts_caps = _ts_object_keys(_ts_source(), EVIDENCE_HEADER)
    missing_in_ts = sorted(python_caps - ts_caps)
    missing_in_python = sorted(ts_caps - python_caps)
    assert not missing_in_ts, (
        "TypeScript agents cannot be checked for %s, but R4 reports that "
        "TypeScript is covered" % missing_in_ts)
    assert not missing_in_python, (
        "TypeScript checks %s and Python has no evidence for it"
        % missing_in_python)


def test_every_capability_is_detectable_in_at_least_one_direction():
    """Evidence is what turns a vocabulary word into an enforced rule.

    A capability with no pattern is a word an agent may declare and no runtime
    can check, which is the state `credential-access` and `dynamic-code` were
    in for TypeScript.
    """
    ts_caps = _ts_object_keys(_ts_source(), EVIDENCE_HEADER)
    exempt = _ts_set_members(_ts_source(), "NO_ABSENCE_PROOF")
    undetectable = sorted(set(conformance.CAPABILITY_EVIDENCE) - ts_caps)
    assert not undetectable, (
        "no TypeScript evidence, so an agent may reach these undeclared: %s"
        % undetectable)
    assert exempt < ts_caps, "an exemption must not remove a capability entirely"


def test_the_over_declaration_exemption_names_real_capabilities():
    exempt = _ts_set_members(_ts_source(), "NO_ABSENCE_PROOF")
    assert exempt, "the exemption set is empty; the comment explains why it is not"
    assert exempt <= set(conformance.CAPABILITY_EVIDENCE), (
        "exempted from over-declaration but not a capability: %s"
        % sorted(exempt - set(conformance.CAPABILITY_EVIDENCE)))


def test_the_exemption_stays_narrow():
    """An exemption for everything would silently retire the whole check."""
    exempt = _ts_set_members(_ts_source(), "NO_ABSENCE_PROOF")
    assert len(exempt) < len(conformance.CAPABILITY_EVIDENCE)


def test_an_environment_read_counts_as_credential_access_in_python():
    """The rule TypeScript now matches, stated where it is enforced.

    A config-shaped name is still an environment read: nothing here can tell
    `OPENRAPPTER_POKEMON_ROM` from `OPENAI_API_KEY`.
    """
    spec = conformance.CAPABILITY_EVIDENCE["credential-access"]
    assert "environ" in spec.get("attrs", set())
    assert "os.environ.get" in spec["calls"]


def test_r4_still_delegates_typescript_to_the_file_this_test_guards():
    """If R4 stops naming that file, this test is guarding nothing."""
    ok, detail = conformance.r4_capabilities_honest.__wrapped__() \
        if hasattr(conformance.r4_capabilities_honest, "__wrapped__") \
        else conformance.r4_capabilities_honest()
    assert ok, detail
    assert "capability-reachability.test.ts" in detail
