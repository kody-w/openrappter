#!/usr/bin/env python3
"""
OpenRappter — RAPP conformance gate.

OpenRappter is an organism built on RAPP. RAPP is the open, MIT-licensed
substrate (kody-w/rapp-1); this repository is the organism that stands on it.
Being "built on RAPP" is a claim, and a claim needs a gate, or it decays into a
sentence in a README that stopped being true six months ago.

Each check proves a property against the code, not against documentation.

    python3 conformance.py            # human-readable
    python3 conformance.py --json     # for CI

Exit codes:  0 all passed  |  1 one or more failed  |  2 could not run
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
# Every agent-shaped file in the repository, in every language. An earlier
# version of this gate pointed only at the Python agents directory — which was
# the one directory that had just been brought into conformance. A gate scoped
# to the work already done reports green and proves nothing.
AGENT_DIRS = [
    os.path.join(ROOT, "python", "openrappter", "agents"),
    os.path.join(ROOT, "typescript", "src", "agents"),
    os.path.join(ROOT, "agents"),
]
AGENTS = AGENT_DIRS[0]  # python dir, for checks that are python-specific
BRAINSTEM = os.path.join(ROOT, "python", "openrappter", "brainstem.py")

AGENT_SCHEMA = "rapp-agent/1.0"

# The five capability classes of the RAPP strain contract (kody-w/rapp-light).
# Kept in step with that repo deliberately: an OpenRappter agent should be
# governable by an enterprise strain without translation.
CAPABILITY_EVIDENCE = {
    "network": {
        "modules": {"socket", "http", "urllib", "urllib3", "requests", "httpx",
                    "ftplib", "smtplib", "telnetlib", "websocket", "websockets",
                    "aiohttp", "xmlrpc", "paramiko", "boto3", "azure"},
        "calls": {"urllib.request.urlopen", "request.urlopen", "urlopen",
                  "socket.create_connection", "requests.get", "requests.post"},
    },
    "process-exec": {
        "modules": {"subprocess", "pty"},
        "calls": {"os.system", "os.popen", "os.spawnl", "os.spawnv", "os.execv",
                  "os.execve", "os.execvp", "os.fork", "subprocess.run",
                  "subprocess.call", "subprocess.check_output",
                  "subprocess.check_call", "subprocess.Popen"},
    },
    "credential-access": {
        "modules": {"keyring", "netrc", "getpass"},
        "calls": {"os.getenv", "os.environ.get", "getpass.getpass"},
        "attrs": {"environ"},
    },
    "filesystem-write": {
        "modules": {"shutil"},
        "calls": {"os.remove", "os.unlink", "os.rename", "os.replace",
                  "os.mkdir", "os.makedirs", "os.rmdir", "os.chmod", "os.chown",
                  "os.symlink", "os.truncate", "shutil.rmtree", "shutil.move",
                  "shutil.copy", "shutil.copytree", "shutil.copyfile",
                  "pathlib.Path.write_text", "Path.write_text",
                  "Path.write_bytes", "write_text", "write_bytes"},
    },
    "dynamic-code": {
        "modules": {"ctypes", "marshal", "pickle"},
        "calls": {"importlib.import_module", "pickle.loads", "pickle.load",
                  "marshal.loads", "ctypes.CDLL"},
        "builtins": {"eval", "exec", "compile", "__import__"},
    },
}

CHECKS = []


def check(cid, claim):
    def decorate(fn):
        fn._cid, fn._claim = cid, claim
        CHECKS.append(fn)
        return fn
    return decorate


def agent_files():
    """Python agents only — the checks that parse a syntax tree."""
    if not os.path.isdir(AGENTS):
        return []
    return [os.path.join(AGENTS, f) for f in sorted(os.listdir(AGENTS))
            if f.endswith("_agent.py") and f != "basic_agent.py"]


def all_agent_files():
    """Every agent in the repo, whatever language it is written in."""
    out = []
    for d in AGENT_DIRS:
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            # The abstract base class is not an agent, in either language.
            # Matched case-insensitively: the Python file is basic_agent.py and
            # the TypeScript one is BasicAgent.ts.
            if f.lower() in ("basic_agent.py", "basicagent.ts", "index.ts",
                             "types.ts", "agentregistry.ts"):
                continue
            if f.endswith(("_agent.py", "_agent.ts", "_agent.js",
                           "Agent.ts", "Agent.js")):
                out.append(os.path.join(d, f))
    return out


def dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def observed_capabilities(path):
    """What this file can actually reach, read out of its syntax tree.

    Calls are matched on their qualified name (`os.system`, `pickle.loads`) and,
    for the handful of table entries that are deliberately bare, on the final
    attribute alone. The bare set is kept deliberately small — `write_text`,
    `write_bytes` — because those receivers are Path objects built at runtime
    and there is no qualifier to match. Everything else stays qualified: a bare
    `loads` would make every `json.loads` a dynamic-code finding, and a control
    that cries wolf on ordinary code gets switched off, and then it protects
    nothing.
    """
    try:
        with open(path, "rb") as fh:
            tree = ast.parse(fh.read())
    except SyntaxError:
        return set(), ["unparseable"]

    found, evidence = set(), []
    for node in ast.walk(tree):
        names = []
        if isinstance(node, ast.Import):
            names = [a.name.split(".")[0] for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            names = [node.module.split(".")[0]]
        for cap, spec in CAPABILITY_EVIDENCE.items():
            for name in names:
                if name in spec.get("modules", set()):
                    found.add(cap)
                    evidence.append(f"{cap}: import {name}")

        if isinstance(node, ast.Call):
            call = dotted(node.func)
            # Match the qualified name AND the final attribute. Some entries in
            # the table are deliberately bare (`write_text`) because the
            # receiver is a Path built at runtime and there is no qualifier to
            # match. Checking only the dotted form missed `p.write_text(...)`
            # and reported a true declaration as an over-declaration.
            tail = call.rsplit(".", 1)[-1] if call else ""
            for cap, spec in CAPABILITY_EVIDENCE.items():
                names = spec.get("calls", set())
                if call in names or (tail and tail in names):
                    found.add(cap)
                    evidence.append(f"{cap}: {call or tail}")
                elif isinstance(node.func, ast.Name) and \
                        node.func.id in spec.get("builtins", set()):
                    found.add(cap)
                    evidence.append(f"{cap}: {node.func.id}")
    return found, evidence


def declared_manifest(path):
    """Read __manifest__ statically. Importing the file to read its manifest
    would execute unverified code to decide whether to trust it — wrong order."""
    try:
        with open(path, "rb") as fh:
            tree = ast.parse(fh.read())
    except SyntaxError:
        return None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "__manifest__"
                for t in node.targets):
            try:
                value = ast.literal_eval(node.value)
            except (ValueError, SyntaxError):
                return None
            return value if isinstance(value, dict) else None
    return None


def _js_balanced_block(text, start):
    """(start, end) of the `{...}` beginning at or after `start`, nesting-aware."""
    open_at = text.find("{", start)
    if open_at == -1:
        return None
    depth = 0
    for i in range(open_at, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return open_at, i + 1
    return None


def js_declared_manifest(path):
    """Read a TypeScript/JavaScript `__manifest__` statically.

    Deliberately does not import the module, for the same reason
    `declared_manifest` does not: deciding whether to trust a file by running
    it is the wrong order.

    A declaration only counts if it is code. A generated manifest block was
    once inserted at an offset that fell inside the Python source string
    `ComputerUseAgent.ts` passes to `python3`; the file then contained every
    substring a text check looks for while exporting no manifest at all. A
    manifest block spans lines, and the only JavaScript string that can span
    lines is a template literal, so an odd number of backticks before the
    declaration means it is inside one and is not a declaration."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            body = fh.read()
    except OSError:
        return None
    for m in re.finditer(r"(?m)^\s*(?:export\s+)?(?:const|let|var)?\s*"
                         r"__manifest__\s*[:=]", body):
        if len(re.findall(r"(?<!\\)`", body[:m.start()])) % 2:
            continue  # inside a template literal, so not a declaration
        block = _js_balanced_block(body, m.end())
        if block is None:
            continue
        raw = body[block[0]:block[1]]
        man = {}
        for key, value in re.findall(
                r"(?m)^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"
                r"(\[[^\]]*\]|'[^']*'|\"[^\"]*\"|[^,\n]+)", raw):
            value = value.strip().rstrip(",")
            if value.startswith("["):
                man[key] = [a or b for a, b in
                            re.findall(r"'([^']*)'|\"([^\"]*)\"", value)]
            elif value[:1] in "'\"":
                man[key] = value[1:-1]
            else:
                man[key] = value
        if man:
            return man
    return None


