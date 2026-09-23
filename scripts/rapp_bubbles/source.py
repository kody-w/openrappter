"""Read only new rows in configured chats; attachment queries follow authorization."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from .config import Config, PortalError, roster_digest


class SQLiteSource:
    def __init__(self, config: Config):
        self.config = config
        try:
            self.db = sqlite3.connect(config.messages_db.as_uri() + "?mode=ro", uri=True, timeout=1)
            self.db.row_factory = sqlite3.Row
            # One row with undecodable text must not stop the reader for every later row.
            self.db.text_factory = lambda value: value.decode("utf-8", "replace")
            self.db.execute("PRAGMA query_only=ON")
            self.db.execute("PRAGMA temp_store=MEMORY")
            self.columns = {row[1] for row in self.db.execute("PRAGMA table_info(message)")}
        except sqlite3.Error as error:
            raise PortalError("messages_unavailable", "Messages is unavailable; check Full Disk Access.") from error

    def close(self) -> None:
        self.db.close()

    def tail(self) -> int:
        try:
            return self.db.execute("SELECT COALESCE(MAX(ROWID), 0) FROM message").fetchone()[0]
        except sqlite3.Error as error:
            raise PortalError("messages_unavailable", "Cannot establish a Messages row watermark.") from error

    def target_matches(self, target: dict) -> bool:
        row = self.db.execute(
            "SELECT guid,service_name,style FROM chat WHERE ROWID=?", (target["chat_id"],)
        ).fetchone()
        allowed = bool(
            row and row["guid"] == target["chat_guid"]
            and str(row["service_name"] or "").strip().casefold() == "imessage"
            and row["style"] == (43 if target.get("is_group") else 45)
        )
        if not allowed:
            return False
        if target.get("is_group"):
            participants = [
                item[0] for item in self.db.execute(
                    "SELECT h.id FROM chat_handle_join j JOIN handle h ON h.ROWID=j.handle_id "
                    "WHERE j.chat_id=?", (target["chat_id"],)
                )
            ]
            return bool(target.get("roster_hash")) and roster_digest(participants) == target["roster_hash"]
        return True

    def direct_target(self, chat_guid: str) -> dict | None:
        """The authorized one-to-one iMessage chat for an operator post, if it exists."""
        row = self.db.execute("SELECT ROWID FROM chat WHERE guid=?", (chat_guid,)).fetchone()
        if row is None:
            return None
        target = {"chat_id": row[0], "chat_guid": chat_guid, "is_group": False}
        return target if self.target_matches(target) else None

    def between(self, chat_guid: str, after: str, before: str | None) -> list[dict] | None:
        """This chat's message rows strictly between two of its rows, or after one to the end
        when ``before`` is None (tapbacks are not messages). None when a row is unknown, the
        range is inverted, or there are more than 50 rows to vouch for."""
        wanted = (after,) if before is None else (after, before)
        ids = {
            row["guid"]: row["id"] for row in self.db.execute(
                f"""SELECT m.guid, m.ROWID AS id FROM message m
                   JOIN chat_message_join j ON j.message_id=m.ROWID
                   JOIN chat c ON c.ROWID=j.chat_id
                   WHERE c.guid=? AND m.guid IN ({",".join("?" * len(wanted))})""", (chat_guid, *wanted),
            )
        }
        if after not in ids or before is not None and (before not in ids or ids[after] >= ids[before]):
            return None
        upper = ids[before] if before is not None else 2**62
        reactions = (
            "AND (m.associated_message_type IS NULL OR m.associated_message_type<2000 "
            "OR m.associated_message_type>3006)"
            if "associated_message_type" in self.columns else ""
        )
        rows = self.db.execute(
            f"""SELECT m.guid, m.is_from_me, h.id AS sender FROM message m
               JOIN chat_message_join j ON j.message_id=m.ROWID
               JOIN chat c ON c.ROWID=j.chat_id
               LEFT JOIN handle h ON h.ROWID=m.handle_id
               WHERE c.guid=? AND m.ROWID>? AND m.ROWID<? {reactions}
               ORDER BY m.ROWID LIMIT 51""", (chat_guid, ids[after], upper),
        ).fetchall()
        # More than 50 rows is too much to vouch for: report it as unknown.
        return None if len(rows) > 50 else [
            {"guid": row["guid"], "is_from_me": bool(row["is_from_me"]), "sender": row["sender"]} for row in rows
        ]

    def latest_prior_guid(self, event: dict) -> str | None:
        # A tapback is not a message: reacting to a card must not break the reply after it.
        reactions = (
            "AND (m.associated_message_type IS NULL OR m.associated_message_type<2000 "
            "OR m.associated_message_type>3006)"
            if "associated_message_type" in self.columns else ""
        )
        row = self.db.execute(
            f"""SELECT m.guid FROM message m
               JOIN chat_message_join j ON j.message_id=m.ROWID
               JOIN chat c ON c.ROWID=j.chat_id
               WHERE c.guid=? AND m.ROWID<? AND m.guid!=? {reactions}
               ORDER BY m.ROWID DESC LIMIT 1""",
            (event["chat_guid"], event["id"], event["guid"]),
        ).fetchone()
        return row["guid"] if row else None

    def _rows(self, condition: str, values: list, limit: int) -> list[dict]:
        routes = []
        bindings = []
        for route in self.config.routes:
            sender_clause = "LOWER(TRIM(h.id))=?"
            if route.allow_from_me:
                sender_clause = f"({sender_clause} OR (m.is_from_me=1 AND IFNULL(h.id,'')='' AND c.style=45))"
            routes.append(f"(c.guid=? AND {sender_clause} AND c.style=?)")
            bindings.extend([route.chat, route.sender, 43 if ";+;" in route.chat and route.allow_group else 45])
        audio = "m.is_audio_message" if "is_audio_message" in self.columns else "0"
        # iOS swipe-to-reply records the quoted message; it binds a reply to that bubble.
        origin = "m.thread_originator_guid" if "thread_originator_guid" in self.columns else "NULL"
        reactions = (
            "AND (m.associated_message_type IS NULL OR m.associated_message_type<2000 "
            "OR m.associated_message_type>3006)"
            if "associated_message_type" in self.columns else ""
        )
        attached = (
            "m.cache_has_attachments" if "cache_has_attachments" in self.columns
            else "EXISTS(SELECT 1 FROM message_attachment_join WHERE message_id=m.ROWID)"
        )
        query = f"""
            SELECT m.ROWID AS id,m.guid,substr(m.text,1,65537) AS text,{audio} AS audio,{origin} AS reply_to,
                   m.date,m.is_from_me,m.service,h.id AS sender,{attached} AS has_attachments,
                   c.ROWID AS chat_id,c.guid AS chat_guid,c.style AS chat_style
            FROM message m JOIN chat_message_join j ON j.message_id=m.ROWID
            JOIN chat c ON c.ROWID=j.chat_id LEFT JOIN handle h ON h.ROWID=m.handle_id
            WHERE ({' OR '.join(routes)})
              AND LOWER(TRIM(c.service_name))='imessage'
              AND LOWER(TRIM(m.service))='imessage' AND ({condition}) {reactions}
            ORDER BY m.ROWID ASC LIMIT ?
        """
        try:
            rows = self.db.execute(query, [*bindings, *values, limit]).fetchall()
            events = []
            for row in rows:
                participants = [
                    item[0] for item in self.db.execute(
                        "SELECT h.id FROM chat_handle_join j JOIN handle h ON h.ROWID=j.handle_id "
                        "WHERE j.chat_id=?", (row["chat_id"],)
                    )
                ]
                events.append({
                    "id": row["id"], "guid": row["guid"],
                    "text": "" if row["audio"] == 1 else row["text"] or "",
                    "needs_native_text": row["text"] is None and row["audio"] != 1,
                    "sender": row["sender"] or "",
                    "is_from_me": bool(row["is_from_me"]) if row["is_from_me"] in (0, 1) else None,
                    "service": row["service"], "chat_id": row["chat_id"],
                    "chat_guid": row["chat_guid"], "is_group": row["chat_style"] == 43,
                    "chat_style": row["chat_style"], "participants": participants,
                    "has_attachments": bool(row["has_attachments"]) or row["audio"] == 1,
                    "reply_to": row["reply_to"] or None,
                    "created_at": datetime.fromtimestamp(
                        (row["date"] or 0) / 1e9 + 978307200, tz=timezone.utc
                    ).isoformat(),
                })
            return events
        except (sqlite3.Error, ValueError, OverflowError) as error:
            raise PortalError("messages_unavailable", "Cannot read the configured Messages route.") from error

    def poll(self, cursor: int, floor: int) -> list[dict]:
        recent = self._rows("m.ROWID>?", [cursor], self.config.events_per_tick)
        # A Messages row can be joined to its chat after a newer row is observed.
        late = self._rows(
            "m.ROWID>? AND m.ROWID<=?", [max(floor, cursor - 128), cursor], 128
        )
        return sorted({(r["id"], r["chat_guid"]): r for r in [*late, *recent]}.values(), key=lambda r: r["id"])

    def attachments(self, event: dict) -> list[dict]:
        try:
            return [
                {
                    "original_path": row["filename"] or "",
                    "filename": row["filename"] or "",
                    "transfer_name": row["transfer_name"] or "",
                    "mime_type": row["mime_type"] or "application/octet-stream",
                    "uti": row["uti"] or "", "total_bytes": row["total_bytes"] or 0,
                }
                for row in self.db.execute(
                    """SELECT a.filename,a.transfer_name,a.mime_type,a.uti,a.total_bytes
                       FROM attachment a JOIN message_attachment_join j ON j.attachment_id=a.ROWID
                       JOIN message m ON m.ROWID=j.message_id
                       JOIN chat_message_join cj ON cj.message_id=m.ROWID
                       JOIN chat c ON c.ROWID=cj.chat_id
                       WHERE m.ROWID=? AND m.guid=? AND c.guid=? ORDER BY a.ROWID""",
                    (event["id"], event["guid"], event["chat_guid"]),
                )
            ]
        except sqlite3.Error as error:
            raise PortalError("attachments_unavailable", "Attachment metadata is not ready.") from error
