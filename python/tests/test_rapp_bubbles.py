"""Synthetic only: run with --noconftest and a project-local --basetemp."""

import copy
import errno
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from rapp_bubbles.clients import NativeClient, NotSubmitted, RuntimeClient, SubmissionUnknown
from rapp_bubbles.config import Config, PortalError, MAX_FILE_BYTES, roster_digest
from rapp_bubbles.files import copy_reference
from rapp_bubbles.outbox import Outbox
from rapp_bubbles.portal import Portal, addressed, HELP
from rapp_bubbles.source import SQLiteSource
from rapp_bubbles.state import Store


SENDER = "owner@example.invalid"
CHAT = "iMessage;-;synthetic-owner"
ACTOR = {"sender": SENDER, "chat": CHAT}
TARGET = {"chat_id": 1, "chat_guid": CHAT}


def synthetic_job(index):
    return f"20260101-000000-{index:032x}"


JOB1 = synthetic_job(1)


class Clock:
    def __init__(self):
        self.now = 1900000000.0

    def __call__(self):
        return self.now

    def advance(self, seconds=2):
        self.now += seconds


def message(index=1, text="RAPP inspect these files", **changes):
    value = {
        "id": index, "guid": f"SYNTHETIC-{index}", "text": text,
        "sender": SENDER, "chat_id": 1, "chat_guid": CHAT, "service": "iMessage",
        "is_group": False, "is_from_me": False, "chat_style": 45,
        "participants": [SENDER], "has_attachments": False,
    }
    value.update(changes)
    return value


class Source:
    def __init__(self):
        self.events = []
        self.attachment_reads = 0
        self.targets = {1: CHAT}
        self.prior_guids = {}
        self.between_rows = []

    def latest_prior_guid(self, event):
        return self.prior_guids.get(event["chat_guid"])

    def between(self, _chat_guid, _after, _before):
        # None: the reader cannot vouch for the gap (too many rows, an unknown row).
        return None if self.between_rows is None else list(self.between_rows)

    def tail(self):
        return 0

    def poll(self, _cursor, floor):
        return [event for event in self.events if event["id"] > floor]

    def attachments(self, event):
        self.attachment_reads += 1
        return next(item for item in self.events if item["guid"] == event["guid"]).get("attachments", [])

    def target_matches(self, target):
        return self.targets.get(target["chat_id"]) == target["chat_guid"]


class Native:
    def __init__(self, clock, source):
        self.clock, self.source = clock, source
        self.calls = []
        self.messages = []
        self.states = {}
        self.errors = []
        self.history_calls = []
        self.decode_calls = []
        self.decoded = {}

    def decode_text(self, event, actor):
        self.decode_calls.append((event["guid"], actor))
        if event["guid"] not in self.decoded:
            raise PortalError("text_decode_unavailable", "Synthetic native decoder is not ready.")
        return self.decoded[event["guid"]]

    def send(self, chat_id, *, text="", file=""):
        self.calls.append({"chat_id": chat_id, "text": text, "file": file})
        if self.errors:
            error = self.errors.pop(0)
            if error:
                raise error
        guid = f"OUTGOING-{len(self.calls)}"
        attachments = []
        caption_guid = f"CAPTION-{len(self.calls)}"
        if file:
            assert text.strip(), "Outbox file parts should carry their identifying caption."
            self.messages.append({
                "id": len(self.messages) + 1,
                "guid": caption_guid, "chat_id": chat_id, "chat_guid": self.source.targets[chat_id],
                "is_from_me": True, "text": text, "attachments": [],
                "created_at": datetime.fromtimestamp(self.clock(), timezone.utc).isoformat(),
            })
            self.states[caption_guid] = "delivered"
            # Native image transcoding is allowed to change the byte count.
            attachments = [{
                "transfer_name": Path(file).name,
                "original_path": "/synthetic-native-store/" + Path(file).name,
                "total_bytes": Path(file).stat().st_size + 471,
            }]
        self.messages.append({
            "id": len(self.messages) + 1,
            "guid": guid, "chat_id": chat_id, "chat_guid": self.source.targets[chat_id],
            "is_from_me": True, "text": "" if file else text, "attachments": attachments,
            "created_at": datetime.fromtimestamp(self.clock(), timezone.utc).isoformat(),
        })
        self.states[guid] = "delivered"
        self.source.prior_guids[self.source.targets[chat_id]] = guid
        if hasattr(self.source, "sent"):
            self.source.sent(self.source.targets[chat_id], *([caption_guid] if file else []), guid)
        return {"ok": True, "guid": caption_guid if file else guid}

    def history(self, chat_id, since, until):
        self.history_calls.append((chat_id, since))
        return list(self.messages)

    def status(self, guid):
        return {
            "ok": True, "guid": guid, "send_state": self.states.get(guid, "pending"),
            "service": "iMessage", "status_fields": {"error": 0},
        }


class Runtime:
    def __init__(self, clock, root):
        self.clock, self.root = clock, root
        self.calls = []
        self.jobs = {}
        self.requests = {}
        self.outputs = {}
        self.errors = []
        self.approval_ttl = 300

    def profile_policy(self, _profile):
        return {"available_tools": ["view", "glob", "rg"], "add_dirs": []}

    def request(self, request):
        self.calls.append(copy.deepcopy(request))
        if self.errors:
            error = self.errors.pop(0)
            if error:
                raise error
        operation = request["op"]
        if operation == "submit":
            job_id = self.requests.setdefault(request["request_id"], synthetic_job(len(self.requests) + 1))
            job = self.jobs.setdefault(job_id, {
                "job_id": job_id, "status": "pending_approval",
                "request_id": request["request_id"], "profile": request["profile"],
                "artifact_paths": list(request["artifact_paths"]), "model": "gpt-6-astra",
            })
            return {
                "ok": True, "job": dict(job),
                "approval": {"token": "finite-" + job_id, "expires_at": self.clock() + self.approval_ttl},
            }
        if operation in ("list", "recover"):
            return {"ok": True, "jobs": list(self.jobs.values())}
        job = self.jobs[request["job_id"]]
        if operation == "approve":
            assert request["approval_token"] == "finite-" + request["job_id"]
            job["status"] = "running"
        if operation == "cancel":
            job["status"] = "cancelled"
        terminal = job["status"] in ("succeeded", "failed", "cancelled", "expired", "interrupted")
        result = None
        if operation == "result" and terminal:
            result = {
                "status": job["status"], "exit_code": 0 if job["status"] == "succeeded" else 1,
                "response": "Synthetic worker output.", "response_truncated": False,
                "error": {"code": "synthetic_failure", "message": "Synthetic failure."} if job["status"] == "failed" else None,
                "artifacts": self.outputs.get(request["job_id"], []),
            }
        return {
            "ok": True, "job": dict(job),
            "stdout": {"text": "Synthetic worker output.", "next_offset": 24, "total_bytes": 24},
            "stderr": {"text": "", "next_offset": 0, "total_bytes": 0},
            "events": [{"id": request["job_id"] + ":1"}], "next_event_offset": 1,
            "worker_active": job["status"] == "running", "result": result,
        }


@pytest.fixture
def env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("OPENRAPPTER_HOME", str(home / "unused-framework"))
    # Unexpected errors surface in tests; quarantine tests turn this off to exercise it.
    monkeypatch.setenv("RAPP_BUBBLES_STRICT", "1")
    incoming = tmp_path / "incoming"
    incoming.mkdir()
    jobs = tmp_path / "jobs"
    jobs.mkdir()
    raw = {
        "state_dir": str(tmp_path / "state"), "messages_db": str(tmp_path / "chat.db"),
        "imsg_path": str(tmp_path / "fake-imsg"),
        "runtime_argv": [sys.executable, str(tmp_path / "fake-runtime.py"), "--portal-config", str(tmp_path / "runtime.json")],
        "incoming_roots": [str(incoming)], "artifact_root": str(jobs),
        "authorized": [{"sender": SENDER, "chat": CHAT}],
        "profile": "synthetic-workspace",
        "artifact_paths": [],
        "stable_seconds": 1, "progress_seconds": 30,
    }
    clock, source = Clock(), Source()
    native, runtime = Native(clock, source), Runtime(clock, jobs)
    value = SimpleNamespace(
        root=tmp_path, incoming=incoming, jobs=jobs, raw=raw, clock=clock,
        source=source, native=native, runtime=runtime,
    )
    value.config = lambda: Config.from_dict(raw)
    value.portal = lambda: Portal(value.config(), source=source, native=native, runtime=runtime, clock=clock)
    return value


def state(env):
    return json.loads((Path(env.raw["state_dir"]) / "transport.json").read_text())


def attachment(env, name="photo.png", mime="image/png", *, exists=True, **changes):
    path = env.incoming / name
    if exists:
        path.write_bytes(("synthetic " + name).encode())
    value = {
        "original_path": str(path), "transfer_name": name, "mime_type": mime,
        "total_bytes": path.stat().st_size if exists else 0, "missing": not exists,
    }
    value.update(changes)
    return value


def submitted(env):
    return [request for request in env.runtime.calls if request["op"] == "submit"]


def add_output(env, job_id, suffix=".png"):
    index = len(env.runtime.outputs.get(job_id, []))
    path = env.jobs / job_id / "artifacts" / f"{job_id}-{index:02d}-result{suffix}"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"deliberately emitted synthetic output")
    item = {
        "id": f"{job_id}:artifact:{index}", "path": str(path),
        "name": "result" + suffix, "mime": {".png": "image/png", ".mp4": "video/mp4", ".m4a": "audio/mp4", ".txt": "text/plain"}[suffix],
        "size_bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }
    env.runtime.outputs.setdefault(job_id, []).append(item)
    return item


def enqueue_native_test_batch(env, outbox, suffixes):
    exports = [add_output(env, JOB1, suffix) for suffix in suffixes]
    artifacts = [{**item, "relative_path": Path(item["path"]).name} for item in exports]
    outbox.enqueue(
        "native-test-batch", ACTOR, TARGET, "Synthetic result.",
        artifacts=artifacts, workspace=env.jobs / JOB1 / "artifacts",
        declared=tuple(item["relative_path"] for item in artifacts), job_id=JOB1,
    )


def test_import_and_help_do_not_load_brainstem(env):
    process = subprocess.run(
        [sys.executable, "-c",
         "import sys; sys.path.insert(0,sys.argv[1]); import rapp_bubbles.portal; "
         "assert not any('brainstem' in name or name.startswith('openrappter') for name in sys.modules)",
         str(SCRIPTS)], capture_output=True, text=True, timeout=10,
    )
    assert process.returncode == 0, process.stderr
    process = subprocess.run(
        [sys.executable, str(SCRIPTS / "rapp-bubbles.py"), "--help"],
        capture_output=True, text=True, timeout=10,
    )
    assert process.returncode == 0
    assert "run" not in process.stdout.split("choices=")[-1] or "tick" in process.stdout
    assert not env.runtime.calls and not env.native.calls


@pytest.mark.parametrize("changes", [
    {"sender": "stranger@example.invalid"}, {"chat_guid": "iMessage;-;another"},
    {"service": "SMS"}, {"service": "RCS"}, {"is_from_me": True},
    {"is_from_me": "false"}, {"chat_style": None},
    {"is_group": True, "chat_style": 43, "chat_guid": "iMessage;+;group"},
])
def test_authorization_precedes_attachment_queries(env, changes):
    env.source.events.append(message(has_attachments=True, attachments=[{"original_path": "/not-read"}], **changes))
    env.portal().tick()
    assert env.source.attachment_reads == 0
    assert not env.runtime.calls and not env.native.calls


def test_explicit_group_and_self_chat_policy(env):
    env.raw["authorized"].extend([
        {"sender": SENDER, "chat": "iMessage;+;test-group", "allow_group": True},
        {"sender": SENDER, "chat": "iMessage;-;self", "allow_from_me": True},
    ])
    portal = env.portal()
    assert portal.authorize(message(
        chat_id=2, chat_guid="iMessage;+;test-group", is_group=True, chat_style=43,
    ))
    assert portal.authorize(message(
        chat_id=3, chat_guid="iMessage;-;self", is_from_me=True, sender="",
    ))
    assert portal.authorize(message(
        chat_id=3, chat_guid="iMessage;-;self", is_from_me=True, participants=[SENDER, "other@example.invalid"],
    )) is None


@pytest.mark.parametrize("text", ["hello Claude", "restart", "wake up", "shut down", "fresh start", "reboot"])
def test_other_ai_and_lifecycle_messages_are_untouched(env, text):
    env.source.events.append(message(text=text))
    env.portal().tick()
    assert not env.runtime.calls and not env.native.calls


def test_existing_watcher_guard_owns_only_rapp_addressed_text(env):
    hook = SCRIPTS / "imessage-portal-watcher-hook.sh"
    for text, wanted in [("RAPP restart the fixture worker", 0), ("rapp: help", 0), ("restart", 1), ("Claude do this", 1)]:
        process = subprocess.run(
            ["bash", "-c", 'source "$1"; imessage_portal_owns_text "$2"', "test", str(hook), text],
            capture_output=True, timeout=5,
        )
        assert process.returncode == wanted
        assert addressed(text) == (wanted == 0)
    echoed = "[RAPP synthetic-notice]\nUse restart to wake Claude, not to run another portal job."
    process = subprocess.run(
        ["bash", "-c", 'source "$1"; imessage_portal_owns_text "$2"', "test", str(hook), echoed],
        capture_output=True, timeout=5,
    )
    assert process.returncode == 0
    assert not addressed(echoed)


def test_submit_is_guid_idempotent_across_restart_and_never_autoapproves(env):
    env.source.events.append(message(text="RAPP run a synthetic task"))
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    assert len(submitted(env)) == 1
    assert not [request for request in env.runtime.calls if request["op"] == "approve"]
    assert all(call.get("profile") != "admin" for call in env.runtime.calls)
    assert stat_mode(Path(env.raw["state_dir"]) / "transport.json") == 0o600


def stat_mode(path):
    return path.stat().st_mode & 0o777


def test_all_four_mimes_mixed_multiple_files_are_staged_not_executed(env):
    attachments = [
        attachment(env, name, mime)
        for name, mime in [("image.png", "image/png"), ("video.mp4", "video/mp4"),
                           ("audio.m4a", "audio/mp4"), ("document.txt", "text/plain")]
    ]
    attachments[0]["approval_token"] = "untrusted metadata cannot approve"
    for item in attachments:
        Path(item["original_path"]).chmod(0o644)
        assert Path(item["original_path"]).stat().st_nlink == 1
    env.source.events.append(message(has_attachments=True, attachments=attachments))
    env.portal().tick()
    assert not submitted(env)
    env.clock.advance()
    env.portal().tick()
    request = submitted(env)[0]
    assert len(request["attachments"]) == 4
    assert {item["mime"] for item in request["attachments"]} == {"image/png", "video/mp4", "audio/mp4", "text/plain"}
    assert all(Path(item["path"]).is_relative_to(Path(env.raw["state_dir"]) / "inbox") for item in request["attachments"])
    assert all(stat_mode(Path(item["path"])) == 0o600 for item in request["attachments"])
    assert "approval_token" not in request
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]


def test_file_only_requires_explicit_context_and_survives_delayed_download(env):
    item = attachment(env, exists=False)
    env.source.events.append(message(text="", has_attachments=True, attachments=[item]))
    env.portal().tick()
    assert env.source.attachment_reads == 0
    env.source.events.extend([
        message(2, "RAPP attach"),
        message(3, "", has_attachments=True, attachments=[item]),
        message(4, "RAPP describe the selected upload"),
    ])
    env.portal().tick()
    assert not submitted(env)
    env.clock.advance(10)
    Path(item["original_path"]).write_bytes(b"synthetic late download")
    env.portal().tick()
    env.clock.advance()
    env.portal().tick()
    assert len(submitted(env)) == 1
    assert len(submitted(env)[0]["attachments"]) == 1
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]


def test_missing_file_times_out_with_explicit_failure_and_no_task(env):
    env.source.events.append(message(has_attachments=True, attachments=[attachment(env, exists=False)]))
    env.portal().tick()
    env.clock.advance(121)
    env.portal().tick()
    assert not submitted(env)
    assert any("attachment_timeout" in call["text"] for call in env.native.calls)
    assert next(iter(state(env)["inbox"].values()))["state"] == "failed"


@pytest.mark.parametrize("kind", ["oversize", "outside", "symlink", "parent-symlink", "traversal"])
def test_unsafe_or_oversize_input_is_explicitly_rejected(env, kind):
    item = attachment(env)
    if kind == "oversize":
        item["total_bytes"] = MAX_FILE_BYTES + 1
    elif kind == "outside":
        path = env.root / "private-config"
        path.write_text("must not be staged")
        item["original_path"] = str(path)
    elif kind == "symlink":
        link = env.incoming / "link"
        link.symlink_to(Path(item["original_path"]))
        item["original_path"] = str(link)
    elif kind == "parent-symlink":
        link = env.incoming / "linked-directory"
        link.symlink_to(env.incoming, target_is_directory=True)
        item["original_path"] = str(link / "photo.png")
    else:
        item["original_path"] = str(env.incoming / ".." / "incoming" / "photo.png")
    env.source.events.append(message(has_attachments=True, attachments=[item]))
    env.portal().tick()
    assert not submitted(env)
    assert next(iter(state(env)["inbox"].values()))["state"] == "failed"
    assert any("could not complete" in call["text"] for call in env.native.calls)


def test_numeric_approval_is_bound_to_sender_chat_job_and_receipt(env):
    other = "iMessage;-;other-authorized-thread"
    env.raw["authorized"].append({"sender": SENDER, "chat": other})
    env.source.targets[2] = other
    env.source.events.append(message())
    env.portal().tick()
    env.clock.advance(10)
    env.source.events.append(message(2, "1", chat_id=2, chat_guid=other))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]
    env.source.events.append(message(3, "1"))
    env.portal().tick()
    approvals = [call for call in env.runtime.calls if call["op"] == "approve"]
    assert len(approvals) == 1 and approvals[0]["actor"] == ACTOR
    env.portal().tick()
    assert len([call for call in env.runtime.calls if call["op"] == "approve"]) == 1


def approval_part(env, job_id=JOB1):
    return next(part for part in state(env)["outbox"] if part["group"] == f"job:{job_id}:approval")


def test_a_bare_digit_approves_only_the_approval_card_it_sits_under(env):
    job2 = synthetic_job(2)
    env.source.events.extend([message(), message(2, "RAPP another task")])
    env.portal().tick()
    env.clock.advance(10)
    env.source.events.append(message(3, "1"))
    env.portal().tick()
    assert [call["job_id"] for call in env.runtime.calls if call["op"] == "approve"] == [job2]
    env.clock.advance(10)
    # A swipe-reply names the older card, even though job 2's card is the row above.
    env.source.events.append(message(4, "1", reply_to=approval_part(env)["guid"]))
    env.portal().tick()
    assert [call["job_id"] for call in env.runtime.calls if call["op"] == "approve"] == [job2, JOB1]


