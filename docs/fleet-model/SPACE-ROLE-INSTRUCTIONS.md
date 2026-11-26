# Role-scoped instructions: leader-only text in a shared space

**Question.** Can a space give **role-specific** instructions — rules that reach the leader lane in that space but not the non-leader lanes running in the same cwd?

**Answer: yes, natively, with no fork.** `pi-modes` discovers mode files along the **cwd ancestor chain**, and a mode can be an **overlay appended to a base mode**. The file is therefore space-scoped and the selection is spawn-scoped, and the intersection is exactly space × role.

Verified 2026-11-01T16:10–16:12Z on throwaway sessions in a scratch cwd. Evidence: [`evidence/modes-proof.txt`](evidence/modes-proof.txt).

## The mechanism

Three facts from the code, not the docs:

1. **Project mode roots exist.** `ancestorModeDirectories(cwd)` (`pi-modes/src/mode-definitions.ts:251`) walks filesystem root → cwd collecting `<dir>/.pi/modes`, with deeper keys overriding shallower ones. Modes are therefore not agent-dir-only: a space can ship its own.
2. **Modes compose.** `PI_MODES` takes a JSON contract — `{"baseKey": "...", "overlayKeys": [...]}` — and *takes precedence over* `PI_MODE` when set (`pi-modes/src/modes.ts:57`). An overlay declares `promptStrategy: "append"`; `before`/`after` ordering is valid only for append overlays.
3. **Selection is spawn-keyed, discovery is cwd-keyed.** A worker in the same directory sees the file, but never selects it.

So the leader-only text lives in `<space>/.pi/modes/<key>.json` and reaches the model only in a process that was launched with the overlay in `PI_MODES`. Nothing else in that cwd receives it.

## Hard rules for a space mode file

These are not style preferences. Discovery walks filesystem root → cwd and **a deeper key wins** (`mode-definitions.ts:251`), so a space file that reuses a global key silently replaces the fleet contract for every lane in that directory — no error line, no warning, nothing in the transcript except a contract that is shorter than it should be. Same silent-total-loss shape as the trust failure, arriving by a different road.

1. **Distinct key only.** A space mode key that collides with a global mode key (`leader`, `worker`, or any built-in) is a **defect**, not a style choice. Space keys carry the space: `assistant-leader`, never `leader`.
2. **`promptStrategy: "append"` on the overlay**, and `baseKey` is always the **global** mode being extended. A space file never appears as a `baseKey`.
3. **The deployment check is two counts, not one.** The delta **and** the base contract must both appear in that lane's transcript. Delta alone means an override crept in; base alone means the overlay did not load; neither means the composition was rejected. One count is not evidence.
4. **Deliberate replacement is documented, never implicit.** If a space ever should replace a fleet mode, it is written up here as an anti-pattern with the failure it causes, not left as an undocumented capability someone discovers by accident.

State at 2026-11-01: exactly **one** space mode file fleet-wide — the Assistant overlay, key `assistant-leader`, `promptStrategy: append`, selected as an `overlayKeys` entry with `baseKey: leader`. Its lane's transcript shows delta 1 **and** leader contract 1, so the composition is additive in practice and not merely in intent.

## Preconditions — and the production failure they explain

**The mechanism is sound; my first proof was incomplete, and it shipped a broken launch.** The scratch-cwd proof ran `pi` directly, so it never exercised the launcher. Every fleet lane runs `pil`, and the launcher's generated instance settings carry **`"defaultProjectTrust": "never"`**. Pi also does not auto-trust a project whose `.pi` holds anything besides `modes/` — and this space has `.pi/skills`. Result: the project's mode definitions are never discovered, so at 2026-11-01T16:2xZ the composed launch fell back and the lane ran with **no role contract at all**, with all three environment variables correctly set.

Two gates, both required:

1. **Project trust** — add the space's directory to `~/.pi/agent/trust.json` (a saved decision outranks the launcher's `never`). Without it, the mode file does not exist as far as pi is concerned and the failure text is `Startup composition is invalid: <key>: overlay mode is unavailable and was omitted`.
2. **Definition confirmation** — `PI_MODE_CONFIRM_PROJECT=1` at launch, or a recorded approval. Without it the failure text is `Startup project mode(s) not confirmed: <key> …`.

Discovery in a directory that holds only `.pi/modes` needs gate 1 too once `.pi/skills` or any other protected resource appears there — that is exactly the trap that broke the first deployment.

Both gates fail **the same dangerous way**: the whole composition is rejected and the native base prompt is used, so the base `leader` contract is lost as well as the delta. It is all-or-nothing, never "delta missing, role intact". Treat the composed launch as unverified until its own transcript shows the delta, and keep anything dangerous-to-lose in `AGENTS.md`.

## Configuring the Assistant space

**0. Trust the space** — `/home/bitnom/Documents/Assistant` → `true` in `~/.pi/agent/trust.json` (applied 2026-11-01T16:26Z; it is what made the difference).

**1. The overlay** — `~/Documents/Assistant/.pi/modes/assistant-leader.json`. It carries *only* the leader delta; the ~1.5k leader contract is inherited from the base, so nothing is duplicated and nothing can drift:

```json
{
  "schemaVersion": 2,
  "key": "assistant-leader",
  "label": "Assistant space leader delta",
  "description": "Leader-only rules for the Assistant space, appended over the base leader contract.",
  "promptStrategy": "append",
  "systemPrompt": "<leader-only text — the part a worker in this space must not receive>"
}
```

**2. The launch** — the leader lane of that space:

