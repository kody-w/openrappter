"""Pinning tests for the no-Copilot onboarding fix (fix/no-copilot-onboarding).

Covers the whole lifecycle a user without Copilot hits on day one, plus the
self-heal the moment their account gains access:

  * a no-Copilot exchange KEEPS the GitHub token (never strands the instance)
  * every surface (/health, /chat, /models, /login/retry) degrades to a clear,
    structured, JSON state — never a crash or a raw exchange body
  * flipping entitlement on self-heals with the SAME token, no restart, no re-login

These use the one seam that already exists — `_exchange_github_for_copilot`, which
returns a plain requests-style response — so no production code path is altered to
enable stubbing.
"""
import os
import sys
import time
import json
import tempfile
import unittest

# This test lives in rapp_brainstem/tests/ — brainstem.py is in the parent dir.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import brainstem  # noqa: E402


# The real 403 body GitHub returns for an account without a Copilot entitlement.
NO_COPILOT_BODY = {
    "message": "You don't have access to GitHub Copilot.",
    "error_details": {
        "url": "https://github.com/github-copilot/signup",
        "message": "You don't have access to GitHub Copilot. Sign up as octocat-nocopilot.",
        "title": "GitHub Copilot",
        "notification_id": "no_copilot_access",
    },
}
# A distinctive token that must NEVER surface to the user in any response body.
RAW_SECRET_MARKER = "raw-403-internal-detail-should-never-leak"
NO_COPILOT_BODY_WITH_SECRET = {
    "message": RAW_SECRET_MARKER,
    "error_details": dict(NO_COPILOT_BODY["error_details"]),
}


def entitled_body():
    return {
        "token": "cop_fake_token_abc",
        "endpoints": {"api": "https://api.fake.githubcopilot.com"},
        "expires_at": time.time() + 1800,
    }


class FakeResp:
    """Minimal stand-in for the requests.Response that _exchange returns."""

    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests
            raise requests.exceptions.HTTPError(str(self.status_code), response=self)


class _AuthTestBase(unittest.TestCase):
    """Redirects every auth dotfile into a throwaway dir and isolates globals so a
    test can never touch the developer's real ~/.brainstem token or session."""

    def setUp(self):
        self.brainstem = brainstem
        self.app = brainstem.app
        self.app.testing = True
        self.client = self.app.test_client()

        self.tmp = tempfile.mkdtemp(prefix="nocopilot-test-")

        # Save originals.
        self._orig = {
            "_token_file": brainstem._token_file,
            "_copilot_cache_file": brainstem._copilot_cache_file,
            "_pending_login_file": brainstem._pending_login_file,
            "_exchange": brainstem._exchange_github_for_copilot,
            "_cache": brainstem._copilot_token_cache.copy(),
            "_no_copilot": dict(brainstem._no_copilot_access),
            "_invalid_credential": dict(brainstem._invalid_github_credential),
            "_models_fetched": brainstem._models_fetched,
            "load_agents": brainstem.load_agents,
            "GITHUB_TOKEN": os.environ.get("GITHUB_TOKEN"),
        }

        # Redirect dotfiles + reset auth state.
        brainstem._token_file = os.path.join(self.tmp, ".copilot_token")
        brainstem._copilot_cache_file = os.path.join(self.tmp, ".copilot_session")
        brainstem._pending_login_file = os.path.join(self.tmp, ".copilot_pending")
        brainstem._copilot_token_cache = {"token": None, "endpoint": None, "expires_at": 0}
        brainstem._no_copilot_access = {"username": None, "at": 0}
        brainstem._invalid_github_credential = {"fingerprint": None, "status": None, "at": 0}
        brainstem.load_agents = lambda: {}
        os.environ.pop("GITHUB_TOKEN", None)

        # The exchange behaviour is driven by this flag; default: no Copilot.
        self.entitled = False

        def fake_exchange(github_token):
            if self.entitled:
                return FakeResp(200, entitled_body())
            return FakeResp(403, NO_COPILOT_BODY)

        brainstem._exchange_github_for_copilot = fake_exchange

    def tearDown(self):
        brainstem._token_file = self._orig["_token_file"]
        brainstem._copilot_cache_file = self._orig["_copilot_cache_file"]
        brainstem._pending_login_file = self._orig["_pending_login_file"]
        brainstem._exchange_github_for_copilot = self._orig["_exchange"]
        brainstem._copilot_token_cache = self._orig["_cache"]
        brainstem._no_copilot_access = self._orig["_no_copilot"]
        brainstem._invalid_github_credential = self._orig["_invalid_credential"]
        brainstem._models_fetched = self._orig["_models_fetched"]
        brainstem.load_agents = self._orig["load_agents"]
        if self._orig["GITHUB_TOKEN"] is not None:
            os.environ["GITHUB_TOKEN"] = self._orig["GITHUB_TOKEN"]
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_token(self, tok="ghu_valid_no_copilot_yet"):
        """Simulate a device-code login having saved a valid ghu_ token. No
        refresh_token, so refresh_github_token() is a no-op (makes no network call)."""
        with open(brainstem._token_file, "w", encoding="utf-8") as f:
            json.dump({"access_token": tok, "saved_at": time.time()}, f)


