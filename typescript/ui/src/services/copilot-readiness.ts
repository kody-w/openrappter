export const COPILOT_READINESS_STATES = [
  'unknown',
  'checking',
  'ready',
  'needs-sign-in',
  'no-entitlement',
  'offline',
  'error',
] as const;

export type CopilotReadinessState =
  (typeof COPILOT_READINESS_STATES)[number];

export interface CopilotReadinessSnapshot {
  state: CopilotReadinessState;
  message: string;
  checkedAt?: string;
}

export interface CopilotAuthAdapter {
  check(): Promise<CopilotReadinessSnapshot>;
  beginSignIn(): Promise<CopilotReadinessSnapshot>;
  reportFailure(error: unknown): Promise<CopilotReadinessSnapshot>;
}

type ReadinessListener = (snapshot: CopilotReadinessSnapshot) => void;

function validSnapshot(
  value: unknown,
): value is CopilotReadinessSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.state === 'string' &&
    (COPILOT_READINESS_STATES as readonly string[]).includes(candidate.state) &&
    typeof candidate.message === 'string'
  );
}

export class PendingCopilotAuthAdapter implements CopilotAuthAdapter {
  async check(): Promise<CopilotReadinessSnapshot> {
    return {
      state: 'unknown',
      message:
        'Copilot readiness is unavailable until the independent authentication service is installed.',
    };
  }

  async beginSignIn(): Promise<CopilotReadinessSnapshot> {
    return {
      state: 'needs-sign-in',
      message:
        'The independent Copilot sign-in adapter is not installed. Use Legacy OpenRappter or retry after the auth service is available.',
    };
  }

  async reportFailure(error: unknown): Promise<CopilotReadinessSnapshot> {
    return pendingReadinessFromError(error);
  }
}

export class CopilotReadinessStore {
  private current: CopilotReadinessSnapshot = {
    state: 'unknown',
    message: 'Copilot readiness has not been checked.',
  };
  private readonly listeners = new Set<ReadinessListener>();

  snapshot(): CopilotReadinessSnapshot {
    return { ...this.current };
  }

  set(snapshot: CopilotReadinessSnapshot): void {
    if (!validSnapshot(snapshot)) {
      throw new Error('Invalid Copilot readiness snapshot.');
    }
    this.current = Object.freeze({ ...snapshot });
    for (const listener of this.listeners) listener(this.snapshot());
  }

  subscribe(listener: ReadinessListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }
}

export const copilotReadiness = new CopilotReadinessStore();

function pendingReadinessFromError(
  error: unknown,
): CopilotReadinessSnapshot {
  const record = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {};
  const status = Number(record.status ?? record.statusCode ?? record.code);
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    status === 401 ||
    /\b401\b|not authenticated|authentication required|sign[ -]?in required/.test(normalized)
  ) {
    return {
      state: 'needs-sign-in',
      message: 'Copilot sign-in is required. Stale Copilot content was cleared.',
      checkedAt: new Date().toISOString(),
    };
  }
  if (
    status === 403 ||
    /no entitlement|not entitled|copilot entitlement|subscription required/.test(normalized)
  ) {
    return {
      state: 'no-entitlement',
      message: 'This account has no Copilot entitlement.',
      checkedAt: new Date().toISOString(),
    };
  }
  if (
    /offline|network|failed to fetch|connection refused|socket|econn/.test(normalized)
  ) {
    return {
      state: 'offline',
      message: 'Copilot readiness cannot be checked while offline.',
      checkedAt: new Date().toISOString(),
    };
  }
  return {
    state: 'error',
    message: message || 'Copilot readiness check failed.',
    checkedAt: new Date().toISOString(),
  };
}

export function copilotIsReady(snapshot = copilotReadiness.snapshot()): boolean {
  return snapshot.state === 'ready';
}
