"""
PhoneAgent — place calls from a RAPP brainstem, with the same guardrails.

This is the grail-contract twin of openrappter's TypeScript PhoneAgent. It
exists so a brainstem is not a second-class citizen: the same capability, the
same limits, and the same second-brain log, reachable from Tier 1, Tier 2,
Tier 3 and a Pyodide sphere.

The decision core is deliberately duplicated rather than shared, because there
is no runtime both a Python brainstem and a Node process can import from. What
keeps them honest is `tests/decision_parity.json` — a table of cases both
implementations are checked against, so a change to one that is not mirrored in
the other fails the build.

What the model gets to decide:  that a call is warranted, and what the goal is.
What it never gets to decide:   what may be agreed to once connected.

    breaks a hard limit                      -> counter, then decline
    meets the limits and matches the request -> accept
    meets the limits but differs             -> stop and ask the owner

Everything is written to the same hash-chained log as rapp-secondbrain, through
the storage shim, so a call placed here is visible to `rsb`, to the sphere, and
to openrappter.

Actions: call, approvals, approve, deny, transcript, brief, hotline_check
"""

import datetime
import hashlib
import json
import re
import uuid

try:  # grail brainstem
    from agents.basic_agent import BasicAgent
except ImportError:  # openrappter's python package
    from openrappter.agents.basic_agent import BasicAgent


__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@openrappter/phone",
    "version": "1.0.0",
    "display_name": "Phone",
    "description": (
        "Place a call on the owner's behalf with a goal and hard limits, negotiate, and stop "
        "for approval rather than committing to anything outside them."
    ),
    "author": "Kody Wildfeuer",
    "ring": "ga",
    "capabilities": ["network-access", "credential-access"],
    "tags": ["openrappter", "phone", "telephony", "second-brain"],
    "category": "communication",
    "quality_tier": "official",
    "requires_env": [],
}

SPEC = "rapp-second-brain/1.0"
LOG_PATH = "second_brain/events.jsonl"
GENESIS = "sha256:" + "0" * 64

DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

WORD_NUMBERS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
    "thirty": 30, "forty": 40, "fifty": 50,
}

HOUR_WORD = r"(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
MINUTE_WORD = (
    r"(?:(?:twenty|thirty|forty|fifty)(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?|"
    r"ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|"
    r"oh[\s-](?:one|two|three|four|five|six|seven|eight|nine)|o'?clock)"
)
SPOKEN_TIME = re.compile(r"\b(%s)\b(?:[\s-]+(%s))?" % (HOUR_WORD, MINUTE_WORD), re.IGNORECASE)
TIME_LEAD_IN = re.compile(
    r"(?:\bat|\baround|\babout|\bby|\buntil|\btill|\bfrom|\bafter|\bbefore|\bdo|\bmake it|"
    r"\bsay|\btry|\bhow about|\bwhat about|\bcome in at)[\s,]+$",
    re.IGNORECASE,
)
HAS_PM = re.compile(r"\b(?:pm|p\.m\.)\b|\bevening\b|\btonight\b", re.IGNORECASE)
HAS_AM = re.compile(r"\b(?:am|a\.m\.)\b|\bmorning\b", re.IGNORECASE)
REFUSAL = re.compile(
    r"\b(?:no|not|none|nothing|fully booked|all booked|can't|cannot|unable|afraid not|sold out)\b",
    re.IGNORECASE,
)
SOFTENER = re.compile(r"\b(?:but|however|could do|can do|how about|what about)\b", re.IGNORECASE)
AGREEMENT = re.compile(
    r"\b(?:yes|yep|yeah|sure|of course|that works|that's fine|perfect|booked|done|confirmed|"
    r"see you then|no problem|all set)\b",
    re.IGNORECASE,
)


# ── primitives ────────────────────────────────────────────────────────────


def _now():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha(text):
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _new_id(prefix):
    return "%s_%s" % (prefix, uuid.uuid4().hex[:12])


def time_to_minutes(text):
    """Minutes since midnight for '19:45', '7:45 pm', '7pm'."""
    match = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$", str(text).strip().lower())
    if not match:
        raise ValueError("not a time: %s" % text)

    hours = int(match.group(1))
    minutes = int(match.group(2) or 0)
    meridiem = match.group(3)

    if meridiem == "pm" and hours < 12:
        hours += 12
    elif meridiem == "am" and hours == 12:
        hours = 0
    if hours > 23 or minutes > 59:
        raise ValueError("time out of range: %s" % text)
    return hours * 60 + minutes


