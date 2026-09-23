"""What the owner's cards offer, and what a reply would do. Read-only: nothing is sent or run.

An agent operating rapp-bubbles (or the owner, from a shell) sees each recent card's options
as commands, which card `RAPP <n>` answers right now, and what a reply would do before
sending it. The dry run goes through the real routing code on a copy of the journal; the
first call to the task runtime is recorded and stops it, and nothing is saved or sent.
"""

from __future__ import annotations

import re
import time
import uuid
from datetime import datetime, timezone

from . import feed, itui
from .config import Config, PortalError
from .outbox import Outbox, token
from .portal import Portal
from .source import SQLiteSource
from .state import Store

ACTS = ("submit", "approve", "cancel", "retry", "resend")


class _Stop(BaseException):
    """The dry run reached the task runtime, Messages, or a resend: recorded, and stopped there."""


class _Runtime:
    def __init__(self):
        self.calls: list[dict] = []

    def act(self, op: str, job_id: str | None = None):
        self.calls.append({"op": op, "job_id": job_id})
        raise _Stop()

    def profile_policy(self, _profile):
        # Asked only right before a task is submitted for approval.
        self.act("submit")

    def request(self, request):
        self.act(request.get("op"), request.get("job_id"))


class _Native:
    """Messages is never touched: any use is recorded and stops the dry run."""

    def __init__(self, runtime: _Runtime):
        self.runtime = runtime

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        self.runtime.act(f"native {name}")


class _Sandbox(Store):
    """A copy of the journal whose writes go nowhere."""

    def __init__(self, root, data):
        super().__init__(root)
        self.data, self.codes = data, []

    def save(self) -> None:
        return None

    def error(self, code: str, now: float) -> None:
        self.codes.append(code)
        super().error(code, now)


class _Source:
    """The real chat.db reader. The dry-run reply is not in chat.db, so a gap that ends at it
    runs to the end of the chat instead."""

    def __init__(self, source, guid):
        self.source, self.guid = source, guid

    def __getattr__(self, name):
        return getattr(self.source, name)

    def between(self, chat_guid, after, before):
        return self.source.between(chat_guid, after, None if before == self.guid else before)

    def attachments(self, _event):
        return []


def ref(group: str) -> str:
    """The six characters a card shows as its `ref`."""
    return token(f"{group}:0")[:6]


def _owner(config: Config):
    route = next((route for route in config.routes if ";+;" not in route.chat), None)
    if route is None:
        raise PortalError("feed_target", "No authorized direct-message thread.")
    return route, {"sender": route.sender, "chat": route.chat}


def _portal(config: Config, store, clock, source=None, runtime=None) -> Portal:
    runtime = runtime or _Runtime()
    native = _Native(runtime)
    portal = Portal(config, source=source, runtime=runtime, native=native, clock=clock)
    portal.store = store
    portal.outbox = Outbox(config, store, native, clock, source.target_matches if source else (lambda _t: True),
                           source.tail if source else None)

    def retry(_actor, job_id, *, uncertain_part=None):
        # A resend copies files and asks Messages for receipts first: record it and stop.
        runtime.act("resend" if uncertain_part else "retry", job_id)

    portal.outbox.retry = retry
    return portal


def _options(store, part: dict) -> list[dict]:
    """Each number a card offers: its label and the RAPP text that does the same from anywhere
    (None for an agent post, which takes the number only as a reply on it)."""
    if part.get("menu"):
        kind = part.get("menu_kind") or ""
        names = [name for name, _ in itui.MENUS.get(kind, ())]
        return [{
            "n": n, "label": names[n - 1] if n <= len(names) else "",
            "command": f"RAPP {'approve' if command == '1' else 'cancel'} {part.get('job_id')}"
            if kind == "approval" else f"RAPP {command}",
        } for n, command in enumerate(part["menu"], 1)]
    post = feed.post_for_group(store, part["group"])
    text = next((item.get("text") or item.get("caption") or "" for item in store.data["outbox"]
                 if item["group"] == post["group"]), "")
    labels = dict(re.findall(r"^\s*\[?([1-9])[\].)]\s+(.+?)\s*$", text, re.MULTILINE))
    return [{"n": n, "label": labels.get(str(n), ""), "command": None} for n in range(1, post["options"] + 1)]


