#!/usr/bin/env python3
"""Rappter Pack Sentinel — watches mixed Brainstem/OpenRappter matrix evidence.

The controller runs tasks. This sentinel remains read-only and judges only the
report the controller actually produced: nodes reached, output still moving,
and every expected-vs-observed case accounted for.
"""

__manifest__ = {
    "schema": "rapp-sentinel/1.0",
    "name": "@openrappter/rappter_pack_sentinel",
    "version": "1.0.0",
    "description": "Refuses to call a mixed-machine Rappter Pack healthy when nodes are unreachable, matrix evidence is stale, or expected outcomes are missing or failing.",
    "category": "consistency",
    "checks": {
        "pack_nodes_reachable": {"domain": "rappter-pack", "kind": "reachability"},
        "pack_matrix_moving": {"domain": "rappter-pack", "kind": "output-freshness"},
        "pack_matrix_expected": {"domain": "rappter-pack", "kind": "consistency"},
    },
    "config": {
        "report_file": "~/.openrappter/desktop/pack/latest.json",
        "max_age_minutes": 90,
        "max_unchanged_minutes": 90,
        "state_file": "rappter_pack_seen.json",
    },
    "requires": [],
    "tags": ["openrappter", "brainstem", "pack", "matrix", "R1", "R2", "R3"],
    "author": "kody-w",
    "license": "Apache-2.0",
    "vantage": "outsider",
}


def run(config=None, ctx=None):
    cfg = dict(__manifest__["config"], **(config or {}))
    c = _ctx(ctx)
    try:
        report = c["read_json"](cfg["report_file"])
    except Exception as error:
        detail = "cannot read pack report (%s: %s)" % (
            type(error).__name__, str(error)[:120])
        return [
            c["fail"]("pack_nodes_reachable", detail, critical=False),
            c["fail"]("pack_matrix_moving", detail, critical=False),
            c["fail"]("pack_matrix_expected", detail, critical=False),
        ]

    results = []
    nodes = report.get("nodes") if isinstance(report, dict) else None
    cases = report.get("cases") if isinstance(report, dict) else None
    wire = report.get("wire") if isinstance(report, dict) else None
    node_map = {
        node.get("id"): node for node in nodes or []
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    }

    if not isinstance(nodes, list) or not nodes:
        results.append(c["fail"](
            "pack_nodes_reachable", "report declares no pack nodes"))
    else:
        reached = set()
        if isinstance(cases, list):
            for case in cases:
                for result in case.get("results") or []:
                    if (
                        result.get("transport_ok") is True
                        and result.get("refused") is False
                    ):
                        reached.add(result.get("node_id"))
        missing = sorted(
            str(node.get("id")) for node in nodes
            if node.get("id") not in reached)
        if missing:
            results.append(c["fail"](
                "pack_nodes_reachable",
                "no successful transport evidence for " + ", ".join(missing)))
        else:
            results.append(c["ok"](
                "pack_nodes_reachable",
                "%d mixed node(s) reached" % len(nodes)))

    age = c["minutes_since"](report.get("created_at"))
    digest = report.get("output_digest")
    recomputed_digest = _output_digest(report) if isinstance(cases, list) else None
    seen = c["state_read"](cfg["state_file"]) or {}
    if age is None:
        results.append(c["fail"](
            "pack_matrix_moving", "report has no readable created_at"))
    elif age >= float(cfg.get("max_age_minutes", 90)):
        results.append(c["fail"](
            "pack_matrix_moving",
            "matrix report stale %.1fm (bar %sm)" % (
                age, cfg.get("max_age_minutes", 90))))
    elif not isinstance(digest, str) or digest != recomputed_digest:
        results.append(c["fail"](
            "pack_matrix_moving",
            "report output_digest does not describe actual node outputs"))
    elif seen.get("digest") == digest:
        unchanged = c["minutes_since"](seen.get("first_seen_at"))
        if (
            unchanged is not None
            and unchanged >= float(cfg.get("max_unchanged_minutes", 90))
        ):
            results.append(c["fail"](
                "pack_matrix_moving",
                "actual matrix output unchanged %.1fm (bar %sm)" % (
                    unchanged, cfg.get("max_unchanged_minutes", 90))))
        else:
            results.append(c["ok"](
                "pack_matrix_moving",
                "output unchanged only %.1fm" % (unchanged or 0)))
    else:
        c["state_write"](cfg["state_file"], {
            "digest": digest,
            "first_seen_at": c["now_iso"](),
        })
        results.append(c["ok"](
            "pack_matrix_moving", "new output digest observed"))

    if (
        not isinstance(report.get("pack_id"), str)
        or not report.get("pack_id")
        or not isinstance(report.get("matrix"), str)
        or not report.get("matrix")
    ):
        results.append(c["fail"](
            "pack_matrix_expected",
            "report does not name its pack and matrix authority"))
    elif wire != {
        "method": "POST",
        "path": "/chat",
        "adapter": "legacy-success-envelope-to-rapp1",
        "upstream_contract": "normalized",
        "neighborhood_protocol": "not-claimed",
    }:
        results.append(c["fail"](
            "pack_matrix_expected",
            "report does not declare the /chat normalization adapter honestly"))
    elif not isinstance(cases, list) or not cases:
        results.append(c["fail"](
            "pack_matrix_expected", "report carries no matrix cases"))
    else:
        incomplete = []
        failed = []
        for case in cases:
            case_id = str(case.get("id") or "unnamed")
            if not isinstance(case.get("expected"), dict) or not isinstance(
                    case.get("observed"), dict):
                incomplete.append(case_id)
            elif not _case_satisfies(case, node_map):
                failed.append(case_id)
        if incomplete:
            results.append(c["fail"](
                "pack_matrix_expected",
                "cases missing expected-vs-observed evidence: "
                + ", ".join(incomplete)))
        elif failed:
            results.append(c["fail"](
                "pack_matrix_expected",
                "acceptance failed: " + ", ".join(failed)))
        else:
            results.append(c["ok"](
                "pack_matrix_expected",
                "%d/%d expected outcomes satisfied" % (
                    len(cases), len(cases))))
    return results


