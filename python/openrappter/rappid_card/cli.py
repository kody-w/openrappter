"""Argparse wiring for the authenticated RAPPID card developer surface."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any, Dict, Optional

from .artifacts import write_rappid_card_fixture_deck
from .contract import make_deep_link, manifest_hash, parse_manifest_json
from .fixtures import (
    RAPPID_CARD_FIXTURE_NAMES,
    build_rappid_card_fixture,
    simulate_rappid_card_fixture,
    simulate_rappid_card_fixture_input,
)
from .qr import render_rappid_card_qr_png, render_rappid_card_qr_svg
from .simulator import simulate_rappid_card
from .sqlite_state_store import SqliteCardStateStore
from .types import (
    RAPPID_CARD_TEST_PROFILE,
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
        help="Write the deterministic signed-trust fixture deck and real QR artifacts",
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
            "--fixture",
            action="store_true",
            help="Use only the built-in signed synthetic fixture authority",
        )
        parser.add_argument(
            "--trust",
            default=None,
            help="Explicit signed production trust bundle; no ambient credentials",
        )
        parser.add_argument(
            "--state",
            default=None,
            help="Durable transactional replay/trust-sequence database",
        )

    qr = commands.add_parser(
        "qr", help="Render the exact compact deep link as a scannable QR artifact"
    )
    qr.add_argument("link")
    qr.add_argument("output")
    qr.add_argument("--format", choices=["svg", "png"], default="svg")

    simulate = commands.add_parser(
        "simulate",
        help="Run one deterministic signed-trust fixture; --approve is required to hydrate",
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


def _explicit_trust_provider(path: str) -> Dict[str, Any]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or sorted(raw) != [
        "authorityKeys",
        "authorization",
        "policy",
        "revocations",
    ]:
        raise ValueError(
            "trust file requires exactly policy, authorization, revocations, and authorityKeys"
        )
    authority_keys = raw["authorityKeys"]
    if not isinstance(authority_keys, dict):
        raise ValueError("trust authorityKeys must be an object")
    for key_id, public_key in authority_keys.items():
        if (
            not isinstance(key_id, str)
            or re.fullmatch(r"[a-z][a-z0-9._-]{0,63}", key_id) is None
            or not isinstance(public_key, str)
            or len(public_key) != 43
            or any(
                character
                not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
                for character in public_key
            )
        ):
            raise ValueError(f"trust authority {key_id} is invalid")
    return raw


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
    if args.fixture:
        if fixture is None or manifest["profile"] != RAPPID_CARD_TEST_PROFILE:
            raise ValueError(
                "--fixture accepts only a generated test-profile card"
            )
        fixture.deep_link = deep_link
        fixture.providers.get_manifest = (
            lambda _endpoint, _hash: copy.deepcopy(manifest)
        )
        snapshot = simulate_rappid_card_fixture_input(fixture, False)
    else:
        if args.trust is None or args.state is None:
            raise ValueError(
                "production verification requires explicit --trust and --state files"
            )
        bundle = _explicit_trust_provider(args.trust)
        providers = CardProviders(
            get_manifest=lambda _endpoint, _hash: copy.deepcopy(manifest),
            get_policy_for_origin=lambda _origin: copy.deepcopy(
                bundle["policy"]
            ),
            get_authorization=lambda _policy_id, _key_id, _subject: copy.deepcopy(
                bundle["authorization"]
            ),
            get_revocations=lambda _policy_id: copy.deepcopy(
                bundle["revocations"]
            ),
            get_authority_key=lambda key_id, _algorithm: bundle[
                "authorityKeys"
            ].get(key_id),
            get_part=lambda _hash: None,
            challenge_response=lambda _request: "0" * 86,
        )
        state_store = SqliteCardStateStore(args.state)
        try:
            snapshot = simulate_rappid_card(
                deep_link,
                approve=False,
                providers=providers,
                state_store=state_store,
            )
        finally:
            state_store.close()
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
