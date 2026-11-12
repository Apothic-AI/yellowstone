// session-file.ts — read one thing out of a session file.
//
// A pi session file is JSONL whose first line is the session header, and the header
// carries the session's id. That is the whole of what this module reads: the first
// line, capped, and nothing else. No entry is parsed, no session is opened, and the
// file is never written.

import { closeSync, openSync, readSync } from "node:fs";

const HEADER_CAP_BYTES = 4096;

/**
 * The session id in a session file's header, or null when there is none.
 *
 * The id is read from the first line only, and the read is capped: a session file is
 * a conversation, and this is not a conversation reader.
 */
export function readSessionHeaderId(sessionPath: string): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(sessionPath, "r");
		const buffer = Buffer.alloc(HEADER_CAP_BYTES);
		const read = readSync(fd, buffer, 0, HEADER_CAP_BYTES, 0);
		const firstLine = buffer.subarray(0, read).toString("utf8").split("\n", 1)[0] ?? "";
		if (!firstLine.trim().startsWith("{")) return null;
		const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
		if (header.type !== "session") return null;
		return typeof header.id === "string" && header.id ? header.id : null;
	} catch {
		// A missing or unreadable file names no session.
		return null;
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// Closing is best effort.
			}
		}
	}
}
