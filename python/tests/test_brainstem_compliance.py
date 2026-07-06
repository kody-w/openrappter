"""RAPP brainstem drop-in compliance (rapp-spine / rapp-installer).

Every ``*_agent.py`` in ``openrappter/agents/`` must run when dropped into a
rapp-installer brainstem. This harness replicates the kernel's agent loading
contract from ``rapp_brainstem/brainstem.py`` (kody-w/rapp-installer):

- file-based module load via ``importlib.util.spec_from_file_location``
- import shims: ``basic_agent``, ``agents.basic_agent``, and
  ``openrappter.agents.basic_agent`` all resolve to the KERNEL BasicAgent
  (vendored verbatim in ``fixtures/brainstem_basic_agent.py``), and
  ``openrappter.agents`` points at the drop directory (so co-dropped modules
  like chain/graph/tracer resolve)
- a ``utils.azure_file_storage.AzureFileStorageManager`` shim (the kernel maps
  it to local storage; here a minimal in-memory stand-in)
- every public class with a ``perform`` attribute (except ``BasicAgent``) is
  instantiated with ZERO arguments and registered under ``instance.name``
- the registered instance must expose ``metadata`` (description + parameters)
  and survive ``to_tool()`` — what the kernel feeds the /chat tool loop

Each agent file is loaded in a clean subprocess so the real ``openrappter``
package can't leak in and mask a compliance break. The reference repos are
never modified — compliance is proven (and fixed) entirely on our side.
"""

import glob
import json
import os
import subprocess
import sys

import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
AGENTS_DIR = os.path.abspath(os.path.join(TESTS_DIR, "..", "openrappter", "agents"))
FIXTURE = os.path.join(TESTS_DIR, "fixtures", "brainstem_basic_agent.py")

# The loader script run per agent file — mirrors brainstem.py's
# _register_shims() + _load_agent_from_file() as closely as possible.
LOADER_SCRIPT = r'''
import importlib.util, json, os, sys, types

agents_dir, fixture, filepath = sys.argv[1], sys.argv[2], sys.argv[3]

# ── shims (mirror brainstem._register_shims) ──
spec = importlib.util.spec_from_file_location("basic_agent", fixture)
ba = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ba)
sys.modules["basic_agent"] = ba

agents_mod = types.ModuleType("agents")
agents_mod.__path__ = [agents_dir]
sys.modules["agents"] = agents_mod
ba_mod = types.ModuleType("agents.basic_agent")
ba_mod.BasicAgent = ba.BasicAgent
sys.modules["agents.basic_agent"] = ba_mod
agents_mod.basic_agent = ba_mod

# In a real brainstem, openrappter.__path__ is the brainstem dir — which
# contains no openrappter modules. Point it at an empty location so ONLY the
# shimmed submodules and the drop dir resolve; anything else must fail here
# exactly like it would fail in a real brainstem.
or_mod = types.ModuleType("openrappter")
or_mod.__path__ = [os.path.join(agents_dir, "__brainstem_has_no_openrappter_package__")]
sys.modules["openrappter"] = or_mod
or_agents = types.ModuleType("openrappter.agents")
or_agents.__path__ = [agents_dir]
or_agents.basic_agent = ba_mod
sys.modules["openrappter.agents"] = or_agents
or_mod.agents = or_agents
sys.modules["openrappter.agents.basic_agent"] = ba_mod

class _StorageStub:
    def __init__(self, *a, **k):
        self._data = {}
    def read_json(self, *a, **k):
        return dict(self._data)
    def write_json(self, data, *a, **k):
        self._data = dict(data)
    def set_memory_context(self, *a, **k):
        pass

utils_mod = types.ModuleType("utils")
utils_mod.__path__ = []
sys.modules["utils"] = utils_mod
afs_mod = types.ModuleType("utils.azure_file_storage")
afs_mod.AzureFileStorageManager = _StorageStub
sys.modules["utils.azure_file_storage"] = afs_mod
utils_mod.azure_file_storage = afs_mod

# ── load (mirror brainstem._load_agent_from_file) ──
result = {"file": os.path.basename(filepath), "agents": [], "error": None}
try:
    mod_name = "agent_" + os.path.basename(filepath).replace(".", "_")
    spec = importlib.util.spec_from_file_location(mod_name, filepath)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for attr in dir(mod):
        cls = getattr(mod, attr)
        if (
            isinstance(cls, type)
            and hasattr(cls, "perform")
            and attr not in ("BasicAgent", "object")
            and not attr.startswith("_")
        ):
            instance = cls()  # kernel instantiates with zero args
            tool = instance.to_tool()
            result["agents"].append({
                "name": instance.name,
                "class": attr,
                "has_metadata": isinstance(getattr(instance, "metadata", None), dict),
                "description": instance.metadata.get("description", ""),
                "has_parameters": isinstance(instance.metadata.get("parameters"), dict),
                "perform_callable": callable(getattr(instance, "perform", None)),
                "tool_name": tool.get("function", {}).get("name"),
            })
except Exception as e:
    import traceback
    result["error"] = f"{type(e).__name__}: {e}"
    result["traceback"] = traceback.format_exc()

print(json.dumps(result))
'''


def agent_files():
    files = sorted(glob.glob(os.path.join(AGENTS_DIR, "*_agent.py")))
    return [f for f in files if os.path.basename(f) != "basic_agent.py"]


def load_like_brainstem(filepath):
    """Load one agent file in a clean subprocess exactly like the kernel does."""
    proc = subprocess.run(
        [sys.executable, "-c", LOADER_SCRIPT, AGENTS_DIR, FIXTURE, filepath],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=TESTS_DIR,  # neutral cwd: the real openrappter package is not importable
    )
    assert proc.returncode == 0, f"loader subprocess crashed: {proc.stderr}"
    return json.loads(proc.stdout.strip().splitlines()[-1])


def test_agent_files_discovered():
    files = agent_files()
    assert len(files) >= 12, f"expected at least 12 agent files, found {len(files)}"


@pytest.mark.parametrize("filepath", agent_files(), ids=lambda f: os.path.basename(f))
def test_agent_is_brainstem_compliant(filepath):
    result = load_like_brainstem(filepath)

    assert result["error"] is None, (
        f"{result['file']} failed to load under the brainstem contract:\n"
        f"{result.get('traceback', result['error'])}"
    )
    assert len(result["agents"]) >= 1, f"{result['file']} registered no agents"

    for agent in result["agents"]:
        ctx = f"{result['file']} -> {agent['class']}"
        assert agent["name"], f"{ctx}: instance has no name"
        assert agent["has_metadata"], f"{ctx}: instance has no metadata dict"
        assert agent["description"], f"{ctx}: metadata has no description"
        assert agent["has_parameters"], f"{ctx}: metadata has no parameters schema"
        assert agent["perform_callable"], f"{ctx}: perform is not callable"
        assert agent["tool_name"] == agent["name"], (
            f"{ctx}: to_tool() name mismatch ({agent['tool_name']} != {agent['name']})"
        )