class TestNoCopilotExchange(_AuthTestBase):

    def test_no_copilot_keeps_token_and_flags(self):
        """The bug fix: a no-Copilot exchange must NOT delete the GitHub token, and
        it must record the no-Copilot flag with the username."""
        self._write_token()
        with self.assertRaises(RuntimeError) as ctx:
            self.brainstem.get_copilot_token()
        self.assertTrue(str(ctx.exception).startswith("NO_COPILOT_ACCESS:"))
        # The credential survives — this is what makes self-heal possible.
        self.assertTrue(os.path.exists(self.brainstem._token_file),
                        "token file was deleted — instance would be stranded")
        self.assertEqual(self.brainstem._no_copilot_access["username"], "octocat-nocopilot")

    def test_entitlement_flip_self_heals_same_token(self):
        """After access is granted, the NEXT exchange with the SAME token succeeds —
        no re-login, no restart, no file deletion."""
        self._write_token()
        with self.assertRaises(RuntimeError):
            self.brainstem.get_copilot_token()
        self.assertEqual(self.brainstem._no_copilot_access["username"], "octocat-nocopilot")

        # Entitlement arrives. Nothing else changes.
        self.entitled = True
        tok, endpoint = self.brainstem.get_copilot_token()
        self.assertEqual(tok, "cop_fake_token_abc")
        self.assertEqual(endpoint, "https://api.fake.githubcopilot.com")
        # The flag is cleared once entitlement is proven.
        self.assertIsNone(self.brainstem._no_copilot_access["username"])

    def test_success_after_failure_needs_no_manual_intervention(self):
        """Same as above but through the exact call the /chat handler makes, twice,
        with no invalidate/restart between — models two back-to-back messages."""
        self._write_token()
        # First message: no access.
        with self.assertRaises(RuntimeError):
            self.brainstem.get_copilot_token()
        # Access granted between messages.
        self.entitled = True
        # Second message: just works.
        tok, _ = self.brainstem.get_copilot_token()
        self.assertTrue(tok)


class TestCopilotCacheIdentity(_AuthTestBase):

    def _write_cache(self, github_token=None):
        cache = {
            "token": "cop_cached_account_a",
            "endpoint": "https://cached.example",
            "expires_at": time.time() + 1800,
        }
        if github_token:
            cache["github_token_fingerprint"] = (
                self.brainstem._github_token_fingerprint(github_token)
            )
        with open(self.brainstem._copilot_cache_file, "w", encoding="utf-8") as handle:
            json.dump(cache, handle)

    def test_matching_account_restores_persisted_session(self):
        github_token = "ghu_account_a"
        self._write_token(github_token)
        self._write_cache(github_token)

        token, endpoint = self.brainstem.get_copilot_token()

        self.assertEqual(token, "cop_cached_account_a")
        self.assertEqual(endpoint, "https://cached.example")

    def test_other_account_or_legacy_cache_is_exchanged_fresh(self):
        current_token = "ghu_account_b"
        for cached_token in ("ghu_account_a", None):
            with self.subTest(cached_token=cached_token):
                self.brainstem._copilot_token_cache = {
                    "token": None, "endpoint": None, "expires_at": 0,
                }
                self._write_token(current_token)
                self._write_cache(cached_token)
                self.entitled = True

                token, endpoint = self.brainstem.get_copilot_token()

                self.assertEqual(token, "cop_fake_token_abc")
                self.assertEqual(endpoint, "https://api.fake.githubcopilot.com")
                with open(self.brainstem._copilot_cache_file, encoding="utf-8") as handle:
                    cache = json.load(handle)
                self.assertEqual(
                    cache["github_token_fingerprint"],
                    self.brainstem._github_token_fingerprint(current_token),
                )


