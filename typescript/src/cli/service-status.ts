/**
 * `openrappter service status` — does launchd supervise the gateway that is
 * actually answering?
 *
 * The two can disagree permanently, and on the machine that prompted this they
 * had for thirteen days (#144):
 *
 *     $ launchctl list | grep com.openrappter.gateway
 *     -   1   com.openrappter.gateway          <- no pid, last exit 1
 *     $ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18790/health
 *     200                                       <- serving fine
 *     $ launchctl print … | grep runs
 *     runs = 29                                 <- and failing on every retry
 *
 * A gateway started outside launchd holds the port, so every supervised start
 * exits 1 with `EADDRINUSE`. Health checks pass, `doctor` reports the same
 * "port is in use (gateway may already be running)" it reports when everything
 * is correct, and nothing anywhere says the service is unsupervised -- which
 * is the state that matters, because `KeepAlive` will not restart a process
 * launchd does not own.
 *
 * This command exists to make those two facts comparable in one place.
 */
import type { Command } from 'commander';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync } from 'fs';
import { defaultGatewayLockFile } from '../infra/gateway-lock.js';
import { OPENRAPPTER_LAUNCH_AGENT_LABEL } from '../channels/imessage-launchd.js';

const run = promisify(execFile);

export interface ServiceStatus {
  /** Whether launchd has the job loaded at all. */
  registered: boolean;
  /** The pid launchd is supervising, if any. */
  launchdPid: number | null;
  /** The exit status launchd last recorded. */
  lastExit: number | null;
  /** The pid recorded by whatever gateway is running. */
  recordedPid: number | null;
  /** Whether that pid is alive. */
  recordedAlive: boolean;
}

/** Parse one `launchctl list` row: `<pid>\t<status>\t<label>`. */
export function parseLaunchctlRow(stdout: string, label: string): {
  registered: boolean;
  pid: number | null;
  lastExit: number | null;
} {
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3 || parts[2].trim() !== label) continue;
    const pid = Number.parseInt(parts[0], 10);
    const status = Number.parseInt(parts[1], 10);
    return {
      registered: true,
      pid: Number.isFinite(pid) ? pid : null,
      lastExit: Number.isFinite(status) ? status : null,
    };
  }
  return { registered: false, pid: null, lastExit: null };
}

function pidIsAlive(pid: number): boolean {
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readServiceStatus(): Promise<ServiceStatus> {
  let row = { registered: false, pid: null as number | null, lastExit: null as number | null };
  try {
    const { stdout } = await run('launchctl', ['list']);
    row = parseLaunchctlRow(stdout, OPENRAPPTER_LAUNCH_AGENT_LABEL);
  } catch {
    // No launchctl (Linux, or a stripped container): everything below still
    // reports what it can rather than failing.
  }

  const lockFile = defaultGatewayLockFile();
  let recordedPid: number | null = null;
  if (existsSync(lockFile)) {
    const parsed = Number.parseInt(readFileSync(lockFile, 'utf-8').trim(), 10);
    if (Number.isFinite(parsed)) recordedPid = parsed;
  }

  return {
    registered: row.registered,
    launchdPid: row.pid,
    lastExit: row.lastExit,
    recordedPid,
    recordedAlive: recordedPid !== null && pidIsAlive(recordedPid),
  };
}

/**
 * The one sentence a reader needs.
 *
 * Returns `null` when supervision is correct, so the caller can stay quiet.
 */
export function describeSupervision(status: ServiceStatus): string | null {
  if (!status.registered) {
    return status.recordedAlive
      ? `A gateway is running (pid ${status.recordedPid}) but no launchd job is installed, so nothing will restart it.\n  Install it with: openrappter service install`
      : null;
  }

  if (status.launchdPid !== null) {
    if (status.recordedPid !== null && status.recordedPid !== status.launchdPid) {
      return `launchd supervises pid ${status.launchdPid}, but the running gateway recorded pid ${status.recordedPid}.`;
    }
    return null;
  }

  // Registered, no pid: launchd is not running it. The interesting case is
  // whether something else is.
  if (status.recordedAlive) {
    return (
      `The gateway answering on this machine (pid ${status.recordedPid}) was NOT started by launchd, `
      + `which last recorded exit ${status.lastExit ?? 'unknown'}.\n`
      + `  It is running unsupervised: KeepAlive will not restart it if it crashes.\n`
      + `  Most likely it holds the port, so every supervised start fails with EADDRINUSE.\n`
      + `  Stop that process and let launchd own it: kill ${status.recordedPid}`
    );
  }

  return `launchd has the job installed but nothing is running (last exit ${status.lastExit ?? 'unknown'}).`;
}

export function registerServiceStatusCommand(serviceCommand: Command): void {
  serviceCommand
    .command('status')
    .description('Report whether launchd supervises the running gateway')
    .option('--json', 'Print the raw status')
    .action(async (options: { json?: boolean }) => {
      const status = await readServiceStatus();

      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(`\n  launchd job:   ${status.registered ? 'installed' : 'not installed'}`);
        console.log(`  supervised pid: ${status.launchdPid ?? '(none)'}`);
        console.log(`  last exit:      ${status.lastExit ?? '(none)'}`);
        console.log(`  running pid:    ${status.recordedPid ?? '(none)'}${
          status.recordedPid !== null && !status.recordedAlive ? ' (stale — not running)' : ''
        }`);
      }

      const problem = describeSupervision(status);
      if (problem) {
        if (!options.json) console.log(`\n  ${problem}\n`);
        process.exitCode = 1;
      } else if (!options.json) {
        console.log('\n  Supervision is correct.\n');
      }
    });
}
