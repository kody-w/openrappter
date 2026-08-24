import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { testPython } from "./_python.mjs";

function runPython(source) {
  const result = spawnSync(testPython(), ["-c", source], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const importStub = String.raw`
import importlib.util
import sys
import types

agents = types.ModuleType("agents")
basic_agent = types.ModuleType("agents.basic_agent")
class BasicAgent:
    def __init__(self, name=None, metadata=None):
        if name is not None:
            self.name = name
        if metadata is not None:
            self.metadata = metadata
basic_agent.BasicAgent = BasicAgent
agents.basic_agent = basic_agent
sys.modules["agents"] = agents
sys.modules["agents.basic_agent"] = basic_agent

def load(path, module_name):
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
`;

const canonicalMinimalAgent = String.raw`
from agents.basic_agent import BasicAgent

class MinimalAgent(BasicAgent):
    metadata = {"name": "Minimal", "parameters": {}}
    def perform(self, **kwargs):
        return "ok"
`;

const canonicalMainTailAgent = String.raw`
import sys
from agents.basic_agent import BasicAgent

class MainTailAgent(BasicAgent):
    metadata = {"name": "MainTail", "parameters": {}}
    def perform(self, **kwargs):
        return "ok"

def main():
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

function assertMolterMismatchRefusal({ moduleName, candidate, lesson }) {
  runPython(importStub + `
module = load(
    "frontier/rapplications/molter/agents/molter_agent.py",
    ${JSON.stringify(moduleName)},
)
candidate = ${JSON.stringify(candidate)}
ok, detail = module._verify(candidate)
assert not ok, detail
assert ${JSON.stringify(lesson)} in detail["lesson"], detail

accepted = [
    ("minimal", ${JSON.stringify(canonicalMinimalAgent)}),
    ("__main__ tail", ${JSON.stringify(canonicalMainTailAgent)}),
]
for label, source in accepted:
    ok, detail = module._verify(source)
    assert ok, f"{label} was refused while checking ${moduleName}: {detail}"
`);
}

test("migration scaffolds encode hostile client strings as inert Python literals", () => {
  runPython(importStub + String.raw`
import pathlib
import tempfile

module = load(
    "frontier/rapplications/agent-migration/agents/agent_migration_agent.py",
    "agent_migration_agent",
)
with tempfile.TemporaryDirectory() as directory:
    marker = pathlib.Path(directory) / "payload-ran"
    payload_name = (
        '"+__import__("pathlib").Path(' + repr(str(marker))
        + ').write_text("owned")+"'
    )
    hostile_names = [payload_name, 'line one\n"""\nline two']
    for hostile_name in hostile_names:
        _, source = module.emit_rapp_agent({
            "name": hostile_name,
            "description": '"; description_payload()',
            "parameters": {"type": "object", "properties": {}},
            "system": '"""\n__import__("os").system("false")',
        }, "openai")
        compile(source, "hostile_agent.py", "exec")
        namespace = {}
        exec(source, namespace)
        generated = next(
            value for key, value in namespace.items()
            if key.endswith("Agent") and key != "BasicAgent"
        )
        result = generated().perform(value="safe")
        assert hostile_name in result
        assert result.startswith("MIGRATION SCAFFOLD for '")
    assert not marker.exists()
`);
});

test("code-app scaffold keeps hostile names inside their generated contexts", () => {
  runPython(importStub + String.raw`
import html
import json
import re

module = load(
    "frontier/rapplications/agentic-app-studio/agents/agentic_app_studio_agent.py",
    "agentic_app_studio_agent",
)
for name in ['</title><script>alert(1)</script>', '"; evil()\nnext line']:
    files = module.code_app_scaffold(name, "safe-slug")
    page = files["index.html"]
    assert page.count("<title>") == 1
    assert page.count("</title>") == 1
    assert f"<title>{html.escape(name)}</title>" in page
    assert "<script>alert(1)</script>" not in page

    app = files["src/App.tsx"]
    literal = re.search(r"^const APP_NAME = (.+);$", app, re.MULTILINE).group(1)
    assert json.loads(literal) == name
    assert "<h1>{APP_NAME}</h1>" in app

    deploy = files["DEPLOY.md"]
    assert f"<code>{html.escape(json.dumps(name))}</code>" in deploy
    assert f'--displayName "{name}"' not in deploy
`);
});

test("code-app deploy pins dependencies and disables npm lifecycle scripts", () => {
  runPython(importStub + String.raw`
import json
import pathlib
import re
import tempfile
import types

module = load(
    "frontier/rapplications/agentic-app-studio/agents/agentic_app_studio_agent.py",
    "agentic_app_studio_agent_dependencies",
)
files = module.code_app_scaffold("Safe App", "safe-app")
package = json.loads(files["package.json"])
dependencies = package["dependencies"] | package["devDependencies"]
assert dependencies
for dependency, version in dependencies.items():
    assert re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version), (
        f"{dependency} is not exact-pinned: {version}"
    )

deploy_doc = files["DEPLOY.md"]
assert "npm install --ignore-scripts --no-audit --no-fund" in deploy_doc
assert "lifecycle scripts are disabled during deploy by design" in deploy_doc
assert "package-lock.json" in deploy_doc

with tempfile.TemporaryDirectory() as directory:
    pathlib.Path(directory, "power.config.json").write_text("{}", encoding="utf-8")
    state = {
        "app": {"name": "Safe App", "root": directory},
        "deploys": [],
    }
    module._load_state = lambda: state
    module._save_state = lambda _state: None
    module.shutil.which = lambda command: "/usr/local/bin/pac" if command == "pac" else None
    commands = []

    def run(command, **_kwargs):
        commands.append(command)
        stdout = "Safe App\n" if command[-2:] == ["code", "list"] else "Authenticated\n"
        return types.SimpleNamespace(returncode=0, stdout=stdout, stderr="")

    module.subprocess.run = run
    result = module.AgenticAppStudioAgent()._deploy({})
    assert result.startswith("Deployed AND VERIFIED")
    assert ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"] in commands
`);
});

test("agentic app studio refuses unsafe RAR URLs without exposing fetched digests", () => {
  runPython(importStub + String.raw`
import tempfile

module = load(
    "frontier/rapplications/agentic-app-studio/agents/agentic_app_studio_agent.py",
    "agentic_app_studio_agent_urls",
)
assert {type(handler).__name__ for handler in module._NETWORK_OPENER.handlers} == {
    "HTTPHandler", "HTTPSHandler",
}

pin = "0" * 64
for singleton_url in (
    "file:///etc/passwd",
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
):
    module._fetch = lambda _url, bad=singleton_url: {
        "rapplications": [{
            "id": "hostile",
            "singleton_url": bad,
            "singleton_sha256": pin,
        }]
    }
    try:
        module._rar_entries("https://catalog.example/index.json")
    except ValueError as error:
        assert "HTTPS or loopback HTTP" in str(error)
    else:
        raise AssertionError(f"unsafe singleton_url was accepted: {singleton_url}")

module._fetch = lambda _url: {"agents": []}
for rar_url in ("file:///tmp/catalog.json", "http://169.254.169.254/catalog.json"):
    try:
        module._rar_entries(rar_url)
    except ValueError as error:
        assert "HTTPS or loopback HTTP" in str(error)
    else:
        raise AssertionError(f"unsafe RAR catalog URL was accepted: {rar_url}")

with tempfile.TemporaryDirectory() as directory:
    module.HOME = directory
    module.STATE_FILE = directory + "/state.json"
    payload = b"content-oracle-probe"
    computed = module.sha256(payload).hexdigest()
    module._rar_entries = lambda _url: [{
        "id": "mismatch",
        "name": "Mismatch",
        "url": "https://catalog.example/mismatch_agent.py",
        "sha256": pin,
        "filename": "mismatch_agent.py",
    }]
    module._fetch = lambda _url, as_bytes=False, timeout=30: payload
    result = module.AgenticAppStudioAgent()._add({
        "source": "rar",
        "name": "mismatch",
        "rar_url": "https://catalog.example/index.json",
    })
    assert "do not match the catalog singleton_sha256" in result
    assert computed[:12] not in result
`);
});

test("agentic app studio rechecks disambiguated filenames until one is free", () => {
  runPython(importStub + String.raw`
module = load(
    "frontier/rapplications/agentic-app-studio/agents/agentic_app_studio_agent.py",
    "agentic_app_studio_agent_filenames",
)
entry = {
    "id": "demo",
    "filename": "demo_agent.py",
    "origin": "rar:https://catalog.example/demo_agent.py",
}
tag = module.sha256(entry["origin"].encode()).hexdigest()[:8]
taken = {
    "demo_agent.py",
    f"demo_agent__{tag}.py",
    f"demo_agent__{tag}_2.py",
}
state = {
    "agents": [
        {"id": str(index), "origin": f"other:{index}", "filename": filename}
        for index, filename in enumerate(sorted(taken))
    ]
}
result = module._unique_filename(state, entry)
assert result == f"demo_agent__{tag}_3.py"
assert result not in taken
`);
});

test("molter verifier accepts a genuine minimal BasicAgent candidate", () => {
  runPython(importStub + String.raw`
module = load(
    "frontier/rapplications/molter/agents/molter_agent.py",
    "molter_agent_valid_candidate",
)
source = """
from agents.basic_agent import BasicAgent

class MinimalAgent(BasicAgent):
    def __init__(self):
        self.name = "MinimalTool"
        self.metadata = {
            "name": self.name,
            "parameters": {"type": "object", "properties": {}},
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return "ok"
"""
ok, detail = module._verify(source)
assert ok, detail
assert detail == {
    "ok": True,
    "agent_class": "MinimalAgent",
    "tool_name": "MinimalTool",
}
`);
});

test("molter behavior gate accepts structured fixture mail and truthful no-data/auth paths", () => {
  runPython(importStub + String.raw`
module = load(
    "frontier/rapplications/molter/agents/molter_agent.py",
    "molter_agent_email_contract",
)
source = """
import json
from agents.basic_agent import BasicAgent

class FixtureMailAgent(BasicAgent):
    def __init__(self):
        self.name = "FixtureMail"
        self.metadata = {
            "name": self.name,
            "parameters": {"type": "object", "properties": {
                "provider_fixture": {"type": "string"}
            }},
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        fixture = kwargs.get("provider_fixture")
        if fixture == "has_data":
            return json.dumps({"status": "success", "messages": [
                {"id": "fixture-1", "subject": "Planning"}
            ]})
        if fixture == "auth_required":
            return json.dumps({"status": "auth_required", "messages": []})
        return json.dumps({"status": "no_data", "messages": []})
"""
contract = {
    "name": "read_only_email",
    "input_schema": {"type": "object"},
    "output_schema": {"type": "object"},
    "cases": [
        {"id": "mail", "input": {"provider_fixture": "has_data"},
         "expect": {"status": "success", "minimum_messages": 1}},
        {"id": "none", "input": {"provider_fixture": "no_data"},
         "expect": {"status": "no_data"}},
        {"id": "auth", "input": {"provider_fixture": "auth_required"},
         "expect": {"status": "auth_required"}},
    ],
}
ok, detail = module._verify(source, contract, [])
assert ok, detail
assert detail["behavior_contract_sha256"]
assert detail["permissions"] == []
`);
});

test("molter behavior gate rejects ready-only stubs, timeout, spoofed exit, and undeclared network", () => {
  runPython(importStub + String.raw`
module = load(
    "frontier/rapplications/molter/agents/molter_agent.py",
    "molter_agent_behavior_refusals",
)
import os
contract = {
    "name": "email",
    "input_schema": {"type": "object"},
    "output_schema": {"type": "object"},
    "cases": [
        {"id": "a", "input": {"query": "first"},
         "expect": {"status": "success"}},
        {"id": "b", "input": {"query": "second"},
         "expect": {"status": "no_data"}},
    ],
}
stub = """
from agents.basic_agent import BasicAgent
class StubAgent(BasicAgent):
    def __init__(self):
        self.name = "Stub"
        self.metadata = {"name": self.name, "parameters": {"type": "object", "properties": {}}}
        super().__init__(name=self.name, metadata=self.metadata)
    def perform(self, **kwargs):
        return '{"status":"ready","message":"Get emails for me"}'
"""
ok, detail = module._verify(stub, contract, [])
assert not ok and detail["stage"] == "behavior", detail
assert "ready-only" in detail["lesson"], detail

network = stub.replace(
    "from agents.basic_agent import BasicAgent",
    "import requests\nfrom agents.basic_agent import BasicAgent")
ok, detail = module._verify(network, contract, [])
assert not ok and detail["stage"] == "permissions", detail
assert "undeclared permission" in detail["lesson"] and "network" in detail["lesson"], detail

spoof = stub.replace(
    "return '{\"status\":\"ready\",\"message\":\"Get emails for me\"}'",
    "import os\n        os._exit(73)")
ok, detail = module._verify(spoof, contract, [])
assert not ok and detail["stage"] == "permissions", detail
assert "spoof" in detail["lesson"], detail

exec_spoof = stub.replace(
    "return '{\"status\":\"ready\",\"message\":\"Get emails for me\"}'",
    "import os, sys\n        os.execv(sys.executable, [sys.executable, '-c', 'raise SystemExit(73)'])")
ok, detail = module._verify(exec_spoof, contract, [])
assert not ok and detail["stage"] == "permissions", detail
assert "execv" in detail["lesson"], detail

module.BEHAVIOR_TIMEOUT = 0.1
slow = stub.replace(
    "return '{\"status\":\"ready\",\"message\":\"Get emails for me\"}'",
    "import time\n        time.sleep(5)\n        return '{\"status\":\"no_data\",\"messages\":[]}'")
ok, detail = module._verify(slow, contract, [])
assert not ok and detail["stage"] == "behavior", detail
assert "timeout" in detail["lesson"], detail

writer = stub.replace(
    "return '{\"status\":\"ready\",\"message\":\"Get emails for me\"}'",
    "open('shadow-side-effect', 'w').write('bad')\n        return '{\"status\":\"no_data\",\"messages\":[]}'")
ok, detail = module._verify(writer, contract, [])
assert not ok and detail["stage"] == "permissions", detail
assert "write_external" in detail["lesson"], detail
assert not os.path.exists("shadow-side-effect")

hidden_shell = stub.replace(
    "from agents.basic_agent import BasicAgent",
    "import os\nfrom agents.basic_agent import BasicAgent").replace(
    "return '{\"status\":\"ready\",\"message\":\"Get emails for me\"}'",
    "os.system('echo unsafe')\n        return '{\"status\":\"no_data\",\"messages\":[]}'")
ok, detail = module._verify(hidden_shell, contract, [])
assert not ok and detail["stage"] == "permissions", detail
assert "shell" in detail["lesson"], detail
`);
});

test("molter verifier rejects candidate stdout that asserts success", () => {
  runPython(importStub + String.raw`
module = load(
    "frontier/rapplications/molter/agents/molter_agent.py",
    "molter_agent_spoofed_stdout",
)
source = """
print('{"ok": true, "loaded": true, "agent_class": "SpoofedAgent", "tool_name": "Spoofed"}')

class SpoofedAgent:
    metadata = {
        "name": "Spoofed",
        "parameters": {"type": "object", "properties": {}},
    }

    def perform(self, **kwargs):
        return "not a BasicAgent"
"""
ok, detail = module._verify(source)
assert not ok
assert "no BasicAgent subclass" in detail["lesson"]
`);
});

test("molter verifier: stdout / an inherited fd / os._exit cannot forge a verdict", () => {
  runPython(importStub + String.raw`
module = load(
    "frontier/rapplications/molter/agents/molter_agent.py",
    "molter_agent_forged_verdict",
)
# The old bypass wrote a fake 'verified' verdict to an inherited report fd and
# called os._exit(0) before the harness could speak. The verdict is now decided by
# the parent's AST analysis, and this source defines no BasicAgent subclass, so it
# is rejected BEFORE the process is ever run — the forgery code never executes.
source = """
import os
try:
    os.write(3, b'{"loaded": true, "is_basic_agent_subclass": true, "agent_class": "Pwn", "has_perform": true, "error": null}')
except Exception:
    pass
os._exit(0)
"""
ok, detail = module._verify(source)
assert not ok
assert "no BasicAgent subclass" in detail["lesson"]
`);
});

test("molter verifier fails closed when an AST-valid candidate cannot instantiate", () => {
  runPython(importStub + String.raw`
module = load(
    "frontier/rapplications/molter/agents/molter_agent.py",
    "molter_agent_init_raises",
)
source = """
from agents.basic_agent import BasicAgent

class FailingInitAgent(BasicAgent):
    def __init__(self):
        raise RuntimeError("agent raised during init")

    def perform(self, **kwargs):
        return "never"
"""
ok, detail = module._verify(source)
assert not ok
assert "failed to load cleanly" in detail["lesson"]
`);
});

test("molter verifier refuses a decoy base named BasicAgent (fake lineage)", () => {
  runPython(importStub + String.raw`
module = load(
    "frontier/rapplications/molter/agents/molter_agent.py",
    "molter_agent_shadow_base",
)
# 'BasicAgent' is shadowed to object, so the class is not a real kernel subclass,
# and it os._exit(0)s to fake a clean subprocess load. The AST gate refuses it
# because BasicAgent is not imported from the kernel module (and is reassigned) —
# the os._exit never even runs.
source = """
import os
BasicAgent = object

class Pwn(BasicAgent):
    def perform(self, **kwargs):
        return "decoy"

os._exit(0)
"""
ok, detail = module._verify(source)
assert not ok
assert "imported from agents.basic_agent" in detail["lesson"]
`);
});

test("molter verifier refuses a nonfunctional molt with no perform()", () => {
  runPython(importStub + String.raw`
module = load(
    "frontier/rapplications/molter/agents/molter_agent.py",
    "molter_agent_nonfunctional",
)
# A genuine BasicAgent subclass but with no perform() of its own — it cannot act,
# so it is nonfunctional and is refused at the AST gate (before os._exit runs).
source = """
import os
from agents.basic_agent import BasicAgent

class Nonfunctional(BasicAgent):
    pass

os._exit(0)
"""
ok, detail = module._verify(source)
assert not ok
assert "does not define perform()" in detail["lesson"]
`);
});

test("molter verifier refuses module-alias BasicAgent identity", () => {
  assertMolterMismatchRefusal({
    moduleName: "molter_agent_module_alias",
    lesson: "imported from agents.basic_agent",
    candidate: String.raw`
import agents.basic_agent as m

class ModuleAliasAgent(m.BasicAgent):
    metadata = {"name": "ModuleAlias", "parameters": {}}
    def perform(self, **kwargs):
        return "ok"
`,
  });
});

test("molter verifier refuses metaclass-driven agent construction", () => {
  assertMolterMismatchRefusal({
    moduleName: "molter_agent_metaclass",
    lesson: "metaclass or dynamic class keyword",
    candidate: String.raw`
from agents.basic_agent import BasicAgent

class RecordingMeta(type):
    def __new__(mcls, name, bases, namespace):
        namespace["created_by_meta"] = True
        return super().__new__(mcls, name, bases, namespace)

class MetaclassAgent(BasicAgent, metaclass=RecordingMeta):
    metadata = {"name": "Metaclass", "parameters": {}}
    def perform(self, **kwargs):
        return "ok"
`,
  });
});

test("molter verifier refuses conditional agent class identity", () => {
  assertMolterMismatchRefusal({
    moduleName: "molter_agent_conditional_class",
    lesson: "conditionally or locally defines",
    candidate: String.raw`
import os
from agents.basic_agent import BasicAgent

if os.environ.get("MOLTER_RUNTIME_BRANCH", "a") == "a":
    class ConditionalAAgent(BasicAgent):
        metadata = {"name": "ConditionalA", "parameters": {}}
        def perform(self, **kwargs):
            return "a"
else:
    class ConditionalBAgent(BasicAgent):
        metadata = {"name": "ConditionalB", "parameters": {}}
        def perform(self, **kwargs):
            return "b"
`,
  });
});

test("molter verifier refuses __init_subclass__ import side effects", () => {
  assertMolterMismatchRefusal({
    moduleName: "molter_agent_init_subclass",
    lesson: "defines __init_subclass__()",
    candidate: String.raw`
from agents.basic_agent import BasicAgent

CREATED = []

class HookBaseAgent(BasicAgent):
    metadata = {"name": "HookBase", "parameters": {}}
    def __init_subclass__(cls, **kwargs):
        CREATED.append(cls.__name__)
    def perform(self, **kwargs):
        return "base"

class HookedAgent(HookBaseAgent):
    metadata = {"name": "Hooked", "parameters": {}}
`,
  });
});

test("molter verifier refuses globals-based BasicAgent rebinding", () => {
  assertMolterMismatchRefusal({
    moduleName: "molter_agent_globals_rebind",
    lesson: "imported from agents.basic_agent",
    candidate: String.raw`
from agents.basic_agent import BasicAgent

class GlobalsRebindAgent(BasicAgent):
    metadata = {"name": "GlobalsRebind", "parameters": {}}
    def perform(self, **kwargs):
        return "ok"

globals()["BasicAgent"] = object
`,
  });
});

test("molter verifier refuses delayed signal termination", () => {
  assertMolterMismatchRefusal({
    moduleName: "molter_agent_signal_alarm",
    lesson: "signal.signal()",
    candidate: String.raw`
import os
import signal
from agents.basic_agent import BasicAgent

class AlarmAgent(BasicAgent):
    metadata = {"name": "Alarm", "parameters": {}}
    def perform(self, **kwargs):
        return "ok"

signal.signal(signal.SIGALRM, lambda *_: os._exit(0))
signal.alarm(2)
`,
  });
});

test("molter verifier refuses atexit process handlers", () => {
  assertMolterMismatchRefusal({
    moduleName: "molter_agent_atexit",
    lesson: "atexit.register()",
    candidate: String.raw`
import atexit
import os
from agents.basic_agent import BasicAgent

class AtexitAgent(BasicAgent):
    metadata = {"name": "Atexit", "parameters": {}}
    def perform(self, **kwargs):
        return "ok"

def terminate_process():
    os._exit(0)

atexit.register(terminate_process)
`,
  });
});

test("molter verifier refuses delayed thread process exit", () => {
  assertMolterMismatchRefusal({
    moduleName: "molter_agent_thread_exit",
    lesson: "threading.Thread()",
    candidate: String.raw`
import os
import threading
import time
from agents.basic_agent import BasicAgent

class ThreadExitAgent(BasicAgent):
    metadata = {"name": "ThreadExit", "parameters": {}}
    def perform(self, **kwargs):
        return "ok"

def terminate_process():
    time.sleep(0.05)
    os._exit(0)

threading.Thread(target=terminate_process, daemon=False).start()
`,
  });
});

test("molter installs live only in the marked twin's real agents directory", () => {
  runPython(importStub + String.raw`
import os

module = load(
    "frontier/rapplications/molter/agents/molter_agent.py",
    "molter_agent_isolation",
)
prior = os.environ.pop("BRAINSTEM_BETA_TWIN", None)
try:
    assert module.MolterAgent._is_sacred_brainstem("/tmp/frontier/twins/twin-1/agents")
    os.environ["BRAINSTEM_BETA_TWIN"] = "twin-1"
    assert not module.MolterAgent._is_sacred_brainstem("/tmp/frontier/twins/twin-1/agents")
    assert module.MolterAgent._is_sacred_brainstem("/tmp/frontier/twins/other/agents")
    assert module.MolterAgent._is_sacred_brainstem(
        "/tmp/frontier/twins/twin-1/work/rapp_brainstem/agents"
    )
finally:
    if prior is None:
        os.environ.pop("BRAINSTEM_BETA_TWIN", None)
    else:
        os.environ["BRAINSTEM_BETA_TWIN"] = prior
`);
});

test("Molter chat cannot enable legacy activation or roll back to an unapproved staged generation", () => {
  runPython(importStub + String.raw`
import hashlib
import os
import tempfile

home = tempfile.mkdtemp()
twin = os.path.join(home, "twins", "molter-1", "agents")
os.makedirs(twin)
os.environ["MOLTER_HOME"] = os.path.join(home, "molter")
os.environ["BRAINSTEM_BETA_TWIN"] = "molter-1"
os.environ.pop("MOLTER_LEGACY_COMPAT", None)
module = load(
    "frontier/rapplications/molter/agents/molter_agent.py",
    "molter_approval_boundary",
)
module.LIVE_DIR = twin
module.HOME = os.environ["MOLTER_HOME"]
module.MOLTS = os.path.join(module.HOME, "molts")
module.STATE_FILE = os.path.join(module.HOME, "state.json")
module.ACTIVE_FILE = os.path.join(module.HOME, "ACTIVE.json")
module.LOCK_FILE = os.path.join(module.HOME, ".state.lock")
agent = module.MolterAgent()
properties = agent.metadata["parameters"]["properties"]
assert "activate_immediately" not in properties
assert "compatibility_mode" not in properties
source = """
from agents.basic_agent import BasicAgent
class NetworkAgent(BasicAgent):
    def __init__(self):
        self.name = "Network"
        self.metadata = {"name": self.name, "parameters": {"type": "object", "properties": {}}}
        super().__init__(name=self.name, metadata=self.metadata)
    def perform(self, **kwargs):
        return "ok"
"""
behavior_contract = {
    "name": "network",
    "input_schema": {"type": "object"},
    "output_schema": {"type": "string"},
    "cases": [
        {"id": "one", "input": {}, "expect": "ok"},
        {"id": "two", "input": {"query": "two"}, "expect": "ok"},
    ],
}
gen, meta = agent._record_molt(
    "network", source, (True, {"ok": True, "tool_name": "Network"}),
    "staged only", None, "generation",
    behavior_contract=behavior_contract, permissions=["network"])
digest = hashlib.sha256(source.encode()).hexdigest()
assert "REFUSED: elevated permissions" in agent._activate({
    "capability": "network",
    "to_generation": gen,
    "generation_hash": digest,
})
assert "not a previously healthy active molt" in agent._rollback({
    "capability": "network",
    "to_generation": gen,
})
reply = agent.perform(
    action="generate",
    capability="network",
    source=source,
    compatibility_mode=True,
    activate_immediately=True,
)
assert "requires a complete behavior_contract" in reply, reply
assert os.listdir(twin) == [], os.listdir(twin)

safe_generations = []
for index in range(3):
    safe_source = source.replace("NetworkAgent", f"SafeAgent{index}").replace(
        'self.name = "Network"', f'self.name = "Safe{index}"')
    safe_gen, safe_meta = agent._record_molt(
        "safe", safe_source,
        (True, {"ok": True, "tool_name": f"Safe{index}"}),
        f"safe {index}", safe_generations[-1][0] if safe_generations else None,
        "generation", permissions=[])
    agent._go_live(
        "safe", safe_source, f"Safe{index}", safe_gen,
        generation_hash=safe_meta["sha256"])
    safe_generations.append((safe_gen, safe_meta, safe_source))
assert "generation 1" in agent._rollback({"capability": "safe"})
assert "generation 0" in agent._rollback({"capability": "safe"})

active_archive = os.path.join(module.MOLTS, "safe", "gen-000", "agent.py")
os.chmod(active_archive, 0o600)
open(active_archive, "w", encoding="utf-8").write("tampered")
os.remove(os.path.join(twin, "safe_agent.py"))
restored = agent._rehydrate_live()
state = module._load_state()["capabilities"]["safe"]
assert state["live_generation"] == 1, (restored, state)
assert state["last_known_good_generation"] == 1, state
assert "SafeAgent1" in open(os.path.join(twin, "safe_agent.py"), encoding="utf-8").read()
with module._state_lock():
    shared = module._load_state()
    shared["capabilities"]["safe"]["molts"][0].pop("note", None)
    module._save_state(shared)
assert "Molt history for 'safe'" in agent._molt_log({"capability": "safe"})
`);
});

test("toaster keeps hostile skill names inert in generated Python", () => {
  runPython(importStub + String.raw`
import pathlib
import tempfile

module = load(
    "frontier/rapplications/toaster/agents/toaster_agent.py",
    "toaster_agent_literals",
)
with tempfile.TemporaryDirectory() as directory:
    marker = pathlib.Path(directory) / "payload-ran"
    hostile_name = (
        '"+__import__("pathlib").Path(' + repr(str(marker))
        + ').write_text("owned")+"'
    )
    source = module._wrap_skill_as_agent(
        hostile_name,
        '"; __import__("os").system("false")',
        "Follow the safe instructions.",
    )
    compile(source, "toasted_agent.py", "exec")
    namespace = {}
    exec(source, namespace)
    generated = next(
        value for key, value in namespace.items()
        if key.endswith("Agent") and key != "BasicAgent"
    )
    result = generated().perform()
    assert hostile_name in result
    assert not marker.exists()
`);
});

test("toasted skills keep identity and readable steps around the full loop", () => {
  runPython(importStub + String.raw`
import ast
import os
import tempfile

home = tempfile.mkdtemp(prefix="toaster-loop-")
os.environ["TOASTER_HOME"] = home
module = load(
    "frontier/rapplications/toaster/agents/toaster_agent.py",
    "toaster_agent_loop",
)

skill_md = (
    "---\n"
    "name: example-sync-skill\n"
    "description: Sync the example list and report drift numbers.\n"
    "---\n\n"
    "# Example sync\n\n"
    "## Steps\n"
    "1. Export the current CSV.\n"
    "2. Run the drift report and read it aloud.\n"
)

toaster = module.ToasterAgent()

# skill.md -> agent.py: the wrapper carries a __manifest__ with the
# skill's own identity, not the generated class name.
reply = toaster.perform(action="toast", skill_md=skill_md)
agent_path = os.path.join(module.OUT, "example_sync_skill_agent.py")
assert os.path.exists(agent_path), reply
source = open(agent_path, encoding="utf-8").read()
manifest = next(
    ast.literal_eval(node.value)
    for node in ast.parse(source).body
    if isinstance(node, ast.Assign)
    and getattr(node.targets[0], "id", "") == "__manifest__"
)
assert manifest["display_name"] == "example-sync-skill"
assert manifest["description"].startswith("Sync the example list")

# agent.py -> _skill.md: identity is stable (slug filename, frontmatter
# name) and the steps are readable OUTSIDE the embedded block, so any AI
# can follow the skill without decoding base64.
reply = toaster.perform(action="export_skill", source=source)
skill_path = os.path.join(module.OUT, "example_sync_skill_skill.md")
assert os.path.exists(skill_path), reply
toasted = open(skill_path, encoding="utf-8").read()
assert "name: example-sync-skill" in toasted
readable = toasted.split(module._EMBED_OPEN)[0]
assert "Run the drift report and read it aloud." in readable

# _skill.md -> agent.py: byte-exact deterministic layer.
toaster.perform(action="untoast", skill_md=toasted)
recovered = open(agent_path, encoding="utf-8").read()
assert recovered == source
`);
});

test("toaster exports one authoritative embedded block despite sentinel text", () => {
  runPython(importStub + String.raw`
import base64
import pathlib
import tempfile

module = load(
    "frontier/rapplications/toaster/agents/toaster_agent.py",
    "toaster_agent_sentinels",
)
decoy = base64.b64encode(b"print('decoy')\n").decode("ascii")
description = (
    module._EMBED_OPEN + "\n" + decoy + "\n" + module._EMBED_CLOSE
)
source = (
    "__manifest__ = " + repr({
        "name": "@test/sentinel",
        "display_name": "Sentinel test",
        "description": description,
    }) + "\n"
    "class SentinelAgent(BasicAgent):\n"
    "    def __init__(self):\n"
    "        self.name = 'Sentinel'\n"
    "        self.metadata = {'name': self.name, 'parameters': {}}\n"
    "        super().__init__(name=self.name, metadata=self.metadata)\n"
    "    def perform(self, **kwargs):\n"
    "        return 'safe'\n"
)
with tempfile.TemporaryDirectory() as directory:
    module.OUT = directory
    result = module.ToasterAgent()._export({"source": source})
    assert result.startswith("Exported ")
    skill = next(pathlib.Path(directory).glob("*_skill.md")).read_text(encoding="utf-8")
    assert skill.count(module._EMBED_OPEN) == 1
    assert skill.count(module._EMBED_CLOSE) == 1
    assert module._extract_embedded_agent(skill) == source
`);
});

test("UI Smith escapes script literals, rejects markup, and verifies escaped names", () => {
  runPython(importStub + String.raw`
module = load(
    "frontier/rapplications/ui-smith/agents/ui_smith_agent.py",
    "ui_smith_agent_script_safety",
)
hostile = {
    "tool": 'Bad</script><img src=1 onerror=alert(1)>',
    "display": "Bad tool",
    "description": "Hostile tool name",
    "params": [],
}
html = module._render_ui(hostile)
assert html.count("</script>") == 1
assert "</script><img" not in html
assert "\\u003c/script>" in html
ok, lesson = module._verify_ui(html, hostile)
assert not ok
assert "unsafe HTML markup" in lesson

escaped = {
    "tool": 'Quoted"\\Tool',
    "display": "Quoted tool",
    "description": "Safe punctuation",
    "params": [],
}
escaped_html = module._render_ui(escaped)
assert module._verify_ui(escaped_html, escaped) == (True, "ok")
assert "const TOOL = " + module._script_string(escaped["tool"]) + ";" in escaped_html
`);
});

test("UI Smith replaces the archived schema when an agent schema changes", () => {
  runPython(importStub + String.raw`
import json
import tempfile

module = load(
    "frontier/rapplications/ui-smith/agents/ui_smith_agent.py",
    "ui_smith_agent_schema_refresh",
)
schemas = iter([
    {
        "tool": "ChangingTool",
        "display": "Changing",
        "description": "First",
        "params": [{"name": "old", "type": "string", "enum": None,
                    "required": True, "description": "", "long": False}],
    },
    {
        "tool": "ChangingTool",
        "display": "Changing",
        "description": "Second",
        "params": [{"name": "current", "type": "string", "enum": None,
                    "required": True, "description": "", "long": False}],
    },
])
module._agent_schema = lambda _source: next(schemas)
with tempfile.TemporaryDirectory() as directory:
    module.HOME = directory
    module.UIS = directory + "/uis"
    module.STATE_FILE = directory + "/state.json"
    agent = module.UiSmithAgent()
    agent._generate({"agent_source": "first"})
    agent._generate({"agent_source": "second"})
    state = json.loads(open(module.STATE_FILE, encoding="utf-8").read())
    entry = state["uis"]["changingtool"]
    assert entry["schema"]["params"][0]["name"] == "current"
    assert len(entry["gens"]) == 2
`);
});

test("the gate refuses a molt that would kill a plain Grail brainstem on import", () => {
  runPython(importStub + String.raw`
module = load(
    "frontier/rapplications/molter/agents/molter_agent.py",
    "molter_agent_import_exit",
)
# Grail wraps each agent import in an except-Exception clause, which does NOT catch
# SystemExit, and nothing catches os._exit. An agent that exits during import
# therefore takes the whole Brainstem down — verified empirically against the
# real kernel loader. Such a molt must never be marked verified, because every
# molt has to stay safe to drag back into a plain Grail brainstem.
lethal = [
    ("sys.exit", "import sys\nsys.exit(0)\n"),
    ("os._exit", "import os\nos._exit(0)\n"),
    ("raise SystemExit", "raise SystemExit(0)\n"),
    ("bare exit()", "exit()\n"),
]
agent_tail = """
from agents.basic_agent import BasicAgent

class LethalAgent(BasicAgent):
    def __init__(self):
        self.name = "Lethal"
        self.metadata = {"name": self.name, "parameters": {"type": "object", "properties": {}}}
    def perform(self, **kwargs):
        return "ok"
"""
for label, prologue in lethal:
    ok, detail = module._verify(prologue + agent_tail)
    assert not ok, f"{label} was accepted: {detail}"
    assert "terminate the Brainstem" in detail["lesson"], (label, detail)

# The standard standalone idiom must NOT be refused: __name__ is the module
# name under import, so the guard is False and the exit never runs. Every agent
# in the public corpus carries this block — refusing it would reject the
# ecosystem's dominant shape.
guarded = """
import sys
from agents.basic_agent import BasicAgent

class StandaloneAgent(BasicAgent):
    def __init__(self):
        self.name = "Standalone"
        self.metadata = {"name": self.name, "parameters": {"type": "object", "properties": {}}}
    def perform(self, **kwargs):
        return "ok"

def main():
    return 0

if __name__ == "__main__":
    sys.exit(main())
"""
ok, detail = module._verify(guarded)
assert ok, f"the standalone __main__ idiom was wrongly refused: {detail}"

# The same call inside a function body is fine: it does not run at import.
safe = """
import sys
from agents.basic_agent import BasicAgent

class SafeAgent(BasicAgent):
    def __init__(self):
        self.name = "Safe"
        self.metadata = {"name": self.name, "parameters": {"type": "object", "properties": {}}}
    def perform(self, **kwargs):
        if False:
            sys.exit(1)
        return "ok"
"""
ok, detail = module._verify(safe)
assert ok, detail
`);
});

test("every Frontier agent stays safe to drag into a plain Grail brainstem", () => {
  // The compatibility contract: any agent.py this system ships or emits can be
  // dropped into an unmodified Grail agents/ folder without killing it. Grail
  // survives a syntax error or a raising import (its except-Exception clause
  // catches those) but NOT a module-level interpreter exit, so this asserts the
  // real loader outcome rather than trusting inspection.
  runPython(String.raw`
import glob
import importlib.util
import os
import sys
import types

class BasicAgent:
    def __init__(self, name=None, metadata=None):
        if name is not None: self.name = name
        if metadata is not None: self.metadata = metadata

agents_pkg = types.ModuleType("agents")
basic = types.ModuleType("agents.basic_agent")
basic.BasicAgent = BasicAgent
agents_pkg.basic_agent = basic
sys.modules["agents"] = agents_pkg
sys.modules["agents.basic_agent"] = basic

# Grail's local-storage shim, which any memory-shaped agent expects.
class _Storage:
    current_guid = None
    def set_memory_context(self, *a, **k): pass
    def read_json(self, *a, **k): return {}
    def write_json(self, *a, **k): pass
utils = types.ModuleType("utils")
azure = types.ModuleType("utils.azure_file_storage")
azure.AzureFileStorageManager = _Storage
utils.azure_file_storage = azure
sys.modules["utils"] = utils
sys.modules["utils.azure_file_storage"] = azure

shipped = sorted(glob.glob("frontier/rapplications/*/agents/*_agent.py"))
assert shipped, "no Frontier agents found to check"

survived = []
for path in shipped:
    name = os.path.basename(path)[:-3]
    try:
        spec = importlib.util.spec_from_file_location("grail_probe_" + name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except Exception:
        # Survivable: Grail catches this, logs it, and keeps serving.
        pass
    except BaseException as exc:
        raise AssertionError(
            f"{name} would kill a plain Grail brainstem on import: "
            f"{type(exc).__name__}"
        )
    survived.append(name)

assert len(survived) == len(shipped), (survived, shipped)
`);
});

test("the toaster never emits an agent that would kill a Grail brainstem", () => {
  runPython(importStub + String.raw`
import base64, os, tempfile

module = load(
    "frontier/rapplications/toaster/agents/toaster_agent.py",
    "toaster_agent_going_home",
)
module.OUT = tempfile.mkdtemp()

lethal = (
    "import os\n"
    "from agents.basic_agent import BasicAgent\n"
    "os._exit(0)\n\n"
    "class KillerAgent(BasicAgent):\n"
    "    def perform(self, **k): return 'never'\n"
)
benign = (
    "from agents.basic_agent import BasicAgent\n\n"
    "class HelperAgent(BasicAgent):\n"
    "    def __init__(self):\n"
    "        self.name = 'Helper'\n"
    "        self.metadata = {'name': 'Helper', 'parameters': {'type': 'object', 'properties': {}}}\n"
    "    def perform(self, **k): return 'ok'\n"
)

def toasted(src, name):
    blob = base64.b64encode(src.encode()).decode()
    return (
        "---\nname: " + name + "\ndescription: d\n---\n# " + name + "\n"
        + module._EMBED_OPEN + "\n" + blob + "\n" + module._EMBED_CLOSE + "\n"
    )

agent = module.ToasterAgent()
# Both emit paths carry embedded agent bytes straight to disk, so both must gate.
for action in ("untoast", "toast"):
    reply = agent.perform(action=action, skill_md=toasted(lethal, "killer"))
    assert "Refused" in reply, (action, reply)
    assert "terminate a Brainstem on import" in reply, (action, reply)

reply = agent.perform(action="untoast", skill_md=toasted(benign, "helper"))
assert "Untoasted" in reply, reply

written = sorted(os.listdir(module.OUT))
assert not any("killer" in f for f in written), written
assert any("helper" in f for f in written), written
`);
});

test("a toasted skill is readable as a skill and its blob proves the readable copy", () => {
  runPython(importStub + String.raw`
import os, tempfile

module = load(
    "frontier/rapplications/toaster/agents/toaster_agent.py",
    "toaster_agent_readable",
)
module.OUT = tempfile.mkdtemp()

source = (
    "from agents.basic_agent import BasicAgent\n\n"
    "class WeatherAgent(BasicAgent):\n"
    '    """Looks up current weather for a city."""\n'
    "    def __init__(self):\n"
    "        self.name = 'Weather'\n"
    "        self.metadata = {\n"
    "            'name': self.name,\n"
    "            'description': 'Get the current weather for a city.',\n"
    "            'parameters': {'type': 'object', 'properties': {\n"
    "                'city': {'type': 'string', 'description': 'City name'}},\n"
    "                'required': ['city']},\n"
    "        }\n"
    "    def perform(self, **kwargs):\n"
    "        return 'sunny in ' + str(kwargs.get('city'))\n"
)

agent = module.ToasterAgent()
agent.perform(action="export_skill", source=source)
name = [f for f in os.listdir(module.OUT) if f.endswith(".md")][0]
md = open(os.path.join(module.OUT, name), encoding="utf-8").read()

# READABLE: the skill states what it does, its inputs, and its actual logic —
# an AI must not have to decode base64 to learn any of that.
assert "Get the current weather for a city." in md, md[:400]
tick = chr(96)
assert ("| " + tick + "city" + tick + " | string | yes | City name |") in md, md
assert "def perform(self, **kwargs):" in md, "the deterministic layer is not readable"
assert module._READABLE_OPEN in md

# BOUND: the blob proves the readable copy.
assert module._declared_digest(md) == module._agent_digest(source)

# LOSSLESS: the round trip still returns the exact bytes.
reply = agent.perform(action="untoast", skill_md=md)
assert "Untoasted" in reply, reply
written = [f for f in os.listdir(module.OUT) if f.endswith("_agent.py")][0]
assert open(os.path.join(module.OUT, written), encoding="utf-8").read() == source

# TAMPERED: editing the readable layer alone is refused — otherwise the skill
# would describe behavior that differs from what actually runs.
tampered = md.replace("sunny in", "EXFILTRATE", 1)
assert tampered != md
reply = agent.perform(action="untoast", skill_md=tampered)
assert "Refusing to untoast" in reply, reply

# TAMPERED BLOB: swapping the authoritative bytes breaks the declared digest.
import base64, re as _re
other = source.replace("sunny", "rainy")
bad = _re.sub(
    _re.escape(module._EMBED_OPEN) + r"\s*\n.*?\n\s*" + _re.escape(module._EMBED_CLOSE),
    module._EMBED_OPEN + "\n" + base64.b64encode(other.encode()).decode() + "\n" + module._EMBED_CLOSE,
    md, count=1, flags=_re.S,
)
assert module._extract_embedded_agent(bad) == other, "test did not swap the blob"
reply = agent.perform(action="untoast", skill_md=bad)
assert "Refusing to untoast" in reply, reply
`);
});

test("a grown capability survives the launcher clearing the twins root", () => {
  runPython(importStub + String.raw`
import os, shutil, tempfile

home = tempfile.mkdtemp()
twin = os.path.join(home, "twins", "molter-1", "agents")
os.makedirs(twin)
os.environ["MOLTER_HOME"] = os.path.join(home, "molter")
os.environ["BRAINSTEM_BETA_TWIN"] = "molter-1"

module = load(
    "frontier/rapplications/molter/agents/molter_agent.py",
    "molter_agent_rehydrate",
)
module.LIVE_DIR = twin
module.HOME = os.environ["MOLTER_HOME"]
module.MOLTS = os.path.join(module.HOME, "molts")
module.STATE_FILE = os.path.join(module.HOME, "state.json")

agent = module.MolterAgent()
source = (
    "from agents.basic_agent import BasicAgent\n\n"
    "class InvoiceAgent(BasicAgent):\n"
    "    def __init__(self):\n"
    "        self.name = 'Invoice'\n"
    "        self.metadata = {'name': 'Invoice', 'parameters': {'type': 'object', 'properties': {}}}\n"
    "    def perform(self, **k):\n        return 'generation 7'\n"
)
gen, _meta = agent._record_molt(
    "invoice", source, (True, {"ok": True, "tool_name": "Invoice"}),
    "grown", None, "generation")
agent._go_live("invoice", source, "Invoice", gen)
assert os.listdir(twin) == ["invoice_agent.py"], os.listdir(twin)

# TwinManager clears the shared twins root in its constructor, so a restart —
# or simply opening a second Frontier window — deletes the live copy of every
# grown capability. The generations are durable on device, so this must be
# recoverable rather than a silent loss.
shutil.rmtree(os.path.join(home, "twins"))
os.makedirs(twin)
assert os.listdir(twin) == [], "precondition: the capability is gone"

reply = agent.perform(action="status")
assert os.listdir(twin) == ["invoice_agent.py"], (
    "the grown capability must come back", os.listdir(twin))
assert "Restored after a restart" in reply, reply
assert "invoice" in reply

# Restored bytes are the archived generation, not a fresh catalog copy.
with open(os.path.join(twin, "invoice_agent.py"), encoding="utf-8") as fh:
    assert fh.read() == source

# Idempotent: a second call restores nothing and says nothing.
again = agent.perform(action="status")
assert "Restored after a restart" not in again, again
shutil.rmtree(home)
`);
});
