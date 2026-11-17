/** Small pure formatters shared by the client and the tests. */

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 48) return h + "h ago";
  const d = Math.round(h / 24);
  return d + "d ago";
}

export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 3600) return Math.round(seconds / 60) + "m";
  if (seconds < 86400 * 2) return (seconds / 3600).toFixed(1) + "h";
  return Math.round(seconds / 86400) + "d";
}

export function statusClass(status: string | null | undefined): string {
  const s = (status ?? "unknown").toLowerCase();
  if (s === "working") return "working";
  if (s === "idle") return "idle";
  if (s === "done") return "done";
  if (s === "blocked") return "blocked";
  return "unknown";
}

export function shortModel(model: string | null | undefined): string {
  if (!model) return "—";
  return model.length > 26 ? model.slice(0, 25) + "…" : model;
}

export function titleClamp(title: string, max = 96): string {
  if (title.length <= max) return title;
  return title.slice(0, max - 1) + "…";
}
