"""
ManageMemoryAgent - Memory management agent for storing memories.

Allows storing facts, preferences, insights, and tasks to persistent memory.
Uses local JSON file storage (no external dependencies).
"""

import json
import uuid
from datetime import datetime
from pathlib import Path

from openrappter.agents.basic_agent import BasicAgent


class ManageMemoryAgent(BasicAgent):
    """
    Agent for storing and managing memories.
    
    Stores memories with metadata like type, importance, and tags.
    Uses ~/.openrappter/memory.json for persistence.
    """
    
    def __init__(self):
        self.name = 'ManageMemory'
        self.metadata = {
            "name": self.name,
            "description": "Stores important information to memory for future reference. Use this to remember facts, preferences, insights, or tasks.",
            "parameters": {
                "type": "object",
                "properties": {
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
                        "description": "Importance rating from 1-5, where 5 is most important.",
                        "minimum": 1,
                        "maximum": 5
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of tags to categorize this memory."
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
        """Store a memory."""
        memory_type = kwargs.get('memory_type', 'fact')
        content = kwargs.get('content', kwargs.get('query', ''))
        importance = kwargs.get('importance', 3)
        tags = kwargs.get('tags', [])
        
        if not content:
            return json.dumps({
                "status": "error",
                "message": "No content provided for memory storage."
            })
        
        return self._store_memory(memory_type, content, importance, tags)
    
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
        self.memory_file.write_text(json.dumps(memories, indent=2))
    
    def _store_memory(self, memory_type: str, content: str, importance: int, tags: list) -> str:
        """Store a memory with metadata."""
        memories = self._load_memories()
        
        # Generate unique ID
        memory_id = str(uuid.uuid4())[:12]
        
        # Create memory entry
        memories[memory_id] = {
            "id": memory_id,
            "message": content,
            "theme": memory_type,
            "importance": importance,
            "tags": tags,
            "date": datetime.now().strftime("%Y-%m-%d"),
            "time": datetime.now().strftime("%H:%M:%S"),
            "accessed": 0
        }
        
        self._save_memories(memories)
        
        return json.dumps({
            "status": "success",
            "message": f"Stored {memory_type} memory: \"{content[:50]}{'...' if len(content) > 50 else ''}\"",
            "memory_id": memory_id
        })
    
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
