"""
Minimal provider registry.

Mirrors ``typescript/src/providers/registry.ts`` at the scope this runtime
currently needs: register/lookup by name. Failover-chain behavior is left
out until a second provider client actually needs it — the bridge here
uses a single configured provider.
"""

from __future__ import annotations

from typing import Any, Dict, List


class ProviderRegistry:
    def __init__(self) -> None:
        self._providers: Dict[str, Any] = {}

    def register(self, provider: Any) -> None:
        self._providers[provider.name] = provider

    def unregister(self, name: str) -> None:
        self._providers.pop(name, None)

    def get(self, name: str) -> Any:
        return self._providers.get(name)

    def has(self, name: str) -> bool:
        return name in self._providers

    def names(self) -> List[str]:
        return list(self._providers.keys())

    def list(self) -> List[Any]:
        return list(self._providers.values())

    @property
    def size(self) -> int:
        return len(self._providers)
