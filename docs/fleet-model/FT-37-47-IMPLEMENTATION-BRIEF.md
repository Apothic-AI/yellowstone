# FT-37/47 implementation brief

Owner: self-improvement-leader. Durable issue: `swarm-c0l.8` (`project:w1K`).

## Current operator requirements

1. Resolve FT-37 now; FT-47 is related but must not delay the reasoning fix.
2. Detection/parsing must be automatic from content, regardless of selected provider/model. No provider/model allowlist. API-specific serialization is fine; provider names are not an activation gate.
3. This is a durable reasoning/replay issue, NOT just TUI cosmetics. Recovered reasoning must be stored distinctly and sent in the appropriate reasoning structure on follow-up requests when the API supports it.
4. Never fabricate opaque provider-issued signatures or encrypted reasoning. On the same API/provider/model, prove recovered reasoning is not accidentally omitted by the fix where the adapter supports replay. Where authentic signed replay cannot be recovered, explicitly document the limitation and use only native supported behavior.
5. Preserve native thinking, signed text, and native tool calls. Never execute tool-call prose, with or without a native call already present.
6. **Do not change Pi's model-switch policy.** `transformMessages` deliberately drops native thinking when provider/API/model differs. Recovery must follow that existing policy, not inject reasoning as user/system/answer text to circumvent it. Provider/model-independent detection is NOT a request for universal cross-model reasoning transfer. The leader's earlier unconditional no-loss wording was overbroad and is superseded by this clause.

## Existing work; do not re-mine or re-litigate

Read `FT-37-47-EVIDENCE.md` and `FT-37-47-MECHANISM.md` in this directory. The prior provider-scoped recommendation is explicitly superseded by requirement 2. Pi maps structured upstream fields to thinking blocks, while tags in `delta.content` stay text. The 45 mixed groups have both native thinking and leaked text; do NOT skip a message merely because it has native thinking.

## Repo and boundaries

Canonical development: `/home/bitnom/Code/yellowstone/src/pi-extensions/pi-fleet-hooks` (git-subrepo). Root `AGENTS.md` applies; this subrepo currently has no own `AGENTS.md` (checked). Never add Fleet scaffolding to `src/`. No jj anywhere in this monorepo. Do not alter `pi-pretty-tui` or installed Pi source. Do not change other components, services, packages, launch plans, secrets, or active instances.

Implementation worker: create an isolated git worktree/branch from the current Yellowstone HEAD after checking space and worktree registrations. Modify ONLY `src/pi-extensions/pi-fleet-hooks/`. Do not push, install live, reload live lanes, or make paid provider calls. Do not update deps merely to test. Leader integrates after review and owns rollout.

## Reading gate

Before code changes, read the installed Pi docs relevant to extensions in full and the relevant examples, following cross-references. Root: `/home/bitnom/.local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent/` (`docs/extensions.md`, relevant message lifecycle/markdown/custom-provider/type docs and examples). `pi-ai` lives under that package's `node_modules/@earendil-works/pi-ai`, NOT as a sibling global package. Verify the actual API signatures instead of copying report pseudocode.

## Worker A: implementation

Deliver a small separately registered `pi-fleet-hooks` extension plus focused tests and docs. Prefer `message_end` durable rewrite with a shared conservative parser and appropriate replay handling; choose a better supported seam if proof shows that inadequate. Do not conflate a ThinkingContent block with a guaranteed outbound reasoning payload. Prove the actual serializer output using installed Pi adapters without a network/model request.

Critical known hazards to address:
- Chat Completions replay only serializes reasoning when the first nonempty thinking block has a recognized field signature (`reasoning`, `reasoning_content`, `reasoning_text`), or structured reasoning_details. An unsigned new block can disappear. Field-name signatures are not cryptographic signatures.
- Native reasoning_details plus additional recovered thinking can silently omit recovered text. Cover it.
- Anthropic can downgrade unsigned thinking to text; Google only preserves thoughts for same provider/model; Responses expects a provider-issued JSON reasoning item and can omit unsigned blocks. Never fabricate such items.
- Cross-model/provider transitions intentionally drop native thinking before serialization. Test that recovery follows the same policy; do not add plaintext/user/system fallbacks that defeat it. Only accidental additional loss on supported same-model replay is a defect to fix here.
- Quoted/inline/fenced examples of tags are ordinary text, including this issue's own discussion. Incomplete, malformed, nested or ambiguous tags must not swallow visible answer text. Keep ordering and idempotence.
- Error/aborted messages and signed text must remain safe.
- Live stream transform must not corrupt native thinking (`assistant-thinking`), hide normal answers, or pretend a post-hoc fix reclassifies from first token. Prioritize durable/replay FT-37 over FT-47 cosmetics.

Write implementation and tests, run them with bounded nonblocking commands. A commit in your isolated worktree is okay after green; no attribution trailer. No push. Report worktree, branch, exact diff/files, test command/count, limitations and proof artifact to leader. Do not mark the full issue closed; integration and one-lane proof remain.

## Worker B: independent replay review and fixtures

Read-only independent review of the replay contract and adversarial acceptance matrix. You own only `FT-37-47-REPLAY-REVIEW.md` plus a synthetic fixture file (if useful) in this Fleet record, NOT the implementation tree. Coordinate with Worker A via DM for proposed semantics and tests, without interrupting working lanes. Verify actual installed serializers locally (no paid calls); record commands and payloads, not just source citations. Focus on omission, duplication, synthetic signatures, mixed native/recovered reasoning, unknown provider/model names, model switch and literal examples. Tell leader/worker immediately if the design cannot meet no-loss replay.

## Done gate

Focused tests green; diff reviewed; exact outbound payload assertions (not renderer-only assertions); native signed blocks untouched; provider/model-independent detection exercised; no synthetic toolCall; documented unsupported signed-replay limits and native model-switch behavior preserved; no accidental additional loss on supported same-model replay; one isolated lane proves load + persisted normalized message + next request payload. Only then integrate, update subrepo/pin as necessary and safely reload affected lanes. A report or a screenshot is not proof of reasoning replay.
