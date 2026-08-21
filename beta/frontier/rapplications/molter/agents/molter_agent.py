"""
Capability Forge — a Frontier RAPPlication.

Gives the Brainstem autonomous, headless capability acquisition + agent
evolution. When the Brainstem lacks a capability, it can:

  1. SEARCH the AIBAST RAR (the full microsoft/aibast-agents-library catalog)
     for an agent.py of a shape SIMILAR to the request.
  2. ACQUIRE the closest match — sha256-verified — and hot-load it as the
     base generation (molt 0).
  3. MUTATE that base to fit the user's exact use case, or GENERATE a new
     agent from scratch when the RAR has no relevant match.
  4. MOLT: every generation is archived on device. A generation that verifies
     becomes the live agent; a CATASTROPHIC one is refused, rolled back to the
     last good molt, and its failure LESSON is returned as chat data-exhaust so
     the next mutation learns and adjusts in real time.

Architecture (buzzsaw / personless-harness law): THIS agent does only the
deterministic, safe work — search, sha-verified fetch, fail-closed verification
(compile + isolated smoke-load in a timeout-bounded subprocess), molt archive,
rollback, and lesson capture. The BRAINSTEM's own LLM does the creative work
(writing the mutated/generated source), guided by the lessons this agent hands
back. No subprocess-invoked model, ever.

Everything is on device under ~/.rapp/molter/. Headless: the whole
loop is driven over /chat by the Brainstem itself.
"""

import ast
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from hashlib import sha256

try:
    from agents.basic_agent import BasicAgent
except Exception:  # pragma: no cover
    from basic_agent import BasicAgent

__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@frontier/molter",
    "version": "1.0.0",
    "display_name": "Capability Forge",
    "description": "Autonomously acquire a capability the Brainstem lacks: search the AIBAST RAR for a shape-similar agent, hot-load it, then mutate it (or generate from scratch) to fit the request — archiving each generation as a molt with rollback and lesson-carrying evolution.",
    "author": "AIBAST Frontier",
    "tags": ["frontier", "capability", "evolution", "rar", "self-improving"],
    "category": "frontier",
    "quality_tier": "frontier",
    "requires_env": [],
    "dependencies": ["@rapp/basic-agent"],
}

HOME = os.path.expanduser(os.environ.get("MOLTER_HOME", "~/.rapp/molter"))
MOLTS = os.path.join(HOME, "molts")
STATE_FILE = os.path.join(HOME, "state.json")
# The full AIBAST catalog (the RAR the Brainstem searches for a base agent).
AIBAST_REGISTRY = os.environ.get(
    "MOLTER_RAR",
    "https://microsoft.github.io/aibast-agents-library/registry.json")
AIBAST_RAW = "https://raw.githubusercontent.com/microsoft/aibast-agents-library/main/"
# Where a verified generation is hot-loaded so the kernel discovers it: the
# forge's own agents dir (i.e. THIS Brainstem's AGENTS_PATH).
LIVE_DIR = os.path.dirname(os.path.abspath(__file__))
VERIFY_TIMEOUT = 20


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "capability").lower()).strip("-")[:48] or "capability"


def _tokens(s):
    return set(re.findall(r"[a-z0-9]+", (s or "").lower()))


