#!/usr/bin/env python3
"""Build the Frontier RAPP Store index (rapp-store/1.0) from frontier/rapplications/.

Completely independent of the industry agent catalog (registry.json): this
store hosts FRONTIER-labeled rapplications — use-case apps that hatch as
isolated twins on the Frontier Brainstem. sha256 pins are computed from the
bytes on disk, never authored; a rapplication missing its declared files
refuses to publish.

    python frontier/build_store.py                 # writes frontier/store/index.json (prod URLs)
    python frontier/build_store.py --base http://127.0.0.1:8123/ --out /tmp/index.json
"""
import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROD_BASE = "https://raw.githubusercontent.com/microsoft/aibast-agents-library/main/"

# The catalog is authored here — one entry per rapplication, files verified.
RAPPLICATIONS = [
    {
        "id": "molter",
        "name": "Molter — self-growing capabilities",
        "version": "1.0.0",
        "summary": "When the Brainstem lacks a capability, it searches the AIBAST catalog for a kindred agent, takes its shape, and molts it through verified generations until it fits — shedding failed skins with rollback and carrying each lesson forward. On device, headless.",
        "category": "frontier · self-improving",
        "tags": ["frontier", "capability", "evolution", "self-improving"],
        "singleton": "rapplications/molter/agents/molter_agent.py",
        "license": "MIT",
    },
    {
        "id": "toaster",
        "name": "Toaster — skill.md ⇄ agent.py",
        "version": "1.0.0",
        "summary": "Losslessly convert between a runnable agent.py and a tradeable, any-AI-readable <name>_skill.md that embeds the agent verbatim. Drop a skill.md on the Frontier to toast + hot-load it; export any agent as a skill; round-trip without losing the deterministic layer.",
        "category": "frontier · interop",
        "tags": ["frontier", "skill", "agent", "interop", "portable"],
        "singleton": "rapplications/toaster/agents/toaster_agent.py",
        "license": "MIT",
    },
    {
        "id": "ui-smith",
        "name": "UI Smith — UIs on the fly",
        "summary": "Derive a fit-for-purpose UI from any agent.py's own schema (no pre-built UI needed), then molt it through verified generations for an isolated twin. Agents stay headless; a UI is summoned on demand.",
        "version": "1.0.0",
        "category": "frontier · ui",
        "tags": ["frontier", "ui", "generate", "molt"],
        "singleton": "rapplications/ui-smith/agents/ui_smith_agent.py",
        "license": "MIT",
    },
    {
        "id": "agentic-app-studio",
        "name": "Agentic App Studio",
        "version": "1.0.0",
        "summary": "Build & Manage Agentic Apps workshop, end to end: compose agents from the local Brainstem and public RARs into a Power Apps code app — test on a local server, then pac-deploy to a connected Power Platform environment.",
        "category": "frontier · power apps",
        "tags": ["frontier", "power-apps", "code-apps", "workshop"],
        "singleton": "rapplications/agentic-app-studio/agents/agentic_app_studio_agent.py",
        "preferred_view": "full",
        "ui": "rapplications/agentic-app-studio/index.html",
        "license": "MIT",
    },
    {
        "id": "agent-migration",
        "name": "Agent Migration Assistant",
        "version": "1.0.0",
        "summary": "Move a client's Anthropic/OpenAI agents to RAPP/1 and Copilot Studio — analyzed and converted entirely on-device.",
        "category": "frontier · migration",
        "tags": ["frontier", "migration", "copilot-studio", "anthropic", "openai"],
        "singleton": "rapplications/agent-migration/agents/agent_migration_agent.py",
        "preferred_view": "full",
        "ui": "rapplications/agent-migration/index.html",
        "license": "MIT",
    },
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=PROD_BASE, help="URL base the index points at (prod raw URLs by default)")
    ap.add_argument("--out", default=str(ROOT / "store" / "index.json"))
    a = ap.parse_args()
    base = a.base if a.base.endswith("/") else a.base + "/"
    prod = PROD_BASE if PROD_BASE.endswith("/") else PROD_BASE + "/"
    prefix = "beta/frontier/" if base == prod else ""

    entries = []
    for r in RAPPLICATIONS:
        sp = ROOT / r["singleton"]
        if not sp.exists():
            sys.exit(f"REFUSING TO PUBLISH: {r['id']} singleton missing: {sp}")
        sb = sp.read_bytes()
        entry = {
            "id": r["id"], "name": r["name"], "version": r["version"], "summary": r["summary"],
            "category": r["category"], "tags": r["tags"],
            "manifest_name": f"@frontier/{r['id']}",
            "singleton_filename": sp.name,
            "singleton_url": base + prefix + r["singleton"],
            "singleton_sha256": hashlib.sha256(sb).hexdigest(),
            "singleton_bytes": len(sb),
            "publisher": "AIBAST Frontier",
            "quality_tier": "frontier",
            "license": r["license"],
        }
        if r.get("preferred_view"):
            entry["preferred_view"] = r["preferred_view"]
        for opt in ("yanked", "min_app_version", "deprecated"):
            if r.get(opt) is not None:
                entry[opt] = r[opt]
        if r.get("ui"):
            up = ROOT / r["ui"]
            if not up.exists():
                sys.exit(f"REFUSING TO PUBLISH: {r['id']} declared ui missing: {up}")
            entry["ui_url"] = base + prefix + r["ui"]
            entry["ui_filename"] = up.name
            # The UI is executable content at the twin's origin — pinned like
            # the singleton. Clients refuse a mismatch and never run unpinned UI.
            entry["ui_sha256"] = hashlib.sha256(up.read_bytes()).hexdigest()
        if r.get("egg"):
            ep = ROOT / r["egg"]
            if not ep.exists():
                sys.exit(f"REFUSING TO PUBLISH: {r['id']} declared egg missing: {ep}")
            entry["egg_url"] = base + prefix + r["egg"]
            entry["egg_sha256"] = hashlib.sha256(ep.read_bytes()).hexdigest()
        entries.append(entry)

    doc = {
        "schema": "rapp-store/1.0",
        "store": "AIBAST Frontier RAPP Store",
        "note": "Frontier rapplications — isolated use-case twins for the Frontier Brainstem. Independent of the industry agent catalog (registry.json).",
        # Deterministic: the store index is a build artifact that CI diffs against
        # the committed copy — a wall-clock stamp would make every rebuild differ
        # and defeat the drift gate. The source-of-truth freshness is git history.
        "schema_version": "1.0",
        "rapplications": entries,
    }
    out = Path(a.out); out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(out), "rapplications": len(entries),
                      "pins": {e['id']: e['singleton_sha256'][:12] for e in entries}}, indent=2))


if __name__ == "__main__":
    main()
