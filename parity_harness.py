#!/usr/bin/env python3
"""Run the `rapp-runtime-parity/1.0` golden vectors against a runtime.

PARITY §5 and §6 both mark the corpus and this harness **PLANNED** — neither is
committed anywhere in the estate, and `rapp_brainstem/parity_vectors/` and its
`rapp-map` mirror are 404. openrappter declares parity tier `core` in SPEC.md,
so until something executes the vectors that declaration is an assertion about
ourselves that nobody, including us, can check.

This is a *candidate* implementation. The vectors in `parity_vectors/` are
written to the published schema and carry nothing openrappter-specific, so they
can be offered upstream unchanged; the harness is ours.

    python3 parity_harness.py --tier core
    python3 parity_harness.py --tier full --report report.json

§5.2 requires the model to be mocked with a scripted responder, because the
model is an out-of-scope axis (§3) and parity governs the loop, the envelope and
the ABI — not which model answered or whether it chose to call a tool. The
script is injected at the runtime's model-call seam. For the Python runtime that
seam is `brainstem.llm_chat`, so the harness runs the server in-process and
patches it there: the runtime executes its real end-to-end loop over real HTTP,
and only the model *data* is scripted.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import re
import sys
import threading
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VECTOR_DIR = ROOT / "parity_vectors"
sys.path.insert(0, str(ROOT / "python"))

SPEC = "rapp-runtime-parity/1.0"
UUID4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I
)

# §6.1: comparison is exact on in-scope keys. These are explicitly out of scope.
OUT_OF_SCOPE = {"model", "requested_model"}


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def corpus_sha256(vectors) -> str:
    lines = "\n".join(
        f"{v['name']} {hashlib.sha256(canonical(v)).hexdigest()}"
        for v in sorted(vectors, key=lambda v: v["name"])
    )
    return hashlib.sha256(lines.encode()).hexdigest()


# ── The scripted model ───────────────────────────────────────────────────────


class ScriptedModel:
    """Stands in for the model at the runtime's model-call seam.

    Records every outbound `messages` array so a vector can assert on what the
    runtime *sent* — which is the only way to check history filtering (§5.3.10)
    and system-context injection (§5.3.11).
    """

    def __init__(self, script):
        self.script = list(script)
        self.round = 0
        self.outbound = []
        self.tools_seen = []

    def __call__(self, messages, tools):
        self.round += 1
        self.outbound.append(json.loads(json.dumps(messages)))
        self.tools_seen.append(tools)
        for step in self.script:
            if step.get("round") == self.round:
                emit = dict(step.get("emit") or {})
                reply = {"role": "assistant", "content": emit.get("content")}
                if "tool_calls" in emit:
                    reply["tool_calls"] = emit["tool_calls"]
                if "finish_reason" in emit:
                    reply["finish_reason"] = emit["finish_reason"]
                return reply, "scripted-model/1.0"
        # Running off the end of the script is a real finding, not a crash: it
        # means the runtime looped more times than the vector allows for.
        return {"role": "assistant", "content": f"__UNSCRIPTED_ROUND_{self.round}__"}, "scripted-model/1.0"


def build_agents(fixture):
    """Turn the vector's declarative agents into objects the runtime can call."""
    agents = {}
    for spec in fixture.get("agents", []):
        agents[spec["name"]] = _DeterministicAgent(spec)
    return agents


class _DeterministicAgent:
    def __init__(self, spec):
        self.name = spec["name"]
        self.metadata = spec["metadata"]
        self._perform = spec.get("perform") or {}
        ctx = spec.get("system_context")
        if ctx is not None:
            self.system_context = lambda: ctx

    def perform(self, **kwargs):
        kind = self._perform.get("kind")
        if kind == "raises":
            raise RuntimeError(self._perform.get("message", "error"))
        template = self._perform.get("returns", "")
        values = dict(kwargs)
        if "{sum}" in template:
            try:
                values["sum"] = int(kwargs.get("a", 0)) + int(kwargs.get("b", 0))
            except (TypeError, ValueError):
                values["sum"] = ""
        out = template
        for key, value in values.items():
            out = out.replace("{" + str(key) + "}", str(value))
        # Unfilled placeholders mean the argument was absent — the
        # bad-arguments vector depends on this degrading rather than raising.
        return re.sub(r"\{[a-zA-Z_]+\}", "", out)


