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
import {
  OPENRAPPTER_LAUNCH_AGENT_LABEL,
  getIMessageServiceStatus,
  type IMessageServiceStatus,
} from '../channels/imessage-launchd.js';

const run = promisify(execFile);

/**
 * The supervision facts, read from the one place that already computes them.
 *
 * This used to re-derive them from `launchctl list` with its own field names:
 * `registered`/`launchdPid`/`recordedPid` beside the existing
 * `installed`/`supervisedPid`/`servingPid`. Both described the **same launchd
 * job** -- `getIMessageServiceStatus` is named for its caller, not its subject,
 * and reports on `com.openrappter.gateway` -- so the repository had two
 * vocabularies for one question, which is what #323 deleted a duplicate for.
 *
 * `servedByForeignProcess` in particular already existed and means exactly
 * what this command was written to detect.
 */
export type ServiceStatus = IMessageServiceStatus & {
  /**
   * The exit status launchd last recorded, which the supervision reader does
   * not carry. It is the difference between "never started" and "started 29
   * times and failed", and that is the whole story on a machine where a
   * foreign process holds the port.
   */
  lastExit: number | null;
};

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

export async function readServiceStatus(): Promise<ServiceStatus> {
  const supervision = await getIMessageServiceStatus();

  let lastExit: number | null = null;
  try {
    const { stdout } = await run('launchctl', ['list']);
    lastExit = parseLaunchctlRow(stdout, OPENRAPPTER_LAUNCH_AGENT_LABEL).lastExit;
  } catch {
    // No launchctl (Linux, or a stripped container).
  }

  return { ...supervision, lastExit };
}

/**
 * The one sentence a reader needs.
 *
 * Returns `null` when supervision is correct, so the caller can stay quiet.
 */
export function describeSupervision(status: ServiceStatus): string | null {
  if (!status.installed) {
    return status.live
      ? `A gateway is running (pid ${status.servingPid}) but no launchd job is installed, so nothing will restart it.\n  Install it with: openrappter service install`
      : null;
  }

  // The condition this command exists for.
  //
  // `servedByForeignProcess` is the neighbouring flag and does NOT cover it:
  // it compares the serving pid against the *supervised* pid, so it is false
  // when launchd owns nothing at all -- which is precisely the state on a
  // machine where a hand-started gateway holds the port and every supervised
  // start dies on EADDRINUSE. Both readings are wanted: theirs catches a
  // running job being shadowed, this catches a job that never got to run.
  if (status.servedByForeignProcess || (status.installed && !status.running && status.live)) {
    return (
      `The gateway answering on this machine (pid ${status.servingPid}) was NOT started by launchd, `
      + `which last recorded exit ${status.lastExit ?? 'unknown'}.\n`
      + `  It is running unsupervised: KeepAlive will not restart it if it crashes.\n`
      + `  Most likely it holds the port, so every supervised start fails with EADDRINUSE.\n`
      + `  Stop that process and let launchd own it: kill ${status.servingPid}`
    );
  }

  if (status.running) return null;

  if (status.live) {
    return (
      `The port answers (pid ${status.servingPid}) but launchd is not running the job `
      + `(last exit ${status.lastExit ?? 'unknown'}).`
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
        console.log(`\n  launchd job:    ${status.installed ? 'installed' : 'not installed'}`);
        console.log(`  supervised pid: ${status.supervisedPid ?? '(none)'}`);
        console.log(`  last exit:      ${status.lastExit ?? '(none)'}`);
        console.log(`  serving pid:    ${status.servingPid ?? '(none)'}${
          status.servedByForeignProcess ? ' (not the supervised job)' : ''
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
