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

/**
 * Redact `key=value` / `key: value` pairs inside a line of free text.
 *
 * `redactSecrets` judges object keys, which is everything the config printer
 * and the logger's `data` field need. A log *line* is different: by the time it
 * reaches disk the secret is inside a string — `Authorization: Bearer ghp_…`,
 * `apiKey=…` — where there is no object key left to judge, so `redactSecrets`
 * passes it through untouched.
 *
 * This is deliberately not a second answer to "is this a secret?": the decision
 * still belongs to `isSecretKey`, and the marker is still `REDACTED`. Only the
 * shape being scanned differs, which is why it lives in this file rather than
 * beside the one caller that needs it.
 *
 * Conservative by construction — an unrecognized shape is left alone, so this
 * is a second line of defense behind "do not log the secret", never a licence
 * to log one.
 */
const TEXT_PAIR =
  /(["']?)([A-Za-z_][A-Za-z0-9_.\- ]*)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|(?:Bearer|Basic|Token)\s+[^\s,;)\]}]+|[^\s,;)\]}]+)/gi;

export function redactSecretsInText(text: string): string {
  if (!text) return text;
  return text.replace(TEXT_PAIR, (whole, quote: string, key: string, separator: string) => {
    if (!isSecretKey(key.trim())) return whole;
    return `${quote}${key}${quote}${separator}${REDACTED}`;
  });
}

const CREDENTIAL_VALUE_SHAPES = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[opsu]_[A-Za-z0-9]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{24,}\b/,
  /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]{16,}=*\b/i,
];

/**
 * Detect credential-shaped values after structural redaction.
 *
 * Key classification remains owned by `isSecretKey`; this adds only the value
 * shapes needed to prove a serialized artifact contains no raw credential.
 */
export function containsSecretShapedText(text: string): boolean {
  if (!text) return false;
  if (CREDENTIAL_VALUE_SHAPES.some((pattern) => pattern.test(text))) return true;
  let found = false;
  text.replace(
    TEXT_PAIR,
    (whole, _quote: string, key: string, _separator: string, value: string) => {
      const normalizedValue = value.replace(/^(["'])(.*)\1$/, '$2');
      if (
        isSecretKey(key.trim())
        && normalizedValue !== REDACTED
        && normalizedValue !== ''
        && normalizedValue !== 'null'
      ) {
        found = true;
      }
      return whole;
    },
  );
  return found;
}
