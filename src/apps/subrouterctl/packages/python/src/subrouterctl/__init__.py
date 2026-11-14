"""Python client for the SubRouter account management API.

The package talks to the Go library of ``subrouterctl`` in process, so the
cache, the retries and the credential handling are the ones of the command
line tool.

    from subrouterctl import SubRouterClient

    client = SubRouterClient()
    print(client.account.info()["username"])
"""

from .client import (
    Account,
    Auth,
    Merchant,
    Models,
    Providers,
    Shared,
    SubRouterClient,
    Subscriptions,
    Tasks,
    Tokens,
    Usage,
)
from .errors import APIError, LibraryNotFound, SubRouterError, TransportError
from .transport import FFITransport, IPCTransport, Transport, open_transport

__version__ = "1.0.0"

__all__ = [
    "APIError",
    "Account",
    "Auth",
    "FFITransport",
    "IPCTransport",
    "LibraryNotFound",
    "Merchant",
    "Models",
    "Providers",
    "Shared",
    "SubRouterClient",
    "SubRouterError",
    "Subscriptions",
    "Tasks",
    "Tokens",
    "Transport",
    "TransportError",
    "Usage",
    "__version__",
    "open_transport",
]
