import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  FlightRecorder,
  setFlightRecorder,
} from '../../flight-recorder/recorder.js';
import type { FlightEvent } from '../../flight-recorder/types.js';
import { GatewayServer } from '../server.js';

interface CapturedProvenance {
  traceId: string;
  scenarioNonce: string;
  requestId: string;
  candidateSourceSha256: string;
  gatewayParentEventId: string;
}

interface TestImportResult {
  status: 'ok' | 'error';
  file?: string;
  error?: string;
  committed?: boolean;
  rejectedBeforeCommit?: boolean;
  candidateSourceSha256?: string;
  activeSourceSha256?: string;
  activeGeneration?: 'present' | 'absent' | 'unknown';
  errorCode?: string;
  commitState?: 'not-committed' | 'committed' | 'restored' | 'unknown';
  retrySafe?: boolean;
  warning?: string;
}

const INCOMPLETE_EVIDENCE_CASES: Array<{
  name: string;
  result: (candidateSourceSha256: string) => TestImportResult;
}> = [
  {
    name: 'missing machine fields',
    result: () => ({ status: 'ok', file: 'checksum_agent.py' }),
  },
  {
    name: 'contradictory rejection fields',
    result: (candidateSourceSha256) => ({
      status: 'error',
      committed: true,
      rejectedBeforeCommit: true,
      candidateSourceSha256,
      activeSourceSha256: sha256('previous active source'),
      activeGeneration: 'present',
      errorCode: 'agent-contract-invalid',
      commitState: 'not-committed',
      retrySafe: true,
    }),
  },
  {
    name: 'a forged candidate hash',
    result: (candidateSourceSha256) => ({
      status: 'ok',
      committed: true,
      rejectedBeforeCommit: false,
      candidateSourceSha256: sha256('forged candidate'),
      activeSourceSha256: candidateSourceSha256,
      activeGeneration: 'present',
      commitState: 'committed',
      retrySafe: false,
    }),
  },
  {
    name: 'a present generation without an active hash',
    result: (candidateSourceSha256) => ({
      status: 'ok',
      committed: true,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeGeneration: 'present',
      commitState: 'committed',
      retrySafe: false,
    }),
  },
  {
    name: 'an absent generation carrying an active hash',
    result: (candidateSourceSha256) => ({
      status: 'error',
      error: 'contradictory restored state',
      errorCode: 'IMPORT_ACTIVATION_FAILED',
      committed: false,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeSourceSha256: sha256('impossible active source'),
      activeGeneration: 'absent',
      commitState: 'restored',
      retrySafe: true,
    }),
  },
  {
    name: 'an unknown generation carrying an invalid hash',
    result: (candidateSourceSha256) => ({
      status: 'error',
      error: 'rollback state is unknown',
      errorCode: 'IMPORT_ROLLBACK_FAILED',
      committed: false,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeSourceSha256: 'not-a-sha256',
      activeGeneration: 'unknown',
      commitState: 'unknown',
      retrySafe: false,
    }),
  },
];

const ACTIVE_TRACE_REJECTION_CASES: Array<{
  name: string;
  boundary?: ImportAuthorizationMode;
  transformTraceView?: (events: FlightEvent[]) => FlightEvent[];
}> = [
  {
    name: 'multiple trace roots',
    transformTraceView: (events) => {
      const root = events.find((event) =>
        event.kind === 'trace.started' && event.parentId === null,
      );
      return root
        ? [...events, { ...root, id: `${root.id}-duplicate` }]
        : events;
    },
  },
  {
    name: 'a stale root with no process incarnation',
    transformTraceView: (events) => rewriteTraceRoot(events, (metadata) => {
      const stale = { ...metadata };
      delete stale.ownerIncarnation;
      return stale;
    }),
  },
  {
    name: 'a root owned by a foreign PID',
    transformTraceView: (events) => rewriteTraceRoot(events, (metadata) => ({
      ...metadata,
      ownerPid: process.pid + 1,
    })),
  },
  {
    name: 'a root owned by a foreign process incarnation',
    transformTraceView: (events) => rewriteTraceRoot(events, (metadata) => ({
      ...metadata,
      ownerIncarnation: 'foreign-process-incarnation',
    })),
  },
  {
    name: 'a missing import authorization boundary',
    boundary: 'missing',
  },
  {
    name: 'a nonce-mismatched import authorization boundary',
    boundary: 'nonce-mismatch',
  },
  {
    name: 'an import authorization boundary from the wrong source',
    boundary: 'wrong-source',
  },
  {
    name: 'duplicate top-level import authorization boundaries',
    boundary: 'duplicate',
  },
  {
    name: 'a completed import authorization inside an active trace',
    boundary: 'completed',
  },
];

