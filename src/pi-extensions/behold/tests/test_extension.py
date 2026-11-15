"""The pi extension: a static contract, and — where node is available — a real run.

The static tests always run: they read the source and assert the promises the extension
makes about itself (no prompt text, no session reopen, no JSONL parsing, an allowlist
that matches the cache's, and no write without an admission map).

The behavioural tests run the extension's pure functions under node with TypeScript
stripping, and check that a spool record written by the extension is one the Python cache
actually ingests. They are skipped when node is not installed: the suite stays
standard-library only, and the static contract still holds without them.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from tests.helpers import ROOT

sys.path.insert(0, ROOT)

from behold import admission as admission_mod  # noqa: E402
from behold import cache as cache_mod  # noqa: E402
from behold import guard  # noqa: E402

EXTENSION = os.path.join(ROOT, "pi-extension", "behold-state.ts")
NODE = shutil.which("node")


def source() -> str:
    with open(EXTENSION, "r", encoding="utf-8") as fh:
        return fh.read()


def code_only() -> str:
    """The extension's source with its comments stripped.

    The comments say what the extension does *not* do, so a naive word scan would find
    "messages" and "JSONL" in the prose that promises never to read them. The scan has to
    look at the code.
    """
    text = source()
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", " ", text)
    return text


class TestExtensionStatic(unittest.TestCase):
    def test_the_extension_ships_in_the_repository(self) -> None:
        self.assertTrue(os.path.exists(EXTENSION), EXTENSION)
        self.assertTrue(os.path.basename(EXTENSION) == "behold-state.ts")

    def test_it_never_reads_a_prompt_a_message_or_a_credential(self) -> None:
        text = code_only()
        # `pending_messages` is an allowlisted field name, so the scan looks for the
        # identifiers that would actually carry content.
        for needle in ("getMessages", "apiKey", "api_key", "auth.json", "credentials",
                       ".skills", "rooms", "bead", "toolArguments", "tool_call",
                       "appendFile", "child_process", "spawn(",
                       "createConnection", "net."):
            self.assertNotIn(needle, text, f"the extension must not touch {needle!r}")

    def test_it_reads_only_the_admission_map_its_own_spool_file_and_proc(self) -> None:
        # Every read is named: the published admission map, two /proc entries that
        # identify this process (the boot id and its start time), and the lane's own
        # spool **directory** (to continue its sequence). No other file is read.
        text = code_only()
        self.assertEqual(text.count("readFileSync"), 3)
        self.assertEqual(text.count("readdirSync"), 2)
        for needle in ("DENY_FILE_NAME", "/proc/sys/kernel/random/boot_id",
                       "/proc/self/stat", "INBOX_DIRNAME"):
            self.assertIn(needle, text, needle)
        # and no fleet store, no session file, no settings file
        for needle in (".pi/", "settings.json", "auth.json", "profiles/"):
            self.assertNotIn(needle, text, needle)

    def test_it_does_not_reopen_a_session_or_parse_the_jsonl(self) -> None:
        text = code_only()
        for needle in ("--mode rpc", "--session", ".jsonl", "JSONL"):
            self.assertNotIn(needle, text, f"the extension must not use {needle!r}")

    def test_it_stores_no_environment_values(self) -> None:
        # The socket path and the env flag are environment values: they are not read and
        # not stored. The pane/workspace/tab ids are identity handles and are.
        text = code_only()
        for needle in ("HERDR_SOCKET_PATH", "HERDR_ENV", "PI_PROFILE", "PI_CODING_AGENT_DIR"):
            self.assertNotIn(needle, text, f"the extension must not read {needle!r}")
        for needle in ("HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID"):
            self.assertIn(needle, text, f"the extension needs the {needle} handle")

    def test_the_allowlist_matches_the_cache(self) -> None:
        text = source()
        match = re.search(r"export const ALLOWED_STATE_KEYS = \[(.*?)\] as const;",
                          text, re.S)
        self.assertIsNotNone(match, "the allowlist is not where the contract expects it")
        keys = re.findall(r'"([a-z0-9_]+)"', match.group(1))
        self.assertEqual(sorted(keys), sorted(cache_mod.ALLOWED_STATE_KEYS))

    def test_the_record_version_matches_the_cache(self) -> None:
        text = source()
        match = re.search(r"export const STATE_RECORD_VERSION = (\d+);", text)
        self.assertIsNotNone(match)
        self.assertEqual(int(match.group(1)), cache_mod.STATE_RECORD_VERSION)

    def test_the_spool_naming_matches_the_cache(self) -> None:
        text = source()
        self.assertIn('replace(/[^A-Za-z0-9._-]/g, "_")', text)
        self.assertTrue(".tab-" in text, "missing: .tab-")
        # and the cache uses the same spelling
        self.assertEqual(cache_mod.spool_file_name("w1A:p1"), "pane-w1A_p1.json")
        self.assertEqual(cache_mod.spool_file_name("w1A:p1", "w1A:t1"),
                         "pane-w1A_p1.tab-w1A_t1.json")
        self.assertEqual(cache_mod.pane_id_from_spool_name("pane-w1A_p1.json"), "w1A:p1")
        self.assertEqual(cache_mod.pane_and_tab_from_spool_name("pane-w1A_p1.tab-w1A_t1.json"),
                         ("w1A:p1", "w1A:t1"))

    def test_it_needs_no_setup_and_can_be_turned_off(self) -> None:
        text = source()
        # the defaults: BEHOLD_STATE_DIR, then BEHOLD_CACHE_DB's directory, then the
        # standard path. No mandatory setup.
        self.assertTrue("BEHOLD_STATE_DIR" in text, "missing: BEHOLD_STATE_DIR")
        self.assertTrue("BEHOLD_CACHE_DB" in text, "missing: BEHOLD_CACHE_DB")
        self.assertIn('".local", "state", "behold"', text)
        self.assertIn('BEHOLD_STATE_ENABLED") !== "0"', text)

    def test_it_honors_the_published_admission_map(self) -> None:
        text = source()
        self.assertIn("denied-lanes.json", text)
        self.assertTrue("readAdmission" in text, "missing: readAdmission")
        self.assertTrue("admissionAllows" in text, "missing: admissionAllows")
        self.assertTrue("denied_workspaces" in text, "the deny list is missing")
        self.assertTrue("reserved_panes" in text, "missing: reserved_panes")
        self.assertTrue("reserved_tabs" in text, "missing: reserved_tabs")
        self.assertTrue("pane_tab" in text, "missing: pane_tab")

    def test_it_writes_nothing_without_a_usable_admission_map(self) -> None:
        # Fail closed: a missing, malformed, wrong-version or stale map means the reporter
        # cannot establish admission, and it writes nothing.
        text = code_only()
        self.assertIn("if (!admission.map) return;", text)
        self.assertIn("if (!decision.allowed || !decision.tab) return;", text)

    def test_it_names_its_incarnation_and_counts_its_own_sequence(self) -> None:
        text = source()
        self.assertTrue("incarnation_start_ticks" in text, "missing: incarnation_start_ticks")
        self.assertTrue("boot_id" in text, "missing: boot_id")
        self.assertTrue("incarnation_boot_epoch" in text, "missing: incarnation_boot_epoch")
        # the sequence is per incarnation, seeded from the lane's own spool file
        self.assertTrue("lastSeq" in text, "missing: lastSeq")
        self.assertTrue("seq += 1" in text, "missing: seq += 1")

    def test_it_writes_atomically_and_never_throws_into_a_turn(self) -> None:
        text = source()
        self.assertTrue("renameSync" in text, "missing: renameSync")
        self.assertTrue("catch" in text, "missing: catch")


HARNESS = """
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import {
  ADMISSION_VERSION,
  ALLOWED_STATE_KEYS,
  DENY_FILE_NAME,
  STATE_RECORD_VERSION,
  admissionAllows,
  collectState,
  enabled,
  incarnationOf,
  intervalMs,
  lastSeq,
  monoEpoch,
  readAdmission,
  sanitizeState,
  sessionIdOf,
  spoolFileCount,
  spoolFileName,
  stateDir,
  writeSpool,
  default as install,
} from "%(extension)s";

