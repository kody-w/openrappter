"""Synthetic only: run with --noconftest and a project-local --basetemp."""

import copy
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

from imessage_portal.clients import NativeClient, NotSubmitted, RuntimeClient, SubmissionUnknown
from imessage_portal.config import Config, PortalError, MAX_FILE_BYTES, roster_digest
from imessage_portal.files import copy_reference
from imessage_portal.outbox import Outbox
from imessage_portal.portal import Portal, addressed, HELP
from imessage_portal.source import SQLiteSource
from imessage_portal.state import Store


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

    def latest_prior_guid(self, event):
        return self.prior_guids.get(event["chat_guid"])

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
                "approval": {"token": "finite-" + job_id, "expires_at": self.clock() + 300},
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
         "import sys; sys.path.insert(0,sys.argv[1]); import imessage_portal.portal; "
         "assert not any('brainstem' in name or name.startswith('openrappter') for name in sys.modules)",
         str(SCRIPTS)], capture_output=True, text=True, timeout=10,
    )
    assert process.returncode == 0, process.stderr
    process = subprocess.run(
        [sys.executable, str(SCRIPTS / "imessage-portal.py"), "--help"],
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


def test_multiple_pending_tasks_disable_ambiguous_numeric_approval(env):
    env.source.events.extend([message(), message(2, "RAPP another task")])
    env.portal().tick()
    env.clock.advance(10)
    env.source.events.append(message(3, "1"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]
    assert any("approval_ambiguous" in call["text"] for call in env.native.calls)


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


def test_progress_notifications_are_bounded_without_fabricated_completion(env):
    env.source.events.append(message())
    env.portal().tick()
    env.runtime.jobs[JOB1]["status"] = "running"
    for _ in range(10):
        env.clock.advance(60)
        env.portal().tick()
    assert len(env.native.calls) <= 2
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
def test_foreign_outbound_sql_row_blocks_bare_selection_but_not_explicit_rapp(env, selection, operation):
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
    tick()
    assert not [call for call in env.runtime.calls if call["op"] in ("approve", "cancel")]
    assert any("approval_context_changed" in call["text"] for call in env.native.calls)
    insert_message(db, 5, f"RAPP {selection}")
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
            "created_at": datetime.fromtimestamp(env.clock() + 86400, timezone.utc).isoformat(),
        }]
        env.clock.advance(86400)
        outbox.pump()
        assert part["state"] == "unknown" and not part.get("guid")
        assert len([call for call in env.native.calls if call["file"]]) == 1
        env.native.messages = [original]
    with Store(env.config().state_dir) as store:
        outbox = Outbox(env.config(), store, env.native, env.clock, env.source.target_matches)
        env.clock.advance(10)
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


def test_an_intervening_ai_message_invalidates_bare_number_selection(env):
    env.source.events.append(message())
    env.portal().tick()
    env.clock.advance(10)
    env.source.prior_guids[CHAT] = "OTHER-AI-PROMPT"
    env.source.events.append(message(2, "1"))
    env.portal().tick()
    assert not [call for call in env.runtime.calls if call["op"] == "approve"]
    assert any("approval_context_changed" in call["text"] for call in env.native.calls)
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
