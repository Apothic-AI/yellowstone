<div align="center">

# subrouterctl

**Run your whole SubRouter account from the terminal.**

Every documented account-management endpoint, one binary, no browser required.
The same core is also a Python and a TypeScript package.

[![Go](https://img.shields.io/badge/go-1.27%2B-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![License](https://img.shields.io/badge/license-MIT-00b3a4)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-linux%20%7C%20macos-6c7577)](https://github.com/)
[![Bindings](https://img.shields.io/badge/bindings-python%20%7C%20typescript-6c7577)](packages)

</div>

---

## At a glance

- **API keys** — All four kinds: smart routing, a pinned provider, shared
  pools, official channels. Pin a model to a provider, set a quota, a price
  ceiling or an IP allowlist.
- **Directories** — The model directory and the provider directory, with
  search, sort and filters. Every entry opens on its own.
- **Usage** — Every log field the platform returns, with the throughput the
  console shows, and the totals of any window.
- **The rest** — Top-ups, referrals, async task records, provider
  subscriptions, shared plans, the merchant and station consoles.
- **Output** — Bordered tables for people, JSON and YAML for scripts. The
  payload goes to stdout, the warnings to stderr.
- **Speed** — Every response is cached in SQLite. A week of logs takes about a
  minute once, then under a second.
- **From a program** — The same core as a Python and a TypeScript package.

---

## Contents

- [At a glance](#at-a-glance)
- [The problem it solves](#the-problem-it-solves)
- [Install](#install)
- [Quick start](#quick-start)
- [The four kinds of key](#the-four-kinds-of-key)
- [Searching and sorting](#searching-and-sorting)
- [Single listings](#single-listings)
- [Command map](#command-map)
- [Endpoint coverage](#endpoint-coverage)
- [Output formats](#output-formats)
- [Caching](#caching)
- [Credentials](#credentials)
- [Python and TypeScript](#python-and-typescript)
- [Safety](#safety)
- [Development](#development)

---

## The problem it solves

SubRouter has a capable web console, but everything in it is a click. If you want
to rotate a key, find the cheapest route for a model, or pull yesterday's spend
into a spreadsheet, you are back to the browser and the mouse.

`subrouterctl` speaks to the same **account management API** the console uses,
using your **system access token**. The browser is needed exactly once, when
you authorize the CLI. After that, everything is scriptable.

```console
$ subrouterctl token list --kind fixed
┌────────┬────────────┬───────┬──────────┬───────────┬─────────┬──────────────────┬─────────┐
│     ID │ NAME       │ KIND  │ PROVIDER │ PROVIDERS │ EXPIRES │ KEY              │ STATUS  │
├────────┼────────────┼───────┼──────────┼───────────┼─────────┼──────────────────┼─────────┤
│ 392958 │ demo-fixed │ fixed │ demo     │           │ -1      │ sk-Qk7******Rt2x │ enabled │
│ 392939 │ acme-fixed │ fixed │ acme     │           │ -1      │ sk-Nm3******Hs6v │ enabled │
└────────┴────────────┴───────┴──────────┴───────────┴─────────┴──────────────────┴─────────┘
```

---

## Install

```bash
git clone https://github.com/Apothic-AI/subrouterctl
cd subrouterctl
make install          # -> $GOBIN/subrouterctl
```

Or build in place:

```bash
make build            # -> ./subrouterctl
```

Building needs Go 1.27 or newer. The result is a single file you can copy
anywhere. The [Python and TypeScript packages](#python-and-typescript) sit on
the same source.

---

## Quick start

```bash
# 1. authorize the CLI (one time, opens a URL you confirm in the browser)
subrouterctl auth login

# 2. see where you stand
subrouterctl account info

# 3. create a key that always routes through one provider
subrouterctl token create --type fixed --name "demo only" --provider demo

# 4. the key is masked in the table; --show-secrets prints it in full
subrouterctl token create --type smart --name "router" --show-secrets
```

The credentials land in `~/.subrouter/credentials.json`, so every later
command works without an argument.

---

## The four kinds of key

SubRouter's console hides the most important idea behind four buttons.
`subrouterctl` names them explicitly, and `token create --type` picks one.

| `--type`   | Routing group   | What it does                                                        |
| ---------- | --------------- | ------------------------------------------------------------------- |
| `smart`    | `subrouter`     | Every subscribed source. Cheapest healthy route wins, auto failover. |
| `official` | `subrouter`     | Platform official channels only.                                     |
| `shared`   | `subrouter`     | Subscribed shared account pools only.                                |
| `fixed`    | `provider:<s>`  | One pinned provider. No cross-provider failover.                     |

```bash
# smart routing across two providers, price first
subrouterctl token create --type smart --name "router" \
  --providers demo,acme --route-preference price_first,stability_first

# pinned to a single provider
subrouterctl token create --type fixed --name "demo only" --provider demo

# shared account pools only, with a discount ceiling
subrouterctl token create --type shared --name "pools" --shared-max-discount 2500

# official channels only
subrouterctl token create --type official --name "official"
```

Pin a single model to a specific provider with `--model-route`:

```bash
subrouterctl token create --type smart --name "pinned" \
  --model-route "gpt-5.4=demo" --model-route "claude-sonnet-4-6=acme"
```

### Route preference criteria

`--route-preference` takes an ordered list. The first criterion that separates
two candidates wins.

```
stability_first   authenticity_first   provider_credit_first   first_token_first   price_first
```

`--sort-mode` picks how candidates of equal standing are ordered:
`token_price_first` (default) or `per_call_price_first`.

### Every flag of a key

`token create` and `token update` take the same flags. On an update, a flag
that is not given keeps the value of the stored key.

| Flag                         | Meaning                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| `--type`                     | `smart`, `official`, `shared` or `fixed`.                  |
| `--name`                     | The name of the key.                                       |
| `--provider`                 | The provider slug a fixed key is pinned to.                |
| `--providers`                | Comma separated slugs a smart key may use.                 |
| `--models`                   | Comma separated model whitelist. Empty means every model.  |
| `--model-route`              | `model=provider1,provider2`. Repeatable.                   |
| `--route-preference`         | The ordered routing criteria, comma separated.             |
| `--sort-mode`                | `token_price_first` or `per_call_price_first`.             |
| `--load-balance`             | Spread the traffic over the candidates.                    |
| `--include-cache-hit`        | Weigh the cache hit rate. On by default.                   |
| `--include-provider-self`    | Allow routes through provider operated channels.           |
| `--include-official-channels`| Allow routes through platform official channels.           |
| `--include-shared-subscriptions` | Allow routes through subscribed shared pools.           |
| `--official-max-discount`    | The highest discount factor of an official channel.        |
| `--shared-max-discount`      | The highest discount factor of a shared plan.              |
| `--official-channel`         | Pin the key to one official channel id.                    |
| `--unlimited`                | Give the key unlimited quota. On by default.               |
| `--quota-usd`                | A quota in dollars.                                        |
| `--quota-units`              | A quota in raw platform units.                             |
| `--expire`                   | `never`, `30d`, `12h` or a unix timestamp.                 |
| `--allow-ips`                | An IP or CIDR allowlist, one per line.                     |
| `--cross-group-retry`        | Retry the next group when the current one fails.           |
| `--group`                    | Override the routing group.                                |
| `--key-group`                | Attach the key to a key group id.                          |

---

## Searching and sorting

Every directory, log feed and task list takes the same three flags.

| Flag              | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `-q, --search`    | Free text search. Matched against names, slugs and categories.  |
| `--sort`          | Sort field, for example `price`, `rating`, `used`, `time`.      |
| `--order`         | `asc` (default) or `desc`.                                      |
| `--limit`         | Maximum rows to print. `0` prints everything.                    |
| `--page`          | Page number for the server-side paged endpoints.                 |
| `--page-size`     | Rows per page. `50` by default.                                 |

```bash
# cheapest routes for gpt models, most expensive first
subrouterctl model list --search gpt --sort price --order desc

# best rated providers
subrouterctl provider list --sort rating --order desc

# the keys that burned the most quota
subrouterctl token list --sort used --order desc

# logs for one model, most expensive call first
subrouterctl usage logs --model deepseek --sort cost --order desc
```

`--sort` is applied locally, so the CLI fetches every matching page first.
Search is pushed to the server where the endpoint supports it.

### Throughput

The usage log carries the time to first token and the request duration, and
`subrouterctl` shows the generation throughput the same way the SubRouter
console does in its **Time/first word** column: the completion tokens divided
by the total request duration.

```bash
$ subrouterctl usage logs --limit 3
┌──────────────────┬────────────┬──────────────────────────┬───────────────┬───────┬────────┬─────────┬─────────┬──────┬────────────────────────────┐
│ TIME             │ KEY        │ MODEL                    │ GROUP         │  COST │ TOKENS │ TIME(s) │ TTFT(s) │  TPS │ REQUEST                    │
├──────────────────┼────────────┼──────────────────────────┼───────────────┼───────┼────────┼─────────┼─────────┼──────┼────────────────────────────┤
│ 2026-11-13 08:36 │ demo-fixed │ deepseek-v4.1-flash-1017 │ provider:demo │ $0.00 │ 275744 │    49.0 │    35.9 │ 47.6 │ 20261113133557142351560... │
└──────────────────┴────────────┴──────────────────────────┴───────────────┴───────┴────────┴─────────┴─────────┴──────┴────────────────────────────┘
```

`--sort tps` orders by that figure and `--sort ttft` by the time to first
token.

```bash
subrouterctl usage logs --sort tps --order desc
subrouterctl usage logs --sort ttft --order asc
```

One log in full, including every field the platform returned and the whole
performance payload it sends in the `other` field:

```bash
$ subrouterctl usage log 20261113133557142351560demo000
Log 20261113133557142351560demo000
────────────────────────────────────────────────────────────
Id                   1042
Created              2026-11-13 08:36:46
Key                  demo-fixed
Model                deepseek-v4.1-flash-1017
Group                provider:demo
IP                   203.0.113.7
Prompt tokens        273410
Completion tokens    2334
Duration             49.0s
Time to first token  35.9s
Throughput           47.6 t/s
Streaming            yes
Cost                 $0.00
Upstream request id  00000000-0000-4000-8000-000000000000

  performance payload
┌──────────────────┬──────────────────────┐
│ FIELD            │ VALUE                │
├──────────────────┼──────────────────────┤
│ frt              │ 35949                │
│ cache_tokens     │ 266368               │
│ provider_slug    │ demo                 │
│ site_input_price │ 0.016911764705882355 │
└──────────────────┴──────────────────────┘
```

The JSON and YAML output carries every field the API returned, so nothing is
lost between the platform and a script.

### Single listings

Every directory entry can be opened on its own. A model is addressed by its
numeric id, a provider by its slug.

```bash
$ subrouterctl model show 27613
Model glm-5.3-prime
──────────────────────────────────────
Id               27613
Provider         Globe Labs
Provider slug    globe
Upstream model   glm-5.3-prime
Category         chat
Billing mode     ratio
Input price      0.4800 CNY
Output price     1.5086 CNY
Official input   1.4000
Cache read       0.0960
Context length   1000000
Average latency  1432 ms
Last call        2026-11-13 09:30:24
Endpoints        {"openai":{"path":"/v1/chat/completions","method":"POST"}, ...}
Description      GLM-5.3 high speed inference version
```

```bash
$ subrouterctl provider show demo
Provider Demo
──────────────────────────
Id            101
Slug          demo
Status        active
Rating        5.00
Uptime        99.62%
Models        12 listed, 12 public
Credit score  500
Max RPM       100000
Subscribers   666
Description   Domestic Model-Openai

┌─────────────────────┬──────────┬────────┬────────┐
│ MODEL               │ PROVIDER │   IN/M │  OUT/M │
├─────────────────────┼──────────┼────────┼────────┤
│ deepseek-v4.1-flash │ Demo     │ 0.1150 │ 0.4600 │
└─────────────────────┴──────────┴────────┴────────┘
```

`provider models <slug>` prints only the catalogue, and it accepts the same
search and sort flags:

```bash
subrouterctl provider models demo --search deepseek --sort input --order desc
```

### Time filters

`--from` and `--to` accept a date, a relative age or a unix timestamp.

```bash
subrouterctl usage logs  --from 2026-11-01 --to 2026-11-07
subrouterctl usage stats --from 24h --to now
subrouterctl usage data  --from 7d  --to now
```

The platform refuses windows longer than 31 days.

The range of a log listing is cached, so a window that was fetched before
comes back from disk the next time. Only the parts of the window that are
missing are fetched from the platform.

---

## Command map

```
subrouterctl
├── auth            login · status
├── account         info · update · groups · models · subrouter-models
│                   topup-info · topups · redeem · balance
│                   notifications · aff · status
├── usage           logs · log · stats · data · export
├── token           list · show · create · update · delete · delete-batch · types
├── model           list · show · routing · pricing · options
├── provider        list · show · models · subs · subscribe · unsubscribe
│                   subscribe-all · unsubscribe-all · sub-config · shared
├── shared          list · subscribe · cancel
├── subscription    list · plans · preference · pay
├── task            list · show
├── merchant        self · models · model-create · model-update · model-batch
│                   price-preview · channels · channel-test · earnings · payouts · register
├── station         self · dashboard · models · global-models · packages
│                   customers · key-groups · shared · official-channels
│                   logs · earnings
└── bridge          the machine interface, on stdin and stdout
```

`merchant` and `station` cover the provider (商家) and distributor (分站站长)
roles. A regular account receives `403 无权进行此操作` from them, which is the
expected answer.

---

## Endpoint coverage

Every endpoint in the
[Account Management API reference](https://subrouter.ai/docs?tab=account-api)
has a command. All 35 of them.

| Documented endpoint                                    | Command                              |
| ------------------------------------------------------ | ------------------------------------ |
| `GET /api/status`                                       | `account status`                     |
| `GET /api/user/self`                                    | `account info`                       |
| `PUT /api/user/self`                                    | `account update`                     |
| `GET /api/user/topup/info`                              | `account topup-info`                 |
| `GET /api/user/topup/self`                              | `account topups`                     |
| `GET /api/log/self`                                     | `usage logs`                         |
| `GET /api/log/self` (by request id)                    | `usage log <request-id>`             |
| `GET /api/log/self/stat`                                | `usage stats`                        |
| `GET /api/data/self`                                    | `usage data`                         |
| `GET /api/subscription/plans`                           | `subscription plans`                 |
| `GET /api/subscription/self`                            | `subscription list`                  |
| `PUT /api/subscription/self/preference`                 | `subscription preference`            |
| `POST /api/subscription/{stripe,creem,epay}/pay`        | `subscription pay`                   |
| `GET /api/marketplace/providers`                        | `provider list`                      |
| `GET /api/marketplace/subscriptions`                    | `provider subs`                      |
| `POST /api/marketplace/subscribe`                       | `provider subscribe`                 |
| `POST /api/marketplace/subscribe-all`                   | `provider subscribe-all`             |
| `DELETE /api/marketplace/subscribe/{provider_id}`       | `provider unsubscribe`               |
| `DELETE /api/marketplace/subscriptions`                 | `provider unsubscribe-all`           |
| `GET /api/marketplace/subscription-config`              | `provider sub-config`                |
| `PUT /api/marketplace/subscription-config`              | `provider sub-config --auto-subscribe` |
| `GET /api/shared-subscriptions/plans`                   | `shared list`                        |
| `POST /api/shared-subscriptions/plans/{id}/subscribe`   | `shared subscribe`                   |
| `DELETE /api/shared-subscriptions/plans/{id}/subscribe` | `shared cancel`                      |
| `GET /api/marketplace/models`                           | `model list`                         |
| `GET /api/marketplace/models/{id}`                      | `model show`                         |
| `GET /api/marketplace/providers/{slug}`                 | `provider show`                      |
| `GET /api/user/self/groups`                             | `account groups`                     |
| `GET /api/user/models`                                  | `account models`                     |
| `GET /api/user/self/subrouter/models`                   | `account subrouter-models`           |
| `GET /api/token/`                                       | `token list`                         |
| `POST /api/token/`                                      | `token create`                       |
| `PUT /api/token/`                                       | `token update`                       |
| `GET /api/token/{id}`                                   | `token show`                         |
| `DELETE /api/token/{id}`                                | `token delete`                       |
| `POST /api/token/batch`                                 | `token delete-batch`                 |

Beyond the reference, the CLI also reaches the async task records
(`GET /api/task/self`), the referral and top-up endpoints, the shared-provider
routes, the marketplace pricing sheet, the log CSV export and the full
merchant and station surfaces.

---

## Output formats

```bash
subrouterctl account info                        # bordered table
subrouterctl -o json account info                # machine readable
subrouterctl -o yaml token list --limit 3        # machine readable
```

```console
$ subrouterctl -o json account info
{
  "id": 10001,
  "username": "demo-user",
  "display_name": "demo-user",
  "email": "",
  "role": 1,
  "group": "default",
  "quota": 25000000,
  "used_quota": 125000000,
  "request_count": 13724,
  "status": 1,
  "aff_code": "DEMO",
  "aff_quota": 0,
  "inviter_id": 0,
  "deleted_at": null,
  "created_time": 0
}
```

Every list command honours `--output`, and the JSON and YAML payloads use the
same field names as the platform's own API.

The payload goes to the standard output and everything else, the warnings and
the errors, goes to the error stream. A JSON payload therefore stays
machine readable even when the command had something to say.

---

## Caching

Every response is written through to a local SQLite database the moment it
arrives, so the cache is always warm. Where a response is *read from* is a
separate decision:

| Situation                                     | Where the data comes from   |
| --------------------------------------------- | ---------------------------- |
| A normal run                                  | The network, always          |
| `--cache-ttl 5m` and the entry is that fresh  | The cache                    |
| The network is down                           | The cache, with a warning    |
| Usage logs                                    | The cache, see below         |

| Flag            | Meaning                                                          |
| --------------- | ---------------------------------------------------------------- |
| `--cache-ttl`   | Serve cached responses younger than this. `0` reads live data.   |
| `--cache-dir`   | Where the cache lives. Default `~/.cache/subrouterctl`.          |
| `--cache-clear` | Remove every cached entry and exit.                              |

Nothing is ever served stale without either `--cache-ttl` or a dead network,
and the offline fallback always says so:

```console
$ subrouterctl --base-url http://127.0.0.1:9 account status
! served GET /api/status from the local cache because the network is unavailable
Site
────────
Name            SubRouter
…
```

### Usage logs are the exception

A log listing names a time range, so the cache keeps the rows together with
the range of time they cover. A range that is already cached is drawn from
disk, and only the parts that are missing are fetched:

```bash
subrouterctl usage logs --from 7d      # fetches the range it does not have
subrouterctl usage logs --from 7d      # instant: the range is covered
```

A range that reaches into the present always keeps a fresh tail, so new calls
still show up. When a range cannot be fetched, the cached rows are still
shown and the gap is reported:

```console
$ subrouterctl usage logs --from 7d
! part of the requested range could not be fetched: GET /api/log/self: …
```

Wide ranges are fetched in parallel chunks, so a week of logs takes about a
minute the first time and under a second afterwards.

The cache lives in `~/.cache/subrouterctl/cache.db`, a SQLite database with
mode `0600`. Payloads are compressed, so a week of logs takes tens of
megabytes instead of hundreds.

### Secrets are not cached

The platform hands out the full relay key of every key on the account, so a
cached response would be a file full of live credentials. The cache is
scrubbed on the way in: every secret value it holds is replaced by a
placeholder of the same length, and the cached copy still decodes. The
command itself is unaffected and still hands you the real key.

```console
$ subrouterctl token list --limit 1          # prints the key, masked
$ subrouterctl -o json token list --limit 1  # prints the key in full
```

`--cache-clear` empties the cache, which is the way to drop the keys that a
version of the tool before this one may have left on disk.

The public directories are slow to fetch. The model directory holds around
2100 models spread over 43 pages, and a sorted listing needs all of them.
Those pages are requested in parallel: the full 2100 model sort went from
about 50 seconds to under 10, and a warm cache brings it down to a second.

## Credentials

`subrouterctl auth login` runs the device authorization flow and writes
`~/.subrouter/credentials.json` with mode `0600`. It never prints the secrets
it stores.

```jsonc
{
  "key":          "sk-…",          // relay key: model calls
  "access_token": "…",             // management credential
  "user_id":      10001,           // numeric account id
  "base_url":     "https://subrouter.ai"
}
```

Every value can also come from the environment, which is what you want in CI.

```bash
export SUBROUTER_ACCESS_TOKEN=…
export SUBROUTER_USER_ID=10001
export SUBROUTER_BASE_URL=https://subrouter.ai
```

Every global flag works on every command.

| Flag               | Environment variable    | Meaning                            |
| ------------------ | ----------------------- | ---------------------------------- |
| `--base-url`       | `SUBROUTER_BASE_URL`    | Site to talk to                    |
| `--token`          | `SUBROUTER_ACCESS_TOKEN`| System access token                |
| `--user-id`        | `SUBROUTER_USER_ID`     | Numeric account id                 |
| `--api-key`        | `SUBROUTER_API_KEY`     | `sk-` relay key                    |
| `-o, --output`     | –                       | `table`, `json` or `yaml`          |
| `--quota-per-unit` | `SUBROUTER_QUOTA_PER_UNIT` | Quota units per 1 USD (500000)  |
| `--show-secrets`   | –                       | Print secrets in full              |
| `--cache-ttl`      | –                       | Serve cached responses younger than this |
| `--cache-dir`      | `SUBROUTER_CACHE_DIR`   | Where the cache lives               |
| `--cache-clear`    | –                       | Empty the cache and exit            |
| `--no-color`       | –                       | Plain output                       |
| `--timeout`        | –                       | Request timeout in seconds         |
| `-y, --yes`        | –                       | Skip confirmation prompts          |

### Two credentials, two jobs

The platform has two distinct token types and mixing them up is the single
most common mistake:

| Credential                    | Header                          | Use                             |
| ----------------------------- | ------------------------------- | ------------------------------- |
| `sk-…` relay key              | `Authorization: Bearer sk-…`    | Model calls, `/v1/*`            |
| System access token + user id | `Authorization: Bearer …` **and** `New-Api-User: <id>` | Account management, `/api/*` |

`subrouterctl` picks the right one for you and refuses to send the wrong pair.

---

## Python and TypeScript

The same account, from a program. The two packages in [`packages/`](packages)
call the Go library this tool is built on, so the cache, the retries and the
credential handling are the ones of the tool rather than a second copy of
them.

| | Python | TypeScript |
| --- | --- | --- |
| Package | [`packages/python`](packages/python) | [`packages/typescript`](packages/typescript) |
| Transport | The Go library in process, over a C ABI | A child process, over a pipe |
| Needs | The shared library, or the binary as a fallback | The binary |
| Extra dependencies | None | None |
| Calls | Synchronous | `async` |

```python
from subrouterctl import SubRouterClient

client = SubRouterClient()
print(client.account.info()["username"])

for log in client.usage.logs(from_="24h", model="gpt-5", limit=10):
    print(log["created_at"], log["model_name"], log["quota"])
```

```ts
import { SubRouterClient } from "subrouterctl";

const client = new SubRouterClient();
const info = await client.account.info();
console.log(info.username);

for (const log of await client.usage.logs({ from: "24h", model: "gpt-5", limit: 10 })) {
  console.log(log.created_at, log.model_name, log.quota);
}
```

Neither package shells out to the CLI and neither one re-implements the API.
They speak one small JSON protocol to the Go library, and the tool itself can
serve that protocol:

```console
$ echo '{"method":"account.info"}' | subrouterctl bridge
{"ok":true,"result":{"id":10001,"username":"demo-user","display_name":"demo-user",...}}
```

The protocol is documented in [`packages/README.md`](packages/README.md), the
Python API in [`packages/python`](packages/python) and the TypeScript API in
[`packages/typescript`](packages/typescript).

```bash
make bindings      # the shared library the Python binding loads
make test-bindings # the Python and TypeScript tests
```

---

## Safety

- Secrets are masked in every table by default. `--show-secrets` reveals them.
- The on-disk cache never holds a secret. The values it scrubs are replaced by
  a placeholder, so a cached response cannot be read back as a live key.
- Deleting a key, unsubscribing a provider and changing billing settings ask
  for confirmation. `-y` skips the prompt in scripts.
- Quota limits accept either USD (`--quota-usd 10`) or raw platform units
  (`--quota-units 5000000`).
- Payment, top-up and payout stay in the browser console. `subscription pay`
  only creates a checkout session and prints the URL.

---

## Development

```bash
make build     # build the binary
make test      # unit tests
make smoke     # live smoke test against your account
make lint      # gofmt + go vet
make help      # list every make target

make bindings      # the shared library the Python binding loads
make test-bindings # the Python and TypeScript tests
```

The smoke test creates and removes a few throwaway API keys, so it needs a
real system access token. It restores the account to its original state: it
sweeps the keys an earlier interrupted run left behind, and if it cannot
remove its own keys at the end it says so and fails, rather than leaving
live credentials behind.

```
passed 67, failed 0
```

---

<div align="center">

<sub>SubRouter is a trademark of its respective owner. This tool is an
independent client and is not affiliated with the platform.</sub>

</div>