def parse_local_iso(iso):
    """Split an ISO local datetime without letting a timezone shift the day."""
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})", str(iso).strip())
    if not match:
        raise ValueError("not an ISO datetime: %s" % iso)
    year, month, day, hour, minute = (int(g) for g in match.groups())
    weekday = (datetime.date(year, month, day).weekday() + 1) % 7  # Sunday = 0
    return {
        "date": "%04d-%02d-%02d" % (year, month, day),
        "minutes": hour * 60 + minute,
        "weekday": weekday,
    }


def _safe_time(text):
    try:
        time_to_minutes(text)
        return text
    except ValueError:
        return None


def parse_constraint(text):
    """One machine-checkable rule, or None. Never a guess."""
    raw = str(text).strip()
    lower = raw.lower()

    party = re.search(r"party\s*(?:size|of)?\s*(?:is\s*)?(?:exactly\s*)?(\d+)", lower)
    if party:
        return {"kind": "party_size", "exactly": int(party.group(1)), "label": raw}

    price = re.search(r"(?:budget|under|max(?:imum)?|no more than)\s*(?:of\s*)?\$?\s*([\d,]+(?:\.\d{1,2})?)", lower)
    if price:
        return {"kind": "max_price", "cents": int(round(float(price.group(1).replace(",", "")) * 100)), "label": raw}

    # Lower bounds first: "before" also appears inside "not before".
    lower_bound = re.search(r"\b(?:no earlier than|not before|not until|after|starting at|from)\s+([\d:]+\s*(?:am|pm)?)", lower)
    if lower_bound:
        found = _safe_time(lower_bound.group(1).strip())
        if found:
            return {"kind": "not_before", "time": found, "label": raw}

    upper_bound = re.search(r"\b(?:no later than|not after|before|by|earlier than)\s+([\d:]+\s*(?:am|pm)?)", lower)
    if upper_bound:
        found = _safe_time(upper_bound.group(1).strip())
        if found:
            return {"kind": "not_after", "time": found, "label": raw}

    for name in DAYS:
        if re.search(r"\b%s\b" % name, lower):
            return {"kind": "day_of_week", "days": [name], "label": raw}

    return None


def parse_constraints(texts):
    """Returns (constraints, unparsed). Unparsed limits must never be dropped."""
    constraints = []
    unparsed = []

    for text in texts or []:
        between = re.search(r"\bbetween\s+([\d:]+\s*(?:am|pm)?)\s+and\s+([\d:]+\s*(?:am|pm)?)", str(text).lower())
        if between:
            start = _safe_time(between.group(1).strip())
            end = _safe_time(between.group(2).strip())
            if start and end:
                constraints.append({"kind": "not_before", "time": start, "label": str(text).strip()})
                constraints.append({"kind": "not_after", "time": end, "label": str(text).strip()})
                continue

        parsed = parse_constraint(text)
        if parsed:
            constraints.append(parsed)
        else:
            unparsed.append(text)

    return constraints, unparsed


def describe_constraint(constraint):
    if constraint.get("label"):
        return constraint["label"]
    kind = constraint["kind"]
    if kind == "not_before":
        return "no earlier than %s" % constraint["time"]
    if kind == "not_after":
        return "no later than %s" % constraint["time"]
    if kind == "day_of_week":
        return "on %s" % " or ".join(constraint["days"])
    if kind == "party_size":
        return "party of exactly %d" % constraint["exactly"]
    if kind == "max_price":
        return "no more than %.2f" % (constraint["cents"] / 100.0)
    return kind


