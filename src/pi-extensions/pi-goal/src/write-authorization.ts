// write-authorization.ts — FT-89: who may command whose queue.
//
// The receiver decides, not the caller. The rule is derived from durable records —
// the lane records the fleet writes about itself — never from a field in the request,
// because a request that names its own authority is a request that can name it wrong.
//
// Default deny is the starting state, not a fallback: a caller this resolver cannot
// place is refused caller_unresolved and nothing is written. The tests prove the deny
// by showing the queue unchanged, not by showing the refusal code.

import type { WriteAuthorizer } from "./receiver-actions.js";

/** What a lane record says about one session. Resolved from disk, never from the request. */
export interface LaneIdentity {
  sessionId: string | null;
  sessionPath: string | null;
  lane: string | null;
  /** "leader", "worker", or null when the record does not say. */
  mode: string | null;
  workspaceId: string | null;
}

/** Where the caller's identity comes from. Injected so the rule is testable without
 *  touching the fleet's real records, and so a caller cannot supply its own. */
export interface IdentitySource {
  resolveCaller(request: Record<string, unknown>): LaneIdentity | null;
}

function refusal(code: string, message: string, detail?: Record<string, unknown>) {
  return { code, message, ...(detail ? { detail } : {}) };
}

function sameSession(a: LaneIdentity, b: LaneIdentity): boolean {
  return Boolean(a.sessionId && b.sessionId && a.sessionId === b.sessionId);
}

/**
 * The rule, in the order it must be applied:
 *
 *   1. a lane addressing *itself* over the socket is refused. The claim "I am this
 *      session" cannot be verified from a request, and nothing needs it: a lane
 *      changes its own queue with its own tools. Accepting it would be the one
 *      path a caller could take by claiming an identity it does not hold;
 *   2. an unresolvable caller is refused `caller_unresolved`;
 *   3. the caller must be a leader (`caller_role_not_leader`);
 *   4. the target must be a worker (`target_role_not_worker`) — a leader is not a
 *      worker's to command, even from the same workspace;
 *   5. both must resolve to the same workspace (`not_my_worker`), which is what
 *      "its own workers" means in the fleet's own terms.
 */
export function createWriteAuthorizer(options: {
  target: LaneIdentity;
  source: IdentitySource;
}): WriteAuthorizer {
  return {
    authorize(request) {
      const caller = options.source.resolveCaller(request);
      if (caller && sameSession(caller, options.target)) {
        return {
          ok: false,
          refusal: refusal(
            "self_addressed_write",
            "a lane changes its own queue locally; a write arriving over the socket must come from another lane",
          ),
        };
      }
      if (!caller || !caller.sessionId || !caller.lane) {
        return {
          ok: false,
          refusal: refusal(
            "caller_unresolved",
            "this receiver cannot place the caller in a lane, so it changes nothing",
          ),
        };
      }
      if (caller.mode !== "leader") {
        return {
          ok: false,
          refusal: refusal("caller_role_not_leader", "a queue is commanded by a leader", {
            callerLane: caller.lane,
            callerMode: caller.mode,
          }),
        };
      }
      if (!options.target.sessionId || !options.target.lane || !options.target.mode) {
        return {
          ok: false,
          refusal: refusal(
            "target_unresolved",
            "this receiver cannot place its own session in a lane, so it cannot say whether a write is legitimate",
            { targetLane: options.target.lane, targetMode: options.target.mode },
          ),
        };
      }
      if (options.target.mode !== "worker") {
        return {
          ok: false,
          refusal: refusal("target_role_not_worker", "only a worker's queue is commanded from outside", {
            targetMode: options.target.mode,
          }),
        };
      }
      const sameWorkspace =
        Boolean(caller.workspaceId) && caller.workspaceId === options.target.workspaceId;
      if (!sameWorkspace) {
        return {
          ok: false,
          refusal: refusal("not_my_worker", "that worker is not in the caller's own workspace", {
            callerWorkspace: caller.workspaceId,
            targetWorkspace: options.target.workspaceId,
          }),
        };
      }
      return { ok: true };
    },
  };
}
