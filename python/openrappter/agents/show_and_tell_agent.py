"""Learn a reusable skill or automation from a local demonstration."""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from openrappter.agents.basic_agent import BasicAgent

try:
    from openrappter.flight_recorder import ensure_flight_recorder_from_env
    from openrappter.show_and_tell import (
        ShowAndTellStore,
        _write_private_text,
        analyze_session,
        assert_context_capture_available,
        build_artifacts,
        capture_explicit_frame,
        is_private_context,
        privacy_reduced_url,
        read_active_context,
        replay_plan,
        revise_analysis,
        show_and_tell_root,
        spawn_collector,
        test_artifacts,
    )
    from openrappter.show_and_tell_skill import (
        build_session_bundle,
        build_skill_plan,
        revise_plan,
    )
    from openrappter.show_and_tell_marketplace import write_marketplace_export
    SHOW_AND_TELL_AVAILABLE = True
except ModuleNotFoundError:
    # Brainstem/RAR loaders intentionally execute one agent file with only the
    # BasicAgent contract available. Keep metadata discoverable and fail closed
    # at invocation instead of making the entire agent sweep fail.
    SHOW_AND_TELL_AVAILABLE = False
    ShowAndTellStore = None

    def _unavailable(*_args, **_kwargs):
        raise RuntimeError(
            "Show-and-Tell requires the full OpenRappter runtime package."
        )

    analyze_session = _unavailable
    assert_context_capture_available = _unavailable
    build_artifacts = _unavailable
    build_session_bundle = _unavailable
    build_skill_plan = _unavailable
    capture_explicit_frame = _unavailable
    is_private_context = _unavailable
    privacy_reduced_url = _unavailable
    read_active_context = _unavailable
    replay_plan = _unavailable
    revise_analysis = _unavailable
    revise_plan = _unavailable
    show_and_tell_root = _unavailable
    spawn_collector = _unavailable
    test_artifacts = _unavailable
    write_marketplace_export = _unavailable
    _write_private_text = _unavailable
    ensure_flight_recorder_from_env = _unavailable


__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@openrappter/show-and-tell",
    "version": "1.0.0",
    "display_name": "Show and Tell",
    "description": (
        "Records a demonstrated workflow, reconstructs its intent and steps, "
        "and builds a reusable skill or automation."
    ),
    "author": "Kody Wildfeuer",
    "ring": "ga",
    "capabilities": [],
    "tags": ["openrappter", "show-and-tell", "automation", "skills"],
    "category": "meta",
    "quality_tier": "official",
    "requires_env": [],
}


def _process_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