def _fetch(url, as_bytes=False, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "molter"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    return data if as_bytes else json.loads(data.decode("utf-8"))


def _load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {"capabilities": {}}


def _save_state(st):
    os.makedirs(HOME, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(st, fh, indent=2)
    os.replace(tmp, STATE_FILE)


def _safe_agent_name(name, fallback):
    base = os.path.basename(str(name or ""))
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_]{0,60}_agent\.py", base):
        base = f"{_slug(fallback).replace('-', '_')}_agent.py"
    return base


# ── fail-closed verification: a candidate must compile AND smoke-load in an
# isolated, timeout-bounded loader before the trusted parent admits it ────────
#
# Trust boundary: this loader runs the UNTRUSTED candidate's module-level code, so
# it holds no secret and emits no verdict. It only *imports and instantiates* the
# candidate in a disposable process and reports success/failure through its EXIT
# STATUS (0 = clean, non-zero = failed, with a human reason on stderr). The pass/
# fail decision is made by the trusted parent from a static AST analysis it does
# itself (see _ast_agent_verdict); the parent never trusts a byte this process
# writes for that decision. There is deliberately no privileged report channel for
# a candidate to hijack.
_LOADER_HARNESS = r'''
import importlib.util
import sys

def main():
    path = sys.argv[1]
    expected_class = sys.argv[2]
    try:
        from agents.basic_agent import BasicAgent

        spec = importlib.util.spec_from_file_location("_forge_candidate", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)          # runs module-level code (isolated proc)

        agent_cls = vars(mod).get(expected_class)
        if (not isinstance(agent_cls, type)
                or agent_cls is BasicAgent
                or getattr(agent_cls, "__module__", None) != mod.__name__
                or getattr(agent_cls, "__name__", None) != expected_class
                or not issubclass(agent_cls, BasicAgent)):
            sys.stderr.write(
                "AST-selected class {0} did not resolve to that module's "
                "BasicAgent subclass".format(expected_class))
            raise SystemExit(1)

        inst = agent_cls()
        md = getattr(inst, "metadata", None)
        if not isinstance(md, dict):
            sys.stderr.write("metadata is missing or is not a dict")
            raise SystemExit(1)
        name = md.get("name")
        if not isinstance(name, str) or not name.strip():
            sys.stderr.write("metadata has no valid string name")
            raise SystemExit(1)
        if not isinstance(md.get("parameters"), dict):
            sys.stderr.write("metadata has no parameters dict")
            raise SystemExit(1)
        if not callable(getattr(inst, "perform", None)):
            sys.stderr.write("perform() is not callable")
            raise SystemExit(1)
        # Advisory only (display label): the agent's own registered name. The parent
        # uses this for a label, NEVER for the pass/fail verdict, so forging it is
        # inert — the verdict is already decided by the parent's AST analysis.
        display_name = getattr(inst, "name", None) or name
        sys.stdout.write(str(display_name)[:200])
        sys.stdout.flush()
        raise SystemExit(0)
    except SystemExit:
        raise
    except BaseException as e:
        sys.stderr.write("{0}: {1}".format(type(e).__name__, e))
        raise SystemExit(1)

if __name__ == "__main__":
    main()
'''


def _ast_extract_tool_name(class_node):
    """Best-effort: read the tool name from a `metadata = {... "name": "X" ...}`
    dict literal in the class body or __init__. Returns None when the name is not a
    plain string literal (the class name is used as a harmless display fallback)."""
    for node in ast.walk(class_node):
        if isinstance(node, ast.Assign):
            is_metadata = any(
                (isinstance(t, ast.Name) and t.id == "metadata")
                or (isinstance(t, ast.Attribute) and t.attr == "metadata")
                for t in node.targets)
            if is_metadata and isinstance(node.value, ast.Dict):
                for key, val in zip(node.value.keys, node.value.values):
                    if (isinstance(key, ast.Constant) and key.value == "name"
                            and isinstance(val, ast.Constant)
                            and isinstance(val.value, str) and val.value.strip()):
                        return val.value
    return None


# Grail's loader wraps each agent import in `except Exception`, which does NOT
# catch SystemExit (a BaseException), and nothing catches os._exit. So an agent
# that exits at import time takes the whole Brainstem down with it. Every molt
# must stay safe to drag back into a plain Grail brainstem, so a candidate that
# could exit during import is refused here — statically, before it ever runs.
_EXIT_CALLS = {("sys", "exit"), ("os", "_exit"), ("os", "abort"), ("os", "kill")}
_PROCESS_LIFECYCLE_CALLS = {
    ("atexit", "register"),
    ("signal", "alarm"),
    ("signal", "setitimer"),
    ("signal", "signal"),
    ("threading", "Thread"),
    ("threading", "Timer"),
}


def _is_main_guard(test):
    """True for `__name__ == "__main__"` (either operand order)."""
    if not isinstance(test, ast.Compare) or len(test.ops) != 1:
        return False
    if not isinstance(test.ops[0], ast.Eq):
        return False
    sides = [test.left] + list(test.comparators)
    names = {n.id for n in sides if isinstance(n, ast.Name)}
    consts = {c.value for c in sides if isinstance(c, ast.Constant)}
    return "__name__" in names and "__main__" in consts


def _module_level_exit(tree):
    """Return a reason if import-time code can terminate or mutate the process
    lifecycle. Function bodies are inert, but decorators/defaults and class bodies
    execute while the module is imported."""
    def import_time_walk(root):
        stack = [root]
        while stack:
            current = stack.pop()
            yield current
            if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
                args = current.args
                children = (
                    list(current.decorator_list)
                    + list(args.defaults)
                    + [value for value in args.kw_defaults if value is not None]
                )
                if current.returns is not None:
                    children.append(current.returns)
                all_args = (
                    list(args.posonlyargs)
                    + list(args.args)
                    + list(args.kwonlyargs)
                    + ([args.vararg] if args.vararg is not None else [])
                    + ([args.kwarg] if args.kwarg is not None else [])
                )
                children.extend(
                    arg.annotation for arg in all_args if arg.annotation is not None)
                stack.extend(reversed(children))
                continue
            if isinstance(current, ast.Lambda):
                stack.extend(reversed(
                    list(current.args.defaults)
                    + [value for value in current.args.kw_defaults
                       if value is not None]))
                continue
            stack.extend(reversed(list(ast.iter_child_nodes(current))))

    def offending(node):
        for sub in import_time_walk(node):
            if isinstance(sub, ast.Call):
                fn = sub.func
                if isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name):
                    if (fn.value.id, fn.attr) in _EXIT_CALLS:
                        return f"{fn.value.id}.{fn.attr}()"
                    if (fn.value.id, fn.attr) in _PROCESS_LIFECYCLE_CALLS:
                        return f"{fn.value.id}.{fn.attr}()"
                if isinstance(fn, ast.Name) and fn.id in ("exit", "quit"):
                    return f"{fn.id}()"
            if isinstance(sub, ast.Raise):
                exc = sub.exc
                name = None
                if isinstance(exc, ast.Call) and isinstance(exc.func, ast.Name):
                    name = exc.func.id
                elif isinstance(exc, ast.Name):
                    name = exc.id
                if name in ("SystemExit", "KeyboardInterrupt"):
                    return f"raise {name}"
        return None

    for node in tree.body:
        # `if __name__ == "__main__":` does not run on import — the loader sets
        # __name__ to the module name. This is the standard idiom that lets an
        # agent ALSO run standalone (`python3 my_agent.py '{...}'`), which is how
        # a RAPP agent stays useful on hosts with no brainstem. Refusing it would
        # reject the ecosystem's dominant shape.
        if isinstance(node, ast.If) and _is_main_guard(node.test):
            continue
        found = offending(node)
        if found:
            return found
    return None


