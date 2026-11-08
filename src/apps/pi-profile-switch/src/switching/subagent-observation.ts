import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type SubagentExtensionObservation = "detected" | "unconfirmed";

export interface SubagentRegistrationSource {
  sourceInfo?: {
    path?: string;
    source?: string;
    origin?: string;
    baseDir?: string;
  };
}

const PACKAGE_NAME = "pi-subagents";
const MAX_REGISTRATIONS = 256;
const MAX_DIRECTORY_DEPTH = 32;

function isSyntheticPath(value: string): boolean {
  return value.startsWith("builtin:") || /^<[^>]*>$/.test(value);
}

function isFilePath(value: string): boolean {
  return !isSyntheticPath(value) && !/^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

async function manifestOwner(startDirectory: string): Promise<string | undefined> {
  let directory = startDirectory;

  for (let depth = 0; depth < MAX_DIRECTORY_DEPTH; depth += 1) {
    const manifestPath = path.join(directory, "package.json");
    try {
      const contents = await readFile(manifestPath, "utf8");
      const manifest: unknown = JSON.parse(contents);
      if (manifest !== null && typeof manifest === "object" && "name" in manifest && typeof manifest.name === "string") {
        return manifest.name;
      }
      // A present but invalid manifest still defines the nearest package boundary.
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
        return undefined;
      }
    }

    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }

  return undefined;
}

async function registrationOwner(sourceInfo: NonNullable<SubagentRegistrationSource["sourceInfo"]>): Promise<string | undefined> {
  const sourcePath = typeof sourceInfo.path === "string" ? sourceInfo.path.trim() : "";
  const baseDir = typeof sourceInfo.baseDir === "string" ? sourceInfo.baseDir.trim() : "";

  if (sourcePath && isFilePath(sourcePath)) {
    const resolvedPath = path.isAbsolute(sourcePath)
      ? path.resolve(sourcePath)
      : baseDir
        ? path.resolve(baseDir, sourcePath)
        : undefined;
    if (!resolvedPath) return undefined;

    try {
      const canonicalPath = await realpath(resolvedPath);
      const fileStat = await stat(canonicalPath);
      const startDirectory = fileStat.isDirectory() ? canonicalPath : path.dirname(canonicalPath);
      return await manifestOwner(startDirectory);
    } catch {
      return undefined;
    }
  }

  // A base directory is authoritative only when no usable file path was supplied.
  if (sourcePath || !baseDir || !isFilePath(baseDir)) return undefined;
  try {
    const canonicalBase = await realpath(path.resolve(baseDir));
    const baseStat = await stat(canonicalBase);
    if (!baseStat.isDirectory()) return undefined;
    const manifestPath = path.join(canonicalBase, "package.json");
    const contents = await readFile(manifestPath, "utf8");
    const manifest: unknown = JSON.parse(contents);
    return manifest !== null && typeof manifest === "object" && "name" in manifest && typeof manifest.name === "string"
      ? manifest.name
      : undefined;
  } catch {
    return undefined;
  }
}

/** Observe native package ownership without importing extensions or activating tools. */
export async function observeSubagentExtension(
  registrations: readonly SubagentRegistrationSource[],
): Promise<SubagentExtensionObservation> {
  const owners = new Map<string, Promise<string | undefined>>();
  const count = Math.min(registrations.length, MAX_REGISTRATIONS);

  for (let index = 0; index < count; index += 1) {
    const sourceInfo = registrations[index]?.sourceInfo;
    if (!sourceInfo) continue;
    const pathKey = `${sourceInfo.path ?? ""}\0${sourceInfo.baseDir ?? ""}`;
    let owner = owners.get(pathKey);
    if (!owner) {
      owner = registrationOwner(sourceInfo);
      owners.set(pathKey, owner);
    }
    if (await owner === PACKAGE_NAME) return "detected";
  }

  return "unconfirmed";
}
