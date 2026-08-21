import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { CONNECTION, NONCE, hex64, lclabel, rappidValid, uint53, validUtc } from './contract.js';
import { CardStateBackend } from './types.js';

interface Statement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  pragma(value: string): unknown;
  close(): void;
}
type DatabaseConstructor = new (
  path: string,
  options?: { timeout?: number },
) => Database;

export class SQLiteCardState extends CardStateBackend {
  private constructor(
    readonly path: string,
    private readonly DatabaseClass: DatabaseConstructor,
  ) {
    super();
  }

  static async open(pathValue: string): Promise<SQLiteCardState> {
    if (pathValue === ':memory:') {
      throw new Error('SQLiteCardState requires a durable filesystem path');
    }
    const path = resolve(pathValue);
    await mkdir(dirname(path), { recursive: true });
    const DatabaseClass =
      (await import('better-sqlite3')).default as unknown as DatabaseConstructor;
    const database = new DatabaseClass(path, { timeout: 30_000 });
    try {
      database.pragma('journal_mode = WAL');
      database.pragma('synchronous = FULL');
      database.pragma('busy_timeout = 30000');
      database.exec(`
        CREATE TABLE IF NOT EXISTS card_nonce (
          nonce TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('hydrating','awake')),
          updated_utc TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS card_sequence (
          namespace TEXT NOT NULL,
          authority TEXT NOT NULL,
          seq INTEGER NOT NULL,
          view_hash TEXT NOT NULL,
          PRIMARY KEY(namespace, authority)
        );
      `);
    } finally {
      database.close();
    }
    return new SQLiteCardState(path, DatabaseClass);
  }

  claimNonce(
    nonce: string,
    connectionId: string,
    utc: string,
  ): [boolean, string] {
    this.validateNonce(nonce, connectionId, utc);
    const database = this.connect();
    try {
      database.exec('BEGIN IMMEDIATE');
      const row = database.prepare(
        'SELECT connection_id, state FROM card_nonce WHERE nonce=?',
      ).get(nonce) as { connection_id: string; state: string } | undefined;
      if (row === undefined) {
        database.prepare(
          "INSERT INTO card_nonce(nonce,connection_id,state,updated_utc) VALUES(?,?,'hydrating',?)",
        ).run(nonce, connectionId, utc);
        database.exec('COMMIT');
        return [true, 'new'];
      }
      if (row.connection_id === connectionId && row.state === 'hydrating') {
        database.prepare(
          'UPDATE card_nonce SET updated_utc=? WHERE nonce=?',
        ).run(utc, nonce);
        database.exec('COMMIT');
        return [true, 'resume'];
      }
      database.exec('ROLLBACK');
      return row.state === 'hydrating'
        ? [false, 'nonce is already hydrating on another connection']
        : [false, 'nonce has already awakened'];
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      throw error;
    } finally {
      database.close();
    }
  }

  markAwake(
    nonce: string,
    connectionId: string,
    utc: string,
  ): [boolean, string] {
    this.validateNonce(nonce, connectionId, utc);
    const database = this.connect();
    try {
      database.exec('BEGIN IMMEDIATE');
      const changed = database.prepare(
        "UPDATE card_nonce SET state='awake', updated_utc=? WHERE nonce=? AND connection_id=? AND state='hydrating'",
      ).run(utc, nonce, connectionId).changes;
      if (changed !== 1) {
        database.exec('ROLLBACK');
        return [false, 'nonce claim was lost before awake'];
      }
      database.exec('COMMIT');
      return [true, 'awake'];
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      throw error;
    } finally {
      database.close();
    }
  }

  acceptSequence(
    namespace: string,
    authority: string,
    seq: number,
    viewHash: string,
  ): [boolean, string] {
    if (!lclabel(namespace) || !rappidValid(authority)) {
      throw new Error('invalid signed-view sequence key');
    }
    if (!uint53(seq) || !hex64(viewHash)) {
      throw new Error('invalid signed-view sequence value');
    }
    const database = this.connect();
    try {
      database.exec('BEGIN IMMEDIATE');
      const row = database.prepare(
        'SELECT seq, view_hash FROM card_sequence WHERE namespace=? AND authority=?',
      ).get(namespace, authority) as { seq: number; view_hash: string } | undefined;
      if (row === undefined) {
        database.prepare(
          'INSERT INTO card_sequence(namespace,authority,seq,view_hash) VALUES(?,?,?,?)',
        ).run(namespace, authority, seq, viewHash);
        database.exec('COMMIT');
        return [true, 'new'];
      }
      if (seq < row.seq) {
        database.exec('ROLLBACK');
        return [false, `${namespace} sequence rollback`];
      }
      if (seq === row.seq && viewHash !== row.view_hash) {
        database.exec('ROLLBACK');
        return [false, `${namespace} sequence fork`];
      }
      if (seq > row.seq) {
        database.prepare(
          'UPDATE card_sequence SET seq=?, view_hash=? WHERE namespace=? AND authority=?',
        ).run(seq, viewHash, namespace, authority);
      }
      database.exec('COMMIT');
      return [true, 'current'];
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      throw error;
    } finally {
      database.close();
    }
  }

  seedNonce(
    nonce: string,
    connectionId: string,
    state: 'hydrating' | 'awake',
    utc: string,
  ): void {
    this.validateNonce(nonce, connectionId, utc);
    const database = this.connect();
    try {
      database.prepare(
        'INSERT OR REPLACE INTO card_nonce(nonce,connection_id,state,updated_utc) VALUES(?,?,?,?)',
      ).run(nonce, connectionId, state, utc);
    } finally {
      database.close();
    }
  }

  seedSequence(
    namespace: string,
    authority: string,
    seq: number,
    viewHash: string,
  ): void {
    if (!lclabel(namespace) || !rappidValid(authority)) throw new Error('invalid sequence seed key');
    if (!uint53(seq) || !hex64(viewHash)) throw new Error('invalid sequence seed value');
    const database = this.connect();
    try {
      database.prepare(
        'INSERT OR REPLACE INTO card_sequence(namespace,authority,seq,view_hash) VALUES(?,?,?,?)',
      ).run(namespace, authority, seq, viewHash);
    } finally {
      database.close();
    }
  }

  nonceState(nonce: string): {
    connection_id: string;
    state: string;
    updated_utc: string;
  } | null {
    const database = this.connect();
    try {
      const row = database.prepare(
        'SELECT connection_id,state,updated_utc FROM card_nonce WHERE nonce=?',
      ).get(nonce) as
        | { connection_id: string; state: string; updated_utc: string }
        | undefined;
      return row ?? null;
    } finally {
      database.close();
    }
  }

  private connect(): Database {
    const database = new this.DatabaseClass(this.path, { timeout: 30_000 });
    database.pragma('busy_timeout = 30000');
    database.pragma('synchronous = FULL');
    return database;
  }

  private validateNonce(nonce: string, connectionId: string, utc: string): void {
    if (!NONCE.test(nonce)) throw new Error('invalid card nonce');
    if (!CONNECTION.test(connectionId)) throw new Error('invalid card connection_id');
    if (validUtc(utc) === null) throw new Error('invalid card nonce timestamp');
  }
}