def prove():
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    iso = lambda value: value.isoformat().replace("+00:00", "Z")

    state = {}

    def report(created_at=None, transport_ok=True, response="OK"):
        value = {
            "schema": "rappter-pack-report/1.0",
            "pack_id": "prove-pack",
            "matrix": "prove-matrix",
            "created_at": created_at or iso(now),
            "wire": {
                "method": "POST",
                "path": "/chat",
                "adapter": "legacy-success-envelope-to-rapp1",
                "upstream_contract": "normalized",
                "neighborhood_protocol": "not-claimed",
            },
            "nodes": [
                {
                    "id": "brainstem-one",
                    "machine": "mini-one",
                    "kind": "brainstem",
                    "capabilities": ["chat"],
                    "transport": "local",
                },
                {
                    "id": "openrappter-two",
                    "machine": "mini-two",
                    "kind": "openrappter",
                    "capabilities": ["chat"],
                    "transport": "local",
                },
            ],
            "cases": [{
                "id": "mixed",
                "action": "chat",
                "mode": "all",
                "candidates": ["brainstem-one", "openrappter-two"],
                "prompt": "Return OK.",
                "handoff_prompt": None,
                "reverse_candidates": False,
                "expected": {
                    "contains": ["OK"],
                    "excludes": [],
                    "required_envelope_fields": [],
                    "max_duration_ms": 1000,
                    "min_passing": 2,
                },
                "observed": {
                    "passing": 2 if transport_ok else 1,
                    "failing": 0 if transport_ok else 1,
                    "transport_failures": 0 if transport_ok else 1,
                    "cancelled_after_winner": 0,
                    "completion_order": [
                        "brainstem-one", "openrappter-two"],
                },
                "pass": True,
                "results": [
                    {
                        "node_id": "brainstem-one",
                        "machine": "mini-one",
                        "kind": "brainstem",
                        "transport": "local",
                        "transport_ok": True,
                        "response": response,
                        "duration_ms": 10,
                        "http_status": 200,
                        "refused": False,
                        "accepted": response == "OK",
                        "differences": [] if response == "OK"
                        else ["missing expected text OK"],
                        "evidence": [],
                        "envelope": {
                            "response": response,
                            "agent_logs": [],
                            "session_id": "brainstem-session",
                        },
                        "outcome": "accepted",
                        "settled_order": 1,
                    },
                    {
                        "node_id": "openrappter-two",
                        "machine": "mini-two",
                        "kind": "openrappter",
                        "transport": "local",
                        "transport_ok": transport_ok,
                        "response": response,
                        "duration_ms": 12,
                        "http_status": 200 if transport_ok else None,
                        "refused": False,
                        "accepted": transport_ok and response == "OK",
                        "differences": []
                        if transport_ok and response == "OK"
                        else ["transport or expected response failed"],
                        "evidence": [],
                        "envelope": {
                            "response": response,
                            "agent_logs": [],
                            "session_id": "openrappter-session",
                        },
                        "outcome": "accepted" if transport_ok else "failed",
                        "settled_order": 2,
                    },
                ],
            }],
        }
        value["output_digest"] = _output_digest(value)
        return value

    ctx = {
        "read_json": lambda _: report(),
        "state_read": lambda name: state.get(name),
        "state_write": lambda name, value: state.__setitem__(name, value),
        "now_iso": lambda: iso(now),
    }

    healthy = run(ctx=ctx)
    assert all(item["ok"] for item in healthy), healthy

    from copy import deepcopy
    mutations = [
        lambda value: value["cases"][0]["results"][0].__setitem__(
            "duration_ms", 2000),
        lambda value: value["cases"][0].__setitem__("expected", {}),
        lambda value: value["cases"][0].__setitem__("mode", "race"),
        lambda value: value["cases"][0]["results"][0].__setitem__(
            "refused", True),
        lambda value: value["cases"][0]["results"][0].__setitem__(
            "http_status", 503),
        lambda value: value["cases"][0]["results"][0].__setitem__(
            "envelope", {
                **value["cases"][0]["results"][0]["envelope"],
                "session_id": "mutated-session",
            }),
        lambda value: value["cases"][0]["observed"].__setitem__(
            "passing", 0),
        lambda value: value["cases"][0]["results"][0].__setitem__(
            "outcome", "failed"),
        lambda value: value["cases"][0]["results"][0].__setitem__(
            "settled_order", 99),
        lambda value: value["cases"][0].__setitem__("pass", False),
    ]
    for mutate in mutations:
        changed = deepcopy(report())
        mutate(changed)
        detected = run(ctx={
            **ctx,
            "read_json": lambda _, value=changed: value,
            "state_read": lambda _: None,
        })
        assert not _by_id(
            detected, "pack_matrix_moving")["ok"], detected

    for mutate in [
        lambda value: value["cases"][0]["results"][0].__setitem__(
            "accepted", False),
        lambda value: value["cases"][0].__setitem__("pass", False),
        lambda value: value["cases"][0]["observed"].__setitem__(
            "passing", 0),
        lambda value: value["cases"][0]["results"][0].update({
            "http_status": 405,
            "accepted": False,
            "differences": ["/chat returned HTTP 405"],
        }),
        lambda value: value["cases"][0]["results"][0].update({
            "http_status": 201,
            "accepted": False,
            "differences": ["/chat returned HTTP 201"],
        }),
    ]:
        changed = deepcopy(report())
        mutate(changed)
        changed["output_digest"] = _output_digest(changed)
        detected = run(ctx={
            **ctx,
            "read_json": lambda _, value=changed: value,
            "state_read": lambda _: None,
        })
        assert not _by_id(
            detected, "pack_matrix_expected")["ok"], detected

    unreachable = run(ctx={
        **ctx,
        "read_json": lambda _: report(transport_ok=False),
    })
    assert not _by_id(unreachable, "pack_nodes_reachable")["ok"], unreachable

    stale = run(ctx={
        **ctx,
        "read_json": lambda _: report(iso(now - timedelta(hours=3))),
    })
    assert not _by_id(stale, "pack_matrix_moving")["ok"], stale

    failed = run(ctx={
        **ctx,
        "read_json": lambda _: report(response="WRONG"),
    })
    assert not _by_id(failed, "pack_matrix_expected")["ok"], failed

    assert not _relay_intermediate_satisfies({
        "transport_ok": True,
        "refused": False,
        "http_status": 200,
        "duration_ms": 10,
        "envelope": {
            "response": "handoff",
            "agent_logs": [42],
            "session_id": "",
        },
    }, {
        "required_envelope_fields": [
            "response", "agent_logs", "session_id"],
        "max_duration_ms": 1000,
    })
    assert not _relay_intermediate_satisfies({
        "transport_ok": True,
        "refused": False,
        "http_status": 201,
        "duration_ms": 10,
        "envelope": {
            "response": "handoff",
            "agent_logs": [],
            "session_id": "session",
        },
    }, {
        "required_envelope_fields": [
            "response", "agent_logs", "session_id"],
        "max_duration_ms": 1000,
    })
    for invalid_status in (None, "200"):
        invalid_result = {
            "transport_ok": True,
            "refused": False,
            "duration_ms": 10,
            "envelope": {
                "response": "OK",
                "agent_logs": [],
                "session_id": "session",
            },
        }
        if invalid_status is not None:
            invalid_result["http_status"] = invalid_status
        expected = {
            "contains": ["OK"],
            "excludes": [],
            "required_envelope_fields": [
                "response", "agent_logs", "session_id"],
            "max_duration_ms": 1000,
            "min_passing": 1,
        }
        assert not _result_satisfies(invalid_result, expected)
        assert not _relay_intermediate_satisfies(
            invalid_result, expected)

    # A producer cannot keep a frozen output green by refreshing created_at.
    state.clear()
    run(ctx=ctx)
    frozen = run(
        {"max_unchanged_minutes": 0},
        {
            **ctx,
            "read_json": lambda _: report(created_at=iso(now)),
            "minutes_since": lambda _: 1,
        },
    )
    assert not _by_id(frozen, "pack_matrix_moving")["ok"], frozen

    def blind(_):
        raise OSError("offline")

    unreadable = run(ctx={**ctx, "read_json": blind})
    assert len(unreadable) == len(__manifest__["checks"]), unreadable
    assert all(
        not item["ok"] and item["severity"] == "warn"
        for item in unreadable), unreadable
    return True


