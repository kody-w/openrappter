# MemoryAgent

Persistent memory at `~/.openrappter/memory.json`. Actions: `remember`, `recall`, `list`, `forget`.

Memory echoes automatically feed into [[Data Sloshing]], giving all agents awareness of past interactions.

Python splits into `ManageMemoryAgent` (store/forget) and `ContextMemoryAgent` (recall/search).

For advanced memory (chunking, embeddings, hybrid search), see [[Memory System]].

## Files
- `typescript/src/agents/MemoryAgent.ts`
- `python/openrappter/agents/manage_memory_agent.py`

## Related
- [[Memory System]] | [[Data Sloshing]] | [[Agent Index]]

---

#agents #core
