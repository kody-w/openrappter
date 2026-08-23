#!/usr/bin/env python3
"""Tests for brainstem local-first agent adaptation."""

import os
import sys
import json
import shutil
import tempfile
import threading
import unittest

# Ensure brainstem dir is importable. This test lives in rapp_brainstem/tests/,
# so the brainstem package dir (holding brainstem.py, soul.md, soul_defaults.sha256)
# is the PARENT directory.
BRAINSTEM_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BRAINSTEM_DIR not in sys.path:
    sys.path.insert(0, BRAINSTEM_DIR)


class TestLocalStorage(unittest.TestCase):
    """Test LocalStorageManager (AzureFileStorageManager shim)."""

    def setUp(self):
        # Use a temp dir for test data
        self._orig_data_dir = None
        import local_storage
        self._orig_data_dir = local_storage._DATA_DIR
        self._tmp = tempfile.mkdtemp()
        local_storage._DATA_DIR = self._tmp

    def tearDown(self):
        import local_storage
        local_storage._DATA_DIR = self._orig_data_dir
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_read_empty(self):
        from local_storage import AzureFileStorageManager
        mgr = AzureFileStorageManager()
        self.assertEqual(mgr.read_json(), {})

    def test_write_and_read(self):
        from local_storage import AzureFileStorageManager
        mgr = AzureFileStorageManager()
        data = {"key1": {"message": "hello", "theme": "test"}}
        mgr.write_json(data)
        result = mgr.read_json()
        self.assertEqual(result, data)

    def test_user_context_isolation(self):
        from local_storage import AzureFileStorageManager
        mgr = AzureFileStorageManager()

        # Write to shared
        mgr.set_memory_context(None)
        mgr.write_json({"shared": True})

        # Write to user-specific
        mgr.set_memory_context("user-abc")
        mgr.write_json({"user": True})

        # Read shared — should not contain user data
        mgr.set_memory_context(None)
        self.assertEqual(mgr.read_json(), {"shared": True})

        # Read user-specific
        mgr.set_memory_context("user-abc")
        self.assertEqual(mgr.read_json(), {"user": True})

    def test_user_context_rejects_path_aliases(self):
        from local_storage import AzureFileStorageManager

        manager = AzureFileStorageManager()
        manager.set_memory_context("b")
        manager.write_json({"owner": "b"})

        with self.assertRaisesRegex(ValueError, "single path component"):
            manager.set_memory_context("a/../b")

        manager.set_memory_context("b")
        self.assertEqual(manager.read_json(), {"owner": "b"})

    def test_user_context_rejects_non_string_identifiers(self):
        from local_storage import AzureFileStorageManager

        manager = AzureFileStorageManager()
        manager.write_json({"shared": True})

        for user_guid in (0, 123, False):
            with self.subTest(user_guid=user_guid):
                with self.assertRaisesRegex(ValueError, "must be a string"):
                    manager.set_memory_context(user_guid)

        manager.set_memory_context(None)
        self.assertEqual(manager.read_json(), {"shared": True})

    def test_user_context_rejects_windows_path_aliases(self):
        from local_storage import AzureFileStorageManager

        manager = AzureFileStorageManager()
        for user_guid in ("user.", "user ", "CON", "con.txt", "COM1", "name:stream"):
            with self.subTest(user_guid=user_guid):
                with self.assertRaisesRegex(ValueError, "single path component"):
                    manager.set_memory_context(user_guid)

    def test_named_shares_are_isolated(self):
        from local_storage import AzureFileStorageManager

        alpha = AzureFileStorageManager(share_name="alpha")
        alpha_again = AzureFileStorageManager(share_name="ALPHA")
        beta = AzureFileStorageManager(share_name="beta")
        unnamed = AzureFileStorageManager()

        alpha.write_json({"owner": "alpha"})
        alpha.write_file("notes/item.txt", "alpha file")

        self.assertEqual(alpha_again.read_json(), {"owner": "alpha"})
        self.assertEqual(beta.read_json(), {})
        self.assertEqual(unnamed.read_json(), {})
        self.assertFalse(beta.file_exists("notes/item.txt"))
        self.assertFalse(unnamed.file_exists("notes/item.txt"))

    def test_set_memory_context(self):
        from local_storage import AzureFileStorageManager
        mgr = AzureFileStorageManager()
        mgr.set_memory_context("guid-123")
        self.assertEqual(mgr.current_guid, "guid-123")
        mgr.set_memory_context(None)
        self.assertIsNone(mgr.current_guid)

    def test_file_ops(self):
        from local_storage import AzureFileStorageManager
        mgr = AzureFileStorageManager()
        mgr.write_file("test/hello.txt", "world")
        self.assertTrue(mgr.file_exists("test/hello.txt"))
        self.assertEqual(mgr.read_file("test/hello.txt"), "world")
        self.assertIn("hello.txt", mgr.list_files("test"))
        mgr.delete_file("test/hello.txt")
        self.assertFalse(mgr.file_exists("test/hello.txt"))

    def test_concurrent_atomic_writes_use_unique_temp_files(self):
        import local_storage

        path = os.path.join(self._tmp, "state.json")
        barrier = threading.Barrier(2)
        errors = []

        def write(value):
            try:
                def emit(handle):
                    json.dump({"value": value}, handle)
                    barrier.wait(timeout=5)
                local_storage._atomic_write(path, emit)
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=write, args=(value,)) for value in (1, 2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertEqual(errors, [])
        with open(path, encoding="utf-8") as handle:
            self.assertIn(json.load(handle)["value"], (1, 2))
        self.assertEqual(os.listdir(self._tmp), ["state.json"])

    def test_transactional_updates_preserve_concurrent_changes(self):
        from local_storage import AzureFileStorageManager

        managers = [AzureFileStorageManager(), AzureFileStorageManager()]
        barrier = threading.Barrier(2)
        errors = []

        def update(index):
            try:
                barrier.wait(timeout=5)
                managers[index].update_json(
                    lambda data: {**data, str(index): index})
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=update, args=(index,)) for index in (0, 1)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertEqual(errors, [])
        self.assertEqual(managers[0].read_json(), {"0": 0, "1": 1})

    def test_transactional_update_preserves_malformed_json(self):
        from local_storage import AzureFileStorageManager

        manager = AzureFileStorageManager()
        path = manager._file_path()
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("{ recoverable but malformed")

        with self.assertRaises(json.JSONDecodeError):
            manager.update_json(lambda data: {**data, "new": True})

        with open(path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "{ recoverable but malformed")


