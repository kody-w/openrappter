#!/usr/bin/env python3
"""Drive RAPPID Field in the iOS Simulator over the debug autopilot mailbox.

The app answers every command with a receipt published to the device
pasteboard, which this script reads with ``simctl pbpaste``. Commands can be
delivered two ways:

``--transport clipboard``
    The specified transport: the command JSON is written with ``simctl pbcopy``
    and the app reads it from the pasteboard mailbox. On iOS 16 and later the
    system raises a "would like to paste from" confirmation for programmatic
    reads of content another process wrote, so this transport needs someone to
    tap "Allow Paste" once per command. It is exact, and it is not unattended.

``--transport file`` (default)
    The same command JSON dropped into a one-slot mailbox inside the app's own
    container, which needs no confirmation. It reaches the identical parser,
    allowlist, replay guard and receipt path, and its receipts are published to
    the pasteboard too, so ``simctl pbpaste`` stays the answer channel either
    way.

Nothing here can make the app do anything the allowlist does not already
permit: this script only formats JSON and reads receipts.

Examples
--------
    ./scripts/autopilot.py up --autopilot
    ./scripts/autopilot.py send snapshot
    ./scripts/autopilot.py send navigate --target growth
    ./scripts/autopilot.py smoke
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import time
import uuid

DEFAULT_DEVICE = "iPhone 17 Pro"
BUNDLE_ID = "com.openrappter.rappidfield"
MAILBOX_DIR = "Library/Application Support/RappidFieldAutopilot"
ACTIVATION_KEY = "RAPPID_AUTOPILOT"
CLIPBOARD_KEY = "RAPPID_AUTOPILOT_CLIPBOARD"
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_APP = PROJECT_ROOT / ".build/Build/Products/Debug-iphonesimulator/RappidField.app"

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


class AutopilotError(RuntimeError):
    pass


def run(args: list[str], *, stdin: bytes | None = None, check: bool = True) -> str:
    result = subprocess.run(args, input=stdin, capture_output=True)
    if check and result.returncode != 0:
        raise AutopilotError(
            f"{' '.join(args)} failed ({result.returncode}): "
            f"{result.stderr.decode(errors='replace').strip()}"
        )
    return result.stdout.decode(errors="replace")


def simctl(device: str, *args: str, **kwargs) -> str:
    return run(["xcrun", "simctl", *args[:1], device, *args[1:]], **kwargs)


# ---------------------------------------------------------------- device setup


def boot(device: str) -> None:
    def is_booted(listing: str) -> bool:
        return any(device in line and "Booted" in line for line in listing.splitlines())

    state = run(["xcrun", "simctl", "list", "devices"], check=False)
    if is_booted(state):
        return
    run(["xcrun", "simctl", "boot", device], check=False)
    for _ in range(60):
        listing = run(["xcrun", "simctl", "list", "devices"], check=False)
        if is_booted(listing):
            return
        time.sleep(1)
    raise AutopilotError(f"{device} did not boot")


def install(device: str, app: pathlib.Path) -> None:
    if not app.exists():
        raise AutopilotError(
            f"{app} not found. Build first:\n"
            "  xcodebuild -project RappidField.xcodeproj -scheme RappidField \\\n"
            f"    -destination 'platform=iOS Simulator,name={device}' -derivedDataPath .build build"
        )
    run(["xcrun", "simctl", "install", device, str(app)])


def launch(device: str, autopilot: bool, fresh: bool, clipboard: bool = False) -> None:
    run(["xcrun", "simctl", "terminate", device, BUNDLE_ID], check=False)
    if fresh:
        # A fresh journey starts at onboarding, like a first install.
        run(["xcrun", "simctl", "uninstall", device, BUNDLE_ID], check=False)
        install(device, DEFAULT_APP)
    environment = dict(os.environ)
    command = ["xcrun", "simctl", "launch", device, BUNDLE_ID]
    if autopilot:
        environment[f"SIMCTL_CHILD_{ACTIVATION_KEY}"] = "1"
        command += [f"-{ACTIVATION_KEY}", "1"]
    if autopilot and clipboard:
        # Opt in to reading commands from the pasteboard. The device will ask
        # to allow each paste, so this needs someone watching.
        environment[f"SIMCTL_CHILD_{CLIPBOARD_KEY}"] = "1"
        command += [f"-{CLIPBOARD_KEY}", "1"]
    result = subprocess.run(command, capture_output=True, env=environment)
    if result.returncode != 0:
        raise AutopilotError(result.stderr.decode(errors="replace").strip())
    time.sleep(2.5)


# ------------------------------------------------------------------- transport


def pbpaste(device: str) -> str:
    return run(["xcrun", "simctl", "pbpaste", device], check=False)


def pbcopy(device: str, payload: str) -> None:
    run(["xcrun", "simctl", "pbcopy", device], stdin=payload.encode())


def openurl(device: str, payload: str) -> None:
    raise AutopilotError("the URL carrier was removed; use --transport file or clipboard")


def mailbox_dir(device: str) -> pathlib.Path:
    container = run(["xcrun", "simctl", "get_app_container", device, BUNDLE_ID, "data"]).strip()
    if not container:
        raise AutopilotError(f"{BUNDLE_ID} is not installed on {device}")
    return pathlib.Path(container) / MAILBOX_DIR


def deliver_file(device: str, payload: str) -> None:
    directory = mailbox_dir(device)
    directory.mkdir(parents=True, exist_ok=True)
    inbox = directory / "inbox.json"
    # Written atomically so the app never reads half a command.
    scratch = directory / "inbox.json.partial"
    scratch.write_text(payload, encoding="utf-8")
    scratch.replace(inbox)


class HandshakeTimeout(AutopilotError):
    """No receipt arrived for the command that was sent. The journey stops."""


class Session:
    """A strict, stepwise handshake with one app.

    One command is in flight at a time. Each carries the next number in a
    monotonic sequence, and nothing else is sent until the app answers *that*
    command, by id and by sequence. There is no fire-and-forget path: a missing
    receipt is a timeout that ends the run rather than a step that is skipped.
    """

    def __init__(self, device: str, transport: str = "file", timeout: float = 20.0) -> None:
        self.device = device
        self.transport = transport
        self.timeout = timeout
        self.seq = 0
        self.cursor = 0
        self.pending: str | None = None
        self.handshakes = 0
        self.start_cursor = 0

    def resync(self) -> int:
        """Picks the sequence up from wherever the app's cursor already is.

        The cursor is discoverable: it rides on every receipt, and the last one
        is still in the mailbox. A caller that joins a session already in
        progress reads it rather than guessing.
        """
        for raw in self._published():
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict) and parsed.get("type") == "receipt":
                cursor = parsed.get("cursor")
                if isinstance(cursor, int) and cursor > self.seq:
                    self.seq = cursor
                    self.cursor = cursor
        self.start_cursor = self.cursor
        return self.seq

    def _published(self) -> list[str]:
        found = [pbpaste(self.device).strip()]
        receipt_file = self._receipt_file()
        if receipt_file is not None and receipt_file.exists():
            try:
                found.append(receipt_file.read_text(encoding="utf-8").strip())
            except OSError:
                pass
        return [item for item in found if item.startswith("{")]

    def payload(self, action: str, command_id: str, seq: int,
                target: str | None, value: str | None) -> str:
        body: dict[str, object] = {
            "type": "command",
            "version": 1,
            "seq": seq,
            "id": command_id,
            "action": action,
        }
        if target is not None:
            body["target"] = target
        if value is not None:
            body["value"] = value
        return json.dumps(body, sort_keys=True, separators=(",", ":"))

    def _receipt_file(self) -> pathlib.Path | None:
        try:
            return mailbox_dir(self.device) / "receipt.json"
        except AutopilotError:
            return None

    def _await_receipt(self, command_id: str, seq: int) -> dict:
        deadline = time.monotonic() + self.timeout
        receipt_file = self._receipt_file()
        while time.monotonic() < deadline:
            candidates = [pbpaste(self.device).strip()]
            # The same receipt is published to both channels; whichever lands
            # first is the same artefact.
            if receipt_file is not None and receipt_file.exists():
                try:
                    candidates.append(receipt_file.read_text(encoding="utf-8").strip())
                except OSError:
                    pass
            for raw in candidates:
                if not raw.startswith("{"):
                    continue
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(parsed, dict):
                    continue
                if parsed.get("type") != "receipt" or parsed.get("version") != 1:
                    continue
                if parsed.get("id") != command_id:
                    continue
                answered = parsed.get("seq")
                if answered != seq:
                    # A command refused before its sequence could be read
                    # answers with seq 0, and that is still an answer to it.
                    if not (answered == 0 and parsed.get("status") in {"refused", "error"}):
                        raise AutopilotError(
                            f"receipt for {command_id} answered seq {answered!r}, expected {seq}"
                        )
                return parsed
            time.sleep(0.1)
        raise HandshakeTimeout(
            f"no receipt for {command_id} (seq {seq}) within {self.timeout:.0f}s"
            + (". With --transport clipboard the app needs the paste allowed on device."
               if self.transport == "clipboard" else ".")
        )

    def send(self, action: str, *, target: str | None = None, value: str | None = None,
             command_id: str | None = None, raw_payload: str | None = None,
             force_seq: int | None = None) -> dict:
        if self.pending is not None:
            raise AutopilotError(f"refusing to send {action}: still waiting on {self.pending}")

        self.seq += 1
        seq = force_seq if force_seq is not None else self.seq
        command_id = command_id or str(uuid.uuid4())
        body = raw_payload if raw_payload is not None else self.payload(action, command_id, seq, target, value)

        self.pending = f"{action}#{seq} ({command_id})"
        try:
            if self.transport == "clipboard":
                pbcopy(self.device, body)
            else:
                deliver_file(self.device, body)
            receipt = self._await_receipt(command_id, seq)
        finally:
            self.pending = None

        cursor = receipt.get("cursor")
        if not isinstance(cursor, int) or cursor < self.cursor:
            raise AutopilotError(f"cursor went backwards: {self.cursor} -> {cursor!r} on {action}#{seq}")
        self.cursor = cursor
        self.handshakes += 1
        return receipt


# ----------------------------------------------------------------- smoke drive


class Journey:
    """A deterministic drive through the app, asserting as it goes."""

    def __init__(self, session: "Session") -> None:
        self.session = session
        self.failures: list[str] = []
        self.steps = 0
        self.cursors: list[int] = []

    def step(
        self,
        note: str,
        action: str,
        *,
        target: str | None = None,
        value: str | None = None,
        expect_status: str = "ok",
        expect_state: dict | None = None,
        expect_error_prefix: str | None = None,
        command_id: str | None = None,
        raw_payload: str | None = None,
        force_seq: int | None = None,
    ) -> dict:
        self.steps += 1
        try:
            receipt = self.session.send(
                action,
                target=target,
                value=value,
                command_id=command_id,
                raw_payload=raw_payload,
                force_seq=force_seq,
            )
        except HandshakeTimeout as timeout:
            # Never skip ahead: the run stops on the step that went unanswered.
            self.failures.append(f"{note}: {timeout}")
            print(f"  {RED}✗{RESET} {note} {DIM}({action}){RESET}")
            print(f"      {RED}{timeout}{RESET}")
            raise
        self.cursors.append(receipt.get("cursor", -1))
        problems = []
        if receipt.get("status") != expect_status:
            problems.append(f"status {receipt.get('status')!r} != {expect_status!r} ({receipt.get('error')})")
        if expect_error_prefix and not str(receipt.get("error", "")).startswith(expect_error_prefix):
            problems.append(f"error {receipt.get('error')!r} does not start with {expect_error_prefix!r}")
        state = receipt.get("state", {})
        for key, wanted in (expect_state or {}).items():
            found = dotted(state, key)
            if wanted is ABSENT:
                if found is not ABSENT:
                    problems.append(f"state[{key}] should be absent, got {found!r}")
            elif found != wanted:
                problems.append(f"state[{key}] {found!r} != {wanted!r}")

        label = f"#{receipt.get('seq')} {action}" + (f" {target}" if target else "") + (f" = {value}" if value else "")
        if problems:
            self.failures.append(f"{note}: {'; '.join(problems)}")
            print(f"  {RED}✗{RESET} {note} {DIM}({label}){RESET}")
            for problem in problems:
                print(f"      {RED}{problem}{RESET}")
        else:
            print(f"  {GREEN}✓{RESET} {note} {DIM}({label} → {receipt.get('status')}){RESET}")
        return receipt

    def check(self, note: str, condition: bool, detail: str = "") -> None:
        self.steps += 1
        if condition:
            print(f"  {GREEN}✓{RESET} {note}")
        else:
            self.failures.append(f"{note}: {detail}")
            print(f"  {RED}✗{RESET} {note} {DIM}{detail}{RESET}")


class _Absent:
    def __repr__(self) -> str:
        return "ABSENT"


ABSENT = _Absent()


def dotted(state: dict, key: str):
    """Reads `a.b` out of a receipt's state, returning ABSENT when missing."""
    node = state
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            return ABSENT
        node = node[part]
    return node


