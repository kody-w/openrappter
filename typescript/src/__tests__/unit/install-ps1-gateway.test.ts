import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '../..');
const tsRoot = path.resolve(srcRoot, '..');
const repoRoot = path.resolve(tsRoot, '..');

const INSTALL_PS1 = path.join(repoRoot, 'install.ps1');
const DOCS_INSTALL_PS1 = path.join(repoRoot, 'docs', 'install.ps1');

/**
 * The installer's gateway launch, checked against the CLI that actually ships.
 *
 * `install.ps1` started the gateway with `node <entry> gateway`. `gateway` is
 * not a registered command, so Commander read it as the `[message]` positional
 * and sent the word to the model as a chat prompt: the process answered a
 * question about network gateways and exited 0 while the installer recorded its
 * PID and announced a running daemon.
 *
 * Source-text assertions could not have caught that, because the string
 * `"gateway"` is perfectly well-formed. Only a comparison against the real
 * registered surface can. So these tests run the CLI, read its help, and reject
 * any argv token the CLI does not register — the same shape of contract PR #158
 * used for the voice-call skill.
 */

interface CommandSurface {
  commands: Set<string>;
  options: Set<string>;
}

/**
 * The command surface as the CLI itself reports it.
 *
 * Run through `tsx` against `src/index.ts` rather than `dist/`, so the contract
 * is measured against the current source and never against a stale build.
 */
async function readCommandSurface(): Promise<CommandSurface> {
  const tsx = path.join(tsRoot, 'node_modules', '.bin', 'tsx');
  const { stdout } = await execFileAsync(tsx, [path.join(srcRoot, 'index.ts'), '--help'], {
    cwd: tsRoot,
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: '1' },
  });

  const commands = new Set<string>();
  const options = new Set<string>();

  let section: 'commands' | 'options' | null = null;
  for (const rawLine of stdout.split('\n')) {
    if (/^Commands:/.test(rawLine)) { section = 'commands'; continue; }
    if (/^Options:/.test(rawLine)) { section = 'options'; continue; }
    if (/^[A-Za-z].*:\s*$/.test(rawLine)) { section = null; continue; }
    if (!section) continue;

    // Only the entry lines are indented by exactly two spaces; continuation
    // lines of a wrapped description are indented further.
    const entry = /^ {2}(\S.*)$/.exec(rawLine);
    if (!entry) continue;

    if (section === 'commands') {
      const name = /^([a-z][\w-]*)/.exec(entry[1]);
      if (name) commands.add(name[1]);
    } else {
      for (const flag of entry[1].matchAll(/(--[\w-]+|-[A-Za-z])(?=[\s,]|$)/g)) {
        options.add(flag[1]);
      }
    }
  }

  return { commands, options };
}

/** The body of a single PowerShell function, up to the next top-level function. */
function functionBody(script: string, name: string): string {
  const start = script.indexOf(`function ${name}`);
  expect(start, `${name} should exist in install.ps1`).toBeGreaterThanOrEqual(0);
  const next = script.indexOf('\nfunction ', start + 1);
  return next === -1 ? script.slice(start) : script.slice(start, next);
}

/**
 * The literal argv the installer hands the CLI.
 *
 * Extracted from the shipped script rather than restated here, so the test
 * reads whatever the installer will really run. Variable tokens (`$entry`) are
 * the interpreter path and carry no command surface, so only string literals
 * are returned.
 */
function launchedCliArgs(script: string): string[] {
  const body = functionBody(script, 'Start-GatewayBrainstem');
  const marker = body.indexOf('-ArgumentList @(');
  expect(marker, 'the gateway launch should pass an -ArgumentList').toBeGreaterThanOrEqual(0);

  const open = body.indexOf('(', marker + '-ArgumentList @'.length);
  let depth = 0;
  let close = -1;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  expect(close, 'the -ArgumentList should be balanced').toBeGreaterThan(open);

  const inner = body.slice(open + 1, close);
  return [...inner.matchAll(/"([^"$]*)"|'([^']*)'/g)]
    .map(match => (match[1] ?? match[2]).trim())
    .filter(token => token.length > 0);
}