process.env.HERDR_PANE_ID = "w1A:p1";
process.env.HERDR_WORKSPACE_ID = "w1A";
process.env.HERDR_TAB_ID = "w1A:t1";
const STATE_DIR = "%(state_dir)s";
if (STATE_DIR) process.env.BEHOLD_STATE_DIR = STATE_DIR;

const ctx = {
  cwd: "/tmp/lane",
  model: { id: "acme-fast-1", provider: "acme" },
  thinkingLevel: "medium",
  sessionManager: {
    getSessionFile: () => "/tmp/sessions/x.jsonl",
    getSessionId: () => "aaaaaaaa-0000-4000-8000-000000000001",
    getLeafId: () => "entry-7",
  },
  isIdle: () => true,
  hasPendingMessages: () => false,
  getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0.05 }),
  getSystemPrompt: () => "SENTINEL_PROMPT_BODY you are a helpful assistant",
};

const state = collectState(ctx);
const sanitized = sanitizeState({
  model_id: "acme-fast-1",
  prompt: "SENTINEL_PROMPT_BODY",
  messages: ["SENTINEL_SESSION_MESSAGE"],
  api_key: "SENTINEL_API_KEY",
});

// Install the extension and fire the events: this is the real publish path. With
// `fire_turn` false the extension is installed, the session starts, and then NOTHING
// happens -- which is what an idle lane looks like. Only the lifecycle timer can make
// it report.
const handlers = {};
install({ on: (event, fn) => { handlers[event] = fn; } });
if (%(fire_session)s && handlers["session_start"]) handlers["session_start"]({}, ctx);
if (%(fire_turn)s && handlers["turn_end"]) handlers["turn_end"]({}, ctx);
if ("%(wait_ms)s") { await new Promise((resolve) => setTimeout(resolve, %(wait_ms)s)); }

