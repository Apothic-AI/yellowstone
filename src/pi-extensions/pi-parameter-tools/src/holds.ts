// holds.ts — the fleet's holds, as this package sees them.
//
// Behold holds a workspace and reserves a tab and a pane. A lane inside a held
// workspace, or in a reserved tab, is not read by the roster and does not report.
// This package keeps that boundary: a lane in a held place does not change its own
// parameters either, and a request that names a held place is refused.
//
// The ids are the fleet's, not this package's invention: they are the same ids
// Behold's guard carries (`behold/guard.py`), kept here so the two agree without one
// package depending on the other.

/** The held workspace. */
export const HELD_WORKSPACES: readonly string[] = ["w2"];

/** The reserved tab. */
export const RESERVED_TABS: readonly string[] = ["wE:t19"];

/** The reserved pane. */
export const RESERVED_PANES: readonly string[] = ["wE:t19"];

/** Is this lane in a held or reserved place? */
export function isHeldPlace(handles: {
	workspaceId?: string | null;
	tabId?: string | null;
	paneId?: string | null;
}): boolean {
	if (handles.workspaceId && HELD_WORKSPACES.includes(handles.workspaceId)) return true;
	if (handles.tabId && RESERVED_TABS.includes(handles.tabId)) return true;
	if (handles.paneId && RESERVED_PANES.includes(handles.paneId)) return true;
	// A pane id names its workspace: `w2:p1` is in the held workspace `w2`.
	const paneWorkspace = handles.paneId?.includes(":") ? handles.paneId.split(":", 1)[0] : null;
	if (paneWorkspace && HELD_WORKSPACES.includes(paneWorkspace)) return true;
	return false;
}
