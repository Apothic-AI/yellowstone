# Upstream provenance and first-run check

Read-only installed package inspected before implementation:

- Path: `/home/bitnom/.pi/agent/npm/node_modules/@arhen/pi-core-tps-stats`
- Package: `@arhen/pi-core-tps-stats` **1.3.4**
- Source repository declared by package:
  `https://github.com/arhen/pi-extensions`, `packages/core/pi-core-tps-stats`
- Author/copyright: **arhen, Copyright (c) 2026 arhen**, MIT.
- Installed `src/index.ts` SHA-256:
  `97d6f0e471a63e4f6da79ab7e63154f339023ca29a82400891cf01754527204d`
- `LICENSE` in this candidate is byte-identical to the installed MIT license.

This is a local candidate, not an upstream publication. `metrics.ts` adapts the
upstream median and effective TPS definitions; the isolated adapter, validated
config, slash controls and metrics-only logging are new. The upstream 2-second
reset flash, speed colors, mean/min/max report are not copied: the candidate
uses a simple median view and immediate reset without timers.

## Verified existing features

A scratch fake event API and deterministic clock executed the exact installed
source via a byte-identical copy outside `node_modules` (Node's native type
stripping refuses TS under `node_modules`). No package files were modified and
no runtime/provider was loaded. The initial direct-import probe hit that Node
restriction; rerunning against the copy succeeded with exit 0.

Verified: effective TPS `100 / 2s = 50`; thinking-first TTFT `200ms`; 200-sample
ring bound; median math; status rendering; `/tps-stats` sample report; automatic
model-change reset. The second empty reset cleared upstream's UI timeout so the
probe required no wait. Registered commands were exactly `['tps-stats']`.

## Exact FT-28 gaps

Upstream has no manual-reset slash control; no latest/period mode toggle; its
200-sample ring is not a configurable elapsed-time period; no global config;
no JSONL disk writer, session-ID log path, timestamped records, or logging
on/off command. There are no config/file imports in the inspected source.
The installed published artifact omits `src/index.test.ts`, despite declaring
an npm test script for it; therefore the requested first-run verification used
the explicit scratch probe, not a claimed upstream suite pass.

Scratch evidence (outside repo):
`/home/bitnom/.local/state/ft28-tps-stats/upstream-check.mjs`,
`upstream-index.ts`, and `upstream-check.log`.
