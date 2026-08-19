"""The Python gateway logger leaked the same keys the TypeScript one did.

Both bodies used the same pattern, character for character:

    token|password|secret|credential|authorization

It has no `key`, so both wrote these into the structured log verbatim:

    apiKey  privateKey  signingKey  openaiApiKey  sessionKey

openrappter#76 fixed the TypeScript side. This is the same fix here, plus a
test that the two answers stay in agreement — the drift is the bug, so a table
that only one runtime is checked against would recreate it.
"""

import json
from pathlib import Path

import pytest

from openrappter.security.secret_keys import is_secret_key

# Names that leaked from the old pattern, names it already caught, and spelling
# variants. Shared with the TypeScript suite; see the agreement test below.
SECRET_NAMES = [
    "apiKey", "privateKey", "signingKey", "openaiApiKey", "sessionKey",
    "githubToken", "password", "clientSecret", "webhookSecret",
    "credential", "credentials", "authorization",
    "api_key", "api-key", "ACCESS_TOKEN", "refresh_token", "passphrase",
    "authToken", "Cookie", "signature",
    # Missed until an outside review checked.
    "jwt", "bearerToken", "privatePem",
    # Plurals. `tokens`, `secrets` and `credentials` were already caught, but
    # only because those three are also substring fragments — the plural of a
    # word that was *only* a word went into the log in the clear.
    "cookies", "sessionCookies", "setCookies",
    "signatures", "requestSignatures", "jwts",
    # A trailing `key` with a qualifier that makes it sensitive.
    "accessKey", "encryptionKey", "masterKey", "sshKey", "key", "keys",
]

BENIGN_NAMES = [
    "monkey", "keyword", "keyboard", "author",
    "name", "port", "host", "model", "sessionId", "requestId",
    "durationMs", "outcome",
    # Blanked by the previous rule, which counted `key` anywhere in the name.
    "keyCount", "keyId", "publicKey", "keyspace",
    # Ordinary plurals. Matching `cookies` must not start matching these: the
    # plural rule strips one trailing `s`, so anything whose stem is not itself
    # a secret word has to stay readable.
    "status", "address", "process", "class", "headers", "params", "results",
    "sessions", "scopes", "permissions", "authors",
]


class TestIsSecretKey:
    @pytest.mark.parametrize("key", SECRET_NAMES)
    def test_secret_names_are_redacted(self, key):
        assert is_secret_key(key) is True

    @pytest.mark.parametrize("key", BENIGN_NAMES)
    def test_benign_names_stay_readable(self, key):
        # Blanking these would cost the debuggability the log exists for.
        assert is_secret_key(key) is False


class TestGatewayLogRedaction:
    def test_the_logger_redacts_key_shaped_names(self, monkeypatch, capsys):
        """Front door. Testing is_secret_key proves the answer is right, not
        that the logger asks it."""
        from openrappter.gateway import observability

        monkeypatch.setenv("OPENRAPPTER_LOG_FORMAT", "json")
        observability.log_gateway_lifecycle(
            "gateway", "start", "msg",
            {
                "apiKey": "ak-leaked",
                "privateKey": "pk-leaked",
                "sessionKey": "sess-leaked",
                "durationMs": 12,
            },
        )

        line = capsys.readouterr().out.strip().splitlines()[-1]
        payload = json.loads(line)

        assert payload["apiKey"] == "[REDACTED]"
        assert payload["privateKey"] == "[REDACTED]"
        assert payload["sessionKey"] == "[REDACTED]"
        for secret in ("ak-leaked", "pk-leaked", "sess-leaked"):
            assert secret not in line
        # An ordinary field is still readable, or the log is worthless.
        assert payload["durationMs"] == 12


class TestRuntimeAgreement:
    @staticmethod
    def _typescript_source() -> str:
        ts_path = (
            Path(__file__).resolve().parents[2]
            / "typescript" / "src" / "security" / "secret-keys.ts"
        )
        return ts_path.read_text(encoding="utf-8")

    def test_the_typescript_answer_lists_the_same_words(self):
        """The bug was two runtimes disagreeing, so pin them to each other.

        Compares the word and fragment tables rather than running node: a
        divergence shows up here as a changed list, which is the thing that
        actually went wrong.
        """
        ts_path = (
            Path(__file__).resolve().parents[2]
            / "typescript" / "src" / "security" / "secret-keys.ts"
        )
        source = ts_path.read_text(encoding="utf-8")

        from openrappter.security.secret_keys import (
            _SECRET_FRAGMENTS,
            _SECRET_KEY_QUALIFIERS,
            _SECRET_WORDS,
        )

        for word in _SECRET_KEY_QUALIFIERS:
            assert f"'{word}'" in source, f"TypeScript is missing the qualifier {word!r}"
        for word in _SECRET_WORDS:
            assert f"'{word}'" in source, f"TypeScript is missing the word {word!r}"
        for fragment in _SECRET_FRAGMENTS:
            assert f"'{fragment}'" in source, f"TypeScript is missing the fragment {fragment!r}"

    def test_the_typescript_answer_applies_the_same_plural_rule(self):
        """Agreeing on the words is not the same as agreeing on the answer.

        `cookies` leaked because of a missing rule, not a missing word: every
        table above was already correct while the plural went into the log in
        the clear. A comparison of tables stays green through that bug, and
        stays green if one runtime is fixed and the other is not — which is the
        drift this class exists to catch.
        """
        source = self._typescript_source()

        assert "function isSecretWord" in source, (
            "TypeScript is missing the plural rule, so `cookies`, `signatures` "
            "and `jwts` leak there while Python redacts them."
        )
        assert "word.slice(0, -1)" in source, (
            "TypeScript's plural rule no longer strips one trailing 's'."
        )
