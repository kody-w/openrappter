"""One bounded watcher tick; deliberately no daemon/run/server entry point."""

from __future__ import annotations

import argparse
import json
import time

from . import doctor, feed
from .config import Config, PortalError
from .outbox import Outbox
from .portal import HELP, Portal
from .source import SQLiteSource
from .state import Store


def locked(config, action, wait=30.0):
    """Run action(store) under the journal lock, waiting out a concurrent watcher tick."""
    deadline = time.monotonic() + wait
    while True:
        try:
            with Store(config.state_dir) as store:
                return action(store)
        except PortalError as error:
            if error.code != "tick_busy" or time.monotonic() > deadline:
                raise
            time.sleep(0.4)


def post_command(config, args):
    if not 0 <= args.route < len(config.routes) or ";+;" in config.routes[args.route].chat:
        raise PortalError("feed_target", "Feed posts go only to an authorized direct-message thread.")
    route = config.routes[args.route]
    source = SQLiteSource(config)
    try:
        target = source.direct_target(route.chat)
        if target is None:
            raise PortalError("feed_target", "The authorized iMessage thread is unavailable.")
        actor = {"sender": route.sender, "chat": route.chat}

        def create(store):
            outbox = Outbox(config, store, None, time.time, source.target_matches, source.tail)
            item = feed.post(store, outbox, actor, target, text=args.text, file=args.file,
                             options=args.options, ttl=args.ttl, channel=args.channel, now=time.time())
            return {"ok": True, "post": item["id"], "state": item["state"]}

        return locked(config, create)
    finally:
        source.close()


def status_command(store):
    counts = {}
    for part in store.data["outbox"]:
        counts[part["state"]] = counts.get(part["state"], 0) + 1
    return {
        "ok": True, "initialized": store.data["cursor"] is not None,
        "jobs": len(store.data["jobs"]), "outbox": counts,
        "imessage": store.data.get("imessage_health", {}),
        "feed": [item["state"] for item in feed.describe(store)],
        "recent_error_codes": [item["code"] for item in store.data["errors"][-10:]],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="Owner-only private portal JSON configuration")
    parser.add_argument("command", choices=(
        "tick", "check-config", "transport-status", "help-route", "post", "feed-status", "doctor",
    ))
    parser.add_argument("--text", default="", help="post: message text, or the file's caption")
    parser.add_argument("--file", help="post: one image or file to attach")
    parser.add_argument("--options", type=int, default=0,
                        help="post: numbered choices offered; posts with choices collect the reply")
    parser.add_argument("--ttl", type=float, default=300, help="post: reply window after delivery, seconds")
    parser.add_argument("--channel", default="loop", help="post: a newer post replaces undelivered ones here")
    parser.add_argument("--route", type=int, default=0, help="post: index of the authorized route")
    parser.add_argument("--id", help="feed-status: one post id")
    args = parser.parse_args(argv)
    try:
        config = Config.load(args.config)
        if args.command == "tick":
            result = Portal(config).tick()
        elif args.command == "check-config":
            result = {"ok": True, "authorized_routes": len(config.routes)}
        elif args.command == "help-route":
            result = {"ok": True, "help": HELP}
        elif args.command == "post":
            result = post_command(config, args)
        elif args.command == "feed-status":
            result = locked(config, lambda store: {
                "ok": True, "posts": feed.describe(store, args.id),
                "imessage": store.data.get("imessage_health", {}),
            })
        elif args.command == "doctor":
            result = doctor.run()
            result["healthy"] = result.pop("ok")
            result["ok"] = True
        else:
            result = locked(config, status_command)
        print(json.dumps(result, separators=(",", ":")))
        return 0 if result["ok"] else 1
    except PortalError as error:
        print(json.dumps({"ok": False, "error": {"code": error.code}}))
        return 1
    except Exception as error:
        # Name the failure class (for example errno 28, disk full) without echoing private
        # paths or message content.
        failure = {"code": "transport_internal_error", "kind": type(error).__name__}
        if isinstance(error, OSError) and error.errno:
            failure["errno"] = error.errno
        print(json.dumps({"ok": False, "error": failure}))
        return 1
