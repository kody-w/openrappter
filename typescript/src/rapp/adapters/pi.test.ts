import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { deriveLiveId, type LiveRappIdentity } from '../../infra/process-identity.js';
import {
  CopilotBrokerGrant,
  type CopilotBrokerGrantOptions,
} from '../../providers/copilot-broker.js';
import { DEFAULT_BRAINSTEM_DESCRIPTOR } from './brainstem.js';
import {
  PI_BROKER_BEARER_ENV,
  PI_PROVIDER_ID,
  PiAdapterError,
  PiRappParticipant,
  verifyPiAdapterReceipt,
  type PiAdapterReceipt,
  type PiGrantBroker,
} from './pi.js';

const RAPPID_A = `rappid:@openrappter/pi-adapter:${'a'.repeat(64)}`;
const RAPPID_B = `rappid:@openrappter/pi-adapter:${'b'.repeat(64)}`;
const SECRET = 'broker-secret-that-must-never-escape';
const ENABLED_CONFIG = {
  experimental: {
    enabled: true,
    harnessAdapters: {
      enabled: true,
      pi: true,
    },
  },
};

interface FakePiScenario {
  text?: string;
  provider?: string;
  model?: string;
  responseModel?: string;
  delayMs?: number;
  exitCode?: number;
  malformed?: boolean;
  floodBytes?: number;
  echoSecret?: boolean;
}

interface FakePiRecord {
  argv: string[];
  runtimeDir: string;
  runtimeMode: number;
  modelsMode: number;
  models: string;
  bearerPresent: boolean;
  offline: string | null;
  telemetry: string | null;
}

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function testRoot(): string {
  const root = mkdtempSync(join(process.cwd(), '.pi-adapter-test-'));
  roots.push(root);
  return root;
}

function identity(rappid = RAPPID_A, incarnation = 'pi-adapter-test'): LiveRappIdentity {
  return {
    rappid,
    liveId: deriveLiveId(rappid, process.pid, incarnation),
    pid: process.pid,
    incarnation,
  };
}

class FakeBroker implements PiGrantBroker {
  readonly issued: CopilotBrokerGrantOptions[] = [];
  readonly revoked: string[] = [];
  expiresAt = Date.now() + 60_000;
  secret = SECRET;

  async issueGrant(options: CopilotBrokerGrantOptions): Promise<CopilotBrokerGrant> {
    this.issued.push(options);
    return new CopilotBrokerGrant({
      version: 1,
      baseUrl: 'http://127.0.0.1:43191/v1',
      grantId: `grant-${this.issued.length}`,
      expiresAt: this.expiresAt,
      modelPolicy: {
        allowedModels: [...options.allowedModels],
        defaultModel: options.defaultModel ?? options.allowedModels[0],
      },
    }, this.secret);
  }

  revoke(grantId: string): boolean {
    this.revoked.push(grantId);
    return true;
  }
}

function fakePi(
  root: string,
  scenario: FakePiScenario = {},
): { binaryPath: string; recordPath: string } {
  mkdirSync(root, { recursive: true });
  const scenarioPath = join(root, 'scenario.json');
  const recordPath = join(root, 'record.json');
  const binaryPath = join(root, 'pi');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  writeFileSync(binaryPath, `#!/usr/bin/env node
import fs from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('pi 0.99.0\\n');
  process.exit(0);
}

const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, 'utf8'));
const runtimeDir = process.env.PI_CODING_AGENT_DIR;
const modelsPath = runtimeDir + '/models.json';
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  runtimeDir,
  runtimeMode: fs.statSync(runtimeDir).mode & 0o777,
  modelsMode: fs.statSync(modelsPath).mode & 0o777,
  models: fs.readFileSync(modelsPath, 'utf8'),
  bearerPresent: Boolean(process.env.${PI_BROKER_BEARER_ENV}),
  offline: process.env.PI_OFFLINE ?? null,
  telemetry: process.env.PI_TELEMETRY ?? null,
}));

const finish = () => {
  if (scenario.echoSecret) {
    process.stderr.write(process.env.${PI_BROKER_BEARER_ENV} + '\\n');
  }
  if (scenario.floodBytes) {
    process.stdout.write('x'.repeat(scenario.floodBytes));
  } else if (scenario.malformed) {
    process.stdout.write('not-json\\n');
  } else if (!scenario.exitCode) {
    process.stdout.write(JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: scenario.provider ?? ${JSON.stringify(PI_PROVIDER_ID)},
        model: scenario.model ?? 'gpt-5',
        ...(scenario.responseModel ? { responseModel: scenario.responseModel } : {}),
        content: [{ type: 'text', text: scenario.text ?? 'from pi' }],
        stopReason: 'stop',
      },
    }) + '\\n');
  }
  process.exit(scenario.exitCode ?? 0);
};

if (scenario.delayMs) {
  setTimeout(finish, scenario.delayMs);
} else {
  finish();
}
`);
  chmodSync(binaryPath, 0o755);
  return { binaryPath, recordPath };
}

