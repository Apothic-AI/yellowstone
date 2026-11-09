// Container test: prevention must make a lane's session path canonical from launch.
//
// Runs pi's real session-manager code (mounted read-only at /pi) inside a container,
// with production session files (mounted read-only at /store) for the listing checks.
// No network, no auth, no live lane -- this is the deterministic half of the proof;
// the live-lane half is recorded in VERIFICATION.md.
//
// Exit 0 = every assertion held. Exit 1 = at least one failed, named on stdout.
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, existsSync, rmSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

const { SessionManager, getDefaultSessionDir } = await import("/pi/dist/core/session-manager.js");

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) console.log(`       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}
const T = mkdtempSync(join(tmpdir(), "spt-"));
const CWD = join(T, "lane");
mkdirSync(CWD, { recursive: true });

// The launch stack: pil computes SESSION_STORE from PI_AGENT_DIR and passes pi a
// --session-dir. A stub `pi` reports the argv it would have received.
function pilArgs(env, args, cwd) {
  const out = execFileSync("bash", ["/pil/pil", ...args], {
    cwd, encoding: "utf8",
    env: { PATH: `/work/stub:/usr/local/bin:/usr/bin:/bin`, ...env },
  });
  return out.split("\n").filter((s) => s !== "");
}
const INST = join(T, "instances", "launch-abc123");
mkdirSync(INST, { recursive: true });

// 1. A bare launch must hand pi the canonical, cwd-scoped session dir -- and it must
//    be exactly pi's own default for this cwd, or sessions land where /resume is not
//    looking. getDefaultSessionDirPath is the authority; pil must agree with it.
const bare = pilArgs({ PI_AGENT_DIR: INST }, [], CWD);
check("bare launch: first flag is --session-dir", bare[0], "--session-dir");
check("bare launch: dir == pi's own default for this cwd",
  bare[1], getDefaultSessionDir(CWD, INST));
check("bare launch: no --session invented", bare.includes("--session"), false);

// 2. A caller's explicit --session-dir is never overridden.
const explicit = pilArgs({ PI_AGENT_DIR: INST }, ["--session-dir", "/custom/dir"], CWD);
check("explicit --session-dir preserved", explicit, ["--session-dir", "/custom/dir"]);

// 3. A dead instance pin is remapped to the store when a durable copy exists, and
//    dropped when it does not -- never handed to pi as an ephemeral path.
const store = join(T, "sessions"); // SESSION_STORE == $PI_AGENT_DIR/sessions
const enc = basename(getDefaultSessionDir(CWD, INST)); // --<cwd>-- component, from pi itself
const storeDir = join(store, enc);
mkdirSync(storeDir, { recursive: true });
const live = join(storeDir, "2026-01-01T00-00-00Z_abc.jsonl");
copyFileSync(join("/store", readdirSync("/store").find((d) => d === "--home-bitnom-.overlord--"),
  readdirSync(join("/store", "--home-bitnom-.overlord--"))[0]), live);
const pin = join(INST, "sessions", enc, basename(live));
const remapped = pilArgs({ PI_AGENT_DIR: T }, ["--session", pin], CWD);
check("dead instance pin: remapped to the durable copy",
  remapped, ["--session-dir", join(T, "sessions", enc), "--session", live]);
const dropped = pilArgs({ PI_AGENT_DIR: T }, ["--session", join(INST, "sessions", enc, "missing.jsonl")], CWD);
check("dead instance pin without a copy: --session dropped",
  dropped, ["--session-dir", join(T, "sessions", enc)]);

// 4. Listing stays scoped to the lane's own cwd. Two cwds' sessions in one store
//    must not bleed into each other's /resume.
const alpha = join(T, "alpha"), beta = join(T, "beta");
mkdirSync(alpha); mkdirSync(beta);
cpSync(join("/store", "--home-bitnom-.overlord--"), alpha, { recursive: true });
cpSync(join("/store", "--home-bitnom-Documents-Comms--"), beta, { recursive: true });
const listAlpha = await SessionManager.list("/home/bitnom/.overlord", alpha);
const listBeta = await SessionManager.list("/home/bitnom/Documents/Comms", beta);
const alphaNames = new Set(listAlpha.map((s) => basename(s.path)));
const betaNames = new Set(listBeta.map((s) => basename(s.path)));
check("listing alpha returns only alpha sessions",
  listAlpha.every((s) => s.cwd === "/home/bitnom/.overlord"), true);
check("listing beta returns only beta sessions",
  listBeta.every((s) => s.cwd === "/home/bitnom/Documents/Comms"), true);
check("the two listings do not overlap",
  [...alphaNames].some((n) => betaNames.has(n)), false);
check("listing is non-empty (fixtures actually loaded)",
  listAlpha.length > 0 && listBeta.length > 0, true);

// 5. The reported path -- what herdr persists -- is the file inside the passed dir.
//    This is the invariant the whole fix rests on.
const target = join(alpha, [...alphaNames][0]);
const mgr = SessionManager.open(target);
check("opened file is the canonical one", mgr.getSessionFile(), target);
// Even if herdr reconstructs a resume command and bypasses pil entirely, a persisted
// STORE path is safe on its own: the derived dir is the durable one.
check("a store path alone derives the durable dir", mgr.getSessionDir(), alpha);
check("--session-dir overrides the file's parent for /new",
  SessionManager.open(target, storeDir).getSessionDir(), storeDir);
check("without --session-dir the parent IS the dir (the 2026-11-03 bug)",
  SessionManager.open(join(INST, "sessions", enc, "x.jsonl")).getSessionDir(),
  join(INST, "sessions", enc));

// 6. The outage reproduced: replay a pin whose directory was reclaimed. pi resolves
//    lexically, so the path is recreated empty rather than failing loudly.
const dead = join(T, "reclaimed", "sessions", enc, "pinned.jsonl");
const deadMgr = SessionManager.open(dead);
check("dead pin resolves to the dead parent (not the store)", deadMgr.getSessionDir(), dead.slice(0, -"pinned.jsonl".length - 1));
check("dead pin does not magically find the durable copy", deadMgr.getSessionFile(), dead);

console.log(failures === 0 ? "\nall container assertions passed" : `\n${failures} assertion(s) failed`);
rmSync(T, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
