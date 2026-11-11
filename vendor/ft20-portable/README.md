# FT-20 portable candidate harness

Everything here operates on a **staged copy** of `../pi-hermes-memory-0.10.0-ft20/`. The vendored
tree is never a build directory and is never edited: gate 10 re-hashes all 106 files after the run
and requires 106/106 OK.

The package itself is byte-exact accepted source. Portability therefore lives here, not inside the
package: the accepted `scripts/verify.sh` and `scripts/link-local-deps.sh` keep their accepted bytes,
and this harness supplies the environment those scripts already accept as overrides.

## Run it

```bash
export FT20_WORK=/var/tmp/ft20-run          # required: absolute, fresh, outside repo AND live dirs
export FT20_TSC=/path/to/typescript/bin/tsc # default: `tsc` on PATH (5.9.3 here)
./rebuild-vendor.sh                         # provenance proof (see ../pi-hermes-memory-0.10.0-ft20/ft20-provenance/REBUILD.md)
./verify-portable.sh                        # strict gate
./harness-selftest.sh                       # negatives for the guard and the JSON gate
```

No `npm install`, no `postinstall`, no network, no provider call. The only writes are under
`$FT20_WORK`.

### Containment contract (`lib/scratch-guard.sh`)

Both entrypoints validate the scratch root **before** they create, delete or copy anything, and
refuse with exit 2 if it is:

* not absolute;
* reached through any symlink component, or canonicalising to a different path;
* the repository, or anywhere inside it (resolved with `git rev-parse --show-toplevel`);
* `$HOME`, or inside `$HOME/.pi`, `.config`, `.pi-profile-switch`, `.agents`, `.local/state`,
  `.local/share`, or `PI_CODING_AGENT_DIR`;
* a shared root (`/`, `/tmp`, `/var/tmp`, `/dev/shm`);
* not **fresh** — it must be absent or an empty directory.

**Every writable output is under that root.** There is no receipt-directory override: `FT20_RECEIPT_DIR`
is refused (exit 2) rather than honoured, and `receipts/` and `stage/` are created through
`ft20_require_output_dir`, which re-checks that each is a real directory, not a symlink, and
canonically inside the validated root. `link-deps.sh` takes no destination from the environment at
all — the dependency-selection receipt is written by the caller that owns a validated receipts
directory.

The p1E rejection was exactly this surface: `FT20_WORK` was validated and `FT20_RECEIPT_DIR` was not,
so a safe scratch root could still be combined with (and write into) a forbidden `HOME/.pi` tree.

`harness-selftest.sh` proves the refusals rather than asserting them — **38 cases in a full run**
(37 without the optional generated-receipt case), all passing:

* 20 containment cases on the WORK surface (repo, repo root, `..` escape, relative, empty argument,
  shared roots, six live directories, three symlink aliases, non-empty directory, non-directory;
  plus absent and empty directories accepted);
* 5 strict-JSON cases (valid accepted; the historical trailing-comma shape rejected; trailing comma
  in an object rejected; missing file rejected; a generated rebuild receipt accepted);
* 12 receipt-destination cases — the real entrypoints run with a **valid fresh WORK** and a forbidden
  `FT20_RECEIPT_DIR` (repository path, synthetic `HOME/.pi`, symlink alias to a live `.pi`, `..`
  escape, relative path, plain outside directory) for both `rebuild-vendor.sh` and
  `verify-portable.sh`, plus the selftest's own surface. Each requires exit 2 **and** the destination
  absent **and** the scratch root still empty, so a refusal that happened after `mkdir` would fail.

It writes `selftest-receipt.json` and fails on any mismatch.

The guard is a containment boundary for *this harness*, not a general sandbox: it decides where this
script may write, and nothing more.

### Dependency contract (`link-deps.sh`)

Six links, and nothing recursive:

| Entry | Default source |
|---|---|
| `@earendil-works/pi-coding-agent` | `FT20_HOST_ROOT`, else resolved from `pi` on PATH |
| `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox` | `$FT20_SDK_ROOT` (default `<host>/node_modules`) |
| `@types/node` | `FT20_NODE_TYPES` |
| `strip-ansi` | `FT20_NPM_ROOT` (default `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules`) |
| `better-sqlite3` (optional, runtime) | same as `strip-ansi`; skip with `FT20_BETTER_SQLITE3=0` |

