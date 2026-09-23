"""Operator feed: durable status posts into the authorized thread, with bounded reply capture.

Local agents post progress (text, optionally with one image or file) through the same
durable outbox and receipt reconciliation the portal uses for task results. A post can offer
numbered choices. The owner's next message is captured as its answer only when it directly
follows the post in that chat, so replies meant for other AIs in a shared thread are left
alone. ``RAPP reply <text>`` answers the latest open post explicitly.
"""

from __future__ import annotations

import hashlib
import mimetypes
import re
import uuid
from pathlib import Path

from .config import PortalError
from .files import copy_reference, filename
from .outbox import Outbox, token

LIFECYCLE = re.compile(
    r"restart|reboot|fresh start|shut ?down|sleep claude|kill claude|stop claude|"
    r"wake ?up|hey claude|start up|come alive|wake$",
    re.IGNORECASE | re.MULTILINE,
)
MAX_TEXT = 2400
MAX_OPTIONS = 9
KEEP_POSTS = 200
# A post whose delivery is never confirmed lapses after its reply window plus the receipt window,
# instead of taking answers (days later) for ever.
PENDING_GRACE = 180


def _parts(store, post):
    return [part for part in store.data["outbox"] if part["group"] == post["group"]]


def drop_queued_copies(store, post, *, original: bool = False) -> bool:
    """Drop the copies of a post (shown again after a refused answer) that have not left the
    Mac yet: a closed or replaced post must not come back, and only the newest copy waits.
    With ``original``, the post's own unsent bubbles go too (it lapsed before it was sent)."""
    copies = set(post.get("aliases", ())) | ({post["group"]} if original else set())
    stale = [part for part in store.data["outbox"] if part["group"] in copies and part["state"] == "queued"]
    for part in stale:
        if "file" in part:
            Path(part["file"]["path"]).unlink(missing_ok=True)
    store.data["outbox"] = [part for part in store.data["outbox"] if part not in stale]
    return bool(stale)


def post(store, outbox: Outbox, actor: dict, target: dict, *, text: str, file: str | None = None,
         options: int = 0, ttl: float = 300, channel: str = "loop", now: float) -> dict:
    if not text.strip() and not file:
        raise PortalError("feed_empty", "A feed post needs text or a file.")
    if len(text) > MAX_TEXT:
        raise PortalError("feed_too_long", f"Feed text is limited to {MAX_TEXT} characters.")
    if not 0 <= options <= MAX_OPTIONS or not 0 < ttl <= 86400:
        raise PortalError("feed_invalid", "Options must be 0-9 and the reply window 1s-24h.")
    if (
        not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", channel) or channel in ("sys", "artifact")
        or re.fullmatch(r"[0-9a-f]{4,6}", channel)
    ):
        # Line one starts [RAPP <channel>]; a channel must never look like a task's or a system card's.
        raise PortalError("feed_invalid", "Channel names are 1-32 lowercase letters, digits, or hyphens, "
                          "starting with a letter, and never sys, artifact, or a short hex ref.")
    feed = store.data.setdefault("feed", {})
    post_id = "post-" + uuid.uuid4().hex[:12]
    for other in feed.values():
        if other["channel"] != channel or other["state"] not in ("pending", "open", "delivered"):
            continue
        # A newer update replaces any older card that has not left this Mac yet, so an
        # iMessage outage never releases a burst of stale cards when it recovers. A card
        # already on the phone stays answerable; adjacency decides which one a reply meant.
        stale = [part for part in _bubbles(store, other) if part["state"] == "queued"]
        for part in stale:
            if "file" in part:
                Path(part["file"]["path"]).unlink(missing_ok=True)
        store.data["outbox"] = [part for part in store.data["outbox"] if part not in stale]
        if not _parts(store, other):
            other.update(state="superseded", superseded_by=post_id)
    group = "feed:" + post_id
    identity = token(group + ":0")
    # Every portal-sent text starts with "[RAPP " so the legacy watcher never acts on an echo;
    # the post's own first line shares line one, which is what the lock screen shows.
    envelope = f"[RAPP {channel}] "
    if file:
        source = Path(file).expanduser().resolve(strict=True)
        digest, size = hashlib.sha256(), 0
        with source.open("rb") as stream:
            for block in iter(lambda: stream.read(1 << 20), b""):
                digest.update(block)
                size += len(block)
        destination = outbox.config.state_dir / "outbox" / identity / f"rapp-{identity}-{filename(source.name)}"
        reference = copy_reference(source, (source.parent,), destination, outbox.config.max_file_bytes,
                                   expected_sha256=digest.hexdigest(), expected_size=size)
        part = outbox._part(group, 0, identity, actor, target, None, file=reference,
                            mime=mimetypes.guess_type(source.name)[0] or "application/octet-stream",
                            caption=envelope + (text.strip() or source.name))
    else:
        part = outbox._part(group, 0, identity, actor, target, None, text=envelope + text)
    store.data["outbox"].append(part)
    feed[post_id] = {
        "id": post_id, "channel": channel, "group": group, "actor": dict(actor),
        "target": dict(target), "created_at": now, "options": options, "ttl": ttl,
        "state": "pending", "answer": None,
    }
    if len(feed) > KEEP_POSTS:
        for old in sorted(feed.values(), key=lambda value: value["created_at"])[:len(feed) - KEEP_POSTS]:
            if old["state"] not in ("pending", "open"):
                feed.pop(old["id"], None)
    store.save()
    return feed[post_id]


