"""
ContextMemoryAgent - Memory recall agent for retrieving stored memories.

Recalls and provides context based on stored memories from past interactions.
Uses local JSON file storage (no external dependencies).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from openrappter.agents.basic_agent import BasicAgent


class ContextMemoryAgent(BasicAgent):
    """
    Agent for recalling and searching memories.
    
    Retrieves memories with optional filtering by keywords, recency, or full recall.
    Uses ~/.openrappter/memory.json for persistence.
    """
    
    def __init__(self):
        self.name = 'ContextMemory'
        self.metadata = {
            "name": self.name,
            "description": "Recalls and provides context based on stored memories of past interactions. Use this to remember what was discussed before.",
            "parameters": {
                "type": "object",
                "properties": {
                    "max_messages": {
                        "type": "integer",
                        "description": "Maximum number of memories to return. Default is 10."
                    },
                    "keywords": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of keywords to filter memories by."
                    },
                    "full_recall": {
                        "type": "boolean",
                        "description": "Return all memories without filtering. Default is false."
                    },
                    "query": {
                        "type": "string",
                        "description": "Search query to find relevant memories."
                    }
                },
                "required": []
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)
        
        # Storage setup
        self.home = Path.home() / ".openrappter"
        self.memory_file = self.home / "memory.json"
    
    def perform(self, **kwargs):
        """Recall memories based on parameters."""
        max_messages = kwargs.get('max_messages', 10)
        keywords = kwargs.get('keywords', [])
        full_recall = kwargs.get('full_recall', False)
        query = kwargs.get('query', '')
        trusted_context = self._trusted_context(kwargs.get("_trusted_context"))
        
        # If query provided, extract keywords from it
        if query and not keywords:
            keywords = [w for w in query.lower().split() if len(w) > 3]
        
        # Default to full recall if no specific parameters
        if not keywords and 'max_messages' not in kwargs:
            full_recall = True
        
        return self._recall_context(
            max_messages,
            keywords,
            full_recall,
            trusted_context=trusted_context,
        )
    
    def _load_memories(self) -> dict:
        """Load memories from file."""
        if self.memory_file.exists():
            try:
                return json.loads(self.memory_file.read_text())
            except json.JSONDecodeError:
                return {}
        return {}
    
    def _recall_context(
        self,
        max_messages: int,
        keywords: list,
        full_recall: bool,
        trusted_context: Mapping[str, Any] | None = None,
    ) -> str:
        """Recall memories with optional filtering."""
        memories = self._load_memories()
        context = self._trusted_context(trusted_context)
        
        if not memories:
            return json.dumps({
                "status": "success",
                "message": "No memories stored yet.",
                "memories": []
            })
        
        # Convert to list
        all_memories = [item for item in memories.values() if isinstance(item, Mapping)]
        memory_list = [
            item for item in all_memories if self._is_authorized(item, context)
        ]
        familiar = any(
            context["principal_id"] in self._memory_principals(item)
            for item in all_memories
        )
        
        # Full recall - return all sorted by date
        if full_recall:
            sorted_memories = sorted(
                memory_list,
                key=lambda x: (x.get('date', ''), x.get('time', '')),
                reverse=True
            )
            
            formatted = self._format_memories(sorted_memories)
            return json.dumps({
                "status": "success",
                "message": f"All memories ({len(sorted_memories)}):",
                "formatted": formatted,
                "memories": self._project_memories(sorted_memories),
                "familiar": familiar,
            })
        
        # Filter by keywords
        if keywords:
            filtered = []
            for mem in memory_list:
                content = mem.get('message', '').lower()
                theme = mem.get('theme', '').lower()
                tags = [t.lower() for t in mem.get('tags', [])]
                
                # Check if any keyword matches
                for kw in keywords:
                    kw_lower = kw.lower()
                    if kw_lower in content or kw_lower in theme or kw_lower in tags:
                        filtered.append(mem)
                        break
            
            if filtered:
                # Sort by relevance (more keyword matches = higher)
                sorted_filtered = sorted(
                    filtered,
                    key=lambda x: sum(
                        1 for kw in keywords 
                        if kw.lower() in x.get('message', '').lower()
                    ),
                    reverse=True
                )[:max_messages]
                
                formatted = self._format_memories(sorted_filtered)
                return json.dumps({
                    "status": "success",
                    "message": f"Found {len(sorted_filtered)} memories matching: {', '.join(keywords)}",
                    "formatted": formatted,
                    "memories": self._project_memories(sorted_filtered),
                    "familiar": familiar,
                })
        
        # No keywords, return most recent
        sorted_memories = sorted(
            memory_list,
            key=lambda x: (x.get('date', ''), x.get('time', '')),
            reverse=True
        )[:max_messages]
        
        formatted = self._format_memories(sorted_memories)
        return json.dumps({
            "status": "success",
            "message": f"Recent memories ({len(sorted_memories)}):",
            "formatted": formatted,
            "memories": self._project_memories(sorted_memories),
            "familiar": familiar,
        })
    
    def _format_memories(self, memories: list) -> str:
        """Format memories for display."""
        lines = []
        for mem in memories:
            message = mem.get('message', '')
            theme = mem.get('theme', 'unknown')
            date = mem.get('date', '')
            time = mem.get('time', '')
            
            if date and time:
                lines.append(f"• {message} (Type: {theme}, Recorded: {date} {time})")
            else:
                lines.append(f"• {message} (Type: {theme})")
        
        return "\n".join(lines) if lines else "No memories found."
    
    def search(self, query: str, limit: int = 5) -> str:
        """Search memories by content similarity."""
        memories = self._load_memories()
        
        if not memories:
            return json.dumps({
                "status": "success",
                "message": "No memories to search.",
                "memories": []
            })
        
        query_lower = query.lower()
        query_words = set(query_lower.split())
        
        scored = []
        for mem in memories.values():
            content = mem.get('message', '').lower()
            content_words = set(content.split())
            
            # Score based on word overlap
            overlap = len(query_words & content_words)
            if overlap > 0 or query_lower in content:
                score = overlap + (2 if query_lower in content else 0)
                scored.append((score, mem))
        
        # Sort by score
        scored.sort(key=lambda x: -x[0])
        results = [m for _, m in scored[:limit]]
        
        if results:
            formatted = self._format_memories(results)
            return json.dumps({
                "status": "success",
                "message": f"Found {len(results)} relevant memories",
                "formatted": formatted,
                "memories": self._project_memories(results)
            })
        
        return json.dumps({
            "status": "success",
            "message": "No matching memories found.",
            "memories": []
        })

    @staticmethod
    def _project_memories(memories: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                "id": memory.get("id"),
                "message": memory.get("message", ""),
                "theme": memory.get("theme", "unknown"),
            }
            for memory in memories
        ]

    @staticmethod
    def _trusted_context(value: object) -> dict[str, Any]:
        if isinstance(value, Mapping) and value.get("trusted") is True:
            principal = str(value.get("principal_id") or "")
            audience = str(value.get("audience_id") or "")
            if principal and audience:
                return {
                    "trusted": True,
                    "principal_id": principal,
                    "audience_id": audience,
                    "conversation_type": str(value.get("conversation_type") or "dm"),
                    "is_owner": bool(value.get("is_owner")),
                }
        if value is not None:
            return {
                "trusted": False,
                "principal_id": "principal:invalid",
                "audience_id": "audience:denied",
                "conversation_type": "denied",
                "is_owner": False,
            }
        return {
            "trusted": True,
            "principal_id": "principal:local-owner",
            "audience_id": "owner:local",
            "conversation_type": "owner",
            "is_owner": True,
        }

    @staticmethod
    def _memory_principals(memory: Mapping[str, Any]) -> set[str]:
        trust = memory.get("trust")
        if not isinstance(trust, Mapping):
            return {"principal:local-owner"}
        return {
            str(item)
            for item in list(trust.get("custodians", [])) + list(trust.get("subjects", []))
            if str(item)
        }

    def _is_authorized(
        self,
        memory: Mapping[str, Any],
        context: Mapping[str, Any],
    ) -> bool:
        trust = memory.get("trust")
        if not isinstance(trust, Mapping):
            return bool(context["is_owner"])
        if trust.get("visibility") == "public":
            return True
        audience = str(context["audience_id"])
        allowed = {str(item) for item in trust.get("allowed_audiences", [])}
        if audience in allowed:
            return True
        for grant in trust.get("grants", []):
            if (
                isinstance(grant, Mapping)
                and grant.get("audience_id") == audience
                and not grant.get("revoked_at")
            ):
                return True
        # A private relationship follows the same principal across DM transports,
        # but never widens into a group.
        if context["conversation_type"] == "dm":
            principals = self._memory_principals(memory)
            return (
                context["principal_id"] in principals
                and trust.get("origin_type") in ("dm", "owner")
            )
        return False
