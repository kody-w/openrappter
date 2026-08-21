import { chmod, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  DurableCardStateStore,
  RappidCardError,
} from './types.js';
import type { CardTrustStateInput } from './types.js';

interface Statement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  pragma(value: string): unknown;
  transaction<T>(operation: () => T): () => T;
  close(): void;
}

type DatabaseConstructor = new (path: string) => Database;

export class SqliteCardStateStore extends DurableCardStateStore {
  private constructor(
    private readonly database: Database,
    readonly path: string,
    private readonly replayLimit: number,
  ) {
    super();
    this.assertDurableBrand();
  }

  static async open(
    databasePath: string,
    replayLimit = 10_000,
  ): Promise<SqliteCardStateStore> {
    if (databasePath === ':memory:' || !Number.isInteger(replayLimit) || replayLimit < 1) {
      throw new RappidCardError(
        'state_store_invalid',
        'production replay state requires a durable SQLite file and positive limit',
      );
    }
    const path = resolve(databasePath);
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const DatabaseClass =
      (await import('better-sqlite3')).default as unknown as DatabaseConstructor;
    const database = new DatabaseClass(path);
    database.pragma('busy_timeout = 5000');
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    database.exec(`
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
    `);
    await chmod(path, 0o600);
    return new SqliteCardStateStore(database, path, replayLimit);
  }

  recordPolicy(
    policyId: string,
    sequence: number,
    documentHash: string,
  ): void {
    const operation = this.database.transaction(() => {
      const current = this.state('rappid_card_policy_state', policyId);
      if (sequence < (current?.sequence ?? -1)) {
        throw new RappidCardError(
          'policy_rollback',
          'signed policy sequence moved backwards',
        );
      }
      if (
        current
        && sequence === current.sequence
        && documentHash !== current.documentHash
      ) {
        throw new RappidCardError(
          'policy_equivocation',
          'signed policy changed without advancing its sequence',
        );
      }
      this.database.prepare(`
        INSERT INTO rappid_card_policy_state
          (policy_id, sequence, document_hash)
        VALUES (?, ?, ?)
        ON CONFLICT(policy_id) DO UPDATE SET
          sequence = excluded.sequence,
          document_hash = excluded.document_hash
      `).run(policyId, sequence, documentHash);
    });
    operation();
  }

  record(input: CardTrustStateInput, claimNonce: boolean): void {
    const operation = this.database.transaction(() => {
      const policyState = this.state(
        'rappid_card_policy_state',
        input.policyId,
      );
      const authorizationState = this.authorizationState(
        input.policyId,
        input.authorizationId,
      );
      const revocationState = this.state(
        'rappid_card_revocation_state',
        input.policyId,
      );
      if (input.policySequence < (policyState?.sequence ?? -1)) {
        throw new RappidCardError(
          'policy_rollback',
          'signed policy sequence moved backwards',
        );
      }
      if (
        policyState
        && input.policySequence === policyState.sequence
        && input.policyHash !== policyState.documentHash
      ) {
        throw new RappidCardError(
          'policy_equivocation',
          'signed policy changed without advancing its sequence',
        );
      }
      if (
        input.authorizationSequence
        < (authorizationState?.sequence ?? -1)
      ) {
        throw new RappidCardError(
          'authorization_rollback',
          'signed authorization sequence moved backwards',
        );
      }
      if (
        authorizationState
        && input.authorizationSequence === authorizationState.sequence
        && input.authorizationHash !== authorizationState.documentHash
      ) {
        throw new RappidCardError(
          'authorization_equivocation',
          'signed authorization changed without advancing its sequence',
        );
      }
      if (input.revocationSequence < (revocationState?.sequence ?? -1)) {
        throw new RappidCardError(
          'revocation_rollback',
          'signed revocation sequence moved backwards',
        );
      }
      if (
        revocationState
        && input.revocationSequence === revocationState.sequence
        && input.revocationHash !== revocationState.documentHash
      ) {
        throw new RappidCardError(
          'revocation_equivocation',
          'signed revocation view changed without advancing its sequence',
        );
      }
      if (
        this.database.prepare(
          'SELECT 1 AS present FROM rappid_card_replay WHERE nonce = ?',
        ).get(input.nonce)
      ) {
        throw new RappidCardError(
          'duplicate_nonce',
          'card nonce has already been accepted',
        );
      }
      this.database.prepare(`
        INSERT INTO rappid_card_policy_state
          (policy_id, sequence, document_hash)
        VALUES (?, ?, ?)
        ON CONFLICT(policy_id) DO UPDATE SET
          sequence = excluded.sequence,
          document_hash = excluded.document_hash
      `).run(input.policyId, input.policySequence, input.policyHash);
      this.database.prepare(`
        INSERT INTO rappid_card_authorization_state
          (policy_id, authorization_id, sequence, document_hash)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(policy_id, authorization_id)
        DO UPDATE SET
          sequence = excluded.sequence,
          document_hash = excluded.document_hash
      `).run(
        input.policyId,
        input.authorizationId,
        input.authorizationSequence,
        input.authorizationHash,
      );
      this.database.prepare(`
        INSERT INTO rappid_card_revocation_state
          (policy_id, sequence, document_hash)
        VALUES (?, ?, ?)
        ON CONFLICT(policy_id) DO UPDATE SET
          sequence = excluded.sequence,
          document_hash = excluded.document_hash
      `).run(
        input.policyId,
        input.revocationSequence,
        input.revocationHash,
      );
      if (claimNonce) {
        this.database.prepare(`
          INSERT INTO rappid_card_replay
            (nonce, policy_id, manifest_hash, accepted_at)
          VALUES (?, ?, ?, ?)
        `).run(
          input.nonce,
          input.policyId,
          input.manifestHash,
          Date.now(),
        );
        const count = (
          this.database.prepare(
            'SELECT COUNT(*) AS count FROM rappid_card_replay',
          ).get() as { count: number }
        ).count;
        if (count > this.replayLimit) {
          this.database.prepare(`
            DELETE FROM rappid_card_replay
            WHERE rowid IN (
              SELECT rowid FROM rappid_card_replay
              ORDER BY accepted_at, rowid
              LIMIT ?
            )
          `).run(count - this.replayLimit);
        }
      }
    });
    operation();
  }

  close(): void {
    this.database.close();
  }

  private state(
    table: string,
    policyId: string,
  ): { sequence: number; documentHash: string } | undefined {
    const row = this.database.prepare(
      `SELECT sequence, document_hash AS documentHash
       FROM ${table}
       WHERE policy_id = ?`,
    ).get(policyId) as { sequence: number; documentHash: string } | undefined;
    return row;
  }

  private authorizationState(
    policyId: string,
    authorizationId: string,
  ): { sequence: number; documentHash: string } | undefined {
    const row = this.database.prepare(`
      SELECT sequence, document_hash AS documentHash
      FROM rappid_card_authorization_state
      WHERE policy_id = ? AND authorization_id = ?
    `).get(policyId, authorizationId) as
      | { sequence: number; documentHash: string }
      | undefined;
    return row;
  }
}
