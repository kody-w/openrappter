import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFrame } from '@rapp-work/rapp1';
import { AgentRuntime } from '@rapp-work/agent-runtime';
import { ComputerBroker, type ComputerBrokerDependencies } from '@rapp-work/computer-broker';
import type { ModelProvider } from '@rapp-work/model-provider';
import { createHost, createLocalServices } from '../../apps/host/src/index.js';
import { computerScope, scopeA, scopeB, workspaceFixture } from './fixture.js';

const execution = vi.hoisted(() => ({ host: 0, home: '', legacyRoots: [] as string[], probes: [] as string[] }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const refuse = () => { execution.host += 1; throw new Error('Host shell execution is forbidden in acceptance'); };
  return { ...actual, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, spawn: refuse, spawnSync: refuse };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const watched = ['access', 'lstat', 'stat', 'open', 'readFile', 'readdir', 'opendir', 'realpath', 'readlink', 'cp', 'copyFile'] as const;
  return {
    ...actual,
    ...Object.fromEntries(watched.map(name => [name, (...args: unknown[]) => {
      const target = args[0] instanceof URL ? decodeURIComponent(args[0].pathname) : String(args[0]);
      if (execution.legacyRoots.some(root => target === root || target.startsWith(`${root}${path.sep}`))
        || (execution.home && target === execution.home && (name === 'readdir' || name === 'opendir'))) execution.probes.push(`${name}:${target}`);
      return Reflect.apply(actual[name], actual, args);
    }])),
  };
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  expect(execution.host).toBe(0);
  execution.host = 0;
  execution.home = '';
  execution.legacyRoots = [];
  execution.probes = [];
});

async function fixture() {
  const value = await workspaceFixture();
  cleanups.push(value.close);
  return value;
}

function brokerDependencies(work: ComputerBrokerDependencies['work'], available: boolean, guestFails = false) {
  const pin = Buffer.alloc(51, 7);
  pin.writeUInt32BE(11, 0);
  pin.write('ssh-ed25519', 4, 'ascii');
  pin.writeUInt32BE(32, 15);
  const configuration = {
    id: 'work-computer', historyScope: computerScope, vmName: 'rapp-work-computer',
    image: `registry.example/omarchy@sha256:${'a'.repeat(64)}`,
    hostKey: `ssh-ed25519 ${pin.toString('base64')}`, guestUser: 'rapp',
    maxExecutionMs: 10_000, maxLeaseMs: 60_000, maxOutputBytes: 4096, maxArtifactBytes: 4096,
  };
  const guestExecute = vi.fn(async (session: { expectedHostKey: string; workspace: typeof scopeA; intentRef: string }) => {
    if (guestFails) throw new Error('Injected guest transport failure');
    return { hostKey: session.expectedHostKey, workspace: session.workspace, intentRef: session.intentRef, exitCode: 0, stdout: 'guest', stderr: '' };
  });
  const clone = vi.fn(async () => {});
  const start = vi.fn(async () => {});
  const inspect = vi.fn(async () => available ? { name: configuration.vmName, sourceImage: configuration.image, operatingSystem: 'omarchy' as const, state: 'running' as const, hostMounts: [] } : undefined);
  const dependencies: ComputerBrokerDependencies = {
    work, configuration,
    leases: { async acquire() { return { id: 'lease-1', async assertHeld() {}, async release() {} }; } },
    tart: {
      inspect,
      clone, start, async stop() {}, async address() { return '192.0.2.1'; },
    },
    guest: { execute: guestExecute, async upload() { throw new Error('Not selected'); }, async download() { throw new Error('Not selected'); } },
    artifacts: { async read() { throw new Error('Not selected'); }, async write() { throw new Error('Not selected'); } },
  };
  return { dependencies, guestExecute, clone, start, inspect };
}

