import { isSecretKey } from './secret-keys.js';

export const REDACTED = '***REDACTED***';

/**
 * Structures below this depth are replaced wholesale rather than emitted.
 * See the note in redactSecrets for why they cannot simply be passed through.
 */
export const MAX_REDACT_DEPTH = 10;

export const TOO_DEEP = '[nested too deep to redact]';

/**
 * Recursively replace secret values so a structure is safe to print or persist.
 *
 * This is the only implementation. `config show` and the logger both call it,
 * because a redactor that some writers bypass is not a redactor.
 */
export function redactSecrets(obj: unknown, depth = 0): unknown {
  // Scalars carry no keys of their own; the caller already judged the key
  // that pointed here, so they are safe to return at any depth.
  if (typeof obj !== 'object' || obj === null) return obj;

  // Past the limit we can no longer inspect keys. Returning the structure
  // unread would let a secret nested deeper than the limit through untouched,
  // so the structure itself is what has to go.
  if (depth > MAX_REDACT_DEPTH) return TOO_DEEP;

  if (Array.isArray(obj)) return obj.map((v) => redactSecrets(v, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (isSecretKey(k)) {
      // A secret name covers everything beneath it, not just a string value.
      // `apiKey: { raw: '...' }` and `apiKey: ['...']` are still the api key.
      result[k] = v === undefined || v === null || v === '' ? v : REDACTED;
      continue;
    }
    result[k] = redactSecrets(v, depth + 1);
  }
  return result;
}
