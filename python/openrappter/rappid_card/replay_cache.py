"""Bounded in-memory nonce replay cache."""

from __future__ import annotations

from collections import OrderedDict
from typing import Iterable, List

from .types import MAX_REPLAY_NONCES


class BoundedReplayCache:
    def __init__(
        self, limit: int = MAX_REPLAY_NONCES, initial: Iterable[str] = ()
    ) -> None:
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ValueError("replay cache limit must be a positive integer")
        self.limit = limit
        self._nonces: "OrderedDict[str, bool]" = OrderedDict()
        for nonce in initial:
            self.add(nonce)

    def has(self, nonce: str) -> bool:
        return nonce in self._nonces

    def add(self, nonce: str) -> None:
        self._nonces.pop(nonce, None)
        self._nonces[nonce] = True
        while len(self._nonces) > self.limit:
            self._nonces.popitem(last=False)

    def values(self) -> List[str]:
        return list(self._nonces)
