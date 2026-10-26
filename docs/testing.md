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

## Suites

| Suite | What it proves |
|---|---|
| `smoke` | every script parses, every JSON file parses, every `SKILL.md` has valid frontmatter, the skill and plugin manifests are consistent and pinned, no credentials or developer paths in the tree |
| `install` | a from-scratch install produces the expected files, packages, providers, credential files and skill links |
| `idempotent` | running install twice changes nothing byte-for-byte, and creates no duplicate packages or providers |
| `partial` | on a machine that already has config, the installer adds and never overwrites: the user's theme, provider route, custom keys and package sources all survive |
| `failures` | with no herdr, with a corrupt `settings.json`, with nothing installed: it explains itself, backs up, and exits honestly |

Run one at a time while iterating; `all` before committing.

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

## Writing a new check

- Use `in_home <sandbox> <command>` so the script under test sees a throwaway
  `HOME`, `HERDR_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `AGENTS_SKILLS_DIR`,
  `LOCAL_BIN_DIR` and `YELLOWSTONE_BACKUP_DIR`. Every one of those is an
  override the installer honours; if you need a new one, add it to `lib.sh` and
  to this list rather than letting a test write to the real home.
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
