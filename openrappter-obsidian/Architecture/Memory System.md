# Memory System

Hybrid search over stored knowledge using vector similarity + BM25 full-text ranking.

## Components

- `memory/manager.ts` — MemoryManager: add, search, remove, clear
- `memory/chunker.ts` — Content chunking with overlapping windows
- `memory/embeddings.ts` — Providers: OpenAI, Gemini, Ollama
- `memory/types.ts` — MemoryChunk, SearchResult

## Usage

```typescript
const mm = new MemoryManager();
await mm.add('TypeScript uses strict mode', 'docs', '/path');
const results = await mm.search('TypeScript config', { limit: 5 });
```

## Search Modes

| Mode | How |
|------|-----|
| **Vector** | Cosine similarity on embeddings |
| **BM25** | Full-text ranking |
| **Hybrid** | Both combined (default) |

Python uses simpler JSON at `~/.openrappter/memory.json`.

## Related
- [[MemoryAgent]]
- [[Storage System]]
- [[Data Sloshing]] — Memory echoes feed into sloshing

---

#architecture #memory
