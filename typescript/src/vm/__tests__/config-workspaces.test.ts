import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOmarchyVmConfig, parseOmarchyVmConfig, VM_CONFIG_FILE } from '../config.js';
import { createHostTartVmSupervisor } from '../tart-vm-supervisor.js';
import { HostVmWorkspaces } from '../workspaces.js';
import { testConfig } from './fake-runner.js';
import { testEvidence } from './fake-rapp-persistence.js';

let directory: string;
beforeEach(async () => {
  const root = path.join(process.cwd(), '.test-scratch');
  await fs.mkdir(root, { recursive: true });
  directory = await fs.mkdtemp(path.join(root, 'omarchy-config-'));
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

describe('host configuration', () => {
  it('uses a versioned reference and explicit sha256 without downloading or provisioning', () => {
    const config = parseOmarchyVmConfig(testConfig);
    expect(config.image.reference.endsWith(`:${config.image.version}`)).toBe(true);
    expect(config.image.sha256).toHaveLength(64);
    expect(config.tartBinary).toBe('/opt/homebrew/bin/tart');
    expect(loadOmarchyVmConfig(directory)).toBeUndefined();
  });

  it.each([
    { name: '../other' }, { name: '--help' }, { name: 'vm;id' },
    { tartBinary: 'tart' }, { tartBinary: '/bin/sh' },
    { tartBinary: '/host/../bin/tart' },
    { image: { ...testConfig.image, sha256: '' } },
    { image: { ...testConfig.image, sha256: 'z'.repeat(64) } },
    { image: { ...testConfig.image, reference: 'registry.example.test/omarchy:latest' } },
    { image: { ...testConfig.image, reference: 'https://untrusted/image' } },
    { image: { ...testConfig.image, version: 'latest' } },
    { ssh: { ...testConfig.ssh, user: 'root' } },
    { ssh: { ...testConfig.ssh, user: '-oProxyCommand=id' } },
    { ssh: { ...testConfig.ssh, identityFile: '~/.ssh/key' } },
    { ssh: { ...testConfig.ssh, identityFile: '/host/%d/key' } },
    { ssh: { ...testConfig.ssh, knownHostsFile: '/host/known\nHosts' } },
    { ssh: { ...testConfig.ssh, strictHostKeyChecking: false } },
    { workspaces: [{ agentId: 'a', workspaceId: '../b' }] },
    { workspaces: [...testConfig.workspaces, ...testConfig.workspaces] },
    { allowedExecutables: ['git;id'] }, { allowedExecutables: ['/host/script'] },
    { readyTimeoutMs: 0 }, { execTimeoutMs: Infinity }, { pollIntervalMs: 0 },
    { extraTartArgs: ['--dir=/'] }, { hostShell: true },
  ])('rejects unsafe or unpinned configuration: %j', (overrides) => {
    expect(() => parseOmarchyVmConfig({ ...testConfig, ...overrides })).toThrowError(/Invalid host Omarchy VM configuration/);
  });

  it('reads only the host-owned file and reports invalid JSON without echoing it', async () => {
    const file = path.join(directory, VM_CONFIG_FILE);
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, JSON.stringify(testConfig), { mode: 0o600 });
    expect(loadOmarchyVmConfig(directory)).toEqual(testConfig);
    await fs.writeFile(file, 'private-malformed-configuration');
    expect(() => loadOmarchyVmConfig(directory)).toThrowError(/Could not read/);
    const supervisor = createHostTartVmSupervisor(directory);
    expect(await supervisor.status()).toMatchObject({ state: 'unavailable', error: { code: 'invalid_configuration' } });
    await supervisor.shutdown();
  });

  it.skipIf(process.platform === 'win32')('rejects writable-by-others and symlinked host configuration', async () => {
    const file = path.join(directory, VM_CONFIG_FILE);
    await fs.mkdir(path.dirname(file));
    const other = path.join(directory, 'other.json');
    await fs.writeFile(other, JSON.stringify(testConfig), { mode: 0o600 });
    await fs.symlink(other, file);
    expect(() => loadOmarchyVmConfig(directory)).toThrowError(/owner-controlled/);
    await fs.unlink(file);
    await fs.writeFile(file, JSON.stringify(testConfig));
    await fs.chmod(file, 0o666);
    expect(() => loadOmarchyVmConfig(directory)).toThrowError(/owner-controlled/);
  });

  it('copies configuration so later caller mutation cannot change the binary or approved identities', () => {
    const input = structuredClone(testConfig);
    const config = parseOmarchyVmConfig(input);
    input.tartBinary = '/another/tart';
    input.workspaces[0].agentId = 'other';
    expect(config.tartBinary).toBe(testConfig.tartBinary);
    expect(config.workspaces).toEqual(testConfig.workspaces);
  });
});

describe('host workspace identities', () => {
  it('creates separate persistent host directories and deterministic future mount points', async () => {
    const registry = new HostVmWorkspaces(directory, [
      { agentId: 'agent-a', workspaceId: 'project' },
      { agentId: 'agent-b', workspaceId: 'project' },
    ], testEvidence());
    const [a, b] = await Promise.all([
      registry.resolve({ agentId: 'agent-a', workspaceId: 'project' }),
      registry.resolve({ agentId: 'agent-b', workspaceId: 'project' }),
    ]);
    expect(a.hostPath).not.toBe(b.hostPath);
    expect(a.guestPath).toBe('/workspaces/agent-a/project');
    await fs.writeFile(path.join(a.hostPath, 'keep.txt'), 'persistent');
    await registry.resolve({ agentId: 'agent-a', workspaceId: 'project' });
    expect(await fs.readFile(path.join(a.hostPath, 'keep.txt'), 'utf8')).toBe('persistent');
    expect(await fs.readdir(b.hostPath)).toEqual([]);
  });

  it('rejects unknown and unsafe pairs without creating any host workspace', async () => {
    const registry = new HostVmWorkspaces(directory, testConfig.workspaces, testEvidence());
    await expect(registry.resolve({ agentId: 'agent-b', workspaceId: 'project-1' })).rejects.toMatchObject({ code: 'workspace_denied' });
    await expect(registry.resolve({ agentId: '../agent-a', workspaceId: 'project-1' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('refuses a workspace symlink before creating files in its target', async () => {
    const registry = new HostVmWorkspaces(directory, testConfig.workspaces, testEvidence());
    const other = path.join(directory, 'unrelated');
    await fs.mkdir(other);
    await fs.mkdir(path.join(directory, 'workspaces'));
    await fs.symlink(other, path.join(directory, 'workspaces', 'agent-a'));
    await expect(registry.resolve(testConfig.workspaces[0])).rejects.toMatchObject({ code: 'workspace_denied' });
    expect(await fs.readdir(other)).toEqual([]);
  });
});
