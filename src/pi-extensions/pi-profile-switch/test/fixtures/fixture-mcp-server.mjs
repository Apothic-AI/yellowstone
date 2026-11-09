#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

// Env-driven startup marker: tests set FIXTURE_MCP_START_MARKER to a file
// path and assert the file stays absent when a server must never connect.
const startMarker = process.env.FIXTURE_MCP_START_MARKER;
if (startMarker) {
	fs.writeFileSync(startMarker, "started");
}

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: false,
});

rl.on("close", () => {
	process.exit(0);
});

let currentTools = [
	{
		name: "search",
		description: "Search items",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" } },
		},
	},
	{
		name: "delete",
		description: "Delete item",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
		},
	},
];

const dynamicFile = process.env.FIXTURE_DYNAMIC_TOOLS_FILE;

function checkForToolUpdates() {
	if (!dynamicFile) return false;
	try {
		if (fs.existsSync(dynamicFile)) {
			const content = fs.readFileSync(dynamicFile, "utf8");
			const parsed = JSON.parse(content);
			if (Array.isArray(parsed)) {
				const oldJson = JSON.stringify(currentTools);
				const newJson = JSON.stringify(parsed);
				if (oldJson !== newJson) {
					currentTools = parsed;
					process.stdout.write(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "notifications/tools/list_changed",
						}) + "\n",
					);
					return true;
				}
			}
		}
	} catch {
		// Ignore read/parse errors during partial writes
	}
	return false;
}

if (dynamicFile) {
	// Initial check in case file already exists
	checkForToolUpdates();
	const watcher = fs.watchFile(dynamicFile, { interval: 50 }, () => {
		checkForToolUpdates();
	});
	watcher.unref();
}

rl.on("line", (line) => {
	checkForToolUpdates();

	let req;
	try {
		req = JSON.parse(line);
	} catch {
		return;
	}
	if (!req || typeof req !== "object") return;
	const { id, method, params } = req;

	if (method === "initialize") {
		process.stdout.write(
			JSON.stringify({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2024-11-05",
					capabilities: { tools: { listChanged: true } },
					serverInfo: { name: "fixture-mcp", version: "1.0.0" },
				},
			}) + "\n",
		);
	} else if (method === "notifications/initialized") {
		// client notification, no response
	} else if (method === "tools/list") {
		process.stdout.write(
			JSON.stringify({
				jsonrpc: "2.0",
				id,
				result: {
					tools: currentTools,
				},
			}) + "\n",
		);
	} else if (method === "tools/call") {
		const callsFile = process.env.FIXTURE_MCP_CALLS_FILE;
		if (callsFile) fs.appendFileSync(callsFile, JSON.stringify({ name: params?.name, arguments: params?.arguments }) + "\n");
		const toolName = params?.name;
		const knownTool = currentTools.find((t) => t.name === toolName);
		if (knownTool) {
			const argStr = params?.arguments?.query ?? params?.arguments?.id ?? params?.arguments?.param ?? "";
			process.stdout.write(
				JSON.stringify({
					jsonrpc: "2.0",
					id,
					result: {
						content: [{ type: "text", text: `${toolName}-result:${argStr}` }],
					},
				}) + "\n",
			);
		} else {
			process.stdout.write(
				JSON.stringify({
					jsonrpc: "2.0",
					id,
					error: { code: -32601, message: `Tool not found on server: ${toolName}` },
				}) + "\n",
			);
		}
	} else if (method === "ping") {
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\n");
	}
});
