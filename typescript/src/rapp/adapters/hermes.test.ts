import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BRAINSTEM_URL } from '../../gateway/brainstem-client.js';
import { deriveLiveId, type LiveRappIdentity } from '../../infra/process-identity.js';
import { CopilotAuthority } from '../../providers/copilot-authority.js';
import { DEFAULT_BRAINSTEM_DESCRIPTOR } from './brainstem.js';
import {
  HERMES_RECEIPT_SCHEMA,
  HERMES_TRANSPORT,
  HermesRappParticipant,
  type HermesProcessRunner,
  type HermesRappParticipantOptions,
} from './hermes.js';

const ENABLED_CONFIG = {
  experimental: {
    enabled: true,
    harnessAdapters: {
      enabled: true,
      hermes: true,
    },
  },
};
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(process.cwd(), '.hermes-adapter-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function identity(hex = HEX_A, incarnation = 'hermes-test'): LiveRappIdentity {
  const rappid = `rappid:@openrappter/hermes-test:${hex}`;
  return {
    rappid,
    liveId: deriveLiveId(rappid, process.pid, incarnation),
    pid: process.pid,
    incarnation,
  };
}

function writeDummyExecutable(name = 'hermes'): string {
  const executable = path.join(root, name);
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(executable, 0o755);
  return executable;
}

function fakeHermesSource(mode: string): string {
  return `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  console.log('hermes-agent 0.20.6');
  process.exit(0);
}
if (args[0] === 'chat' && args[1] === '--help') {
  if (mode === 'old-cli') {
    console.log('usage: hermes chat [-q QUERY]');
  } else {
    console.log('--provider PROVIDER --safe-mode --source SOURCE --run-budget SECONDS --query-file PATH --quiet');
  }
  process.exit(0);
}

const queryIndex = args.indexOf('-q');
const queryFileIndex = args.indexOf('--query-file');
const query = queryIndex >= 0
  ? args[queryIndex + 1]
  : queryFileIndex >= 0
    ? readFileSync(args[queryFileIndex + 1], 'utf8')
    : '';
const health = query.includes('OPENRAPPTER_HERMES_ACP_READY');
if (health) {
  if (mode === 'unsupported') {
    console.error('unknown provider: copilot-acp');
    process.exit(2);
  }
  if (mode === 'unauthenticated') {
    console.error('GitHub Copilot login required: not logged in');
    process.exit(3);
  }
  if (mode === 'unhealthy') {
    console.error('Hermes worker crashed');
    process.exit(4);
  }
  console.log('session_id: health-session');
  console.log('OPENRAPPTER_HERMES_ACP_READY');
  process.exit(0);
}

if (mode === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  writeFileSync(path.join(process.cwd(), 'grandchild.pid'), String(child.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'output-cap') {
  process.stdout.write('x'.repeat(256 * 1024));
} else if (mode === 'malformed') {
  console.log('session_id: malformed-session');
} else if (mode === 'nonzero') {
  console.error('GitHub token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 failed');
  process.exit(7);
} else if (mode === 'env') {
  console.log('session_id: env-session');
  console.log(process.env.GITHUB_TOKEN ?? 'credentials-isolated');
} else {
  console.log('session_id: hermes-session');
  console.log('hello from Hermes');
}
`;
}

function writeFakeHermes(mode = 'success'): string {
  const executable = path.join(root, `hermes-${mode}.mjs`);
  writeFileSync(executable, fakeHermesSource(mode), { mode: 0o755 });
  chmodSync(executable, 0o755);
  return executable;
}