const EXPLICIT_POSTCOMMIT_OUTCOMES: Array<{
  name: string;
  httpStatus: number;
  terminalKind:
    | 'gateway.agent.import.completed'
    | 'gateway.agent.import.failed';
  result: (candidateSourceSha256: string) => TestImportResult;
  metadata: (
    candidateSourceSha256: string,
    activeSourceSha256: string | undefined,
  ) => Record<string, unknown>;
}> = [
  {
    name: 'restored-after-commit error',
    httpStatus: 409,
    terminalKind: 'gateway.agent.import.failed',
    result: (candidateSourceSha256) => ({
      status: 'error',
      error: 'activation failed and the previous generation was restored',
      errorCode: 'IMPORT_ACTIVATION_FAILED',
      committed: false,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeSourceSha256: sha256('restored active source'),
      activeGeneration: 'present',
      commitState: 'restored',
      retrySafe: true,
    }),
    metadata: (candidateSourceSha256, activeSourceSha256) => ({
      requestId: 'gateway-request-2',
      httpStatus: 409,
      responseStatus: 'error',
      committed: false,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeSourceSha256,
      activeGeneration: 'present',
      commitState: 'restored',
      retrySafe: true,
      errorCode: 'IMPORT_ACTIVATION_FAILED',
    }),
  },
  {
    name: 'restored first-install absence',
    httpStatus: 409,
    terminalKind: 'gateway.agent.import.failed',
    result: (candidateSourceSha256) => ({
      status: 'error',
      error: 'activation failed and the first install was removed',
      errorCode: 'IMPORT_ACTIVATION_FAILED',
      committed: false,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeGeneration: 'absent',
      commitState: 'restored',
      retrySafe: true,
    }),
    metadata: (candidateSourceSha256) => ({
      requestId: 'gateway-request-2',
      httpStatus: 409,
      responseStatus: 'error',
      committed: false,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeGeneration: 'absent',
      commitState: 'restored',
      retrySafe: true,
      errorCode: 'IMPORT_ACTIVATION_FAILED',
    }),
  },
  {
    name: 'committed cleanup warning',
    httpStatus: 200,
    terminalKind: 'gateway.agent.import.completed',
    result: (candidateSourceSha256) => ({
      status: 'ok',
      file: 'checksum_agent.py',
      warning: 'The committed candidate is active; cleanup remains pending.',
      errorCode: 'IMPORT_POST_COMMIT_CLEANUP_FAILED',
      committed: true,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeSourceSha256: candidateSourceSha256,
      activeGeneration: 'present',
      commitState: 'committed',
      retrySafe: false,
    }),
    metadata: (candidateSourceSha256, activeSourceSha256) => ({
      requestId: 'gateway-request-2',
      httpStatus: 200,
      responseStatus: 'ok',
      committed: true,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeSourceSha256,
      activeGeneration: 'present',
      commitState: 'committed',
      retrySafe: false,
      warning: 'The committed candidate is active; cleanup remains pending.',
      errorCode: 'IMPORT_POST_COMMIT_CLEANUP_FAILED',
    }),
  },
  {
    name: 'incomplete rollback with the candidate still committed',
    httpStatus: 500,
    terminalKind: 'gateway.agent.import.failed',
    result: (candidateSourceSha256) => ({
      status: 'error',
      error: 'rollback could not establish a safe active generation',
      errorCode: 'IMPORT_ROLLBACK_FAILED',
      committed: true,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeSourceSha256: candidateSourceSha256,
      activeGeneration: 'present',
      commitState: 'unknown',
      retrySafe: false,
    }),
    metadata: (candidateSourceSha256, activeSourceSha256) => ({
      requestId: 'gateway-request-2',
      httpStatus: 500,
      responseStatus: 'error',
      committed: true,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeSourceSha256,
      activeGeneration: 'present',
      commitState: 'unknown',
      retrySafe: false,
      errorCode: 'IMPORT_ROLLBACK_FAILED',
      recoveryRequired: true,
    }),
  },
  {
    name: 'incomplete rollback with unknown commit state',
    httpStatus: 500,
    terminalKind: 'gateway.agent.import.failed',
    result: (candidateSourceSha256) => ({
      status: 'error',
      error: 'rollback left the active generation uncertain',
      errorCode: 'IMPORT_ROLLBACK_FAILED',
      committed: false,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeSourceSha256: sha256('uncertain active source'),
      activeGeneration: 'unknown',
      commitState: 'unknown',
      retrySafe: false,
    }),
    metadata: (candidateSourceSha256, activeSourceSha256) => ({
      requestId: 'gateway-request-2',
      httpStatus: 500,
      responseStatus: 'error',
      committed: false,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeSourceSha256,
      activeGeneration: 'unknown',
      commitState: 'unknown',
      retrySafe: false,
      errorCode: 'IMPORT_ROLLBACK_FAILED',
      recoveryRequired: true,
    }),
  },
];

const provenanceBridge = vi.hoisted(() => ({
  calls: [] as CapturedProvenance[],
}));

vi.mock('../../agents/agent-import.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realWithProvenance = actual.withAgentImportProvenance;
  return {
    ...actual,
    withAgentImportProvenance: async (
      provenance: CapturedProvenance,
      operation: () => Promise<unknown>,
    ): Promise<unknown> => {
      provenanceBridge.calls.push({ ...provenance });
      if (typeof realWithProvenance === 'function') {
        return (realWithProvenance as (
          value: CapturedProvenance,
          callback: () => Promise<unknown>,
        ) => Promise<unknown>)(provenance, operation);
      }
      return operation();
    },
  };
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = path.join(HERE, '.agent-import-provenance-tmp');
const TOKEN = 'gateway-token-that-must-never-enter-flight-events';
const IDENTITY_KEY = '42'.repeat(32);

let recorder: FlightRecorder;
let previousRecorder: FlightRecorder;
let server: GatewayServer | undefined;
let dataDirectory = '';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function actualPythonAgentSource(): string {
  return `
from agents.basic_agent import BasicAgent

class RestoredFirstInstallAgent(BasicAgent):
    def __init__(self):
        self.name = "RestoredFirstInstall"
        self.metadata = {
            "name": self.name,
            "description": "Exercises first-install rollback through the gateway.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return '{"status":"success","result":"installed"}'
`;
}

function rewriteTraceRoot(
  events: FlightEvent[],
  rewriteMetadata: (
    metadata: Record<string, unknown>,
  ) => Record<string, unknown>,
): FlightEvent[] {
  return events.map((event) =>
    event.kind === 'trace.started' && event.parentId === null
      ? { ...event, metadata: rewriteMetadata(event.metadata) }
      : event,
  );
}

function provenanceBody(
  traceId: string,
  contents: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    filename: 'checksum_agent.py',
    contents,
    scenarioNonce: 'import-operation-2',
    requestId: 'gateway-request-2',
    traceId,
    ...overrides,
  };
}

