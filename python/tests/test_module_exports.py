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

    expected = [
        'BaseChannel', 'IncomingMessage', 'OutgoingMessage', 'ChannelRegistry',
        'WebhookChannel', 'ChannelConnectionError', 'ProviderChannelBridge', 'ChannelDispatchError',
    ]

    def test_all_defined(self):
        import openrappter.channels as mod
        assert hasattr(mod, '__all__')
        assert sorted(mod.__all__) == sorted(self.expected)

    def test_all_importable(self):
        from openrappter.channels import (
            BaseChannel, IncomingMessage, OutgoingMessage, ChannelRegistry,
            WebhookChannel, ChannelConnectionError, ProviderChannelBridge, ChannelDispatchError,
        )
        assert BaseChannel is not None
        assert IncomingMessage is not None
        assert OutgoingMessage is not None
        assert ChannelRegistry is not None
        assert WebhookChannel is not None
        assert ChannelConnectionError is not None
        assert ProviderChannelBridge is not None
        assert ChannelDispatchError is not None

    def test_types(self):
        from openrappter.channels import (
            BaseChannel, IncomingMessage, OutgoingMessage, ChannelRegistry,
            WebhookChannel, ChannelConnectionError, ProviderChannelBridge, ChannelDispatchError,
        )
        assert inspect.isclass(BaseChannel)
        assert inspect.isclass(IncomingMessage)
        assert inspect.isclass(OutgoingMessage)
        assert inspect.isclass(ChannelRegistry)
        assert inspect.isclass(WebhookChannel) and issubclass(WebhookChannel, BaseChannel)
        assert inspect.isclass(ChannelConnectionError) and issubclass(ChannelConnectionError, Exception)
        assert inspect.isclass(ProviderChannelBridge)
        assert inspect.isclass(ChannelDispatchError) and issubclass(ChannelDispatchError, Exception)


class TestProvidersExports:
    """Verify openrappter.providers exports."""

    expected = [
        'ChatOptions', 'ProviderError', 'ProviderMessage', 'ProviderResponse',
        'ProviderResponseTooLargeError', 'ProviderTimeoutError', 'ProviderUnavailableError',
        'OpenAICompatibleProvider', 'create_openai_compatible_provider', 'ProviderRegistry',
    ]

    def test_all_defined(self):
        import openrappter.providers as mod
        assert hasattr(mod, '__all__')
        assert sorted(mod.__all__) == sorted(self.expected)

    def test_all_importable(self):
        from openrappter.providers import (
            ChatOptions, ProviderError, ProviderMessage, ProviderResponse,
            ProviderResponseTooLargeError, ProviderTimeoutError, ProviderUnavailableError,
            OpenAICompatibleProvider, create_openai_compatible_provider, ProviderRegistry,
        )
        assert ChatOptions is not None
        assert ProviderError is not None
        assert ProviderMessage is not None
        assert ProviderResponse is not None
        assert ProviderResponseTooLargeError is not None
        assert ProviderTimeoutError is not None
        assert ProviderUnavailableError is not None
        assert OpenAICompatibleProvider is not None
        assert create_openai_compatible_provider is not None
        assert ProviderRegistry is not None

    def test_types(self):
        from openrappter.providers import (
            ChatOptions, ProviderError, ProviderMessage, ProviderResponse,
            ProviderResponseTooLargeError, ProviderTimeoutError, ProviderUnavailableError,
            OpenAICompatibleProvider, create_openai_compatible_provider, ProviderRegistry,
        )
        assert inspect.isclass(ChatOptions)
        assert inspect.isclass(ProviderError) and issubclass(ProviderError, Exception)
        assert inspect.isclass(ProviderMessage)
        assert inspect.isclass(ProviderResponse)
        assert issubclass(ProviderResponseTooLargeError, ProviderError)
        assert issubclass(ProviderTimeoutError, ProviderError)
        assert issubclass(ProviderUnavailableError, ProviderError)
        assert inspect.isclass(OpenAICompatibleProvider)
        assert callable(create_openai_compatible_provider)
        assert inspect.isclass(ProviderRegistry)


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

    expected = ['StreamManager', 'StreamBlock', 'StreamSession', 'stream_manager', 'DashboardHandler',
                'GatewayServer', 'GatewayError', 'RPC_ERROR', 'GatewayMetrics']

    def test_all_defined(self):
        import openrappter.gateway as mod
        assert hasattr(mod, '__all__')
        assert sorted(mod.__all__) == sorted(self.expected)

    def test_all_importable(self):
        from openrappter.gateway import (StreamManager, StreamBlock, StreamSession,
                                          stream_manager, DashboardHandler,
                                          GatewayServer, GatewayError, RPC_ERROR, GatewayMetrics)
        assert StreamManager is not None
        assert StreamBlock is not None
        assert StreamSession is not None
        assert stream_manager is not None
        assert DashboardHandler is not None
        assert GatewayServer is not None
        assert GatewayError is not None
        assert RPC_ERROR is not None
        assert GatewayMetrics is not None

    def test_types(self):
        from openrappter.gateway import (StreamManager, StreamBlock, StreamSession,
                                          stream_manager, DashboardHandler,
                                          GatewayServer, GatewayError, RPC_ERROR, GatewayMetrics)
        assert inspect.isclass(StreamManager)
        assert inspect.isclass(StreamBlock)
        assert inspect.isclass(StreamSession)
        assert isinstance(stream_manager, StreamManager)
        assert inspect.isclass(DashboardHandler)
        assert inspect.isclass(GatewayServer)
        assert inspect.isclass(GatewayError) and issubclass(GatewayError, Exception)
        assert isinstance(RPC_ERROR, dict)
        assert inspect.isclass(GatewayMetrics)


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

    expected = [
        'ApprovalManager', 'ApprovalRule', 'ApprovalRequest', 'ApprovalContext',
        'ExecSafety', 'ApprovalToken', 'ApprovalConsumeResult', 'SafetyCheckResult',
        'AuditEntry', 'create_exec_safety',
    ]

    def test_all_defined(self):
        import openrappter.security as mod
        assert hasattr(mod, '__all__')
        assert sorted(mod.__all__) == sorted(self.expected)

    def test_all_importable(self):
        from openrappter.security import (
            ApprovalManager, ApprovalRule, ApprovalRequest, ApprovalContext,
            ExecSafety, ApprovalToken, ApprovalConsumeResult, SafetyCheckResult,
            AuditEntry, create_exec_safety,
        )
        assert ApprovalManager is not None
        assert ApprovalRule is not None
        assert ApprovalRequest is not None
        assert ApprovalContext is not None
        assert ExecSafety is not None
        assert ApprovalToken is not None
        assert ApprovalConsumeResult is not None
        assert SafetyCheckResult is not None
        assert AuditEntry is not None
        assert create_exec_safety is not None

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
