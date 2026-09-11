import { RPC_ERROR, type RpcError, type RpcMethodHandler } from '../types.js';

const WORKSPACE_STREAMS = ['body', 'memory', 'swarm'] as const;
type WorkspaceStream = (typeof WORKSPACE_STREAMS)[number];

interface WorkspaceEvidenceInput {
  eventKind: string;
  subject: string;
  dataHash: string;
  referenceHashes?: readonly string[];
  utc?: string;
}

interface WorkspaceStore {
  list(): Promise<unknown[]>;
  get(agentId: string): Promise<unknown>;
  ensure(agentId: string): Promise<unknown>;
  frames(agentId: string, stream: WorkspaceStream): Promise<{
    frames: readonly unknown[];
    total: number;
  }>;
  appendEvidence(agentId: string, input: WorkspaceEvidenceInput): Promise<unknown>;
  appendFrame(agentId: string, stream: WorkspaceStream, frame: unknown): Promise<unknown>;
}

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: RpcMethodHandler<P, R>,
    options?: { requiresAuth?: boolean },
  ): void;
}

function invalidParams(): never {
  const error = new Error('invalid workspace RPC parameters') as Error & { code: string };
  error.name = 'WorkspaceError';
  error.code = 'invalid-params';
  throw error;
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidParams();
  const parsed = value as Record<string, unknown>;
  if (Object.keys(parsed).some((key) => !allowed.includes(key))) invalidParams();
  return parsed;
}

function agentParams(value: unknown): { agentId: string } {
  const parsed = record(value, ['agentId']);
  if (typeof parsed.agentId !== 'string') invalidParams();
  return { agentId: parsed.agentId };
}

function framesParams(value: unknown): {
  agentId: string;
  stream: WorkspaceStream;
  offset: number;
  limit: number;
} {
  const parsed = record(value, ['agentId', 'stream', 'offset', 'limit']);
  const stream = parsed.stream ?? 'body';
  const offset = parsed.offset ?? 0;
  const limit = parsed.limit ?? 100;
  if (
    typeof parsed.agentId !== 'string'
    || !WORKSPACE_STREAMS.includes(stream as WorkspaceStream)
    || !Number.isSafeInteger(offset)
    || (offset as number) < 0
    || !Number.isSafeInteger(limit)
    || (limit as number) < 1
    || (limit as number) > 1000
  ) invalidParams();
  return {
    agentId: parsed.agentId,
    stream: stream as WorkspaceStream,
    offset: offset as number,
    limit: limit as number,
  };
}

function evidenceParams(value: unknown): WorkspaceEvidenceInput & {
  agentId: string;
} {
  const parsed = record(
    value,
    ['agentId', 'eventKind', 'subject', 'dataHash', 'referenceHashes', 'utc'],
  );
  if (
    typeof parsed.agentId !== 'string'
    || typeof parsed.eventKind !== 'string'
    || typeof parsed.subject !== 'string'
    || typeof parsed.dataHash !== 'string'
    || (
      parsed.referenceHashes !== undefined
      && (
        !Array.isArray(parsed.referenceHashes)
        || parsed.referenceHashes.some((hash) => typeof hash !== 'string')
      )
    )
    || (parsed.utc !== undefined && typeof parsed.utc !== 'string')
  ) invalidParams();
  return {
    agentId: parsed.agentId,
    eventKind: parsed.eventKind,
    subject: parsed.subject,
    dataHash: parsed.dataHash,
    ...(parsed.referenceHashes === undefined
      ? {}
      : { referenceHashes: parsed.referenceHashes as string[] }),
    ...(parsed.utc === undefined ? {} : { utc: parsed.utc }),
  };
}

function frameParams(value: unknown): {
  agentId: string;
  stream: WorkspaceStream;
  frame: Record<string, unknown>;
} {
  const parsed = record(value, ['agentId', 'stream', 'frame']);
  if (
    typeof parsed.agentId !== 'string'
    || !WORKSPACE_STREAMS.includes(parsed.stream as WorkspaceStream)
    || typeof parsed.frame !== 'object'
    || parsed.frame === null
    || Array.isArray(parsed.frame)
  ) invalidParams();
  return parsed as ReturnType<typeof frameParams>;
}

/** Registered from GatewayServer.registerBuiltInMethods, not a disconnected registry. */
export function registerWorkspaceMethods(
  server: MethodRegistrar,
  getStore: () => WorkspaceStore | Promise<WorkspaceStore>,
  broadcast?: (event: 'workspace', payload: unknown) => void,
): void {
  const auth = { requiresAuth: true };
  server.registerMethod('workspace.list', async (value) => {
    record(value, []);
    return { workspaces: await (await getStore()).list() };
  }, auth);
  server.registerMethod('workspace.get', async (value) => {
    const { agentId } = agentParams(value);
    return { workspace: await (await getStore()).get(agentId) };
  }, auth);
  server.registerMethod('workspace.ensure', async (value) => {
    const { agentId } = agentParams(value);
    const workspace = await (await getStore()).ensure(agentId);
    if (broadcast) broadcast('workspace', { action: 'ensured', agentId, workspace });
    return { workspace };
  }, auth);
  server.registerMethod('workspace.frames', async (value) => {
    const { agentId, stream, offset, limit } = framesParams(value);
    const scan = await (await getStore()).frames(agentId, stream);
    const frames = scan.frames.slice(offset, offset + limit);
    return {
      ...scan,
      frames,
      offset,
      limit,
      nextOffset: offset + frames.length < scan.total ? offset + frames.length : null,
    };
  }, auth);
  server.registerMethod('workspace.appendEvidence', async (value) => {
    const { agentId, ...input } = evidenceParams(value);
    const frame = await (await getStore()).appendEvidence(agentId, input);
    if (broadcast) {
      broadcast('workspace', { action: 'frame-appended', agentId, stream: 'body', frame });
    }
    return { frame };
  }, auth);
  server.registerMethod('workspace.appendFrame', async (value) => {
    const { agentId, stream, frame } = frameParams(value);
    const appended = await (await getStore()).appendFrame(agentId, stream, frame);
    if (broadcast) {
      broadcast('workspace', { action: 'frame-appended', agentId, stream, frame: appended });
    }
    return { frame: appended };
  }, auth);
}

/** Preserve explicit workspace/protocol failures over both production transports. */
export function workspaceRpcError(error: unknown): RpcError | undefined {
  if (
    typeof error !== 'object'
    || error === null
    || !('code' in error)
    || typeof error.code !== 'string'
    || !('message' in error)
    || typeof error.message !== 'string'
    || !('name' in error)
    || error.name !== 'WorkspaceError'
  ) return undefined;
  const workspaceError = error as {
    code: string;
    message: string;
    cause?: { name?: string; code?: string; step?: string; frameIndex?: number };
  };
  const invalid = ['invalid-agent-id', 'invalid-path', 'invalid-params'].includes(workspaceError.code);
  const frameError = workspaceError.cause?.name === 'RappFrameError'
    ? workspaceError.cause
    : undefined;
  return {
    code: invalid ? RPC_ERROR.INVALID_PARAMS : RPC_ERROR.INTERNAL_ERROR,
    message: workspaceError.message,
    data: {
      workspaceCode: workspaceError.code,
      ...(frameError ? {
        frameCode: frameError.code,
        verificationStep: frameError.step,
        frameIndex: frameError.frameIndex,
      } : {}),
    },
  };
}
