// Files a real page ask against a throwaway daemon and then WAITS for the answer.
// It is the "agent" in the spike: if the spike can drive the page, this process returns with
// the submission, which is the same wake path a parked agent uses.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "spike-daemon-"));
process.env.UNBLOCK_STATE_DIR = join(dir, "state");
process.env.UNBLOCK_CONFIG_DIR = join(dir, "config");
process.env.UNBLOCK_SECRET_BACKEND = "env";
process.env.UNBLOCK_SECRET = process.env.UNBLOCK_SECRET || randomBytes(32).toString("hex");

const { startDaemon, loadOrCreateSecret } = await import(join(PLUGIN, "src", "daemon.js"));
const secret = loadOrCreateSecret();
const daemon = await startDaemon({ port: 0 });
const base = `http://127.0.0.1:${daemon.port}`;
const auth = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
const html = readFileSync(join(HERE, "ask-page.html"), "utf8");

const filed = await fetch(`${base}/api/asks`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({
    ask: {
      kind: "page",
      purpose: "decision",
      only_you: "judgment",
      title: "Pick the rollout window",
      why: "The spike needs a page ask whose form is small enough to click blindly.",
      tried: ["Rendered the queue in the TUI and found no way to answer a page ask there."],
      html,
    },
    origin: { session_id: "spike", pane_id: process.env.SPIKE_PANE || "spike:p0" },
  }),
});
const ask = await filed.json();
if (!ask.ticket) {
  console.error("file failed", filed.status, JSON.stringify(ask));
  process.exit(1);
}

const minted = await fetch(`${base}/api/links`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ ticket: ask.ticket, ttl_seconds: 3600 }),
});
const link = await minted.json();
const token = link.token;
const pageUrl = `${base}/u/${token}/api/asks/${ask.ticket}/page.html`;
const ctx = { base, ticket: ask.ticket, token, pageUrl, secret, stateDir: dir };
writeFileSync(process.env.SPIKE_CTX || "/tmp/spike-ctx.json", JSON.stringify(ctx, null, 2));
console.log("PAGE_URL " + pageUrl);
console.log("TICKET " + ask.ticket);

// Wait for the answer exactly the way a parked agent does: poll until it is answered.
const deadline = Date.now() + Number(process.env.SPIKE_WAIT_MS || 180000);
while (Date.now() < deadline) {
  const res = await fetch(`${base}/api/asks/${ask.ticket}`, { headers: auth });
  const now = await res.json();
  if (now.status === "answered") {
    console.log("ANSWERED " + JSON.stringify(now.answers));
    console.log("VIA " + (now.answered_via || ""));
    await daemon.close();
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log("TIMEOUT no answer within the window");
await daemon.close();
process.exit(3);
