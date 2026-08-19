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
    "apikey", "auth", "authorization", "bearer", "credential", "credentials",
    "cookie", "cookies", "jwt", "passphrase", "passwd", "password", "pat",
    "pem", "secret", "secrets", "signature", "token", "tokens",
})

#: Words that make a trailing ``key`` secret.
#:
#: ``key`` on its own is too blunt in both directions. As a whole word it
#: blanked ``keyCount``, ``keyId`` and ``publicKey``; dropping it would let
#: ``apiKey`` and ``privateKey`` through. So it counts when it is what the field
#: *is* — the last word, qualified by something that makes it sensitive.
_SECRET_KEY_QUALIFIERS = frozenset({
    "access", "api", "app", "auth", "client", "encryption", "identity",
    "master", "private", "secret", "session", "signing", "ssh", "token",
})

#: Fragments unambiguous even when glued to other text.
#:
#: ``privatekey`` and ``identitykey`` are here because the word rules cannot
#: reach them: run together with no separator there is nothing to split on, and
#: ``identity`` is not a qualifier that makes a trailing ``key`` secret. Both
#: were caught only by the flight recorder's private copy of this logic, so
#: retiring that copy would have quietly stopped redacting them.
_SECRET_FRAGMENTS = (
    "apikey", "api_key", "authorization", "credential", "identitykey",
    "passphrase", "password", "privatekey", "secret", "token",
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
    words = _split_words(key)
    if any(word in _SECRET_WORDS for word in words):
        return True

    if words and words[-1] in ("key", "keys"):
        # A field named exactly ``key`` is a value, not a label for one.
        if len(words) == 1:
            return True
        if any(word in _SECRET_KEY_QUALIFIERS for word in words[:-1]):
            return True

    lowered = key.lower()
    return any(fragment in lowered for fragment in _SECRET_FRAGMENTS)
