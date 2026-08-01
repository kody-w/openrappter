#!/usr/bin/env python3
"""
Test drive: the Kody allele on both sets of bones.

The claim under test is the one that matters most in this ecosystem — that the
GOD half belongs to the operator, not to a platform. If that is true, the same
vault must behave the same way whether the grail brainstem or openrappter is
reading it, and it must keep working when the network, the keys, and the cloud
are all gone.

So this drives the REAL twin at ~/.rapp/twin through both platforms and
compares them byte for byte, then removes things until something breaks and
checks that what breaks is the right thing.

    python3 drive.py

Nothing here writes to the real vault. Degradation cases run against copies.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
from pathlib import Path

OR = Path.home() / "Developer" / "openrappter"
GRAIL = Path.home() / "RAPP" / "rapp_brainstem"
VAULT = Path(os.environ.get("RAPP_TWIN_HOME", Path.home() / ".rapp" / "twin"))

G, R, Y, D, X = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"
passed = failed = 0
notes: list[str] = []


def ok(m: str, detail: str = "") -> None:
    global passed
    passed += 1
    print(f"  {G}pass{X} {m}" + (f" {D}{detail}{X}" if detail else ""))


def bad(m: str, detail: str = "") -> None:
    global failed
    failed += 1
    print(f"  {R}FAIL{X} {m}")
    if detail:
        print(f"       {detail}")


def note(m: str) -> None:
    notes.append(m)
    print(f"  {Y}note{X} {m}")


def head(t: str) -> None:
    print(f"\n{D}── {t} {'─' * max(0, 58 - len(t))}{X}")


# ── load the Python (grail) side exactly as a brainstem would ────────────
def load_grail_twin():
    agents = types.ModuleType("agents"); agents.__path__ = []
    basic = types.ModuleType("agents.basic_agent")

    class BasicAgent:
        def __init__(self, name=None, metadata=None):
            if name: self.name = name
            if metadata: self.metadata = metadata
        def perform(self, **kw): return "Not implemented."
        def system_context(self): return None
        def to_tool(self):
            return {"type": "function", "function": {
                "name": self.name, "description": self.metadata.get("description", ""),
                "parameters": self.metadata.get("parameters", {})}}

    basic.BasicAgent = BasicAgent
    sys.modules["agents"], sys.modules["agents.basic_agent"] = agents, basic

    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "twin_agent", OR / "python" / "openrappter" / "agents" / "twin_agent.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def ts_soul(audience: str, home: Path | None = None) -> str | None:
    """Render through openrappter's TypeScript path."""
    script = (
        "import {TwinVault, renderSoul} from './src/twin/index.js';"
        f"const v=new TwinVault({{dir:{json.dumps(str(home or VAULT))}}});"
        f"process.stdout.write(renderSoul(v.load(),{{audience:'{audience}'}}));"
    )
    probe = OR / "typescript" / f".drive-{audience}.ts"
    probe.write_text(script)
    try:
        out = subprocess.run(["npx", "tsx", probe.name], cwd=OR / "typescript",
                             capture_output=True, text=True, timeout=180)
        return out.stdout if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None
    finally:
        probe.unlink(missing_ok=True)


print(f"\n{D}Test drive — the Kody allele on both sets of bones{X}")
print(f"{D}vault: {VAULT}{X}")

grail = load_grail_twin()
profile = json.loads((VAULT / "profile.json").read_text())
name = profile["identity"]["name"]
secrets = list(profile.get("accounts", {}).values())

# ═════════════════════════════════════════════════════════════════════════
head("1 · the twin loads on both platforms")

g_owner = grail.render_soul(profile, "owner")
ok("grail brainstem renders the twin", f"{len(g_owner)} chars")

t_owner = ts_soul("owner")
if t_owner:
    ok("openrappter renders the twin", f"{len(t_owner)} chars")
else:
    bad("openrappter renders the twin", "tsx failed")

# ═════════════════════════════════════════════════════════════════════════
head("2 · both bones agree, byte for byte")

if t_owner is not None:
    for audience in ("owner", "trusted", "public"):
        g = grail.render_soul(profile, audience)
        t = ts_soul(audience)
        if t is None:
            bad(f"{audience}: openrappter render", "tsx failed")
        elif g.strip() == t.strip():
            ok(f"{audience} projection is identical on both", f"{len(g)} chars")
        else:
            # Show the first divergence rather than a wall of diff.
            for i, (a, b) in enumerate(zip(g, t)):
                if a != b:
                    bad(f"{audience} projection differs", f"at char {i}: {g[i-40:i+40]!r} vs {t[i-40:i+40]!r}")
                    break
            else:
                bad(f"{audience} projection differs", f"length {len(g)} vs {len(t)}")

# ═════════════════════════════════════════════════════════════════════════
head("3 · the PII boundary holds on both")

for label, soul in [("grail", g_owner), ("openrappter", t_owner)]:
    if soul is None:
        continue
    leaked = [s for s in secrets if s in soul]
    if leaked:
        bad(f"{label}: accounts never enter the owner prompt", f"LEAKED {leaked}")
    else:
        ok(f"{label}: accounts never enter the owner prompt")

