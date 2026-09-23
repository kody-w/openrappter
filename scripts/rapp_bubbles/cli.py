"""One bounded watcher tick; deliberately no daemon/run/server entry point."""

from __future__ import annotations

import argparse
import copy
import json
import os
import time

from . import cards, doctor, feed
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


def record_tick_failure(config, error) -> None:
    """A tiny cause record for a tick that failed as a whole, which saves nothing itself; the
    next good tick names it. On a full disk, at least its time is kept (the file's mtime)."""
    path = config.state_dir / "tick-failure.json"
    now = time.time()
    try:
        previous = json.loads(path.read_text(encoding="utf-8"))
        previous = previous if isinstance(previous, dict) else {}
    except (OSError, ValueError):
        previous = {}
    record = {
        "code": getattr(error, "code", None) or "transport_internal_error", "kind": type(error).__name__,
        "errno": error.errno if isinstance(error, OSError) else None,
        "first": previous.get("first", now), "last": now, "count": int(previous.get("count") or 0) + 1,
    }
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(record, stream)
    except OSError:
        try:
            os.utime(path)
        except OSError:
            pass


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


def status_command(config, store):
    counts = {}
    for part in store.data["outbox"]:
        counts[part["state"]] = counts.get(part["state"], 0) + 1
    return {
        "ok": True, "initialized": store.data["cursor"] is not None,
        "jobs": len(store.data["jobs"]), "outbox": counts,
        "imessage": store.data.get("imessage_health", {}),
        "resources": store.data.get("resources", {}),
        "journal_bytes": (config.state_dir / "transport.json").stat().st_size
        if (config.state_dir / "transport.json").exists() else 0,
        "feed": [item["state"] for item in feed.describe(store)],
        "recent_error_codes": [item["code"] for item in store.data["errors"][-10:]],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="Owner-only private portal JSON configuration")
    parser.add_argument("command", choices=(
        "tick", "check-config", "transport-status", "help-route", "post", "feed-status", "doctor",
        "cards", "resolve",
    ))
    parser.add_argument("--text", default="",
                        help="post: message text, or the file's caption; resolve: the reply to try")
    parser.add_argument("--file", help="post: one image or file to attach")
    parser.add_argument("--options", type=int, default=0,
                        help="post: numbered choices offered; posts with choices collect the reply")
    parser.add_argument("--ttl", type=float, default=300, help="post: reply window after delivery, seconds")
    parser.add_argument("--channel", default="loop", help="post: a newer post replaces undelivered ones here")
    parser.add_argument("--route", type=int, default=0, help="post: index of the authorized route")
    parser.add_argument("--id", help="feed-status: one post id")
    parser.add_argument("--reply-to", help="resolve: the ref of the card the reply is a swipe-reply on")
    parser.add_argument("--typed-ago", type=float, default=0.0,
                        help="resolve: seconds before now the reply was typed")
    args = parser.parse_args(argv)
    try:
        config = Config.load(args.config)
        if args.command == "tick":
            try:
                result = Portal(config).tick()
            except Exception as error:
                if getattr(error, "code", None) != "tick_busy":
                    record_tick_failure(config, error)
                raise
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
        elif args.command == "cards":
            result = locked(config, lambda store: cards.describe(config, store))
        elif args.command == "resolve":
            # A private copy of the journal: the dry run holds no lock and saves nothing.
            data = locked(config, lambda store: copy.deepcopy(store.data))
            result = cards.resolve(config, data, args.text, reply_to=args.reply_to, typed_ago=args.typed_ago)
        elif args.command == "doctor":
            result = doctor.run()
            result["healthy"] = result.pop("ok")
            result["ok"] = True
        else:
            result = locked(config, lambda store: status_command(config, store))
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
