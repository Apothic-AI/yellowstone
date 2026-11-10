// Emit the COMPOSED leader-mode digest for a cwd, using pi-modes' own fingerprint function.
//
// Why this exists: `propagate-mode-change.py` must know the exact digest a lane will record
// after it re-approves, so it can verify the re-approval happened rather than assume it. The
// digest covers the composed definition (the global base plus any project `append` delta) with
// scope and path, so reimplementing it in Python silently produces a value that is not the
// value pi-modes compares against. Call the package instead.
//
// Usage: REAL_AGENT_DIR=~/.pi/agent node --experimental-strip-types mode-composed-digest.mjs <cwd> <key>
// Prints one JSON line: {"scope": "...", "digest": "<sha256>", "path": "..."}
import { existsSync, readFileSync } from "node:fs";

// The pi-modes package is resolved, never hardcoded: it lives inside the yellowstone
// monorepo now, and a lane may be developing it in a worktree, so a fixed path is
// wrong the moment either moves. The installed package list wins, because that is
// the copy pi itself loads. PI_MODES_PKG overrides everything.
function piModesPackage() {
  if (process.env.PI_MODES_PKG) return process.env.PI_MODES_PKG;
  try {
    const settings = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/settings.json`, "utf8"));
    for (const entry of settings.packages || []) {
      const source = typeof entry === "string" ? entry : entry && entry.source;
      if (typeof source === "string" && source.startsWith("/") && /(^|\/)pi-modes$/.test(source)) {
        return source;
      }
    }
  } catch {
    // fall through to the monorepo default
  }
  const fallback = `${process.env.HOME}/Code/yellowstone/src/pi-extensions/pi-modes`;
  if (existsSync(fallback)) return fallback;
  console.error("pi-modes package not found: set PI_MODES_PKG or install it from the monorepo");
  process.exit(2);
}

const PI_MODES = piModesPackage();
const { loadModes, modeDefinitionFingerprint } = await import(`${PI_MODES}/src/modes.ts`);

const cwd = process.argv[2];
const key = process.argv[3];
const agentDir = process.env.REAL_AGENT_DIR || `${process.env.HOME}/.pi/agent`;

if (!cwd || !key) {
  console.error("usage: mode-composed-digest.mjs <cwd> <key>");
  process.exit(2);
}

// Mirror pi-modes' ancestor discovery: root -> cwd, shallowest first.
const dirs = [];
{
  let current = cwd;
  while (true) {
    dirs.push(`${current}/.pi/modes`);
    const parent = current.substring(0, current.lastIndexOf("/")) || "/";
    if (parent === current) break;
    current = parent;
  }
}
dirs.reverse();

const loaded = loadModes({
  globalDir: `${agentDir}/modes`,
  projectDir: `${cwd}/.pi/modes`,
  projectDirs: dirs,
  projectTrusted: true,
});

const mode = loaded.modes.find((candidate) => candidate.key === key);
if (!mode) {
  console.log(JSON.stringify({ scope: null, digest: null, path: null, error: "mode not found" }));
  process.exit(0);
}

// A launcher lane reads its own materialised copy, and `path` is part of the fingerprint, so
// the SAME TEXT at the instance path hashes differently from the real agent dir. When the
// caller names that copy, digest it instead of the discovered definition.
const overridePath = process.argv[4];
if (overridePath) {
  const { parseModeDefinition, modeDefinitionFingerprint } = await import(
    `${PI_MODES}/src/mode-definitions.ts`
  );
  const { readFileSync } = await import("node:fs");
  const raw = JSON.parse(readFileSync(overridePath, "utf8"));
  const override = { ...parseModeDefinition(raw), scope: mode.scope, path: overridePath };
  console.log(
    JSON.stringify({
      scope: mode.scope,
      digest: modeDefinitionFingerprint(override).digest,
      path: overridePath,
    }),
  );
  process.exit(0);
}

console.log(
  JSON.stringify({
    scope: mode.scope,
    digest: modeDefinitionFingerprint(mode).digest,
    path: mode.path ?? null,
  }),
);