```bash
PI_MODES='{"baseKey":"leader","overlayKeys":["assistant-leader"]}' \
PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1 pil
```

Workers keep the ordinary form and get neither the leader contract nor the delta:

```bash
PI_MODE=worker PI_PROFILE=worker pil
```

**3. What stays in `AGENTS.md`.** It is cwd-keyed, so it binds every lane there. Keep only what is true for all of them (workspace facts, shared conventions, outbound boundaries that should bind a worker too). Role-only prose moves into the overlay. The file's launch line, which currently names `PI_MODE=leader pil`, becomes:

> `~/AGENTS.md` is role-neutral and applies here. This file is what every lane in this directory reads, so it holds only what is true for all of them; role-only rules live in `.pi/modes/<role>.json`. The leader lane is launched with `PI_MODES='{"baseKey":"leader","overlayKeys":["assistant-leader"]}' PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1 pil`, which composes the leader contract with this space's leader-only delta.

## Verification

**Acceptance test in the testbed (`~/Documents/Assistant`), launched through `pil`, not `pi`** — the run that counts:

| # | Launch (same cwd, real launcher) | Delta | Leader contract | Worker contract |
|---|---|---|---|---|
| A | `PI_MODES={"baseKey":"leader","overlayKeys":["assistant-leader"]}` + `PI_MODE_CONFIRM_PROJECT=1` + trusted | **1** | **1** | 0 |
| B | `PI_MODE=worker PI_PROFILE=worker` | **0** | **0** | **1** |
| C | A without the confirmation flag | 0 | **0** | 0 |

A is the deployment; B is the isolation the mechanism exists for; C is the failure mode — note `leader_contract=0`, which is why the boundaries stay in `AGENTS.md`.

Earlier scratch-cwd runs, for the record — these proved the mechanism but not the launcher path, and that gap is what broke production:

| # | Selection (scratch cwd, plain `pi`) | Marker | Leader contract | Worker contract |
|---|---|---|---|---|
| A | `PI_MODES={"baseKey":"leader","overlayKeys":["probe-leader"]}` + confirm | **1** | **1** | 0 |
| B | `PI_MODE=worker PI_PROFILE=worker` | **0** | 0 | **1** |
| C | `PI_MODE=probe-preset` (project preset) | 0 | 0 | 0 |
| D | overlay selected, **no** confirmation | 0 | 0 | 0 |

A proves composition: the base leader contract **and** the space delta both reached the model. B proves isolation: a worker in the same directory got neither. C and D are the two traps below.

## What to avoid

- **The trust gate is the one that bit in production, and it fails silently-but-for-one-line.** A space with `.pi/skills` is untrusted by default, and the fleet launcher sets `defaultProjectTrust: "never"`, so the composed launch loses the entire role contract. Expect `Startup composition is invalid: … overlay mode is unavailable` on stderr; a lane that scrolled past it is role-less. Trust the space in `trust.json`, then re-verify by transcript.
- **An unconfirmed project mode does not merely drop the delta — it drops the whole composition.** D fell back to the native base prompt, so the lane lost the leader contract too, with only a stderr line (`Startup project mode(s) not confirmed …`). Launch with `PI_MODE_CONFIRM_PROJECT=1`, or confirm once in the TUI; an interactive lane may scroll that warning past and run role-less.
- **`PI_MODE` cannot name a preset.** C produced `PI_MODE names an unavailable mode: probe-preset; using native SYSTEM.md/host base`. Presets (`<space>/.pi/mode-presets/`) are selector-only; from an environment launch the composition contract is `PI_MODES`.
- **`PI_MODE_CONFIRM_PROJECT=1` records nothing**, so every launch re-accepts whatever the file says. Fine for the operator's own space; if the mode file could change by any other hand, record one approval instead (`~/.pi/agent/mode-approvals.json`) so drift requires re-consent.
- **Do not put role prose in `AGENTS.md` "temporarily".** It is the one surface every lane in the cwd reads; that is the whole problem this solves.
- The mode file must not be a symlink and must be named `<key>.json`; the loader fails closed per file.

## Restart, and what it costs

- **Selecting the overlay needs a restart of that one lane** — `PI_MODES` is read at launch. Only the Assistant leader lane, not the space's workers, not other spaces.
- **Editing the delta later needs no restart.** Mode definitions are re-read per turn; the edit takes effect on the next turn, but a changed definition needs re-confirmation (`/mode-reapprove`) before it composes again.
- No fleet-wide rollout: nothing global changes, and every other lane's launch is untouched.

## Alternatives, rejected on evidence

| Candidate | Verdict |
|---|---|
| Per-project mode discovery (mechanism 1) | **Exists and is the answer** — it supplies the space half of the intersection |
| Mode composition (mechanism 2) | **Exists and is the answer** — `baseKey` + `overlayKeys` with `append`; no duplicated contract to drift |
| Role-conditioned `pi-subdir-agents` | No variant file: discovery is hardcoded to `AGENTS.md` (`src/core/subdir/agents-chain.ts:15`) |
| Role-conditioned `pi-persist` items | No per-item predicate: `mode` is only used to label the message envelope; items are cwd-keyed |
| One mode key per space+role (`PI_MODE=assistant-leader`) | **Unnecessary** — it would duplicate the leader contract per space and drift. It is also the weaker form: it cannot compose, only replace |

Reproduce: create the scratch cwd with `.pi/modes/probe-leader.json`, run the two `pi -p --session-dir …` sessions in it, and grep the transcripts for the marker. `/proc` proves a selection was made; only the transcript proves the text reached the model.