"""Command-line entry point for the canonical OpenRappter iMessage service."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

from .config import (
    DEFAULT_CONFIG_PATH,
    IMSG_PINNED_VERSION,
    ConfigError,
    IMessageConfig,
    _atomic_json_write,
    normalize_handle,
)
from .service import IMessageService, IMessageServiceError


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="openrappter-imessage",
        description="Run OpenRappter's iMessage-first RAPP brainstem channel.",
    )
    parser.add_argument(
        "--config",
        default=str(DEFAULT_CONFIG_PATH),
        help="Local JSON configuration path.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="Create a private local configuration.")
    init.add_argument("--owner", action="append", default=[], help="Owner phone/email handle.")
    init.add_argument(
        "--owner-chat",
        action="append",
        default=[],
        help="Owner self-chat id, guid, or identifier.",
    )
    init.add_argument("--allow-dm", action="append", default=[])
    init.add_argument("--allow-group", action="append", default=[])
    init.add_argument(
        "--group-alias",
        action="append",
        default=[],
        metavar="NAME=CHAT_ID",
    )
    init.add_argument(
        "--imsg",
        default=str(Path.home() / ".openrappter" / "bin" / "imsg"),
    )
    init.add_argument("--account-id", default="default")
    init.add_argument("--instance-id")
    init.add_argument("--force", action="store_true")

    commands.add_parser("preflight", help="Check configuration, imsg, and local state.")
    commands.add_parser("status", help="Show content-free runtime state.")
    commands.add_parser("run", help="Run the iMessage service in the foreground.")
    return parser


def _initialize(args: argparse.Namespace) -> int:
    path = Path(args.config).expanduser()
    aliases: dict[str, str] = {}
    for item in args.group_alias:
        if "=" not in item:
            raise ConfigError("group aliases use NAME=CHAT_ID")
        name, target = item.split("=", 1)
        if not name.strip() or not target.strip():
            raise ConfigError("group aliases use non-empty NAME=CHAT_ID")
        aliases[name.strip()] = target.strip()
    owner_chats = list(args.owner_chat)
    if args.owner and not owner_chats:
        owner_chats = _discover_owner_chats(os.path.expanduser(args.imsg), args.owner)
    payload = {
        "rappter_instance_id": args.instance_id or str(uuid.uuid4()),
        "account_id": args.account_id,
        "imsg_path": os.path.expanduser(args.imsg),
        "imsg_version": IMSG_PINNED_VERSION,
        "owner_handles": args.owner,
        "owner_chat_ids": owner_chats,
        "allowed_dm_handles": args.allow_dm,
        "allowed_group_chat_ids": args.allow_group,
        "mention_required": True,
        "mention_tokens": ["@rappter", "@openrappter", "@rapp"],
        "reply_prefix": "🦖 ",
        "identity_links": {},
        "group_aliases": aliases,
        "state_dir": str(path.parent / "state"),
    }
    # Validate before persisting raw transport identifiers.
    IMessageConfig.from_dict(payload)
    if path.exists() and not args.force:
        raise ConfigError(f"configuration already exists: {path}")
    _atomic_json_write(path, payload)
    print(f"Created private iMessage configuration at {path}")
    return 0


def _discover_owner_chats(imsg_path: str, owners: list[str]) -> list[str]:
    result = subprocess.run(
        [imsg_path, "chats", "--limit", "100", "--json"],
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    )
    owner_set = {normalize_handle(item) for item in owners}
    identifiers: list[str] = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        chat = json.loads(line)
        if not isinstance(chat, dict) or chat.get("is_group"):
            continue
        identifier = normalize_handle(str(chat.get("identifier") or ""))
        participants = {
            normalize_handle(str(item))
            for item in chat.get("participants", [])
            if item
        }
        if identifier not in owner_set and participants != owner_set:
            continue
        for key in ("id", "guid", "identifier"):
            value = chat.get(key)
            if value not in (None, "") and str(value) not in identifiers:
                identifiers.append(str(value))
    return identifiers


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "init":
            return _initialize(args)

        config = IMessageConfig.load(args.config)
        service = IMessageService(config)
        if args.command == "preflight":
            result = service.preflight()
            print(json.dumps(result, indent=2))
            return 0 if result["ok"] else 1
        if args.command == "status":
            preflight = service.preflight()
            heartbeat = {}
            try:
                heartbeat = json.loads((config.state_dir / "status.json").read_text())
            except (OSError, json.JSONDecodeError):
                pass
            updated_at = float(heartbeat.get("updated_at") or 0)
            fresh = updated_at > 0 and time.time() - updated_at < 20
            pid = heartbeat.get("pid")
            pid_alive = False
            if isinstance(pid, int) and pid > 0:
                try:
                    os.kill(pid, 0)
                    pid_alive = True
                except OSError:
                    pass
            healthy = (
                preflight["ok"]
                and fresh
                and pid_alive
                and heartbeat.get("lifecycle") == "running"
                and heartbeat.get("ready") is True
            )
            print(json.dumps({
                **preflight,
                **heartbeat,
                "heartbeat_fresh": fresh,
                "pid_alive": pid_alive,
                "healthy": healthy,
            }, indent=2))
            return 0 if healthy else 1
        if args.command == "run":
            service.run_forever()
            return 0
        raise ConfigError(f"unknown command: {args.command}")
    except (
        ConfigError,
        IMessageServiceError,
        OSError,
        subprocess.SubprocessError,
        json.JSONDecodeError,
    ) as error:
        print(f"openrappter-imessage: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
