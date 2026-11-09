/**
 * Shared JSON-file reading for pi-profile's file-backed stores (catalog,
 * runtime state). Each store maps read failures to its own error policy
 * (loud CatalogError vs. quiet state fallback); this helper only classifies
 * the outcome.
 */

import { readFile } from "node:fs/promises";

export type JsonFileResult =
	| { ok: true; value: unknown }
	| { ok: false; reason: "missing" | "invalid" };

/** Reads and parses a JSON file. Unexpected I/O errors (permissions etc.)
 *  propagate — only absence and malformed JSON are classified. */
export async function readJsonFile(filePath: string): Promise<JsonFileResult> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ok: false, reason: "missing" };
		}
		throw error;
	}
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch {
		return { ok: false, reason: "invalid" };
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
