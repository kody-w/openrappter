"""Google Voice watch decisions, on the grail bones.

This is the Python half of `typescript/src/telephony/watch.ts`. The two are
deliberately transliterations of each other and are held together by a shared
fixture, `tests/google-voice-parity.json`, which both sides assert against.

WHY THE DECISIONS ARE SHARED BUT THE TRANSPORT IS NOT
-----------------------------------------------------
openrappter can drive Chrome over the DevTools Protocol, so on a laptop the
Google Voice rung really can send and receive. A grail brainstem running under
Pyodide or Azure Functions has no browser, no subprocess, and no socket to give
it one — so on those tiers the rung simply is not available, and this agent says
so rather than pretending.

What must NOT differ is the judgement. If the same inbox produces a reply on one
platform and silence on the other, then "the twin runs on both bones" is not
true, and which machine happened to wake up first becomes a behavioural fact.
So every rule below is byte-identical in intent to the TypeScript, and the
parity fixture fails loudly if the two ever drift.

ARTICLE VII
-----------
Nothing here imports anything outside the standard library, touches the network,
reads a clock, or shells out. `now` is always a parameter. That is what makes
the file portable to every tier, and it is enforced by an AST test rather than
by good intentions.

THE FAILURE THIS EXISTS TO PREVENT
----------------------------------
An always-on agent that can send texts fails dangerously in one direction only:
replying to things it should not, at machine speed, to real people. First run
against years of history. Answering its own outbound. Two bots ping-ponging.
Re-answering the same message every poll because state was lost. Every rule is
one of those, and the default answer is NO.
"""

import json

from agents.basic_agent import BasicAgent

DEFAULT_POLICY = {
    # Four replies an hour to one number is plenty for a negotiation and nowhere
    # near enough to be a nuisance if something goes wrong.
    "maxRepliesPerThread": 4,
    "windowMs": 60 * 60 * 1000,
    # A message older than a day is history, not a live conversation.
    "maxAgeMs": 24 * 60 * 60 * 1000,
}


def empty_state():
    """The state a watcher starts from."""
    return {"knownThreads": {}, "handled": [], "replies": {}}


def _digits(value):
    out = "".join(ch for ch in (value or "") if ch.isdigit())
    if len(out) == 11 and out.startswith("1"):
        out = out[1:]
    return out


def _same_number(a, b):
    da, db = _digits(a), _digits(b)
    return bool(da) and da == db


def decide(message, state, policy, now):
    """Whether the watcher may act on one message.

    `now` is a parameter, never a clock read, so the same inputs always produce
    the same verdict — which is what allows the two implementations to be
    compared against a fixture at all.
    """
    # We do not talk to ourselves. An outbound bubble is our own voice, and
    # treating it as input is how a loop starts.
    if message.get("direction") == "outbound":
        return {"act": False, "reason": "outbound", "detail": "our own message"}
    if _same_number(message.get("from"), policy.get("selfNumber")):
        return {"act": False, "reason": "self", "detail": "from our own number"}

    if message.get("id") in state.get("handled", []):
        return {
            "act": False,
            "reason": "already-handled",
            "detail": "already acted on this message",
        }

    # FIRST SIGHT OF A THREAD IS NEVER ACTIONABLE.
    # On first run the inbox is full of history. Answering it would mean texting
    # everyone who has ever messaged this number. The first poll only records a
    # watermark; a thread becomes live from the next message onward.
    known = state.get("knownThreads", {}).get(message.get("threadId"))
    if not known:
        return {
            "act": False,
            "reason": "thread-unseen",
            "detail": "first sight of this thread — recording a watermark instead of replying",
        }
    if message.get("at", 0) <= known.get("watermark", 0):
        return {
            "act": False,
            "reason": "older-than-watermark",
            "detail": "predates the watermark",
        }

    if now - message.get("at", 0) > policy.get("maxAgeMs", DEFAULT_POLICY["maxAgeMs"]):
        return {"act": False, "reason": "too-old", "detail": "older than the freshness window"}

    allow = policy.get("allowFrom")
    if allow:
        if not any(_same_number(n, message.get("from")) for n in allow):
            return {
                "act": False,
                "reason": "not-allowed",
                "detail": "sender is not on the allow list",
            }

    # The loop guard. If something upstream goes wrong — a bot on the other end,
    # a bad prompt, a bug — this stops it at four instead of four hundred.
    window = policy.get("windowMs", DEFAULT_POLICY["windowMs"])
    cap = policy.get("maxRepliesPerThread", DEFAULT_POLICY["maxRepliesPerThread"])
    recent = [t for t in state.get("replies", {}).get(message.get("threadId"), []) if now - t < window]
    if len(recent) >= cap:
        return {
            "act": False,
            "reason": "rate-limited",
            "detail": "already replied %d times to this thread in the window" % len(recent),
        }

    return {"act": True, "reason": "new-inbound", "detail": "new inbound message"}