def any_declared_manifest(path):
    """The manifest a file declares, whatever language it is written in."""
    return (declared_manifest(path) if path.endswith(".py")
            else js_declared_manifest(path))


# ── the agent contract ───────────────────────────────────────────────────────

@check("R1", "Every agent is a single file, in every language.")
def r1_single_file():
    files = all_agent_files()
    if not files:
        return None, "no agents directory found"
    for path in files:
        if os.path.isdir(path):
            return False, f"{os.path.basename(path)} is a package, not a file"
    py = sum(1 for f in files if f.endswith(".py"))
    return True, "%d agents, each one file (%d python, %d ts/js)" % (
        len(files), py, len(files) - py)


@check("R2", "EVERY agent in the repo declares a rapp-agent/1.0 manifest.")
def r2_manifest_present():
    """Every agent, in every language. The contract is not language-specific."""
    files = all_agent_files()
    if not files:
        return None, "no agents found"
    missing = []
    for path in files:
        man = any_declared_manifest(path)
        ok = man is not None and man.get("schema") == AGENT_SCHEMA
        if not ok:
            missing.append(os.path.relpath(path, ROOT))
    if missing:
        return False, ("%d of %d agents carry no rapp-agent/1.0 manifest: %s%s"
                       % (len(missing), len(files), ", ".join(missing[:4]),
                          " …" if len(missing) > 4 else ""))
    return True, "all %d agents declare %s" % (len(files), AGENT_SCHEMA)


