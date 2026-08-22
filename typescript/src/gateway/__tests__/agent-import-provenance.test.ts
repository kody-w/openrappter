import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
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
  errorCode?: string;
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
      errorCode: 'agent-contract-invalid',
    }),
  },
  {
    name: 'a forged candidate hash',
    result: (candidateSourceSha256) => ({
      status: 'ok',
      committed: true,
      candidateSourceSha256: sha256('forged candidate'),
      activeSourceSha256: candidateSourceSha256,
    }),
  },
];

const provenanceBridge = vi.hoisted(() => ({
  calls: [] as CapturedProvenance[],
}));

vi.mock('../../agents/agent-import.js', () => ({
  withAgentImportProvenance: async (
    provenance: CapturedProvenance,
    operation: () => Promise<unknown>,
  ): Promise<unknown> => {
    provenanceBridge.calls.push({ ...provenance });
    return operation();
  },
}));

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

function provenanceBody(
  traceId: string,
  contents: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    filename: 'checksum_agent.py',
    contents,
    scenarioNonce: 'flagship-scenario-2',
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
): Promise<void> {
  dataDirectory = mkdtempSync(path.join(SCRATCH, 'gateway-'));
  server = new GatewayServer({
    port: 0,
    bind: 'loopback',
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
  } = {},
): Promise<Response> {
  if (!server) throw new Error('Gateway test server is not running.');
  const authenticated = options.authenticated ?? true;
  return fetch(
    `http://127.0.0.1:${server.port}/agents/import${options.query ?? ''}`,
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

async function postInsideTrace(
  traceId: string,
  body: Record<string, unknown>,
  options: {
    authenticated?: boolean;
    query?: string;
  } = {},
): Promise<{ response: Response; root: FlightEvent }> {
  let response: Response | undefined;
  let root: FlightEvent | undefined;
  await recorder.runTrace({ traceId }, async () => {
    const roots = await recorder.query({
      traceId,
      kind: 'trace.started',
      order: 'asc',
    });
    root = roots.find((event) => event.parentId === null);
    if (!root) throw new Error('Test trace root was not recorded.');
    response = await postImport(body, options);
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
        candidateSourceSha256,
        activeSourceSha256: candidateSourceSha256,
      };
    });
    const recordSpy = vi.spyOn(recorder, 'record');
    const traceId = 'valid-import-trace';

    const { response, root } = await postInsideTrace(
      traceId,
      provenanceBody(traceId, contents, {
        candidateSourceSha256: 'f'.repeat(64),
      }),
      { query: '?flagship=1' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      file: 'checksum_agent.py',
      committed: true,
      candidateSourceSha256,
      activeSourceSha256: candidateSourceSha256,
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
        nonce: 'flagship-scenario-2',
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
      nonce: 'flagship-scenario-2',
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
        scenarioNonce: 'flagship-scenario-2',
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
      errorCode: 'agent-contract-invalid',
    }));
    const traceId = 'invalid-replacement-trace';

    const { response, root } = await postInsideTrace(
      traceId,
      provenanceBody(traceId, contents),
    );
    expect(response.status).toBe(400);

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

  it('keeps the legacy no-provenance request and response unchanged', async () => {
    let importerCalls = 0;
    await startServer(async (filename) => {
      importerCalls += 1;
      return { status: 'ok', file: filename };
    });

    const response = await postImport({
      filename: 'legacy_agent.py',
      contents: 'print("legacy")',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      file: 'legacy_agent.py',
    });
    expect(importerCalls).toBe(1);
    expect(provenanceBridge.calls).toEqual([]);
    expect(await recorder.query()).toEqual([]);
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
    expect(JSON.stringify(failed)).not.toContain('exception text');
  });
});
