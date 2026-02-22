"""
Tests that every Python sub-package has proper __init__.py exports.

Each test class verifies:
1. __all__ is defined with expected entries
2. Every name in __all__ is importable from the package
3. Exported names are the correct type (class vs function vs instance)
"""

import inspect


class TestChannelsExports:
    """Verify openrappter.channels exports."""

    expected = ['BaseChannel', 'IncomingMessage', 'OutgoingMessage', 'ChannelRegistry']

    def test_all_defined(self):
        import openrappter.channels as mod
        assert hasattr(mod, '__all__')
        assert sorted(mod.__all__) == sorted(self.expected)

    def test_all_importable(self):
        from openrappter.channels import BaseChannel, IncomingMessage, OutgoingMessage, ChannelRegistry
        assert BaseChannel is not None
        assert IncomingMessage is not None
        assert OutgoingMessage is not None
        assert ChannelRegistry is not None

    def test_types(self):
        from openrappter.channels import BaseChannel, IncomingMessage, OutgoingMessage, ChannelRegistry
        assert inspect.isclass(BaseChannel)
        assert inspect.isclass(IncomingMessage)
        assert inspect.isclass(OutgoingMessage)
        assert inspect.isclass(ChannelRegistry)


class TestConfigExports:
    """Verify openrappter.config exports."""

    expected = ['parse_config_content', 'substitute_env_vars', 'merge_configs',
                'validate_config', 'get_config_json_schema']

    def test_all_defined(self):
        import openrappter.config as mod
        assert hasattr(mod, '__all__')
        assert sorted(mod.__all__) == sorted(self.expected)

    def test_all_importable(self):
        from openrappter.config import (parse_config_content, substitute_env_vars,
                                         merge_configs, validate_config, get_config_json_schema)
        assert parse_config_content is not None
        assert substitute_env_vars is not None
        assert merge_configs is not None
        assert validate_config is not None
        assert get_config_json_schema is not None

    def test_types(self):
        from openrappter.config import (parse_config_content, substitute_env_vars,
                                         merge_configs, validate_config, get_config_json_schema)
        assert callable(parse_config_content)
        assert callable(substitute_env_vars)
        assert callable(merge_configs)
        assert callable(validate_config)
        assert callable(get_config_json_schema)


class TestGatewayExports:
    """Verify openrappter.gateway exports."""

    expected = ['StreamManager', 'StreamBlock', 'StreamSession', 'stream_manager', 'DashboardHandler']

    def test_all_defined(self):
        import openrappter.gateway as mod
        assert hasattr(mod, '__all__')
        assert sorted(mod.__all__) == sorted(self.expected)

    def test_all_importable(self):
        from openrappter.gateway import (StreamManager, StreamBlock, StreamSession,
                                          stream_manager, DashboardHandler)
        assert StreamManager is not None
        assert StreamBlock is not None
        assert StreamSession is not None
        assert stream_manager is not None
        assert DashboardHandler is not None

    def test_types(self):
        from openrappter.gateway import (StreamManager, StreamBlock, StreamSession,
                                          stream_manager, DashboardHandler)
        assert inspect.isclass(StreamManager)
        assert inspect.isclass(StreamBlock)
        assert inspect.isclass(StreamSession)
        assert isinstance(stream_manager, StreamManager)
        assert inspect.isclass(DashboardHandler)


class TestMcpExports:
    """Verify openrappter.mcp exports."""

    expected = ['McpServer']

    def test_all_defined(self):
        import openrappter.mcp as mod
        assert hasattr(mod, '__all__')
        assert sorted(mod.__all__) == sorted(self.expected)

    def test_all_importable(self):
        from openrappter.mcp import McpServer
        assert McpServer is not None

    def test_types(self):
        from openrappter.mcp import McpServer
        assert inspect.isclass(McpServer)


class TestMemoryExports:
    """Verify openrappter.memory exports."""

    expected = ['chunk_content', 'generate_snippet', 'MemoryChunk', 'MemoryManager']

    def test_all_defined(self):
        import openrappter.memory as mod
        assert hasattr(mod, '__all__')
        assert sorted(mod.__all__) == sorted(self.expected)

    def test_all_importable(self):
        from openrappter.memory import chunk_content, generate_snippet, MemoryChunk, MemoryManager
        assert chunk_content is not None
        assert generate_snippet is not None
        assert MemoryChunk is not None
        assert MemoryManager is not None

    def test_types(self):
        from openrappter.memory import chunk_content, generate_snippet, MemoryChunk, MemoryManager
        assert callable(chunk_content)
        assert callable(generate_snippet)
        assert inspect.isclass(MemoryChunk)
        assert inspect.isclass(MemoryManager)


class TestSecurityExports:
    """Verify openrappter.security exports."""

    expected = ['ApprovalManager', 'ApprovalRule', 'ApprovalRequest', 'ApprovalContext']

    def test_all_defined(self):
        import openrappter.security as mod
        assert hasattr(mod, '__all__')
        assert sorted(mod.__all__) == sorted(self.expected)

    def test_all_importable(self):
        from openrappter.security import ApprovalManager, ApprovalRule, ApprovalRequest, ApprovalContext
        assert ApprovalManager is not None
        assert ApprovalRule is not None
        assert ApprovalRequest is not None
        assert ApprovalContext is not None

    def test_types(self):
        from openrappter.security import ApprovalManager, ApprovalRule, ApprovalRequest, ApprovalContext
        assert inspect.isclass(ApprovalManager)
        assert inspect.isclass(ApprovalRule)
        assert inspect.isclass(ApprovalRequest)
        assert inspect.isclass(ApprovalContext)


class TestStorageExports:
    """Verify openrappter.storage exports."""

    expected = ['StorageAdapter', 'create_storage_adapter']

    def test_all_defined(self):
        import openrappter.storage as mod
        assert hasattr(mod, '__all__')
        assert sorted(mod.__all__) == sorted(self.expected)

    def test_all_importable(self):
        from openrappter.storage import StorageAdapter, create_storage_adapter
        assert StorageAdapter is not None
        assert create_storage_adapter is not None

    def test_types(self):
        from openrappter.storage import StorageAdapter, create_storage_adapter
        assert inspect.isclass(StorageAdapter)
        assert callable(create_storage_adapter)
