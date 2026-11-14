/**
 * The transport that carries the SubRouter protocol to the Go library.
 *
 * The Go library runs as a child process that speaks the protocol over its
 * standard streams. The package is pure JavaScript: it needs no compiler
 * and no native module.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ClientOptions } from "./types.js";

/** One request of the protocol. */
export interface ProtocolRequest {
  method: string;
  params?: Record<string, unknown>;
  options?: ClientOptions;
  id?: string;
}

/** One response of the protocol. */
export interface ProtocolResponse {
  ok: boolean;
  result?: unknown;
  error?: { message: string; type?: string; status?: number };
  notices?: string[];
  id?: string;
}

/** Raised when the Go library cannot be reached. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/** The name of the helper binary. */
const BINARY_NAME = "subrouterctl";

/** The name of the environment variable that points at the binary. */
const BINARY_ENV = "SUBROUTERCTL_BIN";

/**
 * Finds the root of the repository, so that a checkout of the source finds
 * the binary that `make build` produced.
 */
function findRepositoryRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let step = 0; step < 6; step += 1) {
    if (existsSync(join(dir, "go.mod"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

/** Looks a program up in the PATH. */
function findOnPath(name: string): string | undefined {
  const path = process.env.PATH ?? "";
  for (const entry of path.split(process.platform === "win32" ? ";" : ":")) {
    if (!entry) {
      continue;
    }
    const candidate = join(entry, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Finds the helper binary.
 *
 * The binary is looked for in the order: the argument, the environment,
 * the build of a repository checkout, and the PATH.
 */
export function resolveBinary(explicit?: string): string {
  const candidates: string[] = [];
  if (explicit) {
    candidates.push(explicit);
  }
  const fromEnv = process.env[BINARY_ENV];
  if (fromEnv) {
    candidates.push(fromEnv);
  }
  const root = findRepositoryRoot();
  if (root) {
    candidates.push(join(root, BINARY_NAME));
  }
  const onPath = findOnPath(BINARY_NAME);
  if (onPath) {
    candidates.push(onPath);
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new TransportError(
      `the ${BINARY_NAME} binary was not found. Build it with "make build" in the ` +
        `repository, or point ${BINARY_ENV} at it. Searched: ${candidates.join(", ")}`,
    );
  }
  return found;
}

/** The interface every transport implements. */
export interface Transport {
  readonly name: string;
  call(request: ProtocolRequest): Promise<ProtocolResponse>;
  close(): void;
}

/**
 * Talks to the Go library over the standard streams of a child process.
 */
export class IPCTransport implements Transport {
  readonly name = "ipc";

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, (response: ProtocolResponse) => void>();
  private buffer = "";
  private counter = 0;
  private stderr = "";
  private closed = false;

  constructor(binary?: string) {
    const path = resolveBinary(binary);
    this.child = spawn(path, ["bridge"], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.on("error", (error: Error) => this.failAll(error.message));
    this.child.on("exit", (code: number | null) => {
      this.closed = true;
      this.failAll(`the bridge process stopped (exit code ${code ?? "unknown"})`);
    });
  }

  /** The output of the child process, for error messages. */
  get diagnostics(): string {
    return this.stderr.trim();
  }

  call(request: ProtocolRequest): Promise<ProtocolResponse> {
    if (this.closed) {
      return Promise.reject(new TransportError("the bridge process is closed"));
    }
    this.counter += 1;
    const id = String(this.counter);
    const answer = new Promise<ProtocolResponse>((resolve) => {
      this.pending.set(id, resolve);
    });
    const payload = JSON.stringify({ ...request, id });
    this.child.stdin.write(`${payload}\n`);
    return answer;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.child.stdin.end();
    this.child.kill();
    this.failAll("the bridge process was closed");
  }

  /** Reads the answers that arrived and hands them to their callers. */
  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        this.resolve(line);
      }
      index = this.buffer.indexOf("\n");
    }
  }

  private resolve(line: string): void {
    let response: ProtocolResponse;
    try {
      response = JSON.parse(line) as ProtocolResponse;
    } catch (error) {
      this.failAll(`the bridge process answered with something that is not JSON: ${line}`);
      return;
    }
    const id = response.id;
    if (!id) {
      return;
    }
    const waiting = this.pending.get(id);
    if (waiting) {
      this.pending.delete(id);
      waiting(response);
    }
  }

  private failAll(reason: string): void {
    for (const waiting of this.pending.values()) {
      waiting({
        ok: false,
        error: { message: reason, type: "transport" },
      });
    }
    this.pending.clear();
  }
}
