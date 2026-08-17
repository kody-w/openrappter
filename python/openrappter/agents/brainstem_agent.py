"""
BrainstemAgent — ask the local brainstem from inside an OpenRappter chat turn.

The brainstem is a separate process speaking `POST /chat`, and the two runtimes
return the same frozen envelope (rapp-runtime-parity/1.0 §2.4). PR #226 gave a
person a dropdown to choose between them. This agent gives the *assistant* the
same reach: a user can say "ask the brainstem what it knows about X" and stay in
one conversation, instead of switching brains by hand and relaying the answer
themselves.

That matters most where the two brains genuinely differ. The brainstem holds
agents and memory this runtime does not, so consulting it is a real lookup
rather than a second opinion from the same source.

Single-file and portable, per the RAPP agent contract: `json` and
`urllib.request` from the standard library, `BasicAgent` guarded so the file
loads on its own, and exactly one declared capability — `network` — which is
the only thing its syntax tree can reach. Reading the address from the
environment would have added `credential-access` to that declaration, and an
agent that claims credential access to look up a port number is the kind of
over-declaration that teaches an operator to ignore the manifest.
"""

import json
import urllib.error
import urllib.request

try:  # grail brainstem
    from agents.basic_agent import BasicAgent
except ImportError:  # openrappter's python package
    from openrappter.agents.basic_agent import BasicAgent


__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@openrappter/brainstem",
    "version": "1.0.0",
    "display_name": "Brainstem",
    "description": "Asks the local brainstem a question and returns its reply, so a chat turn can consult the other brain without the operator switching.",
    "author": "Kody Wildfeuer",
    "ring": "ga",
    "capabilities": [
        "network"
    ],
    "tags": [
        "openrappter",
        "brainstem"
    ],
    "category": "research",
    "quality_tier": "official",
    "requires_env": []
}

# Where a brainstem is actually found, in preference order. 7072 is this
# package's own default; 7071 is the slot a RAPP brainstem sits in, and an
# installation that followed the grail path has one there and nothing on 7072.
# The TypeScript client probes the same two, for the same reason.
CANDIDATE_URLS = ("http://127.0.0.1:7072", "http://127.0.0.1:7071")

# §2.4: the six keys every runtime must return.
ENVELOPE_KEYS = ("response", "session_id", "agent_logs",
                 "voice_mode", "model", "requested_model")

HEALTH_TIMEOUT_SECONDS = 2
CHAT_TIMEOUT_SECONDS = 120


class BrainstemAgent(BasicAgent):
    def __init__(self):
        self.name = "Brainstem"
        self.metadata = {
            "name": self.name,
            "description": (
                "Ask the local brainstem a question and return its answer. Use "
                "this when the user asks what the brainstem knows or thinks, or "
                "when a question needs the agents and memory that live there "
                "rather than in this runtime."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "The question to put to the brainstem.",
                    },
                    "session_id": {
                        "type": "string",
                        "description": (
                            "Optional conversation id, so follow-up questions "
                            "continue the same brainstem session."
                        ),
                    },
                    "base_url": {
                        "type": "string",
                        "description": (
                            "Optional brainstem address, e.g. "
                            "http://127.0.0.1:7071. Discovered automatically "
                            "when omitted."
                        ),
                    },
                },
                "required": ["message"],
            },
        }
        super().__init__(self.name, self.metadata)

    def _post_json(self, url, payload, timeout):
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read().decode("utf-8")

    def _answers(self, base_url):
        """Whether a brainstem is listening here."""
        try:
            request = urllib.request.Request(base_url + "/health", method="GET")
            with urllib.request.urlopen(request, timeout=HEALTH_TIMEOUT_SECONDS) as response:
                return 200 <= response.status < 300
        except Exception:
            return False

    def _discover(self):
        for candidate in CANDIDATE_URLS:
            if self._answers(candidate):
                return candidate
        return None

    def perform(self, **kwargs):
        message = (kwargs.get("message") or "").strip()
        if not message:
            return "No question given. Pass `message` with what to ask the brainstem."

        base_url = (kwargs.get("base_url") or "").strip().rstrip("/")
        if not base_url:
            base_url = self._discover()
            if not base_url:
                return (
                    "No brainstem is answering on "
                    + " or ".join(CANDIDATE_URLS)
                    + ". Start one with `python -m openrappter.brainstem`, or pass "
                    "`base_url` if it listens elsewhere."
                )

        payload = {
            # Both spellings. This package documents `message` with `user_input`
            # as a legacy alias, but the RAPP kernel it mirrors requires
            # `user_input` and answers 400 without it.
            "message": message,
            "user_input": message,
        }
        session_id = (kwargs.get("session_id") or "").strip()
        if session_id:
            payload["session_id"] = session_id

        try:
            raw = self._post_json(base_url + "/chat", payload, CHAT_TIMEOUT_SECONDS)
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8")[:300]
            except Exception:
                detail = ""
            return "The brainstem at %s answered %s%s" % (
                base_url, exc.code, (": " + detail) if detail else ".")
        except Exception as exc:
            return "Could not reach the brainstem at %s: %s" % (base_url, exc)

        try:
            envelope = json.loads(raw)
        except ValueError:
            return "The brainstem at %s returned a body that is not JSON." % base_url

        # Something answering on that port is not the same as the brainstem
        # answering. Passing another service's words back as the brainstem's
        # would be worse than failing.
        if not isinstance(envelope, dict) or "response" not in envelope:
            return (
                "The brainstem at %s returned JSON that is not a chat envelope "
                "(expected %s)." % (base_url, ", ".join(ENVELOPE_KEYS))
            )

        answer = envelope.get("response") or ""
        model = envelope.get("model") or "unreported"
        returned_session = envelope.get("session_id") or ""

        lines = ["Brainstem (%s, model %s):" % (base_url, model), "", answer]
        if returned_session:
            lines.append("")
            lines.append("session_id: %s" % returned_session)
        return "\n".join(lines)
