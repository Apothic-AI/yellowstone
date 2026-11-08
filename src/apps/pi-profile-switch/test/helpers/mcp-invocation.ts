import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RpcDriver } from "./rpc-driver.ts";

export const MCP_INVOCATION_ARGS = ["--mode", "rpc", "--no-session", "-e", path.resolve("test/fixtures/mcp-invocation-provider.ts"), "--model", "profile-mcp-invocation/scripted"];

export function localMcpServer(marker?: string, calls?: string, dynamicTools?: string): Record<string, unknown> {
	return { command: process.execPath, args: [path.resolve("test/fixtures/fixture-mcp-server.mjs")], env: { ...(marker ? { FIXTURE_MCP_START_MARKER: marker } : {}), ...(calls ? { FIXTURE_MCP_CALLS_FILE: calls } : {}), ...(dynamicTools ? { FIXTURE_DYNAMIC_TOOLS_FILE: dynamicTools } : {}) } };
}

export interface NativeToolResult {
	toolName: string;
	isError: boolean;
	content: Array<{ type: string; text?: string }>;
	details?: { loaded?: string[] };
}

/** Run a real native tool turn, waiting for completion rather than prompt acceptance. */
export async function invokeNativeTool(driver: RpcDriver, tool: string, args: Record<string, unknown>): Promise<NativeToolResult> {
	const offset = driver.messages.length;
	const settled = driver.waitFor((message) => (message as { type?: string }).type === "agent_settled" && driver.messages.indexOf(message) >= offset, 30_000);
	const prompt = driver.send({ type: "prompt", message: `FIXTURE_MCP_CALL ${JSON.stringify({ tool, args })}` }, 30_000).then((response) => {
		if (!response.success) throw new Error(`native prompt rejected: ${response.error}`);
		return response;
	});
	await Promise.all([prompt, settled]);
	const result = driver.messages.slice(offset).map((record) => record as { type?: string; message?: NativeToolResult & { role?: string } }).find((record) => record.type === "message_end" && record.message?.role === "toolResult" && record.message.toolName === tool)?.message;
	if (!result) throw new Error(`native turn produced no result for ${tool}: ${JSON.stringify(driver.messages.slice(offset))}`);
	return result;
}

export async function mcpCalls(file: string): Promise<Array<{ name: string; arguments: unknown }>> {
	if (!existsSync(file)) return [];
	return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
