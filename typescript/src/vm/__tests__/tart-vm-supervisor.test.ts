import { afterEach, describe, expect, it } from 'vitest';
import { TartVmSupervisor, type TartVmSupervisorOptions } from '../tart-vm-supervisor.js';
import type { VmExecRequest } from '../types.js';
import { deferred, FakeVmCommandRunner, result, testConfig, testHost, testWorkspaces } from './fake-runner.js';
import { testEvidence } from './fake-rapp-persistence.js';

const supervisors: TartVmSupervisor[] = [];
function fixture(options: TartVmSupervisorOptions = {}) {
  const runner = new FakeVmCommandRunner();
  let now = 0;
  const supervisor = new TartVmSupervisor({
    config: testConfig, host: testHost, runner, workspaces: testWorkspaces,
    evidence: testEvidence(),
    now: () => now,
    delay: async (ms) => { now += ms; },
    ...options,
  });
  supervisors.push(supervisor);
  return { supervisor, runner };
}
const request: VmExecRequest = { agentId: 'agent-a', workspaceId: 'project-1', argv: ['/usr/bin/pwd'] };

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));
});

describe('availability and safe state reporting', () => {
  it.each([
    [{ platform: 'linux', arch: 'arm64', addresses: [] }, 'unsupported_platform'],
    [{ platform: 'darwin', arch: 'x64', addresses: [] }, 'unsupported_architecture'],
  ])('reports unsupported hosts without a command: %s', async (host, code) => {
    const { supervisor, runner } = fixture({ host });
    expect(await supervisor.status()).toMatchObject({ state: 'unavailable', error: { code } });
    await expect(supervisor.start()).rejects.toMatchObject({ code });
    expect(runner.calls).toEqual([]);
  });

  it('does not provision or invoke Tart without a configuration', async () => {
    const { supervisor, runner } = fixture({ config: undefined });
    expect(await supervisor.status()).toMatchObject({ state: 'unavailable', error: { code: 'not_configured' } });
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'not_configured' });
    expect(runner.calls).toEqual([]);
  });

  it('distinguishes missing Tart from a missing local image', async () => {
    const { supervisor, runner } = fixture();
    runner.missingTart = true;
    expect(await supervisor.status()).toMatchObject({ state: 'unavailable', error: { code: 'tart_missing' } });
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'tart_missing' });
    runner.missingTart = false;
    runner.installed = false;
    expect(await supervisor.status()).toMatchObject({ state: 'unavailable', error: { code: 'image_missing' } });
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'image_missing' });
    expect(runner.children).toHaveLength(0);
    expect(runner.calls.every((call) => call.argv[0] === 'list')).toBe(true);
  });

  it.each(['not json', '{}', '[{"Name":"rapp-work-omarchy","Running":"false"}]'])('rejects malformed Tart output: %s', async (output) => {
    const { supervisor, runner } = fixture();
    runner.listOutput = output;
    expect(await supervisor.status()).toMatchObject({ state: 'error', error: { code: 'command_failed' } });
  });

  it('does not treat a failed status command as a stopped VM', async () => {
    const { supervisor, runner } = fixture();
    runner.listFailure = result({ exitCode: 1, stderr: 'private host details' });
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'command_failed' });
    expect(await supervisor.status()).toMatchObject({ state: 'error' });
    expect(JSON.stringify(supervisor.getFrames())).not.toContain('private host details');
    expect(runner.children).toHaveLength(0);
  });
});