def check_constraints(constraints, offer):
    """Every hard limit the offer breaks. Empty means the agent may say yes."""
    violations = []
    when = parse_local_iso(offer["start"]) if offer.get("start") else None

    for constraint in constraints or []:
        kind = constraint["kind"]

        if kind == "not_before" and when and when["minutes"] < time_to_minutes(constraint["time"]):
            violations.append({"constraint": constraint, "detail": "offered time is before %s" % constraint["time"]})

        elif kind == "not_after" and when and when["minutes"] > time_to_minutes(constraint["time"]):
            violations.append({"constraint": constraint, "detail": "offered time is after %s" % constraint["time"]})

        elif kind == "on_date" and when and when["date"] != constraint["date"]:
            violations.append({"constraint": constraint, "detail": "offered %s" % when["date"]})

        elif kind == "day_of_week" and when:
            if DAYS[when["weekday"]] not in [d.lower() for d in constraint["days"]]:
                violations.append({"constraint": constraint, "detail": "offered a %s" % DAYS[when["weekday"]]})

        elif kind == "party_size":
            size = offer.get("partySize")
            if size is not None and size != constraint["exactly"]:
                violations.append({"constraint": constraint, "detail": "offered for %s" % size})

        elif kind == "max_price":
            price = offer.get("priceCents")
            if price is not None and price > constraint["cents"]:
                violations.append({"constraint": constraint, "detail": "quoted %.2f" % (price / 100.0)})

    return violations


def matches_ideal(ideal, offer):
    if not ideal:
        return False

    if ideal.get("start") and offer.get("start"):
        wanted = parse_local_iso(ideal["start"])
        got = parse_local_iso(offer["start"])
        if wanted["date"] != got["date"] or wanted["minutes"] != got["minutes"]:
            return False
    elif ideal.get("start") and not offer.get("start"):
        return False

    if ideal.get("partySize") is not None and offer.get("partySize") is not None:
        if ideal["partySize"] != offer["partySize"]:
            return False

    if ideal.get("priceCents") is not None and offer.get("priceCents") is not None:
        if offer["priceCents"] > ideal["priceCents"]:
            return False

    return True


