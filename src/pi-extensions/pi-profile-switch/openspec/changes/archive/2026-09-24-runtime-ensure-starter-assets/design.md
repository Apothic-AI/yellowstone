# Design

## Context

Motivation in "Why" of `proposal.md`. The current state and constraints shaping the design:

- `bin/postinstall.js` must be plain Node ESM (an npm postinstall environment constraint, noted in the file header); its agentDir resolution mirrors Pi's `getAgentDir()`, following the "keep in sync" comment convention.
- The launcher `bin/pi-profile.ts` directly imports Pi's `getAgentDir()` and this package's `getGlobalProfilesDir()`; no mirroring is needed at runtime.
- The extension (`extensions/pi-profile/index.ts`) early-returns directly when `PI_CODING_AGENT_DIR` is absent — the launcher is every session's single entry point, and the instance is generated inside the launcher.
- The shipped assets `examples/ask.json` and `skills/profile-config/SKILL.md` are both in `package.json`'s `files`, available in published packages and the development repo alike.

## Goals / Non-Goals

**Goals:**

- Distribution guarantee: once the user starts through the launcher even once, the starter profile and the `profile-config` skill are in place (same rules as postinstall).
- A single TS implementation, idempotent, cost limited to stat/content comparison; failures never block startup.

**Non-Goals:**

- Not deleting postinstall (demoted to an early optimization, see Decisions).
- No second ensure point in the extension's `session_start`.
- No uninstall cleanup (keeping the existing "residue after uninstall is possible and accepted" stance).
- No new user-visible configuration fields.

## Decisions

### D1: New `src/starter-assets.ts`, export surface

```ts
export interface StarterAssetFileResult {
	/** Absolute path of the target file */
	path: string;
	/** Whether this call performed a write */
	written: boolean;
}

export interface StarterAssetsResult {
	profile: StarterAssetFileResult;
	skill: StarterAssetFileResult;
	/** Human-readable degradation warnings; empty means all succeeded or no-op */
	warnings: string[];
}

export async function ensureStarterAssets(options?: {
	/** Defaults to getGlobalProfilesDir(); injected by tests */
	globalProfilesDir?: string;
	/** Defaults to Pi's getAgentDir(); injected by tests */
	agentDir?: string;
	/** Defaults to locating the package root from import.meta.url; injected by tests */
	packageRoot?: string;
}): Promise<StarterAssetsResult>;
```

- No new error types: IO failures (`NodeJS.ErrnoException`) are caught internally and turned into `warnings` entries; the function never throws for any anticipated runtime-environment failure.
- The two assets succeed or fail independently: one failing does not affect the other's attempt.

### D2: The launcher calls ensure before resolving the initial profile

In `bin/pi-profile.ts`, `ensureStarterAssets()` is called after `parseLauncherArgs` and before `resolveInitialProfile`; `warnings` are printed via `console.error` with the `pi-profile: warning:` prefix (consistent with the instance sweep's best-effort output pattern). This timing makes the seeded `ask` visible to this launch's initial resolution and `/profile list`.

### D3: Asset location relative to the package root via `import.meta.url`

`src/starter-assets.ts` sits one level under `src/`; asset paths are `../examples/ask.json` and `../skills/profile-config/SKILL.md`. No `package.json` reading for location, consistent with postinstall's `new URL("../examples/ask.json", import.meta.url)`.

### D4: Runtime uses Pi's `getAgentDir()` directly, no more mirroring

postinstall's mirrored implementation is kept only because of the plain-JS constraint; the TS runtime reuses the `getAgentDir()` the launcher already imports, eliminating one drift source.

### D5: postinstall stays as a best-effort early optimization

Users who permit `allowScripts` get everything in place at install time; users who don't are backstopped by the launcher. postinstall's logic is unchanged — only the role positioning in its file-header comment is updated (the authoritative behavior contract points at the corresponding requirements in `openspec/specs/profile-catalog/spec.md`). The two implementations continue under the existing "keep in sync" convention.

### D6: Skill sync compares content first, overwriting only on difference

Overwriting on every startup would produce pointless disk writes and mtime churn; skip when content matches. The observable result is equivalent to "always overwrite": after any launch, the content matches the shipped version.

### Rejected alternatives

See the Doc Impact section of `proposal.md` (shell script, documenting `--allow-scripts`, extension double-insurance); the reasoning is not repeated here.

## Risks / Trade-offs

- After a user deletes every profile, the next launch re-seeds `ask.json` → consistent with install semantics (an empty directory counts as a fresh start); the spec's "No overwrite at startup" scenario bounds seeding to only when no profile exists at all.
- Concurrent launcher startup race → seeding keeps using `COPYFILE_EXCL` (the loser is silent); skill overwrites target identical content, last-writer-wins, same result.
- Drift between the postinstall and runtime copies of the logic → the "keep in sync" convention + the behavior contract owned solely by the spec; tests set up mirror cases on both sides.
- The ensure adds two stats and one possible content read to every launch → negligible cost; content comparison happens only when the skill file exists.

## Migration Plan

No migration steps: install-time behavior is unchanged, and existing users automatically backfill missing artifacts on their next `pi-profile` launch. Rollback = remove the invocation from the launcher.
