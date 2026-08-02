#!/usr/bin/env python3
"""The Google Voice watcher's judgement, on the grail bones.

Asserts the SAME fixture the TypeScript asserts — tests/google-voice-parity.json.
If these two files ever disagree, the same inbox behaves differently depending on
which platform woke up first, and the claim that one organism runs on either set
of bones is no longer true.

Also enforces Article VII by reading the agent's own syntax tree rather than
trusting a comment: no imports outside the standard library, no network, no
subprocess, and no clock. A tier without a browser must still be able to load
this file and reason correctly about an inbox.

    python3 python/tests/test_google_voice_agent.py
"""

import ast
import json
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
AGENT = os.path.join(ROOT, "python", "openrappter", "agents", "google_voice_agent.py")
FIXTURE = os.path.join(ROOT, "tests", "google-voice-parity.json")

# The grail loads agents with `from agents.basic_agent import BasicAgent`; stand
# that up so this test needs no brainstem running.
_agents = types.ModuleType("agents")
_agents.__path__ = []
_basic = types.ModuleType("agents.basic_agent")


class _BasicAgent:
    def __init__(self, name=None, metadata=None):
        if name:
            self.name = name
        if metadata:
            self.metadata = metadata


_basic.BasicAgent = _BasicAgent
sys.modules["agents"] = _agents
sys.modules["agents.basic_agent"] = _basic

sys.path.insert(0, os.path.join(ROOT, "python", "openrappter", "agents"))
import google_voice_agent as gv  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   %s" % name)
    else:
        FAIL += 1
        print("  FAIL %s%s" % (name, ("\n         " + detail) if detail else ""))


def eq(name, actual, expected):
    check(name, actual == expected, "expected %r, got %r" % (expected, actual))


def main():
    """Run every parity + portability check. Returns the number that failed.

    Wrapped in a function because pytest collects this file by name, and a
    module-level `sys.exit()` aborts the entire collection with INTERNALERROR —
    which took the whole Python suite down, not just this file.
    """
    global PASS, FAIL
    PASS = 0
    FAIL = 0
    print("\ngoogle voice watch parity (python)")

    with open(FIXTURE) as fh:
        fx = json.load(fh)

    # ── the shared cases ─────────────────────────────────────────────────────────
    for case in fx["cases"]:
        policy = case.get("policy") or fx["policy"]
        # A raise is a failure of THIS case, not a reason to abandon the suite —
        # otherwise one broken branch hides every other result behind a traceback.
        try:
            verdict = gv.decide(case["message"], case["state"], policy, fx["now"])
            ok = verdict["act"] == case["expect"]["act"] and verdict["reason"] == case["expect"]["reason"]
            detail = "expected %r, got %r" % (
                case["expect"], {"act": verdict["act"], "reason": verdict["reason"]},
            )
        except Exception as exc:  # noqa: BLE001
            ok, detail = False, "raised %s: %s" % (type(exc).__name__, exc)
        check(case["$why"][:96], ok, detail)

    # ── the shared state transitions ─────────────────────────────────────────────
    for t in fx["transitions"]:
        if t["op"] == "observe":
            got = gv.observe(t["state"], t["threadId"], t["at"])
        else:
            got = gv.record_reply(t["state"], t["message"], t["at"])
        check(t["$why"][:96], got == t["expect"], "expected %r, got %r" % (t["expect"], got))

    # ── the same standalone properties the TypeScript asserts ────────────────────
    empty = gv.empty_state()
    msg = {
        "id": "x", "threadId": "t.any", "from": "+15551112222",
        "direction": "inbound", "text": "hi", "at": fx["now"] - 1000,
    }
    eq("an empty watcher answers nobody", gv.decide(msg, empty, gv.DEFAULT_POLICY, fx["now"])["act"], False)
    seen = gv.observe(empty, "t.any", fx["now"] - 5000)
    eq("acts only after the thread was observed once", gv.decide(msg, seen, gv.DEFAULT_POLICY, fx["now"])["act"], True)

    state = gv.observe(gv.empty_state(), "t.loop", fx["now"] - 10000)
    allowed = 0
    for i in range(20):
        m = {
            "id": "loop-%d" % i, "threadId": "t.loop", "from": "+15551113333",
            "direction": "inbound", "text": "again", "at": fx["now"] - 1000 + i,
        }
        if not gv.decide(m, state, gv.DEFAULT_POLICY, fx["now"])["act"]:
            break
        allowed += 1
        state = gv.record_reply(state, m, fx["now"])
    eq("stops at the cap, and does not creep past it", allowed, gv.DEFAULT_POLICY["maxRepliesPerThread"])

    big = gv.observe(gv.empty_state(), "t.big", 0)
    for i in range(700):
        big = gv.record_reply(
            big, {"id": "n%d" % i, "threadId": "t.big", "from": "+1555", "direction": "inbound", "text": "x", "at": i}, i
        )
    check("handled ids stay bounded for a 24/7 daemon", len(big["handled"]) <= 500,
          "grew to %d" % len(big["handled"]))
    check("the newest handled id survives trimming", "n699" in big["handled"])

    # `now` is never invented. A tier with no trustworthy clock must not silently
    # get a different verdict than the one openrappter would produce.
    out = json.loads(gv.GoogleVoiceAgent().perform(action="decide", message=msg, state=seen))
    eq("refuses to decide without an explicit `now`", out["status"], "error")
    out = json.loads(gv.GoogleVoiceAgent().perform(action="decide", message=msg, state=seen, now=fx["now"]))
    eq("decides when given one", out["verdict"]["act"], True)

    # ── Article VII, read off the syntax tree ────────────────────────────────────
    print("\n  article VII portability")
    with open(AGENT) as fh:
        tree = ast.parse(fh.read())

    ALLOWED = {"json", "hashlib", "datetime", "uuid", "agents.basic_agent", "agents"}
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                imported.add(a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
    bad = {m for m in imported if m not in ALLOWED and m.split(".")[0] not in ALLOWED}
    check("imports nothing outside the portable set", not bad, "found: %s" % sorted(bad))

    banned = {"subprocess", "requests", "urllib", "socket", "os", "sys", "http", "asyncio", "time"}
    check("no tier-breaking module is imported", not (imported & banned), "found: %s" % sorted(imported & banned))

    # A clock read would make the verdict unreproducible and silently break parity.
    #
    # The first version of this check only matched `datetime.now()` — an Attribute
    # whose value is a Name. It therefore MISSED `datetime.datetime.now()`, where the
    # value is itself an Attribute, and a deliberate divergence sailed through with
    # 25/25 green. Match the attribute NAME anywhere in the tree instead of trying to
    # predict the shape of the expression around it.
    CLOCK_ATTRS = {"now", "utcnow", "today", "monotonic", "perf_counter", "time_ns"}
    clocks = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr in CLOCK_ATTRS:
            clocks.append(node.attr)
        # bare `time()` after `from time import time`
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "time":
            clocks.append("time()")
    check("never reads a clock — `now` is always a parameter", not clocks, "found: %s" % sorted(set(clocks)))

    print("\n  %d passed, %d failed\n" % (PASS, FAIL))

    return FAIL


def test_google_voice_parity():
    """pytest entry point — the same checks, as one assertion."""
    failed = main()
    assert failed == 0, "%d google-voice parity/portability checks failed" % failed


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