@check("R3", "Every manifest carries the fields the registry needs.")
def r3_manifest_complete():
    required = ["schema", "name", "version", "description", "capabilities"]
    bad = []
    for path in all_agent_files():
        man = any_declared_manifest(path) or {}
        gaps = [k for k in required if k not in man]
        if gaps:
            bad.append(f"{os.path.basename(path)} lacks {gaps}")
        elif not re.match(r"^@[a-z0-9-]+/[a-z0-9-]+$", str(man.get("name", ""))):
            bad.append(f"{os.path.basename(path)} name {man.get('name')!r} "
                       "is not @scope/slug")
    if bad:
        return False, "; ".join(bad[:3])
    return True, "every manifest has %s and an @scope/slug name" % ", ".join(required)


@check("R4", "Declared capabilities cover everything the code can reach.")
def r4_capabilities_honest():
    """The check an enterprise strain applies (kody-w/rapp-light check 4). An
    agent that under-declares here is refused there, so failing this check means
    the agent cannot be adopted by a governed deployment."""
    bad = []
    for path in agent_files():
        observed, evidence = observed_capabilities(path)
        man = declared_manifest(path) or {}
        declared = set(man.get("capabilities") or [])
        undeclared = sorted(observed - declared)
        if undeclared:
            hint = next((e for e in evidence
                         if e.split(":")[0] in undeclared), "")
            bad.append(f"{os.path.basename(path)} under-declares "
                       f"{undeclared} ({hint})")
    if bad:
        return False, "; ".join(bad[:3])
    return True, ("all %d Python agents declare every capability their syntax "
                  "tree can reach; TypeScript is covered by "
                  "capability-reachability.test.ts" % len(agent_files()))