def report(journey: "Journey", session: "Session") -> int:
    """Prints the outcome, and the proof that every step was a handshake."""
    print()
    ordered = all(b >= a for a, b in zip(journey.cursors, journey.cursors[1:]))
    print(f"{DIM}{session.handshakes} sequential handshakes · cursor {session.start_cursor} -> "
          f"{session.cursor} · monotonic={ordered} · unanswered=0{RESET}")
    if session.handshakes < 10:
        journey.failures.append(f"only {session.handshakes} handshakes; at least 10 are required")
    if not ordered:
        journey.failures.append(f"cursor was not monotonic: {journey.cursors}")

    if journey.failures:
        print(f"{RED}FAILED{RESET} {len(journey.failures)} of {journey.steps} checks")
        for failure in journey.failures:
            print(f"  {RED}·{RESET} {failure}")
        return 1
    print(f"{GREEN}PASSED{RESET} all {journey.steps} checks")
    return 0


def smoke(device: str, transport: str, timeout: float, fresh: bool) -> int:
    print(f"\n{YELLOW}RAPPID Field autopilot smoke journey{RESET}")
    print(f"{DIM}device={device} transport={transport}{RESET}\n")

    boot(device)
    launch(device, autopilot=True, fresh=fresh, clipboard=transport == "clipboard")
    if transport == "clipboard":
        print(f"{YELLOW}note{RESET} the device will ask to allow each paste; this run is not unattended\n")

    session = Session(device, transport=transport, timeout=timeout)
    session.resync()
    journey = Journey(session)

    print("Onboarding")
    opening = journey.step("answers a snapshot", "snapshot")
    if opening.get("state", {}).get("screen") == "onboarding":
        journey.step("cannot navigate before a path is chosen", "navigate", target="growth",
                     expect_status="refused", expect_error_prefix="not-applicable")
        journey.step("selects the Forge path", "selectStarter", target="forge",
                     expect_state={"onboarding": "confirm"})
        journey.step("confirms and enters the field", "confirmStarter",
                     expect_state={"onboarding": "complete", "starter": "forge", "screen": "fieldGuide"})
    else:
        journey.step("resets to a fresh synthetic field", "resetSyntheticState",
                     expect_state={"pairing": "unpaired"})

    print("\nField Guide")
    journey.step("opens the Canopy card", "openCard", target="canopy",
                 expect_state={"companion": "Mossline", "stage": "Strider", "origin": "synthetic"})
    journey.step("reports an exact weight", "snapshot", expect_state={"weightComplete": True})
    journey.step("plays the wake call on request", "playWakeCall", expect_state={"wakeCall": "playing"})
    journey.step("stops it on request", "stopWakeCall", expect_state={"wakeCall": "idle"})
    journey.step("opens the Forge card", "openCard", target="forge",
                 expect_state={"companion": "Emberline", "stage": "Aetherwing"})
    journey.step("refuses to invent an incomplete weight", "snapshot",
                 expect_state={"weightComplete": False, "weightBytes": ABSENT})

    print("\nGrowth leash")
    journey.step("moves to Growth", "navigate", target="growth", expect_state={"screen": "growth"})
    journey.step("sets the leash to Observe", "setLeash", value="observe", expect_state={"leash": "observe"})
    journey.step("Observe generates no proposal", "requestProposal",
                 expect_status="refused", expect_error_prefix="not-applicable")
    journey.step("sets the leash to Run Approved", "setLeash", value="runApproved",
                 expect_state={"leash": "runApproved"})
    journey.step("reads a proposal", "requestProposal",
                 expect_state={"proposal.authoritative": False, "proposal.appendable": False})

    print("\nThe confirmation stays binding")
    journey.step("refuses to append with no sheet open", "approveAppend",
                 expect_status="refused", expect_error_prefix="requires-operator-confirmation")
    journey.step("opens the confirmation sheet", "openConfirmation",
                 expect_state={"confirmationVisible": True, "confirmationAcknowledged": False})
    journey.step("refuses to append unacknowledged", "approveAppend",
                 expect_status="refused", expect_error_prefix="requires-operator-confirmation")
    journey.step("acknowledges the sheet", "acknowledgeConfirmation",
                 expect_state={"confirmationAcknowledged": True})
    journey.step("is still refused by the append policy", "approveAppend", expect_status="refused")
    journey.step("cancel closes a reopened sheet", "openConfirmation", expect_state={"confirmationVisible": True})
    journey.step("cancels", "cancelAppend", expect_state={"confirmationVisible": False})

    print("\nPairing")
    journey.step("moves to the Host screen", "navigate", target="pairing", expect_state={"screen": "host"})
    journey.step("refuses a foreign host address", "fillPairingHost", value="http://evil.example.com",
                 expect_status="refused", expect_error_prefix="value-rejected")
    journey.step("accepts a loopback host", "fillPairingHost", value="http://localhost:8787",
                 expect_state={"pairingHostFilled": True})
    journey.step("refuses a malformed link code", "fillPairingCode", value="OOOO-1111-IIII",
                 expect_status="refused", expect_error_prefix="value-rejected")
    journey.step("accepts a link code", "fillPairingCode", value="H7K2-9QMR-3TVX",
                 expect_state={"pairingCodeFilled": True})
    paired = journey.step("pairs synthetically", "submitSyntheticPair",
                          expect_state={"pairing": "paired", "origin": "synthetic"})
    receipt_text = json.dumps(paired)
    leaked = [term for term in ("token", "bearer", "secret", "H7K2", "localhost", "oauth")
              if term.lower() in receipt_text.lower()]
    journey.check("the receipt carries no credential material", not leaked, f"leaked: {leaked}")

    print("\nCompanion (CMR/1)")
    journey.step("moves to the companion", "navigate", target="chat", expect_state={"screen": "companion"})
    journey.step("types a question", "fillChatInput", value="What do you weigh?",
                 expect_state={"chatInputFilled": True})
    # No polling: the app answers only once the reply has been committed.
    committed = journey.step("sends it and waits for the committed reply", "sendChat",
                             expect_state={"chatMessages": 2, "chatPhase": "idle"})
    journey.check(
        "no message text rides along in a receipt",
        "what do you weigh?" not in json.dumps(committed).lower(),
    )

    print("\nSequencing")
    ordered = journey.step("answers in order", "snapshot")
    journey.check(
        "the receipt echoes the command's place in the order",
        ordered.get("seq") == ordered.get("cursor") == session.seq,
        f"seq={ordered.get('seq')} cursor={ordered.get('cursor')} sent={session.seq}",
    )
    unsequenced = str(uuid.uuid4())
    journey.step("refuses a command with no sequence number", "navigate",
                 command_id=unsequenced,
                 raw_payload=json.dumps(
                     {"type": "command", "version": 1, "id": unsequenced, "action": "navigate",
                      "target": "growth"},
                     sort_keys=True, separators=(",", ":"),
                 ),
                 expect_status="refused", expect_error_prefix="missing-sequence")
    journey.step("refuses a sequence number it has already passed", "navigate", target="growth",
                 force_seq=max(1, session.cursor - 1),
                 expect_status="refused", expect_error_prefix="stale-sequence")
    journey.check(
        "the cursor only ever moved forward",
        all(b >= a for a, b in zip(journey.cursors, journey.cursors[1:])),
        str(journey.cursors),
    )

    print("\nRefusals")
    replay_id = str(uuid.uuid4())
    journey.step("accepts a command once", "navigate", target="privacy", command_id=replay_id,
                 expect_state={"screen": "privacy"})
    journey.step("refuses the same command id twice", "navigate", target="growth", command_id=replay_id,
                 expect_status="refused", expect_error_prefix="duplicate-command-id",
                 expect_state={"screen": "privacy"})
    journey.step("refuses an unknown action", "evaluateJavaScript",
                 expect_status="refused", expect_error_prefix="unknown-action")
    bad_version = str(uuid.uuid4())
    journey.step(
        "refuses an unsupported version", "navigate",
        command_id=bad_version,
        raw_payload=json.dumps(
            {"type": "command", "version": 99, "id": bad_version, "action": "navigate", "target": "growth"},
            sort_keys=True, separators=(",", ":"),
        ),
        expect_status="refused", expect_error_prefix="unsupported-version",
    )
    malformed = str(uuid.uuid4())
    journey.step(
        "refuses unexpected keys", "navigate",
        command_id=malformed,
        raw_payload=json.dumps(
            {"type": "command", "version": 1, "id": malformed, "action": "navigate",
             "target": "growth", "script": "rm -rf /"},
            sort_keys=True, separators=(",", ":"),
        ),
        expect_status="refused", expect_error_prefix="malformed-payload",
    )

    print("\nReset")
    journey.step("returns to a fresh synthetic field", "resetSyntheticState",
                 expect_state={"pairing": "unpaired", "screen": "fieldGuide", "rosterCount": 3})

    return report(journey, session)