def _by_id(results, check_id):
    return next(item for item in results if item["id"] == check_id)


def _output_digest(report):
    import hashlib
    import json
    cases_payload = []
    for case in report.get("cases") or []:
        expected = case.get("expected") or {}
        observed = case.get("observed") or {}
        results = []
        for result in case.get("results") or []:
            results.append({
                "node_id": result.get("node_id"),
                "machine": result.get("machine"),
                "kind": result.get("kind"),
                "transport": result.get("transport"),
                "transport_ok": result.get("transport_ok"),
                "response": result.get("response"),
                "duration_ms": result.get("duration_ms"),
                "accepted": result.get("accepted"),
                "differences": result.get("differences"),
                "evidence": result.get("evidence"),
                "envelope": _digest_evidence_value(result.get("envelope"))
                if result.get("envelope") is not None else None,
                "http_status": result.get("http_status"),
                "refused": result.get("refused"),
                "outcome": result.get("outcome"),
                "settled_order": result.get("settled_order"),
            })
        winner = case.get("winner")
        cases_payload.append({
            "id": case.get("id"),
            "action": case.get("action"),
            "mode": case.get("mode"),
            "candidates": case.get("candidates"),
            "prompt": case.get("prompt"),
            "handoff_prompt": case.get("handoff_prompt"),
            "reverse_candidates": case.get("reverse_candidates", False),
            "expected": {
                "contains": expected.get("contains"),
                "excludes": expected.get("excludes"),
                "required_envelope_fields":
                    expected.get("required_envelope_fields"),
                "max_duration_ms": expected.get("max_duration_ms"),
                "min_passing": expected.get("min_passing"),
            },
            "observed": {
                "passing": observed.get("passing"),
                "failing": observed.get("failing"),
                "transport_failures": observed.get("transport_failures"),
                "cancelled_after_winner":
                    observed.get("cancelled_after_winner"),
                "completion_order": observed.get("completion_order"),
                "relay": observed.get("relay"),
                "relationship": observed.get("relationship"),
                "neighborhood_protocol":
                    observed.get("neighborhood_protocol"),
            },
            "results": results,
            "winner": {
                "node_id": winner.get("node_id"),
                "accepted": winner.get("accepted"),
                "settled_order": winner.get("settled_order"),
            } if isinstance(winner, dict) else None,
            "pass": case.get("pass"),
        })
    payload = {
        "schema": report.get("schema"),
        "wire": _digest_evidence_value(report.get("wire"))
        if report.get("wire") is not None else None,
        "pack_id": report.get("pack_id"),
        "matrix": report.get("matrix"),
        "nodes": [{
            "id": node.get("id"),
            "machine": node.get("machine"),
            "kind": node.get("kind"),
            "capabilities": node.get("capabilities"),
            "transport": node.get("transport"),
        } for node in report.get("nodes") or []],
        "cases": cases_payload,
    }
    source = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _digest_evidence_value(value, depth=0):
    import struct
    if depth > 64:
        raise ValueError("Pack evidence JSON is nested too deeply")
    if value is None:
        return ["null"]
    if isinstance(value, str):
        return ["string", value]
    if isinstance(value, bool):
        return ["boolean", value]
    if isinstance(value, (int, float)):
        return ["number-f64", struct.pack(">d", float(value)).hex()]
    if isinstance(value, list):
        return [
            "array",
            [_digest_evidence_value(item, depth + 1) for item in value],
        ]
    if isinstance(value, dict):
        return [
            "object",
            [
                [key, _digest_evidence_value(value[key], depth + 1)]
                for key in sorted(value)
            ],
        ]
    raise ValueError("Pack evidence JSON contains an unsupported value")