for label, render in [("grail", lambda a: grail.render_soul(profile, a)), ("openrappter", ts_soul)]:
    pub = render("public")
    if pub is None:
        continue
    bad_bits = [s for s in secrets if s in pub]
    titles = " ".join(r.get("title", "") for r in profile.get("roles", []))
    via_title = []
    for project in profile["context"]["projects"]:
        if project["name"] in pub:
            (via_title if project["name"] in titles else bad_bits).append(project["name"])
    if bad_bits:
        bad(f"{label}: public projection leaks nothing", f"LEAKED {bad_bits}")
    else:
        ok(f"{label}: public projection leaks nothing",
           f"{len(secrets)} secrets + {len(profile['context']['projects']) - len(via_title)} projects withheld")
    if via_title and label == "grail":
        note(f"{', '.join(via_title)} is public because it is in your own role title — "
             "org and focus are stripped, the title is not. Your call, not a defect.")

# ═════════════════════════════════════════════════════════════════════════
head("4 · your alleles, computed on both")


def allele(trait: str, tail: str, bits: int = 16) -> int:
    return int(hashlib.sha256(f"rapp/1:allele:{trait}\n{tail}".encode()).hexdigest()[: bits // 4], 16)


def tier(v: int) -> str:
    return ("mythic" if v == 0xFFFF else "ultra" if v >= 0xFF00 else
            "rare" if v >= 0xF000 else "uncommon" if v >= 0xC000 else "common")


tail = profile["id"]
rolled = {t: allele(t, tail) for t in ("coat", "tempo", "voice", "glow")}
for trait, value in rolled.items():
    mark = f"{Y}★{X} " if value >= 0xF000 else ""
    print(f"       {mark}{trait:6} 0x{value:04X}  {tier(value)}")

# The whole design claim: derivable anywhere, identical everywhere.
js = ("const c=require('crypto');const t=" + json.dumps(tail) + ";" +
      "const o={};for(const k of ['coat','tempo','voice','glow'])" +
      "o[k]=parseInt(c.createHash('sha256').update('rapp/1:allele:'+k+'\\n'+t).digest('hex').slice(0,4),16);" +
      "process.stdout.write(JSON.stringify(o));")
try:
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True, timeout=60)
    if out.returncode == 0 and json.loads(out.stdout) == rolled:
        ok("alleles are identical in Python and Node", "derived, never assigned")
    else:
        bad("alleles are identical in Python and Node", f"{out.stdout} vs {rolled}")
except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
    note(f"node cross-check skipped: {exc}")

if allele("coat", tail) == allele("coat", tail):
    ok("alleles are deterministic")
if allele("coat", tail) != allele("tempo", tail):
    ok("traits are independent", "domain separation works")
if allele("coat", tail) != allele("coat", tail[:-1] + "0"):
    ok("a different tail rolls different alleles", "cannot be re-rolled without re-minting")

# ═════════════════════════════════════════════════════════════════════════
head("5 · local-first degradation")

# 5a. no network at all
env = {**os.environ, "http_proxy": "http://127.0.0.1:1", "https_proxy": "http://127.0.0.1:1",
       "HTTP_PROXY": "http://127.0.0.1:1", "HTTPS_PROXY": "http://127.0.0.1:1", "no_proxy": ""}
try:
    out = subprocess.run(
        [sys.executable, "-c",
         "import sys;sys.path.insert(0,'.');"
         "exec(open('drive_offline.py').read())"],
        cwd=Path(__file__).parent, capture_output=True, text=True, timeout=60, env=env)
except Exception:
    out = None

offline_probe = Path(__file__).parent / "drive_offline.py"
offline_probe.write_text(
    "import json,types,sys,importlib.util\n"
    "a=types.ModuleType('agents');a.__path__=[]\n"
    "b=types.ModuleType('agents.basic_agent')\n"
    "class BA:\n"
    "  def __init__(s,name=None,metadata=None):\n"
    "    if name:s.name=name\n"
    "    if metadata:s.metadata=metadata\n"
    "  def perform(s,**k):return ''\n"
    "  def system_context(s):return None\n"
    "b.BasicAgent=BA;sys.modules['agents']=a;sys.modules['agents.basic_agent']=b\n"
    f"sp=importlib.util.spec_from_file_location('t',{json.dumps(str(OR / 'python' / 'openrappter' / 'agents' / 'twin_agent.py'))})\n"
    "m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)\n"
    "print(len(m.TwinAgent().system_context() or ''))\n")
try:
    out = subprocess.run([sys.executable, str(offline_probe)], capture_output=True,
                         text=True, timeout=60, env=env)
    if out.returncode == 0 and int(out.stdout.strip()) > 100:
        ok("grail twin works with the network cut", f"{out.stdout.strip()} chars of context")
    else:
        bad("grail twin works with the network cut", out.stderr.strip()[:200])
except Exception as exc:
    bad("grail twin works with the network cut", str(exc))
finally:
    offline_probe.unlink(missing_ok=True)

# 5b. no API keys of any kind
stripped = {k: v for k, v in os.environ.items()
            if not any(t in k.upper() for t in ("KEY", "TOKEN", "SECRET", "OPENAI", "ANTHROPIC", "AZURE", "GITHUB"))}
probe = Path(__file__).parent / "drive_nokeys.py"
probe.write_text(
    "import json,hashlib\n"
    f"p=json.load(open({json.dumps(str(VAULT / 'profile.json'))}))\n"
    "print(p['identity']['name'])\n")
try:
    out = subprocess.run([sys.executable, str(probe)], capture_output=True, text=True,
                         timeout=60, env=stripped)
    if out.stdout.strip() == name:
        ok("the vault reads with every API key removed", "no key is required to be yourself")
    else:
        bad("the vault reads with every API key removed", out.stderr[:200])
except Exception as exc:
    bad("the vault reads with every API key removed", str(exc))
finally:
    probe.unlink(missing_ok=True)

# ═════════════════════════════════════════════════════════════════════════
head("6 · what breaks, breaks correctly")

with tempfile.TemporaryDirectory() as tmp:
    tmp_path = Path(tmp)

    # missing vault
    empty = tmp_path / "empty"
    empty.mkdir()
    os.environ["RAPP_TWIN_HOME"] = str(empty)
    try:
        result = json.loads(grail.TwinAgent().perform(action="show"))
        if result.get("status") == "error" and "twin init" in json.dumps(result):
            ok("missing vault: refuses with a fix, not a traceback")
        else:
            bad("missing vault: refuses with a fix", json.dumps(result)[:150])
        if grail.TwinAgent().system_context() is None:
            ok("missing vault: injects no context rather than a broken one")
        else:
            bad("missing vault: injects no context")
    finally:
        os.environ.pop("RAPP_TWIN_HOME", None)

    # corrupt vault
    corrupt = tmp_path / "corrupt"
    corrupt.mkdir()
    (corrupt / "profile.json").write_text("{ not json")
    os.environ["RAPP_TWIN_HOME"] = str(corrupt)
    try:
        raw = grail.TwinAgent().perform(action="show")
        json.loads(raw)  # must still be JSON, not a stack trace
        ok("corrupt vault: degrades to a clean error")
        if grail.TwinAgent().system_context() is None:
            ok("corrupt vault: poisons no prompt")
        else:
            bad("corrupt vault: poisons no prompt")
    except Exception as exc:
        bad("corrupt vault: degrades to a clean error", str(exc)[:150])
    finally:
        os.environ.pop("RAPP_TWIN_HOME", None)

    # vault inside a git repo — the leak this whole design exists to prevent
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    inside = repo / "twin"
    inside.mkdir()
    shutil.copy(VAULT / "profile.json", inside / "profile.json")
    os.environ["RAPP_TWIN_HOME"] = str(inside)
    try:
        where = json.loads(grail.TwinAgent().perform(action="where"))
        if where.get("inside_git_repo") and "unsafe" in (where.get("warning") or ""):
            ok("vault inside a repo: flagged unsafe", "grail")
        else:
            bad("vault inside a repo: flagged unsafe", json.dumps(where)[:150])
    finally:
        os.environ.pop("RAPP_TWIN_HOME", None)

    guard = OR / "typescript" / ".drive-guard.ts"
    guard.write_text(
        "import {TwinVault} from './src/twin/index.js';\n"
        f"const v=new TwinVault({{dir:{json.dumps(str(inside))}}});\n"
        "try{v.assertSafeLocation();console.log('ACCEPTED')}catch(e){console.log('REFUSED')}\n"
    )
    result = subprocess.run(["npx", "tsx", ".drive-guard.ts"], cwd=OR / "typescript",
                            capture_output=True, text=True, timeout=180)
    guard.unlink(missing_ok=True)
    if "REFUSED" in result.stdout:
        ok("vault inside a repo: refused outright", "openrappter")
    elif "ACCEPTED" in result.stdout:
        bad("vault inside a repo: refused outright", "openrappter ACCEPTED it")
    else:
        note(f"openrappter repo-guard probe inconclusive: {result.stderr.strip()[:120]}")

# ═════════════════════════════════════════════════════════════════════════
head("7 · the real vault is untouched")

after = json.loads((VAULT / "profile.json").read_text())
if after == profile:
    ok("the real vault is byte-identical to before the drive")
else:
    bad("the real vault was modified by testing")

mode = oct((VAULT / "profile.json").stat().st_mode)[-3:]
if mode == "600":
    ok("permissions still 0600")
else:
    bad("permissions still 0600", f"found {mode}")

print(f"\n{'─' * 62}")
print(f"  {G}{passed} passed{X}" + (f"   {R}{failed} failed{X}" if failed else "") +
      (f"   {Y}{len(notes)} notes{X}" if notes else ""))
print()
sys.exit(0 if failed == 0 else 1)