class ShowAndTellAgent(BasicAgent):
    def __init__(
        self,
        root: Optional[Path | str] = None,
        spawn: Callable[[Path, str], dict[str, Any]] = spawn_collector,
        capture: Callable[[Path, dict[str, Any]], None] = capture_explicit_frame,
        read_context: Callable[[], dict[str, Any]] = read_active_context,
        local_surface: Optional[bool] = None,
    ):
        self.name = "ShowAndTell"
        self.metadata = {
            "name": self.name,
            "description": (
                "Learns a reusable workflow from a local demonstration. Start "
                "through the interactive CLI, add notes or explicit screenshots, "
                "stop, analyze, approve, then build a SKILL.md or disabled automation."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "start",
                            "status",
                            "note",
                            "capture",
                            "observe",
                            "stop",
                            "analyze",
                            "review",
                            "bundle",
                            "propose",
                            "revise_plan",
                            "export",
                            "build",
                            "replay",
                            "test",
                            "list",
                            "delete",
                        ],
                        "description": "Show-and-Tell lifecycle action.",
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Session id; defaults to active or latest.",
                    },
                    "title": {"type": "string", "description": "Short title."},
                    "intent": {
                        "type": "string",
                        "description": "Demonstrated goal or edited intent.",
                    },
                    "note": {
                        "type": "string",
                        "description": "Narration explaining what and why.",
                    },
                    "detail": {
                        "type": "string",
                        "description": "Manual semantic step detail.",
                    },
                    "app": {"type": "string", "description": "Application involved."},
                    "url": {"type": "string", "description": "URL involved."},
                    "steps_json": {
                        "type": "string",
                        "description": "Edited step array as JSON.",
                    },
                    "values_json": {
                        "type": "string",
                        "description": "Edited plan value array as JSON.",
                    },
                    "plugin_name": {
                        "type": "string",
                        "description": "Marketplace plugin directory name for export.",
                    },
                    "skill_name": {
                        "type": "string",
                        "description": "Marketplace skill directory name for export.",
                    },
                    "feedback": {
                        "type": "string",
                        "description": "Review feedback.",
                    },
                    "approve": {
                        "type": "boolean",
                        "description": "Approve with a local consent token.",
                    },
                    "enhance": {
                        "type": "boolean",
                        "description": (
                            "Ask a connected model to refine the privacy-safe text "
                            "summary. The Python runtime currently provides the "
                            "deterministic baseline."
                        ),
                    },
                    "consent_token": {
                        "type": "string",
                        "description": "Short-lived token from the interactive CLI.",
                    },
                    "target": {
                        "type": "string",
                        "enum": ["skill", "automation", "all"],
                        "description": "Artifact target.",
                    },
                    "poll_interval_ms": {
                        "type": "integer",
                        "description": "Context poll interval.",
                    },
                    "max_duration_ms": {
                        "type": "integer",
                        "description": "Maximum recording duration.",
                    },
                    "query": {
                        "type": "string",
                        "description": "Natural-language fallback note or detail.",
                    },
                },
                "required": [],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)
        self._root = Path(root or show_and_tell_root()) if SHOW_AND_TELL_AVAILABLE else None
        self._stores = threading.local()
        self._spawn = spawn
        self._capture = capture
        self._read_context = read_context
        self.local_surface = (
            root is not None if local_surface is None else local_surface
        )
        self._check_capture = (
            assert_context_capture_available
            if spawn is spawn_collector
            else lambda: None
        )

    @property
    def store(self):
        if self._root is None or not SHOW_AND_TELL_AVAILABLE:
            return None
        store = getattr(self._stores, "store", None)
        if store is None:
            store = ShowAndTellStore(self._root)
            self._stores.store = store
        return store

    def perform(self, **kwargs):
        action = kwargs.get("action", "status")
        if (
            not self.local_surface
            and action not in {"status", "list"}
        ):
            return json.dumps(
                {
                    "status": "error",
                    "action": action,
                    "code": "local_surface_required",
                    "message": (
                        "Use the interactive Show-and-Tell CLI or Electron "
                        "DesktopControl surface for this action."
                    ),
                }
            )
        if not SHOW_AND_TELL_AVAILABLE or self.store is None:
            return json.dumps(
                {
                    "status": "error",
                    "action": action,
                    "message": (
                        "Show-and-Tell requires the full OpenRappter runtime package."
                    ),
                }
            )
        try:
            self.store.initialize()
            handlers = {
                "start": self._start,
                "status": self._status,
                "note": self._note,
                "capture": self._capture_action,
                "observe": self._observe,
                "stop": self._stop,
                "analyze": self._analyze,
                "review": self._review,
                "bundle": self._bundle,
                "propose": self._propose,
                "revise_plan": self._revise_plan,
                "export": self._export,
                "build": self._build,
                "replay": self._replay,
                "test": self._test,
                "list": self._list,
                "delete": self._delete,
            }
            handler = handlers.get(action)
            if not handler:
                return json.dumps(
                    {
                        "status": "error",
                        "action": action,
                        "message": f"Unknown Show-and-Tell action: {action}",
                    }
                )
            return json.dumps(handler(**kwargs))
        except Exception as exc:
            ensure_flight_recorder_from_env().record(
                {
                    "kind": "show-and-tell.failed",
                    "source": "show-and-tell",
                    "status": "error",
                    "agentName": self.name,
                    "metadata": {"action": action, "error": str(exc)},
                }
            )
            return json.dumps(
                {"status": "error", "action": action, "message": str(exc)}
            )

    def _start(self, **kwargs):
        if not self.store.consume_consent(kwargs.get("consent_token"), "start"):
            return {
                "status": "error",
                "action": "start",
                "code": "local_consent_required",
                "message": (
                    "Recording can start only through the interactive local "
                    "command `openrappter show-and-tell start`."
                ),
            }
        self._check_capture()
        session = self.store.create_session(
            title=kwargs.get("title", ""),
            intent_hint=kwargs.get("intent") or kwargs.get("query", ""),
            poll_interval_ms=kwargs.get("poll_interval_ms", 2_000),
            max_duration_ms=kwargs.get("max_duration_ms", 8 * 60 * 60 * 1000),
        )
        self.store.append_event(
            session["id"],
            "session.started",
            "show-and-tell",
            {"captureMode": "context", "screenshots": "explicit-only"},
        )
        try:
            collector = self._spawn(self.store.root, session["id"])
            if collector.get("verify", True) and not self._wait_for_collector(
                session["id"], collector["nonce"], 8
            ):
                self.store.finish_session(
                    session["id"],
                    "failed",
                    error="Collector process did not attach to the session.",
                )
                raise RuntimeError(
                    "Show-and-Tell collector did not start correctly."
                )
        except Exception as exc:
            self.store.finish_session(session["id"], "failed", error=str(exc))
            raise
        ensure_flight_recorder_from_env().record(
            {
                "kind": "show-and-tell.started",
                "source": "show-and-tell",
                "status": "success",
                "agentName": self.name,
                "metadata": {
                    "sessionId": session["id"],
                    "collectorPid": collector["pid"],
                },
            }
        )
        return {
            "status": "success",
            "action": "start",
            "session": session,
            "collector_pid": collector["pid"],
            "message": (
                "Show-and-Tell is recording app/window context. Use `show-and-tell note` "
                "while narrating and `show-and-tell capture` for explicit reference frames."
            ),
            "data_slush": {
                "source_agent": self.name,
                "session_id": session["id"],
                "recording": True,
            },
        }

    def _status(self, **kwargs):
        session = self._recover_session(kwargs.get("session_id"))
        if not session:
            return {
                "status": "success",
                "action": "status",
                "recording": False,
                "session": None,
            }
        events = self.store.events(session["id"])
        analysis = self.store.get_analysis(session["id"])
        artifacts = self.store.artifacts(session["id"])
        if not self.local_surface:
            return {
                "status": "success",
                "action": "status",
                "recording": session["state"] in {"recording", "stopping"},
                "session": {
                    "id": session["id"],
                    "state": session["state"],
                    "startedAt": session["startedAt"],
                    "stoppedAt": session["stoppedAt"],
                },
                "event_count": len(events),
                "analysis": (
                    {
                        "revision": analysis["revision"],
                        "approved": analysis["approved"],
                        "step_count": len(analysis["steps"]),
                    }
                    if analysis
                    else None
                ),
                "artifact_count": len(artifacts),
            }
        context_events = [
            event
            for event in events
            if event.get("type") == "app.activate"
        ]
        last_context_at = (
            context_events[-1]["timestamp"] if context_events else None
        )
        heartbeat_age = (
            int(time.time() * 1000) - session["collectorHeartbeatAt"]
            if session.get("collectorHeartbeatAt")
            else None
        )
        context_age = (
            int(time.time() * 1000) - last_context_at
            if last_context_at
            else None
        )
        return {
            "status": "success",
            "action": "status",
            "recording": session["state"] in {"recording", "stopping"},
            "session": session,
            "event_count": len(events),
            "analysis": (
                {
                    "revision": analysis["revision"],
                    "approved": analysis["approved"],
                    "step_count": len(analysis["steps"]),
                }
                if analysis
                else None
            ),
            "analysis_detail": analysis,
            "artifacts": artifacts,
            "collector_healthy": (
                session["state"] not in {"recording", "stopping"}
                or (
                    heartbeat_age is not None
                    and heartbeat_age
                    <= max(30_000, int(session["pollIntervalMs"]) * 5)
                )
            ),
            "heartbeat_age_ms": heartbeat_age,
            "context_age_ms": context_age,
        }

    def _note(self, **kwargs):
        session = self._require_recording(kwargs.get("session_id"))
        note = kwargs.get("note") or kwargs.get("query", "")
        if not isinstance(note, str) or not note.strip():
            raise ValueError("A Show-and-Tell note is required.")
        event = self.store.append_event(
            session["id"], "session.note", "user-narration", {"note": note}
        )
        return {
            "status": "success",
            "action": "note",
            "session_id": session["id"],
            "event": event,
        }

    def _observe(self, **kwargs):
        session = self._require_recording(kwargs.get("session_id"))
        detail = kwargs.get("detail") or kwargs.get("query", "")
        if not isinstance(detail, str) or not detail.strip():
            raise ValueError("A manual observation detail is required.")
        event = self.store.append_event(
            session["id"],
            "manual.observation",
            "user-observation",
            {
                "title": kwargs.get("title", ""),
                "detail": detail,
                "app": kwargs.get("app", ""),
                "url": privacy_reduced_url(kwargs.get("url")),
            },
        )
        return {
            "status": "success",
            "action": "observe",
            "session_id": session["id"],
            "event": event,
        }

    def _capture_action(self, **kwargs):
        if not self.store.consume_consent(
            kwargs.get("consent_token"), "capture"
        ):
            return {
                "status": "error",
                "action": "capture",
                "code": "local_capture_consent_required",
                "message": (
                    "Screenshot capture requires the interactive local command "
                    "`openrappter show-and-tell capture`."
                ),
            }
        session = self._require_recording(kwargs.get("session_id"))
        context = self._read_context()
        if context.get("privateContext") or is_private_context(
            context.get("app", ""),
            context.get("window", ""),
            context.get("url", ""),
        ):
            return {
                "status": "error",
                "action": "capture",
                "code": "private_context",
                "message": (
                    "The active window looks credential- or sign-in-related. "
                    "Show-and-Tell refused the screenshot."
                ),
            }
        import uuid

        filename = (
            f"frame-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}.png"
        )
        frame = self.store.frames_dir(session["id"]) / filename
        committed = False
        try:
            self._capture(frame, context)
            after = self._read_context()
            if after.get("privateContext") or is_private_context(
                after.get("app", ""),
                after.get("window", ""),
                after.get("url", ""),
            ):
                return {
                    "status": "error",
                    "action": "capture",
                    "code": "private_context",
                    "message": (
                        "The active window became credential- or sign-in-related "
                        "during capture, so the frame was deleted."
                    ),
                }
            if (
                after.get("app") != context.get("app")
                or after.get("window") != context.get("window")
                or (
                    context.get("windowId")
                    and after.get("windowId") != context.get("windowId")
                )
            ):
                return {
                    "status": "error",
                    "action": "capture",
                    "code": "window_changed",
                    "message": (
                        "The active window changed during capture, so the frame "
                        "was deleted."
                    ),
                }
            self.store.append_event(
                session["id"],
                "frame.captured",
                "explicit-capture",
                {
                    "file": f"frames/{filename}",
                    "label": kwargs.get("title") or kwargs.get("note", ""),
                    "app": context.get("app", ""),
                    "window": context.get("window", ""),
                },
            )
            committed = True
            return {
                "status": "success",
                "action": "capture",
                "session_id": session["id"],
                "captured": True,
                "label": kwargs.get("title") or kwargs.get("note", ""),
            }
        finally:
            if not committed:
                frame.unlink(missing_ok=True)

    def _stop(self, **kwargs):
        session = self._recover_session(kwargs.get("session_id"))
        if not session:
            raise RuntimeError("There is no Show-and-Tell session to stop.")
        if session["state"] in {"stopped", "failed"}:
            return {"status": "success", "action": "stop", "session": session}
        self.store.request_stop(session["id"])
        self.store.append_event(
            session["id"], "session.stop.requested", "show-and-tell", {}
        )
        deadline = time.monotonic() + 8
        final = None
        while time.monotonic() < deadline:
            final = self.store.get_session(session["id"])
            if not final or final["state"] in {"stopped", "failed"}:
                break
            time.sleep(0.1)
        if final and final["state"] not in {"stopped", "failed"}:
            final = self._recover_session(session["id"])
        if final and final["state"] not in {"stopped", "failed"}:
            return {
                "status": "error",
                "action": "stop",
                "code": "collector_stop_timeout",
                "session": self.store.get_session(session["id"]),
                "message": (
                    "The collector did not acknowledge shutdown. Its ownership "
                    "metadata was preserved; retry stop or inspect status."
                ),
            }
        if final and final["state"] == "failed":
            return {
                "status": "error",
                "action": "stop",
                "code": "collector_failed",
                "session": final,
                "message": final.get("lastError")
                or "The Show-and-Tell collector failed.",
            }
        self.store.append_event(
            session["id"], "session.stopped", "show-and-tell", {}
        )
        final = self.store.get_session(session["id"])
        ensure_flight_recorder_from_env().record(
            {
                "kind": "show-and-tell.stopped",
                "source": "show-and-tell",
                "status": "success",
                "agentName": self.name,
                "metadata": {"sessionId": session["id"]},
            }
        )
        return {
            "status": "success",
            "action": "stop",
            "session": final,
            "message": "Recording stopped. Analyze it next.",
            "data_slush": {
                "source_agent": self.name,
                "session_id": session["id"],
                "recording": False,
            },
        }

    def _recover_session(self, requested_id):
        self.store.recover_stale_sessions()
        session = self._resolve_session(requested_id)
        if (
            session
            and session["state"] in {"recording", "stopping"}
            and session.get("collectorPid")
            and not _process_is_alive(int(session["collectorPid"]))
        ):
            self.store.finish_session(
                session["id"],
                "failed",
                nonce=session.get("collectorNonce"),
                error="Collector process exited before the session was finalized.",
            )
            session = self.store.get_session(session["id"])
        return session

    def _analyze(self, **kwargs):
        session = self._require_completed(kwargs.get("session_id"))
        if kwargs.get("enhance") is True:
            if not self.store.consume_consent(
                kwargs.get("consent_token"), "analyze"
            ):
                return {
                    "status": "error",
                    "action": "analyze",
                    "code": "local_analysis_consent_required",
                    "message": (
                        "Model enhancement requires an interactive local consent "
                        "token."
                    ),
                }
            return {
                "status": "error",
                "action": "analyze",
                "code": "model_unavailable",
                "message": (
                    "The Python Show-and-Tell runtime currently provides deterministic "
                    "local analysis. Use the TypeScript CLI for optional Copilot enhancement."
                ),
            }
        analysis = analyze_session(self.store, session)
        ensure_flight_recorder_from_env().record(
            {
                "kind": "show-and-tell.analyzed",
                "source": "show-and-tell",
                "status": "success",
                "agentName": self.name,
                "metadata": {
                    "sessionId": session["id"],
                    "revision": analysis["revision"],
                    "enhanced": False,
                    "stepCount": len(analysis["steps"]),
                },
            }
        )
        return {
            "status": "success",
            "action": "analyze",
            "analysis": analysis,
            "enhanced": False,
        }

    def _review(self, **kwargs):
        session = self._require_completed(kwargs.get("session_id"))
        current = self.store.get_analysis(session["id"])
        if not current:
            raise RuntimeError(
                "Analyze the Show-and-Tell session before reviewing it."
            )
        if kwargs.get("approve") is True and not self.store.consume_consent(
            kwargs.get("consent_token"), "approve"
        ):
            return {
                "status": "error",
                "action": "review",
                "code": "local_approval_required",
                "message": (
                    "Approval requires the interactive local command "
                    "`openrappter show-and-tell approve`."
                ),
            }
        revised = revise_analysis(
            current,
            title=kwargs.get("title"),
            intent=kwargs.get("intent"),
            steps_json=kwargs.get("steps_json"),
            feedback=kwargs.get("feedback") or kwargs.get("query"),
            approve=kwargs.get("approve") is True,
        )
        self.store.save_analysis(revised)
        return {
            "status": "success",
            "action": "review",
            "analysis": revised,
            "message": (
                "Analysis approved. It can now build a skill or automation."
                if revised["approved"]
                else "Draft analysis updated but not approved."
            ),
        }

    def _build(self, **kwargs):
        session = self._require_completed(kwargs.get("session_id"))
        analysis = self.store.get_analysis(session["id"])
        if not analysis:
            raise RuntimeError("Analyze and approve the session before building.")
        plan = self.store.get_plan(session["id"])
        if plan is None and any(
            event["type"] == "plan.proposal.requested"
            for event in self.store.events(session["id"])
        ):
            return {
                "status": "error",
                "action": "build",
                "code": "plan_missing",
                "message": (
                    "A plan proposal was requested but its review record is missing. "
                    "Propose it again before building."
                ),
            }
        if plan is not None:
            # A proposed plan is the thing that gets approved. Falling back to
            # the analysis here would build text nobody reviewed as a plan.
            if not plan.get("approved"):
                return {
                    "status": "error",
                    "action": "build",
                    "code": "plan_not_approved",
                    "message": (
                        "Approve the proposed Show-and-Tell plan before building "
                        "from it."
                    ),
                }
            if plan.get("analysisRevision") != analysis.get("revision"):
                return {
                    "status": "error",
                    "action": "build",
                    "code": "plan_stale",
                    "message": (
                        "The analysis changed after this plan was approved. "
                        "Propose the plan again and approve the revision that "
                        "matches it."
                    ),
                }
        target = kwargs.get("target", "skill")
        dimension_offer = target == "rappid"
        artifacts = build_artifacts(
            self.store,
            analysis,
            "skill" if dimension_offer else target,
            plan=plan,
        )
        ensure_flight_recorder_from_env().record(
            {
                "kind": "show-and-tell.built",
                "source": "show-and-tell",
                "status": "success",
                "agentName": self.name,
                "metadata": {
                    "sessionId": session["id"],
                    "targets": [artifact["kind"] for artifact in artifacts],
                },
            }
        )
        result = {
            "status": "success",
            "action": "build",
            "session_id": session["id"],
            "artifacts": artifacts,
            "message": "Built " + " and ".join(a["kind"] for a in artifacts) + ".",
            "data_slush": {
                "source_agent": self.name,
                "session_id": session["id"],
                "artifact_paths": [artifact["path"] for artifact in artifacts],
            },
        }
        if dimension_offer:
            skill = next(
                (item for item in artifacts if item["kind"] == "skill"), artifacts[0]
            )
            # Offered, never attached: a RAPPID grows by an approved append
            # through the habitat, not by an agent deciding on its own.
            result["rappid_dimension"] = {
                "kind": "skill",
                "sessionId": session["id"],
                "name": skill["name"],
                "artifactPath": skill["path"],
                "contentHash": skill["contentHash"],
                "attached": False,
                "privacyScanned": True,
            }
        return result

    def _bundle(self, **kwargs):
        session = self._require_completed(kwargs.get("session_id"))
        bundle = build_session_bundle(session, self.store.events(session["id"]))
        return {
            "status": "success",
            "action": "bundle",
            "session_id": session["id"],
            "bundle": bundle,
            "message": (
                f"{bundle['stats']['segmentCount']} segment(s); "
                f"{bundle['stats']['silentEvents']} event(s) went unexplained."
            ),
        }

    def _propose(self, **kwargs):
        session = self._require_completed(kwargs.get("session_id"))
        analysis = self.store.get_analysis(session["id"])
        if not analysis:
            raise RuntimeError(
                "Analyze the Show-and-Tell session before proposing a plan."
            )
        self.store.append_event(
            session["id"],
            "plan.proposal.requested",
            "show-and-tell",
            {},
        )
        bundle = build_session_bundle(session, self.store.events(session["id"]))
        plan = build_skill_plan(
            analysis,
            bundle,
            previous=self.store.get_plan(session["id"]),
            now=int(time.time() * 1000),
        )
        self.store.save_plan(plan)
        return {
            "status": "success",
            "action": "propose",
            "session_id": session["id"],
            "plan": plan,
            # A proposal is a proposal: this turn writes no artifact at all.
            "proposal_only": True,
            "built": False,
            "message": (
                f"Proposed plan revision {plan['revision']} with "
                f"{len(plan['values'])} editable value(s). Nothing was built."
            ),
        }

    def _revise_plan(self, **kwargs):
        session = self._require_completed(kwargs.get("session_id"))
        plan = self.store.get_plan(session["id"])
        if not plan:
            raise RuntimeError("Propose a Show-and-Tell plan before revising it.")
        approve = kwargs.get("approve") is True
        if approve and not self.store.consume_consent(
            kwargs.get("consent_token"), "approve"
        ):
            return {
                "status": "error",
                "action": "revise_plan",
                "code": "local_approval_required",
                "message": (
                    "Approval requires the interactive local command "
                    "`openrappter show-and-tell approve`."
                ),
            }
        revised = revise_plan(
            plan,
            title=kwargs.get("title"),
            intent=kwargs.get("intent"),
            values_json=kwargs.get("values_json"),
            steps_json=kwargs.get("steps_json"),
            feedback=kwargs.get("feedback") or kwargs.get("query"),
            approve=approve,
            now=int(time.time() * 1000),
        )
        self.store.save_plan(revised)
        return {
            "status": "success",
            "action": "revise_plan",
            "session_id": session["id"],
            "plan": revised,
            "message": (
                "Plan approved. It can now build or export."
                if revised["approved"]
                else "Plan updated but not approved."
            ),
        }

    def _export(self, **kwargs):
        session = self._require_completed(kwargs.get("session_id"))
        plan = self.store.get_plan(session["id"])
        if not plan:
            raise RuntimeError("Propose a Show-and-Tell plan before exporting it.")
        if not plan.get("approved"):
            return {
                "status": "error",
                "action": "export",
                "code": "plan_not_approved",
                "message": "Approve the Show-and-Tell plan before exporting it.",
            }
        exported = write_marketplace_export(
            plan,
            lambda file, content: _write_private_text(Path(file), content),
            plugin_name=kwargs.get("plugin_name"),
            skill_name=kwargs.get("skill_name"),
        )
        artifact = self.store.record_artifact(
            session["id"],
            "marketplace",
            exported["pluginName"],
            Path(exported["marketplacePath"]),
            exported["contentHash"],
        )
        return {
            "status": "success",
            "action": "export",
            "session_id": session["id"],
            "marketplace": exported,
            "artifact": artifact,
            # Writing a local directory is not publishing it anywhere.
            "published": False,
            "message": (
                f"Exported {len(exported['files'])} file(s) to {exported['root']}. "
                "Nothing was published."
            ),
        }

    def _replay(self, **kwargs):
        session = self._require_completed(kwargs.get("session_id"))
        analysis = self.store.get_analysis(session["id"])
        if not analysis or not analysis.get("approved"):
            raise RuntimeError("Approve the analysis before previewing replay.")
        return {
            "status": "success",
            "action": "replay",
            "session_id": session["id"],
            "replay": replay_plan(analysis),
        }

    def _test(self, **kwargs):
        session = self._require_completed(kwargs.get("session_id"))
        result = test_artifacts(self.store, session["id"])
        return {
            "status": "success" if result["ok"] else "error",
            "action": "test",
            "session_id": session["id"],
            **result,
        }

    def _list(self, **_kwargs):
        sessions = self.store.list_sessions()
        return {
            "status": "success",
            "action": "list",
            "sessions": (
                sessions
                if self.local_surface
                else [
                    {
                        "id": session["id"],
                        "state": session["state"],
                        "startedAt": session["startedAt"],
                        "stoppedAt": session["stoppedAt"],
                    }
                    for session in sessions
                ]
            ),
            "count": len(sessions),
        }

    def _delete(self, **kwargs):
        if not self.store.consume_consent(kwargs.get("consent_token"), "delete"):
            return {
                "status": "error",
                "action": "delete",
                "code": "local_consent_required",
                "message": (
                    "Deletion requires the interactive local command "
                    "`openrappter show-and-tell delete`."
                ),
            }
        session = self._resolve_session(kwargs.get("session_id"))
        if not session:
            raise RuntimeError("Show-and-Tell session not found.")
        deleted = self.store.delete_session(session["id"])
        return {
            "status": "success",
            "action": "delete",
            "session_id": session["id"],
            "deleted": deleted,
        }

    def _resolve_session(self, session_id):
        if isinstance(session_id, str) and session_id.strip():
            return self.store.get_session(session_id.strip())
        return self.store.active_session() or self.store.latest_session()

    def _require_recording(self, session_id):
        session = self._resolve_session(session_id)
        if not session:
            raise RuntimeError("Start a Show-and-Tell session first.")
        if session["state"] != "recording":
            raise RuntimeError(
                f"Show-and-Tell session {session['id']} is {session['state']}."
            )
        return session

    def _require_completed(self, session_id):
        session = self._resolve_session(session_id)
        if not session:
            raise RuntimeError("Show-and-Tell session not found.")
        if session["state"] in {"recording", "stopping"}:
            raise RuntimeError(
                "Stop the Show-and-Tell recording before continuing."
            )
        return session

    def _wait_for_collector(self, session_id, nonce, timeout_seconds):
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            session = self.store.get_session(session_id)
            events = self.store.events(session_id)
            if (
                session
                and session.get("collectorNonce") == nonce
                and session.get("collectorPid") is not None
                and session.get("collectorHeartbeatAt") is not None
                and any(event.get("type") == "app.activate" for event in events)
            ):
                return True
            if not session or session.get("state") == "failed":
                return False
            time.sleep(0.1)
        return False