@check("R5", "No agent over-declares a capability it cannot reach.")
def r5_no_over_declaration():
    """Over-declaration is not a security hole, but it is a slow poison: an
    agent that claims process-exec it never uses gets withheld by a strain that
    forbids process-exec, for no reason, and the owner learns to distrust the
    declarations. Reported as a warning-shaped failure so it stays visible."""
    noisy = []
    for path in agent_files():
        observed, _ev = observed_capabilities(path)
        man = declared_manifest(path) or {}
        declared = set(man.get("capabilities") or [])
        extra = sorted(declared - observed)
        if extra:
            noisy.append(f"{os.path.basename(path)} claims unused {extra}")
    if noisy:
        return False, "; ".join(noisy[:3])
    return True, ("no Python agent claims a capability its code does not use; "
                  "TypeScript is covered by capability-reachability.test.ts")


# ── kernel parity ────────────────────────────────────────────────────────────

@check("R6", "The brainstem keeps wire parity with the RAPP kernel.")
def r6_kernel_parity():
    """OpenRappter's brainstem is a wire-compatible mirror, not a fork of
    convenience. The routes are the contract; if one goes missing, anything
    trained against a RAPP brainstem quietly stops working here."""
    if not os.path.isfile(BRAINSTEM):
        return None, "no brainstem.py in this checkout"
    with open(BRAINSTEM, encoding="utf-8") as fh:
        body = fh.read()
    required = ["/chat", "/health", "/version", "/agents", "/models"]
    missing = [r for r in required if f'"{r}"' not in body and f"'{r}'" not in body]
    if missing:
        return False, "routes absent from the brainstem: %s" % ", ".join(missing)
    if "response" not in body:
        return False, "the /chat reply field `response` is not present"
    return True, "routes %s present; /chat replies in `response`" % ", ".join(required)


@check("R7", "An agent needs no import from the kernel to be loadable.")
def r7_agents_are_portable():
    """The single-file contract means an agent is a file you can drop anywhere.
    An agent that imports deep internals is a plugin, not a cartridge."""
    offenders = []
    for path in agent_files():
        with open(path, "rb") as fh:
            tree = ast.parse(fh.read())
        # Only MODULE-LEVEL, UNGUARDED imports break the contract. An import
        # inside a function, or one wrapped in try/except ImportError, still
        # lets the file load alone — which is the property that matters. This
        # repo already uses that pattern deliberately (see shell_agent).
        for node in tree.body:
            targets = []
            if isinstance(node, ast.ImportFrom):
                targets = [node.module or ""]
            elif isinstance(node, ast.Import):
                targets = [a.name for a in node.names]
            for module in targets:
                if not module.startswith("openrappter"):
                    continue
                if module.endswith("basic_agent") or module == "openrappter":
                    continue
                offenders.append(f"{os.path.basename(path)} hard-imports {module}")
    if offenders:
        return False, "; ".join(sorted(set(offenders))[:3])
    return True, ("Python agents import nothing from the kernel beyond "
                  "basic_agent")


# ── licence and provenance ───────────────────────────────────────────────────

@check("R8", "The RAPP substrate is attributed.")
def r8_attribution():
    """RAPP is open and MIT-licensed; this organism stands on it. Saying so is
    both the licence condition and the point of the architecture.

    The token has to stand alone. `rapp` as a plain substring is satisfied by
    the project's own name — openRAPPter contains it — so the check used to
    pass on a README with every mention of the substrate deleted. A licence
    condition that cannot fail is worse than none: it reports compliance
    without ever having looked."""
    substrate = re.compile(r"(?<![a-z0-9])rapp(?![a-z])")
    licence = re.compile(r"(?<![a-z0-9])mit(?![a-z])")
    for name in ("README.md", "LICENSE", "NOTICE"):
        path = os.path.join(ROOT, name)
        if os.path.isfile(path):
            with open(path, encoding="utf-8", errors="replace") as fh:
                body = fh.read().lower()
            if substrate.search(body) and (licence.search(body)
                                           or "rapp-1" in body):
                return True, f"{name} attributes the RAPP substrate"
    return False, "no file attributes RAPP as the underlying substrate"


