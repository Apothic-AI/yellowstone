"""Errors raised by the SubRouter client."""

from __future__ import annotations

from typing import Any, Dict, List, Optional


class SubRouterError(Exception):
    """Base class for every error raised by this package."""

    def __init__(self, message: str, kind: str = "error", status: Optional[int] = None,
                 payload: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.message = message
        self.kind = kind
        self.status = status
        self.payload = payload or {}


class APIError(SubRouterError):
    """The platform rejected a request."""

    def __init__(self, message: str, status: Optional[int] = None,
                 payload: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message, kind="api", status=status, payload=payload)


class TransportError(SubRouterError):
    """The binding could not reach the Go library."""

    def __init__(self, message: str) -> None:
        super().__init__(message, kind="transport")


class LibraryNotFound(TransportError):
    """The Go shared library is not installed."""

    def __init__(self, message: str, searched: Optional[List[str]] = None) -> None:
        super().__init__(message)
        self.searched = searched or []