class TestShimRegistration(unittest.TestCase):
    """Test that sys.modules shims work for remote agent imports."""

    def setUp(self):
        # Clean any previously registered shims so we can test fresh
        import brainstem
        brainstem._shims_registered = False
        for mod in list(sys.modules):
            if mod.startswith("utils.azure") or mod.startswith("utils.dynamics"):
                del sys.modules[mod]

    def test_azure_storage_shim_imports(self):
        """After _register_shims(), `from utils.azure_file_storage import AzureFileStorageManager` should work."""
        import brainstem
        brainstem._register_shims()

        from utils.azure_file_storage import AzureFileStorageManager
        mgr = AzureFileStorageManager()
        self.assertTrue(hasattr(mgr, "read_json"))
        self.assertTrue(hasattr(mgr, "write_json"))
        self.assertTrue(hasattr(mgr, "set_memory_context"))

    def test_basic_agent_shim_imports(self):
        """After _register_shims(), `from agents.basic_agent import BasicAgent` should work."""
        import brainstem
        brainstem._register_shims()

        from agents.basic_agent import BasicAgent
        agent = BasicAgent(name="Test", metadata={"name": "Test", "description": "test"})
        self.assertEqual(agent.name, "Test")

    def test_dynamics_storage_shim(self):
        """utils.dynamics_storage should also be shimmed."""
        import brainstem
        brainstem._register_shims()

        from utils.dynamics_storage import DynamicsStorageManager
        mgr = DynamicsStorageManager()
        self.assertTrue(hasattr(mgr, "read_json"))


