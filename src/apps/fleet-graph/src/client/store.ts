import { createSignal, onCleanup, onMount } from "solid-js";
import type { FleetState } from "../shared/types.ts";

const [state, setState] = createSignal<FleetState | null>(null);
const [error, setError] = createSignal<string | null>(null);
const [loading, setLoading] = createSignal(true);
const [fetchedAt, setFetchedAt] = createSignal(0);
let started = false;
let timer: ReturnType<typeof setInterval> | undefined;

async function load(force = false): Promise<void> {
  try {
    const res = await fetch("/api/state" + (force ? "?refresh=1" : ""), { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText);
    const next = (await res.json()) as FleetState;
    setState(next);
    setFetchedAt(Date.now());
    setError(null);
  } catch (e) {
    setError(String((e as Error)?.message ?? e));
  } finally {
    setLoading(false);
  }
}

export function useFleet() {
  if (!started) {
    started = true;
    onMount(() => {
      void load();
      timer = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        void load();
      }, 5000);
      onCleanup(() => {
        if (timer) clearInterval(timer);
      });
    });
  }
  return {
    state,
    error,
    loading,
    fetchedAt,
    refresh: () => load(true)
  };
}
