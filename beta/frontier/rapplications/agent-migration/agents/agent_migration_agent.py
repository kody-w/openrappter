"""
Agent Migration Assistant — a Frontier RAPPlication.

Answers the field question "a client built agents on Anthropic or OpenAI and
wants them in Copilot Studio — is there a migration path?" with a working,
on-device migration bench: paste the client's agent definitions (Anthropic
Messages API tool schemas / system prompts, or OpenAI assistants & function
tools), get back (1) RAPP/1 single-file agent.py scaffolds that run on any
Brainstem immediately, and (2) a Copilot Studio handoff pack (instructions +
topic outline) per agent. Everything stays in ~/.rapp/agent-migration/ on this
machine — client IP never leaves the device.

Deterministic: schema mapping is mechanical; where judgment is needed (code
tools, retrieval wiring) it is NAMED in the migration report, never guessed.
"""

import json
import os
import re
from datetime import datetime, timezone
from pprint import pformat

try:
    from agents.basic_agent import BasicAgent
except Exception:  # pragma: no cover
    from basic_agent import BasicAgent

__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@frontier/agent-migration",
    "version": "1.0.0",
    "display_name": "Agent Migration Assistant",
    "description": "Migrate Anthropic/OpenAI agent definitions to RAPP/1 agent.py scaffolds and a Copilot Studio handoff pack, entirely on this device.",
    "author": "AIBAST Frontier",
    "tags": ["frontier", "migration", "copilot-studio", "anthropic", "openai"],
    "category": "frontier",
    "quality_tier": "frontier",
    "requires_env": [],
    "dependencies": ["@rapp/basic-agent"],
}

HOME = os.path.expanduser(os.environ.get("AGENT_MIGRATION_HOME", "~/.rapp/agent-migration"))
OUT = os.path.join(HOME, "out")


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _slug(name):
    return re.sub(r"[^a-z0-9]+", "_", (name or "agent").lower()).strip("_")[:40] or "agent"


def _class_name(name):
    return "".join(w.capitalize() for w in re.split(r"[^a-zA-Z0-9]+", name or "Migrated") if w) or "Migrated"


# ---- source-format detection ------------------------------------------------
def _reject_non_finite(node, where="schema"):
    """json.loads accepts NaN/Infinity; pformat would render them as bare
    nan/inf — valid syntax that raises NameError at import. Refuse them at the
    door so the compile() gate is never fooled."""
    import math
    if isinstance(node, float) and not math.isfinite(node):
        raise ValueError(
            f"The {where} contains a non-finite number (NaN/Infinity), which cannot be migrated to a "
            "portable agent. Replace it with a finite value or a string and try again."
        )
    if isinstance(node, dict):
        for v in node.values():
            _reject_non_finite(v, where)
    elif isinstance(node, list):
        for v in node:
            _reject_non_finite(v, where)


def parse_payload(payload):
    """Return (source_kind, [ {name, description, parameters, system, model, notes[]} ])."""
    data = json.loads(payload)
    _reject_non_finite(data, "agent definition")
    agents = []

    def from_tool(tool, system=None, model=None, kind=""):
        fn = tool.get("function", tool) if isinstance(tool, dict) else {}
        notes = []
        if tool.get("type") not in (None, "function", "custom"):
            notes.append(f"tool type '{tool.get('type')}' has no mechanical mapping — needs a human decision")
        return {
            "name": fn.get("name") or tool.get("name") or "unnamed",
            "description": fn.get("description") or tool.get("description") or "",
            "parameters": fn.get("parameters") or tool.get("input_schema") or {"type": "object", "properties": {}},
            "system": system, "model": model, "kind": kind, "notes": notes,
        }

    if isinstance(data, dict) and isinstance(data.get("assistants"), list):        # OpenAI assistants export
        for a in data["assistants"]:
            for t in a.get("tools", []) or [{}]:
                agents.append(from_tool(t, a.get("instructions"), a.get("model"), "openai-assistant"))
        return "openai-assistants", agents
    if isinstance(data, dict) and isinstance(data.get("tools"), list):             # single agent w/ tools
        kind = "anthropic" if any("input_schema" in t for t in data["tools"]) else "openai"
        for t in data["tools"]:
            agents.append(from_tool(t, data.get("system") or data.get("instructions"), data.get("model"), kind))
        return kind, agents
    if isinstance(data, list) and data and isinstance(data[0], dict) and (
            "input_schema" in data[0] or "function" in data[0] or "parameters" in data[0]):
        kind = "anthropic" if "input_schema" in data[0] else "openai"
        for t in data:
            agents.append(from_tool(t, None, None, kind))
        return kind + "-tools", agents
    raise ValueError(
        "I could not find agent definitions. I accept: an object with 'tools' (Anthropic Messages "
        "API tools use input_schema; OpenAI functions use function.parameters), an OpenAI "
        "'assistants' export, or a bare list of tool definitions."
    )


