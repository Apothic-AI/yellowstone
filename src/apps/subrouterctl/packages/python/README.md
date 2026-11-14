# subrouterctl for Python

A Python client for the SubRouter account management API.

It calls the Go library of `subrouterctl` in process, so the cache, the
retries, the paging and the credential handling are exactly the ones of the
command line tool. No API client is written twice.

```python
from subrouterctl import SubRouterClient

client = SubRouterClient()

print(client.account.info()["username"])

page = client.models.list(search="claude", page_size=5)
for model in page["items"]:
    print(model["model_name"], model["input_price"])

for log in client.usage.logs(from_="24h", model="gpt-5", limit=10):
    print(log["created_at"], log["model_name"], log["quota"])
```

## Install

```bash
pip install subrouterctl
```

From a checkout of the repository:

```bash
make build          # the helper binary
make bindings-python # the shared library, inside the package
pip install -e packages/python
```

## Credentials

The client reads the same credential file as the command line tool,
`~/.subrouter/credentials.json`, which `subrouterctl auth login` writes. The
environment works too:

| Variable | Meaning |
|---|---|
| `SUBROUTER_BASE_URL` | the site, `https://subrouter.ai` by default |
| `SUBROUTER_ACCESS_TOKEN` | the system access token |
| `SUBROUTER_USER_ID` | the numeric account id |
| `SUBROUTER_API_KEY` | the `sk-` relay key |

Every one of them can also be given to the client:

```python
client = SubRouterClient(
    base_url="https://subrouter.ai",
    access_token="...",
    user_id=10001,
)
```

## The two transports

| Transport | When it is used | What it needs |
|---|---|---|
| `ffi` | the default, when the shared library is installed | `libsubrouter.so` |
| `ipc` | the fallback | the `subrouterctl` binary |

```python
client = SubRouterClient(transport="ffi")   # in process
client = SubRouterClient(transport="ipc")   # a child process
client = SubRouterClient(transport="auto")  # the default
```

The library is looked for in `SUBROUTERCTL_LIB`, then in the package, then in
the `build` directory of a checkout. The binary is looked for in
`SUBROUTERCTL_BIN`, then in a checkout, then in the `PATH`.

The client holds the transport until it is closed, and it works as a context
manager:

```python
with SubRouterClient() as client:
    print(client.account.info()["username"])
```

The protocol is documented in [the package overview](../README.md).

## The namespaces

| Namespace | What it holds |
|---|---|
| `client.auth` | the credentials of this machine |
| `client.account` | the profile, the balance, the groups, the referral |
| `client.usage` | the logs, the totals, the export |
| `client.tokens` | the model API keys of every kind |
| `client.models` | the model directory |
| `client.providers` | the provider directory and the subscriptions |
| `client.shared` | the shared subscription plans |
| `client.subscriptions` | the plans, the preference, the checkout |
| `client.tasks` | the asynchronous media tasks |
| `client.merchant` | the provider side of the account |
| `client.station` | the distributor side of the account |

## Keys

```python
client.tokens.create(
    kind="smart",
    name="router",
    providers=["demo", "acme"],
    route_preference="price_first",
)

client.tokens.create(kind="fixed", name="demo only", provider="demo")

# a discount ceiling of 25%, in the basis points the platform uses
client.tokens.create(kind="shared", name="pool", shared_max_discount=2500)
```

A field that is not given keeps the default of the kind. A key is unlimited
unless a quota is given.

## Errors

```python
from subrouterctl import APIError

try:
    client.tokens.show(999999)
except APIError as error:
    print(error.message, error.status)
```

## The escape hatch

Every method of the protocol is reachable, including the ones without a name
of their own:

```python
client.call("raw", {"method": "GET", "path": "/api/user/self"})
```

## Tests

```bash
make test-bindings
```

The tests use a fake transport for the mapping and the real library for the
protocol, so they need no account.
