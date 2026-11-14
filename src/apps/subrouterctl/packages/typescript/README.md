# subrouterctl for TypeScript

A TypeScript client for the SubRouter account management API.

It calls the Go library of `subrouterctl` over a pipe, so the cache, the
retries, the paging and the credential handling are exactly the ones of the
command line tool. No API client is written twice.

```ts
import { SubRouterClient } from "subrouterctl";

const client = new SubRouterClient();

const info = await client.account.info();
console.log(info.username);

const page = await client.models.list({ search: "claude", pageSize: 5 });
for (const model of page.items) {
  console.log(model.model_name, model.input_price);
}

for (const log of await client.usage.logs({ from: "24h", model: "gpt-5", limit: 10 })) {
  console.log(log.created_at, log.model_name, log.quota);
}
```

## Install

```bash
npm install subrouterctl
```

The package needs the `subrouterctl` binary. It is looked for in
`SUBROUTERCTL_BIN`, then in the root of a checkout, then in the `PATH`. A
binary can also be named outright:

```ts
const client = new SubRouterClient({ binary: "/usr/local/bin/subrouterctl" });
```

```bash
make build           # in the repository
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

```ts
const client = new SubRouterClient({
  baseUrl: "https://subrouter.ai",
  accessToken: "...",
  userId: 10001,
});
```

## The transport

The Go library runs as a child process that speaks the protocol over its
standard streams. The package starts it when the client is created and keeps
it alive, so a program that makes many calls pays the start-up once.

```ts
const client = new SubRouterClient();
try {
  await client.account.info();
} finally {
  client.close();
}
```

The protocol is documented in [the package overview](../README.md).

---

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

```ts
await client.tokens.create({
  kind: "smart",
  name: "router",
  providers: ["demo", "acme"],
  routePreference: "price_first",
});

await client.tokens.create({ kind: "fixed", name: "demo only", provider: "demo" });

// a discount ceiling of 25%, in the basis points the platform uses
await client.tokens.create({ kind: "shared", name: "pool", sharedMaxDiscount: 2500 });
```

A field that is not given keeps the default of the kind. A key is unlimited
unless a quota is given.

## Errors

```ts
import { SubRouterAPIError } from "subrouterctl";

try {
  await client.tokens.show(999999);
} catch (error) {
  if (error instanceof SubRouterAPIError) {
    console.log(error.message, error.status);
  }
}
```

## The escape hatch

Every method of the protocol is reachable, including the ones without a name
of their own:

```ts
await client.call("raw", { method: "GET", path: "/api/user/self" });
```

## Tests

```bash
npm test
```

The tests use a fake transport for the mapping and the real helper binary for
the protocol, so they need no account.