@check("R9", "The repository contains no credential of its own.")
def r9_no_secrets():
    broker = shutil.which("rapp-keyring") or \
        os.path.expanduser("~/.local/bin/rapp-keyring")
    if not (os.path.isfile(broker) and os.access(broker, os.X_OK)):
        return None, ("rapp-keyring not installed; cannot run the credential scan "
                      "(curl -fsSL https://kody-w.github.io/rapp-keyring/install.sh | bash)")
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT,
                             capture_output=True, text=True).stdout.split()
    if not tracked:
        return None, "not a git checkout"
    # Ask for JSON rather than reading the prose. The prose parse counted the
    # remediation advice ("rotate the credential at its source — assume it
    # already leaked") as a finding, and — the reason this matters — a broker
    # that failed outright printed nothing at all, so nothing matched, the
    # count stayed zero, and the check reported a clean bill of health over
    # files it had never opened. A scanner that cannot run must never be
    # indistinguishable from a scanner that ran and found nothing.
    findings, suppressed = [], 0
    for i in range(0, len(tracked), 400):
        proc = subprocess.run([broker, "scan", "--json"] + tracked[i:i + 400],
                              cwd=ROOT, capture_output=True, text=True)
        # rapp-keyring scan: 0 = clean, 1 = findings. Anything else is the
        # broker itself failing, which is not evidence of an absence.
        if proc.returncode not in (0, 1):
            why = (proc.stderr or proc.stdout).strip().splitlines()
            return False, ("scan did not complete — rapp-keyring exited %d (%s); "
                           "this is not a finding of credentials, it is the "
                           "absence of a verdict"
                           % (proc.returncode, why[0][:90] if why else "no output"))
        try:
            report = json.loads(proc.stdout)
        except ValueError:
            return False, ("scan did not complete — rapp-keyring exited %d with "
                           "output that is not the documented JSON; no verdict"
                           % proc.returncode)
        findings.extend(report.get("findings", []))
        suppressed += len(report.get("suppressed", []))
    if findings:
        files = sorted({str(f.get("file")) for f in findings})
        return False, ("%d credential-shaped value(s) in %d file(s): %s"
                       % (len(findings), len(files),
                          ", ".join(files[:5]) + (" …" if len(files) > 5 else "")))
    detail = "%d tracked files scanned, no plaintext credential" % len(tracked)
    if suppressed:
        detail += " (%d suppressed by an explicit allow pragma)" % suppressed
    return True, detail


# ── report ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="OpenRappter RAPP conformance")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    rows, failed, skipped = [], 0, 0
    for fn in CHECKS:
        try:
            outcome = fn()
            ok, detail = outcome if outcome is not None else (None, "no result")
        except Exception as exc:
            ok, detail = False, "check raised %s: %s" % (type(exc).__name__, exc)
        status = "SKIP" if ok is None else ("PASS" if ok else "FAIL")
        if ok is None:
            skipped += 1
        elif not ok:
            failed += 1
        rows.append({"id": fn._cid, "claim": fn._claim,
                     "status": status, "detail": detail})

    if args.json:
        print(json.dumps({"passed": sum(1 for r in rows if r["status"] == "PASS"),
                          "failed": failed, "skipped": skipped, "checks": rows},
                         indent=2))
        return 1 if failed else 0

    print("OpenRappter — RAPP conformance")
    print("=" * 74)
    for row in rows:
        print()
        print("%s  %-4s %s" % (row["status"].ljust(4), row["id"], row["claim"]))
        print("      %s" % row["detail"])
    print()
    print("=" * 74)
    print("%d passed, %d failed, %d skipped"
          % (sum(1 for r in rows if r["status"] == "PASS"), failed, skipped))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