def test_expired_numeric_approval_cannot_run_a_task(env):
    env.source.events.append(message())
    env.portal().tick()
    env.clock.advance(301)
    env.source.events.append(message(2, "1"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]


@pytest.mark.parametrize("suffix", [".png", ".mp4", ".m4a", ".txt"])
def test_explicit_output_transports_each_media_type_and_accepts_native_transcoding(env, suffix):
    env.source.events.append(message(text=f"RAPP file result{suffix} | create synthetic media"))
    env.portal().tick()
    add_output(env, JOB1, suffix)
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    for _ in range(6):
        env.clock.advance(10)
        env.portal().tick()
    media = [call for call in env.native.calls if call["file"]]
    assert len(media) == 1
    assert all(call["text"].startswith("[RAPP artifact ") for call in media)
    assert all(Path(call["file"]).is_relative_to(Path(env.raw["state_dir"]) / "outbox") for call in media)
    parts = [part for part in state(env)["outbox"] if "file" in part]
    assert {part["state"] for part in parts} == {"delivered"}
    assert all(part["guid"] != part["caption_guid"] for part in parts)
    assert all(chat == 1 for chat, _ in env.native.history_calls)


def test_intentionally_declared_artifacts_only(env):
    env.source.events.append(message(text="RAPP file result.png | create synthetic media"))
    env.portal().tick()
    artifact = add_output(env, JOB1)
    artifact["name"] = "secret.txt"
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(10)
    env.portal().tick()
    assert not [call for call in env.native.calls if call["file"]]
    assert state(env)["jobs"][JOB1]["error"] == "artifact_undeclared"


def test_outbox_partial_retry_never_duplicates_successful_parts(env):
    config = env.config()
    with Store(config.state_dir) as store:
        outbox = Outbox(config, store, env.native, env.clock, env.source.target_matches)
        outbox.enqueue("ordered", ACTOR, TARGET, "a" * 2500, job_id="job-test")
        env.native.errors = [None, NotSubmitted("offline", "synthetic pre-send failure")]
        outbox.pump()
        assert [part["state"] for part in outbox.parts("ordered")] == ["submitted", "failed"]
        assert len(env.native.calls) == 2
    with Store(config.state_dir) as store:
        outbox = Outbox(config, store, env.native, env.clock, env.source.target_matches)
        env.clock.advance(10)
        assert outbox.retry(ACTOR, "job-test") == 1
        outbox.pump()
        assert len(env.native.calls) == 3
        assert env.native.calls[0]["text"] != env.native.calls[2]["text"]


def test_unknown_submission_is_not_retried_after_restart(env):
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        outbox.enqueue("uncertain", ACTOR, TARGET, "one message", job_id="job-test")
        env.native.errors = [SubmissionUnknown("timeout", "synthetic uncertain send")]
        outbox.pump()
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        env.clock.advance(10)
        assert outbox.retry(ACTOR, "job-test") == 0
        outbox.pump()
        assert len(env.native.calls) == 1
        assert outbox.parts("uncertain")[0]["state"] == "unknown"
        assert outbox.retry(ACTOR, "job-test", uncertain_part=outbox.parts("uncertain")[0]["id"]) == 1
        outbox.pump()
        assert len(env.native.calls) == 2


def test_receipt_correlation_requires_chat_outgoing_unique_filename_and_window(env):
    artifact_path = env.jobs / "job-test" / "workspace" / "artifacts/result.png"
    artifact_path.parent.mkdir(parents=True)
    artifact_path.write_bytes(b"synthetic png")
    manifest = {
        "relative_path": "artifacts/result.png", "path": str(artifact_path), "name": "result.png",
        "size_bytes": 13, "sha256": hashlib.sha256(b"synthetic png").hexdigest(), "mime": "image/png",
    }
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        outbox.enqueue(
            "file", ACTOR, TARGET, "", artifacts=[manifest], workspace=artifact_path.parents[1],
            declared=("artifacts/result.png",), job_id="job-test",
        )
        outbox.pump()
        part = outbox.parts("file")[0]
        real = copy.deepcopy(next(m for m in env.native.messages if m["attachments"]))
        env.native.messages = [
            {**real, "guid": "WRONG-CHAT", "chat_id": 2, "chat_guid": "iMessage;-;different"},
            {**real, "guid": "INCOMING", "is_from_me": False},
            {**real, "guid": "OLD", "created_at": "2001-01-01T00:00:00Z"},
            {**real, "guid": "BEFORE-WATERMARK", "id": 0},
        ]
        env.clock.advance(10)
        outbox.pump()
        assert "guid" not in part and part["state"] == "submitted"
        env.native.messages.append(real)
        env.clock.advance(10)
        outbox.pump()
        assert part["guid"] == real["guid"] and part["state"] == "delivered"


def test_corrupt_state_fails_closed_instead_of_resetting_cursor(env):
    env.portal().tick()
    path = Path(env.raw["state_dir"]) / "transport.json"
    path.write_text("corrupt")
    with pytest.raises(PortalError, match="refusing to reset"):
        env.portal().tick()
    assert not env.runtime.calls


def test_no_configurable_file_limit_can_exceed_100_mib(env):
    env.raw["max_file_bytes"] = MAX_FILE_BYTES + 1
    with pytest.raises(PortalError):
        env.config()


def make_database(env):
    db = sqlite3.connect(env.raw["messages_db"])
    db.executescript("""
        CREATE TABLE message (
          ROWID INTEGER PRIMARY KEY,guid TEXT,text TEXT,attributedBody BLOB,date INTEGER,
          is_from_me INTEGER,service TEXT,handle_id INTEGER,cache_has_attachments INTEGER,
          associated_message_guid TEXT,associated_message_type INTEGER,is_audio_message INTEGER DEFAULT 0
        );
        CREATE TABLE chat (
          ROWID INTEGER PRIMARY KEY,guid TEXT,style INTEGER,service_name TEXT,
          chat_identifier TEXT,display_name TEXT
        );
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY,id TEXT);
        CREATE TABLE chat_message_join (message_id INTEGER,chat_id INTEGER);
        CREATE TABLE chat_handle_join (chat_id INTEGER,handle_id INTEGER);
        CREATE TABLE attachment (
          ROWID INTEGER PRIMARY KEY,filename TEXT,transfer_name TEXT,mime_type TEXT,uti TEXT,total_bytes INTEGER
        );
        CREATE TABLE message_attachment_join (message_id INTEGER,attachment_id INTEGER);
    """)
    db.execute("INSERT INTO chat VALUES(1,?,45,'iMessage',?,'Synthetic')", (CHAT, SENDER))
    db.execute("INSERT INTO handle VALUES(1,?)", (SENDER,))
    db.execute("INSERT INTO chat_handle_join VALUES(1,1)")
    db.commit()
    return db


def insert_message(db, index, text="RAPP help", guid=None):
    db.execute(
        "INSERT INTO message(ROWID,guid,text,attributedBody,date,is_from_me,service,handle_id,cache_has_attachments) "
        "VALUES(?,?,?,NULL,1,0,'iMessage',1,0)", (index, guid or f"G-{index}", text),
    )
    db.execute("INSERT INTO chat_message_join VALUES(?,1)", (index,))
    db.commit()


@pytest.mark.parametrize("old_body", ["plain", "attributed"])
def test_real_reader_uses_only_synthetic_db_and_does_not_replay_preinstall_history(env, old_body):
    db = make_database(env)
    insert_message(db, 1, "RAPP old task must not run" if old_body == "plain" else None)
    if old_body == "attributed":
        db.execute(
            "UPDATE message SET attributedBody=? WHERE ROWID=1",
            (b"\xff\xfe" + "RAPP old task must not run".encode("utf-16-le"),),
        )
        db.commit()
    portal = Portal(env.config(), runtime=env.runtime, native=env.native, clock=env.clock)
    portal.tick()
    assert not env.native.calls and not env.runtime.calls
    assert not env.native.decode_calls
    insert_message(db, 2)
    portal.tick()
    assert any("RAPP <task>" in call["text"] for call in env.native.calls)
    assert not submitted(env)
    db.close()


def test_late_chat_join_is_not_lost_to_watermark(env):
    db = make_database(env)
    source = SQLiteSource(env.config())
    db.execute(
        "INSERT INTO message(ROWID,guid,text,attributedBody,date,is_from_me,service,handle_id,cache_has_attachments) "
        "VALUES(1,'LATE','RAPP help',NULL,1,0,'iMessage',1,0)"
    )
    insert_message(db, 2)
    assert [event["id"] for event in source.poll(0, 0)] == [2]
    db.execute("INSERT INTO chat_message_join VALUES(1,1)")
    db.commit()
    assert [event["id"] for event in source.poll(2, 0)] == [1, 2]
    source.close()
    db.close()


def test_private_adapter_argv_and_single_json_request(env):
    script = env.root / "fake-runtime.py"
    script.write_text(
        "import json,sys\n"
        "assert sys.argv[1]=='--portal-config'\n"
        "request=json.load(sys.stdin)\n"
        "print(json.dumps({'ok':True,'observed':request}))\n"
    )
    result = RuntimeClient(env.config()).request({"op": "status", "actor": ACTOR, "job_id": "synthetic"})
    assert result["observed"]["actor"] == ACTOR


def test_native_rpc_is_explicit_imessage_applescript_and_version_pinned(env):
    script = Path(env.raw["imsg_path"])
    script.write_text(
        "#!" + sys.executable + "\n"
        "import json,sys\n"
        "if sys.argv[1]=='--version':\n print('0.12.3');sys.exit(0)\n"
        "assert sys.argv[1:3]==['rpc','--db'] and sys.argv[-1]=='--json'\n"
        "request=json.loads(sys.stdin.readline())\n"
        "p=request['params']\n"
        "assert p['service']=='imessage' and p['transport']=='applescript'\n"
        "print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'ok':True}}),flush=True)\n"
    )
    script.chmod(0o700)
    assert NativeClient(env.config()).send(
        1, text="[RAPP synthetic artifact] fixture", file="/synthetic/never-sent.txt",
    ) == {"ok": True}
    script.write_text("#!" + sys.executable + "\nprint('0.5.0')\n")
    with pytest.raises(NotSubmitted, match="pinned"):
        NativeClient(env.config()).send(1, text="never sent")


def test_file_only_native_client_preserves_unknown_semantics(env):
    script = Path(env.raw["imsg_path"])
    script.write_text(
        "#!" + sys.executable + "\nimport sys,json\n"
        "if sys.argv[1]=='--version':\n print('0.12.3');sys.exit(0)\n"
        "request=json.loads(sys.stdin.readline())\n"
        "assert request['params']['text']=='' and request['params']['file']\n"
        "print(json.dumps({'jsonrpc':'2.0','id':1,'error':{'code':-32603,"
        "'data':'synthetic row has not joined its chat yet'}}),flush=True)\n"
    )
    script.chmod(0o700)
    with pytest.raises(SubmissionUnknown):
        NativeClient(env.config()).send(1, file="/synthetic/never-sent.m4a")


def test_native_timeout_is_ambiguous_not_retried(env):
    script = Path(env.raw["imsg_path"])
    script.write_text(
        "#!" + sys.executable + "\nimport sys,time\n"
        "if sys.argv[1]=='--version':\n print('0.12.3');sys.exit(0)\n"
        "sys.stdin.readline()\ntime.sleep(3)\n"
    )
    script.chmod(0o700)
    env.raw["native_timeout"] = 0.1
    with pytest.raises(SubmissionUnknown):
        NativeClient(env.config()).send(1, text="synthetic only")


def test_native_ghost_row_error_is_unknown_not_a_safe_retry(env):
    script = Path(env.raw["imsg_path"])
    script.write_text(
        "#!" + sys.executable + "\nimport sys,json\n"
        "if sys.argv[1]=='--version':\n print('0.12.3');sys.exit(0)\n"
        "request=json.loads(sys.stdin.readline())\n"
        "print(json.dumps({'jsonrpc':'2.0','id':1,'error':"
        "{'code':-32603,'data':'synthetic unjoined empty outgoing row'}}),flush=True)\n"
    )
    script.chmod(0o700)
    with pytest.raises(SubmissionUnknown):
        NativeClient(env.config()).send(1, text="synthetic caption", file="/synthetic/audio.m4a")


def test_regular_file_actual_size_cannot_bypass_declared_byte_limit(env):
    env.raw["max_file_bytes"] = 128
    item = attachment(env, total_bytes=0)
    Path(item["original_path"]).write_bytes(b"x" * 129)
    env.source.events.append(message(has_attachments=True, attachments=[item]))
    env.portal().tick()
    assert next(iter(state(env)["inbox"].values()))["error"] == "file_too_large"
    assert not submitted(env)


def test_interrupted_submission_is_unknown_on_restart(env):
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        outbox.enqueue("crash", ACTOR, TARGET, "synthetic output", job_id="job-test")
        env.native.errors = [SystemExit("simulated process interruption")]
        with pytest.raises(SystemExit):
            outbox.pump()
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        outbox.pump()
        assert outbox.parts("crash")[0]["state"] == "unknown"
        assert len(env.native.calls) == 1


def test_file_echo_and_caption_echo_are_suppressed_but_remote_repeat_is_not(env):
    env.source.events.append(message(text="RAPP file result.png | create synthetic media"))
    env.portal().tick()
    add_output(env, JOB1)
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(10)
    env.portal().tick()
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        part = next(part for part in store.data["outbox"] if "file" in part)
        file_metadata = [{"transfer_name": Path(part["file"]["path"]).name}]
        echo = message(10, "", is_from_me=True)
        assert outbox.is_echo(echo, file_metadata)
        assert outbox.is_echo(message(11, part["caption"], is_from_me=True))
        assert not outbox.is_echo(message(12, ""), file_metadata)


def test_ambiguous_approval_is_reconciled_without_resubmission(env):
    env.source.events.append(message())
    env.portal().tick()
    env.clock.advance(10)
    original = env.runtime.request

    def request(value):
        result = original(value)
        if value["op"] == "approve":
            raise SubmissionUnknown("adapter_interrupted", "synthetic post-approval interruption")
        return result

    env.runtime.request = request
    env.source.events.append(message(2, "1"))
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    assert len([call for call in env.runtime.calls if call["op"] == "approve"]) == 1
    assert state(env)["jobs"][JOB1]["state"] == "running"


def test_repeated_result_does_not_duplicate_delivered_files(env):
    env.source.events.append(message(text="RAPP file result.png | create synthetic media"))
    env.portal().tick()
    add_output(env, JOB1)
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(10)
    env.portal().tick()
    env.clock.advance(10)
    env.source.events.append(message(2, "RAPP result"))
    env.portal().tick()
    assert len([call for call in env.native.calls if call["file"]]) == 1


def test_artifact_manifest_cannot_cross_job_workspace(env):
    env.source.events.append(message(text="RAPP file result.png | create synthetic media"))
    env.portal().tick()
    item = add_output(env, JOB1)
    other = env.jobs / "some-other-job" / "artifacts"
    item["path"] = str(other / Path(item["path"]).name)
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(10)
    env.portal().tick()
    assert state(env)["jobs"][JOB1]["error"] == "artifact_unconfined"
    assert not [call for call in env.native.calls if call["file"]]


def test_transport_lock_prevents_two_ticks(env):
    with Store(env.config().state_dir):
        with pytest.raises(PortalError, match="already has a portal tick"):
            env.portal().tick()
    assert not env.native.calls and not env.runtime.calls


def test_running_task_keeps_sending_bounded_eta_updates_without_fabricated_completion(env):
    env.source.events.append(message())
    env.portal().tick()
    env.runtime.jobs[JOB1]["status"] = "running"
    for _ in range(10):
        env.clock.advance(60)
        env.portal().tick()
    updates = [call["text"] for call in env.native.calls[1:]]
    assert 1 <= len(updates) <= 4
    for text in updates:
        first = text.splitlines()[0]
        assert first.startswith("[RAPP 0001] ● ") and "no ETA yet" in text
        assert "[1] Details\n[2] Stop\n[3] Quiet" in text and "Done" not in first
    assert state(env)["jobs"][JOB1]["state"] == "running"
    assert not state(env)["jobs"][JOB1]["final_queued"]


def test_object_replacement_body_is_file_only_not_silently_ignored(env):
    env.source.events.extend([
        message(1, "RAPP attach"),
        message(2, " \ufffc ", has_attachments=True, attachments=[attachment(env)]),
    ])
    env.portal().tick()
    env.clock.advance()
    env.portal().tick()
    assert not submitted(env)
    assert any("Saved 1 attachment" in call["text"] for call in env.native.calls)


def test_null_plain_text_uses_native_decode_and_retries_durably(env):
    db = make_database(env)
    with Store(env.config().state_dir) as store:
        store.data["cursor"] = store.data["floor"] = 0
        store.save()
    insert_message(db, 1, None)
    db.execute("UPDATE message SET attributedBody=? WHERE ROWID=1", (b"opaque native attributed body",))
    db.commit()
    Portal(env.config(), runtime=env.runtime, native=env.native, clock=env.clock).tick()
    assert not submitted(env)
    assert next(iter(state(env)["inbox"].values()))["state"] == "decoding"
    env.native.decoded["G-1"] = "RAPP inspect this native-decoded phone text"
    env.clock.advance(10)
    Portal(env.config(), runtime=env.runtime, native=env.native, clock=env.clock).tick()
    assert len(submitted(env)) == 1
    assert submitted(env)[0]["prompt"] == "inspect this native-decoded phone text"
    db.close()


def test_sql_reader_filters_sender_and_service_before_returning_bodies(env):
    db = make_database(env)
    db.execute("INSERT INTO handle VALUES(2,'stranger@example.invalid')")
    insert_message(db, 1, "RAPP unauthorized")
    insert_message(db, 2, "RAPP spoofed sms")
    insert_message(db, 3, "RAPP authorized")
    db.execute("UPDATE message SET handle_id=2 WHERE ROWID=1")
    db.execute("UPDATE message SET service='SMS' WHERE ROWID=2")
    db.commit()
    source = SQLiteSource(env.config())
    assert [event["id"] for event in source.poll(0, 0)] == [3]
    with pytest.raises(sqlite3.OperationalError):
        source.db.execute("DELETE FROM message")
    source.close()
    db.close()


@pytest.mark.parametrize("bad", [7, {"path": "not-a-string"}, "bad\0path"])
def test_malformed_native_path_cannot_poison_the_watch_loop(env, bad):
    item = attachment(env)
    item["original_path"] = bad
    env.source.events.append(message(has_attachments=True, attachments=[item]))
    env.portal().tick()
    assert next(iter(state(env)["inbox"].values()))["error"] == "attachment_metadata"
    assert not submitted(env)


def test_nonzero_adapter_exit_preserves_a_structured_rejection(env):
    script = env.root / "fake-runtime.py"
    script.write_text(
        "import json,sys\njson.load(sys.stdin)\n"
        "print(json.dumps({'ok':False,'error':{'code':'approval_expired'}}))\n"
        "raise SystemExit(2)\n"
    )
    result = RuntimeClient(env.config()).request({
        "op": "approve", "actor": ACTOR, "job_id": "synthetic", "approval_token": "expired",
    })
    assert result["ok"] is False and result["error"]["code"] == "approval_expired"


def test_empty_media_placeholder_is_not_reported_as_a_ready_audio_file(env):
    item = attachment(env, "audio.m4a", "audio/mp4", total_bytes=0)
    Path(item["original_path"]).write_bytes(b"")
    env.source.events.append(message(has_attachments=True, attachments=[item]))
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    assert not submitted(env)
    Path(item["original_path"]).write_bytes(b"synthetic completed media")
    env.portal().tick()
    env.clock.advance()
    env.portal().tick()
    assert len(submitted(env)) == 1


def test_changed_group_roster_cannot_receive_an_old_task_result(env):
    db = make_database(env)
    group = "iMessage;+;synthetic-group"
    db.execute("UPDATE chat SET guid=?,style=43 WHERE ROWID=1", (group,))
    db.commit()
    source = SQLiteSource(env.config())
    target = {
        "chat_id": 1, "chat_guid": group, "is_group": True,
        "roster_hash": roster_digest([SENDER]),
    }
    assert source.target_matches(target)
    db.execute("INSERT INTO handle VALUES(2,'new-participant@example.invalid')")
    db.execute("INSERT INTO chat_handle_join VALUES(1,2)")
    db.commit()
    assert not source.target_matches(target)
    source.close()
    db.close()


def test_caption_submission_does_not_unlock_the_next_file(env):
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        enqueue_native_test_batch(env, outbox, [".m4a", ".mp4"])
        outbox.pump()
        assert len([call for call in env.native.calls if call["file"]]) == 1
        # Only the caption remains discoverable, as in an unconfirmed native file send.
        env.native.messages = [message for message in env.native.messages if not message["attachments"]]
        env.clock.advance(10)
        outbox.pump()
        assert len([call for call in env.native.calls if call["file"]]) == 1


def test_native_exception_then_late_attachment_delivery_resolves_without_resend(env):
    original = env.native.send
    delayed = []

    def send(chat_id, *, text="", file=""):
        result = original(chat_id, text=text, file=file)
        if file.endswith(".m4a"):
            delayed.extend(message for message in env.native.messages if message["attachments"])
            env.native.messages = [message for message in env.native.messages if not message["attachments"]]
            raise SubmissionUnknown("native_send_unknown", "synthetic -32603 before chat join")
        return result

    env.native.send = send
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        enqueue_native_test_batch(env, outbox, [".m4a", ".mp4"])
        outbox.pump()
    recorded = next(part for part in state(env)["outbox"] if part.get("mime") == "audio/mp4")
    assert recorded["state"] == "unknown"
    assert "submitted_at" in recorded and "send_after_rowid" in recorded
    assert Path(recorded["file"]["path"]).name.startswith("rapp-")
    assert len([call for call in env.native.calls if call["file"].endswith(".m4a")]) == 1
    assert not [call for call in env.native.calls if call["file"].endswith(".mp4")]
    env.native.messages.extend(delayed)
    env.clock.advance(10)
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        outbox.pump()
    recorded = next(part for part in state(env)["outbox"] if part.get("mime") == "audio/mp4")
    assert recorded["state"] == "delivered"
    assert recorded["guid"] == delayed[0]["guid"]
    assert len([call for call in env.native.calls if call["file"].endswith(".m4a")]) == 1
    assert len([call for call in env.native.calls if call["file"].endswith(".mp4")]) == 1
    assert not any("explicitly risks a duplicate" in call["text"] for call in env.native.calls)


def test_help_does_not_claim_automatic_media_understanding_or_streaming():
    assert "does not automatically transcribe voice" in HELP
    assert "continuous livestream" in HELP
    assert "approved task and suitable configured tools" in HELP


def configure_real_runtime_fixture(env, monkeypatch):
    entry = os.environ.get("PORTAL_RUNTIME_ENTRY")
    if not entry:
        pytest.skip("Set PORTAL_RUNTIME_ENTRY to the approved local JSON adapter for fake-worker integration.")
    entry = Path(entry)
    assert entry.is_absolute() and entry.is_file()
    for key in ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    fake = env.root / "fake-copilot"
    fake.write_text(
        "#!" + sys.executable + "\n"
        "import pathlib,sys\n"
        "assert '--allow-all' not in sys.argv and '--yolo' not in sys.argv\n"
        "assert 'gpt-6-astra' in sys.argv\n"
        "assert 'report.txt' in '\\n'.join(sys.argv[1:]), 'approved output missing from generation instructions'\n"
        "pathlib.Path('report.txt').write_text('Synthetic local adapter report.\\n')\n"
        "print('Synthetic fake-CLI completion.',flush=True)\n"
    )
    fake.chmod(0o700)
    env.jobs.chmod(0o700)
    root = Path(env.raw["state_dir"])
    root.mkdir(mode=0o700, exist_ok=True)
    staging = root / "inbox"
    staging.mkdir(mode=0o700, exist_ok=True)
    configuration = env.root / "runtime-private.json"
    configuration.write_text(json.dumps({
        "version": 1, "jobs_dir": str(env.jobs), "staging_root": str(staging),
        "copilot_path": str(fake), "authorized": [ACTOR],
        "profiles": {"synthetic-workspace": {"available_tools": []}},
        "auth_account": {"host": "https://github.com", "login": "synthetic-portal-fixture"},
        "approval_ttl_seconds": 600, "max_runtime_seconds": 10,
    }))
    configuration.chmod(0o600)
    env.raw["runtime_argv"] = [sys.executable, str(entry), "--portal-config", str(configuration)]
    env.raw["artifact_paths"] = []
    env.clock.now = time.time()
    return RuntimeClient(env.config())


def test_real_local_adapter_publishes_only_a_fake_workers_declared_artifact(env, monkeypatch):
    client = configure_real_runtime_fixture(env, monkeypatch)
    prepared = client.request({
        "op": "submit", "actor": ACTOR, "request_id": "synthetic-transport-contract",
        "prompt": "Create report.txt containing the synthetic fixture report.",
        "profile": "synthetic-workspace", "attachments": [], "artifact_paths": ["report.txt"],
    })
    assert prepared["ok"], prepared.get("error")
    job_id = prepared["job"]["job_id"]
    assert prepared["job"]["status"] == "pending_approval"
    approved = client.request({
        "op": "approve", "actor": ACTOR, "job_id": job_id,
        "approval_token": prepared["approval"]["token"],
    })
    assert approved["ok"], approved.get("error")
    deadline = time.monotonic() + 15
    while True:
        reply = client.request({
            "op": "result", "actor": ACTOR, "job_id": job_id,
            "stdout_offset": 0, "stderr_offset": 0, "event_offset": 0, "limit": 4096,
        })
        assert reply["ok"], reply.get("error")
        if reply["result"] is not None and not reply["worker_active"]:
            break
        if time.monotonic() >= deadline:
            pytest.fail("The synthetic worker did not reach a terminal result.")
        time.sleep(0.05)
    assert reply["job"]["status"] == "succeeded", reply["result"].get("error")
    assert reply["result"]["exit_code"] == 0
    assert "next_offset" in reply["stdout"] and "next_event_offset" in reply
    artifact = reply["result"]["artifacts"][0]
    assert artifact["name"] == "report.txt" and artifact["mime"] == "text/plain"
    assert Path(artifact["path"]).is_relative_to(env.jobs / job_id / "artifacts")
    assert Path(artifact["path"]).name.startswith(job_id)
    assert hashlib.sha256(Path(artifact["path"]).read_bytes()).hexdigest() == artifact["sha256"]
    print("Local runtime contract:", {
        "job_keys": sorted(reply["job"]), "result_keys": sorted(reply["result"]),
        "artifact_keys": sorted(artifact),
    })


def test_explicit_file_request_binds_only_the_named_output_and_local_profile(env):
    env.raw["artifact_paths"] = []
    env.source.events.append(message(text="RAPP file report.txt | summarize the fixture"))
    env.portal().tick()
    request = submitted(env)[0]
    assert request["artifact_paths"] == ["report.txt"]
    assert request["profile"] == "synthetic-workspace"
    assert request["prompt"] == "summarize the fixture"
    assert any("declared outputs: report.txt" in call["text"] for call in env.native.calls)
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]


def test_ordinary_text_task_has_no_forced_output_files(env):
    env.raw["artifact_paths"] = []
    env.source.events.append(message(text="RAPP a text-only fixture task"))
    env.portal().tick()
    assert submitted(env)[0]["artifact_paths"] == []


@pytest.mark.parametrize("name", [
    "../report.txt", "/private/report.txt", "report.sh", "payload.app", ".hidden.txt",
    "report.txt --profile admin", "--allow-all.txt", "subdir/report.txt", "report.html",
    "other@example.invalid:report.txt", "https://example.invalid/report.png", "first.png,second.png",
])
def test_file_command_cannot_declare_paths_executables_or_flags(env, name):
    env.source.events.append(message(text=f"RAPP file {name} | synthetic task"))
    env.portal().tick()
    assert not submitted(env)
    assert any("output_name_invalid" in call["text"] for call in env.native.calls)


def test_plural_output_command_is_rejected_for_the_frozen_single_file_ux(env):
    env.source.events.append(message(text="RAPP files image.png,clip.mp4 | prepare fixture media"))
    env.portal().tick()
    assert not submitted(env)
    assert any("output_name_invalid" in call["text"] for call in env.native.calls)


def test_fixed_output_defaults_are_rejected_instead_of_breaking_text_tasks(env):
    env.raw["artifact_paths"] = ["mandatory-report.txt"]
    with pytest.raises(PortalError, match="Leave artifact_paths empty"):
        env.config()


@pytest.mark.parametrize("text", [
    "RAPP file report.txt", "RAPP file report.txt | ", "RAPP file | make a report",
])
def test_file_form_requires_a_basename_separator_and_nonempty_task(env, text):
    env.source.events.append(message(text=text))
    env.portal().tick()
    assert not submitted(env)
    assert any("output_name_invalid" in call["text"] for call in env.native.calls)


def test_file_task_is_text_after_the_first_separator(env):
    env.source.events.append(message(text="RAPP file report.txt | describe a | b without executing it"))
    env.portal().tick()
    assert submitted(env)[0]["prompt"] == "describe a | b without executing it"
    assert submitted(env)[0]["artifact_paths"] == ["report.txt"]
    assert submitted(env)[0]["profile"] == "synthetic-workspace"


@pytest.mark.parametrize(("selection", "operation"), [("1", "approve"), ("2", "cancel")])
def test_foreign_outbound_sql_row_blocks_bare_and_rapp_numbers_but_not_named_commands(env, selection, operation):
    db = make_database(env)
    with Store(env.config().state_dir) as store:
        store.data["cursor"] = store.data["floor"] = 0
        store.save()

    def tick():
        return Portal(env.config(), runtime=env.runtime, native=env.native, clock=env.clock).tick()

    insert_message(db, 1, "RAPP prepare the synthetic task")
    tick()
    approval = next(part for part in state(env)["outbox"] if part["group"].endswith(":approval"))
    insert_message(db, 2, approval["text"], approval["guid"])
    db.execute("UPDATE message SET is_from_me=1 WHERE ROWID=2")
    insert_message(db, 3, "Other AI choices: 1. Different action 2. Cancel", "FOREIGN-OUTBOUND")
    db.execute("UPDATE message SET is_from_me=1,handle_id=NULL WHERE ROWID=3")
    insert_message(db, 4, selection)
    env.clock.advance(10)
    sent = len(env.native.calls)
    tick()
    assert not [call for call in env.runtime.calls if call["op"] in ("approve", "cancel")]
    assert len(env.native.calls) == sent
    # RAPP <n> finds our card, but another author's bubble sits after it: nothing runs.
    insert_message(db, 5, f"RAPP {selection}")
    tick()
    assert not [call for call in env.runtime.calls if call["op"] in ("approve", "cancel")]
    assert any("Another message came after the card" in call["text"] for call in env.native.calls)
    insert_message(db, 6, f"RAPP {'approve' if selection == '1' else 'cancel'} 0001")
    tick()
    assert len([call for call in env.runtime.calls if call["op"] == operation]) == 1
    db.close()


def test_native_decode_is_authorized_and_not_used_for_audio_transcription(env):
    db = make_database(env)
    with Store(env.config().state_dir) as store:
        store.data["cursor"] = store.data["floor"] = 0
        store.save()
    db.execute("INSERT INTO handle VALUES(2,'stranger@example.invalid')")
    insert_message(db, 1, None)
    db.execute("UPDATE message SET handle_id=2,attributedBody=? WHERE ROWID=1", (b"untrusted body",))
    insert_message(db, 2, None)
    db.execute("UPDATE message SET is_audio_message=1,attributedBody=? WHERE ROWID=2", (b"voice metadata",))
    insert_message(db, 3, "RAPP approve a transcription must not authorize")
    db.execute("UPDATE message SET is_audio_message=1 WHERE ROWID=3")
    db.commit()
    env.native.decoded["G-1"] = "RAPP approve forged"
    env.native.decoded["G-2"] = "RAPP approve transcript"
    Portal(env.config(), runtime=env.runtime, native=env.native, clock=env.clock).tick()
    assert env.native.decode_calls == []
    assert env.runtime.calls == []
    db.close()


def test_native_text_rpc_matches_only_the_authorized_message_and_disables_attachments(env):
    client = NativeClient(env.config())
    calls = []
    event = message(created_at="2026-01-01T00:00:00+00:00")

    def request(method, params):
        calls.append((method, params))
        return {"messages": [
            {**event, "text": "RAPP correct native text"},
            {**event, "guid": "DIFFERENT-GUID", "text": "RAPP wrong text"},
        ]}

    client.request = request
    assert client.decode_text(event, ACTOR) == "RAPP correct native text"
    assert calls[0][0] == "messages.history"
    assert calls[0][1]["attachments"] is False
    assert calls[0][1]["chat_id"] == 1 and calls[0][1]["participants"] == [SENDER]
    assert calls[0][1]["limit"] == 32


@pytest.mark.parametrize("encoding", ["utf16", "typedstream"])
@pytest.mark.parametrize("scheme", ["iMessage", "any"])
def test_installed_native_decoder_reads_only_the_synthetic_attributed_body(env, encoding, scheme):
    native_path = os.environ.get("PORTAL_NATIVE_READER")
    if not native_path:
        pytest.skip("Set PORTAL_NATIVE_READER for read-only native decoding of fixture SQLite.")
    env.raw["imsg_path"] = native_path
    db = make_database(env)
    canonical = CHAT.replace("iMessage;", scheme + ";", 1)
    actor = {**ACTOR, "chat": canonical}
    env.raw["authorized"][0]["chat"] = canonical
    db.execute("UPDATE chat SET guid=? WHERE ROWID=1", (canonical,))
    text = "RAPP native decoded fixture " + "long text " * 30
    encoded = text.encode("utf-8")
    body = (
        b"\xff\xfe" + text.encode("utf-16-le") if encoding == "utf16"
        else b"NSString\x01+\x82" + len(encoded).to_bytes(2, "big") + encoded + b"\x86\x84"
    )
    insert_message(db, 1, None)
    db.execute("UPDATE message SET attributedBody=? WHERE ROWID=1", (body,))
    db.commit()
    source = SQLiteSource(env.config())
    event = source.poll(0, 0)[0]
    assert event["needs_native_text"] is True and event["text"] == ""
    native = NativeClient(env.config())
    assert native.decode_text(event, actor) == text
    assert event["chat_guid"] == canonical
    source.close()
    db.close()


def test_native_decode_timeout_is_explicit_and_never_executes_a_task(env):
    event = message(text="", needs_native_text=True)
    env.source.events.append(event)
    env.portal().tick()
    assert next(iter(state(env)["inbox"].values()))["state"] == "decoding"
    env.clock.advance(121)
    env.portal().tick()
    assert next(iter(state(env)["inbox"].values()))["error"] == "text_decode_timeout"
    assert not submitted(env)
    assert any("text_decode_timeout" in call["text"] for call in env.native.calls)


@pytest.mark.parametrize("mime", ["audio/mp4a-latm", "audio/x-m4a", "audio/mp4", "audio/m4a"])
def test_valid_aac_m4a_manifest_aliases_preserve_the_container_and_native_file_path(env, mime):
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        pytest.skip("Existing ffmpeg/ffprobe enable the synthetic valid-M4A alias regression.")
    env.source.events.append(message(text="RAPP file result.m4a | create a short synthetic audio file"))
    env.portal().tick()
    artifact = add_output(env, JOB1, ".m4a")
    path = Path(artifact["path"])
    generated = subprocess.run(
        [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "0.1", "-c:a", "aac", str(path)],
        capture_output=True, text=True, timeout=20,
    )
    assert generated.returncode == 0, generated.stderr
    probed = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=format_name:stream=codec_name,codec_type",
         "-of", "json", str(path)], capture_output=True, text=True, timeout=10,
    )
    assert probed.returncode == 0, probed.stderr
    media = json.loads(probed.stdout)
    assert "m4a" in media["format"]["format_name"].split(",")
    assert any(stream["codec_name"] == "aac" and stream["codec_type"] == "audio" for stream in media["streams"])
    artifact.update(
        mime=mime, size_bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
    )
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(10)
    env.portal().tick()
    part = next(part for part in state(env)["outbox"] if "file" in part)
    assert part["mime"] == mime
    assert Path(part["file"]["path"]).suffix == ".m4a"
    assert Path(part["file"]["path"]).read_bytes() == path.read_bytes()
    assert len([call for call in env.native.calls if call["file"].endswith(".m4a")]) == 1
    env.clock.advance(10)
    env.portal().tick()
    assert next(part for part in state(env)["outbox"] if "file" in part)["state"] == "delivered"


def test_capture_crash_after_ack_commit_does_not_duplicate_selected_references(env, monkeypatch):
    env.source.events.extend([
        message(1, "RAPP attach"),
        message(2, "", has_attachments=True, attachments=[attachment(env, "single.txt", "text/plain")]),
    ])
    env.portal().tick()
    original = Portal._notice

    def crash_after_saved(self, key, *args, **kwargs):
        original(self, key, *args, **kwargs)
        if key.endswith(":saved"):
            raise SystemExit("synthetic crash after acknowledgement journal commit")

    monkeypatch.setattr(Portal, "_notice", crash_after_saved)
    env.clock.advance(2)
    with pytest.raises(SystemExit):
        env.portal().tick()
    committed_capture = next(record for record in state(env)["inbox"].values() if record["capture"])
    assert committed_capture["state"] == "done"
    monkeypatch.setattr(Portal, "_notice", original)
    env.clock.advance(2)
    env.portal().tick()
    env.source.events.append(message(3, "RAPP use the captured input once"))
    env.portal().tick()
    assert len(submitted(env)) == 1
    assert [item["name"] for item in submitted(env)[0]["attachments"]] == ["single.txt"]
    saved_notices = [part for part in state(env)["outbox"] if part["group"].endswith(":saved")]
    assert len(saved_notices) == 1
    env.source.events.append(message(4, "RAPP a later text task"))
    env.portal().tick()
    assert submitted(env)[1]["attachments"] == []


@pytest.mark.parametrize("native_decode", [False, True])
def test_task_freezes_preceding_uploads_and_preserves_later_ready_files(env, native_decode):
    slow = attachment(env, "A.txt", "text/plain", exists=False)
    later = attachment(env, "B.txt", "text/plain")
    env.source.events.extend([
        message(1, "RAPP attach"),
        message(2, "", has_attachments=True, attachments=[slow]),
        message(
            3, "" if native_decode else "RAPP use only the preceding upload",
            needs_native_text=native_decode,
        ),
        message(4, "", has_attachments=True, attachments=[later]),
    ])
    env.portal().tick()
    requesting = next(record for record in state(env)["inbox"].values() if record["event"]["id"] == 3)
    selection_key = "input_snapshot" if native_decode else "selected_inputs"
    assert requesting[selection_key] == [hashlib.sha256(b"SYNTHETIC-2").hexdigest()]
    env.clock.advance(2)
    env.portal().tick()
    assert not submitted(env)
    if native_decode:
        env.native.decoded["SYNTHETIC-3"] = "RAPP use only the preceding upload"
    Path(slow["original_path"]).write_text("synthetic A finally downloaded")
    env.clock.advance(5)
    env.portal().tick()
    env.clock.advance(2)
    env.portal().tick()
    assert [item["name"] for item in submitted(env)[0]["attachments"]] == ["A.txt"]
    env.source.events.append(message(5, "RAPP use the next unconsumed upload"))
    env.clock.advance(2)
    env.portal().tick()
    assert [item["name"] for item in submitted(env)[1]["attachments"]] == ["B.txt"]


def test_frozen_uploads_resolve_in_source_row_and_attachment_ordinal_order(env):
    slow = [
        attachment(env, f"A{index}.txt", "text/plain", exists=False)
        for index in range(2)
    ]
    ready = attachment(env, "B.txt", "text/plain")
    env.source.events.extend([
        message(1, "RAPP attach"),
        message(2, "", has_attachments=True, attachments=slow),
        message(3, "", has_attachments=True, attachments=[ready]),
        message(4, "RAPP use all preceding uploads in order"),
    ])
    env.portal().tick()
    env.clock.advance(2)
    env.portal().tick()
    for item in slow:
        Path(item["original_path"]).write_text("synthetic slow input")
    env.clock.advance(2)
    env.portal().tick()
    env.clock.advance(2)
    env.portal().tick()
    assert [item["name"] for item in submitted(env)[0]["attachments"]] == ["A0.txt", "A1.txt", "B.txt"]


@pytest.mark.parametrize(("operation", "spacing"), [("status", 5), ("recover", 60)])
def test_job_polling_and_recovery_budgets_do_not_starve_later_jobs(env, operation, spacing):
    env.source.events.extend(message(index, f"RAPP synthetic task {index}") for index in range(1, 10))
    env.portal().tick()
    env.runtime.calls.clear()
    for _ in range(3):
        env.clock.advance(spacing)
        env.portal().tick()
    seen = {request["job_id"] for request in env.runtime.calls if request["op"] == operation}
    assert seen == {synthetic_job(index) for index in range(1, 10)}


def test_watcher_restart_recovers_every_job_across_the_finite_budget(env, monkeypatch):
    monkeypatch.setenv("RAPP_PORTAL_WATCHER_INSTANCE", "before-restart")
    env.source.events.extend(message(index, f"RAPP synthetic task {index}") for index in range(1, 10))
    env.portal().tick()
    with Store(env.config().state_dir) as store:
        for job in store.data["jobs"].values():
            job["last_recovery"] = env.clock()
            job["recovery_instance"] = "before-restart"
        store.save()
    env.runtime.calls.clear()
    monkeypatch.setenv("RAPP_PORTAL_WATCHER_INSTANCE", "after-restart")
    for _ in range(3):
        env.clock.advance(1)
        env.portal().tick()
    seen = {request["job_id"] for request in env.runtime.calls if request["op"] == "recover"}
    assert seen == {synthetic_job(index) for index in range(1, 10)}


def test_receipts_reject_late_creation_but_accept_late_discovery_inside_attempt_window(env):
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        enqueue_native_test_batch(env, outbox, [".m4a"])
        outbox.pump()
        part = next(part for part in store.data["outbox"] if "file" in part)
        original = copy.deepcopy(next(row for row in env.native.messages if row["attachments"]))
        env.native.messages = [{
            **original,
            "created_at": datetime.fromtimestamp(env.clock() + 3600, timezone.utc).isoformat(),
        }]
        env.clock.advance(3600)
        outbox.pump()
        assert part["state"] == "unknown" and not part.get("guid")
        assert len([call for call in env.native.calls if call["file"]]) == 1
        env.native.messages = [original]
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        env.clock.advance(400)  # the next poll on the age-based backoff schedule
        outbox.pump()
        part = next(part for part in store.data["outbox"] if "file" in part)
        assert part["state"] == "delivered"
        assert part["guid"] == original["guid"]
        assert len([call for call in env.native.calls if call["file"]]) == 1


def test_capture_upgrade_deduplicates_legacy_refs_by_source_event(env):
    env.source.events.extend([
        message(1, "RAPP attach"),
        message(2, "", has_attachments=True, attachments=[attachment(env, "single.txt", "text/plain")]),
    ])
    env.portal().tick()
    env.clock.advance(2)
    env.portal().tick()
    with Store(env.config().state_dir) as store:
        capture = next(record for record in store.data["inbox"].values() if record["capture"])
        capture["state"] = "ready"
        conversation = next(iter(store.data["conversations"].values()))
        conversation.pop("uploads")
        reference = capture["staged"]["0"]
        conversation["files"] = [dict(reference), dict(reference)]
        conversation["files_expire"] = env.clock() + 600
        store.save()
    env.portal().tick()
    env.source.events.append(message(3, "RAPP use only one source attachment"))
    env.portal().tick()
    assert [item["name"] for item in submitted(env)[0]["attachments"]] == ["single.txt"]


def test_task_with_its_own_slow_file_cannot_absorb_a_later_upload(env):
    earlier = attachment(env, "earlier.txt", "text/plain")
    own = attachment(env, "own.txt", "text/plain", exists=False)
    later = attachment(env, "later.txt", "text/plain")
    env.source.events.extend([
        message(1, "RAPP attach"),
        message(2, "", has_attachments=True, attachments=[earlier]),
        message(3, "RAPP use selected files", has_attachments=True, attachments=[own]),
        message(4, "", has_attachments=True, attachments=[later]),
    ])
    env.portal().tick()
    env.clock.advance(2)
    env.portal().tick()
    Path(own["original_path"]).write_text("synthetic mixed-message input")
    env.clock.advance(2)
    env.portal().tick()
    env.clock.advance(2)
    env.portal().tick()
    assert [item["name"] for item in submitted(env)[0]["attachments"]] == ["earlier.txt", "own.txt"]
    env.source.events.append(message(5, "RAPP use the remaining upload"))
    env.portal().tick()
    assert [item["name"] for item in submitted(env)[1]["attachments"]] == ["later.txt"]


