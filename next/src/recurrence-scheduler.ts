import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalJson, contentHash, isBodyStream, isUtc, parseJson, rootTail, sha256, type JsonObject,
} from './canonical.js';
import { label, object } from './contract.js';
import { Refusal, publicError, requireThat } from './errors.js';
import { projectBot } from './projection.js';
import type { RootSnapshot, StoreSnapshot } from './repository.js';
import { RecurringWork } from './recurrence.js';

const AUTHORIZATION_SCHEMA = 'rapp-work.recurrence-scheduler-authorization/1';
const LEASE_SCHEMA = 'rapp-work.recurrence-scheduler-lease/1';
const MAX_ROOTS = 64;
const MAX_LEASE_ENTRIES = 512;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 300_000;
const MIN_POLL_MS = 100;
const MAX_CLAIMS = 128;
const NOFOLLOW = constants.O_NOFOLLOW;
const LEASE_DIRECTORY = /^[0-9a-f]{64}\.lease$/u;
const CANDIDATE_DIRECTORY = /^\.candidate-[0-9a-f]{64}-[0-9a-f-]{36}$/u;
const RETIRED_DIRECTORY = /^\.retired-[0-9a-f]{64}-[0-9a-f]{64}$/u;

export interface RecurrenceSchedulerAuthorization extends JsonObject {
  schema: typeof AUTHORIZATION_SCHEMA;
  authorityId: string;
  profile: string;
  roots: string[];
  operation: 'canonical-recap';
  externalEffects: 'forbidden';
}

interface SchedulerLease extends JsonObject {
  schema: typeof LEASE_SCHEMA;
  profile: string;
  authorityId: string;
  root: string;
  holder: string;
  leaseId: string;
  pid: number;
  acquiredUtc: string;
  renewedUtc: string;
  expiresUtc: string;
}

export interface RecurrenceSchedulerOptions {
  roots: readonly string[];
  holder?: string;
  leaseMs?: number;
  pollMs?: number;
  maxClaimsPerRun?: number;
  clock?: () => string;
}

export interface RecurrenceSchedulerReport extends JsonObject {
  schema: 'rapp-work.recurrence-scheduler-report/1';
  authorityId: string;
  holder: string;
  observedUtc: string;
  roots: JsonObject[];
  claims: number;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, code: string): number {
  const selected = value ?? fallback;
  requireThat(Number.isSafeInteger(selected) && selected >= minimum && selected <= maximum,
    code, `Choose an integer between ${minimum} and ${maximum}.`);
  return selected;
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  requireThat(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700
    && (process.getuid === undefined || info.uid === process.getuid()), 'scheduler-runtime-private',
  'Scheduler runtime directories must be real same-user 0700 directories.');
}

