# bdi (beady-eye) shows no live agents — diagnosis, corrected by proof

**Asked**: 2026-11-01 by the overlord. Symptoms: (A) ~20 trees all reading "no live agent" while `synomone-leader` was working; (B) the pane at `wE:p1Z` (cwd `/home/bitnom/.overlord`) draws no trees at all.
**Status**: cause proven; the fix below is **proven on a throwaway tracker**, and the fix I first proposed was wrong — the proof is why.

## First, the part that is working as designed

**420 trees reading "no live agent" is the data design, not a broken join path.** bdi only draws work it can attribute to a live agent; a tree with no live agent is *hidden* by default and drawn with `a`/`--all`. An empty screen therefore means "no beads name a live agent", which is a fact about the data, not a failure of discovery, the tracker, or the pane list. Any future investigation should start from the tree's `reason: no-live-agent`, not from the collector.

Proof that collection is healthy: `bdi --all-projects --json` from `~/.overlord` reports `agents: herdr / default / answering`, `failed_projects: []`, `conflicts: []`, `unconfigured: []`, and **49 panes collected**, including `w1E:p1` (`synomone-leader`) correctly placed in project `synomone`. `trees: []`, `hidden_trees: 420`.

## Why nothing joins

`src/model/join.rs` accepts three keys. Two are unavailable for a pi fleet, one works.

1. **bead → agent session** (`join.agent_session_key`, default `agent_session`): dead for **every pi lane**, and not because of our data. `Pane::agent_session_id()` in `src/model/types.rs` returns a session only when `agent_session.kind == "id"`. herdr reports pi sessions with `kind: "path"` (a session-file path). So `live_agents` — the map the join looks the bead's session up in — is **empty for a pi fleet**, and a bead naming a session can never match. Verified empirically: a bead stamped with the live pane's exact session path still joined nothing.
2. **bead → pane** (`join.pane_key`, default `agent_pane`): **works.** No kind filter, and pane ids are not reused once herdr closes a pane.
3. **pane → bead** (`display_agent`): herdr 0.9.5 does not emit `display_agent` or `title` at all — the agent record carries `name` and `terminal_title` — and bdi declares both with `#[serde(default)]`, so they silently become `null` (all 49 panes). Even with the rename fixed, the matcher looks the string up **as a bead id**, so lane names like `synomone-leader` would still miss.

Our beads carry no metadata at all (`swarm-3fc.14`: `metadata: null`; 0 of 222 synomone beads; 0 in the bitnom tracker), so no bead names a pane in any direction.

## Why not `assignee` — measured, not assumed

The tidy-looking alternative is to join a bead's first-class `assignee` against the lane's herdr `name`, since both fields already exist and neither needs a stamp. It fails on coverage. Measured against the live fleet tracker on 2026-11-01: **222 beads, 5 with any assignee**, and the only values in the whole graph are `bitnom` (4) and `sibyl-adr` (1). A join on `assignee` would attribute **nothing** today, and a lane-named assignee would still be a convention someone has to keep — an unmaintained first-class field is no less brittle than unmaintained metadata, it is just harder to notice.

So the field is rejected on evidence rather than on taste: it is not that the rule is wrong in principle, it is that this fleet does not populate the field.

## Deployment decision (2026-11-01)

The `agent_pane` stamp is the deployment path. The overlord took the snippet, made it a script (`~/.overlord/tools/stamp-lane-pane.sh`) and wired it into the restart path, resolving the root bead by the `<lane> — ` convention and no-opping on every absence. The convention risk is therefore carried by the spawn path and by its owner: **a silently quiet bdi should be treated as a stamp failure before it is treated as an idle fleet.**

## Upstream proposals, and one correction to the durability argument

The two candidate upstream fixes are not equal, and only one survives contact with the suite. Prepared material: [`PR-beady-eye.md`](PR-beady-eye.md).

