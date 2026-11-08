# extensions/card-surface.ts

- Surface · type · L3-L3 — type Surface = { prefix: string; signature: string; paint: (text: string) => string };
- brush · function · L8-L13 — brush = (sample: string): Surface
- cardSurface · function · L16-L38 — function cardSurface(theme: any, borderRole?: string, fallback = "toolPendingBg"): Surface
