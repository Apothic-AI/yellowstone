# Mode presets — stacking several modes in one selection

A **mode preset** is a named, saved mode *selection*: one base mode plus an ordered list of overlay
modes, applied as a single unit. It is the answer to "I always want `plan` and `review` on top of
`focused-builder` — I should not have to name four things every time."

This is a capability of `@tryinget/pi-modes` (the `pi-modes` extension). It is **not** a second kind
of mode: a preset carries **no prompt text at all**. It only stores keys and their order.

## The two layers, side by side

| | mode | mode preset |
|---|---|---|
| path | `.pi/modes/<key>.json` | `.pi/mode-presets/<key>.json` |
| holds | `promptStrategy` (`replace_base` / `append`) and the `systemPrompt` text | `selection: {baseKey, overlayKeys}` only |
| changes the prompt | yes, that is its whole function | no — it selects modes that do |
| recorded as | a fingerprinted definition (drift-gated) | an activation with `source: "preset"` |

## Where presets are discovered

`pi-modes` uses the same direction as `AGENTS.md`:

```text
~/.pi/agent/mode-presets/*.json          global
<filesystem-root>/.pi/mode-presets/*.json   … ancestor layers, root → cwd
<cwd>/.pi/mode-presets/*.json            project; deeper keys override shallower
```

Untrusted projects contribute no ancestor definitions or presets. Inherited presets are selectable but
read-only from descendants; authoring writes only to the cwd unless `--project` says otherwise.
Symlink boundaries, path traversal, oversized files and malformed JSON fail closed per file.

## Schema (exactly this, unknown fields rejected)

```json
{
  "schemaVersion": 1,
  "key": "deep-review",
  "label": "Deep Review",
  "description": "optional",
  "selection": { "baseKey": "focused-builder", "overlayKeys": ["plan", "review"] }
}
```

`overlayKeys` is ordered — overlays append to the prompt in that order — and is capped at **64**
(`MODE_SELECTION_MAX_OVERLAYS`). `baseKey` may be `null` for an overlay-only composition.

## Commands

| command | effect |
|---|---|
| `/mode presets` | list the presets visible from this cwd |
| `/mode use <key>` | apply a preset's selection; accepts `--confirm-exact`, `--confirm-project` |
| `/mode save [--project] <key>` | capture the **currently active** selection as a preset |
| `/mode export <key>` | emit a portable encoding |
| `/mode import [--project] <key> [--data <base64url>]` | load one back |

Applying a preset resolves the current trusted definitions and validates the **complete** composition
before writing a single state entry, so a preset that no longer resolves cleanly is refused rather than
half-applied. Activation is recorded in `pi-mode-state.v3` with `source: "preset"`, and the composed
definition is fingerprinted like any other selection — so `driftPolicy` still governs the *modes*, and a
preset is not a way to bypass an approval.

## What a preset deliberately cannot do

It stores keys and overlay order — not prompt text, authority, objectives, tools, or drift bypasses.
If you want new instructions, that is a mode (`/mode-new`, `/mode-edit`) or an `AGENTS.md` line; a
preset can only choose among what already exists.

## The three that used to be here (removed 2026-11-14)

`~/.pi/agent/mode-presets/` contained `deep-review.json` (Deep Review: `native` + `plan`, `review`),
`overlord.json` (Overlord: `native` + `plan`, `explain`) and `planning.json` (Planning: `native` +
`plan`). They were test residue, not fleet config: absent from the repo mirror
(`yellowstone/home/.pi/agent/` carries `modes/` but no `mode-presets/`), not created by `install.sh`, all
timestamped `2026-10-31 21:52` alongside an FT-47 loader test's fixtures, and **no session in the
fleet's session store had ever recorded a preset activation**. Removed on the operator's instruction:
3 global files plus 105 per-instance copies, backed up at
`~/.local/state/mode-presets-removed-20261114T2255Z/` (restore is a `mv` back into
`~/.pi/agent/mode-presets/`). Presets carry no fingerprint, so removing them cannot drift a lane; the
instance copies would have vanished at each lane's next relaunch anyway.

Recreating any of them is one command once the modes it names exist: select base plus overlays, then
`/mode save planning` (add `--project` to write into the cwd instead of the global directory).

**The naming trap is worth keeping.** `overlord.json` was a **preset** selecting a native base with two
overlays — nothing to do with the overlord space, whose contract is a **mode** file
(`~/.overlord/.pi/modes/leader.json`, `key: leader`, `promptStrategy: append`). A file's name does not
tell you which layer it belongs to — `key` and `promptStrategy` inside it do, and the footer reports the
resolved base key (`mode:leader`). That confusion is why this document exists.

## Source of truth

The package documents the feature under `## Named composition presets` and `## Discovery` in
`src/pi-extensions/pi-modes/README.md` (yellowstone tree, subrepo `Apothic-AI/pi-modes` at `main`).
That section states the same constraint in one line: presets "store only keys and overlay order—not
prompt text, authority, objectives, tools, or drift bypasses".

**Subrepo caveat before editing it:** `src/pi-extensions/pi-modes` is carried as a flattened subrepo. A
local edit to its README becomes a parent-tree commit that no longer matches the recorded upstream
commit, which is the same divergence that blocked a `git subrepo pull` for `fleet-skills`. Upstream the
expanded text through the subrepo flow, or keep fleet-facing notes here.