`strip-ansi` is the one dependency this package must resolve through `node_modules` rather than
through Pi's host module map. It is also the reason a bare vendor directory cannot load: `pi list`
on the unlinked tree fails with `Cannot find module 'strip-ansi'` before any of this harness runs.

The linker **refuses** a tree whose ancestor has `node_modules`. Inheriting a neighbour's
dependency tree is the failure mode the accepted gate had to disprove (its `no-ancestor.txt` walks
all the way to `/`); here it is a precondition of the link, and `no-ancestor.txt` is still written.

Selected versions on this machine (receipt `sdk-selection.json`): host `@earendil-works/*` 1.5.0,
`@types/node` 26.6.6, `typebox` 1.3.27, `strip-ansi` 7.2.0, `better-sqlite3` 13.0.3, Node v22.23.3,
TypeScript 5.9.3.

## Gate results (measured, this candidate)

| Gate | Requirement | Measured | Receipt |
|---|---|---|---|
| 0 guard | scratch root canonical, symlink-free, outside repo/live dirs, fresh; **no output override** | refusal is exit 2 before any write | `scratch root (canonical, guarded):`, `receipts root (contained):` lines |
| 1 payload | 106 files, exact accepted bytes | 106/106 OK | `payload-check.txt` |
| 2 deps | 6 minimal links, no ancestor `node_modules` | 6/6 linked, ancestors clean | `link-deps.log`, `no-ancestor.txt` |
| 3 resolve | each link imports from the staged tree | 5 modules resolved, `@types/node` types-only present | `resolve.log` |
| 4 typecheck | strict, whole component, 0 errors | exit 0, 0 errors (`error TS` count) | `typecheck.log` |
| 5 build | changed modules emit | exit 0, 25 JS files | `build.log` |
| 6 tests | 77 pass, 0 fail/skip/cancel | 77 / 0 / 0 / 0 | `tests-full.log` |
| 7 controls | published-base fail control 8/8 | `base-control: 8/8 checks passed` | `base-control.log`, `base-build.log` |
| 8 probes | accepted runner 40/40, 30 R1 + 10 R2 | 40 pass / 0 fail / R1 30 / R2 10 | `actual-probes.log`, `actual-probes.summary.json` |
| 9 loader | `pi list` in a scratch HOME, no load failure | exit 0, 0 failures, package listed, scratch unchanged (`skipped: …` is recorded as skipped in `gate-receipt.json`, never as evidence) | `loader.log` |
| 10 integrity | vendored bytes untouched by the run | 106/106 OK | `vendor-integrity.txt` |
| 11 receipts | every emitted receipt parses as strict JSON | all `*.json` parsed, exit 0 | `strict-json.log` |

Verdict line: `GREEN — every gate exact`.

The runner used for gate 8 is the accepted independent one, byte-for-byte; its digest is pinned in
`probes/PINNED.sha256` and gate 8 fails if the bytes drift. Its model and child interactions are
synthetic stubs — no service is contacted.

### Equivalence with the gate the reviewer ran

The vendored, unmodified `scripts/verify.sh` also runs in the staged copy and prints `GREEN`
(77/77 tests, `base-control: 8/8`, 0 type errors). It needs the repository's git objects for
`git archive 5a1446c2a`, so it is run here with `GIT_DIR`/`GIT_WORK_TREE` rather than being a
portable precondition; `verify-portable.sh` never depends on it.

## Deferred, and deliberately not in this release

* `integration/settings.future.diff` — the one-line future replacement, `git apply --check` clean,
  **not applied**. See `integration/FUTURE-REPLACEMENT.md`.
* `loader-canary/` — **prose only; it ships no executable.** The previously proposed `run.sh` was
  withdrawn after the independent source acceptance found its isolation plan unsound (it copied real
  `auth.json`/`models.json`/config, used lexical guards, treated network isolation as optional and
  fell back to running connected). `PROPOSAL.md` now carries a refusal notice plus a specification
  for a future disposable run: the full 25-package actual set as disposable copies, sanitised paths,
  no credentials or models, isolated HOME/XDG/cwd/rooms/sockets, sandbox-enforced (fail-closed)
  network, read-only filesystem, and explicit registration/state receipts with no live fingerprint.
  Gate 9 above is the weaker proof that *is* run: extension load in a scratch agent dir, boot only.
* Anything live: no settings edit, no install, no reload, no canonical write, no push.