def test_invalid_file_request_releases_its_frozen_upload_for_the_next_task(env):
    env.source.events.extend([
        message(1, "RAPP attach"),
        message(2, "", has_attachments=True, attachments=[attachment(env, "input.txt", "text/plain")]),
    ])
    env.portal().tick()
    env.clock.advance(2)
    env.portal().tick()
    env.source.events.append(message(3, "RAPP file ../unsafe.txt | do not run"))
    env.portal().tick()
    assert not submitted(env)
    env.source.events.append(message(4, "RAPP use my selected file"))
    env.portal().tick()
    assert [item["name"] for item in submitted(env)[0]["attachments"]] == ["input.txt"]


@pytest.mark.parametrize(("offset", "accepted"), [
    (-2.001, False), (-2, True), (0, True), (179.999, True), (180, False), (180.001, False), (86400, False),
])
def test_attachment_creation_window_matches_native_start_inclusive_end_exclusive(env, offset, accepted):
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        enqueue_native_test_batch(env, outbox, [".m4a"])
        outbox.pump()
        part = next(part for part in store.data["outbox"] if "file" in part)
        receipt = next(row for row in env.native.messages if row["attachments"])
        receipt["created_at"] = datetime.fromtimestamp(
            part["submitted_at"] + offset, timezone.utc,
        ).isoformat()
        assert part["receipt_created_before"] == part["submitted_at"] + 180
        assert part["receipt_created_after"] == part["submitted_at"] - 2
        env.clock.advance(86410)
        outbox.pump()
        assert (part["state"] == "delivered") is accepted
        assert len([call for call in env.native.calls if call["file"]]) == 1


def test_receipt_window_is_saved_before_send_and_uses_each_parts_actual_start(env):
    original = env.native.send
    starts = []

    def send(chat_id, *, text="", file=""):
        persisted = next(part for part in state(env)["outbox"] if part["state"] == "submitting")
        assert persisted["submitted_at"] == env.clock()
        assert persisted["receipt_created_after"] == env.clock() - 2
        assert persisted["receipt_created_before"] == env.clock() + 180
        starts.append(persisted["submitted_at"])
        result = original(chat_id, text=text, file=file)
        if not file:
            env.clock.advance(12)
        return result

    env.native.send = send
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        enqueue_native_test_batch(env, outbox, [".m4a"])
        outbox.pump()
    assert starts[1] == starts[0] + 12


def test_native_history_query_is_bounded_to_the_persisted_creation_window(env):
    client = NativeClient(env.config())
    calls = []
    client.request = lambda method, params: calls.append((method, params)) or {"messages": []}
    start, end = env.clock() - 2, env.clock() + 180
    assert client.history(1, start, end) == []
    method, params = calls[0]
    assert method == "messages.history" and params["chat_id"] == 1
    assert datetime.fromisoformat(params["start"]).timestamp() == start
    assert datetime.fromisoformat(params["end"]).timestamp() == end


def test_receipt_window_does_not_change_when_configuration_changes_after_restart(env):
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        enqueue_native_test_batch(env, outbox, [".m4a"])
        outbox.pump()
        part = next(part for part in store.data["outbox"] if "file" in part)
        original_end = part["receipt_created_before"]
        row = next(row for row in env.native.messages if row["attachments"])
        row["created_at"] = datetime.fromtimestamp(part["submitted_at"] + 100, timezone.utc).isoformat()
    env.raw["receipt_seconds"] = 1
    env.clock.advance(300)
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        outbox.pump()
        part = next(part for part in store.data["outbox"] if "file" in part)
        assert part["receipt_created_before"] == original_end
        assert part["state"] == "delivered"
    assert len([call for call in env.native.calls if call["file"]]) == 1


def test_repeated_poll_error_cannot_starve_later_jobs(env):
    env.source.events.extend(message(index, f"RAPP synthetic task {index}") for index in range(1, 10))
    env.portal().tick()
    original = env.runtime.request

    def request(value):
        if value["op"] == "status" and value["job_id"] == JOB1:
            env.runtime.calls.append(copy.deepcopy(value))
            raise PortalError("synthetic_status_error", "Synthetic per-job failure.")
        return original(value)

    env.runtime.request = request
    env.runtime.calls.clear()
    for _ in range(3):
        env.clock.advance(5)
        env.portal().tick()
    seen = {request["job_id"] for request in env.runtime.calls if request["op"] == "status"}
    assert seen == {synthetic_job(index) for index in range(1, 10)}


@pytest.mark.parametrize("scheme", ["iMessage", "any"])
@pytest.mark.parametrize(("chat_service", "message_service", "admitted"), [
    ("iMessage", "iMessage", True),
    ("SMS", "SMS", False),
    ("RCS", "RCS", False),
    ("iMessage", "SMS", False),
    ("iMessage", "RCS", False),
    ("SMS", "iMessage", False),
    ("RCS", "iMessage", False),
    ("", "iMessage", False),
    (None, "iMessage", False),
])
def test_chat_scheme_is_not_service_authorization(env, scheme, chat_service, message_service, admitted):
    canonical = CHAT.replace("iMessage;", scheme + ";", 1)
    env.raw["authorized"][0]["chat"] = canonical
    db = make_database(env)
    db.execute("UPDATE chat SET guid=?,service_name=? WHERE ROWID=1", (canonical, chat_service))
    insert_message(db, 1, "RAPP inspect the synthetic route")
    db.execute("UPDATE message SET service=? WHERE ROWID=1", (message_service,))
    db.commit()
    source = SQLiteSource(env.config())
    events = source.poll(0, 0)
    assert bool(events) is admitted
    target = {"chat_id": 1, "chat_guid": canonical, "is_group": False}
    assert source.target_matches(target) is (chat_service == "iMessage")
    if admitted:
        assert events[0]["chat_guid"] == canonical
        assert env.portal().authorize(events[0]) == {"sender": SENDER, "chat": canonical}
    source.close()
    db.close()


def test_any_scheme_imessage_keeps_the_exact_guid_through_submission_and_media_receipts(env):
    canonical = "any;-;synthetic-owner"
    env.raw["authorized"][0]["chat"] = canonical
    env.source.targets[1] = canonical
    db = make_database(env)
    db.execute("UPDATE chat SET guid=? WHERE ROWID=1", (canonical,))
    db.commit()
    with Store(env.config().state_dir) as store:
        store.data["cursor"] = store.data["floor"] = 0
        store.save()
    insert_message(db, 1, "RAPP file result.txt | create synthetic route output")

    def tick():
        return Portal(env.config(), runtime=env.runtime, native=env.native, clock=env.clock).tick()

    tick()
    assert submitted(env)[0]["actor"] == {"sender": SENDER, "chat": canonical}
    add_output(env, JOB1, ".txt")
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    for _ in range(3):
        env.clock.advance(10)
        tick()
    file_part = next(part for part in state(env)["outbox"] if "file" in part)
    assert file_part["actor"]["chat"] == file_part["target"]["chat_guid"] == canonical
    assert file_part["state"] == "delivered"
    assert len([call for call in env.native.calls if call["file"]]) == 1
    db.close()


def test_any_scheme_does_not_relax_exact_sender_chat_or_style_matching(env):
    canonical = "any;-;synthetic-owner"
    env.raw["authorized"][0]["chat"] = canonical
    db = make_database(env)
    db.execute("UPDATE chat SET guid=? WHERE ROWID=1", (canonical,))
    insert_message(db, 1)
    source = SQLiteSource(env.config())
    assert not source.target_matches({"chat_id": 1, "chat_guid": CHAT, "is_group": False})
    assert not source.target_matches({"chat_id": 1, "chat_guid": canonical, "is_group": True})
    db.execute("UPDATE handle SET id='other@example.invalid' WHERE ROWID=1")
    db.commit()
    assert source.poll(0, 0) == []
    source.close()
    db.close()


def test_native_history_binding_does_not_rewrite_any_scheme_to_imessage(env):
    canonical = "any;-;synthetic-owner"
    client = NativeClient(env.config())
    event = message(chat_guid=canonical, created_at="2026-01-01T00:00:00+00:00")
    client.request = lambda *_: {"messages": [{**event, "chat_guid": CHAT, "text": "RAPP wrong rewritten route"}]}
    with pytest.raises(PortalError, match="not ready"):
        client.decode_text(event, {"sender": SENDER, "chat": canonical})


def test_any_scheme_group_retains_explicit_group_authorization_and_roster_checks(env):
    canonical = "any;+;synthetic-group"
    env.raw["authorized"] = [{"sender": SENDER, "chat": canonical, "allow_group": True}]
    db = make_database(env)
    db.execute("UPDATE chat SET guid=?,style=43 WHERE ROWID=1", (canonical,))
    insert_message(db, 1)
    source = SQLiteSource(env.config())
    event = source.poll(0, 0)[0]
    assert event["chat_guid"] == canonical and event["is_group"] is True
    assert env.portal().authorize(event) == {"sender": SENDER, "chat": canonical}
    target = {"chat_id": 1, "chat_guid": canonical, "is_group": True, "roster_hash": roster_digest([SENDER])}
    assert source.target_matches(target)
    db.execute("INSERT INTO handle VALUES(2,'new-member@example.invalid')")
    db.execute("INSERT INTO chat_handle_join VALUES(1,2)")
    db.commit()
    assert not source.target_matches(target)
    env.raw["authorized"][0]["allow_group"] = False
    assert env.portal().authorize(event) is None
    source.close()
    db.close()


@pytest.mark.parametrize("invalidate", [None, "RAPP clear files", "RAPP attach"])
def test_admitted_upload_keeps_decode_eligibility_when_a_later_text_task_closes_intake(env, invalidate):
    upload = attachment(env, "reserved-A.txt", "text/plain")
    env.source.events.extend([
        message(1, "RAPP attach"),
        message(2, "", has_attachments=True, attachments=[upload], needs_native_text=True),
        message(3, "RAPP task T uses the preceding upload"),
        message(4, "RAPP text-only task U"),
    ])
    env.portal().tick()
    assert [request["prompt"] for request in submitted(env)] == ["text-only task U"]
    assert submitted(env)[0]["attachments"] == []
    saved = state(env)
    assert next(iter(saved["conversations"].values()))["capture_until"] == 0
    source = next(record for record in saved["inbox"].values() if record["event"]["id"] == 2)
    assert source["state"] == "decoding" and source.get("selected_by")
    assert source["capture_eligible"] is True
    assert source["capture_generation"] == next(iter(saved["conversations"].values()))["capture_generation"]
    if invalidate:
        env.source.events.append(message(5, invalidate))
        env.portal().tick()
    env.native.decoded["SYNTHETIC-2"] = "\ufffc"
    env.clock.advance(5)
    env.portal().tick()
    env.clock.advance(2)
    env.portal().tick()
    inputs_for_t = [request for request in submitted(env) if request["prompt"] == "T uses the preceding upload"]
    if invalidate:
        assert inputs_for_t == []
        pending = next(record for record in state(env)["inbox"].values() if record["event"]["id"] == 3)
        assert pending["error"] == "attachment_failed"
    else:
        assert len(inputs_for_t) == 1
        assert [item["name"] for item in inputs_for_t[0]["attachments"]] == ["reserved-A.txt"]


def test_rearming_cannot_retroactively_admit_an_earlier_unaddressed_file(env):
    env.source.events.extend([
        message(1, "", has_attachments=True, attachments=[attachment(env)], needs_native_text=True),
        message(2, "RAPP attach"),
    ])
    env.portal().tick()
    env.native.decoded["SYNTHETIC-1"] = "\ufffc"
    env.clock.advance(5)
    env.portal().tick()
    source = next(record for record in state(env)["inbox"].values() if record["event"]["id"] == 1)
    assert source["state"] == "ignored"
    assert env.source.attachment_reads == 0
    assert not any("Saved 1 attachment" in call["text"] for call in env.native.calls)


def test_older_pending_upload_without_admission_evidence_fails_explicitly(env):
    env.source.events.extend([
        message(1, "RAPP attach"),
        message(2, "", has_attachments=True, attachments=[attachment(env)], needs_native_text=True),
        message(3, "RAPP use the pending upload"),
    ])
    env.portal().tick()
    with Store(env.config().state_dir) as store:
        source = next(record for record in store.data["inbox"].values() if record["event"]["id"] == 2)
        source.pop("capture_eligible")
        source.pop("capture_generation")
        store.save()
    env.native.decoded["SYNTHETIC-2"] = "\ufffc"
    env.clock.advance(5)
    env.portal().tick()
    source = next(record for record in state(env)["inbox"].values() if record["event"]["id"] == 2)
    assert source["error"] == "intake_context_unknown"
    assert not submitted(env)
    assert any("intake_context_unknown" in call["text"] for call in env.native.calls)


def test_a_bare_number_answering_another_ai_is_left_alone_even_while_an_approval_waits(env):
    env.source.events.append(message())
    env.portal().tick()
    env.clock.advance(10)
    sent = len(env.native.calls)
    env.source.prior_guids[CHAT] = "OTHER-AI-PROMPT"
    env.source.events.append(message(2, "1"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]
    assert len(env.native.calls) == sent
    env.source.events.append(message(3, "RAPP 1"))
    env.portal().tick()
    assert len([call for call in env.runtime.calls if call["op"] == "approve"]) == 1


def test_watcher_restart_reconciles_owned_jobs_without_reapproving(env, monkeypatch):
    monkeypatch.setenv("RAPP_PORTAL_WATCHER_INSTANCE", "watcher-generation-one")
    env.source.events.append(message())
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    before = len([call for call in env.runtime.calls if call["op"] == "recover"])
    monkeypatch.setenv("RAPP_PORTAL_WATCHER_INSTANCE", "watcher-generation-two")
    env.portal().tick()
    recovery = [call for call in env.runtime.calls if call["op"] == "recover"]
    assert len(recovery) == before + 1
    assert recovery[-1]["actor"] == ACTOR and recovery[-1]["job_id"] == JOB1
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]


@pytest.mark.parametrize("kind", ["hardlink", "executable"])
def test_staging_does_not_launder_runtime_forbidden_file_properties(env, kind):
    item = attachment(env, "document.txt", "text/plain")
    path = Path(item["original_path"])
    if kind == "hardlink":
        os.link(path, env.incoming / "another-link.txt")
    else:
        path.chmod(0o700)
    env.source.events.append(message(has_attachments=True, attachments=[item]))
    env.portal().tick()
    assert next(iter(state(env)["inbox"].values()))["error"] == "unsafe_file"
    assert not submitted(env)


def test_successful_result_operation_does_not_claim_failed_task_succeeded(env):
    env.source.events.append(message())
    env.portal().tick()
    env.runtime.jobs[JOB1]["status"] = "failed"
    env.clock.advance(10)
    env.portal().tick()
    assert any("worker exit 1" in call["text"] and "synthetic_failure" in call["text"] for call in env.native.calls)
    assert not [call for call in env.native.calls if call["file"]]


def test_status_persists_runtime_byte_and_event_cursors(env):
    env.source.events.append(message())
    env.portal().tick()
    saved = state(env)["jobs"][JOB1]
    assert saved["stdout_offset"] == 24 and saved["event_offset"] == 1
    env.clock.advance(10)
    env.portal().tick()
    statuses = [call for call in env.runtime.calls if call["op"] == "status"]
    assert statuses[-1]["stdout_offset"] == 24 and statuses[-1]["event_offset"] == 1
    assert statuses[-1]["limit"] == 4096


def test_real_local_adapter_prepares_an_inert_explicit_file_task_through_portal(env, monkeypatch):
    client = configure_real_runtime_fixture(env, monkeypatch)
    env.source.events.append(message(text="RAPP file report.txt | create a synthetic report"))
    portal = Portal(
        env.config(), source=env.source, native=env.native, runtime=client, clock=env.clock,
    )
    portal.tick()
    saved = state(env)
    assert len(saved["jobs"]) == 1
    job_id, job = next(iter(saved["jobs"].items()))
    assert job["state"] == "pending_approval"
    assert job["declared"] == ["report.txt"]
    reply = client.request({"op": "status", "actor": ACTOR, "job_id": job_id, "limit": 4096})
    assert reply["ok"] and reply["worker_active"] is False
    assert reply["stdout"]["total_bytes"] == 0
    assert any("prepared; NOT running" in call["text"] for call in env.native.calls)
    assert any("Available tools: none" in call["text"] for call in env.native.calls)
    assert any("isolated job workspace only" in call["text"] for call in env.native.calls)
    assert not [call for call in env.native.calls if call["file"]]


def test_real_runtime_fake_worker_roundtrip_through_portal_and_mocked_native_delivery(env, monkeypatch):
    client = configure_real_runtime_fixture(env, monkeypatch)
    env.source.events.append(message(text="RAPP file report.txt | create the synthetic report"))

    def tick():
        return Portal(
            env.config(), source=env.source, native=env.native, runtime=client, clock=env.clock,
        ).tick()

    tick()
    job_id = next(iter(state(env)["jobs"]))
    assert state(env)["jobs"][job_id]["state"] == "pending_approval"
    env.clock.advance(10)
    env.source.events.append(message(2, "1"))
    tick()
    deadline = time.monotonic() + 15
    while True:
        env.clock.advance(5)
        tick()
        saved = state(env)
        files = [part for part in saved["outbox"] if "file" in part]
        if files and all(part["state"] == "delivered" for part in files):
            break
        if time.monotonic() >= deadline:
            pytest.fail(f"Combined synthetic roundtrip did not complete; job state: {saved['jobs'][job_id]['state']}")
        time.sleep(0.05)
    assert saved["jobs"][job_id]["state"] == "succeeded"
    assert len(files) == 1 and files[0]["guid"] != files[0]["caption_guid"]
    assert Path(files[0]["file"]["path"]).read_text() == "Synthetic local adapter report.\n"
    assert len([call for call in env.native.calls if call["file"]]) == 1
    env.clock.advance(10)
    tick()
    assert len([call for call in env.native.calls if call["file"]]) == 1
    finished = client.request({"op": "status", "actor": ACTOR, "job_id": job_id})
    assert finished["worker_active"] is False


@pytest.mark.parametrize("mutation", [
    "other-job-id", "out-of-range-index", "padded-id-index", "wrong-filename-index", "wrong-filename-name",
])
def test_manifest_requires_exact_frozen_identity_and_snapshot_filename(env, mutation):
    env.source.events.append(message(text="RAPP file result.png | create synthetic media"))
    env.portal().tick()
    artifact = add_output(env, JOB1)
    if mutation == "other-job-id":
        artifact["id"] = synthetic_job(2) + ":artifact:0"
    elif mutation == "out-of-range-index":
        artifact["id"] = JOB1 + ":artifact:9"
    elif mutation == "padded-id-index":
        artifact["id"] = JOB1 + ":artifact:00"
    else:
        original = Path(artifact["path"])
        new_name = JOB1 + ("-01-result.png" if mutation == "wrong-filename-index" else "-00-other.png")
        renamed = original.with_name(new_name)
        original.rename(renamed)
        artifact["path"] = str(renamed)
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(10)
    env.portal().tick()
    assert not [call for call in env.native.calls if call["file"]]
    assert state(env)["jobs"][JOB1]["error"] in ("artifact_undeclared", "artifact_unconfined")


@pytest.mark.parametrize("job_id", ["job-1", "../outside", "20260101-000000-abc"])
def test_noncanonical_runtime_job_id_is_rejected(env, job_id):
    original = env.runtime.request

    def response(request):
        value = original(request)
        if request["op"] == "submit":
            value["job"]["job_id"] = job_id
        return value

    env.runtime.request = response
    env.source.events.append(message())
    env.portal().tick()
    assert not state(env)["jobs"]
    assert any("runtime_protocol" in call["text"] for call in env.native.calls)


def sample_report(*threads):
    """Synthetic `sample` call graph: (count, queue, frames, wait_count) per thread."""
    lines = ["Sampling process 1 for 1 second", "", "Call graph:"]
    for index, (count, queue, frames, wait_count) in enumerate(threads, 1):
        lines.append(f"    {count} Thread_{index}   DispatchQueue_{index}: {queue}  (serial)")
        for depth, frame in enumerate(frames):
            lines.append(f"    {'  ' * depth}+ {count} {frame}  (in Synthetic) + 4  [0x{depth:x}]")
        lines.append(f"    {'  ' * len(frames)}+ {wait_count} xpc_connection_send_message_with_reply_sync  (in libxpc.dylib) + 8  [0xff]")
    lines += ["", "Total number in stack (recursive counted multiple, when >=5):", "Binary Images:"]
    return "\n".join(lines)


def test_doctor_names_dasd_as_the_root_of_a_wedged_imessage_chain():
    from rapp_bubbles import doctor

    reports = {
        "imagent": sample_report(
            (500, "com.apple.bg.system.task.internal.queue", ["-[_DASScheduler submitTaskRequestWithIdentifier:]"], 500),
            (500, "com.apple.IDSDaemonControllerConnectingQueue", ["??? (in IDS)"], 500),
        ),
        "identityservicesd": sample_report(
            (500, "com.apple.main-thread", ["-[KTOptInManager getOptInState]"], 500),
        ),
        "transparencyd": sample_report(
            (500, "com.apple.bg.system.task.internal.queue", ["-[BGSystemTaskScheduler submitTaskRequest:error:]"], 500),
        ),
        "callservicesd": sample_report(
            (500, "com.apple.telephonyutilities.callcapabilitiesxpcclient", ["??? (in TelephonyUtilities)"], 500),
        ),
    }
    pids = {"Messages": 1, "imagent": 2, "identityservicesd": 3, "transparencyd": 4, "callservicesd": 5}
    result = doctor.diagnose(pids, reports, "timeout")
    assert result["verdict"] == "dasd_unresponsive" and result["ok"] is False
    assert result["roots"] == ["dasd"]
    assert result["fix"] == "sudo launchctl kickstart -k system/com.apple.dasd"
    assert {(edge["from"], edge["to"]) for edge in result["edges"]} == {
        ("imagent", "dasd"), ("imagent", "identityservicesd"),
        ("identityservicesd", "transparencyd"), ("transparencyd", "dasd"),
    }


def test_doctor_does_not_blame_brief_waits_and_reports_healthy_stack():
    from rapp_bubbles import doctor

    brief = sample_report((500, "com.apple.bg.system.task.internal.queue", ["-[_DASScheduler submitTask]"], 3))
    assert doctor.blocked_waits(brief) == []
    result = doctor.diagnose({"Messages": 1, "imagent": 2}, {"imagent": brief}, "connected")
    assert result["verdict"] == "healthy" and result["ok"] is True and not result["edges"]


def test_doctor_names_a_missing_dependency_and_a_missing_messages_app():
    from rapp_bubbles import doctor

    waiting = sample_report((500, "com.apple.IDSDaemonControllerConnectingQueue", ["??? (in IDS)"], 500))
    result = doctor.diagnose({"Messages": 1, "imagent": 2}, {"imagent": waiting}, "timeout")
    assert result["verdict"] == "blocked_on_identityservicesd"
    assert "not running" in result["explanation"] and "fix" not in result
    assert doctor.diagnose({"imagent": 2}, {}, None)["verdict"] == "messages_not_running"


def feed_post(env, **changes):
    from rapp_bubbles import feed

    values = {"text": "Loop 01\n1. Ship it\n2. Hold", "options": 2, "ttl": 300, "channel": "loop"}
    values.update(changes)
    config = env.config()
    with Store(config.state_dir) as store:
        outbox = Outbox(config, store, env.native, env.clock, env.source.target_matches, env.source.tail)
        return feed.post(store, outbox, ACTOR, TARGET, now=env.clock(), **values)["id"]


def delivered_feed_post(env, **changes):
    post_id = feed_post(env, **changes)
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    assert state(env)["feed"][post_id]["state"] == "open"
    return post_id


def test_feed_post_is_enveloped_and_the_adjacent_bare_reply_answers_it(env):
    post_id = feed_post(env)
    env.portal().tick()
    assert [call["text"] for call in env.native.calls] == ["[RAPP loop] Loop 01\n1. Ship it\n2. Hold"]
    env.clock.advance(10)
    env.source.events.append(message(1, "2"))
    env.portal().tick()
    item = state(env)["feed"][post_id]
    assert item["state"] == "answered"
    assert item["answer"]["number"] == 2 and item["answer"]["explicit"] is False
    assert len(env.native.calls) == 1 and not env.runtime.calls


def test_feed_reply_after_an_intervening_message_needs_explicit_rapp_reply(env):
    post_id = delivered_feed_post(env, options=3)
    env.source.prior_guids[CHAT] = "OTHER-AI-UPDATE"
    env.source.events.append(message(1, "2"))
    env.portal().tick()
    assert state(env)["feed"][post_id]["state"] == "open"
    env.source.events.append(message(2, "RAPP reply 3"))
    env.portal().tick()
    item = state(env)["feed"][post_id]
    assert item["state"] == "answered" and item["answer"]["number"] == 3 and item["answer"]["explicit"] is True
    assert any("Got it." in call["text"] for call in env.native.calls)


def test_bare_number_under_a_feed_card_answers_it_instead_of_an_older_approval(env):
    env.source.events.append(message(1, "RAPP inspect these files"))
    env.portal().tick()
    assert submitted(env)
    env.clock.advance(10)
    post_id = delivered_feed_post(env)
    env.source.events.append(message(2, "2"))
    env.portal().tick()
    assert state(env)["feed"][post_id]["answer"]["number"] == 2
    assert not [call for call in env.runtime.calls if call["op"] in ("approve", "cancel")]


@pytest.mark.parametrize("text", ["restart", "wake up", "Shut down"])
def test_lifecycle_words_under_a_feed_card_stay_with_the_legacy_watcher(env, text):
    post_id = delivered_feed_post(env)
    env.source.events.append(message(1, text))
    env.portal().tick()
    assert state(env)["feed"][post_id]["state"] == "open"


def test_feed_reply_window_expires_after_delivery(env):
    post_id = delivered_feed_post(env, ttl=30)
    env.clock.advance(31)
    env.portal().tick()
    assert state(env)["feed"][post_id]["state"] == "expired"
    env.source.events.append(message(1, "1"))
    env.portal().tick()
    assert state(env)["feed"][post_id]["answer"] is None


def test_feed_image_card_reply_is_captured_by_attachment_adjacency(env):
    card = env.root / "card.png"
    card.write_bytes(b"synthetic card")
    post_id = feed_post(env, text="Loop 01 card", file=str(card))
    env.portal().tick()
    call = env.native.calls[0]
    assert call["file"].endswith("-card.png") and call["text"] == "[RAPP loop] Loop 01 card"
    env.clock.advance(10)
    env.portal().tick()
    env.source.events.append(message(1, "1"))
    env.portal().tick()
    assert state(env)["feed"][post_id]["answer"]["number"] == 1


def test_unhealthy_messages_holds_sends_and_a_newer_post_replaces_the_stale_one(env):
    healthy = []

    def health(value, _now):
        value["code"] = "connected" if healthy else "imessage_account_blocked"
        return bool(healthy)

    env.native.health = health
    first = feed_post(env, text="Loop 01")
    env.portal().tick()
    assert not env.native.calls
    assert state(env)["imessage_health"]["code"] == "imessage_account_blocked"
    second = feed_post(env, text="Loop 02")
    assert state(env)["feed"][first]["state"] == "superseded"
    healthy.append(True)
    env.clock.advance(60)
    env.portal().tick()
    assert [call["text"] for call in env.native.calls] == ["[RAPP loop] Loop 02"]
    assert state(env)["feed"][second]["state"] == "pending"


def test_native_health_gate_relaunches_backs_off_and_fails_open(env, monkeypatch):
    from rapp_bubbles import clients

    calls, pid, answers = [], {"value": None}, {}
    monkeypatch.setattr(clients, "messages_pid", lambda: pid["value"])
    monkeypatch.setattr(clients, "launch_messages", lambda: calls.append("launch"))
    monkeypatch.setattr(clients, "restart_messages", lambda value: calls.append(("restart", value)))
    monkeypatch.setattr(clients, "osascript",
                        lambda script, _timeout: answers["account" if "connection status" in script else "name"])
    native, health = NativeClient(env.config()), {}
    assert native.health(health, 1000) is False and health["code"] == "messages_relaunched" and calls == ["launch"]
    assert native.health(health, 1010) is False and calls == ["launch"]
    pid["value"] = 42
    answers.update(name=("ok", "Messages"), account=("unresponsive", ""))
    assert native.health(health, 1050) is False and health["code"] == "imessage_account_blocked"
    assert "rapp_bubbles.doctor" in health["hint"]
    answers["account"] = ("missing", "")
    assert native.health(health, 1100) is False and health["code"] == "imessage_account_missing"
    answers["account"] = ("ok", "connected")
    assert native.health(health, 1150) is True and health["code"] == "connected" and "hint" not in health
    assert native.health(health, 1250) is True
    answers["name"] = ("unresponsive", "")
    assert native.health(health, 1300) is False and health["code"] == "messages_unresponsive"
    assert native.health(health, 1500) is False and health["code"] == "messages_unresponsive"
    assert native.health(health, 1650) is False and health["code"] == "messages_restarted"
    assert native.health(health, 1700) is False and native.health(health, 1900) is False
    assert calls.count(("restart", 42)) == 1
    answers["name"] = ("error", "")
    assert native.health(health, 2000) is True and health["code"] == "health_unverified"


