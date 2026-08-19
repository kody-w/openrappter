"""The device-code login is one state machine shared by three routes.

`POST /login`, `POST /login/poll` and `GET /login/status` all read and write the
same two module globals, and `ThreadingHTTPServer` gives every request its own
thread. Both mutators check `_pending_login` and then act on it, which is only
safe if nothing can interleave between the check and the write.

Nothing covered any of this before these tests: no test in the suite referenced
`start_device_login` or `poll_device_login` at all.
"""

import threading
import time

import pytest

from openrappter import brainstem


@pytest.fixture
def clean_login(monkeypatch):
    """Isolate the login globals, and make sure no test can write a real token."""
    monkeypatch.setattr(brainstem, "_pending_login", None, raising=False)
    monkeypatch.setattr(brainstem, "_login_result", {}, raising=False)
    monkeypatch.setattr(brainstem, "_save_token_file", lambda *_a, **_k: None)


def _grant_source(delay=0.15):
    """A stand-in for GitHub that issues a distinct grant per call.

    The delay stands for the network round-trip in `_http_form`, which is the
    window the two callers used to interleave in.
    """
    issued = []
    guard = threading.Lock()

    def fake_http_form(_url, _data, timeout=15):
        with guard:
            n = len(issued)
            issued.append(n)
        time.sleep(delay)
        return {
            "device_code": f"DEV{n}",
            "user_code": f"USER{n}",
            "verification_uri": "https://github.com/login/device",
            "interval": 5,
            "expires_in": 900,
        }

    return fake_http_form, issued


def _start_concurrently(count=2):
    shown = {}
    ready = threading.Barrier(count)

    def caller(tag):
        ready.wait()
        shown[tag] = brainstem.start_device_login()["user_code"]

    threads = [threading.Thread(target=caller, args=(i,)) for i in range(count)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return shown


class TestConcurrentLoginStart:
    def test_every_caller_is_shown_the_same_code(self, clean_login, monkeypatch):
        """Two `POST /login` calls must not each start their own grant.

        They did. Each thread found no pending login, each asked GitHub for a
        device code, and the second overwrote the first.
        """
        fake, _ = _grant_source()
        monkeypatch.setattr(brainstem, "_http_form", fake)

        shown = _start_concurrently()

        assert len(set(shown.values())) == 1, f"callers disagreed: {shown}"

    def test_the_code_shown_is_the_one_being_polled_for(self, clean_login, monkeypatch):
        """The invariant the user actually experiences.

        This is why the race mattered. The losing caller was shown `USER0` while
        `_pending_login` held `DEV1`, so `/login/poll` asked GitHub about a grant
        that user never touched. They authorise correctly, GitHub is happy, and
        the brainstem waits forever -- reporting `pending`, with no error
        anywhere to suggest the code on screen was already dead.
        """
        fake, _ = _grant_source()
        monkeypatch.setattr(brainstem, "_http_form", fake)

        shown = _start_concurrently()
        polled_for = brainstem._pending_login

        stranded = [c for c in shown.values() if c != polled_for["user_code"]]
        assert not stranded, (
            f"shown a code that can never succeed: {stranded}; "
            f"poll will authorise {polled_for['device_code']}"
        )

    def test_only_one_grant_is_requested(self, clean_login, monkeypatch):
        """The stronger property: the second caller reuses, it does not re-ask.

        Asserting the codes agree would also pass if both callers somehow
        converged on the same answer after two round-trips. They should not be
        making two.
        """
        fake, issued = _grant_source()
        monkeypatch.setattr(brainstem, "_http_form", fake)

        _start_concurrently()

        assert len(issued) == 1, f"{len(issued)} device-code grants started"


class TestTheStateMachineStillMoves:
    """A lock that serialises this correctly could also freeze it. It must not."""

    def test_a_single_login_still_returns_a_code(self, clean_login, monkeypatch):
        fake, _ = _grant_source(delay=0)
        monkeypatch.setattr(brainstem, "_http_form", fake)

        assert brainstem.start_device_login()["user_code"] == "USER0"

    def test_a_second_call_reuses_the_live_grant(self, clean_login, monkeypatch):
        fake, issued = _grant_source(delay=0)
        monkeypatch.setattr(brainstem, "_http_form", fake)

        first = brainstem.start_device_login()["user_code"]
        second = brainstem.start_device_login()["user_code"]

        assert first == second == "USER0"
        assert len(issued) == 1

    def test_an_expired_grant_is_replaced_rather_than_reused(self, clean_login, monkeypatch):
        """Dedup must not outlive the code it is deduplicating."""
        fake, _ = _grant_source(delay=0)
        monkeypatch.setattr(brainstem, "_http_form", fake)

        brainstem.start_device_login()
        brainstem._pending_login["expires_at"] = time.time() - 1

        assert brainstem.start_device_login()["user_code"] == "USER1"

    def test_polling_with_nothing_pending_is_idle(self, clean_login):
        assert brainstem.poll_device_login() == {"status": "idle"}