class TestHealthNoCopilot(_AuthTestBase):

    def test_rejected_credential_reports_sign_in_not_connected(self):
        self._write_token("ghu_expired")
        self.brainstem._exchange_github_for_copilot = lambda token: FakeResp(
            401, {"message": "Bad credentials"}
        )

        with self.assertRaisesRegex(RuntimeError, "Bad credentials"):
            self.brainstem.get_copilot_token()

        health = self.client.get("/health").get_json()
        self.assertEqual(health["status"], "unauthenticated")
        self.assertEqual(health["auth_error"], "invalid_credentials")

    def test_saving_new_credential_clears_rejected_health_state(self):
        self._write_token("ghu_expired")
        self.brainstem._set_invalid_github_credential("ghu_expired", 401)

        self.brainstem.save_github_token("ghu_replacement")

        health = self.client.get("/health").get_json()
        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["copilot"], "pending")

    def test_health_reports_no_copilot(self):
        """/health must surface the no-Copilot state (status stays ok — they ARE
        authenticated) so the UI can show a banner instead of a dead end."""
        self._write_token()
        self.brainstem._set_no_copilot("octocat-nocopilot")
        d = self.client.get("/health").get_json()
        self.assertEqual(d["status"], "ok")            # preflight contract preserved
        self.assertEqual(d["copilot"], "no_access")
        self.assertEqual(d["copilot_username"], "octocat-nocopilot")

    def test_health_status_still_ok_or_unauth(self):
        """The preflight /health contract: status is always one of these two."""
        self._write_token()
        self.brainstem._set_no_copilot("someone")
        self.assertIn(self.client.get("/health").get_json()["status"], ("ok", "unauthenticated"))

    def test_health_clears_banner_when_entitled(self):
        """A valid Copilot session wins over a stale flag: copilot shows the check."""
        self._write_token()
        self.brainstem._set_no_copilot("stale")
        self.brainstem._copilot_token_cache = {
            "token": "cop_live", "endpoint": "https://ep", "expires_at": time.time() + 1800,
        }
        d = self.client.get("/health").get_json()
        self.assertEqual(d["copilot"], "\u2713")
        self.assertIsNone(d.get("copilot_username"))


