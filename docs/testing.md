# Testing the installer

The installer writes to `~/.config/herdr`, `~/.pi/agent`, `~/.agents/skills` and
`~/.local/bin`. On a working machine that means every test is either "trust that
each write is a no-op" or "audit afterwards". Neither is a test.

`test/` builds a container whose entire HOME is expendable. A mistake costs a
rebuild, and the assertions run against a machine that has never been configured.

Use the wrapper. It bind-mounts the current checkout, so both the scripts under
test *and* the assertions themselves come from your work tree:

```bash
./test/run.sh              # all suites
./test/run.sh smoke        # parsing and static checks only
./test/run.sh install      # one suite
```

It builds the image on first use. To drive the image directly:

```bash
docker build -f test/Dockerfile -t yellowstone-test .
docker run --rm yellowstone-test              # bakes the repo in at build time
docker run --rm -v "$PWD:/repo:ro" yellowstone-test install   # test the work tree
```

**Prefer the wrapper, and if you run the image directly, rebuild it after any
edit.** The image bakes a copy of the repo at build time, so a bare
`docker run` tests whatever was committed when the image was built — silently,
with a green result. This is not hypothetical: a stale baked copy kept reporting
a message as missing from code that contained it, across three debugging rounds.
The suite now reads itself from `/repo` and prints a warning when the mounted
tree differs from the baked copy, but the wrapper is the reliable path.

The image installs the **real** `herdr` and `pi` from their public installers
rather than stubbing them, because half of what the tests assert about —
`herdr plugin list` output, `herdr workspace list`, `pi list`, the managed pi
path — is defined by those binaries. A stub would pass tests the real thing
fails.

## The conversion gate — host-side, not in the container

```bash
./test/verify-subrepo-roundtrip.sh
```

This is the FT-01 completion gate and it is the one test that must **not** run
in the image. It clones the repository into a throwaway directory and, for every
`src/**/.gitrepo`, asserts that `git subrepo status` resolves, that the pulled
commit and branch equal the ones recorded, that the directory has content, and
that `git subrepo pull` is a no-op — plus a hard count, so a subrepo deleted to
make the rest pass fails instead of shrinking the gate. It needs the real remote
(`git ls-remote` against GitHub) and the real subrepo trees, and `.dockerignore`
excludes `src/` from the image on purpose. A container copy could only prove
things about a copy.

Run it on a clean tree: it clones what is committed, and it refuses to start if
the working tree is dirty. That refusal is a feature — a gate that can be run
over uncommitted work is not describing what ships.

## Suites

| Suite | What it proves |
|---|---|
| `smoke` | every script parses, every JSON file parses, every `SKILL.md` has valid frontmatter, the skill and plugin manifests are consistent and pinned, no credentials or developer paths in the tree |
| `install` | a from-scratch install produces the expected files, packages, providers, credential files and skill links |
| `mirror` | `home/` is a literal mirror of `$HOME` in both directions: every file under `home/` has a destination and lands there byte-identical, every documented destination is backed by a file in `home/` (or is generated), a modified destination makes `doctor.sh` exit non-zero and name the path, the personal install-if-absent files survive a reinstall, and `--dry-run` names every destination without writing one |
| `idempotent` | running install twice changes nothing byte-for-byte, and creates no duplicate packages or providers |
| `partial` | on a machine that already has config, the installer adds and never overwrites: the user's theme, provider route, custom keys and package sources all survive |
| `failures` | with no herdr, with a corrupt `settings.json`, with nothing installed: it explains itself, backs up, and exits honestly |

Run one at a time while iterating; `all` before committing.

### What the gates cannot see: the machine

Every suite above runs in a container against a **copy** of this repository, so
every one of them tests the tree against the tree. That is what makes them
reproducible, and it is also their blind spot: **a mirror that has silently
reverted a fix which is live on the machine will pass all of them.** The
container installs `home/.overlord/tools/overlord-wake.sh` as the tree carries
it and then compares that install to that same tree — self-consistent, and
wrong about the machine.

The only check that compares mirror to live is `doctor.sh`'s **Installed mirror**
section, which requires every `copy`/`copy-exec` file to be byte-identical to its
destination (`cmp -s`, `record fail` naming both paths). `.overlord/tools/*` and
`.overlord/bin/*` are `copy-exec`, so the fleet's own tooling is covered. The
`mirror` suite exercises that mechanism with a tampered file in a probe `HOME`,
so the code path is tested — but the **live** invocation is not something
`./test/run.sh` can perform, because a fresh clone has no live directory to
compare against.

Run `./scripts/doctor.sh` after any merge that touches `home/`, and treat a green
gate as saying nothing about this direction. When a conflict is resolved inside
`home/`, the question to ask is not "does the suite pass" but **"is the copy in
the tree still the copy running on this machine"** — compare it from outside with
`cmp`, because nothing in the tree can answer it.

## What the tests already caught

These are real defects the suite found, not hypotheticals:

