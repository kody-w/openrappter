"""
UI Smith — a Frontier rapplication (headless).

The Brainstem never needs a pre-built, foreign UI. Given an agent.py — any
agent.py it already understands — UI Smith DERIVES a fit-for-purpose UI from the
agent's own tool schema: a labelled control per parameter (text / number / enum
select / checkbox / textarea), a Run button that invokes the tool over the twin's
same-origin /chat, and a result area — Frontier-styled, responsive (full + the
host mobile toggle). That derived UI can then be MOLTED through generations for a
specific twin: each generation archived on device, verified (parses + carries a
control for every required parameter), rolled back if catastrophic, with the
lesson carried forward — the Molter pattern, applied to UIs.

Agents stay headless by default (chat hand-holds the user); a UI is summoned
on demand, generated from the agent, and improved by molting. On device under
~/.rapp/ui-smith/. Headless — drive over /chat.
"""

import ast
import json
import os
import re
from datetime import datetime, timezone
from hashlib import sha256

try:
    from agents.basic_agent import BasicAgent
except Exception:  # pragma: no cover
    from basic_agent import BasicAgent

__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@frontier/ui-smith",
    "version": "1.0.0",
    "display_name": "UI Smith — UIs on the fly",
    "description": "Derive a fit-for-purpose UI from any agent.py's own tool schema (no pre-built UI needed), then molt it through verified generations for a twin. Agents stay headless; a UI is summoned on demand and improved by molting.",
    "author": "AIBAST Frontier",
    "tags": ["frontier", "ui", "generate", "molt", "headless"],
    "category": "frontier",
    "quality_tier": "frontier",
    "requires_env": [],
    "dependencies": ["@rapp/basic-agent"],
}

HOME = os.path.expanduser(os.environ.get("UI_SMITH_HOME", "~/.rapp/ui-smith"))
UIS = os.path.join(HOME, "uis")
STATE_FILE = os.path.join(HOME, "state.json")


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "ui").lower()).strip("-")[:48] or "ui"


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def _script_string(s):
    return json.dumps(str(s)).replace("<", "\\u003c")


def _load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {"uis": {}}