def describe_offer(offer):
    parts = []
    if offer.get("start"):
        when = parse_local_iso(offer["start"])
        parts.append("%s at %02d:%02d" % (when["date"], when["minutes"] // 60, when["minutes"] % 60))
    if offer.get("partySize") is not None:
        parts.append("party of %d" % offer["partySize"])
    if offer.get("priceCents") is not None:
        parts.append("$%.2f" % (offer["priceCents"] / 100.0))
    return ", ".join(parts) or offer.get("note") or "the offer"


def decide(objective, offer, room_to_negotiate=True):
    """The whole policy. Must stay identical to the TypeScript decide()."""
    violations = check_constraints(objective.get("constraints") or [], offer)

    if violations:
        summary = "; ".join(describe_constraint(v["constraint"]) for v in violations)
        return {
            "action": "counter" if room_to_negotiate else "decline",
            "reason": "offer breaks a hard limit (%s)" % summary,
            "violations": violations,
        }

    ideal = objective.get("ideal")

    if matches_ideal(ideal, offer):
        return {"action": "accept", "reason": "offer matches what was asked for", "violations": []}

    if not ideal:
        return {
            "action": "accept",
            "reason": "offer is within all limits and nothing more specific was asked for",
            "violations": [],
        }

    return {
        "action": "escalate",
        "reason": "offer is within the limits but is not what was asked for",
        "violations": [],
        "question": "They offered %s instead of %s. Take it?" % (describe_offer(offer), describe_offer(ideal)),
    }


# ── hearing an offer ──────────────────────────────────────────────────────


def _words_to_number(text):
    total = 0
    matched = False
    for part in re.split(r"[\s-]+", str(text).lower()):
        if not part:
            continue
        if part not in WORD_NUMBERS:
            return None
        total += WORD_NUMBERS[part]
        matched = True
    return total if matched else None


def _apply_meridiem(hours, meridiem, hint):
    if meridiem == "pm":
        return hours + 12 if hours < 12 else hours
    if meridiem == "am":
        return 0 if hours == 12 else hours
    if hint == "evening" and 1 <= hours <= 11:
        return hours + 12
    if hint == "none" and 1 <= hours <= 6:
        return hours + 12
    return hours


def _iso(date, hours, minutes):
    return "%sT%02d:%02d:00" % (date, hours, minutes)


def _spoken_time(text, date, hint):
    """
    Take the LAST plausible time, not the first.

    "Seven is fully booked, but I could do seven forty-five" — the first number
    is the thing being refused. A candidate only counts when something marks it
    as a time: minutes, "o'clock", a lead-in word, or am/pm in the sentence.
    """
    meridiem = "pm" if HAS_PM.search(text) else ("am" if HAS_AM.search(text) else None)
    best = None

    for match in SPOKEN_TIME.finditer(text):
        hour_word = _words_to_number(match.group(1))
        if hour_word is None or not (1 <= hour_word <= 12):
            continue

        minute_token = (match.group(2) or "").lower()
        is_oclock = bool(minute_token) and bool(re.search(r"o'?clock", minute_token))
        if minute_token and not is_oclock:
            minutes = _words_to_number(re.sub(r"\boh[\s-]", "", minute_token))
        else:
            minutes = 0
        if minutes is None or minutes >= 60:
            continue

        lead_in = bool(TIME_LEAD_IN.search(text[: match.start()]))
        if not (minute_token or is_oclock or lead_in or meridiem):
            continue

        best = _iso(date, _apply_meridiem(hour_word, meridiem, hint), minutes)

    return best


def extract_offer(utterance, date, hint="none"):
    """None when nothing was offered — different from an offer of nothing."""
    text = str(utterance or "").strip()
    if not text:
        return None

    offer = {}
    found = False

    digit_time = re.search(r"\b(\d{1,2}):(\d{2})\s*(am|pm)?\b", text, re.IGNORECASE)
    if digit_time:
        hours = _apply_meridiem(int(digit_time.group(1)), (digit_time.group(3) or "").lower() or None, hint)
        offer["start"] = _iso(date, hours, int(digit_time.group(2)))
        found = True

    if not found:
        bare = re.search(r"\b(\d{1,2})\s*(am|pm)\b", text, re.IGNORECASE)
        if bare:
            offer["start"] = _iso(date, _apply_meridiem(int(bare.group(1)), bare.group(2).lower(), hint), 0)
            found = True

    if not found:
        quarter = re.search(r"\bquarter past (\w+)\b", text, re.IGNORECASE)
        half = re.search(r"\bhalf (?:past )?(\w+)\b", text, re.IGNORECASE)
        match = quarter or half
        if match:
            hour_word = _words_to_number(match.group(1))
            if hour_word is not None and 1 <= hour_word <= 12:
                offer["start"] = _iso(date, _apply_meridiem(hour_word, None, hint), 15 if quarter else 30)
                found = True

    if not found:
        spoken = _spoken_time(text, date, hint)
        if spoken:
            offer["start"] = spoken
            found = True

    price = re.search(r"\$\s*([\d,]+(?:\.\d{1,2})?)|\b([\d,]+(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b", text, re.IGNORECASE)
    if price:
        amount = (price.group(1) or price.group(2)).replace(",", "")
        offer["priceCents"] = int(round(float(amount) * 100))
        found = True

    party = re.search(r"\b(?:table|party|booking|seats?)\s*(?:for|of)\s*(\d+|\w+)\b", text, re.IGNORECASE)
    if party:
        token = party.group(1)
        size = int(token) if token.isdigit() else _words_to_number(token)
        if size is not None and 0 < size < 100:
            offer["partySize"] = size
            found = True

    if not found:
        return None

    offer["note"] = text
    return offer


def sounds_like_refusal(utterance):
    return bool(REFUSAL.search(utterance or "")) and not SOFTENER.search(utterance or "")


def sounds_like_agreement(utterance):
    return bool(AGREEMENT.search(utterance or ""))


# ── the agent ─────────────────────────────────────────────────────────────


class PhoneAgent(BasicAgent):
    def __init__(self, provider=None):
        self.name = "Phone"
        self.metadata = {
            "name": self.name,
            "description": (
                "Call someone on the owner's behalf. Give a goal and the hard limits the owner will "
                "accept. An offer inside the limits that matches the request is taken; anything inside "
                "the limits but different is held and the owner is asked; anything outside them is "
                "countered or refused. Also lists pending approvals, records the answer, and reads back "
                "a transcript."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["call", "approvals", "approve", "deny", "transcript", "brief", "hotline_check"],
                        "description": "What to do.",
                    },
                    "to": {"type": "string", "description": "Phone number, or a name already in the second brain."},
                    "objective": {"type": "string", "description": "What the call is for, in plain language."},
                    "constraints": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Hard limits, one per entry. Understood: 'no later than 8pm', 'not before 6pm', "
                            "'between 6pm and 8pm', 'party size exactly 2', 'budget under 400', "
                            "'must be on Thursday'. Anything else is rejected, never ignored."
                        ),
                    },
                    "wanted_time": {"type": "string", "description": "The time actually asked for, ISO-8601."},
                    "wanted_party_size": {"type": "integer", "description": "The party size actually asked for."},
                    "rehearse": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Practise against these scripted replies instead of calling anyone.",
                    },
                    "id": {"type": "string", "description": "An approval id, or a call id for transcript."},
                    "note": {"type": "string", "description": "Reason recorded with approve/deny."},
                    "pin": {"type": "string", "description": "Hotline PIN, for hotline_check."},
                    "from": {"type": "string", "description": "Caller number, for hotline_check."},
                    "user_guid": {"type": "string", "description": "Optional per-user memory scope."},
                },
                "required": ["action"],
            },
        }
        self._provider = provider
        super().__init__(name=self.name, metadata=self.metadata)

    # ── the log (same format and chain as rapp-secondbrain) ───────────────

    def _storage(self):
        storage = getattr(self, "storage_manager", None)
        if storage is not None:
            return storage
        from utils.azure_file_storage import AzureFileStorageManager  # grail shim

        return AzureFileStorageManager()

    def _read_events(self):
        try:
            raw = self._storage().read_file(LOG_PATH)
        except Exception:
            return []
        if not raw:
            return []
        events = []
        for line in raw.splitlines():
            line = line.strip()
            if line:
                try:
                    events.append(json.loads(line))
                except ValueError:
                    continue
        return events

    def _append(self, event_type, payload):
        events = self._read_events()
        body = {
            "seq": events[-1]["seq"] + 1 if events else 1,
            "id": _new_id("ev"),
            "ts": _now(),
            "type": event_type,
            "actor": "brainstem-phone",
            "payload": payload,
            "prev": events[-1]["hash"] if events else GENESIS,
        }
        body["hash"] = _sha(_canon(body))

        storage = self._storage()
        try:
            existing = storage.read_file(LOG_PATH) or ""
        except Exception:
            existing = ""
        if existing and not existing.endswith("\n"):
            existing += "\n"
        storage.write_file(LOG_PATH, existing + _canon(body) + "\n")
        return body

    def _state(self):
        state = {"calls": {}, "appointments": {}, "approvals": {}}
        for event in self._read_events():
            kind = event.get("type", "")
            data = event.get("payload") or {}

            if kind == "call.start":
                call = dict(data)
                call["turns"] = []
                state["calls"][data["id"]] = call
            elif kind == "call.turn":
                call = state["calls"].get(data.get("call_id"))
                if call is not None:
                    call["turns"].append({"role": data["role"], "text": data["text"]})
            elif kind == "call.end":
                call = state["calls"].get(data.get("call_id"))
                if call is not None:
                    call["outcome"] = data.get("outcome")
            elif kind == "appointment.propose":
                appointment = dict(data)
                appointment["status"] = "proposed"
                state["appointments"][data["id"]] = appointment
            elif kind in ("appointment.confirm", "appointment.cancel"):
                appointment = state["appointments"].get(data.get("id"))
                if appointment is not None:
                    appointment["status"] = "confirmed" if kind.endswith("confirm") else "cancelled"
            elif kind == "approval.request":
                approval = dict(data)
                approval["status"] = "pending"
                state["approvals"][data["id"]] = approval
            elif kind == "approval.decide":
                approval = state["approvals"].get(data.get("id"))
                if approval is not None:
                    approval["status"] = data["decision"]
        return state

    def _resolve(self, bucket, key):
        if not key:
            return None
        if key in bucket:
            return bucket[key]
        hits = [v for k, v in bucket.items() if k.endswith(key) or k.startswith(key)]
        return hits[0] if len(hits) == 1 else None

    # ── dispatch ─────────────────────────────────────────────────────────

    def perform(self, **kwargs):
        action = kwargs.get("action") or "brief"
        try:
            storage = self._storage()
            if hasattr(storage, "set_memory_context"):
                storage.set_memory_context(kwargs.get("user_guid"))
        except Exception:
            pass

        try:
            return self._dispatch(action, kwargs)
        except Exception as exc:
            return json.dumps({"status": "error", "action": action, "message": str(exc)}, indent=2)

    def _dispatch(self, action, kwargs):
        if action == "call":
            return self._call(kwargs)

        state = self._state()

        if action == "approvals":
            pending = [a for a in state["approvals"].values() if a.get("status") == "pending"]
            return json.dumps({"status": "ok", "count": len(pending), "approvals": pending}, indent=2)

        if action in ("approve", "deny"):
            approval = self._resolve(state["approvals"], kwargs.get("id"))
            if not approval:
                return self._fail(action, "unknown approval")
            if approval.get("status") != "pending":
                return self._fail(action, "already %s" % approval.get("status"))

            self._append(
                "approval.decide",
                {"id": approval["id"], "decision": action, "via": "brainstem", "note": kwargs.get("note") or ""},
            )

            confirmed = None
            if action == "approve" and approval.get("ref"):
                appointment = self._resolve(self._state()["appointments"], approval["ref"])
                if appointment:
                    self._append("appointment.confirm", {"id": appointment["id"]})
                    confirmed = appointment["id"]
            elif action == "deny" and approval.get("ref"):
                appointment = self._resolve(self._state()["appointments"], approval["ref"])
                if appointment:
                    self._append("appointment.cancel", {"id": appointment["id"], "reason": "owner declined"})

            return json.dumps(
                {"status": "ok", "action": action, "approval_id": approval["id"], "confirmed_appointment": confirmed},
                indent=2,
            )

        if action == "transcript":
            call = self._resolve(state["calls"], kwargs.get("id"))
            return json.dumps({"status": "ok" if call else "error", "call": call}, indent=2)

        if action == "brief":
            pending = [a for a in state["approvals"].values() if a.get("status") == "pending"]
            upcoming = [a for a in state["appointments"].values() if a.get("status") == "confirmed"]
            return json.dumps(
                {
                    "status": "ok",
                    "pending_approvals": pending,
                    "confirmed_appointments": upcoming,
                    "calls": len(state["calls"]),
                },
                indent=2,
            )

        if action == "hotline_check":
            pin = kwargs.get("pin")
            if not pin:
                return self._fail(action, "a pin is required")
            if not re.match(r"^\d{4,12}$", str(pin)):
                return self._fail(action, "pin must be 4-12 digits")
            return json.dumps(
                {
                    "status": "ok",
                    "caller": kwargs.get("from") or "",
                    "outcome": "challenge",
                    "say": "Please enter your access code.",
                },
                indent=2,
            )

        return self._fail(action, "unknown action '%s'" % action)

    def _fail(self, action, message):
        return json.dumps({"status": "error", "action": action, "message": message}, indent=2)

    # ── placing a call ───────────────────────────────────────────────────

    def _call(self, kwargs):
        to = kwargs.get("to")
        if not to:
            return self._fail("call", "who should I call?")

        constraints, unparsed = parse_constraints(kwargs.get("constraints") or [])
        if unparsed:
            return json.dumps(
                {
                    "status": "error",
                    "action": "call",
                    "message": "I did not understand some of the limits, so I have not called.",
                    "unparsed": unparsed,
                },
                indent=2,
            )

        ideal = {}
        wanted_time = kwargs.get("wanted_time")
        if wanted_time:
            try:
                parse_local_iso(wanted_time)
            except ValueError:
                return self._fail("call", "wanted_time must be ISO-8601 like 2026-08-07T19:00")
            ideal["start"] = wanted_time
        if isinstance(kwargs.get("wanted_party_size"), int):
            ideal["partySize"] = kwargs["wanted_party_size"]

        objective = {
            "goal": kwargs.get("objective") or "Make an enquiry",
            "constraints": constraints,
            "ideal": ideal or None,
        }

        rehearse = kwargs.get("rehearse")
        provider = self._provider
        if provider is None and not rehearse:
            # No way to reach anyone, and pretending would be the worst outcome.
            return json.dumps(
                {
                    "status": "error",
                    "action": "call",
                    "message": (
                        "no telephony provider is attached to this brainstem. Pass rehearse to practise, "
                        "or run the call through openrappter, which carries the provider ladder "
                        "(cloud voice, then on-device SMS, then a handoff)."
                    ),
                },
                indent=2,
            )

        date = parse_local_iso(ideal["start"])["date"] if ideal.get("start") else datetime.date.today().isoformat()
        hint = "evening" if re.search(r"dinner|table|restaurant|evening|tonight", objective["goal"], re.I) else "none"

        return self._run_call(to, objective, date, hint, list(rehearse or []), provider)

    def _run_call(self, to, objective, date, hint, replies, provider):
        call_id = _new_id("call")
        self._append(
            "call.start",
            {
                "id": call_id,
                "direction": "outbound",
                "peer": to,
                "objective": objective["goal"],
                "constraints": [c.get("label") or c["kind"] for c in objective["constraints"]],
                "provider": "rehearsal" if provider is None else getattr(provider, "name", "provider"),
            },
        )

        transcript = []

        def say(text):
            transcript.append({"role": "agent", "text": text})
            self._append("call.turn", {"call_id": call_id, "role": "agent", "text": text})
            if provider is not None:
                provider.say(text)

        def listen():
            if provider is not None:
                return provider.listen()
            return replies.pop(0) if replies else None

        say("Hi — %s. Is that possible?" % objective["goal"])

        counters = 0
        max_counters = 2
        outcome = "no_answer"
        best_offer = None
        decision = None

        for _ in range(12):
            heard = listen()
            if heard is None:
                break
            transcript.append({"role": "peer", "text": heard})
            self._append("call.turn", {"call_id": call_id, "role": "peer", "text": heard})

            offer = extract_offer(heard, date, hint)

            if not offer:
                if sounds_like_agreement(heard) and best_offer and decision and decision["action"] == "accept":
                    outcome = "agreed"
                    break
                if sounds_like_refusal(heard):
                    outcome = "declined"
                    say("I don't think we can make that work. Thanks for your time.")
                    break
                say("Sorry — could you tell me what you do have available?")
                continue

            decision = decide(objective, offer, room_to_negotiate=counters < max_counters)
            best_offer = offer

            if decision["action"] == "accept":
                say("%s works. Let's do that — thank you." % describe_offer(offer))
                outcome = "agreed"
                break

            if decision["action"] == "escalate":
                say(
                    "%s could work, but I need to confirm it before I book. Can I call you straight back?"
                    % describe_offer(offer)
                )
                outcome = "escalated"
                break

            if decision["action"] == "counter":
                counters += 1
                say(
                    "That doesn't quite work — %s. Is there anything else?"
                    % ", and ".join(v["detail"] for v in decision["violations"])
                )
                continue

            say("I don't think we can make that work — %s. Thanks for your time." % decision["reason"])
            outcome = "declined"
            break

        self._append(
            "call.end",
            {"call_id": call_id, "outcome": outcome, "success": outcome == "agreed", "summary": ""},
        )

        appointment_id = None
        approval_id = None

        if outcome in ("agreed", "escalated") and best_offer:
            appointment_id = _new_id("appt")
            self._append(
                "appointment.propose",
                {
                    "id": appointment_id,
                    "title": objective["goal"],
                    "with": to,
                    "start": best_offer.get("start"),
                    "call_id": call_id,
                },
            )

            if outcome == "escalated":
                approval_id = _new_id("apr")
                self._append(
                    "approval.request",
                    {
                        "id": approval_id,
                        "subject": decision.get("question") if decision else "Approve this?",
                        "detail": decision.get("reason") if decision else "",
                        "options": ["approve", "deny"],
                        "ref": appointment_id,
                        "channel": "brainstem",
                    },
                )
            else:
                # Inside the mandate — the agent may confirm on its own authority.
                self._append("appointment.confirm", {"id": appointment_id})

        return json.dumps(
            {
                "status": "ok",
                "rehearsal": provider is None,
                "outcome": outcome,
                "booked": outcome == "agreed",
                "needs_your_approval": outcome == "escalated",
                "question": decision.get("question") if decision else None,
                "call_id": call_id,
                "appointment_id": appointment_id,
                "approval_id": approval_id,
                "offer": best_offer,
                "transcript": ["%s: %s" % (t["role"], t["text"]) for t in transcript],
                "data_slush": {
                    "call_id": call_id,
                    "appointment_id": appointment_id,
                    "approval_id": approval_id,
                },
            },
            indent=2,
        )
