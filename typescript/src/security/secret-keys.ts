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
  'apikey', 'auth', 'authorization', 'credential', 'credentials', 'cookie',
  'key', 'keys', 'passphrase', 'passwd', 'password', 'pat', 'secret',
  'secrets', 'signature', 'token', 'tokens',
]);

/** Fragments that are unambiguous even when glued to other text. */
const SECRET_FRAGMENTS = [
  'apikey', 'api_key', 'authorization', 'credential', 'passphrase',
  'password', 'secret', 'token',
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
  if (splitWords(key).some(word => SECRET_WORDS.has(word))) return true;
  const lowered = key.toLowerCase();
  return SECRET_FRAGMENTS.some(fragment => lowered.includes(fragment));
}
