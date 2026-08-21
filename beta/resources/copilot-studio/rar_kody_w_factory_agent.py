"""RAPP to Copilot Studio Factory — compile selected agent.py files into one Draft.

This is the portable control-plane wrapper for CopilotStudioDeploy. It keeps
the selected local RAPP agents authoritative, preserves an existing Draft when
extending it, and exposes the build -> provision -> parity -> finalize process
as explicit resumable actions.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

try:
    from agents.basic_agent import BasicAgent
except ModuleNotFoundError:
    from basic_agent import BasicAgent


__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@kody-w/factory",
    "version": "1.0.4",
    "display_name": "RAPP to Copilot Studio Factory",
    "description": (
        "Turns any caller-selected group of local RAPP agent.py files into one "
        "provisioned, functionally parity-tested Copilot Studio Draft."
    ),
    "author": "kody-w",
    "tags": [
        "copilot_studio",
        "factory",
        "pipeline",
        "deployment",
        "parity",
    ],
    "category": "pipeline",
    "quality_tier": "community",
    "requires_env": [],
    "dependencies": [
        "@rapp/basic_agent",
        "@kody-w/copilot_studio_parity_deploy",
    ],
    "example_call": {
        "args": {
            "action": "plan",
            "agents": ["HackerNews", "Weatheragent"],
            "display_name": "News and Weather",
            "environment": "00000000-0000-0000-0000-000000000000",
            "publisher_prefix": "rapp",
        }
    },
}

BETA_DRAFT_ONLY = True


_DEPLOYER_MODULES = (
    "rar_kody_w_copilot_studio_parity_deploy_agent",
    "agents.rar_kody_w_copilot_studio_parity_deploy_agent",
    "copilot_studio_deploy_agent",
    "agents.copilot_studio_deploy_agent",
)


def _load_deployer():
    failures = []
    for module_name in _DEPLOYER_MODULES:
        try:
            module = importlib.import_module(module_name)
        except ModuleNotFoundError as error:
            failures.append(str(error))
            continue
        agent_class = getattr(module, "CopilotStudioDeployAgent", None)
        manifest = getattr(module, "__manifest__", {})
        if (
            agent_class is not None
            and manifest.get("name")
            == "@kody-w/copilot_studio_parity_deploy"
        ):
            return module, agent_class
    raise RuntimeError(
        "CopilotStudioDeployAgent is not installed. Install the declared "
        "@kody-w/copilot_studio_parity_deploy dependency. "
        + "; ".join(failures[-2:])
    )


def _parse_result(value):
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        raise RuntimeError("CopilotStudioDeploy returned a non-string result")
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            "CopilotStudioDeploy returned non-JSON output: " + value[:500]
        ) from error
    if not isinstance(parsed, dict):
        raise RuntimeError("CopilotStudioDeploy result must be a JSON object")
    return parsed


def _write_json(module, path: Path, value) -> None:
    writer = getattr(module, "_write_json", None)
    if writer is None:
        raise RuntimeError(
            "Installed CopilotStudioDeploy is too old for factory extensions"
        )
    writer(path, value)


class RappCopilotStudioFactoryAgent(BasicAgent):
    """Resumable factory around the generic Copilot Studio deploy engine."""

    def __init__(self):
        self.name = "RappCopilotStudioFactoryBeta"
        self.metadata = {
            "name": self.name,
            "display_name": __manifest__["display_name"],
            "description": __manifest__["description"],
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "doctor",
                            "plan",
                            "build",
                            "extend",
                            "provision",
                            "parity",
                            "finalize",
                            "verify",
                            "release_plan",
                            "status",
                        ],
                    },
                    "agents": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Tool names, class names, filenames, or paths for "
                            "the exact local agent.py files to compile."
                        ),
                    },
                    "display_name": {
                        "type": "string",
                        "description": "Copilot Studio display name.",
                    },
                    "environment": {
                        "type": "string",
                        "description": "Target Power Platform environment ID or URL.",
                    },
                    "publisher_prefix": {
                        "type": "string",
                        "description": "Caller-selected publisher prefix.",
                    },
                    "run_dir": {
                        "type": "string",
                        "description": "Existing factory run directory.",
                    },
                    "output_root": {
                        "type": "string",
                        "description": "Optional root for a new build.",
                    },
                    "infrastructure_manifest": {
                        "type": "string",
                        "description": "Optional manifest path under run_dir.",
                    },
                    "parity_cases": {
                        "type": "string",
                        "description": "Optional parity-case path under run_dir.",
                    },
                    "client_id": {
                        "type": "string",
                        "description": "Optional public-client ID for published parity.",
                    },
                    "dry_run": {
                        "type": "boolean",
                        "description": (
                            "For action=build, generate the complete manifest, "
                            "snapshots, and brief without initializing or pushing."
                        ),
                    },
                    "reuse_parity": {
                        "type": "boolean",
                        "description": (
                            "For action=finalize, reuse a live parity run from "
                            "the last 24 hours after full hash revalidation."
                        ),
                    },
                },
                "required": ["action"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def _call(self, action: str, **kwargs):
        _, agent_class = _load_deployer()
        payload = {"action": action, **kwargs}
        return _parse_result(agent_class().perform(**payload))

    def _extend(self, **kwargs):
        module, _ = _load_deployer()
        required_helpers = (
            "_resolve_agent_paths",
            "_build_manifest",
            "_snapshot_sources",
            "_brief_text",
            "_protected_identity",
            "_invoke_plugin_agent",
            "_materialize_skill_resources",
            "_validate_target_project",
            "_pac_pull_push",
            "_sha256",
            "_utc_now",
        )
        missing = [
            name for name in required_helpers
            if not hasattr(module, name)
        ]
        if missing:
            raise RuntimeError(
                "Installed CopilotStudioDeploy is too old for action=extend: "
                + ", ".join(missing)
            )

        run_dir_value = str(kwargs.get("run_dir") or "").strip()
        selectors = kwargs.get("agents")
        if not run_dir_value:
            raise ValueError("run_dir is required for action=extend")
        if not isinstance(selectors, list) or not selectors:
            raise ValueError("agents must contain the complete desired agent set")

        run_dir = Path(run_dir_value).expanduser().resolve()
        project = run_dir / "project"
        manifest_path = run_dir / "rapp-deploy-manifest.json"
        state_path = run_dir / "state.json"
        if not project.is_dir() or not manifest_path.is_file():
            raise ValueError("run_dir is not a complete Copilot Studio run")

        old_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        display_name = str(old_manifest.get("display_name") or "").strip()
        environment = str(old_manifest.get("environment") or "").strip()
        prefix = str(old_manifest.get("publisher_prefix") or "").strip()
        requested_identity = {
            "display_name": kwargs.get("display_name"),
            "environment": kwargs.get("environment"),
            "publisher_prefix": kwargs.get("publisher_prefix"),
        }
        existing_identity = {
            "display_name": display_name,
            "environment": environment,
            "publisher_prefix": prefix,
        }
        for key, requested in requested_identity.items():
            if requested is not None and str(requested).strip() != existing_identity[key]:
                raise ValueError(
                    f"extension cannot change existing {key}"
                )
        paths = module._resolve_agent_paths(selectors)
        new_manifest = module._build_manifest(
            paths,
            display_name=display_name,
            environment=environment,
            publisher_prefix=prefix,
        )
        old_tools = {
            row["tool_name"] for row in old_manifest.get("source_agents", [])
        }
        old_contracts = {
            row["tool_name"]: row
            for row in old_manifest.get("source_agents", [])
        }
        new_contracts = {
            row["tool_name"]: row
            for row in new_manifest.get("source_agents", [])
        }
        new_tools = set(new_contracts)
        removed = sorted(old_tools - new_tools)
        if removed:
            raise ValueError(
                "extension cannot remove existing source agents: "
                + ", ".join(removed)
            )
        for tool_name, old_contract in old_contracts.items():
            new_contract = new_contracts[tool_name]
            for field in ("class_name", "source_path", "source_sha256"):
                if new_contract.get(field) != old_contract.get(field):
                    raise ValueError(
                        "extension cannot replace existing source identity: "
                        f"{tool_name}.{field}"
                    )
        old_order = [
            row["tool_name"] for row in old_manifest.get("source_agents", [])
        ]
        caller_order = [
            row["tool_name"] for row in new_manifest.get("source_agents", [])
        ]
        stable_order = old_order + [
            tool_name for tool_name in caller_order
            if tool_name not in old_tools
        ]
        new_manifest["source_agents"] = [
            new_contracts[tool_name] for tool_name in stable_order
        ]

        identity = module._protected_identity(project)
        if (
            identity.get("displayName") != display_name
            or identity.get("EnvironmentId") != environment
        ):
            raise RuntimeError(
                "existing project identity differs from its deployment manifest"
            )
        module._snapshot_sources(new_manifest, run_dir)
        _write_json(module, manifest_path, new_manifest)
        brief_path = run_dir / "architect-brief.md"
        brief_path.write_text(
            module._brief_text(new_manifest, project),
            encoding="utf-8",
        )
        state = (
            json.loads(state_path.read_text(encoding="utf-8"))
            if state_path.is_file()
            else {"schema": "rapp-to-copilot-studio-state/1.0"}
        )
        state.update({
            "updated_at": module._utc_now(),
            "stage": "extension-planned",
            "manifest_sha256": module._sha256(manifest_path),
            "published": False,
        })
        _write_json(module, state_path, state)

        prompt = (
            f"Read the complete architect brief at {brief_path}. Extend the "
            f"existing initialized project at {project} in place. Preserve "
            "identity and every existing selected capability. Add only the "
            "new caller-selected source contracts. Missing runtime capabilities "
            "must become explicit provisionable infrastructure requirements, "
            "not terminal gaps or model-knowledge substitutes. Do not run PAC, "
            "push, or publish."
        )
        architect_output = module._invoke_plugin_agent(
            module.PLUGIN_AGENTS["architect"],
            prompt,
            cwd=run_dir,
            log_path=run_dir / "logs" / "architect-extension.log",
        )
        materialized = module._materialize_skill_resources(project)
        if module._protected_identity(project) != identity:
            raise RuntimeError(
                "architect changed protected Copilot Studio identity"
            )
        validation = module._validate_target_project(project, prefix)
        pac = module._pac_pull_push(
            project,
            run_dir / "logs" / "pac-extension-push.log",
            publisher_prefix=prefix,
            protected_identity=module._protected_identity(
                project,
                include_file_hashes=False,
            ),
        )
        state.update({
            "updated_at": module._utc_now(),
            "stage": "extension-pushed-unverified",
            "published": False,
        })
        _write_json(module, state_path, state)
        return {
            "status": "extension_pushed",
            "run_dir": str(run_dir),
            "source_agents": sorted(new_tools),
            "infrastructure_requests": [
                row["id"]
                for row in new_manifest.get("infrastructure_requests", [])
            ],
            "materialized_resources": materialized,
            "validation": validation,
            "architect": architect_output,
            "pac": pac,
            "published": False,
            "next_action": "provision",
        }

    def _status(self, run_dir_value: str):
        if not run_dir_value.strip():
            raise ValueError("run_dir is required for action=status")
        run_dir = Path(run_dir_value).expanduser().resolve()
        if not run_dir.is_dir():
            raise ValueError(f"run_dir does not exist: {run_dir}")
        for required in ("rapp-deploy-manifest.json", "state.json"):
            if not (run_dir / required).is_file():
                raise ValueError(
                    f"run_dir is missing required artifact: {required}"
                )
        result = {"status": "success", "run_dir": str(run_dir)}
        for name in (
            "state.json",
            "result.json",
            "infrastructure-receipts.json",
            "parity-evidence.json",
            "release-receipt.json",
        ):
            path = run_dir / name
            if path.is_file():
                result[name.removesuffix(".json")] = json.loads(
                    path.read_text(encoding="utf-8")
                )
        return result

    def perform(self, **kwargs):
        action = str(kwargs.get("action") or "").strip().lower()
        shared = {
            key: kwargs.get(key)
            for key in (
                "agents",
                "display_name",
                "environment",
                "publisher_prefix",
                "run_dir",
                "output_root",
                "infrastructure_manifest",
                "parity_cases",
                "client_id",
                "dry_run",
                "reuse_parity",
            )
            if kwargs.get(key) is not None
        }
        try:
            if action == "doctor":
                result = self._call("doctor")
            elif action == "plan":
                result = self._call("plan", **shared)
            elif action == "build":
                result = self._call("deploy", **shared)
            elif action == "extend":
                result = self._extend(**shared)
            elif action == "provision":
                result = self._call("provision", **shared)
            elif action == "parity":
                result = self._call("parity", **shared)
            elif action == "finalize":
                result = self._call("finalize", **shared)
            elif action == "verify":
                parity = self._call("parity", **shared)
                if parity.get("status") != "success":
                    result = {
                        "status": "parity_failed",
                        "parity": parity,
                    }
                else:
                    finalize = self._call("finalize", **shared)
                    result = {
                        "status": (
                            "success"
                            if finalize.get("status") == "success"
                            else "finalize_failed"
                        ),
                        "parity": parity,
                        "finalize": finalize,
                    }
            elif action == "release_plan":
                result = self._call("release_plan", **shared)
            elif action == "status":
                result = self._status(str(kwargs.get("run_dir") or ""))
            else:
                result = {
                    "status": "error",
                    "error": (
                        "unknown action; expected doctor, plan, build, extend, "
                        "provision, parity, finalize, verify, release_plan, or status"
                    ),
                }
        except (
            ImportError,
            OSError,
            RuntimeError,
            ValueError,
        ) as error:
            result = {
                "status": "error",
                "error": f"{type(error).__name__}: {error}",
            }
        return json.dumps(result, indent=2, ensure_ascii=True)


if __name__ == "__main__":
    print(RappCopilotStudioFactoryAgent().perform(action="doctor"))