function options(
  executable: string,
  overrides: Partial<HermesRappParticipantOptions> = {},
): HermesRappParticipantOptions {
  const admitted = overrides.identity ?? identity();
  return {
    config: ENABLED_CONFIG,
    identity: admitted,
    identityProvider: () => admitted,
    executable,
    stateDirectory: path.join(root, 'state'),
    healthTimeoutMs: 2_000,
    chatTimeoutMs: 2_000,
    ...overrides,
  };
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(filePath)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() > deadline) {
      throw new Error(`Process ${pid} survived Hermes cleanup`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('HermesRappParticipant feature gate', () => {
  it.each([
    {},
    { experimental: { enabled: false } },
    {
      experimental: {
        enabled: true,
        harnessAdapters: { enabled: false, hermes: true },
      },
    },
    {
      experimental: {
        enabled: true,
        harnessAdapters: { enabled: true, hermes: false },
      },
    },
  ])('does no discovery or spawn when disabled', async (config) => {
    const runner = vi.fn<HermesProcessRunner>();
    const stateDirectory = path.join(root, 'must-not-exist');
    const participant = new HermesRappParticipant({
      config,
      identity: identity(),
      identityProvider: () => identity(),
      executable: path.join(root, 'missing-hermes'),
      stateDirectory,
      runner,
    });

    await expect(participant.status()).rejects.toMatchObject({
      code: 'EXPERIMENTAL_FEATURE_DISABLED',
    });
    await expect(participant.chat({
      userInput: 'hello',
      conversationHistory: [],
    })).rejects.toMatchObject({
      code: 'EXPERIMENTAL_FEATURE_DISABLED',
    });
    expect(runner).not.toHaveBeenCalled();
    expect(existsSync(stateDirectory)).toBe(false);
  });
});

describe('HermesRappParticipant probes and command contract', () => {
  it('reports missing, unsupported, unauthenticated, unhealthy, and ready distinctly', async () => {
    const missing = new HermesRappParticipant(
      options(path.join(root, 'missing-hermes')),
    );
    await expect(missing.status()).resolves.toMatchObject({
      status: 'degraded',
      adapterState: 'missing-binary',
    });

    const unsupported = new HermesRappParticipant(options(writeFakeHermes('old-cli'), {
      stateDirectory: path.join(root, 'unsupported-state'),
    }));
    await expect(unsupported.status()).resolves.toMatchObject({
      status: 'degraded',
      adapterState: 'unsupported-acp',
    });

    const unauthenticated = new HermesRappParticipant(
      options(writeFakeHermes('unauthenticated'), {
        stateDirectory: path.join(root, 'unauthenticated-state'),
      }),
    );
    await expect(unauthenticated.status()).resolves.toMatchObject({
      status: 'degraded',
      adapterState: 'unauthenticated-copilot',
    });

    const unhealthy = new HermesRappParticipant(options(writeFakeHermes('unhealthy'), {
      stateDirectory: path.join(root, 'unhealthy-state'),
    }));
    await expect(unhealthy.status()).resolves.toMatchObject({
      status: 'degraded',
      adapterState: 'unhealthy-process',
    });

    const ready = new HermesRappParticipant(options(writeFakeHermes(), {
      stateDirectory: path.join(root, 'ready-state'),
    }));
    await expect(ready.status()).resolves.toMatchObject({
      status: 'ok',
      adapterState: 'ready',
      descriptor: {
        harness: { name: 'hermes', version: '0.20.6' },
        modelAuthority: 'github-copilot-cli',
      },
    });
  });

  it('uses the exact safe copilot-acp argv and no credential environment', async () => {
    const executable = writeDummyExecutable();
    const calls: Parameters<HermesProcessRunner>[0][] = [];
    const runner: HermesProcessRunner = vi.fn(async (invocation) => {
      calls.push(invocation);
      if (invocation.args[0] === '--version') {
        return processResult('hermes-agent 0.20.6\n');
      }
      if (invocation.args[1] === '--help') {
        return processResult(
          '--provider PROVIDER --safe-mode --source SOURCE --run-budget SECONDS --query-file PATH --quiet\n',
        );
      }
      if (invocation.args.includes('-q')) {
        return processResult(`session_id: health\nOPENRAPPTER_HERMES_ACP_READY\n`);
      }
      return processResult('session_id: turn-1\ncontract reply\n');
    });
    const participant = new HermesRappParticipant(options(executable, {
      runner,
      env: {
        ...process.env,
        GITHUB_TOKEN: 'ghp_must_not_reach_hermes',
        GH_TOKEN: 'ghp_must_not_reach_hermes',
        COPILOT_GITHUB_TOKEN: 'ghp_must_not_reach_hermes',
      },
    }));

    await participant.chat({
      userInput: 'hello',
      conversationHistory: [],
    });

    expect(calls.map(call => call.args.slice(0, 2))).toEqual([
      ['--version'],
      ['chat', '--help'],
      ['chat', '--safe-mode'],
      ['chat', '--safe-mode'],
    ]);
    const healthArgv = calls[2].args;
    expect(healthArgv).toEqual([
      'chat',
      '--safe-mode',
      '--source',
      'tool',
      '--provider',
      'copilot-acp',
      '--model',
      'gpt-4.1',
      '--reasoning',
      'low',
      '--max-turns',
      '1',
      '--run-budget',
      '2',
      '--in',
      path.join(root, 'state', 'workspace'),
      '-Q',
      '-q',
      'Reply with exactly: OPENRAPPTER_HERMES_ACP_READY',
    ]);
    expect(calls[3].args).toEqual([
      ...healthArgv.slice(0, -2),
      '--query-file',
      expect.stringMatching(/\.query\.txt$/),
    ]);
    for (const call of calls) {
      expect(call.executable).toBe(executable);
      expect(call.env.HERMES_HOME).toBe(path.join(root, 'state', 'home'));
      expect(call.env.TMPDIR).toBe(path.join(root, 'state', 'tmp'));
      expect(call.env.GITHUB_TOKEN).toBeUndefined();
      expect(call.env.GH_TOKEN).toBeUndefined();
      expect(call.env.COPILOT_GITHUB_TOKEN).toBeUndefined();
      expect(JSON.stringify(call.args)).not.toContain('ghp_must_not_reach_hermes');
    }
  });

  it('honors CopilotAuthority model policy before spawn', async () => {
    const runner = vi.fn<HermesProcessRunner>();
    const authority = new CopilotAuthority({
      modelPolicy: { allowedModels: ['gpt-4.1'] },
    });
    const participant = new HermesRappParticipant(options(writeDummyExecutable(), {
      model: 'forbidden-model',
      authority,
      runner,
    }));

    await expect(participant.status()).rejects.toMatchObject({
      code: 'forbidden_model',
    });
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('HermesRappParticipant chat', () => {
  it('normalizes an ACP turn to ChatEnvelope with admitted identity and receipt', async () => {
    const admitted = identity();
    const participant = new HermesRappParticipant(options(writeFakeHermes(), {
      identity: admitted,
      identityProvider: () => admitted,
    }));

    const envelope = await participant.chat({
      userInput: 'hello',
      conversationHistory: [{ role: 'assistant', content: 'Earlier reply' }],
      sessionId: 'rapp-session',
      idempotencyKey: 'once',
    });

    expect(envelope).toMatchObject({
      schema: 'rapp-chat/1.0',
      status: 'success',
      response: 'hello from Hermes',
      content: 'hello from Hermes',
      session_id: 'rapp-session',
      sessionId: 'rapp-session',
      agent_logs: expect.stringContaining(`via ${HERMES_TRANSPORT}`),
      voice_mode: false,
      model: 'hermes:unreported',
      requested_model: 'gpt-4.1',
      rappid: admitted.rappid,
      live_id: admitted.liveId,
      idempotency_key: 'once',
    });
    expect(envelope).not.toHaveProperty('assistant_response');

    const receipt = JSON.parse(
      readFileSync(participant.receiptPath, 'utf8'),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      schema: HERMES_RECEIPT_SCHEMA,
      executable: {
        command: 'hermes-success.mjs',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        version: '0.20.6',
      },
      feature_profile: {
        experimental: true,
        harness_adapters: true,
        hermes: true,
      },
      rapp_protocol: 'rapp-chat/1.0',
      model_authority: 'github-copilot-cli',
      transport: 'copilot-acp',
      model: 'gpt-4.1',
      live_identity: {
        rappid: admitted.rappid,
        live_id: admitted.liveId,
        pid: process.pid,
      },
      health: { state: 'ready' },
      receipt_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(receipt)).not.toMatch(
      /gh[opsu]_|github_pat_|Bearer\s|accessToken|refreshToken/i,
    );
  });

  it('does not pass raw GitHub credential variables to Hermes', async () => {
    const participant = new HermesRappParticipant(options(writeFakeHermes('env'), {
      env: {
        ...process.env,
        GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      },
    }));

    await expect(participant.chat({
      userInput: 'inspect env isolation',
      conversationHistory: [],
    })).resolves.toMatchObject({
      response: 'credentials-isolated',
    });
  });

  it('kills the process tree on timeout and cancellation', async () => {
    const timeoutState = path.join(root, 'timeout-state');
    const timeoutParticipant = new HermesRappParticipant(
      options(writeFakeHermes('hang'), {
        stateDirectory: timeoutState,
        chatTimeoutMs: 100,
      }),
    );
    await expect(timeoutParticipant.chat({
      userInput: 'hang on timeout',
      conversationHistory: [],
    })).rejects.toMatchObject({
      code: 'timeout',
    });
    const timeoutPid = Number(
      readFileSync(path.join(timeoutState, 'workspace', 'grandchild.pid'), 'utf8'),
    );
    await waitForProcessExit(timeoutPid);

    const cancelState = path.join(root, 'cancel-state');
    const cancelParticipant = new HermesRappParticipant(
      options(writeFakeHermes('hang'), {
        stateDirectory: cancelState,
        chatTimeoutMs: 2_000,
      }),
    );
    const controller = new AbortController();
    const pending = cancelParticipant.chat({
      userInput: 'hang until cancelled',
      conversationHistory: [],
    }, controller.signal);
    const pidFile = path.join(cancelState, 'workspace', 'grandchild.pid');
    await waitForFile(pidFile);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await waitForProcessExit(Number(readFileSync(pidFile, 'utf8')));
  });

  it.each([
    {
      mode: 'malformed',
      overrides: {},
      code: 'HERMES_PROTOCOL_ERROR',
    },
    {
      mode: 'nonzero',
      overrides: {},
      code: 'HERMES_NONZERO_EXIT',
    },
    {
      mode: 'output-cap',
      overrides: { outputLimitBytes: 1_024 },
      code: 'HERMES_OUTPUT_LIMIT',
    },
  ])('rejects $mode output', async ({ mode, overrides, code }) => {
    const participant = new HermesRappParticipant(
      options(writeFakeHermes(mode), overrides),
    );
    await expect(participant.chat({
      userInput: `trigger ${mode}`,
      conversationHistory: [],
    })).rejects.toMatchObject({ code });
  });

  it('redacts secrets from nonzero process errors', async () => {
    const participant = new HermesRappParticipant(
      options(writeFakeHermes('nonzero')),
    );
    let failure: unknown;
    try {
      await participant.chat({
        userInput: 'trigger redaction',
        conversationHistory: [],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'HERMES_NONZERO_EXIT' });
    expect(String((failure as Error).message)).toContain('***REDACTED***');
    expect(String((failure as Error).message)).not.toContain(
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    );
  });

  it('rejects receipt tamper and executable drift before invocation', async () => {
    const executable = writeFakeHermes();
    const participant = new HermesRappParticipant(options(executable));
    await participant.status();

    const receipt = JSON.parse(
      readFileSync(participant.receiptPath, 'utf8'),
    ) as Record<string, unknown>;
    receipt.model = 'tampered-model';
    writeFileSync(participant.receiptPath, JSON.stringify(receipt));
    await expect(participant.chat({
      userInput: 'tampered receipt',
      conversationHistory: [],
    })).rejects.toMatchObject({ code: 'HERMES_RECEIPT_INVALID' });

    const cleanState = path.join(root, 'hash-state');
    const hashParticipant = new HermesRappParticipant(options(executable, {
      stateDirectory: cleanState,
    }));
    await hashParticipant.status();
    writeFileSync(executable, `${readFileSync(executable, 'utf8')}\n// changed\n`);
    chmodSync(executable, 0o755);
    await expect(hashParticipant.chat({
      userInput: 'changed executable',
      conversationHistory: [],
    })).rejects.toMatchObject({ code: 'HERMES_RECEIPT_INVALID' });
  });

  it('rejects admitted wrapper identity drift before accepting the ACP turn', async () => {
    const admitted = identity();
    const drifted = identity(HEX_B, 'drifted');
    let reads = 0;
    const participant = new HermesRappParticipant(options(writeFakeHermes(), {
      identity: admitted,
      identityProvider: () => (++reads === 1 ? admitted : drifted),
    }));

    await expect(participant.chat({
      userInput: 'identity continuity',
      conversationHistory: [],
    })).rejects.toMatchObject({
      code: 'identity-drift',
      axis: 'rappid',
      expected: admitted.rappid,
      actual: drifted.rappid,
    });
  });

  it('does not alter the default Brainstem participant contract', async () => {
    const participant = new HermesRappParticipant(options(writeFakeHermes()));
    await expect(participant.status()).resolves.toMatchObject({
      adapterState: 'ready',
    });
    expect(DEFAULT_BRAINSTEM_DESCRIPTOR).toMatchObject({
      harness: { name: 'brainstem' },
      endpoint: DEFAULT_BRAINSTEM_URL,
      modelAuthority: 'github-copilot',
    });
  });
});

function processResult(
  stdout = '',
  stderr = '',
  exitCode: number | null = 0,
) {
  return {
    stdout,
    stderr,
    exitCode,
    signal: null,
    timedOut: false,
    aborted: false,
    outputLimitExceeded: false,
  };
}