# ---- emitters ---------------------------------------------------------------
def emit_rapp_agent(spec, source_kind):
    name = str(spec["name"])
    source_kind = str(source_kind)
    slug = _slug(name)
    cls = _class_name(name)
    # pformat, not json.dumps: the schema must land as a PYTHON literal
    # (True/False/None), or any boolean/null in the client's schema would
    # generate a file that raises NameError on import.
    params = pformat(spec["parameters"], indent=4, width=96)
    description = str(spec.get("description") or name)
    system = str(spec.get("system") or "").strip()
    module_doc = f"""{name} — migrated to RAPP/1 from {source_kind}.

Generated {_now()} by the Agent Migration Assistant (on-device).
The tool schema below is the client's own, mapped 1:1. perform() is an honest
scaffold: it validates inputs against the original contract and names what a
human must wire (the original tool's backend), instead of pretending.
"""
    return slug, f'''{json.dumps(module_doc)}

try:
    from agents.basic_agent import BasicAgent
except Exception:
    from basic_agent import BasicAgent

MIGRATED_TOOL_NAME = {json.dumps(name)}
MIGRATED_SOURCE_KIND = {json.dumps(source_kind)}
ORIGINAL_SYSTEM_PROMPT = {json.dumps(system)}


class {cls}Agent(BasicAgent):
    def __init__(self):
        self.name = "{cls}"
        self.metadata = {{
            "name": self.name,
            "description": {json.dumps(description)},
            "parameters": {params},
        }}
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        received = {{k: v for k, v in kwargs.items() if v is not None}}
        return (
            "MIGRATION SCAFFOLD for '" + MIGRATED_TOOL_NAME
            + "': the schema contract is live and I received "
            + str(sorted(received)) +
            ". Wire the original backend logic here (the " + MIGRATED_SOURCE_KIND + " implementation), "
            "then remove this notice."
        )
'''


def emit_copilot_studio(spec, source_kind):
    lines = [f"# Copilot Studio handoff — {spec['name']}", "",
             f"Source: {source_kind} · migrated {_now()} on-device", "",
             "## Agent instructions (paste into Copilot Studio → Instructions)", ""]
    if spec.get("system"):
        lines += ["```", spec["system"].strip(), "```", ""]
    else:
        lines += ["_No system prompt in the source; author instructions from the description below._", ""]
    lines += ["## Capability", "", spec.get("description") or "(no description in source)", "",
              "## Inputs (from the original tool schema)", ""]
    props = (spec.get("parameters") or {}).get("properties", {})
    req = set((spec.get("parameters") or {}).get("required", []))
    for k, v in props.items():
        lines.append(f"- `{k}` ({v.get('type', 'any')}{', required' if k in req else ''}): {v.get('description', '')}")
    if not props:
        lines.append("- (none declared)")
    lines += ["", "## Needs a human decision", ""]
    notes = spec.get("notes") or []
    if spec.get("model"):
        notes = notes + [f"source pinned model '{spec['model']}' — pick the Copilot Studio model/agent settings deliberately"]
    notes = notes + ["connect the action to a real connector/flow — the source tool's backend does not migrate mechanically"]
    lines += [f"- {n}" for n in notes]
    return "\n".join(lines) + "\n"


