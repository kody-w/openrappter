/**
 * Talking to the local brainstem from the OpenRappter gateway.
 *
 * The brainstem (`python -m openrappter.brainstem`) is a separate process
 * speaking HTTP `POST /chat`, while the gateway speaks WebSocket `chat.send`.
 * Historically that meant two chat windows to hold one conversation across two
 * brains. It does not have to: both runtimes return the *same* frozen envelope
 * — `rapp-runtime-parity/1.0` §2.4 — so a reply from either can be rendered by
 * the same client without translation.
 *
 * This module is the client half. It is deliberately free of gateway state so
 * it can be tested by handing it a fetch, which is the only way to prove what
 * it does when the brainstem is missing, slow, or answering something that is
 * not an envelope.
 */

/** §2.4: the six keys every runtime must return. */
export const BRAINSTEM_ENVELOPE_KEYS = [
  'response',
  'session_id',
  'agent_logs',
  'voice_mode',
  'model',
  'requested_model',
] as const;

/** Where the brainstem listens when nothing says otherwise. */
export const DEFAULT_BRAINSTEM_URL = 'http://127.0.0.1:7072';

/**
 * The addresses a brainstem is actually found at, in preference order.
 *
 * 7072 is this package's own default. 7071 is the slot a RAPP brainstem sits in
 * — `brainstem.py` documents it as the full drop-in port — and an installation
 * that followed the grail path has one there and nothing on 7072. Probing both
 * is the difference between the selector working on a stock machine and
 * appearing broken until someone finds an environment variable.
 */
export const BRAINSTEM_CANDIDATE_URLS = [
  'http://127.0.0.1:7072',
  'http://127.0.0.1:7071',
] as const;

const DEFAULT_TIMEOUT_MS = 120_000;
const HEALTH_PROBE_TIMEOUT_MS = 1_500;

export interface BrainstemEnvelope {
  response: string;
  session_id: string;
  agent_logs: string;
  voice_mode: boolean;
  model: string;
  requested_model: string;
  /** Present only when the reply carried a voice seam. */
  voice_response?: string;
}

export interface BrainstemAskOptions {
  message: string;
  sessionId?: string;
  conversationHistory?: unknown[];
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * The configured brainstem address.
 *
 * Loopback by default and overridable, because a brainstem on another host is a
 * legitimate setup — but the default must not be a network address that someone
 * else could occupy.
 */
export function brainstemBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENRAPPTER_BRAINSTEM_URL?.trim();
  return configured && configured.length > 0 ? configured.replace(/\/+$/, '') : DEFAULT_BRAINSTEM_URL;
}

/**
 * Find the brainstem, preferring an explicit setting over a guess.
 *
 * An explicit `OPENRAPPTER_BRAINSTEM_URL` is returned without probing: if
 * someone has said where it is, silently using a different one would be worse
 * than failing. Otherwise each candidate is asked `/health`, and the first that
 * answers wins.
 *
 * The result is remembered, because this runs on every brainstem turn and the
 * answer does not change while the gateway is up. `resetBrainstemDiscovery`
 * exists so tests are not order-dependent on that cache.
 */
let discovered: string | null = null;

export function resetBrainstemDiscovery(): void {
  discovered = null;
}

export async function resolveBrainstemUrl(options: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  candidates?: readonly string[];
} = {}): Promise<string> {
  const env = options.env ?? process.env;
  const configured = env.OPENRAPPTER_BRAINSTEM_URL?.trim();
  if (configured && configured.length > 0) return configured.replace(/\/+$/, '');

  if (discovered) return discovered;

  const doFetch = options.fetchImpl ?? fetch;
  const candidates = options.candidates ?? BRAINSTEM_CANDIDATE_URLS;

  for (const candidate of candidates) {
    try {
      const response = await doFetch(`${candidate}/health`, {
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      if (response.ok) {
        discovered = candidate;
        return candidate;
      }
    } catch {
      // Nothing there; try the next.
    }
  }

  // Nothing answered. Return the documented default so the failure names a
  // concrete address rather than reporting that no address was tried.
  return DEFAULT_BRAINSTEM_URL;
}

/**
 * A refusal a person can act on.
 *
 * "fetch failed" tells a user nothing. The common case by far is that the
 * brainstem simply is not running, and the fix is one command, so the error
 * says which address was tried and what to do about it.
 */
export class BrainstemUnavailableError extends Error {
  constructor(baseUrl: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `The brainstem is not answering at ${baseUrl} (${reason}). ` +
        `Start it with \`python -m openrappter.brainstem\`, or set ` +
        `OPENRAPPTER_BRAINSTEM_URL if it listens elsewhere.`,
    );
    this.name = 'BrainstemUnavailableError';
  }
}

function isEnvelope(value: unknown): value is BrainstemEnvelope {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.response === 'string' && typeof record.session_id === 'string';
}

/**
 * Ask the brainstem, and return its envelope unchanged.
 *
 * The envelope is passed through rather than reshaped: it is already the format
 * every OpenRappter client understands, and rewriting it here would be a second
 * place for the two runtimes to drift apart.
 */
export async function askBrainstem(options: BrainstemAskOptions): Promise<BrainstemEnvelope> {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = (
    options.baseUrl ?? (await resolveBrainstemUrl({ fetchImpl: doFetch }))
  ).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const body: Record<string, unknown> = {
    // Both spellings, deliberately. `brainstem.py` documents `message` with
    // `user_input` as a legacy alias, but the RAPP kernel this mirrors is
    // older and rejects a body without `user_input` — a live one answered
    // `400 {"error":"user_input is required"}` to a `message`-only request.
    // Sending both is what makes one client work against both kernels.
    message: options.message,
    user_input: options.message,
  };
  if (options.sessionId) body.session_id = options.sessionId;
  if (options.conversationHistory) body.conversation_history = options.conversationHistory;

  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Not running, refused, DNS, or timed out — all of them mean "no brainstem
    // answered", and all of them are actionable in the same way.
    throw new BrainstemUnavailableError(baseUrl, error);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `The brainstem answered ${response.status} at ${baseUrl}/chat${detail ? `: ${detail.slice(0, 300)}` : '.'}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new Error(
      `The brainstem returned a body that is not JSON (${(error as Error).message}).`,
    );
  }

  if (!isEnvelope(parsed)) {
    throw new Error(
      'The brainstem returned JSON that is not a chat envelope: ' +
        `expected ${BRAINSTEM_ENVELOPE_KEYS.join(', ')}, got ${
          parsed && typeof parsed === 'object' ? Object.keys(parsed).join(', ') || '{}' : typeof parsed
        }.`,
    );
  }

  return parsed;
}