async function assertRealAncestors(directory: string): Promise<void> {
  let cursor = path.parse(directory).root;
  for (const piece of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, piece);
    const info = await lstat(cursor);
    requireThat(info.isDirectory() && !info.isSymbolicLink(), 'scheduler-runtime-path',
      'Scheduler runtime ancestors must be real directories.');
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function schedulerAuthorization(directory: string, roots: readonly string[]): RecurrenceSchedulerAuthorization {
  requireThat(roots.length > 0 && roots.length <= MAX_ROOTS, 'scheduler-authorization',
    'The owner must authorize between one and 64 exact canonical roots.');
  const selected = [...roots];
  requireThat(selected.every(isBodyStream) && new Set(selected).size === selected.length,
    'scheduler-authorization', 'Scheduler roots must be distinct full canonical RAPPIDs.');
  selected.sort();
  const profile = sha256(path.resolve(directory));
  const authorityId = contentHash({
    schema: AUTHORIZATION_SCHEMA,
    profile,
    roots: selected,
    operation: 'canonical-recap',
    externalEffects: 'forbidden',
  });
  return {
    schema: AUTHORIZATION_SCHEMA,
    authorityId,
    profile,
    roots: selected,
    operation: 'canonical-recap',
    externalEffects: 'forbidden',
  };
}

function schedulerLease(value: unknown): SchedulerLease {
  const lease = object(value, [
    'schema', 'profile', 'authorityId', 'root', 'holder', 'leaseId', 'pid',
    'acquiredUtc', 'renewedUtc', 'expiresUtc',
  ]);
  requireThat(lease.schema === LEASE_SCHEMA && /^[0-9a-f]{64}$/u.test(String(lease.profile))
    && /^[0-9a-f]{64}$/u.test(String(lease.authorityId)) && isBodyStream(lease.root)
    && /^[0-9a-f]{64}$/u.test(String(lease.leaseId)) && Number.isSafeInteger(lease.pid)
    && Number(lease.pid) > 0 && isUtc(lease.acquiredUtc) && isUtc(lease.renewedUtc) && isUtc(lease.expiresUtc)
    && Date.parse(String(lease.acquiredUtc)) <= Date.parse(String(lease.renewedUtc))
    && Date.parse(String(lease.renewedUtc)) < Date.parse(String(lease.expiresUtc)),
  'scheduler-lease-invalid', 'The durable scheduler lease is invalid and requires explicit operator inspection.');
  label(lease.holder);
  return lease as SchedulerLease;
}

class DurableSchedulerLeases {
  readonly directory: string;
  readonly profile: string;

  constructor(canonicalDirectory: string) {
    const canonical = path.resolve(canonicalDirectory);
    this.directory = path.join(path.dirname(canonical), `${path.basename(canonical)}.scheduler`);
    this.profile = sha256(canonical);
  }

  async #prepare(): Promise<string> {
    await assertRealAncestors(path.dirname(this.directory));
    try { await mkdir(this.directory, { mode: 0o700 }); }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
    await assertPrivateDirectory(this.directory);
    const runtimeEntries = await readdir(this.directory, { withFileTypes: true });
    requireThat(runtimeEntries.length <= 1 && runtimeEntries.every(entry => entry.name === 'leases' && entry.isDirectory()),
      'scheduler-runtime-private', 'Only the scheduler lease catalog belongs in the scheduler runtime sibling.');
    const leases = path.join(this.directory, 'leases');
    try { await mkdir(leases, { mode: 0o700 }); }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
    await assertPrivateDirectory(leases);
    const entries = await readdir(leases, { withFileTypes: true });
    requireThat(entries.length <= MAX_LEASE_ENTRIES && entries.every(entry => entry.isDirectory()
      && (LEASE_DIRECTORY.test(entry.name) || CANDIDATE_DIRECTORY.test(entry.name) || RETIRED_DIRECTORY.test(entry.name))),
    'scheduler-runtime-private', 'Only bounded scheduler lease directories belong in the scheduler runtime sibling.');
    return leases;
  }

  async #writeRecord(directory: string, filename: string, lease: SchedulerLease): Promise<void> {
    const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try { await handle.writeFile(canonicalJson(lease)); await handle.sync(); }
    finally { await handle.close(); }
    await syncDirectory(directory);
  }

  async #readRecord(directory: string): Promise<SchedulerLease> {
    await assertPrivateDirectory(directory);
    const filename = path.join(directory, 'record.json');
    const handle = await open(filename, constants.O_RDONLY | NOFOLLOW);
    try {
      const info = await handle.stat();
      requireThat(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 4_096
        && (info.mode & 0o777) === 0o600 && (process.getuid === undefined || info.uid === process.getuid()),
      'scheduler-runtime-private', 'Scheduler lease records must be bounded same-user non-linked 0600 files.');
      return schedulerLease(parseJson(await handle.readFile()));
    } finally { await handle.close(); }
  }

  async #removeCandidate(directory: string): Promise<void> {
    try { await unlink(path.join(directory, 'record.json')); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    try { await rmdir(directory); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  }

  async #candidate(leases: string, lease: SchedulerLease): Promise<string> {
    const directory = path.join(leases, `.candidate-${rootTail(lease.root)}-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    try {
      await this.#writeRecord(directory, path.join(directory, 'record.json'), lease);
      return directory;
    } catch (error) {
      await this.#removeCandidate(directory);
      throw error;
    }
  }

  async #renew(directory: string, current: SchedulerLease, candidate: SchedulerLease): Promise<SchedulerLease> {
    const renewed = schedulerLease({
      ...candidate,
      acquiredUtc: current.acquiredUtc,
      renewedUtc: candidate.renewedUtc,
    });
    const temporary = path.join(directory, `.renew-${randomUUID()}.json`);
    try {
      await this.#writeRecord(directory, temporary, renewed);
      await rename(temporary, path.join(directory, 'record.json'));
      await syncDirectory(directory);
      return renewed;
    } catch (error) {
      try { await unlink(temporary); }
      catch (cleanupError) { if (errorCode(cleanupError) !== 'ENOENT') throw cleanupError; }
      throw error;
    }
  }

  async acquire(root: string, authorityId: string, holder: string, now: string, leaseMs: number):
  Promise<{ acquired: boolean; lease: SchedulerLease }> {
    requireThat(isBodyStream(root) && /^[0-9a-f]{64}$/u.test(authorityId) && isUtc(now),
      'scheduler-lease', 'An exact root, owner authorization and UTC clock are required for a scheduler lease.');
    label(holder);
    const leases = await this.#prepare();
    const expiresUtc = new Date(Date.parse(now) + leaseMs).toISOString();
    const lease = schedulerLease({
      schema: LEASE_SCHEMA,
      profile: this.profile,
      authorityId,
      root,
      holder,
      leaseId: contentHash({ profile: this.profile, authorityId, root, holder, now, nonce: randomUUID() }),
      pid: process.pid,
      acquiredUtc: now,
      renewedUtc: now,
      expiresUtc,
    });
    const active = path.join(leases, `${rootTail(root)}.lease`);
    let candidate: string | null = null;
    try {
      for (let attempt = 0; attempt < 16; attempt++) {
        let current: SchedulerLease;
        try { current = await this.#readRecord(active); }
        catch (error) {
          if (errorCode(error) === 'ENOENT') {
            candidate ??= await this.#candidate(leases, lease);
            try {
              await rename(candidate, active);
              candidate = null;
              await syncDirectory(leases);
              return { acquired: true, lease };
            } catch (publishError) {
              if (!['EEXIST', 'ENOTEMPTY'].includes(errorCode(publishError) ?? '')) throw publishError;
              continue;
            }
          }
          throw error;
        }
        requireThat(current.profile === this.profile && current.root === root,
          'scheduler-lease-invalid', 'A scheduler lease is bound to another canonical profile or root.');
        const expired = Date.parse(current.expiresUtc) <= Date.parse(now);
        if (!expired && current.authorityId === authorityId && current.holder === holder) {
          const remaining = Date.parse(current.expiresUtc) - Date.parse(now);
          return { acquired: true, lease: remaining > leaseMs / 2 ? current : await this.#renew(active, current, lease) };
        }
        if (!expired) return { acquired: false, lease: current };

        candidate ??= await this.#candidate(leases, lease);
        const retired = path.join(leases, `.retired-${rootTail(root)}-${current.leaseId}`);
        try {
          await rename(active, retired);
          await syncDirectory(leases);
        } catch (error) {
          if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(errorCode(error) ?? '')) throw error;
        }
      }
      throw new Refusal('scheduler-lease-contention',
        'The durable scheduler lease changed repeatedly; no occurrence was claimed.');
    } finally {
      if (candidate !== null) {
        try { await this.#removeCandidate(candidate); }
        catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
      }
    }
  }
}

function rootById(snapshot: StoreSnapshot, root: string): RootSnapshot {
  const selected = snapshot.roots.find(candidate => candidate.definition.root === root);
  requireThat(selected, 'scheduler-authorization', 'Every scheduler-authorized root must already exist in this canonical profile.');
  return selected;
}

function fenced(error: unknown): error is Refusal {
  return error instanceof Refusal && [
    'bot-hidden', 'canonical-fork-unresolved', 'canonical-head-unresolved', 'recurrence-bound', 'routine', 'routine-not-due',
  ].includes(error.code);
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class RecurrenceScheduler {
  readonly authorization: RecurrenceSchedulerAuthorization;
  readonly holder: string;
  readonly leaseMs: number;
  readonly pollMs: number;
  readonly maxClaimsPerRun: number;
  readonly #leases: DurableSchedulerLeases;
  readonly #clock: () => string;
  #active: Promise<RecurrenceSchedulerReport> | null = null;

  constructor(readonly recurring: RecurringWork, options: RecurrenceSchedulerOptions) {
    this.authorization = schedulerAuthorization(recurring.bots.repository.directory, options.roots);
    this.holder = label(options.holder ?? `scheduler-${randomUUID()}`);
    this.leaseMs = boundedInteger(options.leaseMs, 30_000, MIN_LEASE_MS, MAX_LEASE_MS, 'scheduler-lease');
    this.pollMs = boundedInteger(options.pollMs, 1_000, MIN_POLL_MS, this.leaseMs, 'scheduler-poll');
    requireThat(this.pollMs * 3 <= this.leaseMs, 'scheduler-poll',
      'The scheduler poll interval must renew its durable lease before one third of the lease window.');
    this.maxClaimsPerRun = boundedInteger(options.maxClaimsPerRun, MAX_CLAIMS, 1, MAX_CLAIMS, 'scheduler-bound');
    this.#clock = options.clock ?? (() => recurring.bots.now());
    this.#leases = new DurableSchedulerLeases(recurring.bots.repository.directory);
    requireThat(this.#leases.profile === this.authorization.profile, 'scheduler-authorization',
      'The scheduler authorization must bind this exact canonical profile.');
  }

  async #root(root: string, observedUtc: string, remaining: number): Promise<JsonObject> {
    if (remaining === 0) return { root, status: 'deferred', claims: [] };
    const lease = await this.#leases.acquire(root, this.authorization.authorityId, this.holder, observedUtc, this.leaseMs);
    const leaseView = { holder: lease.lease.holder, leaseId: lease.lease.leaseId, expiresUtc: lease.lease.expiresUtc };
    if (!lease.acquired) return { root, status: 'lease-held', lease: leaseView, claims: [] };
    const claims: JsonObject[] = [];
    try {
      const projection = projectBot(await this.recurring.bots.repository.root(root));
      if (projection.hidden) return { root, status: 'hidden', lease: leaseView, claims };
      const due = (await this.recurring.due(root, observedUtc)).sort((left, right) =>
        String(left.occurrence).localeCompare(String(right.occurrence))
          || String(left.routineId).localeCompare(String(right.routineId)));
      for (const occurrence of due.slice(0, remaining)) {
        try {
          const routineId = String(occurrence.routineId);
          const occurrenceUtc = String(occurrence.occurrence);
          const result = await this.recurring.tick(root, routineId, occurrenceUtc);
          claims.push({ routineId, occurrence: occurrenceUtc, ...result });
        } catch (error) {
          if (fenced(error)) return { root, status: 'fenced', lease: leaseView, claims, error: publicError(error) };
          throw error;
        }
      }
      return {
        root,
        status: due.length === 0 ? 'idle' : due.length > claims.length ? 'partial' : 'completed',
        lease: leaseView,
        claims,
      };
    } catch (error) {
      if (fenced(error)) return { root, status: 'fenced', lease: leaseView, claims, error: publicError(error) };
      throw error;
    }
  }

  async #runOnce(): Promise<RecurrenceSchedulerReport> {
    const observedUtc = this.#clock();
    requireThat(isUtc(observedUtc), 'clock', 'The scheduler requires a UTC observation clock.');
    const snapshot = await this.recurring.bots.repository.snapshot();
    for (const root of this.authorization.roots) {
      const selected = rootById(snapshot, root);
      requireThat(selected.definition.signer === null || this.recurring.bots.signer(root),
        'scheduler-owner-authority', 'A signed root can run unattended only while its owner signer is explicitly injected into this scheduler host.');
    }
    const roots: JsonObject[] = [];
    let claims = 0;
    for (const root of this.authorization.roots) {
      const report = await this.#root(root, observedUtc, this.maxClaimsPerRun - claims);
      roots.push(report);
      claims += (report.claims as JsonObject[]).length;
    }
    return {
      schema: 'rapp-work.recurrence-scheduler-report/1',
      authorityId: this.authorization.authorityId,
      holder: this.holder,
      observedUtc,
      roots,
      claims,
    };
  }

  runOnce(): Promise<RecurrenceSchedulerReport> {
    if (this.#active) return this.#active;
    const operation = this.#runOnce().finally(() => {
      if (this.#active === operation) this.#active = null;
    });
    this.#active = operation;
    return operation;
  }

  async run(signal: AbortSignal, onCycle?: (report: RecurrenceSchedulerReport) => void | Promise<void>): Promise<void> {
    while (!signal.aborted) {
      const report = await this.runOnce();
      await onCycle?.(report);
      await wait(this.pollMs, signal);
    }
  }
}
