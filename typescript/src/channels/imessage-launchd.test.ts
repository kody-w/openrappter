import fs from 'fs/promises';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLaunchAgentPlist,
  installIMessageLaunchAgent,
  OPENRAPPTER_LAUNCH_AGENT_LABEL,
  OPENRAPPTER_USER_GATEWAY_MARKER,
  uninstallIMessageLaunchAgent,
  type LaunchdCommandRunner,
} from './imessage-launchd.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await fs.mkdtemp(path.join(process.cwd(), '.launchd-test-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(value => fs.rm(value, { recursive: true, force: true })),
  );
});

describe('iMessage launch agent', () => {
  it('builds a private throttled launchd definition without credentials', () => {
    const plist = buildLaunchAgentPlist({
      homeDirectory: '/Users/test',
      nodePath: '/managed/node',
      entryPath: '/runtime/dist/index.js',
      workingDirectory: '/runtime',
      port: 19999,
      uid: 501,
      pathEnvironment: '/managed:/usr/bin',
    });

    expect(plist).toContain(OPENRAPPTER_LAUNCH_AGENT_LABEL);
    expect(plist).toContain('/managed/node');
    expect(plist).toContain('/runtime/dist/index.js');
    expect(plist).toContain('<integer>15</integer>');
    expect(plist).toContain('<integer>63</integer>');
    expect(plist).toContain('OPENRAPPTER_LAUNCHD');
    expect(plist).toContain('<key>HOME</key>');
    expect(plist).not.toMatch(/TOKEN|PASSWORD|SECRET/);
  });

  it('uses modern launchctl commands and writes a private plist', async () => {
    const homeDirectory = await root();
    const nodePath = path.join(homeDirectory, 'node');
    const entryPath = path.join(homeDirectory, 'runtime', 'dist', 'index.js');
    await fs.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.writeFile(nodePath, '#!/bin/sh\n', { mode: 0o700 });
    await fs.writeFile(entryPath, 'export {};\n', { mode: 0o600 });
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const commandRunner: LaunchdCommandRunner = async (executable, args) => {
      calls.push({ executable, args: [...args] });
      if (
        args[0] === 'print'
        && args[1] === 'system/com.openrappter.rappterone'
      ) {
        return { exitCode: 1, stdout: '' };
      }
      return { exitCode: 0, stdout: '' };
    };

    await installIMessageLaunchAgent({
      homeDirectory,
      nodePath,
      entryPath,
      workingDirectory: path.join(homeDirectory, 'runtime'),
      uid: 501,
      port: 19999,
      commandRunner,
      waitForStart: false,
      checkHttp: false,
    });

    expect(calls.map(call => call.args[0])).toEqual([
      'print',
      'print',
      '-lint',
      'bootout',
      'bootstrap',
      'enable',
      'kickstart',
      'print',
      'print',
    ]);
    const plistPath = path.join(
      homeDirectory,
      'Library',
      'LaunchAgents',
      `${OPENRAPPTER_LAUNCH_AGENT_LABEL}.plist`,
    );
    expect((await fs.stat(plistPath)).mode & 0o777).toBe(0o600);
  });

  it('delegates an existing system daemon before starting the user agent', async () => {
    const homeDirectory = await root();
    const nodePath = path.join(homeDirectory, 'node');
    const entryPath = path.join(homeDirectory, 'runtime', 'dist', 'index.js');
    await fs.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.writeFile(nodePath, '#!/bin/sh\n', { mode: 0o700 });
    await fs.writeFile(entryPath, 'export {};\n', { mode: 0o600 });
    const commandRunner: LaunchdCommandRunner = async (_executable, args) => {
      if (
        args[0] === 'print'
        && args[1] === 'system/com.openrappter.rappterone'
      ) {
        return { exitCode: 0, stdout: '    pid = 4321\n' };
      }
      return { exitCode: 0, stdout: '' };
    };

    const status = await installIMessageLaunchAgent({
      homeDirectory,
      nodePath,
      entryPath,
      workingDirectory: path.join(homeDirectory, 'runtime'),
      uid: 501,
      port: 19999,
      commandRunner,
      waitForStart: false,
      checkHttp: false,
    });

    expect(status).toMatchObject({
      installed: true,
      loaded: true,
      supervisor: 'user',
    });
    expect(JSON.parse(await fs.readFile(
      path.join(
        homeDirectory,
        '.openrappter',
        OPENRAPPTER_USER_GATEWAY_MARKER,
      ),
      'utf8',
    ))).toMatchObject({
      version: 1,
      state: 'active',
      port: 19999,
      expiresAt: null,
    });
  });

  it('adopts a system daemon for generic gateway startup without delegation', async () => {
    const homeDirectory = await root();
    const calls: string[] = [];
    const commandRunner: LaunchdCommandRunner = async (_executable, args) => {
      calls.push(args.join(' '));
      if (
        args[0] === 'print'
        && args[1] === 'system/com.openrappter.rappterone'
      ) {
        return { exitCode: 0, stdout: '' };
      }
      return { exitCode: 1, stdout: '' };
    };

    const status = await installIMessageLaunchAgent({
      homeDirectory,
      uid: 501,
      commandRunner,
      delegateSystemService: false,
      waitForStart: false,
      checkHttp: false,
    });

    expect(status).toMatchObject({
      installed: true,
      loaded: true,
      supervisor: 'system',
    });
    expect(calls.some(call => call.startsWith('bootstrap'))).toBe(false);
    await expect(fs.access(path.join(
      homeDirectory,
      '.openrappter',
      OPENRAPPTER_USER_GATEWAY_MARKER,
    ))).rejects.toThrow();
  });

  it('restores the prior agent and marker state after installation failure', async () => {
    const homeDirectory = await root();
    const nodePath = path.join(homeDirectory, 'node');
    const entryPath = path.join(homeDirectory, 'runtime', 'dist', 'index.js');
    const launchDirectory = path.join(homeDirectory, 'Library', 'LaunchAgents');
    const plistPath = path.join(
      launchDirectory,
      `${OPENRAPPTER_LAUNCH_AGENT_LABEL}.plist`,
    );
    await fs.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.mkdir(launchDirectory, { recursive: true });
    await fs.writeFile(nodePath, '#!/bin/sh\n', { mode: 0o700 });
    await fs.writeFile(entryPath, 'export {};\n', { mode: 0o600 });
    await fs.writeFile(plistPath, 'previous plist', { mode: 0o600 });
    let bootstrapCalls = 0;
    const commandRunner: LaunchdCommandRunner = async (_executable, args) => {
      if (
        args[0] === 'print'
        && args[1] === 'system/com.openrappter.rappterone'
      ) {
        return { exitCode: 0, stdout: '' };
      }
      if (args[0] === 'bootstrap') {
        bootstrapCalls++;
        return { exitCode: bootstrapCalls === 1 ? 1 : 0, stdout: '' };
      }
      return { exitCode: 0, stdout: '' };
    };

    await expect(installIMessageLaunchAgent({
      homeDirectory,
      nodePath,
      entryPath,
      workingDirectory: path.join(homeDirectory, 'runtime'),
      uid: 501,
      commandRunner,
      waitForStart: false,
      checkHttp: false,
    })).rejects.toThrow(/bootstrap/);

    expect(await fs.readFile(plistPath, 'utf8')).toBe('previous plist');
    await expect(fs.access(path.join(
      homeDirectory,
      '.openrappter',
      OPENRAPPTER_USER_GATEWAY_MARKER,
    ))).rejects.toThrow();
    expect(bootstrapCalls).toBe(2);
  });

  it('keeps the marker and plist when uninstall cannot stop the service', async () => {
    const homeDirectory = await root();
    const launchDirectory = path.join(homeDirectory, 'Library', 'LaunchAgents');
    const plistPath = path.join(
      launchDirectory,
      `${OPENRAPPTER_LAUNCH_AGENT_LABEL}.plist`,
    );
    const markerPath = path.join(
      homeDirectory,
      '.openrappter',
      OPENRAPPTER_USER_GATEWAY_MARKER,
    );
    await fs.mkdir(launchDirectory, { recursive: true });
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(plistPath, 'active plist');
    await fs.writeFile(markerPath, 'enabled\n');
    const commandRunner: LaunchdCommandRunner = async (_executable, args) => ({
      exitCode: args[0] === 'bootout' ? 1 : 0,
      stdout: '',
    });

    await expect(uninstallIMessageLaunchAgent({
      homeDirectory,
      uid: 501,
      commandRunner,
      checkHttp: false,
    })).rejects.toThrow(/stop/);
    await expect(fs.readFile(plistPath, 'utf8')).resolves.toBe('active plist');
    await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('enabled\n');
  });
});