class TestAgentLoading(unittest.TestCase):
    """Test loading remote agents with cloud deps through shims."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        import local_storage
        self._orig_data_dir = local_storage._DATA_DIR
        local_storage._DATA_DIR = self._tmp
        import brainstem
        brainstem._shims_registered = False

    def tearDown(self):
        import local_storage
        local_storage._DATA_DIR = self._orig_data_dir
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_load_agent_with_azure_import(self):
        """An agent that imports AzureFileStorageManager should load via the local shim."""
        agent_code = '''
from agents.basic_agent import BasicAgent
from utils.azure_file_storage import AzureFileStorageManager

class TestMemoryAgent(BasicAgent):
    def __init__(self):
        self.name = "TestMemory"
        self.metadata = {
            "name": self.name,
            "description": "Test agent using Azure storage shim",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
        self.storage = AzureFileStorageManager()
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        self.storage.write_json({"test": True})
        data = self.storage.read_json()
        return f"Storage works: {data}"
'''
        filepath = os.path.join(self._tmp, "test_memory_agent.py")
        with open(filepath, "w") as f:
            f.write(agent_code)

        import brainstem
        agents = brainstem._load_agent_from_file(filepath)
        self.assertIn("TestMemory", agents)
        result = agents["TestMemory"].perform()
        self.assertIn("Storage works", result)

    def test_load_agent_with_missing_pip_dep(self):
        """An agent that imports a missing package should trigger auto-install."""
        # We'll use a package we know is installed (json) to avoid actually pip installing
        agent_code = '''
from agents.basic_agent import BasicAgent
import json  # always available

class SimplePipAgent(BasicAgent):
    def __init__(self):
        self.name = "SimplePip"
        self.metadata = {
            "name": self.name,
            "description": "Test agent",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return json.dumps({"status": "ok"})
'''
        filepath = os.path.join(self._tmp, "simple_pip_agent.py")
        with open(filepath, "w") as f:
            f.write(agent_code)

        import brainstem
        agents = brainstem._load_agent_from_file(filepath)
        self.assertIn("SimplePip", agents)

    def test_load_agent_with_to_tool(self):
        """Loaded agents should have working to_tool() method."""
        agent_code = '''
from agents.basic_agent import BasicAgent

class ToolTestAgent(BasicAgent):
    def __init__(self):
        self.name = "ToolTest"
        self.metadata = {
            "name": self.name,
            "description": "Tests to_tool",
            "parameters": {"type": "object", "properties": {"q": {"type": "string"}}, "required": []}
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return "ok"
'''
        filepath = os.path.join(self._tmp, "tool_test_agent.py")
        with open(filepath, "w") as f:
            f.write(agent_code)

        import brainstem
        agents = brainstem._load_agent_from_file(filepath)
        tool = agents["ToolTest"].to_tool()
        self.assertEqual(tool["type"], "function")
        self.assertEqual(tool["function"]["name"], "ToolTest")


class TestExtractPackageName(unittest.TestCase):
    """Test pip package name extraction from errors."""

    def test_simple_module(self):
        import brainstem
        err = ModuleNotFoundError("No module named 'bs4'")
        self.assertEqual(brainstem._extract_package_name(err), "beautifulsoup4")

    def test_dotted_module(self):
        import brainstem
        err = ModuleNotFoundError("No module named 'PIL.Image'")
        self.assertEqual(brainstem._extract_package_name(err), "Pillow")

    def test_unknown_module(self):
        import brainstem
        err = ModuleNotFoundError("No module named 'somethingweird'")
        self.assertEqual(brainstem._extract_package_name(err), "somethingweird")


class TestLoginPoll(unittest.TestCase):
    """Test /login/poll endpoint reads _login_result instead of racing poll_device_code()."""

    def setUp(self):
        import brainstem
        self.brainstem = brainstem
        self.app = brainstem.app
        self.app.testing = True
        self.client = self.app.test_client()
        # Save original state
        self._orig_login_result = brainstem._login_result
        self._orig_pending_login = brainstem._pending_login
        self._orig_copilot_cache = brainstem._copilot_token_cache.copy()
        self._orig_github_token = os.environ.pop("GITHUB_TOKEN", None)

    def tearDown(self):
        # Restore original state
        self.brainstem._login_result = self._orig_login_result
        self.brainstem._pending_login = self._orig_pending_login
        self.brainstem._copilot_token_cache = self._orig_copilot_cache
        if self._orig_github_token is not None:
            os.environ["GITHUB_TOKEN"] = self._orig_github_token

    def test_returns_ok_from_login_result(self):
        """When bg thread writes success to _login_result, /login/poll returns ok."""
        self.brainstem._login_result = {"status": "ok", "message": "Authenticated with GitHub Copilot!"}
        self.brainstem._pending_login = {}
        resp = self.client.post("/login/poll")
        data = resp.get_json()
        self.assertEqual(data["status"], "ok")
        self.assertIn("Authenticated", data["message"])

    def test_returns_error_from_login_result(self):
        """When bg thread writes NO_COPILOT_ACCESS to _login_result, /login/poll returns it."""
        self.brainstem._login_result = {"status": "error", "error": "NO_COPILOT_ACCESS:testuser"}
        self.brainstem._pending_login = {}
        resp = self.client.post("/login/poll")
        data = resp.get_json()
        self.assertEqual(data["status"], "error")
        self.assertIn("NO_COPILOT_ACCESS", data["error"])
        self.assertIn("testuser", data["error"])

    def test_returns_pending_when_waiting(self):
        """When _pending_login is active and no result yet, returns pending."""
        self.brainstem._login_result = {}
        self.brainstem._pending_login = {
            "device_code": "abc",
            "user_code": "ABCD-1234",
            "verification_uri": "https://github.com/login/device",
            "interval": 5,
            "expires_at": __import__("time").time() + 600,
        }
        resp = self.client.post("/login/poll")
        data = resp.get_json()
        self.assertEqual(data["status"], "pending")

    def test_returns_expired_when_code_expired(self):
        """When _pending_login has expired, returns expired status."""
        self.brainstem._login_result = {}
        self.brainstem._pending_login = {
            "device_code": "abc",
            "expires_at": __import__("time").time() - 10,  # expired 10s ago
        }
        resp = self.client.post("/login/poll")
        data = resp.get_json()
        self.assertEqual(data["status"], "expired")
        self.assertIn("expired", data["error"].lower())

    def test_returns_expired_when_no_pending_login(self):
        """When _pending_login is empty and no result, returns expired."""
        self.brainstem._login_result = {}
        self.brainstem._pending_login = {}
        resp = self.client.post("/login/poll")
        data = resp.get_json()
        self.assertEqual(data["status"], "expired")
        self.assertIn("No login in progress", data["error"])

    def test_login_result_takes_priority_over_pending(self):
        """_login_result is checked before _pending_login state."""
        self.brainstem._login_result = {"status": "ok", "message": "Done!"}
        self.brainstem._pending_login = {
            "device_code": "abc",
            "expires_at": __import__("time").time() + 600,
        }
        resp = self.client.post("/login/poll")
        data = resp.get_json()
        self.assertEqual(data["status"], "ok")


class TestLoginStateCleanup(unittest.TestCase):
    """Test that starting new login flows clears stale state."""

    def setUp(self):
        import brainstem
        self.brainstem = brainstem
        self.app = brainstem.app
        self.app.testing = True
        self.client = self.app.test_client()
        # Save original state
        self._orig_login_result = brainstem._login_result
        self._orig_pending_login = brainstem._pending_login
        self._orig_copilot_cache = brainstem._copilot_token_cache.copy()
        self._orig_token_file = brainstem._token_file
        self._orig_cache_file = brainstem._copilot_cache_file
        self._orig_pending_file = brainstem._pending_login_file
        self._orig_no_copilot = dict(brainstem._no_copilot_access)
        self._orig_github_token = os.environ.pop("GITHUB_TOKEN", None)
        self._tmp = tempfile.mkdtemp(prefix="login-state-test-")
        brainstem._token_file = os.path.join(self._tmp, ".copilot_token")
        brainstem._copilot_cache_file = os.path.join(self._tmp, ".copilot_session")
        brainstem._pending_login_file = os.path.join(self._tmp, ".copilot_pending")

    def tearDown(self):
        self.brainstem._login_result = self._orig_login_result
        self.brainstem._pending_login = self._orig_pending_login
        self.brainstem._copilot_token_cache = self._orig_copilot_cache
        self.brainstem._token_file = self._orig_token_file
        self.brainstem._copilot_cache_file = self._orig_cache_file
        self.brainstem._pending_login_file = self._orig_pending_file
        self.brainstem._no_copilot_access = self._orig_no_copilot
        if self._orig_github_token is not None:
            os.environ["GITHUB_TOKEN"] = self._orig_github_token
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_login_switch_clears_login_result(self):
        """POST /login/switch should clear _login_result."""
        self.brainstem._login_result = {"status": "error", "error": "NO_COPILOT_ACCESS:old"}
        self.brainstem._copilot_token_cache = {"token": "old", "endpoint": "x", "expires_at": 0}
        # login/switch will try to start a new device code flow which calls GitHub API
        # so we just test that the state gets cleared by calling the function directly
        # rather than hitting the endpoint (which would require network)
        from unittest.mock import patch
        with patch.object(self.brainstem, 'start_device_code_login', return_value={"user_code": "TEST", "verification_uri": "https://github.com/login/device"}):
            resp = self.client.post("/login/switch")
        self.assertEqual(self.brainstem._login_result, {})
        self.assertIsNone(self.brainstem._copilot_token_cache["token"])

    def test_start_device_code_clears_stale_state(self):
        """start_device_code_login() should clear _login_result and Copilot cache."""
        self.brainstem._login_result = {"status": "ok", "message": "stale"}
        self.brainstem._copilot_token_cache = {"token": "stale", "endpoint": "x", "expires_at": 9999999999}
        self.brainstem._pending_login = {}  # No existing code to reuse
        from unittest.mock import patch, MagicMock
        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "device_code": "test_dc",
            "user_code": "TEST-CODE",
            "verification_uri": "https://github.com/login/device",
            "interval": 5,
            "expires_in": 900,
        }
        mock_resp.raise_for_status = MagicMock()
        with patch("requests.post", return_value=mock_resp):
            with patch.object(self.brainstem, '_start_bg_poll'):
                self.brainstem.start_device_code_login(force_new=True)
        self.assertEqual(self.brainstem._login_result, {})
        self.assertIsNone(self.brainstem._copilot_token_cache["token"])

    def test_completed_device_login_invalidates_old_account_session(self):
        import time
        from unittest.mock import MagicMock, patch

        self.brainstem._pending_login = {
            "device_code": "device-code",
            "expires_at": time.time() + 60,
        }
        self.brainstem._copilot_token_cache = {
            "token": "old-account-session",
            "endpoint": "https://old.example",
            "expires_at": time.time() + 1800,
        }
        self.brainstem._save_copilot_cache(
            "old-account-session", "https://old.example",
            time.time() + 1800, "ghu_old_account",
        )
        response = MagicMock()
        response.json.return_value = {
            "access_token": "ghu_new_account",
            "refresh_token": "refresh-new",
        }

        with patch.object(self.brainstem.requests, "post", return_value=response):
            token = self.brainstem.poll_device_code()

        self.assertEqual(token, "ghu_new_account")
        self.assertIsNone(self.brainstem._copilot_token_cache["token"])
        self.assertFalse(os.path.exists(self.brainstem._copilot_cache_file))

    def test_reuse_existing_code_preserves_login_result(self):
        """When reusing a non-expired code, _login_result should NOT be cleared."""
        import time
        self.brainstem._pending_login = {
            "device_code": "existing",
            "user_code": "REUSE-ME",
            "verification_uri": "https://github.com/login/device",
            "interval": 5,
            "expires_at": time.time() + 600,
        }
        self.brainstem._login_result = {"status": "ok", "message": "previous success"}
        result = self.brainstem.start_device_code_login(force_new=False)
        self.assertEqual(result["user_code"], "REUSE-ME")
        # _login_result should be untouched because we reused the existing code
        self.assertEqual(self.brainstem._login_result["status"], "ok")


class TestMemoryAgentIntegration(unittest.TestCase):
    """End-to-end: load the real context_memory_agent and manage_memory_agent from remote repo."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        import local_storage
        self._orig = local_storage._DATA_DIR
        local_storage._DATA_DIR = self._tmp
        import brainstem
        brainstem._shims_registered = False

    def tearDown(self):
        import local_storage
        local_storage._DATA_DIR = self._orig
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_manage_then_recall_memory(self):
        """ManageMemory stores, ContextMemory recalls — both using local storage.

        Exercises the BUNDLED agents shipped in agents/ (no network): those are the
        ones a real install actually runs, and this keeps the test hermetic/offline.
        """
        import brainstem

        agents_dir = os.path.join(os.path.dirname(os.path.abspath(brainstem.__file__)), "agents")

        # Load both bundled agents
        manage_agents = brainstem._load_agent_from_file(os.path.join(agents_dir, "manage_memory_agent.py"))
        context_agents = brainstem._load_agent_from_file(os.path.join(agents_dir, "context_memory_agent.py"))

        self.assertIn("ManageMemory", manage_agents)
        self.assertIn("ContextMemory", context_agents)

        # Store a memory
        result = manage_agents["ManageMemory"].perform(
            memory_type="fact",
            content="The brainstem project uses local-first storage"
        )
        self.assertIn("Successfully stored", result)

        # Recall it
        result = context_agents["ContextMemory"].perform(full_recall=True)
        self.assertIn("brainstem", result.lower())

    def test_full_recall_respects_max_messages(self):
        import brainstem

        agents_dir = os.path.join(os.path.dirname(os.path.abspath(brainstem.__file__)), "agents")
        context = brainstem._load_agent_from_file(
            os.path.join(agents_dir, "context_memory_agent.py"))["ContextMemory"]
        context.storage_manager.write_json({
            str(index): {
                "message": f"memory-{index}",
                "theme": "fact",
                "date": "2026-07-09",
                "time": f"00:00:{index:02d}",
            }
            for index in range(10)
        })

        result = context.perform(full_recall=True, max_messages=3)
        self.assertEqual(result.count("(Theme:"), 3)
        self.assertIn("memory-9", result)
        self.assertNotIn("memory-0", result)

    def test_keyword_miss_does_not_return_unrelated_memories(self):
        import brainstem

        agents_dir = os.path.join(os.path.dirname(os.path.abspath(brainstem.__file__)), "agents")
        context = brainstem._load_agent_from_file(
            os.path.join(agents_dir, "context_memory_agent.py"))["ContextMemory"]
        context.storage_manager.write_json({
            "private": {
                "message": "unrelated private memory",
                "theme": "account",
            }
        })

        result = context.perform(keywords=["vacation"])

        self.assertEqual(result, "No matching memories found.")
        self.assertNotIn("private memory", result)

    def test_manage_memory_persists_declared_importance_and_tags(self):
        import brainstem

        agents_dir = os.path.join(os.path.dirname(os.path.abspath(brainstem.__file__)), "agents")
        manager = brainstem._load_agent_from_file(
            os.path.join(agents_dir, "manage_memory_agent.py"))["ManageMemory"]

        manager.perform(
            memory_type="preference",
            content="prefers concise answers",
            importance=5,
            tags=["communication", "style", 7],
        )

        stored = next(iter(manager.storage_manager.read_json().values()))
        self.assertEqual(stored["importance"], 5)
        self.assertEqual(stored["tags"], ["communication", "style"])

    def test_concurrent_manage_memory_saves_are_not_lost(self):
        import brainstem
        import local_storage

        agents_dir = os.path.join(os.path.dirname(os.path.abspath(brainstem.__file__)), "agents")
        path = os.path.join(agents_dir, "manage_memory_agent.py")
        managers = [
            brainstem._load_agent_from_file(path)["ManageMemory"],
            brainstem._load_agent_from_file(path)["ManageMemory"],
        ]
        barrier = threading.Barrier(2)
        errors = []

        def save(index):
            try:
                barrier.wait(timeout=5)
                managers[index].perform(
                    memory_type="fact", content=f"concurrent memory {index}")
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=save, args=(index,)) for index in (0, 1)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertEqual(errors, [])
        stored = local_storage.AzureFileStorageManager().read_json()
        self.assertEqual(
            {entry["message"] for entry in stored.values()},
            {"concurrent memory 0", "concurrent memory 1"},
        )