def _envelope_satisfies(envelope, required):
    if required and not isinstance(envelope, dict):
        return False
    if any(field not in envelope for field in required):
        return False
    known_types = {
        "schema": str,
        "status": str,
        "response": str,
        "content": str,
        "session_id": str,
        "sessionId": str,
        "agent_logs": list,
        "voice_mode": bool,
        "model": str,
        "requested_model": str,
    }
    if any(
        field in known_types
        and not isinstance(envelope[field], known_types[field])
        for field in required
    ):
        return False
    if (
        "agent_logs" in required
        and any(not isinstance(entry, str) for entry in envelope["agent_logs"])
    ):
        return False
    if "session_id" in required and not envelope["session_id"]:
        return False
    return True


def _result_satisfies(result, expected):
    if result.get("transport_ok") is not True:
        return False
    if result.get("refused") is not False:
        return False
    status = result.get("http_status")
    if (
        not isinstance(status, int)
        or isinstance(status, bool)
        or status != 200
    ):
        return False
    response = str(result.get("response") or "")
    if any(str(value) not in response for value in expected.get("contains") or []):
        return False
    if any(str(value) in response for value in expected.get("excludes") or []):
        return False
    if not _envelope_satisfies(
            result.get("envelope"),
            expected.get("required_envelope_fields") or []):
        return False
    maximum = expected.get("max_duration_ms")
    duration = result.get("duration_ms")
    if (
        not isinstance(duration, (int, float))
        or isinstance(duration, bool)
        or duration < 0
    ):
        return False
    if maximum is not None and duration > maximum:
        return False
    return True