def refresh(store, now: float) -> None:
    changed = False
    for item in store.data.get("feed", {}).values():
        if item["state"] not in ("pending", "open"):
            continue
        parts = _parts(store, item)
        if item["state"] == "pending":
            if parts and all(part["state"] in ("sent", "delivered") for part in parts):
                item.update(state="open" if item["options"] else "delivered", delivered_at=now,
                            open_until=now + item["ttl"])
                changed = True
            elif any(part["state"] == "failed" for part in parts):
                item.update(state="failed")
                drop_queued_copies(store, item)
                changed = True
            elif not _live(item, now):
                # Never confirmed on the phone in time: it lapses, and what has not gone yet stays.
                item.update(state="expired", lapsed=True)
                drop_queued_copies(store, item, original=True)
                changed = True
        elif item["state"] == "open" and now > item["open_until"]:
            item["state"] = "expired"
            drop_queued_copies(store, item)
            changed = True
    if changed:
        store.save()


def post_for_group(store, group: str) -> dict | None:
    """The post a bubble belongs to: its own bubble, or a copy shown again after a refusal."""
    return next((item for item in store.data.get("feed", {}).values()
                 if item["group"] == group or group in item.get("aliases", ())), None)


def _bubbles(store, post):
    groups = {post["group"], *post.get("aliases", ())}
    return [part for part in store.data["outbox"] if part["group"] in groups]


def _live(item: dict, now: float) -> bool:
    if item["state"] == "pending":
        return now <= item["created_at"] + item["ttl"] + PENDING_GRACE
    return item["state"] == "open" and item.get("open_until", 0) >= now


def is_open(item: dict, actor: dict, now: float) -> bool:
    """Whether a post still takes an answer from this actor."""
    return bool(_live(item, now) and item["options"] and item["actor"] == actor)


def capture(store, event: dict, actor: dict, text: str, now: float, *,
            prior=None, explicit: bool = False, post_id: str | None = None, guard=None) -> dict | None:
    """Record the owner's answer to the latest open post.

    ``prior`` is a callable returning the GUID of the message just before this one; it is
    only called when a post is waiting. A post whose receipt bookkeeping has not caught up
    yet (still pending) can already be answered, because adjacency is proven by GUID.
    """
    candidates = [item for item in store.data.get("feed", {}).values() if is_open(item, actor, now)]
    if not candidates:
        return None
    has_files = event.get("has_attachments") is True or bool(event.get("attachments"))
    if not explicit:
        # The card directly above the reply, not the newest one: a newer card may still be
        # queued while the owner answers the one on the phone.
        before = prior() if callable(prior) else prior
        adjacent = [
            item for item in candidates if before and before in {
                value for part in _bubbles(store, item)
                for value in (part.get("guid"), part.get("caption_guid")) if value
            }
        ]
        if not adjacent:
            return None
        item = adjacent[0]
        if LIFECYCLE.search(text.strip()) or not (text.strip() or has_files):
            return None
    else:
        if post_id is not None:
            candidates = [item for item in candidates if item["id"] == post_id]
        # Only a post that reached the phone can be answered: a newer one still waiting to be
        # sent must not take the answer to the one the owner is looking at.
        shown = [item for item in candidates if any(
            part.get("guid") or part.get("caption_guid") for part in _bubbles(store, item))]
        if not shown:
            return None
        item = max(shown, key=lambda value: value["created_at"])
    if guard is not None and not guard(item):
        # The caller judged that this answer cannot have been meant for this post.
        return None
    stripped = text.strip()
    # ASCII only: "²" or "①" pass str.isdigit() but crash int() and would wedge every tick.
    number = int(stripped) if re.fullmatch(r"[1-9]", stripped) and int(stripped) <= item["options"] else None
    item.update(state="answered", answer={
        "text": stripped[:2000], "number": number, "guid": event.get("guid"),
        "rowid": event.get("id"), "at": now, "explicit": explicit, "has_attachments": has_files,
    })
    drop_queued_copies(store, item)
    store.save()
    return item


def describe(store, post_id: str | None = None) -> list[dict]:
    items = store.data.get("feed", {})
    selected = [items[post_id]] if post_id in items else [] if post_id else sorted(
        items.values(), key=lambda value: value["created_at"])[-10:]
    return [{
        "id": item["id"], "channel": item["channel"], "state": item["state"], "options": item["options"],
        "open_until": item.get("open_until"), "answer": item["answer"], "lapsed": bool(item.get("lapsed")),
        "parts": [part["state"] for part in _parts(store, item)],
        # Every time the post was shown (again after a refused answer), and why answers were refused.
        "showings": [{"ref": token(f"{group}:0")[:6], "parts": [part["state"] for part in store.data["outbox"]
                                                               if part["group"] == group]}
                     for group in [item["group"], *item.get("aliases", ())]],
        "refusals": list(item.get("refusals", ())),
    } for item in selected]