class TestHackerNewsAgent(unittest.TestCase):

    def _load(self):
        import brainstem

        agents_dir = os.path.join(os.path.dirname(os.path.abspath(brainstem.__file__)), "agents")
        return brainstem._load_agent_from_file(
            os.path.join(agents_dir, "hacker_news_agent.py"))["HackerNews"]

    def test_malformed_count_returns_structured_error_without_fetching(self):
        from unittest.mock import MagicMock, patch

        agent = self._load()
        fetch = MagicMock()
        with patch.dict(agent.perform.__func__.__globals__, {"_fetch_json": fetch}):
            result = json.loads(agent.perform(count="many"))

        self.assertEqual(result["status"], "error")
        self.assertIn("count must be an integer", result["message"])
        fetch.assert_not_called()

    def test_non_list_top_stories_payload_returns_structured_error(self):
        from unittest.mock import patch

        agent = self._load()
        fetch = lambda url: {"unexpected": True}
        with patch.dict(agent.perform.__func__.__globals__, {"_fetch_json": fetch}):
            result = json.loads(agent.perform(count=5))

        self.assertEqual(result["status"], "error")
        self.assertIn("not a list", result["message"])


class TestExperimentalResearchAgent(unittest.TestCase):

    def test_nonzero_cli_exit_never_returns_partial_stdout_as_success(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        import brainstem

        path = os.path.join(
            os.path.dirname(os.path.abspath(brainstem.__file__)),
            "agents", "experimental", "copilot_research_agent.py",
        )
        agent = brainstem._load_agent_from_file(path)["CopilotResearch"]
        globals_dict = agent.perform.__func__.__globals__
        result = SimpleNamespace(
            returncode=1,
            stdout="partial answer that must not be trusted",
            stderr="command failed",
        )

        with patch.dict(globals_dict, {"_COPILOT_BIN": "copilot"}), \
             patch.object(globals_dict["subprocess"], "run", return_value=result):
            output = agent.perform(query="current topic")

        self.assertIn("Copilot CLI error (exit 1)", output)
        self.assertIn("command failed", output)
        self.assertNotEqual(output, result.stdout)


class TestFetchCopilotModels(unittest.TestCase):
    """_fetch_copilot_models() must keep only chat models with a /chat/completions route."""

    # A model with a /chat/completions route, a Responses-API-only chat model,
    # an embeddings model, a legacy chat model with no endpoints field, a chat
    # model with an empty endpoints list, and an o1 model.
    SAMPLE = [
        {"id": "chat-ok", "name": "Chat OK", "capabilities": {"type": "chat"},
         "supported_endpoints": ["/responses", "/chat/completions"]},
        {"id": "responses-only", "name": "Responses Only", "capabilities": {"type": "chat"},
         "supported_endpoints": ["/responses", "ws:/responses"]},
        {"id": "embed-1", "name": "Embed", "capabilities": {"type": "embeddings"}},
        {"id": "chat-legacy", "name": "Legacy chat (no endpoints field)",
         "capabilities": {"type": "chat"}},
        {"id": "chat-empty-endpoints", "name": "Empty endpoints",
         "capabilities": {"type": "chat"}, "supported_endpoints": []},
        {"id": "o1-preview", "name": "o1 preview", "capabilities": {"type": "chat"},
         "supported_endpoints": ["/chat/completions"]},
    ]

    def setUp(self):
        import brainstem
        self.brainstem = brainstem
        self._orig_models = list(brainstem.AVAILABLE_MODELS)
        self._orig_no_tc = set(brainstem._NO_TOOL_CHOICE_MODELS)
        self._orig_fetched = brainstem._models_fetched

    def tearDown(self):
        self.brainstem.AVAILABLE_MODELS = self._orig_models
        self.brainstem._NO_TOOL_CHOICE_MODELS = self._orig_no_tc
        self.brainstem._models_fetched = self._orig_fetched

    def _run_fetch(self, payload):
        from unittest.mock import patch, MagicMock
        self.brainstem._models_fetched = False
        self.brainstem._NO_TOOL_CHOICE_MODELS = set()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = payload
        with patch.object(self.brainstem, "get_copilot_token", return_value=("tok", "https://api.example")):
            with patch("requests.get", return_value=mock_resp):
                self.brainstem._fetch_copilot_models()

    def test_filters_to_chat_completions_models(self):
        self._run_fetch({"data": self.SAMPLE})
        ids = [m["id"] for m in self.brainstem.AVAILABLE_MODELS]
        # Kept: chat route present, OR endpoints field absent (fail open).
        self.assertIn("chat-ok", ids)
        self.assertIn("chat-legacy", ids)
        self.assertIn("o1-preview", ids)
        # Skipped: Responses-only, embeddings, and empty endpoints list.
        self.assertNotIn("responses-only", ids)
        self.assertNotIn("embed-1", ids)
        self.assertNotIn("chat-empty-endpoints", ids)
        self.assertEqual(len(ids), 3)

    def test_o1_model_marked_no_tool_choice(self):
        self._run_fetch({"data": self.SAMPLE})
        self.assertIn("o1-preview", self.brainstem._NO_TOOL_CHOICE_MODELS)
        self.assertNotIn("chat-ok", self.brainstem._NO_TOOL_CHOICE_MODELS)

    def test_empty_result_keeps_defaults(self):
        """If filtering yields nothing, the existing AVAILABLE_MODELS is preserved."""
        sentinel = [{"id": "keep-me", "name": "Keep Me"}]
        self.brainstem.AVAILABLE_MODELS = list(sentinel)
        # Only an embeddings model -> filtered out -> new_models empty -> defaults kept.
        self._run_fetch({"data": [{"id": "embed-only", "capabilities": {"type": "embeddings"}}]})
        self.assertEqual(self.brainstem.AVAILABLE_MODELS, sentinel)


class TestAgentQuarantine(unittest.TestCase):
    """Hot-load boundary: a tool-illegal cartridge is quarantined (skipped, logged
    once, surfaced in /health) instead of poisoning the tools array and 400-ing every
    /chat. See issue #33 — a machine-generated cartridge carried a human display name
    ('Tech Reviewer') as self.name and silently killed all chats on v0.6.7."""

    GOOD_AGENT = '''
from agents.basic_agent import BasicAgent

class GoodReviewerAgent(BasicAgent):
    def __init__(self):
        self.name = "GoodReviewer"
        self.metadata = {
            "name": self.name,
            "description": "A well-formed agent",
            "parameters": {"type": "object", "properties": {"q": {"type": "string"}}, "required": []}
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return "ok"
'''

    def _bad_name_agent(self, name):
        """A cartridge whose class name is fine but self.name is tool-illegal."""
        return f'''
from agents.basic_agent import BasicAgent

class TechReviewerAgent(BasicAgent):
    def __init__(self):
        self.name = {name!r}
        self.metadata = {{
            "name": self.name,
            "description": "Cartridge carrying a human display name",
            "parameters": {{"type": "object", "properties": {{}}, "required": []}}
        }}
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return "ok"
'''

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        import brainstem
        import local_storage
        self.brainstem = brainstem
        self._orig_agents_path = brainstem.AGENTS_PATH
        brainstem.AGENTS_PATH = self._tmp
        self._orig_data_dir = local_storage._DATA_DIR
        local_storage._DATA_DIR = self._tmp
        brainstem._shims_registered = False
        # Isolate quarantine + flight-log state so memoization/log assertions are clean.
        self._orig_quar = dict(brainstem._quarantined_agents)
        self._orig_logged = set(brainstem._quarantine_logged)
        brainstem._quarantined_agents.clear()
        brainstem._quarantine_logged.clear()
        with brainstem._flight_log_lock:
            self._orig_flight = list(brainstem._flight_log)
            brainstem._flight_log.clear()
        self.app = brainstem.app
        self.app.testing = True
        self.client = self.app.test_client()

    def tearDown(self):
        import local_storage
        self.brainstem.AGENTS_PATH = self._orig_agents_path
        local_storage._DATA_DIR = self._orig_data_dir
        self.brainstem._quarantined_agents.clear()
        self.brainstem._quarantined_agents.update(self._orig_quar)
        self.brainstem._quarantine_logged.clear()
        self.brainstem._quarantine_logged.update(self._orig_logged)
        with self.brainstem._flight_log_lock:
            self.brainstem._flight_log[:] = self._orig_flight
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _write(self, filename, code):
        path = os.path.join(self._tmp, filename)
        with open(path, "w") as f:
            f.write(code)
        return path

    def test_bad_name_quarantined_good_still_loads(self):
        """A space in name (the canonical bad case) is quarantined; a healthy agent
        in the same directory still loads in the same sweep."""
        bad = self._write("tech_reviewer_agent.py", self._bad_name_agent("Tech Reviewer"))
        self._write("good_reviewer_agent.py", self.GOOD_AGENT)

        agents = self.brainstem.load_agents()

        self.assertIn("GoodReviewer", agents)
        self.assertNotIn("Tech Reviewer", agents)
        self.assertIn(bad, self.brainstem._quarantined_agents)
        self.assertEqual(self.brainstem._quarantined_agents[bad]["class"], "TechReviewerAgent")
        self.assertIn("tool-safe", self.brainstem._quarantined_agents[bad]["reason"])

    def test_quarantined_absent_from_tools(self):
        """The quarantined cartridge never reaches the tools array shipped to Copilot."""
        self._write("tech_reviewer_agent.py", self._bad_name_agent("Tech Reviewer"))
        self._write("good_reviewer_agent.py", self.GOOD_AGENT)

        agents = self.brainstem.load_agents()
        # Build tools exactly like the /chat handler does.
        tools = [a.to_tool() for a in agents.values()]
        names = [t["function"]["name"] for t in tools]

        self.assertIn("GoodReviewer", names)
        self.assertNotIn("Tech Reviewer", names)
        # Every shipped tool name is tool-safe — nothing that could 400 the request.
        for n in names:
            self.assertRegex(n, r"^[a-zA-Z0-9_-]+$")

    def test_health_lists_quarantined_with_reason(self):
        """/health surfaces the quarantined cartridge with file, class, and reason."""
        self._write("tech_reviewer_agent.py", self._bad_name_agent("Tech Reviewer"))

        resp = self.client.get("/health")
        data = resp.get_json()

        self.assertIn("quarantined", data)
        entry = next((q for q in data["quarantined"] if q["file"] == "tech_reviewer_agent.py"), None)
        self.assertIsNotNone(entry)
        self.assertEqual(entry["class"], "TechReviewerAgent")
        self.assertIn("tool-safe", entry["reason"])

    def test_health_quarantined_empty_when_clean(self):
        """With only healthy agents, /health reports an empty quarantine list."""
        self._write("good_reviewer_agent.py", self.GOOD_AGENT)

        resp = self.client.get("/health")
        data = resp.get_json()

        self.assertEqual(data.get("quarantined"), [])

    def test_repeated_sweeps_do_not_duplicate_log(self):
        """load_agents() runs on every /chat — the same bad cartridge is flight-logged
        exactly once per process, not on every sweep, while the registry stays current."""
        bad = self._write("tech_reviewer_agent.py", self._bad_name_agent("Tech Reviewer"))

        self.brainstem.load_agents()
        self.brainstem.load_agents()
        self.brainstem.load_agents()

        with self.brainstem._flight_log_lock:
            warns = [
                e for e in self.brainstem._flight_log
                if e.get("type") == "agent.quarantined"
                and e.get("data", {}).get("file") == "tech_reviewer_agent.py"
            ]
        self.assertEqual(len(warns), 1)
        self.assertEqual(warns[0]["level"], "warn")
        # The registry still reflects it after every sweep, even though the log didn't repeat.
        self.assertIn(bad, self.brainstem._quarantined_agents)

    def test_empty_name_quarantined(self):
        """An empty name is quarantined (not a non-empty string)."""
        bad = self._write("empty_name_agent.py", self._bad_name_agent(""))

        agents = self.brainstem.load_agents()

        self.assertEqual(agents, {})
        self.assertIn(bad, self.brainstem._quarantined_agents)
        self.assertIn("non-empty", self.brainstem._quarantined_agents[bad]["reason"])

    def test_non_dict_metadata_quarantined(self):
        """Non-dict metadata is quarantined (name is valid, so metadata is the cause)."""
        code = '''
from agents.basic_agent import BasicAgent

class BadMetaAgent(BasicAgent):
    def __init__(self):
        self.name = "BadMeta"
        self.metadata = ["not", "a", "dict"]
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return "ok"
'''
        bad = self._write("bad_meta_agent.py", code)

        agents = self.brainstem.load_agents()

        self.assertNotIn("BadMeta", agents)
        self.assertIn(bad, self.brainstem._quarantined_agents)
        self.assertIn("metadata is not a dict", self.brainstem._quarantined_agents[bad]["reason"])

    def test_provider_invalid_parameter_schema_is_quarantined(self):
        for filename, parameters, reason in (
            (
                "bad_required_agent.py",
                '{"type": "object", "properties": {}, "required": "query"}',
                "required must be an array of strings",
            ),
            (
                "bad_property_agent.py",
                '{"type": "object", "properties": {"query": "string"}}',
                "properties must map string names to schema objects",
            ),
        ):
            with self.subTest(filename=filename):
                code = f'''
from agents.basic_agent import BasicAgent

class InvalidSchemaAgent(BasicAgent):
    def __init__(self):
        self.name = "InvalidSchema"
        self.metadata = {{
            "name": self.name,
            "description": "invalid schema",
            "parameters": {parameters},
        }}
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return "unexpected"
'''
                path = self._write(filename, code)

                agents = self.brainstem.load_agents()

                self.assertNotIn("InvalidSchema", agents)
                self.assertIn(reason, self.brainstem._quarantined_agents[path]["reason"])
                os.remove(path)

    def test_explicit_null_tool_schema_fields_are_invalid(self):
        from types import SimpleNamespace

        cases = (
            ({"description": None}, "description"),
            ({"description": "x", "parameters": None}, "parameters"),
            ({"description": "x", "parameters": {
                "type": "object", "properties": None,
            }}, "properties"),
            ({"description": "x", "parameters": {
                "type": "object", "properties": {}, "required": None,
            }}, "required"),
        )
        for metadata, reason in cases:
            with self.subTest(reason=reason):
                instance = SimpleNamespace(name="NullSchema", metadata=metadata)
                self.assertIn(
                    reason,
                    self.brainstem._validate_agent_instance(instance),
                )

        nested = SimpleNamespace(name="NestedNull", metadata={
            "description": "nested schema",
            "parameters": {
                "type": "object",
                "properties": {
                    "filter": {"type": "object", "properties": None},
                },
            },
        })
        self.assertIn(
            "properties",
            self.brainstem._validate_agent_instance(nested),
        )

    def test_duplicate_names_within_one_file_are_entirely_quarantined(self):
        code = '''
from agents.basic_agent import BasicAgent

class FirstAgent(BasicAgent):
    def __init__(self):
        self.name = "Duplicate"
        self.metadata = {"name": self.name, "description": "first", "parameters": {"type": "object", "properties": {}}}
        super().__init__(name=self.name, metadata=self.metadata)
    def perform(self, **kwargs):
        return "first"

class SecondAgent(FirstAgent):
    def perform(self, **kwargs):
        return "second"

class ThirdAgent(FirstAgent):
    def perform(self, **kwargs):
        return "third"
'''
        path = self._write("duplicates_agent.py", code)

        agents = self.brainstem.load_agents()

        self.assertNotIn("Duplicate", agents)
        self.assertIn(path, self.brainstem._quarantined_agents)
        self.assertIn("within one file", self.brainstem._quarantined_agents[path]["reason"])

    def test_duplicate_agent_name_keeps_first_sorted_file(self):
        first = self.GOOD_AGENT.replace('return "ok"', 'return "first"')
        second = self.GOOD_AGENT.replace('return "ok"', 'return "second"')
        self._write("a_reviewer_agent.py", first)
        duplicate = self._write("z_reviewer_agent.py", second)

        agents = self.brainstem.load_agents()

        self.assertEqual(agents["GoodReviewer"].perform(), "first")
        self.assertIn(duplicate, self.brainstem._quarantined_agents)
        self.assertIn("duplicate agent name", self.brainstem._quarantined_agents[duplicate]["reason"])

    def test_missing_parameters_is_lenient(self):
        """Missing 'parameters' is fine — BasicAgent defaults it; the agent loads clean."""
        code = '''
from agents.basic_agent import BasicAgent

class NoParamsAgent(BasicAgent):
    def __init__(self):
        self.name = "NoParams"
        self.metadata = {"name": self.name, "description": "no parameters key"}
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return "ok"
'''
        self._write("no_params_agent.py", code)

        agents = self.brainstem.load_agents()

        self.assertIn("NoParams", agents)
        self.assertEqual(self.brainstem._quarantine_snapshot(), [])

    def test_fixed_cartridge_leaves_quarantine_next_sweep(self):
        """The registry is rebuilt each sweep — a repaired cartridge stops being quarantined."""
        path = self._write("tech_reviewer_agent.py", self._bad_name_agent("Tech Reviewer"))
        self.brainstem.load_agents()
        self.assertIn(path, self.brainstem._quarantined_agents)

        # Repair the same file to a tool-safe name and re-sweep.
        self._write("tech_reviewer_agent.py", self._bad_name_agent("TechReviewer"))
        agents = self.brainstem.load_agents()

        self.assertIn("TechReviewer", agents)
        self.assertNotIn(path, self.brainstem._quarantined_agents)
        self.assertEqual(self.brainstem._quarantine_snapshot(), [])


class TestCopilotTimeout(unittest.TestCase):
    """call_copilot retries once on a read timeout, then surfaces a clean, human message.

    Guards the enterprise-endpoint report where a raw urllib3
    'HTTPSConnectionPool(host=...): Read timed out. (read timeout=60)' string
    leaked straight into the chat UI.
    """

    def setUp(self):
        import brainstem
        self.brainstem = brainstem
        self._orig_model = brainstem.MODEL
        # Pin a plain model; with tools=None the tool_choice path is untouched.
        brainstem.MODEL = "gpt-4o"

    def tearDown(self):
        self.brainstem.MODEL = self._orig_model

    def _ok_response(self):
        from unittest.mock import MagicMock
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = {
            "choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]
        }
        resp.raise_for_status = MagicMock()
        return resp

    def test_retry_succeeds_after_one_timeout(self):
        import requests
        from unittest.mock import patch
        brainstem = self.brainstem
        ok = self._ok_response()
        with patch.object(brainstem, "get_copilot_token", return_value=("tok", "https://api.example")), \
             patch.object(brainstem, "_tlog") as mock_tlog, \
             patch("requests.post", side_effect=[requests.exceptions.ReadTimeout("boom"), ok]) as mock_post:
            result, model = brainstem.call_copilot([{"role": "user", "content": "hi"}])

        self.assertEqual(result["choices"][0]["message"]["content"], "ok")
        self.assertEqual(mock_post.call_count, 2)  # first timed out, second answered
        events = [c.args[0] for c in mock_tlog.call_args_list]
        self.assertIn("api.timeout_retry", events)

    def test_double_timeout_raises_clean_message(self):
        import requests
        from unittest.mock import patch
        brainstem = self.brainstem
        raw = ("HTTPSConnectionPool(host='api.enterprise.githubcopilot.com', port=443): "
               "Read timed out. (read timeout=60)")
        with patch.object(brainstem, "get_copilot_token", return_value=("tok", "https://api.example")), \
             patch.object(brainstem, "_tlog") as mock_tlog, \
             patch("requests.post", side_effect=requests.exceptions.ReadTimeout(raw)) as mock_post:
            with self.assertRaises(RuntimeError) as ctx:
                brainstem.call_copilot([{"role": "user", "content": "hi"}])

        msg = str(ctx.exception)
        self.assertIn("took too long", msg)
        self.assertNotIn("HTTPSConnectionPool", msg)  # raw text must never surface
        self.assertEqual(mock_post.call_count, 2)  # tried twice, then gave up
        events = [c.args[0] for c in mock_tlog.call_args_list]
        self.assertIn("api.timeout_retry", events)
        self.assertIn("api.timeout", events)

    def test_non_timeout_exception_not_retried(self):
        import requests
        from unittest.mock import patch
        brainstem = self.brainstem
        with patch.object(brainstem, "get_copilot_token", return_value=("tok", "https://api.example")), \
             patch("requests.post", side_effect=requests.exceptions.ConnectionError("down")) as mock_post:
            with self.assertRaises(requests.exceptions.ConnectionError):
                brainstem.call_copilot([{"role": "user", "content": "hi"}])

        self.assertEqual(mock_post.call_count, 1)  # non-timeout errors propagate unchanged, no retry


class TestSoulDefaultsManifest(unittest.TestCase):
    """The upgrade-time 'refresh unmodified default soul' feature (issue #40).

    install.sh / install.ps1 only refresh an installed soul.md if its NORMALIZED
    hash is listed in rapp_brainstem/tests/soul_defaults.sha256 (an unmodified
    historical default). This self-enforcement test makes a soul edit without
    regenerating the manifest fail CI: it asserts the manifest contains the normalized
    hash of the default soul this checkout ships. Regenerate with
    `bash tests/gen_soul_hashes.sh`.
    """

    # soul.md is the shipped engine default (rapp_brainstem/ root); the manifest + hasher
    # are soul-refresh tooling that lives here in tests/ (root stays grail).
    SOUL = os.path.join(BRAINSTEM_DIR, "soul.md")
    MANIFEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "soul_defaults.sha256")

    def _manifest_hashes(self):
        hashes = set()
        with open(self.MANIFEST, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                hashes.add(line.split()[0].lower())
        return hashes

    def _committed_default_soul(self):
        """soul.md as committed at HEAD (the shipped default), or None if unavailable.

        The invariant is about the DEFAULT this checkout ships, not the file on disk:
        in an installed copy the user may have customized soul.md (legitimately absent
        from the manifest), yet HEAD still holds the pristine default the manifest must
        describe. Reading the committed blob keeps this test correct both in the source
        repo (CI) and when it runs inside a live install (e.g. preflight upgrade).
        """
        import subprocess
        try:
            out = subprocess.run(
                ["git", "-C", BRAINSTEM_DIR, "show", "HEAD:rapp_brainstem/soul.md"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10,
            )
            if out.returncode == 0 and out.stdout:
                return out.stdout
        except Exception:
            pass
        return None

    def test_hasher_and_manifest_present(self):
        import soul_hash  # noqa: F401
        self.assertTrue(os.path.isfile(self.SOUL), "rapp_brainstem/soul.md missing")
        self.assertTrue(
            os.path.isfile(self.MANIFEST),
            "rapp_brainstem/tests/soul_defaults.sha256 missing — run tests/gen_soul_hashes.sh",
        )

    def test_current_soul_hash_is_in_manifest(self):
        import soul_hash
        manifest = self._manifest_hashes()
        # Fast path: the working soul is a known default (pristine source tree, or an
        # install still on a shipped default). This is the common CI case.
        if soul_hash.normalized_sha256(self.SOUL) in manifest:
            return
        # The on-disk soul is NOT a known default. In the source repo that means the
        # manifest is stale (soul.md was edited without regenerating). In an installed
        # copy it just means the user customized their soul. Decide against the blob
        # committed at HEAD — always the shipped default — which is the real invariant.
        committed = self._committed_default_soul()
        if committed is None:
            self.skipTest("soul.md is not a known default and git is unavailable "
                          "to read the committed default (likely a customized install)")
        self.assertIn(
            soul_hash.normalized_sha256_bytes(committed),
            manifest,
            "soul.md changed but soul_defaults.sha256 is stale — "
            "run `bash tests/gen_soul_hashes.sh` and commit the result",
        )

    def test_manifest_entries_are_lowercase_sha256(self):
        for h in self._manifest_hashes():
            self.assertRegex(h, r"^[0-9a-f]{64}$")

    def test_normalization_is_idempotent_and_absorbs_mechanical_drift(self):
        # The whole feature rests on this contract (mirrored natively by install.ps1):
        # BOM / CRLF / trailing whitespace / trailing-newline drift must NOT change the
        # hash, and normalizing twice must be a no-op.
        import soul_hash
        with open(self.SOUL, "rb") as fh:
            base = fh.read()
        canonical = soul_hash.normalize(base)
        want = soul_hash.normalized_sha256_bytes(canonical)
        variants = {
            "bom": b"\xef\xbb\xbf" + canonical,
            "crlf": canonical.replace(b"\n", b"\r\n"),
            "no_final_newline": canonical.rstrip(b"\n"),
            "extra_final_newlines": canonical + b"\n\n",
            "trailing_ws": b"\n".join(l + b" \t" for l in canonical.split(b"\n")),
        }
        for name, data in variants.items():
            self.assertEqual(
                soul_hash.normalized_sha256_bytes(data), want,
                f"mechanical drift '{name}' changed the normalized hash",
            )
        self.assertEqual(
            soul_hash.normalize(soul_hash.normalize(base)),
            soul_hash.normalize(base),
            "normalize() is not idempotent",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