const incarnation = incarnationOf();
const admission = readAdmission(STATE_DIR || stateDir());
const out = {
  allowed: ALLOWED_STATE_KEYS,
  version: STATE_RECORD_VERSION,
  admissionVersion: ADMISSION_VERSION,
  state,
  sanitized,
  sessionId: sessionIdOf(ctx),
  fileName: spoolFileName("w1A:p1"),
  fileNameWithTab: spoolFileName("w1A:p1", "w1A:t1"),
  fileNameWithIncarnation: spoolFileName("w1A:p1", "w1A:t1", "boot:1:2", 7),
  stateDir: stateDir(),
  enabled: enabled(),
  denyFileName: DENY_FILE_NAME,
  admission: admission.map ? { ok: true, reason: admission.reason } : { ok: false, reason: admission.reason },
  admissionReason: admission.reason,
  denied: admission.map
    ? admissionAllows(admission.map, "w2:p1", "w2:t1", "w2")
    : { allowed: false, reason: "no map" },
  deniedTab: admission.map
    ? admissionAllows(admission.map, "wE:p99", "wE:t19", "wE")
    : { allowed: false, reason: "no map" },
  admitted: admission.map
    ? admissionAllows(admission.map, "w1A:p1", "w1A:t1", "w1A")
    : { allowed: false, reason: "no map" },
  incarnation: incarnation,
  monoEpoch: monoEpoch(),
  intervalMs: intervalMs(),
  lastSeq: lastSeq(STATE_DIR || stateDir(), "w1A:p1", incarnation.id),
  spoolFiles: existsSync((STATE_DIR || stateDir()) + "/inbox")
    ? readdirSync((STATE_DIR || stateDir()) + "/inbox")
    : [],
};
%(extra)s
writeFileSync("%(out)s", JSON.stringify(out));
"""


#: A writer that runs in its own process, waits for a signal, and then writes. Two of
#: these, released at the same moment, are two reporters writing the same pane at the
#: same time -- the interleaving a sequential test cannot produce.
WRITER = """
import { existsSync, writeFileSync } from "node:fs";
import { writeSpool } from "%(extension)s";

const inc = {
  id: process.env.INC,
  bootId: process.env.INC.split(":")[0],
  startTicks: Number(process.env.INC.split(":")[2]),
  bootEpoch: 5000,
};
writeFileSync(process.env.READY, "ready");
let waited = 0;
while (!existsSync(process.env.GO) && waited < 60000) {
  waited += 10;
  const until = Date.now() + 10;
  while (Date.now() < until) { /* spin */ }
}
const target = writeSpool(process.env.BEHOLD_STATE_DIR, "w1A:p1", "w1A:t1", "session",
  { model_id: process.env.MODEL }, 1, Date.now() / 1000, inc);
if (!target) { process.exit(3); }
"""


#: A `/reload` inside the same process: the module is imported twice (two fresh module
#: instances, the same pid, so the same incarnation), with the pane moved in between.
#: The sequence belongs to the lane, so the second instance has to continue it.
RELOAD = """
import { existsSync } from "node:fs";

process.env.HERDR_PANE_ID = "w1A:p1";
process.env.HERDR_WORKSPACE_ID = "w1A";
process.env.HERDR_TAB_ID = "w1A:t1";

const ctx = {
  cwd: "/tmp/lane",
  model: { id: "acme-fast-1", provider: "acme" },
  thinkingLevel: "medium",
  sessionManager: {
    getSessionFile: () => "/tmp/sessions/x.jsonl",
    getSessionId: () => "aaaaaaaa-0000-4000-8000-000000000001",
    getLeafId: () => "entry-7",
  },
  isIdle: () => true,
  hasPendingMessages: () => false,
  getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0.05 }),
  getSystemPrompt: () => "SENTINEL_PROMPT_BODY you are a helpful assistant",
};

const first = await import("file://%(extension)s?reload=1");
const handlers1 = {};
first.default({ on: (event, fn) => { handlers1[event] = fn; } });
handlers1["turn_end"]({}, ctx);

