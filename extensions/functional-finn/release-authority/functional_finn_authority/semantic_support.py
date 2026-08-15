"""Narrow semantic-support contract consumed by _finnrel."""

from __future__ import annotations

from typing import Protocol


class SemanticSupportError(RuntimeError):
    pass


class SupportGate(Protocol):
    def supports(self, support: str, claim: str) -> bool: ...

    def close(self) -> None: ...


class RejectingSupportGate:
    def supports(self, _support: str, _claim: str) -> bool:
        raise SemanticSupportError("semantic support model is unavailable")

    def close(self) -> None:
        return None
