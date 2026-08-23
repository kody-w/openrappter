"""CLI for exact RAPP/1 §7.10 card vectors and fail-closed verification."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

from .artifacts import write_rappid_card_fixture_deck
from .contract import H, parse_card_link, read_card_resource
from .fixtures import (
    RAPPID_CARD_FIXTURE_NAMES,
    build_rappid_card_fixture,
    simulate_rappid_card_fixture,
)
from .qr import render_rappid_card_qr_png, render_rappid_card_qr_svg
from .simulator import inspect_card_offline, verify_card_link
from .trust_config import load_rappid_card_trust_config


def register_rappid_card_parser(subparsers: Any) -> None:
    command = subparsers.add_parser(
        "rappid-card",
        help="Inspect and verify exact RAPP/1 calling-card/debug-card frames",
    )
    commands = command.add_subparsers(dest="rappid_card_command")

    fixtures = commands.add_parser(
        "fixtures", help="Export the vendored RAPP/1 §7.10 conformance deck and QR artifacts"
    )
    fixtures.add_argument("directory")
    fixtures.add_argument("--format", choices=["svg", "png", "both"], default="svg")

    inspect = commands.add_parser(
        "inspect", help="Parse canonical eleven-key frame bytes and compact URI"
    )
    inspect.add_argument("card")
    inspect.add_argument("--link", required=True)

    verify = commands.add_parser(
        "verify", help="Verify one vendored scenario at its exact ordered RAPP/1 §7.10 step"
    )
    verify.add_argument("card")
    verify.add_argument("--link", required=True)
    verify.add_argument("--scenario", choices=RAPPID_CARD_FIXTURE_NAMES)
    verify.add_argument("--bundle")
    verify.add_argument("--trust-config")
    verify.add_argument("--state", required=True)

    offline = commands.add_parser(
        "inspect-offline",
        help="Historical cryptographic/policy inspection; never returns awake",
    )
    offline.add_argument("card")
    offline.add_argument("--link", required=True)
    offline.add_argument("--bundle", required=True)
    offline.add_argument("--trust-config", required=True)

    simulate = commands.add_parser(
        "simulate", help="Run one vendored mandatory RAPP/1 §7.10 scenario"
    )
    simulate.add_argument("scenario", choices=RAPPID_CARD_FIXTURE_NAMES)
    simulate.add_argument("--state", required=True)

    qr = commands.add_parser("qr", help="Render the exact canonical compact URI")
    qr.add_argument("link")
    qr.add_argument("output")
    qr.add_argument("--format", choices=["svg", "png"], default="svg")


def _print(value: Any) -> None:
    print(json.dumps(value, indent=2))


def _fixture_envelope(scenario, declared, verdict):
    return {
        "mode": "synthetic-conformance-fixture",
        "live": False,
        "scenario": scenario,
        "protocol_source_commit": "2167c34",
        "declared_expected": {
            "ok": declared["ok"],
            "step": declared["step"],
            "reason": declared["reason_contains"],
        },
        "verdict": verdict.to_wire(),
    }


def _read_link(value: str) -> str:
    return value if value.startswith("rappid://") else Path(value).read_text(
        encoding="utf-8"
    ).strip()


def _inspect(card_path: str, link_value: str) -> dict:
    octets = Path(card_path).read_bytes()
    frame = read_card_resource(octets)
    link_text = _read_link(link_value)
    link = parse_card_link(link_text)
    return {
        "frame": frame,
        "link": link_text,
        "parsed_link": link,
        "payload_particle": H("rapp/1:particle", frame["payload"]),
        "canonical_bytes": len(octets),
    }


def _load_historical_bundle(path: str) -> dict:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    expected = [
        "authority_view",
        "connection_id",
        "continuity",
        "fetch_trace",
        "hydrated_parts_b64",
        "now_utc",
        "revocation_view",
        "runtime_policy",
        "runtime_policy_authority",
    ]
    if not isinstance(raw, dict) or sorted(raw) != expected:
        raise ValueError(
            "historical bundle has the wrong closed schema; trust roots are forbidden"
        )
    return raw


def handle_rappid_card_command(args: Any) -> bool:
    command = args.rappid_card_command
    if command == "fixtures":
        _print(write_rappid_card_fixture_deck(args.directory, args.format))
        return True
    if command == "inspect":
        _print(_inspect(args.card, args.link))
        return True
    if command == "verify":
        if bool(args.scenario) == bool(args.bundle):
            raise ValueError(
                "verify requires exactly one of --scenario or --bundle"
            )
        inspected = _inspect(args.card, args.link)
        if args.scenario:
            fixture = build_rappid_card_fixture(args.scenario)
            if (
                inspected["frame"] != fixture.frame
                or inspected["link"] != fixture.deep_link
            ):
                _print(
                    {
                        "ok": False,
                        "step": "content-address",
                        "reason": "card/link bytes do not equal the selected vendored scenario",
                        "result": None,
                    }
                )
                return False
            verdict = simulate_rappid_card_fixture(args.scenario, args.state)
            _print(_fixture_envelope(args.scenario, fixture.expected, verdict))
            return verdict.ok == fixture.expected["ok"]
        bundle = _load_historical_bundle(args.bundle)
        local = load_rappid_card_trust_config(args.trust_config)
        if (
            bundle["runtime_policy_authority"]
            != local["config"]["runtime_policy_authority"]
        ):
            raise ValueError(
                "bundle runtime-policy authority is not locally configured"
            )
        _print(
            {
                "ok": False,
                "status": "unavailable",
                "reason": "live-adapter-required",
                "detail": (
                    "production awake verification requires local clock, "
                    "connection, fetch, hydration, and continuity adapters"
                ),
            }
        )
        return False
    if command == "inspect-offline":
        inspected = _inspect(args.card, args.link)
        bundle = _load_historical_bundle(args.bundle)
        local = load_rappid_card_trust_config(args.trust_config)
        if (
            bundle["runtime_policy_authority"]
            != local["config"]["runtime_policy_authority"]
        ):
            raise ValueError(
                "bundle runtime-policy authority is not locally configured"
            )
        parts = {
            name: base64.b64decode(value)
            for name, value in bundle["hydrated_parts_b64"].items()
        }
        inspection = inspect_card_offline(
            uri=inspected["link"],
            frame=inspected["frame"],
            trust=local["trust"],
            now_utc=bundle["now_utc"],
            runtime_policy=bundle["runtime_policy"],
            authority_view=bundle["authority_view"],
            revocation_view=bundle["revocation_view"],
            connection_id=bundle["connection_id"],
            fetch_trace=bundle["fetch_trace"],
            hydrate_part=lambda entry: parts.get(entry["part"]),
            continuity=bundle["continuity"],
        )
        _print(inspection)
        return inspection["cryptographic_policy_ok"]
    if command == "simulate":
        verdict = simulate_rappid_card_fixture(args.scenario, args.state)
        _print(
            _fixture_envelope(
                args.scenario,
                build_rappid_card_fixture(args.scenario).expected,
                verdict,
            )
        )
        expected = build_rappid_card_fixture(args.scenario).expected
        return (
            verdict.ok is expected["ok"]
            and verdict.step == expected["step"]
            and (
                expected["reason_contains"] is None
                or expected["reason_contains"] in verdict.reason
            )
        )
    if command == "qr":
        link = _read_link(args.link)
        parse_card_link(link)
        if args.format == "png":
            Path(args.output).write_bytes(render_rappid_card_qr_png(link))
        else:
            Path(args.output).write_text(
                render_rappid_card_qr_svg(link), encoding="utf-8"
            )
        _print({"output": args.output, "format": args.format, "link": link})
        return True
    raise ValueError(
        "Usage: openrappter rappid-card [fixtures|inspect|verify|simulate|qr]"
    )
