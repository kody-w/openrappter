import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { homedir } from 'os';
import { dirname, join } from 'path';

/**
 * The alpha's runtime lock.
 *
 * A FUNCTION, not a constant, so that home is resolved at the same moment as
 * every other path this module produces. It used to be computed once at import
 * time while `gatewayLockFileFor({ instance })` re-read `homedir()` on every
 * call — so redirecting HOME moved every twin's files and left the alpha's
 * behind, and a test that believed it was isolated wrote a fixture into the
 * operator's real ~/.openrappter/endpoint.json. That corrupted the live roster,
 * which then reported a running alpha as dead. #110
 */
export function defaultGatewayLockFile(): string {
  return join(homedir(), '.openrappter', 'gateway.pid');
}

export const ALPHA_GATEWAY_PORT = 18790;

/**
 * The band a hatched twin's port is drawn from.
 *
 * Chosen to sit clear of everything this machine already answers on: the alpha
 * (18790), the brainstem (7071), the ports burrow.js probes (7081-7083), and
 * the ephemeral range the kernel hands out for outbound sockets (49152+ on
 * macOS). 900 slots is far more twins than a device will ever hatch.
 */
export const TWIN_PORT_BASE = 19000;
export const TWIN_PORT_SPAN = 900;

/**
 * Which port a given rappter listens on.
 *
 * #94 scoped the runtime LOCK per instance and left the PORT device-global, so
 * `--instance scout` — the flag whose own help text says it exists so an alpha
 * and its hatched twins can share a device — acquired a lock of its own and
 * then tried to bind the alpha's 18790. The lock said "you are a separate
 * rappter" and the bind said "you are the alpha", and the disagreement reached
 * the user as an unhandled EADDRINUSE stack trace. #101
 *
 * So this lives in the same module as `gatewayLockFileFor`, deliberately: the
 * bug was two derivations of "which rappter am I" drifting apart, and the way
 * to stop that recurring is to keep them where they cannot be changed
 * independently.
 *
 * The port is derived from the instance NAME rather than assigned on a
 * first-come basis, because a twin that lands on a different port each time it
 * starts cannot be addressed by a neighbour — and being addressable is the
 * entire point of hatching one. Same name, same port, every boot, on every
 * device.
 *
 * The ALPHA is untouched: no instance and no explicit port still resolves to
 * 18790, so nothing already installed moves.
 */
export function gatewayPortFor(options: {
  instance?: string;
  port?: number;
} = {}): number {
  // An explicit port is a direct instruction and always wins, including for a
  // twin whose derived port happens to collide with something else.
  if (options.port !== undefined && Number.isFinite(options.port)) {
    return options.port;
  }
  const instance = (options.instance ?? '').trim();
  if (!instance) return ALPHA_GATEWAY_PORT;

  // The SAME key the lock path uses. Hashing the raw name here is what let two
  // names sharing a lock derive two different ports. #111
  //
  // sha256 rather than a hand-rolled string hash so the answer is identical
  // across Node versions, architectures and machines. A twin's address is a
  // fact two different programs have to agree on, so the derivation must not
  // depend on anything local.
  const digest = createHash('sha256').update(canonicalInstanceKey(instance), 'utf8').digest();
  return TWIN_PORT_BASE + (digest.readUInt32BE(0) % TWIN_PORT_SPAN);
}

/**
 * Where a given rappter keeps its runtime lock.
 *
 * The lock used to be one file per home directory with no port or instance in
 * the path, so a machine could run exactly ONE rappter. That is incompatible
 * with the thing this product is for: a device runs an alpha plus any number of
 * hatched twins, exactly as a brainstem hatches twins, and they meet as peers
 * over /twin and /chat.
 *
 * It also produced a failure nobody could read. `com.openrappter.gateway`
 * started seven times and exited 1 every time — not an orphan, not a stale job,
 * just a second instance being refused by the singleton — and three separate
 * diagnoses of that were wrong before the cause was found.
 *
 * The ALPHA keeps the original path byte for byte, so nothing already installed
 * moves or has to be migrated. Every other instance is keyed by its explicit id
 * when it has one, and otherwise by the port it listens on — which is already
 * unique per instance on a machine, because two servers cannot share it.
 */