def _case_satisfies(case, node_map=None):
    expected = case.get("expected")
    if not _valid_expected(expected):
        return False
    results = case.get("results") or []
    mode = case.get("mode")
    if mode not in ("all", "race", "relay"):
        return False
    node_map = node_map or {}
    if (
        case.get("candidates") != [
            result.get("node_id") for result in results
        ] and mode == "relay"
    ):
        return False
    if any(
        result.get("node_id") not in node_map
        or result.get("machine") != node_map[result.get("node_id")].get("machine")
        or result.get("kind") != node_map[result.get("node_id")].get("kind")
        or result.get("transport")
            != node_map[result.get("node_id")].get("transport")
        for result in results
    ):
        return False
    decisions = [
        _result_satisfies(result, expected)
        if mode != "relay" or index == len(results) - 1
        else _relay_intermediate_satisfies(result, expected)
        for index, result in enumerate(results)
    ]
    if any(
        result.get("accepted") is not decision
        or (
            decision
            and result.get("differences") != []
        )
        or (
            not decision
            and (
                not isinstance(result.get("differences"), list)
                or not result.get("differences")
            )
        )
        for result, decision in zip(results, decisions)
    ):
        return False
    if mode == "relay":
        computed = (
            len(results) >= 2
            and all(decisions)
        )
    else:
        minimum = expected.get("min_passing", len(results))
        computed = (
            bool(results)
            and isinstance(minimum, int)
            and sum(decisions) >= minimum
        )
    if case.get("pass") is not computed:
        return False
    observed = case.get("observed")
    if not isinstance(observed, dict):
        return False
    passing = sum(decisions)
    if (
        observed.get("passing") != passing
        or observed.get("failing") != len(results) - passing
        or observed.get("transport_failures") != sum(
            result.get("transport_ok") is not True for result in results)
        or observed.get("cancelled_after_winner") != sum(
            result.get("outcome") == "cancelled_after_winner"
            for result in results)
    ):
        return False
    try:
        completion = [
            result.get("node_id")
            for result in sorted(
                results, key=lambda result: result["settled_order"])
        ]
    except Exception:
        return False
    if observed.get("completion_order") != completion:
        return False
    if mode == "relay" and observed.get("relay") != [
        result.get("node_id") for result in results
    ]:
        return False
    return computed