class TestChatNoCopilot(_AuthTestBase):

    def test_chat_returns_clean_structured_error(self):
        """/chat degrades to structured JSON — never a crash — and keeps the
        NO_COPILOT_ACCESS: prefix the web UI parses."""
        self._write_token()
        r = self.client.post("/chat", json={"user_input": "hello"})
        d = r.get_json()
        self.assertIsNotNone(d)
        self.assertTrue(d["error"].startswith("NO_COPILOT_ACCESS:"))
        self.assertTrue(d.get("no_copilot_access"))
        self.assertEqual(d.get("copilot_username"), "octocat-nocopilot")

    def test_chat_never_leaks_raw_exchange_body(self):
        """The raw 403 body must never reach the user."""
        self._write_token()

        def leaky_exchange(github_token):
            return FakeResp(403, NO_COPILOT_BODY_WITH_SECRET)

        self.brainstem._exchange_github_for_copilot = leaky_exchange
        r = self.client.post("/chat", json={"user_input": "hello"})
        self.assertNotIn(RAW_SECRET_MARKER, r.get_data(as_text=True))

    def test_chat_self_heals_after_entitlement(self):
        """No-Copilot /chat, then entitlement, then a canned model reply — the second
        /chat succeeds with zero manual intervention."""
        self._write_token()
        first = self.client.post("/chat", json={"user_input": "hi"}).get_json()
        self.assertTrue(first["error"].startswith("NO_COPILOT_ACCESS:"))

        self.entitled = True
        # Stub the actual model call so we exercise the auth gate, not the network.
        _orig_call = self.brainstem.call_copilot
        self.brainstem.call_copilot = lambda messages, tools=None: (
            {"choices": [{"message": {"role": "assistant", "content": "pong"},
                          "finish_reason": "stop"}]}, self.brainstem.MODEL)
        try:
            second = self.client.post("/chat", json={"user_input": "hi again"}).get_json()
        finally:
            self.brainstem.call_copilot = _orig_call
        self.assertEqual(second.get("response"), "pong")
        self.assertNotIn("error", second)

    def test_chat_stream_degrades_without_crashing(self):
        """The streaming endpoint (/chat/stream — the web UI's default send path)
        must ALSO survive a no-Copilot account. Streaming was validated against a
        working-Copilot rig and the onboarding fix was validated on POST /chat, so
        this seam is exactly what neither suite alone covers. Requirement: the stream
        opens cleanly (200), emits a well-formed SSE 'error' event — never a crash,
        never a bogus 'done' with an answer — so the web UI's stream->POST fallback
        renders the friendly banner instead of streaming a raw error into the chat."""
        self._write_token()
        r = self.client.post("/chat/stream", json={"user_input": "hello"})
        self.assertEqual(r.status_code, 200, "stream must open cleanly, not 500")
        events = []
        for line in r.get_data(as_text=True).splitlines():
            if line.startswith("data:"):
                try:
                    events.append(json.loads(line[5:].strip()))
                except ValueError:
                    pass
        types = [e.get("type") for e in events]
        self.assertIn("error", types, f"no-Copilot stream never reported an error; frames={types}")
        self.assertNotIn("done", types, "no-Copilot stream must not emit a completed answer")
        err = next(e for e in events if e.get("type") == "error")
        # Non-empty error carrying the prefix the client parses on the POST fallback.
        self.assertTrue(err.get("error"))
        self.assertTrue(err["error"].startswith("NO_COPILOT_ACCESS:"),
                        f"stream error should carry the parseable prefix, got: {err['error']!r}")


class TestLoginRetry(_AuthTestBase):

    def test_retry_unauthenticated_without_token(self):
        r = self.client.post("/login/retry").get_json()
        self.assertEqual(r["status"], "unauthenticated")

    def test_retry_reports_no_copilot(self):
        self._write_token()
        r = self.client.post("/login/retry").get_json()
        self.assertEqual(r["status"], "no_copilot_access")
        self.assertEqual(r["username"], "octocat-nocopilot")

    def test_retry_succeeds_after_entitlement(self):
        """The single action a user needs after enabling Copilot: Retry → ok, using
        the existing token (no re-login)."""
        self._write_token()
        self.assertEqual(self.client.post("/login/retry").get_json()["status"], "no_copilot_access")
        self.entitled = True
        r = self.client.post("/login/retry").get_json()
        self.assertEqual(r["status"], "ok")
        self.assertIsNone(self.brainstem._no_copilot_access["username"])


class TestAccountSwitch(_AuthTestBase):

    def test_switch_rejects_environment_pinned_account(self):
        self._write_token("saved-token")
        os.environ["GITHUB_TOKEN"] = "environment-token"
        original = self.brainstem.start_device_code_login
        called = {"start": False}

        def fake_start(*args, **kwargs):
            called["start"] = True
            return {}

        self.brainstem.start_device_code_login = fake_start
        try:
            r = self.client.post("/login/switch")
        finally:
            self.brainstem.start_device_code_login = original
        self.assertEqual(r.status_code, 409)
        self.assertTrue(os.path.exists(self.brainstem._token_file))
        self.assertFalse(called["start"])


class TestModelsNoCopilot(_AuthTestBase):

    def test_models_no_crash_without_copilot(self):
        """/models must still return a JSON model list (bootstrap) when the account
        has no Copilot — never a 500 or a raw error."""
        self._write_token()
        self.brainstem._models_fetched = False
        r = self.client.get("/models")
        self.assertEqual(r.status_code, 200)
        d = r.get_json()
        self.assertIsInstance(d.get("models"), list)
        self.assertGreater(len(d["models"]), 0)


if __name__ == "__main__":
    unittest.main()