describe('clean release runtime acceptance', () => {
  it('startup-ignores-legacy-home', async () => {
    const root = path.resolve('tests/.test-scratch', randomUUID());
    await mkdir(root, { recursive: true, mode: 0o700 });
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const input = JSON.parse(await readFile(new URL('../fixtures/migration/legacy-home.json', import.meta.url), 'utf8')) as { sentinels: Array<{ path: string; content: string }> };
    for (const sentinel of input.sentinels) {
      const filename = path.join(root, sentinel.path);
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, sentinel.content, { mode: 0o600 });
    }
    vi.stubEnv('HOME', root);
    execution.home = root;
    execution.legacyRoots = [...new Set(input.sentinels.map(sentinel => path.join(root, sentinel.path.split('/')[0]!)))];
    const token = randomBytes(48).toString('base64url');
    const services = createLocalServices({ directory: path.join(root, 'work-data'), token });
    const host = await createHost(services);
    cleanups.push(() => host.close());
    const principal = (await services.security.authenticate(token))!;
    const snapshot = await services.work.snapshot({ principal, requestId: 'startup' });
    expect(snapshot.ownerId).toBe(principal.id);
    expect(snapshot.workspaceId).toBe(principal.workspaceId);
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.tasks).toEqual([]);
    expect(execution.probes).toEqual([]);
    execution.legacyRoots = [];
    execution.home = '';
    for (const sentinel of input.sentinels) expect(await readFile(path.join(root, sentinel.path), 'utf8')).toBe(sentinel.content);
    expect(JSON.stringify(snapshot)).not.toContain('SYNTHETIC-DO-NOT-IMPORT');
  });

  it('two-agent-ownership-isolation', async () => {
    const f = await fixture();
    const alice = f.workspaces.get(scopeA.workspaceId)!;
    const bob = f.workspaces.get(scopeB.workspaceId)!;
    const aliceFile = alice.artifact('private.txt', ['read', 'write']);
    const bobFile = bob.artifact('private.txt', ['read', 'write']);
    await alice.writeArtifact(aliceFile, Buffer.from('agent-a-private'));
    await bob.writeArtifact(bobFile, Buffer.from('agent-b-private'));
    await expect(bob.readArtifact(aliceFile)).rejects.toBeDefined();
    await expect(bob.writeArtifact(aliceFile, Buffer.from('intrusion'))).rejects.toBeDefined();
    await expect(f.work.read(f.capabilities.get(scopeA.workspaceId)!, scopeB)).rejects.toBeDefined();
    await expect(f.store.open({ workspaceId: scopeB.workspaceId } as never)).rejects.toBeDefined();
    const before = await bob.scan();
    const foreign = buildFrame({ kind: 'memory.save', streamId: alice.identity.memory_stream, head: null, utc: new Date().toISOString(), payload: { value: 'foreign' } });
    await expect(bob.compareAndAppend({ expectedHeads: before.heads, frames: [foreign] })).rejects.toBeDefined();
    expect(await alice.readArtifact(aliceFile)).toEqual(Buffer.from('agent-a-private'));
    expect(await bob.readArtifact(bobFile)).toEqual(Buffer.from('agent-b-private'));
    expect((await bob.scan()).heads).toEqual(before.heads);
  });

  it('frames-only-rebuild', async () => {
    const f = await fixture();
    const capability = f.capabilities.get(scopeA.workspaceId)!;
    const committed = await f.work.commit(capability, {
      scope: scopeA, operation: 'acceptance.task.create', idempotencyKey: 'task-one',
      payload: { title: 'Review the monthly close' }, resources: [{ kind: 'agent', id: scopeA.agentId }, { kind: 'workspace', id: scopeA.workspaceId }],
    }, async () => ({
      status: 'succeeded', value: { taskId: 'task-1' },
      events: [{ type: 'task.created', id: 'task-1', title: 'Review the monthly close' }],
      receipts: [{ kind: 'inert-reviewed-data' }],
    }));
    expect(committed.state).toBe('committed');
    const before = await f.work.read(capability, scopeA);
    expect(before.commands).toHaveLength(1);
    const reconstructed = await f.rebuild();
    expect(await reconstructed.read(capability, scopeA)).toEqual(before);
    const reducer = { initial: () => [] as string[], apply: (state: string[], command: { events: readonly { type?: unknown; title?: unknown }[] }) => [...state, ...command.events.filter(event => event.type === 'task.created').map(event => String(event.title))] };
    expect((await reconstructed.project(capability, scopeA, reducer)).value).toEqual(['Review the monthly close']);
  });

  it('missing-persistence-zero-execution', async () => {
    const f = await fixture();
    const providerCall = vi.fn(async () => ({ kind: 'final' as const, text: 'must not execute' }));
    const provider: ModelProvider = { id: 'fixture-provider', complete: providerCall };
    const toolCall = vi.fn(async () => { throw new Error('must not execute'); });
    const limits = { maxConcurrentRuns: 1, maxConcurrentTools: 1, maxStepsPerRun: 2, maxToolCallsPerRun: 1, maxDurationMs: 5000, maxOutputTokens: 128 };
    expect(() => new AgentRuntime({ work: undefined, provider, tools: [], limits } as never)).toThrow('missing_mandatory_port');
    const runtime = new AgentRuntime({ work: f.work, provider, tools: [{ description: { name: 'guest.exec', description: 'Guest fixture', inputSchema: { type: 'object' } }, validate() {}, execute: toolCall }], limits });
    const capability = f.capabilities.get(scopeA.workspaceId)!;
    const definition = {
      id: scopeA.agentId, workspaceId: scopeA.workspaceId, name: 'Close analyst', instructions: 'Work only inside the guest.', model: 'fixture-model', enabled: true,
      policy: { workspaceId: scopeA.workspaceId, allowedTools: ['guest.exec'], maxSteps: 2, maxToolCalls: 1, maxConcurrentRuns: 1, maxConcurrentTools: 1, maxDurationMs: 5000, maxOutputTokens: 128 },
    };
    expect((await runtime.definitions.save(capability, definition, 'agent-definition')).state).toBe('committed');
    f.faults.writes = true;
    const result = await runtime.run(capability, { scope: scopeA, taskId: 'task-1', runId: 'run-1', input: 'Review.' });
    expect(result.status).toBe('unresolved');
    expect(f.faults.rejectedWrites).toBeGreaterThan(0);
    expect(providerCall).not.toHaveBeenCalled();
    expect(toolCall).not.toHaveBeenCalled();
    expect(execution.host).toBe(0);
  });

  it('missing-computer-zero-execution', async () => {
    const f = await fixture();
    const inputs = brokerDependencies(f.work, false);
    expect(() => new ComputerBroker({ ...inputs.dependencies, guest: undefined } as never)).toThrow('missing_mandatory_port');
    const broker = new ComputerBroker(inputs.dependencies);
    const capability = f.capabilities.get(computerScope.workspaceId)!;
    const request = { parentIntentRef: 'parent-intent', taskId: 'task-1', runId: 'run-1' };
    const acquired = await broker.acquire(capability, scopeA, { ...request, idempotencyKey: 'acquire' });
    expect(acquired.state).toBe('acquired');
    if (acquired.state !== 'acquired') throw new Error('No test lease was acquired');
    const result = await broker.execute(capability, acquired.lease, { ...request, idempotencyKey: 'execute', argv: ['/usr/bin/printf', 'fixture'], cwd: '.', timeoutMs: 10_000 });
    expect(result.state).toBe('unresolved');
    expect(inputs.inspect).toHaveBeenCalledTimes(1);
    expect(inputs.guestExecute).not.toHaveBeenCalled();
    expect(inputs.clone).not.toHaveBeenCalled();
    expect(inputs.start).not.toHaveBeenCalled();
    expect(execution.host).toBe(0);
  });

  it('no-host-shell-fallback', async () => {
    const f = await fixture();
    const inputs = brokerDependencies(f.work, true, true);
    const broker = new ComputerBroker(inputs.dependencies);
    const capability = f.capabilities.get(computerScope.workspaceId)!;
    const request = { parentIntentRef: 'parent-intent', taskId: 'task-1', runId: 'run-1' };
    const acquired = await broker.acquire(capability, scopeA, { ...request, idempotencyKey: 'acquire' });
    if (acquired.state !== 'acquired') throw new Error('No test lease was acquired');
    const operation = { ...request, idempotencyKey: 'execute', argv: ['/usr/bin/printf', 'fixture'], cwd: '.', timeoutMs: 10_000 };
    expect((await broker.execute(capability, acquired.lease, operation)).state).toBe('unresolved');
    expect(inputs.guestExecute).toHaveBeenCalledTimes(1);
    await expect(broker.execute(capability, acquired.lease, operation)).rejects.toThrow(/lease_unresolved|computer_operation_busy/);
    expect(inputs.guestExecute).toHaveBeenCalledTimes(1);
    expect(execution.host).toBe(0);
  });
});