describe('lifecycle ordering and idempotency', () => {
  it('shares one persistent VM across callers and repeated starts/stops', async () => {
    const { supervisor, runner } = fixture();
    expect(await supervisor.status()).toMatchObject({ state: 'stopped', ready: false, owned: false });
    const first = supervisor.start();
    expect(supervisor.start()).toBe(first);
    expect(await first).toMatchObject({ state: 'running', ready: true, owned: true });
    await supervisor.start();
    expect(runner.children).toHaveLength(1);
    expect(runner.calls.find((call) => call.kind === 'spawn')?.argv).toEqual([
      'run', '--no-graphics', '--no-audio', '--no-clipboard', testConfig.name,
    ]);
    const stop = supervisor.stop();
    expect(supervisor.stop()).toBe(stop);
    await stop;
    await supervisor.stop();
    expect(await supervisor.status()).toMatchObject({ state: 'stopped', owned: false });
    expect(runner.calls.filter((call) => call.argv[0] === 'stop')).toHaveLength(1);
  });

  it('reports starting while waiting for SSH instead of equating an IP with readiness', async () => {
    const ready = deferred<ReturnType<typeof result>>();
    const entered = deferred<void>();
    const { supervisor, runner } = fixture();
    runner.intercept = async (call) => {
      if (call.file === '/usr/bin/ssh') { entered.resolve(); return ready.promise; }
    };
    const starting = supervisor.start();
    await entered.promise;
    expect(await supervisor.status()).toMatchObject({ state: 'starting', ready: false, owned: true });
    ready.resolve(result());
    expect(await starting).toMatchObject({ state: 'running', ready: true });
  });

  it('does not let a stale status probe overwrite a newer successful start', async () => {
    const observed = deferred<void>();
    const stale = deferred<ReturnType<typeof result>>();
    const { supervisor, runner } = fixture();
    let first = true;
    runner.intercept = async (call) => {
      if (call.argv[0] === 'list' && first) {
        first = false;
        observed.resolve();
        return stale.promise;
      }
    };
    const status = supervisor.status();
    await observed.promise;
    await supervisor.start();
    stale.resolve(result({ stdout: JSON.stringify([{ Name: testConfig.name, Running: false }]) }));
    expect(await status).toMatchObject({ state: 'running', ready: true, owned: true });
  });

  it('reports stopping while Tart is terminating the VM', async () => {
    const stopping = deferred<void>();
    const release = deferred<ReturnType<typeof result> | undefined>();
    const { supervisor, runner } = fixture();
    await supervisor.start();
    runner.intercept = async (call) => {
      if (call.argv[0] === 'stop') { stopping.resolve(); return release.promise; }
    };
    const stop = supervisor.stop();
    await stopping.promise;
    expect(await supervisor.status()).toMatchObject({ state: 'stopping', ready: false });
    release.resolve(undefined);
    expect(await stop).toMatchObject({ state: 'stopped' });
  });

  it('cancels start before a queued stop and preserves a later start', async () => {
    const { supervisor, runner } = fixture();
    const start = supervisor.start();
    const rejected = expect(start).rejects.toMatchObject({ code: 'operation_cancelled' });
    const stop = supervisor.stop();
    const next = supervisor.start();
    await rejected;
    expect(await stop).toMatchObject({ state: 'stopped' });
    expect(await next).toMatchObject({ state: 'running' });
    expect(runner.children).toHaveLength(1);
  });

  it('cancels an in-flight boot and does not run a late SSH probe', async () => {
    const observed = deferred<void>();
    const ip = deferred<ReturnType<typeof result>>();
    const { supervisor, runner } = fixture();
    runner.intercept = async (call) => {
      if (call.argv[0] === 'ip') { observed.resolve(); return ip.promise; }
    };
    const starting = supervisor.start();
    const rejected = expect(starting).rejects.toMatchObject({ code: 'operation_cancelled' });
    await observed.promise;
    const stopping = supervisor.stop();
    ip.resolve(result({ stdout: '192.168.64.2' }));
    await rejected;
    expect(await stopping).toMatchObject({ state: 'stopped', owned: false });
    expect(runner.calls.filter((call) => call.file === '/usr/bin/ssh')).toHaveLength(0);
  });

  it('coalesces restart and waits for stop before booting again', async () => {
    const { supervisor, runner } = fixture();
    await supervisor.start();
    const restarting = supervisor.restart();
    expect(supervisor.restart()).toBe(restarting);
    expect(await restarting).toMatchObject({ state: 'running', ready: true });
    expect(runner.children).toHaveLength(2);
    expect(runner.children[0].finished).toBe(true);
    const lifecycle = runner.calls.filter((call) => ['run', 'stop'].includes(call.argv[0])).map((call) => call.argv[0]);
    expect(lifecycle).toEqual(['run', 'stop', 'run']);
  });

  it('does not boot after a stop failure; error recovery remains possible', async () => {
    const { supervisor, runner } = fixture();
    await supervisor.start();
    runner.stopFailure = result({ exitCode: 1 });
    await expect(supervisor.restart()).rejects.toMatchObject({ code: 'command_failed' });
    expect(runner.children).toHaveLength(1);
    runner.stopFailure = undefined;
    expect(await supervisor.restart()).toMatchObject({ state: 'running' });
  });

  it('observes external power-off and unexpected foreground failure', async () => {
    const { supervisor, runner } = fixture();
    await supervisor.start();
    runner.children[0].exit(result({ exitCode: 9 }));
    await Promise.resolve();
    expect(await supervisor.status()).toMatchObject({ state: 'stopped', ready: false, owned: false });
    expect(JSON.stringify(supervisor.getFrames())).toContain('process_exited');
    await supervisor.start();
    runner.children[1].exit();
    await Promise.resolve();
    expect(await supervisor.status()).toMatchObject({ state: 'stopped', ready: false });
  });

  it('bounds readiness and leaves a timed-out owned VM available for cleanup', async () => {
    const { supervisor, runner } = fixture();
    runner.sshReady = false;
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'readiness_timeout' });
    expect(await supervisor.status()).toMatchObject({ state: 'error', ready: false, error: { code: 'readiness_timeout' } });
    expect(runner.calls.filter((call) => call.file === '/usr/bin/ssh').length).toBeLessThanOrEqual(10);
    await supervisor.shutdown();
    expect(runner.children[0].signals).toContain('SIGINT');
  });

  it('waitReady never implicitly starts a stopped VM', async () => {
    const { supervisor, runner } = fixture();
    await expect(supervisor.waitReady()).rejects.toMatchObject({ code: 'not_ready' });
    expect(runner.children).toEqual([]);
    runner.running = true;
    expect(await supervisor.waitReady()).toMatchObject({ state: 'running', ready: true, owned: false });
  });

  it('reports a missing Tart binary even when it disappears between list and spawn', async () => {
    const { supervisor, runner } = fixture();
    runner.spawnIntercept = async () => { runner.missingTart = true; };
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'tart_missing' });
    expect(runner.children).toHaveLength(0);
  });
});

