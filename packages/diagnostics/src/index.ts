import { createHash, randomBytes } from "node:crypto";

export type RedactedValue = null | boolean | number | string | readonly RedactedValue[] | { readonly [key: string]: RedactedValue };
export const REDACTED = "[redacted]";
const sensitiveKey = /(?:token|secret|password|passwd|authorization|cookie|credential|private.?key|api.?key|prompt|input|output|content|command|argv|env|path|email|phone|stack|message)/iu;
const identifierKey = /^(?:agentId|workspaceId|taskId|runId|traceId|spanId|parentId|artifactId|computerId)$/u;
const safeTextKey = /^(?:component|operation|code|status|level|kind|name|state)$/u;
const safeNumberKey = /^(?:count|attempt|bytes|durationMs|latencyMs|retryAfterMs|sequence|failures|successes|pending)$/u;
const secretValue = /(?:github_pat_|gh[pousr]_|bearer\s|-----BEGIN|[A-Za-z0-9+/=_-]{40,}|(?:\/Users\/|\/home\/)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu;

export class DiagnosticRedactor {
  private readonly salt = randomBytes(32);

  redact(input: unknown): RedactedValue {
    const seen = new Set<object>();
    let budget = 1000;
    const visit = (value: unknown, key: string, depth: number): RedactedValue => {
      if (--budget < 0 || depth > 12 || sensitiveKey.test(key)) return REDACTED;
      if (value === null) return null;
      if (identifierKey.test(key) && typeof value === "string") {
        return `id:${createHash("sha256").update(this.salt).update(value).digest("hex").slice(0, 16)}`;
      }
      if (typeof value === "string") {
        return safeTextKey.test(key) && /^[a-zA-Z0-9_.:-]{1,80}$/u.test(value) && !secretValue.test(value)
          ? value : REDACTED;
      }
      if (typeof value === "number") return safeNumberKey.test(key) && Number.isFinite(value) ? value : REDACTED;
      if (typeof value === "boolean") return /^(?:healthy|available|enabled|redacted)$/u.test(key) ? value : REDACTED;
      if (typeof value !== "object" || seen.has(value)) return REDACTED;
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const array: RedactedValue[] = [];
          for (let index = 0; index < Math.min(value.length, 100); index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, index);
            array.push(descriptor && "value" in descriptor ? visit(descriptor.value, key, depth + 1) : REDACTED);
          }
          return Object.freeze(array);
        }
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
          return REDACTED;
        }
        const output: Record<string, RedactedValue> = {};
        for (const [childKey, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)).slice(0, 100)) {
          if (!descriptor.enumerable || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(childKey) || secretValue.test(childKey)) continue;
          const child = "value" in descriptor ? visit(descriptor.value, childKey, depth + 1) : REDACTED;
          Object.defineProperty(output, childKey, { value: child, enumerable: true });
        }
        return Object.freeze(output);
      } catch { return REDACTED; }
      finally { seen.delete(value); }
    };
    return visit(input, "", 0);
  }
}

export interface DiagnosticInput {
  readonly component: string;
  readonly operation: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly details?: unknown;
}

export interface DiagnosticRecord {
  readonly authoritative: false;
  readonly sequence: number;
  readonly at: string;
  readonly data: RedactedValue;
}

export interface HealthProbe {
  readonly name: string;
  check(signal: AbortSignal): Promise<"healthy" | "degraded" | "unavailable">;
}

export interface HealthObservation {
  readonly authoritative: false;
  readonly name: RedactedValue;
  readonly status: "healthy" | "degraded" | "unavailable" | "unconfirmed";
}

export class Diagnostics {
  private readonly records: DiagnosticRecord[] = [];
  private readonly redactor = new DiagnosticRedactor();
  private sequence = 0;
  private readonly maximum: number;
  private readonly now: () => Date;
  private readonly sink: ((record: DiagnosticRecord) => void) | undefined;

  constructor(options: {
    readonly maxRecords?: number;
    readonly now?: () => Date;
    readonly sink?: (record: DiagnosticRecord) => void;
  } = {}) {
    this.maximum = options.maxRecords ?? 500;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > 10_000) {
      throw new Error("invalid_diagnostic_limit");
    }
    this.now = options.now ?? (() => new Date());
    this.sink = options.sink;
  }

  record(input: DiagnosticInput): void {
    try {
      const record: DiagnosticRecord = Object.freeze({
        authoritative: false, sequence: ++this.sequence, at: this.now().toISOString(),
        data: this.redactor.redact(input),
      });
      this.records.push(record);
      if (this.records.length > this.maximum) this.records.shift();
      try { this.sink?.(record); } catch { /* Diagnostics must not change a command's outcome. */ }
    } catch { /* A failed clock or serializer must not become business authority. */ }
  }

  snapshot(): readonly DiagnosticRecord[] {
    return Object.freeze([...this.records]);
  }

  async health(probes: readonly HealthProbe[], timeoutMs = 1000): Promise<readonly HealthObservation[]> {
    if (probes.length > 16 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error("invalid_health_limits");
    }
    return Promise.all(probes.map(async (probe): Promise<HealthObservation> => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let status: HealthObservation["status"];
      try {
        status = await Promise.race([
          Promise.resolve().then(() => probe.check(controller.signal)),
          new Promise<"unconfirmed">((resolve) => {
            timer = setTimeout(() => { controller.abort(); resolve("unconfirmed"); }, timeoutMs);
          }),
        ]);
        if (!["healthy", "degraded", "unavailable", "unconfirmed"].includes(status)) status = "unconfirmed";
      } catch { status = "unconfirmed"; }
      finally { clearTimeout(timer); }
      return Object.freeze({
        authoritative: false, name: this.redactor.redact({ name: probe.name }), status,
      });
    }));
  }

  exportSupport(): string {
    return JSON.stringify({
      schema: "rapp-work.diagnostics/v1", authoritative: false, redacted: true,
      records: this.snapshot(),
    }, null, 2);
  }
}
