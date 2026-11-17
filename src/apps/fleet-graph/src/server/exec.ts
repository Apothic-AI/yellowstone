/** Run a read-only CLI as a subprocess and return its JSON, with timing and
 * failure captured as data rather than thrown. Every collector goes through
 * here so the UI can render "this source failed and why" instead of a blank
 * screen. */

import { execFile } from "node:child_process";

export interface RunResult<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
  stderr: string | null;
  ms: number;
}

export function runJson<T>(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}
): Promise<RunResult<T>> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: opts.maxBuffer ?? 128 * 1024 * 1024,
        encoding: "utf8",
        env: opts.env ?? process.env,
        cwd: opts.cwd
      },
      (err, stdout, stderr) => {
        const ms = Date.now() - started;
        if (err) {
          resolve({
            ok: false,
            data: null,
            error: err.message || String(err),
            stderr: (stderr || "").trim().slice(0, 2000) || null,
            ms
          });
          return;
        }
        try {
          resolve({ ok: true, data: JSON.parse(stdout) as T, error: null, stderr: null, ms });
        } catch (parseErr) {
          resolve({
            ok: false,
            data: null,
            error: "invalid JSON from " + cmd + ": " + (parseErr as Error).message,
            stderr: (stderr || "").trim().slice(0, 2000) || null,
            ms
          });
        }
      }
    );
  });
}
