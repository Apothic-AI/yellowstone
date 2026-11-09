import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeSubagentExtension, type SubagentRegistrationSource } from "../src/switching/subagent-observation.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "subagent-observation-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function packageAt(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name }));
}

function registration(filePath: string, baseDir?: string): SubagentRegistrationSource {
  return { sourceInfo: { path: filePath, source: "local", origin: "top-level", ...(baseDir ? { baseDir } : {}) } };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("observeSubagentExtension", () => {
  it("does not infer ownership from registration names or source labels", async () => {
    expect(await observeSubagentExtension([
      { name: "subagent", sourceInfo: { source: "pi-subagents" } } as SubagentRegistrationSource,
      { sourceInfo: { path: "builtin:subagent", source: "builtin", baseDir: "/not/a/package" } },
      { sourceInfo: { path: "<inline:delegation>", source: "pi-subagents", baseDir: "/not/a/package" } },
      {},
    ])).toBe("unconfirmed");
  });

  it("detects a registered inactive tool through package ownership", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "dist", "extension.js");
    await packageAt(root, "pi-subagents");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "// registration source");

    expect(await observeSubagentExtension([registration(file)])).toBe("detected");
  });

  it.each(["cli", "project", "local", "symlink"]) ("recognizes %s package ownership", async (kind) => {
    const root = await temporaryDirectory();
    const pkg = path.join(root, "installed", "pi-subagents");
    const file = path.join(pkg, "dist", "extension.js");
    await packageAt(pkg, "pi-subagents");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "// registered source");

    let registeredPath = file;
    let baseDir: string | undefined;
    if (kind === "symlink") {
      const alias = path.join(root, "alias.js");
      await symlink(file, alias);
      registeredPath = alias;
    } else if (kind === "cli") {
      registeredPath = path.relative(root, file);
      baseDir = root;
    } else if (kind === "project") {
      registeredPath = path.relative(pkg, file);
      baseDir = pkg;
    }
    expect(await observeSubagentExtension([registration(registeredPath, baseDir)])).toBe("detected");
  });

  it("uses the base directory manifest when no file path is present", async () => {
    const root = await temporaryDirectory();
    await packageAt(root, "pi-subagents");
    expect(await observeSubagentExtension([{ sourceInfo: { source: "local", baseDir: root } }])).toBe("detected");
  });

  it("stops at a foreign nearest manifest rather than crediting an ancestor", async () => {
    const root = await temporaryDirectory();
    const nested = path.join(root, "node_modules", "foreign");
    const file = path.join(nested, "entry.js");
    await packageAt(root, "pi-subagents");
    await packageAt(nested, "foreign-extension");
    await writeFile(file, "// foreign code");

    expect(await observeSubagentExtension([registration(file)])).toBe("unconfirmed");
  });

  it("does not treat a same-named foreign package registration as owned", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "entry.js");
    await packageAt(root, "foreign-extension");
    await writeFile(file, "// foreign code");
    expect(await observeSubagentExtension([registration(file)])).toBe("unconfirmed");
  });

  it("returns unconfirmed for absent or unreadable metadata and manifests", async () => {
    const root = await temporaryDirectory();
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "package.json"), "{");
    const file = path.join(root, "extension.js");
    await writeFile(file, "// registration source");
    const unreadableRoot = path.join(root, "unreadable");
    await mkdir(path.join(unreadableRoot, "package.json"), { recursive: true });
    const unreadableFile = path.join(unreadableRoot, "extension.js");
    await writeFile(unreadableFile, "// registration source");
    expect(await observeSubagentExtension([
      registration(file),
      registration(unreadableFile),
      {},
      { sourceInfo: { path: "/missing/file.js" } },
    ])).toBe("unconfirmed");
  });

  it("bounds parent traversal and registration work", async () => {
    const root = await temporaryDirectory();
    let deepPath = root;
    for (let index = 0; index < 40; index += 1) deepPath = path.join(deepPath, "d");
    const file = path.join(deepPath, "extension.js");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "// registration source");
    await packageAt(root, "pi-subagents");

    const startedAt = Date.now();
    expect(await observeSubagentExtension(Array.from({ length: 300 }, () => registration(file)))).toBe("unconfirmed");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