def _ast_agent_verdict(source):
    """The trusted, parent-side verdict — it PARSES the candidate, never executes
    it, so it cannot be forged by anything the candidate does at import time
    (including os._exit/SystemExit tricks that would fake a clean subprocess load).
    A source passes only if it statically (a) imports BasicAgent from the kernel
    base module and never rebinds that name — so the base is the genuine kernel
    class, not a `BasicAgent = object` decoy — (b) resolves an unconditional,
    module-level subclass lineage, and (c) that lineage defines perform() — a molt
    that cannot act is sterile and is refused. Returns
    (ok, reason_or_None, info_or_None)."""
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return False, f"SyntaxError: {e.msg} at line {e.lineno}", None

    has_structural_agent = any(
        isinstance(node, ast.ClassDef)
        and any(
            (isinstance(base, ast.Name) and base.id == "BasicAgent")
            or (isinstance(base, ast.Attribute) and base.attr == "BasicAgent")
            for base in node.bases)
        for node in ast.walk(tree)
    )
    if not has_structural_agent:
        return False, "no BasicAgent subclass is defined", None

    def rebinds_name(target):
        if isinstance(target, ast.Name):
            return target.id == "BasicAgent"
        if isinstance(target, (ast.Tuple, ast.List)):
            return any(rebinds_name(item) for item in target.elts)
        if isinstance(target, ast.Subscript):
            value = target.value
            key = target.slice
            return (
                isinstance(value, ast.Call)
                and isinstance(value.func, ast.Name)
                and value.func.id == "globals"
                and not value.args
                and not value.keywords
                and isinstance(key, ast.Constant)
                and key.value == "BasicAgent"
            )
        return False

    def canonical_import(node):
        return (
            isinstance(node, ast.ImportFrom)
            and node.level == 0
            and node.module == "agents.basic_agent"
            and any(alias.name == "BasicAgent" and alias.asname is None
                    for alias in node.names)
        )

    def catches_import_error(handler):
        caught = handler.type
        if isinstance(caught, ast.Name):
            return caught.id == "ImportError"
        if isinstance(caught, ast.Tuple):
            return any(isinstance(item, ast.Name) and item.id == "ImportError"
                       for item in caught.elts)
        return False

    canonical_import_ids = set()
    allowed_fallback_import_ids = set()
    for statement in tree.body:
        if canonical_import(statement):
            canonical_import_ids.add(id(statement))
            continue
        if not isinstance(statement, ast.Try):
            continue
        canonical_import_ids.update(
            id(item) for item in statement.body if canonical_import(item))
        if not any(canonical_import(item) for item in statement.body):
            continue
        for handler in statement.handlers:
            if not catches_import_error(handler):
                continue
            for handler_statement in handler.body:
                for sub in ast.walk(handler_statement):
                    if (isinstance(sub, ast.ImportFrom)
                            and sub.level == 0
                            and sub.module == "basic_agent"
                            and any(alias.name == "BasicAgent"
                                    and alias.asname is None
                                    for alias in sub.names)):
                        allowed_fallback_import_ids.add(id(sub))

    imported_basic_agent = False
    invalid_basic_agent_import = False
    rebinds_basic_agent = False
    top_level_definition_ids = {id(node) for node in tree.body}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.asname == "BasicAgent" and alias.name != "BasicAgent":
                    rebinds_basic_agent = True
                if alias.name != "BasicAgent":
                    continue
                if id(node) in canonical_import_ids and alias.asname is None:
                    imported_basic_agent = True
                elif id(node) in allowed_fallback_import_ids:
                    continue
                else:
                    invalid_basic_agent_import = True
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.endswith("basic_agent"):
                    invalid_basic_agent_import = True
                if alias.asname == "BasicAgent":
                    rebinds_basic_agent = True
        elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(rebinds_name(target) for target in targets):
                rebinds_basic_agent = True
        elif (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
              and id(node) in top_level_definition_ids
              and node.name == "BasicAgent"):
            rebinds_basic_agent = True

    if (not imported_basic_agent or invalid_basic_agent_import
            or rebinds_basic_agent):
        return False, ("BasicAgent must be imported from agents.basic_agent and its name "
                       "never reassigned (the base must be the real kernel class)"), None

    top_level_classes = [
        node for node in tree.body if isinstance(node, ast.ClassDef)]
    top_level_ids = {id(node) for node in top_level_classes}
    for node in ast.walk(tree):
        if (isinstance(node, ast.ClassDef) and id(node) not in top_level_ids
                and any(isinstance(base, ast.Name) and base.id == "BasicAgent"
                        for base in node.bases)):
            return False, (
                f"{node.name} conditionally or locally defines a BasicAgent subclass; "
                "the agent class must be unconditional and module-level"), None

    agent_classes = []
    agent_classes_by_name = {}
    known_bases = {"BasicAgent"}
    for node in top_level_classes:
        if any(isinstance(base, ast.Name) and base.id in known_bases
               for base in node.bases):
            agent_classes.append(node)
            agent_classes_by_name[node.name] = node
            known_bases.add(node.name)
    if not agent_classes:
        return False, "no BasicAgent subclass is defined", None

    identity_decorators = set()
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef):
            continue
        args = node.args
        if (not node.decorator_list and len(args.posonlyargs) + len(args.args) == 1
                and not args.vararg and not args.kwarg and not args.kwonlyargs
                and not args.defaults and len(node.body) == 1
                and isinstance(node.body[0], ast.Return)
                and isinstance(node.body[0].value, ast.Name)):
            parameter = (args.posonlyargs + args.args)[0].arg
            if node.body[0].value.id == parameter:
                identity_decorators.add(node.name)
    for node in agent_classes:
        if node.keywords:
            return False, (
                f"{node.name} uses a metaclass or dynamic class keyword; "
                "class construction must stay statically verifiable"), None
        if any(not isinstance(decorator, ast.Name)
               or decorator.id not in identity_decorators
               for decorator in node.decorator_list):
            return False, (
                f"{node.name} uses a decorator whose identity behavior "
                "cannot be proven statically"), None
        if any(isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
               and item.name == "__init_subclass__" for item in node.body):
            return False, (
                f"{node.name} defines __init_subclass__(), which executes "
                "during import-time class construction"), None

    agent_cls = agent_classes[-1]
    lineage = []
    pending = [agent_cls]
    seen = set()
    while pending:
        node = pending.pop()
        if id(node) in seen:
            continue
        seen.add(id(node))
        lineage.append(node)
        pending.extend(
            agent_classes_by_name[base.id]
            for base in node.bases
            if isinstance(base, ast.Name) and base.id in agent_classes_by_name)
    if not any(
            isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
            and item.name == "perform"
            for node in lineage for item in node.body):
        return False, f"{agent_cls.name} does not define perform() — a molt must be able to act", None
    exiting = _module_level_exit(tree)
    if exiting:
        return False, (f"module-level {exiting} can terminate the Brainstem or mutate "
                       "its process lifecycle on import; "
                       "a molt must stay safe to load in a plain Grail brainstem"), None

    tool_name = _ast_extract_tool_name(agent_cls)  # None when not a static literal
    return True, None, {"agent_class": agent_cls.name, "tool_name": tool_name}


