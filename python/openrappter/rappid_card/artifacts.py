"""Export PR9 vectors and genuinely scannable QR artifacts."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from . import pr9_reference as R
from .fixtures import PROVENANCE_COMMIT, load_rappid_card_deck
from .qr import render_rappid_card_qr_png, render_rappid_card_qr_svg


def write_rappid_card_fixture_deck(
    directory: str,
    qr_format: str = "svg",
) -> Dict[str, Any]:
    if qr_format not in {"svg", "png", "both"}:
        raise ValueError("format must be svg, png, or both")
    root = Path(directory).resolve()
    root.mkdir(parents=True, exist_ok=True)
    files = []
    deck = load_rappid_card_deck()
    for vector in deck["vectors"]:
        target = root / vector["name"]
        target.mkdir(parents=True, exist_ok=True)
        outputs = {
            ".rappid-card.json": R.canonical(vector["frame"]),
            "rappid-card.link.txt": vector["link"] + "\n",
            "runtime-policy.json": R.canonical(vector["runtime_policy"]),
            "authority-view.json": R.canonical(vector["authority_view"]),
            "revocation-view.json": R.canonical(vector["revocation_view"]),
        }
        for name, text in outputs.items():
            path = target / name
            path.write_text(text, encoding="utf-8")
            files.append(str(path))
        if vector["expected"]["step"] != "parse" and qr_format in {"svg", "both"}:
            path = target / "rappid-card.svg"
            path.write_text(
                render_rappid_card_qr_svg(vector["link"]),
                encoding="utf-8",
            )
            files.append(str(path))
        if vector["expected"]["step"] != "parse" and qr_format in {"png", "both"}:
            path = target / "rappid-card.png"
            path.write_bytes(render_rappid_card_qr_png(vector["link"]))
            files.append(str(path))
    return {
        "directory": str(root),
        "fixtures": len(deck["vectors"]),
        "files": files,
        "provenance": f"rapp-1 commit {PROVENANCE_COMMIT}",
    }
