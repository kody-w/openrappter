"""Deterministic on-disk fixture deck for developers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

from .fixtures import (
    RAPPID_CARD_FIXTURE_NAMES,
    build_rappid_card_fixture,
    list_rappid_card_fixtures,
)
from .qr import render_rappid_card_qr_png, render_rappid_card_qr_svg
from .types import RAPPID_CARD_FILENAME


def write_rappid_card_fixture_deck(
    directory: str, qr_format: str = "svg"
) -> Dict[str, Any]:
    if qr_format not in {"svg", "png", "both"}:
        raise ValueError("format must be svg, png, or both")
    root = Path(directory).resolve()
    root.mkdir(parents=True, exist_ok=True)
    files = []
    deck_path = root / "deck.json"
    deck_path.write_text(
        json.dumps(
            {
                "schema": "rappid-card-fixture-deck/1",
                "fixtures": list_rappid_card_fixtures(),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    files.append(str(deck_path))
    for name in RAPPID_CARD_FIXTURE_NAMES:
        fixture = build_rappid_card_fixture(name)
        fixture_directory = root / name
        fixture_directory.mkdir(parents=True, exist_ok=True)
        card_path = fixture_directory / RAPPID_CARD_FILENAME
        link_path = fixture_directory / "rappid-card.link.txt"
        card_path.write_text(
            json.dumps(fixture.manifest, indent=2) + "\n",
            encoding="utf-8",
        )
        link_path.write_text(fixture.deep_link + "\n", encoding="utf-8")
        files.extend([str(card_path), str(link_path)])
        if qr_format in {"svg", "both"}:
            svg_path = fixture_directory / "rappid-card.svg"
            svg_path.write_text(
                render_rappid_card_qr_svg(fixture.deep_link),
                encoding="utf-8",
            )
            files.append(str(svg_path))
        if qr_format in {"png", "both"}:
            png_path = fixture_directory / "rappid-card.png"
            png_path.write_bytes(render_rappid_card_qr_png(fixture.deep_link))
            files.append(str(png_path))
    return {
        "directory": str(root),
        "fixtures": len(RAPPID_CARD_FIXTURE_NAMES),
        "files": files,
    }
