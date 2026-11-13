# Validation record

How the one OpenSpec gate that was blocked at stage 0 (`tasks.md` 1.4) was cleared, and what the
`/opsx-verify` procedure returned when it was run against the CLI's own artifact map.

Recorded 2026-11-12, in the S3 verification stage. Nothing here was installed, fetched, published or
deployed; no package was added to the project; no file outside this change was written.

## 1. The blocker, and why it was environmental

At stage 0 the `openspec` CLI was absent from this machine (`command -v openspec` → exit 1,
`openspec --version` → exit 127, command not found), and installing it was outside that stage's
authorization. The blocker was recorded rather than bypassed, and tasks 1.4 and the stage-0
readiness line stayed open on purpose.

The CLI is in fact present on this machine, in the pre-existing npx cache. The gate was therefore
run against a **pinned** copy of it, offline.

## 2. The pinned CLI

| What | Value |
|---|---|
| Path | `~/.npm/_npx/20f2b75ddc8bce88/node_modules/.bin/openspec` |
| Version | `1.5.0` (`openspec --version`) |
| Upstream artifact | `https://registry.npmjs.org/@fission-ai/openspec/-/openspec-1.5.0.tgz` |
| Tarball integrity | `sha512-SLZkyF51gFYkISufZKaka0X04z4y/WCjPOcCB+EC7tALd0TC+7V76BOIzWOSIOhdhBWwh5EMIBhrgLnugIh1DA==` (from the npx install lock) |
| Installed package manifest | `sha256:1567891abb2352df2f025d26020d35d8d38a30d0d0523cbfe8833d792353c699` over 342 package files (each file's own sha256, sorted by path) |
| Network | none. Every run sets `OPENSPEC_TELEMETRY=0` and `DO_NOT_TRACK=1`, which is the CLI's documented telemetry opt-out |

The tarball itself is no longer in the npm content cache, so the CLI cannot be re-materialized from
the registry copy offline. The installed package directory is therefore pinned by the two hashes
above: the upstream artifact identity and the file-by-file manifest of what is installed.

## 3. The gate on the real tree

Run in `src/pi-extensions/pi-profile-switch`, the directory that owns `openspec/`:

```bash
openspec validate 2026-11-11-project-profile-append-composition --strict --type change
# → Change '2026-11-11-project-profile-append-composition' is valid   (exit 0)

openspec validate --all --strict
# → ✓ change/2026-11-11-project-profile-append-composition
#   ✓ spec/in-session-switch  ✓ spec/launcher  ✓ spec/profile-catalog  ✓ spec/resource-reference
#   Totals: 5 passed, 0 failed (5 items)                             (exit 0)

openspec list --json
# → {"name": "2026-11-11-project-profile-append-composition", "completedTasks": 21, "totalTasks": 23}
```

## 4. The date-prefix limitation, and how the two `/opsx-verify` CLI steps were run

OpenSpec 1.5.0 validates a change name against `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`
(`dist/utils/change-utils.js`, `validateChangeName`) before `status` and `instructions apply`
resolve it. The rule is a hardcoded regular expression with no configuration escape, so a
date-prefixed change such as this one cannot be addressed by those two commands:

```bash
openspec status --change 2026-11-11-project-profile-append-composition --json
# → {"status":[{"severity":"error","code":"change_error",
#              "message":"Invalid change name '2026-11-11-project-profile-append-composition': Change name must start with a letter"}]}
#   (exit 1)
```

`list` and `validate` do not call that validator, which is why the gate in §3 runs against the real
name while these two commands do not.

The same artifacts were therefore addressed under a temporary letter-prefixed alias in a scratch
copy of `openspec/` made outside the repository. The alias keeps the original name visible:
`d2026-11-11-project-profile-append-composition`.

```bash
SCRATCH="$(mktemp -d /tmp/ft54-opsx-verify-XXXXXX)"
cp -a openspec "$SCRATCH/openspec"
mv "$SCRATCH/openspec/changes/2026-11-11-project-profile-append-composition" \
   "$SCRATCH/openspec/changes/d2026-11-11-project-profile-append-composition"
cd "$SCRATCH"
openspec status --change d2026-11-11-project-profile-append-composition --json          # exit 0
openspec instructions apply --change d2026-11-11-project-profile-append-composition --json  # exit 0
rm -rf "$SCRATCH"
```

The full script, including the byte-identity proof and the cleanup, is kept with the stage's logs
at `~/.local/state/ft54-s3/logs/opsx-alias-verify.sh` and `opsx-alias-verify.log`.

**The source names are preserved.** The repository's change directory keeps its name, is never
renamed, moved or written, and the artifacts' own text still names it. The copy is proven to be the
same content: `diff -r` between the source change directory and the scratch copy reports no
difference, and all 12 file hashes match. A copy that differed in any file would not be evidence and
would be discarded rather than reported.

What the two commands returned:

* `status` — `schemaName: spec-driven`, `planningHome.kind: repo`, `actionContext.mode: repo-local`,
  `isComplete: true`, `applyRequires: ["tasks"]`, and the artifact map
  `proposal`, `specs` (three deltas), `design`, `tasks`, all `status: done`.
* `instructions apply` — `contextFiles` for the same four artifacts, `progress: {total: 23, complete: 21,
  remaining: 2}`, `state: ready`, and the per-task completion flags. The two remaining tasks are 5.1
  and 5.2, both in the stage the change declares as release scope owned outside it.

## 5. `/opsx-verify` result

Run against the artifact map the CLI returned, not against a hand-built file list.

| Dimension | Status |
|---|---|
| Completeness | Stages 0–S3: **21 of 23** tasks ticked; the two unticked tasks (5.1, 5.2) are the stage the change declares out of scope. Stage 0's only blocker, task 1.4, is now closed by §3 |
| Correctness | 10 requirements and 62 scenarios across the three capability deltas; every scenario has a covering test, and the 16 tests added in stage S3 remain green |
| Coherence | No contradiction between the design, the implementation and the specs; the design's export surface is what the code exposes |

The gates on the final tree:

| Gate | Result |
|---|---|
| `npm run check` | exit 0 |
| `npm test` | 53 files, 984 tests passed, exit 0 (52 files / 982 tests before this stage; the new file is `test/openspec-change-tasks.test.ts`) |
| `openspec validate <change> --strict --type change` | exit 0, "is valid" |
| `openspec validate --all --strict` | 5 passed, 0 failed, exit 0 |
| `openspec status --change <alias> --json` (scratch copy) | exit 0 |
| `openspec instructions apply --change <alias> --json` (scratch copy) | exit 0 |

**Issues by priority**

* CRITICAL: none.
* WARNING: none.
* SUGGESTION: the change's date-prefixed name is outside the name rule of OpenSpec 1.5.0, so
  `status` and `instructions apply` need the alias procedure of §4 until the project's validation CLI
  accepts the name. The name is the change's identity and renaming it is not this change's call.

**Final assessment.** All four gates of task 4.4 exit successfully on the final tree, and
`/opsx-verify` is completed against the CLI's own artifact map. The change is ready to be
suggested for archive. Stage S4 (the release note and the consumer-conversion obligation) stays open
and is release scope owned outside this change; archiving it is a separate decision.

## 6. The guard added for the failure this stage found

`test/openspec-change-tasks.test.ts` reads the active change's `tasks.md` and fails when a task in an
in-scope section is unticked, and when a task carries no `Verification:` clause. The stale-progress
failure it guards is real: stage S2 was implemented and accepted while its four boxes stayed empty,
so the record read "15 of 19". Both failure paths were exercised — unticking task 1.4 fails the
first check, removing the `Verification:` clause fails the second.
