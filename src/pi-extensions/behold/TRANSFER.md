# Transfer plan — from this staging tree to the behold repo (READY, not executed)

**V2 note.** The transfer tree is unchanged in shape; the behaviour it carries changed: no
file output, externals opt-in (`--git`/`--jj`/`--herdr`), exact child argv, held lanes
emitting nothing, untrusted disagreements, and instance provenance from the verified
process only. Step 2 below must run the suite (178 tests, as measured on this tree) in the
scratch copy with **no** host `git`/`jj`/`herdr` on PATH and no network, which is the
hermetic proof.

This file is a **plan**. Nothing in it has been run. It requires its own authorization
(see the source decision, binding correction #8, and the plan §10). It exists so the
transfer is a mechanical, reviewable operation rather than an improvisation.

**Rename note (FT-21 → Behold).** This plan was written for the product's former name and
was mechanically renamed to `behold` when the staging tree moved to `staging/ft21/behold/`.
Every *path* in it now names the Behold target. The **shape observations** it records were
taken against the pre-rename target directory, which no longer exists; they do not carry
over to `~/Code/behold` and must be re-observed and re-recorded at preflight time. Nothing
in this plan was executed before or after the rename.

## What is authoritative now

- Authoritative copy of the CLI: `staging/ft21/behold/` **on branch
  `ft21/integrate-058f6575`** in the FT-21 integration worktree.
- Intended owner: `~/Code/behold` — **not verified by this file**. The shape this plan was
  written against (a git repo on an unborn `master`, zero commits, two empty reserved
  directories) was observed on the *pre-rename* target directory, which no longer exists.
  The shape of `~/Code/behold` must be re-observed and re-recorded at preflight time.
- **No `git init` in `~/Code/behold`**, no force-push, no touching the two reserved empty
  directories from outside the repo. A linked worktree cannot be created from an unborn
  branch, which is why the first commit needs its own one-shot operation.

## Exact durable transfer tree

The whole directory transfers as the behold repo root, one-to-one:

```
staging/ft21/behold/           ->  ~/Code/behold/
├── README.md                  ->  README.md
├── FIELD-LEDGER.md            ->  FIELD-LEDGER.md
├── bin/behold                 ->  bin/behold           (executable)
├── behold/**                  ->  behold/**            (12 modules, no data files)
├── fixtures/make_fixtures.py  ->  fixtures/make_fixtures.py
└── tests/**                   ->  tests/**             (6 suites + helpers)
```

Explicitly **not** transferred: `__pycache__/`, any generated fixture root, any `.jsonl`
session copy, any receipt, and this `TRANSFER.md` (it is a Yellowstone-side planning
artifact; the behold repo gets `README.md` + `FIELD-LEDGER.md`).

The reserved `herdr-behold/` and `pi-behold/` directories stay empty until P3 is approved.

## Ownership facts: observed vs intended (do not call them verified)

| Claim | Status |
|---|---|
| `~/Code/behold` is a git repo with an unborn `master` | **Observed** at planning time by the planning lane — but on the *pre-rename* target directory, not on `~/Code/behold` (`rev-list --all --count` = 0, two empty dirs). Not re-checked by this lane, which never touched the path. Any later step must re-observe `~/Code/behold` and record the read. |
| behold is the intended owner of the CLI | **Intended** (operator decision), not observed by this lane. |
| this tree is a faithful copy candidate | **Observed**: it is the committed tree at the candidate SHA, reproduced by the test suite. |

"Verified" is reserved for bytes this repository can hash. Anything about `~/Code/behold`
is inherited evidence, and the transfer record must say so.

## Exact manifest, not a recursive add

The transfer is defined by a **manifest** committed alongside this file:
`MANIFEST.sha256` — one `sha256  path  mode` line per file, generated from the candidate
tree with `find … -type f` over the four transfer roots. No recursive staging command of any
kind is used: every path is staged by name.
A receiving operation must:

1. verify every manifest line against the source tree and abort on any mismatch. The manifest
   is `sha256  path  mode`; `sha256sum` needs the digest/path columns only, so the exact
   verification command is
   `awk '{print $1"  "$2}' MANIFEST.sha256 | sha256sum -c -`
   (a plain `sha256sum -c MANIFEST.sha256` fails, because the third column is not a filename —
   that was a documentation defect in the V3 plan and is corrected here);
2. create each target file **only** if it does not already exist (no clobber), recording
   `preexisting` for any path that did exist and leaving its bytes untouched;
3. leave `herdr-behold/`, `pi-behold/` and every pre-existing untracked file exactly as found;
4. stage **only** the paths in the manifest by name (`git add -- <path> …`), never `-A`;
5. quarantine anything unexpected into a separate, named directory rather than staging it.

## Ordered steps (each with a receipt)

1. **Preflight (read-only, re-observed).**
   ```
   git -C ~/Code/behold rev-list --all --count            # expect 0
   git -C ~/Code/behold status --porcelain                # expect empty
   git -C ~/Code/behold rev-parse --abbrev-ref HEAD       # expect master
   find ~/Code/behold -maxdepth 1 -not -path '*/.git*'    # expect herdr-behold/, pi-behold/
   awk '{print $1"  "$2}' MANIFEST.sha256 | sha256sum -c -   # in the candidate tree
   ```
2. **Stage outside the repo.** Copy the manifest-listed files into
   `~/.local/state/ft21-bootstrap/behold/`, run `tests/run-tests.sh` there (hermetic: no
   network, no host git/jj/herdr needed for the suite itself), capture the output.
3. **One-shot bootstrap commit** — a single, separately authorized operation that stages the
   manifest paths by name, commits once, and touches nothing else. No merge, no force.
4. **Post-commit receipts**, including the ref transition as a compare-and-swap:
   ```
   git -C ~/Code/behold rev-list --all --count                 # expect 1
   git -C ~/Code/behold rev-parse HEAD
   git -C ~/Code/behold rev-parse --abbrev-ref HEAD            # master
   git -C ~/Code/behold status --porcelain                     # empty
   git -C ~/Code/behold log --oneline --decorate -n 1
   git -C ~/Code/behold ls-tree -r --name-only HEAD | sha256sum   # compare with the manifest
   ls -la ~/Code/behold/herdr-behold ~/Code/behold/pi-behold      # both still empty
   ```
   The ref must be advanced with an expected-old-value compare-and-swap
   (`git update-ref refs/heads/master <new> <old>` where `<old>` is the empty tree's
   absence), so a concurrent writer aborts the operation instead of being overwritten.
5. **From commit #1 onward**, normal behold work uses
   `~/Code/behold-wt/<issue>-<base8>` on branch `<issue>/<base8>`.

## Rollback

Rollback is a **reviewed, separately authorized** ref CAS back to unborn
(`git update-ref -d refs/heads/master <expected-current>` supplied explicitly, never blindly)
plus removing only the manifest-listed paths that this operation created. It is not part of
the bootstrap and is not run automatically. Nothing in the fleet references the CLI, so a
rollback has no runtime effect.

## What stays in Yellowstone, later, under its own gate

Only the P4 agent-facing residual, and only *after* the CLI is shipped:

- one `behold-roster` skill in the existing fleet-skills repo (`kind = repo` in
  `skills/skills.tsv`), documenting the shipped command and its unknown/stale vocabulary
  with **no static roster**;
- one row in the `## Skills — everything procedural` table of `home/AGENTS.md`;
- propagation via the operator's normal `reload-fleet --dry-run` decision.

This tranche makes **no** edit to `home/AGENTS.md`, `skills/skills.tsv`, any live
`~/.agents/skills/`, install script, mode/profile config, or extension directory.