/**
 * The one name a rappter is known by, everywhere.
 *
 * Identity used to be computed two ways: `gatewayPortFor` hashed the RAW name
 * while the lock path keyed on a SANITISED one. So `a b` and `a_b` derived
 * different ports (19884 and 19291) and shared a single lock directory,
 * endpoint record and roster row. Live consequence:
 *
 *   $ openrappter hatch "a b"   -> Hatching a b on :19884 (pid 85246)
 *   $ openrappter hatch "a_b"   -> a_b is already running on :19884 (pid 85246)
 *
 * The second reported success about a DIFFERENT twin. `a_b` was never started.
 *
 * That is #101 again — the lock and the port disagreeing about which rappter a
 * process is — surviving in the same module the fix put them in, because one
 * side hashed the raw string and the other the cleaned one. Both now go through
 * here, so there is nothing left to drift. #111
 *
 * Anything reaching a filesystem path from user input is flattened, so an id
 * like `../../alpha` cannot walk out of the instances directory and seize the
 * alpha's lock. Replacing separators is not sufficient on its own: an id of
 * exactly `..` survives that untouched and resolves the join straight back to
 * ~/.openrappter/gateway.pid — the alpha's file. So a key that is only dots is
 * rejected outright. Caught by its own test.
 *
 * A name that is ALREADY canonical maps to itself unchanged, which is what
 * keeps every existing twin on the port it has today.
 */
export function canonicalInstanceKey(name: string): string {
  const raw = name.trim();
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  if (/^\.+$/.test(cleaned) || cleaned === '') {
    return `_${Buffer.from(raw).toString('hex')}`;
  }
  return cleaned;
}

export function gatewayLockFileFor(options: {
  instance?: string;
  port?: number;
} = {}): string {
  const instance = (options.instance ?? '').trim();
  if (!instance && (options.port === undefined || options.port === ALPHA_GATEWAY_PORT)) {
    return defaultGatewayLockFile();
  }
  const key = canonicalInstanceKey(instance || String(options.port));
  return join(homedir(), '.openrappter', 'instances', key, 'gateway.pid');
}

/**
 * Where a rappter writes down the address it actually reached.
 *
 * Deliberately derived from `gatewayLockFileFor`, so a rappter's lock and its
 * endpoint record can never end up in different directories — the same reason
 * `gatewayPortFor` lives in this file.
 *
 * The roster needs this because the port CANNOT be re-derived from the name in
 * general. `gatewayPortFor` hashes the raw instance name while the lock path
 * uses a sanitised form, so the two disagree for any name outside
 * [A-Za-z0-9._-]; and an explicit `--port` overrides the derivation entirely.
 * A roster that re-derived would report a twin started with `--port` as DEAD
 * while it was serving. Reading back what the process wrote is the only answer
 * that stays true in both cases. #107
 */
export function gatewayEndpointFileFor(options: {
  instance?: string;
  port?: number;
} = {}): string {
  return join(dirname(gatewayLockFileFor(options)), 'endpoint.json');
}

export interface GatewayEndpoint {
  /** The hatched twin's name, or undefined for the alpha. */
  instance?: string;
  port: number;
  pid: number;
  startedAt: string;
}

/**
 * Record where this rappter landed. Best effort: a rappter that cannot write
 * its own endpoint must still serve, so every failure here is swallowed. The
 * roster treats a missing record as "unknown", never as "not running" — the
 * running/dead question is answered by probing, never by a file. #107
 */
export function writeGatewayEndpoint(endpoint: GatewayEndpoint): void {
  try {
    const file = gatewayEndpointFileFor({
      ...(endpoint.instance ? { instance: endpoint.instance } : {}),
      port: endpoint.port,
    });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(endpoint, null, 2), { mode: 0o600 });
  } catch {
    // Not being able to say where you are is not a reason to stop existing.
  }
}

/** Read back an endpoint record, or null when there is none to read. */
export function readGatewayEndpoint(file: string): GatewayEndpoint | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as GatewayEndpoint;
    if (typeof parsed?.port !== 'number' || !Number.isFinite(parsed.port)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The runtime lock belonging to whichever rappter is on this port.
 *
 * A caller that has a port and wants "who is actually serving it" cannot get
 * there by derivation: a twin's lock is keyed by its NAME
 * (`instances/scout/gateway.pid`) and a name cannot be recovered from a port.
 * Only the endpoint record each rappter writes at startup connects the two.
 *
 * Without this, `getIMessageServiceStatus` read the ALPHA's lock for every
 * port. Measured with a twin on 19509: `live` was fetched from 19509 and
 * answered by pid 71257, while `servingPid` came back 66014 — the alpha. The
 * two fields described different rappters, and `servedByForeignProcess`, whose
 * only job is to notice that the port is being served by something other than
 * the supervised job, was structurally unable to fire. #109
 */
export function gatewayLockFileForPort(port: number): string {
  // Check the alpha's own record first, so an alpha started on a non-default
  // port is still recognised as the alpha rather than searched for as a twin.
  const alpha = readGatewayEndpoint(gatewayEndpointFileFor({}));
  if (alpha ? alpha.port === port : port === ALPHA_GATEWAY_PORT) {
    return defaultGatewayLockFile();
  }

  try {
    const root = join(homedir(), '.openrappter', 'instances');
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const record = readGatewayEndpoint(gatewayEndpointFileFor({ instance: entry.name }));
      if (record?.port === port) return gatewayLockFileFor({ instance: entry.name });
    }
  } catch {
    // No instances directory yet: nothing has ever been hatched.
  }

  // Nothing claims this port. Key the fallback by the port as an instance, so
  // it can never collapse back to the alpha's file — which would attribute a
  // stranger's port to the alpha, the exact failure this function exists to
  // end. That collapse is real: `gatewayLockFileFor({ port: 18790 })` returns
  // the alpha's path by its own contract, so an alpha that had moved to
  // another port would still be named as the owner of 18790. Caught by its own
  // test.
  return gatewayLockFileFor({ instance: String(port) });
}

