import { execFile } from "node:child_process";

import type { ProfileDefinition } from "../../src/profile-catalog.ts";
import type { ActivationPlan } from "../../src/profile-resolver.ts";

/** Vitest's SSR import.meta lacks resolve(). Exercise the installed native
 *  thinking predicate through the actual resolver under Node instead. */
export function resolveModelProfileInNode(definition: ProfileDefinition): Promise<ActivationPlan> {
	const resolverUrl = new URL("../../src/profile-resolver.ts", import.meta.url).href;
	const extensionsUrl = new URL("../../src/extension-discovery.ts", import.meta.url).href;
	const script = `
		const { resolveProfile } = await import(process.argv[1]);
		const { DiscoveredExtensions } = await import(process.argv[2]);
		const definition = JSON.parse(process.argv[3]);
		const plan = await resolveProfile({
			profile: { name: "review", source: "global", definition },
			skills: [],
			extensions: new DiscoveredExtensions([], [], []),
		});
		process.stdout.write(JSON.stringify(plan));
	`;
	return new Promise((resolve, reject) => {
		const child = execFile(
			process.execPath,
			["--input-type=module", "-e", script, resolverUrl, extensionsUrl, JSON.stringify(definition)],
			{ timeout: 30_000 },
			(error, stdout, stderr) => {
				if (error !== null) {
					reject(new Error(`native model resolver subprocess failed: ${error.message}\n${stderr}`));
					return;
				}
				try {
					resolve(JSON.parse(stdout) as ActivationPlan);
				} catch (error) {
					reject(new Error(`native model resolver returned invalid JSON: ${String(error)}`));
				}
			},
		);
		child.stdin?.end();
	});
}