function participantOptions(
  binaryPath: string,
  broker: FakeBroker,
  overrides: Partial<ConstructorParameters<typeof PiRappParticipant>[0]> = {},
): ConstructorParameters<typeof PiRappParticipant>[0] {
  return {
    config: ENABLED_CONFIG,
    identity: identity(),
    broker,
    binaryPath,
    runtimeRoot: testRoot(),
    model: 'gpt-5',
    probeTimeoutMs: 1_000,
    timeoutMs: 1_000,
    ...overrides,
  };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'NO_ERROR';
  } catch (error) {
    expect(error).toBeInstanceOf(PiAdapterError);
    return (error as PiAdapterError).code;
  }
}

describe('PiRappParticipant', () => {
  it('fails closed before binary discovery, auth, probe, or spawn', async () => {
    const broker = new FakeBroker();
    const resolveBinary = vi.fn(async () => '/should/not/be/read');
    const participant = new PiRappParticipant({
      config: {},
      identity: identity(),
      broker,
      resolveBinary,
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
    expect(resolveBinary).not.toHaveBeenCalled();
    expect(broker.issued).toEqual([]);
  });

  it('creates a private transient provider profile and removes it after a turn', async () => {
    const root = testRoot();
    const { binaryPath, recordPath } = fakePi(root, { text: 'safe answer' });
    const broker = new FakeBroker();
    const participant = new PiRappParticipant(
      participantOptions(binaryPath, broker),
    );

    const envelope = await participant.chat({
      userInput: 'hello',
      conversationHistory: [{ role: 'assistant', content: 'previous reply' }],
      sessionId: 'session-5',
    });
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as FakePiRecord;

    expect(envelope).toMatchObject({
      schema: 'rapp-chat/1.0',
      response: 'safe answer',
      session_id: 'session-5',
      model: 'gpt-5',
      requested_model: 'gpt-5',
      rappid: RAPPID_A,
      live_id: identity().liveId,
    });
    expect(record.runtimeMode).toBe(0o700);
    expect(record.modelsMode).toBe(0o600);
    expect(record.bearerPresent).toBe(true);
    expect(record.models).toContain(`"$${PI_BROKER_BEARER_ENV}"`);
    expect(record.models).not.toContain(SECRET);
    expect(record.argv.join('\n')).not.toContain(SECRET);
    expect(record.offline).toBe('1');
    expect(record.telemetry).toBe('0');
    expect(existsSync(record.runtimeDir)).toBe(false);
    expect(record.argv).toEqual(expect.arrayContaining([
      '--mode',
      'json',
      '--provider',
      PI_PROVIDER_ID,
      '--model',
      'gpt-5',
      '--no-session',
      '--no-context-files',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-tools',
      '--offline',
      '-p',
      '--',
    ]));
    expect(broker.issued).toEqual([{
      allowedModels: ['gpt-5'],
      defaultModel: 'gpt-5',
      ttlMs: 60_000,
    }]);
    expect(broker.revoked).toEqual(['grant-1']);
  });

  it('binds receipts to Pi, provider, protocol, features, and live identity', async () => {
    const root = testRoot();
    const { binaryPath } = fakePi(root);
    const participant = new PiRappParticipant(
      participantOptions(binaryPath, new FakeBroker()),
    );

    const status = await participant.status();
    const receipt = participant.receipt;

    expect(status.descriptor).toMatchObject({
      rappid: RAPPID_A,
      liveId: identity().liveId,
      pid: process.pid,
      protocol: 'rapp-chat/1.0',
      modelAuthority: 'github-copilot',
      harness: {
        name: 'pi',
        version: 'pi 0.99.0',
        metadata: {
          providerMode: 'loopback-broker',
          piProvider: PI_PROVIDER_ID,
        },
      },
    });
    expect(receipt).toMatchObject({
      schema: 'rapp-pi-adapter-receipt/1.0',
      providerMode: 'loopback-broker',
      piProvider: PI_PROVIDER_ID,
      modelAuthority: 'github-copilot',
      model: 'gpt-5',
      protocol: 'rapp-chat/1.0',
      features: {
        experimental: true,
        harnessAdapters: true,
        pi: true,
      },
      identity: {
        rappid: RAPPID_A,
        liveId: identity().liveId,
        pid: process.pid,
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
    expect(() => verifyPiAdapterReceipt(receipt!)).not.toThrow();
  });

  it('rejects receipt tampering and executable drift before invocation', async () => {
    const root = testRoot();
    const { binaryPath, recordPath } = fakePi(root);
    const participant = new PiRappParticipant(
      participantOptions(binaryPath, new FakeBroker()),
    );
    await participant.status();
    const receipt = participant.receipt!;
    const tampered = structuredClone(receipt) as PiAdapterReceipt;
    tampered.executable.sha256 = '0'.repeat(64);

    expect(() => verifyPiAdapterReceipt(tampered)).toThrowError(
      expect.objectContaining({ code: 'PI_RECEIPT_TAMPERED' }),
    );

    writeFileSync(binaryPath, `${readFileSync(binaryPath, 'utf8')}\n// changed\n`);
    chmodSync(binaryPath, 0o755);
    expect(await errorCode(participant.chat({
      userInput: 'hello',
      conversationHistory: [],
    }))).toBe('PI_RECEIPT_MISMATCH');
    expect(existsSync(recordPath)).toBe(false);
  });

  it('rejects expired grants and revokes live grants after failures', async () => {
    const expiredRoot = testRoot();
    const expiredPi = fakePi(expiredRoot);
    const expiredBroker = new FakeBroker();
    expiredBroker.expiresAt = Date.now() - 1;
    const expired = new PiRappParticipant(
      participantOptions(expiredPi.binaryPath, expiredBroker),
    );

    expect(await errorCode(expired.chat({
      userInput: 'hello',
      conversationHistory: [],
    }))).toBe('PI_BROKER_GRANT_EXPIRED');
    expect(existsSync(expiredPi.recordPath)).toBe(false);
    expect(expiredBroker.revoked).toEqual(['grant-1']);

    const failedRoot = testRoot();
    const failedPi = fakePi(failedRoot, { exitCode: 9 });
    const failedBroker = new FakeBroker();
    const failed = new PiRappParticipant(
      participantOptions(failedPi.binaryPath, failedBroker),
    );
    await expect(failed.chat({
      userInput: 'hello',
      conversationHistory: [],
    })).rejects.toMatchObject({ code: 'PI_PROCESS_FAILED' });
    expect(failedBroker.revoked).toEqual(['grant-1']);
  });

  it('bounds execution time and honors caller cancellation', async () => {
    const timeoutRoot = testRoot();
    const timeoutPi = fakePi(timeoutRoot, { delayMs: 5_000 });
    const timed = new PiRappParticipant(participantOptions(
      timeoutPi.binaryPath,
      new FakeBroker(),
      { timeoutMs: 50 },
    ));
    expect(await errorCode(timed.chat({
      userInput: 'hello',
      conversationHistory: [],
    }))).toBe('PI_TIMEOUT');

    const abortRoot = testRoot();
    const abortPi = fakePi(abortRoot, { delayMs: 5_000 });
    const aborted = new PiRappParticipant(
      participantOptions(abortPi.binaryPath, new FakeBroker()),
    );
    const controller = new AbortController();
    const turn = aborted.chat({
      userInput: 'hello',
      conversationHistory: [],
    }, controller.signal);
    setTimeout(() => controller.abort(), 50);
    expect(await errorCode(turn)).toBe('PI_ABORTED');
  });

  it('rejects malformed, nonzero, oversized, and wrong-provider output', async () => {
    const cases: Array<[FakePiScenario, string, Partial<ConstructorParameters<typeof PiRappParticipant>[0]>?]> = [
      [{ malformed: true }, 'PI_OUTPUT_MALFORMED'],
      [{ exitCode: 2 }, 'PI_PROCESS_FAILED'],
      [{ floodBytes: 32_000 }, 'PI_OUTPUT_LIMIT_EXCEEDED', { maxOutputBytes: 4_096 }],
      [{ provider: 'github-copilot' }, 'PI_PROVIDER_MISMATCH'],
    ];

    for (const [scenario, expected, overrides] of cases) {
      const root = testRoot();
      const { binaryPath } = fakePi(root, scenario);
      const participant = new PiRappParticipant(
        participantOptions(binaryPath, new FakeBroker(), overrides),
      );
      expect(await errorCode(participant.chat({
        userInput: 'hello',
        conversationHistory: [],
      }))).toBe(expected);
    }
  });

  it('redacts broker bearers from process errors and receipts', async () => {
    const root = testRoot();
    const { binaryPath } = fakePi(root, { echoSecret: true, exitCode: 17 });
    const participant = new PiRappParticipant(
      participantOptions(binaryPath, new FakeBroker()),
    );

    await expect(participant.chat({
      userInput: 'hello',
      conversationHistory: [],
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PiAdapterError);
      expect((error as Error).message).not.toContain(SECRET);
      expect((error as Error).message).toContain('***REDACTED***');
      return true;
    });
    expect(JSON.stringify(participant.receipt)).not.toContain(SECRET);

    const successRoot = testRoot();
    const successPi = fakePi(successRoot, { text: SECRET });
    const successful = new PiRappParticipant(
      participantOptions(successPi.binaryPath, new FakeBroker()),
    );
    const envelope = await successful.chat({
      userInput: 'hello',
      conversationHistory: [],
    });
    expect(envelope.response).toContain('***REDACTED***');
    expect(JSON.stringify(envelope)).not.toContain(SECRET);
  });

  it('rejects stable or live identity drift across status and chat', async () => {
    const root = testRoot();
    const { binaryPath } = fakePi(root);
    let activeIdentity = identity();
    const participant = new PiRappParticipant(participantOptions(
      binaryPath,
      new FakeBroker(),
      { identity: () => activeIdentity },
    ));
    await participant.status();
    activeIdentity = identity(RAPPID_B, 'pi-adapter-test-b');

    await expect(participant.chat({
      userInput: 'hello',
      conversationHistory: [],
    })).rejects.toMatchObject({
      code: 'identity-drift',
      axis: 'rappid',
      expected: RAPPID_A,
      actual: RAPPID_B,
    });
  });

  it('does not affect the default Brainstem participant or routing', async () => {
    const before = structuredClone(DEFAULT_BRAINSTEM_DESCRIPTOR);
    const broker = new FakeBroker();
    const participant = new PiRappParticipant({
      config: {},
      identity: identity(),
      broker,
      resolveBinary: vi.fn(async () => {
        throw new Error('Pi must not be discovered');
      }),
    });

    expect(participant.descriptor.harness?.name).toBe('pi');
    expect(DEFAULT_BRAINSTEM_DESCRIPTOR).toEqual(before);
    await expect(participant.status()).rejects.toMatchObject({
      code: 'EXPERIMENTAL_FEATURE_DISABLED',
    });
    expect(DEFAULT_BRAINSTEM_DESCRIPTOR).toEqual(before);
  });

  it('uses private runtime permissions even when the supplied root is broad', async () => {
    const root = testRoot();
    chmodSync(root, 0o755);
    const { binaryPath, recordPath } = fakePi(join(root, 'fake'));
    const participant = new PiRappParticipant(participantOptions(
      binaryPath,
      new FakeBroker(),
      { runtimeRoot: root },
    ));

    await participant.chat({ userInput: 'hello', conversationHistory: [] });
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as FakePiRecord;
    expect(record.runtimeMode).toBe(0o700);
    expect(statSync(root).mode & 0o777).toBe(0o755);
  });
});
