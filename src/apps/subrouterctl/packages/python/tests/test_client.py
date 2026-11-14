"""Tests for the Python binding.

The tests that need no network use a fake transport, so they check the
mapping from the Python API to the protocol. The tests that talk to the Go
library use a method that needs no account, so they run offline too.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from subrouterctl import APIError, SubRouterClient
from subrouterctl.transport import FFITransport, IPCTransport, Transport


class FakeTransport(Transport):
    """A transport that answers with canned responses."""

    name = "fake"

    def __init__(self, responses=None):
        self.requests = []
        self.responses = responses or {}

    def call(self, request):
        self.requests.append(request)
        method = request.get("method")
        if method in self.responses:
            return self.responses[method]
        return {"ok": True, "result": {"method": method}}


def make_client(responses=None, **kwargs):
    transport = FakeTransport(responses)
    client = SubRouterClient(transport=transport, **kwargs)
    return client, transport


def test_call_maps_to_the_protocol():
    client, transport = make_client()
    client.account.info()
    assert transport.requests[0]["method"] == "account.info"


def test_options_travel_with_the_request():
    client, transport = make_client(base_url="https://example.test", user_id=7)
    client.account.info()
    options = transport.requests[0]["options"]
    assert options["base_url"] == "https://example.test"
    assert options["user_id"] == 7


def test_time_parameters_use_the_protocol_names():
    client, transport = make_client()
    client.usage.logs(from_="24h", to="now", model="gpt-5")
    params = transport.requests[0]["params"]
    assert params["from"] == "24h"
    assert params["to"] == "now"
    assert params["model"] == "gpt-5"


def test_unset_parameters_are_left_out():
    client, transport = make_client()
    client.usage.logs()
    assert "params" not in transport.requests[0]


def test_the_result_comes_back():
    client, transport = make_client(responses={"account.info": {"ok": True, "result": {"username": "demo-user"}}})
    assert client.account.info()["username"] == "demo-user"


def test_a_failed_call_raises():
    transport = FakeTransport(responses={
        "token.show": {"ok": False, "error": {"message": "no such key", "type": "api", "status": 404}}
    })
    client = SubRouterClient(transport=transport)
    with pytest.raises(APIError) as caught:
        client.tokens.show(3)
    assert caught.value.message == "no such key"
    assert caught.value.status == 404


def test_notices_are_kept():
    transport = FakeTransport(responses={
        "account.info": {"ok": True, "result": {}, "notices": ["served from the cache"]}
    })
    client = SubRouterClient(transport=transport)
    client.account.info()
    assert client.notices == ["served from the cache"]


def test_token_creation_maps_the_spec():
    client, transport = make_client()
    client.tokens.create(kind="smart", name="router", providers=["a", "b"])
    params = transport.requests[0]["params"]
    assert params == {"kind": "smart", "name": "router", "providers": ["a", "b"]}


def test_token_update_carries_the_id():
    client, transport = make_client()
    client.tokens.update(42, name="renamed")
    params = transport.requests[0]["params"]
    assert params["id"] == 42
    assert params["name"] == "renamed"


def test_the_escape_hatch_calls_any_method():
    client, transport = make_client()
    client.call("raw", {"method": "GET", "path": "/api/user/self"})
    assert transport.requests[0]["method"] == "raw"
    assert transport.requests[0]["params"]["path"] == "/api/user/self"


# -- the Go library --------------------------------------------------------


def _library_available():
    try:
        FFITransport()
        return True
    except Exception:
        return False


def _binary_available():
    try:
        IPCTransport()
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _library_available(), reason="the Go shared library is not built")
def test_the_shared_library_answers():
    transport = FFITransport()
    response = transport.call({"method": "token.types"})
    assert response["ok"] is True
    assert [entry["kind"] for entry in response["result"]] == [
        "smart", "official", "shared", "fixed"
    ]


@pytest.mark.skipif(not _binary_available(), reason="the subrouterctl binary is not built")
def test_the_bridge_process_answers():
    transport = IPCTransport()
    try:
        response = transport.call({"method": "token.types"})
        assert response["ok"] is True
        assert len(response["result"]) == 4
    finally:
        transport.close()


@pytest.mark.skipif(not _library_available(), reason="the Go shared library is not built")
def test_the_client_works_over_the_shared_library():
    client = SubRouterClient(transport=FFITransport())
    assert client.transport == "ffi"
    assert len(client.tokens.types()) == 4