describe('guest-only execution', () => {
  it('requires registered identity, a ready VM, and uses only pinned-key SSH', async () => {
    const { supervisor, runner } = fixture();
    await expect(supervisor.exec(request)).rejects.toMatchObject({ code: 'not_ready' });
    await supervisor.start();
    expect(await supervisor.exec({ ...request, argv: ['/usr/bin/git', 'status'], cwd: 'src' })).toMatchObject({
      cwd: '/workspaces/agent-a/project-1/src', stdout: 'guest output\n', exitCode: 0,
    });
    const ssh = runner.calls.filter((call) => call.file === '/usr/bin/ssh').at(-1)!;
    expect(ssh.argv).toEqual(expect.arrayContaining([
      '-F', '/dev/null', 'BatchMode=yes', 'StrictHostKeyChecking=yes',
      'ForwardAgent=no', 'PermitLocalCommand=no', 'IdentityAgent=none',
      'ProxyCommand=none', 'ClearAllForwardings=yes', '192.168.64.2',
    ]));
    expect(ssh.argv.at(-1)).toContain('/usr/bin/realpath -e --');
    expect(ssh.argv.at(-1)).toContain('exit 126');
    expect(ssh.argv.at(-1)).toContain('/workspaces/agent-a/project-1/src');
    expect(ssh.argv.at(-1)).not.toContain('/host/');
    await expect(supervisor.exec({ ...request, agentId: 'agent-b' })).rejects.toMatchObject({ code: 'workspace_denied' });
  });

  it.each([
    { agentId: '../other' }, { workspaceId: '-oProxyCommand=id' },
    { workspaceId: 'a/b' }, { agentId: 'a;id' }, { workspaceId: '' },
    { argv: '/usr/bin/pwd; id' }, { argv: [] }, { argv: ['-oProxyCommand=id'] },
    { argv: ['/bin/sh', '-c', 'id'] }, { argv: ['/usr/bin/pwd', 'a\nb'] },
    { argv: ['/usr/bin/pwd', '\0'] }, { cwd: '/etc' }, { cwd: '../other' },
    { cwd: 'src/../other' }, { cwd: 'src\\other' }, { cwd: '' },
    { cwd: 'src//other' }, { timeoutMs: Infinity }, { timeoutMs: 0 },
    { timeoutMs: 999999 }, { hostCwd: '/Users/private' }, { env: { PATH: '/evil' } },
  ])('refuses unsafe input before command execution: %j', async (change) => {
    const { supervisor, runner } = fixture();
    await expect(supervisor.exec({ ...request, ...change } as VmExecRequest)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(runner.calls).toHaveLength(0);
  });

  it.each(['127.0.0.1', '192.168.64.1', '::1', '8.8.8.8', '-oProxyCommand=id', '192.168.64.2\nid'])(
    'never connects SSH to a host or injected address: %s', async (address) => {
      const { supervisor, runner } = fixture();
      runner.address = address;
      await expect(supervisor.start()).rejects.toMatchObject({ code: 'unsafe_guest_address' });
      expect(runner.calls.some((call) => call.file === '/usr/bin/ssh')).toBe(false);
    },
  );

  it('returns guest failures and bounded output without retrying on the host', async () => {
    const { supervisor, runner } = fixture();
    await supervisor.start();
    runner.execResult = result({ exitCode: 7, stdout: 'partial', stderr: 'guest failure', truncated: true });
    expect(await supervisor.exec(request)).toMatchObject({ exitCode: 7, stdout: 'partial', truncated: true });
    runner.execResult = result({ exitCode: null, signal: 'SIGKILL', timedOut: true });
    expect(await supervisor.exec(request)).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
    expect(runner.calls.every((call) => [testConfig.tartBinary, '/usr/bin/ssh'].includes(call.file))).toBe(true);
    expect(JSON.stringify(supervisor.getFrames())).not.toContain('guest failure');
  });

  it('invalidates an exec waiting on workspace resolution when stop wins', async () => {
    const resolving = deferred<Awaited<ReturnType<typeof testWorkspaces.resolve>>>();
    const { supervisor, runner } = fixture({ workspaces: { resolve: () => resolving.promise } });
    await supervisor.start();
    const before = runner.calls.length;
    const execution = supervisor.exec(request);
    const rejected = expect(execution).rejects.toMatchObject({ code: 'operation_cancelled' });
    await supervisor.stop();
    resolving.resolve(await testWorkspaces.resolve({ agentId: request.agentId, workspaceId: request.workspaceId }));
    await rejected;
    expect(runner.calls.slice(before).some((call) => call.file === '/usr/bin/ssh')).toBe(false);
  });
});

describe('shutdown authority and fencing', () => {
  it('does not acquire or stop an already-running VM on shutdown', async () => {
    const { supervisor, runner } = fixture();
    runner.running = true;
    expect(await supervisor.start()).toMatchObject({ state: 'running', ready: true, owned: false });
    await supervisor.shutdown();
    expect(runner.running).toBe(true);
    expect(runner.calls.some((call) => call.argv[0] === 'stop' || call.kind === 'spawn')).toBe(false);
  });

  it('leaves a borrowed VM running when shutdown interrupts its readiness check', async () => {
    const entered = deferred<void>();
    const { supervisor, runner } = fixture();
    runner.running = true;
    runner.intercept = async (call) => {
      if (call.file === '/usr/bin/ssh') {
        entered.resolve();
        return new Promise((resolve) => call.options!.signal!.addEventListener('abort', () => resolve(result({ aborted: true })), { once: true }));
      }
    };
    const start = supervisor.start();
    const rejected = expect(start).rejects.toMatchObject({ code: 'shutting_down' });
    await entered.promise;
    await supervisor.shutdown();
    await rejected;
    expect(await supervisor.status()).toMatchObject({ state: 'running', ready: false, owned: false });
    expect(runner.running).toBe(true);
    expect(runner.children).toHaveLength(0);
  });

  it('terminates only its child handle and is idempotent; no VM-name shutdown command', async () => {
    const { supervisor, runner } = fixture();
    await supervisor.start();
    runner.children[0].ignoreInt = true;
    const shutdown = supervisor.shutdown();
    expect(supervisor.shutdown()).toBe(shutdown);
    await shutdown;
    expect(runner.children[0].signals).toEqual(['SIGINT', 'SIGKILL']);
    expect(runner.calls.some((call) => call.argv[0] === 'stop')).toBe(false);
    expect(await supervisor.status()).toMatchObject({ state: 'stopped', owned: false });
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'shutting_down' });
    await expect(supervisor.exec(request)).rejects.toMatchObject({ code: 'shutting_down' });
  });

  it('fences queued starts and still collects a child whose spawn resolves after shutdown', async () => {
    const spawned = deferred<void>();
    const release = deferred<void>();
    const { supervisor, runner } = fixture();
    runner.spawnIntercept = async () => { spawned.resolve(); await release.promise; };
    const start = supervisor.start();
    const rejected = expect(start).rejects.toMatchObject({ code: 'shutting_down' });
    await spawned.promise;
    const shutdown = supervisor.shutdown();
    release.resolve();
    await rejected;
    await shutdown;
    expect(runner.children[0].finished).toBe(true);
    expect(runner.calls.some((call) => call.file === '/usr/bin/ssh')).toBe(false);
  });

  it('does not kill an external replacement after its owned process exited', async () => {
    const { supervisor, runner } = fixture();
    await supervisor.start();
    runner.children[0].exit();
    await Promise.resolve();
    runner.running = true;
    await supervisor.shutdown();
    expect(runner.running).toBe(true);
    expect(runner.children[0].signals).toEqual([]);
  });

  it('does not claim the winner when two host supervisors race Tart native locking', async () => {
    const { supervisor, runner } = fixture();
    const other = new TartVmSupervisor({ config: testConfig, runner, host: testHost, workspaces: testWorkspaces, evidence: testEvidence() });
    supervisors.push(other);
    const starts = await Promise.allSettled([supervisor.start(), other.start()]);
    expect(starts.filter((start) => start.status === 'fulfilled')).toHaveLength(1);
    expect(starts.filter((start) => start.status === 'rejected')).toHaveLength(1);
    const loser = starts[0].status === 'rejected' ? supervisor : other;
    await loser.shutdown();
    expect(runner.running).toBe(true);
    expect(runner.children[0].signals).toEqual([]);
  });

  it('aborts in-flight guest commands before shutdown completes', async () => {
    const entered = deferred<void>();
    const { supervisor, runner } = fixture();
    await supervisor.start();
    runner.intercept = async (call) => {
      if (call.file === '/usr/bin/ssh') {
        entered.resolve();
        return new Promise((resolve) => call.options!.signal!.addEventListener('abort', () => resolve(result({ aborted: true })), { once: true }));
      }
    };
    const exec = supervisor.exec(request);
    const rejected = expect(exec).rejects.toMatchObject({ code: 'shutting_down' });
    await entered.promise;
    await supervisor.shutdown();
    await rejected;
  });

  it('bounds verified frame views without command arguments or output', async () => {
    const { supervisor } = fixture();
    await supervisor.start();
    for (let i = 0; i < 51; i++) await supervisor.exec({ ...request, argv: ['/usr/bin/pwd', 'private-argument'] });
    expect(supervisor.getFrames()).toHaveLength(100);
    expect(JSON.stringify(supervisor.getFrames())).not.toContain('private-argument');
    expect(() => { supervisor.getFrames()[0].payload.event_kind = 'modified'; }).toThrow();
  });
});