# ── Running one vector ───────────────────────────────────────────────────────


@contextlib.contextmanager
def runtime_under_test(vector, brainstem):
    """Stand the fixture into the runtime and serve it over real HTTP."""
    fixture = vector.get("fixture") or {}
    model = ScriptedModel(vector.get("model_script") or [])

    saved = {
        "llm_chat": brainstem.llm_chat,
        "load_agents": brainstem.load_agents,
        "load_soul": brainstem.load_soul,
    }
    brainstem.llm_chat = model
    agents = build_agents(fixture)
    brainstem.load_agents = lambda: agents
    brainstem.load_soul = lambda: fixture.get("soul", "")

    server = ThreadingHTTPServer(("127.0.0.1", 0), brainstem.BrainstemHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", model
    finally:
        server.shutdown()
        server.server_close()
        for name, value in saved.items():
            setattr(brainstem, name, value)


def post_chat(base, payload):
    body = json.dumps(payload).encode()
    request = urllib.request.Request(
        base + "/chat", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        raw = error.read() or b"{}"
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, {"_raw": raw.decode("utf-8", "replace")}


def matches(expected, actual):
    """Exact comparison, with an explicit `$match` escape for minted values."""
    if isinstance(expected, dict) and "$match" in expected:
        if expected["$match"] == "uuid4":
            return isinstance(actual, str) and bool(UUID4.match(actual))
        return False
    return expected == actual


def check(vector, base, model):
    """Return a list of failure strings. Empty means the vector passed."""
    request = dict(vector.get("request") or {})
    expect = vector.get("expect") or {}
    failures = []

    payload = {"user_input": request.get("user_input", "")}
    if "session_id" in request:
        payload["session_id"] = request["session_id"]
    if request.get("conversation_history") is not None:
        payload["conversation_history"] = request["conversation_history"]

    status, body = post_chat(base, payload)

    if "status" in expect and status != expect["status"]:
        failures.append(f"status: expected {expect['status']}, got {status}")

    if "body" in expect:
        for key, want in expect["body"].items():
            if not matches(want, body.get(key)):
                failures.append(f"body.{key}: expected {want!r}, got {body.get(key)!r}")

    if expect.get("model_called") is False and model.round != 0:
        failures.append(f"model was called {model.round}x; vector expects no call")

    if "rounds" in expect and model.round != expect["rounds"]:
        failures.append(f"rounds: expected {expect['rounds']}, got {model.round}")

    if "tools_argument" in expect and model.tools_seen:
        got = model.tools_seen[0]
        want = expect["tools_argument"]
        if want is None and got:
            failures.append(f"tools: expected null/empty, got {len(got)} tool(s)")

    for key in expect.get("envelope_required_keys", []):
        if key not in body:
            failures.append(f"envelope missing required key {key!r}")
    if "assistant_response" in body:
        failures.append("envelope carries assistant_response (KERNEL §2.2 forbids it)")

    for key, want in (expect.get("envelope") or {}).items():
        if key in OUT_OF_SCOPE:
            continue
        if not matches(want, body.get(key)):
            failures.append(f"envelope.{key}: expected {want!r}, got {body.get(key)!r}")

    if "tool_call_sequence" in expect:
        called = []
        for messages in model.outbound:
            for message in messages:
                if message.get("role") == "tool":
                    called.append(message.get("_name"))
        # The runtime does not label tool messages with the agent name, so the
        # sequence is read from what the script emitted and the logs recorded.
        logged = [
            line.split("]")[0].lstrip("[")
            for line in (body.get("agent_logs") or "").split("\n")
            if line.startswith("[")
        ]
        if logged != expect["tool_call_sequence"]:
            failures.append(
                f"tool_call_sequence: expected {expect['tool_call_sequence']}, got {logged}"
            )

    if "tool_messages_appended" in expect:
        appended = [
            message
            for messages in model.outbound
            for message in messages
            if message.get("role") == "tool"
        ]
        # De-duplicate: each round resends the whole transcript.
        unique = {json.dumps(m, sort_keys=True) for m in appended}
        if len(unique) != expect["tool_messages_appended"]:
            failures.append(
                f"tool messages: expected {expect['tool_messages_appended']}, got {len(unique)}"
            )
        # §2.3 fixes the tool result message shape exactly.
        for message in appended:
            missing = [k for k in ("tool_call_id", "role", "name", "content") if k not in message]
            if missing:
                failures.append(f"tool message missing {missing} (§2.3 shape)")
                break

    if "outbound_history_roles" in expect and model.outbound:
        first = model.outbound[0]
        roles = [m.get("role") for m in first[1:-1]]
        if roles != expect["outbound_history_roles"]:
            failures.append(
                f"outbound history roles: expected {expect['outbound_history_roles']}, got {roles}"
            )

    for needle in expect.get("outbound_must_not_contain", []):
        if any(needle in json.dumps(messages) for messages in model.outbound):
            failures.append(f"outbound carried {needle!r}, which should have been filtered")

    if "outbound_system_prompt_contains" in expect:
        needle = expect["outbound_system_prompt_contains"]
        system = model.outbound[0][0].get("content", "") if model.outbound else ""
        if needle not in system:
            failures.append(f"system prompt missing {needle!r}")

    if expect.get("session_id_stable_for_turn") and body.get("session_id"):
        if body.get("sessionId") and body["sessionId"] != body["session_id"]:
            failures.append("session_id and sessionId disagree within one turn")

    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vectors", type=Path, default=VECTOR_DIR)
    parser.add_argument("--tier", choices=["core", "full", "edge"], default="core")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    import openrappter.brainstem as brainstem  # noqa: E402

    vectors = []
    for path in sorted(args.vectors.glob("*.json")):
        if path.name == "CORPUS.json":
            continue
        vectors.append(json.loads(path.read_text(encoding="utf-8")))

    if args.tier == "core":
        selected = [v for v in vectors if v["tags"].get("core")]
    elif args.tier == "edge":
        selected = [v for v in vectors if v["tags"].get("edge")]
    else:
        selected = vectors

    results = []
    for vector in selected:
        try:
            with runtime_under_test(vector, brainstem) as (base, model):
                failures = check(vector, base, model)
        except Exception as error:  # noqa: BLE001
            failures = [f"harness error: {type(error).__name__}: {error}"]
        results.append({
            "vector": vector["name"],
            "pass": not failures,
            "diff": failures or None,
        })

    passed = sum(1 for r in results if r["pass"])
    report = {
        "spec": SPEC,
        "runtime": "python/openrappter/brainstem.py",
        "declared_tier": "core",
        "corpus_sha256": corpus_sha256(vectors),
        "utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "summary": {
            "total": len(results),
            "passed": passed,
            "failed": len(results) - passed,
            "tier_satisfied": passed == len(results),
        },
        "results": results,
    }

    for result in results:
        mark = "PASS" if result["pass"] else "FAIL"
        print(f"  {mark}  {result['vector']}")
        for line in result["diff"] or []:
            print(f"          {line}")
    summary = report["summary"]
    print(f"\n{summary['passed']}/{summary['total']} passed "
          f"(tier={args.tier}, corpus={report['corpus_sha256'][:12]})")

    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    return 0 if summary["tier_satisfied"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