def _verify(source):
    """Return (ok, detail). The pass/fail VERDICT is decided by the trusted parent
    from a static AST analysis of the source (never executed here). A disposable
    subprocess additionally confirms the source imports and instantiates cleanly —
    a *correctness* signal read only from the child's EXIT STATUS, never from any
    byte the child writes — so a candidate cannot forge a pass by what it prints,
    by pre-empting a report channel, or by calling os._exit(). Fail-closed."""
    ok, reason, info = _ast_agent_verdict(source)
    if not ok:
        return False, {"stage": "ast", "lesson": reason}

    def fail(lesson):
        one_line = " ".join(str(lesson).split()) or "verification failed"
        return False, {"stage": "smoke", "lesson": one_line[:600]}

    with tempfile.TemporaryDirectory() as td:
        cand = os.path.join(td, "candidate_agent.py")
        with open(cand, "w", encoding="utf-8") as fh:
            fh.write(source)
        pkg = os.path.join(td, "agents"); os.makedirs(pkg, exist_ok=True)
        open(os.path.join(pkg, "__init__.py"), "w").close()
        with open(os.path.join(pkg, "basic_agent.py"), "w", encoding="utf-8") as fh:
            fh.write('# minimal BasicAgent stub so any agent loads for schema/verify regardless of env\nclass BasicAgent:\n    def __init__(self, name=None, metadata=None):\n        if name is not None: self.name = name\n        if metadata is not None: self.metadata = metadata\n')
        with open(os.path.join(td, "basic_agent.py"), "w", encoding="utf-8") as fh:
            fh.write("from agents.basic_agent import BasicAgent\n")
        loader = os.path.join(td, "loader.py")
        with open(loader, "w", encoding="utf-8") as fh:
            fh.write(_LOADER_HARNESS)
        env = dict(os.environ)
        # basic_agent must resolve; expose the same shim path the kernel uses
        env["PYTHONPATH"] = os.pathsep.join(
            [td, LIVE_DIR, os.path.dirname(LIVE_DIR)] + env.get("PYTHONPATH", "").split(os.pathsep))
        try:
            r = subprocess.run(
                [sys.executable, loader, cand, info["agent_class"]],
                capture_output=True, timeout=VERIFY_TIMEOUT, env=env)
        except subprocess.TimeoutExpired:
            return fail(
                f"candidate did not finish loading within {VERIFY_TIMEOUT}s "
                "(likely an infinite loop or blocking call at import time)")
        except OSError as e:
            return fail(f"loader could not start: {type(e).__name__}: {e}")

        if r.returncode != 0:
            stderr = (r.stderr or b"").decode("utf-8", "replace").strip()
            return fail(f"candidate failed to load cleanly: {stderr[-400:]}"
                        if stderr else "candidate failed to load cleanly")

        # Advisory display label from the verified child — never gates the verdict.
        runtime_name = (r.stdout or b"").decode("utf-8", "replace").strip()[:200]

    return True, {
        "ok": True,
        "agent_class": info["agent_class"],
        "tool_name": info["tool_name"] or runtime_name or info["agent_class"],
    }


