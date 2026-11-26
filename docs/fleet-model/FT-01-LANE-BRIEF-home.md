# FT-01 lane brief — `ft-01-home`

Owner of this brief: `self-improvement-leader`. Source: `/home/bitnom/Documents/Assistant/Fleet TODOs.md`, FT-01.
Decision record: `pi-fleet-model/FT-01-LEAD-DECISIONS.md` (D6, D8, D10). This brief is the task; the decision record is why.

## Job

Turn yellowstone's home-directory content into a literal `home/` mirror, and turn `install.sh`
into "copy `home/` onto `$HOME`" with `doctor.sh` verifying the result.

Do this in your own worktree on branch `ft-01/home`, branched from `master` at the moment the
worktree lands. **Never** edit `~/Code/yellowstone` itself, and **never** touch
`.pi/launch.env` in any tree. jj is not used in this repo.

## The rule that makes it mechanical

`home/` contains **exactly the files `install.sh` writes today**, and nothing else. A file the
installer does not write has no home under `home/`. A file it does write must have exactly one.

That rule is the whole design. Do not extend `home/` to "things that look like config", and do
not copy a live directory wholesale — the live directories are mostly generated state
(`~/.pi/agent` alone holds `auth.json`, `models-store.json`, `missions/`, `mode-approvals.json`,
`mode-presets/`, `extensions/`, `git/`, and two dozen `.bak-*` files).

## Destinations (measured from `install.sh`, 2026-11-08)

The mirror is **per file, not per directory** — one source directory maps to more than one
destination. These are the actual `install_file` / `link_dir` calls, not a summary:

| Source in `home/` | Destination | Written by |
|---|---|---|
| `home/.config/herdr/config.toml` | `~/.config/herdr/config.toml` | `install_file herdr/config.toml` |
| `home/.config/herdr/plugins.toml` | `~/.config/herdr/plugins.toml` | plugins stage |
| `home/.agents/skills/herdr/` | `~/.agents/skills/herdr` | `link_dir herdr/skills/herdr` |
| `home/.local/bin/herdr-agy.sh` | `~/.local/bin/herdr-agy.sh` (mode 755) | `install_file herdr/scripts/herdr-agy.sh` |
| `home/.pi/agent/settings.json` | `~/.pi/agent/settings.json` | merge or first-install |
| `home/.pi/agent/models.json` | `~/.pi/agent/models.json` | merge |
| `home/.pi/agent/extensions/transient-error-retry.ts` | `~/.pi/agent/extensions/…` | `install_file pi/extensions/…` |
| `home/.pi/agent/extensions/nonblock.ts` | `~/.pi/agent/extensions/…` | `install_file pi/extensions/…` |
| `home/.pi/agent/pi-auto-compact.json` | `~/.pi/agent/pi-auto-compact.json` | `install_file` |
| `home/.pi/agent/pi-goal.json` | `~/.pi/agent/pi-goal.json` | `install_file` |
| `home/.pi/agent/pretty-tui.json` | `~/.pi/agent/pretty-tui.json` | `install_file` |
| `home/.pi/agent/pi-persist.json` | `~/.pi/agent/pi-persist.json` | install **only if absent** (holds reminders) |
| `home/.pi/agent/model-picker.json` | `~/.pi/agent/model-picker.json` | install **only if absent** (MRU state) |
| `home/.pi/agent/web-search.json` | `~/.pi/agent/web-search.json` | install **only if absent** |
| `home/.agents/skills/hotshot/` | `~/.agents/skills/hotshot` | skills stage (`skills/skills.tsv` drives it) |
| `home/.agents/skills/shared-flyio-build-server/` | `~/.agents/skills/shared-flyio-build-server` | skills stage |
| `home/AGENTS.md` | `~/AGENTS.md` | `fleet/AGENTS.md` today |
| `home/.overlord/` | `~/.overlord/` | overlord stage |
| `home/.sysops/` | `~/.sysops/` | overlord stage |

Three consequences that are easy to get wrong and are therefore spelled out:

- **`herdr/` does not map to one place.** `config.toml` and `plugins.toml` go to `~/.config/herdr/`,
  `scripts/herdr-agy.sh` goes to `~/.local/bin/`, `skills/herdr` goes to `~/.agents/skills/`.
- **`skills/skills.tsv` is a manifest, not installed content.** It stays at the top level (or
  next to the installer) and drives which `home/.agents/skills/*` entries install; it must not
  appear as a skill.
- **Three pi files are install-if-absent** (`pi-persist.json`, `model-picker.json`,
  `web-search.json`) because they hold a person's own state. The mirror still carries them as
  the first-install source; the installer must keep never overwriting them.

The env-var overrides stay working — they are how a test harness installs somewhere harmless.
The point of the change is that the *default* destination is derivable from the path instead of
living only in a shell variable, so a sixth file has an obvious home.

## What already exists and moves

`pi/` → `home/.pi/agent/` (including `pi/extensions/`); `herdr/` → three destinations as tabled
above; `skills/<name>/` → `home/.agents/skills/<name>/`; `fleet/AGENTS.md` → `home/AGENTS.md`;
`overlord/` → `home/.overlord/`.

`scripts/`, `docs/`, `test/`, `yellowstone-skill/`, `install.sh`, `IDEA.md`, `README.md` stay at
the top level — they are the installer and its documentation, not installed content. The
`yellowstone-skill` keeps owning install/update procedures that are brittle; do not reimplement
them, and do not move the skill.

## Exclusions that are decisions, not omissions

- `~/.pi-profile-switch/instances/<id>` is **never** mirrored. It is generated (auth, sessions,
  npm, modes), partly secret-bearing, and it is what `PI_CODING_AGENT_DIR` actually points at
  on this machine. `home/.pi/agent/` is *the path pi uses when no profile is selected*, and
  `README.md` must say so in those words — the two differ today and hiding that would be worse
  than the drift.
- `~/.pi/agent/secrets` is excluded. The `secrets` stage keeps creating empty
  `<provider>` files to fill in; it must never copy real values out of a mirror.
- `.bak-yellowstone-*` backups are an install-time artifact and are not part of the tree.

## Acceptance — what "done" means

1. `git subrepo status` in the conversion tree is unaffected (you do not touch `src/`).
2. On a **clean clone** of your branch, `./install.sh --dry-run` prints a complete plan that
   names every destination above, and touches nothing.
3. `./install.sh --yes` into a throwaway `HOME` (e.g. `HOME=$(mktemp -d)` with the four
   destination variables overridden) produces exactly the `home/` tree at the right paths.
4. `doctor.sh` (or the `verify` stage) exits non-zero when a single destination file is
   modified, and lists the mismatch by path. Prove it by modifying one file in the throwaway
   `HOME` and showing the non-zero exit.
5. `test/` gains one runnable check for (3) or (4) — a test that fails if a `home/` file has no
   destination or a documented destination has no `home/` file.
6. You report: branch, commit, test counts, and the throwaway-`HOME` transcript. A report is
   `reported` until a command in it can be re-run.

## Report back to `self-improvement-leader`

Branch, commit, what moved, what you deliberately left, the acceptance evidence above, and
anything you found that contradicts the decision record. If the record is wrong, say so — it is
easier to change a document than a monorepo.