class AgentMigrationAgent(BasicAgent):
    def __init__(self):
        self.name = "AgentMigration"
        self.metadata = {
            "name": self.name,
            "description": ("Migrate Anthropic/OpenAI agent definitions to RAPP/1 and Copilot Studio, on-device. "
                            "Actions: analyze (what is in the payload), convert (emit agent.py + Copilot Studio pack), "
                            "status, report."),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["analyze", "convert", "status", "report"]},
                    "payload_json": {"type": "string",
                                     "description": "The client's agent definitions as JSON (Anthropic tools / OpenAI functions or assistants export)."},
                },
                "required": ["action"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def _publish(self, state):
        try:
            agents_dir = os.path.dirname(os.path.abspath(__file__))
            body = "# migration live state - inert, served read-only to the local UI\n" + json.dumps(state, ensure_ascii=False)
            tmp = os.path.join(agents_dir, "migration_live_state.py.tmp")
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(body)
            os.replace(tmp, os.path.join(agents_dir, "migration_live_state.py"))
        except Exception:
            pass

    def perform(self, **kwargs):
        action = (kwargs.get("action") or "").strip()
        try:
            if action == "analyze":
                return self._analyze(kwargs)
            if action == "convert":
                return self._convert(kwargs)
            if action in ("status", "report"):
                return self._report()
            return "Unknown action. I can: analyze, convert, status, report. Everything stays on this device."
        except ValueError as e:
            return str(e)
        except Exception as e:
            return f"AgentMigration error: {type(e).__name__}: {e}"

    def _analyze(self, a):
        payload = a.get("payload_json")
        if not payload:
            return ("I need payload_json — paste the client's agent definitions as JSON "
                    "(Anthropic 'tools' with input_schema, OpenAI 'tools' with function.parameters, "
                    "or an OpenAI assistants export). Nothing is uploaded anywhere.")
        kind, agents = parse_payload(payload)
        lines = [f"Found {len(agents)} agent tool(s) in a {kind} payload:"]
        for s in agents:
            flags = " · ".join(s["notes"]) if s["notes"] else "maps mechanically"
            lines.append(f"- {s['name']}: {s['description'][:80] or '(no description)'} — {flags}")
        lines.append("Run action=convert with the same payload_json to emit RAPP/1 agent.py scaffolds + Copilot Studio packs.")
        self._publish({"at": _now(), "phase": "analyzed", "kind": kind,
                       "agents": [{"name": s["name"], "notes": s["notes"]} for s in agents]})
        return "\n".join(lines)

    def _convert(self, a):
        payload = a.get("payload_json")
        if not payload:
            return "convert needs payload_json (same JSON you would give analyze)."
        kind, agents = parse_payload(payload)
        os.makedirs(OUT, exist_ok=True)
        written = []
        skipped = [s for s in agents if any("no mechanical mapping" in n for n in s["notes"])]
        agents = [s for s in agents if s not in skipped]
        used_slugs = set()
        for s in agents:
            slug, py = emit_rapp_agent(s, kind)
            # Two distinct tools can slugify to the same name; disambiguate so a
            # later scaffold never silently overwrites an earlier one.
            if slug in used_slugs:
                n = 2
                while f"{slug}-{n}" in used_slugs:
                    n += 1
                slug = f"{slug}-{n}"
            used_slugs.add(slug)
            try:
                compile(py, f"{slug}_agent.py", "exec")
            except SyntaxError as err:
                skipped.append({"name": s["name"],
                                "notes": [f"generated scaffold failed to compile ({err}) — nothing emitted; report this"]})
                continue
            p1 = os.path.join(OUT, f"{slug}_agent.py")
            with open(p1, "w", encoding="utf-8") as fh:
                fh.write(py)
            p2 = os.path.join(OUT, f"{slug}.copilot-studio.md")
            with open(p2, "w", encoding="utf-8") as fh:
                fh.write(emit_copilot_studio(s, kind))
            os.chmod(p1, 0o600); os.chmod(p2, 0o600)
            written.append({"agent": s["name"], "rapp": p1, "copilot_studio": p2, "needs_human": s["notes"]})
        self._publish({"at": _now(), "phase": "converted", "kind": kind, "written": written,
                       "skipped": [x["name"] for x in skipped]})
        lines = [f"Converted {len(written)} agent(s) from {kind} — everything under {OUT} (this device only):"]
        for x in skipped:
            lines.append(f"- SKIPPED {x['name'] or '(unnamed built-in tool)'}: {'; '.join(x['notes'])} — nothing emitted; decide this one by hand.")
        for w in written:
            lines.append(f"- {w['agent']} → {os.path.basename(w['rapp'])} + {os.path.basename(w['copilot_studio'])}")
        lines.append("The agent.py files drop straight onto a Brainstem (drag & drop or /agents/import). "
                     "The .md files are the Copilot Studio handoff. Backend wiring is named per file, never guessed.")
        return "\n".join(lines)

    def _report(self):
        if not os.path.isdir(OUT):
            return "No migrations yet on this device. Start with action=analyze and the client's agent JSON."
        files = sorted(os.listdir(OUT))
        return (f"Migration bench at {OUT}: {len([f for f in files if f.endswith('_agent.py')])} RAPP agent(s), "
                f"{len([f for f in files if f.endswith('.md')])} Copilot Studio pack(s). Files: " + ", ".join(files[:20]))
