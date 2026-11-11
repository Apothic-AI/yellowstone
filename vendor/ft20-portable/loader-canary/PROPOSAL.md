# Loader canary — REFUSED as previously proposed; disposable recipe only

**This directory ships no executable canary.** There is no `run.sh`. The previous proposal's script
was removed because the independent source acceptance found its isolation plan unsound, and a
runnable file that copies real credentials is a hazard whether or not anyone runs it today. Anything
that starts a real `pi` process belongs to a separately authorised release, built to the recipe
below and accepted on its own terms.

## Refusal notice (verbatim scope of what was withdrawn)

The withdrawn script did all of the following, each of which the acceptance rejected:

* copied `auth.json`, `models.json`, `settings.json` and `hermes-memory-config.json` out of a real
  agent directory — real credentials and real model routing, in a file whose prose claimed zero
  credentials;
* inherited credential/provider/proxy/session/rooms environment variables and Pi locators;
* preserved skills and prompts with symlinks intact and resource paths pointing outside scratch;
* carried an absolute configured `memoryDir`, so redirecting `HOME` and `PI_CODING_AGENT_DIR`
  confined nothing, and `session_start` handlers can read, write or migrate real stores with no
  prompt;
* used lexical `ROOT` guards rather than canonical containment, so repo and live-directory overlap
  was possible;
* treated network isolation as optional — if `unshare -n` failed it ran connected — and counted the
  absence of selected RPC events as if it were provider-call accounting;
* fingerprinted a **live** store, which cannot prevent a write and was itself outside the
  acceptance's authorisation;
* promised assertions (tool enumeration with exact containment, `isCompacting`, scratch-store
  absence, package/profile hashes) that its code did not implement;
* lacked `set -e` semantics and reused an existing scratch root.

Do not recreate it. Do not adapt it. The recipe below is a specification for a future, separately
authorised release, not a template to be half-implemented.

## What the proof is for

Full-profile, zero-provider registration proof: a real `pi` process loads the **full actual package
set** and the extension registers its tools and commands, with no model call and no access to real
state. It is the gate the portable harness deliberately does not attempt — gate 9 there is a
scratch-HOME `pi list` boot smoke, and the harness cannot prove registration.

## Recipe — disposable, full actual, no live inputs

1. **Disposable full actual package set (all 25).** Render `home/.pi/agent/settings.json` into a
   disposable root and copy **every** package it names — the 25 entries, not just the vendor
   package — into that root, so each `packages` entry is a disposable local copy. Sanitise every
   path: rewrite `@YELLOWSTONE_REPO@` renders to the disposable copies, and replace any absolute
   `memoryDir`/`projectsMemoryDir`/skills/prompt/session path in `hermes-memory-config.json` and
   `settings.json` with a disposable path. Record the pre-sanitisation and post-sanitisation forms
   as a receipt; a remaining absolute path outside the disposable root is a hard failure, not a
   warning.
2. **No credentials, no models.** Do not copy `auth.json` or `models.json`; assert their absence in
   the disposable agent directory before start, and scrub credential/provider/proxy/session/rooms
   variables from the environment (`env -i` plus an explicit allowlist, never an inherited
   environment). The process must start with no usable provider configuration.
3. **Isolated HOME / XDG / cwd / rooms / sockets.** Fresh `HOME`, `XDG_*`, `TMPDIR`, cwd and session
   directory inside the disposable root; `unset` Pi/rooms/session locators; hide the live `.pi`,
   `.config`, `.pi-profile-switch`, `.agents` and runtime socket directories from the process by not
   binding them at all.
4. **Fail-closed network.** Network isolation is **required**, implemented by the sandbox
   (`bwrap --unshare-net`, plus `--unshare-pid --unshare-ipc --unshare-uts --new-session
   --die-with-parent --cap-drop ALL`). If the sandbox is unavailable the run aborts; there is no
   connected fallback and no flag that turns isolation off. Loopback-only assertions are not enough:
   record that the process had no route out.
5. **Read-only filesystem.** Everything the process reads (repository, vendored package copies,
   installed SDK) is mounted read-only; only the disposable root is writable, and only the
   directories the loader legitimately needs. A post-run diff of the read-only mounts is empty by
   construction and is recorded as such.
6. **Explicit receipts, no live fingerprint.** Record: the disposable package tree hash before and
   after; the settings/config copy manifest (path → sanitised path); the registration list from
   `get_commands` with **canonically contained** `sourceInfo.baseDir` (exact prefix under the
   disposable root, not `startsWith` on a string), plus a static fallback for tool enumeration if
   the CLI exposes none; the scratch store **absence** (no store file created anywhere in the
   disposable root) rather than a before/after fingerprint of anything real; and provider-attempt
   accounting by observation (zero outbound sockets / zero `connect` syscalls), not by the absence of
   events the client happened to subscribe to.
7. **One process, one load, no prompt.** The only commands sent are state reads (`get_commands`,
   `get_state`). A prompt is never sent, and any assistant/tool event fails the run. The run is
   bounded by timeout and by `--die-with-parent`.

## Acceptance criteria for the future canary

| Criterion | Requirement |
|---|---|
| Package set | all 25 rendered entries present as disposable copies; zero unresolved package |
| Paths | zero path outside the disposable root in the effective settings/config |
| Credentials | no `auth.json`, no `models.json`, no credential/provider env var in the process |
| Network | sandbox-enforced; abort on unavailability; zero outbound sockets recorded |
| Filesystem | read-only mounts outside the disposable root; nothing written outside it |
| Registration | the extension's ten commands and six tools observed (or statically demonstrated with a recorded reason) |
| State | no store file created; no live data read |
| Receipts | tree hashes, manifest, registration list, socket/state observations — all strict JSON |

## Deliberately not shipped here

No script, no wrapper, no bwrap argument list as a copy-paste artefact, no template that copies a
real profile, and no connected fallback. The recipe is prose so that implementing it is a deliberate
act under a separate authorisation rather than an inherited default.

## Limits of the current source release

Even with this recipe implemented, a canary would not prove model behaviour (zero completions), the
advertised 732 upstream tests (not published), native SQLite behaviour, or the historical FT-20
warning cause. Those remain unproven and are recorded as such.
