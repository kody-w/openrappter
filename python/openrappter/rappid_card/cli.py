"""Argparse wiring for the developer-facing RAPPID card surface."""

from __future__ import annotations

import copy
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from openrappter import __version__

from .artifacts import write_rappid_card_fixture_deck
from .contract import make_deep_link, manifest_hash, parse_manifest_json
from .fixtures import (
    RAPPID_CARD_FIXTURE_NAMES,
    build_rappid_card_fixture,
    simulate_rappid_card_fixture,
)
from .qr import render_rappid_card_qr_png, render_rappid_card_qr_svg
from .replay_cache import BoundedReplayCache
from .simulator import simulate_rappid_card
from .types import (
    RAPPID_CARD_PROTOCOL,
    RAPPID_CARD_TEST_PROFILE,
    CardPolicy,
    CardProviders,
)


def register_rappid_card_parser(subparsers: Any) -> None:
    command = subparsers.add_parser(
        "rappid-card",
        help="Generate, inspect, verify, render, and simulate virtual RAPPID Debug Cards",
    )
    commands = command.add_subparsers(dest="rappid_card_command")

    fixtures = commands.add_parser(
        "fixtures",
        help="Write the deterministic .rappid-card.json fixture deck and real QR artifacts",
    )
    fixtures.add_argument("directory")
    fixtures.add_argument(
        "--format", choices=["svg", "png", "both"], default="svg"
    )

    for name, help_text in (
        ("inspect", "Parse, hash, and preview-verify a closed card manifest"),
        ("verify", "Verify a card and fail on any rejected control"),
    ):
        parser = commands.add_parser(name, help=help_text)
        parser.add_argument("card")
        parser.add_argument("--link", default=None)
        parser.add_argument(
            "--mode", choices=["fixture", "production"], default="fixture"
        )
        parser.add_argument(
            "--keys",
            default=None,
            help="Explicit key-id to hex-key JSON; ambient credentials are never read",
        )

    qr = commands.add_parser(
        "qr", help="Render the exact compact deep link as a scannable QR artifact"
    )
    qr.add_argument("link")
    qr.add_argument("output")
    qr.add_argument("--format", choices=["svg", "png"], default="svg")

    simulate = commands.add_parser(
        "simulate",
        help="Run one deterministic fixture; --approve is required to hydrate and wake",
    )
    simulate.add_argument("fixture", choices=RAPPID_CARD_FIXTURE_NAMES)
    simulate.add_argument("--approve", action="store_true")


def _print(value: Any) -> None:
    print(json.dumps(value, indent=2))


def _read_link(value: Optional[str], manifest: Dict[str, Any]) -> str:
    if value is None:
        return make_deep_link(manifest)
    if value.startswith("rappid://"):
        return value
    return Path(value).read_text(encoding="utf-8").strip()


def _explicit_keys(path: Optional[str]) -> Dict[str, bytes]:
    if path is None:
        return {}
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(
            "key file must be an object mapping key ids to 64 hex characters"
        )
    result = {}
    for key_id, value in raw.items():
        if (
            not isinstance(key_id, str)
            or not isinstance(value, str)
            or len(value) != 64
            or any(character not in "0123456789abcdef" for character in value)
        ):
            raise ValueError(
                f"key file entry {key_id} must be 64 lowercase hex characters"
            )
        result[key_id] = bytes.fromhex(value)
    return result


def _matching_fixture(manifest: Dict[str, Any]) -> Any:
    digest = manifest_hash(manifest)
    for name in RAPPID_CARD_FIXTURE_NAMES:
        fixture = build_rappid_card_fixture(name)
        if manifest_hash(fixture.manifest) == digest:
            return fixture
    return None


def _inspect_card(args: Any) -> bool:
    card_path = Path(args.card)
    manifest = parse_manifest_json(card_path.read_text(encoding="utf-8"))
    deep_link = _read_link(args.link, manifest)
    fixture = _matching_fixture(manifest)
    if args.mode == "fixture" and fixture is not None:
        providers = CardProviders(
            get_manifest=lambda _endpoint, _hash: copy.deepcopy(manifest),
            get_key=fixture.providers.get_key,
            is_revoked=fixture.providers.is_revoked,
            get_part=fixture.providers.get_part,
            challenge_response=fixture.providers.challenge_response,
        )
    else:
        keys = _explicit_keys(args.keys)
        providers = CardProviders(
            get_manifest=lambda _endpoint, _hash: copy.deepcopy(manifest),
            get_key=lambda key_id, _algorithm: keys.get(key_id),
            is_revoked=lambda _hash, _key_id: False,
            get_part=lambda _hash: None,
            challenge_response=lambda _request: "0" * 64,
        )
    now = (
        fixture.policy.now
        if args.mode == "fixture" and fixture is not None
        else datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    )
    snapshot = simulate_rappid_card(
        deep_link,
        approve=False,
        policy=CardPolicy(
            mode=args.mode,
            now=now,
            runtime_name="openrappter",
            runtime_version=__version__,
            protocol=RAPPID_CARD_PROTOCOL,
            max_classification="restricted",
            granted_scopes=[
                "identity:read",
                "traits:read",
                "skill:hydrate",
                "sonic:hydrate",
                "capability:hydrate",
            ],
        ),
        providers=providers,
        replay_cache=BoundedReplayCache(),
    )
    _print(
        {
            "file": str(card_path),
            "profile": manifest["profile"],
            "syntheticFixture": manifest["profile"] == RAPPID_CARD_TEST_PROFILE,
            "canonicalManifestHash": manifest_hash(manifest),
            "exactDeepLink": deep_link,
            "simulation": snapshot,
        }
    )
    return snapshot["state"] != "failed"


def handle_rappid_card_command(args: Any) -> bool:
    command = args.rappid_card_command
    if command == "fixtures":
        _print(write_rappid_card_fixture_deck(args.directory, args.format))
        return True
    if command in {"inspect", "verify"}:
        return _inspect_card(args)
    if command == "qr":
        if args.format == "png":
            Path(args.output).write_bytes(render_rappid_card_qr_png(args.link))
        else:
            Path(args.output).write_text(
                render_rappid_card_qr_svg(args.link), encoding="utf-8"
            )
        _print(
            {
                "output": args.output,
                "format": args.format,
                "exactDeepLink": args.link,
            }
        )
        return True
    if command == "simulate":
        fixture = build_rappid_card_fixture(args.fixture)
        _print(
            {
                "fixture": args.fixture,
                "exactDeepLink": fixture.deep_link,
                "simulation": simulate_rappid_card_fixture(
                    args.fixture, args.approve
                ),
            }
        )
        return True
    raise ValueError(
        "Usage: openrappter rappid-card "
        "[fixtures|inspect|verify|qr|simulate]"
    )
