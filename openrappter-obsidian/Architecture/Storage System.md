# Storage System

SQLite-based persistence layer using `better-sqlite3`.

## Adapter Types

| Type | Usage | Config |
|------|-------|--------|
| `sqlite` | Production | `{ type: 'sqlite', path: '~/.openrappter/data.db' }` |
| `memory` | Testing | `{ type: 'memory' }` |

## Tables

| Table | Purpose |
|-------|---------|
| **sessions** | Multi-turn conversation state |
| **memory_chunks** | Searchable facts with embeddings |
| **cron_jobs** | Scheduled task definitions |
| **cron_logs** | Execution history |
| **devices** | Connected clients |
| **config** | Key-value settings |

SQLite WAL mode + foreign keys enabled. Schema versioning via `migrations.ts`.

## Files
- `typescript/src/storage/sqlite.ts`
- `typescript/src/storage/types.ts`
- `typescript/src/storage/migrations.ts`
- `typescript/src/storage/index.ts` — Factory

## Related
- [[Memory System]]
- [[Architecture Overview]]

---

#architecture #storage
