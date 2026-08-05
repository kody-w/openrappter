/**
 * See and create the rappters running on this device. — #107
 *
 * A device runs an alpha plus any number of hatched twins, and after #101/#102/
 * #103 that works. Nothing could answer "what is running right now" — every
 * twin started during development had to be stopped with `kill <pid>` against a
 * number captured by hand at launch.
 *
 * The one place that looked like a roster lied. `~/.openrappter/instances/`
 * held two names while zero twins were running, one of which had never
 * successfully started at all, because SQLite leaves the lock FILE behind when
 * it releases the lock. So nothing here treats a directory as evidence of life.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, openSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { listRappters, type RappterStatus } from '../infra/roster.js';
import { gatewayPortFor } from '../infra/gateway-lock.js';
import { portTypedOnCommandLine } from '../infra/cli-port.js';

const EMOJI = '🦖';

function describe(entry: RappterStatus): string {
  const role = entry.isAlpha ? chalk.bold('alpha') : entry.name;
  const label = `${role}`.padEnd(16);

  if (entry.running) {
    const up = entry.uptimeSeconds !== undefined
      ? chalk.dim(`  up ${Math.floor(entry.uptimeSeconds / 60)}m`)
      : '';
    const pid = entry.pid !== undefined ? chalk.dim(`  pid ${entry.pid}`) : '';
    return `  ${chalk.green('●')} ${label} :${entry.port}${pid}${up}`;
  }

  if (entry.portTakenByOther) {
    return `  ${chalk.yellow('◍')} ${label} :${entry.port}  `
      + chalk.yellow(`port held by pid ${entry.pid}, which is not a rappter`);
  }

  return `  ${chalk.dim('○')} ${label} :${entry.port}  ${chalk.dim('not running')}`;
}

/**
 * The port the user actually typed, wherever Commander decided to put it.
 *
 * `openrappter hatch archivist --port 19950` hatched on the DERIVED port with
 * no error, because the root program's `--port` declaration takes precedence
 * over this command's own. Shared with the four subcommands that had the same
 * defect so there is one answer to "where did the user's port go". #107 / #108
 */
function explicitPort(options: { port?: number }, command: Command): number | undefined {
  if (options.port !== undefined) return options.port;
  return portTypedOnCommandLine(command);
}

export function registerRappterCommand(program: Command): void {
  program
    .command('twins')
    .description('Which rappters are running on this device')
    .option('--json', 'machine-readable')
    .action(async (options: { json?: boolean }) => {
      const entries = await listRappters();

      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      console.log(`\n${EMOJI} Rappters on this device\n`);
      for (const entry of entries) console.log(describe(entry));

      const live = entries.filter((e) => e.running).length;
      const dead = entries.length - live;
      console.log(
        `\n  ${live} running`
        // Names with no live process are shown, not hidden: a name that was
        // used and is gone is exactly what someone is looking for.
        + (dead > 0 ? chalk.dim(`, ${dead} known but not running`) : '')
        + '\n',
      );
      if (live > 0) {
        console.log(chalk.dim('  Talk to one:  openrappter twin say --to-instance <name> --text "…"'));
        console.log(chalk.dim('  Stop one:     kill <pid>\n'));
      }
    });

  program
    .command('hatch')
    .description('Hatch a twin rappter on this device')
    .argument('<name>', 'what to call it')
    .option('--port <port>', 'override the port derived from the name', (value: string) => {
      const port = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${value}`);
      }
      return port;
    })
    .action(async (name: string, options: { port?: number }, command: Command) => {
      const instance = name.trim();
      if (!instance) {
        console.error(`\n${EMOJI} A twin needs a name.\n`);
        process.exitCode = 1;
        return;
      }
      if (instance.toLowerCase() === 'alpha') {
        // The alpha is not hatched, it simply is. Allowing this would create a
        // twin called "alpha" that is not the alpha, on a different port.
        console.error(`\n${EMOJI} "alpha" is the rappter this device already runs. Pick another name.\n`);
        process.exitCode = 1;
        return;
      }

      const existing = (await listRappters()).find((e) => e.name === instance);
      if (existing?.running) {
        console.log(`\n${EMOJI} ${instance} is already running on :${existing.port}`
          + (existing.pid ? ` (pid ${existing.pid})` : '') + '\n');
        return;
      }

      const port = explicitPort(options, command) ?? gatewayPortFor({ instance });
      const entry = resolve(fileURLToPath(import.meta.url), '..', '..', 'index.js');
      const logDir = join(homedir(), '.openrappter', 'logs');
      mkdirSync(logDir, { recursive: true });
      const logFile = join(logDir, `twin-${instance}.log`);

      if (!existsSync(entry)) {
        console.error(`\n${EMOJI} Cannot find the openrappter entry point at ${entry}\n`);
        process.exitCode = 1;
        return;
      }

      const out = openSync(logFile, 'a');
      const child = spawn(
        process.execPath,
        [entry, '--daemon', '--instance', instance, '--port', String(port)],
        // Detached with its own stdio, so the twin outlives the shell that
        // hatched it. A twin that dies when you close the terminal is not a
        // peer, it is a subprocess.
        { detached: true, stdio: ['ignore', out, out] },
      );
      child.unref();

      console.log(`\n${EMOJI} Hatching ${chalk.bold(instance)} on :${port} (pid ${child.pid})`);
      console.log(chalk.dim(`   log: ${logFile}`));
      console.log(chalk.dim('   It takes a moment to come up. Check with: openrappter twins'));
      console.log(chalk.dim(`   Talk to it:  openrappter twin say --to-instance ${instance} --text "hello"\n`));
    });
}
