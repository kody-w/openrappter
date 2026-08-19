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
import subprocess
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
SPEC_MD = ROOT / "SPEC.md"
TS_DRIVER = ROOT / "ts_parity_driver.mjs"
TS_BUILD = ROOT / "typescript/dist/agents/Assistant.js"
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


# ── One observation shape, however the runtime was driven ────────────────────


class Observation:
    """What a runtime did with one vector, in a runtime-neutral shape."""

    __slots__ = ("status", "body", "rounds", "outbound", "tools_first_call")

    def __init__(self, status, body, rounds=0, outbound=None, tools_first_call=None):
        self.status = status
        self.body = body or {}
        self.rounds = rounds
        self.outbound = outbound or []
        self.tools_first_call = tools_first_call


def observe_python(vector, brainstem):
    """Drive the Python runtime over real HTTP with a scripted model."""
    with runtime_under_test(vector, brainstem) as (base, model):
        # Send the vector's request body as written.
        #
        # This used to rebuild the payload from three whitelisted keys, so any
        # other field a vector declared was dropped before it reached the
        # runtime -- silently. A vector could therefore name a field, look like
        # it tested it, and test nothing: `{"user_input":"A","message":"B"}`
        # arrived as `{"user_input":"A"}` and passed on a runtime that reads
        # `message` in preference to `user_input`.
        #
        # `ts_parity_driver.mjs` had the same defect and was fixed for the same
        # reason: "a driver that reimplements the thing under test can only ever
        # confirm itself". That fix did not travel to this half of the harness.
        payload = dict(vector.get("request") or {})
        status, body = post_chat(base, payload)
        return Observation(
            status=status,
            body=body,
            rounds=model.round,
            outbound=model.outbound,
            tools_first_call=model.tools_seen[0] if model.tools_seen else None,
        )


def observe_typescript(vector, driver=TS_DRIVER):
    """Drive the TypeScript runtime through `ts_parity_driver.mjs`.

    That driver injects the scripted responder at `Assistant.provider.chat()`,
    this runtime's model-call seam, and builds the reply with the real
    `buildChatEnvelope`. It is NOT driven over HTTP — see `--help` for what that
    does and does not prove.
    """
    result = subprocess.run(
        ["node", str(driver)],
        input=json.dumps(vector),
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(ROOT),
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"typescript driver exited {result.returncode}: "
            f"{(result.stderr or '').strip()[:400]}"
        )
    payload = json.loads(result.stdout or "{}")
    status = payload.pop("__status", 200)
    rounds = payload.pop("__rounds", 0)
    outbound = payload.pop("__outbound", [])
    tools_first = payload.pop("__toolsFirstCall", None)
    payload.pop("__modelCalled", None)
    error = payload.pop("__error", None)
    body = payload.get("body") if "body" in payload else payload
    if error:
        body = dict(body or {})
        body["_driver_error"] = error
    return Observation(status, body, rounds, outbound, tools_first)


def default_outbound_user_input(vector):
    """The text the model must receive when the vector does not say otherwise.

    `user_input` is the spec key and wins over the `message` alias, matching
    both runtimes (#335). Returned trimmed, because both runtimes trim before
    dispatching. `None` means "do not check": the vector sends no usable input,
    so the model is not expected to be called at all.
    """
    request = vector.get("request") or {}
    if not isinstance(request, dict):
        return None
    raw = request.get("user_input")
    if raw is None:
        raw = request.get("message")
    if not isinstance(raw, str) or not raw.strip():
        return None
    return raw.strip()


