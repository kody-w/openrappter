import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const OPENRAPPTER_LAUNCH_AGENT_LABEL = 'com.openrappter.gateway';
export const OPENRAPPTER_SYSTEM_DAEMON_LABEL = 'com.openrappter.rappterone';
export const OPENRAPPTER_USER_GATEWAY_MARKER =
  'gateway-user-agent.enabled';
const DEFAULT_PORT = 18_790;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_FILES = 3;

export interface LaunchdCommandResult {
  exitCode: number;
  stdout: string;
}

async function writeDelegationMarker(
  markerPath: string,
  state: 'preparing' | 'active',
  port: number,
  expiresAt?: number,
): Promise<void> {
  await writePrivateFile(markerPath, `${JSON.stringify({
    version: 1,
    state,
    port,
    expiresAt: expiresAt
      ? new Date(expiresAt).toISOString()
      : null,
  })}\n`);
}

export type LaunchdCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<LaunchdCommandResult>;

export interface IMessageLaunchAgentOptions {
  homeDirectory?: string;
  nodePath?: string;
  entryPath?: string;
  workingDirectory?: string;
  port?: number;
  uid?: number;
  pathEnvironment?: string;
  commandRunner?: LaunchdCommandRunner;
  waitForStart?: boolean;
  healthTimeoutMs?: number;
  checkHttp?: boolean;
  delegateSystemService?: boolean;
}

export interface IMessageServiceStatus {
  installed: boolean;
  loaded: boolean;
  supervisor: 'user' | 'system' | 'none';
  live: boolean;
  ready: boolean;
  readinessReason?: string;
}

interface ResolvedLaunchAgentOptions {
  homeDirectory: string;
  nodePath: string;
  entryPath: string;
  workingDirectory: string;
  port: number;
  uid: number;
  pathEnvironment: string;
  commandRunner: LaunchdCommandRunner;
  waitForStart: boolean;
  healthTimeoutMs: number;
  checkHttp: boolean;
  delegateSystemService: boolean;
}

const defaultCommandRunner: LaunchdCommandRunner = (
  executable,
  args,
) => new Promise(resolve => {
  execFile(
    executable,
    [...args],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    },
    (error, stdout) => {
      resolve({
        exitCode:
          error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        stdout: String(stdout),
      });
    },
  );
});

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function stringValue(value: string, indentation = '    '): string {
  return `${indentation}<string>${xml(value)}</string>`;
}

function keyValue(value: string, indentation = '    '): string {
  return `${indentation}<key>${xml(value)}</key>`;
}

function arrayValue(values: readonly string[]): string {
  return [
    '  <array>',
    ...values.map(value => stringValue(value)),
    '  </array>',
  ].join('\n');
}

function defaultEntryPath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const besideCompiledModule = path.resolve(moduleDirectory, '..', 'index.js');
  if (moduleDirectory.includes(`${path.sep}dist${path.sep}`)) {
    return besideCompiledModule;
  }
  return path.resolve(moduleDirectory, '..', '..', 'dist', 'index.js');
}

function resolveOptions(
  options: IMessageLaunchAgentOptions = {},
): ResolvedLaunchAgentOptions {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const entryPath = options.entryPath ?? defaultEntryPath();
  const port =
    Number.isSafeInteger(options.port)
    && (options.port ?? 0) >= 1
    && (options.port ?? 0) <= 65_535
      ? options.port!
      : DEFAULT_PORT;
  return {
    homeDirectory,
    nodePath: options.nodePath ?? process.execPath,
    entryPath,
    workingDirectory:
      options.workingDirectory ?? path.dirname(path.dirname(entryPath)),
    port,
    uid: options.uid ?? process.getuid?.() ?? 0,
    pathEnvironment:
      options.pathEnvironment
      ?? process.env.PATH
      ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    commandRunner: options.commandRunner ?? defaultCommandRunner,
    waitForStart: options.waitForStart ?? true,
    healthTimeoutMs:
      Number.isFinite(options.healthTimeoutMs)
      && (options.healthTimeoutMs ?? 0) > 0
        ? Math.floor(options.healthTimeoutMs!)
        : 180_000,
    checkHttp: options.checkHttp ?? true,
    delegateSystemService: options.delegateSystemService ?? true,
  };
}

