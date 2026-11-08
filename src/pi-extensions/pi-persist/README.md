# pi-persist

> Two ways to put text in front of the model: a **cached prompt section** for facts that hold for
> the session, and a **trailing developer message** for anything that changes or that the model must
> never lose mid-run. Extensions register programmatically; you can also add items from a JSON file
> without writing code.

```text
<pi_context>
Context configured for this session by the operator. This is not a user message and does not
replace the task you were given, but the contents below are authoritative: follow any
instruction they contain. Environment facts are for reference.
  <current_datetime>Tuesday, 27/10/2026, 22:00:22 GMT-4</current_datetime>
  <git_branch>main</git_branch>
</pi_context>
```

---

## Install

```sh
pi install npm:@apothic-ai/pi-persist
```

Or from a checkout:

```sh
pi install /path/to/pi-persist
```

That is the whole setup. On first run the extension writes
`~/.pi/agent/pi-persist.json` with one preset item — the current date and time. A repository can add
its own items in `.pi/pi-persist.json`; see [project items](#project-items).

## The two channels

Pick by **how often the value changes**, not by what it is.

|  | 🗂️ Section | 📨 Trailing |
| --- | --- | --- |
| **Lands in** | the leading system prompt | the end of every request |
| **Fires** | once per run | every request |
| **Cached** | ✅ with the prompt prefix | ❌ fresh input each time |
| **Cost of a change** | re-renders the cached prefix | one small message |
| **Survives a tool loop** | ✅ it is in the prefix | ✅ re-appended every request |
| **Role on the wire** | `developer` / `system` per provider | `developer` |
| **Use it for** | shell, platform, mode flags | clocks, branches, task counts |

> **Rule of thumb** — if it is true for the whole session, use the section. If it changes, or the
> model must read it on *every* request, use the trailing message.

### Why the trailing message fires per request

`before_agent_start` fires once per **run**, not per model call. A run with three tool calls makes
four requests, so anything injected there reaches the model once and then vanishes for the rest of
the run — exactly when it is most useful. The trailing channel hooks `before_provider_request`
instead, so it lands after the final tool result, every time.

It is appended to the provider payload rather than returned as a message, because pi's `convertToLlm`
flattens `role: "custom"` to `role: "user"`. An appended `custom` message competes with the user's
request; an appended `developer` item does not.

### Measured behaviour

Verified by loading the extension into pi and inspecting the outgoing payload.

| Provider / model | API | payload key | trailing role | status |
| --- | --- | --- | --- | --- |
| `subrouter/deepseek-v4.1-flash-1017` | `openai-completions` | `messages` | `developer` | ✅ 200 |
| `openrouter/xiaomi/mimo-v2.6-flash:nitro` | `openai-completions` | `messages` | `developer` | ✅ 200 |
| `opencode-go/minimax-m3.1-flash` | `openai-completions` | `messages` | `developer` | ✅ 200 |
| `openai/gpt-6-luna` via OpenRouter `/responses` | `openai-responses` | `input` | `developer` | ✅ 200 |

`openai-completions` payloads carry `messages`; `openai-responses` payloads carry `input`. Both are
handled. A payload with neither key is left untouched rather than guessed at — if a provider changes
shape, this channel no-ops for it instead of corrupting the request.

> [!WARNING]
> A trailing message is **never cached**. It is fresh input on every request of every run, including
> each step of a tool loop. That is the price of "the model always sees it", and it is the right
> trade for short text. Keep trailing items small: a few hundred bytes is free in practice, a
> multi-kilobyte block is paid for on every request. Large and stable belongs in the section.
>
> The extension does not enforce this. Sizing is your judgement.

---

## Declarative items

Everything above is the programmatic API — an extension calls `register…` with a function, which is
what makes per-request values possible. Declarative items cover the other case: a value with a
policy, added without writing code. Both feed the same registries, so rendering cannot tell them
apart.

```json
{
  "version": 1,
  "items": [
    {
      "id": "git_branch",
      "channel": "trailing",
      "content": "{{exec:git rev-parse --abbrev-ref HEAD}}",
      "priority": 5,
      "providers": ["subrouter"],
      "activeTools": ["read"]
    }
  ]
}
```

| Field | Required | Meaning |
| --- | :---: | --- |
| `id` | ✅ | Unique per channel. Becomes the XML tag name. |
| `channel` | ✅ | `trailing` (per request, uncached) or `section` (cached with the prompt). |
| `content` | ✅ | Body text; `{{…}}` templates expand per request. |
| `priority` | | Lower sorts first. Default `0`. |
| `providers` | | Skip unless the active provider is listed. |
| `activeTools` | | Skip unless every listed tool is active. |

A malformed entry is skipped and reported rather than thrown, so one bad item cannot stop a session
from starting. `pi-persist list` shows what was skipped and why.

### Project items

A project can carry items of its own in `<cwd>/.pi/pi-persist.json` — the same schema, beside pi's
other project configuration. They are **merged over** the global file, and a project item wins over a
global item with the same `channel:id`:

```console
$ pi-persist add repo_notes 'branch {{exec:git rev-parse --abbrev-ref HEAD}}' --channel section --project
added section item "repo_notes" in /repo/.pi/pi-persist.json
```

|  | Global (`~/.pi/agent/`) | Project (`<cwd>/.pi/`) |
| --- | --- | --- |
| Applies to | every session | sessions started in that directory |
| Loaded when | always | the project is trusted |
| Same `channel:id` | loses | wins |

Why layer instead of picking one file: the global file holds machine-wide defaults, the project file
holds what only makes sense in that repository, and naming an existing global id in the project file
is how you override a default without deleting it.

**Trust gating.** Project items are read only when pi reports the project as trusted, which is
decided *after* extensions load — so they are loaded at `session_start` rather than at import, and
again on the first `before_agent_start`. A refused project contributes nothing and says so. A file
that appears mid-session, or a trust decision that changes, is picked up on the next session start or
`/reload`.

> [!NOTE]
> Pi skips its trust prompt entirely when a project holds no trust-requiring resources —
> `.pi/settings.json`, `.pi/extensions`, `.pi/mcp.json` and friends. A repository whose only project
> config is `.pi/pi-persist.json` is therefore trusted without ever being asked, and its items load
> on `git clone` alone. That is pi's rule for non-trust-requiring resources, not this extension's,
> so treat a project items file as untrusted input: read it before you work in a repository you did
> not write. Loading is never silent — the extension reports how many items a project contributed.

### The preset

On first run the file is created with:

```json
{ "id": "current_datetime", "channel": "trailing", "content": "{{datetime}}", "priority": -100 }
```

That item **is** the clock. There is no built-in clock contribution in code — delete the item and the
clock is gone, with nothing else to change.

The file is only seeded when it does not exist, so deleting every item does not bring the preset
back. `pi-persist preset` writes it again on demand.

---

## Turning it off

`/pi-persist-toggle` switches the whole extension on and off. Off means nothing is injected: no
`<environment_context>` section, no trailing `<pi_context>` message, and no `{{exec:…}}` command
running on the request path. The items stay in the file, so turning it back on restores exactly
what was there before.

```console
$ /pi-persist-toggle
pi-persist: is off — nothing is injected until it is turned back on

$ /pi-persist-toggle on
pi-persist: is on — the section and the trailing message are injected again
```

`/pi-persist-toggle status` reports the state without changing it, and `on` / `off` set it
explicitly instead of flipping it.

The switch is written to `piPersist.enabled` in `~/.pi/agent/settings.json`, so it survives a
`/reload` and the next session. It is global: a project cannot turn the operator's context on or
off. A settings file that cannot be written — one that is locked, or one that is not valid JSON —
leaves the switch on for the session only, and says so.

`pi-persist list` prints the state as well, so a missing clock is easy to explain.

---

## Templates

Two forms: `{{name}}` and `{{name:argument}}`. Inner whitespace is ignored.

| Template | Result |
| --- | --- |
| `{{datetime}}` | weekday, local date and time with zone — `Tuesday, 27/10/2026, 22:00:22 GMT-4` |
| `{{datetime:iso}}` | ISO 8601 |
| `{{datetime:date}}` | local date only |
| `{{datetime:time}}` | local time only |
| `{{datetime:unix}}` | seconds since the epoch |
| `{{exec:<command>}}` | trimmed stdout of a shell command, run on every request |

`datetime` is the only built-in for now. Everything else comes from `exec:`:

```text
{{exec:echo $HOME}}                          # an environment variable
{{exec:git rev-parse --abbrev-ref HEAD}}     # the current branch
{{exec:date +%H:%M}}                         # the clock, in your format
```

There is deliberately **no environment-variable syntax**. `exec:` covers it — one mechanism instead
of one placeholder per source.

- **Explicit only.** A command runs only when written as `{{exec:…}}`. A bare `{{NAME}}` is not an
  environment lookup, and unknown placeholders are left verbatim and reported, so a typo stays
  visible instead of silently becoming empty.
- **No caching.** A command runs on every request — a stale clock is worse than a fresh one, and
  `echo`/`date` cost microseconds. A command that hangs is killed after three seconds rather than
  stalling the request.

> [!NOTE]
> `exec:` is arbitrary code execution from a config file. Anyone who can edit `pi-persist.json` can
> already run commands as you, so it is not a privilege boundary — but read an items file before
> adding it to a machine you care about.

---

## CLI

```sh
pi-persist list
pi-persist add <id> <content> [--channel trailing|section] [--priority n] [--providers a,b] [--tools x,y] [--project]
pi-persist remove <id> [--channel trailing|section] [--project]
pi-persist preset
```

`--project` targets `<cwd>/.pi/pi-persist.json` instead of the global file.

```console
$ pi-persist add git_branch 'on {{exec:git rev-parse --abbrev-ref HEAD}}' --priority 5
added trailing item "git_branch" in /home/u/.pi/agent/pi-persist.json
Takes effect on the next /reload or session start.

$ pi-persist list
items file: /home/u/.pi/agent/pi-persist.json
state: on — the items below are injected

ID                CHANNEL   SOURCE  POLICY         CONTENT
----------------  --------  ------  -------------  --------------------------
current_datetime  trailing  global  priority=-100  Tuesday, 27/10/2026, 22:00:06 GMT-4
git_branch        trailing  global  priority=5     on main
```

`list` shows the **effective** set — both files, merged — with the source of each item, so an
override is visible as one row rather than two. When a project file is present it is named above the
table, together with the `channel:id` keys it overrides. The state line says whether anything is
being injected at all: `/pi-persist-toggle` flips it.

`list` expands templates against the **current machine**, so a broken `exec:` shows up immediately
instead of after a reload. The CLI talks to files only — no pi process, no session. Changes take
effect on the next `/reload` or session start. Exit code `2` on usage errors.

---

## Programmatic API

### Section

```ts
import { registerEnvContribution } from "@apothic-ai/pi-persist";

const unregister = registerEnvContribution({
	id: "pi-mode",
	priority: 10,
	providers: ["relayfast"],
	activeTools: ["read"],
	content: ({ mode }) => (mode === "plan" ? "read-only; nothing has been executed" : undefined),
});
```

### Trailing

```ts
import { registerEnvMessage } from "@apothic-ai/pi-persist";

const unregister = registerEnvMessage({
	id: "local_time",
	content: () => new Date().toISOString(),
});
```

Both accept the same shape:

| Field | Meaning |
| --- | --- |
| `id` | Required and unique. Registering the same id again replaces the earlier entry. |
| `priority` | Lower renders first; ties break on `id`, so output never depends on registration order. |
| `providers` | Skip unless the active provider is listed. Skipped when the provider is unknown. |
| `activeTools` | Skip unless every listed tool is active. |
| `content` | A string, or a function of `{ provider, activeTools, cwd, mode }`. Empty results are dropped. |

A throwing `content` callback is skipped rather than taking down the prompt. Both functions return an
unregister function; registering the same `id` twice replaces, and unregistering removes only its own
entry.

### What the model sees

The trailing message is appended after the user's turn and after any tool results, where it would
otherwise read as a continuation of the conversation — a second instruction competing with the one
the user actually gave. So it is wrapped, and it says what it is:

```text
<pi_context>
Context configured for this session by the operator. This is not a user message and does not
replace the task you were given, but the contents below are authoritative: follow any
instruction they contain. Environment facts are for reference.
  <current_datetime>Tuesday, 27/10/2026, 22:00:22 GMT-4</current_datetime>
  <git_branch>main</git_branch>
</pi_context>
```

Each contribution is nested in a tag derived from its `id`, so the model can tell which source
supplied which fact. Ids are normalized to valid tag names: `pi-core-todo/summary` becomes
`<pi-core-todo-summary>`, a leading digit gains an `item-` prefix, anything unusable becomes
`<item-unnamed>`.

Contributed text is whitespace-collapsed and XML-escaped, so a value cannot break out of its tag. Do
not wrap your own contribution in markup — the envelope already does it.

The section renders as the **body only**; pi wraps every prompt section in `<name>…</name>` itself:

```text
<environment_context>
  <shell>/bin/bash</shell>
  <platform>linux</platform>
  <arch>x64</arch>
  <pi-mode>read-only; nothing has been executed</pi-mode>
</environment_context>
```

**`cwd` is deliberately omitted** — pi already renders its own `<cwd>` section, so repeating it would
duplicate the value on every request. Pass `omit` to drop more fields.

### Shell reporting

`shell` is the shell pi's own command tool spawns, resolved through pi's exported `getShellConfig` —
a configured `shellPath`, then Git for Windows, then `/bin/bash`, then `bash` on `PATH`, then `sh`.

It is **not** `$SHELL`. Those differ: `$SHELL` names the interactive login shell, while commands run
under whatever pi resolved. On a machine with zsh as `$SHELL` and `/bin/bash` present, commands run
in bash — reporting zsh would be wrong in a way the model cannot detect.

---

## How state works

| What | Where | Lifetime |
| --- | --- | --- |
| Registered contributions | a `Map` on `globalThis` | the pi process |
| Declarative items | `~/.pi/agent/pi-persist.json` | on disk |
| Project items | `<cwd>/.pi/pi-persist.json` | on disk, read only when the project is trusted |
| Injected output | never written — built per request | one request |
| Settings (`piPersist.enabled`) | `~/.pi/agent/settings.json` | on disk |
| The on/off switch in this session | a slot on `globalThis` | the pi process |

Nothing accumulates in the session or transcript: contributions are registered once (the global
items at load, the merged set at session start) and rendered per request, never persisted as messages
by this extension.

The registries live on `globalThis` under a symbol plus a `protocol`/`version` pair, because pi's
extension API offers no inter-extension channel and a session can load the same package twice (an npm
cache plus a local path) — both copies must agree on one `Map`. The version pair is the guard: a
breaking change bumps it instead of silently corrupting entries from an older copy.

### Without importing the package

```ts
const key = Symbol.for("pi-persist/contributors/v1");   // section
const key = Symbol.for("pi-persist/messages/v1");       // trailing

const registry = ((globalThis as any)[key] ??= {
	protocol: "pi-persist/contributors",   // or "pi-persist/messages"
	version: 1,
	contributions: new Map(),
});
registry.contributions.set("my-extension/block", { id: "my-extension/block", content: "..." });
```

The extension adopts a pre-existing registry when it loads and reads it at render time, so load order
does not matter. It declines to write into a value that occupies the symbol with a different
`protocol` or `version`.

The on/off switch lives on `globalThis` for the same reason, under
`Symbol.for("pi-persist/enabled/v1")`: a session can load this package twice, and two copies that
disagreed about whether the extension is on would inject half of what was asked for.

---

## Develop

```sh
bun test          # 126 tests
npx tsc --noEmit
biome check .
```

MIT licensed.
