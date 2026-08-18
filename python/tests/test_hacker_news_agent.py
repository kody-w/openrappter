"""`count` must not be able to crash the agent before it does anything.

``perform`` computed::

    count = min(max(kwargs.get("count", 5), 1), 10)

on the line *above* its ``try``, so anything that is not already a number raised
``TypeError`` straight out of the agent rather than returning the structured
error every other failure here produces. Measured before the fix::

    count='5'   -> TypeError: '>' not supported between instances of 'int' and 'str'
    count=None  -> TypeError: '>' not supported between instances of 'int' and 'NoneType'
    count='abc' -> TypeError: '>' not supported between instances of 'int' and 'str'

``None`` is the one that matters. ``{"count": null}`` from a JSON-RPC client is
an ordinary way to say "unset", and because ``None`` is present rather than
absent, ``kwargs.get("count", 5)`` never applied its default.

These are the agent's first tests. **No case here touches the network.** Every
action this agent offers fetches from Hacker News, including ``status`` -- I
assumed otherwise on the first attempt and the suite made seven live requests
and took seventeen seconds. The fetch helpers are patched instead.
"""

from __future__ import annotations

import json
import pytest

from openrappter.agents.hacker_news_agent import HackerNewsAgent, _bounded_int


@pytest.fixture
def agent(monkeypatch) -> HackerNewsAgent:
    """An agent whose fetch helpers cannot reach Hacker News."""
    built = HackerNewsAgent()
    monkeypatch.setattr(built, "_fetch_top_story_ids", lambda count: list(range(count)))
    monkeypatch.setattr(
        built,
        "_fetch_story_details",
        lambda story_id: {
            "id": story_id,
            "title": f"story {story_id}",
            "url": f"https://example.invalid/{story_id}",
            "score": 1,
            "by": "nobody",
            "descendants": 0,
            "time": 0,
        },
    )
    return built


@pytest.mark.parametrize("value", ["5", "abc", None, "", [], {}, object()])
def test_unusable_counts_do_not_raise(agent, value):
    # Before the fix each of these raised TypeError out of perform.
    payload = json.loads(agent.perform(action="status", count=value))
    assert payload["status"] == "success"


def test_the_documented_default_is_used_when_count_is_unusable():
    assert _bounded_int(None, 5, 1, 10) == 5
    assert _bounded_int("7", 5, 1, 10) == 5
    assert _bounded_int("", 5, 1, 10) == 5


def test_a_real_number_is_honoured_and_clamped():
    # The behaviour that already worked, pinned so stricter checking did not
    # quietly replace it.
    assert _bounded_int(3, 5, 1, 10) == 3
    assert _bounded_int(0, 5, 1, 10) == 1
    assert _bounded_int(99, 5, 1, 10) == 10
    assert _bounded_int(3.7, 5, 1, 10) == 3


def test_booleans_are_not_counts():
    # True is an int in Python. A caller passing a flag here means something
    # other than "one story", so it takes the default rather than 1.
    assert _bounded_int(True, 5, 1, 10) == 5
    assert _bounded_int(False, 5, 1, 10) == 5


def test_nan_and_infinity_fall_back():
    assert _bounded_int(float("nan"), 5, 1, 10) == 5
    assert _bounded_int(float("inf"), 5, 1, 10) == 5
    assert _bounded_int(float("-inf"), 5, 1, 10) == 5


def test_no_test_here_reaches_the_network(agent, monkeypatch):
    # Anti-vacuity for the fixture itself: if the patches missed their target,
    # every case above would be measuring live Hacker News rather than this
    # agent, which is exactly what the first version of this file did.
    def explode(*args, **kwargs):  # pragma: no cover - only runs on failure
        raise AssertionError("a test opened a real connection")

    monkeypatch.setattr("urllib.request.urlopen", explode)
    payload = json.loads(agent.perform(action="status", count=3))
    assert payload["status"] == "success"
