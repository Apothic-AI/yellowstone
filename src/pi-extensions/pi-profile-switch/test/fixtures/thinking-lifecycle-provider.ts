import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * FT-32 lifecycle fixture: reasoning models that can express every thinking
 * level, including `max`.
 *
 * The older `provider-registration.ts` fixture maps no `xhigh`/`max` provider
 * values, so Pi clamps those levels down to `high` and a level-precedence test
 * written against it would compare two values that both collapse to `high`.
 * These models mirror a real production model's map, where `max` is a supported
 * level, so the level actually selected by Pi is observable.
 *
 * Requests are forbidden: `streamSimple` throws before any I/O.
 */
const tracePath = process.env.PI_PROFILE_VALIDATION_TRACE;
if (tracePath === undefined) throw new Error("provider fixture requires PI_PROFILE_VALIDATION_TRACE");

function record(event: Record<string, unknown>): void {
	appendFileSync(tracePath!, `${JSON.stringify({ ...event, pid: process.pid })}\n`);
}

// Provenance: the entry this child actually executed. The suite asserts it against
// `pi --version` so a scratch home or a PATH change cannot silently swap the
// deployed runtime for the pinned dev dependency (or the reverse).
record({ kind: "module", piEntry: process.argv[1] });

export default function thinkingLifecycleProvider(pi: ExtensionAPI): void {
	record({ kind: "factory" });
	pi.registerProvider("thinking-lifecycle-fixture", {
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "test-only-not-a-credential",
		models: ["shared-model", "other-model"].map((id) => ({
			id,
			name: `Thinking lifecycle fixture ${id}`,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 128_000,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
		})),
		streamSimple() {
			record({ kind: "request" });
			throw new Error("provider requests are forbidden in the thinking lifecycle fixture");
		},
	});
	pi.on("before_provider_request", () => {
		record({ kind: "provider-request" });
	});
	pi.on("session_start", (event) => {
		record({ kind: "session_start", reason: event.reason });
	});
}
