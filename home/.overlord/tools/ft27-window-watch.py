#!/usr/bin/env python3
"""FT-27 instrument v2: detect the operator's symptom directly from the pane's rendered text.

The symptom: while a lane works, the transcript briefly shows *earlier* lines, then returns to
the bottom. Since pi's transcript lives inside its own fullscreen ScrollView, herdr's pane scroll
offset stays 0, so the excursion has to be observed in the rendered rows.

Method: every interval, read the pane's visible text and characterise the window by its last
non-empty line (the newest content) and its first non-empty line (the oldest visible). A jump
shows up as the window changing while `agent_status == "working"` and later reverting to a
previously-seen signature.

Usage: ft27-window-watch.py <pane_id> [--seconds N] [--interval S] [--log PATH] [--rows N]
"""
import argparse, hashlib, json, os, subprocess, sys, time, datetime


def visible(pane, rows):
    out = subprocess.run(["herdr", "pane", "read", pane, "--source", "visible",
                          "--format", "text", "--lines", str(rows)],
                         capture_output=True, text=True, timeout=15)
    if out.returncode != 0:
        return None, f"exit {out.returncode}: {out.stderr.strip()[:120]}"
    return out.stdout.splitlines(), None


def status(pane):
    out = subprocess.run(["herdr", "pane", "get", pane], capture_output=True, text=True, timeout=10)
    try:
        return json.loads(out.stdout).get("result", {}).get("pane", {}).get("agent_status")
    except Exception:
        return None


def sig(lines):
    text = "\n".join(lines).rstrip()
    return hashlib.sha1(text.encode()).hexdigest()[:12]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pane")
    ap.add_argument("--seconds", type=float, default=600)
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--log", default="/home/bitnom/.local/state/ft27/window-watch.jsonl")
    a = ap.parse_args()
    os.makedirs(os.path.dirname(a.log), exist_ok=True)

    t0 = time.time()
    prev = None
    hist = {}
    reverts = 0
    samples = errors = 0
    with open(a.log, "a") as log:
        while time.time() - t0 < a.seconds:
            lines, err = visible(a.pane, a.rows)
            ts = datetime.datetime.now(datetime.UTC).strftime("%H:%M:%S.%f")[:-3]
            if err:
                errors += 1
                print(f"{ts} ERROR {err}", flush=True)
                time.sleep(a.interval)
                continue
            samples += 1
            body = [l for l in lines if l.strip()]
            if not body:
                time.sleep(a.interval)
                continue
            s = sig(body)
            first, last = body[0][:70], body[-1][:70]
            if s != prev:
                seen = hist.get(s)
                note = ""
                if seen is not None:
                    note = f"  <== REVERTED to a window seen at {seen} " \
                           f"({time.time()-seen:.0f}s ago)"
                    reverts += 1
                hist[s] = time.time()
                st = status(a.pane)
                print(f"{ts} [{st}] sig={s} top={first!r} bottom={last!r}{note}", flush=True)
                log.write(json.dumps({"ts": ts, "sig": s, "status": st,
                                      "top": first, "bottom": last,
                                      "revert": seen is not None}) + "\n")
                log.flush()
                prev = s
            time.sleep(a.interval)
    print(f"SUMMARY samples={samples} errors={errors} window_changes={len(hist)} reverts={reverts} "
          f"window={a.seconds:.0f}s pane={a.pane}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