describe('install.ps1 gateway start', () => {
  let script: string;
  let surface: CommandSurface;

  beforeAll(async () => {
    script = await fs.readFile(INSTALL_PS1, 'utf-8');
    surface = await readCommandSurface();
  }, 180_000);

  it('reads a non-empty command surface from the CLI', () => {
    // Guards the rest of the file: an empty surface would make every argv look
    // unregistered, and an unparsed one would make every argv look fine.
    expect(surface.commands.size).toBeGreaterThan(0);
    expect(surface.options.has('--daemon')).toBe(true);
    expect(surface.commands.has('doctor')).toBe(true);
  });

  it('launches the gateway with argv the CLI registers', () => {
    const unregistered = launchedCliArgs(script).filter(token =>
      token.startsWith('-') ? !surface.options.has(token) : !surface.commands.has(token),
    );

    expect(unregistered).toEqual([]);
  });

  it('launches a mode that actually serves a gateway', () => {
    // `--daemon` is the only argv that binds the port the installer then
    // reports. Passing a registered but unrelated command would satisfy the
    // check above while still starting no gateway.
    expect(launchedCliArgs(script)).toContain('--daemon');
  });

  it('never advertises a command the CLI does not register', () => {
    // The closing summary told users to run `openrappter gateway` — the same
    // non-command, reaching them as advice instead of as a silent failure.
    const advertised = [
      // The "What's next" table: Write-Kv <label> <command>.
      ...[...script.matchAll(/Write-Kv\s+"[^"]*"\s+(?:"([^"]*)"|'([^']*)')/g)]
        .map(match => match[1] ?? match[2]),
      // Prose that hands the user a command to type.
      ...[...script.matchAll(/(?:run|with):\s*(openrappter [^"']+)/g)].map(match => match[1]),
    ]
      .map(line => line.trim())
      .filter(line => line.startsWith('openrappter '));

    expect(advertised.length).toBeGreaterThan(0);

    for (const line of advertised) {
      const token = line.split(/\s+/)[1];
      if (token.startsWith('-')) {
        expect(
          surface.options.has(token),
          `install.ps1 advertises "${line}", but the CLI registers no ${token} option`,
        ).toBe(true);
      } else if (/^[a-z][\w-]*$/.test(token)) {
        expect(
          surface.commands.has(token),
          `install.ps1 advertises "${line}", which the CLI does not register`,
        ).toBe(true);
      }
      // Anything else is a quoted argument, e.g. openrappter "hello".
    }
  });

  it('probes an endpoint the gateway actually serves', async () => {
    const body = functionBody(script, 'Test-GatewayAnswering');
    const probed = /http:\/\/127\.0\.0\.1:\$Port(\/[\w-]+)/.exec(body);
    expect(probed, 'the readiness probe should name a loopback URL path').not.toBeNull();

    // A typo here would poll a 404 forever and report a healthy gateway as
    // failed, so the path is checked against the server that has to answer it.
    const server = await fs.readFile(path.join(srcRoot, 'gateway', 'server.ts'), 'utf-8');
    expect(server).toContain(`req.url === '${probed![1]}'`);
  });

  it('does not credit itself with a gateway that was already running', () => {
    // Any gateway already bound to the port answers the probe regardless of
    // what was just launched, so the pre-flight check has to run before the
    // launch for the readiness result to mean anything.
    const body = functionBody(script, 'Start-GatewayBrainstem');
    const preflight = body.indexOf('Test-GatewayAnswering');
    const launch = body.indexOf('Start-Process');

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeLessThan(launch);
  });

  it('treats process exit as failure rather than waiting out the timeout', () => {
    const body = functionBody(script, 'Wait-GatewayReady');
    expect(body).toContain('HasExited');
    expect(body).toMatch(/TimeoutSeconds/);
  });

  it('reports success only after readiness, never on a PID alone', () => {
    const body = functionBody(script, 'Start-GatewayBrainstem');

    const launch = body.indexOf('Start-Process');
    const readiness = body.indexOf('Wait-GatewayReady');
    const gate = body.indexOf('if (-not $readiness.Ready)');
    const recordPid = body.indexOf('Set-Content -Path $GATEWAY_PID');
    // Only the line that claims a PID is at stake here; the "already running"
    // branch reports a gateway it probed rather than one it launched.
    const pidClaim = [...body.matchAll(/Write-Success[^\r\n]*/g)]
      .find(match => match[0].includes('$proc.Id'));

    expect(launch).toBeGreaterThanOrEqual(0);
    expect(readiness).toBeGreaterThan(launch);
    expect(gate).toBeGreaterThan(readiness);
    expect(pidClaim, 'the launch should report the PID it verified').toBeDefined();
    // A PID is not readiness. Both the recorded PID and the success line must
    // sit behind the gate, or the installer is back to announcing a daemon it
    // never observed.
    expect(recordPid).toBeGreaterThan(gate);
    expect(pidClaim!.index).toBeGreaterThan(gate);
  });

  it('gives up on a gateway that never answers instead of claiming one', () => {
    const body = functionBody(script, 'Start-GatewayBrainstem');
    const failure = body.slice(body.indexOf('if (-not $readiness.Ready)'));
    expect(failure).toContain('Write-Warn');
    expect(failure).toContain('$($readiness.Reason)');
    // The failure path has to leave the function without recording a PID.
    expect(failure.indexOf('return')).toBeLessThan(failure.indexOf('Set-Content'));
  });

  it('verifies the entry point exists before launching node', () => {
    const body = functionBody(script, 'Resolve-GatewayEntry');
    expect(body).toContain('Test-Path');

    const start = functionBody(script, 'Start-GatewayBrainstem');
    const resolve = start.indexOf('Resolve-GatewayEntry');
    const guard = start.indexOf('if (-not $entry)');
    const launch = start.indexOf('Start-Process');

    expect(resolve).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(resolve);
    expect(launch).toBeGreaterThan(guard);
  });

  it('verifies the installer-owned launcher before setup or success', () => {
    const main = functionBody(script, 'Main');
    const install = main.indexOf('Install-ViaNpm');
    const verify = main.indexOf('Confirm-InstalledOpenRappter');
    const setup = main.indexOf('Setup-CopilotSdk');

    expect(install).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(install);
    expect(setup).toBeGreaterThan(verify);

    const confirmation = functionBody(script, 'Confirm-InstalledOpenRappter');
    expect(confirmation).toContain('Resolve-OwnedOpenRappterBin');
    expect(confirmation).toContain('Resolve-InstalledPackageVersion');
    expect(confirmation).toContain('& $owned --version');
    expect(confirmation).toContain('$actual -ne $expected');
    expect(confirmation).toContain('$script:InstalledOpenRappterBin = $owned');
    expect(confirmation).toContain('$script:InstalledOpenRappterVersion = $expected');
  });

  it('does not treat an arbitrary PATH launcher as the npm artifact', () => {
    const npmInstall = functionBody(script, 'Install-ViaNpm');
    expect(npmInstall).toContain('Resolve-OwnedOpenRappterBin');
    expect(npmInstall).not.toContain('Get-Command openrappter');

    const resolver = functionBody(script, 'Resolve-OwnedOpenRappterBin');
    expect(resolver).toContain('Get-NpmGlobalPrefix');
    expect(resolver).toContain('"openrappter.cmd"');

    const precedence = functionBody(script, 'Ensure-OwnedLauncherPrecedence');
    expect(precedence).toContain('Get-Command openrappter');
    expect(precedence).toContain('$env:Path = "$ownedDir;$env:Path"');
    expect(precedence).toContain('SetEnvironmentVariable("Path", $nextUserPath, "User")');
  });

  it('uses the verified launcher for status, doctor, gateway, and onboarding', () => {
    const main = functionBody(script, 'Main');
    expect(main).toContain('$script:InstalledOpenRappterBin');
    expect(main).toContain('& $openrappterBin.Source --status');
    expect(main).toContain('$installedVersion = $script:InstalledOpenRappterVersion');
    expect(main).toContain('& $openrappterBin.Source onboard');
    expect(main).not.toContain('& openrappter --version');

    const doctor = functionBody(script, 'Invoke-DoctorIfAvailable');
    expect(doctor).toContain('$script:InstalledOpenRappterBin');
    expect(doctor).toContain('& $bin.Source doctor --json');

    const gateway = functionBody(script, 'Start-GatewayBrainstem');
    expect(gateway).toContain('$script:InstalledOpenRappterBin');
  });

  it('ships the same script it serves from docs/', async () => {
    // `irm https://kody-w.github.io/openrappter/install.ps1 | iex` fetches the
    // docs/ copy. Fixing only the repo root would leave every piped install on
    // the broken script.
    const served = await fs.readFile(DOCS_INSTALL_PS1, 'utf-8');
    expect(served).toBe(script);
  });
});