class MolterAgent(BasicAgent):
    def __init__(self):
        self.name = "Molter"
        self.metadata = {
            "name": self.name,
            "description": (
                "Autonomously acquire/evolve a Brainstem capability. Actions: search_capability "
                "(find shape-similar agents in the AIBAST RAR), acquire (sha-verified hot-load a base "
                "as molt 0), mutate (verify+install an LLM-written mutation of the current source, or "
                "return its failure lesson), generate (same, from scratch when the RAR has no match), "
                "rollback (restore the last good molt), molt_log, status. Headless — drive it over /chat."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": [
                        "search_capability", "acquire", "mutate", "generate",
                        "rollback", "molt_log", "status"]},
                    "request": {"type": "string", "description": "The capability the user needs, in plain words (search_capability/generate)."},
                    "capability": {"type": "string", "description": "A short slug naming the capability being forged (acquire/mutate/generate)."},
                    "agent_name": {"type": "string", "description": "acquire: the RAR agent name to pull as the base (from search_capability results)."},
                    "source": {"type": "string", "description": "mutate/generate: the FULL agent.py source the Brainstem's LLM produced. This agent verifies it before it ever goes live."},
                    "note": {"type": "string", "description": "mutate/generate: one line on what this generation changed/attempts (recorded on the molt)."},
                    "to_generation": {"type": "integer", "description": "rollback: molt generation to restore (default: the last good one before the current)."},
                    "top_k": {"type": "integer", "description": "search_capability: how many candidates to return (default 5)."},
                },
                "required": ["action"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    # ---- helpers -----------------------------------------------------------
    def _cap_dir(self, cap):
        return os.path.join(MOLTS, _slug(cap))

    def _record_molt(self, cap, source, verdict, note, parent, kind):
        d = self._cap_dir(cap)
        st = _load_state()
        entry = st["capabilities"].setdefault(_slug(cap), {"live_generation": None, "molts": []})
        gen = len(entry["molts"])
        gdir = os.path.join(d, f"gen-{gen:03d}")
        os.makedirs(gdir, exist_ok=True)
        with open(os.path.join(gdir, "agent.py"), "w", encoding="utf-8") as fh:
            fh.write(source)
        meta = {"generation": gen, "kind": kind, "note": (note or "").strip(),
                "parent": parent, "at": _now(), "verdict": "verified" if verdict[0] else "catastrophic",
                "detail": verdict[1], "sha256": sha256(source.encode()).hexdigest()}
        with open(os.path.join(gdir, "molt.json"), "w", encoding="utf-8") as fh:
            json.dump(meta, fh, indent=2)
        entry["molts"].append(meta)
        _save_state(st)
        return gen, meta

    @staticmethod
    def _is_sacred_brainstem(d):
        """Refuse unless this is provably the current isolated twin's agents dir."""
        marker = (os.environ.get("BRAINSTEM_BETA_TWIN") or "").strip()
        if not marker or marker in (".", "..") or os.path.basename(marker) != marker:
            return True
        parts = os.path.realpath(d).replace("\\", "/").rstrip("/").split("/")
        return len(parts) < 3 or parts[-3:] != ["twins", marker, "agents"]

    def _go_live(self, cap, source, tool_name, generation):
        if self._is_sacred_brainstem(LIVE_DIR):
            raise RuntimeError(
                "Refusing to install a molt outside a proven isolated twin agents dir. "
                "Molting happens only when BRAINSTEM_BETA_TWIN matches the real "
                ".../twins/<id>/agents path. The molt is archived on device."
            )
        """Install a specific verified generation as the live agent the kernel
        discovers. The generation is passed explicitly — a rollback installs an
        OLD molt's source, so live_generation must be that molt, never the
        newest one on the pile."""
        filename = _safe_agent_name(f"{_slug(cap)}_agent.py", cap)
        live_path = os.path.join(LIVE_DIR, filename)
        tmp = live_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(source)
        os.replace(tmp, live_path)
        os.chmod(live_path, 0o600)
        st = _load_state()
        entry = st["capabilities"][_slug(cap)]
        entry["live_generation"] = generation
        entry["live_file"] = filename
        entry["live_tool"] = tool_name
        _save_state(st)
        return live_path

    def _rehydrate_live(self):
        """Reinstall every capability that state says is live but whose file is
        missing from the twin's agents dir.

        A twin's agents directory is disposable: the launcher clears the twins
        root when it starts, so a restart — or simply opening a second Frontier
        window — deletes the live copy of every grown capability. The generations
        themselves are durable (each is archived under ~/.rapp/molter), so the
        loss is recoverable; without this the capability silently vanishes while
        status still reports the generation as live, which is the worst of both.

        Returns the list of capabilities it restored. Never raises: a Brainstem
        that cannot rehydrate must still answer."""
        restored = []
        try:
            if self._is_sacred_brainstem(LIVE_DIR):
                return restored           # never install into the sacred kernel
            st = _load_state()
        except Exception:
            return restored
        for slug, entry in (st.get("capabilities") or {}).items():
            try:
                gen = entry.get("live_generation")
                filename = entry.get("live_file")
                if gen is None or not filename:
                    continue
                live_path = os.path.join(LIVE_DIR, filename)
                if os.path.exists(live_path):
                    continue              # still there; nothing to do
                archived = os.path.join(
                    MOLTS, slug, f"gen-{int(gen):03d}", "agent.py")
                with open(archived, "r", encoding="utf-8") as fh:
                    source = fh.read()
                tmp = live_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as fh:
                    fh.write(source)
                os.replace(tmp, live_path)
                os.chmod(live_path, 0o600)
                restored.append(f"{slug} (generation {gen})")
            except Exception:
                continue                  # one unrecoverable capability is not fatal
        return restored

    def _lessons(self, cap):
        st = _load_state()
        entry = st["capabilities"].get(_slug(cap), {})
        return [f"gen {m['generation']} ({m['kind']}): {m['detail'].get('lesson', m['verdict'])}"
                for m in entry.get("molts", []) if m["verdict"] == "catastrophic"]

    # ---- actions -----------------------------------------------------------
    def perform(self, **kw):
        action = (kw.get("action") or "").strip()
        # Self-heal first: the twins root is cleared on launch, so a grown
        # capability's live file may be gone even though its generation is
        # durable on device. Restoring here means the capability survives a
        # restart, and status can never claim a generation is live while its
        # file is missing.
        restored = self._rehydrate_live()
        try:
            result = {
                "search_capability": self._search, "acquire": self._acquire,
                "mutate": lambda a: self._forge(a, kind="mutation"),
                "generate": lambda a: self._forge(a, kind="generation"),
                "rollback": self._rollback, "molt_log": self._molt_log,
                "status": self._status,
            }.get(action, lambda a: f"Unknown action '{action}'.")(kw)
            # Tell the user when a grown capability had to be brought back, so a
            # silent loss-and-recovery is visible rather than invisible.
            if restored:
                result = f"{result}\n\n[molter] Restored after a restart: " \
                         + ", ".join(restored) + "."
            return result
        except Exception as e:
            return f"Molter error: {type(e).__name__}: {e}"

    def _search(self, a):
        request = (a.get("request") or "").strip()
        if not request:
            return "search_capability needs a 'request' — the capability you need, in plain words."
        top_k = int(a.get("top_k") or 5)
        try:
            reg = _fetch(AIBAST_REGISTRY)
        except Exception as e:
            return f"Could not reach the AIBAST RAR ({AIBAST_REGISTRY}): {e}"
        want = _tokens(request)
        scored = []
        for ag in reg.get("agents", []):
            if not ag.get("_file") or not ag.get("_sha256"):
                continue
            hay = _tokens(" ".join([ag.get("display_name", ""), ag.get("description", ""),
                                    ag.get("category", ""), " ".join(ag.get("tags", []))]))
            overlap = len(want & hay)
            if overlap:
                scored.append((overlap / max(1, len(want)), overlap, ag))
        scored.sort(key=lambda x: (-x[0], -x[1]))
        top = scored[:top_k]
        if not top:
            return (f"No shape-similar agent in the AIBAST RAR for '{request}'. "
                    "There is nothing to mutate from — use action=generate with a from-scratch "
                    "agent.py written for this request (I will verify and molt it).")
        lines = [f"AIBAST RAR candidates for '{request}' (closest shape first):"]
        for sim, ov, ag in top:
            lines.append(f"- {ag['name']} · {ag.get('display_name','')} — {int(sim*100)}% shape match "
                         f"({ov} shared concepts). {ag.get('description','')[:80]}")
        lines.append("Pick the closest with action=acquire, agent_name='<name>', capability='<slug>'. "
                     "I hot-load it as molt 0; then write a mutation with action=mutate.")
        return "\n".join(lines)

    def _acquire(self, a):
        name = (a.get("agent_name") or "").strip()
        cap = (a.get("capability") or name.split("/")[-1]).strip()
        if not name:
            return "acquire needs agent_name (from search_capability) and a capability slug."
        try:
            reg = _fetch(AIBAST_REGISTRY)
        except Exception as e:
            return f"Could not reach the AIBAST RAR: {e}"
        ag = next((x for x in reg.get("agents", []) if x.get("name") == name), None)
        if not ag:
            return f"'{name}' is not in the AIBAST RAR. Run action=search_capability first."
        url = AIBAST_RAW + "/".join(urllib.request.quote(p) for p in ag["_file"].split("/"))
        try:
            data = _fetch(url, as_bytes=True)
        except Exception as e:
            return f"Could not fetch {name} bytes: {e}"
        digest = sha256(data).hexdigest()
        if digest != ag["_sha256"].lower():
            return (f"REFUSED: {name} bytes hash {digest[:12]}… but the RAR pins {ag['_sha256'][:12]}… "
                    "— not acquiring an unverified base.")
        source = data.decode("utf-8")
        verdict = _verify(source)
        gen, meta = self._record_molt(cap, source, verdict, f"acquired base {name} (sha {digest[:12]})",
                                      parent=None, kind="acquisition")
        if not verdict[0]:
            return (f"Acquired {name} as molt {gen} but it did NOT smoke-load here "
                    f"(lesson: {verdict[1].get('lesson')}). It is archived but NOT live. "
                    "You can still mutate from its source with action=mutate.")
        live = self._go_live(cap, source, verdict[1].get("tool_name", cap), gen)
        return (f"Grew + hot-loaded {name} as molt {gen} for capability '{_slug(cap)}' "
                f"(tool '{verdict[1].get('tool_name')}', sha {digest[:12]}). It is LIVE now — usable "
                "on the next message. To fit it to the exact request, write a mutation with "
                "action=mutate, capability='" + _slug(cap) + "', source=<full mutated agent.py>.")

    def _forge(self, a, kind):
        cap = (a.get("capability") or "").strip()
        source = a.get("source")
        note = a.get("note") or ""
        if not cap or not source:
            base_hint = ""
            if kind == "mutation":
                base_hint = (" Provide the FULL mutated agent.py in 'source' — start from the current "
                             "live/base source and change it to fit the request.")
            return (f"{kind} needs capability='<slug>' and source=<full agent.py>." + base_hint)
        lessons = self._lessons(cap)
        verdict = _verify(source)
        parent = None
        st = _load_state()
        entry = st["capabilities"].get(_slug(cap))
        if entry and entry.get("molts"):
            parent = entry.get("live_generation", len(entry["molts"]) - 1)
        gen, meta = self._record_molt(cap, source, verdict, note, parent=parent, kind=kind)
        if verdict[0]:
            self._go_live(cap, source, verdict[1].get("tool_name", cap), gen)
            return (f"Generation {gen} VERIFIED and now LIVE for '{_slug(cap)}' "
                    f"(tool '{verdict[1].get('tool_name')}'). {('Note: ' + note) if note else ''}\n"
                    "Molt archived on device; roll back anytime with action=rollback.")
        # Catastrophic: refuse to go live, roll back to last good, hand back the lesson.
        rolled = self._restore_last_good(cap)
        exhaust = [f"Generation {gen} was CATASTROPHIC — refused, not installed.",
                   f"Lesson (stage {verdict[1].get('stage','smoke')}): {verdict[1].get('lesson')}"]
        if verdict[1].get("trace"):
            exhaust.append(f"trace tail: {verdict[1]['trace'][-300:]}")
        exhaust.append(f"Rolled back to {rolled}." if rolled else "No earlier good molt to roll back to; capability stays unset.")
        if lessons:
            exhaust.append("Prior lessons this run: " + " | ".join(lessons[-3:]))
        exhaust.append("Write the NEXT mutation with action=" + ("mutate" if kind == "mutation" else "generate")
                       + " addressing that lesson — this feedback is your data to adjust from.")
        return "\n".join(exhaust)

    def _restore_last_good(self, cap):
        st = _load_state()
        entry = st["capabilities"].get(_slug(cap))
        if not entry:
            return None
        for m in reversed(entry["molts"][:-1]):   # skip the just-failed one
            if m["verdict"] == "verified":
                gdir = os.path.join(self._cap_dir(cap), f"gen-{m['generation']:03d}")
                src = open(os.path.join(gdir, "agent.py"), encoding="utf-8").read()
                self._go_live(cap, src, m["detail"].get("tool_name", cap), m["generation"])
                return f"generation {m['generation']}"
        # nothing good before it — remove any live file so a broken cap isn't served
        if entry.get("live_file"):
            try:
                os.remove(os.path.join(LIVE_DIR, entry["live_file"]))
            except OSError:
                pass
            entry["live_generation"] = None
            _save_state(st)
        return None

    def _rollback(self, a):
        cap = (a.get("capability") or "").strip()
        st = _load_state()
        entry = st["capabilities"].get(_slug(cap))
        if not entry or not entry["molts"]:
            return f"No molts for '{_slug(cap)}' to roll back to."
        target = a.get("to_generation")
        candidates = [m for m in entry["molts"] if m["verdict"] == "verified"]
        if target is not None:
            m = next((x for x in entry["molts"] if x["generation"] == int(target)), None)
            if not m or m["verdict"] != "verified":
                return f"Generation {target} is not a verified molt; pick a verified one from molt_log."
        else:
            m = candidates[-2] if len(candidates) >= 2 else (candidates[-1] if candidates else None)
        if not m:
            return f"No verified molt to roll back to for '{_slug(cap)}'."
        gdir = os.path.join(self._cap_dir(cap), f"gen-{m['generation']:03d}")
        src = open(os.path.join(gdir, "agent.py"), encoding="utf-8").read()
        self._go_live(cap, src, m["detail"].get("tool_name", cap), m["generation"])
        return f"Rolled '{_slug(cap)}' back to generation {m['generation']} (tool '{m['detail'].get('tool_name')}'). It is LIVE."

    def _molt_log(self, a):
        cap = (a.get("capability") or "").strip()
        st = _load_state()
        entry = st["capabilities"].get(_slug(cap))
        if not entry:
            caps = list(st["capabilities"].keys())
            return f"No molts for '{_slug(cap)}'. Capabilities on device: {caps or 'none'}."
        lines = [f"Molt history for '{_slug(cap)}' (live = generation {entry.get('live_generation')}):"]
        for m in entry["molts"]:
            live = " ← LIVE" if m["generation"] == entry.get("live_generation") else ""
            lesson = f" — {m['detail'].get('lesson')}" if m["verdict"] == "catastrophic" else ""
            lines.append(f"  gen {m['generation']} [{m['kind']}] {m['verdict']}{live}: {m['note'] or ''}{lesson}")
        return "\n".join(lines)

    def _status(self, a):
        st = _load_state()
        caps = {k: {"live_generation": v.get("live_generation"), "molts": len(v["molts"]),
                    "live_tool": v.get("live_tool")}
                for k, v in st["capabilities"].items()}
        return json.dumps({"forge_home": HOME, "live_dir": LIVE_DIR, "rar": AIBAST_REGISTRY,
                           "capabilities": caps}, indent=2)
