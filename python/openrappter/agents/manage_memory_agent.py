"""
ManageMemoryAgent - Memory storage agent for persisting facts and preferences.

Stores important information to memory for future reference including
facts, preferences, insights, and tasks. Uses ~/.openrappter/memory.json
for persistence. Stored memories are automatically surfaced during data
sloshing when their content overlaps with the current query.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

from openrappter.agents.basic_agent import BasicAgent


class ManageMemoryAgent(BasicAgent):
    _memory_lock = threading.RLock()

    def __init__(self):
        self.name = 'ManageMemory'
        self.metadata = {
            "name": self.name,
            "description": "Stores important information to memory for future reference. Use this to remember facts, preferences, insights, or tasks.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "Natural-language memory operation. Remember stores a fact; share grants one fact to a specific audience; revoke removes that grant; forget deletes a fact.",
                        "enum": ["remember", "share", "revoke", "forget"]
                    },
                    "memory_type": {
                        "type": "string",
                        "description": "Type of memory to store.",
                        "enum": ["fact", "preference", "insight", "task"]
                    },
                    "content": {
                        "type": "string",
                        "description": "The content to store in memory. Should be a concise statement."
                    },
                    "importance": {
                        "type": "integer",
                        "description": "Importance rating from 1-5, where 5 is most important."
                    },
                    "tags": {
                        "type": "array",
                        "description": "Optional list of tags to categorize this memory."
                    },
                    "memory_id": {
                        "type": "string",
                        "description": "Exact memory id for share, revoke, or forget when known."
                    },
                    "query": {
                        "type": "string",
                        "description": "Words identifying the specific memory to share, revoke, or forget."
                    },
                    "audience": {
                        "type": "string",
                        "description": "For share/revoke: 'current' or a locally configured group alias. Never invent an audience id."
                    },
                    "sensitivity": {
                        "type": "string",
                        "description": "Confidentiality requested by the speaker when storing the memory.",
                        "enum": ["private", "shareable", "public"]
                    }
                },
                "required": ["content"]
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)
        
        # Storage setup
        self.home = Path.home() / ".openrappter"
        self.memory_file = self.home / "memory.json"
        self.home.mkdir(exist_ok=True)
    
    def perform(self, **kwargs):
        """Store or explicitly change disclosure of a memory."""
        with self._memory_lock:
            with self._file_transaction_lock():
                return self._perform_locked(**kwargs)

    def _perform_locked(self, **kwargs):
        action = kwargs.get("action", "remember")
        trusted_context = self._trusted_context(kwargs.get("_trusted_context"))
        if trusted_context.get("trusted") is not True:
            return json.dumps({
                "status": "error",
                "message": "Trusted conversation context is malformed; memory operation denied."
            })
        if action == "share":
            return self._share_memory(
                kwargs.get("memory_id") or kwargs.get("query") or kwargs.get("content", ""),
                kwargs.get("audience", "current"),
                trusted_context,
            )
        if action == "revoke":
            return self._revoke_memory(
                kwargs.get("memory_id") or kwargs.get("query") or kwargs.get("content", ""),
                kwargs.get("audience", "current"),
                trusted_context,
            )
        if action == "forget":
            return self._forget_owned_memory(
                kwargs.get("memory_id") or kwargs.get("query") or kwargs.get("content", ""),
                trusted_context,
            )
        memory_type = kwargs.get('memory_type', 'fact')
        content = kwargs.get('content', kwargs.get('query', ''))
        importance = kwargs.get('importance', 3)
        tags = kwargs.get('tags', [])
        sensitivity = kwargs.get("sensitivity", "private")
        
        if not content:
            return json.dumps({
                "status": "error",
                "message": "No content provided for memory storage."
            })
        
        return self._store_memory(
            memory_type,
            content,
            importance,
            tags,
            trusted_context=trusted_context,
            sensitivity=sensitivity,
        )
    
    def _load_memories(self) -> dict:
        """Load memories from file."""
        if self.memory_file.exists():
            try:
                return json.loads(self.memory_file.read_text())
            except json.JSONDecodeError:
                return {}
        return {}
    
    def _save_memories(self, memories: dict):
        """Save memories to file."""
        self.memory_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.memory_file.with_name(
            f".{self.memory_file.name}.{uuid.uuid4().hex}.tmp"
        )
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(memories, stream, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.memory_file)
            try:
                os.chmod(self.memory_file, 0o600)
            except OSError:
                pass
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass

    @contextmanager
    def _file_transaction_lock(self):
        self.memory_file.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.memory_file.with_suffix(self.memory_file.suffix + ".lock")
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            try:
                import fcntl

                fcntl.flock(descriptor, fcntl.LOCK_EX)
            except ImportError:
                # The iMessage service is macOS-only; retain thread safety on
                # platforms without fcntl for general OpenRappter use.
                pass
            yield
        finally:
            try:
                import fcntl

                fcntl.flock(descriptor, fcntl.LOCK_UN)
            except ImportError:
                pass
            os.close(descriptor)
    
    def _store_memory(
        self,
        memory_type: str,
        content: str,
        importance: int,
        tags: list,
        *,
        trusted_context: Mapping[str, Any] | None = None,
        sensitivity: str = "private",
    ) -> str:
        """Store a memory with metadata."""
        memories = self._load_memories()
        context = self._trusted_context(trusted_context)
        if sensitivity == "public" and context.get("brokered"):
            return json.dumps({
                "status": "error",
                "message": "Public memory requires a separate explicit declassification flow."
            })
        
        # Generate unique ID
        memory_id = str(uuid.uuid4())[:12]
        
        # Create memory entry
        trust = {
            "custodians": [context["principal_id"]],
            "subjects": [context["principal_id"]],
            "origin_audience": context["audience_id"],
            "origin_conversation": context["conversation_id"],
            "origin_type": context["conversation_type"],
            "origin_participants": context["participant_ids"],
            "source_event_id": context.get("transport_event_id"),
            "visibility": "public" if sensitivity == "public" else "private",
            "allowed_audiences": (
                ["public"] if sensitivity == "public" else [context["audience_id"]]
            ),
            "grants": [],
        }
        memories[memory_id] = {
            "id": memory_id,
            "message": content,
            "theme": memory_type,
            "importance": importance,
            "tags": tags,
            "date": datetime.now().strftime("%Y-%m-%d"),
            "time": datetime.now().strftime("%H:%M:%S"),
            "accessed": 0,
            "sensitivity": sensitivity,
            "trust": trust,
        }
        
        self._save_memories(memories)
        
        return json.dumps({
            "status": "success",
            "message": f"Stored {memory_type} memory: \"{content[:50]}{'...' if len(content) > 50 else ''}\"",
            "memory_id": memory_id
        })

    def _share_memory(
        self,
        selector: str,
        audience: str,
        context: Mapping[str, Any],
    ) -> str:
        memories = self._load_memories()
        match = self._find_custodied_memory(memories, selector, context["principal_id"])
        if match is None:
            return json.dumps({
                "status": "error",
                "message": "No memory controlled by the current speaker matched that request."
            })
        memory_id, memory = match
        target = self._resolve_audience(audience, context)
        if target is None:
            return json.dumps({
                "status": "error",
                "message": "That audience is not available in the trusted conversation context."
            })
        if not self._consume_consent(context, "share", memory, target):
            return json.dumps({
                "status": "error",
                "message": "No unused exact disclosure consent matches that fact and audience."
            })
        trust = self._memory_trust(memory)
        now = datetime.now().isoformat()
        active = next(
            (
                grant for grant in trust["grants"]
                if grant.get("audience_id") == target and not grant.get("revoked_at")
            ),
            None,
        )
        if active is None:
            trust["grants"].append({
                "audience_id": target,
                "granted_by": context["principal_id"],
                "granted_at": now,
                "revoked_at": None,
            })
        if target not in trust["allowed_audiences"]:
            trust["allowed_audiences"].append(target)
        memory["trust"] = trust
        self._save_memories(memories)
        return json.dumps({
            "status": "success",
            "message": "Disclosure granted only to the requested audience.",
            "memory_id": memory_id,
            "shared_memory": memory.get("message", ""),
            "audience_id": target,
        })

    def _revoke_memory(
        self,
        selector: str,
        audience: str,
        context: Mapping[str, Any],
    ) -> str:
        memories = self._load_memories()
        match = self._find_custodied_memory(memories, selector, context["principal_id"])
        if match is None:
            return json.dumps({"status": "error", "message": "No controlled memory matched."})
        memory_id, memory = match
        target = self._resolve_audience(audience, context)
        if target is None:
            return json.dumps({"status": "error", "message": "Unknown trusted audience."})
        if not self._consume_consent(context, "revoke", memory, target):
            return json.dumps({
                "status": "error",
                "message": "No unused exact revocation consent matches that fact and audience."
            })
        trust = self._memory_trust(memory)
        now = datetime.now().isoformat()
        revoked = 0
        for grant in trust["grants"]:
            if grant.get("audience_id") == target and not grant.get("revoked_at"):
                grant["revoked_at"] = now
                revoked += 1
        origin = trust.get("origin_audience")
        trust["allowed_audiences"] = [
            item for item in trust["allowed_audiences"]
            if item != target or item == origin
        ]
        memory["trust"] = trust
        self._save_memories(memories)
        return json.dumps({
            "status": "success",
            "message": "Disclosure grant revoked.",
            "memory_id": memory_id,
            "revoked": revoked,
        })

    def _forget_owned_memory(
        self,
        selector: str,
        context: Mapping[str, Any],
    ) -> str:
        memories = self._load_memories()
        match = self._find_custodied_memory(memories, selector, context["principal_id"])
        if match is None:
            return json.dumps({"status": "error", "message": "No controlled memory matched."})
        memory_id, memory = match
        if not self._consume_consent(
            context,
            "forget",
            memory,
            str(context["audience_id"]),
        ):
            return json.dumps({
                "status": "error",
                "message": "No unused exact forget consent matches that fact."
            })
        del memories[memory_id]
        self._save_memories(memories)
        return json.dumps({
            "status": "success",
            "message": "Memory forgotten.",
            "memory_id": memory_id,
        })

    @staticmethod
    def _trusted_context(value: object) -> dict[str, Any]:
        if isinstance(value, Mapping) and value.get("trusted") is True:
            principal = str(value.get("principal_id") or "")
            audience = str(value.get("audience_id") or "")
            conversation = str(value.get("conversation_id") or audience)
            if principal and audience:
                return {
                    "trusted": True,
                    "brokered": True,
                    "principal_id": principal,
                    "audience_id": audience,
                    "conversation_id": conversation,
                    "conversation_type": str(value.get("conversation_type") or "dm"),
                    "participant_ids": [
                        str(item) for item in value.get("participant_ids", [])
                        if str(item)
                    ],
                    "is_owner": bool(value.get("is_owner")),
                    "known_group_audiences": dict(value.get("known_group_audiences", {})),
                    "allowed_share_audiences": [
                        str(item) for item in value.get("allowed_share_audiences", [])
                    ],
                    "consent_action": str(value.get("consent_action") or ""),
                    "consent_capability": (
                        value["consent_capability"]
                        if isinstance(value.get("consent_capability"), Mapping)
                        else None
                    ),
                    "transport_event_id": str(value.get("transport_event_id") or ""),
                }
        if value is not None:
            return {
                "trusted": False,
                "brokered": True,
                "principal_id": "principal:invalid",
                "audience_id": "audience:denied",
                "conversation_id": "audience:denied",
                "conversation_type": "denied",
                "participant_ids": [],
                "is_owner": False,
                "known_group_audiences": {},
                "allowed_share_audiences": [],
                "consent_action": "",
                "consent_capability": None,
                "transport_event_id": "",
            }
        return {
            "trusted": True,
            "brokered": False,
            "principal_id": "principal:local-owner",
            "audience_id": "owner:local",
            "conversation_id": "owner:local",
            "conversation_type": "owner",
            "participant_ids": ["principal:local-owner"],
            "is_owner": True,
            "known_group_audiences": {},
            "allowed_share_audiences": ["owner:local"],
            "consent_action": "",
            "consent_capability": None,
            "transport_event_id": "",
        }

    @staticmethod
    def _memory_trust(memory: Mapping[str, Any]) -> dict[str, Any]:
        raw = memory.get("trust")
        if isinstance(raw, Mapping):
            return {
                "custodians": list(raw.get("custodians", [])),
                "subjects": list(raw.get("subjects", [])),
                "origin_audience": raw.get("origin_audience"),
                "origin_conversation": raw.get("origin_conversation"),
                "origin_type": raw.get("origin_type"),
                "origin_participants": list(raw.get("origin_participants", [])),
                "visibility": raw.get("visibility", "private"),
                "allowed_audiences": list(raw.get("allowed_audiences", [])),
                "grants": [dict(item) for item in raw.get("grants", []) if isinstance(item, Mapping)],
            }
        return {
            "custodians": ["principal:local-owner"],
            "subjects": ["principal:local-owner"],
            "origin_audience": "owner:local",
            "origin_conversation": "owner:local",
            "origin_type": "owner",
            "origin_participants": ["principal:local-owner"],
            "visibility": "private",
            "allowed_audiences": ["owner:local"],
            "grants": [],
        }

    def _find_custodied_memory(
        self,
        memories: Mapping[str, Any],
        selector: str,
        principal_id: str,
    ) -> tuple[str, dict[str, Any]] | None:
        query = str(selector or "").strip().casefold()
        if not query:
            return None
        exact = memories.get(selector)
        candidates: list[tuple[str, dict[str, Any]]] = []
        iterable = [(selector, exact)] if isinstance(exact, dict) else memories.items()
        for memory_id, raw in iterable:
            if not isinstance(raw, dict):
                continue
            trust = self._memory_trust(raw)
            if principal_id not in trust["custodians"]:
                continue
            if memory_id.casefold() == query or query in str(raw.get("message", "")).casefold():
                candidates.append((memory_id, raw))
        return candidates[0] if len(candidates) == 1 else None

    @staticmethod
    def _resolve_audience(audience: str, context: Mapping[str, Any]) -> str | None:
        requested = str(audience or "current").strip()
        if requested.casefold() == "current":
            return str(context["audience_id"])
        aliases = context.get("known_group_audiences", {})
        if requested in aliases:
            requested = str(aliases[requested])
        allowed = set(context.get("allowed_share_audiences", []))
        return requested if requested in allowed else None

    @staticmethod
    def _consume_consent(
        context: Mapping[str, Any],
        action: str,
        memory: Mapping[str, Any],
        audience_id: str,
    ) -> bool:
        capability = context.get("consent_capability")
        valid = (
            context.get("consent_action") == action
            and isinstance(capability, Mapping)
            and not capability.get("consumed")
            and capability.get("action") == action
            and capability.get("principal_id") == context.get("principal_id")
            and capability.get("audience_id") == audience_id
            and capability.get("event_id") == context.get("transport_event_id")
        )
        if not valid:
            return False
        utterance = str(capability.get("utterance") or "").casefold()
        fact = str(memory.get("message") or "").casefold()
        fact_words = {word for word in fact.split() if len(word) > 3}
        utterance_words = {word for word in utterance.split() if len(word) > 3}
        if not (fact_words & utterance_words):
            return False
        try:
            capability["consumed"] = True
        except TypeError:
            return False
        return True
    
    def retrieve_by_tags(self, tags: list) -> str:
        """Retrieve memories matching given tags."""
        memories = self._load_memories()
        
        if not memories:
            return json.dumps({
                "status": "success",
                "message": "No memories found.",
                "memories": []
            })
        
        matches = []
        for mem_id, mem in memories.items():
            mem_tags = mem.get('tags', [])
            mem_theme = mem.get('theme', '').lower()
            
            if any(tag.lower() in [t.lower() for t in mem_tags] for tag in tags):
                matches.append(mem)
            elif any(tag.lower() == mem_theme for tag in tags):
                matches.append(mem)
        
        if matches:
            return json.dumps({
                "status": "success",
                "message": f"Found {len(matches)} memories matching tags: {', '.join(tags)}",
                "memories": matches
            })
        
        return json.dumps({
            "status": "success",
            "message": f"No memories found matching tags: {', '.join(tags)}",
            "memories": []
        })
    
    def retrieve_recent(self, limit: int = 5) -> str:
        """Retrieve most recent memories."""
        memories = self._load_memories()
        
        if not memories:
            return json.dumps({
                "status": "success",
                "message": "No memories found.",
                "memories": []
            })
        
        # Sort by date/time
        sorted_mems = sorted(
            memories.values(),
            key=lambda x: (x.get('date', ''), x.get('time', '')),
            reverse=True
        )[:limit]
        
        return json.dumps({
            "status": "success",
            "message": f"Retrieved {len(sorted_mems)} recent memories",
            "memories": sorted_mems
        })
    
    def delete_memory(self, memory_id: str) -> str:
        """Delete a memory by ID."""
        memories = self._load_memories()
        
        if memory_id in memories:
            del memories[memory_id]
            self._save_memories(memories)
            return json.dumps({
                "status": "success",
                "message": f"Deleted memory {memory_id}"
            })
        
        return json.dumps({
            "status": "error",
            "message": f"Memory not found: {memory_id}"
        })
