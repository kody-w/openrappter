"""
openrappter Providers Package

LLM provider contract (message/result models, error taxonomy) and a
minimal OpenAI-compatible HTTP client usable against the real OpenAI API,
a local Ollama server, or any other self-hosted OpenAI-compatible
endpoint.
"""

from openrappter.providers.types import (
    ChatOptions,
    ProviderError,
    ProviderMessage,
    ProviderResponse,
    ProviderResponseTooLargeError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from openrappter.providers.openai_compatible import (
    OpenAICompatibleProvider,
    create_openai_compatible_provider,
)
from openrappter.providers.registry import ProviderRegistry

__all__ = [
    'ChatOptions',
    'ProviderError',
    'ProviderMessage',
    'ProviderResponse',
    'ProviderResponseTooLargeError',
    'ProviderTimeoutError',
    'ProviderUnavailableError',
    'OpenAICompatibleProvider',
    'create_openai_compatible_provider',
    'ProviderRegistry',
]