def describe(config: Config, store, *, limit: int = 10, clock=time.time) -> dict:
    """The owner's recent cards with options, newest first: kind, delivery, whether open, and
    each option; plus the card `RAPP <n>` answers now."""
    _, actor = _owner(config)
    portal, now = _portal(config, store, clock), clock()
    texted = {part["group"] for part in store.data["outbox"] if "text" in part}
    rows, seen = [], set()
    for part in sorted(store.data["outbox"], key=portal._landed, reverse=True):
        if (
            part["group"] in seen or part["actor"] != actor
            or part["state"] not in ("submitted", "sent", "delivered", "unknown")
            or ("file" in part and part["group"] in texted)
        ):
            continue
        card = portal._card(part, actor, now)
        if card is None:
            continue
        seen.add(part["group"])
        rows.append({
            "ref": ref(part["group"]), "job": part.get("job_id"),
            "kind": part.get("menu_kind") or "post", "state": part["state"],
            "landed": datetime.fromtimestamp(portal._landed(part), timezone.utc).isoformat(timespec="seconds"),
            "open": card["open"], "options": _options(store, part),
        })
        if len(rows) >= limit:
            break
    newest = portal._latest_card(actor, 2**62)
    return {"ok": True, "cards": rows,
            "rapp_n": {"ref": ref(newest["group"]), "open": newest["open"]} if newest else None}


def resolve(config: Config, data: dict, text: str, *, reply_to: str | None = None,
            typed_ago: float = 0.0, clock=time.time) -> dict:
    """What `text` would do if the owner sent it now (typed `typed_ago` seconds ago; a
    swipe-reply on the card whose ref is `reply_to`, when given). `data` is a journal copy
    this spends."""
    route, _ = _owner(config)
    source = SQLiteSource(config)
    try:
        target = source.direct_target(route.chat)
        if target is None:
            raise PortalError("feed_target", "The authorized iMessage thread is unavailable.")
        now, guid = clock(), f"DRYRUN-{uuid.uuid4().hex}"
        event = {
            "id": source.tail() + 1, "guid": guid, "text": text, "sender": route.sender,
            "chat_id": target["chat_id"], "chat_guid": route.chat, "service": "iMessage",
            "is_group": False, "is_from_me": False, "chat_style": 45, "participants": [route.sender],
            "has_attachments": False,
            "created_at": datetime.fromtimestamp(now - max(0.0, typed_ago), timezone.utc).isoformat(),
        }
        if reply_to:
            group = next((part["group"] for part in data["outbox"] if ref(part["group"]) == reply_to), None)
            bubbles = [value for part in data["outbox"] if part["group"] == group
                       for value in (part.get("guid") or part.get("caption_guid"),) if value]
            if not bubbles:
                raise PortalError("unknown_ref", "No sent card has that ref.")
            event["reply_to"] = bubbles[-1]
        sandbox, runtime = _Sandbox(config.state_dir, data), _Runtime()
        portal = _portal(config, sandbox, lambda: now, _Source(source, guid), runtime)
        refused = []
        reoffer, post_refusal = portal._reoffer, portal._post_refusal

        def _reoffer(identity, actor, target, part, *, note=None):
            refused.append(note or "That card's options have closed.")
            return reoffer(identity, actor, target, part, note=note)

        def _post_refusal(identity, actor, target, refusal):
            refused.append(refusal[1])
            return post_refusal(identity, actor, target, refusal)

        portal._reoffer, portal._post_refusal = _reoffer, _post_refusal
        before = len(data["outbox"])
        answered = {key for key, item in data.get("feed", {}).items() if item["state"] == "answered"}
        try:
            identity = portal._ingest(event)
            if identity is not None and data["inbox"][identity]["state"] in ("ready", "receiving"):
                portal._advance(identity, data["inbox"][identity])
        except _Stop:
            pass
        groups = list(dict.fromkeys(part["group"] for part in data["outbox"][before:]))
        cards = [(portal.outbox.parts(group)[0].get("text") or "").split("\n", 1)[0] for group in groups]
        answers = sorted(key for key, item in data.get("feed", {}).items()
                         if item["state"] == "answered" and key not in answered)
        would = [f"{call['op']} {call['job_id']}" if call["job_id"] else call["op"] for call in runtime.calls]
        verdict = (
            "acts" if any(call["op"] in ACTS for call in runtime.calls) else "answers" if answers
            else "reoffers" if refused else "fails" if sandbox.codes else "replies" if cards or would
            else "ignored"
        )
        return {"ok": True, "verdict": verdict, "would": would, "answers": answers,
                "refused": refused, "errors": sandbox.codes, "cards": cards}
    finally:
        source.close()
