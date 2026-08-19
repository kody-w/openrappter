/**
 * One answer to "is this field name a secret?".
 *
 * There were two, and each missed what the other caught:
 *
 *   config display    token password key secret apikey api_key
 *   gateway logging   token password secret credential authorization
 *
 * So `apiKey`, `privateKey`, `signingKey` and `sessionKey` were written to the
 * structured log in the clear, while `credential`, `credentials` and
 * `authorization` were printed in the clear by `config show`. Two lists, two
 * different holes, neither visible from the other file.
 *
 * Matching is on word boundaries rather than substrings, so `apiKey` and
 * `private_key` are caught while `monkey` and `keyword` are not — the previous
 * config list redacted both of those by accident, which is harmless for display
 * but would blank useful fields if the same list were used for logs.
 */

/** Whole words that make a field a secret. */
const SECRET_WORDS = new Set([
  'apikey', 'auth', 'authorization', 'bearer', 'credential', 'credentials',
  'cookie', 'cookies', 'jwt', 'passphrase', 'passwd', 'password', 'pat', 'pem',
  'secret', 'secrets', 'signature', 'token', 'tokens',
]);

/**
 * Words that make a trailing `key` secret.
 *
 * `key` on its own is too blunt in both directions. Treating it as a whole word
 * blanked `keyCount`, `keyId` and `publicKey` — this file's own commit claimed
 * `keyCount` stayed readable, and it did not, which an outside review caught.
 * Dropping it entirely would let `apiKey` and `privateKey` through, which is
 * the bug the word was added for.
 *
 * So `key` counts when it is what the field *is* — the last word, qualified by
 * something that makes it sensitive — and not when it merely appears.
 */
const SECRET_KEY_QUALIFIERS = new Set([
  'access', 'api', 'app', 'auth', 'client', 'encryption', 'identity', 'master',
  'private', 'secret', 'session', 'signing', 'ssh', 'token',
]);

/**
 * Fragments that are unambiguous even when glued to other text.
 *
 * `privatekey` and `identitykey` are here because the word rules cannot reach
 * them: run together with no separator there is nothing to split on, and
 * `identity` is not a qualifier that makes a trailing `key` secret. Both were
 * caught only by the flight recorder's private copy of this logic, so retiring
 * that copy would have quietly stopped redacting them.
 */
const SECRET_FRAGMENTS = [
  'apikey', 'api_key', 'authorization', 'credential', 'identitykey',
  'passphrase', 'password', 'privatekey', 'secret', 'token',
];

/** Split `apiKey`, `api_key`, `api-key` and `API KEY` into their words. */
function splitWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(part => part.toLowerCase())
    .filter(Boolean);
}

export function isSecretKey(key: string): boolean {
  const words = splitWords(key);
  if (words.some(word => SECRET_WORDS.has(word))) return true;

  const last = words[words.length - 1];
  if (last === 'key' || last === 'keys') {
    // A field named exactly `key` is a value, not a label for one.
    if (words.length === 1) return true;
    if (words.slice(0, -1).some(word => SECRET_KEY_QUALIFIERS.has(word))) return true;
  }

  const lowered = key.toLowerCase();
  return SECRET_FRAGMENTS.some(fragment => lowered.includes(fragment));
}