def _save_state(st):
    os.makedirs(HOME, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(st, fh, indent=2)
    os.replace(tmp, STATE_FILE)


_SCHEMA_HARNESS = r"""
import sys, importlib.util, json
path = sys.argv[1]
spec = importlib.util.spec_from_file_location("_uismith_agent", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
man = getattr(mod, "__manifest__", {}) or {}
cls = None
for k, v in vars(mod).items():
    if isinstance(v, type) and k.endswith("Agent") and k != "BasicAgent" and hasattr(v, "perform"):
        cls = v
if cls is None:
    print(json.dumps({"err": "no BasicAgent subclass with perform()"})); sys.exit(0)
md = getattr(cls(), "metadata", {}) or {}
print(json.dumps({"tool": md.get("name"), "display": man.get("display_name"),
                  "description": man.get("description") or md.get("description"),
                  "parameters": md.get("parameters") or {}}))
"""


def _agent_schema(source):
    """Load the agent in an isolated subprocess and read its REAL metadata — the
    only reliable way (metadata often references self.name / is computed, so
    ast.literal_eval fails). params = [{name,type,enum,required,description,long}]."""
    import subprocess, sys, tempfile
    try:
        ast.parse(source)
    except SyntaxError as e:
        raise ValueError(f"That is not valid Python ({e}); cannot derive a UI.")
    with tempfile.TemporaryDirectory() as td:
        ap = os.path.join(td, "agent_under_ui.py")
        with open(ap, "w", encoding="utf-8") as fh:
            fh.write(source)
        with open(os.path.join(td, "basic_agent.py"), "w", encoding="utf-8") as fh:
            fh.write('# minimal BasicAgent stub so any agent loads for schema/verify regardless of env\nclass BasicAgent:\n    def __init__(self, name=None, metadata=None):\n        if name is not None: self.name = name\n        if metadata is not None: self.metadata = metadata\n')
        pkg = os.path.join(td, "agents"); os.makedirs(pkg, exist_ok=True)
        open(os.path.join(pkg, "__init__.py"), "w").close()
        with open(os.path.join(pkg, "basic_agent.py"), "w", encoding="utf-8") as fh:
            fh.write('# minimal BasicAgent stub so any agent loads for schema/verify regardless of env\nclass BasicAgent:\n    def __init__(self, name=None, metadata=None):\n        if name is not None: self.name = name\n        if metadata is not None: self.metadata = metadata\n')
        hp = os.path.join(td, "h.py")
        with open(hp, "w", encoding="utf-8") as fh:
            fh.write(_SCHEMA_HARNESS)
        here = os.path.dirname(os.path.abspath(__file__))
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join([td, here, os.path.dirname(here)] + env.get("PYTHONPATH", "").split(os.pathsep))
        try:
            r = subprocess.run([sys.executable, hp, ap], capture_output=True, text=True, timeout=20, env=env)
        except subprocess.TimeoutExpired:
            raise ValueError("agent did not load within 20s; cannot read its schema.")
        line = (r.stdout or "").strip().splitlines()
        try:
            got = json.loads(line[-1]) if line else {}
        except Exception:
            raise ValueError(f"could not read the agent's schema ({(r.stderr or 'no output')[-200:]}).")
        if got.get("err") or not got.get("tool"):
            raise ValueError(got.get("err") or "the agent exposes no tool name; nothing to build a UI from.")
    props = (got.get("parameters") or {}).get("properties") or {}
    req = set((got.get("parameters") or {}).get("required") or [])
    params = []
    for name, spec in props.items():
        spec = spec if isinstance(spec, dict) else {}
        d = spec.get("description", "")
        long = spec.get("type") == "string" and (
            bool(re.search(r"json|source|text|transcript|body|markdown|payload|prompt|instructions|code", (name + " " + d).lower()))
            or (spec.get("maxLength") or 0) > 200)
        params.append({"name": name, "type": spec.get("type", "string"), "enum": spec.get("enum"),
                       "required": name in req, "description": d, "long": long})
    tool = got["tool"]
    return {"tool": tool, "display": got.get("display") or tool,
            "description": got.get("description") or f"{tool} agent.", "params": params}


def _render_ui(schema):
    """Deterministic schema -> a Frontier-styled, same-origin UI that runs the tool."""
    tool = str(schema["tool"])
    tool_literal = _script_string(tool)
    fields = []
    for p in schema["params"]:
        nm, req = p["name"], (" *" if p["required"] else "")
        lbl = f'<label for="f_{_esc(nm)}">{_esc(nm)}{req}</label>'
        hint = f'<span class="hint">{_esc(p["description"])}</span>' if p["description"] else ""
        if p["enum"]:
            opts = "".join(f'<option value="{_esc(o)}">{_esc(o)}</option>' for o in p["enum"])
            ctl = f'<select id="f_{_esc(nm)}" data-k="{_esc(nm)}"><option value="">—</option>{opts}</select>'
        elif p["type"] == "boolean":
            ctl = f'<label class="chk"><input type="checkbox" id="f_{_esc(nm)}" data-k="{_esc(nm)}" data-bool="1"> yes</label>'
        elif p["type"] in ("integer", "number"):
            ctl = f'<input type="number" id="f_{_esc(nm)}" data-k="{_esc(nm)}"{" step=1" if p["type"]=="integer" else ""}>'
        elif p["long"]:
            ctl = f'<textarea id="f_{_esc(nm)}" data-k="{_esc(nm)}" rows="6"></textarea>'
        else:
            ctl = f'<input type="text" id="f_{_esc(nm)}" data-k="{_esc(nm)}">'
        fields.append(f'<div class="field">{lbl}{hint}{ctl}</div>')
    fields_html = "\n".join(fields) or '<p class="hint">This tool takes no parameters — just run it.</p>'
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_esc(schema["display"])}</title>
<style>
  :root{{--ground:#0d1117;--panel:#161b22;--raised:#1c1e23;--border:#26282d;--t1:#e6edf3;--t2:#c8c9cc;--t3:#8b8f98;--blue:#58a6ff;--action:#3d7cf0;--purple:#b79cff;--purple-bd:#2f2650}}
  *{{box-sizing:border-box;margin:0;padding:0}}
  body{{background:var(--ground);color:var(--t1);font:13.5px Inter,ui-sans-serif,system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column}}
  header{{padding:14px 18px;border-bottom:1px solid var(--border)}}
  header h1{{font-size:16px;display:flex;align-items:center;gap:8px}}
  header .badge{{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--purple);border:1px solid var(--purple-bd);background:#1b1730;border-radius:6px;padding:2px 7px}}
  header p{{font-size:12px;color:var(--t3);margin-top:4px}}
  main{{flex:1;display:grid;grid-template-columns:minmax(300px,0.85fr) 1.15fr;min-height:0}}
  .form{{border-right:1px solid var(--border);padding:16px;overflow:auto;display:flex;flex-direction:column;gap:12px}}
  .field{{display:flex;flex-direction:column;gap:4px}}
  .field label{{font-size:12px;color:var(--t2)}}
  .field .hint{{font-size:11px;color:var(--t3)}}
  input,select,textarea{{background:var(--raised);border:1px solid #30363d;border-radius:8px;color:var(--t1);padding:8px 10px;font:12.5px inherit;width:100%}}
  textarea{{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;resize:vertical}}
  .chk{{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--t2)}} .chk input{{width:auto}}
  button{{font:600 13px Inter,system-ui,sans-serif;padding:10px 16px;border-radius:9px;border:none;background:var(--action);color:#fff;cursor:pointer}}
  .out{{padding:16px;overflow:auto;display:flex;flex-direction:column;gap:8px}}
  .out h2{{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--t3)}}
  #result{{background:var(--panel);border:1px solid var(--border);border-radius:9px;padding:13px;white-space:pre-wrap;font-size:12.5px;color:var(--t2);flex:1;min-height:120px}}
  .law{{font-size:10.5px;color:var(--t3);padding:8px 18px;border-top:1px solid var(--border)}}
  @media (max-width:720px){{main{{grid-template-columns:1fr}}.form{{border-right:none;border-bottom:1px solid var(--border)}}}}
  html[data-rapp-view="mobile"] main{{grid-template-columns:1fr}}
  html[data-rapp-view="mobile"] .form{{border-right:none;border-bottom:1px solid var(--border)}}
</style></head><body>
<header><h1>{_esc(schema["display"])} <span class="badge">generated UI</span></h1><p>{_esc(schema["description"])}</p></header>
<main>
  <div class="form" id="form">
    {fields_html}
    <button id="run">Run {_esc(tool)}</button>
  </div>
  <div class="out"><h2>Result</h2><div id="result">Fill the fields and run — the tool answers over this twin's Brainstem.</div></div>
</main>
<div class="law">Generated from the agent's own schema · runs over the twin's same-origin /chat · on device.</div>
<script>
const TOOL = {tool_literal};
function collect(){{
  const kv=[];
  document.querySelectorAll("#form [data-k]").forEach(function(el){{
    let v = el.dataset.bool ? (el.checked?"true":"") : el.value;
    if(v!=="" && v!=null){{ kv.push(el.dataset.k+"="+JSON.stringify(v)); }}
  }});
  return kv.join(", ");
}}
document.getElementById("run").addEventListener("click", async function(){{
  const r=document.getElementById("result"); r.textContent="Running "+TOOL+"…";
  try{{
    const resp=await fetch("/chat",{{method:"POST",headers:{{"Content-Type":"application/json"}},
      body:JSON.stringify({{user_input:"Use the "+TOOL+" tool with "+collect()+" . Repeat its answer verbatim.",user_guid:"ui-smith"}})}});
    const d=await resp.json(); r.textContent=d.response||d.error||("HTTP "+resp.status);
  }}catch(e){{ r.textContent="Brainstem unreachable: "+e.message; }}
}});
</script></body></html>'''


def _verify_ui(html, schema):
    """Catastrophic = doesn't parse as a document OR lacks a control for a required
    parameter OR doesn't wire the tool. Deterministic, no browser needed."""
    if "<html" not in html.lower() or "</html>" not in html.lower() or "<body" not in html.lower():
        return False, "not a complete HTML document (missing <html>/<body>)"
    tool = str(schema["tool"])
    if "<" in tool:
        return False, "tool name contains unsafe HTML markup"
    if "/chat" not in html or f"const TOOL = {_script_string(tool)};" not in html:
        return False, f"UI does not wire the tool '{tool}' over /chat"
    for p in schema["params"]:
        if p["required"] and f'data-k="{_esc(p["name"])}"' not in html:
            return False, f"required parameter '{p['name']}' has no control in the UI"
    return True, "ok"


class UiSmithAgent(BasicAgent):
    def __init__(self):
        self.name = "UiSmith"
        self.metadata = {
            "name": self.name,
            "description": (
                "Derive/evolve a UI for an agent from its own schema. Actions: generate_ui "
                "(agent.py -> a fit-for-purpose ui.html), molt_ui (verify+archive an edited UI "
                "generation, or return its lesson), rollback, ui_log, status. Headless."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["generate_ui", "molt_ui", "rollback", "ui_log", "status"]},
                    "agent_source": {"type": "string", "description": "generate_ui: the full agent.py to derive a UI from."},
                    "ui_key": {"type": "string", "description": "molt_ui/rollback/ui_log: which UI (defaults to the tool slug)."},
                    "ui_source": {"type": "string", "description": "molt_ui: an edited/mutated UI HTML to verify + archive as the next generation."},
                    "schema_json": {"type": "string", "description": "molt_ui: the tool schema (from generate_ui) so the verifier knows the required controls; optional if the same ui_key was generated before."},
                    "note": {"type": "string", "description": "molt_ui: one line on what this UI generation changes."},
                    "to_generation": {"type": "integer", "description": "rollback: which generation to restore."},
                },
                "required": ["action"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def _dir(self, key):
        return os.path.join(UIS, _slug(key))

    def _archive(self, key, html, verdict, note, schema):
        st = _load_state()
        entry = st["uis"].setdefault(_slug(key), {"live_generation": None, "tool": schema["tool"] if schema else None,
                                                  "schema": schema, "gens": []})
        if schema is not None:
            entry["tool"] = schema["tool"]
            entry["schema"] = schema
        gen = len(entry["gens"])
        gdir = os.path.join(self._dir(key), f"gen-{gen:03d}")
        os.makedirs(gdir, exist_ok=True)
        with open(os.path.join(gdir, "ui.html"), "w", encoding="utf-8") as fh:
            fh.write(html)
        meta = {"generation": gen, "at": _now(), "note": (note or "").strip(),
                "verdict": "verified" if verdict[0] else "catastrophic", "lesson": None if verdict[0] else verdict[1],
                "sha256": sha256(html.encode()).hexdigest()}
        entry["gens"].append(meta)
        if verdict[0]:
            entry["live_generation"] = gen
        _save_state(st)
        return gen, meta

    def perform(self, **kw):
        action = (kw.get("action") or "").strip()
        try:
            return {"generate_ui": self._generate, "molt_ui": self._molt, "rollback": self._rollback,
                    "ui_log": self._log, "status": self._status}.get(
                action, lambda a: f"Unknown action '{action}'.")(kw)
        except ValueError as e:
            return str(e)
        except Exception as e:
            return f"UiSmith error: {type(e).__name__}: {e}"

    def _generate(self, a):
        src = a.get("agent_source")
        if not src:
            return "generate_ui needs agent_source (the full agent.py to derive a UI from)."
        schema = _agent_schema(src)
        html = _render_ui(schema)
        verdict = _verify_ui(html, schema)
        key = _slug(schema["tool"])
        gen, meta = self._archive(key, html, verdict, "generated from schema", schema)
        controls = ", ".join(p["name"] + ("*" if p["required"] else "") for p in schema["params"]) or "(no params)"
        return (f"Derived a UI for '{schema['tool']}' (ui '{key}', generation {gen}) from its schema — "
                f"controls: {controls}. It runs the tool over the twin's /chat. Summon it as this twin's "
                f"custom UI, or molt it further with action=molt_ui, ui_key='{key}', ui_source=<edited html>. "
                f"Schema for the molt verifier:\n{json.dumps(schema)}")

    def _molt(self, a):
        key = _slug(a.get("ui_key") or "")
        html = a.get("ui_source")
        if not key or not html:
            return "molt_ui needs ui_key and ui_source (the edited UI HTML)."
        st = _load_state()
        entry = st["uis"].get(key)
        schema = entry["schema"] if entry and entry.get("schema") else None
        if schema is None and a.get("schema_json"):
            try:
                schema = json.loads(a["schema_json"])
            except Exception:
                return "schema_json is not valid JSON."
        if schema is None:
            return f"No schema on file for '{key}' — pass schema_json (from generate_ui) so I can verify the required controls."
        verdict = _verify_ui(html, schema)
        gen, meta = self._archive(key, html, verdict, a.get("note"), schema)
        if verdict[0]:
            return (f"UI generation {gen} for '{key}' VERIFIED and set live. "
                    f"{('Note: ' + a['note']) if a.get('note') else ''} Molt archived; rollback anytime.")
        # catastrophic: refuse, roll back to last good, return the lesson
        rolled = self._restore_last_good(key)
        return "\n".join([
            f"UI generation {gen} was CATASTROPHIC — refused, not set live.",
            f"Lesson: {verdict[1]}.",
            (f"Rolled back to generation {rolled}." if rolled else "No earlier good UI to roll back to."),
            "Address that lesson in the next molt_ui — this is your feedback to adjust from.",
        ])

    def _restore_last_good(self, key):
        st = _load_state()
        entry = st["uis"].get(key)
        if not entry:
            return None
        for m in reversed(entry["gens"][:-1]):
            if m["verdict"] == "verified":
                entry["live_generation"] = m["generation"]
                _save_state(st)
                return m["generation"]
        entry["live_generation"] = None
        _save_state(st)
        return None

    def _rollback(self, a):
        key = _slug(a.get("ui_key") or "")
        st = _load_state()
        entry = st["uis"].get(key)
        if not entry or not entry["gens"]:
            return f"No UI generations for '{key}'."
        verified = [m for m in entry["gens"] if m["verdict"] == "verified"]
        tgt = a.get("to_generation")
        if tgt is not None:
            m = next((x for x in entry["gens"] if x["generation"] == int(tgt) and x["verdict"] == "verified"), None)
            if not m:
                return f"Generation {tgt} is not a verified UI."
        else:
            m = verified[-2] if len(verified) >= 2 else (verified[-1] if verified else None)
        if not m:
            return f"No verified UI to roll back to for '{key}'."
        entry["live_generation"] = m["generation"]
        _save_state(st)
        return f"Rolled UI '{key}' back to generation {m['generation']} (live)."

    def _log(self, a):
        key = _slug(a.get("ui_key") or "")
        st = _load_state()
        entry = st["uis"].get(key)
        if not entry:
            return f"No UI generations for '{key}'. UIs on device: {list(st['uis'].keys()) or 'none'}."
        lines = [f"UI generations for '{key}' (tool {entry.get('tool')}, live = generation {entry.get('live_generation')}):"]
        for m in entry["gens"]:
            live = " ← LIVE" if m["generation"] == entry.get("live_generation") else ""
            lesson = f" — {m['lesson']}" if m["verdict"] == "catastrophic" else ""
            lines.append(f"  gen {m['generation']} {m['verdict']}{live}: {m['note'] or ''}{lesson}")
        return "\n".join(lines)

    def _status(self, a):
        st = _load_state()
        return json.dumps({"ui_smith_home": HOME,
                           "uis": {k: {"tool": v.get("tool"), "live_generation": v.get("live_generation"),
                                       "generations": len(v["gens"])} for k, v in st["uis"].items()}}, indent=2)
