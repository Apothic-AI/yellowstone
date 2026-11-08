# FT-01 inventory — what actually has a canonical home

Reconnaissance for [FT-01](../../../Documents/Assistant/Fleet%20TODOs.md): turning this repo into a
git-subrepo monorepo. This page records **measurements**, not the plan. Every row was read with
`git -C <path>` and the commands are given so anyone can re-derive it.

Read on 2026-11-08, after `git-subrepo` 0.4.9 was confirmed installed
(`~/.local/opt/git-subrepo`, `git subrepo version`). There is **no git-subrepo skill on this
machine** — `~/.agents/skills` has none, and neither does `~/.pi/agent/skills`.

## Reproduce

```bash
# declared pi packages and the refs they resolve to
python3 -c 'import json;print(json.load(open("pi/settings.json"))["packages"])'
pi list | grep -E '^(  git:|  /)'          # what is *running*, not what is declared

# declared herdr plugins
grep -E '^id|^source|^ref' herdr/plugins.toml

# per-repo state
git -C <path> remote get-url origin
git -C <path> branch -a | grep -E 'apothic(-main|-master)?$'
git -C <path> status --porcelain | wc -l
test -d <path>/.jj && echo jj
```

## Forked components — these are the subrepo candidates

Each is a real delta we maintain, installed from its own repository.

| Component | Upstream | `apothic*` branch | Checked out | jj | Dirty files | Canonical checkout today |
|---|---|---|---|---|---|---|
| pi-pretty-tui | `Apothic-AI/pi-pretty-tui` | `apothic` | `apothic` | yes | 0 | `/home/bitnom/Code/apothic-monorepo-workspace/tooling/pi-pretty-tui` |
| pi-extensions (supplies `packages/pi-goal`) | `Apothic-AI/pi-extensions` | `apothic` | `apothic` | no | 2 | `/home/bitnom/Code/pi-extensions-apothic` |
| bizzy | `Apothic-AI/bizzy` | `apothic-main` | `apothic-main` | yes | 0 | `/home/bitnom/Code/apothic-monorepo-workspace/tooling/bizzy` |
| unblock | `Apothic-AI/unblock` | `apothic-main` | detached `HEAD` | yes | 6 | `/home/bitnom/Code/apothic-monorepo-workspace/tooling/unblock` |
| pi-rooms | `Apothic-AI/pi-rooms` | **none** | `master` | no | 2 | `/home/bitnom/Code/pi-rooms` |
| apothic-todo | `Apothic-AI/apothic-todo` | **none** | `main` | no | 0 | `/home/bitnom/Code/apothic-todo` |
| pi-persist | `Apothic-AI/pi-persist` | **none** | `main` | no | 0 | `/home/bitnom/Code/pi-persist` |
| herdr-voice-linux | `Apothic-AI/herdr-voice-linux` | **none** | `linux-port` | no | 0 | `/home/bitnom/Code/herdr-voice-linux` |
| pi-cache-optimizer | `bitnom/pi-cache-optimizer` | **none** | `feat/opencode-cache-stats` | no | 2 | `/home/bitnom/Code/pi-cache-optimizer` |

Nine repositories. Only four carry a branch named the way FT-01 expects
(`apothic-master` / `apothic-main` / `apothic`); the other five are on `master`, `main`,
`linux-port` and `feat/opencode-cache-stats`, and have **no** `apothic*` branch at all.

## Not forks — they stay declared refs, not subrepos

- **Twelve pinned upstream herdr plugins** in `herdr/plugins.toml` (`herdr-bar`,
  `ray.plugin-manager`, `herdr-dagr`, `codeforbreakfast.beady-eye`, `mroth.jj-status`,
  `herdr-context`, `wilbeibi.catchup`, `vsh.stash`, `ntindle.herdr-resurrect`,
  `herdr-theme-picker`, `ezracerpac.jj-waltz`, `abhishekrana.dictate`). We do not patch them;
  a pinned commit *is* the record.
- **Ten npm pi packages** (`pi-web-access`, `pi-auto-compact`, `@spences10/pi-themes`,
  `pi-nested-skills`, `@narumitw/pi-btw`, `pi-copy-message`, `@timmyjl12/pi-model-picker`,
  `@arhen/pi-core-tps-stats`, `@99percentpeople/pi-thinking-fold`,
  `@howaboua/pi-subdir-agents`). Upstream releases; nothing of ours to carry.
- **Two local herdr plugins** (`unblock`, `herdr-voice`) are `link`-installed from the fork
  checkouts above, so they are covered by those rows.
- **Hand-written code that belongs to the superproject**: `pi/extensions/nonblock.ts`,
  `pi/extensions/transient-error-retry.ts`, `scripts/`, `herdr/scripts/`, `skills/`,
  `fleet/AGENTS.md`, and the config files (`config.toml`, `plugins.toml`, `models.json`,
  `settings.json`, `pi/*.json`).

## Drift found while measuring

1. **The running pi disagrees with the committed manifest.** `pi/settings.json` declares
   `git:github.com/Apothic-AI/pi-pretty-tui@apothic`; `pi list` reports the live install at
   `@test/composer-selection-on-apothic`. The `~/Code/pi-pretty-tui` checkout is on that same
   test branch (last commit 2026-11-01) and the `tooling/pi-pretty-tui` checkout is on `apothic`
   (last commit 2026-10-27). Nothing in the repo says which of the two is canonical.
2. **Three remotes have two checkouts each.**
   `Apothic-AI/pi-pretty-tui` → `~/Code/pi-pretty-tui` and `tooling/pi-pretty-tui`;
   `Apothic-AI/pi-persist` → `~/Code/pi-persist` and `~/Code/pi-persist-toggle`;
   pi-extensions exists as `~/Code/pi-extensions` (**`bitnom/pi-extensions.git`**) and
   `~/Code/pi-extensions-apothic` (**`Apothic-AI/pi-extensions`**, the one
   `pi/settings.json` resolves `@PI_EXTENSIONS_APOTHIC@` to).
3. **Uncommitted work sits in four of the nine.** `unblock` (6 files, including a new
   `test/weekly-keep.test.js`), `pi-rooms` (2: `.pi/`, `AGENTS.md`), `pi-extensions-apothic`
   (untracked `.pi/`), `pi-cache-optimizer` (2). `git subrepo` will not take a dirty tree.
4. **Three of the nine are jj-managed** (`tooling/pi-pretty-tui`, `tooling/bizzy`,
   `tooling/unblock`). Cloning them into a git-only superproject is fine — subrepo records
   plain git refs — but any push from yellowstone lands on the same `apothic*` branch jj is
   working in, so those two worktrees must not be edited concurrently.
5. `yellowstone` itself is clean except `.pi/launch.env` (`PI_PROFILE=fleet` → `leader`).

## Decisions this inventory does not make

1. Which checkout is canonical for the two duplicated remotes, and whether the losers are
   deleted or left alone.
2. What to do about the five forks with no `apothic*` branch: create one from their current
   default branch, or track `master` / `main` / `linux-port` as-is. FT-01 says track a
   secondary merge branch; five forks do not have one to track.
3. Whether pinned upstream herdr plugins get subrepos too, or stay pinned refs. They are not
   forks, and a subrepo of an unmodified upstream is a clone with no delta to review.
4. What `home/` mirrors: only yellowstone-owned configs, or also the generated state under
   `~/.pi-profile-switch/instances/<id>/` that `install.sh` writes.
5. Whether `pi-pretty-tui`'s test branch is adopted (fix the manifest) or abandoned (fix the
   install).
