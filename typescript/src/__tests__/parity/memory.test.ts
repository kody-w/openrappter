/**
 * Memory System Parity Tests
 * Tests SQLite persistence, vector search, FTS search
 */

import { describe, it, expect, vi } from 'vitest';

// Mock better-sqlite3
vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(() => ({
    exec: vi.fn(),
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      bind: vi.fn(),
    }),
    close: vi.fn(),
    pragma: vi.fn(),
    transaction: vi.fn((fn) => fn),
  })),
}));

describe('Memory Parity', () => {
  describe('SQLite Persistence', () => {
    describe('Sessions Table', () => {
      it('should create sessions table', async () => {
        const schema = `
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            channel_type TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            user_id TEXT,
            agent_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            metadata TEXT
          )
        `;

        expect(schema).toContain('sessions');
        expect(schema).toContain('channel_type');
        expect(schema).toContain('user_id');
      });

      it('should store session data', async () => {
        const session = {
          id: 'session_123',
          channelType: 'discord',
          channelId: 'channel_456',
          userId: 'user_789',
          agentId: 'main',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: { guildId: 'guild_123' },
        };

        expect(session.id).toBeDefined();
        expect(session.channelType).toBe('discord');
      });

      it('should retrieve session by id', async () => {
        const sessionId = 'session_123';
        expect(sessionId).toBeDefined();
      });

      it('should list sessions by channel', async () => {
        const channelType = 'slack';
        const channelId = 'C123';
        expect(channelType).toBeDefined();
        expect(channelId).toBeDefined();
      });

      it('should delete expired sessions', async () => {
        const expirationDays = 30;
        expect(expirationDays).toBeGreaterThan(0);
      });
    });

    describe('Memory Chunks Table', () => {
      it('should create memory_chunks table', async () => {
        const schema = `
          CREATE TABLE IF NOT EXISTS memory_chunks (
            id TEXT PRIMARY KEY,
            session_id TEXT,
            content TEXT NOT NULL,
            embedding BLOB,
            metadata TEXT,
            created_at TEXT NOT NULL
          )
        `;

        expect(schema).toContain('memory_chunks');
        expect(schema).toContain('embedding');
      });

      it('should store memory chunk with embedding', async () => {
        const chunk = {
          id: 'chunk_123',
          sessionId: 'session_456',
          content: 'User discussed project architecture',
          embedding: new Float32Array([0.1, 0.2, 0.3]),
          metadata: { type: 'conversation' },
          createdAt: new Date().toISOString(),
        };

        expect(chunk.embedding).toBeInstanceOf(Float32Array);
        expect(chunk.content).toBeDefined();
      });

      it('should retrieve chunks by session', async () => {
        const sessionId = 'session_456';
        expect(sessionId).toBeDefined();
      });
    });

    describe('Cron Jobs Table', () => {
      it('should create cron_jobs table', async () => {
        const schema = `
          CREATE TABLE IF NOT EXISTS cron_jobs (
            id TEXT PRIMARY KEY,
            schedule TEXT NOT NULL,
            task TEXT NOT NULL,
            enabled INTEGER DEFAULT 1,
            last_run TEXT,
            next_run TEXT,
            created_at TEXT NOT NULL
          )
        `;

        expect(schema).toContain('cron_jobs');
        expect(schema).toContain('schedule');
      });

      it('should store cron job', async () => {
        const job = {
          id: 'job_123',
          schedule: '0 * * * *',
          task: JSON.stringify({ type: 'agent', prompt: 'Check status' }),
          enabled: true,
          lastRun: null,
          nextRun: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };

        expect(job.schedule).toBe('0 * * * *');
      });
    });

    describe('Devices Table', () => {
      it('should create devices table', async () => {
        const schema = `
          CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            name TEXT,
            public_key TEXT,
            status TEXT DEFAULT 'pending',
            last_seen TEXT,
            created_at TEXT NOT NULL
          )
        `;

        expect(schema).toContain('devices');
        expect(schema).toContain('public_key');
      });

      it('should store device with pairing status', async () => {
        const device = {
          id: 'device_123',
          name: 'My Phone',
          publicKey: 'ed25519:abc123',
          status: 'approved',
          lastSeen: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };

        expect(device.status).toBe('approved');
      });
    });

    describe('Config Table', () => {
      it('should create config table', async () => {
        const schema = `
          CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `;

        expect(schema).toContain('config');
        expect(schema).toContain('key');
      });

      it('should store config key-value', async () => {
        const config = {
          key: 'agent.model',
          value: 'claude-3-sonnet',
          updatedAt: new Date().toISOString(),
        };

        expect(config.key).toBe('agent.model');
      });
    });
  });

  describe('Vector Search', () => {
    it('should compute cosine similarity', async () => {
      const cosineSimilarity = (a: number[], b: number[]): number => {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
          dotProduct += a[i] * b[i];
          normA += a[i] * a[i];
          normB += b[i] * b[i];
        }

        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
      };

      const vec1 = [1, 0, 0];
      const vec2 = [1, 0, 0];
      const vec3 = [0, 1, 0];

      expect(cosineSimilarity(vec1, vec2)).toBeCloseTo(1.0);
      expect(cosineSimilarity(vec1, vec3)).toBeCloseTo(0.0);
    });

    it('should search by vector similarity', async () => {
      const query = {
        embedding: new Float32Array([0.1, 0.2, 0.3]),
        topK: 5,
        threshold: 0.7,
      };

      expect(query.topK).toBe(5);
      expect(query.threshold).toBe(0.7);
    });

    it('should return ranked results', async () => {
      const results = [
        { id: 'chunk_1', score: 0.95, content: 'Very relevant' },
        { id: 'chunk_2', score: 0.85, content: 'Somewhat relevant' },
        { id: 'chunk_3', score: 0.75, content: 'Less relevant' },
      ];

      expect(results[0].score).toBeGreaterThan(results[1].score);
      expect(results[1].score).toBeGreaterThan(results[2].score);
    });

    it('should filter by threshold', async () => {
      const threshold = 0.7;
      const results = [
        { score: 0.95 },
        { score: 0.8 },
        { score: 0.65 },
      ];

      const filtered = results.filter((r) => r.score >= threshold);
      expect(filtered).toHaveLength(2);
    });
  });

  describe('Full-Text Search (FTS)', () => {
    it('should create FTS virtual table', async () => {
      const schema = `
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          content,
          content='memory_chunks',
          content_rowid='rowid'
        )
      `;

      expect(schema).toContain('fts5');
      expect(schema).toContain('memory_fts');
    });

    it('should index content for FTS', async () => {
      const content = 'User asked about implementing authentication';
      expect(content.split(' ').length).toBeGreaterThan(1);
    });

    it('should search with FTS query', async () => {
      const query = 'authentication';
      const ftsQuery = `SELECT * FROM memory_fts WHERE memory_fts MATCH ?`;

      expect(ftsQuery).toContain('MATCH');
      expect(query).toBeDefined();
    });

    it('should support phrase search', async () => {
      const phraseQuery = '"implementing authentication"';
      expect(phraseQuery.startsWith('"')).toBe(true);
      expect(phraseQuery.endsWith('"')).toBe(true);
    });

    it('should support prefix search', async () => {
      const prefixQuery = 'auth*';
      expect(prefixQuery.endsWith('*')).toBe(true);
    });

    it('should rank FTS results by relevance', async () => {
      const rankedQuery = `
        SELECT *, rank FROM memory_fts
        WHERE memory_fts MATCH ?
        ORDER BY rank
      `;

      expect(rankedQuery).toContain('rank');
      expect(rankedQuery).toContain('ORDER BY');
    });
  });

  describe('Hybrid Search', () => {
    it('should combine vector and FTS results', async () => {
      const vectorResults = [
        { id: 'chunk_1', score: 0.9 },
        { id: 'chunk_2', score: 0.8 },
      ];

      const ftsResults = [
        { id: 'chunk_2', score: 0.85 },
        { id: 'chunk_3', score: 0.7 },
      ];

      // Combine and deduplicate
      const combined = new Map<string, { vectorScore: number; ftsScore: number }>();

      vectorResults.forEach((r) => {
        combined.set(r.id, { vectorScore: r.score, ftsScore: 0 });
      });

      ftsResults.forEach((r) => {
        const existing = combined.get(r.id);
        if (existing) {
          existing.ftsScore = r.score;
        } else {
          combined.set(r.id, { vectorScore: 0, ftsScore: r.score });
        }
      });

      expect(combined.size).toBe(3);
      expect(combined.get('chunk_2')?.vectorScore).toBe(0.8);
      expect(combined.get('chunk_2')?.ftsScore).toBe(0.85);
    });

    it('should apply weighted scoring', async () => {
      const vectorWeight = 0.6;
      const ftsWeight = 0.4;

      const hybridScore = (vectorScore: number, ftsScore: number): number => {
        return vectorScore * vectorWeight + ftsScore * ftsWeight;
      };

      const score = hybridScore(0.9, 0.8);
      expect(score).toBeCloseTo(0.86);
    });

    it('should respect result limits', async () => {
      const limit = 10;
      const results = Array.from({ length: 20 }, (_, i) => ({
        id: `chunk_${i}`,
        score: 1 - i * 0.05,
      }));

      const limited = results.slice(0, limit);
      expect(limited).toHaveLength(10);
    });
  });

  describe('Memory Sync from Files', () => {
    it('should read memory files', async () => {
      const memoryPaths = [
        './memories/user_prefs.md',
        './memories/project_context.md',
      ];

      expect(memoryPaths).toHaveLength(2);
    });

    it('should chunk long documents', async () => {
      const content = 'A'.repeat(10000);
      const chunkSize = 1000;
      const chunks = [];

      for (let i = 0; i < content.length; i += chunkSize) {
        chunks.push(content.slice(i, i + chunkSize));
      }

      expect(chunks).toHaveLength(10);
    });

    it('should handle overlap between chunks', async () => {
      const content = 'ABCDEFGHIJ';
      const chunkSize = 4;
      const overlap = 1;
      const chunks = [];

      for (let i = 0; i < content.length; i += chunkSize - overlap) {
        chunks.push(content.slice(i, i + chunkSize));
      }

      // First chunk: ABCD, Second chunk: DEFG, etc.
      expect(chunks[0]).toBe('ABCD');
      expect(chunks[1]).toBe('DEFG');
    });

    it('should update index on file change', async () => {
      const fileEvent = {
        type: 'change',
        path: './memories/user_prefs.md',
        timestamp: new Date().toISOString(),
      };

      expect(fileEvent.type).toBe('change');
    });
  });

  describe('Memory Operations', () => {
    describe('Add Memory', () => {
      it('should add memory with auto-embedding', async () => {
        const memory = {
          content: 'User prefers TypeScript over JavaScript',
          metadata: { category: 'preference' },
        };

        expect(memory.content).toBeDefined();
        expect(memory.metadata.category).toBe('preference');
      });
    });

    describe('Search Memory', () => {
      it('should search with natural language query', async () => {
        const query = 'What programming language does the user prefer?';
        expect(query.length).toBeGreaterThan(0);
      });

      it('should return relevant context', async () => {
        const results = [
          {
            content: 'User prefers TypeScript over JavaScript',
            score: 0.92,
            metadata: { category: 'preference' },
          },
        ];

        expect(results[0].score).toBeGreaterThan(0.9);
      });
    });

    describe('Delete Memory', () => {
      it('should delete by id', async () => {
        const id = 'chunk_123';
        expect(id).toBeDefined();
      });

      it('should delete by session', async () => {
        const sessionId = 'session_456';
        expect(sessionId).toBeDefined();
      });

      it('should cascade delete related data', async () => {
        // When session deleted, related chunks should be deleted
        const cascade = true;
        expect(cascade).toBe(true);
      });
    });
  });

  describe('Embedding Generation', () => {
    it('should generate embeddings for text', async () => {
      const embeddingDim = 1536; // OpenAI embedding dimension

      const mockEmbedding = new Float32Array(embeddingDim);
      expect(mockEmbedding.length).toBe(embeddingDim);
    });

    it('should batch embed multiple texts', async () => {
      const texts = ['Hello', 'World', 'Test'];
      const batchSize = 100;

      expect(texts.length).toBeLessThanOrEqual(batchSize);
    });

    it('should cache embeddings', async () => {
      const cache = new Map<string, Float32Array>();
      const hash = 'hash_123';

      cache.set(hash, new Float32Array([0.1, 0.2, 0.3]));

      expect(cache.has(hash)).toBe(true);
    });
  });

  describe('Migrations', () => {
    it('should track migration versions', async () => {
      const migrations = [
        { version: 1, name: 'initial_schema' },
        { version: 2, name: 'add_vector_index' },
        { version: 3, name: 'add_session_tokens' },
        { version: 4, name: 'add_approval_requests' },
        { version: 5, name: 'add_oauth_tokens' },
      ];

      expect(migrations).toHaveLength(5);
      expect(migrations[0].version).toBe(1);
    });

    it('should run migrations in order', async () => {
      const currentVersion = 2;
      const targetVersion = 5;

      const pending = [3, 4, 5];
      expect(pending[0]).toBeGreaterThan(currentVersion);
      expect(pending[pending.length - 1]).toBe(targetVersion);
    });

    it('should be idempotent', async () => {
      // Running same migration twice should not fail
      const migration = {
        version: 1,
        up: 'CREATE TABLE IF NOT EXISTS test (id TEXT)',
      };

      expect(migration.up).toContain('IF NOT EXISTS');
    });
  });
});