def check(vector, obs):
    """Judge one observation against one vector.

    Takes an already-executed `Observation` rather than driving the runtime
    itself, so every runtime is judged by exactly this code. Two drivers, one
    comparator — otherwise a difference in the checker could be mistaken for a
    difference in the runtimes, which is the very thing being measured.
    """
    expect = vector.get("expect") or {}
    failures = []

    status, body = obs.status, obs.body

    if "status" in expect and status != expect["status"]:
        failures.append(f"status: expected {expect['status']}, got {status}")

    if "body" in expect:
        for key, want in expect["body"].items():
            if not matches(want, body.get(key)):
                failures.append(f"body.{key}: expected {want!r}, got {body.get(key)!r}")

    if expect.get("model_called") is False and obs.rounds != 0:
        failures.append(f"model was called {obs.rounds}x; vector expects no call")

    if "rounds" in expect and obs.rounds != expect["rounds"]:
        failures.append(f"rounds: expected {expect['rounds']}, got {obs.rounds}")

    if "tools_argument" in expect and obs.tools_first_call is not None:
        got = obs.tools_first_call
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
        for messages in obs.outbound:
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
            for messages in obs.outbound
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

    if "outbound_history_roles" in expect and obs.outbound:
        first = obs.outbound[0]
        roles = [m.get("role") for m in first[1:-1]]
        if roles != expect["outbound_history_roles"]:
            failures.append(
                f"outbound history roles: expected {expect['outbound_history_roles']}, got {roles}"
            )

    for needle in expect.get("outbound_must_not_contain", []):
        if any(needle in json.dumps(messages) for messages in obs.outbound):
            failures.append(f"outbound carried {needle!r}, which should have been filtered")

    # What the model was actually asked. The corpus could assert the reply, the
    # history roles and the system prompt, but never the user turn -- so a
    # runtime that resolved the wrong request field sent the model different
    # text and still passed every vector. That is not hypothetical: python read
    # `message` in preference to `user_input`, so `{"user_input":"A",
    # "message":"B"}` answered B while typescript and the grail answered A,
    # both with a 200.
    #
    # This is checked on EVERY vector that reaches the model, not only the one
    # that opts in. When only the alias vector asserted it, the corpus could
    # still not see a runtime that mangled the input just for requests carrying
    # history, or on a later tool round -- conditions that vector does not
    # create. #250 asked for exactly this assertion; one instance of it was not
    # the same as having it.
    expected_outbound = expect.get("outbound_user_input")
    if expected_outbound is None:
        expected_outbound = default_outbound_user_input(vector)
    if expected_outbound is not None and obs.outbound and obs.outbound[0]:
        sent = obs.outbound[0][-1].get("content")
        if sent != expected_outbound:
            failures.append(
                f"outbound user input: expected {expected_outbound!r}, got {sent!r}"
            )

    if "outbound_system_prompt_contains" in expect:
        needle = expect["outbound_system_prompt_contains"]
        system = obs.outbound[0][0].get("content", "") if obs.outbound else ""
        if needle not in system:
            failures.append(f"system prompt missing {needle!r}")

    if expect.get("session_id_stable_for_turn") and body.get("session_id"):
        if body.get("sessionId") and body["sessionId"] != body["session_id"]:
            failures.append("session_id and sessionId disagree within one turn")

    return failures


DECLARED_TIER_RE = re.compile(r"^##\s*\d+\.\s*Declared parity tier:\s*`([a-z]+)`", re.M)


def declared_tier(spec_path=SPEC_MD):
    """Read the tier openrappter declares, from SPEC.md.

    Never defaulted and never hardcoded. A hardcoded tier lets the claim and
    the test drift apart silently — the document could be edited to say `full`
    while CI went on proving `core`, and the badge would stay green. If the
    declaration cannot be read, that is a failure to report, not a value to
    guess.
    """
    try:
        text = Path(spec_path).read_text(encoding="utf-8")
    except OSError as error:
        raise SystemExit(f"cannot read the declared tier from {spec_path}: {error}")
    match = DECLARED_TIER_RE.search(text)
    if not match:
        raise SystemExit(
            f"{spec_path} does not declare a parity tier in the expected form "
            "('## 1. Declared parity tier: `core`'). Refusing to guess."
        )
    tier = match.group(1)
    if tier not in ("core", "full", "edge"):
        raise SystemExit(f"{spec_path} declares unknown parity tier {tier!r}")
    return tier


def select(vectors, tier):
    if tier == "core":
        return [v for v in vectors if v["tags"].get("core")]
    if tier == "edge":
        return [v for v in vectors if v["tags"].get("edge")]
    return list(vectors)


def needs_live_model(vector):
    """A vector the harness cannot execute without a real model.

    PARITY §5.2 mandates `model.kind = "scripted"` for the whole corpus, so
    today this is empty — and that is a fact worth stating rather than a
    category worth pretending is populated. It exists so that if a vector is
    ever added that genuinely needs a model, it is reported as NOT EXECUTED
    instead of quietly vanishing from the denominator.
    """
    return ((vector.get("fixture") or {}).get("model") or {}).get("kind") != "scripted"