# ------------------------------------------------------------------------ main


SUMMARY_KEYS = (
    "screen", "starter", "stage", "frameHeight", "weightComplete",
    "attunement", "encountersResolved", "drillsCompleted",
)


def print_summary(state: dict) -> None:
    """The bounded view an agent plays from."""
    for key in SUMMARY_KEYS:
        value = state.get(key, "-")
        print(f"  {key:<18} {value}")
    encounter = state.get("encounter")
    print(f"  {'encounter':<18} " + (
        f"{encounter['kind']} strength {encounter['strength']}, attunement {encounter['attunement']}, "
        f"{encounter['revealedNotes']} notes heard, {encounter['phase']}"
        if encounter else "none"
    ))
    training = state.get("training")
    print(f"  {'training':<18} " + (
        f"round {training['round'] + 1}/{training['rounds']}, {training['correct']} right, "
        f"intervals {training['intervals']}, {training['phase']}"
        if training else "none"
    ))
    proposal = state.get("proposal")
    print(f"  {'proposal':<18} " + (
        f"{proposal['id']} · {proposal['dimension']} · authoritative={proposal['authoritative']} "
        f"· appendable={proposal['appendable']}"
        if proposal else "none"
    ))
    print(f"  {'availableActions':<18} {', '.join(state.get('availableActions', []))}")


