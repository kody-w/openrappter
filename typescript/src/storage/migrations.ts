/**
 * SQLite schema migrations
 */

export interface Migration {
  id: number;
  name: string;
  up: string;
  down: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'initial_schema',
    up: `
      -- Sessions table
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        user_id TEXT,
        metadata TEXT DEFAULT '{}',
        messages TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON sessions(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      -- Memory chunks table
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        source_path TEXT,
        embedding BLOB,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_source ON memory_chunks(source);
      CREATE INDEX IF NOT EXISTS idx_memory_source_path ON memory_chunks(source_path);

      -- FTS for memory chunks
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
        id,
        content,
        source,
        source_path,
        content=memory_chunks,
        content_rowid=rowid
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN
        INSERT INTO memory_chunks_fts(rowid, id, content, source, source_path)
        VALUES (new.rowid, new.id, new.content, new.source, new.source_path);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
        INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, id, content, source, source_path)
        VALUES ('delete', old.rowid, old.id, old.content, old.source, old.source_path);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_chunks_au AFTER UPDATE ON memory_chunks BEGIN
        INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, id, content, source, source_path)
        VALUES ('delete', old.rowid, old.id, old.content, old.source, old.source_path);
        INSERT INTO memory_chunks_fts(rowid, id, content, source, source_path)
        VALUES (new.rowid, new.id, new.content, new.source, new.source_path);
      END;

      -- Cron jobs table
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        message TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        last_run TEXT,
        next_run TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cron_enabled ON cron_jobs(enabled);
      CREATE INDEX IF NOT EXISTS idx_cron_next_run ON cron_jobs(next_run);

      -- Cron logs table
      CREATE TABLE IF NOT EXISTS cron_logs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_cron_logs_job ON cron_logs(job_id);
      CREATE INDEX IF NOT EXISTS idx_cron_logs_started ON cron_logs(started_at);

      -- Devices table
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        public_key TEXT,
        last_seen TEXT NOT NULL,
        trusted INTEGER DEFAULT 0,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_devices_type ON devices(type);
      CREATE INDEX IF NOT EXISTS idx_devices_trusted ON devices(trusted);

      -- Config table
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Migrations table
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `,
    down: `
      DROP TABLE IF EXISTS migrations;
      DROP TABLE IF EXISTS config;
      DROP TABLE IF EXISTS devices;
      DROP TABLE IF EXISTS cron_logs;
      DROP TABLE IF EXISTS cron_jobs;
      DROP TRIGGER IF EXISTS memory_chunks_au;
      DROP TRIGGER IF EXISTS memory_chunks_ad;
      DROP TRIGGER IF EXISTS memory_chunks_ai;
      DROP TABLE IF EXISTS memory_chunks_fts;
      DROP TABLE IF EXISTS memory_chunks;
      DROP TABLE IF EXISTS sessions;
    `,
  },
  {
    id: 2,
    name: 'add_vector_index',
    up: `
      -- Add embedding dimensions column for vector search optimization
      ALTER TABLE memory_chunks ADD COLUMN embedding_dims INTEGER DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_memory_embedding_dims ON memory_chunks(embedding_dims);
    `,
    down: `
      DROP INDEX IF EXISTS idx_memory_embedding_dims;
      -- SQLite doesn't support DROP COLUMN, so we leave the column
    `,
  },
  {
    id: 3,
    name: 'add_session_tokens',
    up: `
      -- Track token usage per session
      ALTER TABLE sessions ADD COLUMN total_tokens INTEGER DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN prompt_tokens INTEGER DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN completion_tokens INTEGER DEFAULT 0;
    `,
    down: `
      -- SQLite doesn't support DROP COLUMN
    `,
  },
  {
    id: 4,
    name: 'add_approval_requests',
    up: `
      -- Approval requests for exec/tool calls
      CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        device_id TEXT,
        tool_name TEXT NOT NULL,
        tool_args TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        approved_by TEXT,
        approved_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approval_requests(status);
      CREATE INDEX IF NOT EXISTS idx_approvals_session ON approval_requests(session_id);
    `,
    down: `
      DROP TABLE IF EXISTS approval_requests;
    `,
  },
  {
    id: 5,
    name: 'add_oauth_tokens',
    up: `
      -- OAuth token storage
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        user_id TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        token_type TEXT DEFAULT 'Bearer',
        scope TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_provider ON oauth_tokens(provider);
      CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_tokens(user_id);
    `,
    down: `
      DROP TABLE IF EXISTS oauth_tokens;
    `,
  },
];

export function getMigration(id: number): Migration | undefined {
  return migrations.find((m) => m.id === id);
}

export function getPendingMigrations(appliedIds: number[]): Migration[] {
  return migrations.filter((m) => !appliedIds.includes(m.id));
}
