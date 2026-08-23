"""Mode-0600 local production trust configuration."""

from __future__ import annotations

import base64
import json
import os
import stat
from pathlib import Path
from typing import Any, Dict, Optional

from .contract import CardTrustStore, rappid_valid

RAPPID_CARD_TRUST_CONFIG_SCHEMA = "openrappter-rappid-card-trust/1"
RAPPID_CARD_TRUST_CONFIG_ENV = "OPENRAPPTER_RAPPID_CARD_TRUST_CONFIG"


def load_rappid_card_trust_config(
    explicit_path: Optional[str] = None,
) -> Dict[str, Any]:
    path_value = explicit_path or os.environ.get(RAPPID_CARD_TRUST_CONFIG_ENV)
    if not path_value:
        raise ValueError(
            "production trust config unavailable; pass --trust-config or set "
            + RAPPID_CARD_TRUST_CONFIG_ENV
        )
    path = Path(path_value)
    status = path.lstat()
    if not stat.S_ISREG(status.st_mode) or path.is_symlink():
        raise ValueError(
            "production trust config must be a regular non-symlink file"
        )
    if stat.S_IMODE(status.st_mode) & 0o077:
        raise ValueError(
            "production trust config permissions must be mode 0600"
        )
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or sorted(raw) != [
        "keys",
        "runtime_policy_authority",
        "schema",
    ]:
        raise ValueError("production trust config has the wrong closed schema")
    if (
        raw["schema"] != RAPPID_CARD_TRUST_CONFIG_SCHEMA
        or not rappid_valid(raw["runtime_policy_authority"])
        or not isinstance(raw["keys"], list)
        or not raw["keys"]
    ):
        raise ValueError("production trust config is invalid")
    keys = {}
    for entry in raw["keys"]:
        if (
            not isinstance(entry, dict)
            or sorted(entry) != ["kid", "spki_der_b64"]
            or not rappid_valid(entry["kid"])
            or not isinstance(entry["spki_der_b64"], str)
        ):
            raise ValueError("production trust config key entry is invalid")
        if entry["kid"] in keys:
            raise ValueError("production trust config contains a duplicate key")
        keys[entry["kid"]] = base64.b64decode(
            entry["spki_der_b64"], validate=True
        )
    return {
        "path": str(path),
        "config": raw,
        "trust": CardTrustStore(keys, raw["runtime_policy_authority"]),
    }