// wait for the map to move the pane
while (!existsSync(process.env.GO)) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// the reload: a fresh module instance in the SAME process -- the same pid, so the same
// incarnation, with the counter starting from scratch
const second = await import("file://%(extension)s?reload=2");
const handlers2 = {};
second.default({ on: (event, fn) => { handlers2[event] = fn; } });
handlers2["turn_end"]({}, ctx);
"""


def run_node(extra: str = "", out_path: str = "", env: dict | None = None,
             state_dir: str = "", fire_turn: bool = True, fire_session: bool = False,
             wait_ms: int = 0) -> dict:
    """Run the extension's pure functions under node and return their results.

    ``fire_turn`` and ``fire_session`` are which pi events the harness fires, and
    ``wait_ms`` is how long the harness then waits -- which is how the **lifecycle
    timer** is exercised: with ``fire_turn=False`` the lane is idle after its session
    started, and only the timer can make it report.
    """
    with tempfile.TemporaryDirectory() as tmp:
        target = out_path or os.path.join(tmp, "out.json")
        harness = HARNESS % {"extension": EXTENSION, "extra": extra, "out": target,
                             "state_dir": state_dir,
                             "fire_turn": "true" if fire_turn else "false",
                             "fire_session": "true" if fire_session else "false",
                             "wait_ms": int(wait_ms)}
        script = os.path.join(tmp, "harness.mjs")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write(harness)
        run_env = {**os.environ}
        if env:
            run_env.update(env)
        proc = subprocess.run([NODE, script], capture_output=True, text=True, timeout=120,
                              env=run_env)
        if proc.returncode != 0:
            raise AssertionError(f"node harness failed: {proc.stderr[:2000]}")
        with open(target, "r", encoding="utf-8") as fh:
            return json.load(fh)


def write_admission(directory: str, *, version: int = admission_mod.ADMISSION_VERSION,
                    captured_at_epoch: float | None = None,
                    panes: dict[str, tuple[str, str]] | None = None,
                    mutate: dict | None = None) -> str:
    """Publish an admission map the way the roster does."""
    records = []
    for pane_id, (tab_id, workspace_id) in (panes or {
        "w1A:p1": ("w1A:t1", "w1A"),
        "w2:p1": ("w2:t1", "w2"),
        "wE:p99": ("wE:t19", "wE"),
    }).items():
        records.append({"pane_id": pane_id, "tab_id": tab_id, "workspace_id": workspace_id})
    published = admission_mod.build_map(
        policy=guard.Policy(), panes=records, topology_revision="test",
        captured_at_epoch=captured_at_epoch)
    payload = published.to_dict()
    if version != admission_mod.ADMISSION_VERSION:
        payload["version"] = version
    if mutate is not None:
        for key, value in mutate.items():
            if value is None:
                payload.pop(key, None)
            else:
                payload[key] = value
    path = os.path.join(directory, admission_mod.ADMISSION_FILE_NAME)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    return path


@unittest.skipUnless(NODE, "node is not installed: the static contract still holds")
class TestExtensionBehaviour(unittest.TestCase):
    def test_the_state_holds_only_allowlisted_scalars(self) -> None:
        result = run_node()
        state = result["state"]
        self.assertEqual(sorted(state), sorted(cache_mod.ALLOWED_STATE_KEYS))
        self.assertEqual(state["model_id"], "acme-fast-1")
        self.assertEqual(state["thinking_level"], "medium")
        self.assertTrue(state["idle"])
        self.assertFalse(state["pending_messages"])
        self.assertEqual(state["context_tokens"], 100)

    def test_it_reports_the_identity_handles_and_no_environment_values(self) -> None:
        result = run_node()
        state = result["state"]
        self.assertEqual(state["herdr_pane_id"], "w1A:p1")
        self.assertEqual(state["herdr_workspace_id"], "w1A")
        self.assertEqual(state["herdr_tab_id"], "w1A:t1")
        self.assertNotIn("herdr_socket_path", state)
        self.assertNotIn("herdr_env", state)

    def test_the_system_prompt_is_reduced_to_metadata(self) -> None:
        result = run_node()
        state = result["state"]
        self.assertNotIn("SENTINEL_PROMPT_BODY", json.dumps(state))
        self.assertIsInstance(state["system_prompt_length"], int)
        self.assertEqual(len(state["system_prompt_sha256"]), 16)

    def test_the_sanitizer_drops_forbidden_content(self) -> None:
        result = run_node()
        sanitized = result["sanitized"]
        self.assertEqual(sanitized, {"model_id": "acme-fast-1"})
        self.assertNotIn("SENTINEL", json.dumps(sanitized))

    def test_the_spool_file_name_matches_the_cache(self) -> None:
        result = run_node()
        self.assertEqual(result["fileName"], cache_mod.spool_file_name("w1A:p1"))
        self.assertEqual(result["fileNameWithTab"],
                         cache_mod.spool_file_name("w1A:p1", "w1A:t1"))

    def test_the_per_write_file_name_matches_the_cache(self) -> None:
        # The incarnation and the sequence number are in the name, so every write gets
        # its own file and a name is never reused.
        result = run_node()
        self.assertEqual(
            result["fileNameWithIncarnation"],
            cache_mod.spool_file_name("w1A:p1", "w1A:t1", "boot:1:2", 7))

    def test_the_state_directory_needs_no_setup(self) -> None:
        env = {k: v for k, v in os.environ.items()
               if k not in ("BEHOLD_STATE_DIR", "BEHOLD_CACHE_DB", "BEHOLD_STATE_ENABLED")}
        result = run_node(env=env)
        self.assertTrue(result["enabled"])
        self.assertEqual(result["stateDir"],
                         os.path.join(os.path.expanduser("~"), ".local", "state", "behold"))

    def test_the_state_directory_follows_the_cache_database(self) -> None:
        env = {k: v for k, v in os.environ.items()
               if k not in ("BEHOLD_STATE_DIR", "BEHOLD_CACHE_DB", "BEHOLD_STATE_ENABLED")}
        env["BEHOLD_CACHE_DB"] = "/tmp/behold-elsewhere/behold.db"
        result = run_node(env=env)
        self.assertEqual(result["stateDir"], "/tmp/behold-elsewhere")

    def test_the_reporter_can_be_turned_off(self) -> None:
        env = {k: v for k, v in os.environ.items()
               if k not in ("BEHOLD_STATE_DIR", "BEHOLD_CACHE_DB", "BEHOLD_STATE_ENABLED")}
        env["BEHOLD_STATE_ENABLED"] = "0"
        result = run_node(env=env)
        self.assertFalse(result["enabled"])

    def test_it_honors_the_published_admission_map(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp)
            result = run_node(state_dir=tmp)
            self.assertTrue(result["admission"]["ok"], result["admissionReason"])
            # a held workspace is refused
            self.assertFalse(result["denied"]["allowed"])
            self.assertIn("held_workspace:w2", result["denied"]["reason"])
            # a lane inside a reserved tab is refused
            self.assertFalse(result["deniedTab"]["allowed"])
            self.assertIn("reserved_tab:wE:t19", result["deniedTab"]["reason"])
            # and an ordinary lane is admitted
            self.assertTrue(result["admitted"]["allowed"])

    def test_a_missing_admission_map_writes_nothing(self) -> None:
        # Fail closed: without a map the reporter cannot establish admission.
        with tempfile.TemporaryDirectory() as tmp:
            result = run_node(state_dir=tmp)
            self.assertFalse(result["admission"]["ok"])
            self.assertIn("no admission map", result["admissionReason"])
            self.assertEqual(result["spoolFiles"], [])

    def test_a_malformed_or_foreign_admission_map_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, admission_mod.ADMISSION_FILE_NAME)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("{not json")
            result = run_node(state_dir=tmp)
            self.assertFalse(result["admission"]["ok"])
            self.assertEqual(result["spoolFiles"], [])
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp, version=99)
            result = run_node(state_dir=tmp)
            self.assertFalse(result["admission"]["ok"])
            self.assertIn("unsupported admission map version", result["admissionReason"])
            self.assertEqual(result["spoolFiles"], [])

    def test_a_stale_admission_map_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp, captured_at_epoch=1.0)
            result = run_node(state_dir=tmp)
            self.assertFalse(result["admission"]["ok"])
            self.assertIn("stale", result["admissionReason"])
            self.assertEqual(result["spoolFiles"], [])

    def test_a_refused_lane_is_not_written(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp)
            result = run_node(
                state_dir=tmp,
                extra=('process.env.HERDR_PANE_ID = "w2:p1";\n'
                       'process.env.HERDR_WORKSPACE_ID = "w2";\n'
                       'process.env.HERDR_TAB_ID = "w2:t1";\n'
                       'if (handlers["turn_end"]) handlers["turn_end"]({}, ctx);\n'))
            # the held lane wrote nothing; the admitted lane (fired first) did
            self.assertFalse(any("w2" in name for name in result["spoolFiles"]),
                             result["spoolFiles"])

    def test_the_incarnation_is_stable_and_names_this_process(self) -> None:
        result = run_node()
        incarnation = result["incarnation"]
        self.assertIn(":", incarnation["id"])
        self.assertTrue(incarnation["startTicks"] > 0)
        self.assertTrue(len(incarnation["bootId"]) > 0)
        # the monotone clock is close to the wall clock
        self.assertLess(abs(result["monoEpoch"] - time_now()), 120)

    def test_a_map_without_its_deny_lists_writes_nothing(self) -> None:
        # A missing deny list is a BROKEN map, not an empty one. The reporter writes
        # nothing: it cannot establish admission.
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp, mutate={"denied_workspaces": None})
            result = run_node(state_dir=tmp)
            self.assertFalse(result["admission"]["ok"])
            self.assertIn("deny lists", result["admissionReason"])
            self.assertEqual(result["spoolFiles"], [])

    def test_a_map_with_a_malformed_deny_list_writes_nothing(self) -> None:
        for value in ("w2", 42, ["w2", 7], ["../../etc/passwd"], ["w 2"]):
            with tempfile.TemporaryDirectory() as tmp:
                write_admission(tmp, mutate={"denied_workspaces": value})
                result = run_node(state_dir=tmp)
                self.assertFalse(result["admission"]["ok"], value)
                self.assertEqual(result["spoolFiles"], [], value)

    def test_a_map_with_an_incomplete_pane_mapping_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp, mutate={"pane_workspace": {"w2:p1": "w2"}})
            result = run_node(state_dir=tmp)
            self.assertFalse(result["admission"]["ok"])
            self.assertIn("mappings disagree", result["admissionReason"])
            self.assertEqual(result["spoolFiles"], [])

    def test_a_map_with_a_future_capture_time_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp, captured_at_epoch=time.time() + 3600)
            result = run_node(state_dir=tmp)
            self.assertFalse(result["admission"]["ok"])
            self.assertIn("future", result["admissionReason"])
            self.assertEqual(result["spoolFiles"], [])

    def test_a_map_with_a_non_finite_capture_time_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp)
            path = os.path.join(tmp, admission_mod.ADMISSION_FILE_NAME)
            with open(path, "r", encoding="utf-8") as fh:
                payload = fh.read()
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(payload.replace(
                    '"captured_at_epoch":',
                    '"captured_at_epoch": Infinity, "ignored":'))
            result = run_node(state_dir=tmp)
            self.assertFalse(result["admission"]["ok"])
            self.assertEqual(result["spoolFiles"], [])

    def test_a_pane_that_moved_to_an_admitted_tab_keeps_reporting(self) -> None:
        # The map is the current topology: the reporter writes under the MAP's tab, so a
        # pane that moved does not fall silent forever.
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp, panes={"w1A:p1": ("w1A:t9", "w1A")})
            result = run_node(state_dir=tmp)
            self.assertTrue(result["admission"]["ok"], result["admissionReason"])
            self.assertTrue(any(name.startswith("pane-w1A_p1.tab-w1A_t9.inc-")
                                for name in result["spoolFiles"]),
                            result["spoolFiles"])

    def test_a_pane_that_moved_into_a_reserved_tab_is_not_written(self) -> None:
        # The map says the pane is now in a reserved tab: the reporter writes nothing, and
        # the ingester would refuse the file before opening it.
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp, panes={"w1A:p1": ("wE:t19", "w1A")})
            result = run_node(state_dir=tmp)
            self.assertTrue(result["admission"]["ok"], result["admissionReason"])
            self.assertEqual(result["spoolFiles"], [])

    def test_a_lane_launched_in_a_reserved_tab_stays_silent(self) -> None:
        # The inherited handle is a reserved tab even though the map has moved the pane
        # out: the lane says nothing.
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp, panes={"w1A:p1": ("w1A:t1", "w1A")})
            result = run_node(state_dir=tmp, extra=(
                'process.env.HERDR_TAB_ID = "wE:t19";\n'
                'ctx.model = { id: "after-the-move", provider: "acme" };\n'
                'if (handlers["turn_end"]) handlers["turn_end"]({}, ctx);\n'
                'const dir = "%(state_dir)s/inbox";\n'
                'const names = readdirSync(dir).filter((n) => n.startsWith("pane-w1A_p1"));\n'
                'out.afterModel = JSON.parse(readFileSync(dir + "/" + names[0], "utf-8"))'
                '.state.model_id;\n'
            ) % {"state_dir": tmp})
            # the second write was refused: the file still holds the first record
            self.assertEqual(result["afterModel"], "acme-fast-1")

    def test_two_reporters_of_one_pane_never_share_a_file(self) -> None:
        # The old scheme kept ONE file per lane and replaced it: a read-modify-write
        # with no compare-and-swap, so two writers could interleave and the older one
        # could win the file before the first ingest. Now every write has its own name,
        # so the two writers cannot touch the same pathname at all.
        with tempfile.TemporaryDirectory() as tmp:
            out_path = os.path.join(tmp, "out.json")
            result = run_node(state_dir=tmp, out_path=out_path, extra=(
                'const older = { id: "boot:100:100", bootId: "boot", startTicks: 100, '
                'bootEpoch: 5000 };\n'
                'const newer = { id: "boot:100:300", bootId: "boot", startTicks: 300, '
                'bootEpoch: 5000 };\n'
                'const a = writeSpool("%(state_dir)s", "w1A:p9", "w1A:t9", "session", '
                '{ model_id: "newer-model" }, 5, Date.now() / 1000, newer);\n'
                'const b = writeSpool("%(state_dir)s", "w1A:p9", "w1A:t9", "session", '
                '{ model_id: "stale-model" }, 99, Date.now() / 1000, older);\n'
                'out.two = { a, b, files: readdirSync("%(state_dir)s/inbox") };\n'
            ) % {"state_dir": tmp})
            two = result["two"]
            self.assertNotEqual(two["a"], two["b"])
            names = [name for name in two["files"] if "w1A_p9" in name]
            self.assertEqual(len(names), 2, two)
            # neither write destroyed the other
            models = set()
            for name in names:
                with open(os.path.join(tmp, "inbox", name), encoding="utf-8") as fh:
                    models.add(json.load(fh)["state"]["model_id"])
            self.assertEqual(models, {"newer-model", "stale-model"})

    def test_two_overlapping_reporters_produce_two_files(self) -> None:
        """Two **processes** writing the same pane at the same time.

        The sequential test above cannot show the interleaving; this one can: both
        writers wait for the same signal, then write at the same moment. The property
        holds for every interleaving, because the two writers never touch the same
        pathname.
        """
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp)
            script = os.path.join(tmp, "writer.mjs")
            with open(script, "w", encoding="utf-8") as fh:
                fh.write(WRITER % {"extension": EXTENSION})
            go = os.path.join(tmp, "go")
            procs = []
            for index, (incarnation, model) in enumerate((
                    ("boot:100:100", "older-model"), ("boot:100:300", "newer-model"))):
                env = {**os.environ,
                       "BEHOLD_STATE_DIR": tmp,
                       "GO": go,
                       "READY": os.path.join(tmp, f"ready-{index}"),
                       "INC": incarnation,
                       "MODEL": model}
                procs.append(subprocess.Popen([NODE, script], env=env,
                                              stdout=subprocess.PIPE,
                                              stderr=subprocess.PIPE, text=True))
            deadline = time.time() + 60
            while time.time() < deadline:
                if all(os.path.exists(os.path.join(tmp, f"ready-{i}")) for i in (0, 1)):
                    break
                time.sleep(0.01)
            else:
                self.fail("the writers never became ready")
            with open(go, "w", encoding="utf-8") as fh:
                fh.write("go")
            for proc in procs:
                _out, err = proc.communicate(timeout=60)
                self.assertEqual(proc.returncode, 0, err)
            inbox = os.path.join(tmp, "inbox")
            names = [name for name in os.listdir(inbox) if "w1A_p1" in name]
            self.assertEqual(len(names), 2, names)
            self.assertEqual(len(set(names)), 2, names)

    def test_the_reporter_writes_by_default(self) -> None:
        # The reporter is functional by default: it writes against the admission map's
        # placement, which is the placement as of the last capture. The map's reserved
        # tab, reserved pane and held workspace are still refused (see the tests above),
        # and the reader refuses a moved or reserved lane's record before opening it.
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp)
            result = run_node(state_dir=tmp)
            self.assertTrue(result["enabled"])
            self.assertTrue(result["spoolFiles"], result["spoolFiles"])
            self.assertTrue(result["admission"]["ok"], result["admissionReason"])

    def test_an_idle_lane_reports_on_the_lifecycle_timer(self) -> None:
        """The bootstrap the review named: an idle lane has no event.

        The session starts (so the reporter has a context and a session id) and then
        nothing happens. The lifecycle timer re-reads the admission map and publishes
        the last observation, so the lane reports without an event -- which is what
        makes the roster's **first** map useful and what lets a lane resume after the
        map expires.
        """
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp)
            env = {**os.environ, "BEHOLD_STATE_INTERVAL_MS": "1000"}
            result = run_node(state_dir=tmp, env=env, fire_turn=False,
                              fire_session=True, wait_ms=2500)
            self.assertEqual(result["intervalMs"], 1000, result["intervalMs"])
            files = [name for name in result["spoolFiles"] if "w1A_p1" in name]
            self.assertTrue(files, result["spoolFiles"])
            # the record carries the observation's own time, not the tick's time
            with open(os.path.join(tmp, "inbox", files[0]), encoding="utf-8") as fh:
                record = json.load(fh)
            self.assertEqual(record["seq"], 1)
            self.assertIn("observed_at", record)

    def test_the_lifecycle_timer_is_cleared_on_shutdown(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp)
            env = {**os.environ, "BEHOLD_STATE_INTERVAL_MS": "1000"}
            result = run_node(state_dir=tmp, env=env, fire_turn=False,
                              fire_session=True, wait_ms=1200,
                               extra=(
                'const dir = "%(state_dir)s/inbox";\n'
                'out.filesBefore = readdirSync(dir);\n'
                'if (handlers["session_shutdown"]) handlers["session_shutdown"]({}, ctx);\n'
                'await new Promise((resolve) => setTimeout(resolve, 2500));\n'
                'out.filesAfter = readdirSync(dir);\n'
            ) % {"state_dir": tmp})
            before = len(result["filesBefore"])
            after = len(result["filesAfter"])
            # the shutdown event itself publishes once; the timer must not publish again
            self.assertLessEqual(after - before, 1,
                                 f"the timer kept running after the shutdown: "
                                 f"{result['filesBefore']} -> {result['filesAfter']}")

    def test_the_sequence_is_seeded_across_a_move_and_a_reload(self) -> None:
        """A pane that moved, and a module reload inside the same process.

        The record is written under the tab the MAP gives. The sequence belongs to the
        lane, not to the tab, so the seed has to look at the lane's records whichever
        tab they were written under. Seeding by the inherited tab would restart the
        counter at 1, and the cache would refuse the record (a sequence number that does
        not move forward freezes the lane's observation).
        """
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp, panes={"w1A:p1": ("w1A:t1", "w1A")})
            script = os.path.join(tmp, "reload.mjs")
            with open(script, "w", encoding="utf-8") as fh:
                fh.write(RELOAD % {"extension": EXTENSION})
            go = os.path.join(tmp, "go")
            env = {**os.environ, "BEHOLD_STATE_DIR": tmp, "GO": go}
            proc = subprocess.Popen([NODE, script], env=env, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True)
            # wait until the first record exists, then move the pane in the map
            inbox = os.path.join(tmp, "inbox")
            deadline = time.time() + 60
            while time.time() < deadline:
                if os.path.isdir(inbox) and os.listdir(inbox):
                    break
                time.sleep(0.01)
            self.assertTrue(os.path.isdir(inbox) and os.listdir(inbox),
                            "the first record never appeared")
            write_admission(tmp, panes={"w1A:p1": ("w1A:t9", "w1A")})
            with open(go, "w", encoding="utf-8") as fh:
                fh.write("go")
            _out, err = proc.communicate(timeout=60)
            self.assertEqual(proc.returncode, 0, err)
            names = sorted(os.listdir(inbox))
            self.assertEqual(len(names), 2, names)
            self.assertTrue(any(".tab-w1A_t1.inc-" in name and ".s1.json" in name
                                for name in names), names)
            self.assertTrue(any(".tab-w1A_t9.inc-" in name and ".s2.json" in name
                                for name in names), names)

    def test_the_spool_growth_is_bounded(self) -> None:
        # One file per write means the spool grows with the lane's event rate until the
        # roster ingests it. The bound is a refusal: the last observation stays, and the
        # lane goes quiet rather than filling the disk.
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp)
            out_path = os.path.join(tmp, "out.json")
            result = run_node(state_dir=tmp, out_path=out_path, extra=(
                'const inc = { id: "boot:100:100", bootId: "boot", startTicks: 100, '
                'bootEpoch: 5000 };\n'
                'let written = 0;\n'
                'for (let i = 1; i <= 300; i++) {\n'
                '  const target = writeSpool("%(state_dir)s", "w1A:p8", "w1A:t8", '
                '"session", { model_id: "m" }, i, Date.now() / 1000, inc);\n'
                '  if (target !== "") written += 1;\n'
                '}\n'
                'out.cap = { written, count: spoolFileCount("%(state_dir)s", '
                '"w1A:p8", inc.id) };\n'
            ) % {"state_dir": tmp})
            cap = result["cap"]
            self.assertEqual(cap["written"], 256, cap)
            self.assertEqual(cap["count"], 256, cap)

    def test_a_record_written_by_the_extension_is_ingested_by_the_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            write_admission(tmp)
            out_path = os.path.join(tmp, "out.json")
            result = run_node(state_dir=tmp, out_path=out_path)
            inbox = os.path.join(tmp, "inbox")
            self.assertTrue(os.path.isdir(inbox))
            files = os.listdir(inbox)
            self.assertEqual(len(files), 1, files)
            self.assertTrue(files[0].startswith(
                cache_mod.spool_file_name("w1A:p1", "w1A:t1").replace(".json", ".inc-")), files)
            admission = admission_mod.build_map(
                policy=guard.Policy(),
                panes=[{"pane_id": "w1A:p1", "tab_id": "w1A:t1", "workspace_id": "w1A"}],
                topology_revision="test")
            with cache_mod.Cache(os.path.join(tmp, "behold.db")) as cache:
                result_ingest = cache.ingest_inbox(inbox, admission_map=admission)
                self.assertEqual(result_ingest["written"], 1, result_ingest)
                read = cache.read_pi_state(
                    "w1A:p1", session_id="aaaaaaaa-0000-4000-8000-000000000001")
                self.assertEqual(read.state, cache_mod.FRESH)
                self.assertEqual(read.value["model_id"], "acme-fast-1")
                self.assertEqual(read.value["thinking_level"], "medium")
                self.assertEqual(read.value["herdr_pane_id"], "w1A:p1")
                self.assertNotIn("SENTINEL", json.dumps(read.value))
                self.assertNotIn("herdr_socket_path", read.value)
                # the row names the incarnation that wrote it
                self.assertTrue(read.incarnation)
                self.assertIn(str(result["incarnation"]["startTicks"]),
                              read.incarnation)


def time_now() -> float:
    import time
    return time.time()


if __name__ == "__main__":
    unittest.main()
