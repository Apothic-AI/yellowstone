import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Native RPC has no built-in /reload command. This calls the same native
 *  command-context operation used by the profile extension, without profiles. */
export default function nativeReload(pi: ExtensionAPI): void {
	pi.registerCommand("fixture-native-reload", {
		description: "Reload native resources for lifecycle comparison",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await ctx.reload();
		},
	});
}
