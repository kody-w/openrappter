"""The one place that decides where OpenRappter keeps its data.

Mirrors ``typescript/src/infra/openrappter-home.ts``.

``OPENRAPPTER_HOME`` relocates an installation. TypeScript routes every path
through its helper (#331); Python honoured the variable in ``brainstem.py`` and
``flight_recorder.py`` and hardcoded ``Path.home() / ".openrappter"``
everywhere else — so setting it moved one runtime and not the other, and the
two ended up reading **different** files:

    typescript memory -> /tmp/split-test/memory.json
    python memory     -> /Users/…/.openrappter/memory.json

That is worse than ignoring the variable outright. A split store is silent:
both runtimes work, neither sees what the other wrote.

Read at call time rather than captured at import, for the reason the
TypeScript side documents — ``openrappter reset`` and the test suites both
change this after modules are loaded, and a module-level constant would keep
pointing at the directory that was current when the file happened to load.
"""

from __future__ import annotations

import os
from pathlib import Path


def openrappter_home() -> Path:
    """The data directory: ``$OPENRAPPTER_HOME``, else ``~/.openrappter``."""
    override = os.environ.get("OPENRAPPTER_HOME")
    if override and override.strip():
        return Path(override)
    return Path.home() / ".openrappter"


def openrappter_path(*segments: str) -> Path:
    """A path inside the data directory."""
    return openrappter_home().joinpath(*segments)
