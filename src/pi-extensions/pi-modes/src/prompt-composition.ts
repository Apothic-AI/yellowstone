import {
  type BuildSystemPromptOptions,
  formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import { ensureSnapshot, readSnapshot } from "./mode-snapshots.ts";
import {
  type DefinitionFingerprints,
  type DriftPolicy,
  type ModeDefinition,
  type ModeSelection,
  type ModeStateV3,
  modeDefinitionFingerprint,
  normalizeModeSelection,
  type ResolvedMode,
  type ResolvedModeSelection,
  type SelectionDiagnostic,
  selectedKeys,
} from "./modes.ts";
import { isProjectModeApproved } from "./project-mode-approvals.ts";
import { displaySafe } from "./untrusted-text.ts";

export const PI_HOST_COMPATIBILITY = ">=1.1.0 <2.0.0";

/** Compose one legacy mode; retained as a compatibility helper. */
export function composeModePrompt(
  mode: ModeDefinition,
  options: BuildSystemPromptOptions,
  assembledPrompt: string,
): string {
  if (mode.promptStrategy === "append") {
    return `${assembledPrompt}\n\n# Active prompt mode: ${mode.label}\n${mode.systemPrompt}`;
  }
  if (mode.promptStrategy === "replace_final") return mode.systemPrompt;
  return buildCustomBasePrompt(mode.systemPrompt, options);
}

export interface ResolutionPolicy {
  fingerprints?: DefinitionFingerprints;
  driftPolicy?: DriftPolicy;
  // When given, a project mode whose exact definition was not confirmed blocks the resolution under
  // every drift policy (AK6201). The status bar and activation messages pass it, so they say what the
  // model gets. Structural checks (persisting, reapproval, policy, presets, the selector's starting
  // selection) leave it out: trust is confirmed separately and must not stall edits.
  projectApprovals?: ReadonlyMap<string, string>;
}

/**
 * Which project definitions a composition may use: the confirmed ones, or "review" for text shown to
 * the operator (previews) and never sent to the model. Required, so no caller composes unconfirmed
 * text by leaving it out.
 */
export type ProjectTrust = ReadonlyMap<string, string> | "review";

/** The recorded drift state of a selection, plus confirmed project definitions when given. */
export function resolutionPolicy(
  state: Pick<ModeStateV3, "fingerprints" | "driftPolicy"> | undefined,
  projectApprovals?: ReadonlyMap<string, string>,
): ResolutionPolicy {
  return {
    ...(state ? { fingerprints: state.fingerprints, driftPolicy: state.driftPolicy } : {}),
    ...(projectApprovals ? { projectApprovals } : {}),
  };
}

export function resolveModeSelection(
  selection: ModeSelection,
  modes: readonly ResolvedMode[],
  policy: ResolutionPolicy = {},
): ResolvedModeSelection {
  const diagnostics: SelectionDiagnostic[] = [];
  const driftedKeys: string[] = [];
  let normalized: ModeSelection;
  try {
    normalized = normalizeModeSelection(selection);
  } catch (error) {
    return {
      overlays: [],
      diagnostics: [{ message: error instanceof Error ? error.message : String(error) }],
      driftedKeys,
      blocked: true,
    };
  }
  const byKey = new Map(modes.map((mode) => [mode.key, mode]));
  let base: ResolvedMode | undefined;
  if (normalized.baseKey) {
    const candidate = byKey.get(normalized.baseKey);
    if (!candidate) {
      diagnostics.push({
        key: normalized.baseKey,
        message: "base mode is unavailable; using native host",
      });
    } else if (candidate.promptStrategy === "append") {
      diagnostics.push({
        key: candidate.key,
        message: "append mode cannot occupy the base slot; using native host",
      });
    } else {
      base = candidate;
    }
  }

  const overlays: ResolvedMode[] = [];
  const seen = new Set<string>();
  for (const key of normalized.overlayKeys) {
    if (seen.has(key)) {
      diagnostics.push({ key, message: "duplicate overlay omitted" });
      continue;
    }
    seen.add(key);
    const candidate = byKey.get(key);
    if (!candidate) {
      diagnostics.push({ key, message: "overlay mode is unavailable and was omitted" });
    } else if (candidate.promptStrategy !== "append") {
      diagnostics.push({
        key,
        message: `${candidate.promptStrategy} mode cannot be an overlay and was omitted`,
      });
    } else {
      overlays.push(candidate);
    }
  }

  // A composed definition whose project half cannot be used degrades to the definition it extends.
  // Dropping the whole selection here would let an unconfirmed project file take the fleet contract
  // with it — the failure that makes a composition worse than no composition at all.
  const approvals = policy.projectApprovals;
  const degrade = (mode: ResolvedMode | undefined): ResolvedMode | undefined => {
    if (!mode || !approvals || mode.scope !== "project") return mode;
    if (isProjectModeApproved(mode, approvals)) return mode;
    const fallback = mode.fallback;
    if (!fallback) return mode;
    diagnostics.push({
      key: mode.key,
      message: `project text dropped: ${mode.path ? displaySafe(mode.path) : "the project definition"} is not confirmed; continuing with the ${fallback.scope} definition alone`,
    });
    return {
      ...fallback,
      key: mode.key,
      schemaVersion: mode.schemaVersion,
      scope: fallback.scope,
    } as ResolvedMode;
  };
  // The composition is judged *before* the unconfirmed-project fallback runs. A project half whose
  // file changed is unapproved precisely because its digest moved, and degrading it first replaced it
  // with the shallower definition before `reuse` could restore the text it was approved under -- the
  // live proof caught a drifted cwd mode silently losing its project half that way.
  const components = [...(base ? [base] : []), ...overlays];
  const resolvedByDrift = new Set<string>();
  // `reuse` is the default: an edited definition file must not cost a lane the instructions it was
  // approved to run. `block` still exists, but it withholds the drifted key only.
  const driftPolicy = policy.driftPolicy ?? "reuse";
  if (policy.fingerprints) {
    for (const key of selectedKeys(normalized)) {
      const expected = policy.fingerprints[key];
      const current = byKey.get(key);
      const actual = current ? modeDefinitionFingerprint(current) : undefined;
      if (
        !expected ||
        !actual ||
        expected.digest !== actual.digest ||
        expected.scope !== actual.scope ||
        expected.path !== actual.path
      ) {
        driftedKeys.push(key);
        diagnostics.push({
          key,
          message: `definition changed since activation (${driftPolicy} policy)`,
        });
      }
    }
  }
  // Drift resolves per key. A definition file that moved cannot take the rest of the composition
  // with it: whatever happens to this key -- the approved snapshot, the new text, or nothing at
  // all -- every other component composes exactly as it would have. Dropping the whole composition
  // for one edited file cost a lane its entire role contract and fell back to the native prompt
  // (FT-91); no policy does that now. The drifted key is the *part* that drifted, and so it is the
  // only part that changes.
  if (driftedKeys.length > 0) {
    const replacements = new Map<string, ResolvedMode>();
    const withheld: string[] = [];
    for (const key of driftedKeys) {
      // warn and allow keep the new text, and the diagnostic above already named the change.
      if (driftPolicy !== "reuse" && driftPolicy !== "block") continue;
      const current = byKey.get(key);
      const changedPath = current?.path ?? key;
      const digest = policy.fingerprints?.[key]?.digest;
      const snapshot = driftPolicy === "reuse" && digest ? readSnapshot(key, digest) : null;
      if (snapshot) {
        const restored = {
          ...(current ?? {}),
          ...snapshot.definition,
          key,
          scope: snapshot.scope as ResolvedMode["scope"],
          path: snapshot.path,
        } as ResolvedMode;
        replacements.set(key, restored);
        resolvedByDrift.add(key);
        diagnostics.push({
          key,
          message: `using the composition first seen at ${snapshot.firstSeenAt}; ${changedPath} changed since -- /mode-reapprove adopts the new text`,
        });
        continue;
      }
      withheld.push(key);
      resolvedByDrift.add(key);
      diagnostics.push({
        key,
        message:
          driftPolicy === "reuse"
            ? `no verified snapshot for this definition; withheld from the composition, everything else is unaffected -- /mode-reapprove adopts the new text`
            : `withheld from the composition by the block policy, everything else is unaffected -- /mode-reapprove adopts the new text`,
      });
    }
    if (base && replacements.has(base.key)) base = replacements.get(base.key);
    for (let index = 0; index < overlays.length; index += 1) {
      const replacement = replacements.get(overlays[index].key);
      if (replacement) overlays[index] = replacement;
    }
    if (withheld.length > 0) {
      if (base && withheld.includes(base.key)) base = undefined;
      for (let index = overlays.length - 1; index >= 0; index -= 1) {
        if (withheld.includes(overlays[index].key)) overlays.splice(index, 1);
      }
    }
    // `components` was captured before drift resolved; the constraints must see the composition
    // that actually runs, not the one the files were about to produce.
    components.splice(0, components.length, ...[...(base ? [base] : []), ...overlays]);
  }
  // The unconfirmed-project fallback runs on what drift did not resolve: a key restored from its
  // approved snapshot is approved by construction, and a withheld key is not composed at all.
  // Everything else degrades exactly as it did before.
  if (base && !resolvedByDrift.has(base.key)) base = degrade(base);
  for (let index = 0; index < overlays.length; index += 1) {
    const mode = overlays[index];
    if (resolvedByDrift.has(mode.key)) continue;
    const next = degrade(mode);
    if (next) overlays[index] = next;
  }
  components.splice(0, components.length, ...[...(base ? [base] : []), ...overlays]);
  const unconfirmed = approvals
    ? components.filter((mode) => !isProjectModeApproved(mode, approvals))
    : [];
  if (unconfirmed.length > 0) {
    for (const mode of unconfirmed) {
      diagnostics.push({
        key: mode.key,
        message: `project mode from ${mode.path ? displaySafe(mode.path) : "an unknown file"}${mode.promptPath ? ` (prompt in ${displaySafe(mode.promptPath)})` : ""} is not confirmed; review it with /mode-preview, then confirm it with /mode-reapprove (--confirm-project headless)`,
      });
    }
    diagnostics.push({ message: "composition blocked until its project modes are confirmed" });
    return { overlays: [], diagnostics, driftedKeys, blocked: true };
  }
  {
    // Keep the composition a lane is actually running, so a later drift has something verified to
    // fall back on. Every key that did not drift seeds here -- a withheld or substituted key is
    // skipped, because its snapshot must stay the one it was approved under. Idempotent: one stat
    // per component once the file exists.
    const firstSeenAt = new Date().toISOString();
    for (const mode of [...(base ? [base] : []), ...overlays]) {
      if (driftedKeys.includes(mode.key)) continue;
      ensureSnapshot(mode, firstSeenAt);
    }
  }

  if (base?.promptStrategy === "replace_final" && normalized.overlayKeys.length > 0) {
    diagnostics.push({
      key: base.key,
      message: `replace_final is exclusive; preserving exact final prompt and omitting overlays: ${normalized.overlayKeys.join(", ")}`,
    });
    return { base, overlays: [], diagnostics, driftedKeys, blocked: false };
  }

  const selected = new Set(components.map((component) => component.key));
  const overlayPositions = new Map(overlays.map((component, index) => [component.key, index]));
  const constraintDiagnostics: SelectionDiagnostic[] = [];
  for (const component of components) {
    const missing = (component.requires ?? []).filter((key) => !selected.has(key));
    if (missing.length > 0) {
      constraintDiagnostics.push({
        key: component.key,
        message: `requires selected mode(s): ${missing.join(", ")}`,
      });
    }
    const conflicts = (component.conflictsWith ?? []).filter((key) => selected.has(key));
    if (conflicts.length > 0) {
      constraintDiagnostics.push({
        key: component.key,
        message: `conflicts with selected mode(s): ${conflicts.join(", ")}`,
      });
    }
    for (const key of component.before ?? []) {
      if (!selected.has(key)) continue;
      if (byKey.get(key)?.promptStrategy !== "append") {
        constraintDiagnostics.push({
          key: component.key,
          message: `before may target only a selected append overlay: ${key}`,
        });
      } else if ((overlayPositions.get(component.key) ?? -1) >= (overlayPositions.get(key) ?? -1)) {
        constraintDiagnostics.push({ key: component.key, message: `must appear before ${key}` });
      }
    }
    for (const key of component.after ?? []) {
      if (!selected.has(key)) continue;
      if (byKey.get(key)?.promptStrategy !== "append") {
        constraintDiagnostics.push({
          key: component.key,
          message: `after may target only a selected append overlay: ${key}`,
        });
      } else if ((overlayPositions.get(component.key) ?? -1) <= (overlayPositions.get(key) ?? -1)) {
        constraintDiagnostics.push({ key: component.key, message: `must appear after ${key}` });
      }
    }
  }
  if (constraintDiagnostics.length > 0) {
    diagnostics.push(...constraintDiagnostics, {
      message: "composition constraints failed; using native host",
    });
    return { overlays: [], diagnostics, driftedKeys, blocked: true };
  }
  return { base, overlays, diagnostics, driftedKeys, blocked: false };
}

/**
 * What a composition changes in Pi's prompt options for a turn. Pi 1.x builds the prompt from these
 * options and keeps it in the transcript as named sections, so a mode edits them instead of replacing
 * the text: replace_base sets the custom base, overlays add sections. Only replace_final forces text.
 */
export interface ModePromptChanges {
  customPrompt?: string;
  sections?: Record<string, string>;
  forceSystemPrompt?: string;
}

export function composeModeSelection(
  selection: ModeSelection,
  modes: readonly ResolvedMode[],
  options: BuildSystemPromptOptions,
  assembledPrompt: string,
  trust: ProjectTrust,
  policy: Omit<ResolutionPolicy, "projectApprovals"> = {},
): { prompt: string; resolved: ResolvedModeSelection; changes: ModePromptChanges } {
  // Checked at run time as well: a JavaScript caller that leaves trust out must not fail open.
  if (trust !== "review" && typeof (trust as { get?: unknown } | undefined)?.get !== "function") {
    throw new TypeError(
      'composeModeSelection needs the confirmed project definitions (a Map) or "review"',
    );
  }
  const resolved = resolveModeSelection(selection, modes, {
    ...policy,
    ...(trust === "review" ? {} : { projectApprovals: trust }),
  });
  if (resolved.blocked) return { prompt: assembledPrompt, resolved, changes: {} };
  if (resolved.base?.promptStrategy === "replace_final") {
    const exact = resolved.base.systemPrompt;
    return { prompt: exact, resolved, changes: { forceSystemPrompt: exact } };
  }
  const sections = overlaySections(resolved.overlays);
  const changes: ModePromptChanges = Object.keys(sections).length > 0 ? { sections } : {};
  if (resolved.base?.promptStrategy === "replace_base") {
    const customPrompt = resolved.base.systemPrompt;
    const prompt = buildCustomBasePrompt(customPrompt, {
      ...options,
      sections: { ...options.sections, ...sections },
    });
    return { prompt, resolved, changes: { ...changes, customPrompt } };
  }
  // Pi renders custom sections last, so overlays follow the host prompt as it stands.
  return {
    prompt: [assembledPrompt, ...Object.entries(sections).map(renderSection)].join("\n\n"),
    resolved,
    changes,
  };
}

function overlaySections(overlays: readonly ModeDefinition[]): Record<string, string> {
  return Object.fromEntries(
    overlays.map((mode, index) => [
      `prompt_overlay_${index + 1}`,
      `# Active prompt overlay ${index + 1}: ${mode.label}\n${mode.systemPrompt}`,
    ]),
  );
}

function renderSection([name, content]: [string, string]): string {
  return `<${name}>\n${content}\n</${name}>`;
}

/**
 * Pi 1.1's custom-base prompt as its transcript replays it: the custom base, then the addendum,
 * project context, skills, cwd and custom sections, each in its tag. Pi builds the real prompt
 * itself (the before_agent_start options carry customPrompt); this rendering serves previews and
 * the parity canary.
 */
export function buildCustomBasePrompt(
  customPrompt: string,
  options: BuildSystemPromptOptions,
): string {
  const selectedTools = options.selectedTools ?? ["read", "bash", "edit", "write"];
  const declaredTools = selectedTools.filter((name) => !(options.hiddenTools ?? []).includes(name));
  const sections: Record<string, string> = {};
  if (options.appendSystemPrompt) sections.addendum = options.appendSystemPrompt;
  const contextFiles = options.contextFiles ?? [];
  if (contextFiles.length > 0) {
    sections.project_context = [
      "Project-specific instructions and guidelines:",
      ...contextFiles.map(
        ({ path, content }) =>
          `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
      ),
    ].join("\n\n");
  }
  // A hidden reader still reaches skill files through another tool, so the hint names none.
  const readers = ["read", "bash"] as const;
  const reader =
    readers.find((tool) => declaredTools.includes(tool)) ??
    (readers.some((tool) => selectedTools.includes(tool)) ? ("indirect" as const) : undefined);
  const skills = options.skills ?? [];
  if (reader && skills.length > 0) {
    const text = formatSkillsForPrompt(skills, reader).trim();
    if (text) sections.skills = text;
  }
  sections.cwd = options.cwd.replace(/\\/g, "/");
  for (const [name, content] of Object.entries(options.sections ?? {})) {
    if (content) sections[name] = content;
  }
  return [customPrompt, ...Object.entries(sections).map(renderSection)]
    .filter((part) => part.length > 0)
    .join("\n\n");
}
