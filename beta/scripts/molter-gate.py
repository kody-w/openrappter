#!/usr/bin/env python3
"""Adapt Frontier Molter verification to git-molt's stdin verifier contract."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys


def _refuse(lesson: str) -> int:
    print(" ".join(str(lesson).split()) or "verification refused")
    return 1


def main() -> int:
    grail_value = os.environ.get("MOLTER_GRAIL", "").strip()
    if not grail_value:
        return _refuse("MOLTER_GRAIL must name the copied Brainstem directory")

    grail = Path(grail_value).expanduser().resolve()
    basic_agent = grail / "agents" / "basic_agent.py"
    if not basic_agent.is_file():
        return _refuse(f"MOLTER_GRAIL has no agents/basic_agent.py: {grail}")

    source = sys.stdin.read()
    if not source:
        return _refuse("candidate source is empty")

    beta_root = Path(__file__).resolve().parent.parent
    molter_path = (
        beta_root
        / "frontier"
        / "rapplications"
        / "molter"
        / "agents"
        / "molter_agent.py"
    )
    if not molter_path.is_file():
        return _refuse(f"Molter verifier is missing: {molter_path}")

    sys.path.insert(0, str(grail))
    spec = importlib.util.spec_from_file_location(
        "_git_molt_frontier_verifier", molter_path
    )
    if spec is None or spec.loader is None:
        return _refuse(f"could not load Molter verifier: {molter_path}")

    try:
        molter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(molter)
        molter.LIVE_DIR = str(grail / "agents")
        ok, detail = molter._verify(source)
    except Exception as exc:
        return _refuse(f"Molter gate failed closed: {type(exc).__name__}: {exc}")

    if not ok:
        return _refuse(detail.get("lesson", "Molter refused the candidate"))

    print(
        "verified"
        f" class={detail.get('agent_class', 'unknown')}"
        f" tool={detail.get('tool_name', 'unknown')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