async function startServer(
  importer: (
    filename: string,
    contents: Buffer,
  ) => Promise<TestImportResult>,
  options: { bind?: 'loopback' | 'all' } = {},
): Promise<void> {
  dataDirectory = mkdtempSync(path.join(SCRATCH, 'gateway-'));
  server = new GatewayServer({
    port: 0,
    bind: options.bind ?? 'loopback',
    auth: { mode: 'token', tokens: [TOKEN] },
    heartbeatInterval: 60_000,
    dataDir: dataDirectory,
  });
  server.setAgentImporter(importer);
  await server.start();
}

async function postImport(
  body: Record<string, unknown>,
  options: {
    authenticated?: boolean;
    query?: string;
    origin?: string;
  } = {},
): Promise<Response> {
  if (!server) throw new Error('Gateway test server is not running.');
  const authenticated = options.authenticated ?? true;
  return fetch(
    `${options.origin ?? `http://127.0.0.1:${server.port}`}/agents/import${options.query ?? ''}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        connection: 'close',
        ...(authenticated ? { authorization: ['Bearer', TOKEN].join(' ') } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

type ImportAuthorizationMode =
  | 'valid'
  | 'missing'
  | 'nonce-mismatch'
  | 'wrong-source'
  | 'duplicate'
  | 'completed';

interface TraceRequestOptions {
  authenticated?: boolean;
  query?: string;
  boundary?: ImportAuthorizationMode;
  transformTraceView?: (events: FlightEvent[]) => FlightEvent[];
}

async function recordImportAuthorization(
  root: FlightEvent,
  nonce: string,
  mode: ImportAuthorizationMode = 'valid',
): Promise<void> {
  if (mode === 'missing') return;
  const count = mode === 'duplicate' ? 2 : 1;
  for (let index = 0; index < count; index += 1) {
    await recorder.record({
      kind: 'agent.import.authorization.started',
      source: mode === 'wrong-source'
        ? 'not-agent-import-authorizer'
        : 'agent-import-authorizer',
      status: 'started',
      parentId: root.id,
      metadata: {
        nonce: mode === 'nonce-mismatch' ? `${nonce}-mismatch` : nonce,
      },
    });
  }
  if (mode === 'completed') {
    await recorder.record({
      kind: 'agent.import.authorization.completed',
      source: 'agent-import-authorizer',
      status: 'success',
      parentId: root.id,
      metadata: { nonce },
    });
  }
}

async function postInsideTrace(
  traceId: string,
  body: Record<string, unknown>,
  options: TraceRequestOptions = {},
): Promise<{ response: Response; root: FlightEvent }> {
  let response: Response | undefined;
  let root: FlightEvent | undefined;
  const queryRecorder = recorder.query.bind(recorder);
  await recorder.runTrace({ traceId }, async () => {
    const roots = await queryRecorder({
      traceId,
      kind: 'trace.started',
      order: 'asc',
    });
    root = roots.find((event) => event.parentId === null);
    if (!root) throw new Error('Test trace root was not recorded.');
    const nonce =
      typeof body.scenarioNonce === 'string' ? body.scenarioNonce : '';
    await recordImportAuthorization(
      root,
      nonce,
      options.boundary ?? 'valid',
    );
    if (options.transformTraceView) {
      const transformTraceView = options.transformTraceView;
      const querySpy = vi.spyOn(recorder, 'query').mockImplementation(
        async (query = {}) => {
          const events = await queryRecorder(query);
          return query.traceId === traceId
            ? transformTraceView(events)
            : events;
        },
      );
      try {
        response = await postImport(body, options);
      } finally {
        querySpy.mockRestore();
      }
    } else {
      response = await postImport(body, options);
    }
  });
  if (!response || !root) {
    throw new Error('Test request did not complete inside its Flight trace.');
  }
  return { response, root };
}

async function traceEvents(traceId: string): Promise<FlightEvent[]> {
  return recorder.query({ traceId, order: 'asc' });
}

beforeAll(() => {
  mkdirSync(SCRATCH, { recursive: true });
});

beforeEach(async () => {
  provenanceBridge.calls.length = 0;
  recorder = new FlightRecorder({
    enabled: true,
    inMemory: true,
    identityKey: IDENTITY_KEY,
    privacy: { recordIO: true },
  });
  await recorder.initialize();
  previousRecorder = setFlightRecorder(recorder);
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  setFlightRecorder(previousRecorder);
  await recorder.close();
  if (dataDirectory) {
    rmSync(dataDirectory, { recursive: true, force: true });
    dataDirectory = '';
  }
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function bindAllOrigin(port: number): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return `http://${address.address}:${port}`;
      }
    }
  }
  throw new Error('No non-loopback IPv4 interface is available for bind-all testing.');
}

describe('POST /agents/import causal provenance', () => {
  it('authenticates before recording provenance or invoking the importer', async () => {
    let importerCalls = 0;
    await startServer(async () => {
      importerCalls += 1;
      return { status: 'ok', committed: true };
    });
    const traceId = 'unauthenticated-import-trace';

    const { response } = await postInsideTrace(
      traceId,
      provenanceBody(traceId, 'print("must not run")'),
      { authenticated: false },
    );

    expect(response.status).toBe(401);
    expect(importerCalls).toBe(0);
    expect(provenanceBridge.calls).toEqual([]);
    expect(
      (await traceEvents(traceId)).filter((event) =>
        event.kind.startsWith('gateway.agent.import.'),
      ),
    ).toEqual([]);
  });

  it('allows an authenticated bind-all client through gateway-owned provenance', async () => {
    let importerCalls = 0;
    await startServer(async (_filename, contents) => {
      importerCalls += 1;
      const hash = sha256(contents);
      return {
        status: 'ok',
        file: 'remote_agent.py',
        committed: true,
        rejectedBeforeCommit: false,
        candidateSourceSha256: hash,
        activeSourceSha256: hash,
        activeGeneration: 'present',
        commitState: 'committed',
        retrySafe: false,
      };
    }, { bind: 'all' });
    const origin = bindAllOrigin(server!.port);
    const body = {
      filename: 'remote_agent.py',
      contents: 'print("authenticated remote import")',
    };

    expect((await postImport(body, {
      authenticated: false,
      origin,
    })).status).toBe(401);
    expect(importerCalls).toBe(0);

    const response = await postImport(body, { origin });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      committed: true,
      activeGeneration: 'present',
    });
    expect(importerCalls).toBe(1);
    expect((await recorder.query()).map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        'agent.import.authorization.started',
        'gateway.agent.import.started',
        'gateway.agent.import.completed',
        'agent.import.authorization.completed',
      ]),
    );
  });

  it('rejects caller-supplied provenance from a bind-all remote client', async () => {
    let importerCalls = 0;
    await startServer(async () => {
      importerCalls += 1;
      return { status: 'ok' };
    }, { bind: 'all' });
    const origin = bindAllOrigin(server!.port);
    const traceId = 'remote-caller-provenance';
    let response: Response | undefined;

    await recorder.runTrace({ traceId }, async () => {
      const root = (await recorder.query({
        traceId,
        kind: 'trace.started',
      }))[0]!;
      await recordImportAuthorization(root, 'import-operation-2');
      response = await postImport(
        provenanceBody(traceId, 'print("remote caller provenance")'),
        { origin },
      );
    });

    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      status: 'error',
      error: expect.stringContaining('loopback'),
    });
    expect(importerCalls).toBe(0);
  });

  it.each([
    {
      name: 'authorization start',
      failedKind: 'agent.import.authorization.started',
      expectedImporterCalls: 0,
    },
    {
      name: 'gateway start',
      failedKind: 'gateway.agent.import.started',
      expectedImporterCalls: 0,
    },
    {
      name: 'gateway terminal',
      failedKind: 'gateway.agent.import.completed',
      expectedImporterCalls: 1,
    },
    {
      name: 'authorization terminal',
      failedKind: 'agent.import.authorization.completed',
      expectedImporterCalls: 1,
    },
  ])(
    'fails closed when durable $name evidence returns null',
    async ({ failedKind, expectedImporterCalls }) => {
      let importerCalls = 0;
      await startServer(async (_filename, contents) => {
        importerCalls += 1;
        const hash = sha256(contents);
        return {
          status: 'ok',
          file: 'fault_agent.py',
          committed: true,
          rejectedBeforeCommit: false,
          candidateSourceSha256: hash,
          activeSourceSha256: hash,
          activeGeneration: 'present',
          commitState: 'committed',
          retrySafe: false,
        };
      });
      const realRecord = recorder.record.bind(recorder);
      vi.spyOn(recorder, 'record').mockImplementation(async (input) =>
        input.kind === failedKind ? null : realRecord(input),
      );

      const response = await postImport({
        filename: 'fault_agent.py',
        contents: `print(${JSON.stringify(failedKind)})`,
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        status: 'error',
        error: expect.any(String),
      });
      if (expectedImporterCalls > 0) {
        expect(body).toMatchObject({
          committed: true,
          activeGeneration: 'present',
          retrySafe: false,
        });
      }
      expect(importerCalls).toBe(expectedImporterCalls);
    },
  );

  it.each(ACTIVE_TRACE_REJECTION_CASES)(
    'rejects $name before any importer side effect',
    async ({ name, boundary, transformTraceView }) => {
      let importerCalls = 0;
      await startServer(async (_filename, contents) => {
        importerCalls += 1;
        const hash = sha256(contents);
        return {
          status: 'ok',
          committed: true,
          rejectedBeforeCommit: false,
          candidateSourceSha256: hash,
          activeSourceSha256: hash,
          activeGeneration: 'present',
          commitState: 'committed',
          retrySafe: false,
        };
      });
      const traceId =
        `inactive-${name.replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`;
      const contents = `root-rejection-source-sentinel:${name}`;

      const { response } = await postInsideTrace(
        traceId,
        provenanceBody(traceId, contents),
        { boundary, transformTraceView },
      );
      const responseBody = await response.json();

      expect(response.status).toBe(400);
      expect(responseBody).toMatchObject({
        status: 'error',
        error: expect.any(String),
      });
      expect(importerCalls).toBe(0);
      expect(provenanceBridge.calls).toEqual([]);
      const events = await traceEvents(traceId);
      expect(
        events.some((event) =>
          event.kind.startsWith('gateway.agent.import.'),
        ),
      ).toBe(false);
      expect(JSON.stringify(events)).not.toContain(contents);
      expect(JSON.stringify(events)).not.toContain(TOKEN);
      expect(JSON.stringify(responseBody)).not.toContain(contents);
      expect(JSON.stringify(responseBody)).not.toContain(TOKEN);
    },
  );

  it('rejects a completed authorization trace before invoking the importer', async () => {
    let importerCalls = 0;
    await startServer(async () => {
      importerCalls += 1;
      return { status: 'ok' };
    });
    const traceId = 'completed-import-trace';
    await recorder.runTrace({ traceId }, async () => {
      const root = (await recorder.query({
        traceId,
        kind: 'trace.started',
      })).find((event) => event.parentId === null);
      if (!root) throw new Error('Completed test trace has no root.');
      await recordImportAuthorization(root, 'import-operation-2');
    });

    const response = await postImport(
      provenanceBody(traceId, 'completed-trace-source-sentinel'),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      status: 'error',
      error: expect.stringContaining('no longer active'),
    });
    expect(importerCalls).toBe(0);
    expect(provenanceBridge.calls).toEqual([]);
    const events = await traceEvents(traceId);
    expect(
      events.some((event) =>
        event.kind.startsWith('gateway.agent.import.'),
      ),
    ).toBe(false);
    expect(JSON.stringify(events)).not.toContain(
      'completed-trace-source-sentinel',
    );
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it('records the computed hash and exact causal parents for a query-string request', async () => {
    const contents = 'print("source-sentinel-never-record")\n';
    const candidateSourceSha256 = sha256(contents);
    let importerCalls = 0;
    let importerParentId = '';
    await startServer(async (filename, received) => {
      importerCalls += 1;
      importerParentId = recorder.currentTrace()?.parentId ?? '';
      expect(filename).toBe('checksum_agent.py');
      expect(received.equals(Buffer.from(contents))).toBe(true);
      return {
        status: 'ok',
        file: filename,
        committed: true,
        rejectedBeforeCommit: false,
        candidateSourceSha256,
        activeSourceSha256: candidateSourceSha256,
        activeGeneration: 'present',
        commitState: 'committed',
        retrySafe: false,
      };
    });
    const recordSpy = vi.spyOn(recorder, 'record');
    const traceId = 'valid-import-trace';

    const { response, root } = await postInsideTrace(
      traceId,
      provenanceBody(traceId, contents, {
        candidateSourceSha256: 'f'.repeat(64),
      }),
      { query: '?provenance=1' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      file: 'checksum_agent.py',
      committed: true,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeSourceSha256: candidateSourceSha256,
      activeGeneration: 'present',
      commitState: 'committed',
      retrySafe: false,
    });

    const events = await traceEvents(traceId);
    const started = events.find(
      (event) => event.kind === 'gateway.agent.import.started',
    );
    const completed = events.find(
      (event) => event.kind === 'gateway.agent.import.completed',
    );
    expect(importerCalls).toBe(1);
    expect(started).toMatchObject({
      traceId,
      parentId: root.id,
      source: 'gateway',
      status: 'started',
      metadata: {
        method: 'POST',
        path: '/agents/import',
        authenticated: true,
        authMode: 'token',
        filename: 'checksum_agent.py',
        nonce: 'import-operation-2',
        requestId: 'gateway-request-2',
        candidateSourceSha256,
      },
    });
    expect(started?.metadata).toEqual({
      method: 'POST',
      path: '/agents/import',
      authenticated: true,
      authMode: 'token',
      filename: 'checksum_agent.py',
      nonce: 'import-operation-2',
      requestId: 'gateway-request-2',
      candidateSourceSha256,
    });
    expect(completed).toMatchObject({
      traceId,
      parentId: started?.id,
      source: 'gateway',
      status: 'success',
      metadata: {
        requestId: 'gateway-request-2',
        httpStatus: 200,
        responseStatus: 'ok',
        committed: true,
        candidateSourceSha256,
      },
    });
    expect(completed?.metadata).toEqual({
      requestId: 'gateway-request-2',
      httpStatus: 200,
      responseStatus: 'ok',
      committed: true,
      candidateSourceSha256,
    });
    expect(provenanceBridge.calls).toEqual([
      {
        traceId,
        scenarioNonce: 'import-operation-2',
        requestId: 'gateway-request-2',
        candidateSourceSha256,
        gatewayParentEventId: started?.id,
      },
    ]);
    expect(importerParentId).toBe(started?.id);

    const persisted = JSON.stringify(events);
    const recorderInputs = JSON.stringify(recordSpy.mock.calls);
    expect(persisted).not.toContain(contents);
    expect(persisted).not.toContain(TOKEN);
    expect(recorderInputs).not.toContain(contents);
    expect(recorderInputs).not.toContain(TOKEN);
  });

  it.each([
    ['a cyclic value', (result: Record<string, unknown>) => {
      result.self = result;
    }],
    ['a BigInt value', (result: Record<string, unknown>) => {
      result.unsupported = BigInt(1);
    }],
  ])(
    'fails closed when proven importer evidence contains %s',
    async (_name, makeUnserialisable) => {
      const contents = 'print("serialisation boundary")';
      const candidateSourceSha256 = sha256(contents);
      await startServer(async () => {
        const result: TestImportResult & Record<string, unknown> = {
          status: 'ok',
          file: 'checksum_agent.py',
          committed: true,
          rejectedBeforeCommit: false,
          candidateSourceSha256,
          activeSourceSha256: candidateSourceSha256,
          activeGeneration: 'present',
          commitState: 'committed',
          retrySafe: false,
        };
        makeUnserialisable(result);
        return result;
      });
      const traceId = `unserialisable-${_name.replaceAll(' ', '-')}`;

      const { response } = await postInsideTrace(
        traceId,
        provenanceBody(traceId, contents),
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        status: 'error',
        error: 'Import result could not be serialised',
      });
      expect((await fetch(`http://127.0.0.1:${server!.port}/health`)).status)
        .toBe(200);
    },
  );

  it('records an invalid replacement as a failed child with the active hash', async () => {
    const contents = 'this is not a valid agent';
    const candidateSourceSha256 = sha256(contents);
    const activeSourceSha256 = sha256('working agent source');
    await startServer(async () => ({
      status: 'error',
      error: 'agent contract invalid',
      committed: false,
      rejectedBeforeCommit: true,
      candidateSourceSha256,
      activeSourceSha256,
      activeGeneration: 'present',
      errorCode: 'agent-contract-invalid',
      commitState: 'not-committed',
      retrySafe: true,
    }));
    const traceId = 'invalid-replacement-trace';

    const { response, root } = await postInsideTrace(
      traceId,
      provenanceBody(traceId, contents),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      status: 'error',
      error: 'agent contract invalid',
      committed: false,
      rejectedBeforeCommit: true,
      candidateSourceSha256,
      activeSourceSha256,
      activeGeneration: 'present',
      errorCode: 'agent-contract-invalid',
      commitState: 'not-committed',
      retrySafe: true,
    });

    const events = await traceEvents(traceId);
    const started = events.find(
      (event) => event.kind === 'gateway.agent.import.started',
    );
    const failed = events.find(
      (event) => event.kind === 'gateway.agent.import.failed',
    );
    expect(started?.parentId).toBe(root.id);
    expect(failed).toMatchObject({
      traceId,
      parentId: started?.id,
      source: 'gateway',
      status: 'error',
    });
    expect(failed?.metadata).toEqual({
      requestId: 'gateway-request-2',
      httpStatus: 400,
      responseStatus: 'error',
      committed: false,
      rejectedBeforeCommit: true,
      candidateSourceSha256,
      activeSourceSha256,
    });
  });

  it('accepts a retry-safe precommit rejection with no prior active source', async () => {
    const contents = 'first-install-invalid-source-sentinel';
    const candidateSourceSha256 = sha256(contents);
    const importResult: TestImportResult = {
      status: 'error',
      error: 'candidate validation failed before commit',
      errorCode: 'IMPORT_CANDIDATE_INVALID',
      committed: false,
      rejectedBeforeCommit: true,
      candidateSourceSha256,
      activeGeneration: 'absent',
      commitState: 'not-committed',
      retrySafe: true,
    };
    await startServer(async () => importResult);
    const traceId = 'precommit-without-active-source';

    const { response } = await postInsideTrace(
      traceId,
      provenanceBody(traceId, contents),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(importResult);
    const events = await traceEvents(traceId);
    const failed = events.find(
      (event) => event.kind === 'gateway.agent.import.failed',
    );
    expect(failed?.metadata).toEqual({
      requestId: 'gateway-request-2',
      httpStatus: 400,
      responseStatus: 'error',
      committed: false,
      rejectedBeforeCommit: true,
      candidateSourceSha256,
      activeGeneration: 'absent',
    });
    expect(failed?.metadata).not.toHaveProperty('evidenceIncomplete');
    expect(JSON.stringify(events)).not.toContain(contents);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it.each(EXPLICIT_POSTCOMMIT_OUTCOMES)(
    'preserves the explicit $name outcome',
    async ({ name, httpStatus, terminalKind, result, metadata }) => {
      const contents = `postcommit-source-sentinel:${name}`;
      const candidateSourceSha256 = sha256(contents);
      const importResult = result(candidateSourceSha256);
      let importerCalls = 0;
      await startServer(async () => {
        importerCalls += 1;
        return importResult;
      });
      const recordSpy = vi.spyOn(recorder, 'record');
      const traceId =
        `outcome-${name.replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`;

      const { response } = await postInsideTrace(
        traceId,
        provenanceBody(traceId, contents),
      );
      const responseBody = await response.json();

      expect(response.status).toBe(httpStatus);
      expect(responseBody).toEqual(importResult);
      expect(importerCalls).toBe(1);
      const events = await traceEvents(traceId);
      const started = events.find(
        (event) => event.kind === 'gateway.agent.import.started',
      );
      const terminal = events.find((event) => event.kind === terminalKind);
      expect(terminal).toMatchObject({
        traceId,
        parentId: started?.id,
        source: 'gateway',
        status: terminalKind.endsWith('.completed') ? 'success' : 'error',
      });
      expect(terminal?.metadata).toEqual(
        metadata(
          candidateSourceSha256,
          importResult.activeSourceSha256,
        ),
      );
      expect(terminal?.metadata).not.toHaveProperty('evidenceIncomplete');
      expect(terminal?.metadata.committed).toBe(importResult.committed);
      expect(terminal?.metadata.retrySafe).toBe(importResult.retrySafe);
      expect(terminal?.metadata.commitState).toBe(importResult.commitState);
      expect(terminal?.metadata.activeGeneration).toBe(
        importResult.activeGeneration,
      );

      const persisted = JSON.stringify(events);
      const recorderInputs = JSON.stringify(recordSpy.mock.calls);
      const serializedResponse = JSON.stringify(responseBody);
      for (const secret of [contents, TOKEN]) {
        expect(persisted).not.toContain(secret);
        expect(recorderInputs).not.toContain(secret);
        expect(serializedResponse).not.toContain(secret);
      }
    },
  );

  it('preserves an actual first-install rollback as restored with no active generation', async () => {
    const contents = actualPythonAgentSource();
    const candidateSourceSha256 = sha256(contents);
    const filename = 'restored_first_install_agent.py';
    let rawImportResult: Record<string, unknown> | undefined;
    let targetPath = '';
    let reloadCalls = 0;
    await startServer(async (receivedFilename, receivedContents) => {
      const [{ AgentRegistry }, importerModule] = await Promise.all([
        import('../../agents/AgentRegistry.js'),
        import('../../agents/agent-import.js'),
      ]);
      const agentsDirectory = path.join(dataDirectory, 'actual-importer-agents');
      mkdirSync(agentsDirectory, { recursive: true });
      const registry = new AgentRegistry(
        path.join(dataDirectory, 'empty-builtins'),
        agentsDirectory,
      );
      const originalReload = registry.reloadUserAgents.bind(registry);
      registry.reloadUserAgents = async () => {
        reloadCalls += 1;
        if (reloadCalls === 1) return [];
        return originalReload();
      };
      try {
        const result = await importerModule.importAgentFile(
          receivedFilename,
          receivedContents,
          registry,
          { dir: agentsDirectory },
        );
        rawImportResult = result as unknown as Record<string, unknown>;
        targetPath = path.join(agentsDirectory, receivedFilename);
        if (rawImportResult.activeGeneration !== undefined) {
          return rawImportResult as unknown as TestImportResult;
        }

        // This gateway worktree intentionally predates the coordinated importer
        // commit. Preserve its real rollback result while supplying only the
        // new machine fields that commit adds; integrated runs take the branch
        // above and exercise the importer result without adaptation.
        return {
          ...rawImportResult,
          committed: false,
          rejectedBeforeCommit: false,
          candidateSourceSha256,
          activeGeneration: 'absent',
          errorCode: 'IMPORT_REGISTRY_VERIFICATION_FAILED',
          commitState: 'restored',
          retrySafe: true,
        } as TestImportResult;
      } finally {
        registry.reloadUserAgents = originalReload;
      }
    });
    const traceId = 'actual-restored-first-install';

    const { response } = await postInsideTrace(
      traceId,
      provenanceBody(traceId, contents, { filename }),
    );
    const responseBody = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(rawImportResult?.status).toBe('error');
    expect(reloadCalls).toBeGreaterThan(0);
    expect(targetPath).not.toBe('');
    expect(existsSync(targetPath)).toBe(false);
    expect(responseBody).toMatchObject({
      status: 'error',
      committed: false,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeGeneration: 'absent',
      commitState: 'restored',
      retrySafe: true,
    });
    expect(responseBody).not.toHaveProperty('activeSourceSha256');

    const events = await traceEvents(traceId);
    const failed = events.find(
      (event) => event.kind === 'gateway.agent.import.failed',
    );
    expect(failed?.metadata).toEqual({
      requestId: 'gateway-request-2',
      httpStatus: 409,
      responseStatus: 'error',
      committed: false,
      rejectedBeforeCommit: false,
      candidateSourceSha256,
      activeGeneration: 'absent',
      commitState: 'restored',
      retrySafe: true,
      errorCode: 'IMPORT_REGISTRY_VERIFICATION_FAILED',
    });
    expect(failed?.metadata).not.toHaveProperty('evidenceIncomplete');
    expect(JSON.stringify(events)).not.toContain(contents);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it.each(INCOMPLETE_EVIDENCE_CASES)(
    'fails closed on $name without fabricating terminal metadata',
    async ({ name, result }) => {
      const contents = `machine-evidence-source-sentinel:${name}`;
      const candidateSourceSha256 = sha256(contents);
      let importerCalls = 0;
      await startServer(async () => {
        importerCalls += 1;
        return result(candidateSourceSha256);
      });
      const recordSpy = vi.spyOn(recorder, 'record');
      const traceId = `incomplete-evidence-${name.replaceAll(' ', '-')}`;

      const { response } = await postInsideTrace(
        traceId,
        provenanceBody(traceId, contents),
      );
      const responseBody = await response.json();

      expect(response.status).toBe(503);
      expect(responseBody).toEqual({
        status: 'error',
        error:
          'Agent import result lacked complete, consistent provenance evidence.',
      });
      expect(importerCalls).toBe(1);
      expect(provenanceBridge.calls).toHaveLength(1);

      const events = await traceEvents(traceId);
      const started = events.find(
        (event) => event.kind === 'gateway.agent.import.started',
      );
      const failed = events.find(
        (event) => event.kind === 'gateway.agent.import.failed',
      );
      expect(failed).toMatchObject({
        traceId,
        parentId: started?.id,
        source: 'gateway',
        status: 'error',
      });
      expect(failed?.metadata).toEqual({
        requestId: 'gateway-request-2',
        httpStatus: 503,
        responseStatus: 'error',
        evidenceIncomplete: true,
        candidateSourceSha256,
      });
      expect(failed?.metadata).not.toHaveProperty('committed');
      expect(failed?.metadata).not.toHaveProperty('rejectedBeforeCommit');
      expect(failed?.metadata).not.toHaveProperty('activeSourceSha256');
      expect(failed?.metadata).not.toHaveProperty('activeGeneration');
      expect(failed?.metadata).not.toHaveProperty('commitState');
      expect(failed?.metadata).not.toHaveProperty('retrySafe');
      expect(failed?.metadata).not.toHaveProperty('recoveryRequired');
      expect(
        events.some(
          (event) => event.kind === 'gateway.agent.import.completed',
        ),
      ).toBe(false);

      const persisted = JSON.stringify(events);
      const recorderInputs = JSON.stringify(recordSpy.mock.calls);
      const serializedResponse = JSON.stringify(responseBody);
      for (const secret of [contents, TOKEN]) {
        expect(persisted).not.toContain(secret);
        expect(recorderInputs).not.toContain(secret);
        expect(serializedResponse).not.toContain(secret);
      }
    },
  );

  it('rejects incomplete, invalid, and rootless provenance before importing', async () => {
    let importerCalls = 0;
    await startServer(async () => {
      importerCalls += 1;
      return { status: 'ok', committed: true };
    });

    const incomplete = await postImport({
      filename: 'checksum_agent.py',
      contents: 'print(1)',
      scenarioNonce: 'nonce',
      requestId: 'request',
    });
    expect(incomplete.status).toBe(400);
    expect(await incomplete.json()).toMatchObject({
      error: expect.stringContaining('together'),
    });

    const invalid = await postImport(
      provenanceBody('invalid-id-trace', 'print(2)', {
        requestId: 'request\ninjected',
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: expect.stringContaining('requestId'),
    });

    const tooLong = await postImport(
      provenanceBody('overlong-trace', 'print(3)', {
        scenarioNonce: 'n'.repeat(129),
      }),
    );
    expect(tooLong.status).toBe(400);

    const rootless = await postImport(
      provenanceBody('missing-flight-root', 'print(4)'),
    );
    expect(rootless.status).toBe(400);
    expect(await rootless.json()).toMatchObject({
      error: expect.stringContaining('trace.started'),
    });

    expect(importerCalls).toBe(0);
    expect(provenanceBridge.calls).toEqual([]);
    expect(
      (await recorder.query()).some((event) =>
        event.kind.startsWith('gateway.agent.import.'),
      ),
    ).toBe(false);
  });

  it('creates gateway-owned evidence when client provenance is missing', async () => {
    const contents = 'print("gateway-owned provenance")';
    const candidateSourceSha256 = sha256(contents);
    let importerCalls = 0;
    await startServer(async (filename) => {
      importerCalls += 1;
      return {
        status: 'ok',
        file: filename,
        committed: true,
        rejectedBeforeCommit: false,
        candidateSourceSha256,
        activeSourceSha256: candidateSourceSha256,
        activeGeneration: 'present',
        commitState: 'committed',
        retrySafe: false,
      };
    });

    const response = await postImport({
      filename: 'automatic_agent.py',
      contents,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      file: 'automatic_agent.py',
      committed: true,
      candidateSourceSha256,
      activeSourceSha256: candidateSourceSha256,
    });
    expect(importerCalls).toBe(1);
    expect(provenanceBridge.calls).toEqual([
      expect.objectContaining({
        traceId: expect.stringMatching(/^agent-import-/u),
        scenarioNonce: expect.stringMatching(/^agent-import-/u),
        requestId: expect.stringMatching(/^agent-import-/u),
        candidateSourceSha256,
        gatewayParentEventId: expect.any(String),
      }),
    ]);
    const events = await recorder.query();
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        'trace.started',
        'agent.import.authorization.started',
        'gateway.agent.import.started',
        'gateway.agent.import.completed',
        'agent.import.authorization.completed',
        'trace.completed',
      ]),
    );
    expect(events.find((event) =>
      event.kind === 'agent.import.authorization.started',
    )).toMatchObject({
      source: 'agent-import-authorizer',
      status: 'started',
      metadata: {
        mode: 'gateway-owned',
      },
    });
  });

  it('records unexpected importer exceptions without claiming commit state', async () => {
    await startServer(async () => {
      throw new Error('exception text must not enter provenance');
    });
    const traceId = 'throwing-import-trace';

    const { response } = await postInsideTrace(
      traceId,
      provenanceBody(traceId, 'print("candidate")'),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      status: 'error',
      error: 'Agent import failed unexpectedly.',
    });

    const failed = (await traceEvents(traceId)).find(
      (event) => event.kind === 'gateway.agent.import.failed',
    );
    expect(failed?.metadata).toEqual({
      requestId: 'gateway-request-2',
      httpStatus: 500,
      responseStatus: 'error',
      candidateSourceSha256: sha256('print("candidate")'),
    });
    expect(failed?.metadata).not.toHaveProperty('committed');
    expect(failed?.metadata).not.toHaveProperty('rejectedBeforeCommit');
    expect(failed?.metadata).not.toHaveProperty('activeSourceSha256');
    expect(failed?.metadata).not.toHaveProperty('activeGeneration');
    expect(failed?.metadata).not.toHaveProperty('commitState');
    expect(failed?.metadata).not.toHaveProperty('retrySafe');
    expect(failed?.metadata).not.toHaveProperty('recoveryRequired');
    expect(JSON.stringify(failed)).not.toContain('exception text');
  });
});
