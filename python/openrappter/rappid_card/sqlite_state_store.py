"""Durable transactional replay and trust-sequence state."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any, Dict

from .types import DurableCardStateStore, RappidCardError


class SqliteCardStateStore(DurableCardStateStore):
    def __init__(self, database_path: str, replay_limit: int = 10_000) -> None:
        if (
            database_path == ":memory:"
            or not isinstance(replay_limit, int)
            or isinstance(replay_limit, bool)
            or replay_limit < 1
        ):
            raise RappidCardError(
                "state_store_invalid",
                "production replay state requires a durable SQLite file and positive limit",
            )
        self.path = str(Path(database_path).resolve())
        self.replay_limit = replay_limit
        parent = Path(self.path).parent
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(parent, 0o700)
        self._database = sqlite3.connect(
            self.path,
            timeout=5.0,
            isolation_level=None,
        )
        self._database.execute("PRAGMA journal_mode = WAL")
        self._database.execute("PRAGMA synchronous = FULL")
        self._database.executescript(
            """
            CREATE TABLE IF NOT EXISTS rappid_card_policy_state (
              policy_id TEXT PRIMARY KEY,
              sequence INTEGER NOT NULL,
              document_hash TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rappid_card_authorization_state (
              policy_id TEXT NOT NULL,
              authorization_id TEXT NOT NULL,
              sequence INTEGER NOT NULL,
              document_hash TEXT NOT NULL,
              PRIMARY KEY (policy_id, authorization_id)
            );
            CREATE TABLE IF NOT EXISTS rappid_card_revocation_state (
              policy_id TEXT PRIMARY KEY,
              sequence INTEGER NOT NULL,
              document_hash TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rappid_card_replay (
              nonce TEXT PRIMARY KEY,
              policy_id TEXT NOT NULL,
              manifest_hash TEXT NOT NULL,
              accepted_at INTEGER NOT NULL
            );
            """
        )
        os.chmod(self.path, 0o600)

    def record_policy(
        self, policy_id: str, sequence: int, document_hash: str
    ) -> None:
        database = self._database
        try:
            database.execute("BEGIN IMMEDIATE")
            current = self._state("rappid_card_policy_state", policy_id)
            if sequence < (current["sequence"] if current else -1):
                raise RappidCardError(
                    "policy_rollback", "signed policy sequence moved backwards"
                )
            if (
                current
                and sequence == current["sequence"]
                and document_hash != current["document_hash"]
            ):
                raise RappidCardError(
                    "policy_equivocation",
                    "signed policy changed without advancing its sequence",
                )
            database.execute(
                """
                INSERT INTO rappid_card_policy_state
                  (policy_id, sequence, document_hash)
                VALUES (?, ?, ?)
                ON CONFLICT(policy_id) DO UPDATE SET
                  sequence = excluded.sequence,
                  document_hash = excluded.document_hash
                """,
                (policy_id, sequence, document_hash),
            )
            database.execute("COMMIT")
        except Exception:
            if database.in_transaction:
                database.execute("ROLLBACK")
            raise

    def record(
        self, trust_state: Dict[str, Any], claim_nonce: bool
    ) -> None:
        database = self._database
        try:
            database.execute("BEGIN IMMEDIATE")
            policy_state = self._state(
                "rappid_card_policy_state", trust_state["policyId"]
            )
            authorization_state = self._authorization_state(
                trust_state["policyId"], trust_state["authorizationId"]
            )
            revocation_state = self._state(
                "rappid_card_revocation_state", trust_state["policyId"]
            )
            if trust_state["policySequence"] < (
                policy_state["sequence"] if policy_state else -1
            ):
                raise RappidCardError(
                    "policy_rollback", "signed policy sequence moved backwards"
                )
            if (
                policy_state
                and trust_state["policySequence"] == policy_state["sequence"]
                and trust_state["policyHash"]
                != policy_state["document_hash"]
            ):
                raise RappidCardError(
                    "policy_equivocation",
                    "signed policy changed without advancing its sequence",
                )
            if trust_state["authorizationSequence"] < (
                authorization_state["sequence"]
                if authorization_state
                else -1
            ):
                raise RappidCardError(
                    "authorization_rollback",
                    "signed authorization sequence moved backwards",
                )
            if (
                authorization_state
                and trust_state["authorizationSequence"]
                == authorization_state["sequence"]
                and trust_state["authorizationHash"]
                != authorization_state["document_hash"]
            ):
                raise RappidCardError(
                    "authorization_equivocation",
                    "signed authorization changed without advancing its sequence",
                )
            if trust_state["revocationSequence"] < (
                revocation_state["sequence"] if revocation_state else -1
            ):
                raise RappidCardError(
                    "revocation_rollback",
                    "signed revocation sequence moved backwards",
                )
            if (
                revocation_state
                and trust_state["revocationSequence"]
                == revocation_state["sequence"]
                and trust_state["revocationHash"]
                != revocation_state["document_hash"]
            ):
                raise RappidCardError(
                    "revocation_equivocation",
                    "signed revocation view changed without advancing its sequence",
                )
            if database.execute(
                "SELECT 1 FROM rappid_card_replay WHERE nonce = ?",
                (trust_state["nonce"],),
            ).fetchone():
                raise RappidCardError(
                    "duplicate_nonce", "card nonce has already been accepted"
                )
            database.execute(
                """
                INSERT INTO rappid_card_policy_state
                  (policy_id, sequence, document_hash)
                VALUES (?, ?, ?)
                ON CONFLICT(policy_id) DO UPDATE SET
                  sequence = excluded.sequence,
                  document_hash = excluded.document_hash
                """,
                (
                    trust_state["policyId"],
                    trust_state["policySequence"],
                    trust_state["policyHash"],
                ),
            )
            database.execute(
                """
                INSERT INTO rappid_card_authorization_state
                  (policy_id, authorization_id, sequence, document_hash)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(policy_id, authorization_id)
                DO UPDATE SET
                  sequence = excluded.sequence,
                  document_hash = excluded.document_hash
                """,
                (
                    trust_state["policyId"],
                    trust_state["authorizationId"],
                    trust_state["authorizationSequence"],
                    trust_state["authorizationHash"],
                ),
            )
            database.execute(
                """
                INSERT INTO rappid_card_revocation_state
                  (policy_id, sequence, document_hash)
                VALUES (?, ?, ?)
                ON CONFLICT(policy_id) DO UPDATE SET
                  sequence = excluded.sequence,
                  document_hash = excluded.document_hash
                """,
                (
                    trust_state["policyId"],
                    trust_state["revocationSequence"],
                    trust_state["revocationHash"],
                ),
            )
            if claim_nonce:
                database.execute(
                    """
                    INSERT INTO rappid_card_replay
                      (nonce, policy_id, manifest_hash, accepted_at)
                    VALUES (?, ?, ?, CAST(strftime('%s', 'now') AS INTEGER))
                    """,
                    (
                        trust_state["nonce"],
                        trust_state["policyId"],
                        trust_state["manifestHash"],
                    ),
                )
                count = database.execute(
                    "SELECT COUNT(*) FROM rappid_card_replay"
                ).fetchone()[0]
                if count > self.replay_limit:
                    database.execute(
                        """
                        DELETE FROM rappid_card_replay
                        WHERE rowid IN (
                          SELECT rowid FROM rappid_card_replay
                          ORDER BY accepted_at, rowid
                          LIMIT ?
                        )
                        """,
                        (count - self.replay_limit,),
                    )
            database.execute("COMMIT")
        except Exception:
            if database.in_transaction:
                database.execute("ROLLBACK")
            raise

    def close(self) -> None:
        self._database.close()

    def _state(self, table: str, policy_id: str) -> Any:
        row = self._database.execute(
            f"SELECT sequence, document_hash FROM {table} WHERE policy_id = ?",
            (policy_id,),
        ).fetchone()
        return (
            {"sequence": int(row[0]), "document_hash": str(row[1])}
            if row is not None
            else None
        )

    def _authorization_state(
        self, policy_id: str, authorization_id: str
    ) -> Any:
        row = self._database.execute(
            """
            SELECT sequence, document_hash
            FROM rappid_card_authorization_state
            WHERE policy_id = ? AND authorization_id = ?
            """,
            (policy_id, authorization_id),
        ).fetchone()
        return (
            {"sequence": int(row[0]), "document_hash": str(row[1])}
            if row is not None
            else None
        )
