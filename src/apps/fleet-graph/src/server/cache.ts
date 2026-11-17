/** Tiny TTL cache with in-flight de-duplication. Sources are read-only and
 * idempotent, but some are expensive (behold walks every session), so the API
 * reuses a recent read instead of racing N browser tabs into N walks. */

interface Entry<T> {
  at: number;
  ttlMs: number;
  value?: T;
  error?: unknown;
  inflight?: Promise<T>;
}

const entries = new Map<string, Entry<unknown>>();

export async function ttl<T>(name: string, ttlMs: number, load: () => Promise<T>, refresh = false): Promise<T> {
  const now = Date.now();
  const hit = entries.get(name) as Entry<T> | undefined;
  if (!refresh && hit && hit.value !== undefined && now - hit.at < hit.ttlMs) {
    return hit.value;
  }
  if (!refresh && hit?.inflight) return hit.inflight;
  const inflight = load()
    .then((value) => {
      entries.set(name, { at: Date.now(), ttlMs, value });
      return value;
    })
    .catch((error) => {
      // Keep the last good value if there is one; a transient failure must not
      // clear a screen that was working a second ago.
      entries.set(name, { at: Date.now(), ttlMs: Math.min(ttlMs, 5_000), value: hit?.value, error });
      throw error;
    });
  entries.set(name, { at: now, ttlMs, value: hit?.value, inflight });
  return inflight;
}

export function clearCache(): void {
  entries.clear();
}
