// Metric definitions and median adapted from @arhen/pi-core-tps-stats 1.3.4
// Copyright (c) 2026 arhen. MIT; see LICENSE and UPSTREAM.md.
export const MAX_SAMPLES = 200;
export type Mode = "period" | "latest";
export interface Config {
  mode: Mode;
  periodSeconds: number;
  logging: boolean;
}
export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  mode: "period", periodSeconds: 300, logging: false,
});
export interface Measurement {
  endedAtMs: number;
  outputTokens: number;
  durationMs: number;
  tps: number;
  ttftMs: number | null;
}
export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
export function measure(outputTokens: number, startMs: number, firstMs: number | undefined, endMs: number): Measurement | undefined {
  const durationMs = endMs - startMs;
  if (![outputTokens, startMs, endMs, durationMs].every(Number.isFinite) || outputTokens <= 0 || durationMs <= 0) return;
  const rate = outputTokens / (durationMs / 1000);
  if (!Number.isFinite(rate)) return;
  return {
    endedAtMs: endMs, outputTokens, durationMs, tps: rate,
    ttftMs: firstMs !== undefined && Number.isFinite(firstMs) && firstMs >= startMs && firstMs <= endMs ? firstMs - startMs : null,
  };
}
export class Measurements {
  private samples: Measurement[] = [];
  reset(): void { this.samples = []; }
  add(sample: Measurement): void {
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }
  select(config: Config, now: number): Measurement[] {
    if (config.mode === "latest") return this.samples.slice(-1);
    const cutoff = now - config.periodSeconds * 1000;
    return this.samples.filter(sample => sample.endedAtMs >= cutoff && sample.endedAtMs <= now);
  }
}