def run_runtime(name, vectors, brainstem_module):
    """Execute the selected vectors against one runtime."""
    results = []
    for vector in vectors:
        if needs_live_model(vector):
            results.append({
                "vector": vector["name"],
                "status": "not_executed",
                "reason": "needs a live model; CI runs no model",
                "diff": None,
            })
            continue
        try:
            if name == "python":
                obs = observe_python(vector, brainstem_module)
            else:
                obs = observe_typescript(vector)
            failures = check(vector, obs)
        except Exception as error:  # noqa: BLE001
            failures = [f"harness error: {type(error).__name__}: {error}"]
        results.append({
            "vector": vector["name"],
            "status": "passed" if not failures else "failed",
            "diff": failures or None,
        })
    return results


RUNTIME_PATHS = {
    "python": "python/openrappter/brainstem.py",
    "typescript": "typescript/src/agents/Assistant.ts + gateway/chat-envelope.ts",
}


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--vectors", type=Path, default=VECTOR_DIR)
    parser.add_argument(
        "--tier", choices=["core", "full", "edge"],
        help="override the tier declared in SPEC.md (default: whatever it declares)",
    )
    parser.add_argument(
        "--runtime", choices=["python", "typescript", "both"], default="python",
        help="which runtime to measure. 'both' is what parity actually means.",
    )
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    tier = args.tier or declared_tier()
    tier_source = "--tier" if args.tier else f"declared in {SPEC_MD.name}"

    vectors = []
    for path in sorted(args.vectors.glob("*.json")):
        if path.name == "CORPUS.json":
            continue
        vectors.append(json.loads(path.read_text(encoding="utf-8")))
    selected = select(vectors, tier)

    runtimes = ["python", "typescript"] if args.runtime == "both" else [args.runtime]

    brainstem = None
    if "python" in runtimes:
        import openrappter.brainstem as brainstem  # noqa: E402
    if "typescript" in runtimes and not TS_BUILD.exists():
        raise SystemExit(
            f"the TypeScript runtime is not built ({TS_BUILD} is missing).\n"
            "Run: cd typescript && npm ci && npm run build"
        )

    per_runtime = {}
    for name in runtimes:
        per_runtime[name] = run_runtime(name, selected, brainstem)

    def tally(results):
        passed = sum(1 for r in results if r["status"] == "passed")
        failed = sum(1 for r in results if r["status"] == "failed")
        skipped = sum(1 for r in results if r["status"] == "not_executed")
        return {
            "total": len(results),
            "passed": passed,
            "failed": failed,
            # Reported separately, never folded into `passed`. Silent skipping
            # is exactly the failure this corpus exists to prevent.
            "not_executed": skipped,
            "tier_satisfied": failed == 0 and skipped == 0 and passed == len(results),
        }

    report = {
        "spec": SPEC,
        "declared_tier": tier,
        "tier_source": tier_source,
        "corpus_sha256": corpus_sha256(vectors),
        "corpus_vectors": len(vectors),
        "utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "runtimes": {
            name: {
                "path": RUNTIME_PATHS[name],
                "summary": tally(results),
                "results": results,
            }
            for name, results in per_runtime.items()
        },
    }
    report["summary"] = {
        "tier_satisfied": all(
            report["runtimes"][n]["summary"]["tier_satisfied"] for n in runtimes
        ),
        "runtimes_measured": runtimes,
    }

    mark = {"passed": "PASS", "failed": "FAIL", "not_executed": "NOT RUN"}
    for name in runtimes:
        block = report["runtimes"][name]
        print(f"\n── {name} ── {block['path']}")
        for result in block["results"]:
            print(f"  {mark[result['status']]:>7}  {result['vector']}")
            for line in result["diff"] or []:
                print(f"           {line}")
        s = block["summary"]
        print(f"  {s['passed']}/{s['total']} passed, {s['failed']} failed, "
              f"{s['not_executed']} not executed")

    total_classes = len(vectors)
    proven = {
        n: report["runtimes"][n]["summary"]["passed"] for n in runtimes
    }
    print(f"\ntier {tier} ({tier_source}) · corpus {report['corpus_sha256'][:12]} "
          f"· {len(selected)}/{total_classes} classes in tier")
    for name in runtimes:
        print(f"  {name}: CI proves {proven[name]} of the {total_classes} "
              f"required classes")
    print("PASS" if report["summary"]["tier_satisfied"] else "FAIL")

    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    return 0 if report["summary"]["tier_satisfied"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