1. **`herdr workspace create` does not deduplicate.** Given identical `--label`
   and `--cwd` twice, it produced two workspaces (`w1A`, `w1B`). A duplicate
   `overlord` space silently splits orchestrator attention, which is why
   `scripts/overlord.sh` looks the space up first.
2. **`herdr workspace list` rejects `--json`.** It already emits JSON; the flag
   is a usage error. A script that passed it got an empty parse and then
   silently did nothing.
3. **The pi managed installer activates at `~/.pi/agent/bin`,** not
   `~/.local/bin`. Anything that assumes the latter cannot find `pi` after a
   fresh install.
4. **A no-op `pi install` still rewrites `npm/package-lock.json`.** The
   idempotency suite fingerprints the tree excluding npm's cache (which churns on
   every npm invocation) and git's `FETCH_HEAD`, then asserts on
   `package-lock.json` and every config file separately — so lock churn can
   neither hide a real change nor be reported as one.
5. **`local a="$1" b="$SANDBOX/$a"` is an unbound-variable error** under
   `set -u`: bash creates every name in the `local` list before assigning any.
   That was a defect in the test harness itself, and the kind of thing that makes
   a suite report 25 failures that are all one bug.
6. **`short()` never shortened anything.** It was written
   `${1/#$HOME/~}`, and bash tilde-expands the replacement, so the `~` expanded
   straight back to `$HOME` and every "installed ~/…" line printed an absolute
   path. Escaping the replacement (`\~`) is the fix; the mirror suite reads the
   plan, so a plan that cannot say `~/AGENTS.md` is now a failure.
7. **`--dry-run` could abort before it printed the plan.** Two stages called a
   helper without the `|| warn` guard their neighbours had, so under `set -e` a
   missing dagr binary (the skills stage) or an absent local plugin checkout (the
   herdr stage) ended the run — in dry-run, before agents, overlord, secrets and
   verify were ever described. A dry run that stops half way is worse than no
   dry run: it reads as "nothing left to do".
8. **A first install handed pi a package placeholder as a path.** The template's
   `@PI_EXTENSIONS_APOTHIC@/packages/pi-goal`, `@PI_EXTENSIONS_1@/packages/pi-modes`
   and `@PI_FLEET_HOOKS@` were copied verbatim when no `settings.json` existed
   yet, because the copy branch skipped the rendering the merge did. `json-edit.js
   render-settings` renders them and drops the ones whose checkout is absent.
9. **The skills manifest was read as the loop's stdin.** `npx skills add` can
   read stdin, and inside `while read … done < <(rows)` that is the manifest, so
   the first fetched skill swallowed every row after it and the install reported
   success having skipped the rest. `</dev/null` on the fetch is the fix; it only
   bites on a machine with no local checkouts, which is exactly a fresh clone.

## Writing a new check

- Use `in_home <sandbox> <command>` so the script under test sees a throwaway
  `HOME`, `HERDR_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `AGENTS_SKILLS_DIR`,
  `LOCAL_BIN_DIR`, `OVERLORD_DIR`, `SYSOPS_DIR` and `YELLOWSTONE_BACKUP_DIR`.
  Every one of those is an
  override the installer honours; if you need a new one, add it to `lib.sh` and
  to this list rather than letting a test write to the real home.
- Resolve paths through `scripts/lib.sh` (`home_dest`, `home_policy`,
  `home_dest_roots`), as the `mirror` suite does, instead of hardcoding a
  destination in the test: a test that repeats the mapping cannot catch the
  mapping being wrong.
- Prefer asserting on **artifacts** (file exists, JSON parses, exit code) over
  transcript text. Text assertions are for the cases where the message is the
  contract, such as a failure explaining how to fix itself.
- If a check fails, the failure output should be enough to act on without
  re-running. Print the expectation and what arrived.

## Machine inventories are not repo content

A list of what is installed *on one machine* — skills, themes, plugins with
their versions — is useful for an operator and wrong for a repository: it pins
versions that move, and on a personal machine it names private projects. The
inventory generated for this machine lives at
`~/.overlord/notes/skill-inventory.md`; `agent-skills.md` is gitignored so a copy
never lands in a commit.

Regenerate it from the sources rather than trusting a stored copy: herdr's themes
come from `herdr --default-config`, pi's from
`~/.pi/agent/npm/node_modules/@spences10/pi-themes/themes/`, and the skill list
from `~/.agents/skills` plus `~/.pi/agent/skills`. The repo documents *how to
enumerate* each of those; the enumeration itself is a snapshot.

## Limits

- **herdr plugins are per-user, not per-HOME.** The sandbox cannot install them,
  so plugin-dependent checks assert on what the installer *says* it is doing
  rather than on a plugin that cannot exist in a fresh container. Covering plugin
  behaviour needs a pre-baked image with the plugins installed; that is a
  separate, slower suite.
- **No network assertions.** `pi auth check` resolves a credential locally and
  does not contact the provider, so the suites cannot catch a revoked key. They
  catch a missing or empty one.
- **The container is Linux x86_64.** macOS and Windows paths are untested;
  `install.sh` is POSIX-ish bash but has not been proven there.