export function buildLaunchAgentPlist(
  options: IMessageLaunchAgentOptions = {},
): string {
  const resolved = resolveOptions(options);
  const logDirectory = path.join(
    resolved.homeDirectory,
    '.openrappter',
    'logs',
  );
  const environment = {
    HOME: resolved.homeDirectory,
    PATH: resolved.pathEnvironment,
    NODE_ENV: 'production',
    OPENRAPPTER_LAUNCHD: '1',
  };
  const environmentXml = Object.entries(environment)
    .flatMap(([key, value]) => [
      keyValue(key, '      '),
      stringValue(value, '      '),
    ])
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    stringValue(OPENRAPPTER_LAUNCH_AGENT_LABEL, '  '),
    '  <key>ProgramArguments</key>',
    arrayValue([
      resolved.nodePath,
      resolved.entryPath,
      '--daemon',
      '--port',
      String(resolved.port),
    ]),
    '  <key>WorkingDirectory</key>',
    stringValue(resolved.workingDirectory, '  '),
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>15</integer>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>Umask</key>',
    '  <integer>63</integer>',
    '  <key>StandardOutPath</key>',
    stringValue(path.join(logDirectory, 'gateway.stdout.log'), '  '),
    '  <key>StandardErrorPath</key>',
    stringValue(path.join(logDirectory, 'gateway.stderr.log'), '  '),
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    environmentXml,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export async function installIMessageLaunchAgent(
  options: IMessageLaunchAgentOptions = {},
): Promise<IMessageServiceStatus> {
  const resolved = resolveOptions(options);
  const domain = `gui/${resolved.uid}`;
  const serviceTarget = `${domain}/${OPENRAPPTER_LAUNCH_AGENT_LABEL}`;
  const systemService = await resolved.commandRunner(
    '/bin/launchctl',
    ['print', `system/${OPENRAPPTER_SYSTEM_DAEMON_LABEL}`],
  );
  const priorUserService = await resolved.commandRunner(
    '/bin/launchctl',
    ['print', serviceTarget],
  );
  if (
    systemService.exitCode === 0
    && !resolved.delegateSystemService
  ) {
    if (resolved.waitForStart) {
      await waitForLive(resolved.port, resolved.healthTimeoutMs);
      await waitForReady(
        resolved.port,
        Math.min(resolved.healthTimeoutMs, 60_000),
      );
    }
    return getIMessageServiceStatus(resolved);
  }
  const userServiceWasLoaded = priorUserService.exitCode === 0;
  const markerPath = path.join(
    resolved.homeDirectory,
    '.openrappter',
    OPENRAPPTER_USER_GATEWAY_MARKER,
  );
  const previousMarker = await fs.readFile(markerPath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  await assertExecutable(resolved.nodePath, 'Node.js runtime');
  await assertReadable(resolved.entryPath, 'OpenRappter compiled runtime');

  const openRappterDirectory = path.join(
    resolved.homeDirectory,
    '.openrappter',
  );
  const logDirectory = path.join(openRappterDirectory, 'logs');
  const launchAgentsDirectory = path.join(
    resolved.homeDirectory,
    'Library',
    'LaunchAgents',
  );
  await Promise.all([
    fs.mkdir(openRappterDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(logDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(launchAgentsDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    fs.chmod(openRappterDirectory, 0o700),
    fs.chmod(logDirectory, 0o700),
  ]);
  await rotateLogs(logDirectory);

  const plistPath = path.join(
    launchAgentsDirectory,
    `${OPENRAPPTER_LAUNCH_AGENT_LABEL}.plist`,
  );
  const previousPlist = await fs.readFile(plistPath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  const temporaryPath = `${plistPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, buildLaunchAgentPlist(resolved), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  let lint: LaunchdCommandResult;
  try {
    lint = await resolved.commandRunner(
      '/usr/bin/plutil',
      ['-lint', temporaryPath],
    );
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  if (lint.exitCode !== 0) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw new Error('Generated OpenRappter launch agent is invalid');
  }

  try {
    await fs.rename(temporaryPath, plistPath);
    await fs.chmod(plistPath, 0o600);
    if (userServiceWasLoaded) {
      const bootout = await resolved.commandRunner(
        '/bin/launchctl',
        ['bootout', serviceTarget],
      );
      if (bootout.exitCode !== 0) {
        throw new Error('Failed to stop the existing OpenRappter launch agent');
      }
    }
    if (systemService.exitCode === 0) {
      await writeDelegationMarker(
        markerPath,
        'preparing',
        resolved.port,
        Date.now() + resolved.healthTimeoutMs + 30_000,
      );
      if (resolved.checkHttp) {
        await waitForPortVacated(resolved.port, 10_000);
      }
    }
    const bootstrap = await resolved.commandRunner(
      '/bin/launchctl',
      ['bootstrap', domain, plistPath],
    );
    if (bootstrap.exitCode !== 0) {
      throw new Error('Failed to bootstrap the OpenRappter launch agent');
    }
    const enable = await resolved.commandRunner(
      '/bin/launchctl',
      ['enable', serviceTarget],
    );
    if (enable.exitCode !== 0) {
      throw new Error('Failed to enable the OpenRappter launch agent');
    }
    const kickstart = await resolved.commandRunner(
      '/bin/launchctl',
      ['kickstart', '-k', serviceTarget],
    );
    if (kickstart.exitCode !== 0) {
      throw new Error('Failed to start the OpenRappter launch agent');
    }

    if (resolved.waitForStart) {
      await waitForLive(resolved.port, resolved.healthTimeoutMs);
      await waitForReady(
        resolved.port,
        Math.min(resolved.healthTimeoutMs, 60_000),
      );
    }
    if (systemService.exitCode === 0) {
      await writeDelegationMarker(markerPath, 'active', resolved.port);
    }
    return getIMessageServiceStatus(resolved);
  } catch (error) {
    await resolved.commandRunner('/bin/launchctl', ['bootout', serviceTarget]);
    if (previousPlist === null) {
      await fs.unlink(plistPath).catch(() => undefined);
    } else {
      await writePrivateFile(plistPath, previousPlist);
      if (userServiceWasLoaded) {
        const restored = await resolved.commandRunner(
          '/bin/launchctl',
          ['bootstrap', domain, plistPath],
        );
        if (restored.exitCode === 0) {
          await resolved.commandRunner(
            '/bin/launchctl',
            ['enable', serviceTarget],
          );
          await resolved.commandRunner(
            '/bin/launchctl',
            ['kickstart', '-k', serviceTarget],
          );
        }
      }
    }
    if (previousMarker === null) {
      await fs.unlink(markerPath).catch(() => undefined);
    } else {
      await writePrivateFile(markerPath, previousMarker);
    }
    throw error;
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

export async function uninstallIMessageLaunchAgent(
  options: IMessageLaunchAgentOptions = {},
): Promise<void> {
  const resolved = resolveOptions(options);
  const domain = `gui/${resolved.uid}`;
  const serviceTarget = `${domain}/${OPENRAPPTER_LAUNCH_AGENT_LABEL}`;
  const plistPath = path.join(
    resolved.homeDirectory,
    'Library',
    'LaunchAgents',
    `${OPENRAPPTER_LAUNCH_AGENT_LABEL}.plist`,
  );
  const markerPath = path.join(
    resolved.homeDirectory,
    '.openrappter',
    OPENRAPPTER_USER_GATEWAY_MARKER,
  );
  const [plistContent, markerContent] = await Promise.all([
    fs.readFile(plistPath, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }),
    fs.readFile(markerPath, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }),
  ]);
  const current = await resolved.commandRunner(
    '/bin/launchctl',
    ['print', serviceTarget],
  );
  if (current.exitCode === 0) {
    const bootout = await resolved.commandRunner(
      '/bin/launchctl',
      ['bootout', serviceTarget],
    );
    if (bootout.exitCode !== 0) {
      throw new Error('Failed to stop the OpenRappter launch agent');
    }
  }
  try {
    await fs.unlink(plistPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await fs.unlink(markerPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  } catch (error) {
    if (plistContent !== null) {
      await writePrivateFile(plistPath, plistContent);
    }
    if (markerContent !== null) {
      await writePrivateFile(markerPath, markerContent);
    }
    if (current.exitCode === 0 && plistContent !== null) {
      const restored = await resolved.commandRunner(
        '/bin/launchctl',
        ['bootstrap', domain, plistPath],
      );
      if (restored.exitCode === 0) {
        await resolved.commandRunner('/bin/launchctl', ['enable', serviceTarget]);
        await resolved.commandRunner(
          '/bin/launchctl',
          ['kickstart', '-k', serviceTarget],
        );
      }
    }
    throw error;
  }
}

export async function getIMessageServiceStatus(
  options: IMessageLaunchAgentOptions = {},
): Promise<IMessageServiceStatus> {
  const resolved = resolveOptions(options);
  const plistPath = path.join(
    resolved.homeDirectory,
    'Library',
    'LaunchAgents',
    `${OPENRAPPTER_LAUNCH_AGENT_LABEL}.plist`,
  );
  const installed = await fs.access(plistPath).then(
    () => true,
    () => false,
  );
  const print = await resolved.commandRunner(
    '/bin/launchctl',
    [
      'print',
      `gui/${resolved.uid}/${OPENRAPPTER_LAUNCH_AGENT_LABEL}`,
    ],
  );
  const systemPrint = await resolved.commandRunner(
    '/bin/launchctl',
    ['print', `system/${OPENRAPPTER_SYSTEM_DAEMON_LABEL}`],
  );
  const [liveResponse, readyResponse] = resolved.checkHttp
    ? await Promise.all([
        fetchLocalStatus(resolved.port, '/livez'),
        fetchLocalStatus(resolved.port, '/readyz'),
      ])
    : [{ ok: false }, { ok: false }];
  return {
    installed: installed || systemPrint.exitCode === 0,
    loaded: print.exitCode === 0 || systemPrint.exitCode === 0,
    supervisor:
      print.exitCode === 0
        ? 'user'
        : systemPrint.exitCode === 0
          ? 'system'
          : 'none',
    live: liveResponse.ok,
    ready: readyResponse.ok,
    readinessReason:
      typeof readyResponse.body?.reason === 'string'
        ? readyResponse.body.reason
        : undefined,
  };
}

async function fetchLocalStatus(
  port: number,
  endpoint: string,
): Promise<{ ok: boolean; body?: Record<string, unknown> }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      signal: AbortSignal.timeout(2_000),
    });
    const body = await response.json() as Record<string, unknown>;
    return { ok: response.ok, body };
  } catch {
    return { ok: false };
  }
}

async function waitForLive(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await fetchLocalStatus(port, '/livez')).ok) return;
    await new Promise<void>(resolve => setTimeout(resolve, 500));
  }
  throw new Error('OpenRappter launch agent did not become live');
}

async function waitForReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await fetchLocalStatus(port, '/readyz')).ok) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 1_000));
  }
  return false;
}

async function waitForPortVacated(
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fetchLocalStatus(port, '/livez')).ok) return;
    await new Promise<void>(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Existing OpenRappter service did not release the gateway port');
}

async function assertExecutable(filePath: string, label: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.X_OK);
  } catch {
    throw new Error(`${label} is not executable`);
  }
}

async function writePrivateFile(
  filePath: string,
  content: string,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.restore`;
  await fs.writeFile(temporaryPath, content, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  try {
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function assertReadable(filePath: string, label: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.R_OK);
  } catch {
    throw new Error(`${label} is unavailable; build OpenRappter first`);
  }
}

async function rotateLogs(logDirectory: string): Promise<void> {
  for (const name of ['gateway.stdout.log', 'gateway.stderr.log']) {
    const filePath = path.join(logDirectory, name);
    let size = 0;
    try {
      size = (await fs.stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (size >= MAX_LOG_BYTES) {
      for (let index = MAX_LOG_FILES - 1; index >= 1; index--) {
        await fs.rename(
          `${filePath}.${index}`,
          `${filePath}.${index + 1}`,
        ).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
      await fs.rename(filePath, `${filePath}.1`);
    }
    await fs.chmod(filePath, 0o600).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}