def observe(state, thread_id, at):
    """Record that a thread was observed. Safe to call every poll."""
    threads = dict(state.get("knownThreads", {}))
    known = threads.get(thread_id)
    threads[thread_id] = {"watermark": max(known.get("watermark", 0), at) if known else at}
    out = dict(state)
    out["knownThreads"] = threads
    return out


def record_reply(state, message, at):
    """Record that we acted on a message and replied to its thread."""
    replies = dict(state.get("replies", {}))
    replies[message.get("threadId")] = list(replies.get(message.get("threadId"), [])) + [at]
    # Keep `handled` bounded so a long-lived daemon's state cannot grow without
    # limit; the watermark already covers anything older.
    handled = (list(state.get("handled", [])) + [message.get("id")])[-500:]
    threads = dict(state.get("knownThreads", {}))
    prev = threads.get(message.get("threadId"), {}).get("watermark", 0)
    threads[message.get("threadId")] = {"watermark": max(prev, message.get("at", 0))}
    out = dict(state)
    out["handled"] = handled
    out["replies"] = replies
    out["knownThreads"] = threads
    return out


class GoogleVoiceAgent(BasicAgent):
    """Decide what an always-on watcher may do about Google Voice messages."""

    def __init__(self):
        super().__init__(
            name="GoogleVoice",
            metadata={
                "name": "GoogleVoice",
                "description": (
                    "Decides whether an always-on watcher may reply to a Google Voice "
                    "message. Shares its judgement byte-for-byte with openrappter so the "
                    "same inbox behaves the same on either set of bones. Decisions only — "
                    "sending requires a browser this tier may not have."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "description": "decide | observe | record | policy",
                        },
                        "message": {"type": "object", "description": "The inbox message."},
                        "state": {"type": "object", "description": "Watcher state."},
                        "policy": {"type": "object", "description": "Overrides for DEFAULT_POLICY."},
                        "now": {"type": "number", "description": "Epoch ms. Never read from a clock."},
                    },
                    "required": ["action"],
                },
            },
        )

    def perform(self, **kwargs):
        action = kwargs.get("action", "decide")
        state = kwargs.get("state") or empty_state()
        policy = dict(DEFAULT_POLICY)
        policy.update(kwargs.get("policy") or {})
        message = kwargs.get("message") or {}
        now = kwargs.get("now")

        if action == "policy":
            return json.dumps({"status": "ok", "policy": policy}, indent=2)

        if action == "observe":
            return json.dumps(
                {"status": "ok", "state": observe(state, message.get("threadId"), message.get("at", 0))},
                indent=2,
            )

        if action == "record":
            return json.dumps(
                {"status": "ok", "state": record_reply(state, message, now or message.get("at", 0))},
                indent=2,
            )

        if now is None:
            # Refusing is the honest move: this tier may have no trustworthy
            # clock, and silently substituting one would make the verdict
            # unreproducible and break parity with the other bones.
            return json.dumps(
                {
                    "status": "error",
                    "error": "`now` (epoch ms) is required — this agent never reads a clock.",
                },
                indent=2,
            )

        return json.dumps({"status": "ok", "verdict": decide(message, state, policy, now)}, indent=2)
