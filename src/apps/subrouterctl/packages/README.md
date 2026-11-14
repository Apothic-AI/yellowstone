# Bindings

Two packages wrap `subrouterctl` for Python and TypeScript.

They do not re-implement the API client. They call **the Go library the
command line tool is built on**, so the cache, the retries, the paging, the
secret masking and the credential handling are exactly the ones of the tool.

```
                    ┌──────────────────────────────────────────┐
                    │  pkg/api      the SubRouter HTTP client  │
                    │  pkg/cache    the SQLite cache           │
                    │  pkg/config   the credentials            │
                    └────────────────────┬─────────────────────┘
                                         │
                    ┌────────────────────▼─────────────────────┐
                    │  pkg/service    the protocol             │
                    │  one JSON request in, one JSON answer out│
                    └───────┬──────────────────────┬───────────┘
                            │                      │
              ┌─────────────▼──────────┐  ┌────────▼───────────────────┐
              │  bridge/cgo             │  │  bridge/ipc                │
              │  a C ABI                │  │  a stdio server            │
              │  in-process, ctypes     │  │  a child process, JSON     │
              └─────────────┬──────────┘  └────────┬───────────────────┘
                            │                      │
                 ┌──────────▼─────────┐  ┌─────────▼──────────┐
                 │  packages/python    │  │  packages/typescript│
                 │  ctypes, zero deps  │  │  pure JavaScript   │
                 └─────────────────────┘  └────────────────────┘
```

## The protocol

One JSON object in, one JSON object out. Nothing about the command line
surface leaks into it, so the bindings never parse a flag or a table.

```jsonc
// request
{
  "method": "usage.logs",
  "params": { "from": "24h", "to": "now", "model": "gpt-5" },
  "options": { "base_url": "https://subrouter.ai" },
  "id": "7"
}

// answer
{
  "ok": true,
  "result": [ { "id": 1, "model_name": "gpt-5", "quota": 42 } ],
  "notices": [],
  "id": "7"
}
```

A failed call answers with an error instead of a result:

```jsonc
{
  "ok": false,
  "error": { "message": "token.show: no such key (HTTP 404)", "type": "api", "status": 404 }
}
```

The `id` is echoed back, so a client may keep several calls in flight over a
stream.

## The transports

| Transport | Where it runs | What it needs |
|---|---|---|
| `ffi` | in the calling process | the shared library `libsubrouter.so` |
| `ipc` | a child process | the `subrouterctl` binary |

**Python** uses the in-process library when it is installed and falls back to
the child process otherwise. The fallback needs no C toolchain at all.

**TypeScript** uses the child process. The npm package is pure JavaScript:
no compiler, no native module, and the Go binary cross-compiles for every
platform.

Both transports speak the same protocol, so the two packages behave the
same.

## Build

```bash
make build             # the subrouterctl binary
make bindings          # build/libsubrouter.so, the library Python loads
make bindings-python   # the same library inside the Python package
make test-bindings     # the Python and TypeScript tests
```

## The method names

The protocol covers the same ground as the command line tool. The names are
the command with a dot in it:

| The command | The method |
|---|---|
| `subrouterctl account info` | `account.info` |
| `subrouterctl usage logs` | `usage.logs` |
| `subrouterctl token create` | `token.create` |
| `subrouterctl model list` | `model.list` |
| `subrouterctl provider show` | `provider.show` |
| `subrouterctl station customers` | `station.customers` |

There is one method that has no command of its own: `raw` sends any request
to any endpoint, for the ones without a named method yet.

```python
client.call("raw", {"method": "GET", "path": "/api/user/self"})
```

## Try it

```bash
make build && make bindings

# the protocol by hand
echo '{"method":"account.info"}' | ./subrouterctl bridge
```