def play_demo(device: str, transport: str, timeout: float, fresh: bool) -> int:
    """A deterministic session an agent could have played from receipts alone."""
    print(f"\n{YELLOW}RAPPID Field play demo{RESET}")
    print(f"{DIM}device={device} transport={transport}{RESET}\n")

    boot(device)
    launch(device, autopilot=True, fresh=fresh, clipboard=transport == "clipboard")
    session = Session(device, transport=transport, timeout=timeout)
    session.resync()
    journey = Journey(session)

    def state_of(receipt: dict) -> dict:
        return receipt.get("state", {})

    print("Choosing a companion")
    opening = journey.step("reads the opening state", "snapshot")
    if state_of(opening).get("screen") == "onboarding":
        journey.check(
            "the opening state offers a starter",
            "selectStarter" in state_of(opening).get("availableActions", []),
            str(state_of(opening).get("availableActions")),
        )
        journey.step("selects Canopy", "selectStarter", target="canopy",
                     expect_state={"onboarding": "confirm"})
        journey.step("begins the field", "confirmStarter",
                     expect_state={"onboarding": "complete", "starter": "canopy"})
    else:
        journey.step("starts from a quiet field", "resetSyntheticState")
        journey.step("opens its own card", "openCard", target="canopy")

    print("\nListening")
    journey.step("opens the companion card", "openCard", target="canopy",
                 expect_state={"companion": "Mossline"})
    journey.step("plays the wake call", "playWakeCall", expect_state={"wakeCall": "playing"})
    journey.step("stops it", "stopWakeCall", expect_state={"wakeCall": "idle"})
    inspected = journey.step("inspects traits and stats", "inspectCompanion",
                             expect_state={"weightComplete": True})
    traits = state_of(inspected).get("traits", {})
    journey.check("traits are exact thousandths", bool(traits) and all(0 <= v <= 1000 for v in traits.values()), str(traits))

    journey.step("takes the leash off Observe", "setLeash", value="propose",
                 expect_state={"leash": "propose"})
    cold = journey.step("reads a proposal before playing", "requestProposal",
                        expect_state={"proposal.authoritative": False})
    cold_proposal = (state_of(cold).get("proposal") or {}).get("id")

    print("\nDiscovery encounter")
    receipt = journey.step("opens an encounter", "beginEncounter", expect_state={"encounter.phase": "open"})
    encounter = state_of(receipt).get("encounter", {})
    steps = 0
    while encounter.get("phase") == "open" and steps < 6:
        # Listen until the shape is known, then close. The receipt says
        # everything this choice needs.
        move = "approach" if encounter.get("revealedNotes", 0) >= 2 else "listen"
        receipt = journey.step(f"plays {move}", "encounterMove", target=move)
        encounter = state_of(receipt).get("encounter", {})
        steps += 1
    journey.check(
        "the encounter resolved",
        encounter.get("phase") in {"attuned", "faded", "withdrawn"},
        str(encounter),
    )
    print(f"    {DIM}outcome: {state_of(receipt).get('lastOutcome')}{RESET}")
    journey.step("leaves the signal", "leaveEncounter", expect_state={"encounter": ABSENT})

    print("\nTraining drill")
    receipt = journey.step("starts a drill", "beginTraining", expect_state={"training.phase": "answering"})
    for _ in range(6):
        drill = state_of(receipt).get("training", {})
        if drill.get("phase") != "answering":
            break
        shape = sum(drill.get("intervals", []))
        answer = "extend" if shape > 0 else ("invert" if shape < 0 else "echo")
        receipt = journey.step(f"answers {answer}", "trainingAnswer", target=answer)
    drill = state_of(receipt).get("training", {})
    journey.check(
        "the drill was played from its published intervals",
        drill.get("phase") == "complete" and drill.get("correct") == drill.get("rounds"),
        str(drill),
    )
    journey.step("puts the drill away", "endTraining", expect_state={"training": ABSENT})

    print("\nGrowth, still on the leash")
    journey.step("moves to Growth", "navigate", target="growth", expect_state={"screen": "growth"})
    journey.step("sets the leash to Run Approved", "setLeash", value="runApproved",
                 expect_state={"leash": "runApproved"})
    proposed = journey.step("asks for a reading again", "requestProposal",
                            expect_state={"proposal.authoritative": False})
    warm_proposal = (state_of(proposed).get("proposal") or {}).get("id")
    journey.check(
        "playing changed the reading but not its authority",
        cold_proposal is not None and warm_proposal is not None and cold_proposal != warm_proposal,
        f"cold={cold_proposal} warm={warm_proposal}",
    )
    journey.step("opens the confirmation", "openConfirmation",
                 expect_state={"confirmationVisible": True, "confirmationAcknowledged": False})
    journey.step("acknowledges it", "acknowledgeConfirmation",
                 expect_state={"confirmationAcknowledged": True})
    journey.step("is refused by the append policy", "approveAppend", expect_status="refused")
    journey.step("reopens the sheet", "openConfirmation", expect_state={"confirmationVisible": True})
    final = journey.step("cancels instead", "cancelAppend", expect_state={"confirmationVisible": False})

    print("\nFinal state")
    print_summary(state_of(final))

    return report(journey, session)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--device", default=DEFAULT_DEVICE)
    parser.add_argument("--transport", choices=("file", "clipboard"), default="file")
    parser.add_argument("--timeout", type=float, default=15.0)
    sub = parser.add_subparsers(dest="command", required=True)

    up = sub.add_parser("up", help="boot, install and launch")
    up.add_argument("--autopilot", action="store_true", help=f"launch with {ACTIVATION_KEY}=1")
    up.add_argument("--clipboard", action="store_true",
                    help="also read commands from the pasteboard (prompts on device)")
    up.add_argument("--app", default=str(DEFAULT_APP))

    send_parser = sub.add_parser("send", help="send one command and print its receipt")
    send_parser.add_argument("action")
    send_parser.add_argument("--target")
    send_parser.add_argument("--value")

    sub.add_parser("state", help="snapshot the app's semantic state")

    smoke_parser = sub.add_parser("smoke", help="run the deterministic smoke journey")
    smoke_parser.add_argument("--keep", action="store_true", help="do not reinstall first")

    play_parser = sub.add_parser("play-demo", help="play the game end to end from receipts alone")
    play_parser.add_argument("--keep", action="store_true", help="do not reinstall first")

    args = parser.parse_args()

    try:
        if args.command == "up":
            boot(args.device)
            install(args.device, pathlib.Path(args.app))
            launch(args.device, autopilot=args.autopilot, fresh=False, clipboard=args.clipboard)
            print(f"{GREEN}launched{RESET} {BUNDLE_ID} on {args.device}"
                  f"{' with autopilot enabled' if args.autopilot else ''}")
            return 0

        if args.command in ("send", "state"):
            action = "snapshot" if args.command == "state" else args.action
            session = Session(args.device, transport=args.transport, timeout=args.timeout)
            session.resync()
            receipt = session.send(
                action,
                target=getattr(args, "target", None),
                value=getattr(args, "value", None),
            )
            if args.command == "state":
                print_summary(receipt.get("state", {}))
                print()
            print(json.dumps(receipt, indent=2, sort_keys=True))
            return 0 if receipt.get("status") == "ok" else 2

        if args.command == "smoke":
            return smoke(args.device, args.transport, args.timeout, fresh=not args.keep)

        if args.command == "play-demo":
            return play_demo(args.device, args.transport, args.timeout, fresh=not args.keep)
    except AutopilotError as error:
        print(f"{RED}error{RESET} {error}", file=sys.stderr)
        return 3

    return 0


if __name__ == "__main__":
    sys.exit(main())