def test_cli_post_targets_only_the_authorized_direct_thread_and_reports_status(env, capsys):
    from rapp_bubbles import cli

    make_database(env).close()
    path = env.root / "private-portal.json"
    path.write_text(json.dumps(env.raw))
    path.chmod(0o600)
    assert cli.main(["--config", str(path), "post", "--text", "Loop 01", "--options", "2"]) == 0
    posted = json.loads(capsys.readouterr().out)
    assert posted["ok"] is True and posted["state"] == "pending"
    assert cli.main(["--config", str(path), "feed-status", "--id", posted["post"]]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["posts"][0]["parts"] == ["queued"] and report["posts"][0]["options"] == 2
    assert cli.main(["--config", str(path), "post", "--text", "x", "--route", "5"]) == 1
    assert json.loads(capsys.readouterr().out)["error"]["code"] == "feed_target"
    assert cli.main(["--config", str(path), "transport-status"]) == 0
    assert json.loads(capsys.readouterr().out)["feed"] == ["pending"]


@pytest.mark.parametrize("reply", ["²", "①", "٣", "9" * 5000, "0", "10"])
def test_non_ascii_or_oversized_digit_replies_never_wedge_ticks(env, reply):
    post_id = delivered_feed_post(env, options=3)
    env.source.events.append(message(1, reply))
    env.portal().tick()
    env.portal().tick()
    answer = state(env)["feed"][post_id]["answer"]
    assert answer is not None and answer["number"] is None


def approved_running_job(env):
    env.source.events.append(message(1, "RAPP inspect these files"))
    env.portal().tick()
    env.clock.advance(10)
    env.source.events.append(message(2, "1"))
    env.portal().tick()
    assert [call for call in env.runtime.calls if call["op"] == "approve"]
    return env.native.calls[-1]["text"]


def explicit_ops(env, op):
    return [call for call in env.runtime.calls if call["op"] == op and "stdout_offset" not in call]


def progress_parts(env):
    return [part for part in state(env)["outbox"] if part.get("card") == "progress"]


def test_bare_digits_under_a_running_card_pick_its_options(env):
    card = approved_running_job(env)
    assert card.splitlines()[0].startswith("[RAPP 0001] ● ")
    assert "[1] Details\n[2] Stop\n[3] Quiet" in card
    env.clock.advance(10)
    env.source.events.append(message(3, "1"))
    env.portal().tick()
    assert len(explicit_ops(env, "status")) == 1
    env.clock.advance(10)
    env.source.events.append(message(4, "3"))
    env.portal().tick()
    assert state(env)["jobs"][JOB1]["stream"]["quiet"] is True
    env.clock.advance(10)
    env.source.events.append(message(5, "2"))
    env.portal().tick()
    assert [call for call in env.runtime.calls if call["op"] == "cancel" and call["job_id"] == JOB1]


def test_bare_digit_not_directly_under_a_card_is_left_for_other_ais(env):
    approved_running_job(env)
    sent = len(env.native.calls)
    env.source.prior_guids[CHAT] = "OTHER-AI-MESSAGE"
    env.source.events.append(message(3, "3"))
    env.portal().tick()
    assert not state(env)["jobs"][JOB1]["stream"].get("quiet") and len(env.native.calls) == sent
    env.source.events.append(message(4, "RAPP 3"))
    env.portal().tick()
    assert state(env)["jobs"][JOB1]["stream"]["quiet"] is True


def test_a_number_under_one_tasks_card_never_approves_another_pending_task(env):
    approved_running_job(env)
    env.clock.advance(10)
    env.source.events.append(message(3, "RAPP another task"))
    env.portal().tick()
    env.clock.advance(200)
    env.portal().tick()
    assert env.native.calls[-1]["text"].startswith("[RAPP 0001] ● ")
    env.clock.advance(10)
    env.source.events.append(message(4, "1"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "approve" and call["job_id"] != JOB1]
    assert len(explicit_ops(env, "status")) == 1


def test_silent_long_task_backs_off_caps_updates_and_still_delivers_the_final(env):
    approved_running_job(env)
    started = env.clock.now
    for _ in range(6 * 60):
        env.clock.advance(60)
        env.portal().tick()
    updates = progress_parts(env)
    assert len(updates) == 10
    gaps = [b["created_at"] - a["created_at"] for a, b in zip(updates, updates[1:])]
    assert updates[0]["created_at"] - started >= 120
    assert max(gaps) <= 1800 + 60 and min(gaps) >= 90
    # Heartbeats back off; the one stall milestone falls between two of them.
    stall = next(i for i, part in enumerate(updates) if "stalled · " in part["text"].splitlines()[0])
    beats = [part["created_at"] for i, part in enumerate(updates) if i != stall]
    beat_gaps = [b - a for a, b in zip(beats, beats[1:])]
    assert all(later >= earlier - 60 for earlier, later in zip(beat_gaps, beat_gaps[1:]))
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(60)
    env.portal().tick()
    final = env.native.calls[-1]["text"]
    assert final.splitlines()[0].startswith("[RAPP 0001] ✓ Done")
    assert "[1] Full result\n[2] Recent jobs" in final and "worker exit 0" in final
    assert len(state(env)["eta_history"]["synthetic-workspace"]) == 1


def test_quiet_stops_automatic_updates_but_not_the_final(env):
    approved_running_job(env)
    env.clock.advance(10)
    env.source.events.append(message(3, "RAPP quiet 0001"))
    env.portal().tick()
    before = len(env.native.calls)
    for _ in range(60):
        env.clock.advance(60)
        env.portal().tick()
    assert len(env.native.calls) == before
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(10)
    env.portal().tick()
    assert env.native.calls[-1]["text"].startswith("[RAPP 0001] ✓ Done")


def test_outage_keeps_one_queued_update_and_the_final_replaces_it(env):
    approved_running_job(env)
    healthy = [False]
    env.native.health = lambda value, now: healthy[0]
    sent = len(env.native.calls)
    for _ in range(90):
        env.clock.advance(60)
        env.portal().tick()
    assert len([part for part in progress_parts(env) if part["state"] == "queued"]) == 1
    assert len(env.native.calls) == sent
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(10)
    env.portal().tick()
    assert not [part for part in progress_parts(env) if part["state"] == "queued"]
    healthy[0] = True
    env.clock.advance(60)
    env.portal().tick()
    fresh = [call["text"] for call in env.native.calls[sent:]]
    assert len(fresh) == 1 and fresh[0].startswith("[RAPP 0001] ✓ Done")


def test_itui_eta_is_honest_about_its_basis():
    from rapp_bubbles import itui

    unknown = itui.estimate(240, None, [])
    assert unknown["basis"] == "none" and unknown["fraction"] is None and "no ETA yet" in unknown["detail"]
    typical = itui.estimate(120, None, [600, 660, 540])
    assert typical["status"] == "~8m left" and 0 < typical["fraction"] < 0.9
    overdue = itui.estimate(1000, None, [600, 660, 540])
    assert overdue["status"] == "long · 17m" and overdue["remaining"] is None
    worker = itui.estimate(300, {"done": 3, "total": 6, "label": "encode"}, [])
    assert worker["status"] == "~5m left" and worker["fraction"] == 0.5 and "step 3/6" in worker["detail"]
    assert itui.marker([{"type": "progress", "done": 2, "total": 0}, {"id": "x"}]) is None
    assert itui.marker([{"type": "progress", "done": 2, "total": 5, "label": "frames"}])["done"] == 2


def test_every_itui_card_is_guarded_and_its_structural_lines_fit_a_phone(env):
    import re

    from rapp_bubbles import itui

    approved_running_job(env)
    for _ in range(30):
        env.clock.advance(60)
        env.portal().tick()
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(10)
    env.portal().tick()
    assert len(env.native.calls) >= 5
    for call in env.native.calls:
        text, lines = call["text"], call["text"].splitlines()
        assert re.match(r"\s*\[rapp\s", text, re.IGNORECASE)
        structural = [lines[0]] + [
            line for line in lines
            if line == itui.RULE or re.fullmatch(r"\[\d\] .+", line) or " · ref " in line or line.startswith("ref ")
        ]
        assert all(len(line) <= itui.WIDTH for line in structural), structural
        assert itui.parse(text)["options"], text


def test_a_menu_reply_is_dispatched_once_even_when_reread(env):
    approved_running_job(env)
    env.clock.advance(10)
    env.source.events.append(message(3, "1"))
    for _ in range(3):
        env.portal().tick()
    assert len(explicit_ops(env, "status")) == 1


def test_short_job_refs_work_and_quiet_words_can_still_start_tasks(env):
    approved_running_job(env)
    env.clock.advance(10)
    env.source.events.append(message(3, "RAPP status 0001"))
    env.portal().tick()
    assert len(explicit_ops(env, "status")) == 1
    env.source.events.append(message(4, "RAPP quiet the fans"))
    env.portal().tick()
    assert len(submitted(env)) == 2


def test_rapp_number_without_an_open_card_explains_instead_of_guessing(env):
    env.source.events.append(message(1, "RAPP 5"))
    env.portal().tick()
    assert any("no_open_menu" in call["text"] for call in env.native.calls)
    assert not env.runtime.calls


def test_reply_to_the_card_on_the_phone_is_not_stolen_by_a_newer_queued_card(env):
    first = delivered_feed_post(env, text="Loop 01")
    env.native.health = lambda value, now: False
    second = feed_post(env, text="Loop 02")
    env.source.events.append(message(1, "2"))
    env.portal().tick()
    assert state(env)["feed"][first]["answer"]["number"] == 2
    assert state(env)["feed"][second]["state"] == "pending"


def owner_target(env):
    env.source.direct_target = lambda chat: {"chat_id": 1, "chat_guid": chat, "is_group": False}


def test_idle_ticks_do_not_rewrite_the_journal(env):
    env.source.events.append(message(1, "hello Claude"))
    env.portal().tick()
    env.portal().tick()
    path = Path(env.raw["state_dir"]) / "transport.json"
    before = (path.stat().st_mtime_ns, path.stat().st_ino)
    for _ in range(5):
        env.clock.advance(10)
        env.portal().tick()
    assert (path.stat().st_mtime_ns, path.stat().st_ino) == before


def test_compaction_drops_only_old_settled_records_past_the_late_window(env):
    env.source.events.append(message(1, "RAPP help"))
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    with Store(env.config().state_dir) as store:
        assert store.data["outbox"][0]["state"] == "delivered"
        uncertain = copy.deepcopy(store.data["outbox"][0])
        uncertain.update(id="old-unknown", group="old-unknown", state="unknown", text="[RAPP old] never seen")
        uncertain.pop("guid", None)
        store.data["outbox"].append(uncertain)
        store.data["cursor"] = 10_000
        store.save()
    env.clock.advance(15 * 86400)
    env.portal().tick()
    saved = state(env)
    assert [part["id"] for part in saved["outbox"]] == ["old-unknown"]
    assert not saved["inbox"]


def test_disk_pressure_warns_once_per_level_and_critical_pauses_new_tasks(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    owner_target(env)
    free = {"gib": 5}
    monkeypatch.setattr(portal_module.shutil, "disk_usage",
                        lambda _path: SimpleNamespace(total=100 * 2**30, used=0, free=free["gib"] * 2**30))
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    low = [call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ! Disk low")]
    assert len(low) == 1 and "5.0 GB free" in low[0] and "[1] Health\n[2] Recent jobs" in low[0]
    free["gib"] = 1
    env.clock.advance(10)
    env.portal().tick()
    assert env.native.calls[-1]["text"].startswith("[RAPP sys] ! Disk critical")
    env.source.events.append(message(1, "RAPP make a report"))
    env.clock.advance(10)
    env.portal().tick()
    assert not submitted(env)
    assert any("disk_low" in call["text"] for call in env.native.calls)


def test_imessage_outage_is_reported_once_after_recovery(env):
    from rapp_bubbles.clients import _verdict

    owner_target(env)
    connected = [False]
    env.native.health = lambda value, now: _verdict(
        value, now, connected[0], "connected" if connected[0] else "imessage_account_blocked")
    feed_post(env, text="Loop 01")
    env.portal().tick()
    env.clock.advance(20 * 60)
    env.portal().tick()
    connected[0] = True
    for _ in range(3):
        env.clock.advance(60)
        env.portal().tick()
    backs = [call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ✓ iMessage back")]
    assert len(backs) == 1 and "down 21m" in backs[0] and "imessage_account_blocked" in backs[0]


def test_a_long_gap_between_ticks_is_reported_once(env):
    owner_target(env)
    env.portal().tick()
    env.clock.advance(3 * 3600)
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    gaps = [call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ✓ Back online")]
    assert len(gaps) == 1 and "no ticks for 3h00m" in gaps[0]


def test_rapp_health_reports_imessage_disk_journal_and_outbox(env):
    env.source.events.append(message(1, "RAPP health"))
    env.portal().tick()
    text = env.native.calls[-1]["text"]
    assert text.startswith("[RAPP sys] · Health")
    assert "iMessage:" in text and "Disk:" in text and "Journal:" in text and "Outbox:" in text
    assert "[1] Health\n[2] Recent jobs" in text


def test_day_old_sent_receipts_are_not_polled_forever(env):
    env.source.events.append(message(1, "RAPP help"))
    env.portal().tick()
    guid = state(env)["outbox"][0]["guid"]
    env.native.states[guid] = "sent"
    checked = []
    original = env.native.status
    env.native.status = lambda value: checked.append(value) or original(value)
    env.clock.advance(10)
    env.portal().tick()
    assert state(env)["outbox"][0]["state"] == "sent" and checked
    before = len(checked)
    env.clock.advance(25 * 3600)
    for _ in range(3):
        env.clock.advance(10)
        env.portal().tick()
    # At most one look after its receipt window, then the part retires for good.
    assert len(checked) <= before + 1
    settled = len(checked)
    for _ in range(6):
        env.clock.advance(600)
        env.portal().tick()
    assert len(checked) == settled


def test_a_stray_digit_after_an_approval_expires_never_stops_another_task(env):
    approved_running_job(env)
    env.clock.advance(10)
    env.source.events.append(message(3, "RAPP another task"))
    env.portal().tick()
    env.clock.advance(400)
    env.portal().tick()
    env.source.prior_guids[CHAT] = "OTHER-AI-MESSAGE"
    env.source.events.append(message(4, "2"))
    env.portal().tick()
    env.source.events.append(message(5, "RAPP 2"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "cancel"]
    assert state(env)["jobs"][JOB1]["state"] == "running"


def test_repeated_long_cards_never_share_a_first_piece(env):
    approved_running_job(env)
    original = env.runtime.request

    def long_result(request):
        value = original(request)
        if request["op"] == "result":
            value["stdout"] = {**value["stdout"], "text": "y" * 5600}
            if value.get("result"):
                value["result"]["response"] = "x" * 5600
        return value

    env.runtime.request = long_result
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(10)
    env.portal().tick()
    env.source.events.extend([message(3, "RAPP result 0001"), message(4, "RAPP result 0001")])
    env.clock.advance(10)
    env.portal().tick()
    firsts = [part["text"] for part in state(env)["outbox"] if part["index"] == 0 and "⋯ 1/" in part["text"]]
    assert len(firsts) >= 3 and len(set(firsts)) == len(firsts)


def test_resend_by_short_part_ref_requeues_that_uncertain_part(env):
    approved_running_job(env)
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(10)
    env.portal().tick()
    with Store(env.config().state_dir) as store:
        final = next(part for part in store.data["outbox"] if part["group"] == f"job:{JOB1}:final")
        final.update(state="unknown", error="receipt_unconfirmed", text="[RAPP 0001] ✓ Done\nnever seen")
        final.pop("guid", None)
        store.save()
        ref = final["id"][:6]
    env.source.events.append(message(3, f"RAPP resend {ref}"))
    env.clock.advance(10)
    env.portal().tick()
    part = next(part for part in state(env)["outbox"] if part["id"].startswith(ref))
    assert part["attempt"] == 1 and any("[RAPP retry " in call["text"] for call in env.native.calls)


def test_a_failing_final_result_records_the_job_duration_once(env):
    env.source.events.append(message(1, "RAPP file result.png | create synthetic media"))
    env.portal().tick()
    env.clock.advance(10)
    env.source.events.append(message(2, "1"))
    env.portal().tick()
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    for _ in range(6):
        env.clock.advance(10)
        env.portal().tick()
    assert state(env)["jobs"][JOB1]["error"] == "artifact_missing"
    assert len(state(env)["eta_history"]["synthetic-workspace"]) == 1


def running_card_guid(env):
    return next(part for part in state(env)["outbox"] if part["group"].endswith(":approved"))["guid"]


def test_stop_under_an_hour_old_running_card_still_stops_the_live_job(env):
    approved_running_job(env)
    card = running_card_guid(env)
    for _ in range(8):
        env.clock.advance(600)
        env.portal().tick()
    env.source.prior_guids[CHAT] = card
    env.source.events.append(message(3, "2"))
    env.portal().tick()
    assert [call for call in env.runtime.calls if call["op"] == "cancel" and call["job_id"] == JOB1]


def test_a_digit_under_a_closed_card_gets_one_card_closed_reply_and_runs_nothing(env):
    approved_running_job(env)
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(10)
    env.portal().tick()
    env.clock.advance(2 * 3600)
    env.portal().tick()
    sent = len(env.native.calls)
    env.source.events.append(message(3, "2"))
    for _ in range(3):
        env.clock.advance(10)
        env.portal().tick()
    fresh = [call["text"] for call in env.native.calls[sent:]]
    assert len(fresh) == 1 and "Card closed" in fresh[0].splitlines()[0]
    assert not explicit_ops(env, "list")


def test_an_out_of_range_digit_under_a_live_card_gets_the_live_card_again(env):
    approved_running_job(env)
    sent = len(env.native.calls)
    env.clock.advance(10)
    env.source.events.append(message(3, "7"))
    env.portal().tick()
    fresh = [call["text"] for call in env.native.calls[sent:]]
    assert len(fresh) == 1 and "[1] Details\n[2] Stop\n[3] Quiet" in fresh[0]
    assert not [call for call in env.runtime.calls if call["op"] == "cancel"]


def test_rapp_n_answers_the_newest_card_even_when_it_is_an_agent_post(env):
    approved_running_job(env)
    env.clock.advance(10)
    post_id = feed_post(env, text="Loop 01", options=2)
    env.portal().tick()
    env.clock.advance(10)
    env.source.prior_guids[CHAT] = "OTHER-AI-MESSAGE"
    env.source.events.append(message(3, "RAPP 2"))
    env.portal().tick()
    assert state(env)["feed"][post_id]["answer"]["number"] == 2
    assert not [call for call in env.runtime.calls if call["op"] == "cancel"]
    env.source.events.append(message(4, "RAPP 3"))
    env.portal().tick()
    assert any("no_open_menu" in call["text"] for call in env.native.calls)
    assert not state(env)["jobs"][JOB1]["stream"].get("quiet")


def test_rapp_n_ignores_cards_sent_after_the_owner_typed(env):
    approved_running_job(env)
    env.source.tail = lambda: 1000
    env.clock.advance(130)
    env.portal().tick()
    assert state(env)["jobs"][JOB1]["stream"]["sent"] == 1
    env.source.events.append(message(3, "RAPP 1"))
    env.portal().tick()
    record = next(value for value in state(env)["inbox"].values() if value["event"]["id"] == 3)
    assert record["menu_pick"]["group"].endswith(":approved")


def test_running_bars_never_fill_and_stalled_workers_are_named(env):
    from rapp_bubbles import itui

    assert itui.bar(0.95).count("▰") == 9 and itui.bar(1.0, done=True).count("▰") == 10
    stalled = itui.estimate(1800, None, [600, 600, 600], idle=900, active=True)
    assert stalled["basis"] == "stall" and stalled["status"] == "stalled · 15m" and stalled["fraction"] is None
    assert itui.estimate(60, None, [], idle=60, active=False)["detail"] == "worker inactive"
    approved_running_job(env)
    for _ in range(16):
        env.clock.advance(60)
        env.portal().tick()
    stalls = [call["text"] for call in env.native.calls if "stalled · " in call["text"].splitlines()[0]]
    assert stalls and all("~" not in text.splitlines()[0] for text in stalls)


def test_a_long_gap_yields_one_catch_up_update_not_a_burst(env):
    approved_running_job(env)
    env.clock.advance(2 * 3600)
    env.portal().tick()
    for _ in range(10):
        env.clock.advance(60)
        env.portal().tick()
    assert len(progress_parts(env)) <= 2
    assert state(env)["jobs"][JOB1]["stream"]["slot"] >= 6


def test_the_footer_promises_exactly_the_next_heartbeat(env):
    card = approved_running_job(env)
    assert card.splitlines()[-1].startswith("next ~2m")
    started = state(env)["jobs"][JOB1]["started_at"]
    for _ in range(30):
        env.clock.advance(20)
        env.portal().tick()
    first = progress_parts(env)[0]
    assert 120 <= first["created_at"] - started <= 140


def test_an_outage_does_not_spend_the_update_budget_and_iMessage_back_leads_the_backlog(env):
    from rapp_bubbles.clients import _verdict

    owner_target(env)
    approved_running_job(env)
    connected = [False]
    env.native.health = lambda value, now: _verdict(
        value, now, connected[0], "connected" if connected[0] else "imessage_account_blocked")
    for _ in range(120):
        env.clock.advance(60)
        env.portal().tick()
    assert state(env)["jobs"][JOB1]["stream"]["sent"] <= 1
    sent = len(env.native.calls)
    connected[0] = True
    for _ in range(4):
        env.clock.advance(60)
        env.portal().tick()
    fresh = [call["text"] for call in env.native.calls[sent:]]
    assert fresh and fresh[0].startswith("[RAPP sys] ✓ iMessage back")


def test_an_uncertain_part_backs_off_then_retires_but_explicit_resend_still_reconciles(env):
    approved_running_job(env)
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(10)
    env.portal().tick()
    with Store(env.config().state_dir) as store:
        final = next(part for part in store.data["outbox"] if part["group"] == f"job:{JOB1}:final")
        final.update(state="unknown", error="receipt_unconfirmed", text="[RAPP 0001] ✓ Done\nnot yet visible")
        final.pop("guid", None)
        store.save()
        ref = final["id"][:6]
    polls = len(env.native.history_calls)
    for _ in range(288):
        env.clock.advance(300)
        env.portal().tick()
    first_day = len(env.native.history_calls) - polls
    assert 0 < first_day <= 120
    retired = len(env.native.history_calls)
    for _ in range(48):
        env.clock.advance(1800)
        env.portal().tick()
    assert len(env.native.history_calls) == retired
    sends = len(env.native.calls)
    env.source.events.append(message(3, f"RAPP resend {ref}"))
    env.portal().tick()
    assert len(env.native.history_calls) > retired
    assert any("[RAPP retry " in call["text"] for call in env.native.calls[sends:])


def test_polls_of_a_quiet_running_job_do_not_rewrite_the_journal(env, monkeypatch):
    approved_running_job(env)
    for _ in range(3):
        env.clock.advance(10)
        env.portal().tick()
    saves = []
    original = Store.save
    monkeypatch.setattr(Store, "save", lambda self: saves.append(1) or original(self))
    for _ in range(4):
        env.clock.advance(10)
        env.portal().tick()
    assert len(saves) <= 1


def test_rapp_n_never_acts_on_an_older_card_when_the_newest_one_closed(env):
    approved_running_job(env)
    env.clock.advance(130)
    env.portal().tick()
    assert state(env)["jobs"][JOB1]["stream"]["sent"] == 1
    post_id = feed_post(env, text="Ship it?", options=2, ttl=60)
    for step in (10, 10, 70):
        env.clock.advance(step)
        env.portal().tick()
    assert state(env)["feed"][post_id]["state"] == "expired"
    env.source.events.append(message(3, "RAPP 2"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "cancel"]
    assert any("no_open_menu" in call["text"] for call in env.native.calls)


def test_a_failed_receipt_check_does_not_use_up_the_parts_one_look(env):
    approved_running_job(env)
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.clock.advance(10)
    env.portal().tick()
    with Store(env.config().state_dir) as store:
        final = next(part for part in store.data["outbox"] if part["group"] == f"job:{JOB1}:final")
        final["state"] = "submitted"
        for field in ("guid", "last_checked", "receipt_looked_at"):
            final.pop(field, None)
        store.save()
    env.clock.advance(2 * 86400)
    calls = []
    original = env.native.history

    def flaky(chat_id, since, until):
        calls.append(chat_id)
        if len(calls) == 1:
            raise PortalError("native_timeout", "Synthetic boot-time timeout.")
        return original(chat_id, since, until)

    env.native.history = flaky
    for _ in range(30):
        env.clock.advance(600)
        env.portal().tick()
    final = next(part for part in state(env)["outbox"] if part["group"] == f"job:{JOB1}:final")
    assert len(calls) >= 2 and final["state"] in ("sent", "delivered")


def at(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat()


def running_part(env, job_id=JOB1):
    return next(part for part in state(env)["outbox"]
                if part.get("menu_kind") == "running" and part["job_id"] == job_id)


def test_reader_skips_tapbacks_and_reports_swipe_reply_targets(env):
    db = make_database(env)
    db.execute("ALTER TABLE message ADD COLUMN thread_originator_guid TEXT")
    source = SQLiteSource(env.config())
    insert_message(db, 1, "[RAPP 0001] ? Approve task?", guid="CARD")
    db.execute(
        "INSERT INTO message(ROWID,guid,text,attributedBody,date,is_from_me,service,handle_id,"
        "cache_has_attachments,associated_message_guid,associated_message_type) "
        "VALUES(2,'TAPBACK','Liked a message',NULL,1,0,'iMessage',1,0,'p:0/CARD',2001)"
    )
    db.execute("INSERT INTO chat_message_join VALUES(2,1)")
    insert_message(db, 3, "1", guid="DIGIT")
    insert_message(db, 4, "2", guid="QUOTED")
    db.execute("UPDATE message SET thread_originator_guid='CARD' WHERE ROWID=4")
    db.commit()
    events = {event["guid"]: event for event in source.poll(0, 0)}
    # A reaction to the card is not a message between the card and the reply.
    assert source.latest_prior_guid(events["DIGIT"]) == "CARD"
    assert events["QUOTED"]["reply_to"] == "CARD" and events["DIGIT"]["reply_to"] is None
    source.close()
    db.close()


def test_a_swipe_reply_digit_answers_the_quoted_card_not_the_newest(env):
    approved_running_job(env)
    running = running_part(env)
    env.clock.advance(10)
    env.source.events.append(message(3, "RAPP help"))
    env.portal().tick()
    env.clock.advance(10)
    env.source.events.append(message(4, "2", reply_to=running["guid"]))
    env.portal().tick()
    assert [call["job_id"] for call in env.runtime.calls if call["op"] == "cancel"] == [JOB1]


def test_a_swipe_reply_to_another_ais_message_is_left_alone(env):
    env.source.events.append(message())
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    before = len(env.native.calls)
    # Our approval card is the row directly above, but the owner quoted someone else.
    env.source.events.append(message(2, "1", reply_to="OTHER-AI-MESSAGE"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]
    assert len(env.native.calls) == before


def test_a_digit_that_lands_with_its_card_runs_nothing_and_reoffers_the_card(env):
    env.source.events.append(message())
    env.portal().tick()
    card = approval_part(env)
    env.clock.advance(10)
    env.source.events.append(message(2, "1", created_at=at(card["submitted_at"] + 1)))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]
    offer = env.native.calls[-1]["text"]
    assert offer.startswith("[RAPP 0001] ? Approve task?") and "nothing ran" in offer
    assert "[1] Approve\n[2] Cancel" in offer
    env.clock.advance(10)
    env.source.events.append(message(3, "1", created_at=at(env.clock.now)))
    env.portal().tick()
    assert [call["job_id"] for call in env.runtime.calls if call["op"] == "approve"] == [JOB1]


def test_a_stop_digit_that_lands_with_a_new_card_runs_nothing(env):
    approved_running_job(env)
    running = running_part(env)
    env.clock.advance(10)
    env.source.events.append(message(3, "2", created_at=at(running["submitted_at"] + 2)))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "cancel"]
    card = env.native.calls[-1]["text"]
    assert card.startswith("[RAPP 0001] ● ") and "nothing ran" in card and "[2] Stop" in card


def test_rapp_n_typed_as_a_new_card_lands_reoffers_it_and_runs_nothing(env):
    approved_running_job(env)
    running = running_part(env)
    env.clock.advance(10)
    env.source.events.append(message(3, "RAPP 2", created_at=at(running["submitted_at"] + 1)))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "cancel"]
    offer = env.native.calls[-1]["text"]
    assert offer.startswith("[RAPP 0001] ● ") and "nothing ran" in offer and "[2] Stop" in offer
    # The re-offered card is now the newest, so sending it again does what was meant.
    env.clock.advance(10)
    env.source.events.append(message(4, "RAPP 2", created_at=at(env.clock.now)))
    env.portal().tick()
    assert [call["job_id"] for call in explicit_ops(env, "cancel")] == [JOB1]


def test_rapp_1_approves_only_when_the_newest_card_is_that_approval(env):
    approved_running_job(env)
    env.clock.advance(10)
    env.source.events.append(message(3, "RAPP another task"))
    env.portal().tick()
    env.clock.advance(130)
    env.portal().tick()
    assert progress_parts(env), "job 1's heartbeat is now the newest card"
    env.clock.advance(10)
    env.source.events.append(message(4, "RAPP 1"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "approve" and call["job_id"] != JOB1]


def test_rapp_1_under_a_lapsed_approval_card_runs_nothing(env):
    env.source.events.append(message())
    env.portal().tick()
    env.clock.advance(400)
    env.source.events.append(message(2, "RAPP 1"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]
    assert any("approval_expired" in call["text"] for call in env.native.calls)


def test_a_bare_digit_under_a_lapsed_approval_card_says_it_closed(env):
    env.source.events.append(message())
    env.portal().tick()
    env.clock.advance(400)
    env.source.events.append(message(2, "1"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]
    closed = env.native.calls[-1]["text"]
    assert closed.splitlines()[0] == "[RAPP 0001] ○ Expired" and "nothing ran" in closed


def test_rapp_number_with_extra_words_approves_nothing(env):
    env.source.events.append(message())
    env.portal().tick()
    env.clock.advance(10)
    env.source.events.append(message(2, "RAPP 1 please"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]
    hint = env.native.calls[-1]["text"]
    assert "RAPP approve <ref>" in hint and "waiting: 0001" in hint


def test_an_unconfirmed_newest_card_blocks_rapp_n_without_falling_back(env):
    approved_running_job(env)
    with Store(env.config().state_dir) as store:
        running = next(part for part in store.data["outbox"] if part.get("menu_kind") == "running")
        newer = copy.deepcopy(running)
        newer.update(id="newer-unknown", group=f"job:{JOB1}:update:9", state="unknown",
                     submitted_at=running["submitted_at"] + 5, text="[RAPP 0001] ● newer")
        newer.pop("guid", None)
        store.data["outbox"].append(newer)
        store.save()
    env.clock.advance(10)
    env.source.events.append(message(3, "RAPP 2"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "cancel"]
    assert any("may not have reached your phone" in call["text"] for call in env.native.calls)


def test_the_first_card_after_a_long_wait_for_approval_is_not_stalled(env):
    # Longer than the stall line, so both output silence and worker inactivity would show.
    env.runtime.approval_ttl = 3600
    env.source.events.append(message())
    env.portal().tick()
    for _ in range(11):
        env.clock.advance(60)
        env.portal().tick()
    env.source.events.append(message(2, "1"))
    env.portal().tick()
    assert [call for call in env.runtime.calls if call["op"] == "approve"]
    first = env.native.calls[-1]["text"]
    assert first.startswith("[RAPP 0001] ● ") and "stalled" not in first and "inactive" not in first


def test_a_queued_job_is_waiting_not_stalled(env):
    approved_running_job(env)
    env.runtime.jobs[JOB1]["status"] = "queued"
    for _ in range(25):
        env.clock.advance(60)
        env.portal().tick()
    cards = [call["text"] for call in env.native.calls if call["text"].startswith("[RAPP 0001]")]
    assert any(text.splitlines()[0].endswith("Queued") for text in cards)
    assert not any("stalled" in text or "inactive" in text for text in cards)


def test_a_stall_held_back_by_card_spacing_is_still_announced(env):
    from rapp_bubbles import itui

    approved_running_job(env)
    started = env.clock.now
    real = env.runtime.request

    def request(value):
        response = real(value)
        if value["op"] == "status" and env.clock.now <= started + 600:
            response["stdout"] = {**response["stdout"], "next_offset": 24 + int(env.clock.now - started)}
        return response

    env.runtime.request = request
    for _ in range(30):
        env.clock.advance(60)
        env.portal().tick()
    stalls = [part for part in progress_parts(env) if "stalled · " in part["text"].splitlines()[0]]
    # Output stopped at 10m, so the stall began one tick after the 20m heartbeat.
    assert stalls and stalls[0]["created_at"] - started <= 1200 + 60 + itui.MIN_GAP


def disk(monkeypatch, free):
    from rapp_bubbles import portal as portal_module

    monkeypatch.setattr(portal_module.shutil, "disk_usage", lambda _path: SimpleNamespace(
        total=100 * 2**30, used=0, free=int(free["gib"] * 2**30)))


def disk_cards(env):
    return [call["text"] for call in env.native.calls
            if call["text"].startswith("[RAPP sys]") and " Disk " in call["text"].splitlines()[0]]


def test_disk_hovering_at_a_threshold_sends_one_card_and_writes_nothing(env, monkeypatch):
    owner_target(env)
    free = {"gib": 9.9}
    disk(monkeypatch, free)
    for _ in range(3):
        env.portal().tick()
        env.clock.advance(10)
    journal = (Path(env.raw["state_dir"]) / "transport.json").read_bytes()
    for index in range(60):
        free["gib"] = 10.1 if index % 2 else 9.9
        env.clock.advance(10)
        env.portal().tick()
    cards = disk_cards(env)
    assert len(cards) == 1 and cards[0].startswith("[RAPP sys] ! Disk low")
    assert (Path(env.raw["state_dir"]) / "transport.json").read_bytes() == journal


def test_disk_recovery_holds_then_sends_one_resolve_card(env, monkeypatch):
    owner_target(env)
    free = {"gib": 1}
    disk(monkeypatch, free)
    env.portal().tick()
    assert disk_cards(env)[-1].startswith("[RAPP sys] ! Disk critical")
    free["gib"] = 50
    env.clock.advance(10)
    env.source.events.append(message(1, "RAPP make a report"))
    env.portal().tick()
    # Refusal follows the disk right now; only the cards wait out the hold.
    assert submitted(env) and len(disk_cards(env)) == 1
    for _ in range(10):
        env.clock.advance(60)
        env.portal().tick()
    cards = disk_cards(env)
    assert len(cards) == 2 and cards[1].startswith("[RAPP sys] ✓ Disk ok") and "tasks resume" in cards[1]
    for _ in range(10):
        env.clock.advance(60)
        env.portal().tick()
    assert len(disk_cards(env)) == 2


def test_leaving_critical_for_low_sends_one_card_and_no_reminder_after_it(env, monkeypatch):
    owner_target(env)
    free = {"gib": 1}
    disk(monkeypatch, free)
    env.portal().tick()
    free["gib"] = 6
    for _ in range(14):
        env.clock.advance(60)
        env.portal().tick()
    cards = disk_cards(env)
    assert len(cards) == 2 and cards[1].startswith("[RAPP sys] ! Disk low") and "tasks resume" in cards[1]


def test_a_digit_typed_before_its_card_was_sent_runs_nothing(env):
    approved_running_job(env)
    running = running_part(env)
    env.clock.advance(10)
    # Typed before the card existed, though it reached chat.db after it: meant for something else.
    env.source.events.append(message(3, "2", created_at=at(running["submitted_at"] - 30)))
    env.portal().tick()
    env.source.events.append(message(4, "RAPP 2", created_at=at(running["submitted_at"] - 1)))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "cancel"]
    assert state(env)["jobs"][JOB1]["state"] == "running"


def test_disk_hovering_at_the_exit_line_writes_once_then_resolves_after_the_hold(env, monkeypatch):
    owner_target(env)
    free = {"gib": 5}
    disk(monkeypatch, free)
    for _ in range(4):
        env.portal().tick()
        env.clock.advance(10)
    assert len(disk_cards(env)) == 1
    journal = Path(env.raw["state_dir"]) / "transport.json"
    free["gib"] = 12.1
    env.portal().tick()
    written = journal.read_bytes()
    for index in range(40):
        free["gib"] = 11.9 if index % 2 == 0 else 12.1
        env.clock.advance(10)
        env.portal().tick()
    assert journal.read_bytes() == written and len(disk_cards(env)) == 1
    for index in range(30):
        free["gib"] = 11.9 if index % 2 == 0 else 12.1
        env.clock.advance(10)
        env.portal().tick()
    cards = disk_cards(env)
    assert len(cards) == 2 and cards[1].startswith("[RAPP sys] ✓ Disk ok")


def test_tasks_and_updates_resume_as_soon_as_the_disk_leaves_critical(env, monkeypatch):
    owner_target(env)
    free = {"gib": 1}
    disk(monkeypatch, free)
    env.portal().tick()
    free["gib"] = 3  # out of critical, but not yet clear of its line: the card still waits
    env.clock.advance(10)
    card = approved_running_job(env)
    assert "updates paused" not in card
    for _ in range(4):
        env.clock.advance(60)
        env.portal().tick()
    assert progress_parts(env)
    assert [text.splitlines()[0] for text in disk_cards(env)] == ["[RAPP sys] ! Disk critical"]
    env.source.events.append(message(3, "RAPP health"))
    env.portal().tick()
    assert "3.0 GB free · low · easing from critical" in env.native.calls[-1]["text"]


def test_a_disk_that_worsens_again_after_its_resolve_card_alerts_at_once_and_holds_longer(env, monkeypatch):
    owner_target(env)
    free = {"gib": 1}
    disk(monkeypatch, free)
    env.portal().tick()
    free["gib"] = 6
    for _ in range(11):
        env.clock.advance(60)
        env.portal().tick()
    headers = lambda: [text.splitlines()[0] for text in disk_cards(env)]  # noqa: E731
    assert headers() == ["[RAPP sys] ! Disk critical", "[RAPP sys] ! Disk low"]
    free["gib"] = 1
    env.clock.advance(60)
    env.portal().tick()
    # Critical was announced minutes ago, but the owner was since told tasks resume.
    assert headers()[-1] == "[RAPP sys] ! Disk critical" and len(headers()) == 3
    free["gib"] = 6
    for _ in range(15):
        env.clock.advance(60)
        env.portal().tick()
    assert len(headers()) == 3  # after a flap the hold doubles
    for _ in range(10):
        env.clock.advance(60)
        env.portal().tick()
    assert len(headers()) == 4 and headers()[-1] == "[RAPP sys] ! Disk low"


def test_a_resolve_card_after_a_long_quiet_spell_is_not_followed_by_a_reminder(env, monkeypatch):
    owner_target(env)
    free = {"gib": 1}
    disk(monkeypatch, free)
    env.portal().tick()
    free["gib"] = 3  # tasks run again; no "tasks paused" reminder may claim otherwise
    for _ in range(7 * 15):
        env.clock.advance(240)
        env.portal().tick()
    assert len(disk_cards(env)) == 1
    free["gib"] = 6
    for _ in range(20):
        env.clock.advance(60)
        env.portal().tick()
    cards = disk_cards(env)
    assert len(cards) == 2 and cards[1].startswith("[RAPP sys] ! Disk low") and "tasks resume" in cards[1]


def test_a_changed_group_never_gets_an_old_tasks_approval_card_again(env):
    group = "iMessage;+;synthetic-group"
    env.raw["authorized"] = [{"sender": SENDER, "chat": group, "allow_group": True}]
    env.source.targets[1] = group
    members = {"chat_guid": group, "is_group": True, "chat_style": 43, "participants": [SENDER]}
    env.source.events.append(message(1, "RAPP inspect these files", **members))
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    assert env.native.calls[-1]["text"].startswith("[RAPP 0001] ? Approve task?")
    before = len(env.native.calls)
    grown = {**members, "participants": [SENDER, "new-member@example.invalid"]}
    env.source.events.append(message(2, "3", **grown))
    env.portal().tick()
    sent = [call["text"] for call in env.native.calls[before:]]
    assert sent and "This group changed" in sent[0]
    assert not any("Approve task?" in text or "inspect these files" in text for text in sent)


def test_an_unconfirmed_attachment_does_not_close_its_delivered_result_card(env):
    approved_running_job(env)
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    for _ in range(2):
        env.clock.advance(10)
        env.portal().tick()
    with Store(env.config().state_dir) as store:
        final = next(part for part in store.data["outbox"] if part["group"] == f"job:{JOB1}:final")
        assert final["state"] == "delivered"
        bubble = copy.deepcopy(final)
        bubble.update(id="final-file", index=1, state="unknown", file={"path": "/synthetic/rapp-final-file-report.txt"},
                      caption="[RAPP artifact final-file]\nreport.txt", submitted_at=final["submitted_at"] + 1)
        for field in ("text", "guid"):
            bubble.pop(field, None)
        store.data["outbox"].append(bubble)
        store.save()
    env.clock.advance(10)
    env.source.events.append(message(3, "RAPP 1"))
    env.portal().tick()
    assert not any("may not have reached your phone" in call["text"] for call in env.native.calls)
    assert any(part["group"].startswith(f"job:{JOB1}:requested:") for part in state(env)["outbox"])


def test_a_swipe_reply_to_any_bubble_of_a_long_approval_card_approves_it(env):
    tools = [f"synthetic-tool-{index:03d}" for index in range(160)]
    env.runtime.profile_policy = lambda _profile: {"available_tools": tools, "add_dirs": []}
    env.source.events.append(message())
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    pieces = [part for part in state(env)["outbox"] if part["group"] == f"job:{JOB1}:approval"]
    assert len(pieces) == 2 and all(part["state"] in ("sent", "delivered") for part in pieces)
    env.source.events.append(message(2, "1", reply_to=pieces[0]["guid"]))
    env.portal().tick()
    assert [call["job_id"] for call in env.runtime.calls if call["op"] == "approve"] == [JOB1]


def test_rapp_n_answers_an_image_post_not_an_older_cards_stop(env):
    approved_running_job(env)
    image = env.root / "chart.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 64)
    post_id = feed_post(env, text="Loop 02\n1. Ship it\n2. Hold", file=str(image))
    for _ in range(2):
        env.clock.advance(10)
        env.portal().tick()
    env.source.events.append(message(3, "RAPP 2"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "cancel"]
    assert state(env)["feed"][post_id]["state"] == "answered"


def test_a_swiped_rapp_1_approves_the_quoted_approval_card_not_the_newest(env):
    env.source.events.extend([message(), message(2, "RAPP another task")])
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    env.source.events.append(message(3, "RAPP 1", reply_to=approval_part(env)["guid"]))
    env.portal().tick()
    assert [call["job_id"] for call in env.runtime.calls if call["op"] == "approve"] == [JOB1]


def test_a_swiped_rapp_2_stops_the_quoted_task_not_the_newest_approval(env):
    approved_running_job(env)
    running = running_part(env)
    env.clock.advance(10)
    env.source.events.append(message(3, "RAPP another task"))
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    env.source.events.append(message(4, "RAPP 2", reply_to=running["guid"]))
    env.portal().tick()
    assert [call["job_id"] for call in explicit_ops(env, "cancel")] == [JOB1]


def test_a_swiped_rapp_n_on_a_message_that_is_not_our_card_runs_nothing(env):
    env.source.events.append(message())
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    env.source.events.append(message(2, "RAPP 1", reply_to="OTHER-AI-MESSAGE"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]
    assert any("not on one of our cards" in call["text"] for call in env.native.calls)


def closed_offer(env):
    return next(part for part in reversed(state(env)["outbox"]) if part["group"].endswith(":closed"))


def test_a_stop_typed_as_a_same_task_card_lands_still_stops_it(env):
    approved_running_job(env)
    running = running_part(env)
    env.clock.advance(10)
    # Typed as the running card landed, when the approval card before it meant something else.
    env.source.events.append(message(3, "2", created_at=at(running["submitted_at"] + 1)))
    env.portal().tick()
    assert not explicit_ops(env, "cancel")
    offer = closed_offer(env)
    env.clock.advance(10)
    # Only the owner's own refused "2" sits between the two cards.
    env.source.between_rows = [{"guid": "SYNTHETIC-3", "is_from_me": False}]
    # Just as fast under the re-offered card: Stop meant Stop on the card before it too.
    env.source.events.append(message(4, "2", created_at=at(offer["submitted_at"] + 1)))
    env.portal().tick()
    assert [call["job_id"] for call in explicit_ops(env, "cancel")] == [JOB1]


def test_a_slow_send_still_counts_the_race_window_from_landing(env):
    send = env.native.send

    def slow(chat_id, **kwargs):
        env.clock.advance(4)
        return send(chat_id, **kwargs)

    env.native.send = slow
    env.source.events.append(message())
    env.portal().tick()
    card = approval_part(env)
    assert card["sent_at"] - card["submitted_at"] == 4
    env.native.send = send
    env.clock.advance(10)
    env.source.events.append(message(2, "1", created_at=at(card["submitted_at"] + 5)))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]
    assert "nothing ran" in env.native.calls[-1]["text"]


def test_a_stop_under_a_card_not_confirmed_on_the_phone_runs_nothing(env):
    approved_running_job(env)
    env.native.states[running_part(env)["guid"]] = "failed"
    env.clock.advance(10)
    env.source.events.append(message(3, "2"))
    env.portal().tick()
    assert not explicit_ops(env, "cancel")
    assert any("Not confirmed on your phone" in call["text"] for call in env.native.calls)


def test_an_answer_typed_as_an_agent_post_lands_is_not_recorded(env):
    post_id = delivered_feed_post(env)
    post = next(part for part in state(env)["outbox"] if part["group"] == f"feed:{post_id}")
    env.source.events.append(message(1, "1", created_at=at(post["submitted_at"] + 1)))
    env.portal().tick()
    assert state(env)["feed"][post_id]["state"] != "answered"
    again = env.native.calls[-1]["text"]
    # Line one says so on the lock screen; the reason is right under it; the options stay last.
    assert again.startswith("[RAPP loop] Not answered · Loop 01\nYour reply landed as it arrived, "
                            "so nothing was answered. Send the number again.\n")
    assert again.endswith("\n1. Ship it\n2. Hold")
    # A swipe-reply names the update, so it is answered even that fast.
    env.source.events.append(message(2, "1", created_at=at(post["submitted_at"] + 1), reply_to=post["guid"]))
    env.portal().tick()
    assert state(env)["feed"][post_id]["answer"]["number"] == 1


def test_rapp_n_typed_as_an_agent_post_lands_answers_nothing(env):
    post_id = delivered_feed_post(env)
    post = next(part for part in state(env)["outbox"] if part["group"] == f"feed:{post_id}")
    env.source.events.append(message(1, "RAPP 2", created_at=at(post["submitted_at"] + 1)))
    env.portal().tick()
    assert state(env)["feed"][post_id]["state"] != "answered"
    again = env.native.calls[-1]["text"]
    assert again.startswith("[RAPP loop] Not answered · Loop 01\n") and again.endswith("\n2. Hold")
    assert "so nothing was answered. Send the number again.\n" in again


def test_a_poison_message_is_set_aside_with_one_notice_and_the_next_one_runs(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    route = portal_module.Portal._route_event

    def fragile(self, identity, event, actor, target):
        if "poison" in str(event.get("text")):
            raise KeyError("synthetic")
        return route(self, identity, event, actor, target)

    monkeypatch.setattr(portal_module.Portal, "_route_event", fragile)
    env.source.events.extend([message(1, "RAPP poison"), message(2, "RAPP help")])
    for _ in range(3):
        env.portal().tick()
        env.clock.advance(10)
    texts = [call["text"] for call in env.native.calls]
    assert sum(text.splitlines()[0].endswith("! Skipped") for text in texts) == 1
    assert any("RAPP <task>" in text for text in texts)
    saved = state(env)
    assert saved["cursor"] == 2
    assert [record["error"] for record in saved["inbox"].values() if record["state"] == "failed"] == ["internal:KeyError"]


def test_a_vanished_output_file_ends_its_job_with_the_text_result(env):
    env.source.events.append(message(text="RAPP file result.png | create synthetic media"))
    env.portal().tick()
    Path(add_output(env, JOB1)["path"]).unlink()
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    env.source.events.append(message(2, "RAPP help"))
    for _ in range(6):
        env.clock.advance(10)
        env.portal().tick()
    texts = [call["text"] for call in env.native.calls]
    assert any("RAPP <task>" in text for text in texts)
    finals = [text for text in texts if text.startswith("[RAPP 0001] ✓ Done")]
    assert len(finals) == 1 and "Output files unavailable (artifact_missing)" in finals[0]
    assert state(env)["jobs"][JOB1]["final_queued"] is True
    assert len([call for call in env.runtime.calls if call["op"] == "result"]) <= 3


def test_an_undecodable_text_row_does_not_stop_the_real_reader(env):
    db = make_database(env)
    source = SQLiteSource(env.config())
    insert_message(db, 1)
    db.execute("UPDATE message SET text=CAST(X'5241505020ff68656c70' AS TEXT) WHERE ROWID=1")
    db.commit()
    insert_message(db, 2)
    events = source.poll(0, 0)
    assert [event["id"] for event in events] == [1, 2] and "\ufffd" in events[0]["text"]
    source.close()
    db.close()


def test_a_part_that_breaks_the_pump_is_set_aside_and_the_rest_still_send(env, monkeypatch):
    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    send = env.native.send

    def fragile(chat_id, **kwargs):
        if "poison" in kwargs.get("text", ""):
            raise KeyError("synthetic")
        return send(chat_id, **kwargs)

    env.native.send = fragile
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        outbox.enqueue("first", ACTOR, TARGET, "[RAPP t] poison")
        outbox.enqueue("second", ACTOR, TARGET, "[RAPP t] fine")
        outbox.pump()
        states = {part["group"]: (part["state"], part.get("error")) for part in store.data["outbox"]}
    assert states["first"] == ("unknown", "internal:KeyError") and states["second"][0] == "submitted"


def test_a_journal_that_cannot_be_written_still_fails_the_tick(env, monkeypatch):
    from rapp_bubbles.state import JournalWriteError

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    env.portal().tick()

    def full(self, pending):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(Store, "_write", full)
    env.source.events.append(message(1, "RAPP help"))
    with pytest.raises(JournalWriteError):
        env.portal().tick()


def test_a_job_whose_poll_breaks_is_set_aside_and_other_jobs_still_poll(env, monkeypatch):
    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    env.source.events.extend([message(1, "RAPP one"), message(2, "RAPP two")])
    env.portal().tick()
    real = env.runtime.request

    def fragile(request):
        if request["op"] == "status" and request.get("job_id") == JOB1:
            raise KeyError("synthetic")
        return real(request)

    env.runtime.request = fragile
    for _ in range(12):
        env.clock.advance(10)
        env.portal().tick()
    polls = [call for call in env.runtime.calls if call["op"] == "status" and call["job_id"] == synthetic_job(2)]
    assert len(polls) >= 10
    job = state(env)["jobs"][JOB1]
    assert job["final_queued"] is True and job["error"] == "internal:KeyError"
    assert sum(call["text"].splitlines()[0].endswith("Not followed") for call in env.native.calls) == 1


def test_a_failing_poll_backs_off_and_resumes_after_success(env):
    env.source.events.append(message())
    env.portal().tick()
    real = env.runtime.request
    failing = [True]

    def flaky(request):
        if request["op"] == "status" and failing[0]:
            env.runtime.calls.append(copy.deepcopy(request))
            return {"ok": False, "error": {"code": "runtime_unavailable"}}
        return real(request)

    env.runtime.request = flaky
    for _ in range(60):
        env.clock.advance(5)
        env.portal().tick()
    polls = [call for call in env.runtime.calls if call["op"] == "status" and "stdout_offset" in call]
    assert 3 <= len(polls) <= 7
    errors = [item for item in state(env)["errors"] if item["code"] == "runtime_unavailable"]
    assert len(errors) == 1 and errors[0]["count"] == len(polls) - 1
    failing[0] = False
    for _ in range(6):
        env.clock.advance(5)
        env.portal().tick()
    job = state(env)["jobs"][JOB1]
    assert "fail_streak" not in job and "next_poll" not in job


def test_an_idle_running_job_writes_the_journal_only_for_its_cards(env, monkeypatch):
    approved_running_job(env)
    for _ in range(3):
        env.clock.advance(10)
        env.portal().tick()
    writes = []
    save = Store.save
    monkeypatch.setattr(Store, "save", lambda self: (writes.append(1), save(self))[1])
    cards_before, calls_before, written = len(env.native.calls), len(env.runtime.calls), 0
    for _ in range(60):
        env.clock.advance(10)
        count = len(writes)
        env.portal().tick()
        written += len(writes) > count
    cards = len(env.native.calls) - cards_before
    assert cards and written <= 2 * cards + 1
    assert not [call for call in env.runtime.calls[calls_before:] if call["op"] == "recover"]


def test_a_job_the_runtime_lost_is_no_longer_followed(env):
    env.source.events.append(message())
    env.portal().tick()
    real = env.runtime.request

    def lost(request):
        if request["op"] == "status":
            return {"ok": False, "error": {"code": "not_found"}}
        return real(request)

    env.runtime.request = lost
    for _ in range(40):
        env.clock.advance(10)
        env.portal().tick()
    assert state(env)["jobs"][JOB1]["final_queued"] is True
    assert sum(call["text"].splitlines()[0].endswith("Lost") for call in env.native.calls) == 1


def test_errors_are_kept_once_per_code_with_a_count(env):
    with Store(env.config().state_dir) as store:
        for code in ("a", "b", "a", "a"):
            store.error(code, env.clock())
            env.clock.advance(1)
        errors = store.data["errors"]
    assert [(item["code"], item["count"]) for item in errors] == [("b", 1), ("a", 3)]
    assert errors[-1]["first"] < errors[-1]["time"]


def test_a_quick_digit_after_another_ais_question_does_not_stop_a_task(env):
    approved_running_job(env)
    running = running_part(env)
    env.clock.advance(10)
    env.source.events.append(message(3, "2", created_at=at(running["submitted_at"] + 1)))
    env.portal().tick()
    offer = closed_offer(env)
    env.clock.advance(10)
    # Another AI asked "1 = continue, 2 = abort" between the two cards: the number may be its.
    env.source.between_rows = [{"guid": "OTHER-AI-QUESTION", "is_from_me": True}]
    env.source.events.append(message(4, "2", created_at=at(offer["submitted_at"] + 1)))
    env.portal().tick()
    assert not explicit_ops(env, "cancel")


def test_reader_lists_the_rows_between_two_cards_without_tapbacks(env):
    db = make_database(env)
    source = SQLiteSource(env.config())
    insert_message(db, 1, "[RAPP 0001] one", guid="CARD-1")
    insert_message(db, 2, "Other AI: 1 = continue, 2 = abort", guid="OTHER")
    db.execute(
        "INSERT INTO message(ROWID,guid,text,attributedBody,date,is_from_me,service,handle_id,"
        "cache_has_attachments,associated_message_guid,associated_message_type) "
        "VALUES(3,'TAPBACK','Liked a message',NULL,1,0,'iMessage',1,0,'p:0/CARD-1',2001)"
    )
    db.execute("INSERT INTO chat_message_join VALUES(3,1)")
    insert_message(db, 4, "[RAPP 0001] two", guid="CARD-2")
    db.commit()
    assert [row["guid"] for row in source.between(CHAT, "CARD-1", "CARD-2")] == ["OTHER"]
    assert source.between(CHAT, "CARD-1", "MISSING") is None
    source.close()
    db.close()


def test_a_transient_result_failure_keeps_the_declared_file(env):
    env.source.events.append(message(text="RAPP file result.png | create synthetic media"))
    env.portal().tick()
    add_output(env, JOB1)
    env.runtime.jobs[JOB1]["status"] = "succeeded"
    real = env.runtime.request
    failures = [2]

    def flaky(request):
        if request["op"] == "result" and failures[0]:
            failures[0] -= 1
            raise NotSubmitted("helper_protocol_error", "Synthetic helper timeout.")
        return real(request)

    env.runtime.request = flaky
    for _ in range(12):
        env.clock.advance(10)
        env.portal().tick()
    assert [call for call in env.native.calls if call["file"]]
    assert not any("Output files unavailable" in call["text"] for call in env.native.calls)


def test_timeouts_and_one_not_found_do_not_make_a_job_lost(env):
    env.source.events.append(message())
    env.portal().tick()
    real = env.runtime.request
    codes = ["runtime_unavailable", "runtime_unavailable", "not_found"]

    def flaky(request):
        if request["op"] == "status" and codes:
            return {"ok": False, "error": {"code": codes.pop(0)}}
        return real(request)

    env.runtime.request = flaky
    for _ in range(20):
        env.clock.advance(10)
        env.portal().tick()
    job = state(env)["jobs"][JOB1]
    assert job["final_queued"] is False and "fail_counts" not in job


def test_a_locked_chat_db_fails_the_tick_and_the_digit_still_approves_later(env, monkeypatch):
    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    env.source.events.append(message())
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    locked = [True]
    prior = env.source.latest_prior_guid

    def flaky(event):
        if locked[0]:
            raise sqlite3.OperationalError("database is locked")
        return prior(event)

    env.source.latest_prior_guid = flaky
    env.source.events.append(message(2, "1"))
    with pytest.raises(sqlite3.OperationalError):
        env.portal().tick()
    locked[0] = False
    env.portal().tick()
    assert [call["job_id"] for call in env.runtime.calls if call["op"] == "approve"] == [JOB1]


def test_a_locked_chat_db_leaves_a_queued_part_queued(env, monkeypatch):
    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    matches = env.source.target_matches
    locked = [True]

    def flaky(target):
        if locked[0]:
            raise sqlite3.OperationalError("database is locked")
        return matches(target)

    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, flaky)
        outbox.enqueue("card", ACTOR, TARGET, "[RAPP t] hello")
        with pytest.raises(sqlite3.OperationalError):
            outbox.pump()
        assert outbox.parts("card")[0]["state"] == "queued"
        locked[0] = False
        outbox.pump()
        assert outbox.parts("card")[0]["state"] == "submitted"


def test_a_decoded_message_that_breaks_is_marked_failed_and_runs_only_once(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    command = portal_module.Portal._command
    calls = []

    def fragile(self, identity, record):
        calls.append(identity)
        if "poison" in record.get("body", ""):
            raise KeyError("synthetic")
        return command(self, identity, record)

    monkeypatch.setattr(portal_module.Portal, "_command", fragile)
    env.source.events.append(message(1, None, needs_native_text=True))
    env.portal().tick()
    env.native.decoded["SYNTHETIC-1"] = "RAPP poison task"
    for _ in range(3):
        env.clock.advance(10)
        env.portal().tick()
    record = next(iter(state(env)["inbox"].values()))
    assert record["state"] == "failed" and record["error"] == "internal:KeyError"
    assert len(calls) == 1


def test_rapp_reply_on_a_swiped_older_update_answers_that_update(env):
    first = delivered_feed_post(env, channel="loop")
    older = next(part for part in state(env)["outbox"] if part["group"] == f"feed:{first}")
    second = delivered_feed_post(env, channel="other", text="Other 01\n1. Yes\n2. No")
    newer = next(part for part in state(env)["outbox"] if part["group"] == f"feed:{second}")
    env.source.events.append(message(1, "RAPP reply 1", reply_to=older["guid"],
                                     created_at=at(newer["submitted_at"] + 1)))
    env.portal().tick()
    posts = state(env)["feed"]
    assert posts[first]["answer"]["number"] == 1 and posts[second]["state"] != "answered"


def test_a_full_disk_while_staging_is_not_called_an_unsafe_file(env, monkeypatch):
    from rapp_bubbles import files

    source = env.root / "input.txt"
    source.write_text("synthetic")

    def full(_descriptor):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(files.os, "fsync", full)
    with pytest.raises(PortalError) as caught:
        copy_reference(source, (env.root,), env.root / "staged" / "input.txt", 1024)
    assert caught.value.code == "disk_full"


def test_a_file_part_waits_while_the_disk_is_full_and_goes_out_after(env, monkeypatch):
    from rapp_bubbles import outbox as outbox_module

    free = {"bytes": 50 * 2**30}
    monkeypatch.setattr(shutil, "disk_usage",
                        lambda _path: SimpleNamespace(total=100 * 2**30, used=0, free=free["bytes"]))
    real = outbox_module.copy_reference
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        enqueue_native_test_batch(env, outbox, [".png"])
        free["bytes"] = 0
        for _ in range(3):
            outbox.pump()
            env.clock.advance(10)
        file_part = next(part for part in store.data["outbox"] if "file" in part)
        assert file_part["state"] == "queued" and not [call for call in env.native.calls if call["file"]]
        # Room reported, but the disk fills during the verifying copy: still queued, not lost.
        free["bytes"] = 50 * 2**30

        def full(*_args, **_kwargs):
            raise PortalError("disk_full", "Synthetic full disk.")

        monkeypatch.setattr(outbox_module, "copy_reference", full)
        outbox.pump()
        assert file_part["state"] == "queued"
        monkeypatch.setattr(outbox_module, "copy_reference", real)
        for _ in range(2):
            env.clock.advance(10)
            outbox.pump()
    assert [call for call in env.native.calls if call["file"]]


def test_an_upload_on_a_full_disk_waits_for_space_instead_of_failing(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    real = portal_module.copy_reference
    full = [True]

    def copy(*args, **kwargs):
        if full[0]:
            raise PortalError("disk_full", "Synthetic full disk.")
        return real(*args, **kwargs)

    monkeypatch.setattr(portal_module, "copy_reference", copy)
    env.source.events.extend([
        message(1, "RAPP attach"), message(2, "", has_attachments=True, attachments=[attachment(env)]),
    ])
    for _ in range(3):
        env.portal().tick()
        env.clock.advance()
    record = next(item for item in state(env)["inbox"].values() if item["event"]["id"] == 2)
    assert record["state"] == "receiving"
    full[0] = False
    for _ in range(3):
        env.portal().tick()
        env.clock.advance()
    assert any("Saved 1 attachment" in call["text"] for call in env.native.calls)


def test_reader_does_not_vouch_for_a_long_or_inverted_gap(env):
    db = make_database(env)
    source = SQLiteSource(env.config())
    insert_message(db, 1, "[RAPP 0001] one", guid="CARD-1")
    for index in range(2, 54):
        insert_message(db, index, f"row {index}", guid=f"ROW-{index}")
    insert_message(db, 54, "[RAPP 0001] two", guid="CARD-2")
    assert source.between(CHAT, "CARD-1", "CARD-2") is None
    assert source.between(CHAT, "CARD-2", "CARD-1") is None
    assert source.between(CHAT, "ROW-2", "ROW-4") == [{"guid": "ROW-3", "is_from_me": False, "sender": SENDER}]
    assert [row["guid"] for row in source.between(CHAT, "ROW-52", None)] == ["ROW-53", "CARD-2"]
    source.close()
    db.close()


def full_disk(monkeypatch, free):
    monkeypatch.setattr(shutil, "disk_usage",
                        lambda _path: SimpleNamespace(total=100 * 2**30, used=0, free=free["bytes"]))


def test_copies_are_never_tried_into_a_full_disk(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    free = {"bytes": 0}
    full_disk(monkeypatch, free)
    attempts = []
    real = portal_module.copy_reference
    monkeypatch.setattr(portal_module, "copy_reference",
                        lambda *args, **kwargs: (attempts.append(1), real(*args, **kwargs))[1])
    env.source.events.extend([
        message(1, "RAPP attach"), message(2, "", has_attachments=True, attachments=[attachment(env)]),
    ])
    for _ in range(3):
        env.portal().tick()
        env.clock.advance()
    assert not attempts and next(
        item for item in state(env)["inbox"].values() if item["event"]["id"] == 2
    )["state"] == "receiving"
    free["bytes"] = 50 * 2**30
    for _ in range(3):
        env.portal().tick()
        env.clock.advance()
    assert attempts and any("Saved 1 attachment" in call["text"] for call in env.native.calls)
    free["bytes"] = 0
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        with pytest.raises(PortalError) as caught:
            enqueue_native_test_batch(env, outbox, [".png"])
    assert caught.value.code == "disk_full"


def test_a_file_waiting_for_space_costs_no_health_probe_or_write(env, monkeypatch):
    free = {"bytes": 50 * 2**30}
    full_disk(monkeypatch, free)
    probes = []

    def health(value, now):
        probes.append(now)
        value["checked_at"] = now
        return True

    env.native.health = health
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        enqueue_native_test_batch(env, outbox, [".png"])
        free["bytes"] = 0
        outbox.pump()  # the text bubble goes; the file waits for space
        before = len(probes)
        for _ in range(5):
            env.clock.advance(150)
            outbox.pump()
        assert len(probes) == before
        assert next(part for part in store.data["outbox"] if "file" in part)["state"] == "queued"


# Round 5: one read rule for RAPP <n>, failures the owner can see, and cards an agent can ask about.


class Timeline(Source):
    """One chat in real ROWID order: the owner's messages, our bubbles as they are sent, and
    other authors' rows (another AI sending as this Apple ID). The read guard sees the order
    chat.db would give it instead of canned per-test rows."""

    def __init__(self, clock, prefix=""):
        super().__init__()
        self.clock, self.prefix, self.rows = clock, prefix, []

    def add(self, guid, *, is_from_me, sender=None, chat=CHAT, thread=None):
        self.rows.append({"id": len(self.rows) + 1, "guid": guid, "chat": chat,
                          "is_from_me": is_from_me, "sender": sender, "thread": thread})
        return self.rows[-1]

    def sent(self, chat, *guids):
        for guid in guids:
            self.add(guid, is_from_me=True, chat=chat)

    def say(self, text, *, typed_ago=0.0, **changes):
        """The owner's message lands now; he typed it typed_ago seconds earlier."""
        row = self.add(f"{self.prefix}OWNER-{len(self.rows) + 1}", is_from_me=False, sender=SENDER,
                       thread=changes.get("reply_to"))
        event = message(row["id"], text, guid=row["guid"], created_at=at(self.clock() - typed_ago), **changes)
        self.events.append(event)
        return event

    def foreign(self, thread=None):
        """Another AI's bubble, sent as this Apple ID (a reply in ``thread``'s thread, if given)."""
        return self.add(f"{self.prefix}FOREIGN-{len(self.rows) + 1}", is_from_me=True, thread=thread)

    def thread_rows(self, chat_guid, root, event):
        rows = [{"guid": row["guid"], "is_from_me": row["is_from_me"], "sender": row["sender"]}
                for row in self.rows if row["chat"] == chat_guid and row["thread"] == root
                and row["id"] < event["id"] and row["guid"] != event["guid"]]
        return None if len(rows) > 50 else rows

    def latest_prior_guid(self, event):
        prior = [row["guid"] for row in self.rows if row["chat"] == event["chat_guid"] and row["id"] < event["id"]]
        return prior[-1] if prior else None

    def between(self, chat_guid, after, before):
        ids = {row["guid"]: row["id"] for row in self.rows if row["chat"] == chat_guid}
        if after not in ids or before is not None and (before not in ids or ids[after] >= ids[before]):
            return None
        upper = ids[before] if before is not None else float("inf")
        rows = [{"guid": row["guid"], "is_from_me": row["is_from_me"], "sender": row["sender"]}
                for row in self.rows if row["chat"] == chat_guid and ids[after] < row["id"] < upper]
        return None if len(rows) > 50 else rows

    def tail(self):
        return len(self.rows)


def timeline(env, prefix=""):
    line = Timeline(env.clock, prefix)
    env.source = env.native.source = line
    env.portal = lambda: Portal(env.config(), source=line, native=env.native, runtime=env.runtime, clock=env.clock)
    env.portal().tick()  # the cursor starts at the empty chat
    return line


FOREIGN_LINE = "Another message came after the card, so nothing ran."


@pytest.mark.parametrize("kind", ["approval", "running"])
def test_rapp_n_after_another_authors_bubble_shows_the_card_again_and_runs_nothing(env, kind):
    line = timeline(env)
    line.say("RAPP inspect these files")
    env.portal().tick()
    if kind == "running":
        env.clock.advance(10)
        line.say("1")
        env.portal().tick()
        assert explicit_ops(env, "approve")
    op, reply = ("approve", "RAPP 1") if kind == "approval" else ("cancel", "RAPP 2")
    env.clock.advance(10)
    line.foreign()  # another AI's look-alike card lands under ours
    line.say(reply)
    sent = len(env.native.calls)
    env.portal().tick()
    assert not explicit_ops(env, op)
    assert any(FOREIGN_LINE in call["text"] for call in env.native.calls[sent:])
    env.clock.advance(10)
    line.say(reply)  # right under the card shown again, it runs
    env.portal().tick()
    assert len(explicit_ops(env, op)) == 1


@pytest.mark.parametrize("again", ["1", "RAPP 1"])
@pytest.mark.parametrize("reply", ["RAPP 1", "RAPP reply 1"])
def test_an_explicit_answer_after_another_authors_bubble_gets_the_post_again(env, reply, again):
    line = timeline(env)
    post_id = delivered_feed_post(env)
    env.clock.advance(250)
    line.foreign()
    line.say(reply)
    env.portal().tick()
    assert state(env)["feed"][post_id]["state"] == "open"
    shown = env.native.calls[-1]["text"]
    assert shown == ("[RAPP loop] Not answered · Loop 01\nAnother message came after it, so nothing was "
                     "answered. Swipe-reply your number on this one.\n1. Ship it\n2. Hold")
    # Past the first reply window: the copy keeps the post open for a full window of its own.
    env.clock.advance(100)
    line.say(again)
    env.portal().tick()
    item = state(env)["feed"][post_id]
    assert item["state"] == "answered" and item["answer"]["number"] == 1


def test_only_the_owners_own_rows_leave_a_group_card_answerable(env):
    portal = env.portal()
    with Store(env.config().state_dir) as store:
        portal.store = store
        portal.outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        owner = {"guid": "ROW", "is_from_me": False, "sender": SENDER}
        member = {"guid": "ROW", "is_from_me": False, "sender": "member@example.invalid"}
        another_ai = {"guid": "ROW", "is_from_me": True, "sender": None}
        group, direct = {"is_group": True, "sender": SENDER}, {"is_group": False, "sender": SENDER}
        card = {"group": f"job:{JOB1}:approval"}
        assert portal._harmless(owner, group, card) and not portal._harmless(member, group, card)
        # In a one-to-one chat every inbound row is the owner's.
        assert portal._harmless(member, direct, card)
        assert not portal._harmless(another_ai, direct, card) and not portal._harmless(another_ai, group, card)


@pytest.mark.parametrize("persistent", [False, True])
def test_an_error_after_the_runtime_was_called_is_checked_again_not_called_nothing_ran(env, monkeypatch, persistent):
    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    policy, calls = env.runtime.profile_policy, []

    def fragile(profile):
        calls.append(profile)
        # The check right after the submit went through breaks: once, or every time.
        if len(calls) == 2 or persistent and len(calls) % 2 == 0:
            raise KeyError("synthetic")
        return policy(profile)

    env.runtime.profile_policy = fragile
    env.source.events.append(message(1, "RAPP inspect these files"))
    env.portal().tick()
    # Set aside once; looked at again on the next tick, not straight away.
    record = next(iter(state(env)["inbox"].values()))
    assert record["state"] == "runtime_pending" and record["internal_attempts"] == 1
    env.clock.advance(10)
    env.portal().tick()
    texts = [call["text"] for call in env.native.calls]
    assert not any("nothing ran" in text for text in texts)
    heads = [text.split("\n", 1)[0] for text in texts if "! " in text.split("\n", 1)[0]]
    record = next(iter(state(env)["inbox"].values()))
    # Submits are idempotent by request id: looking again never prepares a second job.
    assert len(env.runtime.requests) == 1
    if persistent:
        assert [head.rsplit("! ", 1)[1] for head in heads] == ["Checking", "May have run"]
        assert "may have run" in texts[-1] and "Check it with RAPP status." in texts[-1]
        assert record["state"] == "failed" and record["internal_attempts"] == 2
        assert not [part for part in state(env)["outbox"] if part["group"] == f"job:{JOB1}:approval"]
    else:
        assert [head.rsplit("! ", 1)[1] for head in heads] == ["Checking"] and "Checking again" in texts[0]
        assert record["state"] == "done" and record["internal_attempts"] == 1 and approval_part(env)


def test_a_number_that_breaks_before_anything_runs_gets_its_card_again(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.source.events.append(message(1, "RAPP inspect these files"))
    env.portal().tick()
    real = portal_module.Portal._approve_or_cancel

    def fragile(*_args, **_kwargs):
        raise KeyError("synthetic")

    monkeypatch.setattr(portal_module.Portal, "_approve_or_cancel", fragile)
    env.clock.advance(10)
    env.source.events.append(message(2, "1"))
    env.portal().tick()
    assert not explicit_ops(env, "approve")
    texts = [call["text"] for call in env.native.calls]
    assert not any(text.split("\n", 1)[0].endswith("! Skipped") for text in texts)
    assert texts[-1].startswith("[RAPP 0001] ? Approve task?\nAn internal error stopped it, so nothing ran.")
    monkeypatch.setattr(portal_module.Portal, "_approve_or_cancel", real)
    env.clock.advance(10)
    env.source.events.append(message(3, "1"))  # the number sent again, under the card shown again
    env.portal().tick()
    assert len(explicit_ops(env, "approve")) == 1


def test_a_card_whose_send_timed_out_is_timed_from_the_row_it_landed_in(env):
    real = env.native.send

    def slow(chat_id, *, text="", file=""):
        if "Approve task?" in text.split("\n", 1)[0]:
            env.clock.advance(25)  # the send hangs; the bubble lands just before it times out
            real(chat_id, text=text, file=file)
            raise SubmissionUnknown("native_send_timeout", "Synthetic send timeout.")
        return real(chat_id, text=text, file=file)

    env.native.send = slow
    env.source.events.append(message(1, "RAPP inspect these files"))
    env.portal().tick()
    part = approval_part(env)
    assert part["state"] == "unknown" and "sent_at" not in part
    env.clock.advance(5)
    # Typed a second before the card reached the phone, so it cannot be an answer to it.
    env.source.events.append(message(2, "1", created_at=at(part["submitted_at"] + 24)))
    env.portal().tick()
    part = approval_part(env)
    assert part["state"] == "delivered" and part["sent_at"] == pytest.approx(part["submitted_at"] + 25)
    assert not explicit_ops(env, "approve")


def test_a_retried_part_forgets_when_its_last_attempt_landed(env):
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        outbox.enqueue(f"job:{JOB1}:final", ACTOR, TARGET, "[RAPP 0001] ✓ Done", job_id=JOB1)
        part = store.data["outbox"][0]
        part.update(state="failed", retryable=True, submitted_at=env.clock(), sent_at=env.clock())
        assert outbox.retry(ACTOR, JOB1) == 1
        assert part["state"] == "queued" and "sent_at" not in part


def test_a_stage_failing_tick_after_tick_is_told_once_after_a_minute_then_back(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.portal().tick()
    real = portal_module.Portal._outage_report

    def broken(_self):
        raise RuntimeError("synthetic")

    monkeypatch.setattr(portal_module.Portal, "_outage_report", broken)
    journal = Path(env.raw["state_dir"]) / "transport.json"
    env.portal().tick()  # the streak starts and is recorded once
    first = journal.stat()
    for _ in range(4):
        env.clock.advance(10)
        env.portal().tick()
    # Forty seconds of the same failure: nothing new to say, so nothing is written.
    assert (journal.stat().st_ino, journal.stat().st_mtime_ns) == (first.st_ino, first.st_mtime_ns)
    assert not [call for call in env.native.calls if "stuck" in call["text"].split("\n", 1)[0]]
    for _ in range(4):
        env.clock.advance(10)
        env.portal().tick()
    stuck = [call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ! Outage stuck")]
    assert len(stuck) == 1 and "RuntimeError" in stuck[0]
    monkeypatch.setattr(portal_module.Portal, "_outage_report", real)
    for _ in range(3):
        env.clock.advance(10)
        env.portal().tick()
    # Working again, but not back until it has held for fifteen minutes (twenty from the saved failure).
    assert not [call for call in env.native.calls if "Outage back" in call["text"]] and state(env)["stages"]
    for _ in range(15):
        env.clock.advance(100)
        env.portal().tick()
    back = [call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ✓ Outage back")]
    assert len(back) == 1 and not state(env).get("stages")
    assert [item["code"] for item in state(env)["errors"]] == ["internal:outage:RuntimeError"]


def test_new_tasks_wait_while_the_disk_cannot_be_checked(env, monkeypatch):
    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    real, broken = shutil.disk_usage, {"on": True}

    def usage(path):
        if broken["on"]:
            raise OSError(errno.EIO, "synthetic")
        return real(path)

    monkeypatch.setattr(shutil, "disk_usage", usage)
    env.source.events.append(message(1, "RAPP inspect these files"))
    env.portal().tick()
    assert not submitted(env)
    assert "(disk_unknown)" in env.native.calls[-1]["text"]
    broken["on"] = False
    env.clock.advance(10)
    env.source.events.append(message(2, "RAPP inspect these files again"))
    env.portal().tick()
    assert len(submitted(env)) == 1


def test_the_back_online_card_and_health_name_why_ticks_failed(env):
    from rapp_bubbles import cli

    owner_target(env)
    env.portal().tick()
    config = env.config()
    for _ in range(2):
        cli.record_tick_failure(config, OSError(errno.ENOSPC, "No space left on device"))
    env.clock.advance(600)
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    back = [call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ✓ Back online")]
    assert len(back) == 1 and "2 ticks failed · disk full" in back[0]
    assert not (config.state_dir / "tick-failure.json").exists()
    env.source.events.append(message(1, "RAPP health"))
    env.portal().tick()
    assert "Last failed: 2 ticks failed · disk full · " in env.native.calls[-1]["text"]


def test_cards_and_resolve_show_what_a_reply_would_do_without_doing_it(env, capsys):
    from rapp_bubbles import cards, cli

    db = make_database(env)
    with Store(env.config().state_dir) as store:
        store.data["cursor"] = store.data["floor"] = 0
        store.save()

    def tick():
        return Portal(env.config(), runtime=env.runtime, native=env.native, clock=env.clock).tick()

    insert_message(db, 1, "RAPP prepare the synthetic task")
    tick()
    approval = approval_part(env)
    insert_message(db, 2, approval["text"], approval["guid"])
    db.execute("UPDATE message SET is_from_me=1 WHERE ROWID=2")
    db.commit()
    env.clock.advance(10)
    tick()  # its receipt: delivered
    config = env.config()
    journal = (config.state_dir / "transport.json").read_bytes()
    with Store(config.state_dir) as store:
        listing = cards.describe(config, store, clock=env.clock)
    assert listing["rapp_n"] == {"ref": cards.ref(approval["group"]), "open": True, "blocked": None, "options": []}
    card = listing["cards"][0]
    assert (card["kind"], card["state"], card["open"], card["job"]) == ("approval", "delivered", True, JOB1)
    assert [(option["label"], option["command"]) for option in card["options"]] == [
        ("Approve", f"RAPP approve {JOB1}"), ("Cancel", f"RAPP cancel {JOB1}")]

    def resolve(text, **kwargs):
        return cards.resolve(config, copy.deepcopy(state(env)), text, clock=env.clock, **kwargs)

    assert resolve("1") == {"ok": True, "verdict": "acts", "would": [f"approve {JOB1}"], "answers": [],
                            "refused": [], "errors": [], "cards": []}
    assert resolve("RAPP status")["would"] == [f"status {JOB1}"]
    assert resolve("RAPP inspect more")["would"] == ["submit"]
    # Typed as the card landed: refused, with the card shown again.
    assert resolve("1", typed_ago=11)["refused"] == ["Your reply landed as this card arrived, so nothing ran."]
    # Another AI's bubble lands under our card.
    insert_message(db, 3, "Other AI: 1. Deploy 2. Wait", "FOREIGN")
    db.execute("UPDATE message SET is_from_me=1,handle_id=NULL WHERE ROWID=3")
    db.commit()
    assert resolve("1")["verdict"] == "ignored"
    refused = resolve("RAPP 1")
    assert (refused["verdict"], refused["cards"]) == ("reoffers", ["[RAPP 0001] ? Approve task?"])
    assert [note.startswith(FOREIGN_LINE) for note in refused["refused"]] == [True]
    assert resolve("1", reply_to=cards.ref(approval["group"]))["would"] == [f"approve {JOB1}"]
    assert resolve(f"RAPP approve {JOB1}")["verdict"] == "acts"
    assert (resolve("RAPP 7")["verdict"], resolve("RAPP 7")["errors"]) == ("fails", ["no_open_menu"])
    with pytest.raises(PortalError):
        resolve("1", reply_to="ffffff")
    # Nothing was sent, run, or saved.
    assert not explicit_ops(env, "approve") and (config.state_dir / "transport.json").read_bytes() == journal
    path = env.root / "private-portal.json"
    path.write_text(json.dumps(env.raw))
    path.chmod(0o600)
    capsys.readouterr()
    assert cli.main(["--config", str(path), "cards"]) == 0
    assert json.loads(capsys.readouterr().out)["cards"][0]["ref"] == cards.ref(approval["group"])
    assert cli.main(["--config", str(path), "resolve", "--text", f"RAPP approve {JOB1}"]) == 0
    assert json.loads(capsys.readouterr().out)["would"] == [f"approve {JOB1}"]
    assert (config.state_dir / "transport.json").read_bytes() == journal
    db.close()


def test_no_number_acts_on_a_card_another_author_spoke_after(env):
    """Seeded interleavings of the owner's numbers and another AI's bubbles: an Approve, Cancel
    or Stop runs only when nothing but our bubbles and the owner's messages came since the
    card it answers."""
    import random

    acts = refusals = 0
    for seed in range(16):
        rng = random.Random(seed)
        env.raw["state_dir"] = str(env.root / f"state-{seed}")
        env.native, env.runtime = Native(env.clock, env.source), Runtime(env.clock, env.jobs)
        line = timeline(env, f"S{seed}-")
        line.say("RAPP inspect these files")
        env.portal().tick()
        for step in range(12):
            env.clock.advance(rng.choice([1, 5, 10]))
            if rng.random() < 0.35:
                line.foreign()
                continue
            reply = line.say(rng.choice(["1", "2", "RAPP 1", "RAPP 2", "RAPP 3"]), typed_ago=rng.choice([0, 0, 2]))
            before, sent = len(env.runtime.calls), len(env.native.calls)
            env.portal().tick()
            refusals += sum(FOREIGN_LINE in call["text"] for call in env.native.calls[sent:])
            if [call for call in env.runtime.calls[before:] if call["op"] in ("approve", "cancel")
                    and "stdout_offset" not in call]:
                acts += 1
                prior = [row for row in line.rows if row["id"] < reply["id"]]
                foreign = [row["id"] for row in prior if "FOREIGN" in row["guid"]]
                ours = [row["id"] for row in prior if row["is_from_me"] and "FOREIGN" not in row["guid"]]
                assert ours and ours[-1] > max(foreign, default=0), (seed, step, reply["text"])
    assert acts and refusals


# Round 5 review, pass 1.


@pytest.mark.parametrize("kind", ["approval", "post", "heartbeat"])
def test_a_fast_rapp_n_is_judged_by_the_card_it_could_read_and_what_came_after_that(env, kind):
    """RAPP <n> typed as a newer card lands falls back to the card the owner could read; another
    AI's bubble after that card may be what the number answered, so nothing runs."""
    line = timeline(env)
    if kind == "post":
        post_id = delivered_feed_post(env)
    else:
        line.say("RAPP inspect these files")
        env.portal().tick()
        env.clock.advance(10)
        env.portal().tick()
    op, reply = "cancel", "RAPP 2"
    if kind == "heartbeat":
        line.say("1")
        env.portal().tick()
        assert explicit_ops(env, "approve")
        env.clock.advance(10)
        env.portal().tick()
        line.foreign()
        for _ in range(12):  # until the 2-minute heartbeat, offering the same Stop, goes out
            env.clock.advance(30)
            env.portal().tick()
            if progress_parts(env):
                break
        assert progress_parts(env)
    else:
        op, reply = ("answer", "RAPP 1") if kind == "post" else ("approve", "RAPP 1")
        line.foreign()
        line.say(reply)  # refused: the card (or update) comes again under the foreign bubble
        env.portal().tick()
        env.clock.advance(1)

    def done():
        if kind == "post":
            return state(env)["feed"][post_id]["state"] == "answered"
        return bool(explicit_ops(env, op))

    # Typed a second before the newest card reached the phone.
    line.say(reply, typed_ago=2 if kind != "heartbeat" else 1)
    env.portal().tick()
    assert not done()
    env.clock.advance(10)
    line.say(reply)  # under the card shown again, it runs
    env.portal().tick()
    assert done()


@pytest.mark.parametrize("failed", ["text-and-image", "image-only"])
def test_resolve_never_copies_files_or_asks_messages_for_a_retry_or_resend(env, failed):
    from rapp_bubbles import cards

    db = make_database(env)
    config = env.config()
    with Store(config.state_dir) as store:
        store.data["cursor"] = store.data["floor"] = 0
        store.save()
    insert_message(db, 1, "RAPP prepare the synthetic task")
    Portal(config, runtime=env.runtime, native=env.native, clock=env.clock).tick()
    with Store(config.state_dir) as store:
        outbox = Outbox(config, store, env.native, env.clock, env.source.target_matches)
        enqueue_native_test_batch(env, outbox, [".png"])
        text, image = outbox.parts("native-test-batch")
        # Messages reported the text failed (it has a row), or it went out; the image never
        # left the Mac, so a real retry would copy it again.
        if failed == "image-only":
            text.update(state="delivered", guid="DELIVERED-ROW", submitted_at=env.clock())
        else:
            text.update(state="failed", retryable=True, guid="FAILED-ROW", submitted_at=env.clock())
        image.update(state="failed", retryable=True)
        outbox.enqueue(f"job:{JOB1}:final", ACTOR, TARGET, "[RAPP 0001] ✓ Done", job_id=JOB1)
        uncertain = outbox.parts(f"job:{JOB1}:final")[0]
        uncertain.update(state="unknown", submitted_at=env.clock(), send_after_rowid=0)
        store.save()

    def files():
        return sorted((str(path), path.stat().st_mtime_ns) for path in config.state_dir.rglob("*") if path.is_file())

    before = files()
    retry = cards.resolve(config, copy.deepcopy(state(env)), f"RAPP retry {JOB1}", clock=env.clock)
    assert files() == before, "a dry-run retry copied a file"
    assert (retry["verdict"], retry["would"]) == ("acts", [f"retry {JOB1}"])
    resend = cards.resolve(config, copy.deepcopy(state(env)), f"RAPP resend {uncertain['id'][:6]}", clock=env.clock)
    assert (resend["verdict"], resend["would"]) == ("acts", [f"resend {JOB1}"])
    assert files() == before and not env.native.history_calls
    db.close()


def test_a_number_that_breaks_on_a_card_with_no_live_task_gets_the_skipped_card(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.source.events.append(message(1, "RAPP health"))
    env.portal().tick()
    assert env.native.calls[-1]["text"].startswith("[RAPP sys] · Health")

    def fragile(*_args, **_kwargs):
        raise KeyError("synthetic")

    monkeypatch.setattr(portal_module.Portal, "_health_card", fragile)
    env.clock.advance(10)
    env.source.events.append(message(2, "1"))  # [1] Health, on a card that is still open
    env.portal().tick()
    heads = [call["text"].split("\n", 1)[0] for call in env.native.calls[1:]]
    assert len(heads) == 1 and heads[0].endswith("! Skipped")
    assert "nothing ran" in env.native.calls[-1]["text"]


# Round 6: updates shown again whole, one read rule on every path, failures told once.


def running_on_timeline(env, line):
    line.say("RAPP inspect these files")
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    line.say("1")
    env.portal().tick()
    assert explicit_ops(env, "approve")
    env.clock.advance(10)
    env.portal().tick()


def until_heartbeat(env):
    for _ in range(12):
        env.clock.advance(30)
        env.portal().tick()
        if progress_parts(env):
            return
    raise AssertionError("no heartbeat went out")


def test_long_texts_split_between_lines_never_inside_one():
    from rapp_bubbles.outbox import pieces_of

    text = "\n".join(f"line {n:04d} " + "x" * 50 for n in range(100))
    pieces = pieces_of(text)
    assert len(pieces) == 3 and all(len(piece) <= 2400 for piece in pieces)
    assert "\n".join(pieces) == text
    assert pieces_of("") == [] and pieces_of("a" * 5000) == ["a" * 2400, "a" * 2400, "a" * 200]


def test_a_long_update_shown_again_keeps_every_line_whole_and_ends_with_its_options(env):
    line = timeline(env)
    filler = "\n".join(f"Step {n:02d}: " + "detail " * 7 for n in range(1, 41))
    text = f"Loop 01\n{filler}\n1. Ship it\n2. Hold"
    assert 2300 < len(text) <= 2400
    delivered_feed_post(env, text=text)
    env.clock.advance(10)
    line.foreign()
    line.say("RAPP 1")
    sent = len(env.native.calls)
    env.portal().tick()
    copy_bubbles = [call["text"] for call in env.native.calls[sent:]]
    assert len(copy_bubbles) == 2 and copy_bubbles[-1].endswith("\n1. Ship it\n2. Hold")
    own = set(text.split("\n"))
    for bubble in copy_bubbles:
        lines = [value for value in bubble.split("\n")
                 if not value.startswith(("[RAPP ", "⋯ ")) and "nothing was answered" not in value]
        assert set(lines) <= own, "a line of the update was cut in half"


def test_only_the_newest_copy_of_an_update_waits_and_none_goes_after_it_closes(env):
    line = timeline(env)
    post_id = delivered_feed_post(env)
    original = next(part for part in state(env)["outbox"] if part["group"] == f"feed:{post_id}")
    down = {"on": True}
    env.native.health = lambda _value, _now: not down["on"]
    for _ in range(2):  # Messages is down: each refusal's copy waits, replacing the one before
        env.clock.advance(10)
        line.foreign()
        line.say("RAPP 1")
        env.portal().tick()
    waiting = [part for part in state(env)["outbox"] if ":again:" in part["group"] and part["state"] == "queued"]
    assert len(waiting) == 1 and len(state(env)["feed"][post_id]["aliases"]) == 2
    env.clock.advance(10)
    line.say("1", reply_to=original["guid"])  # answered after all, by a swipe on the original
    env.portal().tick()
    assert state(env)["feed"][post_id]["state"] == "answered"
    down["on"] = False
    sent = len(env.native.calls)
    for _ in range(3):
        env.clock.advance(10)
        env.portal().tick()
    assert not [call for call in env.native.calls[sent:] if "nothing was answered" in call["text"]]


def test_a_newer_update_drops_an_older_ones_waiting_copy(env):
    from rapp_bubbles import feed

    line = timeline(env)
    first = delivered_feed_post(env)
    env.native.health = lambda _value, _now: False
    env.clock.advance(10)
    line.foreign()
    line.say("RAPP 1")
    env.portal().tick()
    assert [part for part in state(env)["outbox"] if ":again:" in part["group"] and part["state"] == "queued"]
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches, env.source.tail)
        feed.post(store, outbox, ACTOR, TARGET, text="Loop 02\n1. Ship it\n2. Hold", options=2, ttl=300,
                  channel="loop", now=env.clock())
    assert not [part for part in state(env)["outbox"] if part["group"].startswith(f"feed:{first}:again:")]


def test_a_refused_answer_is_never_lost_to_a_crash_between_its_saves(env, monkeypatch):
    from rapp_bubbles.state import JournalWriteError

    line = timeline(env)
    delivered_feed_post(env)
    real, failed = Outbox.enqueue, []

    def crash(self, group, *args, **kwargs):
        if ":again:" in group and not failed:
            failed.append(group)
            raise JournalWriteError(errno.ENOSPC, "synthetic full disk")
        return real(self, group, *args, **kwargs)

    monkeypatch.setattr(Outbox, "enqueue", crash)
    env.clock.advance(10)
    line.foreign()
    line.say("RAPP reply 1")
    with pytest.raises(JournalWriteError):
        env.portal().tick()
    env.clock.advance(10)
    sent = len(env.native.calls)
    env.portal().tick()
    assert len([call for call in env.native.calls[sent:] if "nothing was answered" in call["text"]]) == 1


def test_feed_status_shows_why_an_answer_was_refused_and_every_showing(env):
    from rapp_bubbles import feed

    line = timeline(env)
    post_id = delivered_feed_post(env)
    env.clock.advance(10)
    line.foreign()
    line.say("RAPP 1")
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    with Store(env.config().state_dir) as store:
        item = feed.describe(store, post_id)[0]
    assert item["state"] == "open" and item["answer"] is None
    assert [refusal["why"] for refusal in item["refusals"]] == ["foreign"]
    assert [showing["parts"] for showing in item["showings"]] == [["delivered"], ["delivered"]]
    assert item["refusals"][0]["copy"] == item["showings"][1]["ref"]


def test_refused_answers_keep_an_update_open_at_most_twice_its_window(env):
    line = timeline(env)
    post_id = delivered_feed_post(env)
    opened = state(env)["feed"][post_id]["delivered_at"]
    for _ in range(4):
        env.clock.advance(140)
        line.foreign()
        line.say("RAPP 1")
        env.portal().tick()
    assert state(env)["feed"][post_id]["open_until"] <= opened + 600
    env.clock.now = opened + 610
    env.portal().tick()
    assert state(env)["feed"][post_id]["state"] == "expired"


def test_a_fast_stop_is_not_refused_over_the_owners_own_note_to_another_ai(env):
    line = timeline(env)
    running_on_timeline(env, line)
    line.say("claude, what time is it?")  # his own message, not for us, so never recorded
    env.portal().tick()
    until_heartbeat(env)
    line.say("2", typed_ago=1)  # typed as the heartbeat, offering the same Stop, landed
    env.portal().tick()
    assert len(explicit_ops(env, "cancel")) == 1


@pytest.mark.parametrize("draws", [True, False])
def test_rapp_n_under_an_agent_post_that_draws_numbers_stops_nothing(env, draws):
    line = timeline(env)
    running_on_timeline(env, line)
    env.clock.advance(10)
    feed_post(env, text="Deploy?\n[1] Yes\n[2] No" if draws else "Build 42 passed.", options=0)
    env.portal().tick()
    env.clock.advance(10)
    line.say("RAPP 2")
    env.portal().tick()
    assert len(explicit_ops(env, "cancel")) == (0 if draws else 1)


def test_a_swipe_reply_in_a_thread_another_author_replied_in_shows_the_card_again(env):
    line = timeline(env)
    line.say("RAPP inspect these files")
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    card = approval_part(env)
    line.foreign(thread=card["guid"])  # another author replies under our card
    env.clock.advance(10)
    line.say("1", reply_to=card["guid"])  # iOS names the thread's root, whichever bubble was swiped
    sent = len(env.native.calls)
    env.portal().tick()
    assert not explicit_ops(env, "approve")
    assert len([call for call in env.native.calls[sent:]
                if "Someone else replied under the card, so nothing ran." in call["text"]]) == 1
    env.clock.advance(10)
    fresh = next(part for part in reversed(state(env)["outbox"]) if part.get("menu_kind") == "approval")
    line.say("1", reply_to=fresh["guid"])
    env.portal().tick()
    assert len(explicit_ops(env, "approve")) == 1


def test_reader_lists_the_replies_in_a_cards_thread(env):
    db = make_database(env)
    db.execute("ALTER TABLE message ADD COLUMN thread_originator_guid TEXT")
    source = SQLiteSource(env.config())
    insert_message(db, 1, "[RAPP 0001] ? Approve task?", guid="CARD")
    insert_message(db, 2, "another AI, in the thread", guid="IN-THREAD")
    db.execute("UPDATE message SET is_from_me=1,handle_id=NULL,thread_originator_guid='CARD' WHERE ROWID=2")
    insert_message(db, 3, "not in the thread", guid="OTHER")
    insert_message(db, 4, "1", guid="SWIPE")
    db.execute("UPDATE message SET thread_originator_guid='CARD' WHERE ROWID=4")
    db.commit()
    event = {"id": 4, "guid": "SWIPE"}
    assert source.thread_rows(CHAT, "CARD", event) == [{"guid": "IN-THREAD", "is_from_me": True, "sender": None}]
    assert source.thread_rows(CHAT, "OTHER", event) == []
    source.close()
    db.close()


def test_a_refusal_after_another_ais_message_names_the_reply_that_always_works(env):
    line = timeline(env)
    line.say("RAPP inspect these files")
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    line.foreign()
    line.say("RAPP 1")
    env.portal().tick()
    assert "Swipe-reply your number on this one." in env.native.calls[-1]["text"]
    assert "swipe-reply your number on it" in HELP
    env.clock.advance(10)
    line.foreign()  # a chatty AI speaks after every message, so no number is ever right under
    fresh = next(part for part in reversed(state(env)["outbox"]) if part.get("menu_kind") == "approval")
    line.say("1", reply_to=fresh["guid"])
    env.portal().tick()
    assert len(explicit_ops(env, "approve")) == 1


def approval_ready(env):
    env.source.events.append(message(1, "RAPP inspect these files"))
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()


def test_rapp_n_is_refused_when_the_reader_cannot_vouch_for_the_gap(env):
    approval_ready(env)
    env.source.between_rows = None  # too many rows between, or one the reader does not know
    env.source.events.append(message(2, "RAPP 1"))
    env.portal().tick()
    assert not explicit_ops(env, "approve")
    assert env.native.calls[-1]["text"].startswith("[RAPP 0001] ? Approve task?\n")


def test_rapp_n_is_refused_under_a_card_with_no_known_bubble(env):
    approval_ready(env)
    with Store(env.config().state_dir) as store:
        next(part for part in store.data["outbox"] if part["group"] == f"job:{JOB1}:approval").pop("guid")
        store.save()
    env.source.events.append(message(2, "RAPP 1"))
    env.portal().tick()
    assert not explicit_ops(env, "approve")


def test_a_card_from_before_sends_were_timed_lands_at_the_end_of_its_timeout(env):
    env.source.events.append(message(1, "RAPP inspect these files"))
    env.portal().tick()
    with Store(env.config().state_dir) as store:
        part = next(part for part in store.data["outbox"] if part["group"] == f"job:{JOB1}:approval")
        part.pop("sent_at")
        store.save()
    env.clock.advance(15)
    env.source.events.append(message(2, "1", created_at=at(part["submitted_at"] + 10)))
    env.portal().tick()
    assert not explicit_ops(env, "approve")


def journal_writes(path, before):
    now = (path.stat().st_ino, path.stat().st_mtime_ns)
    return int(now != before), now


def test_a_flapping_stage_is_one_incident_written_about_once_a_minute(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.portal().tick()
    real, ticks = portal_module.Portal._outage_report, [0]

    def flaky(self):
        ticks[0] += 1
        if ticks[0] % 2:
            raise RuntimeError("synthetic")
        return real(self)

    monkeypatch.setattr(portal_module.Portal, "_outage_report", flaky)
    journal = Path(env.raw["state_dir"]) / "transport.json"
    writes, mark = 0, (journal.stat().st_ino, journal.stat().st_mtime_ns)
    for _ in range(30):  # five minutes, failing every other tick
        env.clock.advance(10)
        env.portal().tick()
        wrote, mark = journal_writes(journal, mark)
        writes += wrote
    flaky = [call for call in env.native.calls if call["text"].startswith("[RAPP sys] ! Outage flaky")]
    assert len(flaky) == 1 and writes <= 15


def test_an_hourly_stage_that_fails_each_run_is_told_on_its_second_run(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)

    def broken(self):
        data, now = self.store.data, self.clock()
        if now - data.get("compacted_at", 0) < 3600:
            return False
        data["compacted_at"] = now
        raise RuntimeError("synthetic")

    monkeypatch.setattr(portal_module.Portal, "_compact", broken)
    for _ in range(125):  # two hours of ticks
        env.clock.advance(60)
        env.portal().tick()
    stuck = [call for call in env.native.calls if call["text"].startswith("[RAPP sys] ! Cleanup stuck")]
    assert len(stuck) == 1


def test_a_stuck_sender_sends_one_back_card_and_no_stuck_card(env, monkeypatch):
    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.portal().tick()
    real = Outbox.pump

    def broken(self, *, reconcile_only=False):
        if not reconcile_only:
            raise RuntimeError("synthetic")
        return real(self, reconcile_only=True)

    monkeypatch.setattr(Outbox, "pump", broken)
    for _ in range(12):
        env.clock.advance(10)
        env.portal().tick()
    monkeypatch.setattr(Outbox, "pump", real)
    for _ in range(15):
        env.clock.advance(100)
        env.portal().tick()
    heads = [call["text"].split("\n", 1)[0] for call in env.native.calls]
    assert [head for head in heads if "Sending" in head] == ["[RAPP sys] ✓ Sending back"]


def test_a_stage_card_that_breaks_never_takes_the_tick_down(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.portal().tick()

    def broken(_self):
        raise RuntimeError("synthetic")

    def card(*_args, **_kwargs):
        raise KeyError("synthetic card")

    monkeypatch.setattr(portal_module.Portal, "_outage_report", broken)
    monkeypatch.setattr(portal_module.Portal, "_system_card", card)
    for _ in range(9):
        env.clock.advance(10)
        assert env.portal().tick()["ok"]
    assert state(env)["stages"]["outage"]["told"]


def test_a_full_disk_never_erases_the_failed_tick_count(env, monkeypatch):
    from rapp_bubbles import cli

    owner_target(env)
    env.portal().tick()
    config = env.config()
    for _ in range(3):
        cli.record_tick_failure(config, OSError(errno.ENOSPC, "No space left on device"))

    def full(*_args, **_kwargs):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(cli.json, "dump", full)
    cli.record_tick_failure(config, OSError(errno.ENOSPC, "No space left on device"))
    monkeypatch.undo()
    env.clock.advance(600)
    env.portal().tick()  # queues the card; the next tick sends it
    env.clock.advance(10)
    env.portal().tick()
    back = [call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ✓ Back online")]
    assert len(back) == 1 and "3 ticks failed · disk full" in back[0]


def test_a_failed_tick_record_is_kept_until_the_save_that_holds_it(env, monkeypatch):
    from rapp_bubbles import cli
    from rapp_bubbles import portal as portal_module
    from rapp_bubbles.state import JournalWriteError

    owner_target(env)
    env.portal().tick()
    config = env.config()
    for _ in range(2):
        cli.record_tick_failure(config, OSError(errno.ENOSPC, "No space left on device"))
    real = portal_module.Portal._system_card

    def full(self, key, *args, **kwargs):
        if key.startswith("sys:gap:"):
            raise JournalWriteError(errno.ENOSPC, "synthetic full disk")
        return real(self, key, *args, **kwargs)

    monkeypatch.setattr(portal_module.Portal, "_system_card", full)
    env.clock.advance(600)
    with pytest.raises(JournalWriteError):
        env.portal().tick()
    assert (config.state_dir / "tick-failure.json").exists()
    monkeypatch.setattr(portal_module.Portal, "_system_card", real)
    for _ in range(2):
        env.clock.advance(10)
        env.portal().tick()
    back = [call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ✓ Back online")]
    assert len(back) == 1 and "2 ticks failed · disk full" in back[0]


def test_ticks_that_fail_now_and_then_gather_instead_of_a_write_each(env, monkeypatch):
    from rapp_bubbles import cli

    owner_target(env)
    env.portal().tick()
    config = env.config()
    monkeypatch.setattr(cli.time, "time", env.clock)
    journal = Path(env.raw["state_dir"]) / "transport.json"
    writes, mark, failed = 0, (journal.stat().st_ino, journal.stat().st_mtime_ns), 0
    for n in range(45):  # 15 minutes; one tick in three fails (a locked chat.db)
        env.clock.advance(20)
        if n % 3 == 0:
            cli.record_tick_failure(config, OSError(errno.EIO, "synthetic"))
            failed += 1
            continue
        env.portal().tick()
        wrote, mark = journal_writes(journal, mark)
        writes += wrote
    # One merge, and the one card it sends (queued, sent, receipt), not a write per failure.
    assert writes <= 8
    assert state(env)["last_tick_failure"]["count"] >= 10
    assert len([call for call in env.native.calls if call["text"].startswith("[RAPP sys] ! Ticks failing")]) == 1


def test_a_locked_chat_db_is_named_as_the_cause(tmp_path):
    from rapp_bubbles import cli

    path = tmp_path / "locked.db"
    holder = sqlite3.connect(path, timeout=0)
    holder.execute("CREATE TABLE t(x)")
    holder.commit()
    holder.execute("BEGIN EXCLUSIVE")
    other = sqlite3.connect(path, timeout=0)
    with pytest.raises(sqlite3.Error) as caught:
        other.execute("INSERT INTO t VALUES(1)")
    holder.rollback()
    holder.close()
    other.close()
    assert cli.failure_code(caught.value) == "sqlite_busy"
    assert Portal._failure_cause({"code": "sqlite_busy"}) == "chat.db busy"


def test_a_broken_recheck_of_an_approve_that_ran_never_says_nothing_ran(env, monkeypatch):
    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.source.events.append(message(1, "RAPP inspect these files"))
    env.portal().tick()
    real = env.runtime.request

    def lossy(request):
        if request["op"] == "status" and "stdout_offset" not in request:
            raise KeyError("synthetic")  # the re-check itself breaks
        response = real(request)
        if request["op"] == "approve":
            raise SubmissionUnknown("runtime_reply_lost", "Synthetic lost reply.")
        return response

    env.runtime.request = lossy
    env.clock.advance(10)
    env.source.events.append(message(2, "1"))
    env.portal().tick()
    assert env.runtime.jobs[JOB1]["status"] == "running"  # the approve did land
    heads = [call["text"].split("\n", 1)[0] for call in env.native.calls]
    assert heads.count("[RAPP 0001] ! Checking") == 1
    env.clock.advance(10)
    env.portal().tick()
    texts = [call["text"] for call in env.native.calls]
    assert not any("nothing ran" in text for text in texts)
    final = [text for text in texts if text.startswith("[RAPP 0001] ! May have run")]
    assert len(final) == 1 and "[1] Details" in final[0]
    record = next(item for item in state(env)["inbox"].values() if item["event"]["id"] == 2)
    assert record["state"] == "failed" and record["internal_attempts"] == 2


@pytest.mark.parametrize("reply", ["1", "2"])
def test_an_approve_or_cancel_that_breaks_after_the_runtime_call_is_checked(env, monkeypatch, reply):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.source.events.append(message(1, "RAPP inspect these files"))
    env.portal().tick()
    real = portal_module.response_job

    def fragile(response):
        if (response.get("job") or {}).get("status") in ("running", "cancelled"):
            raise KeyError("synthetic")
        return real(response)

    monkeypatch.setattr(portal_module, "response_job", fragile)
    env.clock.advance(10)
    env.source.events.append(message(2, reply))
    env.portal().tick()
    texts = [call["text"] for call in env.native.calls]
    assert not any("nothing ran" in text for text in texts)
    assert any(text.split("\n", 1)[0].endswith("! Checking") for text in texts)


def test_cards_says_when_rapp_n_would_be_refused_and_why(env):
    from rapp_bubbles import cards

    line = timeline(env)
    line.direct_target = lambda chat: {"chat_id": 1, "chat_guid": chat, "is_group": False}
    line.say("RAPP inspect these files")
    env.portal().tick()
    config = env.config()

    def rapp_n():
        with Store(config.state_dir) as store:
            return cards.describe(config, store, clock=env.clock, source=line)["rapp_n"]

    assert rapp_n()["blocked"] == "unconfirmed"
    env.clock.advance(1)
    env.portal().tick()
    assert (rapp_n()["blocked"], rapp_n()["ready_in"]) == ("race", 2.0)
    env.clock.advance(10)
    assert rapp_n()["blocked"] is None
    line.foreign()
    assert rapp_n()["blocked"] == "foreign"


# Round 6 review, pass 1.


def test_a_fast_stop_under_a_long_card_with_another_ais_bubble_inside_it_stops_nothing(env):
    line = timeline(env)
    running_on_timeline(env, line)
    original = env.runtime.request

    def long_result(request):
        value = original(request)
        if request["op"] == "result":
            value["stdout"] = {**value["stdout"], "text": "\n".join(f"row {n:03d} " + "y" * 60 for n in range(90))}
        return value

    env.runtime.request = long_result
    real = env.native.send

    def interleaving(chat_id, *, text="", file=""):
        result = real(chat_id, text=text, file=file)
        if "⋯ 1/" in text:
            line.foreign()  # another AI's bubble lands while our card is still going out
        return result

    env.native.send = interleaving
    env.clock.advance(10)
    line.say("RAPP result 0001")  # a 3-bubble "output so far" card, ending [2] Stop
    env.portal().tick()
    assert any("FOREIGN" in row["guid"] for row in line.rows)
    env.clock.advance(1)
    line.say("2")  # right under its last bubble, a second after it landed
    env.portal().tick()
    assert not explicit_ops(env, "cancel")


def test_a_fast_answer_under_a_copy_with_another_ais_bubble_inside_it_is_not_recorded(env):
    line = timeline(env)
    filler = "\n".join(f"Step {n:02d}: " + "detail " * 7 for n in range(1, 41))
    post_id = feed_post(env, text=f"Loop 01\n{filler}\n1. Ship it\n2. Hold")
    env.portal().tick()
    real = env.native.send

    def interleaving(chat_id, *, text="", file=""):
        result = real(chat_id, text=text, file=file)
        if text.startswith("[RAPP loop] Not answered") and "⋯ 1/2" in text:
            line.foreign()  # another AI's bubble lands between the copy's two bubbles
        return result

    env.native.send = interleaving
    env.clock.advance(10)
    line.say("1", typed_ago=9)  # typed a second after the post landed: refused, shown again
    env.portal().tick()
    assert any("FOREIGN" in row["guid"] for row in line.rows)
    env.clock.advance(1)
    line.say("1")  # right under the copy's last bubble, a second after it landed
    env.portal().tick()
    assert state(env)["feed"][post_id]["state"] != "answered"


def test_a_copy_is_not_sent_when_the_update_has_no_reply_window_left(env):
    line = timeline(env)
    post_id = delivered_feed_post(env)
    opened = state(env)["feed"][post_id]["delivered_at"]
    env.clock.now = opened + 299  # first refusal: the window grows to opened + 599
    line.foreign()
    line.say("RAPP 1")
    env.portal().tick()
    env.clock.now = opened + 598  # second refusal: capped at opened + 600, two seconds left
    line.foreign()
    line.say("RAPP 1")
    sent = len(env.native.calls)
    env.portal().tick()
    texts = [call["text"] for call in env.native.calls[sent:]]
    assert not [text for text in texts if "Not answered ·" in text.split("\n", 1)[0]]
    assert any("That update is no longer open." in text for text in texts)
    assert state(env)["feed"][post_id]["refusals"][-1]["copy"] is None
    # And it is closed, as the owner was told: an answer a second later is not taken.
    assert state(env)["feed"][post_id]["state"] == "expired"
    env.clock.advance(1)
    line.say("RAPP reply 1")
    env.portal().tick()
    assert state(env)["feed"][post_id]["state"] == "expired"


def test_an_update_with_a_short_reply_window_still_gets_its_copy(env):
    line = timeline(env)
    post_id = delivered_feed_post(env, ttl=20)
    part = next(item for item in state(env)["outbox"] if item["group"] == f"feed:{post_id}")
    line.say("1", typed_ago=env.clock() - part["sent_at"] - 1)  # typed a second after it landed
    sent = len(env.native.calls)
    env.portal().tick()
    texts = [call["text"] for call in env.native.calls[sent:]]
    assert [text.split("\n", 1)[0] for text in texts] == ["[RAPP loop] Not answered · Loop 01"]
    item = state(env)["feed"][post_id]
    assert item["state"] == "open" and item["open_until"] - env.clock() == 20


def dry_run_on(line, monkeypatch):
    from rapp_bubbles import cards

    line.direct_target = lambda chat: {"chat_id": 1, "chat_guid": chat, "is_group": False}
    line.close = lambda: None
    monkeypatch.setattr(cards, "SQLiteSource", lambda _config: line)
    return cards


def test_resolve_lists_the_cards_it_would_send_even_when_a_waiting_copy_is_dropped(env, monkeypatch):
    line = timeline(env)
    cards = dry_run_on(line, monkeypatch)
    post_id = delivered_feed_post(env)
    original = next(part for part in state(env)["outbox"] if part["group"] == f"feed:{post_id}")
    env.native.health = lambda _value, _now: False  # Messages is down: the copy waits
    env.clock.advance(10)
    line.foreign()
    line.say("RAPP 1")
    env.portal().tick()
    again = cards.resolve(env.config(), copy.deepcopy(state(env)), "RAPP 1", clock=env.clock)
    assert (again["verdict"], again["cards"]) == ("reoffers", ["[RAPP loop] Not answered · Loop 01"])
    answered = cards.resolve(env.config(), copy.deepcopy(state(env)), "RAPP reply 1",
                             reply_to=cards.ref(original["group"]), clock=env.clock)
    assert answered["answers"] == [post_id] and answered["cards"]


def test_resolve_says_new_tasks_wait_while_the_disk_check_fails(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    line = timeline(env)
    cards = dry_run_on(line, monkeypatch)

    def usage(_path):
        raise RuntimeError("synthetic disk check failure")

    monkeypatch.setattr(portal_module.shutil, "disk_usage", usage)
    env.clock.advance(10)
    env.portal().tick()
    dry = cards.resolve(env.config(), copy.deepcopy(state(env)), "RAPP inspect more", clock=env.clock)
    assert dry["verdict"] == "fails" and "disk_unknown" in dry["errors"]


def test_a_failure_that_only_moved_the_records_time_is_still_counted(env, monkeypatch):
    from rapp_bubbles import cli

    owner_target(env)
    env.portal().tick()
    config = env.config()
    now = {"t": env.clock()}
    monkeypatch.setattr(cli.time, "time", lambda: now["t"])
    real_utime = os.utime
    monkeypatch.setattr(cli.os, "utime", lambda path, times=None, **kwargs: real_utime(
        path, times if times is not None else (now["t"], now["t"]), **kwargs))
    cli.record_tick_failure(config, OSError(errno.EIO, "synthetic"))  # written
    now["t"] += 10
    real_dump = cli.json.dump

    def full(*_args, **_kwargs):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(cli.json, "dump", full)
    cli.record_tick_failure(config, OSError(errno.ENOSPC, "No space left on device"))  # only its time moves
    monkeypatch.setattr(cli.json, "dump", real_dump)
    now["t"] += 10
    cli.record_tick_failure(config, OSError(errno.EIO, "synthetic"))  # written again
    env.clock.now = now["t"] + 600
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    back = [call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ✓ Back online")]
    assert len(back) == 1 and "2+ ticks failed" in back[0]


# Round 6 review, pass 3.


def near_cap(env, line):
    """A delivered update whose second refusal lands 2 s before the 2x cap."""
    post_id = delivered_feed_post(env)
    opened = state(env)["feed"][post_id]["delivered_at"]
    env.clock.now = opened + 299
    line.foreign()
    line.say("RAPP 1")
    env.portal().tick()
    env.clock.now = opened + 598
    return post_id


def test_a_withheld_refusal_handled_again_after_a_crash_is_told_once(env, monkeypatch):
    from rapp_bubbles import portal as portal_module
    from rapp_bubbles.state import JournalWriteError

    line = timeline(env)
    near_cap(env, line)
    copy_part = next(part for part in reversed(state(env)["outbox"]) if ":again:" in part["group"])
    real, failed = portal_module.Portal._remember_reply, []

    def crash(self, identity, event, actor, target, kind):
        if kind == "feed_race" and not failed:
            failed.append(kind)
            raise JournalWriteError(errno.ENOSPC, "synthetic full disk")
        return real(self, identity, event, actor, target, kind)

    monkeypatch.setattr(portal_module.Portal, "_remember_reply", crash)
    line.say("1", typed_ago=env.clock() - copy_part["sent_at"] - 1)  # typed as the copy landed
    sent = len(env.native.calls)
    with pytest.raises(JournalWriteError):
        env.portal().tick()
    env.clock.advance(1)
    env.portal().tick()
    assert [call["text"].split("\n", 1)[0].rsplit("· ", 1)[-1] for call in env.native.calls[sent:]] == ["Not answered"]


def test_resolve_reports_a_withheld_copy_as_the_update_closing(env, monkeypatch):
    line = timeline(env)
    cards = dry_run_on(line, monkeypatch)
    near_cap(env, line)
    line.foreign()
    dry = cards.resolve(env.config(), copy.deepcopy(state(env)), "RAPP 1", clock=env.clock)
    assert dry["refused"] == ["That update is no longer open."]
    assert [head.rsplit("· ", 1)[-1] for head in dry["cards"]] == ["Not answered"]


# Round 7: a number never runs what the owner did not mean; failures that keep coming are told;
# answers only to updates that reached the phone.


def second_task_waiting(env):
    """Task 1 is running; task 2's approval card is waiting; then task 1's heartbeat lands."""
    approved_running_job(env)
    env.source.events.append(message(3, "RAPP another task"))
    env.portal().tick()
    assert state(env)["conversations"] and any(
        conversation["approvals"] for conversation in state(env)["conversations"].values())
    until_heartbeat(env)


def test_a_bare_stop_under_a_heartbeat_waits_while_another_tasks_approval_does(env):
    second_task_waiting(env)
    heartbeat = progress_parts(env)[-1]
    env.clock.advance(10)
    env.source.events.append(message(10, "2"))  # meant for task 2's Cancel, landed under the heartbeat
    env.portal().tick()
    assert not explicit_ops(env, "cancel")
    assert "Task 0002's approval is waiting, so nothing stopped." in env.native.calls[-1]["text"]
    env.clock.advance(10)
    env.source.events.append(message(11, "2", reply_to=heartbeat["guid"]))  # a swipe-reply names its card
    env.portal().tick()
    assert [call["job_id"] for call in explicit_ops(env, "cancel")] == [JOB1]


def test_rapp_2_while_an_approval_waits_shows_the_running_card_again_not_an_error(env):
    second_task_waiting(env)
    env.clock.advance(10)
    env.source.events.append(message(10, "RAPP 2"))
    env.portal().tick()
    shown = env.native.calls[-1]["text"]
    assert not explicit_ops(env, "cancel")
    assert shown.startswith("[RAPP 0001] ● Not stopped\n") and "Task 0002's approval is waiting" in shown
    env.clock.advance(10)
    env.source.events.append(message(11, "RAPP stop 0001"))
    env.portal().tick()
    assert [call["job_id"] for call in explicit_ops(env, "cancel")] == [JOB1]


def long_result_card(env, line):
    running_on_timeline(env, line)
    original = env.runtime.request

    def long_result(request):
        value = original(request)
        if request["op"] == "result":
            rows = [f"row {n:03d} " + "y" * 60 for n in range(60)]
            rows[5] = "[2] Show the diff"  # worker text drawing an option of its own
            value["stdout"] = {**value["stdout"], "text": "\n".join(rows + [f"tail {n:03d} " + "z" * 60 for n in range(30)])}
        return value

    env.runtime.request = long_result
    env.clock.advance(10)
    line.say("RAPP result 0001")
    env.portal().tick()
    pieces = sorted((part for part in state(env)["outbox"] if part["group"].startswith(f"job:{JOB1}:requested:")),
                    key=lambda part: part["index"])
    assert len(pieces) >= 2 and pieces[0]["menu_kind"] == "running"
    return pieces


def test_a_swipe_on_a_middle_piece_whose_worker_text_draws_options_stops_nothing(env):
    line = timeline(env)
    pieces = long_result_card(env, line)
    env.clock.advance(10)
    line.say("2", reply_to=pieces[0]["guid"])
    env.portal().tick()
    assert not explicit_ops(env, "cancel")
    assert "That bubble is not the one with the options" in env.native.calls[-1]["text"]
    env.clock.advance(10)
    line.say("2", reply_to=pieces[-1]["guid"])  # on the bubble that shows the options
    env.portal().tick()
    assert [call["job_id"] for call in explicit_ops(env, "cancel")] == [JOB1]


def test_numbers_are_seen_in_any_form_a_phone_shows_them():
    from rapp_bubbles import itui

    for text in ("[1] Yes", "2. Hold", "3) Later", "(2) Show", "2\ufe0f\u20e3 Show", "\u200b2. Show",
                 "\uff3b\uff12\uff3d Show", "2 - Show", "[2]Show", "\u20682\u2069. Show", "• 1 item", "\u0662. Show"):
        assert itui.draws_numbers(f"Header\n{text}"), text
    for text in ("Build 42 passed.", "Loop 01", "Step 3 done", "No numbers here"):
        assert not itui.draws_numbers(text), text


@pytest.mark.parametrize("drawn", ["(2) Show", "2\ufe0f\u20e3 Show", "\u200b2. Show", "\uff3b\uff12\uff3d Show",
                                   "2 - Show", "[2]Show", "\u20682\u2069. Show"])
def test_an_agent_post_drawing_numbers_in_any_form_interrupts_rapp_n(env, drawn):
    line = timeline(env)
    running_on_timeline(env, line)
    env.clock.advance(10)
    feed_post(env, text=f"Deploy?\n{drawn}", options=0)
    env.portal().tick()
    env.clock.advance(10)
    line.say("RAPP 2")
    env.portal().tick()
    assert not explicit_ops(env, "cancel")


def test_a_task_no_longer_followed_has_no_live_menu(env):
    approved_running_job(env)
    with Store(env.config().state_dir) as store:
        store.data["jobs"][JOB1]["final_queued"] = True  # lost: no longer followed
        store.save()
    env.clock.advance(10)
    env.source.events.append(message(3, "2"))  # under its old running card
    env.portal().tick()
    assert not explicit_ops(env, "cancel")
    last = env.native.calls[-1]["text"]
    assert "next ~" not in last and "Card closed" in last.split("\n", 1)[0]


@pytest.mark.parametrize("channel", ["0001", "9c1e", "beef", "sys", "artifact", "1loop"])
def test_a_feed_channel_cannot_look_like_a_task_or_system_card(env, channel):
    with pytest.raises(PortalError) as caught:
        feed_post(env, channel=channel)
    assert caught.value.code == "feed_invalid"
    feed_post(env, channel="loop")
    feed_post(env, channel="eta-2")


def test_cards_reports_blocked_for_each_number_the_way_the_tick_guards(env):
    from rapp_bubbles import cards

    line = timeline(env)
    line.direct_target = lambda chat: {"chat_id": 1, "chat_guid": chat, "is_group": False}
    running_on_timeline(env, line)
    env.clock.advance(10)
    line.foreign()
    config = env.config()
    with Store(config.state_dir) as store:
        rapp_n = cards.describe(config, store, clock=env.clock, source=line)["rapp_n"]
    assert [option["blocked"] for option in rapp_n["options"]] == [None, "foreign", None]
    assert rapp_n["blocked"] == "foreign"
    line.say("RAPP 1")  # Details is not guarded, so it runs
    env.portal().tick()
    assert [call for call in env.runtime.calls if call["op"] == "status" and "stdout_offset" not in call]


def test_a_stage_whose_error_keeps_changing_is_told_once(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.portal().tick()
    kinds = [KeyError, RuntimeError]

    def broken(_self):
        kinds.reverse()
        raise kinds[0]("synthetic")

    monkeypatch.setattr(portal_module.Portal, "_outage_report", broken)
    for _ in range(12):
        env.clock.advance(10)
        env.portal().tick()
    stuck = [call for call in env.native.calls if call["text"].startswith("[RAPP sys] ! Outage stuck")]
    assert len(stuck) == 1
    assert sorted(item["code"] for item in state(env)["errors"]) == [
        "internal:outage:KeyError", "internal:outage:RuntimeError"]


def test_a_stage_failing_every_few_minutes_is_one_incident_told_once(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.portal().tick()
    real, ticks = portal_module.Portal._outage_report, [0]

    def now_and_then(self):
        ticks[0] += 1
        if ticks[0] % 15 == 1:  # one tick in fifteen: every 150 s
            raise RuntimeError("synthetic")
        return real(self)

    monkeypatch.setattr(portal_module.Portal, "_outage_report", now_and_then)
    for _ in range(60):
        env.clock.advance(10)
        env.portal().tick()
    flaky = [call for call in env.native.calls if call["text"].startswith("[RAPP sys] ! Outage flaky")]
    assert len(flaky) == 1


def test_ticks_failing_between_good_ones_are_told_at_most_once_an_hour(env, monkeypatch):
    from rapp_bubbles import cli

    owner_target(env)
    env.portal().tick()
    config = env.config()
    monkeypatch.setattr(cli.time, "time", env.clock)
    for n in range(120):  # 40 minutes; one tick in three fails
        env.clock.advance(20)
        if n % 3 == 0:
            cli.record_tick_failure(config, OSError(errno.ENOSPC, "No space left on device"))
            continue
        env.portal().tick()
    cards_sent = [call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ! Ticks failing")]
    assert len(cards_sent) == 1 and "disk full" in cards_sent[0]


def test_a_busy_chat_db_behind_the_readers_wrapper_is_named(env):
    from rapp_bubbles import cli

    db = make_database(env)
    source = SQLiteSource(env.config())
    db.execute("BEGIN EXCLUSIVE")
    with pytest.raises(PortalError) as caught:
        source.tail()
    db.rollback()
    source.close()
    db.close()
    assert caught.value.code == "messages_unavailable"
    assert cli.failure_code(caught.value) == "sqlite_busy"
    assert Portal._failure_cause({"code": cli.failure_code(caught.value)}) == "chat.db busy"
    assert Portal._failure_cause({"code": "sqlite_busy_recovery"}) == "chat.db busy"


def test_back_online_on_a_critical_disk_is_not_all_clear(env, monkeypatch):
    owner_target(env)
    free = {"bytes": 50 * 2**30}
    full_disk(monkeypatch, free)
    env.portal().tick()
    free["bytes"] = 1 * 2**30  # critical
    env.clock.advance(900)
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    back = [call["text"] for call in env.native.calls if "Back" in call["text"].split("\n", 1)[0]]
    assert len(back) == 1 and back[0].startswith("[RAPP sys] ! Back, disk full")
    assert "new tasks paused until space frees" in back[0]


def test_rapp_reply_answers_the_update_on_the_phone_while_a_newer_one_waits(env):
    line = timeline(env)
    first = delivered_feed_post(env)
    env.native.health = lambda _value, _now: False  # Messages is down: the next post waits
    feed_post(env, channel="other", text="Other 01\n1. Yes\n2. No")
    env.clock.advance(10)
    line.say("RAPP reply 1")
    env.portal().tick()
    assert state(env)["feed"][first]["state"] == "answered"


def test_an_update_whose_delivery_never_confirms_lapses_instead_of_taking_answers(env):
    line = timeline(env)
    post_id = feed_post(env, ttl=60)
    env.portal().tick()  # sent
    part = next(item for item in state(env)["outbox"] if item["group"] == f"feed:{post_id}")
    env.native.states[part["guid"]] = "pending"  # its receipt never confirms
    for _ in range(40):
        env.clock.advance(30)
        env.portal().tick()
    item = state(env)["feed"][post_id]
    assert item["state"] == "expired" and item.get("lapsed")
    env.clock.advance(3 * 86400)
    line.say("RAPP reply 1")
    env.portal().tick()
    assert state(env)["feed"][post_id]["state"] == "expired"


def test_a_copy_of_an_update_that_starts_with_an_option_keeps_its_menu_whole(env):
    line = timeline(env)
    delivered_feed_post(env, text="1. Ship it\n2. Hold")
    env.clock.advance(10)
    line.foreign()
    line.say("RAPP 1")
    env.portal().tick()
    shown = env.native.calls[-1]["text"]
    assert shown.split("\n", 1)[0] == "[RAPP loop] Not answered"
    assert shown.endswith("\n1. Ship it\n2. Hold")


def test_a_refused_text_answer_is_told_to_send_its_answer_again(env):
    line = timeline(env)
    delivered_feed_post(env)
    env.clock.advance(10)
    line.foreign()
    line.say("RAPP reply ship it")
    env.portal().tick()
    shown = env.native.calls[-1]["text"]
    assert "Swipe-reply your answer on this one." in shown and "number" not in shown.split("\n")[1]


def test_thread_rows_stops_at_fifty_and_skips_tapbacks_and_later_rows(env):
    db = make_database(env)
    db.execute("ALTER TABLE message ADD COLUMN thread_originator_guid TEXT")
    source = SQLiteSource(env.config())
    insert_message(db, 1, "[RAPP 0001] ? Approve task?", guid="CARD")
    insert_message(db, 2, "Liked a message", guid="TAPBACK")
    db.execute("UPDATE message SET associated_message_type=2001,thread_originator_guid='CARD' WHERE ROWID=2")
    insert_message(db, 3, "1", guid="SWIPE")
    db.execute("UPDATE message SET thread_originator_guid='CARD' WHERE ROWID=3")
    insert_message(db, 4, "another AI, later", guid="LATER")
    db.execute("UPDATE message SET is_from_me=1,handle_id=NULL,thread_originator_guid='CARD' WHERE ROWID=4")
    db.commit()
    assert source.thread_rows(CHAT, "CARD", {"id": 3, "guid": "SWIPE"}) == []
    for index in range(5, 56):
        insert_message(db, index, "in the thread", guid=f"REPLY-{index}")
        db.execute("UPDATE message SET thread_originator_guid='CARD' WHERE ROWID=?", (index,))
    db.commit()
    assert source.thread_rows(CHAT, "CARD", {"id": 100, "guid": "LATEST"}) is None
    source.close()
    db.close()


def test_may_have_run_names_the_picked_job_and_offers_its_details(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    approved_running_job(env)
    real = portal_module.response_job

    def fragile(response):
        if (response.get("job") or {}).get("status") == "cancelled":
            raise KeyError("synthetic")
        return real(response)

    monkeypatch.setattr(portal_module, "response_job", fragile)
    env.clock.advance(10)
    env.source.events.append(message(3, "2"))  # Stop, from the running card's menu
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    final = next(part for part in state(env)["outbox"] if part["text"].startswith("[RAPP 0001] ! May have run"))
    assert final["menu_kind"] == "check" and final["menu"][0] == f"status {JOB1}"


# Round 7 review, pass 1.


@pytest.mark.parametrize("drawn", ["\u2777 Hold", "\u278b Hold", "\u24f6 Hold", "- **2.** Hold", ">>> 2. Hold"])
def test_circled_digits_and_markdown_bullets_in_a_post_interrupt_rapp_n(env, drawn):
    line = timeline(env)
    running_on_timeline(env, line)
    env.clock.advance(10)
    feed_post(env, text=f"Deploy?\n{drawn}", options=0)
    env.portal().tick()
    env.clock.advance(10)
    line.say("RAPP 2")
    env.portal().tick()
    assert not explicit_ops(env, "cancel")


def test_a_status_post_waiting_out_an_outage_is_still_sent(env):
    healthy = [False]
    env.native.health = lambda _value, _now: healthy[0]
    feed_post(env, text="Build finished", options=0)
    for _ in range(54):
        env.clock.advance(10)
        env.portal().tick()
    healthy[0] = True
    for _ in range(3):
        env.clock.advance(10)
        env.portal().tick()
    assert [call["text"] for call in env.native.calls] == ["[RAPP loop] Build finished"]


def test_a_post_sent_late_still_takes_its_answer_once_delivered(env):
    line = timeline(env)
    healthy = [False]
    env.native.health = lambda _value, _now: healthy[0]
    post_id = feed_post(env, ttl=300)
    created = env.clock.now
    while env.clock.now < created + 470:
        env.clock.advance(10)
        env.portal().tick()
    healthy[0] = True
    env.clock.advance(5)
    env.portal().tick()  # sent at last
    part = next(item for item in state(env)["outbox"] if item["group"] == f"feed:{post_id}")
    env.native.states[part["guid"]] = "pending"
    env.clock.advance(10)
    env.portal().tick()
    env.native.states[part["guid"]] = "delivered"
    env.clock.advance(10)
    env.portal().tick()
    env.clock.advance(20)
    line.say("1")
    env.portal().tick()
    assert state(env)["feed"][post_id]["state"] == "answered"


def test_a_long_cards_options_go_out_whole_in_its_last_bubble(env):
    line = timeline(env)
    running_on_timeline(env, line)
    original = env.runtime.request

    def result(request):
        value = original(request)
        if request["op"] == "result":
            rows = [f"row {n:03d} " + "y" * 60 for n in range(32)] + ["p" * 37]
            value["stdout"] = {**value["stdout"], "text": "\n".join(rows)}
        return value

    env.runtime.request = result
    env.clock.advance(10)
    line.say("RAPP result 0001")
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    pieces = sorted((part for part in state(env)["outbox"] if part["group"].startswith(f"job:{JOB1}:requested:")),
                    key=lambda part: part["index"])
    assert len(pieces) == 2 and "[1] Details\n[2] Stop\n[3] Quiet" in pieces[-1]["text"]
    assert "[2] Stop" not in pieces[0]["text"]
    env.clock.advance(10)
    line.say("2", reply_to=pieces[-1]["guid"])
    env.portal().tick()
    assert [call["job_id"] for call in explicit_ops(env, "cancel")] == [JOB1]


def test_a_back_card_says_how_long_the_stage_failed_not_its_hold(env, monkeypatch):
    import re

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.portal().tick()
    real = Outbox.pump

    def broken(self, *, reconcile_only=False):
        if not reconcile_only:
            raise RuntimeError("synthetic")
        return real(self, reconcile_only=True)

    monkeypatch.setattr(Outbox, "pump", broken)
    started = env.clock.now + 10
    for _ in range(12):  # two minutes
        env.clock.advance(10)
        env.portal().tick()
    failed_for = env.clock.now - started
    monkeypatch.setattr(Outbox, "pump", real)
    for _ in range(15):
        env.clock.advance(100)
        env.portal().tick()
    back = next(call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ✓ Sending back"))
    spell = re.search(r"it failed for (?:under (\d+)m|(\d+)m–(\d+)m)", back)
    low, high = (0, int(spell.group(1))) if spell.group(1) else (int(spell.group(2)), int(spell.group(3)))
    # A range that holds the real two minutes, not the fifteen-minute hold on top.
    assert low * 60 <= failed_for <= high * 60 and high <= 7, back


def test_a_back_card_waits_the_whole_hold_and_bounds_how_long_the_stage_failed(env, monkeypatch):
    import re
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.portal().tick()
    real, failing = portal_module.Portal._outage_report, [True]

    def flaky(self):
        if failing[0]:
            raise RuntimeError("synthetic")
        return real(self)

    monkeypatch.setattr(portal_module.Portal, "_outage_report", flaky)
    started = env.clock.now + 10
    for _ in range(54):  # about nine minutes, failing every tick of an otherwise idle Mac
        env.clock.advance(10)
        env.portal().tick()
    last_failure, failing[0] = env.clock.now, False
    for _ in range(150):
        env.clock.advance(10)
        env.portal().tick()
    back = next(part for part in state(env)["outbox"] if part["group"].startswith("sys:back:outage"))
    assert back["created_at"] - last_failure >= 900
    low, high = map(int, re.search(r"it failed for (\d+)m–(\d+)m", back["text"]).groups())
    assert low * 60 <= last_failure - started <= high * 60


# Round 7 review, pass 3.


def test_a_back_card_range_holds_a_stage_that_failed_twice_minutes_apart(env, monkeypatch):
    import re
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.portal().tick()
    real, ticks, fails = portal_module.Portal._outage_report, [0], []

    def twice(self):
        ticks[0] += 1
        if ticks[0] in (1, 17, 33):  # three separate failures, 320 s from first to last
            fails.append(self.clock())
            raise RuntimeError("synthetic")
        return real(self)

    monkeypatch.setattr(portal_module.Portal, "_outage_report", twice)
    for _ in range(200):
        env.clock.advance(10)
        env.portal().tick()
    back = next(part["text"] for part in state(env)["outbox"] if part["group"].startswith("sys:back:outage"))
    low, high = map(int, re.search(r"it failed for (\d+)m–(\d+)m", back).groups())
    assert low * 60 <= fails[-1] - fails[0] <= high * 60, back


# Round 8: a Stop the owner resends is his; one pick rule for every path; failure cards that
# tell a real streak (or a flaky stage) once and say when it ends; agent posts read deny by default.


def waiting_approval(env):
    return next(value for conversation in state(env)["conversations"].values()
                for value in conversation["approvals"].values())


def run_until(env, moment, step=30):
    while env.clock.now + step < moment:
        env.clock.advance(step)
        env.portal().tick()
    env.clock.now = moment
    env.portal().tick()


@pytest.mark.parametrize("again", ["2", "RAPP 2"])
def test_a_stop_sent_again_under_the_card_that_told_of_the_approval_stops(env, again):
    second_task_waiting(env)
    env.clock.advance(10)
    env.source.events.append(message(10, again))
    env.portal().tick()
    shown = env.native.calls[-1]["text"]
    assert not explicit_ops(env, "cancel")
    assert shown.startswith("[RAPP 0001] ● Not stopped\n")
    assert "Send 2 again to stop 0001; to cancel 0002, swipe-reply 2 on its card." in shown
    env.clock.advance(10)
    env.source.events.append(message(11, again))  # right under that card, having read it
    env.portal().tick()
    assert [call["job_id"] for call in explicit_ops(env, "cancel")] == [JOB1]


@pytest.mark.parametrize("stop", ["2", "RAPP 2"])
def test_an_approval_that_lapsed_a_while_ago_no_longer_holds_a_stop(env, stop):
    from rapp_bubbles.portal import LAPSE_SHADOW

    second_task_waiting(env)
    # The runtime never reported it expired, so it is still on record (until the hourly cleanup).
    run_until(env, waiting_approval(env)["expires_at"] + LAPSE_SHADOW + 5)
    env.source.events.append(message(20, stop))
    env.portal().tick()
    assert [call["job_id"] for call in explicit_ops(env, "cancel")] == [JOB1]


def test_a_stop_just_after_an_approval_lapsed_says_so_and_runs_when_sent_again(env):
    second_task_waiting(env)
    run_until(env, waiting_approval(env)["expires_at"] + 30)
    env.source.events.append(message(20, "RAPP 2"))
    env.portal().tick()
    shown = env.native.calls[-1]["text"]
    assert not explicit_ops(env, "cancel")
    assert "Task 0002's approval just lapsed, so nothing stopped. Send 2 again to stop 0001." in shown
    env.clock.advance(10)
    env.source.events.append(message(21, "RAPP 2"))
    env.portal().tick()
    assert [call["job_id"] for call in explicit_ops(env, "cancel")] == [JOB1]


def test_cards_names_the_approval_not_a_race_for_a_stop_both_would_hold(env):
    from rapp_bubbles import cards

    line = timeline(env)
    line.direct_target = lambda chat: {"chat_id": 1, "chat_guid": chat, "is_group": False}
    running_on_timeline(env, line)
    env.clock.advance(10)
    line.say("RAPP another task")
    env.portal().tick()
    until_heartbeat(env)  # task 1's heartbeat has just landed: a race, and task 2's approval waits
    config = env.config()
    with Store(config.state_dir) as store:
        rapp_n = cards.describe(config, store, clock=env.clock, source=line)["rapp_n"]
    assert rapp_n["options"][1] == {"n": 2, "blocked": "approval", "waiting": ["0002"]}
    assert rapp_n["blocked"] == "approval" and "ready_in" not in rapp_n
    line.say("RAPP 2")
    env.portal().tick()
    assert not explicit_ops(env, "cancel") and "Task 0002's approval is waiting" in env.native.calls[-1]["text"]


def test_following_is_the_one_rule_for_a_task_cards_live_menu(env):
    assert Portal._following({"state": "queued", "started_at": 1})
    assert Portal._following({"state": "cancelling", "started_at": 1})
    assert not Portal._following({"state": "running"})  # never shown as started
    assert not Portal._following({"state": "pending_approval", "started_at": 1})
    assert not Portal._following({"state": "running", "started_at": 1, "final_queued": True})
    approved_running_job(env)
    env.runtime.jobs[JOB1]["status"] = "paused"  # not ended, but not a state the card follows
    with Store(env.config().state_dir) as store:
        store.data["jobs"][JOB1]["state"] = "paused"
        store.save()
    env.clock.advance(10)
    env.source.events.append(message(3, "2"))  # under its running card
    env.portal().tick()
    assert not explicit_ops(env, "cancel")
    assert "next ~" not in env.native.calls[-1]["text"]


def outage_failing_at(monkeypatch, failing):
    from rapp_bubbles import portal as portal_module

    real, ticks = portal_module.Portal._outage_report, [0]

    def sometimes(self):
        ticks[0] += 1
        if failing(ticks[0]):
            raise RuntimeError("synthetic")
        return real(self)

    monkeypatch.setattr(portal_module.Portal, "_outage_report", sometimes)


def test_two_failures_on_their_own_tell_nothing(env, monkeypatch):
    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.portal().tick()
    outage_failing_at(monkeypatch, lambda tick: tick in (1, 62))  # 610 s apart, working in between
    for _ in range(200):
        env.clock.advance(10)
        env.portal().tick()
    assert not [call for call in env.native.calls if call["text"].startswith("[RAPP sys]")]
    assert not state(env).get("stages")
    assert [item["code"] for item in state(env)["errors"]] == ["internal:outage:RuntimeError"]


def test_a_stage_failing_now_and_then_is_told_as_flaky_and_how_often(env, monkeypatch):
    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.portal().tick()
    outage_failing_at(monkeypatch, lambda tick: tick in (1, 31, 61))  # three runs, 300 s apart
    for _ in range(62):
        env.clock.advance(10)
        env.portal().tick()
    flaky = [call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ! Outage flaky")]
    assert len(flaky) == 1
    assert "now and then, outage reports are paused" in flaky[0] and "failed 3 times in 10m" in flaky[0]


def test_a_damaged_tick_failure_record_never_stops_the_ticks(env, monkeypatch):
    from rapp_bubbles import cli

    owner_target(env)
    env.portal().tick()
    config = env.config()
    record = config.state_dir / "tick-failure.json"
    record.write_text(json.dumps({"first": "soon", "last": "later", "count": "many", "code": 7}))
    monkeypatch.setattr(cli.time, "time", env.clock)
    cli.record_tick_failure(config, OSError(errno.EIO, "synthetic"))  # a failure on top of it
    written = json.loads(record.read_text())
    assert written["count"] == 2 and isinstance(written["first"], float)
    record.write_text(json.dumps({"first": None, "last": "nan", "count": [], "code": ""}))
    for _ in range(3):
        env.clock.advance(400)
        assert env.portal().tick()["ok"]
    assert not record.exists()


def test_ticks_failing_now_and_then_are_one_incident_that_backs_off_and_ends(env, monkeypatch):
    import re
    from rapp_bubbles import cli

    owner_target(env)
    env.portal().tick()
    config = env.config()
    monkeypatch.setattr(cli.time, "time", env.clock)
    for n in range(8 * 60):  # eight hours, a tick a minute; one in five fails, healing on the next
        env.clock.advance(60)
        if n % 5 == 0:
            cli.record_tick_failure(config, OSError(errno.EIO, "synthetic"))
            continue
        env.portal().tick()
    failing = [call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ! Ticks failing")]
    assert len(failing) == 2  # told once, then again only after six hours, with the total so far
    assert int(re.search(r"(\d+) ticks failed", failing[1]).group(1)) > 60
    for _ in range(20):
        env.clock.advance(60)
        env.portal().tick()
    back = [call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ✓ Ticks back")]
    assert len(back) == 1 and "96 ticks failed over 7h" in back[0]
    assert not state(env).get("tick_alerts")


def test_ticks_failing_counts_every_failure_toward_its_card(env, monkeypatch):
    from rapp_bubbles import cli

    owner_target(env)
    env.portal().tick()
    config = env.config()
    monkeypatch.setattr(cli.time, "time", env.clock)

    def fail_then_merge(failures):
        for _ in range(failures):
            env.clock.advance(20)
            cli.record_tick_failure(config, OSError(errno.EIO, "synthetic"))
        for _ in range(11):  # good ticks a minute apart, until one saves the record
            env.clock.advance(60)
            env.portal().tick()
        assert not (config.state_dir / "tick-failure.json").exists()
        return [call for call in env.native.calls if call["text"].startswith("[RAPP sys] ! Ticks failing")]

    assert not fail_then_merge(2)  # two failed ticks are not an incident to tell yet
    told = fail_then_merge(1)  # a third, in a later record, is
    assert len(told) == 1 and "3 ticks failed" in told[0]["text"]


def test_a_gap_on_a_critical_disk_is_one_card(env, monkeypatch):
    owner_target(env)
    free = {"bytes": 50 * 2**30}
    full_disk(monkeypatch, free)
    env.portal().tick()
    free["bytes"] = 1 * 2**30  # the disk filled while ticks stopped
    env.clock.advance(900)
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    lines = [call["text"].split("\n", 1)[0] for call in env.native.calls if call["text"].startswith("[RAPP sys]")]
    assert lines == ["[RAPP sys] ! Back, disk full"]
    back = next(call["text"] for call in env.native.calls if call["text"].startswith("[RAPP sys] ! Back"))
    assert "1.0 GB free · new tasks paused until space frees" in back
    assert state(env)["resources"]["level"] == "critical"


def test_transport_status_shows_stages_tick_failures_and_the_heartbeat(env, monkeypatch):
    from rapp_bubbles import cli

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.portal().tick()
    outage_failing_at(monkeypatch, lambda tick: tick == 1)
    env.clock.advance(10)
    env.portal().tick()
    config = env.config()
    monkeypatch.setattr(cli.time, "time", env.clock)
    cli.record_tick_failure(config, OSError(errno.ENOSPC, "No space left on device"))
    with Store(config.state_dir) as store:
        status = cli.status_command(config, store)
    stage = status["stages"]["outage"]
    assert stage["told"] is False and stage["kind"] is None and stage["back_after"] == stage["last"] + 900
    assert status["tick_failure"]["pending"]["count"] == 1 and status["tick_failure"]["pending"]["errno"] == errno.ENOSPC
    assert isinstance(status["heartbeat_age_s"], float) and status["tick_incidents"] == {}


def test_a_told_stage_writes_the_journal_at_most_every_five_minutes(env, monkeypatch):
    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.portal().tick()
    outage_failing_at(monkeypatch, lambda tick: True)
    for _ in range(8):
        env.clock.advance(10)
        env.portal().tick()
    assert state(env)["stages"]["outage"]["told"]
    for _ in range(6):  # let the stuck card go out and its receipt settle
        env.clock.advance(10)
        env.portal().tick()
    journal = Path(env.raw["state_dir"]) / "transport.json"
    writes, mark = 0, (journal.stat().st_ino, journal.stat().st_mtime_ns)
    for _ in range(30):  # five more minutes of the same failure
        env.clock.advance(10)
        env.portal().tick()
        wrote, mark = journal_writes(journal, mark)
        writes += wrote
    assert writes <= 2


def test_failure_code_names_a_sqlite_error_raised_while_handling_another(tmp_path):
    from rapp_bubbles import cli

    path = tmp_path / "locked.db"
    holder = sqlite3.connect(path, timeout=0)
    holder.execute("CREATE TABLE t(x)")
    holder.commit()
    holder.execute("BEGIN EXCLUSIVE")
    other = sqlite3.connect(path, timeout=0)
    try:
        try:
            other.execute("SELECT * FROM t").fetchall()
        except sqlite3.Error:
            raise PortalError("messages_unavailable", "Messages history is unavailable.")  # no "from"
    except PortalError as error:
        caught = error
    finally:
        other.close()
        holder.rollback()
        holder.close()
    assert caught.__cause__ is None and cli.failure_code(caught) == "sqlite_busy"


@pytest.mark.parametrize("drawn", ["[2] Hold", "1) Ship 2) Hold", "2\ufe0f\u20e3 Hold", "\u3164\u3164[2] Hold",
                                   "\uffa02. Hold", "Reply 1 to ship or 2 to hold", "\u202edloH .2"])
def test_an_agent_post_whose_first_line_draws_numbers_interrupts_rapp_n(env, drawn):
    line = timeline(env)
    running_on_timeline(env, line)
    env.clock.advance(10)
    feed_post(env, text=drawn, options=0)
    env.portal().tick()
    env.clock.advance(10)
    line.say("RAPP 2")
    env.portal().tick()
    assert not explicit_ops(env, "cancel")
    assert FOREIGN_LINE in env.native.calls[-1]["text"]


def test_an_agent_post_with_a_picture_interrupts_rapp_n(env):
    line = timeline(env)
    running_on_timeline(env, line)
    picture = env.root / "board.png"
    picture.write_bytes(b"synthetic picture of a numbered board")
    env.clock.advance(10)
    post_id = feed_post(env, text="Board", file=str(picture), options=0)
    env.portal().tick()
    with Store(env.config().state_dir) as store:
        # Its receipt found the picture's own row, as chat.db's attachment match does.
        part = next(item for item in store.data["outbox"] if item["group"] == f"feed:{post_id}")
        part["guid"] = part["caption_guid"].replace("CAPTION-", "OUTGOING-")
        store.save()
    env.clock.advance(10)
    line.say("RAPP 2")
    env.portal().tick()
    assert not explicit_ops(env, "cancel")


def test_an_agent_post_without_numbers_leaves_rapp_n_on_our_card(env):
    line = timeline(env)
    running_on_timeline(env, line)
    env.clock.advance(10)
    feed_post(env, text="Build 42 passed on R8 (40676fe).", options=0, channel="ci-2")
    env.portal().tick()
    env.clock.advance(10)
    line.say("RAPP 2")
    env.portal().tick()
    assert [call["job_id"] for call in explicit_ops(env, "cancel")] == [JOB1]


def test_numbers_are_read_the_way_a_phone_draws_them():
    from rapp_bubbles import itui

    for text in ("\u3164[2] Hold", "\uffa02. Hold", "\u202edloH .2", "\u2067\u05d0 2\u2069", "\u33e0 Hold",
                 "_1_ Hold"):
        assert itui.draws_numbers(text), text
    for text in ("Reply 1 to ship or 2 to hold", "Pick 2", "5/8 agents in", "v1.2 is out", "2\ufe0f\u20e3"):
        assert itui.names_numbers(text), text
    for text in ("Build 42 passed.", "R8 ships 40676fe", "No numbers here"):
        assert not itui.names_numbers(text) and not itui.draws_numbers(text), text
    assert itui.names_numbers("Loop 01") and not itui.draws_numbers("Loop 01")  # a zero-padded 1 is a 1


def test_an_update_without_options_never_lapses(env):
    timeline(env)
    post_id = feed_post(env, text="Status only", options=0, ttl=60)
    env.portal().tick()
    part = next(item for item in state(env)["outbox"] if item["group"] == f"feed:{post_id}")
    env.native.states[part["guid"]] = "pending"  # its receipt never confirms
    for _ in range(40):
        env.clock.advance(30)
        env.portal().tick()
    item = state(env)["feed"][post_id]
    assert item["state"] == "pending" and not item.get("lapsed")


def test_an_update_lapses_the_grace_and_its_window_after_its_first_send(env):
    from rapp_bubbles.feed import PENDING_GRACE

    timeline(env)
    post_id = feed_post(env, ttl=60)
    env.portal().tick()
    part = next(item for item in state(env)["outbox"] if item["group"] == f"feed:{post_id}")
    env.native.states[part["guid"]] = "pending"
    sent = part["submitted_at"]
    run_until(env, sent + PENDING_GRACE + 60 - 1)
    assert state(env)["feed"][post_id]["state"] == "pending"
    run_until(env, sent + PENDING_GRACE + 60 + 1, step=1)
    item = state(env)["feed"][post_id]
    assert item["state"] == "expired" and item["lapsed"] and item["sent_at"] == sent


def test_a_lapsed_updates_unsent_bubble_never_goes_out(env):
    from rapp_bubbles.feed import PENDING_GRACE

    timeline(env)
    post_id = feed_post(env, ttl=60)
    env.portal().tick()
    part = next(item for item in state(env)["outbox"] if item["group"] == f"feed:{post_id}")
    env.native.states[part["guid"]] = "pending"
    run_until(env, part["submitted_at"] + PENDING_GRACE + 60 - 5)
    with Store(env.config().state_dir) as store:
        mine = next(item for item in store.data["outbox"] if item["group"] == f"feed:{post_id}")
        mine["state"] = "queued"  # waiting to be sent again
        store.save()
    sends = len(env.native.calls)
    env.clock.advance(10)
    env.portal().tick()
    assert state(env)["feed"][post_id]["state"] == "expired"
    assert not [item for item in state(env)["outbox"] if item["group"] == f"feed:{post_id}"]
    assert len(env.native.calls) == sends


@pytest.mark.parametrize(("pick", "stop"), [("1", False), ("2", True)])
def test_a_running_cards_pick_that_broke_names_a_stop_only_when_it_was_one(env, monkeypatch, pick, stop):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    approved_running_job(env)

    def fragile(*_args, **_kwargs):
        raise KeyError("synthetic")

    monkeypatch.setattr(portal_module.Portal, "_job_for_actor", fragile)
    env.clock.advance(10)
    env.source.events.append(message(3, pick))
    env.portal().tick()
    shown = env.native.calls[-1]["text"]
    assert "An internal error stopped it, so nothing ran." in shown
    assert shown.startswith("[RAPP 0001] ● Not stopped\n") == stop


def test_a_tick_failure_record_read_again_after_a_crash_is_counted_once(env, monkeypatch):
    from rapp_bubbles import cli

    owner_target(env)
    env.portal().tick()
    config = env.config()
    monkeypatch.setattr(cli.time, "time", env.clock)
    record = config.state_dir / "tick-failure.json"
    for _ in range(3):
        env.clock.advance(20)
        cli.record_tick_failure(config, OSError(errno.EIO, "synthetic"))
    kept = record.read_text()
    env.clock.advance(600)
    env.portal().tick()
    assert not record.exists()
    record.write_text(kept)  # as if that tick died after its save, before removing the record
    env.clock.advance(60)
    env.portal().tick()
    assert state(env)["tick_alerts"]["transport_internal_error"]["count"] == 3
    record.write_text(kept)
    env.clock.advance(20)
    cli.record_tick_failure(config, OSError(errno.EIO, "synthetic"))  # one more, on that same record
    env.clock.advance(60)
    env.portal().tick()
    assert state(env)["tick_alerts"]["transport_internal_error"]["count"] == 4


# Round 8 review, pass 1.


def second_task_on_timeline(env):
    line = timeline(env)
    line.direct_target = lambda chat: {"chat_id": 1, "chat_guid": chat, "is_group": False}
    running_on_timeline(env, line)
    env.clock.advance(10)
    line.say("RAPP another task")
    env.portal().tick()
    env.clock.advance(10)
    env.portal().tick()
    until_heartbeat(env)
    return line


@pytest.mark.parametrize("again", ["2", "RAPP 2"])
def test_a_stop_sent_again_before_the_card_that_told_could_be_read_still_waits(env, again):
    line = second_task_on_timeline(env)
    env.clock.advance(10)
    line.say(again)  # meant for task 2's Cancel
    env.portal().tick()
    assert env.native.calls[-1]["text"].startswith("[RAPP 0001] ● Not stopped\n")
    told = next(part for part in state(env)["outbox"] if part.get("told_approvals"))
    landed = max(told.get("submitted_at") or 0, told.get("sent_at") or 0)
    env.clock.now = landed + 1
    line.say(again)  # typed a second after that card left the Mac: not read yet
    env.portal().tick()
    assert not explicit_ops(env, "cancel")
    env.clock.advance(10)
    line.say(again)  # sent again once it could have been read
    env.portal().tick()
    assert [call["job_id"] for call in explicit_ops(env, "cancel")] == [JOB1]


def test_a_pick_whose_card_cannot_be_shown_again_is_still_set_aside(env, monkeypatch):
    from rapp_bubbles import portal as portal_module

    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    approved_running_job(env)

    def broken(*_args, **_kwargs):
        raise KeyError("synthetic card bug")

    monkeypatch.setattr(portal_module.Portal, "_job_card", broken)
    env.clock.advance(10)
    env.source.events.append(message(3, "1"))  # Details, right under the running card
    for _ in range(4):
        assert env.portal().tick()["ok"]
        env.clock.advance(10)
    assert len([call for call in env.native.calls if "was set aside after an internal error" in call["text"]]) == 1


def test_a_flaky_sender_is_told_while_it_can_still_send(env, monkeypatch):
    monkeypatch.delenv("RAPP_BUBBLES_STRICT")
    owner_target(env)
    env.portal().tick()
    real, ticks = Outbox.pump, [0]

    def sometimes(self, *, reconcile_only=False):
        if not reconcile_only:
            ticks[0] += 1
            if ticks[0] in (1, 31, 61):
                raise RuntimeError("synthetic")
        return real(self, reconcile_only=reconcile_only)

    monkeypatch.setattr(Outbox, "pump", sometimes)
    for _ in range(70):
        env.clock.advance(10)
        env.portal().tick()
    assert [call["text"].split("\n", 1)[0] for call in env.native.calls
            if call["text"].startswith("[RAPP sys]")] == ["[RAPP sys] ! Sending flaky"]


# Round 8 review, pass 2.


@pytest.mark.parametrize("text", ["Pick one:\n_1_ Ship it\n_2_ Hold", "Pick one:\n1st: ship it\n2nd: hold",
                                  "_2_ Hold", "\u33e1 Hold", "Pick 1st or 2nd", "Pick one:\n10. Ten"])
def test_an_agent_post_offering_a_number_in_any_word_interrupts_rapp_n(env, text):
    line = timeline(env)
    running_on_timeline(env, line)
    env.clock.advance(10)
    feed_post(env, text=text, options=0)
    env.portal().tick()
    env.clock.advance(10)
    line.say("RAPP 2")  # meant for the agent's second option
    env.portal().tick()
    assert not explicit_ops(env, "cancel")


def test_a_number_that_starts_a_word_is_named_and_one_inside_a_word_is_not():
    from rapp_bubbles import itui

    for text in ("1st: ship", "Pick 2nd", "_2_ Hold", "\u33e1 Hold", "2FA on", "x (3)", "\u00b2 more"):
        assert itui.names_numbers(text), text
    for text in ("R8 ships", "Build 42", "v10 out", "No numbers", "ref 64707a", "0 left"):
        assert not itui.names_numbers(text), text


# Round 8 review, pass 3.


@pytest.mark.parametrize("text", ["Pick one:\n01. Ship it\n02. Hold", "Pick \u21161 or \u21162", "Pick 01 or 02",
                                  "Option \u2160 or \u2161"])
def test_an_agent_post_numbering_its_choices_another_way_interrupts_rapp_n(env, text):
    line = timeline(env)
    running_on_timeline(env, line)
    env.clock.advance(10)
    feed_post(env, text=text, options=0)
    env.portal().tick()
    env.clock.advance(10)
    line.say("RAPP 2")  # meant for the agent's second choice
    env.portal().tick()
    assert not explicit_ops(env, "cancel")


def test_zero_padded_and_roman_numbers_are_read_as_numbers():
    from rapp_bubbles import itui

    for text in ("01. Ship", "Pick one:\n02. Hold", "\u2161 Hold"):
        assert itui.draws_numbers(text), text
    for text in ("0. Cancel", "0x1F", "Loop 01"):
        assert not itui.draws_numbers(text), text
    for text in ("Pick \u21162", "Pick 02", "Option \u2161"):
        assert itui.names_numbers(text), text


# Round 8 review, pass 4.


@pytest.mark.parametrize("text", ["Pick N\u00ba1 or N\u00ba2", "Pick n\u00ba1 or n\u00ba2", "Pick N\u00aa2", "Pick N\u1d522"])
def test_an_agent_post_numbering_with_an_ordinal_numero_interrupts_rapp_n(env, text):
    from rapp_bubbles import itui

    assert itui.names_numbers(text)
    line = timeline(env)
    running_on_timeline(env, line)
    env.clock.advance(10)
    feed_post(env, text=text, options=0)
    env.portal().tick()
    env.clock.advance(10)
    line.say("RAPP 2")
    env.portal().tick()
    assert not explicit_ops(env, "cancel")


# Round 8 review, pass 5.


@pytest.mark.parametrize("text", ["\u9078\u629e\u80a2\u306f1\u304b2\u3067\u3059", "\u7b2c1\u6848\u304b\u7b2c2\u6848",
                                  "\u9009\u98791\u6216\u9009\u98792", "\uc81c1\uc548 \ub610\ub294 \uc81c2\uc548",
                                  "\u0e02\u0e49\u0e2d1\u0e2b\u0e23\u0e37\u0e2d\u0e02\u0e49\u0e2d2"])
def test_an_agent_post_offering_numbers_in_a_script_without_spaces_interrupts_rapp_n(env, text):
    from rapp_bubbles import itui

    assert itui.names_numbers(text)
    line = timeline(env)
    running_on_timeline(env, line)
    env.clock.advance(10)
    feed_post(env, text=text, options=0)
    env.portal().tick()
    env.clock.advance(10)
    line.say("RAPP 2")
    env.portal().tick()
    assert not explicit_ops(env, "cancel")


def test_only_a_latin_letter_or_digit_glues_a_number_into_a_word():
    from rapp_bubbles import itui

    for text in ("R8 ships", "v10 out", "Build 42", "ref 64707a", "\uff32\uff18 ships"):  # fullwidth R8 is R8
        assert not itui.names_numbers(text), text