export interface GatewayLockOptions {  filePath?: string;
  pid?: number;
}

interface LockDatabase {
  exec(sql: string): void;
  pragma(sql: string): unknown;
  close(): void;
}

type LockDatabaseConstructor = new (filePath: string) => LockDatabase;

interface HeldLock {
  pid: number;
  database: LockDatabase;
}

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as LockDatabaseConstructor;
const heldLocks = new Map<string, HeldLock>();

function databasePath(filePath: string): string {
  return `${filePath}.sqlite`;
}

function openExclusiveDatabase(filePath: string): LockDatabase | null {
  let database: LockDatabase | undefined;
  try {
    database = new Database(databasePath(filePath));
    database.pragma('busy_timeout = 0');
    database.pragma('journal_mode = DELETE');
    database.exec(`
      CREATE TABLE IF NOT EXISTS gateway_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1)
      )
    `);
    database.exec('BEGIN EXCLUSIVE');
    chmodSync(databasePath(filePath), 0o600);
    return database;
  } catch {
    try {
      database?.close();
    } catch {
      // The operating system releases any partial lock when the handle closes.
    }
    return null;
  }
}

function writeOwner(filePath: string, pid: number): void {
  const temporaryPath = `${filePath}.${pid}.tmp`;
  const descriptor = openSync(temporaryPath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${pid}\n`, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The atomic rename normally removes the temporary path.
    }
  }
}

function readOwner(filePath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(filePath, 'utf8').trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function acquireLock(options: GatewayLockOptions = {}): boolean {
  const filePath = options.filePath ?? defaultGatewayLockFile();
  const pid = options.pid ?? process.pid;
  const held = heldLocks.get(filePath);
  if (held) return held.pid === pid;

  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(filePath), 0o700);
  const database = openExclusiveDatabase(filePath);
  if (!database) return false;
  try {
    writeOwner(filePath, pid);
    heldLocks.set(filePath, { pid, database });
    return true;
  } catch {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Closing below releases the exclusive lock even if rollback fails.
    }
    database.close();
    return false;
  }
}

export function releaseLock(options: GatewayLockOptions = {}): void {
  const filePath = options.filePath ?? defaultGatewayLockFile();
  const pid = options.pid ?? process.pid;
  const held = heldLocks.get(filePath);
  if (!held || held.pid !== pid) return;

  if (readOwner(filePath) === pid) {
    try {
      unlinkSync(filePath);
    } catch {
      // The PID file is advisory; the SQLite transaction is authoritative.
    }
  }
  try {
    held.database.exec('ROLLBACK');
  } catch {
    // Closing releases the kernel lock.
  }
  held.database.close();
  heldLocks.delete(filePath);
}

export interface GatewayLockOwner {
  /** PID recorded in the lock file, or null when absent/unreadable/malformed. */
  pid: number | null;
  /** Whether that recorded PID is a live process this user can signal. */
  alive: boolean;
}

/**
 * Report who the lock file says owns the gateway.
 *
 * `isGatewayRunning()` answers *whether* the gateway is held, which is not
 * enough to debug the case that matters: another supervisor holding the lock
 * while the installed launch agent loops on "Another OpenRappter gateway
 * already owns the runtime lock". Then `install-service` reports live/ready for
 * a listener it does not own, and the symptoms look like a credential problem
 * instead of an ownership one.
 */
export function readGatewayLockOwner(options: GatewayLockOptions = {}): GatewayLockOwner {
  const filePath = options.filePath ?? defaultGatewayLockFile();
  let pid: number | null = null;
  try {
    const raw = readFileSync(filePath, 'utf-8').trim();
    // The file may carry trailing content; only a leading integer is meaningful.
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    return { pid: null, alive: false };
  }
  if (pid === null) return { pid: null, alive: false };

  let alive = false;
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    alive = (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  return { pid, alive };
}

export function isGatewayRunning(options: GatewayLockOptions = {}): boolean {
  const filePath = options.filePath ?? defaultGatewayLockFile();
  if (heldLocks.has(filePath)) return true;

  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(filePath), 0o700);
  const probe = openExclusiveDatabase(filePath);
  if (!probe) return true;
  try {
    probe.exec('ROLLBACK');
  } catch {
    // Closing still releases the probe lock.
  }
  probe.close();
  return false;
}
