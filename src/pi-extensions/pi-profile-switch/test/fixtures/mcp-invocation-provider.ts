import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Scripted local model: native Pi still owns tool dispatch and MCP enforcement. */
export default function mcpInvocationProvider(pi: ExtensionAPI): void {
	let sequence = 0;
	pi.registerProvider("profile-mcp-invocation", {
		api: "profile-mcp-invocation-api",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "test-only-not-a-credential",
		models: [{ id: "scripted", name: "Local MCP invocation", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1024 }],
		streamSimple(model, context) {
			const userIndex = context.messages.findLastIndex((message) => message.role === "user");
			const user = context.messages[userIndex];
			if (user?.role !== "user") throw new Error("MCP invocation fixture requires a user command");
			const text = typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("");
			if (!text.startsWith("FIXTURE_MCP_CALL ")) throw new Error("MCP invocation fixture only accepts scripted calls");
			const request = JSON.parse(text.slice("FIXTURE_MCP_CALL ".length)) as { tool: string; args: ToolCall["arguments"] };
			const completed = context.messages.slice(userIndex + 1).some((message) => message.role === "assistant");
			const stream = createAssistantMessageEventStream();
			const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "pending", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			stream.push({ type: "start", partial: output });
			if (!completed) {
				const call: ToolCall = { type: "toolCall", id: `fixture-${++sequence}`, name: request.tool, arguments: {} };
				output.content.push(call);
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
				call.arguments = request.args;
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(request.args), partial: output });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
				output.stopReason = "toolUse";
				stream.push({ type: "done", reason: "toolUse", message: output });
			} else {
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				output.content[0] = { type: "text", text: "fixture complete" };
				stream.push({ type: "text_delta", contentIndex: 0, delta: "fixture complete", partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: "fixture complete", partial: output });
				output.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: output });
			}
			stream.end();
			return stream;
		},
	});
	pi.registerCommand("fixture-mcp-registry", {
		description: "Inspect actual native registrations for restriction tests",
		handler: async () => {
			pi.sendMessage({ customType: "fixture-mcp-registry", content: "native MCP registry", display: true, details: { tools: pi.getAllTools().filter((tool) => tool.sourceInfo?.path === "builtin:mcp").map((tool) => ({ name: tool.name, exposure: tool.exposure })) } });
		},
	});
}
