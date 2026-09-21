"""One bounded watcher tick; deliberately no daemon/run/server entry point."""

from __future__ import annotations

import argparse
import json

from .config import Config, PortalError
from .portal import HELP, Portal
from .state import Store


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="Owner-only private portal JSON configuration")
    parser.add_argument("command", choices=("tick", "check-config", "transport-status", "help-route"))
    args = parser.parse_args(argv)
    try:
        config = Config.load(args.config)
        if args.command == "tick":
            result = Portal(config).tick()
        elif args.command == "check-config":
            result = {"ok": True, "authorized_routes": len(config.routes)}
        elif args.command == "help-route":
            result = {"ok": True, "help": HELP}
        else:
            with Store(config.state_dir) as store:
                counts = {}
                for part in store.data["outbox"]:
                    counts[part["state"]] = counts.get(part["state"], 0) + 1
                result = {
                    "ok": True, "initialized": store.data["cursor"] is not None,
                    "jobs": len(store.data["jobs"]), "outbox": counts,
                    "recent_error_codes": [item["code"] for item in store.data["errors"][-10:]],
                }
        print(json.dumps(result, separators=(",", ":")))
        return 0 if result["ok"] else 1
    except PortalError as error:
        print(json.dumps({"ok": False, "error": {"code": error.code}}))
        return 1
    except Exception:
        print(json.dumps({"ok": False, "error": {"code": "transport_internal_error"}}))
        return 1
