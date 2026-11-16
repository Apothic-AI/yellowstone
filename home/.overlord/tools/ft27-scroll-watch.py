#!/usr/bin/env python3
"""FT-27 instrument: sample a herdr pane's scroll offset and report excursions.

Decides between two hypotheses that look identical on screen:
  A. something scrolls the *pane* (offset_from_bottom leaves 0 and returns)
  B. pi re-lays-out its own viewport (offset stays 0 while content visibly shifts)

Usage: ft27-scroll-watch.py <pane_id> [--seconds N] [--interval S] [--log PATH]
Prints one line per observed change; a jump is a non-zero offset followed by 0.
"""
import argparse, json, subprocess, sys, time, os, datetime


def pane_state(pane):
    out = subprocess.run(["herdr", "pane", "get", pane],
                         capture_output=True, text=True, timeout=10)
    if out.returncode != 0:
        return None, f"herdr exit {out.returncode}: {out.stderr.strip()[:120]}"
    try:
        d = json.loads(out.stdout)
    except Exception as e:
        return None, f"unparseable: {e}"
    p = d.get("result", {}).get("pane") or {}
    return p, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pane")
    ap.add_argument("--seconds", type=float, default=300)
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--log", default="/home/bitnom/.local/state/ft27/scroll-watch.jsonl")
    a = ap.parse_args()
    os.makedirs(os.path.dirname(a.log), exist_ok=True)

    t0 = time.time()
    last = None
    samples = 0
    excursions = 0
    errors = 0
    with open(a.log, "a") as log:
        while time.time() - t0 < a.seconds:
            p, err = pane_state(a.pane)
            ts = datetime.datetime.now(datetime.UTC).strftime("%H:%M:%S.%f")[:-3]
            if err:
                errors += 1
                print(f"{ts} ERROR {err}", flush=True)
                time.sleep(a.interval)
                continue
            samples += 1
            sc = p.get("scroll") or {}
            off = sc.get("offset_from_bottom")
            mx = sc.get("max_offset_from_bottom")
            vp = sc.get("viewport_rows")
            key = (off, mx, vp)
            if key != last:
                tag = ""
                if last is not None and off is not None and off > 0:
                    tag = "  <== PANE SCROLLED (hypothesis A)"
                    excursions += 1
                if last is not None and off == 0 and last[0]:
                    tag = "  <== returned to bottom"
                print(f"{ts} offset_from_bottom={off} max={mx} viewport={vp}{tag}", flush=True)
                log.write(json.dumps({"ts": ts, "offset": off, "max": mx,
                                      "viewport": vp, "status": p.get("agent_status")}) + "\n")
                log.flush()
                last = key
            time.sleep(a.interval)
    print(f"SUMMARY samples={samples} errors={errors} scroll_excursions={excursions} "
          f"window={a.seconds:.0f}s pane={a.pane}", flush=True)
    if excursions == 0:
        print("VERDICT: offset never left 0 — the pane was not scrolled by herdr; "
              "any visible shift came from inside pi (hypothesis B).", flush=True)


if __name__ == "__main__":
    sys.exit(main())