def _relay_intermediate_satisfies(result, expected):
    if result.get("transport_ok") is not True:
        return False
    if result.get("refused") is not False:
        return False
    status = result.get("http_status")
    if (
        not isinstance(status, int)
        or isinstance(status, bool)
        or status != 200
    ):
        return False
    duration = result.get("duration_ms")
    if (
        not isinstance(duration, (int, float))
        or isinstance(duration, bool)
        or duration < 0
    ):
        return False
    if not _envelope_satisfies(
            result.get("envelope"),
            expected.get("required_envelope_fields") or []):
        return False
    maximum = expected.get("max_duration_ms")
    return maximum is None or duration <= maximum


def _valid_expected(expected):
    if not isinstance(expected, dict):
        return False
    for key in ("contains", "excludes", "required_envelope_fields"):
        value = expected.get(key)
        if (
            not isinstance(value, list)
            or any(not isinstance(item, str) or not item for item in value)
            or len(value) != len(set(value))
        ):
            return False
    maximum = expected.get("max_duration_ms")
    if maximum is not None and (
        not isinstance(maximum, (int, float))
        or isinstance(maximum, bool)
        or maximum <= 0
    ):
        return False
    minimum = expected.get("min_passing")
    if (
        not isinstance(minimum, int)
        or isinstance(minimum, bool)
        or minimum < 1
    ):
        return False
    return bool(
        expected["contains"]
        or expected["excludes"]
        or expected["required_envelope_fields"]
        or maximum is not None
    )


def _read_json(file):
    import json
    from pathlib import Path
    return json.loads(
        Path(file).expanduser().read_text(encoding="utf-8"))


def _minutes_since(value):
    from datetime import datetime, timezone
    if not value:
        return None
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - stamp).total_seconds() / 60
    except Exception:
        return None


def _now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _state_path(name):
    import os
    from pathlib import Path
    home = Path(os.environ.get(
        "SENTINEL_HOME",
        Path.home() / ".rapp" / "sentinel" / "instance"))
    directory = home / "state" / "hub"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / name


def _state_read(name):
    import json
    try:
        return json.loads(_state_path(name).read_text(encoding="utf-8"))
    except Exception:
        return None


def _state_write(name, value):
    import json
    target = _state_path(name)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n",
        encoding="utf-8")
    temporary.replace(target)


def _ctx(ctx):
    base = {
        "ok": lambda check_id, detail="": {
            "id": check_id,
            "ok": True,
            "severity": "warn",
            "detail": detail,
        },
        "fail": lambda check_id, detail="", critical=True: {
            "id": check_id,
            "ok": False,
            "severity": "critical" if critical else "warn",
            "detail": detail,
        },
        "read_json": _read_json,
        "minutes_since": _minutes_since,
        "now_iso": _now_iso,
        "state_read": _state_read,
        "state_write": _state_write,
    }
    base.update(ctx or {})
    return base


if __name__ == "__main__":
    import json
    import sys
    if "--prove" in sys.argv:
        sys.exit(0 if prove() else 1)
    print(json.dumps(run(), indent=2))
