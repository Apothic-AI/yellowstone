import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const tracePath = process.env.PI_PROFILE_VALIDATION_TRACE;
if (tracePath === undefined) throw new Error("provider fixture requires PI_PROFILE_VALIDATION_TRACE");

function record(event: Record<string, unknown>): void {
	appendFileSync(tracePath!, `${JSON.stringify({ ...event, pid: process.pid })}\n`);
}

// Detect imports as well as factory calls: neither belongs in the launcher.
record({ kind: "module" });

export default function providerRegistration(pi: ExtensionAPI): void {
	record({ kind: "factory" });
	pi.registerProvider("profile-validation-fixture", {
		api: "profile-validation-fixture-api",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "test-only-not-a-credential",
		models: ["startup", "cli", "project", "reload"].map((id) => ({
			id,
			name: `Lifecycle fixture ${id}`,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 256,
		})),
		streamSimple() {
			record({ kind: "request" });
			throw new Error("provider requests are forbidden in the lifecycle fixture");
		},
	});
	pi.on("before_provider_request", () => { record({ kind: "provider-request" }); });
	pi.on("session_start", (event, ctx) => {
		record({
			kind: "session_start",
			reason: event.reason,
			sessionId: ctx.sessionManager.getSessionId(),
			model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
		});
	});
}