1. **`agent_session_id()` accepting `kind: "path"` — WITHDRAWN.** I called it a one-line gap. It is not: the change fails a deliberate upstream test, `a_session_of_another_kind_is_not_the_agent_session_a_bead_names`, whose docstring reads "a session of another kind is not the agent's id, so it never matches the one a bead names, even where the two read the same". Upstream intends a path-kind session to be inert as a join key. Reversing that is a behaviour change to a join rule and needs more than "our fleet uses paths"; the reviewable form would be opt-in (`[join] agent_session_kinds`, default `["id"]`) across five call sites, which buys this fleet nothing now that the pane stamp is adopted. Branch kept locally, not pushed.
2. **`name` → the pane's name, `terminal_title` → `title`** (`src/collect/herdr.rs`). A bug regardless of joining: herdr 0.9.5 renamed both fields and bdi's `#[serde(default)]` turned them into `null` on **all 49 panes**, so every lane name and caption is blank. Prepared on `fix/herdr-pane-fields`: the name lands in a new `Pane::name` (not `display_agent`, which keeps its meaning of "the pane's own bead claim"), and `title` falls back to `terminal_title`. `cargo test --lib` produces the **identical failure set to `main`** (42 pre-existing, all environment-dependent), no new failures.

**The durability claim needs one correction.** A session key does follow a lane across panes, but it does *not* survive a restart: the session file is new for every process, so a bead holding a session path goes stale at each restart. A pane id, by contrast, survives a restart in the same pane and changes only when the pane moves. Given that lanes restart often and move rarely, **the pane stamp is the more durable of the two for this fleet**, and the session key is the one that would need re-stamping most often — on top of the upstream decision above.

Stamp the lane's **pane id** into its root bead's metadata, under the default key `agent_pane`.

Throwaway proof (`/tmp/bdi-probe`, its own `bd init` tracker, a scratch pane `w1K:p1F` running pi in that directory, a probe config pointing only at it):

| State | `trees` | `hidden_trees` | join source |
|---|---|---|---|
| bead exists, **no** metadata | 0 | 1 (`no-live-agent`) | — |
| + `agent_session = <live session path>` | 0 | 1 | **none — the kind filter rejects pi sessions** |
| + `agent_pane = w1K:p1F` | **1** | 0 | **`agent_pane`** |

The probe tracker, pane and config were removed afterwards. Nothing was written to a live tracker.

### Spawn-path snippet

Idempotent, and a no-op when the lane has no root bead. Stamp **after** the agent is detected, so the pane id is settled.

```bash
# stamp-bead-pane <lane> — attribute the lane's root bead to its pane for bdi
stamp-bead-pane() {
  lane="$1"
  pane="$(herdr agent get "$lane" 2>/dev/null | jq -r '.result.agent.pane_id // empty')"
  [ -n "$pane" ] || return 0
  bead="$(bd -C /home/bitnom list --all --json 2>/dev/null \
    | jq -r --arg l "$lane" '.[] | select(.status != "closed")
        | select(.title | startswith($l + " —")) | .id' | head -1)"
  [ -n "$bead" ] || return 0
  bd -C /home/bitnom update "$bead" --set-metadata "agent_pane=$pane" >/dev/null
}
```

**Durability**: the stamp survives a process restart in the same pane, so a normal lane restart needs nothing. It must be re-run when the **pane id changes** — a pane moved to another workspace gets a new workspace-qualified id — so wiring it into the spawn path is the right home and running it twice is harmless.

**Failure mode, stated**: the snippet finds the bead by the `<lane> — <title>` convention. If that convention changes, the stamp silently no-ops and bdi goes back to hiding the lane's trees. It cannot misattribute: a closed pane's id is never reused, so a stale stamp stops joining rather than naming another lane.

**Do not stamp `agent_session`.** It is inert for pi lanes until bdi accepts `kind: "path"` — that is a one-line upstream change in `agent_session_id()`, worth reporting to CodeForBreakfast, and it would make the session-following join work fleet-wide. Until then it is noise in the bead metadata.

## Not done, deliberately

- **No plugin patch or rebuild.** The `name`→`display_agent` / `terminal_title`→`title` mapping is a real bug worth fixing upstream (the blank lane names), but it creates no join. The name-based join rule is a product decision, not mine to invent inside a third-party plugin. Rust rebuild goes through the remote build server, and the liveness view does not depend on it.
- **No writes to live trackers.** The stamp belongs in the spawn path, where it stays true.

## What the pane needs right now

`--all-projects` (or a launch cwd inside a project) so it draws the whole graph rather than only the `overlord` project's hidden trees. That fixes the empty screen; attribution needs the stamp.

Cheapest monitor that cannot be blinded this way: `tools/leader-board.py` or `swarm-topology`, both of which join herdr by pane.