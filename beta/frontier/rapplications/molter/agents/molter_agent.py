"""
Capability Forge — a Frontier rapplication.

Gives the Brainstem autonomous, headless capability acquisition + agent
evolution. When the Brainstem lacks a capability, it can:

  1. SEARCH the AIBAST RAR (the full microsoft/aibast-agents-library catalog)
     for an agent.py of a shape SIMILAR to the request.
  2. ACQUIRE the closest match — sha256-verified — and hot-load it as the
     base generation (molt 0).
  3. MUTATE that base to fit the user's exact use case, or GENERATE a new
     agent from scratch when the RAR has no relevant match.
  4. MOLT: every generation is archived on device. A generation that verifies
     is staged; a separate exact-hash activation may make it live after shadow
     and permission policy. A CATASTROPHIC one is refused, quarantined, rolled
     back to the last good molt, and its failure LESSON is returned as chat
     data-exhaust so the next mutation can address it.

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
import time
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256

try:
    from agents.basic_agent import BasicAgent
except Exception:  # pragma: no cover
    from basic_agent import BasicAgent

__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@frontier/molter",
    "version": "1.1.0",
    "display_name": "Capability Forge",
    "description": "Safely acquire or evolve a capability: prefer a verified RAR base, archive immutable generations, stage by default, and activate or roll back only an exact verified generation hash.",
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
ACTIVE_FILE = os.path.join(HOME, "ACTIVE.json")
LOCK_FILE = os.path.join(HOME, ".state.lock")
# The full AIBAST catalog (the RAR the Brainstem searches for a base agent).
AIBAST_REGISTRY = os.environ.get(
    "MOLTER_RAR",
    "https://microsoft.github.io/aibast-agents-library/registry.json")
AIBAST_RAW = "https://raw.githubusercontent.com/microsoft/aibast-agents-library/main/"
# Where a verified generation is hot-loaded so the kernel discovers it: the
# forge's own agents dir (i.e. THIS Brainstem's AGENTS_PATH).
LIVE_DIR = os.path.dirname(os.path.abspath(__file__))
VERIFY_TIMEOUT = 20
BEHAVIOR_TIMEOUT = 10
KNOWN_PERMISSIONS = {
    "read_local", "memory_read", "memory_write", "network", "data_source",
    "write_external", "send", "shell", "credential",
}
ELEVATED_PERMISSIONS = {
    "network", "data_source", "write_external", "send", "shell", "credential",
}
PROCESS_REPLACEMENT_NAMES = {
    "execl", "execle", "execlp", "execlpe", "execv", "execve", "execvp",
    "execvpe", "fork", "forkpty", "posix_spawn", "posix_spawnp", "spawnl",
    "spawnle", "spawnlp", "spawnlpe", "spawnv", "spawnve", "spawnvp",
    "spawnvpe",
}


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


def _atomic_active_pointer(value):
    os.makedirs(HOME, exist_ok=True)
    target = _active_pointer_path(value.get("capability"))
    tmp = target + f".{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(value, fh, indent=2)
    os.replace(tmp, target)


def _active_pointer_path(capability):
    return ACTIVE_FILE.replace(".json", f".{_slug(capability)}.json")


def _clear_active_pointer(capability):
    try:
        os.remove(_active_pointer_path(capability))
    except OSError:
        pass


@contextmanager
def _state_lock(timeout=5):
    """Small cross-platform exclusive-create lock for generation allocation."""
    os.makedirs(HOME, exist_ok=True)
    deadline = time.monotonic() + timeout
    fd = None
    while fd is None:
        try:
            fd = os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.write(fd, f"{os.getpid()}\n".encode())
        except FileExistsError:
            stale = False
            try:
                with open(LOCK_FILE, "r", encoding="utf-8") as fh:
                    owner = int(fh.read().strip())
                try:
                    os.kill(owner, 0)
                except ProcessLookupError:
                    stale = True
                except PermissionError:
                    stale = False
            except Exception:
                try:
                    stale = time.time() - os.path.getmtime(LOCK_FILE) > timeout
                except OSError:
                    stale = True
            if stale:
                try:
                    os.remove(LOCK_FILE)
                except OSError:
                    pass
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError("another adaptation is allocating a generation")
            time.sleep(0.025)
    try:
        yield
    finally:
        try:
            os.close(fd)
        finally:
            try:
                os.remove(LOCK_FILE)
            except OSError:
                pass


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
import builtins
import importlib.util
import os
import shutil
import socket
import subprocess
import sys
import urllib.request

_real_open = builtins.open

def blocked(*_args, **_kwargs):
    raise RuntimeError("shadow side effects are disabled")

def read_only_open(file, mode="r", *args, **kwargs):
    if any(flag in str(mode) for flag in ("w", "a", "x", "+")):
        raise RuntimeError("shadow filesystem writes are disabled")
    return _real_open(file, mode, *args, **kwargs)

builtins.open = read_only_open
socket.create_connection = blocked
socket.socket.connect = blocked
urllib.request.urlopen = blocked
os.system = blocked
os.popen = blocked
for name in ("remove", "unlink", "rename", "replace", "mkdir", "makedirs", "rmdir"):
    setattr(os, name, blocked)
for name in ("copy", "copy2", "copyfile", "move", "rmtree"):
    setattr(shutil, name, blocked)
for name in ("Popen", "call", "check_call", "check_output", "run"):
    setattr(subprocess, name, blocked)

def audit(event, args):
    if event == "open":
        flags = args[2] if len(args) > 2 and isinstance(args[2], int) else 0
        write_flags = (
            os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)
        if flags & write_flags:
            raise RuntimeError("shadow filesystem writes are disabled")
    if (event.startswith("socket.")
            or event in {
                "subprocess.Popen", "os.system", "os.remove", "os.rename",
                "os.mkdir", "os.rmdir", "os.exec", "os.fork",
                "os.posix_spawn", "ctypes.dlopen",
            }):
        raise RuntimeError("shadow side effects are disabled")

sys.addaudithook(audit)
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
    memory = 256 * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
except Exception:
    pass

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
            for target in node.targets:
                if (isinstance(target, ast.Attribute)
                        and isinstance(target.value, ast.Name)
                        and target.value.id == "self"
                        and target.attr == "name"
                        and isinstance(node.value, ast.Constant)
                        and isinstance(node.value.value, str)
                        and node.value.value.strip()):
                    return node.value.value
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
_EXIT_CALLS = {
    ("sys", "exit"),
    ("os", "_exit"),
    ("os", "abort"),
    ("os", "kill"),
    ("os", "execl"),
    ("os", "execle"),
    ("os", "execlp"),
    ("os", "execlpe"),
    ("os", "execv"),
    ("os", "execve"),
    ("os", "execvp"),
    ("os", "execvpe"),
    ("os", "fork"),
    ("os", "forkpty"),
    ("os", "posix_spawn"),
    ("os", "posix_spawnp"),
    ("os", "spawnl"),
    ("os", "spawnle"),
    ("os", "spawnlp"),
    ("os", "spawnlpe"),
    ("os", "spawnv"),
    ("os", "spawnve"),
    ("os", "spawnvp"),
    ("os", "spawnvpe"),
}
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


def _validate_permissions(permissions):
    declared = sorted(set(str(item) for item in (permissions or [])))
    unknown = [item for item in declared if item not in KNOWN_PERMISSIONS]
    if unknown:
        return False, f"unknown declared permission: {unknown[0]}"
    return True, declared


def _validate_behavior_contract(contract):
    if contract is None:
        return True, None
    if not isinstance(contract, dict) or not str(contract.get("name", "")).strip():
        return False, "behavior contract needs a name"
    if not isinstance(contract.get("input_schema"), dict):
        return False, "behavior contract needs input_schema"
    if not isinstance(contract.get("output_schema"), dict):
        return False, "behavior contract needs output_schema"
    cases = contract.get("cases")
    if not isinstance(cases, list) or not 2 <= len(cases) <= 20:
        return False, "behavior contract needs 2-20 bounded golden cases"
    for case in cases:
        if (not isinstance(case, dict) or not str(case.get("id", "")).strip()
                or "input" not in case or "expect" not in case):
            return False, "every behavior case needs id, input, and expect"
    return True, None


def _behavior_ast_verdict(source, permissions):
    """Permission/static checks used only when behavior execution is requested."""
    tree = ast.parse(source)
    allowed = set(permissions or [])
    imports = set()
    required_permissions = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imports.add(node.module.split(".")[0])
        elif isinstance(node, ast.Call):
            fn = node.func
            if isinstance(fn, ast.Name) and fn.id in (
                    "__import__", "eval", "exec", "compile"):
                return False, (
                    f"dynamic code operation {fn.id}() is not statically "
                    "permission-verifiable")
            if isinstance(fn, ast.Name) and fn.id == "open":
                mode = (
                    node.args[1].value
                    if len(node.args) > 1
                    and isinstance(node.args[1], ast.Constant)
                    and isinstance(node.args[1].value, str)
                    else "r")
                required_permissions.add(
                    "write_external"
                    if any(flag in mode for flag in ("w", "a", "x", "+"))
                    else "read_local")
            if (isinstance(fn, ast.Name) and fn.id == "getattr"
                    and not (allowed & ELEVATED_PERMISSIONS)):
                return False, (
                    "dynamic attribute lookup is not permission-verifiable "
                    "without an elevated permission profile")
            if isinstance(fn, ast.Attribute) and fn.attr == "open":
                required_permissions.add("write_external")
            if isinstance(fn, ast.Attribute) and fn.attr in PROCESS_REPLACEMENT_NAMES:
                return False, (
                    f"{fn.attr}() is forbidden in a behavior-tested candidate "
                    "because it can replace the verifier process")
            if (isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name)
                    and (fn.value.id, fn.attr) in _EXIT_CALLS):
                return False, (
                    f"{fn.value.id}.{fn.attr}() is forbidden in a behavior-tested "
                    "candidate because it can spoof the verifier process exit")
            if isinstance(fn, ast.Name) and fn.id in ("exit", "quit"):
                return False, (
                    f"{fn.id}() is forbidden in a behavior-tested candidate")
            if isinstance(fn, ast.Name) and fn.id in PROCESS_REPLACEMENT_NAMES:
                return False, (
                    f"{fn.id}() is forbidden in a behavior-tested candidate "
                    "because it can replace the verifier process")
        elif isinstance(node, ast.Attribute):
            if node.attr in ("__dict__", "__getattribute__") and not (
                    allowed & ELEVATED_PERMISSIONS):
                return False, (
                    "dynamic attribute access is not permission-verifiable "
                    "without an elevated permission profile")
            if node.attr in ("environ", "getenv", "putenv", "unsetenv"):
                required_permissions.add("credential")
            if node.attr in (
                    "system", "popen", "Popen", "run", "call", "check_call",
                    "check_output"):
                required_permissions.add("shell")
        elif isinstance(node, ast.Raise):
            exc = node.exc
            name = (
                exc.func.id
                if isinstance(exc, ast.Call) and isinstance(exc.func, ast.Name)
                else exc.id if isinstance(exc, ast.Name) else None)
            if name in ("SystemExit", "KeyboardInterrupt"):
                return False, (
                    f"raise {name} is forbidden in a behavior-tested candidate "
                    "because it can spoof the verifier process exit")
    network_modules = {"requests", "urllib", "http", "socket", "msal"}
    shell_modules = {"subprocess", "pty", "shutil"}
    dynamic_modules = {"importlib", "ctypes"}
    if imports & dynamic_modules:
        return False, (
            "candidate imports dynamic code/native loading support that cannot "
            "be permission-verified")
    if imports & network_modules:
        required_permissions.add("network")
    if imports & shell_modules:
        required_permissions.add("shell")
    missing = sorted(required_permissions - allowed)
    if missing:
        return False, (
            "candidate behavior requires undeclared permission(s): "
            + ", ".join(missing))
    return True, None


_BEHAVIOR_HARNESS = r'''
import builtins
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import urllib.request

SUCCESS = 73

def blocked(*_args, **_kwargs):
    raise RuntimeError("shadow network is disabled")

socket.create_connection = blocked
socket.socket.connect = blocked
urllib.request.urlopen = blocked
os.environ.clear()
os.environ.update({
    "MOLTER_SHADOW": "1",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONUTF8": "1",
})

try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
    memory = 256 * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
except Exception:
    pass

def parse_output(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return value
    return value

def ready_only(value):
    if not isinstance(value, dict) or not value:
        return False
    allowed = {"status", "message", "ready", "ack", "acknowledged"}
    if any(key not in allowed for key in value):
        return False
    marker = str(value.get("status") or value.get("message") or "").lower()
    return marker in {"ready", "ok", "accepted", "acknowledged"}

def matches_schema(value, schema):
    if not isinstance(schema, dict):
        return True
    expected = schema.get("type")
    allowed = expected if isinstance(expected, list) else [expected]
    observed = (
        "null" if value is None
        else "boolean" if isinstance(value, bool)
        else "integer" if isinstance(value, int)
        else "number" if isinstance(value, float)
        else "array" if isinstance(value, list)
        else "object" if isinstance(value, dict)
        else "string" if isinstance(value, str)
        else type(value).__name__
    )
    if expected and observed not in allowed and not (
            observed == "integer" and "number" in allowed):
        return False
    if isinstance(value, dict):
        if any(key not in value for key in schema.get("required", [])):
            return False
        for key, child in schema.get("properties", {}).items():
            if key in value and not matches_schema(value[key], child):
                return False
    if isinstance(value, list) and schema.get("items"):
        return all(matches_schema(item, schema["items"]) for item in value)
    return True

def matches(value, expect):
    if not isinstance(expect, dict):
        return value == expect
    if not isinstance(value, dict):
        return False
    if "status" in expect and value.get("status") != expect["status"]:
        return False
    minimum = expect.get("minimum_messages")
    if minimum is not None:
        messages = value.get("messages")
        if not isinstance(messages, list) or len(messages) < int(minimum):
            return False
    for key, wanted in expect.items():
        if key == "minimum_messages":
            continue
        if key in value and value[key] != wanted:
            return False
    return True

def main():
    candidate, class_name, contract_path = sys.argv[1:4]
    contract = json.load(open(contract_path, encoding="utf-8"))
    real_open = builtins.open
    def read_only_open(file, mode="r", *args, **kwargs):
        if any(flag in str(mode) for flag in ("w", "a", "x", "+")):
            raise RuntimeError("shadow filesystem writes are disabled")
        return real_open(file, mode, *args, **kwargs)
    builtins.open = read_only_open
    os.system = blocked
    os.popen = blocked
    for name in ("remove", "unlink", "rename", "replace", "mkdir", "makedirs", "rmdir"):
        setattr(os, name, blocked)
    for name in ("copy", "copy2", "copyfile", "move", "rmtree"):
        setattr(shutil, name, blocked)
    for name in ("Popen", "call", "check_call", "check_output", "run"):
        setattr(subprocess, name, blocked)
    def audit(event, args):
        if event == "open":
            flags = args[2] if len(args) > 2 and isinstance(args[2], int) else 0
            write_flags = (
                os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)
            if flags & write_flags:
                raise RuntimeError("shadow filesystem writes are disabled")
        if (event.startswith("socket.")
                or event in {
                    "subprocess.Popen", "os.system", "os.remove", "os.rename",
                    "os.mkdir", "os.rmdir", "os.exec", "os.fork",
                    "os.posix_spawn", "ctypes.dlopen",
                }):
            raise RuntimeError("shadow side effects are disabled")
    sys.addaudithook(audit)
    spec = importlib.util.spec_from_file_location("_molter_shadow", candidate)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    cls = vars(module).get(class_name)
    agent = cls()
    outputs = []
    for case in contract["cases"]:
        if not matches_schema(case["input"], contract["input_schema"]):
            raise SystemExit(23)
        value = parse_output(agent.perform(**dict(case["input"])))
        if (ready_only(value)
                or not matches_schema(value, contract["output_schema"])
                or not matches(value, case["expect"])):
            raise SystemExit(21)
        outputs.append(json.dumps(value, sort_keys=True, default=str))
    raise SystemExit(SUCCESS)

if __name__ == "__main__":
    main()
'''


def _verify(source, behavior_contract=None, permissions=None):
    """Return (ok, detail). The pass/fail VERDICT is decided by the trusted parent
    from a static AST analysis of the source (never executed here). A disposable
    subprocess additionally confirms the source imports and instantiates cleanly —
    a *correctness* signal read only from the child's EXIT STATUS, never from any
    byte the child writes — so a candidate cannot forge a pass by what it prints,
    by pre-empting a report channel, or by calling os._exit(). Fail-closed."""
    ok, reason = _validate_behavior_contract(behavior_contract)
    if not ok:
        return False, {"stage": "contract", "lesson": reason}
    ok, permission_detail = _validate_permissions(permissions)
    if not ok:
        return False, {"stage": "permissions", "lesson": permission_detail}
    declared_permissions = permission_detail
    ok, reason, info = _ast_agent_verdict(source)
    if not ok:
        return False, {"stage": "ast", "lesson": reason}
    if behavior_contract is not None:
        ok, reason = _behavior_ast_verdict(source, declared_permissions)
        if not ok:
            return False, {"stage": "permissions", "lesson": reason}

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
        env = {
            "HOME": td,
            "PATH": os.environ.get("PATH", ""),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUTF8": "1",
        }
        for key in ("SystemRoot", "WINDIR"):
            if os.environ.get(key):
                env[key] = os.environ[key]
        # basic_agent must resolve; expose the same shim path the kernel uses
        env["PYTHONPATH"] = os.pathsep.join(
            [td, LIVE_DIR, os.path.dirname(LIVE_DIR)]
            + os.environ.get("PYTHONPATH", "").split(os.pathsep))
        try:
            r = subprocess.run(
                [sys.executable, loader, cand, info["agent_class"]],
                capture_output=True, timeout=VERIFY_TIMEOUT, env=env, cwd=td)
        except subprocess.TimeoutExpired:
            return fail(
                f"candidate did not finish loading within {VERIFY_TIMEOUT}s "
                "(likely an infinite loop or blocking call at import time)")
        except OSError as e:
            return fail(f"loader could not start: {type(e).__name__}: {e}")

        if r.returncode != 0:
            return fail(
                f"candidate failed to load cleanly (exit code {r.returncode})")

        # Never consume candidate stdout/stderr as metadata: untrusted source
        # could otherwise turn verifier output into a file-exfiltration channel.
        runtime_name = info["agent_class"]

        if behavior_contract is not None:
            contract_path = os.path.join(td, "contract.json")
            behavior_loader = os.path.join(td, "behavior.py")
            with open(contract_path, "w", encoding="utf-8") as fh:
                json.dump(behavior_contract, fh)
            with open(behavior_loader, "w", encoding="utf-8") as fh:
                fh.write(_BEHAVIOR_HARNESS)
            shadow_env = {
                "HOME": td,
                "PATH": os.environ.get("PATH", ""),
                "PYTHONPATH": env["PYTHONPATH"],
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONUTF8": "1",
            }
            for key in ("SystemRoot", "WINDIR"):
                if os.environ.get(key):
                    shadow_env[key] = os.environ[key]
            try:
                behavior = subprocess.run(
                    [sys.executable, behavior_loader, cand,
                     info["agent_class"], contract_path],
                     capture_output=True, timeout=BEHAVIOR_TIMEOUT,
                     env=shadow_env, cwd=td)
            except subprocess.TimeoutExpired:
                return False, {
                    "stage": "behavior",
                    "lesson": "shadow behavior exceeded the resource timeout",
                }
            except OSError as e:
                return False, {
                    "stage": "behavior",
                    "lesson": f"shadow process could not start: {type(e).__name__}: {e}",
                }
            if behavior.returncode != 73:
                labels = {
                    21: "golden case failed or returned a ready-only acknowledgement",
                    22: "stub detector found constant output for meaningful inputs",
                    23: "golden case input violates input_schema",
                }
                return False, {
                    "stage": "behavior",
                    "lesson": labels.get(
                        behavior.returncode,
                        f"shadow process exited {behavior.returncode}"),
                }

    detail = {
        "ok": True,
        "agent_class": info["agent_class"],
        "tool_name": info["tool_name"] or runtime_name or info["agent_class"],
    }
    if behavior_contract is not None or permissions is not None:
        detail["permissions"] = declared_permissions
        detail["behavior_contract_sha256"] = (
            sha256(json.dumps(
                behavior_contract, sort_keys=True, separators=(",", ":"),
            ).encode()).hexdigest()
            if behavior_contract is not None else None
        )
    return True, detail


class MolterAgent(BasicAgent):
    def __init__(self):
        self.name = "Molter"
        self.metadata = {
            "name": self.name,
            "description": (
                "Autonomously acquire/evolve a Brainstem capability. Actions: search_capability "
                "(find shape-similar agents in the AIBAST RAR), acquire/mutate/generate "
                "(verify and archive an immutable staged generation), activate (materialize one "
                "exact verified generation/hash after the controller's policy/approval gate), "
                "rollback (restore a last-known-good verified molt), molt_log, status. "
                "Headless — drive it over /chat. Staging is the default; activation is explicit."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": [
                        "search_capability", "acquire", "mutate", "generate",
                        "activate", "rollback", "molt_log", "status"]},
                    "request": {"type": "string", "description": "The capability the user needs, in plain words (search_capability/generate)."},
                    "capability": {"type": "string", "description": "A short slug naming the capability being forged (acquire/mutate/generate)."},
                    "agent_name": {"type": "string", "description": "acquire: the RAR agent name to pull as the base (from search_capability results)."},
                    "source": {"type": "string", "description": "mutate/generate: the FULL agent.py source the Brainstem's LLM produced. This agent verifies it before it ever goes live."},
                    "note": {"type": "string", "description": "mutate/generate: one line on what this generation changed/attempts (recorded on the molt)."},
                    "to_generation": {"type": "integer", "description": "rollback: molt generation to restore (default: the last good one before the current)."},
                    "generation_hash": {"type": "string", "description": "activate: exact staged generation sha256."},
                    "expected_base_hash": {"type": "string", "description": "activate: exact active base hash observed when staging (empty for no base)."},
                    "behavior_contract": {"type": "object", "description": "Complete behavior contract with input/output schemas and 2-20 bounded golden cases."},
                    "permissions": {"type": "array", "items": {"type": "string"}, "description": "Complete declared permission set for this generation."},
                    "top_k": {"type": "integer", "description": "search_capability: how many candidates to return (default 5)."},
                },
                "required": ["action"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    # ---- helpers -----------------------------------------------------------
    def _cap_dir(self, cap):
        return os.path.join(MOLTS, _slug(cap))

    def _record_molt(self, cap, source, verdict, note, parent, kind,
                     behavior_contract=None, permissions=None):
        d = self._cap_dir(cap)
        digest = sha256(source.encode()).hexdigest()
        with _state_lock():
            st = _load_state()
            entry = st["capabilities"].setdefault(
                _slug(cap),
                {"live_generation": None, "molts": [], "quarantine": []})
            on_disk = []
            try:
                on_disk = [
                    int(name[4:]) for name in os.listdir(d)
                    if re.fullmatch(r"gen-\d+", name)]
            except OSError:
                pass
            gen = max(
                [len(entry["molts"]) - 1] + on_disk,
                default=-1,
            ) + 1
            gdir = os.path.join(d, f"gen-{gen:03d}")
            os.makedirs(d, exist_ok=True)
            os.mkdir(gdir, 0o700)
            meta = {
                "schema": "molter-generation/2.0",
                "generation": gen,
                "kind": kind,
                "note": (note or "").strip(),
                "parent": parent,
                "base_hash": (
                    entry["molts"][parent]["sha256"]
                    if isinstance(parent, int) and 0 <= parent < len(entry["molts"])
                    else None),
                "at": _now(),
                "verdict": "verified" if verdict[0] else "catastrophic",
                "activation": "staged" if verdict[0] else "quarantined",
                "detail": verdict[1],
                "sha256": digest,
                "behavior_contract": behavior_contract,
                "behavior_contract_sha256": (
                    sha256(json.dumps(
                        behavior_contract, sort_keys=True,
                        separators=(",", ":")).encode()).hexdigest()
                    if behavior_contract is not None else None),
                "permissions": sorted(set(permissions or [])),
            }
            try:
                with open(os.path.join(gdir, "agent.py"), "x", encoding="utf-8") as fh:
                    fh.write(source)
                with open(os.path.join(gdir, "molt.json"), "x", encoding="utf-8") as fh:
                    json.dump(meta, fh, indent=2)
                try:
                    os.chmod(os.path.join(gdir, "agent.py"), 0o400)
                    os.chmod(os.path.join(gdir, "molt.json"), 0o400)
                except OSError:
                    pass
            except Exception:
                try:
                    for name in os.listdir(gdir):
                        try:
                            os.chmod(os.path.join(gdir, name), 0o600)
                            os.remove(os.path.join(gdir, name))
                        except OSError:
                            pass
                    os.rmdir(gdir)
                except OSError:
                    pass
                raise
            entry["molts"].append(meta)
            if not verdict[0]:
                entry.setdefault("quarantine", []).append({
                    "generation": gen,
                    "sha256": digest,
                    "at": _now(),
                    "lesson": str(verdict[1].get("lesson", "verification failed"))[:600],
                })
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

    def _go_live(self, cap, source, tool_name, generation, generation_hash=None,
                 expected_base_hash=None):
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
        digest = sha256(source.encode()).hexdigest()
        exact_hash = generation_hash or digest
        filename = _safe_agent_name(f"{_slug(cap)}_agent.py", cap)
        live_path = os.path.join(LIVE_DIR, filename)
        with _state_lock():
            st = _load_state()
            entry = st["capabilities"].get(_slug(cap))
            if not entry or not 0 <= int(generation) < len(entry.get("molts", [])):
                raise RuntimeError("activation requires an archived generation")
            meta = entry["molts"][int(generation)]
            if (meta.get("verdict") != "verified"
                    or meta.get("sha256") != digest or exact_hash != digest):
                raise RuntimeError(
                    "activation hash does not match the exact verified generation")
            active = entry.get("live_generation")
            current_base = (
                entry["molts"][active].get("sha256")
                if isinstance(active, int) and 0 <= active < len(entry["molts"])
                else None)
            if expected_base_hash is not None and expected_base_hash != current_base:
                raise RuntimeError("stale activation base; the active generation changed")
            tmp = live_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(source)
            os.replace(tmp, live_path)
            os.chmod(live_path, 0o600)
            prior = entry.get("live_generation")
            entry["live_generation"] = generation
            entry["last_known_good_generation"] = generation
            entry["prior_live_generation"] = prior
            activated = entry.setdefault("activated_generations", [])
            if generation not in activated:
                activated.append(generation)
            entry["live_file"] = filename
            entry["live_tool"] = tool_name
            entry["live_sha256"] = digest
            _save_state(st)
        _atomic_active_pointer({
            "schema": "molter-active-pointer/1.0",
            "capability": _slug(cap),
            "generation": generation,
            "sha256": digest,
            "live_file": filename,
        })
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
            with _state_lock():
                st = _load_state()
                changed = False
                for slug, entry in (st.get("capabilities") or {}).items():
                    gen = entry.get("live_generation")
                    filename = entry.get("live_file")
                    if gen is None or not filename:
                        continue

                    def materialize(target):
                        if (not isinstance(target, int)
                                or not 0 <= target < len(entry.get("molts", []))
                                or target not in set(
                                    entry.get("activated_generations") or [])):
                            raise RuntimeError(
                                "generation was never a healthy active head")
                        meta = entry["molts"][target]
                        if meta.get("verdict") != "verified":
                            raise RuntimeError("generation is not verified")
                        archived = os.path.join(
                            MOLTS, slug, f"gen-{target:03d}", "agent.py")
                        if os.path.islink(archived):
                            raise RuntimeError("archived generation is a symlink")
                        with open(archived, "r", encoding="utf-8") as fh:
                            source = fh.read()
                        digest = sha256(source.encode()).hexdigest()
                        if digest != meta.get("sha256"):
                            raise RuntimeError(
                                "archived generation hash is tampered")
                        live_path = os.path.join(LIVE_DIR, filename)
                        if os.path.exists(live_path):
                            with open(live_path, "r", encoding="utf-8") as fh:
                                if sha256(fh.read().encode()).hexdigest() == digest:
                                    return digest, meta, False
                        tmp = live_path + ".tmp"
                        with open(tmp, "w", encoding="utf-8") as fh:
                            fh.write(source)
                        os.replace(tmp, live_path)
                        os.chmod(live_path, 0o600)
                        return digest, meta, True

                    try:
                        if entry.get("last_known_good_generation", gen) != gen:
                            raise RuntimeError(
                                "active generation is not last-known-good")
                        digest, meta, wrote = materialize(int(gen))
                        if digest != entry.get("live_sha256", digest):
                            raise RuntimeError(
                                "active generation digest disagrees with state")
                        _atomic_active_pointer({
                            "schema": "molter-active-pointer/1.0",
                            "capability": slug,
                            "generation": gen,
                            "sha256": digest,
                            "live_file": filename,
                        })
                        if wrote:
                            restored.append(f"{slug} (generation {gen})")
                    except Exception as error:
                        entry.setdefault("quarantine", []).append({
                            "generation": gen,
                            "sha256": entry.get("live_sha256"),
                            "at": _now(),
                            "lesson": f"rehydration refused: {str(error)[:400]}",
                        })
                        prior = entry.get("prior_live_generation")
                        try:
                            digest, meta, _wrote = materialize(prior)
                            entry["live_generation"] = prior
                            entry["last_known_good_generation"] = prior
                            entry["prior_live_generation"] = None
                            entry["live_sha256"] = digest
                            entry["live_tool"] = (
                                meta.get("detail", {}).get("tool_name")
                                or entry.get("live_tool")
                                or slug)
                            _atomic_active_pointer({
                                "schema": "molter-active-pointer/1.0",
                                "capability": slug,
                                "generation": prior,
                                "sha256": digest,
                                "live_file": filename,
                            })
                            restored.append(
                                f"{slug} (generation {prior}, last-known-good fallback)")
                        except Exception as fallback_error:
                            try:
                                os.remove(os.path.join(LIVE_DIR, filename))
                            except OSError:
                                pass
                            entry["live_generation"] = None
                            entry["last_known_good_generation"] = None
                            entry["prior_live_generation"] = None
                            entry["live_sha256"] = None
                            entry["live_tool"] = None
                            _clear_active_pointer(slug)
                            entry["quarantine"].append({
                                "generation": prior,
                                "sha256": None,
                                "at": _now(),
                                "lesson": (
                                    "last-known-good fallback refused: "
                                    f"{str(fallback_error)[:400]}"),
                            })
                        changed = True
                if changed:
                    _save_state(st)
        except Exception:
            return restored
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
                "activate": self._activate,
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
                     "I verify and stage it as molt 0; activation is a separate exact-hash step.")
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
        contract = a.get("behavior_contract")
        permissions = a.get("permissions")
        legacy_compat = os.environ.get("MOLTER_LEGACY_COMPAT") == "1"
        if ((contract is None or not isinstance(permissions, list))
                and not legacy_compat):
            return (
                "acquire requires a complete behavior_contract and declared "
                "permissions list. A host operator may temporarily set "
                "MOLTER_LEGACY_COMPAT=1 for a deliberate legacy migration.")
        verdict = _verify(source, contract, permissions)
        gen, meta = self._record_molt(cap, source, verdict, f"acquired base {name} (sha {digest[:12]})",
                                      parent=None, kind="acquisition",
                                      behavior_contract=contract,
                                      permissions=permissions)
        if not verdict[0]:
            return (f"Acquired {name} as molt {gen} but it did NOT smoke-load here "
                    f"(lesson: {verdict[1].get('lesson')}). It is archived but NOT live. "
                    "You can still mutate from its source with action=mutate.")
        if (legacy_compat
                and not (set(meta.get("permissions") or []) & ELEVATED_PERMISSIONS)):
            self._go_live(
                cap, source, verdict[1].get("tool_name", cap), gen,
                generation_hash=meta["sha256"])
            return (
                f"Compatibility activation: {name} generation {gen} is LIVE "
                f"for '{_slug(cap)}' at sha256 {meta['sha256']}.")
        return (
            f"Acquired and STAGED {name} as generation {gen} for '{_slug(cap)}' "
            f"(tool '{verdict[1].get('tool_name')}', sha256 {meta['sha256']}). "
            "It is not live. The adaptation controller must shadow-verify permissions "
            "and activate this exact generation/hash.")

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
        contract = a.get("behavior_contract")
        permissions = a.get("permissions")
        legacy_compat = os.environ.get("MOLTER_LEGACY_COMPAT") == "1"
        if ((contract is None or not isinstance(permissions, list))
                and not legacy_compat):
            return (
                f"{kind} requires a complete behavior_contract and declared "
                "permissions list. A host operator may temporarily set "
                "MOLTER_LEGACY_COMPAT=1 for a deliberate legacy migration.")
        verdict = _verify(source, contract, permissions)
        parent = None
        st = _load_state()
        entry = st["capabilities"].get(_slug(cap))
        if entry and entry.get("molts"):
            parent = entry.get("live_generation", len(entry["molts"]) - 1)
        gen, meta = self._record_molt(
            cap, source, verdict, note, parent=parent, kind=kind,
            behavior_contract=contract, permissions=permissions)
        if verdict[0]:
            if (legacy_compat
                    and not (set(meta.get("permissions") or []) & ELEVATED_PERMISSIONS)):
                self._go_live(
                    cap, source, verdict[1].get("tool_name", cap), gen,
                    generation_hash=meta["sha256"])
                return (
                    f"Compatibility activation: generation {gen} VERIFIED and LIVE "
                    f"for '{_slug(cap)}' at sha256 {meta['sha256']}.")
            return (
                f"Generation {gen} VERIFIED and STAGED for '{_slug(cap)}' "
                f"(tool '{verdict[1].get('tool_name')}', sha256 {meta['sha256']}). "
                "It is not live. Activate only by exact generation/hash after shadow "
                "verification and any required human approval.")
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

    def _activate(self, a):
        cap = (a.get("capability") or "").strip()
        generation = a.get("to_generation")
        generation_hash = (a.get("generation_hash") or "").strip().lower()
        if not cap or generation is None or not re.fullmatch(r"[0-9a-f]{64}", generation_hash):
            return (
                "activate needs capability, to_generation, and the exact 64-character "
                "generation_hash from the staged molt.")
        st = _load_state()
        entry = st["capabilities"].get(_slug(cap))
        if not entry or not 0 <= int(generation) < len(entry.get("molts", [])):
            return f"No archived generation {generation} for '{_slug(cap)}'."
        meta = entry["molts"][int(generation)]
        if meta.get("verdict") != "verified" or meta.get("sha256") != generation_hash:
            return "REFUSED: generation/hash is not an exact verified staged molt."
        if (not (meta.get("behavior_contract_sha256")
                 or meta.get("behavior_contract_hash"))
                or not isinstance(meta.get("permissions"), list)):
            if os.environ.get("MOLTER_LEGACY_COMPAT") != "1":
                return (
                    "REFUSED: generation predates behavior-contract/permission "
                    "attestation; only a trusted host operator can migrate it.")
        elevated = sorted(
            set(meta.get("permissions") or []) & ELEVATED_PERMISSIONS)
        if elevated:
            return (
                "REFUSED: elevated permissions require exact action-bound human UI "
                "approval through the Twin Adaptation Controller; a chat agent cannot "
                "approve or activate them (" + ", ".join(elevated) + ").")
        gdir = os.path.join(self._cap_dir(cap), f"gen-{int(generation):03d}")
        source_path = os.path.join(gdir, "agent.py")
        if os.path.islink(source_path):
            return "REFUSED: archived source is a symlink."
        source = open(source_path, encoding="utf-8").read()
        if sha256(source.encode()).hexdigest() != generation_hash:
            return "REFUSED: archived generation was tampered after verification."
        expected = a.get("expected_base_hash") if "expected_base_hash" in a else None
        self._go_live(
            cap, source, meta.get("detail", {}).get("tool_name", cap),
            int(generation), generation_hash=generation_hash,
            expected_base_hash=expected)
        return (
            f"Activated exact generation {generation} for '{_slug(cap)}' "
            f"at sha256 {generation_hash}. It is LIVE.")

    def _restore_last_good(self, cap):
        st = _load_state()
        entry = st["capabilities"].get(_slug(cap))
        if not entry:
            return None
        activated = set(entry.get("activated_generations") or [])
        for m in reversed(entry["molts"][:-1]):   # skip the just-failed one
            if (m["verdict"] == "verified"
                    and m["generation"] in activated):
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
            with _state_lock():
                current = _load_state()
                current_entry = current["capabilities"].get(_slug(cap))
                if current_entry:
                    current_entry["live_generation"] = None
                    current_entry["last_known_good_generation"] = None
                    current_entry["live_sha256"] = None
                    _save_state(current)
            _clear_active_pointer(cap)
        return None

    def _rollback(self, a):
        cap = (a.get("capability") or "").strip()
        st = _load_state()
        entry = st["capabilities"].get(_slug(cap))
        if not entry or not entry["molts"]:
            return f"No molts for '{_slug(cap)}' to roll back to."
        target = a.get("to_generation")
        activated = set(entry.get("activated_generations") or [])
        candidates = [
            m for m in entry["molts"]
            if m["verdict"] == "verified" and m["generation"] in activated]
        if target is not None:
            m = next((x for x in entry["molts"] if x["generation"] == int(target)), None)
            if (not m or m["verdict"] != "verified"
                    or m["generation"] not in activated):
                return (
                    f"Generation {target} is not a previously healthy active molt; "
                    "pick a last-known-good generation from molt_log.")
        else:
            live_generation = entry.get("live_generation")
            earlier = [
                candidate for candidate in candidates
                if isinstance(live_generation, int)
                and candidate["generation"] < live_generation
            ]
            m = max(
                earlier,
                key=lambda candidate: candidate["generation"],
                default=None,
            )
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
            detail = m.get("detail") or {}
            lesson = f" — {detail.get('lesson')}" if m.get("verdict") == "catastrophic" else ""
            lines.append(
                f"  gen {m.get('generation')} [{m.get('kind', 'adaptation')}] "
                f"{m.get('verdict', 'unknown')}{live}: {m.get('note', '') or ''}{lesson}")
        return "\n".join(lines)

    def _status(self, a):
        st = _load_state()
        caps = {k: {"live_generation": v.get("live_generation"), "molts": len(v["molts"]),
                    "live_tool": v.get("live_tool"),
                    "live_sha256": v.get("live_sha256"),
                    "staged_generations": [
                        m["generation"] for m in v["molts"]
                        if m.get("verdict") == "verified"
                        and m["generation"] != v.get("live_generation")],
                    "quarantined_generations": [
                        item.get("generation") for item in v.get("quarantine", [])]}
                for k, v in st["capabilities"].items()}
        return json.dumps({"forge_home": HOME, "live_dir": LIVE_DIR, "rar": AIBAST_REGISTRY,
                           "capabilities": caps}, indent=2)
