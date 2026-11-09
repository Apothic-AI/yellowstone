/**
 * Types for the plain-JS install-time seeder (bin/postinstall.js), which
 * stays dependency-free and cannot ship TypeScript.
 */

export interface InstallResult {
	path: string;
	written: boolean;
	/** Present when skipped to avoid shadowing a legacy catalog. */
	skipped?: "legacy-catalog-present";
}

export function installDefaultProfiles(options?: { env?: NodeJS.ProcessEnv }): Promise<InstallResult>;

export function installProfileConfigSkill(options?: { env?: NodeJS.ProcessEnv }): Promise<InstallResult>;
