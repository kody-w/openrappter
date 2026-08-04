"""One answer to "is this field name a secret?".

The TypeScript runtime had two, and each missed what the other caught, so
`apiKey`, `privateKey`, `signingKey` and `sessionKey` were written into the
structured log in the clear. That was fixed in openrappter#76.

This body had the same logging pattern, character for character:

    token|password|secret|credential|authorization

so it leaked the same five names. Fixing one runtime and leaving the other is
how the two stop meaning the same thing.

Matching is on word boundaries rather than substrings, so `apiKey` and
`private_key` are caught while `monkey` and `keyword` are not — blanking a
field named `keyCount` would cost the debuggability the log exists for.

Kept deliberately in step with typescript/src/security/secret-keys.ts; a test
asserts the two agree on a shared table of names.
"""

from __future__ import annotations

import re

#: Whole words that make a field a secret.
_SECRET_WORDS = frozenset({
    "apikey", "auth", "authorization", "credential", "credentials", "cookie",
    "key", "keys", "passphrase", "passwd", "password", "pat", "secret",
    "secrets", "signature", "token", "tokens",
})

#: Fragments unambiguous even when glued to other text.
_SECRET_FRAGMENTS = (
    "apikey", "api_key", "authorization", "credential", "passphrase",
    "password", "secret", "token",
)

_CAMEL_BOUNDARY = re.compile(r"([a-z0-9])([A-Z])")
_ACRONYM_BOUNDARY = re.compile(r"([A-Z]+)([A-Z][a-z])")
_NON_ALNUM = re.compile(r"[^A-Za-z0-9]+")


def _split_words(key: str) -> list:
    """Split apiKey, api_key, api-key and API KEY into their words."""
    spaced = _CAMEL_BOUNDARY.sub(r"\1 \2", key)
    spaced = _ACRONYM_BOUNDARY.sub(r"\1 \2", spaced)
    return [part.lower() for part in _NON_ALNUM.split(spaced) if part]


def is_secret_key(key: str) -> bool:
    """True when a field of this name must never be logged verbatim."""
    if any(word in _SECRET_WORDS for word in _split_words(key)):
        return True
    lowered = key.lower()
    return any(fragment in lowered for fragment in _SECRET_FRAGMENTS)
